// @ts-check
import { randomBytes } from "node:crypto";

/** @typedef {import("./tool-names.js").ToolNames} ToolNames */

export const newMessageId = () => `msg_${randomBytes(12).toString("hex")}`;
export const newToolUseId = () => `toolu_${randomBytes(12).toString("hex")}`;

/**
 * @param {string | null | undefined} finishReason  OpenAI finish_reason
 * @param {boolean} hadToolCalls
 */
export function mapStopReason(finishReason, hadToolCalls) {
  if (finishReason === "length") return "max_tokens";
  if (finishReason === "content_filter") return "refusal";
  if (finishReason === "tool_calls" || finishReason === "function_call") return "tool_use";
  // Ollama and some vLLM builds report "stop" even when they returned tool calls.
  return hadToolCalls ? "tool_use" : "end_turn";
}

/**
 * OpenAI `prompt_tokens` includes cached tokens (`prompt_tokens_details.cached_tokens`);
 * Anthropic `input_tokens` excludes them and reports `cache_read_input_tokens`
 * separately. Subtracting keeps input + cache_read equal to the provider's total.
 *
 * @param {any} usage
 */
export function anthropicUsage(usage) {
  if (!usage) {
    return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  }
  const cacheRead = usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input_tokens: Math.max(0, (usage.prompt_tokens ?? 0) - cacheRead),
    output_tokens: usage.completion_tokens ?? 0,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0
  };
}

/** @param {string | undefined} raw */
function parseToolArguments(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : { value: parsed };
  } catch {
    return { raw };
  }
}

/** @param {any} obj */
const reasoningOf = (obj) => {
  const r = obj?.reasoning_content ?? obj?.reasoning;
  return typeof r === "string" ? r : "";
};

/**
 * Convert a non-streaming OpenAI chat completion to an Anthropic Message.
 *
 * @param {any} data
 * @param {{ model: string, toolNames: ToolNames, thinkingRequested?: boolean }} ctx
 */
export function translateResponse(data, ctx) {
  const choice = data?.choices?.[0];
  const message = choice?.message || {};
  /** @type {any[]} */
  const content = [];

  const reasoning = reasoningOf(message);
  if (reasoning && ctx.thinkingRequested) content.push({ type: "thinking", thinking: reasoning, signature: "" });
  if (message.content) content.push({ type: "text", text: message.content });

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const tc of toolCalls) {
    content.push({
      type: "tool_use",
      id: tc.id || newToolUseId(),
      name: ctx.toolNames.toOriginal(tc.function?.name || ""),
      input: parseToolArguments(tc.function?.arguments)
    });
  }

  return {
    id: newMessageId(),
    type: "message",
    role: "assistant",
    model: ctx.model,
    content,
    stop_reason: mapStopReason(choice?.finish_reason, toolCalls.length > 0),
    stop_sequence: null,
    usage: anthropicUsage(data?.usage)
  };
}

/** @typedef {[string, any]} SseEvent  [event name, data] */

/**
 * Incrementally converts OpenAI streaming chunks into Anthropic SSE events.
 * Pure: feed it parsed chunks, write out whatever events it returns.
 *
 * Guarantees the Anthropic event grammar: message_start first; content blocks are
 * strictly sequential (each block is stopped before the next one starts); then
 * message_delta and message_stop.
 */
export class StreamTranslator {
  /** @param {{ model: string, toolNames: ToolNames, thinkingRequested?: boolean }} ctx */
  constructor(ctx) {
    this.ctx = ctx;
    this.messageId = newMessageId();
    this.started = false;
    this.finished = false;
    this.nextIndex = 0;
    /** @type {{ key: string, index: number } | null} */
    this.current = null;
    /** @type {Map<number, { id: string, name: string, pendingArgs: string, index: number | null }>} */
    this.tools = new Map();
    this.sawToolCall = false;
    /** @type {string | null} */
    this.finishReason = null;
    /** @type {ReturnType<typeof anthropicUsage> | null} */
    this.usage = null;
  }

  /** @param {SseEvent[]} out */
  #start(out) {
    if (this.started) return;
    this.started = true;
    out.push([
      "message_start",
      {
        type: "message_start",
        message: {
          id: this.messageId,
          type: "message",
          role: "assistant",
          model: this.ctx.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          // Real usage arrives in OpenAI's final chunk; it's reported in message_delta.
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      }
    ]);
  }

