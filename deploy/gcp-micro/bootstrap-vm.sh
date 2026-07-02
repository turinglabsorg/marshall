#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  exec sudo "$0" "$@"
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl docker.io libcap2-bin

systemctl enable --now docker

if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
fi
if ! grep -q '^/swapfile ' /etc/fstab; then
  printf "/swapfile none swap sw 0 0\n" >>/etc/fstab
fi
swapon /swapfile 2>/dev/null || true

if ! id marshall >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/marshall --create-home --shell /usr/sbin/nologin marshall
fi

install -d -m 0755 /opt/marshall/bin
rm -rf /opt/marshall/app
install -d -m 0755 /opt/marshall/app
cp -a /tmp/marshall-deploy/app/. /opt/marshall/app/

install -d -m 0750 -o marshall -g marshall /etc/marshall
install -d -m 0750 -o marshall -g marshall /var/lib/marshall/redis
install -d -m 0750 -o marshall -g marshall /var/lib/marshall/artifacts
install -d -m 0750 -o marshall -g marshall /var/lib/marshall/control
install -d -m 0750 -o marshall -g marshall /var/lib/marshall/control-mirror
install -d -m 0750 -o marshall -g marshall /var/lib/marshall/jobs/current
install -d -m 0755 -o marshall -g marshall /var/lib/marshall/public
install -d -m 0755 -o marshall -g marshall /var/lib/marshall/datasets
install -d -m 0750 -o marshall -g marshall /var/lib/marshall/caddy/data
install -d -m 0750 -o marshall -g marshall /var/lib/marshall/caddy/config

if [ ! -f /var/lib/marshall/jobs/current/train-adapters.json ]; then
  printf "[]\n" >/var/lib/marshall/jobs/current/train-adapters.json
fi

docker run --rm -v /opt/marshall/app:/app -w /app node:22-bookworm-slim npm ci --omit=dev

install -m 0755 /tmp/marshall-deploy/marshall-coordinator /opt/marshall/bin/marshall-coordinator

install -m 0640 -o root -g marshall /tmp/marshall-deploy/coordinator.env /etc/marshall/coordinator.env
install -m 0644 /tmp/marshall-deploy/Caddyfile /etc/marshall/Caddyfile
install -m 0644 /tmp/marshall-deploy/marshall-redis.service /etc/systemd/system/marshall-redis.service
install -m 0644 /tmp/marshall-deploy/marshall-coordinator.service /etc/systemd/system/marshall-coordinator.service
install -m 0644 /tmp/marshall-deploy/marshall-coordinator-replica.service /etc/systemd/system/marshall-coordinator-replica.service
install -m 0644 /tmp/marshall-deploy/marshall-caddy.service /etc/systemd/system/marshall-caddy.service
install -m 0644 /tmp/marshall-deploy/marshall-control.service /etc/systemd/system/marshall-control.service
install -m 0644 /tmp/marshall-deploy/marshall-control-mirror.service /etc/systemd/system/marshall-control-mirror.service
install -m 0644 /tmp/marshall-deploy/marshall-round-daemon.service /etc/systemd/system/marshall-round-daemon.service
if [ -f /tmp/marshall-deploy/round-daemon.env ]; then
  install -m 0640 -o root -g marshall /tmp/marshall-deploy/round-daemon.env /etc/marshall/round-daemon.env
fi

systemctl daemon-reload
systemctl enable --now marshall-redis.service
systemctl restart marshall-coordinator.service
systemctl enable marshall-coordinator.service
systemctl restart marshall-coordinator-replica.service
systemctl enable marshall-coordinator-replica.service
systemctl restart marshall-caddy.service
systemctl enable marshall-caddy.service
systemctl restart marshall-control.service
systemctl enable marshall-control.service
systemctl restart marshall-control-mirror.service
systemctl enable marshall-control-mirror.service
for attempt in $(seq 1 30); do
  if [ -s /var/lib/marshall/public/control.json ] && [ -s /var/lib/marshall/public/control-mirror.json ]; then
    break
  fi
  sleep 1
done
docker run --rm -v /opt/marshall/app:/app:ro -v /var/lib/marshall:/var/lib/marshall -w /app node:22-bookworm-slim node dist/src/control-network-cli.js --control-info /var/lib/marshall/public/control.json --control-info /var/lib/marshall/public/control-mirror.json --output /var/lib/marshall/public/control-network.json
if [ -f /etc/marshall/round-daemon.env ]; then
  systemctl restart marshall-round-daemon.service
  systemctl enable marshall-round-daemon.service
else
  systemctl disable --now marshall-round-daemon.service 2>/dev/null || true
fi

curl -fsS http://127.0.0.1:8080/dashboard >/dev/null
curl -fsS http://127.0.0.1:8081/health >/dev/null
systemctl --no-pager --full status marshall-coordinator.service
systemctl --no-pager --full status marshall-coordinator-replica.service
systemctl --no-pager --full status marshall-caddy.service
systemctl --no-pager --full status marshall-control.service
systemctl --no-pager --full status marshall-control-mirror.service
if [ -f /etc/marshall/round-daemon.env ]; then
  systemctl --no-pager --full status marshall-round-daemon.service || true
fi
