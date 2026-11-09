// @ts-check
import { GatewayError } from "./errors.js";

/** @typedef {import("./logger.js").Logger} Logger */

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

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
 * `timeoutMs` bounds the wait for response headers, not the whole stream.
 * The returned controller aborts the response body (used for idle timeouts).
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.apiKey
 * @param {any} opts.payload
 * @param {AbortSignal} opts.signal  Aborted when the client disconnects
 * @param {number} opts.timeoutMs
 * @param {number} opts.maxRetries
 * @param {typeof fetch} opts.fetchImpl
 * @param {Logger} opts.logger
 * @param {string} opts.requestId
 * @returns {Promise<{ response: Response, controller: AbortController }>}
 */
export async function postUpstream({ url, apiKey, payload, signal, timeoutMs, maxRetries, fetchImpl, logger, requestId }) {
  const body = JSON.stringify(payload);

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
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body,
        signal: controller.signal
      });
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

    if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
      const delay = retryDelayMs(attempt, response.headers.get("retry-after"));
      await response.body?.cancel().catch(() => {});
      signal.removeEventListener("abort", onClientAbort);
      logger.warn("upstream returned retryable status", { requestId, status: response.status, attempt: attempt + 1, delayMs: delay });
      await sleep(delay, signal);
      continue;
    }

    return { response, controller };
  }
}
