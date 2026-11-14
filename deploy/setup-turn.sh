#!/usr/bin/env bash
set -euo pipefail

public_ip="${1:?Informe o IP publico da VPS}"
app_env="${2:-/opt/kafcord/shared/.env}"
turn_config="/etc/turnserver.conf"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y coturn

existing_secret="$(sed -n 's/^TURN_SHARED_SECRET=//p' "$app_env" 2>/dev/null | tail -n 1)"
turn_secret="${existing_secret:-$(openssl rand -hex 32)}"

config_tmp="$(mktemp)"
env_tmp="$(mktemp)"
cleanup() {
  rm -f "$config_tmp" "$env_tmp"
}
trap cleanup EXIT

cat > "$config_tmp" <<EOF
listening-port=3478
listening-ip=0.0.0.0
relay-ip=${public_ip}
external-ip=${public_ip}
realm=kafcord.kafly.com.br
server-name=kafcord.kafly.com.br
fingerprint
use-auth-secret
static-auth-secret=${turn_secret}
min-port=49160
max-port=49200
stale-nonce=600
no-cli
no-multicast-peers
no-loopback-peers
EOF
install -o root -g turnserver -m 640 "$config_tmp" "$turn_config"

if [[ -f "$app_env" ]]; then
  grep -Ev '^(RTC_STUN_URLS|TURN_URLS|TURN_SHARED_SECRET|TURN_REALM)=' "$app_env" > "$env_tmp" || true
else
  install -d -m 750 "$(dirname "$app_env")"
fi
cat >> "$env_tmp" <<EOF
RTC_STUN_URLS=stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302
TURN_URLS=turn:${public_ip}:3478?transport=udp,turn:${public_ip}:3478?transport=tcp
TURN_SHARED_SECRET=${turn_secret}
TURN_REALM=kafcord.kafly.com.br
EOF
install -m 600 "$env_tmp" "$app_env"

if [[ -f /etc/default/coturn ]]; then
  sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
fi

if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
  ufw allow 3478/tcp
  ufw allow 3478/udp
  ufw allow 49160:49200/udp
fi

systemctl enable coturn
systemctl restart coturn
systemctl --no-pager --full status coturn | sed -n '1,12p'
ss -lntup | grep ':3478 '
