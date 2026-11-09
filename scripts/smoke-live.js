// Live check against your real provider using your .env (costs a few tokens).
// Verifies streaming text and a tool-call round trip. Run: npm run test:live
import { once } from "node:events";
import { loadConfigFromEnvironment } from "../src/config.js";
import { createGateway } from "../src/server.js";
import { createLogger } from "../src/logger.js";

const config = loadConfigFromEnvironment();
const gateway = createGateway(config, { logger: createLogger({ format: "pretty", level: "warn" }) });
gateway.listen(0, "127.0.0.1");
await once(gateway, "listening");
const base = `http://127.0.0.1:${gateway.address().port}`;
const headers = { "content-type": "application/json", "x-api-key": config.gatewayApiKey || "local" };

async function stream(body) {
  const res = await fetch(`${base}/v1/messages`, { method: "POST", headers, body: JSON.stringify({ ...body, stream: true }) });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${text}`);
  return text.split("\n\n").filter(Boolean).map((b) => ({
    event: b.match(/^event: (.*)$/m)?.[1],
    data: JSON.parse(b.match(/^data: (.*)$/m)?.[1] ?? "null")
  }));
}

let failed = false;
async function check(name, fn) {
  const t0 = performance.now();
  try {
    const detail = await fn();
    console.log(`✅ ${name} (${Math.round(performance.now() - t0)} ms) ${detail ?? ""}`);
  } catch (err) {
    failed = true;
    console.log(`❌ ${name}: ${err.message}`);
  }
}

console.log(`Upstream: ${config.upstreamBaseUrl}  sonnet → ${config.familyModels.sonnet}  haiku → ${config.familyModels.haiku}\n`);

await check("streaming text", async () => {
  const events = await stream({
    model: "claude-haiku-4-5",
    max_tokens: 50,
    messages: [{ role: "user", content: "Reply with exactly: gateway ok" }]
  });
  const text = events.filter((e) => e.data?.delta?.type === "text_delta").map((e) => e.data.delta.text).join("");
  if (events[0]?.event !== "message_start" || events.at(-1)?.event !== "message_stop") throw new Error("incomplete event stream");
  const usage = events.find((e) => e.event === "message_delta")?.data.usage;
  return `"${text.trim()}" usage=${JSON.stringify({ in: usage?.input_tokens, out: usage?.output_tokens })}`;
});

await check("tool call", async () => {
  const events = await stream({
    model: "claude-sonnet-4-5",
    max_tokens: 200,
    tools: [{ name: "Bash", description: "Run a bash command", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }],
    tool_choice: { type: "any" },
    messages: [{ role: "user", content: "Use the Bash tool to run `pwd`." }]
  });
  const block = events.find((e) => e.data?.content_block?.type === "tool_use")?.data.content_block;
  const args = events.filter((e) => e.data?.delta?.type === "input_json_delta").map((e) => e.data.delta.partial_json).join("");
  const stop = events.find((e) => e.event === "message_delta")?.data.delta.stop_reason;
  if (block?.name !== "Bash") throw new Error("no Bash tool_use block");
  JSON.parse(args);
  if (stop !== "tool_use") throw new Error(`stop_reason ${stop}`);
  return `Bash(${args})`;
});

gateway.close();
process.exit(failed ? 1 : 0);
