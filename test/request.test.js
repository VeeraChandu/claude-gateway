import { test } from "node:test";
import assert from "node:assert/strict";
import { translateRequest } from "../src/translate/request.js";
import { toUpstreamToolName } from "../src/translate/tool-names.js";

const opts = { model: "gpt-4o", reasoning: false };

test("simple message, system prompt and sampling params", () => {
  const { payload } = translateRequest(
    {
      model: "claude-sonnet-4-5",
      system: [{ type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } }, { type: "text", text: "Be kind." }],
      messages: [{ role: "user", content: "Hello!" }],
      max_tokens: 1024,
      temperature: 0.7,
      top_p: 0.9,
      top_k: 5,
      stop_sequences: ["a", "b", "c", "d", "e"],
      metadata: { user_id: "user_abc_session_123" },
      stream: true
    },
    opts
  );
  assert.deepEqual(payload.messages, [
    { role: "system", content: "Be brief.\n\nBe kind." },
    { role: "user", content: "Hello!" }
  ]);
  assert.equal(payload.max_tokens, 1024);
  assert.equal(payload.temperature, 0.7);
  assert.equal(payload.top_p, 0.9);
  assert.equal(payload.top_k, undefined);
  assert.deepEqual(payload.stop, ["a", "b", "c", "d"]);
  assert.match(payload.user, /^[0-9a-f]{32}$/);
  assert.deepEqual(payload.stream_options, { include_usage: true });
});

test("stream defaults to false like the Anthropic API", () => {
  const { payload } = translateRequest({ messages: [] }, opts);
  assert.equal(payload.stream, false);
  assert.equal(payload.stream_options, undefined);
});

test("reasoning models get max_completion_tokens and no sampling params", () => {
  const { payload } = translateRequest(
    { system: "S", messages: [{ role: "user", content: "x" }], max_tokens: 2000, temperature: 1, top_p: 0.5 },
    { model: "gpt-5", reasoning: true }
  );
  assert.equal(payload.max_completion_tokens, 2000);
  assert.equal(payload.max_tokens, undefined);
  assert.equal(payload.temperature, undefined);
  assert.equal(payload.top_p, undefined);
  assert.equal(payload.messages[0].role, "system");
});

test("max_tokens is clamped to MAX_OUTPUT_TOKENS", () => {
  const { payload } = translateRequest({ messages: [], max_tokens: 64000 }, { ...opts, maxOutputTokens: 16384 });
  assert.equal(payload.max_tokens, 16384);
});

test("tools: cache_control dropped, server tools filtered, tool_choice mapped", () => {
  const { payload } = translateRequest(
    {
      messages: [],
      tools: [
        {
          name: "Bash",
          description: "Run command",
          input_schema: { type: "object", properties: { cache_control: { type: "string" } } },
          cache_control: { type: "ephemeral" }
        },
        { type: "web_search_20250305", name: "web_search", max_uses: 5 },
        { type: "custom", name: "Read", input_schema: { type: "object", properties: {} } }
      ],
      tool_choice: { type: "any", disable_parallel_tool_use: true }
    },
    opts
  );
  assert.deepEqual(
    payload.tools.map((t) => t.function.name),
    ["Bash", "Read"]
  );
  assert.equal(payload.tools[0].cache_control, undefined);
  // A real property that happens to be named cache_control is preserved.
  assert.deepEqual(payload.tools[0].function.parameters.properties.cache_control, { type: "string" });
  assert.equal(payload.tool_choice, "required");
  assert.equal(payload.parallel_tool_calls, false);

  const none = translateRequest({ messages: [], tools: [{ name: "A", input_schema: {} }], tool_choice: { type: "none" } }, opts);
  assert.equal(none.payload.tool_choice, "none");

  const onlyServer = translateRequest({ messages: [], tools: [{ type: "web_search_20250305", name: "web_search" }], tool_choice: { type: "auto" } }, opts);
  assert.equal(onlyServer.payload.tools, undefined);
  assert.equal(onlyServer.payload.tool_choice, undefined);
});

