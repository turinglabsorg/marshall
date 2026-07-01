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

require_env MARSHALL_GCLOUD_BIN
require_env MARSHALL_GCP_PROJECT
require_env MARSHALL_GCP_INSTANCE
require_env MARSHALL_GCP_ZONE
require_env MARSHALL_CHAT_TUNNEL_REMOTE_HOST
require_env MARSHALL_CHAT_TUNNEL_REMOTE_PORT
require_env MARSHALL_CHAT_TUNNEL_LOCAL_HOST
require_env MARSHALL_CHAT_TUNNEL_LOCAL_PORT

if [ ! -x "$MARSHALL_GCLOUD_BIN" ]; then
  echo "MARSHALL_GCLOUD_BIN is not executable: $MARSHALL_GCLOUD_BIN" >&2
  exit 1
fi

if [ -n "${MARSHALL_CLOUDSDK_PYTHON:-}" ]; then
  if [ ! -x "$MARSHALL_CLOUDSDK_PYTHON" ]; then
    echo "MARSHALL_CLOUDSDK_PYTHON is not executable: $MARSHALL_CLOUDSDK_PYTHON" >&2
    exit 1
  fi
  export CLOUDSDK_PYTHON="$MARSHALL_CLOUDSDK_PYTHON"
fi

exec "$MARSHALL_GCLOUD_BIN" compute ssh "$MARSHALL_GCP_INSTANCE" \
  --zone "$MARSHALL_GCP_ZONE" \
  --project "$MARSHALL_GCP_PROJECT" \
  -- \
  -N \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -R "${MARSHALL_CHAT_TUNNEL_REMOTE_HOST}:${MARSHALL_CHAT_TUNNEL_REMOTE_PORT}:${MARSHALL_CHAT_TUNNEL_LOCAL_HOST}:${MARSHALL_CHAT_TUNNEL_LOCAL_PORT}"
