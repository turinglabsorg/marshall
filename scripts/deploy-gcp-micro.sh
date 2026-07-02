#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${MARSHALL_GCP_PROJECT:-iconic-elevator-394020}"
INSTANCE="${MARSHALL_GCP_INSTANCE:-marshall-micro-1}"
MACHINE_TYPE="${MARSHALL_GCP_MACHINE_TYPE:-e2-small}"
FIREWALL_RULE="${MARSHALL_GCP_FIREWALL_RULE:-marshall-allow-http}"
NETWORK_TAG="${MARSHALL_GCP_NETWORK_TAG:-marshall-coordinator}"
ADDRESS_NAME="${MARSHALL_GCP_ADDRESS_NAME:-marshall-training-ip}"
DEPLOY_DIR="$ROOT_DIR/.marshall/deploy/gcp-micro"
APP_DEPLOY_DIR="$DEPLOY_DIR/app"
SECRETS_DIR="$ROOT_DIR/.marshall/secrets"
BINARY_PATH="$DEPLOY_DIR/marshall-coordinator"
TOKEN_PATH="$SECRETS_DIR/coordinator-token"
ENV_PATH="$SECRETS_DIR/coordinator.env"

mkdir -p "$DEPLOY_DIR" "$SECRETS_DIR"

gcloud config set project "$PROJECT" >/dev/null

ZONE="${MARSHALL_GCP_ZONE:-}"
EXISTING_ZONE="$(gcloud compute instances list --project "$PROJECT" --filter "name=($INSTANCE)" --format "value(zone.basename())" | head -n 1)"

if [ -n "$EXISTING_ZONE" ]; then
  ZONE="$EXISTING_ZONE"
else
  if [ -n "$ZONE" ]; then
    CANDIDATE_ZONES="$ZONE"
  else
    CANDIDATE_ZONES="${MARSHALL_GCP_ZONES:-us-central1-a us-central1-b us-central1-c us-central1-f us-east1-b us-east1-c us-east1-d}"
  fi

  for candidate_zone in $CANDIDATE_ZONES; do
    if gcloud compute instances create "$INSTANCE" \
      --project "$PROJECT" \
      --zone "$candidate_zone" \
      --machine-type "$MACHINE_TYPE" \
      --image-family debian-12 \
      --image-project debian-cloud \
      --boot-disk-size 10GB \
      --boot-disk-type pd-balanced \
      --tags "$NETWORK_TAG"; then
      ZONE="$candidate_zone"
      break
    fi
  done

  if [ -z "$ZONE" ]; then
    echo "Could not create $INSTANCE in any candidate zone." >&2
    exit 1
  fi
fi

if ! gcloud compute firewall-rules describe "$FIREWALL_RULE" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud compute firewall-rules create "$FIREWALL_RULE" \
    --project "$PROJECT" \
    --allow tcp:80,tcp:443,tcp:4001,tcp:4002 \
    --target-tags "$NETWORK_TAG" \
    --description "Allow public HTTP, HTTPS, and libp2p control traffic for Marshall"
else
  gcloud compute firewall-rules update "$FIREWALL_RULE" \
    --project "$PROJECT" \
    --allow tcp:80,tcp:443,tcp:4001,tcp:4002 \
    --target-tags "$NETWORK_TAG"
fi

REGION="${ZONE%-*}"
CURRENT_IP="$(gcloud compute instances describe "$INSTANCE" --zone "$ZONE" --project "$PROJECT" --format='get(networkInterfaces[0].accessConfigs[0].natIP)')"

if ! gcloud compute addresses describe "$ADDRESS_NAME" --region "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud compute addresses create "$ADDRESS_NAME" --region "$REGION" --project "$PROJECT" --addresses "$CURRENT_IP"
fi

STATIC_IP="$(gcloud compute addresses describe "$ADDRESS_NAME" --region "$REGION" --project "$PROJECT" --format='get(address)')"

