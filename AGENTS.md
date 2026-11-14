# Kafcord agent guide

## Product

Kafcord is a web community platform for group text, voice, file sharing, and
low-latency screen sharing. The current delivery is a local MVP, not a
production-ready Discord replacement.

## Stack and components

- React 19, TypeScript, and Vite: browser client in `src/`.
- Node.js, Express, Socket.IO, and Multer: real-time/API server in `server/`.
- Browser WebRTC: peer-to-peer audio and screen media.
- Local `uploads/`: development-only file storage, ignored by Git.
- Local `data/community.json`: persisted community configuration, ignored by Git.
- `scripts/smoke-test.mjs`: two-client real-time integration check.

No database, object storage, or SFU is configured. Production uses a self-hosted
coturn relay with short-lived REST credentials for restrictive networks. See
`docs/ARCHITECTURE.md` for boundaries and known limitations.

## Repository map

- `src/`: client UI and real-time/WebRTC behavior.
- `server/`: HTTP, uploads, presence, chat, voice membership, and signaling.
- `scripts/`: repeatable project validation.
- `docs/STATUS.md`: current handoff and next step.
- `docs/WORKFLOW.md`: session routines and confirmed commands.
- `docs/ARCHITECTURE.md`: system flow, limits, and production direction.
- `docs/DISCORD_IMPORT.md`: supported migration sources, mapping, and safety rules.

## Implementation rules

- Keep shared event names and payload shapes aligned across client, server, and
  smoke tests.
- Validate all client-controlled values at the server boundary; never trust file
  names, MIME types, room IDs, user names, or signaling targets.
- Do not expose uploads inline. Preserve attachment and content-sniffing headers.
- Never commit credentials, `.env` files, runtime uploads, or user data.
- Link imported Discord members by immutable Discord user ID, never by username,
  display name, or email.
- Preserve user changes and inspect relevant diffs before editing modified files.
- Code, manifests, configuration, and tests take priority over old documentation.

