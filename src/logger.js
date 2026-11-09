// @ts-check

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS = { debug: "\x1b[90m", info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m" };

/**
 * @typedef {(msg: string, fields?: Record<string, unknown>) => void} LogFn
 * @typedef {{ debug: LogFn, info: LogFn, warn: LogFn, error: LogFn }} Logger
 */

/**
 * @param {{ format?: "json" | "pretty", level?: keyof typeof LEVELS, stream?: { write(s: string): unknown } }} [opts]
 * @returns {Logger}
 */
export function createLogger({ format = "json", level = "info", stream = process.stdout } = {}) {
  const min = LEVELS[level];
  /** @param {keyof typeof LEVELS} lvl */
  const make = (lvl) => /** @type {LogFn} */ (msg, fields = {}) => {
    if (LEVELS[lvl] < min) return;
    if (format === "json") {
      stream.write(JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...fields }) + "\n");
      return;
    }
    const extras = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `\x1b[90m${k}=\x1b[0m${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    stream.write(`${COLORS[lvl]}${lvl.toUpperCase().padEnd(5)}\x1b[0m ${msg}${extras ? " " + extras : ""}\n`);
  };
  return { debug: make("debug"), info: make("info"), warn: make("warn"), error: make("error") };
}

/** @type {Logger} */
export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