test("long / invalid tool names are shortened consistently and map back", () => {
  const long = "mcp__some-really-long-server-name__and_an_even_longer_tool_name_that_overflows";
  const dotted = "my.tool";
  assert.ok(long.length > 64);
  const short = toUpstreamToolName(long);
  assert.ok(short.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(short));
  assert.notEqual(toUpstreamToolName(dotted), toUpstreamToolName("my_tool"));

  const { payload, toolNames } = translateRequest(
    {
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: long, input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }
      ],
      tools: [{ name: long, input_schema: { type: "object" } }, { name: dotted, input_schema: { type: "object" } }],
      tool_choice: { type: "tool", name: long }
    },
    opts
  );
  assert.equal(payload.tools[0].function.name, short);
  assert.equal(payload.messages[1].tool_calls[0].function.name, short);
  assert.equal(payload.tool_choice.function.name, short);
  assert.equal(toolNames.toOriginal(short), long);
  assert.equal(toolNames.toOriginal(toUpstreamToolName(dotted)), dotted);
  assert.equal(toolNames.toOriginal("Unknown"), "Unknown");
});

test("tool_use / tool_result round trip, thinking dropped, errors flagged", () => {
  const { payload } = translateRequest(
    {
      messages: [
        { role: "user", content: "List files" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm", signature: "sig" },
            { type: "text", text: "Checking." },
            { type: "tool_use", id: "call_1", name: "Bash", input: { command: "ls" } },
            { type: "tool_use", id: "call_2", name: "Bash", input: { command: "pwd" } }
          ]
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "a.txt" }] },
            { type: "tool_result", tool_use_id: "call_2", is_error: true, content: "permission denied" },
            { type: "text", text: "<system-reminder>x</system-reminder>" }
          ]
        },
        { role: "assistant", content: [{ type: "thinking", thinking: "only thinking", signature: "s" }] }
      ]
    },
    opts
  );
  assert.deepEqual(payload.messages.slice(1), [
    {
      role: "assistant",
      content: "Checking.",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } },
        { id: "call_2", type: "function", function: { name: "Bash", arguments: '{"command":"pwd"}' } }
      ]
    },
    { role: "tool", tool_call_id: "call_1", content: "a.txt" },
    { role: "tool", tool_call_id: "call_2", content: "Error: permission denied" },
    { role: "user", content: "<system-reminder>x</system-reminder>" }
  ]);
});

test("images in tool results move to a user message instead of being stringified", () => {
  const data = "A".repeat(10_000);
  const { payload } = translateRequest(
    {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "r1", name: "Read", input: {} }] },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "r1",
              content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data } }]
            }
          ]
        }
      ]
    },
    opts
  );
  const [, toolMsg, userMsg] = payload.messages;
  assert.equal(toolMsg.role, "tool");
  assert.ok(!toolMsg.content.includes(data), "base64 must not be inlined as text");
  assert.equal(userMsg.role, "user");
  assert.deepEqual(userMsg.content[1], { type: "image_url", image_url: { url: `data:image/jpeg;base64,${data}` } });
});

test("user images, url images and documents", () => {
  const { payload } = translateRequest(
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look" },
            { type: "image", source: { type: "url", url: "https://x/y.png" } },
            { type: "document", title: "spec.pdf", source: { type: "base64", media_type: "application/pdf", data: "UERG" } },
            { type: "document", source: { type: "text", media_type: "text/plain", data: "plain doc" } }
          ]
        }
      ]
    },
    opts
  );
  assert.deepEqual(payload.messages[0].content, [
    { type: "text", text: "Look" },
    { type: "image_url", image_url: { url: "https://x/y.png" } },
    { type: "file", file: { filename: "spec.pdf", file_data: "data:application/pdf;base64,UERG" } },
    { type: "text", text: "plain doc" }
  ]);
});

test("multiple text blocks collapse to one string", () => {
  const { payload } = translateRequest(
    { messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] },
    opts
  );
  assert.equal(payload.messages[0].content, "a\n\nb");
});
