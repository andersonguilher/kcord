# Project workflow

Use `AGENTS.md` as the entry point and `docs/STATUS.md` as the current handoff.
Treat code, manifests, configuration, and CI as the source of truth once present.

## Confirmed commands

- `npm install`: install locked dependencies.
- `npm run dev`: run Vite on port 5173 and the real-time server on port 3001.
- `npm run typecheck`: check client and server TypeScript.
- `npm run lint`: Biome lint (errors fail; existing a11y/hook warnings are a ratchet to fix over time).
- `npm test`: Vitest unit tests (`tests/`), including the shared chat protocol schemas.
  Client hooks are tested with Testing Library in happy-dom (`// @vitest-environment happy-dom`
  at the top of the file; call `cleanup()` in `afterEach`, since Vitest globals are off).
- `npm run build`: type-check and create the production client in `dist/`.
- `npm start`: serve Socket.IO, APIs, uploads, and an existing `dist/` on port 3001.
- `npm run test:smoke`: validate health and core real-time flows against a running
  server on port 3001.
- `npm run test:desktop-hook` (and any `electron ...` command): run it with `ELECTRON_RUN_AS_NODE`
  unset (`env -u ELECTRON_RUN_AS_NODE npm run test:desktop-hook`). VS Code-hosted shells export it,
  which makes Electron start as plain Node and fail with `Cannot read properties of undefined`.
- `npm run test:ui`: real-browser end-to-end check (needs `npm run build` and Edge or Chrome).
  Starts an isolated server with two fake logged-in users and drives chat, voice with real
  WebRTC audio, audio settings, the owner panel and a reload. Uses port 3331 (`KCORD_UI_TEST_PORT`).
  Run it before any client refactor or release; it is the only check that exercises the
  logged-in UI.
- `npm run test:chat-store`: create, reopen, validate, and remove an isolated
  SQLite database containing public/private messages and read state.
- `npm run test:session-afk`: start an isolated server with fake Discord sessions
  in a temporary folder and check one live session per account (newest device
  wins) and the silent AFK channel. Uses port 3311 (`KCORD_TEST_PORT`).
- `npm run test:voice-eq`: start an isolated server and check that only the owner
  changes the community voice equalizer, that values are validated and clamped,
  and that the setting reaches everyone and is saved. Uses port 3312.

The server requires Node.js 22.13 or newer because chat persistence uses the
built-in `node:sqlite` module. `KAFCORD_CHAT_DATABASE_PATH` defaults to
`data/kafcord.sqlite`; production must point it at persistent/shared storage.

CI (`.github/workflows/ci.yml`) runs typecheck, lint, unit tests, build, the isolated
integration tests, and the real-time smoke test on every push and pull request.
Shared event payload schemas live in `shared/protocol.ts` (zod) and are used by the
server; extend them when adding or changing socket events.

## Start a session

1. Determine the user's intent from meaning, not an exact phrase.
2. Read `AGENTS.md` and the relevant parts of `docs/STATUS.md` without rereading
   context already available.
3. If Git exists, inspect `git status --short`; otherwise note that change tracking
   is unavailable.
4. Inspect only the files needed for the selected work.

## Plan the day

For questions such as "what is next?", "where did we stop?", or "what should we do
today?":

1. Use `AGENTS.md` and `docs/STATUS.md`.
2. Inspect `git status --short` when Git exists.
3. Consult commits or historical excerpts only when needed.
4. Present the current state, verifiable pending work, and up to three next steps.
5. Wait for a choice only when the user has not already selected a task.

## Resume uncommitted work

1. Inspect Git status and relevant diffs before editing when Git exists.
2. Distinguish user changes, completed work, and partial implementation.
3. Use `docs/STATUS.md` and history only to clarify the diffs' intent.
4. Reconstruct the objective, prior validation, and safest next step.
5. Continue and validate while preserving all existing changes.
6. Ask only when plausible interpretations lead to materially different results.

Without Git, inspect relevant files and their surrounding context directly, and
state the resulting evidence limit.

## Execute a concrete task

When the user names a task, prioritize it over planning rituals. Inspect related
context, implement the requested change, run proportional validation, and report
the result. Do not ask the user to choose again when the choice is already clear.

## Select validation

- Start with the closest focused check for the changed area.
- Expand to type checking, tests, build, or integration checks according to reach
  and risk, once such commands exist.
- For documentation-only changes, review paths, links, formatting, and diffs; do
  not run an application build merely for formality.
- Never describe a command as confirmed until it has succeeded in this project.
- Never equate local checks with success in a real external environment.

## Close the day

For requests such as "finish for today," "close the session," or "prepare the
handoff":

1. Complete proportional checks within the authorized work.
2. Review Git status and relevant diffs when Git exists.
3. Replace obsolete content in `docs/STATUS.md` (public: state, evidence, roadmap; never server
   addresses, backups or credentials). Release directories, image tags, backups and rollback steps go
   in `docs/OPERATIONS.private.md`, which is git-ignored (`*.private.md`) and stays on the maintainer's
   machine. Replace obsolete content in `docs/STATUS.md` with the result, evidence, pending
   work, next step, blockers, and relevant uncommitted changes; keep it under 80
   lines.
4. Update permanent documentation only when it became inaccurate.
5. Record durable decisions in a memory document or ADR only when one is warranted.
6. Summarize changed files, validation, risks, and pending work.
7. Suggest coherent commits if useful, but do not stage, commit, or push unless the
   user explicitly requests it.

## Git and delivery policy

- Git is initialized on `main` with Conventional Commit messages (`feat:`, `fix:`,
  `docs:`, `refactor:`); no branch or review procedure is defined yet.
- Treat pre-existing uncommitted changes as user-owned and preserve them.
- Do not stage, commit, push, publish, deploy, or send external messages unless the
  user explicitly authorizes that action.
