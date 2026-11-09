import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvFile } from "../src/env.js";
import { loadConfig, ConfigError, mergeEnv } from "../src/config.js";

test("parseEnvFile: quotes, comments, export, expansion", () => {
  const { vars, unresolved } = parseEnvFile(
    [
      "# comment",
      "export A=1",
      'B="two words"',
      "C='$NOT_EXPANDED'",
      "D=${TOKEN}",
      "E=$A-x # trailing comment",
      "F=${MISSING}",
      "bad line"
    ].join("\n"),
    { TOKEN: "secret" }
  );
  assert.deepEqual(vars, { A: "1", B: "two words", C: "$NOT_EXPANDED", D: "secret", E: "1-x", F: "" });
  assert.deepEqual(unresolved, { F: ["MISSING"] });
});

test("loadConfig: defaults are loopback, admin local-only", () => {
  const c = loadConfig({});
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.port, 8080);
  assert.equal(c.adminEnabled, true);
  assert.equal(c.adminAllowFrom, "local");
  assert.match(c.dataFile, /data[\\/]gateway\.json$/);
  assert.equal(loadConfig({ DATA_DIR: "none" }).dataFile, "");
});

test("loadConfig: env values become the first-run seed", () => {
  const c = loadConfig({
    OPENAI_BASE_URL: "https://api.venice.ai/api/v1/",
    OPENAI_API_KEY: "k",
    DEFAULT_MODEL: "big",
    MODEL_HAIKU: "small",
    MAX_OUTPUT_TOKENS: "8000",
    GATEWAY_API_KEY: "g".repeat(20)
  });
  assert.equal(c.seed.baseUrl, "https://api.venice.ai/api/v1");
  assert.deepEqual(c.seed.familyModels, { haiku: "small" });
  assert.equal(c.seed.maxOutputTokens, 8000);
  assert.equal(c.seed.gatewayApiKey, "g".repeat(20));
});

test("loadConfig: warns (not fails) about an unresolved key reference", () => {
  const c = loadConfig({ OPENAI_API_KEY: "" }, { unresolved: { OPENAI_API_KEY: ["VENICE_API_TOKEN"] } });
  assert.match(c.warnings.join(), /VENICE_API_TOKEN/);
});

test("loadConfig: reports all bad values at once", () => {
  try {
    loadConfig({ PORT: "abc", OPENAI_BASE_URL: "ftp://x", MODEL_MAP: "{", REASONING_MODELS: "(", ADMIN_ALLOW_FROM: "everyone", ADMIN_PASSWORD: "short" });
    assert.fail("should throw");
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    assert.equal(err.problems.length, 6);
  }
});

test("mergeEnv: shell wins, except OPENAI_* from .env", () => {
  const merged = mergeEnv(
    { PORT: "9000", OPENAI_API_KEY: "sk-openai-from-shell", HOME: "/h" },
    { PORT: "8080", OPENAI_API_KEY: "venice-token", OPENAI_BASE_URL: "https://api.venice.ai/api/v1", DEFAULT_MODEL: "m" }
  );
  assert.equal(merged.PORT, "9000");
  assert.equal(merged.OPENAI_API_KEY, "venice-token");
  assert.equal(merged.OPENAI_BASE_URL, "https://api.venice.ai/api/v1");
  assert.equal(merged.DEFAULT_MODEL, "m");
  assert.equal(mergeEnv({ OPENAI_API_KEY: "shell" }, {}).OPENAI_API_KEY, "shell");
});
