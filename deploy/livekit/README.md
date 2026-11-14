# LiveKit server

Files for the self-hosted LiveKit SFU described in `docs/LIVEKIT.md`.

1. Copy `livekit.yaml.example` to `livekit.yaml` next to `compose.yml`, fill in the public IP and a
   random API key and secret, and `chmod 600 livekit.yaml`.
2. Open `7881/tcp` and `50000-50100/udp` to the internet. Nothing else needs opening.
3. Add `nginx-location.conf` to the HTTPS server block of your site, before `location /`, then
   `nginx -t && systemctl reload nginx`. It exposes only `/livekit/rtc` and `/livekit/rtc/validate`
   and answers 404 for everything else under `/livekit/`, which keeps the admin API private.
4. `docker compose up -d`.
5. Check it: `curl -s -o /dev/null -w '%{http_code}' https://YOUR.HOST/livekit/rtc/validate` answers
   `401` (LiveKit reached, no token), and `https://YOUR.HOST/livekit/twirp/...` answers `404`.

Nothing uses the server until `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` and
`LIVEKIT_VOICE_CHANNEL_IDS` are set on the KCord server.
