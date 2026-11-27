# Architecture

## Current shape

Kafcord is a single-repository TypeScript application with two runtime parts:

```text
Browser (React)
  |-- HTTP: health, client assets, file upload/download
  |-- Socket.IO: presence, chat, voice membership, WebRTC signaling
  `-- WebRTC mesh: microphone, camera, and requested screen tracks
             |-- direct path through public STUN discovery
             `-- coturn relay when a direct path is unavailable
             |
Docker container (Node 24, Express + Socket.IO)
  |-- in-memory presence and WebRTC session state
  |-- SQLite: messages, reactions, pins, and read state
  `-- local uploads/ directory
```

The application server never transports live media. It introduces peers through
Socket.IO; browsers use direct WebRTC paths when possible and the separate coturn
service when NAT or firewall restrictions prevent a direct connection.

## Main flows

1. A person chooses a display name and joins the fixed Kafcord community.
2. Socket.IO returns recent and pinned messages, durable unread counts, and
   current members, then broadcasts live changes.
3. Text and direct messages are validated and written to SQLite before the server
   broadcasts them. Edits, reactions, pins, and read markers use the same store.
4. An uploaded file is limited to 10 MB, stored under an opaque generated name,
   announced with its expiration time, and served as a forced download. Files
   expire after three days; an hourly cleanup removes expired and old orphaned
   uploads while preserving the message as an expired-attachment record.
5. Joining voice asks the browser for microphone access. A newcomer creates
   WebRTC offers for existing participants in the same voice room. The client
   obtains STUN plus one-hour TURN credentials from `/api/rtc-config` first.
6. Screen capture first publishes a compressed JPEG thumbnail through Socket.IO.
   The sharer's live screen tracks are not attached to every peer.
7. When a participant clicks the thumbnail, the server validates that both people
   share a voice room and asks the sharer to attach screen tracks only to that
   viewer. Closing the viewer removes those tracks and renegotiates the peer.
8. Text channels whose name contains a word starting with "link" (for example
   `#links`) render messages that contain a URL as thumbnail cards. Message creation
   starts the server-side capture of the page's `og:image`/`twitter:image`, title
   and site name. The validated image and metadata are persisted under
   `data/link-preview-cache`; `/api/link-preview` and `/api/link-preview/image`
   serve that local capture, so opening an existing card neither contacts nor
   depends on the third-party host.
9. Text channels named for screenshots/captures render valid image attachments
   in the same responsive card grid as link previews. The card reuses the
   verified attachment blob, opens the existing lightbox, and keeps the original
   download available. Expired and non-image files remain ordinary message rows.
10. `shared/channel-rules.ts` limits what those channels accept, in the client and
    again on the server: link channels take only text containing an http(s) URL
    (no files); screenshot channels take only image files, checked by name and by
    leading bytes (no text messages). Private messages are not affected. For
    messages stored before the rule, `node scripts/move-channel-messages.ts` lists
    misplaced links and images between those two channels, and `--apply` backs up
    the database and moves them. Other content stays where it is.

## Security boundary

Everything received from the browser is untrusted. The server currently limits
display names, messages, channel IDs, JSON bodies, file count, and file size. It
also restricts signaling to participants in the same voice room and serves files
with attachment, same-origin, and no-sniff headers.

Link previews are the only outbound HTTP the server makes on a user's behalf. They
require a Discord session, accept only http/https on default ports, refuse
credentials in URLs, check every resolved address at connect time (blocking
loopback, private, link-local, CGNAT, and reserved ranges, including after
redirects), cap size, time and redirects, and rate-limit each user. The image route
only serves URLs that a fetched page pointed at and that were successfully stored,
and only JPEG/PNG/WebP/GIF/AVIF (never SVG), with no-sniff and a sandbox CSP.
Memory is a hot cache; the durable image cache survives server restarts and evicts
the oldest files after reaching 256 MB.

Client failure reports (`POST /api/client-reports`) send every app failure to the
owner: known failures (share source list, starting a live, app audio, microphone on
joining voice), any unhandled error on the page, and every desktop-process failure
(native modules that do not load, PTT hook, capture, updates, crashed processes),
which `electron/desktop-issues.cjs` queues until a signed-in page sends them.
Desktop reports carry the Windows build, graphics card and screen capture mode.
Owners online get a `admin:client-report` socket alert; the panel button shows how
many open reports arrived since the panel was last opened. The owner can mark a
report open, resolved, or ignored; state changes are persisted with the report.
Reports require a Discord session,
accept only known kinds and short plain-text fields, drop duplicates within two
minutes, allow 30 per user per hour, and keep the latest 300 in
the application database. Window names leave the PC only when the user names the
missing application, presses "Enviar diagnóstico" in the picker, and confirms.

