#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  exec sudo "$0" "$@"
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl docker.io libcap2-bin

systemctl enable --now docker

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
install -m 0644 /tmp/marshall-deploy/marshall-caddy.service /etc/systemd/system/marshall-caddy.service
install -m 0644 /tmp/marshall-deploy/marshall-control.service /etc/systemd/system/marshall-control.service

systemctl daemon-reload
systemctl enable --now marshall-redis.service
systemctl restart marshall-coordinator.service
systemctl enable marshall-coordinator.service
systemctl restart marshall-caddy.service
systemctl enable marshall-caddy.service
systemctl restart marshall-control.service
systemctl enable marshall-control.service

curl -fsS http://127.0.0.1:8080/dashboard >/dev/null
systemctl --no-pager --full status marshall-coordinator.service
systemctl --no-pager --full status marshall-caddy.service
systemctl --no-pager --full status marshall-control.service
