// @ts-check

/**
 * Claude Desktop silently drops a model from its picker when the ID matches a
 * third-party vendor name, even when the ID also contains "claude". Its rule is
 * evaluated denylist-first, so the "claude" prefix is not an exemption:
 *
 *   function Io(e) { const t = e.toLowerCase(); return DENYLIST.test(t) ? false : CLAUDE_OR_FAMILY.test(t) }
 *
 * This module is the same rule, kept in one place so the admin UI can suggest an ID
 * that survives it. Claude Code's own gate is only "the ID contains claude", which is
 * why an ID rejected here can still work in Claude Code.
 *
 * VENDOR_TOKENS is a verbatim copy of the app's deny pattern (56 tokens, from the two
 * identical copies of it in app.asar). It is a snapshot of one Claude Desktop release
 * and it grows over time, so treat a suggestion as a best effort, not a guarantee.
 */

/** @typedef {"ok" | "vendor-name" | "no-claude" | "charset" | "too-long"} IdProblem */

/**
 * Verbatim from Claude Desktop's `Io()`. Eleven tokens are anchored (`\b`, a trailing
 * `-`, a `.`, or `\d`); the other 45 match anywhere, in any word.
 */
const VENDOR_TOKENS = [
  "ark-code", "astron", "command-r", "deepseek",
  "doubao", "gemini", "gemma", "glm",
  "gpt", "grok", "hermes", "hy3",
  "kimi", "lfm", "\\bling\\b", "llama",
  "longcat", "mimo", "minimax", "mistral",
  "mixtral", "moonshot", "nemotron", "openai",
  "phi-", "qianfan", "qwen", "tc-code",
  "\\bunic\\b", "yi-", "stepfun", "step-3",
  "seed-", "bytedance", "hunyuan", "granite",
  "amazon\\.nova", "nova-", "devstral", "ministral",
  "ernie", "codex", "arcee", "trinity",
  "abab", "jamba", "arctic", "solar",
  "mercury", "zamba", "kat-coder", "\\bds-",
  "dpsk", "phi\\d", "\\bk2\\.", "\\bm2\\.",
];

/** Claude's own family words. Desktop treats these as valid model IDs on their own. */
export const FAMILY_WORDS = /** @type {const} */ (["sonnet", "opus", "haiku", "fable", "mythos"]);

/** The gateway's own model-ID rule, from store.js. Kept here so the UI and the store agree. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

/** Anything matching this is dropped by Desktop before its "claude" test runs. */
export const VENDOR_NAME_PATTERN = new RegExp(VENDOR_TOKENS.join("|"), "i");

const FAMILY_ALIAS = new RegExp(`^(${FAMILY_WORDS.join("|")})(-[\\d.]+)?$`);

/**
 * The vendor token in `id`, or "" when it is clean.
 *
 * @param {string} id
 * @returns {string}
 */
export function vendorToken(id) {
  const match = id.toLowerCase().match(VENDOR_NAME_PATTERN);
  return match ? match[0] : "";
}

/**
 * Would Claude Desktop show this ID in its model picker? Mirrors `Io()` exactly,
 * including the deny-first order.
 *
 * @param {string} id
 * @returns {boolean}
 */
export function desktopAccepts(id) {
  const lower = id.toLowerCase();
  if (VENDOR_NAME_PATTERN.test(lower)) return false;
  return FAMILY_ALIAS.test(lower) || ["claude", ...FAMILY_WORDS, "anthropic"].some((w) => lower.includes(w));
}

/**
 * Would the gateway accept this ID as a row under **Your models**? Mirrors the
 * checks in `normalizeModels` (store.js).
 *
 * @param {string} id
 * @returns {boolean}
 */
export function gatewayAccepts(id) {
  return MODEL_ID_PATTERN.test(id) && /claude|anthropic/i.test(id);
}

/**
 * Explain why an ID is not usable, or "ok". Reports the gateway's rules first,
 * since those are the ones that block saving.
 *
 * @param {string} id
 * @returns {IdProblem}
 */
export function checkModelId(id) {
  if (id.length > 100) return "too-long";
  if (!MODEL_ID_PATTERN.test(id)) return "charset";
  if (!/claude|anthropic/i.test(id)) return "no-claude";
  if (vendorToken(id)) return "vendor-name";
  return "ok";
}

/**
 * The vendor token in a *display label*. Used only to decide whether to offer a
 * suggested label, never to reject anything: labels are not filtered by Desktop.
 *
 * @param {string} label
 * @returns {string}
 */
export function labelVendorToken(label) {
  return vendorToken(label);
}

/**
 * Short, stable code for a vendor name. Codes are checked against the deny pattern
 * afterwards, so a code that would itself collide (`ds` → `\bds-`) is lengthened.
 */
