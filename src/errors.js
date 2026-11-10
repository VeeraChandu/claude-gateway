// @ts-check

export class GatewayError extends Error {
  /**
   * @param {number} status
   * @param {string} type  Anthropic error type
   * @param {string} message
   */
  constructor(status, type, message) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

/** @param {string} type @param {string} message */
export const errorBody = (type, message) => ({ type: "error", error: { type, message } });

/** Anthropic error types Claude Code keys its retry / compaction behavior on. */
const TYPE_BY_STATUS = /** @type {Record<number, string>} */ ({
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  413: "request_too_large",
  422: "invalid_request_error",
  429: "rate_limit_error",
  500: "api_error",
  502: "api_error",
  503: "overloaded_error",
  504: "api_error",
  529: "overloaded_error"
});

const CONTEXT_OVERFLOW =
  /context[_ ]length|context window|maximum context|prompt is too long|input is too long|too many (input )?tokens|reduce the length of the (messages|prompt)/i;

/**
 * @param {any} payload  Parsed upstream error body, or undefined
 * @param {string} text  Raw body
 */
function extractMessage(payload, text) {
  const e = payload?.error;
  if (typeof e === "string") return e;
  return e?.message || payload?.message || payload?.detail || text || "unknown upstream error";
}

/**
 * Map an upstream (OpenAI-compatible) error to the Anthropic error Claude Code
 * expects. Context-window overflows become Anthropic's "prompt is too long" so
 * Claude Code compacts the conversation instead of failing.
 *
 * @param {number} status
 * @param {string} text  Raw response body
 */
export function mapUpstreamError(status, text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {}
  const message = String(extractMessage(payload, text)).slice(0, 2000);
  const code = payload?.error?.code;

  if (CONTEXT_OVERFLOW.test(message) || code === "context_length_exceeded") {
    return new GatewayError(400, "invalid_request_error", `prompt is too long: ${message}`);
  }
  const type = TYPE_BY_STATUS[status] ?? (status >= 500 ? "api_error" : "invalid_request_error");
  return new GatewayError(status, type, `Upstream ${status}: ${message}`);
}

/**
 * Map an `{"error": ...}` object that a provider embedded inside an SSE stream.
 * @param {any} err
 */
export function mapStreamError(err) {
  const status = Number(err?.code) || Number(err?.status) || 500;
  return mapUpstreamError(status >= 400 && status < 600 ? status : 500, JSON.stringify({ error: err }));
}
