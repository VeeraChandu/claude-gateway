import http from "node:http";

const TEST_PORT = 8990;
process.env.PORT = String(TEST_PORT);
process.env.DEFAULT_MODEL = "gpt-4o-mini";

// Start server
await import("./server.js");

console.log("\n🛠️ Testing live tool-calling streaming response...\n");

const requestBody = JSON.stringify({
  model: "claude-3-5-sonnet-20241022",
  messages: [
    { role: "user", content: "Run the Bash tool to check what directory we are in using 'pwd'." }
  ],
  tools: [
    {
      name: "Bash",
      description: "Run a bash command",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to run" }
        },
        required: ["command"]
      }
    }
  ],
  tool_choice: { type: "auto" },
  max_tokens: 150,
  stream: true
});

const reqStartTime = performance.now();
const eventsReceived = [];
let toolUseBlock = null;
let toolArgsJson = "";

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
    let buffer = "";

    res.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventsReceived.push(line.slice(7).trim());
        } else if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === "content_block_start" && data.content_block?.type === "tool_use") {
              toolUseBlock = data.content_block;
            } else if (data.type === "content_block_delta" && data.delta?.type === "input_json_delta") {
              toolArgsJson += data.delta.partial_json;
            }
          } catch {}
        }
      }
    });

    res.on("end", () => {
      const totalTime = Math.round(performance.now() - reqStartTime);
      console.log(`Events Received: ${eventsReceived.join(" -> ")}`);
      console.log(`Tool Use Block: `, toolUseBlock);
      console.log(`Tool Arguments:  ${toolArgsJson}`);
      console.log(`Duration:        ${totalTime}ms`);

      if (toolUseBlock && toolUseBlock.name === "Bash") {
        console.log("\n✅ Tool Calling Test Passed! Anthropic tool_use SSE received correctly.\n");
        process.exit(0);
      } else {
        console.error("\n❌ Tool Calling Test Failed.");
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
