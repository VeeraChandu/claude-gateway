import http from "node:http";
import { once } from "node:events";
import { loadConfig } from "../src/config.js";
import { createGateway } from "../src/server.js";
import { Store } from "../src/store.js";
import { silentLogger } from "../src/logger.js";

/** Build a config for tests; overrides are env-style strings. */
export function testConfig(env = {}) {
  return loadConfig({ DATA_DIR: "none", UPSTREAM_MAX_RETRIES: "0", ...env });
}

/** An in-memory store with one connection as the default route. */
export async function testStore({ baseUrl = "http://127.0.0.1:9/v1", model = "upstream-model", provider = {} } = {}) {
  const store = await Store.open({ file: "", logger: silentLogger });
  const p = await store.addProvider({ name: "Fake", baseUrl, apiKey: "upstream-key", defaultModel: model, ...provider });
  return { store, provider: p };
}

/** An OpenAI-style SSE body from chunk objects. */
export function sse(chunks, { done = true } = {}) {
  return chunks.map((c) => `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");
}

export const textChunk = (content) => ({ choices: [{ index: 0, delta: { content } }] });

/** Start a fake OpenAI-compatible upstream; requests are recorded. */
export async function fakeUpstream(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const record = { method: req.method, headers: req.headers, url: req.url, body: raw ? JSON.parse(raw) : null, closed: false };
    res.on("close", () => (record.closed = !res.writableFinished));
    requests.push(record);
    await handler(req, res, record.body, requests.length);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    server,
    requests,
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close() {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    }
  };
}

/**
 * Start a fake upstream and a gateway pointed at it.
 * `handler(req, res, body, n)` handles each upstream request.
 * opts.clientKey: create a client key and return it as `key`.
 */
export async function startStack(handler, env = {}, opts = {}) {
  const upstream = await fakeUpstream(handler);
  const { store, provider } = await testStore({ baseUrl: upstream.url, ...opts.store });
  const key = opts.clientKey ? (await store.createClientKey("test")).secret : "";

  const config = testConfig(env);
  const gateway = createGateway(config, { store, setupCode: opts.setupCode ?? "" });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const base = `http://127.0.0.1:${gateway.address().port}`;

  return {
    base,
    requests: upstream.requests,
    upstream,
    store,
    provider,
    config,
    key,
    async close() {
      gateway.closeAllConnections();
      await Promise.all([new Promise((r) => gateway.close(r)), upstream.close()]);
    }
  };
}

/** Parse an Anthropic SSE response body into [{event, data}]. */
export function parseAnthropicSse(text) {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const event = block.match(/^event: (.*)$/m)?.[1];
      const data = block.match(/^data: (.*)$/m)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });
}

/**
 * Assert the Anthropic stream grammar: message_start first, blocks strictly
 * sequential with increasing indices, then message_delta + message_stop.
 */
export function assertValidAnthropicStream(events, assert) {
  assert.equal(events[0][0], "message_start");
  let open = null;
  let next = 0;
  for (const [name, data] of events.slice(1)) {
    if (name === "content_block_start") {
      assert.equal(open, null, `block ${data.index} started while ${open} still open`);
      assert.equal(data.index, next++);
      open = data.index;
    } else if (name === "content_block_delta") {
      assert.equal(data.index, open, "delta for a block that is not open");
    } else if (name === "content_block_stop") {
      assert.equal(data.index, open);
      open = null;
    }
  }
  assert.equal(open, null, "a block was left open");
  assert.deepEqual(events.slice(-2).map((e) => e[0]), ["message_delta", "message_stop"]);
}
