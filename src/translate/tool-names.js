// @ts-check
import { createHash } from "node:crypto";

const VALID = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * OpenAI requires tool names matching ^[a-zA-Z0-9_-]{1,64}$; Anthropic (and long
 * MCP tool names) don't. Invalid names are sanitized and suffixed with a short hash
 * so distinct originals can't collide. Deterministic, so names in conversation
 * history map the same way on every turn.
 *
 * @param {string} name
 */
export function toUpstreamToolName(name) {
  if (VALID.test(name)) return name;
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${cleaned.slice(0, 55)}_${hash}`;
}

/** Tracks renamed tools for one request so responses can be mapped back. */
export class ToolNames {
  /** @type {Map<string, string>} */
  #toOriginal = new Map();

  /** @param {string} name */
  register(name) {
    const upstream = toUpstreamToolName(name);
    this.#toOriginal.set(upstream, name);
    return upstream;
  }

  /** @param {string} upstreamName */
  toOriginal(upstreamName) {
    return this.#toOriginal.get(upstreamName) ?? upstreamName;
  }
}
