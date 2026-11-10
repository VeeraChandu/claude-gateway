// @ts-check
import { createHash } from "node:crypto";
import { ToolNames } from "./tool-names.js";

/**
 * @typedef {object} TranslateOptions
 * @property {string} model            Upstream model name
 * @property {boolean} reasoning        Whether the upstream model is a reasoning model
 * @property {number | null} [maxOutputTokens]  Clamp for max_tokens
 */

const TOOL_IMAGE_NOTE = "[image output from this tool is attached in the next user message]";

/** @param {any} source */
function imageUrlFromSource(source) {
  if (!source) return null;
  if (source.type === "url" && source.url) return source.url;
  if (source.type === "base64" && source.data) return `data:${source.media_type || "image/png"};base64,${source.data}`;
  return null;
}

/**
 * Anthropic image/document block → OpenAI content part(s).
 * @param {any} block
 * @returns {any[]}
 */
function mediaParts(block) {
  if (block.type === "image") {
    const url = imageUrlFromSource(block.source);
    return url ? [{ type: "image_url", image_url: { url } }] : [];
  }
  if (block.type === "document") {
    const src = block.source || {};
    const title = block.title ? `Document: ${block.title}\n` : "";
    if (src.type === "text") return [{ type: "text", text: title + (src.data || "") }];
    if (src.type === "content" && Array.isArray(src.content)) {
      const text = src.content.map((/** @type {any} */ c) => c.text || "").filter(Boolean).join("\n");
      return [{ type: "text", text: title + text }];
    }
    if (src.type === "url") return [{ type: "text", text: `${title}[document at ${src.url}]` }];
    if (src.type === "base64") {
      return [
        {
          type: "file",
          file: {
            filename: block.title || "document.pdf",
            file_data: `data:${src.media_type || "application/pdf"};base64,${src.data}`
          }
        }
      ];
    }
  }
  return [];
}

/**
 * OpenAI-compatible providers vary in accepting array content; collapse all-text to a string.
 * @param {any[]} parts
 */
function collapseParts(parts) {
  return parts.every((p) => p.type === "text") ? parts.map((p) => p.text).join("\n\n") : parts;
}

/**
 * Convert an Anthropic tool_result block into an OpenAI tool message, plus any
 * images it contained (tool messages can only carry text).
 * @param {any} block
 */
function convertToolResult(block) {
  const texts = [];
  const images = [];
  if (typeof block.content === "string") {
    texts.push(block.content);
  } else if (Array.isArray(block.content)) {
    for (const c of block.content) {
      if (typeof c === "string") texts.push(c);
      else if (c?.type === "text") texts.push(c.text || "");
      else if (c?.type === "image" || c?.type === "document") {
        const parts = mediaParts(c);
        images.push(...parts);
        if (parts.length) texts.push(TOOL_IMAGE_NOTE);
      } else if (c) texts.push(JSON.stringify(c));
    }
  } else if (block.content) {
    texts.push(JSON.stringify(block.content));
  }

  let content = texts.filter(Boolean).join("\n");
  if (block.is_error) content = content ? `Error: ${content}` : "Error: tool execution failed";
  return {
    message: { role: "tool", tool_call_id: block.tool_use_id, content: content || "(no output)" },
    images
  };
}

/**
 * Convert an Anthropic /v1/messages request body into an OpenAI
 * /v1/chat/completions payload.
 *
 * @param {any} body
 * @param {TranslateOptions} opts
 */
export function translateRequest(body, opts) {
  const toolNames = new ToolNames();
  /** @type {any[]} */
  const messages = [];

  const systemText =
    typeof body.system === "string"
      ? body.system
      : Array.isArray(body.system)
        ? body.system
            .map((/** @type {any} */ s) => (typeof s === "string" ? s : s?.text || ""))
            .filter(Boolean)
            .join("\n\n")
        : "";
  if (systemText) messages.push({ role: "system", content: systemText });

  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        if (msg.content) messages.push({ role: "assistant", content: msg.content });
        continue;
      }
      if (!Array.isArray(msg.content)) continue;
      const texts = [];
      const toolCalls = [];
      for (const block of msg.content) {
        if (block.type === "text" && block.text) texts.push(block.text);
        else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: toolNames.register(block.name),
              arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {})
            }
          });
        }
        // thinking / redacted_thinking blocks are Anthropic-signed; upstreams can't use them.
      }
      if (!texts.length && !toolCalls.length) continue;
      /** @type {any} */
      const out = { role: "assistant", content: texts.length ? texts.join("\n") : null };
      if (toolCalls.length) out.tool_calls = toolCalls;
      messages.push(out);
    } else if (msg.role === "user") {
      if (typeof msg.content === "string") {
        messages.push({ role: "user", content: msg.content });
        continue;
      }
      if (!Array.isArray(msg.content)) continue;
      const toolMessages = [];
      const toolImages = [];
      const parts = [];
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          const { message, images } = convertToolResult(block);
          toolMessages.push(message);
          toolImages.push(...images);
        } else if (block.type === "text") {
          if (block.text) parts.push({ type: "text", text: block.text });
        } else {
          parts.push(...mediaParts(block));
        }
      }
      // Tool messages must directly follow the assistant tool_calls message.
      messages.push(...toolMessages);
      const userParts = toolImages.length
        ? [{ type: "text", text: "Images returned by the tool calls above:" }, ...toolImages, ...parts]
        : parts;
      if (userParts.length) messages.push({ role: "user", content: collapseParts(userParts) });
    }
  }

  // Anthropic server tools (web_search_*, code_execution_*, …) have a `type` and no
  // input_schema; an OpenAI upstream can't run them.
  const customTools = (Array.isArray(body.tools) ? body.tools : []).filter(
    (/** @type {any} */ t) => t && (!t.type || t.type === "custom")
  );

  /** @type {any} */
  const payload = {
    model: opts.model,
    messages,
    stream: body.stream === true
  };

  if (customTools.length) {
    payload.tools = customTools.map((/** @type {any} */ t) => ({
      type: "function",
      function: {
        name: toolNames.register(t.name),
        description: t.description || "",
        parameters: t.input_schema || { type: "object", properties: {} }
      }
    }));

    const tc = body.tool_choice;
    if (tc?.type === "auto") payload.tool_choice = "auto";
    else if (tc?.type === "any") payload.tool_choice = "required";
    else if (tc?.type === "none") payload.tool_choice = "none";
    else if (tc?.type === "tool" && tc.name) {
      payload.tool_choice = { type: "function", function: { name: toolNames.register(tc.name) } };
    }
    if (tc?.disable_parallel_tool_use) payload.parallel_tool_calls = false;
  }

  let maxTokens = body.max_tokens;
  if (maxTokens && opts.maxOutputTokens) maxTokens = Math.min(maxTokens, opts.maxOutputTokens);

  if (opts.reasoning) {
    if (maxTokens) payload.max_completion_tokens = maxTokens;
  } else {
    if (maxTokens) payload.max_tokens = maxTokens;
    if (body.temperature !== undefined) payload.temperature = body.temperature;
    if (body.top_p !== undefined) payload.top_p = body.top_p;
  }

  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
    payload.stop = body.stop_sequences.slice(0, 4);
  }
  if (body.metadata?.user_id) {
    payload.user = createHash("sha256").update(String(body.metadata.user_id)).digest("hex").slice(0, 32);
  }
  if (payload.stream) payload.stream_options = { include_usage: true };

  return {
    payload,
    toolNames,
    thinkingRequested: body.thinking?.type === "enabled" || body.thinking?.type === "adaptive"
  };
}
