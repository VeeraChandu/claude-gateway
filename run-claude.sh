#!/usr/bin/env bash
# Start the gateway (if not already running) and launch Claude Code through it.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Read a key from .env without sourcing it (values may contain shell syntax).
env_value() {
  [[ -f "${DIR}/.env" ]] || return 0
  grep -E "^(export )?$1=" "${DIR}/.env" | tail -1 | cut -d= -f2- | sed -E "s/^['\"]//; s/['\"]$//"
}

HOST="${HOST:-$(env_value HOST)}"; HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-$(env_value PORT)}"; PORT="${PORT:-8080}"
# A client key from the admin UI; GATEWAY_API_KEY from .env also works (it seeds the first key).
GATEWAY_API_KEY="${CLAUDE_GATEWAY_KEY:-${GATEWAY_API_KEY:-$(env_value GATEWAY_API_KEY)}}"
[[ "$HOST" == "0.0.0.0" ]] && CONNECT_HOST=127.0.0.1 || CONNECT_HOST="$HOST"
URL="http://${CONNECT_HOST}:${PORT}"

if curl -fsS "${URL}/health" >/dev/null 2>&1; then
  echo "✅ Gateway already running at ${URL}"
else
  echo "🚀 Starting gateway at ${URL}..."
  LOG_FORMAT="${LOG_FORMAT:-pretty}" node "${DIR}/server.js" >>"${DIR}/gateway.log" 2>&1 &
  GATEWAY_PID=$!
  trap 'kill "$GATEWAY_PID" 2>/dev/null || true' EXIT

  for _ in {1..50}; do
    curl -fsS "${URL}/health" >/dev/null 2>&1 && break
    if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
      echo "❌ Gateway failed to start:" >&2
      tail -20 "${DIR}/gateway.log" >&2
      exit 1
    fi
    sleep 0.1
  done
fi

export ANTHROPIC_BASE_URL="$URL"
export ANTHROPIC_API_KEY="${GATEWAY_API_KEY:-local}"

echo "🤖 Launching Claude Code via ${URL} (logs: ${DIR}/gateway.log)"
claude "$@"
