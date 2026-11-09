// @ts-check

/** @typedef {import("./config.js").Config} Config */

/**
 * Pick the upstream model for a requested model name.
 *
 * 1. MODEL_MAP: exact match, then longest matching prefix.
 * 2. Non-Claude names (e.g. `claude --model gpt-4.1`) pass through unchanged.
 * 3. Claude names route by family (opus / sonnet / haiku), so new versions
 *    like `claude-sonnet-4-5` or `claude-haiku-5-5` map without config changes.
 * 4. Anything else goes to DEFAULT_MODEL.
 *
 * @param {string | undefined} requested
 * @param {Pick<Config, "modelMap" | "familyModels" | "defaultModel">} config
 */
export function resolveModel(requested, config) {
  if (!requested) return config.defaultModel;

  if (Object.hasOwn(config.modelMap, requested)) return config.modelMap[requested];
  const prefix = Object.keys(config.modelMap)
    .filter((k) => requested.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  if (prefix) return config.modelMap[prefix];

  if (!/^claude/i.test(requested)) return requested;

  const lower = requested.toLowerCase();
  if (lower.includes("haiku")) return config.familyModels.haiku;
  if (lower.includes("sonnet")) return config.familyModels.sonnet;
  if (lower.includes("opus")) return config.familyModels.opus;
  return config.defaultModel;
}

/**
 * Reasoning models reject `max_tokens` / `temperature` / `top_p` and need
 * `max_completion_tokens` instead.
 *
 * @param {string} model
 * @param {Pick<Config, "reasoningPattern">} config
 */
export function isReasoningModel(model, config) {
  return config.reasoningPattern.test(model);
}
