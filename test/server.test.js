import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { startStack, fakeUpstream, sse, textChunk, parseAnthropicSse, assertValidAnthropicStream } from "./helpers.js";

const post = (base, path, body, headers = {}) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });

const streamOk = (req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(sse([textChunk("Hi"), { choices: [{ delta: {}, finish_reason: "stop" }] }, { choices: [], usage: { prompt_tokens: 9, completion_tokens: 1 } }]));
};

const hi = { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }], stream: true };

test("health is minimal and unauthenticated; / goes to the admin UI; no CORS", async (t) => {
  const s = await startStack(streamOk, {}, { clientKey: true });
  t.after(() => s.close());
  const res = await fetch(s.base + "/health");
  assert.deepEqual(await res.json(), { status: "ok" });
  assert.equal(res.headers.get("access-control-allow-origin"), null);

  const root = await fetch(s.base + "/", { redirect: "manual" });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/admin/");

  const pre = await fetch(s.base + "/v1/messages", { method: "OPTIONS", headers: { origin: "https://evil.example" } });
  assert.equal(pre.headers.get("access-control-allow-origin"), null);
  assert.equal(pre.status, 405);
});

test("once a client key exists, every request needs a valid one", async (t) => {
  const s = await startStack(streamOk, {}, { clientKey: true });
  t.after(() => s.close());

  assert.equal((await post(s.base, "/v1/messages", hi)).status, 401);
  assert.equal((await post(s.base, "/v1/messages", hi, { "x-api-key": "cgw_wrong" })).status, 401);
  assert.equal((await fetch(s.base + "/v1/models")).status, 401);
  assert.equal(s.requests.length, 0, "unauthenticated requests must not reach upstream");

  const ok = await post(s.base, "/v1/messages", hi, { authorization: `Bearer ${s.key}` });
  assert.equal(ok.status, 200);
  await ok.text();
  assert.equal(s.requests[0].headers.authorization, "Bearer upstream-key", "upstream gets the connection's key, not the client key");

  const key = s.store.state.clientKeys[0];
  assert.deepEqual(key.usage, { requests: 1, inputTokens: 9, outputTokens: 1 });

  await s.store.revokeClientKey(key.id);
  const revoked = await post(s.base, "/v1/messages", hi, { "x-api-key": s.key });
  assert.equal(revoked.status, 401);
  assert.match((await revoked.json()).error.message, /revoked/);
  // Even with no key sent and every key gone, a loopback client is not let back in.
  await s.store.deleteClientKey(key.id);
  const none = await post(s.base, "/v1/messages", hi);
  assert.equal(none.status, 401);
  assert.match((await none.json()).error.message, /No active client keys/);
});

test("without client keys: open only for direct loopback on a loopback-bound gateway", async (t) => {
  const local = await startStack(streamOk);
  t.after(() => local.close());
  const ok = await post(local.base, "/v1/messages", hi);
  assert.equal(ok.status, 200);
  await ok.text();
  // Proxied (e.g. tailscale serve) requests are not "local", even from 127.0.0.1.
  assert.equal((await post(local.base, "/v1/messages", hi, { "x-forwarded-for": "100.100.1.1" })).status, 401);

  const exposed = await startStack(streamOk, { HOST: "0.0.0.0" });
  t.after(() => exposed.close());
  const res = await post(exposed.base, "/v1/messages", hi);
  assert.equal(res.status, 401);
  assert.match((await res.json()).error.message, /admin UI/);

  const allowed = await startStack(streamOk, { HOST: "0.0.0.0", ALLOW_UNAUTHENTICATED: "true" });
  t.after(() => allowed.close());
  const r2 = await post(allowed.base, "/v1/messages", hi);
  assert.equal(r2.status, 200);
  await r2.text();
});

test("routes across connections, and route changes apply without restart", async (t) => {
  const s = await startStack(streamOk);
  t.after(() => s.close());
  const second = await fakeUpstream(streamOk);
  t.after(() => second.close());
  const local = await s.store.addProvider({ name: "Local", baseUrl: second.url, apiKey: "local-key" });
  await s.store.setRoutes({ default: { provider: s.provider.id, model: "big-model" }, haiku: { provider: local.id, model: "small-model" } });

  await (await post(s.base, "/v1/messages", { ...hi, model: "claude-haiku-4-5-20251001" })).text();
  await (await post(s.base, "/v1/messages", { ...hi, model: "claude-opus-5-5" })).text();
  assert.equal(second.requests.length, 1);
  assert.equal(second.requests[0].body.model, "small-model");
  assert.equal(second.requests[0].headers.authorization, "Bearer local-key");
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].body.model, "big-model");

  await s.store.setRoutes({ default: { provider: local.id, model: "everything" } });
  await (await post(s.base, "/v1/messages", { ...hi, model: "claude-opus-5-5" })).text();
  assert.equal(second.requests.at(-1).body.model, "everything");
});

test("per-connection max output tokens apply", async (t) => {
  const s = await startStack(streamOk, {}, { store: { provider: { maxOutputTokens: 4096 } } });
  t.after(() => s.close());
  await (await post(s.base, "/v1/messages", { ...hi, max_tokens: 64000 })).text();
  assert.equal(s.requests[0].body.max_tokens, 4096);
});

