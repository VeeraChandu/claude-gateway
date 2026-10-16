import { config } from "./config.js";

/**
 * Clean schema to remove Anthropic-specific extensions like cache_control
 */
function cleanSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(cleanSchema);

  const cleaned = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "cache_control") continue;
    cleaned[key] = cleanSchema(value);
  }
  return cleaned;
}

/**
 * Convert Anthropic /v1/messages request to OpenAI /v1/chat/completions payload
 */
export function anthropicToOpenAI(anthropicBody, resolvedModel) {
  // Extract system prompt
  let systemText = "";
  if (typeof anthropicBody.system === "string") {
    systemText = anthropicBody.system;
  } else if (Array.isArray(anthropicBody.system)) {
    systemText = anthropicBody.system
      .map((item) => (typeof item === "string" ? item : item.text || ""))
      .filter(Boolean)
      .join("\n\n");
  }

  const isReasoning = config.isReasoningModel(resolvedModel);
  const openAiMessages = [];

  if (systemText) {
    const role = isReasoning ? "developer" : "system";
    openAiMessages.push({ role, content: systemText });
  }

  // Convert messages
  if (Array.isArray(anthropicBody.messages)) {
    for (const msg of anthropicBody.messages) {
      if (msg.role === "assistant") {
        if (typeof msg.content === "string") {
          openAiMessages.push({ role: "assistant", content: msg.content });
        } else if (Array.isArray(msg.content)) {
          let textContent = "";
          const toolCalls = [];

          for (const block of msg.content) {
            if (block.type === "text") {
              textContent += (textContent ? "\n" : "") + (block.text || "");
            } else if (block.type === "tool_use") {
              toolCalls.push({
                id: block.id,
                type: "function",
                function: {
                  name: block.name,
                  arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input || {})
                }
              });
            }
          }

          const assistantMsg = {
            role: "assistant",
            content: textContent || (toolCalls.length ? null : "")
          };
          if (toolCalls.length > 0) {
            assistantMsg.tool_calls = toolCalls;
          }
          openAiMessages.push(assistantMsg);
        }
      } else if (msg.role === "user") {
        if (typeof msg.content === "string") {
          openAiMessages.push({ role: "user", content: msg.content });
        } else if (Array.isArray(msg.content)) {
          const toolResults = [];
          const userParts = [];

          for (const block of msg.content) {
            if (block.type === "tool_result") {
              let contentStr = "";
              if (typeof block.content === "string") {
                contentStr = block.content;
              } else if (Array.isArray(block.content)) {
                contentStr = block.content
                  .map((c) => (typeof c === "string" ? c : c.text || JSON.stringify(c)))
                  .join("\n");
              } else if (block.content) {
                contentStr = JSON.stringify(block.content);
              }
              if (!contentStr && block.is_error) {
                contentStr = "Tool execution returned an error";
              }
              toolResults.push({
                role: "tool",
                tool_call_id: block.tool_use_id,
                content: contentStr || "Done"
              });
            } else if (block.type === "text") {
              userParts.push({ type: "text", text: block.text || "" });
            } else if (block.type === "image" && block.source) {
              userParts.push({
                type: "image_url",
                image_url: {
                  url: `data:${block.source.media_type || "image/png"};base64,${block.source.data}`
                }
              });
            }
          }

          // OpenAI expects tool response messages immediately following tool_calls
          for (const tr of toolResults) {
            openAiMessages.push(tr);
          }

          if (userParts.length > 0) {
            if (userParts.length === 1 && userParts[0].type === "text") {
              openAiMessages.push({ role: "user", content: userParts[0].text });
            } else {
              openAiMessages.push({ role: "user", content: userParts });
            }
          }
        }
      }
    }
  }

  // Convert tools
  let openAiTools = undefined;
  if (Array.isArray(anthropicBody.tools) && anthropicBody.tools.length > 0) {
    openAiTools = anthropicBody.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: cleanSchema(t.input_schema || { type: "object", properties: {} })
      }
    }));
  }

  // Convert tool_choice
  let openAiToolChoice = undefined;
  if (anthropicBody.tool_choice) {
    if (typeof anthropicBody.tool_choice === "string") {
      openAiToolChoice = anthropicBody.tool_choice;
    } else if (anthropicBody.tool_choice.type === "auto") {
      openAiToolChoice = "auto";
    } else if (anthropicBody.tool_choice.type === "any") {
      openAiToolChoice = "required";
    } else if (anthropicBody.tool_choice.type === "tool" && anthropicBody.tool_choice.name) {
      openAiToolChoice = {
        type: "function",
        function: { name: anthropicBody.tool_choice.name }
      };
    }
  }

  const payload = {
    model: resolvedModel,
    messages: openAiMessages,
    stream: anthropicBody.stream !== false
  };

  if (openAiTools) {
    payload.tools = openAiTools;
    if (openAiToolChoice) {
      payload.tool_choice = openAiToolChoice;
    }
  }

  if (isReasoning) {
    if (anthropicBody.max_tokens) {
      payload.max_completion_tokens = anthropicBody.max_tokens;
    }
  } else {
    if (anthropicBody.max_tokens) {
      payload.max_tokens = anthropicBody.max_tokens;
    }
    if (anthropicBody.temperature !== undefined) {
      payload.temperature = anthropicBody.temperature;
    }
  }

  if (payload.stream) {
    payload.stream_options = { include_usage: true };
  }

  return payload;
}