const VENDOR_CODES = {
  deepseek: "d",
  doubao: "dou",
  openai: "o",
  gpt: "o",
  chatgpt: "o",
  gemini: "g",
  gemma: "g",
  glm: "z",
  grok: "x",
  qwen: "q",
  mistral: "m",
  mixtral: "m",
  minimax: "mm",
  moonshot: "mo",
  kimi: "k",
  metamodel: "mt",
  meta: "mt",
  llama: "l",
  nemotron: "n",
  nvidia: "nv",
  phi: "p",
  anthropic: "a",
  azure: "az",
  bedrock: "b",
  amazon: "az",
  nova: "an",
  mistralai: "m",
  microsoft: "ms",
  google: "gg",
  cohere: "c",
  command: "co",
  voyage: "v",
  yi: "y",
  ernie: "e",
  hunyuan: "h",
  stepfun: "st",
  step: "s",
  seed: "sd",
  bytedance: "by",
  arcee: "ar",
  trinity: "t",
  abab: "ab",
  jamba: "j",
  arctic: "ac",
  solar: "so",
  mercury: "me",
  granite: "gr",
  olmo: "ol",
  zamba: "zb",
};

/** Longest vendor name first, so "gemma" is matched before "gem". */
const VENDOR_NAMES = Object.keys(VENDOR_CODES).sort((a, b) => b.length - a.length);

/**
 * Turn a vendor name into a code that does not itself trip the deny pattern.
 * A one- or two-letter code can collide (`d` alone is fine, but `d` + `s` gives
 * `\bds-`), so lengthen until it is clear.
 *
 * @param {string} name
 * @returns {string}
 */
function codeFor(name) {
  const base = VENDOR_CODES[name] ?? name.replace(/[^a-z0-9]/g, "").slice(0, 2);
  if (!base) return "";
  for (const candidate of [base, base + "x", base + "x" + "x"]) {
    if (!vendorToken(candidate) && !vendorToken(`claude-${candidate}-`)) return candidate;
  }
  return "gw";
}

/**
 * Split an upstream model name into its vendor and the rest, dropping any
 * namespace (`moonshotai/kimi-k2.5`) and release-channel suffix (`:free`).
 *
 * @param {string} upstream
 * @returns {{ vendor: string, rest: string }}
 */
function splitVendor(upstream) {
  const bare = upstream
    .trim()
    .toLowerCase()
    .replace(/^.*\//, "")
    .replace(/:[a-z0-9-]+$/, "");
  for (const name of VENDOR_NAMES) {
    if (bare.startsWith(name) && bare.length > name.length && /[^a-z]/.test(bare[name.length])) {
      return { vendor: name, rest: bare.slice(name.length).replace(/^[^a-z0-9]+/, "") };
    }
    if (bare.includes(name)) {
      const rest = bare.replace(name, "").replace(/^[^a-z0-9]+/, "").replace(/[^a-z0-9]+$/, "");
      return { vendor: name, rest };
    }
  }
  return { vendor: "", rest: bare };
}

/** Collapse the rest into `-`-separated segments, keeping `1.5` style versions intact. */
const segments = (/** @type {string} */ text) =>
  text
    .replace(/[^a-z0-9._]+/g, "-")
    .replace(/\.(?=[a-z])/g, "-")
    .replace(/[-_.]{2,}/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .split(/[-.]+/)
    .filter(Boolean);

/**
 * Suggest a model ID for an upstream model that Claude Desktop will keep.
 *
 * The shape is `claude-<vendor code>-<model>` — `deepseek-v4-1-flash` becomes
 * `claude-d-v4-1-flash`. When the name has a token Desktop rejects, the offending
 * segment is repaired (`k2.5` → `k2-5`, `phi-4` → `p-4`) rather than dropped, so the
 * suggestion reads as the model it points at. Returns "" for an empty name.
 *
 * @param {string} upstream The upstream model name, e.g. `deepseek-v4-1-flash`
 * @returns {string}
 */
export function suggestModelId(upstream) {
  const trimmed = upstream.trim();
  if (!trimmed) return "";
  // Already an ID of this shape: keep it, so re-running the helper is a no-op.
  if (/^claude-[a-z0-9]/.test(trimmed.toLowerCase()) && !vendorToken(trimmed) && checkModelId(trimmed) === "ok") {
    return trimmed;
  }
  const { vendor, rest } = splitVendor(trimmed);
  let code = vendor ? codeFor(vendor) : "";
  let parts = segments(rest);

  // The vendor is in the upstream name but its token was consumed as the code
  // (`amazon/nova-pro` → `claude-az-pro`). Skip a segment that still repeats it.
  parts = parts.filter((part, i) => i !== 0 || part !== (VENDOR_CODES[vendor] ?? ""));

  // A leading segment that repeats the code is noise: `openai-gpt-6-luna` → `claude-o-6-luna`.
  if (parts.length > 1 && parts[0] === code) parts = parts.slice(1);

  // Repair any segment that would trip the denylist. A version segment goes through
  // untouched (its `.` is safe); anything else has the offending part removed.
  const cleaned = parts
    .map((part) => (vendorToken(part) ? part.replace(VENDOR_NAME_PATTERN, "") : part))
    .map((part) => part.replace(/[^a-z0-9.]+/g, ""))
    .filter(Boolean);

  const id = ["claude", code, ...cleaned].join("-").replace(/-{2,}/g, "-").replace(/[-.]+$/, "");
  if (!cleaned.length || !gatewayAccepts(id) || vendorToken(id)) return "";
  return id;
}
