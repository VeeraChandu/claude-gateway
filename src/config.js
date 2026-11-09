// @ts-check
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "./env.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Matches OpenAI o-series, gpt-5*, and DeepSeek-style "reasoner" models (optionally provider-prefixed). */
export const DEFAULT_REASONING_PATTERN = /(^|\/)(o\d+(-|$)|gpt-5)|reasoner/i;

/**
 * Values from the environment used only to seed the store on first start.
 * After that, connections, routes and keys are managed in the admin UI.
 *
 * @typedef {object} Seed
 * @property {string} baseUrl
 * @property {string} apiKey
 * @property {string} defaultModel
 * @property {{ opus?: string, sonnet?: string, haiku?: string }} familyModels  Only explicitly set ones
 * @property {Record<string, string>} modelMap
 * @property {string} reasoningPattern  Source of REASONING_MODELS, or ""
 * @property {number | null} maxOutputTokens
 * @property {string} gatewayApiKey
 * @property {string} adminPassword
 */

/**
 * @typedef {object} Config
 * @property {number} port
 * @property {string} host
 * @property {string} dataFile         Path of the JSON store, or "" for in-memory
 * @property {boolean} allowUnauthenticated
 * @property {boolean} adminEnabled
 * @property {"local" | "any"} adminAllowFrom  "local" = loopback, private networks and Tailscale
 * @property {string[]} adminHosts     Extra Host header names allowed for the admin UI
 * @property {number} maxBodyBytes
 * @property {number} upstreamTimeoutMs
 * @property {number} streamIdleTimeoutMs
 * @property {number} maxRetries
 * @property {"json" | "pretty"} logFormat
 * @property {"debug" | "info" | "warn" | "error"} logLevel
 * @property {number} shutdownTimeoutMs
 * @property {Seed} seed
 * @property {string[]} warnings
 */

export class ConfigError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`Invalid gateway configuration:\n  - ${problems.join("\n  - ")}`);
    this.problems = problems;
  }
}

