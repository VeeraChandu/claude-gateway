import { test } from "node:test";
import assert from "node:assert/strict";
import { translateResponse, StreamTranslator, mapStopReason } from "../src/translate/response.js";
import { ToolNames, toUpstreamToolName } from "../src/translate/tool-names.js";
import { textChunk, assertValidAnthropicStream } from "./helpers.js";

const ctx = (extra = {}) => ({ model: "claude-sonnet-4-5", toolNames: new ToolNames(), ...extra });

/** Run chunks through a StreamTranslator and return all events. */
function run(chunks, c = ctx()) {
  const t = new StreamTranslator(c);
  const events = chunks.flatMap((ch) => t.handle(ch));
  events.push(...t.finish());
  return events;
}
const deltas = (events, type) => events.filter(([n, d]) => n === "content_block_delta" && d.delta.type === type).map(([, d]) => d.delta);

test("mapStopReason", () => {
  assert.equal(mapStopReason("stop", false), "end_turn");
  assert.equal(mapStopReason("stop", true), "tool_use");
  assert.equal(mapStopReason(null, true), "tool_use");
  assert.equal(mapStopReason("tool_calls", false), "tool_use");
  assert.equal(mapStopReason("length", true), "max_tokens");
  assert.equal(mapStopReason("content_filter", false), "refusal");
});

test("non-stream: text, tools, usage, name mapping, Ollama-style stop", () => {
  const long = "mcp__x".padEnd(80, "y");
  const toolNames = new ToolNames();
  toolNames.register(long);
  const msg = translateResponse(
    {
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: "Done!",
            tool_calls: [
              { id: "call_xyz", function: { name: "Bash", arguments: '{"command":"echo 1"}' } },
              { function: { name: toUpstreamToolName(long), arguments: "not json" } }
            ]
          }
        }
      ],
      usage: { prompt_tokens: 120, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 100 } }
    },
    { model: "claude-sonnet-4-5", toolNames }
  );
  assert.equal(msg.stop_reason, "tool_use");
  assert.deepEqual(msg.content[0], { type: "text", text: "Done!" });
  assert.deepEqual(msg.content[1], { type: "tool_use", id: "call_xyz", name: "Bash", input: { command: "echo 1" } });
  assert.equal(msg.content[2].name, long);
  assert.match(msg.content[2].id, /^toolu_/);
  assert.deepEqual(msg.content[2].input, { raw: "not json" });
  assert.deepEqual(msg.usage, { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 });
});

test("non-stream: reasoning only surfaces when thinking was requested", () => {
  const data = { choices: [{ finish_reason: "stop", message: { content: "hi", reasoning_content: "because" } }] };
  assert.equal(translateResponse(data, ctx()).content.length, 1);
  assert.deepEqual(translateResponse(data, ctx({ thinkingRequested: true })).content[0], {
    type: "thinking",
    thinking: "because",
    signature: ""
  });
});

test("stream: plain text with usage in message_delta", () => {
  const events = run([
    textChunk("Hel"),
    textChunk("lo"),
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 50, completion_tokens: 2 } }
  ]);
  assertValidAnthropicStream(events, assert);
  assert.deepEqual(deltas(events, "text_delta").map((d) => d.text), ["Hel", "lo"]);
  const md = events.at(-2)[1];
  assert.equal(md.delta.stop_reason, "end_turn");
  assert.equal(md.usage.input_tokens, 50);
  assert.equal(md.usage.output_tokens, 2);
});

test("stream: reasoning → thinking block, then text", () => {
  const chunks = [
    { choices: [{ delta: { reasoning_content: "think " } }] },
    { choices: [{ delta: { reasoning: "more" } }] },
    textChunk("answer")
  ];
  const withThinking = run(chunks, ctx({ thinkingRequested: true }));
  assertValidAnthropicStream(withThinking, assert);
  assert.deepEqual(deltas(withThinking, "thinking_delta").map((d) => d.thinking), ["think ", "more"]);
  assert.equal(withThinking[1][1].content_block.type, "thinking");

  const without = run(chunks);
  assertValidAnthropicStream(without, assert);
  assert.equal(deltas(without, "thinking_delta").length, 0);
});

test("stream: text then two sequential tool calls with split arguments", () => {
  const events = run([
    textChunk("Running."),
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "Bash", arguments: '{"comm' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: "c2", function: { name: "Read", arguments: "" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"path":"a"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
  ]);
  assertValidAnthropicStream(events, assert);
  const starts = events.filter(([n]) => n === "content_block_start").map(([, d]) => d.content_block);
  assert.deepEqual(starts.map((b) => b.type), ["text", "tool_use", "tool_use"]);
  assert.deepEqual(starts.slice(1).map((b) => [b.id, b.name]), [["c1", "Bash"], ["c2", "Read"]]);
  const args = events.filter(([n, d]) => n === "content_block_delta" && d.delta.type === "input_json_delta");
  assert.equal(args.filter(([, d]) => d.index === 1).map(([, d]) => d.delta.partial_json).join(""), '{"command":"ls"}');
  assert.equal(args.filter(([, d]) => d.index === 2).map(([, d]) => d.delta.partial_json).join(""), '{"path":"a"}');
  assert.equal(events.at(-2)[1].delta.stop_reason, "tool_use");
});

test("stream: interleaved parallel tool calls keep blocks sequential and arguments whole", () => {
  const events = run([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "Bash", arguments: '{"comm' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: "c2", function: { name: "Read", arguments: '{"pa' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: 'th":"a"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
  ]);
  assertValidAnthropicStream(events, assert);
  const args = (i) => events.filter(([n, d]) => n === "content_block_delta" && d.index === i).map(([, d]) => d.delta.partial_json).join("");
  assert.equal(args(0), '{"command":"ls"}');
  assert.equal(args(1), '{"path":"a"}');
  const starts = events.filter(([n]) => n === "content_block_start").map(([, d]) => d.content_block.name);
  assert.deepEqual(starts, ["Bash", "Read"]);
});

test("stream: tool name arriving after the id is not lost", () => {
  const events = run([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { arguments: "" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "Bash", arguments: "{}" } }] } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] }
  ]);
  assertValidAnthropicStream(events, assert);
  const start = events.find(([n]) => n === "content_block_start")[1];
  assert.equal(start.content_block.name, "Bash");
  assert.equal(start.content_block.id, "c1");
  // Ollama-style "stop" with tool calls still yields tool_use.
  assert.equal(events.at(-2)[1].delta.stop_reason, "tool_use");
});

test("stream: shortened tool names map back to the original", () => {
  const toolNames = new ToolNames();
  const long = "mcp__server__".padEnd(90, "z");
  const short = toolNames.register(long);
  const events = run([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: short, arguments: "{}" } }] } }] }], ctx({ toolNames }));
  assert.equal(events.find(([n]) => n === "content_block_start")[1].content_block.name, long);
});

test("stream: empty upstream still produces a valid message", () => {
  const events = run([]);
  assertValidAnthropicStream(events, assert);
  assert.equal(events.length, 3);
});

test("stream: content_filter → refusal", () => {
  const events = run([textChunk("I can"), { choices: [{ delta: {}, finish_reason: "content_filter" }] }]);
  assert.equal(events.at(-2)[1].delta.stop_reason, "refusal");
});
