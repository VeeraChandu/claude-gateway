// @ts-check
import http from "node:http";
import { once } from "node:events";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { GatewayError, errorBody, mapUpstreamError, mapStreamError } from "./errors.js";
import { resolveModel, isReasoningModel } from "./models.js";
import { translateRequest } from "./translate/request.js";
import { translateResponse, StreamTranslator } from "./translate/response.js";
import { postUpstream } from "./upstream.js";
import { sseData } from "./sse.js";
import { estimateInputTokens } from "./tokens.js";
import { silentLogger } from "./logger.js";

/** @typedef {import("./config.js").Config} Config */
/** @typedef {import("./logger.js").Logger} Logger */

const MESSAGES_PATHS = new Set(["/v1/messages", "/messages", "/v1/v1/messages"]);
const COUNT_TOKENS_PATHS = new Set(["/v1/messages/count_tokens", "/messages/count_tokens"]);

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Read the request body as UTF-8, decoding once so multi-byte characters split
 * across TCP chunks survive. Rejects bodies over `limit` bytes.
 *
 * @param {http.IncomingMessage} req
 * @param {number} limit
 */
async function readJsonBody(req, limit) {
  const declared = Number(req.headers["content-length"]);
  if (declared > limit) throw new GatewayError(413, "request_too_large", `Request body exceeds ${limit} bytes`);

  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new GatewayError(413, "request_too_large", `Request body exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed = JSON.parse(text || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new GatewayError(400, "invalid_request_error", "Request body must be a JSON object");
  }
}

/** @param {http.IncomingMessage} req */
function clientKey(req) {
  const x = req.headers["x-api-key"];
  if (typeof x === "string" && x) return x;
  const auth = req.headers.authorization;
  return auth?.replace(/^Bearer\s+/i, "") || "";
}

/** Constant-time comparison that doesn't leak length. @param {string} a @param {string} b */
function safeEqual(a, b) {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Create the gateway HTTP server (not yet listening).
 *
 * @param {Config} config
 * @param {{ logger?: Logger, fetchImpl?: typeof fetch }} [deps]
 */
export function createGateway(config, { logger = silentLogger, fetchImpl = globalThis.fetch } = {}) {
  /**
   * Resolve the upstream API key for this request, enforcing gateway auth.
   * @param {http.IncomingMessage} req
   */
  function authorize(req) {
    const key = clientKey(req);
    if (config.passthroughClientKey) {
      if (key) return key;
      if (config.upstreamApiKey) return config.upstreamApiKey;
      throw new GatewayError(401, "authentication_error", "Send your provider API key as x-api-key");
    }
    if (config.gatewayApiKey && !safeEqual(key, config.gatewayApiKey)) {
      throw new GatewayError(401, "authentication_error", "Invalid gateway API key (set ANTHROPIC_API_KEY to GATEWAY_API_KEY)");
    }
    return config.upstreamApiKey;
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {string} requestId
   */
  async function handleMessages(req, res, requestId) {
    const started = performance.now();
    const apiKey = authorize(req);
    const body = await readJsonBody(req, config.maxBodyBytes);

    const requestedModel = typeof body.model === "string" ? body.model : "";
    const upstreamModel = resolveModel(requestedModel, config);
    const { payload, toolNames, thinkingRequested } = translateRequest(body, {
      model: upstreamModel,
      reasoning: isReasoningModel(upstreamModel, config),
      maxOutputTokens: config.maxOutputTokens
    });
    const ctx = { model: requestedModel || upstreamModel, toolNames, thinkingRequested };
    const logFields = { requestId, model: requestedModel, upstreamModel, stream: payload.stream };

    // Client gone (e.g. Esc in Claude Code) → stop generating upstream tokens.
    const clientGone = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) clientGone.abort(new Error("client disconnected"));
    });

    let upstream;
    try {
      upstream = await postUpstream({
        url: `${config.upstreamBaseUrl}/chat/completions`,
        apiKey,
        payload,
        signal: clientGone.signal,
        timeoutMs: config.upstreamTimeoutMs,
        maxRetries: config.maxRetries,
        fetchImpl,
        logger,
        requestId
      });
    } catch (err) {
      if (clientGone.signal.aborted) {
        logger.info("client disconnected before upstream responded", logFields);
        return;
      }
      throw err;
    }
    const { response, controller } = upstream;

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const mapped = mapUpstreamError(response.status, text);
      logger.warn("upstream error", { ...logFields, status: response.status, errorType: mapped.type, error: mapped.message.slice(0, 300) });
      throw mapped;
    }

    if (!payload.stream) {
      const data = await response.json();
      const message = translateResponse(data, ctx);
      sendJson(res, 200, message);
      logger.info("request completed", {
        ...logFields,
        status: 200,
        durationMs: Math.round(performance.now() - started),
        stopReason: message.stop_reason,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens
      });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "request-id": requestId
    });
    const translator = new StreamTranslator(ctx);

    /** @param {import("./translate/response.js").SseEvent[]} events */
    const send = async (events) => {
      for (const [event, data] of events) {
        if (!res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) {
          await once(res, "drain", { signal: clientGone.signal });
        }
      }
    };

    const idle = setTimeout(() => controller.abort(new Error("stream idle timeout")), config.streamIdleTimeoutMs);
    let ttftMs;
    try {
      for await (const data of sseData(/** @type {ReadableStream<Uint8Array>} */ (response.body))) {
        idle.refresh();
        if (data === "[DONE]") break;
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          logger.debug("skipping unparseable upstream chunk", { requestId, data: data.slice(0, 200) });
          continue;
        }
        if (chunk.error) {
          const mapped = mapStreamError(chunk.error);
          logger.warn("upstream error mid-stream", { ...logFields, errorType: mapped.type, error: mapped.message.slice(0, 300) });
          await send(translator.error(mapped.type, mapped.message));
          res.end();
          return;
        }
        ttftMs ??= Math.round(performance.now() - started);
        await send(translator.handle(chunk));
      }
      await send(translator.finish());
      res.end();
      logger.info("request completed", {
        ...logFields,
        status: 200,
        ttftMs,
        durationMs: Math.round(performance.now() - started),
        stopReason: translator.stopReason,
        inputTokens: translator.usage?.input_tokens,
        outputTokens: translator.usage?.output_tokens
      });
    } catch (err) {
      if (clientGone.signal.aborted) {
        logger.info("client disconnected mid-stream; upstream aborted", { ...logFields, durationMs: Math.round(performance.now() - started) });
        return;
      }
      const reason = controller.signal.aborted ? String(controller.signal.reason?.message) : /** @type {Error} */ (err).message;
      logger.error("stream failed", { ...logFields, error: reason });
      await send(translator.error("api_error", `Upstream stream failed: ${reason}`)).catch(() => {});
      res.end();
    } finally {
      clearTimeout(idle);
    }
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  async function route(req, res) {
    const requestId = (typeof req.headers["x-request-id"] === "string" && req.headers["x-request-id"].slice(0, 64)) || `req_${randomBytes(8).toString("hex")}`;
    res.setHeader("request-id", requestId);
    const { pathname } = new URL(req.url || "/", "http://gateway");

    try {
      if (pathname === "/health" || pathname === "/") {
        return sendJson(res, 200, { status: "ok" });
      }
      if (pathname === "/v1/models" || pathname === "/models") {
        if (req.method !== "GET") throw new GatewayError(405, "invalid_request_error", "Use GET");
        authorize(req);
        const models = [
          ["claude-opus-5-5", "Opus", config.familyModels.opus],
          ["claude-sonnet-5-5", "Sonnet", config.familyModels.sonnet],
          ["claude-haiku-5-5", "Haiku", config.familyModels.haiku]
        ].map(([id, family, target]) => ({ type: "model", id, display_name: `${family} → ${target}`, created_at: "2026-01-01T00:00:00Z" }));
        return sendJson(res, 200, { data: models, has_more: false, first_id: models[0].id, last_id: models.at(-1)?.id });
      }
      if (COUNT_TOKENS_PATHS.has(pathname)) {
        if (req.method !== "POST") throw new GatewayError(405, "invalid_request_error", "Use POST");
        authorize(req);
        const body = await readJsonBody(req, config.maxBodyBytes);
        return sendJson(res, 200, { input_tokens: estimateInputTokens(body) });
      }
      if (MESSAGES_PATHS.has(pathname)) {
        if (req.method !== "POST") throw new GatewayError(405, "invalid_request_error", "Use POST");
        return await handleMessages(req, res, requestId);
      }
      throw new GatewayError(404, "not_found_error", `Unknown path: ${pathname}`);
    } catch (err) {
      const e =
        err instanceof GatewayError ? err : new GatewayError(500, "api_error", `Gateway error: ${/** @type {Error} */ (err).message}`);
      if (!(err instanceof GatewayError)) logger.error("unhandled error", { requestId, error: /** @type {Error} */ (err).stack });
      else if (e.status >= 400 && e.status !== 404) logger.debug("request rejected", { requestId, status: e.status, type: e.type });
      if (res.headersSent) {
        res.end();
      } else {
        // Discard any unread upload (no buffering) so the client can read the
        // error instead of hitting a connection reset mid-write.
        req.resume();
        sendJson(res, e.status, errorBody(e.type, e.message));
      }
    }
  }

  const server = http.createServer((req, res) => {
    route(req, res);
  });
  return server;
}
