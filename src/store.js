// @ts-check
import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomBytes, createHash, scrypt as scryptCb, timingSafeEqual } from "node:crypto";

/** @typedef {import("./config.js").Seed} Seed */
/** @typedef {import("./logger.js").Logger} Logger */

/**
 * @typedef {object} Provider
 * @property {string} id
 * @property {string} name
 * @property {string} baseUrl
 * @property {string} apiKey
 * @property {number | null} maxOutputTokens
 * @property {string} reasoningPattern   Regex source; "" = gateway default
 * @property {AuthScheme} authScheme     How the API key is sent
 * @property {string} authHeader         Header name when authScheme is "header"
 * @property {string} queryParams        Appended to every request URL, e.g. "api-version=2024-10-21"
 * @property {boolean} parameterRetry    Retry once without parameters the provider rejected
 * @property {string} createdAt
 *
 * @typedef {{ provider: string, model: string }} Route
 * @typedef {{ match: string, provider: string, model: string }} RouteOverride
 * @typedef {{ id: string, displayName: string, description: string, provider: string, model: string }} CustomModel
 *   A model of your own, listed on /v1/models so it appears in Claude Code's /model picker.
 * @typedef {{ default: Route | null, opus: Route | null, sonnet: Route | null, haiku: Route | null, fable: Route | null,
 *   models: CustomModel[], overrides: RouteOverride[] }} Routes
 *
 * @typedef {object} ClientKey
 * @property {string} id
 * @property {string} name
 * @property {string} prefix       First characters of the key, for recognition
 * @property {string} hash         sha256 of the full key
 * @property {string} createdAt
 * @property {string | null} lastUsedAt
 * @property {string | null} revokedAt
 * @property {{ requests: number, inputTokens: number, outputTokens: number }} usage
 *
 * @typedef {object} State
 * @property {1} version
 * @property {Provider[]} providers
 * @property {Routes} routes
 * @property {ClientKey[]} clientKeys
 * @property {{ passwordHash: string }} admin
 * @property {{ requireClientKey: boolean }} security  Set once the first client key exists; never unset
 */

export class StoreError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const FAMILIES = /** @type {const} */ (["opus", "sonnet", "haiku", "fable"]);

/**
 * How a connection's API key is sent.
 * - `bearer`   `Authorization: Bearer <key>` (default, what most providers want)
 * - `x-api-key`  `x-api-key: <key>`
 * - `header`   a header you name yourself (e.g. Azure's `api-key`)
 * - `none`     no credential (a local server that needs none)
 * @typedef {"bearer" | "x-api-key" | "header" | "none"} AuthScheme
 */
export const AUTH_SCHEMES = /** @type {const} */ (["bearer", "x-api-key", "header", "none"]);

/**
 * Claude Code only adds discovered models whose id contains "claude" or
 * "anthropic" to its /model picker, and sends the id verbatim as `model`.
 */
const CUSTOM_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const USAGE_FLUSH_MS = 5000;

const newId = (/** @type {string} */ prefix) => `${prefix}_${randomBytes(6).toString("hex")}`;
const sha256 = (/** @type {string} */ s) => createHash("sha256").update(s).digest();
const now = () => new Date().toISOString();

/** @returns {State} */
export function emptyState() {
  return {
    version: 1,
    providers: [],
    routes: { default: null, opus: null, sonnet: null, haiku: null, fable: null, models: [], overrides: [] },
    clientKeys: [],
    admin: { passwordHash: "" },
    security: { requireClientKey: false }
  };
}

/**
 * @param {string} password
 * @param {Buffer} salt
 * @returns {Promise<Buffer>}
 */
function scrypt(password, salt) {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, 32, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key)))
  );
}

/** @param {string} password */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** @param {string} password @param {string} stored */
export async function verifyPassword(password, stored) {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Mask a secret for display: "sk-…a9f2". @param {string} secret */
export function maskSecret(secret) {
  if (!secret) return "";
  if (secret.length <= 8) return "••••";
  return `${secret.slice(0, 3)}…${secret.slice(-4)}`;
}

/** @param {string} baseUrl */
function normalizeBaseUrl(baseUrl) {
  const trimmed = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
  } catch {
    throw new StoreError(400, "Base URL must be an http(s) URL, e.g. https://api.openai.com/v1");
  }
  return trimmed;
}

/** @param {unknown} v */
function normalizeMaxTokens(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new StoreError(400, "Max output tokens must be a positive integer");
  return n;
}

