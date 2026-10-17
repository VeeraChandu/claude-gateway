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

// Unknown Claude model names we've already complained about, so a long session
// doesn't print the same warning on every request.
const warnedUnknownModels = new Set();

export const config = {
  port: parseInt(getEnv("PORT", "8080"), 10),
  host: getEnv("HOST", "127.0.0.1"),
  openaiApiKey: resolvedApiKey,
  openaiBaseUrl: baseUrl,
  defaultModel: getEnv("DEFAULT_MODEL", "gpt-4o"),

  // Map specific Claude models to target models.
  // Keys are matched as substrings (case-insensitive) so this keeps working as
  // Anthropic ships new model versions without needing a config change.
  modelMappings: {
    "sonnet": getEnv("MODEL_SONNET", getEnv("DEFAULT_MODEL", "gpt-4o")),
    "haiku": getEnv("MODEL_HAIKU", getEnv("DEFAULT_MODEL", "gpt-4o-mini")),
    "opus": getEnv("MODEL_OPUS", getEnv("DEFAULT_MODEL", "gpt-4o")),
  },

  // Determine if a model is an OpenAI reasoning model (o1, o3, etc.)
  isReasoningModel: (model) => {
    return /^o[13](?:-|$)/i.test(model) || model.includes("reasoner");
  },

  // Resolve model name
  resolveModel: (requestedModel) => {
    if (!requestedModel) return config.defaultModel;
    const lower = requestedModel.toLowerCase();

    // Match on the family name anywhere in the string, longest key first, so
    // claude-3-5-sonnet-20241022 and claude-sonnet-5-5 both hit "sonnet".
    const keys = Object.keys(config.modelMappings).sort((a, b) => b.length - a.length);
    for (const key of keys) {
      if (lower.includes(key)) {
        return config.modelMappings[key];
      }
    }

    // Not a Claude alias — pass the name through to the backend untouched so
    // explicit backend model names (e.g. deepseek-v4-1-flash) are honored.
    if (!lower.startsWith("claude")) {
      return requestedModel;
    }

    // A Claude name we don't recognize, probably a new tier we have no mapping
    // for. Falling back silently is what turned an unknown model into a wrong
    // model before, so say so loudly — once per distinct name.
    if (!warnedUnknownModels.has(lower)) {
      warnedUnknownModels.add(lower);
      console.warn(
        `\x1b[33m[Config Warning]\x1b[0m Unrecognized Claude model ` +
          `\x1b[1m${requestedModel}\x1b[0m matches no family in modelMappings ` +
          `(${Object.keys(config.modelMappings).join(", ")}). ` +
          `Falling back to DEFAULT_MODEL \x1b[1m${config.defaultModel}\x1b[0m. ` +
          `Add a mapping if this should route elsewhere.`
      );
    }

    return config.defaultModel;
  }
};
