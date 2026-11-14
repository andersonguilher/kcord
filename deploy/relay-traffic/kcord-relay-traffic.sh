#!/usr/bin/env bash
# Counts coturn relay traffic with nftables and writes the totals for the KCord app.
# Runs every minute from kcord-relay-traffic.timer. Only counts; never drops packets.
set -euo pipefail

output="${1:-/opt/kafcord/shared/data/relay-traffic.json}"
interface="${KCORD_RELAY_INTERFACE:-eth0}"

if ! nft list table inet kcord_traffic >/dev/null 2>&1; then
  nft -f - <<EOF
table inet kcord_traffic {
  counter relay_in {}
  counter relay_out {}
  chain input {
    type filter hook input priority -300; policy accept;
    iifname "${interface}" udp dport { 3478, 49160-49200 } counter name relay_in
    iifname "${interface}" tcp dport 3478 counter name relay_in
  }
  chain output {
    type filter hook output priority -300; policy accept;
    oifname "${interface}" udp sport { 3478, 49160-49200 } counter name relay_out
    oifname "${interface}" tcp sport 3478 counter name relay_out
  }
}
EOF
fi

counter_bytes() {
  nft list counter inet kcord_traffic "$1" | grep -o 'bytes [0-9]*' | head -n 1 | cut -d' ' -f2
}

rx_bytes="$(counter_bytes relay_in)"
tx_bytes="$(counter_bytes relay_out)"
boot_id="$(cat /proc/sys/kernel/random/boot_id)"
updated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

temporary="$(mktemp "$(dirname "$output")/.relay-traffic.XXXXXX")"
printf '{"bootId":"%s","rxBytes":%s,"txBytes":%s,"updatedAt":"%s"}\n' \
  "$boot_id" "${rx_bytes:-0}" "${tx_bytes:-0}" "$updated_at" > "$temporary"
chown 1000:1000 "$temporary"
chmod 644 "$temporary"
mv -f "$temporary" "$output"
