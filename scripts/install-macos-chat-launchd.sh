#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${MARSHALL_CHAT_ENV:-$ROOT_DIR/.marshall/secrets/chat-gateway.env}"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$ROOT_DIR/.marshall/logs"
GATEWAY_LABEL="com.turinglabs.marshall.chat-gateway"
TUNNEL_LABEL="com.turinglabs.marshall.chat-tunnel"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

mkdir -p "$LAUNCH_AGENTS_DIR" "$LOG_DIR"

write_plist() {
  local label="$1"
  local script="$2"
  local plist="$LAUNCH_AGENTS_DIR/$label.plist"
  local stdout_path="$LOG_DIR/$label.out.log"
  local stderr_path="$LOG_DIR/$label.err.log"

  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$script</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MARSHALL_CHAT_ENV</key>
    <string>$ENV_FILE</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$stdout_path</string>
  <key>StandardErrorPath</key>
  <string>$stderr_path</string>
</dict>
</plist>
PLIST
}

bootstrap_label() {
  local label="$1"
  local plist="$LAUNCH_AGENTS_DIR/$label.plist"
  local domain="gui/$(id -u)"

  launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
  launchctl bootstrap "$domain" "$plist"
  launchctl enable "$domain/$label"
  launchctl kickstart -k "$domain/$label"
}

write_plist "$GATEWAY_LABEL" "$ROOT_DIR/scripts/run-chat-gateway-local.sh"
write_plist "$TUNNEL_LABEL" "$ROOT_DIR/scripts/run-chat-tunnel-gcp.sh"

bootstrap_label "$GATEWAY_LABEL"
bootstrap_label "$TUNNEL_LABEL"

echo "$GATEWAY_LABEL"
echo "$TUNNEL_LABEL"
