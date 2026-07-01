#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${MARSHALL_CHAT_ENV:-$ROOT_DIR/.marshall/secrets/chat-gateway.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck source=/dev/null
. "$ENV_FILE"
set +a

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "Missing required env: $name" >&2
    exit 1
  fi
}

require_env MARSHALL_NODE_BIN
require_env MARSHALL_CHAT_HOST
require_env MARSHALL_CHAT_PORT
require_env MARSHALL_CHAT_RUNTIME
require_env MARSHALL_CHAT_P2P_KEY
require_env MARSHALL_CHAT_P2P_WORKER_ADDR
require_env MARSHALL_CHAT_CONVERSATION_DIR
require_env MARSHALL_MODEL
require_env MARSHALL_ADAPTER_ID
require_env MARSHALL_ADAPTER_HASH

if [ "$MARSHALL_CHAT_RUNTIME" != "p2p_worker" ]; then
  echo "MARSHALL_CHAT_RUNTIME must be p2p_worker for the public prototype" >&2
  exit 1
fi

if [ ! -x "$MARSHALL_NODE_BIN" ]; then
  echo "MARSHALL_NODE_BIN is not executable: $MARSHALL_NODE_BIN" >&2
  exit 1
fi

NODE_MAJOR="$("$MARSHALL_NODE_BIN" -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Marshall chat requires Node.js 22+, got $("$MARSHALL_NODE_BIN" -v)" >&2
  exit 1
fi

if [ ! -f "$ROOT_DIR/dist/src/chat-server-cli.js" ]; then
  echo "Missing compiled chat server. Run: npm run build" >&2
  exit 1
fi

mkdir -p "$ROOT_DIR/.marshall/logs" "$(dirname "$MARSHALL_CHAT_CONVERSATION_DIR")"

ARGS=(
  "$ROOT_DIR/dist/src/chat-server-cli.js"
  --host "$MARSHALL_CHAT_HOST"
  --port "$MARSHALL_CHAT_PORT"
  --runtime "$MARSHALL_CHAT_RUNTIME"
  --p2p-key "$MARSHALL_CHAT_P2P_KEY"
  --p2p-worker-addr "$MARSHALL_CHAT_P2P_WORKER_ADDR"
  --conversation-dir "$MARSHALL_CHAT_CONVERSATION_DIR"
  --model "$MARSHALL_MODEL"
  --adapter-id "$MARSHALL_ADAPTER_ID"
  --adapter-hash "$MARSHALL_ADAPTER_HASH"
)

if [ -n "${MARSHALL_CHAT_P2P_WORKER_ADDRS:-}" ]; then
  ARGS+=(--p2p-worker-addrs "$MARSHALL_CHAT_P2P_WORKER_ADDRS")
fi
if [ -n "${MARSHALL_CHAT_P2P_MAX_ATTEMPTS:-}" ]; then
  ARGS+=(--p2p-max-attempts "$MARSHALL_CHAT_P2P_MAX_ATTEMPTS")
fi
if [ -n "${MARSHALL_CHAT_MAX_CONTEXT_MESSAGES:-}" ]; then
  ARGS+=(--max-context-messages "$MARSHALL_CHAT_MAX_CONTEXT_MESSAGES")
fi
if [ -n "${MARSHALL_CHAT_MAX_MEMORY_ITEMS:-}" ]; then
  ARGS+=(--max-memory-items "$MARSHALL_CHAT_MAX_MEMORY_ITEMS")
fi
if [ -n "${MARSHALL_CHAT_CONVERSATION_TTL_DAYS:-}" ]; then
  ARGS+=(--conversation-ttl-days "$MARSHALL_CHAT_CONVERSATION_TTL_DAYS")
fi
if [ -n "${MARSHALL_CHAT_SYSTEM_PROMPT:-}" ]; then
  ARGS+=(--system-prompt "$MARSHALL_CHAT_SYSTEM_PROMPT")
fi
if [ -n "${MARSHALL_CHAT_MAX_TOKENS:-}" ]; then
  ARGS+=(--max-tokens "$MARSHALL_CHAT_MAX_TOKENS")
fi
if [ -n "${MARSHALL_CHAT_TEMPERATURE:-}" ]; then
  ARGS+=(--temperature "$MARSHALL_CHAT_TEMPERATURE")
fi

cd "$ROOT_DIR"
exec "$MARSHALL_NODE_BIN" "${ARGS[@]}"
