import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load and parse .env manually to ensure file values override parent shell and expand ${VARS}
const envFromFile = {};
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();

    // Remove quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }

    // Expand ${VAR} or $VAR
    val = val.replace(/\$\{?([A-Z0-9_]+)\}?/g, (_, varName) => process.env[varName] || "");
    envFromFile[key] = val;
  }
}

function getEnv(key, fallback = "") {
  return process.env[key] || envFromFile[key] || fallback;
}

const baseUrl = (getEnv("OPENAI_BASE_URL", "https://api.openai.com/v1")).replace(/\/+$/, "");

// Resolve API key smartly based on provider
let resolvedApiKey = envFromFile.OPENAI_API_KEY || process.env.OPENAI_API_KEY || "";

// If pointing to Venice AI, prioritize VENICE_API_TOKEN
if (baseUrl.includes("venice.ai")) {
  if (process.env.VENICE_API_TOKEN && (!resolvedApiKey || resolvedApiKey.startsWith("sk-proj-") || resolvedApiKey.startsWith("${"))) {
    resolvedApiKey = process.env.VENICE_API_TOKEN;
  }
} else if (baseUrl.includes("deepseek.com")) {
  if (process.env.DEEPSEEK_API_KEY && (!resolvedApiKey || resolvedApiKey.startsWith("${"))) {
    resolvedApiKey = process.env.DEEPSEEK_API_KEY;
  }
}

export const config = {
  port: parseInt(getEnv("PORT", "8080"), 10),
  host: getEnv("HOST", "127.0.0.1"),
  openaiApiKey: resolvedApiKey,
  openaiBaseUrl: baseUrl,
  defaultModel: getEnv("DEFAULT_MODEL", "gpt-4o"),

  // Map specific Claude models to target models
  modelMappings: {
    "claude-3-7-sonnet": getEnv("MODEL_SONNET", getEnv("DEFAULT_MODEL", "gpt-4o")),
    "claude-3-5-sonnet": getEnv("MODEL_SONNET", getEnv("DEFAULT_MODEL", "gpt-4o")),
    "claude-3-5-haiku": getEnv("MODEL_HAIKU", getEnv("DEFAULT_MODEL", "gpt-4o-mini")),
    "claude-3-opus": getEnv("MODEL_OPUS", getEnv("DEFAULT_MODEL", "gpt-4o")),
  },

  // Determine if a model is an OpenAI reasoning model (o1, o3, etc.)
  isReasoningModel: (model) => {
    return /^o[13](?:-|$)/i.test(model) || model.includes("reasoner");
  },

  // Resolve model name
  resolveModel: (requestedModel) => {
    if (!requestedModel) return config.defaultModel;
    for (const [prefix, target] of Object.entries(config.modelMappings)) {
      if (requestedModel.startsWith(prefix)) {
        return target;
      }
    }
    return config.defaultModel;
  }
};
