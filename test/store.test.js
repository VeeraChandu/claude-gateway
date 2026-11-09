import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store, StoreError, maskSecret, hashPassword, verifyPassword } from "../src/store.js";
import { loadConfig } from "../src/config.js";
import { resolveRoute, isReasoningModel } from "../src/models.js";
import { isLocalNetworkAddress, isAllowedAdminHost, isLoopbackAddress } from "../src/net.js";
import { silentLogger } from "../src/logger.js";

const memStore = () => Store.open({ file: "", logger: silentLogger });

async function tmpFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cgw-"));
  return { dir, file: path.join(dir, "data", "gateway.json") };
}

test("seeds a new store from env, once", async () => {
  const { dir, file } = await tmpFile();
  const seed = loadConfig({
    OPENAI_BASE_URL: "https://api.venice.ai/api/v1",
    OPENAI_API_KEY: "venice-secret",
    DEFAULT_MODEL: "big",
    MODEL_HAIKU: "small",
    MODEL_SONNET: "big",
    MODEL_MAP: '{"claude-fable":"fable-model"}',
    GATEWAY_API_KEY: "legacy-gateway-key-123",
    ADMIN_PASSWORD: "correct horse battery"
  }).seed;

  const store = await Store.open({ file, seed, logger: silentLogger });
  const s = store.state;
  assert.equal(s.providers.length, 1);
  assert.equal(s.providers[0].name, "venice.ai");
  assert.deepEqual(s.routes.default, { provider: s.providers[0].id, model: "big" });
  assert.deepEqual(s.routes.haiku, { provider: s.providers[0].id, model: "small" });
  assert.equal(s.routes.sonnet, null, "same as default is not duplicated");
  assert.deepEqual(s.routes.overrides, [{ match: "claude-fable", provider: s.providers[0].id, model: "fable-model" }]);
  assert.ok(store.verifyClientKey("legacy-gateway-key-123"));
  assert.ok(await store.verifyAdminPassword("correct horse battery"));

  // File is private and holds no plaintext client key.
  const stat = await fs.stat(file);
  assert.equal(stat.mode & 0o777, 0o600);
  const raw = await fs.readFile(file, "utf8");
  assert.ok(!raw.includes("legacy-gateway-key-123"));
  assert.ok(!raw.includes("correct horse battery"));

  // Reopening ignores the seed: the store is the source of truth now.
  await store.addProvider({ name: "Ollama", baseUrl: "http://localhost:11434/v1", apiKey: "ollama" });
  const reopened = await Store.open({ file, seed: { ...seed, defaultModel: "changed" }, logger: silentLogger });
  assert.equal(reopened.state.providers.length, 2);
  assert.equal(reopened.state.routes.default.model, "big");
  await fs.rm(dir, { recursive: true });
});

test("tightens permissions on an existing world-readable store", async () => {
  const { dir, file } = await tmpFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "{}", { mode: 0o644 });
  await Store.open({ file, logger: silentLogger });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await fs.rm(dir, { recursive: true });
});

test("providers: validation, masked view, patch keeps key when blank, delete guarded by routes", async () => {
  const store = await memStore();
  await assert.rejects(store.addProvider({ name: "x", baseUrl: "ftp://nope", apiKey: "k" }), StoreError);
  await assert.rejects(store.addProvider({ name: "", baseUrl: "https://a/v1", apiKey: "k" }), /Name is required/);
  await assert.rejects(store.addProvider({ name: "x", baseUrl: "https://a/v1", apiKey: "k", reasoningPattern: "(" }), /regular expression/);

  const p = await store.addProvider({ name: "OpenAI", baseUrl: "https://api.openai.com/v1/", apiKey: "sk-supersecretkey1234", defaultModel: "gpt-4.1" });
  assert.equal(p.baseUrl, "https://api.openai.com/v1");
  assert.deepEqual(store.state.routes.default, { provider: p.id, model: "gpt-4.1" });
  await assert.rejects(store.addProvider({ name: "openai", baseUrl: "https://b/v1", apiKey: "k" }), /already exists/);

  const view = store.publicView().providers[0];
  assert.equal(view.apiKey, undefined);
  assert.equal(view.apiKeyMasked, "sk-…1234");

  await store.updateProvider(p.id, { name: "OpenAI main", apiKey: "" });
  assert.equal(store.getProvider(p.id).apiKey, "sk-supersecretkey1234");
  await store.updateProvider(p.id, { apiKey: "sk-new" });
  assert.equal(store.getProvider(p.id).apiKey, "sk-new");

  await assert.rejects(store.deleteProvider(p.id), /used by a route/);
});

test("routes: must reference existing connections; default required", async () => {
  const store = await memStore();
  const a = await store.addProvider({ name: "A", baseUrl: "https://a/v1", apiKey: "k", defaultModel: "m" });
  await assert.rejects(store.setRoutes({ default: { provider: "prv_missing", model: "m" } }), /does not exist/);
  await assert.rejects(store.setRoutes({ default: null }), /default route/);
  await assert.rejects(store.setRoutes({ default: { provider: a.id, model: "" } }), /model is required/);
  const r = await store.setRoutes({ default: { provider: a.id, model: "m2" }, haiku: { provider: "", model: "" }, overrides: [{ match: "claude-x", provider: a.id, model: "y" }] });
  assert.equal(r.haiku, null);
  assert.equal(r.overrides.length, 1);
});

