import { test } from "node:test";
import assert from "node:assert/strict";
import { startStack, sse, textChunk } from "./helpers.js";

const post = (base, body, headers = {}) =>
  fetch(base + "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });

const hi = { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }], stream: true };

const streamOk = (req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(sse([textChunk("Hi"), { choices: [{ delta: {}, finish_reason: "stop" }] }]));
};

test("a connection with a custom auth header sends the key there, not in Authorization", async (t) => {
  const s = await startStack(streamOk, {}, { store: { provider: { authScheme: "header", authHeader: "api-key" } } });
  t.after(() => s.close());

  const res = await post(s.base, hi);
  assert.equal(res.status, 200);
  await res.text();

  const sent = s.requests[0].headers;
  assert.equal(sent["api-key"], "upstream-key", "the key must arrive in the named header");
  assert.equal(sent.authorization, undefined, "Authorization must not be sent for a custom-header connection");
});

test("a connection can disable the credential entirely", async (t) => {
  const s = await startStack(streamOk, {}, { store: { provider: { authScheme: "none" } } });
  t.after(() => s.close());
  assert.equal((await post(s.base, hi)).status, 200);
  const sent = s.requests[0].headers;
  assert.equal(sent.authorization, undefined);
  assert.equal(sent["x-api-key"], undefined);
});

test("query parameters land on the request URL (Azure api-version)", async (t) => {
  const s = await startStack(streamOk, {}, { store: { provider: { queryParams: "api-version=2024-10-21" } } });
  t.after(() => s.close());
  assert.equal((await post(s.base, hi)).status, 200);
  assert.equal(s.requests[0].url, "/v1/chat/completions?api-version=2024-10-21");
});

test("a 400 naming temperature/top_p is retried without them and succeeds", async (t) => {
  const s = await startStack(
    (req, res, body, n) => {
      if (n === 1) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Unsupported parameter: 'temperature' is not supported with this model." } }));
        return;
      }
      streamOk(req, res);
    },
    {},
    { store: { provider: {} } }
  );
  t.after(() => s.close());

  // Claude Code always sends max_tokens; temperature shows up when a user sets it.
  const res = await post(s.base, { ...hi, max_tokens: 64, temperature: 0.7, top_p: 0.9 });
  assert.equal(res.status, 200, "the request must succeed after the strip-and-retry");
  await res.text();

  assert.equal(s.requests.length, 2, "the gateway should have retried exactly once");
  const first = s.requests[0].body;
  const second = s.requests[1].body;
  assert.equal(first.temperature, 0.7, "the first attempt carries the parameter");
  assert.equal(second.temperature, undefined, "the retry drops the parameter the provider named");
  assert.equal(second.top_p, 0.9, "parameters the provider did not name are kept");
  assert.equal(second.max_tokens, 64, "max_tokens is kept — it was not named");
  assert.deepEqual(second.messages, first.messages, "the conversation is resent unchanged");
});

test("a 400 about something unrelated is passed through, not retried", async (t) => {
  const s = await startStack(
    (req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid API key provided" } }));
    },
    {},
    { store: { provider: {} } }
  );
  t.after(() => s.close());

  const res = await post(s.base, { ...hi, max_tokens: 64 });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /Invalid API key/);
  assert.equal(s.requests.length, 1, "an unrecognized 400 must not be retried");
});

test("parameter retry can be turned off per connection", async (t) => {
  const s = await startStack(
    (req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Unsupported parameter: 'temperature'" } }));
    },
    {},
    { store: { provider: { parameterRetry: false } } }
  );
  t.after(() => s.close());
  assert.equal((await post(s.base, { ...hi, temperature: 1 })).status, 400);
  assert.equal(s.requests.length, 1, "retry must be skipped when the connection disables it");
});

test("an old store file (no new provider fields) still works", async (t) => {
  // A store written before authScheme/queryParams existed: the gateway must
  // treat it as a plain bearer connection rather than crashing or sending nothing.
  const s = await startStack(streamOk, {}, { store: { provider: { authScheme: undefined, queryParams: undefined } } });
  t.after(() => s.close());

  const p = s.store.getProvider(s.provider.id);
  assert.equal(p.authScheme, "bearer");
  assert.equal(p.queryParams, "");
  assert.equal(p.parameterRetry, true);

  assert.equal((await post(s.base, hi)).status, 200);
  assert.equal(s.requests[0].headers.authorization, "Bearer upstream-key");
});

test("the admin connection test uses the connection's auth scheme and query string", async (t) => {
  const { fakeUpstream } = await import("./helpers.js");
  const upstream = await fakeUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "deployment-a" }] }));
  });
  t.after(() => upstream.close());

  const { testConnection } = await import("../src/admin/index.js");
  const result = await testConnection(fetch, {
    baseUrl: upstream.url,
    apiKey: "azure-key",
    authScheme: "header",
    authHeader: "api-key",
    queryParams: "api-version=2024-10-21"
  });

  assert.equal(result.ok, true, `test failed: ${result.error}`);
  assert.deepEqual(result.models, ["deployment-a"]);
  const sent = upstream.requests[0];
  assert.equal(sent.headers["api-key"], "azure-key", "the test must use the connection's auth header");
  assert.equal(sent.headers.authorization, undefined);
  assert.equal(sent.url, "/v1/models?api-version=2024-10-21");
});
