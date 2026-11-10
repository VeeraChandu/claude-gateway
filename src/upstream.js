// @ts-check
import { GatewayError } from "./errors.js";

/** @typedef {import("./logger.js").Logger} Logger */

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

/**
 * Parameters that OpenAI-compatible providers disagree about. Listed from the
 * most specific to the most general, so `max_completion_tokens` is tried for
 * removal before `max_tokens`.
 */
const STRIPPABLE_KEYS = ["max_completion_tokens", "max_tokens", "temperature", "top_p", "stop", "parallel_tool_calls"];

/**
 * Which request fields an upstream 400 is complaining about. Providers name
 * them in the message ("Unsupported parameter: 'temperature'"), in a `param`
 * field, or in a `code`. Matching is deliberately conservative: an unrecognized
 * 400 is passed through to the client rather than blindly retried.
 *
 * @param {unknown} payload  Parsed error body, if any
 * @param {string} text      Raw error body
 * @returns {string[]}       Keys to drop
 */
export function unsupportedParams(payload, text) {
  const haystack = [];
  const p = /** @type {any} */ (payload);
  haystack.push(p?.error?.message, p?.error?.param, p?.error?.code, p?.message, p?.detail);
  haystack.push(text);
  const hay = haystack.filter((s) => typeof s === "string").join("\n").toLowerCase();
  if (!hay) return [];
  return STRIPPABLE_KEYS.filter((k) => hay.includes(k));
}

/**
 * A copy of the payload without the given keys, or null if there is nothing
 * left to remove.
 *
 * @param {any} payload
 * @param {string[]} keys
 */
function withoutParams(payload, keys) {
  const next = { ...payload };
  let changed = false;
  for (const k of keys) {
    if (k in next) {
      delete next[k];
      changed = true;
    }
  }
  return changed ? next : null;
}

/**
 * @param {number} ms
 * @param {AbortSignal} signal
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(undefined);
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * @param {number} attempt
 * @param {string | null} retryAfter
 */
export function retryDelayMs(attempt, retryAfter) {
  const seconds = Number(retryAfter);
  if (retryAfter && Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  return Math.min(500 * 2 ** attempt, 8000) + Math.floor(Math.random() * 250);
}

/**
 * POST to the upstream chat completions endpoint, retrying rate limits, 5xx and
 * network errors with backoff. Retries happen only here, before any bytes have
 * been sent to the client.
 *
 * A 400 that names unsupported parameters is retried once with those parameters
 * removed (see `unsupportedParams`), so a provider that rejects `temperature`
 * or `max_tokens` still answers instead of failing the request.
 *
 * `timeoutMs` bounds the wait for response headers, not the whole stream.
 * The returned controller aborts the response body (used for idle timeouts).
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {Record<string, string>} opts.headers
 * @param {any} opts.payload
 * @param {AbortSignal} opts.signal  Aborted when the client disconnects
 * @param {number} opts.timeoutMs
 * @param {number} opts.maxRetries
 * @param {boolean} [opts.parameterRetry]  Strip rejected parameters and retry once
 * @param {typeof fetch} opts.fetchImpl
 * @param {Logger} opts.logger
 * @param {string} opts.requestId
 * @returns {Promise<{ response: Response, controller: AbortController, body: any }>}
 */
export async function postUpstream({ url, headers, payload, signal, timeoutMs, maxRetries, parameterRetry = true, fetchImpl, logger, requestId }) {
  let body = payload;
  let dropped = /** @type {string[]} */ ([]);
  let parameterRetried = false;

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const onClientAbort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", onClientAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("upstream timeout"));
    }, timeoutMs);

    /** @type {Response} */
    let response;
    try {
      response = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      signal.removeEventListener("abort", onClientAbort);
      if (signal.aborted) throw signal.reason;
      const reason = timedOut ? `no response within ${timeoutMs}ms` : /** @type {any} */ (err).cause?.message || /** @type {Error} */ (err).message;
      if (attempt < maxRetries) {
        const delay = retryDelayMs(attempt, null);
        logger.warn("upstream request failed, retrying", { requestId, attempt: attempt + 1, delayMs: delay, reason });
        await sleep(delay, signal);
        continue;
      }
      throw new GatewayError(timedOut ? 504 : 502, "api_error", `Upstream unreachable: ${reason}`);
    }
    clearTimeout(timer);

    // A provider rejecting one of our parameters: drop it and try once more.
    if (parameterRetry && !parameterRetried && response.status === 400) {
      const text = await response.text().catch(() => "");
      signal.removeEventListener("abort", onClientAbort);
      const keys = unsupportedParams(safeJson(text), text);
      const stripped = keys.length ? withoutParams(body, keys) : null;
      if (stripped) {
        parameterRetried = true;
        dropped = [...dropped, ...keys.filter((k) => k in body)];
        body = stripped;
        logger.warn("upstream rejected parameters; retrying without them", { requestId, dropped: dropped.join(", ") });
        continue;
      }
      // Nothing recognizable to drop. Rebuild the response so the caller can read it.
      return { response: new Response(text, { status: 400, headers: response.headers }), controller, body };
    }

    if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
      const delay = retryDelayMs(attempt, response.headers.get("retry-after"));
      await response.body?.cancel().catch(() => {});
      signal.removeEventListener("abort", onClientAbort);
      logger.warn("upstream returned retryable status", { requestId, status: response.status, attempt: attempt + 1, delayMs: delay });
      await sleep(delay, signal);
      continue;
    }

    // The listener stays registered: aborting the controller is what stops
    // upstream generation when the client goes away (Esc in Claude Code).
    return { response, controller, body };
  }
}

/** @param {string} text */
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
