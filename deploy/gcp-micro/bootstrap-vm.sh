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
install -d -m 0750 -o marshall -g marshall /etc/marshall
install -d -m 0750 -o marshall -g marshall /var/lib/marshall/redis
install -d -m 0750 -o marshall -g marshall /var/lib/marshall/artifacts

install -m 0755 /tmp/marshall-deploy/marshall-coordinator /opt/marshall/bin/marshall-coordinator
setcap cap_net_bind_service=+ep /opt/marshall/bin/marshall-coordinator

install -m 0640 -o root -g marshall /tmp/marshall-deploy/coordinator.env /etc/marshall/coordinator.env
install -m 0644 /tmp/marshall-deploy/marshall-redis.service /etc/systemd/system/marshall-redis.service
install -m 0644 /tmp/marshall-deploy/marshall-coordinator.service /etc/systemd/system/marshall-coordinator.service

systemctl daemon-reload
systemctl enable --now marshall-redis.service
systemctl restart marshall-coordinator.service
systemctl enable marshall-coordinator.service

curl -fsS http://127.0.0.1/dashboard >/dev/null
systemctl --no-pager --full status marshall-coordinator.service
