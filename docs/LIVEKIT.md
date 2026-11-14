# Replacing the peer-to-peer mesh with LiveKit

Status: server side done and tested; client side in progress. Nothing is enabled
by default, so every voice channel still uses the mesh.

## Why

Voice, camera and screen sharing are a WebRTC **mesh**: each participant opens a
connection to every other one. Upload cost grows with the number of people (a screen
shared to five viewers is sent five times from the sharer's home connection), and
quality degrades quickly beyond a handful of participants. A self-hosted **SFU**
(LiveKit) receives each stream once and forwards it, with simulcast and bandwidth
adaptation. It also removes most of the NAT problems that need a TURN relay today.

## Decisions

- **LiveKit, self-hosted**, next to coturn on the same server. Open source (Apache-2.0),
  runs as one container, and has maintained server and browser SDKs.
- **Per-channel rollout.** A mesh client and a LiveKit client cannot hear each other,
  so a room must use exactly one backend. `LIVEKIT_VOICE_CHANNEL_IDS` lists the voice
  channels served by LiveKit (`*` for all); every other channel keeps the mesh. The
  client reads the list from `GET /api/rtc-config` (`livekitChannelIds`).
- **LiveKit identity = the member's socket id.** Members, tiles, screen previews and
  moderation already key everything by socket id, so the rest of the app is unchanged.
- **The server stays the authority.** Presence, chat, moderation, screen announcements
  and the AFK channel keep using Socket.IO. LiveKit carries only media.
- **Tokens are minted by our server** (`POST /api/livekit/token`) and only for the live
  socket of a signed-in member, with the permissions that member has *right now*
  (a server-muted member cannot publish a microphone, a deafened one cannot subscribe).
  They are valid to join for ten minutes, and no member ever sees the API secret.
- **The AFK channel never uses LiveKit** (it is silent by design).
- **Screen sharing stays watch-on-demand.** Viewers subscribe to a screen track only
  after choosing to watch (manual subscription), which keeps today's bandwidth behaviour.
- **The microphone pipeline is unchanged.** The processed track (gain, sensitivity,
  push-to-talk gating) is what gets published.

## Server configuration

Set all four, or none. With any missing, LiveKit is off.

| Variable | Meaning |
|---|---|
| `LIVEKIT_URL` | Public WebSocket URL browsers connect to, for example `wss://example.org/livekit` |
| `LIVEKIT_API_KEY` | API key from `livekit.yaml` |
| `LIVEKIT_API_SECRET` | API secret from `livekit.yaml` (never sent to clients) |
| `LIVEKIT_VOICE_CHANNEL_IDS` | Comma-separated voice channel ids, or `*` |

### The LiveKit server

`livekit.yaml`:

```yaml
port: 7880
bind_addresses: ["127.0.0.1"]   # reached through the reverse proxy, never directly
rtc:
  tcp_port: 7881                # fallback when UDP is blocked
  port_range_start: 50000       # media, kept narrow so it is easy to open
  port_range_end: 50100
  use_external_ip: true
keys:
  YOUR_API_KEY: YOUR_API_SECRET
room:
  empty_timeout: 60
```

Run it with host networking (it avoids Docker NAT rules, which have failed before after
daemon restarts) and proxy the signalling path over TLS:

```nginx
location /livekit/ {
    proxy_pass http://127.0.0.1:7880/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}
```

Open `7881/tcp` and `50000-50100/udp` to the world. Everything else stays closed.

## Moderation mapping

| Today (Socket.IO) | With LiveKit |
|---|---|
| Server mute | Token omits the microphone source; a live mute uses the room API |
| Server deafen | Token sets `canSubscribe: false`; a live change uses the room API |
| Disconnect from voice | Remove the participant through the room API |
| Move to another channel | The client leaves one room and joins the other |

## Rollout and rollback

1. Deploy the LiveKit server and verify it answers, with no channel assigned.
2. Enable one rarely used channel and test with two real people.
3. Move channels over one at a time, watching server CPU and bandwidth.
4. **Rollback is one setting:** remove a channel id (or unset the variables) and restart.
   Clients rejoin that room on the mesh.

## Testing

- Unit tests cover the configuration, the token's permissions (decoded and verified with
  the SDK) and every response of the token endpoint.
- The real-browser test will run against a LiveKit server started in CI, with the same
  scenarios as the mesh (audio, camera, screen sharing watched on demand).

## Open risks

- **Bandwidth and CPU on the server.** An SFU moves the upload from members' homes to the
  server. Watch egress, especially for screens shared to many viewers.
- **One more service to run and patch.**
- **Mixed-backend rooms are impossible**, which is why the rollout is per channel.
