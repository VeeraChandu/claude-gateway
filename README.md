# Claude Code Gateway

A small, zero-dependency Node.js gateway that lets **Claude Code** talk to **OpenAI** or any
OpenAI-compatible provider (Venice, DeepSeek, Groq, Ollama, vLLM, OpenRouter, …). It translates
the Anthropic Messages API, including streaming, tool use, images, and thinking, to
`/chat/completions` and back.

- **No dependencies.** Only Node.js built-ins; the Docker image is Alpine plus Node.
- **Low overhead.** About 3 ms added to time-to-first-byte and about 0.01 ms per streamed
  chunk on a laptop (`npm run bench` measures it on yours against a local fake upstream).
- **Built for Claude Code.** Model families route automatically. Context overflows trigger
  Claude Code's auto-compaction. Rate limits are retried. Pressing Esc stops upstream generation.

## Quick start

Requires Node.js 20.12 or newer.

```bash
git clone https://github.com/VeeraChandu/claude-code-gateway.git
cd claude-code-gateway
cp .env.example .env      # set OPENAI_BASE_URL, OPENAI_API_KEY, models
npm start
```

In another terminal:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8080 ANTHROPIC_API_KEY=local claude
```

Or let `./run-claude.sh` start the gateway (if needed) and launch Claude Code with the right variables.
Gateway logs go to `gateway.log`.

### Docker

```bash
echo "GATEWAY_API_KEY=$(openssl rand -hex 24)" >> .env
docker compose up -d
ANTHROPIC_BASE_URL=http://127.0.0.1:5175 ANTHROPIC_API_KEY=<your GATEWAY_API_KEY> claude
```

The container listens on 8080, and compose publishes it on the host's **loopback** at `DOCKER_PORT`
(default 5175). The image has a healthcheck and shuts down gracefully on `SIGTERM`.

## Security

The gateway holds your provider API key, so anything that can reach it can spend your credits.

- **Loopback by default.** With `HOST=127.0.0.1` only processes on your machine can connect.
- **`GATEWAY_API_KEY`** is a shared secret clients must send (Claude Code sends `ANTHROPIC_API_KEY`
  as `x-api-key`). The gateway **refuses to start** on a non-loopback `HOST` without it, unless you set
  `ALLOW_UNAUTHENTICATED=true` because something else (a firewall, an authenticating proxy) restricts access.
- **No CORS.** Browsers can't call the gateway, so websites you visit can't use your key.
- **Request bodies are capped** (`MAX_BODY_MB`, default 32).
- `/health` returns only `{"status":"ok"}`. Model mappings are only shown to authenticated clients.
- **`PASSTHROUGH_CLIENT_KEY=true`** forwards each client's own key upstream instead of `OPENAI_API_KEY`.
  Use it for a shared gateway where every user brings their own key.

## Configuration

All settings are environment variables, usually in `.env`. Your shell's values win over `.env`,
**except** `OPENAI_API_KEY` and `OPENAI_BASE_URL`. Those names are commonly exported for other tools,
so the gateway's `.env` takes precedence. `${VAR}` in `.env` expands from your shell, for example
`OPENAI_API_KEY=${VENICE_API_TOKEN}`. Invalid settings stop startup with a message listing every problem.

| Variable | Default | |
| :-- | :-- | :-- |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Provider base URL |
| `OPENAI_API_KEY` | — | Provider key (any non-empty value for keyless local servers) |
| `DEFAULT_MODEL` | `gpt-4o` | Fallback model |
| `MODEL_OPUS` / `MODEL_SONNET` / `MODEL_HAIKU` | `DEFAULT_MODEL` | Model per Claude family |
| `MODEL_MAP` | — | JSON of exact/prefix overrides, e.g. `{"claude-sonnet-4-5":"gpt-4.1"}` |
| `MAX_OUTPUT_TOKENS` | — | Clamp Claude Code's `max_tokens` (e.g. `16384` for gpt-4o) |
| `REASONING_MODELS` | `(^\|/)(o\d+(-\|$)\|gpt-5)\|reasoner` | Regex for models needing `max_completion_tokens` and no `temperature` |
| `HOST` / `PORT` | `127.0.0.1` / `8080` | Listen address |
| `GATEWAY_API_KEY` | — | Client shared secret (see Security) |
| `PASSTHROUGH_CLIENT_KEY` | `false` | Forward the client's key upstream |
| `UPSTREAM_TIMEOUT_MS` | `300000` | Max wait for upstream response headers |
| `STREAM_IDLE_TIMEOUT_MS` | `300000` | Max gap between streamed chunks |
| `UPSTREAM_MAX_RETRIES` | `2` | Retries for 408/429/5xx/network errors (before streaming starts; honors `Retry-After`) |
| `MAX_BODY_MB` | `32` | Request size limit |
| `LOG_FORMAT` / `LOG_LEVEL` | `pretty` on a TTY, else `json` / `info` | Logging |

### Model routing

1. `MODEL_MAP`: exact match, then the longest matching prefix.
2. Names that don't start with `claude` pass through unchanged, so `claude --model gpt-4.1` works.
3. Claude names route by family: anything containing `opus`, `sonnet`, or `haiku` uses the matching
   `MODEL_*`, so new releases (`claude-sonnet-4-5`, `claude-haiku-5-5`, …) need no config change.
   Point `MODEL_HAIKU` at a cheap model: Claude Code makes many small background calls with it.
4. Anything else uses `DEFAULT_MODEL`.

### Provider examples

```ini
# OpenAI
OPENAI_BASE_URL=https://api.openai.com/v1
DEFAULT_MODEL=gpt-4.1
MODEL_HAIKU=gpt-4.1-mini
MAX_OUTPUT_TOKENS=32768

