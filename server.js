// @ts-check
import { loadConfigFromEnvironment, ConfigError, isLoopback } from "./src/config.js";
import { createLogger } from "./src/logger.js";
import { createGateway } from "./src/server.js";

let config;
try {
  config = loadConfigFromEnvironment();
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}

const logger = createLogger({ format: config.logFormat, level: config.logLevel });
for (const w of config.warnings) logger.warn(w);

const server = createGateway(config, { logger });

server.on("error", (err) => {
  logger.error("server error", { error: err.message });
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : config.port;
  const url = `http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${port}`;
  logger.info("gateway listening", {
    url,
    upstream: config.upstreamBaseUrl,
    models: { default: config.defaultModel, ...config.familyModels, ...config.modelMap },
    auth: config.passthroughClientKey ? "passthrough" : config.gatewayApiKey ? "gateway-key" : "none",
    exposed: !isLoopback(config.host)
  });
  if (config.logFormat === "pretty") {
    const key = config.gatewayApiKey ? "$GATEWAY_API_KEY" : "local";
    console.log(`\nUse it from Claude Code:\n  ANTHROPIC_BASE_URL=${url} ANTHROPIC_API_KEY=${key} claude\n`);
  }
});

let shuttingDown = false;
/** @param {string} signal */
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutting down", { signal });
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => {
    logger.warn("in-flight requests did not finish in time; closing them", { timeoutMs: config.shutdownTimeoutMs });
    server.closeAllConnections();
    process.exit(0);
  }, config.shutdownTimeoutMs).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
