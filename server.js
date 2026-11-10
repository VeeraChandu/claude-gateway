// @ts-check
import { randomInt } from "node:crypto";
import { loadConfigFromEnvironment, ConfigError, isLoopback } from "./src/config.js";
import { createLogger } from "./src/logger.js";
import { createGateway } from "./src/server.js";
import { Store } from "./src/store.js";

let config;
try {
  config = loadConfigFromEnvironment();
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}

const logger = createLogger({ format: config.logFormat, level: config.logLevel });
for (const w of config.warnings) logger.warn(w);

let store;
try {
  store = await Store.open({ file: config.dataFile, seed: config.seed, logger });
} catch (err) {
  logger.error("cannot open store", { error: /** @type {Error} */ (err).message });
  process.exit(1);
}

// One-time code required to set the admin password, so only someone who can
// read this log can claim a fresh gateway.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const setupCode = store.hasAdminPassword()
  ? ""
  : Array.from({ length: 8 }, (_, i) => (i === 4 ? "-" : "") + ALPHABET[randomInt(ALPHABET.length)]).join("");

const server = createGateway(config, { store, logger, setupCode });

server.on("error", (err) => {
  logger.error("server error", { error: err.message });
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : config.port;
  const host = config.host === "0.0.0.0" || config.host === "::" ? "localhost" : config.host;
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  logger.info("gateway listening", {
    url,
    admin: config.adminEnabled ? `${url}/admin/` : "disabled",
    connections: store.state.providers.map((p) => p.name),
    clientKeys: store.state.clientKeys.filter((k) => !k.revokedAt).length,
    exposed: !isLoopback(config.host)
  });
  if (setupCode && config.adminEnabled) {
    logger.warn(`Admin setup code: ${setupCode} — open ${url}/admin/ to set the admin password`);
  }
  if (!store.hasActiveClientKeys() && (store.requiresClientKey() || (!isLoopback(config.host) && !config.allowUnauthenticated))) {
    logger.warn("no client keys yet: Claude Code requests are rejected until you create one in the admin UI");
  }
});

let shuttingDown = false;
/** @param {string} signal */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutting down", { signal });
  const exit = async () => {
    await store.flush().catch((err) => logger.error("failed to save store", { error: err.message }));
    process.exit(0);
  };
  server.close(exit);
  server.closeIdleConnections();
  setTimeout(() => {
    logger.warn("in-flight requests did not finish in time; closing them", { timeoutMs: config.shutdownTimeoutMs });
    server.closeAllConnections();
    exit();
  }, config.shutdownTimeoutMs).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
