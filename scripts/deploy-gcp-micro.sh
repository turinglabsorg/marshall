#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${MARSHALL_GCP_PROJECT:-iconic-elevator-394020}"
PRIMARY_INSTANCE="${MARSHALL_GCP_INSTANCE:-marshall-micro-1}"
REPLICA_INSTANCE="${MARSHALL_GCP_REPLICA_INSTANCE:-marshall-micro-2}"
MACHINE_TYPE="${MARSHALL_GCP_MACHINE_TYPE:-e2-small}"
FIREWALL_RULE="${MARSHALL_GCP_FIREWALL_RULE:-marshall-allow-http}"
INTERNAL_FIREWALL_RULE="${MARSHALL_GCP_INTERNAL_FIREWALL_RULE:-marshall-allow-internal-coordinator}"
NETWORK_TAG="${MARSHALL_GCP_NETWORK_TAG:-marshall-coordinator}"
PRIMARY_ADDRESS_NAME="${MARSHALL_GCP_ADDRESS_NAME:-marshall-training-ip}"
REPLICA_ADDRESS_NAME="${MARSHALL_GCP_REPLICA_ADDRESS_NAME:-marshall-training-replica-ip}"
DEPLOY_DIR="$ROOT_DIR/.marshall/deploy/gcp-micro"
APP_DEPLOY_DIR="$DEPLOY_DIR/app"
SECRETS_DIR="$ROOT_DIR/.marshall/secrets"
BINARY_PATH="$DEPLOY_DIR/marshall-coordinator"
TOKEN_PATH="$SECRETS_DIR/coordinator-token"
ENV_PATH="$SECRETS_DIR/coordinator.env"
PRIMARY_ENV_PATH="$DEPLOY_DIR/node-primary.env"
REPLICA_ENV_PATH="$DEPLOY_DIR/node-replica.env"
REPLICA_CONTROL_INFO="$DEPLOY_DIR/control-replica.json"

mkdir -p "$DEPLOY_DIR" "$SECRETS_DIR"

gcloud config set project "$PROJECT" >/dev/null

ensure_instance() {
  local instance="$1"
  local requested_zone="$2"
  local address_name="$3"
  local zone=""
  local existing_zone=""

  existing_zone="$(gcloud compute instances list --project "$PROJECT" --filter "name=($instance)" --format "value(zone.basename())" | head -n 1)"
  if [ -n "$existing_zone" ]; then
    zone="$existing_zone"
  else
    local candidate_zones=""
    if [ -n "$requested_zone" ]; then
      candidate_zones="$requested_zone"
    else
      candidate_zones="${MARSHALL_GCP_ZONES:-us-east1-b us-east1-c us-east1-d us-central1-a us-central1-b us-central1-c us-central1-f}"
    fi

    for candidate_zone in $candidate_zones; do
      if gcloud compute instances create "$instance" \
        --project "$PROJECT" \
        --zone "$candidate_zone" \
        --machine-type "$MACHINE_TYPE" \
        --image-family debian-12 \
        --image-project debian-cloud \
        --boot-disk-size 10GB \
        --boot-disk-type pd-balanced \
        --tags "$NETWORK_TAG" >/dev/null; then
        zone="$candidate_zone"
        break
      fi
    done

    if [ -z "$zone" ]; then
      echo "Could not create $instance in any candidate zone." >&2
      exit 1
    fi
  fi

  local region="${zone%-*}"
  local current_ip=""
  current_ip="$(gcloud compute instances describe "$instance" --zone "$zone" --project "$PROJECT" --format='get(networkInterfaces[0].accessConfigs[0].natIP)')"

  if ! gcloud compute addresses describe "$address_name" --region "$region" --project "$PROJECT" >/dev/null 2>&1; then
    gcloud compute addresses create "$address_name" --region "$region" --project "$PROJECT" --addresses "$current_ip" >/dev/null
  fi

  local static_ip=""
  static_ip="$(gcloud compute addresses describe "$address_name" --region "$region" --project "$PROJECT" --format='get(address)')"

  if [ "$current_ip" != "$static_ip" ]; then
    local access_config_name=""
    access_config_name="$(gcloud compute instances describe "$instance" --zone "$zone" --project "$PROJECT" --format='get(networkInterfaces[0].accessConfigs[0].name)')"
    gcloud compute instances delete-access-config "$instance" \
      --zone "$zone" \
      --project "$PROJECT" \
      --access-config-name "$access_config_name" >/dev/null
    gcloud compute instances add-access-config "$instance" \
      --zone "$zone" \
      --project "$PROJECT" \
      --access-config-name "$access_config_name" \
      --address "$static_ip" >/dev/null
  fi

  for attempt in {1..30}; do
    if gcloud compute ssh "$instance" --zone "$zone" --project "$PROJECT" --command "true" >/dev/null 2>&1; then
      break
    fi

    if [ "$attempt" -eq 30 ]; then
      echo "SSH did not become ready for $instance in $zone." >&2
      exit 1
    fi

    sleep 5
  done

  local internal_ip=""
  internal_ip="$(gcloud compute instances describe "$instance" --zone "$zone" --project "$PROJECT" --format='get(networkInterfaces[0].networkIP)')"
  printf "%s\t%s\t%s\t%s\n" "$zone" "$region" "$static_ip" "$internal_ip"
}

