#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8080}"
HOST="${HOST:-127.0.0.1}"

# Check if gateway is already running
if curl -s "http://${HOST}:${PORT}/health" > /dev/null 2>&1; then
  echo "✅ Gateway already running on http://${HOST}:${PORT}"
else
  echo "🚀 Starting Claude-OpenAI Gateway on http://${HOST}:${PORT}..."
  node --env-file="${DIR}/.env" "${DIR}/server.js" &
  GATEWAY_PID=$!
  trap 'kill $GATEWAY_PID 2>/dev/null || true' EXIT

  # Wait for gateway to be ready
  for i in {1..20}; do
    if curl -s "http://${HOST}:${PORT}/health" > /dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done
fi

export ANTHROPIC_BASE_URL="http://${HOST}:${PORT}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-sk-local-gateway-key}"

echo "🤖 Launching Claude Code connected to OpenAI gateway..."
exec claude "$@"
