// @ts-check

const IMAGE_TOKENS = 1600; // Anthropic's guidance for a ~1.15MP image
const PDF_BYTES_PER_TOKEN = 100;

/**
 * Rough token estimate for /v1/messages/count_tokens. Text counts ~4 chars per
 * token; base64 media counts as media, not as text.
 *
 * @param {any} body
 */
export function estimateInputTokens(body) {
  let chars = 0;
  let fixed = 0;

  /** @param {any} node */
  const walk = (node) => {
    if (typeof node === "string") {
      chars += node.length;
    } else if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === "object") {
      if (node.type === "image") {
        fixed += IMAGE_TOKENS;
        return;
      }
      if (node.type === "document" && node.source?.type === "base64") {
        fixed += Math.ceil(((node.source.data?.length ?? 0) * 0.75) / PDF_BYTES_PER_TOKEN);
        return;
      }
      for (const [k, v] of Object.entries(node)) {
        if (k === "cache_control") continue;
        chars += k.length;
        walk(v);
      }
    }
  };

  walk(body?.system);
  walk(body?.messages);
  walk(body?.tools);
  return Math.max(1, Math.ceil(chars / 4) + fixed);
}