# Venice
OPENAI_BASE_URL=https://api.venice.ai/api/v1
OPENAI_API_KEY=${VENICE_API_TOKEN}
DEFAULT_MODEL=deepseek-v4-flash

# DeepSeek
OPENAI_BASE_URL=https://api.deepseek.com/v1
DEFAULT_MODEL=deepseek-chat
MAX_OUTPUT_TOKENS=8192

# Ollama / vLLM
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=ollama
DEFAULT_MODEL=qwen2.5-coder:32b
```

## What gets translated

| Anthropic | OpenAI |
| :-- | :-- |
| `system` (string or blocks) | `system` message |
| `tool_use` / `tool_result` | `tool_calls` / `tool` messages (errors prefixed `Error:`) |
| Images in messages **and in tool results** | `image_url` parts (tool images go in a follow-up user message, not inlined as base64 text) |
| `document` blocks | `file` parts (PDF) or text |
| Custom `tools` | `function` tools. Names that OpenAI rejects (over 64 chars, dots, …) are shortened with a hash and mapped back |
| Server tools (`web_search_*`, …) | Dropped. An OpenAI upstream can't run them |
| `tool_choice` auto / any / tool / none, `disable_parallel_tool_use` | `auto` / `required` / function / `none`, `parallel_tool_calls: false` |
| `max_tokens`, `temperature`, `top_p`, `stop_sequences`, `metadata.user_id` | Same names (`max_completion_tokens` for reasoning models), `stop`, hashed `user` |
| Streaming | `message_start` → strictly sequential content blocks → `message_delta` (with real token usage) → `message_stop` |
| `reasoning_content` / `reasoning` | `thinking` blocks when the request enables thinking |
| `finish_reason` | `stop_reason`, including `tool_use` when a provider says `stop` but returned tool calls, and `content_filter` → `refusal` |
| Upstream errors | Anthropic error types (`rate_limit_error`, `overloaded_error`, …). Context-window overflow becomes `prompt is too long`, so Claude Code compacts |

`/v1/messages/count_tokens` returns an estimate (about 4 characters per token, with images and PDFs counted by size class).

## Limitations

- Thinking blocks from earlier turns aren't sent upstream (their signatures are Anthropic-specific).
- Anthropic prompt caching (`cache_control`) is ignored. Provider-side automatic caching still works,
  and cached tokens are reported as `cache_read_input_tokens`.
- Server-side tools (web search, code execution) aren't available.
- `count_tokens` is an estimate, not the upstream tokenizer.

## Troubleshooting

| Symptom | Fix |
| :-- | :-- |
| `400 … max_tokens is too large` | Set `MAX_OUTPUT_TOKENS` to the model's output limit |
| `400 … temperature / max_tokens unsupported` | Add the model to `REASONING_MODELS` |
| `401 Invalid gateway API key` | `ANTHROPIC_API_KEY` must equal `GATEWAY_API_KEY` |
| Gateway exits with "OPENAI_API_KEY in .env references ${X}" | Export `X` in the shell that starts the gateway |
| Background tasks are slow or expensive | Point `MODEL_HAIKU` at a small model |

Use `LOG_LEVEL=debug` to see rejected requests and skipped upstream chunks. Every response carries a
`request-id` header that matches the logs.

## Development

```bash
npm test          # unit and HTTP integration tests against a fake upstream (no network, no cost)
npm run test:live # streaming and tool-call smoke test against your configured provider
npm run bench     # gateway overhead vs. calling the upstream directly
```

The code is plain ESM JavaScript with `// @ts-check` JSDoc types. CI runs the tests on Node 20/22/24,
runs `tsc` over the JSDoc types, and builds the Docker image and checks that it reports healthy.

```
server.js              entry point: config, logging, signals
src/config.js          env loading and validation
src/models.js          model routing, reasoning-model detection
src/server.js          HTTP routing, auth, body limits, streaming pipeline
src/upstream.js        upstream calls: timeouts, retries, cancellation
src/translate/         request / response / stream translation, tool-name mapping
src/errors.js          upstream → Anthropic error mapping
src/sse.js             SSE parsing
```

## License

MIT