/**
 * Stream OpenAI SSE chunks to Anthropic SSE events in real-time
 */
export async function streamOpenAIToAnthropic(openAiStream, requestedModel, res, thinkingRequested = false) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });

  const sendEvent = (eventType, data) => {
    res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  let messageStartSent = false;
  let thinkingBlockStarted = false;
  let thinkingBlockIndex = -1;
  let textBlockStarted = false;
  let textBlockIndex = -1;
  let nextBlockIndex = 0;

  const toolCallMap = new Map(); // openAiIndex -> { anthropicIndex, id, name, stopped }
  let totalOutputTokens = 0;
  let totalInputTokens = 0;
  let finishReason = "end_turn";

  const reader = openAiStream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (trimmed === "data: [DONE]") continue;

        if (trimmed.startsWith("data: ")) {
          let chunk;
          try {
            chunk = JSON.parse(trimmed.slice(6));
          } catch {
            continue;
          }

          if (chunk.usage) {
            if (chunk.usage.prompt_tokens !== undefined) totalInputTokens = chunk.usage.prompt_tokens;
            if (chunk.usage.completion_tokens !== undefined) totalOutputTokens = chunk.usage.completion_tokens;
          }

          if (!messageStartSent) {
            sendEvent("message_start", {
              type: "message_start",
              message: {
                id: messageId,
                type: "message",
                role: "assistant",
                model: requestedModel,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: totalInputTokens, output_tokens: 0 }
              }
            });
            messageStartSent = true;
          }

          const choice = chunk.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;
          if (delta) {
            // Reasoning delta (DeepSeek / Venice / o-series)
            if (delta.reasoning_content && thinkingRequested) {
              if (!thinkingBlockStarted) {
                thinkingBlockIndex = nextBlockIndex++;
                sendEvent("content_block_start", {
                  type: "content_block_start",
                  index: thinkingBlockIndex,
                  content_block: { type: "thinking", thinking: "" }
                });
                thinkingBlockStarted = true;
              }
              sendEvent("content_block_delta", {
                type: "content_block_delta",
                index: thinkingBlockIndex,
                delta: { type: "thinking_delta", thinking: delta.reasoning_content }
              });
            }

            // Text delta
            if (delta.content) {
              if (thinkingBlockStarted) {
                sendEvent("content_block_stop", {
                  type: "content_block_stop",
                  index: thinkingBlockIndex
                });
                thinkingBlockStarted = false;
              }
              if (!textBlockStarted) {
                textBlockIndex = nextBlockIndex++;
                sendEvent("content_block_start", {
                  type: "content_block_start",
                  index: textBlockIndex,
                  content_block: { type: "text", text: "" }
                });
                textBlockStarted = true;
              }
              sendEvent("content_block_delta", {
                type: "content_block_delta",
                index: textBlockIndex,
                delta: { type: "text_delta", text: delta.content }
              });
            }

            // Tool call deltas
            if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
              if (thinkingBlockStarted) {
                sendEvent("content_block_stop", {
                  type: "content_block_stop",
                  index: thinkingBlockIndex
                });
                thinkingBlockStarted = false;
              }
              if (textBlockStarted) {
                sendEvent("content_block_stop", {
                  type: "content_block_stop",
                  index: textBlockIndex
                });
                textBlockStarted = false;
              }

              for (const tc of delta.tool_calls) {
                const tcIdx = tc.index ?? 0;
                let toolState = toolCallMap.get(tcIdx);

                if (!toolState) {
                  const bIdx = nextBlockIndex++;
                  const toolId = tc.id || `call_${Math.random().toString(36).slice(2, 9)}`;
                  const toolName = tc.function?.name || "";
                  toolState = { anthropicIndex: bIdx, id: toolId, name: toolName, stopped: false };
                  toolCallMap.set(tcIdx, toolState);

                  sendEvent("content_block_start", {
                    type: "content_block_start",
                    index: bIdx,
                    content_block: {
                      type: "tool_use",
                      id: toolState.id,
                      name: toolState.name,
                      input: {}
                    }
                  });
                } else if (!toolState.name && tc.function?.name) {
                  toolState.name = tc.function.name;
                }

                if (tc.function?.arguments) {
                  sendEvent("content_block_delta", {
                    type: "content_block_delta",
                    index: toolState.anthropicIndex,
                    delta: {
                      type: "input_json_delta",
                      partial_json: tc.function.arguments
                    }
                  });
                }
              }
            }
          }

          if (choice.finish_reason) {
            if (choice.finish_reason === "tool_calls") {
              finishReason = "tool_use";
            } else if (choice.finish_reason === "length") {
              finishReason = "max_tokens";
            } else {
              finishReason = "end_turn";
            }
          }
        }
      }
    }

    // Ensure message_start was sent even if stream was totally empty
    if (!messageStartSent) {
      sendEvent("message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model: requestedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: totalInputTokens, output_tokens: 0 }
        }
      });
    }

    if (thinkingBlockStarted) {
      sendEvent("content_block_stop", {
        type: "content_block_stop",
        index: thinkingBlockIndex
      });
      thinkingBlockStarted = false;
    }

    if (textBlockStarted) {
      sendEvent("content_block_stop", {
        type: "content_block_stop",
        index: textBlockIndex
      });
      textBlockStarted = false;
    }

    for (const [_, toolState] of toolCallMap) {
      if (!toolState.stopped) {
        sendEvent("content_block_stop", {
          type: "content_block_stop",
          index: toolState.anthropicIndex
        });
        toolState.stopped = true;
      }
    }

    sendEvent("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: finishReason,
        stop_sequence: null
      },
      usage: {
        output_tokens: totalOutputTokens || 1
      }
    });

    sendEvent("message_stop", {
      type: "message_stop"
    });

    res.end();
  } catch (err) {
    console.error("[Stream Error]", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "server_error", message: err.message } }));
    } else {
      res.end();
    }
  }
}

/**
 * Convert OpenAI non-streaming JSON response to Anthropic Message JSON
 */
export function openAIToAnthropicNonStream(openAiData, requestedModel) {
  const choice = openAiData.choices?.[0];
  const message = choice?.message || {};
  const content = [];

  if (message.content) {
    content.push({
      type: "text",
      text: message.content
    });
  }

  if (message.tool_calls && Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      let parsedInput = {};
      try {
        parsedInput = JSON.parse(tc.function.arguments || "{}");
      } catch {
        parsedInput = { raw: tc.function.arguments };
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: parsedInput
      });
    }
  }

  let stop_reason = "end_turn";
  if (choice?.finish_reason === "tool_calls") {
    stop_reason = "tool_use";
  } else if (choice?.finish_reason === "length") {
    stop_reason = "max_tokens";
  }

  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: openAiData.usage?.prompt_tokens || 0,
      output_tokens: openAiData.usage?.completion_tokens || 0
    }
  };
}
