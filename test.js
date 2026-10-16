import assert from "node:assert";
import { anthropicToOpenAI, openAIToAnthropicNonStream } from "./translator.js";

console.log("🧪 Testing Anthropic -> OpenAI translation...\n");

// Test 1: Simple message translation
const req1 = {
  model: "claude-3-7-sonnet-20250219",
  system: "You are a helpful assistant.",
  messages: [
    { role: "user", content: "Hello!" }
  ],
  max_tokens: 1024,
  temperature: 0.7,
  stream: true
};

const openAi1 = anthropicToOpenAI(req1, "gpt-4o");
assert.strictEqual(openAi1.model, "gpt-4o");
assert.strictEqual(openAi1.stream, true);
assert.strictEqual(openAi1.max_tokens, 1024);
assert.strictEqual(openAi1.temperature, 0.7);
assert.strictEqual(openAi1.messages[0].role, "system");
assert.strictEqual(openAi1.messages[0].content, "You are a helpful assistant.");
assert.strictEqual(openAi1.messages[1].role, "user");
assert.strictEqual(openAi1.messages[1].content, "Hello!");
console.log("  ✅ Test 1 Passed: Simple message & system prompt");

// Test 2: Tools conversion
const req2 = {
  model: "claude-3-5-sonnet-20241022",
  messages: [{ role: "user", content: "Run bash" }],
  tools: [
    {
      name: "Bash",
      description: "Run command",
      input_schema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"]
      },
      cache_control: { type: "ephemeral" } // Anthropic prompt caching
    }
  ]
};

const openAi2 = anthropicToOpenAI(req2, "gpt-4o");
assert.strictEqual(openAi2.tools.length, 1);
assert.strictEqual(openAi2.tools[0].type, "function");
assert.strictEqual(openAi2.tools[0].function.name, "Bash");
assert.strictEqual(openAi2.tools[0].function.parameters.cache_control, undefined);
console.log("  ✅ Test 2 Passed: Tool schema converted and cache_control stripped");

// Test 3: Tool use and tool result round-trip
const req3 = {
  model: "claude-3-5-sonnet-20241022",
  messages: [
    { role: "user", content: "List files" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I will check the directory." },
        { type: "tool_use", id: "call_abc123", name: "Bash", input: { command: "ls" } }
      ]
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_abc123", content: "file1.txt\nfile2.txt" }
      ]
    }
  ]
};

const openAi3 = anthropicToOpenAI(req3, "gpt-4o");
assert.strictEqual(openAi3.messages.length, 3);
// Assistant turn has tool_calls
assert.strictEqual(openAi3.messages[1].role, "assistant");
assert.strictEqual(openAi3.messages[1].content, "I will check the directory.");
assert.strictEqual(openAi3.messages[1].tool_calls.length, 1);
assert.strictEqual(openAi3.messages[1].tool_calls[0].id, "call_abc123");
assert.strictEqual(openAi3.messages[1].tool_calls[0].function.name, "Bash");

// User turn with tool_result maps to role: 'tool'
assert.strictEqual(openAi3.messages[2].role, "tool");
assert.strictEqual(openAi3.messages[2].tool_call_id, "call_abc123");
assert.strictEqual(openAi3.messages[2].content, "file1.txt\nfile2.txt");
console.log("  ✅ Test 3 Passed: Multi-turn tool execution mapping");

// Test 4: Reasoning models (o1 / o3-mini) parameter adjustment
const openAi4 = anthropicToOpenAI(req1, "o3-mini");
assert.strictEqual(openAi4.temperature, undefined); // Omitted for reasoning models
assert.strictEqual(openAi4.max_completion_tokens, 1024);
assert.strictEqual(openAi4.messages[0].role, "developer");
console.log("  ✅ Test 4 Passed: Reasoning models (o1/o3-mini) developer role & max_completion_tokens");

// Test 5: Non-streaming response mapping
const openAiResponse = {
  id: "chatcmpl-999",
  choices: [
    {
      message: {
        role: "assistant",
        content: "Done!",
        tool_calls: [
          {
            id: "call_xyz",
            type: "function",
            function: { name: "Bash", arguments: '{"command":"echo 1"}' }
          }
        ]
      },
      finish_reason: "tool_calls"
    }
  ],
  usage: { prompt_tokens: 20, completion_tokens: 10 }
};

const anthropicRes = openAIToAnthropicNonStream(openAiResponse, "claude-3-7-sonnet-20250219");
assert.strictEqual(anthropicRes.model, "claude-3-7-sonnet-20250219");
assert.strictEqual(anthropicRes.stop_reason, "tool_use");
assert.strictEqual(anthropicRes.content.length, 2);
assert.strictEqual(anthropicRes.content[0].type, "text");
assert.strictEqual(anthropicRes.content[0].text, "Done!");
assert.strictEqual(anthropicRes.content[1].type, "tool_use");
assert.strictEqual(anthropicRes.content[1].name, "Bash");
assert.deepStrictEqual(anthropicRes.content[1].input, { command: "echo 1" });
console.log("  ✅ Test 5 Passed: Non-streaming response format conversion");

console.log("\n🎉 All translation tests passed successfully!\n");
