// @ts-check
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "./env.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Matches OpenAI o-series, gpt-5*, and DeepSeek-style "reasoner" models (optionally provider-prefixed). */
export const DEFAULT_REASONING_PATTERN = /(^|\/)(o\d+(-|$)|gpt-5)|reasoner/i;

/**
 * @typedef {object} Config
 * @property {number} port
 * @property {string} host
 * @property {string} upstreamBaseUrl
 * @property {string} upstreamApiKey
 * @property {string} gatewayApiKey
 * @property {boolean} passthroughClientKey
 * @property {string} defaultModel
 * @property {{ opus: string, sonnet: string, haiku: string }} familyModels
 * @property {Record<string, string>} modelMap
 * @property {RegExp} reasoningPattern
 * @property {number | null} maxOutputTokens
 * @property {number} maxBodyBytes
 * @property {number} upstreamTimeoutMs
 * @property {number} streamIdleTimeoutMs
 * @property {number} maxRetries
 * @property {"json" | "pretty"} logFormat
 * @property {"debug" | "info" | "warn" | "error"} logLevel
 * @property {number} shutdownTimeoutMs
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
  const bool = (/** @type {string} */ key) => /^(1|true|yes|on)$/i.test(get(key));

  const port = int("PORT", 8080, 0, 65535);
  const host = get("HOST", "127.0.0.1");

  const upstreamBaseUrl = get("OPENAI_BASE_URL", "https://api.openai.com/v1").replace(/\/+$/, "");
  try {
    const u = new URL(upstreamBaseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
  } catch {
    problems.push(`OPENAI_BASE_URL must be an http(s) URL (got "${upstreamBaseUrl}")`);
  }

  const upstreamApiKey = get("OPENAI_API_KEY");
  const gatewayApiKey = get("GATEWAY_API_KEY");
  const passthroughClientKey = bool("PASSTHROUGH_CLIENT_KEY");
  const allowUnauthenticated = bool("ALLOW_UNAUTHENTICATED");

  if (!upstreamApiKey && !passthroughClientKey) {
    const refs = meta.unresolved?.OPENAI_API_KEY;
    problems.push(
      refs
        ? `OPENAI_API_KEY in .env references \${${refs.join("}, ${")}}, which is not set in your shell`
        : "OPENAI_API_KEY is not set (use any non-empty value for keyless providers like Ollama), " +
            "or set PASSTHROUGH_CLIENT_KEY=true to forward each client's own key"
    );
  }
  if (passthroughClientKey && gatewayApiKey) {
    warnings.push("GATEWAY_API_KEY is ignored when PASSTHROUGH_CLIENT_KEY=true (the client key is forwarded upstream)");
  }
  if (!isLoopback(host) && !gatewayApiKey && !passthroughClientKey && !allowUnauthenticated) {
    problems.push(
      `HOST=${host} exposes the gateway beyond this machine without authentication. ` +
        "Set GATEWAY_API_KEY (clients send it as ANTHROPIC_API_KEY), or ALLOW_UNAUTHENTICATED=true if " +
        "something else already restricts access"
    );
  }
  if (gatewayApiKey && gatewayApiKey.length < 16) {
    warnings.push("GATEWAY_API_KEY is shorter than 16 characters; consider `openssl rand -hex 24`");
  }

  const defaultModel = get("DEFAULT_MODEL", "gpt-4o");
  const familyModels = {
    opus: get("MODEL_OPUS", defaultModel),
    sonnet: get("MODEL_SONNET", defaultModel),
    haiku: get("MODEL_HAIKU", defaultModel)
  };

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

  let reasoningPattern = DEFAULT_REASONING_PATTERN;
  const rawPattern = get("REASONING_MODELS");
  if (rawPattern) {
    try {
      reasoningPattern = new RegExp(rawPattern, "i");
    } catch (err) {
      problems.push(`REASONING_MODELS must be a valid regular expression (${/** @type {Error} */ (err).message})`);
    }
  }

  const maxOutputTokensRaw = int("MAX_OUTPUT_TOKENS", 0, 0);
  const logFormatRaw = get("LOG_FORMAT", meta.stdoutIsTTY ? "pretty" : "json");
  if (logFormatRaw !== "json" && logFormatRaw !== "pretty") problems.push(`LOG_FORMAT must be "json" or "pretty"`);
  const logLevelRaw = get("LOG_LEVEL", "info");
  if (!["debug", "info", "warn", "error"].includes(logLevelRaw)) problems.push(`LOG_LEVEL must be debug, info, warn or error`);

  const config = {
    port,
    host,
    upstreamBaseUrl,
    upstreamApiKey,
    gatewayApiKey: passthroughClientKey ? "" : gatewayApiKey,
    passthroughClientKey,
    defaultModel,
    familyModels,
    modelMap,
    reasoningPattern,
    maxOutputTokens: maxOutputTokensRaw || null,
    maxBodyBytes: int("MAX_BODY_MB", 32, 1, 1024) * 1024 * 1024,
    upstreamTimeoutMs: int("UPSTREAM_TIMEOUT_MS", 300_000, 1000),
    streamIdleTimeoutMs: int("STREAM_IDLE_TIMEOUT_MS", 300_000, 1000),
    maxRetries: int("UPSTREAM_MAX_RETRIES", 2, 0, 10),
    logFormat: /** @type {"json" | "pretty"} */ (logFormatRaw),
    logLevel: /** @type {Config["logLevel"]} */ (logLevelRaw),
    shutdownTimeoutMs: int("SHUTDOWN_TIMEOUT_MS", 8000, 0),
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
