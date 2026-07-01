#!/usr/bin/env bash
set -euo pipefail

BASE_URL=""
EXPECTED_IP=""
TIMEOUT="30"
MESSAGE="Answer in one short sentence: is Marshall chat serving this response through the public HTTPS path?"

usage() {
  cat >&2 <<USAGE
Usage:
  scripts/check-chat-public.sh --url <https-url> --expected-ip <ipv4> [--timeout <seconds>] [--message <prompt>]

Examples:
  scripts/check-chat-public.sh --url https://marshall.training/chat/ --expected-ip 34.148.63.131
  scripts/check-chat-public.sh --url https://marshall.chat --expected-ip 34.148.63.131
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --url)
      BASE_URL="${2:-}"
      shift 2
      ;;
    --expected-ip)
      EXPECTED_IP="${2:-}"
      shift 2
      ;;
    --timeout)
      TIMEOUT="${2:-}"
      shift 2
      ;;
    --message)
      MESSAGE="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [ -z "$BASE_URL" ]; then
  echo "Missing required argument: --url" >&2
  usage
  exit 1
fi

if [ -z "$EXPECTED_IP" ]; then
  echo "Missing required argument: --expected-ip" >&2
  usage
  exit 1
fi

HOST="$(node -e 'console.log(new URL(process.argv[1]).hostname)' "$BASE_URL")"
SCHEME="$(node -e 'console.log(new URL(process.argv[1]).protocol.replace(":", ""))' "$BASE_URL")"
BASE_URL="${BASE_URL%/}"
HEALTH_FILE="$(mktemp)"
STREAM_FILE="$(mktemp)"
REQUEST_FILE="$(mktemp)"
trap 'rm -f "$HEALTH_FILE" "$STREAM_FILE" "$REQUEST_FILE"' EXIT

DNS_IPS="$(dig +short A "$HOST" | sed -n '/^[0-9.][0-9.]*$/p')"
if ! printf "%s\n" "$DNS_IPS" | grep -Fx "$EXPECTED_IP" >/dev/null; then
  echo "DNS check failed for $HOST: expected $EXPECTED_IP, got ${DNS_IPS:-<none>}" >&2
  exit 1
fi
echo "dns ok: $HOST -> $EXPECTED_IP"

CURL_RESOLVE=()
case "$SCHEME" in
  http)
    CURL_RESOLVE=(--resolve "$HOST:80:$EXPECTED_IP")
    ;;
  https)
    CURL_RESOLVE=(--resolve "$HOST:443:$EXPECTED_IP")
    ;;
  *)
    echo "Unsupported URL scheme: $SCHEME" >&2
    exit 1
    ;;
esac

curl -fsS --max-time "$TIMEOUT" "${CURL_RESOLVE[@]}" "$BASE_URL/api/health" -o "$HEALTH_FILE"
node - "$HEALTH_FILE" <<'NODE'
const { readFileSync } = require("node:fs");
const file = process.argv[2];
const health = JSON.parse(readFileSync(file, "utf8"));
if (health.type !== "marshall_chat_health") {
  throw new Error(`unexpected health type: ${health.type}`);
}
if (health.ready !== true) {
  throw new Error("chat health is not ready");
}
if (health.runtime !== "p2p_worker") {
  throw new Error(`unexpected runtime: ${health.runtime}`);
}
const readyWorkers = Number(health.inference?.ready_workers ?? 0);
if (!Number.isFinite(readyWorkers) || readyWorkers < 1) {
  throw new Error("no ready inference workers");
}
console.log(`health ok: ${readyWorkers}/${health.inference.configured_workers} workers ready`);
NODE

CONVERSATION_ID="public-check-$(date -u +%Y%m%d%H%M%S)-$$"
node - "$MESSAGE" "$CONVERSATION_ID" > "$REQUEST_FILE" <<'NODE'
const [message, conversationId] = process.argv.slice(2);
process.stdout.write(JSON.stringify({
  conversation_id: conversationId,
  prompt: message,
  max_tokens: 32,
  temperature: 0.1,
}));
NODE

curl -fsS -N --max-time "$TIMEOUT" \
  "${CURL_RESOLVE[@]}" \
  -X POST "$BASE_URL/api/chat/stream" \
  -H "content-type: application/json" \
  --data-binary "@$REQUEST_FILE" \
  -o "$STREAM_FILE"

node - "$STREAM_FILE" <<'NODE'
const { readFileSync } = require("node:fs");
const file = process.argv[2];
const raw = readFileSync(file, "utf8");
const events = raw.trim().split(/\n\n+/).filter(Boolean).map((block) => {
  const lines = block.split(/\n/);
  const event = lines.find((line) => line.startsWith("event:"))?.slice("event:".length).trim() ?? "message";
  const dataText = lines.find((line) => line.startsWith("data:"))?.slice("data:".length).trim() ?? "{}";
  return { event, data: JSON.parse(dataText) };
});

if (!events.some((entry) => entry.event === "started")) {
  throw new Error("stream did not start");
}
for (const entry of events.filter((item) => item.event === "completed")) {
  if (Object.prototype.hasOwnProperty.call(entry.data, "prompt")) {
    throw new Error("completed stream event leaked the gateway-composed prompt");
  }
}
const done = events.find((entry) => entry.event === "done")?.data;
if (done == null) {
  throw new Error("stream did not emit done");
}
if (done.type !== "marshall_chat_response") {
  throw new Error(`unexpected done type: ${done.type}`);
}
if (typeof done.worker_id !== "string" || done.worker_id === "") {
  throw new Error("done event is missing worker_id");
}
if (typeof done.text !== "string" || done.text.trim() === "") {
  throw new Error("done event is missing generated text");
}
console.log(`stream ok: ${done.worker_id} ${done.elapsed_ms}ms`);
NODE

echo "public chat ok: $BASE_URL"
