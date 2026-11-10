import { test } from "node:test";
import assert from "node:assert/strict";
import { completionsUrl, modelsUrl, upstreamHeaders } from "../src/provider-request.js";
import { unsupportedParams } from "../src/upstream.js";
import { withProviderDefaults, AUTH_SCHEMES } from "../src/store.js";

test("completionsUrl appends query parameters only when the connection has them", () => {
  assert.equal(completionsUrl({ baseUrl: "https://api.openai.com/v1", queryParams: "" }), "https://api.openai.com/v1/chat/completions");
  assert.equal(
    completionsUrl({ baseUrl: "https://r.openai.azure.com/openai/deployments/d", queryParams: "api-version=2024-10-21" }),
    "https://r.openai.azure.com/openai/deployments/d/chat/completions?api-version=2024-10-21"
  );
  // A leading ? or & from the form is tolerated.
  assert.equal(completionsUrl({ baseUrl: "https://x/v1", queryParams: "?a=1&b=2" }), "https://x/v1/chat/completions?a=1&b=2");
  assert.equal(modelsUrl({ baseUrl: "https://x/v1", queryParams: "" }), "https://x/v1/models");
  assert.equal(modelsUrl({ baseUrl: "https://x/v1", queryParams: "api-version=1" }), "https://x/v1/models?api-version=1");
});

test("upstreamHeaders sends the key in the shape the connection asks for", () => {
  const key = "sk-secret";
  assert.deepEqual(upstreamHeaders({ authScheme: "bearer" }, key), {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`
  });
  assert.equal(upstreamHeaders({ authScheme: "x-api-key" }, key)["x-api-key"], key);
  assert.equal(upstreamHeaders({ authScheme: "x-api-key" }, key).Authorization, undefined);
  // Azure OpenAI
  const azure = upstreamHeaders({ authScheme: "header", authHeader: "api-key" }, key);
  assert.equal(azure["api-key"], key);
  assert.equal(azure.Authorization, undefined);
  // A local server that wants no credential.
  assert.deepEqual(upstreamHeaders({ authScheme: "none" }, key), { "Content-Type": "application/json" });
  // Default when the field is absent (older store files).
  assert.equal(upstreamHeaders({}, key).Authorization, `Bearer ${key}`);
});

test("upstreamHeaders never sends an empty credential", () => {
  for (const authScheme of AUTH_SCHEMES) {
    const h = upstreamHeaders({ authScheme, authHeader: "api-key" }, "");
    assert.deepEqual(h, { "Content-Type": "application/json" }, `${authScheme} sent a header for an empty key`);
  }
});

test("unsupportedParams recognizes the fields a provider rejects", () => {
  assert.deepEqual(unsupportedParams(undefined, `{"error":{"message":"Unsupported parameter: 'temperature' is not supported with this model."}}`), ["temperature"]);
  assert.deepEqual(unsupportedParams(undefined, `{"error":{"message":"bad request","param":"top_p"}}`), ["top_p"]);
  assert.deepEqual(unsupportedParams(undefined, `{"error":{"code":"unsupported_value","message":"max_tokens is not supported"}}`), ["max_tokens"]);
  assert.deepEqual(
    unsupportedParams(undefined, `{"error":{"message":"temperature and max_completion_tokens are not supported"}}`),
    ["max_completion_tokens", "temperature"]
  );
  // A 400 about something else must not be retried blindly.
  assert.deepEqual(unsupportedParams(undefined, `{"error":{"message":"Invalid API key"}}`), []);
  assert.deepEqual(unsupportedParams(undefined, "upstream is down"), []);
});

test("withProviderDefaults fills in the newer fields for an old store record", () => {
  const old = withProviderDefaults({ id: "prv_1", name: "Old", baseUrl: "https://x/v1", apiKey: "k", maxOutputTokens: null, reasoningPattern: "" });
  assert.equal(old.authScheme, "bearer");
  assert.equal(old.authHeader, "");
  assert.equal(old.queryParams, "");
  assert.equal(old.parameterRetry, true);
  // Explicit values survive.
  const kept = withProviderDefaults({ authScheme: "header", authHeader: "api-key", queryParams: "v=1", parameterRetry: false });
  assert.equal(kept.authScheme, "header");
  assert.equal(kept.authHeader, "api-key");
  assert.equal(kept.queryParams, "v=1");
  assert.equal(kept.parameterRetry, false);
});
