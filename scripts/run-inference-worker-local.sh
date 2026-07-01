#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${MARSHALL_INFERENCE_ENV:-$ROOT_DIR/.marshall/secrets/inference-worker.env}"

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
require_env MARSHALL_INFERENCE_KEY
require_env MARSHALL_INFERENCE_LISTEN
require_env MARSHALL_INFERENCE_WORKER_ID
require_env MARSHALL_PYTHON

if [ -z "${MARSHALL_MODEL_PACKAGE:-}" ]; then
  require_env MARSHALL_MODEL
  require_env MARSHALL_ADAPTER_ID
  require_env MARSHALL_ADAPTER_HASH
fi

if [ ! -x "$MARSHALL_NODE_BIN" ]; then
  echo "MARSHALL_NODE_BIN is not executable: $MARSHALL_NODE_BIN" >&2
  exit 1
fi

NODE_MAJOR="$("$MARSHALL_NODE_BIN" -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Marshall inference requires Node.js 22+, got $("$MARSHALL_NODE_BIN" -v)" >&2
  exit 1
fi

if [ ! -x "$MARSHALL_PYTHON" ]; then
  echo "MARSHALL_PYTHON is not executable: $MARSHALL_PYTHON" >&2
  exit 1
fi

if [ ! -f "$ROOT_DIR/dist/src/inference-worker-cli.js" ]; then
  echo "Missing compiled inference worker. Run: npm run build" >&2
  exit 1
fi

KEY_DIR="$(dirname "$MARSHALL_INFERENCE_KEY")"
if [ "${KEY_DIR#/}" = "$KEY_DIR" ]; then
  KEY_DIR="$ROOT_DIR/$KEY_DIR"
fi
mkdir -p "$ROOT_DIR/.marshall/logs" "$KEY_DIR"

ARGS=(
  "$ROOT_DIR/dist/src/inference-worker-cli.js"
  --key "$MARSHALL_INFERENCE_KEY"
  --listen "$MARSHALL_INFERENCE_LISTEN"
  --worker-id "$MARSHALL_INFERENCE_WORKER_ID"
  --python "$MARSHALL_PYTHON"
)

if [ -n "${MARSHALL_MODEL_PACKAGE:-}" ]; then
  ARGS+=(--model-package "$MARSHALL_MODEL_PACKAGE")
else
  ARGS+=(--model "$MARSHALL_MODEL")
  ARGS+=(--adapter-id "$MARSHALL_ADAPTER_ID")
  ARGS+=(--adapter-hash "$MARSHALL_ADAPTER_HASH")
  if [ -n "${MARSHALL_ADAPTER_PATH:-}" ]; then
    ARGS+=(--adapter-path "$MARSHALL_ADAPTER_PATH")
  fi
fi
if [ -n "${MARSHALL_CHAT_RUNNER:-}" ]; then
  ARGS+=(--runner "$MARSHALL_CHAT_RUNNER")
fi
if [ -n "${MARSHALL_CHAT_PUBLIC_DIR:-}" ]; then
  ARGS+=(--public-dir "$MARSHALL_CHAT_PUBLIC_DIR")
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
