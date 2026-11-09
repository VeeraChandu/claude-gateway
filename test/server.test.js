import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { startStack, sse, textChunk, parseAnthropicSse, assertValidAnthropicStream } from "./helpers.js";

const GW_KEY = "gw-key-0123456789abcdef";

const post = (base, path, body, headers = {}) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": GW_KEY, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });

const streamOk = (req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(sse([textChunk("Hi"), { choices: [{ delta: {}, finish_reason: "stop" }] }, { choices: [], usage: { prompt_tokens: 9, completion_tokens: 1 } }]));
};

test("health is minimal and unauthenticated; no CORS headers anywhere", async (t) => {
  const s = await startStack(streamOk, { GATEWAY_API_KEY: GW_KEY });
  t.after(() => s.close());
  const res = await fetch(s.base + "/health");
  assert.deepEqual(await res.json(), { status: "ok" });
  assert.equal(res.headers.get("access-control-allow-origin"), null);

  const pre = await fetch(s.base + "/v1/messages", { method: "OPTIONS", headers: { origin: "https://evil.example" } });
  assert.equal(pre.headers.get("access-control-allow-origin"), null);
  assert.equal(pre.status, 405);
});

test("gateway key is required when configured", async (t) => {
  const s = await startStack(streamOk, { GATEWAY_API_KEY: GW_KEY });
  t.after(() => s.close());
  const body = { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }], stream: true };

  assert.equal((await post(s.base, "/v1/messages", body, { "x-api-key": "" })).status, 401);
  assert.equal((await post(s.base, "/v1/messages", body, { "x-api-key": "wrong" })).status, 401);
  assert.equal((await fetch(s.base + "/v1/models")).status, 401);
  assert.equal(s.requests.length, 0, "unauthenticated requests must not reach upstream");

  const ok = await post(s.base, "/v1/messages", body, { "x-api-key": "", authorization: `Bearer ${GW_KEY}` });
  assert.equal(ok.status, 200);
  await ok.text();
  assert.equal(s.requests[0].headers.authorization, "Bearer upstream-key", "upstream gets the configured key, not the gateway key");
});

test("passthrough mode forwards the client's key", async (t) => {
  const s = await startStack(streamOk, { PASSTHROUGH_CLIENT_KEY: "true", OPENAI_API_KEY: "" });
  t.after(() => s.close());
  const res = await post(s.base, "/v1/messages", { messages: [], stream: true }, { "x-api-key": "sk-client" });
  await res.text();
  assert.equal(s.requests[0].headers.authorization, "Bearer sk-client");
});

test("streaming end to end: model mapping and valid Anthropic events", async (t) => {
  const s = await startStack(streamOk, { MODEL_HAIKU: "small-model", DEFAULT_MODEL: "big-model" });
  t.after(() => s.close());
  const res = await post(s.base, "/v1/messages?beta=true", {
    model: "claude-haiku-4-5-20251001",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 10,
    stream: true
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  assert.ok(res.headers.get("request-id"));
  const events = parseAnthropicSse(await res.text()).map((e) => [e.event, e.data]);
  assertValidAnthropicStream(events, assert);
  assert.equal(events[0][1].message.model, "claude-haiku-4-5-20251001");
  assert.equal(events.at(-2)[1].usage.input_tokens, 9);
  assert.equal(s.requests[0].body.model, "small-model");
  assert.equal(s.requests[0].url, "/v1/chat/completions");
});

test("non-streaming end to end", async (t) => {
  const s = await startStack((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "Hello" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
  });
  t.after(() => s.close());
  const res = await post(s.base, "/v1/messages", { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] });
  const msg = await res.json();
  assert.equal(msg.type, "message");
  assert.deepEqual(msg.content, [{ type: "text", text: "Hello" }]);
  assert.equal(s.requests[0].body.stream, false);
});

test("multi-byte UTF-8 split across request chunks arrives intact", async (t) => {
  const s = await startStack(streamOk);
  t.after(() => s.close());
  const text = "héllo wörld — 日本語 🚀".repeat(2000);
  const bytes = Buffer.from(JSON.stringify({ messages: [{ role: "user", content: text }], stream: true }));
  const port = new URL(s.base).port;
  await new Promise((resolve, reject) => {
    const req = http.request({ port, method: "POST", path: "/v1/messages", headers: { "content-type": "application/json", "content-length": bytes.length } }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", reject);
    // Write in 7-byte pieces so multi-byte characters straddle chunk boundaries.
    (async () => {
      for (let i = 0; i < bytes.length; i += 7) {
        req.write(bytes.subarray(i, i + 7));
        if (i % 7000 === 0) await delay(0);
      }
      req.end();
    })();
  });
  assert.equal(s.requests[0].body.messages[0].content, text);
});

test("oversized body → 413 without calling upstream", async (t) => {
  const s = await startStack(streamOk, { MAX_BODY_MB: "1" });
  t.after(() => s.close());
  const res = await post(s.base, "/v1/messages", { messages: [{ role: "user", content: "x".repeat(1.5 * 1024 * 1024) }] });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error.type, "request_too_large");
  assert.equal(s.requests.length, 0);
});

test("malformed JSON → 400 invalid_request_error", async (t) => {
  const s = await startStack(streamOk);
  t.after(() => s.close());
  const res = await post(s.base, "/v1/messages", "{nope");
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.type, "invalid_request_error");
});

