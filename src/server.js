// @ts-check
import http from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { GatewayError, errorBody, mapUpstreamError, mapStreamError } from "./errors.js";
import { resolveRoute, isReasoningModel } from "./models.js";
import { translateRequest } from "./translate/request.js";
import { translateResponse, StreamTranslator } from "./translate/response.js";
import { postUpstream } from "./upstream.js";
import { sseData } from "./sse.js";
import { estimateInputTokens } from "./tokens.js";
import { silentLogger } from "./logger.js";
import { Activity } from "./activity.js";
import { isLoopback } from "./config.js";
import { isLoopbackAddress } from "./net.js";
import { createAdmin } from "./admin/index.js";

/** @typedef {import("./config.js").Config} Config */
/** @typedef {import("./logger.js").Logger} Logger */
/** @typedef {import("./store.js").Store} Store */
/** @typedef {import("./store.js").ClientKey} ClientKey */
/** @typedef {import("./activity.js").ActivityEntry} ActivityEntry */

const MESSAGES_PATHS = new Set(["/v1/messages", "/messages", "/v1/v1/messages"]);
const COUNT_TOKENS_PATHS = new Set(["/v1/messages/count_tokens", "/messages/count_tokens"]);

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
export function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/**
 * Read the request body as UTF-8, decoding once so multi-byte characters split
 * across TCP chunks survive. Rejects bodies over `limit` bytes.
 *
 * @param {http.IncomingMessage} req
 * @param {number} limit
 */
