// @ts-check
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { GatewayError } from "../errors.js";
import { StoreError, maskSecret } from "../store.js";
import { resolveRoute } from "../models.js";
import { isLocalNetworkAddress, isAllowedAdminHost } from "../net.js";
import { isLoopback } from "../config.js";

/** @typedef {import("node:http").IncomingMessage} IncomingMessage */
/** @typedef {import("node:http").ServerResponse} ServerResponse */
/** @typedef {import("../config.js").Config} Config */
/** @typedef {import("../store.js").Store} Store */
/** @typedef {import("../activity.js").Activity} Activity */
/** @typedef {import("../logger.js").Logger} Logger */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "public");
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, "..", "..", "package.json"), "utf8")).version;

const COOKIE = "cgw_admin";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const MAX_ADMIN_BODY = 64 * 1024;

const STATIC = {
  "/admin/": ["index.html", "text/html; charset=utf-8"],
  "/admin/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/admin/app.css": ["app.css", "text/css; charset=utf-8"],
  "/admin/favicon.svg": ["favicon.svg", "image/svg+xml"]
};

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin"
};

/** @param {ServerResponse} res @param {number} status @param {unknown} body */
function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/** @param {ServerResponse} res @param {number} status @param {string} message */
function fail(res, status, message) {
  json(res, status, { error: { message } });
}

/** @param {IncomingMessage} req */
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_ADMIN_BODY) throw new StoreError(413, "Request too large");
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new StoreError(400, "Body must be a JSON object");
  }
}

/** @param {IncomingMessage} req */
function cookieToken(req) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return "";
}

/** @param {string} a @param {string} b */
function safeEqual(a, b) {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/**
 * Fetch the provider's model list; doubles as a connection test.
 * @param {typeof fetch} fetchImpl
 * @param {string} baseUrl
 * @param {string} apiKey
 */
export async function testConnection(fetchImpl, baseUrl, apiKey) {
  const started = performance.now();
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000)
    });
    const latencyMs = Math.round(performance.now() - started);
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {}
    if (!res.ok) {
      const message = body?.error?.message || body?.error || body?.message || text.slice(0, 200) || res.statusText;
      return { ok: false, status: res.status, latencyMs, models: [], error: `HTTP ${res.status}: ${message}` };
    }
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
    const models = list
      .map((/** @type {any} */ m) => (typeof m === "string" ? m : m?.id || m?.name))
      .filter((/** @type {unknown} */ id) => typeof id === "string")
      .sort()
      .slice(0, 1000);
    return { ok: true, status: res.status, latencyMs, models, error: "" };
  } catch (err) {
    const e = /** @type {any} */ (err);
    const reason = e.name === "TimeoutError" ? "no response within 10s" : e.cause?.message || e.message;
    return { ok: false, status: 0, latencyMs: Math.round(performance.now() - started), models: [], error: reason };
  }
}

/**
 * The /admin UI and its JSON API.
 *
 * Access requires, in order: a local/private/Tailscale source address (unless
 * ADMIN_ALLOW_FROM=any), an allowed Host header (DNS-rebinding guard), and for
 * the API a session cookie. State-changing calls must also be same-origin and
 * carry the X-CGW-Admin header, which cross-site forms and fetches can't send.
 *
 * @param {{ config: Config, store: Store, activity: Activity, logger: Logger, fetchImpl: typeof fetch, setupCode: string }} deps
 */
