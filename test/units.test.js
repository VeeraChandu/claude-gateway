import { test } from "node:test";
import assert from "node:assert/strict";
import { mapUpstreamError, mapStreamError } from "../src/errors.js";
import { sseData } from "../src/sse.js";
import { estimateInputTokens } from "../src/tokens.js";
import { retryDelayMs } from "../src/upstream.js";

test("mapUpstreamError: status → Anthropic type", () => {
  assert.equal(mapUpstreamError(429, '{"error":{"message":"slow down"}}').type, "rate_limit_error");
  assert.equal(mapUpstreamError(401, "bad key").type, "authentication_error");
  assert.equal(mapUpstreamError(503, "").type, "overloaded_error");
  assert.equal(mapUpstreamError(418, "teapot").type, "invalid_request_error");
  assert.match(mapUpstreamError(429, '{"error":{"message":"slow down"}}').message, /slow down/);
});

test("mapUpstreamError: context overflow → 'prompt is too long' so Claude Code compacts", () => {
  for (const body of [
    '{"error":{"message":"This model\'s maximum context length is 128000 tokens.","code":"context_length_exceeded"}}',
    '{"error":{"message":"bad","code":"context_length_exceeded"}}',
    '{"error":"Input is too long for requested model."}',
    '{"detail":"prompt is too long: 210000 tokens > 200000 maximum"}'
  ]) {
    const e = mapUpstreamError(400, body);
    assert.equal(e.status, 400);
    assert.equal(e.type, "invalid_request_error");
    assert.match(e.message, /^prompt is too long/);
  }
  // max_tokens complaints are not context overflows
  assert.doesNotMatch(mapUpstreamError(400, '{"error":{"message":"max_tokens is too large: 64000"}}').message, /^prompt is too long/);
});

test("mapStreamError", () => {
  assert.equal(mapStreamError({ message: "rate limited", code: 429 }).type, "rate_limit_error");
  assert.equal(mapStreamError({ message: "boom" }).type, "api_error");
});

test("sseData: CRLF, no-space data:, comments, chunk-split lines and UTF-8", async () => {
  const bytes = Buffer.from(': keepalive\r\nevent: x\r\ndata: {"a":"é"}\r\n\r\ndata:{"b":2}\n\ndata: [DONE]\n\n');
  const splitAt = bytes.indexOf(Buffer.from("é")) + 1; // split inside the 2-byte é
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(bytes.subarray(0, splitAt));
      c.enqueue(bytes.subarray(splitAt));
      c.close();
    }
  });
  const out = [];
  for await (const d of sseData(stream)) out.push(d);
  assert.deepEqual(out, ['{"a":"é"}', '{"b":2}', "[DONE]"]);
});

test("estimateInputTokens counts images as images, not base64 text", () => {
  const big = "A".repeat(2_000_000);
  const n = estimateInputTokens({
    system: "x".repeat(400),
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", data: big } }] }]
  });
  assert.ok(n > 1600 && n < 2000, String(n));
});

test("retryDelayMs honors retry-after and caps backoff", () => {
  assert.equal(retryDelayMs(0, "3"), 3000);
  assert.equal(retryDelayMs(0, "999"), 30_000);
  assert.ok(retryDelayMs(10, null) <= 8250);
});