test("upstream 429 is retried, then succeeds", async (t) => {
  const s = await startStack(
    (req, res, body, n) => {
      if (n === 1) {
        res.writeHead(429, { "retry-after": "0", "content-type": "application/json" });
        return res.end('{"error":{"message":"rate limited"}}');
      }
      streamOk(req, res);
    },
    { UPSTREAM_MAX_RETRIES: "2" }
  );
  t.after(() => s.close());
  const res = await post(s.base, "/v1/messages", { messages: [], stream: true });
  assert.equal(res.status, 200);
  await res.text();
  assert.equal(s.requests.length, 2);
});

test("upstream errors map to Anthropic types; context overflow → prompt is too long", async (t) => {
  let reply;
  const s = await startStack((req, res) => {
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(reply.body);
  });
  t.after(() => s.close());

  reply = { status: 400, body: '{"error":{"message":"This model\'s maximum context length is 128000 tokens","code":"context_length_exceeded"}}' };
  let res = await post(s.base, "/v1/messages", { messages: [], stream: true });
  let json = await res.json();
  assert.equal(res.status, 400);
  assert.match(json.error.message, /^prompt is too long/);

  reply = { status: 429, body: '{"error":{"message":"quota"}}' };
  res = await post(s.base, "/v1/messages", { messages: [], stream: true });
  json = await res.json();
  assert.equal(res.status, 429);
  assert.equal(json.error.type, "rate_limit_error");
});

test("unreachable upstream → 502 api_error", async (t) => {
  const s = await startStack(streamOk, { OPENAI_BASE_URL: "http://127.0.0.1:1/v1" });
  t.after(() => s.close());
  const res = await post(s.base, "/v1/messages", { messages: [], stream: true });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.type, "api_error");
});

test("error inside the upstream stream becomes an Anthropic error event", async (t) => {
  const s = await startStack((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse([textChunk("par"), { error: { message: "provider overloaded", code: 503 } }], { done: false }));
  });
  t.after(() => s.close());
  const events = parseAnthropicSse(await (await post(s.base, "/v1/messages", { messages: [], stream: true })).text());
  const last = events.at(-1);
  assert.equal(last.event, "error");
  assert.equal(last.data.error.type, "overloaded_error");
});

test("upstream dying mid-stream yields an error event, not a silent truncation", async (t) => {
  const s = await startStack((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse([textChunk("partial")], { done: false }));
    setTimeout(() => res.destroy(), 20);
  });
  t.after(() => s.close());
  const events = parseAnthropicSse(await (await post(s.base, "/v1/messages", { messages: [], stream: true })).text());
  assert.equal(events.at(-1).event, "error");
});

test("client disconnect aborts the upstream request", async (t) => {
  const s = await startStack((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const timer = setInterval(() => res.write(sse([textChunk("tick")], { done: false })), 10);
    res.on("close", () => clearInterval(timer));
  });
  t.after(() => s.close());

  const res = await post(s.base, "/v1/messages", { messages: [], stream: true }, {});
  const reader = res.body.getReader();
  await reader.read();
  await reader.cancel();

  for (let i = 0; i < 50 && !s.requests[0].closed; i++) await delay(20);
  assert.equal(s.requests[0].closed, true, "upstream connection should be closed early");
});

test("count_tokens estimates without counting base64 as text", async (t) => {
  const s = await startStack(streamOk);
  t.after(() => s.close());
  const res = await post(s.base, "/v1/messages/count_tokens", {
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", data: "A".repeat(500_000) } }] }]
  });
  const { input_tokens } = await res.json();
  assert.ok(input_tokens < 2000, String(input_tokens));
});

test("unknown path → 404, wrong method → 405", async (t) => {
  const s = await startStack(streamOk);
  t.after(() => s.close());
  assert.equal((await fetch(s.base + "/nope")).status, 404);
  assert.equal((await fetch(s.base + "/v1/messages")).status, 405);
});
