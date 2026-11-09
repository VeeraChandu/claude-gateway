// Measures the latency the gateway adds on top of the upstream, using a local
// fake upstream (no network, no API costs). Run: npm run bench
import http from "node:http";
import { once } from "node:events";
import { loadConfig } from "../src/config.js";
import { createGateway } from "../src/server.js";
import { Store } from "../src/store.js";
import { silentLogger } from "../src/logger.js";

const CHUNKS = 500;
const RUNS = 30;
const chunk = (i) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `token${i} ` } }] })}\n\n`;
const body = Array.from({ length: CHUNKS }, (_, i) => chunk(i)).join("") +
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: CHUNKS } })}\n\ndata: [DONE]\n\n`;

const upstream = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(body);
  });
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

const store = await Store.open({ file: "", logger: silentLogger });
await store.addProvider({ name: "bench", baseUrl: `${upstreamUrl}/v1`, apiKey: "x", defaultModel: "m" });
const gateway = createGateway(loadConfig({ DATA_DIR: "none" }), { store });
gateway.listen(0, "127.0.0.1");
await once(gateway, "listening");
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;

async function time(url, payload) {
  const t0 = performance.now();
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const reader = res.body.getReader();
  let ttfb;
  while (true) {
    const { done } = await reader.read();
    ttfb ??= performance.now() - t0;
    if (done) break;
  }
  return { ttfb, total: performance.now() - t0 };
}
const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const req = { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }], max_tokens: 100, stream: true };
const direct = [], via = [];
for (let i = 0; i < RUNS + 5; i++) {
  const d = await time(`${upstreamUrl}/v1/chat/completions`, req);
  const g = await time(`${gatewayUrl}/v1/messages`, req);
  if (i >= 5) { direct.push(d); via.push(g); } // skip warm-up
}

const fmt = (n) => `${n.toFixed(2)} ms`;
console.log(`${CHUNKS}-chunk stream, median of ${RUNS} runs (local fake upstream):`);
console.log(`  time to first byte  direct ${fmt(median(direct.map((r) => r.ttfb)))}   via gateway ${fmt(median(via.map((r) => r.ttfb)))}`);
console.log(`  full stream         direct ${fmt(median(direct.map((r) => r.total)))}   via gateway ${fmt(median(via.map((r) => r.total)))}`);
console.log(`  added per chunk     ${fmt((median(via.map((r) => r.total)) - median(direct.map((r) => r.total))) / CHUNKS)}`);
console.log(`  gateway RSS         ${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)} MB (includes benchmark client + fake upstream)`);
gateway.close();
upstream.close();