/** @param {unknown} v */
function normalizePattern(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  try {
    new RegExp(s, "i");
  } catch {
    throw new StoreError(400, "Reasoning model pattern must be a valid regular expression");
  }
  return s;
}

/** @param {unknown} v @returns {AuthScheme} */
function normalizeAuthScheme(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return "bearer";
  if (!AUTH_SCHEMES.includes(/** @type {any} */ (s))) {
    throw new StoreError(400, `Auth scheme must be one of ${AUTH_SCHEMES.join(", ")}`);
  }
  return /** @type {AuthScheme} */ (s);
}

/**
 * A header name for `authScheme: "header"`. Restricted to characters that are
 * legal in a token, so it can never inject a header or split a request.
 * @param {unknown} v
 */
function normalizeAuthHeader(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (!/^[A-Za-z0-9-]{1,64}$/.test(s)) {
    throw new StoreError(400, "Auth header name may only contain letters, digits and hyphens");
  }
  return s;
}

/**
 * A query string appended to every request URL, e.g. Azure's
 * `api-version=2024-10-21`. Leading `?` and `&` are accepted and stripped; the
 * value is percent-encoded as one parameter pair per `&`.
 * @param {unknown} v
 */
function normalizeQueryParams(v) {
  const s = String(v ?? "").trim().replace(/^[?&]+/, "");
  if (!s) return "";
  if (s.length > 1024) throw new StoreError(400, "Query parameters must be at most 1024 characters");
  try {
    // Throws on a lone "%" or a malformed escape, which would break URL building.
    new URLSearchParams(s);
  } catch {
    throw new StoreError(400, "Query parameters must be a valid query string, e.g. api-version=2024-10-21");
  }
  return s;
}

/**
 * A provider as the rest of the gateway sees it: every newer field present,
 * whatever shape the record on disk is in. Older store files predate these
 * fields, so they are filled from the defaults instead of leaving `undefined`.
 * @param {any} p
 * @returns {Provider}
 */
export function withProviderDefaults(p) {
  return {
    ...p,
    authScheme: AUTH_SCHEMES.includes(p?.authScheme) ? p.authScheme : "bearer",
    authHeader: typeof p?.authHeader === "string" ? p.authHeader : "",
    queryParams: typeof p?.queryParams === "string" ? p.queryParams : "",
    parameterRetry: p?.parameterRetry === false ? false : true
  };
}

/** @param {unknown} v @param {string} what */
function requireText(v, what, max = 80) {
  const s = String(v ?? "").trim();
  if (!s) throw new StoreError(400, `${what} is required`);
  if (s.length > max) throw new StoreError(400, `${what} must be at most ${max} characters`);
  return s;
}

/**
 * @param {unknown} input
 * @returns {CustomModel[]}
 */
function normalizeModels(input) {
  const seen = new Set();
  return (Array.isArray(input) ? input : []).map((/** @type {any} */ m) => {
    const id = requireText(m?.id, "Model ID", 100);
    if (!CUSTOM_MODEL_ID.test(id)) {
      throw new StoreError(400, `Model ID "${id}" may only contain letters, digits and . _ : / -`);
    }
    if (!/claude|anthropic/i.test(id)) {
      throw new StoreError(400, `Model ID "${id}" must contain "claude" so Claude Code shows it in /model (e.g. claude-${id})`);
    }
    if (seen.has(id.toLowerCase())) throw new StoreError(400, `Model ID "${id}" is listed twice`);
    seen.add(id.toLowerCase());
    return {
      id,
      displayName: String(m.displayName ?? "").trim().slice(0, 80),
      description: String(m.description ?? "").trim().slice(0, 200),
      provider: requireText(m.provider, `Connection for ${id}`),
      model: requireText(m.model, `Upstream model for ${id}`, 200)
    };
  });
}

/**
 * Persistent gateway state: upstream providers, model routes, client keys and
 * the admin password. Stored as one JSON file (mode 0600), written atomically.
 * Emits "change" after every successful update.
 */
export class Store extends EventEmitter {
  /** @type {State} */
  #state;
  #file;
  #logger;
  /** @type {Promise<void>} */
  #writes = Promise.resolve();
  /** @type {NodeJS.Timeout | null} */
  #usageTimer = null;

  /**
   * @param {State} state
   * @param {string} file  "" for in-memory
   * @param {Logger} logger
   */
  constructor(state, file, logger) {
    super();
    this.#state = state;
    this.#file = file;
    this.#logger = logger;
  }

