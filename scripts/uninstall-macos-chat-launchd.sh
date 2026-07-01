#!/usr/bin/env bash
set -euo pipefail

LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
LABELS=(
  "com.turinglabs.marshall.chat-gateway"
  "com.turinglabs.marshall.chat-tunnel"
)

for label in "${LABELS[@]}"; do
  launchctl bootout "$DOMAIN/$label" >/dev/null 2>&1 || true
  rm -f "$LAUNCH_AGENTS_DIR/$label.plist"
  echo "$label"
done
