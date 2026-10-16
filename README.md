# Claude Code Gateway

A blazing-fast, lightweight, zero-dependency LLM gateway that routes **Claude Code** to **OpenAI** (or any OpenAI-compatible provider like Venice AI, DeepSeek, Groq, Ollama) with near-zero latency.

---

## ⚡ Why This Gateway?

LiteLLM and other multi-provider proxies introduce noticeable streaming lag due to heavy Python abstractions, Pydantic schema validation, and background logging hooks.

This gateway is built with pure native Node.js streams and socket pipelines:

| Feature | LiteLLM | Claude Code Gateway |
| :--- | :--- | :--- |
| **Proxy Latency** | 50ms – 250ms+ per chunk | **< 1ms** (pure streaming pipe) |
| **Docker Size** | ~550 MB | **~73 MB** (stripped Alpine) |
| **Memory Footprint** | ~180 MB | **~16 MB** |
| **External Dependencies** | Hundreds of Python packages | **Zero (0 npm dependencies)** |
| **Startup Time** | 2–5 seconds | **~10ms** |

---

## 🚀 Quick Start

### 1. Clone & Configure

```bash
git clone https://github.com/VeeraChandu/claude-code-gateway.git
cd claude-code-gateway
cp .env.example .env
```

Edit `.env` to configure your API key and provider:

```ini
# Provider URL (OpenAI, Venice AI, DeepSeek, Ollama, etc.)
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=your-api-key-here

# Target model
DEFAULT_MODEL=gpt-4o

# Port & Host
PORT=8080
HOST=127.0.0.1
```

---

### 2. Run the Gateway

#### Option A: Local Node.js (Node 20+)
```bash
npm start
```

#### Option B: Minimal Docker Container (~73 MB)
Using Docker Compose:
```bash
docker compose up -d
```
Or via Docker / Podman CLI:
```bash
docker build -t claude-code-gateway .
docker run -d --name claude-gateway -p 8080:8080 --env-file .env claude-code-gateway
```

---

### 3. Launch Claude Code

In any project directory, point Claude Code to the local gateway:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8080"
export ANTHROPIC_API_KEY="sk-local-gateway"
claude
```

Or run the included one-command launcher:
```bash
./run-claude.sh
```

---

## 🔄 Provider Examples

### Official OpenAI
```ini
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-...
DEFAULT_MODEL=gpt-4o
```

### Venice AI
```ini
OPENAI_BASE_URL=https://api.venice.ai/api/v1
OPENAI_API_KEY=your_venice_token
DEFAULT_MODEL=deepseek-v4-flash
```

### DeepSeek Direct
```ini
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_API_KEY=your_deepseek_key
DEFAULT_MODEL=deepseek-chat
```

### Local Ollama / vLLM
```ini
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=ollama
DEFAULT_MODEL=qwen2.5-coder:32b
```

---

## 🧩 Protocol Translation Details

1. **System Prompt**: Maps Anthropic system strings and block arrays into OpenAI `system` or `developer` role messages.
2. **Tool / Function Calling**: Translates Anthropic JSON Schema `input_schema` to OpenAI `tools` definitions, and strips Anthropic-specific caching tokens (`cache_control`) that would cause OpenAI 400 errors.
3. **Multi-turn History**:
   - Converts Anthropic `tool_result` blocks in user turns into discrete `{ role: "tool", tool_call_id: "..." }` messages.
   - Maps assistant `tool_use` blocks into OpenAI `tool_calls`.
4. **Real-time SSE Streaming**: Translates OpenAI chunk streams on-the-fly into Anthropic `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, and `message_stop`.
5. **Reasoning Models**: Automatically uses `max_completion_tokens` and omits `temperature` for `o1`, `o3-mini`, and reasoning models like `deepseek-v4-flash`.

---

## 🧪 Testing

Run unit and live translation tests:

```bash
node test.js            # Unit tests for message and tool schemas
node test-live.js       # Live streaming SSE verification
node test-tools-live.js # Live tool-calling round-trip verification
```

---

## 📄 License

MIT
