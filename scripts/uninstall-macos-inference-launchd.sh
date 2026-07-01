#!/usr/bin/env bash
set -euo pipefail

LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LABEL="${MARSHALL_INFERENCE_LAUNCHD_LABEL:-com.turinglabs.marshall.inference-worker}"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
rm -f "$LAUNCH_AGENTS_DIR/$LABEL.plist"
echo "$LABEL"