if [ "$CURRENT_IP" != "$STATIC_IP" ]; then
  ACCESS_CONFIG_NAME="$(gcloud compute instances describe "$INSTANCE" --zone "$ZONE" --project "$PROJECT" --format='get(networkInterfaces[0].accessConfigs[0].name)')"
  gcloud compute instances delete-access-config "$INSTANCE" \
    --zone "$ZONE" \
    --project "$PROJECT" \
    --access-config-name "$ACCESS_CONFIG_NAME"
  gcloud compute instances add-access-config "$INSTANCE" \
    --zone "$ZONE" \
    --project "$PROJECT" \
    --access-config-name "$ACCESS_CONFIG_NAME" \
    --address "$STATIC_IP"
fi

for attempt in {1..30}; do
  if gcloud compute ssh "$INSTANCE" --zone "$ZONE" --project "$PROJECT" --command "true" >/dev/null 2>&1; then
    break
  fi

  if [ "$attempt" -eq 30 ]; then
    echo "SSH did not become ready for $INSTANCE in $ZONE." >&2
    exit 1
  fi

  sleep 5
done

(
  cd "$ROOT_DIR"
  npm run build
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o "$BINARY_PATH" ./cmd/marshall-coordinator
  rm -rf "$APP_DEPLOY_DIR"
  mkdir -p "$APP_DEPLOY_DIR"
  cp package.json package-lock.json "$APP_DEPLOY_DIR/"
  cp -R dist "$APP_DEPLOY_DIR/dist"
)

if [ ! -f "$TOKEN_PATH" ]; then
  umask 077
  openssl rand -hex 32 > "$TOKEN_PATH"
fi

umask 077
{
  printf "MARSHALL_REDIS_ADDR=127.0.0.1:6379\n"
  printf "MARSHALL_HTTP_ADDR=127.0.0.1:8080\n"
  printf "MARSHALL_REDIS_PREFIX=marshall\n"
  printf "MARSHALL_COORDINATOR_TOKEN=%s\n" "$(cat "$TOKEN_PATH")"
} > "$ENV_PATH"

gcloud compute ssh "$INSTANCE" --zone "$ZONE" --project "$PROJECT" --command "rm -rf /tmp/marshall-deploy && mkdir -p /tmp/marshall-deploy"
gcloud compute scp \
  "$BINARY_PATH" \
  "$ENV_PATH" \
  "$ROOT_DIR/deploy/gcp-micro/Caddyfile" \
  "$ROOT_DIR/deploy/gcp-micro/bootstrap-vm.sh" \
  "$ROOT_DIR/deploy/gcp-micro/marshall-redis.service" \
  "$ROOT_DIR/deploy/gcp-micro/marshall-coordinator.service" \
  "$ROOT_DIR/deploy/gcp-micro/marshall-caddy.service" \
  "$ROOT_DIR/deploy/gcp-micro/marshall-control.service" \
  "$ROOT_DIR/deploy/gcp-micro/marshall-control-mirror.service" \
  "$ROOT_DIR/deploy/gcp-micro/marshall-round-daemon.service" \
  "$INSTANCE:/tmp/marshall-deploy/" \
  --zone "$ZONE" \
  --project "$PROJECT"
if [ -f "$SECRETS_DIR/round-daemon.env" ]; then
  gcloud compute scp \
    "$SECRETS_DIR/round-daemon.env" \
    "$INSTANCE:/tmp/marshall-deploy/round-daemon.env" \
    --zone "$ZONE" \
    --project "$PROJECT"
fi
gcloud compute scp \
  --recurse \
  "$APP_DEPLOY_DIR" \
  "$INSTANCE:/tmp/marshall-deploy/app" \
  --zone "$ZONE" \
  --project "$PROJECT"
gcloud compute ssh "$INSTANCE" --zone "$ZONE" --project "$PROJECT" --command "sudo bash /tmp/marshall-deploy/bootstrap-vm.sh"

printf "Marshall coordinator URL: https://marshall.training/\n"
printf "Marshall fallback URL: http://%s/\n" "$STATIC_IP"
printf "Coordinator token file: %s\n" "$TOKEN_PATH"