  /** @param {SseEvent[]} out */
  #closeCurrent(out) {
    if (!this.current) return;
    out.push(["content_block_stop", { type: "content_block_stop", index: this.current.index }]);
    this.current = null;
  }

  /**
   * @param {SseEvent[]} out
   * @param {string} key
   * @param {any} block
   * @returns {number} block index
   */
  #open(out, key, block) {
    if (this.current?.key === key) return this.current.index;
    this.#closeCurrent(out);
    const index = this.nextIndex++;
    this.current = { key, index };
    out.push(["content_block_start", { type: "content_block_start", index, content_block: block }]);
    return index;
  }

  /**
   * @param {SseEvent[]} out
   * @param {number} openAiIndex
   */
  #flushTool(out, openAiIndex) {
    const st = this.tools.get(openAiIndex);
    if (!st) return;
    const key = `tool:${openAiIndex}`;
    if (st.index === null) {
      if (!st.name) return; // wait until the name arrives
      st.index = this.#open(out, key, {
        type: "tool_use",
        id: st.id || newToolUseId(),
        name: this.ctx.toolNames.toOriginal(st.name),
        input: {}
      });
      this.sawToolCall = true;
    }
    if (st.pendingArgs) {
      // Providers stream tool calls one after another; if one interleaves anyway,
      // deliver to its own index rather than lose arguments.
      out.push([
        "content_block_delta",
        { type: "content_block_delta", index: st.index, delta: { type: "input_json_delta", partial_json: st.pendingArgs } }
      ]);
      st.pendingArgs = "";
    }
  }

  /**
   * @param {any} chunk  Parsed OpenAI chat.completion.chunk
   * @returns {SseEvent[]}
   */
  handle(chunk) {
    /** @type {SseEvent[]} */
    const out = [];
    this.#start(out);
    if (chunk?.usage) this.usage = anthropicUsage(chunk.usage);

    const choice = chunk?.choices?.[0];
    if (!choice) return out;
    const delta = choice.delta || {};

    const reasoning = reasoningOf(delta);
    if (reasoning && this.ctx.thinkingRequested) {
      const index = this.#open(out, "thinking", { type: "thinking", thinking: "", signature: "" });
      out.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: reasoning } }]);
    }

    if (typeof delta.content === "string" && delta.content) {
      const index = this.#open(out, "text", { type: "text", text: "" });
      out.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: delta.content } }]);
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const i = tc.index ?? 0;
        let st = this.tools.get(i);
        if (!st) {
          st = { id: "", name: "", pendingArgs: "", index: null };
          this.tools.set(i, st);
        }
        if (tc.id && !st.id) st.id = tc.id;
        if (tc.function?.name && !st.name) st.name = tc.function.name;
        if (tc.function?.arguments) st.pendingArgs += tc.function.arguments;
        this.#flushTool(out, i);
      }
    }

    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    return out;
  }

  /** @returns {SseEvent[]} */
  finish() {
    /** @type {SseEvent[]} */
    const out = [];
    if (this.finished) return out;
    this.finished = true;
    this.#start(out);

    // Tool calls whose name never arrived still carry arguments the client needs.
    for (const [i, st] of this.tools) {
      if (st.index === null && (st.pendingArgs || st.id)) {
        st.name ||= "unknown_tool";
        this.#flushTool(out, i);
      }
    }
    this.#closeCurrent(out);

    const usage = this.usage ?? anthropicUsage(null);
    out.push([
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: mapStopReason(this.finishReason, this.sawToolCall), stop_sequence: null },
        usage
      }
    ]);
    out.push(["message_stop", { type: "message_stop" }]);
    return out;
  }

  /**
   * Terminate the stream with an Anthropic `error` event.
   * @param {string} type
   * @param {string} message
   * @returns {SseEvent[]}
   */
  error(type, message) {
    this.finished = true;
    return [["error", { type: "error", error: { type, message } }]];
  }

  get stopReason() {
    return mapStopReason(this.finishReason, this.sawToolCall);
  }
}
