# VPS deployment

The production application runs in the Docker container `kafcord`, built from
`/opt/kafcord/current`. Persistent state lives under `/opt/kafcord/shared`, and
the application listens on `127.0.0.1:3201` behind Nginx.

Public host: `kafcord.kafly.com.br`.

## Application container

The production application runs from `deploy/compose.production.yml`. Nginx keeps
proxying `127.0.0.1:3201`; only the Node application moved into Docker. Persistent
state remains on the host under `/opt/kafcord/shared` and is bind-mounted into the
container. The image uses Node 24, runs as the unprivileged `node` user, drops Linux
capabilities, uses a read-only root filesystem, and exposes a health check.

Nginx accepts up to 11 MiB of multipart request data so the application can enforce
the exact 10 MiB file limit after multipart framing. Compressed request bodies are
rejected with `415`; KCord clients do not use them, and this avoids exposing the
JSON parser's decompression path.

From a prepared release directory:

```bash
docker compose -f deploy/compose.production.yml build
docker compose -f deploy/compose.production.yml up -d
docker compose -f deploy/compose.production.yml ps
```

Before the first container start, `shared/data` and `shared/uploads` must be writable
by UID/GID `1000:1000`. Back up both directories before changing ownership or
switching from PM2. Keep the previous release and PM2 definition available until
the public health and smoke checks pass.

## Server bandwidth metrics

The owner panel shows the server's total bandwidth in two parts:

- **App:** the app reads its container's `eth0` counters every minute. This covers
  the site, API, Socket.IO, uploads, downloads, installers, and outbound calls.
- **Voice/video relay:** coturn runs on the host, so `deploy/relay-traffic/` counts
  its ports (3478 and 49160-49200 on `eth0`) with an nftables table that only counts
  and never drops. A systemd timer writes the totals to
  `/opt/kafcord/shared/data/relay-traffic.json` every minute.

Direct (peer-to-peer) calls do not touch the server and are not counted. Install
the relay counter once on the host:

```bash
install -D -m 755 deploy/relay-traffic/kcord-relay-traffic.sh /opt/kafcord/bin/kcord-relay-traffic.sh
install -m 644 deploy/relay-traffic/kcord-relay-traffic.service deploy/relay-traffic/kcord-relay-traffic.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now kcord-relay-traffic.timer
```

## Docker network repair after upgrades

On 2026-10-31 an automatic Docker upgrade restarted the daemon, and two Compose
networks came back without their NAT/FORWARD rules. Their containers lost internet
access, so every new Discord login failed with `fetch failed` while open sessions
kept working.

`deploy/docker-network-repair/` runs a check about 60 s after every Docker daemon
start. It only recreates (`docker compose down` + `up -d`) the Compose projects
whose bridge network is missing its rules, so normal restarts cause no downtime.
Install it once on the host:

```bash
install -D -m 755 deploy/docker-network-repair/kcord-docker-network-repair.sh /opt/kafcord/bin/kcord-docker-network-repair.sh
install -m 644 deploy/docker-network-repair/kcord-docker-network-repair.service /etc/systemd/system/
install -D -m 644 deploy/docker-network-repair/docker-network-repair.conf /etc/systemd/system/docker.service.d/network-repair.conf
systemctl daemon-reload
```

Check without changing anything: `/opt/kafcord/bin/kcord-docker-network-repair.sh --dry-run`.
Logs: `journalctl -u kcord-docker-network-repair`.

Current public URL: `https://kafcord.kafly.com.br`. HTTPS is active through a
Let's Encrypt certificate, and HTTP redirects permanently to HTTPS.

DNS record:

```text
Type: A
Name: kafcord
Value: <SERVER_PUBLIC_IP>
TTL: 300 (or automatic)
```

Certificate renewal uses the configured ACME webroot:

```bash
certbot certonly --webroot -w /var/www/letsencrypt -d kafcord.kafly.com.br
```

The Discord Developer Portal redirect must be exactly:

```text
https://kafcord.kafly.com.br/auth/discord/callback
```
