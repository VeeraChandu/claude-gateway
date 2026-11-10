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
cp .env.example .env      # optional: seeds your first connection
npm start
```

The log prints a one-time **admin setup code**. Open <http://127.0.0.1:8080/admin/>, enter the code,
and choose an admin password. Then:

1. **Connections**: add a provider (OpenAI, Venice, DeepSeek, Groq, OpenRouter, Ollama, or any
   OpenAI-compatible URL). **Test connection** checks the key and lists the provider's models.
2. **Routing**: pick the connection and model for the default route and, optionally, for Opus,
   Sonnet, and Haiku.
3. **Client keys**: create a key per device. The key is shown once, together with the two
   `export` lines that point Claude Code at the gateway.

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8080
export ANTHROPIC_API_KEY=cgw_…        # from the Client keys page
claude
```

`./run-claude.sh` starts the gateway if needed and launches Claude Code. It reads the key from
`CLAUDE_GATEWAY_KEY` or `GATEWAY_API_KEY`.

## Admin UI

Served at `/admin` by the gateway itself (plain HTML/JS, no build step):

| Page | |
| :-- | :-- |
| **Overview** | Requests, errors, and token totals; a live table of recent requests showing which key, model, connection, and upstream model each used, plus status, stop reason, tokens, and time to first token |
| **Connections** | Add, edit, test, and delete providers. Each has its own API key, auth scheme, output-token cap, and reasoning-model pattern. Keys are write-only: the UI only ever shows `sk-…a9f2` |
| **Routing** | Connection + model per Claude family (Opus, Sonnet, Haiku, Fable); **your models**, any number of extra entries for Claude Code's `/model` picker; prefix overrides; and a "test a model name" resolver. Changes apply to the next request, with no restart |
| **Client keys** | Create, revoke, and delete keys. Shows last use, request count, and token totals per key |
| **Settings** | Change the admin password (signs out other sessions); server info |

Everything lives in `data/gateway.json` (mode `0600`, written atomically). Provider keys are stored
as-is because the gateway must send them. Client keys are stored only as SHA-256 hashes, and the
admin password as an scrypt hash. Back the file up like any other secret.

## Running on a server with Tailscale

The gateway is meant to be reached from your own devices over your tailnet, never from the public
internet. Two good setups on an Ubuntu server:

**A. `tailscale serve` in front (recommended).** The gateway listens on loopback only, and Tailscale
provides HTTPS at your machine's MagicDNS name:

```bash
# .env: HOST=127.0.0.1  PORT=8080
sudo tailscale serve --bg 8080
# → https://<machine>.<tailnet>.ts.net   (admin at /admin/)
```

**B. Bind to the Tailscale IP.** Set `HOST` to the server's `100.x.y.z` address (`tailscale ip -4`),
so the gateway is only reachable on the tailnet. The included systemd unit starts after `tailscaled`.

For either setup, use `deploy/claude-gateway.service`, a hardened systemd unit with install steps in
its header. Read the setup code with `journalctl -u claude-gateway | grep "setup code"`. With Docker,
set `DOCKER_BIND` to `127.0.0.1` (for `tailscale serve`) or to your Tailscale IP.

On each device:

```bash
export ANTHROPIC_BASE_URL=https://<machine>.<tailnet>.ts.net    # or http://100.x.y.z:8080
export ANTHROPIC_API_KEY=cgw_…
```

### Docker

```bash
docker compose up -d
docker compose logs gateway | grep "setup code"
```

Data is kept in the `gateway-data` volume. Compose publishes on `DOCKER_BIND:DOCKER_PORT`
(default `127.0.0.1:5175`). The image has a healthcheck and shuts down gracefully, saving usage counters.

## Security

The gateway holds your provider API keys, so anything that can use it can spend your credits.

- **Client keys.** Once you create the first client key, every `/v1` request needs a valid,
  unrevoked key. Revoking or deleting every key locks the gateway; it doesn't reopen it. Before the
  first key exists, only direct loopback connections to a loopback-bound gateway are allowed, so a
  fresh install works locally. Requests through a proxy (with `X-Forwarded-For`, as `tailscale serve`
  sends) never count as local. On a non-loopback `HOST`, keys are always required unless
  `ALLOW_UNAUTHENTICATED=true`.
