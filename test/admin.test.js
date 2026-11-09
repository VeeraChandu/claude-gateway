import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { startStack, sse, textChunk } from "./helpers.js";

const SETUP_CODE = "ABCD-EFGH";
const PASSWORD = "a very good password";

/** Fake upstream: lists models on GET /models, streams on chat completions. */
const upstream = (req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    if (req.headers.authorization !== "Bearer upstream-key" && req.headers.authorization !== "Bearer typed-key") {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end('{"error":{"message":"bad key"}}');
    }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ data: [{ id: "model-b" }, { id: "model-a" }] }));
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(sse([textChunk("ok"), { choices: [{ delta: {}, finish_reason: "stop" }] }, { choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } }]));
};

/** Minimal cookie-keeping admin client that sends the same-origin headers the UI sends. */
function client(base, { origin = base, adminHeader = true } = {}) {
  let cookie = "";
  return {
    get cookie() {
      return cookie;
    },
    async call(method, path, body, extra = {}) {
      const headers = { "content-type": "application/json", ...extra };
      if (origin) headers.origin = origin;
      if (adminHeader) headers["x-cgw-admin"] = "1";
      if (cookie) headers.cookie = cookie;
      const res = await fetch(`${base}/admin/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      const data = await res.json().catch(() => null);
      return { status: res.status, data, headers: res.headers, setCookie: set };
    }
  };
}

async function signedIn(env = {}, opts = {}) {
  const s = await startStack(upstream, env, { setupCode: SETUP_CODE, ...opts });
  const c = client(s.base);
  const r = await c.call("POST", "/setup", { code: SETUP_CODE, password: PASSWORD });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { s, c };
}

/** Raw request with a custom Host header (fetch won't override Host). */
function rawGet(base, path, host) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    http
      .get({ port, path, headers: { host } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
      .on("error", reject);
  });
}

test("first-run setup needs the code from the log, then locks", async (t) => {
  const s = await startStack(upstream, {}, { setupCode: SETUP_CODE });
  t.after(() => s.close());
  const c = client(s.base);

  assert.deepEqual((await c.call("GET", "/session")).data, { authenticated: false, setupRequired: true });
  assert.equal((await c.call("POST", "/setup", { code: "WRONG-CODE", password: PASSWORD })).status, 401);
  assert.equal((await c.call("POST", "/setup", { code: SETUP_CODE, password: "short" })).status, 400);

  const ok = await c.call("POST", "/setup", { code: SETUP_CODE.toLowerCase(), password: PASSWORD });
  assert.equal(ok.status, 200);
  assert.match(ok.setCookie, /HttpOnly/);
  assert.match(ok.setCookie, /SameSite=Strict/);
  assert.match(ok.setCookie, /Path=\/admin/);
  assert.deepEqual((await c.call("GET", "/session")).data, { authenticated: true, setupRequired: false });

  assert.equal((await client(s.base).call("POST", "/setup", { code: SETUP_CODE, password: "another password!" })).status, 409);
});

test("login: wrong password rejected, then rate limited; right password works", async (t) => {
  const { s } = await signedIn();
  t.after(() => s.close());
  const c = client(s.base);
  assert.equal((await c.call("GET", "/state")).status, 401);
  for (let i = 0; i < 5; i++) assert.equal((await c.call("POST", "/login", { password: "nope" })).status, 401);
  assert.equal((await c.call("POST", "/login", { password: PASSWORD })).status, 429, "locked out after 5 failures");
});

test("login and logout", async (t) => {
  const { s } = await signedIn();
  t.after(() => s.close());
  const c = client(s.base);
  assert.equal((await c.call("POST", "/login", { password: PASSWORD })).status, 200);
  assert.equal((await c.call("GET", "/state")).status, 200);
  await c.call("POST", "/logout");
  assert.equal((await c.call("GET", "/state")).status, 401);
});

test("cross-site requests are blocked", async (t) => {
  const { s, c } = await signedIn();
  t.after(() => s.close());
  const session = { cookie: c.cookie };

  const evil = client(s.base, { origin: "https://evil.example" });
  const noOrigin = client(s.base, { origin: null });
  const noHeader = client(s.base, { adminHeader: false });
  for (const x of [evil, noOrigin, noHeader]) {
    const r = await x.call("POST", "/keys", { name: "pwned" }, session);
    assert.equal(r.status, 403);
  }
  assert.equal(s.store.state.clientKeys.length, 0);
});

test("Host header allowlist blocks DNS rebinding; admin can be disabled", async (t) => {
  const s = await startStack(upstream, {}, { setupCode: SETUP_CODE });
  t.after(() => s.close());
  assert.equal(await rawGet(s.base, "/admin/", "evil.example.com"), 403);
  assert.equal(await rawGet(s.base, "/admin/", "myserver.tail1234.ts.net"), 200);
  assert.equal(await rawGet(s.base, "/admin/", "myserver:8080"), 200);

  const off = await startStack(upstream, { ADMIN_ENABLED: "false" });
  t.after(() => off.close());
  assert.equal((await fetch(`${off.base}/admin/`)).status, 404);
});

test("UI is served with a strict CSP and builds DOM without innerHTML", async (t) => {
  const s = await startStack(upstream);
  t.after(() => s.close());
  const res = await fetch(`${s.base}/admin/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy"), /script-src 'self'/);
  assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(await res.text(), /app\.js/);
  for (const f of ["app.js", "app.css", "favicon.svg"]) assert.equal((await fetch(`${s.base}/admin/${f}`)).status, 200, f);
  assert.equal((await fetch(`${s.base}/admin/../server.js`)).status, 404);

  const js = fs.readFileSync(new URL("../src/admin/public/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|eval\(/);
});

test("connections: secrets never leave the server; test and model listing", async (t) => {
  const { s, c } = await signedIn();
  t.after(() => s.close());

  let state = (await c.call("GET", "/state")).data;
  assert.equal(state.providers[0].apiKeyMasked, "ups…-key");
  assert.ok(!JSON.stringify(state).includes("upstream-key"), "full provider key must not be sent to the browser");

  const added = await c.call("POST", "/providers", { name: "Second", baseUrl: `${s.upstream.url}/`, apiKey: "typed-key", maxOutputTokens: "8192" });
  assert.equal(added.status, 201);
  assert.equal(added.data.apiKey, undefined);
  assert.equal(added.data.maxOutputTokens, 8192);
  assert.equal((await c.call("POST", "/providers", { name: "second", baseUrl: s.upstream.url, apiKey: "x" })).status, 409);

  // Test with typed values, with the stored key, and with a bad key.
  const typed = await c.call("POST", "/providers/test", { baseUrl: s.upstream.url, apiKey: "typed-key" });
  assert.equal(typed.data.ok, true);
  assert.deepEqual(typed.data.models, ["model-a", "model-b"]);
  assert.equal((await c.call("POST", "/providers/test", { id: s.provider.id })).data.ok, true);
  const bad = await c.call("POST", "/providers/test", { baseUrl: s.upstream.url, apiKey: "wrong" });
  assert.equal(bad.data.ok, false);
  assert.match(bad.data.error, /401/);
  const down = await c.call("POST", "/providers/test", { baseUrl: "http://127.0.0.1:1/v1", apiKey: "x" });
  assert.equal(down.data.ok, false);

  assert.deepEqual((await c.call("GET", `/providers/${s.provider.id}/models`)).data.models, ["model-a", "model-b"]);

  // Blank key on edit keeps the stored key.
  await c.call("PATCH", `/providers/${added.data.id}`, { name: "Renamed", apiKey: "" });
  assert.equal(s.store.getProvider(added.data.id).apiKey, "typed-key");

  // Can't delete a connection a route uses; can delete an unused one.
  assert.equal((await c.call("DELETE", `/providers/${s.provider.id}`)).status, 409);
  assert.equal((await c.call("DELETE", `/providers/${added.data.id}`)).status, 200);
  state = (await c.call("GET", "/state")).data;
  assert.equal(state.providers.length, 1);
});

test("routes and resolver", async (t) => {
  const { s, c } = await signedIn();
  t.after(() => s.close());
  const id = s.provider.id;
  const put = await c.call("PUT", "/routes", { default: { provider: id, model: "big" }, haiku: { provider: id, model: "small" }, overrides: [] });
  assert.equal(put.status, 200);
  assert.deepEqual((await c.call("GET", "/resolve?model=claude-haiku-4-5")).data, { provider: "Fake", model: "small", rule: "haiku" });
  assert.equal((await c.call("PUT", "/routes", { default: { provider: "prv_nope", model: "x" } })).status, 400);
});

test("client keys: secret shown once, usage and activity tracked, revoke", async (t) => {
  const { s, c } = await signedIn();
  t.after(() => s.close());

  const created = await c.call("POST", "/keys", { name: "laptop" });
  assert.equal(created.status, 201);
  const secret = created.data.secret;
  assert.match(secret, /^cgw_/);
  assert.equal(created.data.key.hash, undefined);

  const state = (await c.call("GET", "/state")).data;
  assert.ok(!JSON.stringify(state).includes(secret));
  assert.ok(state.clientKeys.every((k) => k.hash === undefined));

  const res = await fetch(`${s.base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": secret },
    body: JSON.stringify({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }], stream: true })
  });
  await res.text();

  const after = (await c.call("GET", "/state")).data;
  assert.equal(after.clientKeys[0].usage.requests, 1);
  assert.equal(after.stats.requests, 1);
  const [entry] = (await c.call("GET", "/activity")).data.entries;
  assert.equal(entry.keyName, "laptop");
  assert.equal(entry.provider, "Fake");
  assert.equal(entry.inputTokens, 7);
  assert.equal(entry.status, 200);

  assert.equal((await c.call("POST", `/keys/${created.data.key.id}/revoke`)).status, 200);
  const denied = await fetch(`${s.base}/v1/messages`, { method: "POST", headers: { "x-api-key": secret }, body: "{}" });
  assert.equal(denied.status, 401);
});

test("changing the password signs out other sessions", async (t) => {
  const { s, c } = await signedIn();
  t.after(() => s.close());
  const other = client(s.base);
  await other.call("POST", "/login", { password: PASSWORD });
  assert.equal((await other.call("GET", "/state")).status, 200);

  assert.equal((await c.call("POST", "/password", { current: "wrong password", next: "brand new password" })).status, 401);
  assert.equal((await c.call("POST", "/password", { current: PASSWORD, next: "brand new password" })).status, 200);
  assert.equal((await c.call("GET", "/state")).status, 200, "the session that changed it stays signed in");
  assert.equal((await other.call("GET", "/state")).status, 401);
});
