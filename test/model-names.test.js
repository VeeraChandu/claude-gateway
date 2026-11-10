import { test } from "node:test";
import assert from "node:assert/strict";
import { checkModelId, desktopAccepts, gatewayAccepts, suggestModelId, vendorToken, VENDOR_NAME_PATTERN } from "../src/model-names.js";

test("vendorToken finds the token Desktop rejects, or returns empty", () => {
  assert.equal(vendorToken("claude-deepseek-v4-1-flash"), "deepseek");
  assert.equal(vendorToken("claude-o-6-luna"), "");
  assert.equal(vendorToken("claude-nemotron-3-ultra"), "nemotron");
  assert.equal(vendorToken("claude-ds-v4-1-flash"), "ds-", "the anchored ds- token still matches a segment");
  assert.equal(vendorToken("claude-d-v4-1-flash"), "");
});

test("desktopAccepts mirrors Desktop's deny-first filter", () => {
  for (const id of ["claude-sonnet-5", "claude-opus-5-5", "claude-venice-flash", "claude-d-v4-1-flash", "claude-o-6-luna", "sonnet"]) {
    assert.equal(desktopAccepts(id), true, id);
  }
  // Denylisted, even though each contains "claude": the vendor check runs first.
  for (const id of ["claude-deepseek-v4-1-flash", "claude-nemotron-3-ultra", "claude-gpt-4-1", "claude-mo-k2.5", "claude-m-m2.1", "claude-a-nova-pro", "claude-s-step-3", "claude-p-phi-4", "claude-d-ling", "claude-ds-v4-1-flash"]) {
    assert.equal(desktopAccepts(id), false, id);
  }
  // No reason to be shown at all.
  assert.equal(desktopAccepts("gpt-4.1"), false);
  assert.equal(desktopAccepts("flash"), false);
});

test("gatewayAccepts mirrors the store's own ID rule", () => {
  assert.equal(gatewayAccepts("claude-qwen-coder"), true);
  assert.equal(gatewayAccepts("anthropic/claude-flash"), true);
  assert.equal(gatewayAccepts("flash"), false, "must contain claude or anthropic");
  assert.equal(gatewayAccepts("claude bad space"), false);
  assert.equal(gatewayAccepts(`claude-${"a".repeat(120)}`), false);
});

test("checkModelId reports the gateway's rules before Desktop's", () => {
  assert.equal(checkModelId("claude-d-v4-1-flash"), "ok");
  assert.equal(checkModelId("flash"), "no-claude");
  assert.equal(checkModelId("claude bad"), "charset");
  assert.equal(checkModelId("claude-deepseek-v4-1-flash"), "vendor-name");
  assert.equal(checkModelId(`claude-${"a".repeat(120)}`), "too-long");
});

test("suggestModelId uses the vendor's initial and keeps the model readable", () => {
  assert.equal(suggestModelId("deepseek-v4-1-flash"), "claude-d-v4-1-flash");
  assert.equal(suggestModelId("openai-gpt-6-luna"), "claude-o-6-luna");
  assert.equal(suggestModelId("nvidia/nemotron-3-ultra-550b-a55b:free"), "claude-n-3-ultra-550b-a55b");
  assert.equal(suggestModelId("mistralai/mistral-large"), "claude-m-large");
  assert.equal(suggestModelId("meta-llama/llama-4-scout"), "claude-l-4-scout");
  assert.equal(suggestModelId("google/gemini-3-pro"), "claude-g-3-pro");
  assert.equal(suggestModelId("qwen/qwen3-max"), "claude-q-3-max");
  assert.equal(suggestModelId("deepseek/deepseek-v4-1-flash:free"), "claude-d-v4-1-flash");
  assert.equal(suggestModelId("gpt-4.1"), "claude-o-4-1");
});

test("suggestModelId repairs name tokens Desktop rejects rather than dropping them", () => {
  assert.equal(suggestModelId("moonshotai/kimi-k2.5"), "claude-k-k2-5", "k2. is a denied token, k2-5 is not");
  assert.equal(suggestModelId("minimax/minimax-m2.1"), "claude-mm-m2-1", "m2. is a denied token, m2-1 is not");
  assert.equal(suggestModelId("stepfun/step-3"), "claude-s-3");
  assert.equal(suggestModelId("microsoft/phi-4"), "claude-p-4");
  assert.equal(suggestModelId("amazon/nova-pro"), "claude-an-pro");
});

test("suggestModelId leaves an already-good claude ID alone", () => {
  assert.equal(suggestModelId("claude-sonnet-4-5"), "claude-sonnet-4-5");
  assert.equal(suggestModelId("claude-d-v4-1-flash"), "claude-d-v4-1-flash", "idempotent");
});

test("suggestModelId returns empty when there is nothing to suggest", () => {
  for (const input of ["", "   ", "gpt", "deepseek"]) assert.equal(suggestModelId(input), "", JSON.stringify(input));
});

test("every suggestion survives both gates", () => {
  // The property that matters: a suggestion is never itself dropped.
  const vendors = ["deepseek", "openai", "gemini", "nova", "solar", "mercury", "ling", "kimi", "qwen", "mistral", "llama", "glm", "grok", "nemotron", "minimax", "moonshot", "phi", "step", "granite", "jamba", "codex", "ernie"];
  const models = ["k2.5", "m2.1", "v4-1-flash", "gpt-6-luna", "3-pro", "pro", "large", "3-ultra", "phi-4", "step-3", "nova-pro", "4.1", "2-5", "m2.1-flash", "unic", "ds-flash"];
  for (const vendor of vendors) {
    for (const model of models) {
      const id = suggestModelId(`${vendor}-${model}`);
      if (!id) continue;
      assert.equal(vendorToken(id), "", `${vendor}-${model} -> ${id}`);
      assert.equal(desktopAccepts(id), true, `${vendor}-${model} -> ${id}`);
      assert.equal(checkModelId(id), "ok", `${vendor}-${model} -> ${id}`);
    }
  }
});

test("the token list matches the app's deny pattern shape", () => {
  // 56 tokens, from the two identical copies in app.asar. Eleven are anchored.
  const tokens = VENDOR_NAME_PATTERN.source.split("|");
  assert.equal(tokens.length, 56);
  assert.equal(tokens.filter((t) => /\\b|-$|\.|\\d/.test(t)).length, 11);
});