/** @param {string} host */
export function isLoopback(host) {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

/**
 * Build a validated config from a flat env object. Pure: no file or process access.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ unresolved?: Record<string, string[]>, stdoutIsTTY?: boolean }} [meta]
 * @returns {Config}
 */
export function loadConfig(env, meta = {}) {
  const problems = [];
  const warnings = [];
  const get = (/** @type {string} */ key, fallback = "") => {
    const v = env[key];
    return v === undefined || v === "" ? fallback : v.trim();
  };
  const int = (/** @type {string} */ key, /** @type {number} */ fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    const raw = get(key);
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${key} must be an integer between ${min} and ${max} (got "${raw}")`);
      return fallback;
    }
    return n;
  };
  const bool = (/** @type {string} */ key, fallback = false) => {
    const raw = get(key);
    return raw ? /^(1|true|yes|on)$/i.test(raw) : fallback;
  };

  // ── Seed values (first start only) ──────────────────────────────────────
  const baseUrl = get("OPENAI_BASE_URL").replace(/\/+$/, "");
  if (baseUrl) {
    try {
      const u = new URL(baseUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
    } catch {
      problems.push(`OPENAI_BASE_URL must be an http(s) URL (got "${baseUrl}")`);
    }
  }
  const unresolvedKey = meta.unresolved?.OPENAI_API_KEY;
  if (unresolvedKey && !get("OPENAI_API_KEY")) {
    warnings.push(`OPENAI_API_KEY in .env references \${${unresolvedKey.join("}, ${")}}, which is not set in your shell`);
  }

  /** @type {Record<string, string>} */
  let modelMap = {};
  const rawMap = get("MODEL_MAP");
  if (rawMap) {
    try {
      const parsed = JSON.parse(rawMap);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v !== "string" || !v) throw new Error(`value for "${k}" must be a non-empty string`);
      }
      modelMap = parsed;
    } catch (err) {
      problems.push(`MODEL_MAP must be a JSON object of {"claude-model-prefix": "upstream-model"} (${/** @type {Error} */ (err).message})`);
    }
  }

  const reasoningPattern = get("REASONING_MODELS");
  if (reasoningPattern) {
    try {
      new RegExp(reasoningPattern, "i");
    } catch (err) {
      problems.push(`REASONING_MODELS must be a valid regular expression (${/** @type {Error} */ (err).message})`);
    }
  }

  const defaultModel = get("DEFAULT_MODEL", "gpt-4o");
  /** @type {Seed} */
  const seed = {
    baseUrl,
    apiKey: get("OPENAI_API_KEY"),
    defaultModel,
    familyModels: Object.fromEntries(
      [["opus", "MODEL_OPUS"], ["sonnet", "MODEL_SONNET"], ["haiku", "MODEL_HAIKU"]]
        .filter(([, key]) => get(key))
        .map(([family, key]) => [family, get(key)])
    ),
    modelMap,
    reasoningPattern,
    maxOutputTokens: int("MAX_OUTPUT_TOKENS", 0, 0) || null,
    gatewayApiKey: get("GATEWAY_API_KEY"),
    adminPassword: get("ADMIN_PASSWORD")
  };
  if (seed.adminPassword && seed.adminPassword.length < 10) problems.push("ADMIN_PASSWORD must be at least 10 characters");

  // ── Server settings ─────────────────────────────────────────────────────
  const host = get("HOST", "127.0.0.1");
  const adminAllowFrom = get("ADMIN_ALLOW_FROM", "local");
  if (adminAllowFrom !== "local" && adminAllowFrom !== "any") problems.push(`ADMIN_ALLOW_FROM must be "local" or "any"`);
  const dataDir = get("DATA_DIR", path.join(ROOT, "data"));

  const logFormat = get("LOG_FORMAT", meta.stdoutIsTTY ? "pretty" : "json");
  if (logFormat !== "json" && logFormat !== "pretty") problems.push(`LOG_FORMAT must be "json" or "pretty"`);
  const logLevel = get("LOG_LEVEL", "info");
  if (!["debug", "info", "warn", "error"].includes(logLevel)) problems.push(`LOG_LEVEL must be debug, info, warn or error`);

  const config = {
    port: int("PORT", 8080, 0, 65535),
    host,
    dataFile: dataDir === "none" ? "" : path.resolve(dataDir, "gateway.json"),
    allowUnauthenticated: bool("ALLOW_UNAUTHENTICATED"),
    adminEnabled: bool("ADMIN_ENABLED", true),
    adminAllowFrom: /** @type {"local" | "any"} */ (adminAllowFrom),
    adminHosts: get("ADMIN_HOSTS")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    maxBodyBytes: int("MAX_BODY_MB", 32, 1, 1024) * 1024 * 1024,
    upstreamTimeoutMs: int("UPSTREAM_TIMEOUT_MS", 300_000, 1000),
    streamIdleTimeoutMs: int("STREAM_IDLE_TIMEOUT_MS", 300_000, 1000),
    maxRetries: int("UPSTREAM_MAX_RETRIES", 2, 0, 10),
    logFormat: /** @type {"json" | "pretty"} */ (logFormat),
    logLevel: /** @type {Config["logLevel"]} */ (logLevel),
    shutdownTimeoutMs: int("SHUTDOWN_TIMEOUT_MS", 8000, 0),
    seed,
    warnings
  };

  if (problems.length) throw new ConfigError(problems);
  return config;
}

/**
 * OPENAI_* names are commonly exported for other tools; the gateway's own .env
 * must win for these, or a stray shell OPENAI_API_KEY would be sent to another provider.
 */
const FILE_WINS = ["OPENAI_API_KEY", "OPENAI_BASE_URL"];

/**
 * Merge the shell environment with .env values. The shell wins (so
 * `PORT=9000 npm start` works), except for FILE_WINS keys.
 *
 * @param {Record<string, string | undefined>} processEnv
 * @param {Record<string, string>} fileVars
 */
export function mergeEnv(processEnv, fileVars) {
  const merged = { ...fileVars, ...processEnv };
  for (const key of FILE_WINS) if (key in fileVars) merged[key] = fileVars[key];
  return merged;
}

/**
 * Load config from the process environment plus the project's .env file.
 * `${VAR}` inside .env expands from the shell. Set ENV_FILE to use another
 * file, or ENV_FILE=none to skip it.
 *
 * @returns {Config}
 */
export function loadConfigFromEnvironment() {
  const envFile = process.env.ENV_FILE ?? path.join(ROOT, ".env");
  /** @type {Record<string, string>} */
  let fileVars = {};
  /** @type {Record<string, string[]>} */
  let unresolved = {};
  if (envFile !== "none" && fs.existsSync(envFile)) {
    ({ vars: fileVars, unresolved } = parseEnvFile(fs.readFileSync(envFile, "utf8"), process.env));
  }
  return loadConfig(mergeEnv(process.env, fileVars), { unresolved, stdoutIsTTY: process.stdout.isTTY });
}
