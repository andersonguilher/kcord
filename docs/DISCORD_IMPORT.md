# Discord import design

## Goal

Create a new Kafcord community that resembles an existing Discord server without
requiring a Discord password or user token and without silently importing private
account data.

## Supported sources

### 1. Discord Server Template (fast path)

Input: a `discord.new/...` template URL or template code.

Expected mapping:

- source server name and description -> community draft;
- categories -> channel groups;
- text and voice channels -> corresponding Kafcord channels;
- roles and channel permission overwrites -> Kafcord roles and access rules.

This path does not copy members, message history, files, bots, functional webhooks,
or settings that Discord excludes from templates. Deleted or stale template links
cannot be imported.

### 2. Official Discord Data Package (owner path)

Input: only a selected owned-server folder or a ZIP processed with strict
allow-listing. The importer should recognize guild settings, channels and their
permissions, uploaded emoji, audit-log metadata, and webhook metadata when present.

Account, payment, IP address, session, direct-message, advertising, and unrelated
server data must be ignored. Webhook URLs or tokens must never be copied; at most,
import a disabled webhook name that the owner can reconnect later.

### 3. Authorized Discord bot (implemented live path)

A bot installed by a server administrator reads allowed guild members through
Discord's API. The local implementation requires owner/Manage Server OAuth approval,
shows a preview, ignores bots, and persists only pending identities after explicit
confirmation. It must never be replaced by a self-bot or pasted user token.

## Members and login identity

Server Templates do not contain members. To migrate membership, a Kafcord-owned
Discord bot must be installed by an administrator in the source server and use the
Discord `List Guild Members` endpoint. That endpoint requires the privileged
`GUILD_MEMBERS` intent and returns at most 1,000 members per request, so imports
must page by Discord snowflake ID.

For each source member, store a pending membership with:

- immutable Discord user ID;
- source guild ID;
- source role IDs and nickname;
- import timestamp and status;
- no OAuth token, email, session data, or direct messages.

Kafcord login should use Discord OAuth2 Authorization Code flow with the minimal
`identify` scope. The returned Discord user ID is matched to the pending record:

```text
Discord member import                    First Kafcord login
discord_user_id + source_role_ids  <->  OAuth /users/@me.id
                 |                              |
                 `------> Kafcord user <--------'
                              |
                       mapped Kafcord roles
```

Never match by username, display name, nickname, or email: these can change or be
non-unique. A pending member has no usable Kafcord account until that person signs
in and consents. Existing Kafcord accounts need an explicit link flow protected by
OAuth `state`; never auto-merge accounts solely from profile similarity.

Bots, deleted Discord accounts, and people who never sign in remain unclaimed and
must not receive active sessions. Role mapping must show a preview and warn about
Discord permissions that Kafcord does not support.

The local implementation now keeps ordinary member login on `identify` and uses a
separate `identify guilds` authorization only for migration administrators. A
successful member callback atomically changes matching pending records to claimed,
retains one stable Kafcord user ID, and exposes the mapped role IDs to realtime
presence. It never matches by profile name.

## Import workflow

1. Select the source and parse it into a versioned, provider-neutral draft.
2. Validate names, channel types, role references, permission bits, file sizes, and
   unsupported Discord-only features.
3. Show counts, mappings, dropped fields, conflicts, and security warnings.
4. Let the owner rename or exclude items.
5. Require explicit confirmation before creating or replacing Kafcord data.
6. Record an import report without retaining the original archive or credentials.

Imports should create a new community by default. Re-import and merge semantics
need stable persistence IDs and are deferred until the database model exists.

## Known non-equivalences

- Discord accounts cannot become Kafcord accounts; people must join Kafcord.
- Discord bots and integrations need Kafcord-native replacements.
- Permission bits need an explicit mapping and may be downgraded with warnings.
- Message/file migration is separate content migration with privacy, retention,
  attribution, and storage implications.
- Voice sessions, calls, and screen-share history are not configuration to import.

## Prerequisites for implementation

- durable community, channel, role, and permission models;
- a sanitized real-world sample or template to test field mapping;
- transactional import so a failure cannot leave a partial community;
- archive limits, path-traversal protection, schema validation, and upload cleanup.
