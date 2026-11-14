# Project status

KCord is a web and Windows community platform for text, voice, files, camera and
screen sharing. It is a local-first MVP in active development, used by one real
community, and not yet a production-ready Discord replacement. See
`docs/ARCHITECTURE.md` for system boundaries and known limits.

## Stack

- Client: React 19, TypeScript, Vite (`src/`).
- Server: Node.js, Express, Socket.IO, SQLite (`server/`), shared event schemas in `shared/`.
- Media: browser WebRTC, peer-to-peer mesh with a coturn relay fallback.
- Desktop: Electron shell for Windows with a native per-application audio helper in Rust.

## Quality gates

Run before every change (`docs/WORKFLOW.md` has the full command list):

- `npm run typecheck`, `npm run lint`, `npm test` (unit and hook tests).
- `npm run build` then `npm run test:ui`: a real-browser end-to-end test with two
  fake signed-in users covering chat, private messages, voice with real WebRTC
  audio, camera, screen sharing, audio settings and the owner panel.
- `npm run test:smoke` and the isolated `test:*` integration scripts against a server.
- GitHub Actions runs all of the above on every push and pull request.

## Architecture work in progress

1. Safety net (CI, lint, unit tests, shared zod schemas for every socket event): done.
2. Splitting the monoliths: the server is modular. The client's call layer
   (microphone, peer connections, camera, screen sharing and viewing) and the
   chat, audio, push-to-talk, update and admin logic are hooks under `src/hooks`.
   Remaining in `src/App.tsx`: the JSX, auth/profile screens and join/leave orchestration.
3. Move the remaining JSON files (sessions, profiles, reports, traffic stats) into SQLite.
4. Replace the peer-to-peer mesh with a self-hosted SFU (LiveKit) behind a feature flag.
5. Signed Windows releases built and signed in CI (see `CODE_SIGNING_POLICY.md`).

## Known limitations

- No object storage or database server: SQLite and a local uploads folder.
- Calls are a peer-to-peer mesh, so quality degrades with many participants.
- Phone layouts and iOS background behaviour are only manually tested.
- The Windows installer is not yet code signed, so Windows or antivirus software
  may warn about it.

## Next step

Finish the client split (join/leave and the JSX into components), then SQLite
consolidation, then the SFU.
