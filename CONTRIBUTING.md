# Contributing to KCord

Thanks for helping. KCord is a small project, so the process is light.

## Set up

```bash
npm install
npm run dev        # client on :5173, server on :3001
```

Copy `.env.example` to `.env` to use Discord login locally. Never commit `.env`,
uploads, or user data.

## Before you open a pull request

```bash
npm run typecheck
npm run lint
npm test
npm run build && npm run test:ui   # needs Edge or Chrome
```

CI runs the same checks. A change that touches a socket event must update the
shared schema in `shared/protocol.ts`, the server handler, the client, and the
tests together. Validate every client-controlled value at the server boundary.

## Guidelines

- Keep changes focused, with tests next to the behaviour they protect.
- Prefer small hooks and modules over growing `src/App.tsx` or `server/index.ts`.
- Conventional Commit messages (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).
- Link imported Discord members by immutable Discord user ID only.
- See `AGENTS.md` and `docs/WORKFLOW.md` for the project rules and routines.

## Reporting security issues

Do not open a public issue. See `SECURITY.md`.

## License

By contributing you agree that your contributions are licensed under the MIT License.