test("no route configured → 503 pointing at the admin UI", async (t) => {
  const s = await startStack(streamOk);
  t.after(() => s.close());
  await s.store.setRoutes({ default: { provider: s.provider.id, model: "m" } });
  s.store.state.routes.default = null; // simulate an unconfigured gateway
  const res = await post(s.base, "/v1/messages", hi);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error.message, /admin/);
});

test("streaming end to end: valid Anthropic events", async (t) => {
  const s = await startStack(streamOk);
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
  assert.equal(s.requests[0].body.model, "upstream-model");
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

test("a rate-limited target falls back at once, and stays skipped while it cools down", async (t) => {
  const s = await startStack(
    (req, res) => {
      res.writeHead(429, { "retry-after": "120", "content-type": "application/json" });
      res.end('{"error":{"message":"free tier cap reached"}}');
    },
    { UPSTREAM_MAX_RETRIES: "3" }
  );
  t.after(() => s.close());
  const backup = await fakeUpstream(streamOk);
  t.after(() => backup.close());
  const b = await s.store.addProvider({ name: "Backup", baseUrl: backup.url, apiKey: "backup-key" });
  await s.store.setRoutes({ default: { provider: s.provider.id, model: "free-model", fallbacks: [{ provider: b.id, model: "paid-model" }] } });

  const first = await post(s.base, "/v1/messages", hi);
  assert.equal(first.status, 200);
  await first.text();
  assert.equal(s.requests.length, 1, "no backoff retries on the capped target when a fallback exists");
  assert.equal(backup.requests[0].body.model, "paid-model");

  await (await post(s.base, "/v1/messages", hi)).text();
  assert.equal(s.requests.length, 1, "cooling down: the capped target isn't tried again");
  assert.equal(backup.requests.length, 2);
});

test("fallbacks: 5xx falls over, 400 does not, and the last target's error is returned", async (t) => {
  let reply = { status: 503, body: '{"error":{"message":"overloaded"}}' };
  const s = await startStack((req, res) => {
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(reply.body);
  });
  t.after(() => s.close());
  let backupStatus = 200;
  const backup = await fakeUpstream((req, res) => {
    if (backupStatus === 200) return streamOk(req, res);
    res.writeHead(backupStatus, { "content-type": "application/json" });
    res.end('{"error":{"message":"backup down too"}}');
  });
  t.after(() => backup.close());
  const b = await s.store.addProvider({ name: "Backup", baseUrl: backup.url, apiKey: "k" });
  await s.store.setRoutes({ default: { provider: s.provider.id, model: "m", fallbacks: [{ provider: b.id, model: "m2" }] } });

  assert.equal((await post(s.base, "/v1/messages", hi)).status, 200, "503 → fallback answers");

  reply = { status: 400, body: '{"error":{"message":"bad request"}}' };
  const bad = await post(s.base, "/v1/messages", hi);
  assert.equal(bad.status, 400, "a client error is not retried elsewhere");
  assert.equal(backup.requests.length, 1);

  reply = { status: 503, body: '{"error":{"message":"overloaded"}}' };
  backupStatus = 502;
  const both = await post(s.base, "/v1/messages", hi);
  assert.equal(both.status, 502, "all targets failed → the last one's error");
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
  const s = await startStack(streamOk, {}, { store: { baseUrl: "http://127.0.0.1:1/v1" } });
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

test("/v1/models lists your models for Claude Code's picker; /api/hello probe answers", async (t) => {
  const s = await startStack(streamOk, {}, { clientKey: true });
  t.after(() => s.close());
  const auth = { "x-api-key": s.key };

  let list = await (await fetch(`${s.base}/v1/models?limit=1000`, { headers: auth })).json();
  assert.deepEqual(list.data, []);

  await s.store.setRoutes({
    default: { provider: s.provider.id, model: "upstream-model" },
    models: [
      { id: "claude-gw-qwen", displayName: "Qwen Coder", provider: s.provider.id, model: "qwen2.5-coder:32b" },
      { id: "claude-gw-r1", provider: s.provider.id, model: "deepseek-r1" }
    ]
  });
  list = await (await fetch(`${s.base}/v1/models?limit=1000`, { headers: auth })).json();
  assert.deepEqual(
    list.data.map((m) => [m.id, m.display_name, m.description]),
    [
      ["claude-gw-qwen", "Qwen Coder", "Fake · qwen2.5-coder:32b"],
      ["claude-gw-r1", "claude-gw-r1", "Fake · deepseek-r1"]
    ]
  );
  assert.ok(list.data.every((m) => /claude|anthropic/i.test(m.id)), "Claude Code drops ids without claude/anthropic");

  await (await post(s.base, "/v1/messages", { ...hi, model: "claude-gw-qwen" }, auth)).text();
  assert.equal(s.requests.at(-1).body.model, "qwen2.5-coder:32b");

  assert.equal((await fetch(`${s.base}/api/hello`, { method: "HEAD" })).status, 200);
});
