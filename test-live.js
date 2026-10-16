import http from "node:http";

const TEST_PORT = 8989;
process.env.PORT = String(TEST_PORT);
process.env.DEFAULT_MODEL = process.env.DEFAULT_MODEL || "gpt-4o-mini";

// Start server
await import("./server.js");

console.log("\n🚀 Testing live gateway streaming response...\n");

const requestBody = JSON.stringify({
  model: "claude-3-5-sonnet-20241022",
  messages: [
    { role: "user", content: "Reply with exactly: 'Gateway is working perfectly!'" }
  ],
  max_tokens: 30,
  stream: true
});

const reqStartTime = performance.now();
let ttft = 0;
let fullText = "";
const eventsReceived = [];

const req = http.request(
  {
    hostname: "127.0.0.1",
    port: TEST_PORT,
    path: "/v1/messages",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "test-key"
    }
  },
  (res) => {
    console.log(`HTTP Status: ${res.statusCode}`);
    let buffer = "";

    res.on("data", (chunk) => {
      if (!ttft) {
        ttft = Math.round(performance.now() - reqStartTime);
      }
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let currentEvent = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
          eventsReceived.push(currentEvent);
        } else if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.delta?.text) {
              fullText += data.delta.text;
            }
          } catch {}
        }
      }
    });

    res.on("end", () => {
      const totalTime = Math.round(performance.now() - reqStartTime);
      console.log(`\nTime to First Token (TTFT): ${ttft}ms`);
      console.log(`Total Duration:             ${totalTime}ms`);
      console.log(`Events Received:            ${eventsReceived.join(" -> ")}`);
      console.log(`Model Response:             "${fullText.trim()}"`);

      if (eventsReceived.includes("message_start") && eventsReceived.includes("message_stop")) {
        console.log("\n✅ Integration Test Passed! Full Anthropic SSE stream verified.\n");
        process.exit(0);
      } else {
        console.error("\n❌ Test Failed: Incomplete event stream.");
        process.exit(1);
      }
    });
  }
);

req.on("error", (err) => {
  console.error("Request error:", err);
  process.exit(1);
});

req.write(requestBody);
req.end();