- **Admin UI access is layered:**
  - **Network:** only loopback, private LAN/Docker, and Tailscale (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`)
    addresses can load it (`ADMIN_ALLOW_FROM=local`). Anyone else gets a 404.
  - **Host header:** must be an IP, `localhost`, a single-label MagicDNS name, `*.ts.net`, or a name in
    `ADMIN_HOSTS`. This blocks DNS-rebinding attacks.
  - **Password:** scrypt-hashed, 10+ characters. After 5 failed sign-ins from an address, it's locked
    out for 15 minutes. A fresh install can only be claimed with the setup code from the server log.
  - **Session cookie:** `HttpOnly`, `SameSite=Strict`, scoped to `/admin`, and `Secure` behind HTTPS.
  - **Cross-site protection:** every state-changing call must be same-origin and carry an `X-CGW-Admin`
    header, which other sites can't send without CORS (the gateway sends no CORS headers).
  - **Strict Content-Security-Policy:** no inline script, no framing. The UI builds its DOM with text
    nodes only, never from HTML strings.
- **Request bodies are capped** (`MAX_BODY_MB`, default 32), and `/health` returns only `{"status":"ok"}`.

## Which providers work

Any provider that speaks `POST {baseUrl}/chat/completions`, streams SSE in OpenAI's chunk
format, and supports function calling. That covers OpenAI, Venice, DeepSeek, Groq, OpenRouter,
Together, Fireworks, Cerebras, Ollama, vLLM, llama.cpp, LM Studio and the rest.

Three settings on a connection let it reach providers that deviate from the vanilla shape.
They live under **Connections → Edit → Advanced**:

| Setting | Use it for |
| :-- | :-- |
| **Auth scheme** | `Authorization: Bearer` (default), `x-api-key`, a header you name (**Azure OpenAI** uses `api-key`), or none for a local server |
| **Query parameters** | A query string on every request, e.g. Azure's `api-version=2024-10-21` |
| **Retry without rejected parameters** | On by default. When a provider answers 400 naming `temperature`, `top_p`, `max_tokens`, `max_completion_tokens`, `stop` or `parallel_tool_calls`, the gateway drops just those and retries once |

So Azure OpenAI is a normal connection:

```
Base URL         https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT
Auth scheme      Custom header → api-key
Query parameters api-version=2024-10-21
```

**What still won't work:** providers that don't expose a `/chat/completions` endpoint at all.
Gemini and Vertex native (`generateContent`, `?key=`), and Bedrock (SigV4 signing) are separate
protocols, not OpenAI-compatible variants — point the gateway at a provider that speaks OpenAI,
or at a translating proxy for those. PDF `document` blocks also translate to an OpenAI `file`
part that most OpenAI-compatible servers don't implement; text documents always work.

### When a provider rejects a parameter

OpenAI-compatible implementations disagree about which fields they accept. Rather than making you
find the right **Reasoning models** pattern by trial and error, the gateway handles it: a 400 that
names one of the parameters above is retried once without it, and the retry is logged.

```json
{"level":"warn","msg":"upstream rejected parameters; retrying without them","dropped":"temperature, top_p"}
```

The parameters dropped are recorded on the request in **Overview** and in the log line for the
completed request. Turn the behavior off per connection if you'd rather see the provider's error.

## Configuration

Server settings are environment variables, usually in `.env`. Your shell's values win over `.env`,
**except** `OPENAI_API_KEY` and `OPENAI_BASE_URL` (commonly exported for other tools). `${VAR}` in
`.env` expands from your shell.

| Variable | Default | |
| :-- | :-- | :-- |
| `HOST` / `PORT` | `127.0.0.1` / `8080` | Listen address |
| `DATA_DIR` | `./data` | Where `gateway.json` lives (`none` keeps it in memory) |
| `ADMIN_ENABLED` | `true` | Serve the admin UI |
| `ADMIN_ALLOW_FROM` | `local` | `local` (loopback, private, Tailscale) or `any` |
| `ADMIN_HOSTS` | — | Extra allowed Host names, comma-separated |
| `ADMIN_PASSWORD` | — | Sets the admin password if none is set (skips the setup code) |
| `ALLOW_UNAUTHENTICATED` | `false` | Serve `/v1` without client keys on a non-loopback `HOST` |
| `UPSTREAM_TIMEOUT_MS` | `300000` | Max wait for upstream response headers |
| `STREAM_IDLE_TIMEOUT_MS` | `300000` | Max gap between streamed chunks |
| `UPSTREAM_MAX_RETRIES` | `2` | Retries for 408/429/5xx/network errors (before streaming starts; honors `Retry-After`) |
| `MAX_BODY_MB` | `32` | Request size limit |
| `LOG_FORMAT` / `LOG_LEVEL` | `pretty` on a TTY, else `json` / `info` | Logging |

**First-run seed:** when `data/gateway.json` doesn't exist yet, the gateway creates it from these
variables:
- `OPENAI_BASE_URL` and `OPENAI_API_KEY` become the first connection, with `MAX_OUTPUT_TOKENS` and
  `REASONING_MODELS` as its settings.
- `DEFAULT_MODEL`, `MODEL_OPUS`, `MODEL_SONNET`, `MODEL_HAIKU`, `MODEL_FABLE`, and `MODEL_MAP` become its routes.
- `GATEWAY_API_KEY` becomes a client key.

After that, the store is the source of truth and these variables are ignored.

### More models in Claude Code's `/model` picker

Claude Code's picker has built-in entries: Opus, Sonnet, Haiku, Fable, the `[1m]` variants, and
`opusplan`. Each family routes to whatever you set on the Routing page. The `[1m]` variants reach the
gateway as the plain model name, so they share their family's route.

To add your own entries, use **Routing → Your models**. Add one row per model you want to pick: a
display name, an ID containing `claude` (Claude Code ignores IDs without it), a connection, and an
upstream model. The gateway lists them on `GET /v1/models`. Claude Code loads that list at startup
when this is set:

```bash
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
```

The snippet shown when you create a client key includes it. Restart Claude Code after changing your
models. You can also skip the picker and run `claude --model <your-id>`.

If the same gateway also serves Claude Desktop, keep those IDs free of vendor names such as
`deepseek` or `gpt` — Desktop hides them. See [Claude Desktop](#claude-desktop).

### Model routing

0. **Your models:** an exact ID match.
1. **Overrides:** an exact match, then the longest matching prefix.
2. **Non-Claude names** (`claude --model gpt-4.1`) go to the default connection unchanged.
3. **Claude names route by family:** anything containing `opus`, `sonnet`, `haiku`, or `fable` uses that
   family's route, so new releases need no changes. Families without a route use the default.
   Point Haiku at a cheap model: Claude Code makes many small background calls with it.
4. **Anything else** uses the default route.

### Claude Desktop

Claude Desktop (the app, not Claude Code) can also use this gateway, through its **third-party mode**.
It's a separate instance with its own data directory and its own logs:

| | |
| :-- | :-- |
| Config file | `~/Library/Application Support/Claude-3p/configLibrary/<id>.json` (macOS) |
| Logs | `~/Library/Logs/Claude-3p/main.log` (macOS) |
| Deployment mode | `deploymentMode: "3p"` in `~/Library/Application Support/Claude-3p/claude_desktop_config.json` |

The config library is what the app's own third-party setup window writes, and each entry is a named
config you can switch between. A minimal one for this gateway, using a client key from **Client keys**:

```json
{
  "inferenceProvider": "gateway",
  "inferenceGatewayBaseUrl": "http://127.0.0.1:8080",
  "inferenceGatewayApiKey": "cgw_…",
  "inferenceGatewayAuthScheme": "bearer",
  "inferenceCredentialKind": "static",
  "inferenceModels": [
    { "name": "claude-sonnet-5", "labelOverride": "Sonnet 5 via gateway" }
  ]
}
```

Restart the app after editing. `inferenceGatewayAuthScheme` accepts `bearer` (the default, which sends
`Authorization: Bearer <key>`) or `x-api-key`; this gateway accepts both.

`inferenceCredentialKind` describes *how the app gets* the credential, and for a fixed API key the
right value is `"static"` (the setup window calls it **Static API key**). The full enum is `static`,
`helper-script`, `interactive`, `vendor-profile`, `workforce`, and `external-idp`; anything else makes
the whole config invalid. `static` is what the setup window writes when you paste a key.

Desktop reads the model list from `GET /v1/models` unless `inferenceModels` is set, in which case that
list wins. Setting it explicitly is more predictable than relying on discovery.

#### Model names: Desktop drops vendor names

**Desktop silently discards any model ID containing a third-party vendor token.** Its filter keeps a
row only if the ID matches a Claude family alias or contains `claude` / `anthropic` / a family name —
*and* contains none of `deepseek`, `gemini`, `glm`, `gpt`, `grok`, `qwen`, `llama`, `mistral`,
`nemotron`, `openai`, `codex`, `solar`, `mercury`, and about forty more. The check runs before
`anthropic`/`claude` is considered, so a `claude-` prefix is **not** an exemption:

| Model ID | Desktop | Claude Code |
| :-- | :-- | :-- |
| `claude-sonnet-5`, `claude-opus-5-5` | shown | shown |
| `claude-venice-flash`, `claude-flash` | shown | shown |
| `claude-deepseek-v4-1-flash` | **dropped** | shown |
| `claude-nemotron-3-ultra` | **dropped** | shown |
| `gpt-4.1`, `deepseek-chat` | **dropped** | shown (pass-through) |

The same check validates IDs in `inferenceModels` and again when a session names a model, so
`behavesAs` cannot rescue a dropped ID — an ID Desktop refuses at discovery is refused at use too.
Only the model *ID* matters: the upstream model behind it is sent to your provider as-is. A route
named `claude-venice-flash` pointed at `deepseek-v4-1-flash` works in both clients.

**The admin UI suggests a safe ID for you.** Under **Routing → Your models**, type the upstream model
name and the ID is filled in with a vendor-free one; the shape is `claude-<vendor code>-<model>`, so
`deepseek-v4-1-flash` becomes `claude-d-v4-1-flash` and `openai-gpt-6-luna` becomes `claude-o-6-luna`.
The ID field warns as you type when Desktop would drop the value, names the offending token, and
offers **Use suggested ID** to fix it — including on rows you saved earlier. Suggestions repair a
name token rather than dropping it (`kimi-k2.5` → `claude-k-k2-5`, `phi-4` → `claude-p-4`), since a
`.` or `-` inside a version is what usually trips the filter. The vendor list is embedded in the
app, so a suggestion is a best effort: check it against the table above if Desktop ever updates.

So when you add rows under **Routing → Your models**, give Desktop-facing entries IDs that name no
vendor. Claude Code's own gate is only "the ID contains `claude`", which is why a name like
`claude-deepseek-v4-1-flash` can work in Claude Code and still show *Your organization hasn't
configured any models* in Desktop.

If Desktop shows that message, its log says why:

```bash
tail -20 ~/Library/Logs/Claude-3p/main.log
```

- `Gateway /v1/models returned 0 usable models { rawCount: 1 }` — the gateway answered and Desktop
  dropped the row: it's a vendor name (above).
- `Gateway /v1/models non-OK` — the client key is wrong, or the app can't reach the URL.
- `Model discovery: 0 found … picker = 0 (empty)` — nothing was usable, so the picker is empty.
- `ConfigHealth recomputed { state: 'invalid_config' }` — a field has a bad value or a value outside
  its enum (a misspelled scheme, an unknown `inferenceCredentialKind`, …). The log line above it
  names the field. `inferenceCredentialKind: "static"` is valid and is not a cause.

Model discovery needs the gateway reachable at `inferenceGatewayBaseUrl` when the app launches.

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
| `400 … max_tokens is too large` | Set the connection's **Max output tokens** to the model's limit |
| `400 … temperature / max_tokens unsupported` | Handled automatically (the gateway retries without them). Set the connection's **Reasoning models** pattern only if you want to avoid the first 400 |
| `401 … from an Azure endpoint` | Set the connection's **Auth scheme** to a custom header named `api-key`, and add `api-version=…` under **Query parameters** |
| `401 Missing / invalid client key` | Set `ANTHROPIC_API_KEY` to an active key from **Client keys** |
| `503 No connection configured` | Add a connection and a default route in the admin UI |
| `/admin` returns 404 from another machine | It's only served to local, private, and Tailscale addresses (`ADMIN_ALLOW_FROM`) |
| `/admin` says the Host is not allowed | Browse by IP, MagicDNS name, or `*.ts.net`, or add the name to `ADMIN_HOSTS` |
| Lost the admin password | Stop the gateway, set `"passwordHash": ""` under `admin` in `data/gateway.json`, and start it. A new setup code is printed |
| Claude Desktop says *Your organization hasn't configured any models* | Its model ID contains a third-party vendor name — see [Claude Desktop](#claude-desktop) |
| Background tasks are slow or expensive | Route Haiku to a small model |

Use `LOG_LEVEL=debug` to see rejected requests and skipped upstream chunks. Every response carries a
`request-id` header that matches the logs.

## Development

```bash
npm test          # unit and HTTP integration tests against a fake upstream (no network, no cost)
npm run test:live # streaming and tool-call smoke test against your saved connections
npm run bench     # gateway overhead vs. calling the upstream directly
```

The code is plain ESM JavaScript with `// @ts-check` JSDoc types. CI runs the tests on Node 20/22/24,
runs `tsc` over the JSDoc types, and builds the Docker image and checks that it reports healthy.

```
server.js              entry point: config, logging, signals
src/config.js          env loading and validation
src/store.js           persistent connections, routes, client keys, admin password
src/models.js          model routing across connections, reasoning-model detection
src/model-names.js     Claude Desktop's vendor-name filter and safe model-ID suggestions
src/server.js          HTTP routing, client auth, body limits, streaming pipeline
src/admin/             admin API (sessions, CSRF/Host/IP checks) and the UI in public/
src/net.js             address and Host header checks
src/activity.js        recent-request log and totals
src/upstream.js        upstream calls: timeouts, retries, cancellation, parameter-rejection retry
src/provider-request.js  how a connection is addressed: URL, auth header, query parameters
src/translate/         request / response / stream translation, tool-name mapping
src/errors.js          upstream → Anthropic error mapping
src/sse.js             SSE parsing
```

## License

MIT