  /**
   * Open (or create) the store. A new store is seeded from the environment.
   * @param {{ file: string, seed?: Seed, logger: Logger }} opts
   */
  static async open({ file, seed, logger }) {
    let state;
    let created = false;
    if (file) {
      try {
        const raw = await fs.readFile(file, "utf8");
        const parsed = JSON.parse(raw);
        const base = emptyState();
        state = {
          ...base,
          ...parsed,
          routes: { ...base.routes, ...parsed.routes },
          security: { ...base.security, ...parsed.security }
        };
        const { mode } = await fs.stat(file);
        if (mode & 0o077) {
          await fs.chmod(file, 0o600);
          logger.warn("store file was readable by others; permissions reset to 0600", { file });
        }
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") {
          throw new Error(`Cannot read store ${file}: ${/** @type {Error} */ (err).message}`);
        }
      }
    }
    if (!state) {
      state = emptyState();
      created = true;
    }
    const store = new Store(state, file, logger);
    if (created && seed) store.#seed(seed);
    if (seed?.adminPassword && !store.hasAdminPassword()) {
      store.#state.admin.passwordHash = await hashPassword(seed.adminPassword);
    }
    if (created || seed?.adminPassword) await store.#persist();
    if (created) logger.info("created gateway store", { file: file || "(memory)", providers: state.providers.length, clientKeys: state.clientKeys.length });
    return store;
  }

  /** @param {Seed} seed */
  #seed(seed) {
    const s = this.#state;
    if (seed.baseUrl && seed.apiKey) {
      const provider = {
        id: newId("prv"),
        name: new URL(seed.baseUrl).hostname.replace(/^api\./, ""),
        baseUrl: seed.baseUrl,
        apiKey: seed.apiKey,
        maxOutputTokens: seed.maxOutputTokens,
        reasoningPattern: seed.reasoningPattern,
        authScheme: /** @type {AuthScheme} */ ("bearer"),
        authHeader: "",
        queryParams: "",
        parameterRetry: true,
        createdAt: now()
      };
      s.providers.push(provider);
      s.routes.default = { provider: provider.id, model: seed.defaultModel };
      for (const family of FAMILIES) {
        const model = seed.familyModels[family];
        if (model && model !== seed.defaultModel) s.routes[family] = { provider: provider.id, model };
      }
      s.routes.overrides = Object.entries(seed.modelMap).map(([match, model]) => ({ match, provider: provider.id, model }));
    }
    if (seed.gatewayApiKey) {
      s.clientKeys.push(this.#newKeyRecord("from GATEWAY_API_KEY", seed.gatewayApiKey));
      s.security.requireClientKey = true;
    }
  }

  /** @param {string} name @param {string} secret @returns {ClientKey} */
  #newKeyRecord(name, secret) {
    return {
      id: newId("key"),
      name,
      prefix: secret.slice(0, 10),
      hash: sha256(secret).toString("hex"),
      createdAt: now(),
      lastUsedAt: null,
      revokedAt: null,
      usage: { requests: 0, inputTokens: 0, outputTokens: 0 }
    };
  }

  /** Current state. Treat as read-only; it is replaced (not mutated) on update. */
  /**
   * The live state. Providers are passed through `withProviderDefaults`, so a
   * record written by an older version of the gateway still has every field.
   */
  get state() {
    return { ...this.#state, providers: this.#state.providers.map(withProviderDefaults) };
  }

  /**
   * Apply a change atomically: mutate a copy, validate, swap, persist.
   * @template T
   * @param {(draft: State) => T} fn
   * @returns {Promise<T>}
   */
  async #update(fn) {
    const draft = structuredClone(this.#state);
    const result = fn(draft);
    this.#validate(draft);
    this.#state = draft;
    await this.#persist();
    this.emit("change");
    return result;
  }

  /** @param {State} s */
  #validate(s) {
    const ids = new Set(s.providers.map((p) => p.id));
    const names = new Set();
    for (const p of s.providers) {
      const key = p.name.toLowerCase();
      if (names.has(key)) throw new StoreError(409, `A connection named "${p.name}" already exists`);
      names.add(key);
    }
    const routes = [s.routes.default, ...FAMILIES.map((f) => s.routes[f]), ...s.routes.models, ...s.routes.overrides];
    for (const r of routes) {
      if (r && !ids.has(r.provider)) throw new StoreError(400, "A route points at a connection that does not exist");
    }
  }

  async #persist() {
    if (!this.#file) return;
    const file = this.#file;
    const data = JSON.stringify(this.#state, null, 2);
    // Serialize writes so an older snapshot never lands after a newer one.
    this.#writes = this.#writes
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, data, { mode: 0o600 });
        await fs.rename(tmp, file);
      });
    return this.#writes;
  }

  /** Write pending usage counters now (call on shutdown). */
  async flush() {
    if (this.#usageTimer) {
      clearTimeout(this.#usageTimer);
      this.#usageTimer = null;
    }
    await this.#persist();
  }

  // ── Providers ───────────────────────────────────────────────────────────

  /** @param {string} id */
  getProvider(id) {
    const p = this.#state.providers.find((x) => x.id === id);
    return p ? withProviderDefaults(p) : null;
  }

  /** @param {any} input */
  addProvider(input) {
    return this.#update((s) => {
      const authScheme = normalizeAuthScheme(input.authScheme);
      if (authScheme === "header" && !normalizeAuthHeader(input.authHeader)) {
        throw new StoreError(400, "Name the header to send the key in (for Azure OpenAI this is “api-key”)");
      }
      const provider = {
        id: newId("prv"),
        name: requireText(input.name, "Name"),
        baseUrl: normalizeBaseUrl(input.baseUrl),
        apiKey: requireText(input.apiKey, "API key", 4096),
        maxOutputTokens: normalizeMaxTokens(input.maxOutputTokens),
        reasoningPattern: normalizePattern(input.reasoningPattern),
        authScheme: normalizeAuthScheme(input.authScheme),
        authHeader: normalizeAuthHeader(input.authHeader),
        queryParams: normalizeQueryParams(input.queryParams),
        parameterRetry: input.parameterRetry === false ? false : true,
        createdAt: now()
      };
      s.providers.push(provider);
      // The first connection becomes the default route so the gateway works immediately.
      if (!s.routes.default && input.defaultModel) s.routes.default = { provider: provider.id, model: String(input.defaultModel).trim() };
      return provider;
    });
  }

  /** @param {string} id @param {any} patch  Empty apiKey keeps the current key */
  updateProvider(id, patch) {
    return this.#update((s) => {
      const p = s.providers.find((x) => x.id === id);
      if (!p) throw new StoreError(404, "Connection not found");
      if (patch.name !== undefined) p.name = requireText(patch.name, "Name");
      if (patch.baseUrl !== undefined) p.baseUrl = normalizeBaseUrl(patch.baseUrl);
      if (patch.apiKey) p.apiKey = requireText(patch.apiKey, "API key", 4096);
      if (patch.maxOutputTokens !== undefined) p.maxOutputTokens = normalizeMaxTokens(patch.maxOutputTokens);
      if (patch.reasoningPattern !== undefined) p.reasoningPattern = normalizePattern(patch.reasoningPattern);
      if (patch.authScheme !== undefined) p.authScheme = normalizeAuthScheme(patch.authScheme);
      if (patch.authHeader !== undefined) p.authHeader = normalizeAuthHeader(patch.authHeader);
      if (patch.queryParams !== undefined) p.queryParams = normalizeQueryParams(patch.queryParams);
      if (patch.parameterRetry !== undefined) p.parameterRetry = patch.parameterRetry !== false;
      if (p.authScheme === "header" && !p.authHeader) {
        throw new StoreError(400, "Name the header to send the key in (for Azure OpenAI this is “api-key”)");
      }
      return p;
    });
  }

  /** @param {string} id */
  deleteProvider(id) {
    return this.#update((s) => {
      if (!s.providers.some((p) => p.id === id)) throw new StoreError(404, "Connection not found");
      const r = s.routes;
      if ([r.default, ...FAMILIES.map((f) => r[f]), ...r.models, ...r.overrides].some((x) => x?.provider === id)) {
        throw new StoreError(409, "This connection is used by a route. Change the routes first.");
      }
      s.providers = s.providers.filter((p) => p.id !== id);
    });
  }

  // ── Routes ──────────────────────────────────────────────────────────────

  /** @param {any} input */
  setRoutes(input) {
    /** @param {any} r @param {string} what @returns {Route | null} */
    const route = (r, what) => {
      if (!r || !r.provider) return null;
      return { provider: String(r.provider), model: requireText(r.model, `${what} model`, 200) };
    };
    return this.#update((s) => {
      const def = route(input.default, "Default");
      if (!def && s.providers.length) throw new StoreError(400, "The default route needs a connection and a model");
      s.routes = {
        default: def,
        opus: route(input.opus, "Opus"),
        fable: route(input.fable, "Fable"),
        models: normalizeModels(input.models),
        sonnet: route(input.sonnet, "Sonnet"),
        haiku: route(input.haiku, "Haiku"),
        overrides: (Array.isArray(input.overrides) ? input.overrides : []).map((/** @type {any} */ o) => ({
          match: requireText(o.match, "Override model name", 200),
          provider: requireText(o.provider, "Override connection"),
          model: requireText(o.model, "Override model", 200)
        }))
      };
      return s.routes;
    });
  }

  // ── Client keys ─────────────────────────────────────────────────────────

  /** @param {string} name @returns {Promise<{ key: ClientKey, secret: string }>} */
  createClientKey(name) {
    const secret = `cgw_${randomBytes(24).toString("base64url")}`;
    return this.#update((s) => {
      const key = this.#newKeyRecord(requireText(name, "Key name", 60), secret);
      s.clientKeys.push(key);
      s.security.requireClientKey = true;
      return { key, secret };
    });
  }

  /** @param {string} id */
  revokeClientKey(id) {
    return this.#update((s) => {
      const k = s.clientKeys.find((x) => x.id === id);
      if (!k) throw new StoreError(404, "Key not found");
      k.revokedAt ??= now();
      return k;
    });
  }

  /** @param {string} id */
  deleteClientKey(id) {
    return this.#update((s) => {
      if (!s.clientKeys.some((k) => k.id === id)) throw new StoreError(404, "Key not found");
      s.clientKeys = s.clientKeys.filter((k) => k.id !== id);
    });
  }

  /**
   * True once any client key has been created. Revoking or deleting every key
   * then locks the gateway rather than silently reopening it.
   */
  requiresClientKey() {
    return this.#state.security.requireClientKey;
  }

  hasActiveClientKeys() {
    return this.#state.clientKeys.some((k) => !k.revokedAt);
  }

  /**
   * Find the active key matching a presented secret (constant-time per key).
   * @param {string} secret
   * @returns {ClientKey | null}
   */
  verifyClientKey(secret) {
    if (!secret) return null;
    const presented = sha256(secret);
    let match = null;
    for (const k of this.#state.clientKeys) {
      if (timingSafeEqual(presented, Buffer.from(k.hash, "hex")) && !k.revokedAt) match = k;
    }
    return match;
  }

  /**
   * Count a request against a key. Updated in place and flushed to disk
   * periodically, not on every request.
   * @param {string} keyId
   * @param {{ inputTokens?: number, outputTokens?: number }} usage
   */
  recordUsage(keyId, { inputTokens = 0, outputTokens = 0 }) {
    const k = this.#state.clientKeys.find((x) => x.id === keyId);
    if (!k) return;
    k.usage.requests += 1;
    k.usage.inputTokens += inputTokens;
    k.usage.outputTokens += outputTokens;
    k.lastUsedAt = now();
    if (!this.#usageTimer && this.#file) {
      this.#usageTimer = setTimeout(() => {
        this.#usageTimer = null;
        this.#persist().catch((err) => this.#logger.error("failed to save usage", { error: err.message }));
      }, USAGE_FLUSH_MS);
      this.#usageTimer.unref();
    }
  }

  // ── Admin ───────────────────────────────────────────────────────────────

  hasAdminPassword() {
    return Boolean(this.#state.admin.passwordHash);
  }

  /** @param {string} password */
  verifyAdminPassword(password) {
    return this.hasAdminPassword() ? verifyPassword(String(password ?? ""), this.#state.admin.passwordHash) : Promise.resolve(false);
  }

  /** @param {string} password */
  async setAdminPassword(password) {
    const pw = String(password ?? "");
    if (pw.length < 10) throw new StoreError(400, "Password must be at least 10 characters");
    const hash = await hashPassword(pw);
    await this.#update((s) => {
      s.admin.passwordHash = hash;
    });
  }

  // ── Views ───────────────────────────────────────────────────────────────

  /** State safe to send to the admin UI: secrets masked, hashes removed. */
  publicView() {
    const s = this.#state;
    return {
      providers: s.providers.map((p) => ({ ...p, apiKey: undefined, apiKeyMasked: maskSecret(p.apiKey) })),
      routes: s.routes,
      clientKeys: s.clientKeys.map((k) => ({ ...k, hash: undefined }))
    };
  }
}
