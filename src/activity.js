// @ts-check

/**
 * @typedef {object} ActivityEntry
 * @property {string} id
 * @property {string} time
 * @property {string} [keyName]
 * @property {string} [model]          Model Claude Code asked for
 * @property {string} [provider]       Connection name
 * @property {string} [upstreamModel]
 * @property {boolean} [stream]
 * @property {number} status
 * @property {string} [stopReason]
 * @property {number} [ttftMs]
 * @property {number} durationMs
 * @property {number} [inputTokens]
 * @property {number} [outputTokens]
 * @property {string} [error]
 */

/** In-memory ring buffer of recent /v1/messages requests plus totals since start. */
export class Activity {
  /** @type {ActivityEntry[]} */
  #entries = [];
  #limit;
  startedAt = new Date().toISOString();
  totals = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 };

  constructor(limit = 300) {
    this.#limit = limit;
  }

  /** @param {ActivityEntry} entry */
  push(entry) {
    this.#entries.push(entry);
    if (this.#entries.length > this.#limit) this.#entries.shift();
    this.totals.requests += 1;
    if (entry.status >= 400 || entry.error) this.totals.errors += 1;
    this.totals.inputTokens += entry.inputTokens ?? 0;
    this.totals.outputTokens += entry.outputTokens ?? 0;
  }

  /** Most recent first. */
  list(limit = 100) {
    return this.#entries.slice(-limit).reverse();
  }
}