If Windows Graphics Capture cannot start a whole screen (`NotReadableError`), the
desktop app offers to restart in compatibility mode (saved in `capture-mode.json`)
and rejoins the voice room. Chromium 151+ forces WGC for monitor video tracks on
Windows 11 build 26100+, so this mode does not request another Chromium track: it
polls bounded JPEG snapshots through Electron and feeds a canvas track at up to
10 fps. Window capture keeps WGC. The user can return to normal WGC capture in
Settings → Windows. The mode never switches back by itself: it is saved with the
Windows build, graphics drivers and Chromium version it was chosen under, and
when any of them changes, the share notice and Settings suggest trying WGC again.
Every compatible share also points at sharing a window for normal fps.

Discord-backed sessions authenticate normal users, and the local guest mode is
restricted to the configured owner. Files are still not malware-scanned, so a
future production hardening pass must add scanning, rate limits, and abuse controls.

Each Discord account keeps one live session, matched by the immutable Discord user
ID: when it joins from another PC, phone or tab, the server sends
`session:replaced` to the older sessions and disconnects them. Those clients stay
offline until the user chooses "Usar aqui", so devices never reconnect in a loop.

The AFK channel is silent by server rule: joining it returns no voice peers, WebRTC
signaling inside it is dropped, screen sharing is refused, and member state is
forced to muted and deafened whatever the client reports.

The browser build is an installable webapp (`public/manifest.webmanifest` and
`public/sw.js`). The service worker only caches the app shell (`/`, hashed
`/assets/`, icons). `/api`, `/socket.io`, `/files`, `/auth`, `/avatars`, and
downloads always go to the network and are never stored. It registers only over
HTTPS and never inside the Electron or Tauri clients. Bump `CACHE` in `sw.js`
when the caching rules change.

## Production direction

Before larger-scale public deployment, add:

- authenticated accounts, community membership, roles, and moderation;
- PostgreSQL when multi-instance or multi-community operation outgrows the
  single-process SQLite store;
- private object storage with signed access and malware scanning;
- an SFU for scalable audio/screen distribution plus capacity monitoring and TLS
  hardening for the existing TURN service;
- rate limits, audit events, observability, retention rules, and abuse controls;
- deployment-specific TLS, secrets, backup, and recovery procedures.

An SFU is the important low-latency scaling boundary: the current mesh requires
each participant to upload one copy of their microphone/camera media to every
other participant. Screen upload is already viewer-driven, but each active viewer
still receives a separate peer-to-peer copy.

## Discord migration boundary

Discord migration is an offline configuration import, not an ongoing dependency.
The preferred sources are a Server Template link for basic structure or the
owned-server portion of the user's official Discord Data Package for richer data.
The importer must normalize both sources into a Kafcord-owned intermediate format,
show a preview and warnings, and write only after explicit confirmation. It must
never request or store a Discord user token. See `docs/DISCORD_IMPORT.md`.

All durable state lives in one SQLite file, `data/kafcord.sqlite` by default or
`KAFCORD_CHAT_DATABASE_PATH`: the chat tables, and an `app_state` table of JSON
documents for login sessions, profiles, imported Discord members, the community
configuration, the voice equalizer, client failure reports and traffic statistics
(`server/app-state.ts`). Earlier releases kept those documents as separate
JSON files in `data/`; on the first start each one is imported once, and the files are
then left in place (never read again) so a rollback still finds data. The SQLite file
is runtime data, intentionally ignored by Git; it must live in persistent/shared
storage during release deployments and is the only file to back up (use SQLite's
backup API, because the write-ahead log holds recent changes). PostgreSQL should replace it before running multiple app
server instances or supporting concurrent multi-community administration.

Production runs the application as an unprivileged container behind the existing
host Nginx proxy. Only `127.0.0.1:3201` is published; data, uploads, and downloads
are bind-mounted from `/opt/kafcord/shared`. The root filesystem is read-only and
all Linux capabilities are dropped.