export function createAdmin({ config, store, activity, logger, fetchImpl, setupCode }) {
  /** @type {Map<string, number>} token → expiry */
  const sessions = new Map();
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const failures = new Map();
  const files = Object.fromEntries(
    Object.entries(STATIC).map(([route, [file, type]]) => [route, { body: fs.readFileSync(path.join(PUBLIC_DIR, file)), type }])
  );

  /** @param {IncomingMessage} req */
  const remote = (req) => req.socket.remoteAddress || "";

  /** @param {IncomingMessage} req */
  function isAuthenticated(req) {
    const token = cookieToken(req);
    const expires = token && sessions.get(token);
    if (!expires) return false;
    if (expires < Date.now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  /** @param {IncomingMessage} req @param {ServerResponse} res */
  function startSession(req, res) {
    const token = randomBytes(32).toString("hex");
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    const secure = req.headers["x-forwarded-proto"] === "https" || /** @type {any} */ (req.socket).encrypted;
    res.setHeader(
      "Set-Cookie",
      `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${SESSION_TTL_MS / 1000}${secure ? "; Secure" : ""}`
    );
  }

  /** @param {IncomingMessage} req */
  function checkRateLimit(req) {
    const f = failures.get(remote(req));
    if (f && f.resetAt > Date.now() && f.count >= LOGIN_MAX_FAILURES) {
      throw new StoreError(429, `Too many failed attempts. Try again in ${Math.ceil((f.resetAt - Date.now()) / 60000)} min.`);
    }
  }

  /** @param {IncomingMessage} req */
  function recordFailure(req) {
    const ip = remote(req);
    const f = failures.get(ip);
    if (!f || f.resetAt < Date.now()) failures.set(ip, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
    else f.count += 1;
    logger.warn("admin login failed", { ip });
  }

  /** Same-origin + custom header check for state-changing requests. @param {IncomingMessage} req */
  function checkCsrf(req) {
    const origin = req.headers.origin;
    let sameOrigin = false;
    try {
      sameOrigin = Boolean(origin) && new URL(/** @type {string} */ (origin)).host === req.headers.host;
    } catch {}
    if (!sameOrigin || req.headers["x-cgw-admin"] !== "1") {
      throw new StoreError(403, "Cross-site request blocked");
    }
  }

  /** @param {any} p */
  const providerView = (p) => ({ ...p, apiKey: undefined, apiKeyMasked: maskSecret(p.apiKey) });

  function openMode() {
    return !store.requiresClientKey() && (isLoopback(config.host) || config.allowUnauthenticated);
  }

  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @param {string} route  Path after /admin/api
   */
  async function api(req, res, route) {
    const method = req.method || "GET";
    if (method !== "GET" && method !== "HEAD") checkCsrf(req);

    // ── Unauthenticated ──
    if (route === "/session" && method === "GET") {
      return json(res, 200, { authenticated: isAuthenticated(req), setupRequired: !store.hasAdminPassword() });
    }
    if (route === "/setup" && method === "POST") {
      if (store.hasAdminPassword()) throw new StoreError(409, "Admin password is already set");
      checkRateLimit(req);
      const body = await readBody(req);
      if (!setupCode || !safeEqual(String(body.code ?? "").trim().toUpperCase(), setupCode)) {
        recordFailure(req);
        throw new StoreError(401, "Wrong setup code. It's printed in the gateway log at startup.");
      }
      await store.setAdminPassword(body.password);
      logger.info("admin password set via setup");
      startSession(req, res);
      return json(res, 200, { ok: true });
    }
    if (route === "/login" && method === "POST") {
      checkRateLimit(req);
      const body = await readBody(req);
      if (!(await store.verifyAdminPassword(body.password))) {
        recordFailure(req);
        throw new StoreError(401, "Wrong password");
      }
      failures.delete(remote(req));
      startSession(req, res);
      return json(res, 200, { ok: true });
    }
    if (route === "/logout" && method === "POST") {
      sessions.delete(cookieToken(req));
      res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0`);
      return json(res, 200, { ok: true });
    }

    if (!isAuthenticated(req)) throw new StoreError(401, "Not signed in");

    // ── Authenticated ──
    if (route === "/state" && method === "GET") {
      return json(res, 200, {
        ...store.publicView(),
        stats: { ...activity.totals, startedAt: activity.startedAt },
        server: {
          version: VERSION,
          host: config.host,
          port: config.port,
          dataFile: config.dataFile || "(in memory)",
          adminAllowFrom: config.adminAllowFrom,
          openMode: openMode()
        }
      });
    }
    if (route === "/activity" && method === "GET") {
      return json(res, 200, { entries: activity.list(100) });
    }
    if (route === "/password" && method === "POST") {
      const body = await readBody(req);
      if (!(await store.verifyAdminPassword(body.current))) throw new StoreError(401, "Current password is wrong");
      await store.setAdminPassword(body.next);
      // Sign out every other session.
      const keep = cookieToken(req);
      for (const token of sessions.keys()) if (token !== keep) sessions.delete(token);
      return json(res, 200, { ok: true });
    }

    if (route === "/providers" && method === "POST") {
      return json(res, 201, providerView(await store.addProvider(await readBody(req))));
    }
    if (route === "/providers/test" && method === "POST") {
      const body = await readBody(req);
      const stored = body.id ? store.getProvider(String(body.id)) : null;
      if (body.id && !stored) throw new StoreError(404, "Connection not found");
      const baseUrl = String(body.baseUrl || stored?.baseUrl || "");
      const apiKey = String(body.apiKey || stored?.apiKey || "");
      if (!/^https?:\/\//.test(baseUrl)) throw new StoreError(400, "Base URL must be an http(s) URL");
      return json(res, 200, await testConnection(fetchImpl, baseUrl, apiKey));
    }
    let m = route.match(/^\/providers\/([\w-]+)(\/models)?$/);
    if (m) {
      const [, id, models] = m;
      if (models && method === "GET") {
        const p = store.getProvider(id);
        if (!p) throw new StoreError(404, "Connection not found");
        return json(res, 200, await testConnection(fetchImpl, p.baseUrl, p.apiKey));
      }
      if (!models && method === "PATCH") return json(res, 200, providerView(await store.updateProvider(id, await readBody(req))));
      if (!models && method === "DELETE") {
        await store.deleteProvider(id);
        return json(res, 200, { ok: true });
      }
    }

    if (route === "/routes" && method === "PUT") {
      return json(res, 200, await store.setRoutes(await readBody(req)));
    }
    if (route.startsWith("/resolve") && method === "GET") {
      const model = new URL(req.url || "", "http://x").searchParams.get("model") || "";
      const r = resolveRoute(model, store.state);
      return json(res, 200, r ? { provider: r.provider.name, model: r.model, rule: r.rule } : null);
    }

    if (route === "/keys" && method === "POST") {
      const { key, secret } = await store.createClientKey((await readBody(req)).name);
      logger.info("client key created", { name: key.name });
      return json(res, 201, { key: { ...key, hash: undefined }, secret });
    }
    m = route.match(/^\/keys\/([\w-]+)(\/revoke)?$/);
    if (m) {
      const [, id, revoke] = m;
      if (revoke && method === "POST") {
        const key = await store.revokeClientKey(id);
        logger.info("client key revoked", { name: key.name });
        return json(res, 200, { ...key, hash: undefined });
      }
      if (!revoke && method === "DELETE") {
        await store.deleteClientKey(id);
        return json(res, 200, { ok: true });
      }
    }

    throw new StoreError(404, "Unknown admin endpoint");
  }

  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @param {string} pathname
   */
  async function handle(req, res, pathname) {
    const notFound = () => {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    };
    if (!config.adminEnabled) return notFound();
    if (config.adminAllowFrom === "local" && !isLocalNetworkAddress(remote(req))) {
      logger.warn("admin request from non-local address refused", { ip: remote(req) });
      return notFound();
    }
    if (!isAllowedAdminHost(req.headers.host, config.adminHosts)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      return res.end(`Host "${req.headers.host}" is not allowed for the admin UI. Add it to ADMIN_HOSTS.`);
    }
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

    if (pathname.startsWith("/admin/api/")) {
      try {
        return await api(req, res, pathname.slice("/admin/api".length));
      } catch (err) {
        if (err instanceof StoreError || err instanceof GatewayError) return fail(res, err.status, err.message);
        logger.error("admin api error", { error: /** @type {Error} */ (err).stack });
        return fail(res, 500, "Internal error");
      }
    }
    if (pathname === "/admin") {
      res.writeHead(302, { Location: "/admin/" });
      return res.end();
    }
    const file = files[pathname];
    if (!file || (req.method !== "GET" && req.method !== "HEAD")) return notFound();
    res.writeHead(200, { "Content-Type": file.type, "Cache-Control": "no-cache" });
    res.end(req.method === "HEAD" ? undefined : file.body);
  }

  return { handle };
}
