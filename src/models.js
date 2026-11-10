// @ts-check
import { DEFAULT_REASONING_PATTERN } from "./config.js";

/** @typedef {import("./store.js").State} State */
/** @typedef {import("./store.js").Provider} Provider */

/**
 * Pick the connection and upstream model for a requested model name.
 *
 * 0. Your models (listed in Claude Code's /model picker): exact id match.
 * 1. Overrides: exact match, then longest matching prefix.
 * 2. Non-Claude names (e.g. `claude --model gpt-4.1`) go to the default
 *    connection with the name unchanged.
 * 3. Claude names route by family (opus / sonnet / haiku / fable), so new versions
 *    like `claude-sonnet-4-5` map without config changes; unset families
 *    fall back to the default route.
 * 4. Anything else uses the default route.
 *
 * The route's fallbacks come along, resolved to their connections, in the order
 * they should be tried.
 *
 * @param {string | undefined} requested
 * @param {State} state
 * @returns {{ provider: Provider, model: string, rule: string, fallbacks: { provider: Provider, model: string }[] } | null}
 */
export function resolveRoute(requested, state) {
  const { routes } = state;
  /** @param {string} id */
  const conn = (id) => state.providers.find((p) => p.id === id);
  /** @param {import("./store.js").Route | null} r @param {string} rule */
  const pick = (r, rule) => {
    const provider = r && conn(r.provider);
    if (!r || !provider) return null;
    const fallbacks = (r.fallbacks ?? []).flatMap((f) => {
      const p = conn(f.provider);
      return p ? [{ provider: p, model: f.model }] : [];
    });
    return { provider, model: r.model, rule, fallbacks };
  };

  const name = requested || "";
  const custom = routes.models.find((m) => m.id === name);
  if (custom) return pick(custom, `model "${custom.id}"`);
  const exact = routes.overrides.find((o) => o.match === name);
  if (exact) return pick(exact, `override "${exact.match}"`);
  const prefix = routes.overrides
    .filter((o) => name.startsWith(o.match))
    .sort((a, b) => b.match.length - a.match.length)[0];
  if (prefix) return pick(prefix, `override "${prefix.match}*"`);

  if (name && !/^claude/i.test(name)) {
    const def = pick(routes.default, "pass-through");
    return def && { ...def, model: name };
  }

  const lower = name.toLowerCase();
  const family = /** @type {const} */ (["haiku", "sonnet", "opus", "fable"]).find((f) => lower.includes(f));
  if (family) {
    const r = pick(routes[family], family);
    if (r) return r;
  }
  return pick(routes.default, "default");
}

/**
 * Reasoning models reject `max_tokens` / `temperature` / `top_p` and need
 * `max_completion_tokens` instead.
 *
 * @param {string} model
 * @param {Pick<Provider, "reasoningPattern">} provider
 */
export function isReasoningModel(model, provider) {
  const pattern = provider.reasoningPattern ? new RegExp(provider.reasoningPattern, "i") : DEFAULT_REASONING_PATTERN;
  return pattern.test(model);
}