configure_firewall() {
  if ! gcloud compute firewall-rules describe "$FIREWALL_RULE" --project "$PROJECT" >/dev/null 2>&1; then
    gcloud compute firewall-rules create "$FIREWALL_RULE" \
      --project "$PROJECT" \
      --allow tcp:80,tcp:443,tcp:4001,tcp:4002 \
      --target-tags "$NETWORK_TAG" \
      --description "Allow public HTTP, HTTPS, and libp2p control traffic for Marshall" >/dev/null
  else
    gcloud compute firewall-rules update "$FIREWALL_RULE" \
      --project "$PROJECT" \
      --allow tcp:80,tcp:443,tcp:4001,tcp:4002 \
      --target-tags "$NETWORK_TAG" >/dev/null
  fi

  if ! gcloud compute firewall-rules describe "$INTERNAL_FIREWALL_RULE" --project "$PROJECT" >/dev/null 2>&1; then
    gcloud compute firewall-rules create "$INTERNAL_FIREWALL_RULE" \
      --project "$PROJECT" \
      --allow tcp:8080 \
      --source-tags "$NETWORK_TAG" \
      --target-tags "$NETWORK_TAG" \
      --description "Allow Marshall coordinator federation only between coordinator nodes" >/dev/null
  else
    gcloud compute firewall-rules update "$INTERNAL_FIREWALL_RULE" \
      --project "$PROJECT" \
      --allow tcp:8080 \
      --source-tags "$NETWORK_TAG" \
      --target-tags "$NETWORK_TAG" >/dev/null
  fi
}

write_shared_env() {
  if [ ! -f "$TOKEN_PATH" ]; then
    umask 077
    openssl rand -hex 32 > "$TOKEN_PATH"
  fi

  umask 077
  {
    printf "MARSHALL_REDIS_ADDR=127.0.0.1:6379\n"
    printf "MARSHALL_HTTP_ADDR=0.0.0.0:8080\n"
    printf "MARSHALL_REDIS_PREFIX=marshall\n"
    printf "MARSHALL_COORDINATOR_TOKEN=%s\n" "$(cat "$TOKEN_PATH")"
  } > "$ENV_PATH"
}

write_node_env() {
  local output="$1"
  local role="$2"
  local coordinator_id="$3"
  local peer_id="$4"
  local peer_url="$5"
  local control_role="$6"
  local control_port="$7"
  local public_control_addr="$8"

  umask 077
  {
    printf "MARSHALL_NODE_ROLE=%s\n" "$role"
    printf "MARSHALL_COORDINATOR_ID=%s\n" "$coordinator_id"
    printf "MARSHALL_COORDINATOR_PEERS=%s=%s\n" "$peer_id" "$peer_url"
    printf "MARSHALL_CONTROL_ROLE=%s\n" "$control_role"
    printf "MARSHALL_CONTROL_LISTEN=/ip4/0.0.0.0/tcp/%s\n" "$control_port"
    printf "MARSHALL_PUBLIC_CONTROL_ADDR=%s\n" "$public_control_addr"
    printf "MARSHALL_CONTROL_NETWORK_PATH=/var/lib/marshall/public/control-network.json\n"
  } > "$output"
}

build_artifacts() {
  (
    cd "$ROOT_DIR"
    npm run build
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o "$BINARY_PATH" ./cmd/marshall-coordinator
    rm -rf "$APP_DEPLOY_DIR"
    mkdir -p "$APP_DEPLOY_DIR"
    cp package.json package-lock.json "$APP_DEPLOY_DIR/"
    cp -R dist "$APP_DEPLOY_DIR/dist"
  )
}