test("client keys: hashed, verified, revoked", async () => {
  const store = await memStore();
  assert.equal(store.hasActiveClientKeys(), false);
  const { key, secret } = await store.createClientKey("laptop");
  assert.match(secret, /^cgw_[A-Za-z0-9_-]{32}$/);
  assert.equal(key.prefix, secret.slice(0, 10));
  assert.ok(!JSON.stringify(store.state).includes(secret));
  assert.equal(store.verifyClientKey(secret)?.id, key.id);
  assert.equal(store.verifyClientKey(secret + "x"), null);
  assert.equal(store.verifyClientKey(""), null);

  store.recordUsage(key.id, { inputTokens: 10, outputTokens: 5 });
  store.recordUsage(key.id, { inputTokens: 1, outputTokens: 1 });
  assert.deepEqual(store.state.clientKeys[0].usage, { requests: 2, inputTokens: 11, outputTokens: 6 });
  assert.ok(store.state.clientKeys[0].lastUsedAt);

  assert.equal(store.requiresClientKey(), true);
  await store.revokeClientKey(key.id);
  assert.equal(store.verifyClientKey(secret), null);
  assert.equal(store.hasActiveClientKeys(), false);
  await store.deleteClientKey(key.id);
  assert.equal(store.state.clientKeys.length, 0);
  assert.equal(store.requiresClientKey(), true, "removing every key must not reopen the gateway");
});

test("passwords: scrypt hash round-trip and minimum length", async () => {
  const hash = await hashPassword("a long password");
  assert.match(hash, /^scrypt\$/);
  assert.ok(await verifyPassword("a long password", hash));
  assert.ok(!(await verifyPassword("a long passworD", hash)));
  const store = await memStore();
  await assert.rejects(store.setAdminPassword("short"), /at least 10/);
  assert.equal(await store.verifyAdminPassword("anything"), false);
});

test("maskSecret", () => {
  assert.equal(maskSecret(""), "");
  assert.equal(maskSecret("short"), "••••");
  assert.equal(maskSecret("sk-proj-abcdefghijkl"), "sk-…ijkl");
});

test("resolveRoute: overrides, pass-through, families, default, across connections", async () => {
  const store = await memStore();
  const big = await store.addProvider({ name: "Big", baseUrl: "https://big/v1", apiKey: "k", defaultModel: "big-default" });
  const local = await store.addProvider({ name: "Local", baseUrl: "http://localhost:11434/v1", apiKey: "ollama" });
  await store.setRoutes({
    default: { provider: big.id, model: "big-default" },
    haiku: { provider: local.id, model: "qwen-small" },
    opus: { provider: big.id, model: "big-opus" },
    overrides: [
      { match: "claude-sonnet", provider: big.id, model: "sonnet-generic" },
      { match: "claude-sonnet-4-5", provider: local.id, model: "sonnet-45" }
    ]
  });
  const r = (m) => {
    const x = resolveRoute(m, store.state);
    return x && [x.provider.name, x.model, x.rule];
  };
  assert.deepEqual(r("claude-haiku-4-5-20251001"), ["Local", "qwen-small", "haiku"]);
  assert.deepEqual(r("claude-3-5-haiku-20241022"), ["Local", "qwen-small", "haiku"]);
  assert.deepEqual(r("claude-opus-5-5"), ["Big", "big-opus", "opus"]);
  assert.deepEqual(r("claude-sonnet-4-5-20250929"), ["Local", "sonnet-45", 'override "claude-sonnet-4-5*"']);
  assert.deepEqual(r("claude-sonnet-4"), ["Big", "sonnet-generic", 'override "claude-sonnet*"']);
  assert.deepEqual(r("claude-fable-5-1"), ["Big", "big-default", "default"]);
  assert.deepEqual(r("gpt-4.1"), ["Big", "gpt-4.1", "pass-through"]);
  assert.deepEqual(r(undefined), ["Big", "big-default", "default"]);

  const empty = await memStore();
  assert.equal(resolveRoute("claude-sonnet-4-5", empty.state), null);
});

test("isReasoningModel: built-in detection and per-connection override", () => {
  const builtIn = { reasoningPattern: "" };
  for (const m of ["o1", "o3-mini", "o4-mini", "gpt-5", "gpt-5-mini", "openai/gpt-5", "deepseek-reasoner"]) assert.ok(isReasoningModel(m, builtIn), m);
  for (const m of ["gpt-4o", "gpt-4.1", "deepseek-chat", "qwen2.5-coder:32b", "llama3-70b"]) assert.ok(!isReasoningModel(m, builtIn), m);
  const custom = { reasoningPattern: "^deepseek-v4" };
  assert.ok(isReasoningModel("deepseek-v4-flash", custom));
  assert.ok(!isReasoningModel("o3-mini", custom));
});

test("network checks: local/Tailscale addresses and rebinding-safe hosts", () => {
  for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "10.1.2.3", "172.17.0.1", "192.168.1.20", "100.101.102.103", "::ffff:100.64.0.1", "fd7a:115c:a1e0::1"]) {
    assert.ok(isLocalNetworkAddress(a), a);
  }
  for (const a of ["8.8.8.8", "100.128.0.1", "172.32.0.1", "2001:db8::1", "", undefined]) {
    assert.ok(!isLocalNetworkAddress(a), String(a));
  }
  assert.ok(isLoopbackAddress("::ffff:127.0.0.1"));
  assert.ok(!isLoopbackAddress("10.0.0.1"));

  for (const h of ["localhost:8080", "127.0.0.1:8080", "[::1]:8080", "100.90.1.2:5175", "myserver:8080", "myserver.tail1234.ts.net", "MyServer.Tail1234.ts.net:443"]) {
    assert.ok(isAllowedAdminHost(h), h);
  }
  for (const h of ["evil.example.com", "evil.example.com:8080", "ts.net.evil.com", "", undefined]) {
    assert.ok(!isAllowedAdminHost(h), String(h));
  }
  assert.ok(isAllowedAdminHost("gateway.home.lan:8080", ["gateway.home.lan"]));
});
