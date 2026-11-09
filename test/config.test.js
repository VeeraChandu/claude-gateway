import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvFile } from "../src/env.js";
import { loadConfig, ConfigError, mergeEnv } from "../src/config.js";
import { resolveModel, isReasoningModel } from "../src/models.js";

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

test("loadConfig: defaults are loopback and valid", () => {
  const c = loadConfig({ OPENAI_API_KEY: "k" });
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.port, 8080);
  assert.equal(c.maxOutputTokens, null);
});

test("loadConfig: refuses to expose without auth", () => {
  assert.throws(() => loadConfig({ OPENAI_API_KEY: "k", HOST: "0.0.0.0" }), ConfigError);
  assert.doesNotThrow(() => loadConfig({ OPENAI_API_KEY: "k", HOST: "0.0.0.0", GATEWAY_API_KEY: "a".repeat(24) }));
  assert.doesNotThrow(() => loadConfig({ OPENAI_API_KEY: "k", HOST: "0.0.0.0", ALLOW_UNAUTHENTICATED: "true" }));
});

test("loadConfig: names the unresolved variable behind an empty key", () => {
  assert.throws(
    () => loadConfig({ OPENAI_API_KEY: "" }, { unresolved: { OPENAI_API_KEY: ["VENICE_API_TOKEN"] } }),
    /VENICE_API_TOKEN/
  );
});

test("loadConfig: reports all bad values at once", () => {
  try {
    loadConfig({ PORT: "abc", OPENAI_BASE_URL: "ftp://x", MODEL_MAP: "{", REASONING_MODELS: "(" });
    assert.fail("should throw");
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    assert.equal(err.problems.length, 5);
  }
});

test("resolveModel: routes current and legacy Claude names by family", () => {
  const c = loadConfig({ OPENAI_API_KEY: "k", DEFAULT_MODEL: "big", MODEL_HAIKU: "small", MODEL_OPUS: "huge" });
  assert.equal(resolveModel("claude-haiku-4-5-20251001", c), "small");
  assert.equal(resolveModel("claude-3-5-haiku-20241022", c), "small");
  assert.equal(resolveModel("claude-sonnet-4-5", c), "big");
  assert.equal(resolveModel("claude-opus-5-5", c), "huge");
  assert.equal(resolveModel("claude-fable-5-1", c), "big");
  assert.equal(resolveModel(undefined, c), "big");
});

test("resolveModel: non-Claude names pass through; MODEL_MAP wins with longest prefix", () => {
  const c = loadConfig({
    OPENAI_API_KEY: "k",
    MODEL_MAP: JSON.stringify({ "claude-sonnet": "a", "claude-sonnet-4-5": "b", "claude-fable": "c" })
  });
  assert.equal(resolveModel("gpt-4.1", c), "gpt-4.1");
  assert.equal(resolveModel("claude-sonnet-4-5-20250929", c), "b");
  assert.equal(resolveModel("claude-sonnet-4", c), "a");
  assert.equal(resolveModel("claude-fable-5-1", c), "c");
});

test("isReasoningModel: o-series, gpt-5, reasoners; overridable", () => {
  const c = loadConfig({ OPENAI_API_KEY: "k" });
  for (const m of ["o1", "o3-mini", "o4-mini", "gpt-5", "gpt-5-mini", "openai/gpt-5", "deepseek-reasoner"]) {
    assert.ok(isReasoningModel(m, c), m);
  }
  for (const m of ["gpt-4o", "gpt-4.1", "deepseek-chat", "qwen2.5-coder:32b", "llama3-70b"]) {
    assert.ok(!isReasoningModel(m, c), m);
  }
  const custom = loadConfig({ OPENAI_API_KEY: "k", REASONING_MODELS: "^deepseek-v4" });
  assert.ok(isReasoningModel("deepseek-v4-flash", custom));
  assert.ok(!isReasoningModel("o3-mini", custom));
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