export async function readJsonBody(req, limit) {
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

/**
 * Create the gateway HTTP server (not yet listening).
 *
 * @param {Config} config
 * @param {{ store: Store, logger?: Logger, fetchImpl?: typeof fetch, activity?: Activity, setupCode?: string }} deps
 */
export function createGateway(config, { store, logger = silentLogger, fetchImpl = globalThis.fetch, activity = new Activity(), setupCode = "" }) {
  const admin = createAdmin({ config, store, activity, logger, fetchImpl, setupCode });

  /**
   * Authenticate a Claude Code client. Before the first client key is created,
   * only direct loopback connections to a loopback-bound gateway are allowed.
   * @param {http.IncomingMessage} req
   * @returns {ClientKey | null}
   */
  function authorize(req) {
    const key = clientKey(req);
    const record = store.verifyClientKey(key);
    if (record) return record;
    if (!store.requiresClientKey()) {
      const direct = isLoopbackAddress(req.socket.remoteAddress) && !req.headers["x-forwarded-for"];
      if ((isLoopback(config.host) && direct) || config.allowUnauthenticated) return null;
      throw new GatewayError(401, "authentication_error", "No client keys exist yet. Create one in the gateway admin UI (/admin).");
    }
    throw new GatewayError(
      401,
      "authentication_error",
      key
        ? "Invalid or revoked client key"
        : store.hasActiveClientKeys()
          ? "Missing client key: set ANTHROPIC_API_KEY to a key from the gateway admin UI"
          : "No active client keys. Create one in the gateway admin UI (/admin)."
    );
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {ActivityEntry} entry  Filled in as the request progresses
   */
  async function handleMessages(req, res, entry) {
    const started = performance.now();
    const requestId = entry.id;
    const keyRecord = authorize(req);
    entry.keyName = keyRecord?.name ?? "(local)";
    const body = await readJsonBody(req, config.maxBodyBytes);

    const requestedModel = typeof body.model === "string" ? body.model : "";
    entry.model = requestedModel;
    const route = resolveRoute(requestedModel, store.state);
    if (!route) {
      throw new GatewayError(503, "api_error", "No connection configured for this model. Add a connection and a default route in the gateway admin UI (/admin).");
    }
    const { provider, model: upstreamModel } = route;
    entry.provider = provider.name;
    entry.upstreamModel = upstreamModel;

    const { payload, toolNames, thinkingRequested } = translateRequest(body, {
      model: upstreamModel,
      reasoning: isReasoningModel(upstreamModel, provider),
      maxOutputTokens: provider.maxOutputTokens
    });
    entry.stream = payload.stream;
    const ctx = { model: requestedModel || upstreamModel, toolNames, thinkingRequested };
    const logFields = { requestId, key: entry.keyName, model: requestedModel, provider: provider.name, upstreamModel, stream: payload.stream };

    /** @param {{ input_tokens?: number, output_tokens?: number } | null | undefined} usage */
    const finish = (usage) => {
      entry.inputTokens = usage?.input_tokens ?? 0;
      entry.outputTokens = usage?.output_tokens ?? 0;
      if (keyRecord) store.recordUsage(keyRecord.id, { inputTokens: entry.inputTokens, outputTokens: entry.outputTokens });
    };

    // Client gone (e.g. Esc in Claude Code) → stop generating upstream tokens.
    const clientGone = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) clientGone.abort(new Error("client disconnected"));
    });

    let upstream;
    try {
      upstream = await postUpstream({
        url: `${provider.baseUrl}/chat/completions`,
        apiKey: provider.apiKey,
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
        entry.error = "client disconnected";
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
      entry.stopReason = message.stop_reason;
      finish(message.usage);
      logger.info("request completed", {
        ...logFields,
        status: 200,
        durationMs: Math.round(performance.now() - started),
        stopReason: message.stop_reason,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens
      });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
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
          entry.error = mapped.message;
          logger.warn("upstream error mid-stream", { ...logFields, errorType: mapped.type, error: mapped.message.slice(0, 300) });
          await send(translator.error(mapped.type, mapped.message));
          finish(translator.usage);
          res.end();
          return;
        }
        entry.ttftMs ??= Math.round(performance.now() - started);
        await send(translator.handle(chunk));
      }
      await send(translator.finish());
      res.end();
      entry.stopReason = translator.stopReason;
      finish(translator.usage);
      logger.info("request completed", {
        ...logFields,
        status: 200,
        ttftMs: entry.ttftMs,
        durationMs: Math.round(performance.now() - started),
        stopReason: entry.stopReason,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens
      });
    } catch (err) {
      finish(translator.usage);
      if (clientGone.signal.aborted) {
        entry.error = "client disconnected";
        logger.info("client disconnected mid-stream; upstream aborted", { ...logFields, durationMs: Math.round(performance.now() - started) });
        return;
      }
      const reason = controller.signal.aborted ? String(controller.signal.reason?.message) : /** @type {Error} */ (err).message;
      entry.error = `stream failed: ${reason}`;
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
    /** @type {ActivityEntry | null} */
    let entry = null;
    const started = performance.now();

    try {
      if (pathname === "/health") {
        return sendJson(res, 200, { status: "ok" });
      }
      if (pathname === "/api/hello") {
        // Claude Code probes this (HEAD) at startup.
        res.writeHead(200);
        return res.end();
      }
      if (pathname === "/") {
        res.writeHead(302, { Location: "/admin/" });
        return res.end();
      }
      if (pathname === "/admin" || pathname.startsWith("/admin/")) {
        return await admin.handle(req, res, pathname);
      }
      if (pathname === "/v1/models" || pathname === "/models") {
        if (req.method !== "GET") throw new GatewayError(405, "invalid_request_error", "Use GET");
        authorize(req);
        // Your models, for Claude Code's /model picker (CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1).
        // Built-in aliases (opus, sonnet, haiku, fable) are already in the picker.
        const { state } = store;
        const models = state.routes.models.map((m) => {
          const provider = state.providers.find((p) => p.id === m.provider);
          return {
            type: "model",
            id: m.id,
            display_name: m.displayName || m.id,
            description: m.description || `${provider?.name ?? "?"} · ${m.model}`,
            created_at: "2026-01-01T00:00:00Z"
          };
        });
        return sendJson(res, 200, { data: models, has_more: false, first_id: models[0]?.id ?? null, last_id: models.at(-1)?.id ?? null });
      }
      if (COUNT_TOKENS_PATHS.has(pathname)) {
        if (req.method !== "POST") throw new GatewayError(405, "invalid_request_error", "Use POST");
        authorize(req);
        const body = await readJsonBody(req, config.maxBodyBytes);
        return sendJson(res, 200, { input_tokens: estimateInputTokens(body) });
      }
      if (MESSAGES_PATHS.has(pathname)) {
        if (req.method !== "POST") throw new GatewayError(405, "invalid_request_error", "Use POST");
        entry = { id: requestId, time: new Date().toISOString(), status: 0, durationMs: 0 };
        return await handleMessages(req, res, entry);
      }
      throw new GatewayError(404, "not_found_error", `Unknown path: ${pathname}`);
    } catch (err) {
      const e =
        err instanceof GatewayError ? err : new GatewayError(500, "api_error", `Gateway error: ${/** @type {Error} */ (err).message}`);
      if (!(err instanceof GatewayError)) logger.error("unhandled error", { requestId, error: /** @type {Error} */ (err).stack });
      else if (e.status >= 400 && e.status !== 404) logger.debug("request rejected", { requestId, status: e.status, type: e.type });
      if (entry) entry.error = e.message;
      if (res.headersSent) {
        res.end();
      } else {
        // Discard any unread upload (no buffering) so the client can read the
        // error instead of hitting a connection reset mid-write.
        req.resume();
        sendJson(res, e.status, errorBody(e.type, e.message));
      }
    } finally {
      if (entry) {
        entry.status = res.statusCode;
        entry.durationMs = Math.round(performance.now() - started);
        activity.push(entry);
      }
    }
  }

  const server = http.createServer((req, res) => {
    route(req, res);
  });
  return server;
}