deploy_node() {
  local instance="$1"
  local zone="$2"
  local node_env="$3"
  local include_round_daemon="$4"
  local control_replica_info="$5"

  gcloud compute ssh "$instance" --zone "$zone" --project "$PROJECT" --command "rm -rf /tmp/marshall-deploy && mkdir -p /tmp/marshall-deploy"
  gcloud compute scp \
    "$BINARY_PATH" \
    "$ENV_PATH" \
    "$node_env" \
    "$ROOT_DIR/deploy/gcp-micro/Caddyfile" \
    "$ROOT_DIR/deploy/gcp-micro/bootstrap-vm.sh" \
    "$ROOT_DIR/deploy/gcp-micro/marshall-redis.service" \
    "$ROOT_DIR/deploy/gcp-micro/marshall-coordinator.service" \
    "$ROOT_DIR/deploy/gcp-micro/marshall-caddy.service" \
    "$ROOT_DIR/deploy/gcp-micro/marshall-control.service" \
    "$ROOT_DIR/deploy/gcp-micro/marshall-round-daemon.service" \
    "$instance:/tmp/marshall-deploy/" \
    --zone "$zone" \
    --project "$PROJECT"
  gcloud compute ssh "$instance" --zone "$zone" --project "$PROJECT" --command "mv /tmp/marshall-deploy/$(basename "$node_env") /tmp/marshall-deploy/node.env"
  if [ "$include_round_daemon" = "true" ] && [ -f "$SECRETS_DIR/round-daemon.env" ]; then
    gcloud compute scp \
      "$SECRETS_DIR/round-daemon.env" \
      "$instance:/tmp/marshall-deploy/round-daemon.env" \
      --zone "$zone" \
      --project "$PROJECT"
  fi
  if [ -n "$control_replica_info" ] && [ -f "$control_replica_info" ]; then
    gcloud compute scp \
      "$control_replica_info" \
      "$instance:/tmp/marshall-deploy/control-replica.json" \
      --zone "$zone" \
      --project "$PROJECT"
  fi
  gcloud compute scp \
    --recurse \
    "$APP_DEPLOY_DIR" \
    "$instance:/tmp/marshall-deploy/app" \
    --zone "$zone" \
    --project "$PROJECT"
  gcloud compute ssh "$instance" --zone "$zone" --project "$PROJECT" --command "sudo bash /tmp/marshall-deploy/bootstrap-vm.sh"
}

PRIMARY_REQUESTED_ZONE="${MARSHALL_GCP_ZONE:-}"
PRIMARY_INFO="$(ensure_instance "$PRIMARY_INSTANCE" "$PRIMARY_REQUESTED_ZONE" "$PRIMARY_ADDRESS_NAME")"
PRIMARY_ZONE="$(printf "%s" "$PRIMARY_INFO" | cut -f1)"
PRIMARY_REGION="$(printf "%s" "$PRIMARY_INFO" | cut -f2)"
PRIMARY_IP="$(printf "%s" "$PRIMARY_INFO" | cut -f3)"
PRIMARY_INTERNAL_IP="$(printf "%s" "$PRIMARY_INFO" | cut -f4)"

REPLICA_REQUESTED_ZONE="${MARSHALL_GCP_REPLICA_ZONE:-$PRIMARY_ZONE}"
REPLICA_INFO="$(ensure_instance "$REPLICA_INSTANCE" "$REPLICA_REQUESTED_ZONE" "$REPLICA_ADDRESS_NAME")"
REPLICA_ZONE="$(printf "%s" "$REPLICA_INFO" | cut -f1)"
REPLICA_REGION="$(printf "%s" "$REPLICA_INFO" | cut -f2)"
REPLICA_IP="$(printf "%s" "$REPLICA_INFO" | cut -f3)"
REPLICA_INTERNAL_IP="$(printf "%s" "$REPLICA_INFO" | cut -f4)"

configure_firewall
build_artifacts
write_shared_env
write_node_env \
  "$REPLICA_ENV_PATH" \
  "replica" \
  "public-replica-1" \
  "public-primary" \
  "http://$PRIMARY_INTERNAL_IP:8080" \
  "mirror" \
  "4002" \
  "/ip4/$REPLICA_IP/tcp/4002/p2p/<peer-id>"

deploy_node "$REPLICA_INSTANCE" "$REPLICA_ZONE" "$REPLICA_ENV_PATH" "false" ""
gcloud compute scp \
  "$REPLICA_INSTANCE:/var/lib/marshall/public/control.json" \
  "$REPLICA_CONTROL_INFO" \
  --zone "$REPLICA_ZONE" \
  --project "$PROJECT"

write_node_env \
  "$PRIMARY_ENV_PATH" \
  "primary" \
  "public-primary" \
  "public-replica-1" \
  "http://$REPLICA_INTERNAL_IP:8080" \
  "primary" \
  "4001" \
  "/dns4/marshall.training/tcp/4001/p2p/<peer-id>"

deploy_node "$PRIMARY_INSTANCE" "$PRIMARY_ZONE" "$PRIMARY_ENV_PATH" "true" "$REPLICA_CONTROL_INFO"

printf "Marshall coordinator URL: https://marshall.training/\n"
printf "Marshall primary: %s zone=%s region=%s internal=%s\n" "$PRIMARY_IP" "$PRIMARY_ZONE" "$PRIMARY_REGION" "$PRIMARY_INTERNAL_IP"
printf "Marshall replica: %s zone=%s region=%s internal=%s\n" "$REPLICA_IP" "$REPLICA_ZONE" "$REPLICA_REGION" "$REPLICA_INTERNAL_IP"
printf "Coordinator token file: %s\n" "$TOKEN_PATH"
