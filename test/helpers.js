import http from "node:http";
import { once } from "node:events";
import { loadConfig } from "../src/config.js";
import { createGateway } from "../src/server.js";

/** Build a config for tests; overrides are env-style strings. */
export function testConfig(env = {}) {
  return loadConfig({ OPENAI_API_KEY: "upstream-key", UPSTREAM_MAX_RETRIES: "0", ...env });
}

/** An OpenAI-style SSE body from chunk objects. */
export function sse(chunks, { done = true } = {}) {
  return chunks.map((c) => `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");
}

export const textChunk = (content) => ({ choices: [{ index: 0, delta: { content } }] });

/**
 * Start a fake upstream and a gateway pointed at it.
 * `handler(req, res, body)` handles each upstream request; requests are recorded.
 */
export async function startStack(handler, env = {}) {
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const record = { headers: req.headers, url: req.url, body: raw ? JSON.parse(raw) : null, closed: false };
    res.on("close", () => (record.closed = !res.writableFinished));
    requests.push(record);
    await handler(req, res, record.body, requests.length);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");

  const config = testConfig({ OPENAI_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`, ...env });
  const gateway = createGateway(config);
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const base = `http://127.0.0.1:${gateway.address().port}`;

  return {
    base,
    requests,
    config,
    async close() {
      gateway.closeAllConnections();
      upstream.closeAllConnections();
      await Promise.all([new Promise((r) => gateway.close(r)), new Promise((r) => upstream.close(r))]);
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
