# KCord

[![CI](https://github.com/andersonguilher/kcord/actions/workflows/ci.yml/badge.svg)](https://github.com/andersonguilher/kcord/actions/workflows/ci.yml)

KCord is an early web community platform for group conversations in text and
voice, file exchange, and low-latency screen sharing.

The current MVP provides a local community with imported Discord categories,
text channels and voice rooms, live presence, real-time messages, files up to
10 MB, microphone audio, camera tiles, on-demand screen sharing, Discord OAuth
identity linking, audio device selection, microphone/output tests, voice activity
detection, and configurable push-to-talk. Its layout follows the familiar
server/channel/call organization of Discord while retaining the KCord name,
assets, and implementation.

## Requirements

- Node.js 24 or a compatible current Node.js release
- npm 11 or a compatible npm release
- A modern browser with WebRTC and screen-capture support

## Install

```bash
npm install
```

## Development

Run the Vite client and real-time server together:

```bash
npm run dev
```

Open `http://localhost:5173`. To test presence and real-time communication, open
the page in two browser tabs and enter with different names.

## Production-style local run

```bash
npm run build
npm start
```

Open `http://localhost:3001`.

## Validation

With the server running on port 3001:

```bash
npm run typecheck
npm run build
npm run test:smoke
```

The smoke test covers server health, two-client presence, text messaging, voice
room membership, WebRTC signaling relay, and the on-demand screen subscription
protocol.

## Current limits

- State and messages are held in memory and disappear when the server restarts.
- Files are stored locally in `uploads/`; this is not durable object storage.
- Discord-backed local identities and imported role labels exist, but durable
  production accounts, full permission enforcement, moderation, encryption policy,
  and malware scanning are not implemented yet.
- Voice, camera, and requested screen media use a peer-to-peer mesh with public
  STUN discovery and a self-hosted TURN fallback in production. It is suitable
  for small rooms, but an SFU is still required for internet-scale rooms.
- Media capture still requires manual browser verification and permission.

See `docs/ARCHITECTURE.md` for the path toward a production deployment.

## VPS deployment

The current VPS deployment uses versioned releases under `/opt/kafcord`, Docker
Compose for the Node application, and Nginx as a WebSocket-capable reverse proxy.
Persistent configuration, SQLite data, imported member data, and uploads live
under `/opt/kafcord/shared`. See `deploy/README.md` for container, DNS, TLS, and
Discord callback details.

## Discord template migration

After entering the application, select the `⇩` button in the left rail, paste a
Discord Server Template link, review the counts and warnings, and choose **Aplicar
cópia**. The resulting community configuration is persisted locally in the ignored
`data/community.json` file.

The template `https://discord.new/pNTb9KZuGEPX` was imported and validated with 2
categories, 6 text channels, 8 voice rooms, and 6 roles. Member migration and
Discord OAuth login are implemented: 212 pending member identities were imported
from Kafly Airline, with 147 of 148 role assignments mapped. See
`docs/DISCORD_IMPORT.md`.

## Audio controls

Choose **Áudio** in the bottom voice dock to select input and output devices,
adjust their volumes, monitor the microphone through the chosen output while
watching its live meter, play an output test tone, and choose between automatic
voice detection and push-to-talk. Sensitivity, noise suppression, echo
cancellation, chosen devices, input mode, and PTT key are stored in browser local
storage. Output selection requires browser support for
`HTMLMediaElement.setSinkId`; otherwise KCord uses the system default output.

## Calls and on-demand screen sharing

Entering a voice room opens a participant grid with fixed controls for microphone,
camera, screen sharing, fullscreen, and hangup. Voice participants also remain
visible below their channel in the sidebar.

When a participant shares a screen, KCord initially sends the room a compressed
320×180 JPEG preview every few seconds. Live screen tracks are attached only after
another participant clicks that preview. Closing the viewer removes those tracks
for that viewer while the preview remains available to the room.

## License and security

KCord is released under the [MIT License](LICENSE). Report vulnerabilities as
described in [SECURITY.md](SECURITY.md). Code signing details are in
[CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md).

See [CONTRIBUTING.md](CONTRIBUTING.md) to get started and `docs/STATUS.md` for the current state and roadmap.
