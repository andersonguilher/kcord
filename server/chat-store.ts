import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ChatMessage = {
  id: string;
  channelId: string;
  author: string;
  authorUserId?: string;
  text: string;
  sentAt: string;
  editedAt?: string;
  pinned?: boolean;
  replyTo?: { id: string; author: string; text: string };
  reactions?: Record<string, string[]>;
  authorAvatarUrl?: string | null;
  file?: { name: string; url: string; size: number; expiresAt?: string; expired?: boolean };
};

export type DirectMessage = {
  id: string;
  fromUserId: string;
  toUserId: string;
  fromDiscordUserId?: string;
  toDiscordUserId?: string;
  author: string;
  authorAvatarUrl?: string | null;
  recipient: string;
  recipientAvatarUrl?: string | null;
  text: string;
  sentAt: string;
  file?: { name: string; url: string; size: number; expiresAt?: string; expired?: boolean };
};

type PublicMessageRow = {
  id: string;
  channel_id: string;
  author: string;
  author_user_id: string | null;
  text: string;
  sent_at: string;
  edited_at: string | null;
  pinned: number;
  reply_to_id: string | null;
  reply_to_author: string | null;
  reply_to_text: string | null;
  author_avatar_url: string | null;
  file_name: string | null;
  file_url: string | null;
  file_size: number | null;
  file_expires_at: string | null;
  file_expires_at_ms: number | null;
  file_deleted: number;
};

type DirectMessageRow = {
  id: string;
  from_user_id: string;
  to_user_id: string;
  from_discord_user_id: string | null;
  to_discord_user_id: string | null;
  author: string;
  author_avatar_url: string | null;
  recipient: string;
  recipient_avatar_url: string | null;
  text: string;
  sent_at: string;
  file_name: string | null;
  file_url: string | null;
  file_size: number | null;
  file_expires_at: string | null;
  file_expires_at_ms: number | null;
  file_deleted: number;
};

function timestamp(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function publicMessageFromRow(row: PublicMessageRow, reactions?: Record<string, string[]>): ChatMessage {
  return {
    id: row.id,
    channelId: row.channel_id,
    author: row.author,
    authorUserId: row.author_user_id ?? undefined,
    text: row.text,
    sentAt: row.sent_at,
    editedAt: row.edited_at ?? undefined,
    pinned: row.pinned === 1 || undefined,
    replyTo: row.reply_to_id && row.reply_to_author && row.reply_to_text !== null ? {
      id: row.reply_to_id,
      author: row.reply_to_author,
      text: row.reply_to_text,
    } : undefined,
    reactions: reactions && Object.keys(reactions).length > 0 ? reactions : undefined,
    authorAvatarUrl: row.author_avatar_url,
    file: row.file_name && row.file_url && row.file_size !== null ? {
      name: row.file_name,
      url: row.file_url,
      size: row.file_size,
      expiresAt: row.file_expires_at ?? undefined,
      expired: row.file_deleted === 1 || (row.file_expires_at_ms !== null && row.file_expires_at_ms <= Date.now()) || undefined,
    } : undefined,
  };
}

function directMessageFromRow(row: DirectMessageRow): DirectMessage {
  return {
    id: row.id,
    fromUserId: row.from_user_id,
    toUserId: row.to_user_id,
    fromDiscordUserId: row.from_discord_user_id ?? undefined,
    toDiscordUserId: row.to_discord_user_id ?? undefined,
    author: row.author,
    authorAvatarUrl: row.author_avatar_url,
    recipient: row.recipient,
    recipientAvatarUrl: row.recipient_avatar_url,
    text: row.text,
    sentAt: row.sent_at,
    file: row.file_name && row.file_url && row.file_size !== null ? {
      name: row.file_name,
      url: row.file_url,
      size: row.file_size,
      expiresAt: row.file_expires_at ?? undefined,
      expired: row.file_deleted === 1 || (row.file_expires_at_ms !== null && row.file_expires_at_ms <= Date.now()) || undefined,
    } : undefined,
  };
}

export class ChatStore {
  readonly database: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      const parent = dirname(databasePath);
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    }
    this.database = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:") {
      try {
        chmodSync(databasePath, 0o600);
      } catch {
        // Windows may not apply POSIX modes; the containing data directory still scopes access.
      }
    }
    // The timeout comes first: switching the journal mode needs a lock other connections may hold.
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS public_messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        author TEXT NOT NULL,
        author_user_id TEXT,
        text TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        sent_at_ms INTEGER NOT NULL,
        edited_at TEXT,
        pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
        reply_to_id TEXT,
        reply_to_author TEXT,
        reply_to_text TEXT,
        author_avatar_url TEXT,
        file_name TEXT,
        file_url TEXT,
        file_size INTEGER,
        file_expires_at TEXT,
        file_expires_at_ms INTEGER,
        file_deleted INTEGER NOT NULL DEFAULT 0 CHECK (file_deleted IN (0, 1))
      );
      CREATE INDEX IF NOT EXISTS public_messages_channel_time
        ON public_messages(channel_id, sent_at_ms DESC);
      CREATE INDEX IF NOT EXISTS public_messages_pinned
        ON public_messages(channel_id, pinned, sent_at_ms DESC);

      CREATE TABLE IF NOT EXISTS message_reactions (
        message_id TEXT NOT NULL REFERENCES public_messages(id) ON DELETE CASCADE,
        emoji TEXT NOT NULL,
        user_id TEXT NOT NULL,
        PRIMARY KEY (message_id, emoji, user_id)
      );

      CREATE TABLE IF NOT EXISTS channel_reads (
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        read_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, channel_id)
      );

      CREATE TABLE IF NOT EXISTS direct_messages (
        id TEXT PRIMARY KEY,
        from_user_id TEXT NOT NULL,
        to_user_id TEXT NOT NULL,
        from_discord_user_id TEXT,
        to_discord_user_id TEXT,
        author TEXT NOT NULL,
        author_avatar_url TEXT,
        recipient TEXT NOT NULL,
        recipient_avatar_url TEXT,
        text TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        sent_at_ms INTEGER NOT NULL,
        file_name TEXT,
        file_url TEXT,
        file_size INTEGER,
        file_expires_at TEXT,
        file_expires_at_ms INTEGER,
        file_deleted INTEGER NOT NULL DEFAULT 0 CHECK (file_deleted IN (0, 1))
      );
      CREATE INDEX IF NOT EXISTS direct_messages_from_time
        ON direct_messages(from_user_id, sent_at_ms DESC);
      CREATE INDEX IF NOT EXISTS direct_messages_to_time
        ON direct_messages(to_user_id, sent_at_ms DESC);

      CREATE TABLE IF NOT EXISTS direct_reads (
        user_id TEXT NOT NULL,
        peer_user_id TEXT NOT NULL,
        read_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, peer_user_id)
      );
    `);
    const publicMessageColumns = new Set((this.database.prepare("PRAGMA table_info(public_messages)").all() as { name: string }[])
      .map((column) => column.name));
    if (!publicMessageColumns.has("file_expires_at")) this.database.exec("ALTER TABLE public_messages ADD COLUMN file_expires_at TEXT");
    if (!publicMessageColumns.has("file_expires_at_ms")) this.database.exec("ALTER TABLE public_messages ADD COLUMN file_expires_at_ms INTEGER");
    if (!publicMessageColumns.has("file_deleted")) this.database.exec("ALTER TABLE public_messages ADD COLUMN file_deleted INTEGER NOT NULL DEFAULT 0");
    const directMessageColumns = new Set((this.database.prepare("PRAGMA table_info(direct_messages)").all() as { name: string }[])
      .map((column) => column.name));
    if (!directMessageColumns.has("file_name")) this.database.exec("ALTER TABLE direct_messages ADD COLUMN file_name TEXT");
    if (!directMessageColumns.has("file_url")) this.database.exec("ALTER TABLE direct_messages ADD COLUMN file_url TEXT");
    if (!directMessageColumns.has("file_size")) this.database.exec("ALTER TABLE direct_messages ADD COLUMN file_size INTEGER");
    if (!directMessageColumns.has("file_expires_at")) this.database.exec("ALTER TABLE direct_messages ADD COLUMN file_expires_at TEXT");
    if (!directMessageColumns.has("file_expires_at_ms")) this.database.exec("ALTER TABLE direct_messages ADD COLUMN file_expires_at_ms INTEGER");
    if (!directMessageColumns.has("file_deleted")) this.database.exec("ALTER TABLE direct_messages ADD COLUMN file_deleted INTEGER NOT NULL DEFAULT 0");
    if (!directMessageColumns.has("from_discord_user_id")) this.database.exec("ALTER TABLE direct_messages ADD COLUMN from_discord_user_id TEXT");
    if (!directMessageColumns.has("to_discord_user_id")) this.database.exec("ALTER TABLE direct_messages ADD COLUMN to_discord_user_id TEXT");
  }

  private reactionsFor(messageIds: string[]) {
    const grouped = new Map<string, Record<string, string[]>>();
    if (messageIds.length === 0) return grouped;
    const placeholders = messageIds.map(() => "?").join(",");
    const rows = this.database.prepare(`
      SELECT message_id, emoji, user_id
      FROM message_reactions
      WHERE message_id IN (${placeholders})
      ORDER BY rowid ASC
    `).all(...messageIds) as { message_id: string; emoji: string; user_id: string }[];
    for (const row of rows) {
      const reactions = grouped.get(row.message_id) ?? {};
      reactions[row.emoji] = [...(reactions[row.emoji] ?? []), row.user_id];
      grouped.set(row.message_id, reactions);
    }
    return grouped;
  }

  listPublicMessages(recentLimit = 500, pinnedLimit = 200) {
    const recent = this.database.prepare(`
      SELECT * FROM public_messages ORDER BY sent_at_ms DESC LIMIT ?
    `).all(recentLimit) as PublicMessageRow[];
    const pinned = this.database.prepare(`
      SELECT * FROM public_messages WHERE pinned = 1 ORDER BY sent_at_ms DESC LIMIT ?
    `).all(pinnedLimit) as PublicMessageRow[];
    const rows = [...new Map([...recent, ...pinned].map((row) => [row.id, row])).values()]
      .sort((left, right) => timestamp(left.sent_at) - timestamp(right.sent_at));
    const reactions = this.reactionsFor(rows.map((row) => row.id));
    return rows.map((row) => publicMessageFromRow(row, reactions.get(row.id)));
  }

  getPublicMessage(messageId: string) {
    const row = this.database.prepare("SELECT * FROM public_messages WHERE id = ?").get(messageId) as PublicMessageRow | undefined;
    if (!row) return undefined;
    return publicMessageFromRow(row, this.reactionsFor([row.id]).get(row.id));
  }

  insertPublicMessage(message: ChatMessage) {
    this.database.prepare(`
      INSERT INTO public_messages (
        id, channel_id, author, author_user_id, text, sent_at, sent_at_ms,
        edited_at, pinned, reply_to_id, reply_to_author, reply_to_text,
        author_avatar_url, file_name, file_url, file_size, file_expires_at,
        file_expires_at_ms, file_deleted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.channelId,
      message.author,
      message.authorUserId ?? null,
      message.text,
      message.sentAt,
      timestamp(message.sentAt),
      message.editedAt ?? null,
      message.pinned ? 1 : 0,
      message.replyTo?.id ?? null,
      message.replyTo?.author ?? null,
      message.replyTo?.text ?? null,
      message.authorAvatarUrl ?? null,
      message.file?.name ?? null,
      message.file?.url ?? null,
      message.file?.size ?? null,
      message.file?.expiresAt ?? null,
      message.file?.expiresAt ? timestamp(message.file.expiresAt) : null,
      message.file?.expired ? 1 : 0,
    );
  }

  backfillAttachmentExpiry(retentionMs: number) {
    this.database.prepare(`
      UPDATE public_messages
      SET file_expires_at_ms = sent_at_ms + ?,
          file_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', (sent_at_ms + ?) / 1000.0, 'unixepoch')
      WHERE file_url IS NOT NULL AND file_expires_at_ms IS NULL
    `).run(retentionMs, retentionMs);
    this.database.prepare(`
      UPDATE direct_messages
      SET file_expires_at_ms = sent_at_ms + ?,
          file_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', (sent_at_ms + ?) / 1000.0, 'unixepoch')
      WHERE file_url IS NOT NULL AND file_expires_at_ms IS NULL
    `).run(retentionMs, retentionMs);
  }

  attachmentByUrl(url: string) {
    const publicAttachment = this.database.prepare(`
      SELECT id, 'public' AS scope, NULL AS from_user_id, NULL AS to_user_id,
        NULL AS from_discord_user_id, NULL AS to_discord_user_id,
        file_name, file_url, file_size, file_expires_at, file_expires_at_ms, file_deleted
      FROM public_messages WHERE file_url = ? LIMIT 1
    `).get(url) as {
      id: string;
      scope: "public" | "direct";
      from_user_id: string | null;
      to_user_id: string | null;
      from_discord_user_id: string | null;
      to_discord_user_id: string | null;
      file_name: string;
      file_url: string;
      file_size: number;
      file_expires_at: string | null;
      file_expires_at_ms: number | null;
      file_deleted: number;
    } | undefined;
    if (publicAttachment) return publicAttachment;
    return this.database.prepare(`
      SELECT id, 'direct' AS scope, from_user_id, to_user_id,
        from_discord_user_id, to_discord_user_id,
        file_name, file_url, file_size, file_expires_at, file_expires_at_ms, file_deleted
      FROM direct_messages WHERE file_url = ? LIMIT 1
    `).get(url) as {
      id: string;
      scope: "public" | "direct";
      from_user_id: string | null;
      to_user_id: string | null;
      from_discord_user_id: string | null;
      to_discord_user_id: string | null;
      file_name: string;
      file_url: string;
      file_size: number;
      file_expires_at: string | null;
      file_expires_at_ms: number | null;
      file_deleted: number;
    } | undefined;
  }

  expiredAttachments(now = Date.now()) {
    return this.database.prepare(`
      SELECT id, file_url FROM public_messages
      WHERE file_url IS NOT NULL AND file_deleted = 0
        AND file_expires_at_ms IS NOT NULL AND file_expires_at_ms <= ?
      UNION ALL
      SELECT id, file_url FROM direct_messages
      WHERE file_url IS NOT NULL AND file_deleted = 0
        AND file_expires_at_ms IS NOT NULL AND file_expires_at_ms <= ?
    `).all(now, now) as { id: string; file_url: string }[];
  }

  markAttachmentDeleted(messageId: string) {
    this.database.prepare("UPDATE public_messages SET file_deleted = 1 WHERE id = ?").run(messageId);
    this.database.prepare("UPDATE direct_messages SET file_deleted = 1 WHERE id = ?").run(messageId);
  }

  editPublicMessage(messageId: string, text: string, editedAt: string) {
    this.database.prepare("UPDATE public_messages SET text = ?, edited_at = ? WHERE id = ?").run(text, editedAt, messageId);
  }

  deletePublicMessage(messageId: string) {
    this.database.prepare("DELETE FROM public_messages WHERE id = ?").run(messageId);
  }

  setPublicMessagePinned(messageId: string, pinned: boolean) {
    this.database.prepare("UPDATE public_messages SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, messageId);
  }

  toggleReaction(messageId: string, emoji: string, userId: string) {
    const existing = this.database.prepare(`
      SELECT 1 FROM message_reactions WHERE message_id = ? AND emoji = ? AND user_id = ?
    `).get(messageId, emoji, userId);
    if (existing) {
      this.database.prepare("DELETE FROM message_reactions WHERE message_id = ? AND emoji = ? AND user_id = ?")
        .run(messageId, emoji, userId);
      return false;
    }
    const reactionCount = this.database.prepare(`
      SELECT COUNT(*) AS count FROM message_reactions WHERE message_id = ? AND emoji = ?
    `).get(messageId, emoji) as { count: number };
    if (reactionCount.count >= 200) return false;
    this.database.prepare("INSERT INTO message_reactions (message_id, emoji, user_id) VALUES (?, ?, ?)")
      .run(messageId, emoji, userId);
    return true;
  }

  markChannelRead(userId: string, channelId: string) {
    const latest = this.database.prepare(`
      SELECT MAX(sent_at_ms) AS sent_at_ms FROM public_messages WHERE channel_id = ?
    `).get(channelId) as { sent_at_ms: number | null };
    const readAt = Math.max(Date.now(), latest.sent_at_ms ?? 0);
    this.database.prepare(`
      INSERT INTO channel_reads (user_id, channel_id, read_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id, channel_id) DO UPDATE SET read_at = excluded.read_at
    `).run(userId, channelId, readAt);
  }

  mergeChannelReadIdentity(targetUserId: string, sourceUserIds: string[]) {
    const sources = [...new Set(sourceUserIds.filter((userId) => userId && userId !== targetUserId))];
    if (sources.length === 0) return;
    const placeholders = sources.map(() => "?").join(",");
    const rows = this.database.prepare(`
      SELECT channel_id, MAX(read_at) AS read_at
      FROM channel_reads
      WHERE user_id IN (${placeholders})
      GROUP BY channel_id
    `).all(...sources) as { channel_id: string; read_at: number }[];
    const upsert = this.database.prepare(`
      INSERT INTO channel_reads (user_id, channel_id, read_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id, channel_id) DO UPDATE SET read_at = MAX(channel_reads.read_at, excluded.read_at)
    `);
    for (const row of rows) upsert.run(targetUserId, row.channel_id, row.read_at);
  }

  markChannelUnread(userId: string, channelId: string, authorUserIds = [userId]) {
    const ownAuthorIds = [...new Set(authorUserIds.filter(Boolean))];
    if (ownAuthorIds.length === 0) ownAuthorIds.push(userId);
    const authorPlaceholders = ownAuthorIds.map(() => "?").join(",");
    const latest = this.database.prepare(`
      SELECT sent_at_ms FROM public_messages
      WHERE channel_id = ? AND (author_user_id IS NULL OR author_user_id NOT IN (${authorPlaceholders}))
      ORDER BY sent_at_ms DESC LIMIT 1
    `).get(channelId, ...ownAuthorIds) as { sent_at_ms: number } | undefined;
    if (!latest) return 0;
    this.database.prepare(`
      INSERT INTO channel_reads (user_id, channel_id, read_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id, channel_id) DO UPDATE SET read_at = excluded.read_at
    `).run(userId, channelId, latest.sent_at_ms - 1);
    return 1;
  }

  channelUnreadFor(userId: string, channelIds: string[], authorUserIds = [userId]) {
    if (channelIds.length === 0) return {};
    const placeholders = channelIds.map(() => "?").join(",");
    const ownAuthorIds = [...new Set(authorUserIds.filter(Boolean))];
    if (ownAuthorIds.length === 0) ownAuthorIds.push(userId);
    const authorPlaceholders = ownAuthorIds.map(() => "?").join(",");
    const rows = this.database.prepare(`
      SELECT message.channel_id, COUNT(*) AS count
      FROM public_messages AS message
      LEFT JOIN channel_reads AS read
        ON read.user_id = ? AND read.channel_id = message.channel_id
      WHERE message.channel_id IN (${placeholders})
        AND message.sent_at_ms > COALESCE(read.read_at, 0)
        AND (message.author_user_id IS NULL OR message.author_user_id NOT IN (${authorPlaceholders}))
      GROUP BY message.channel_id
    `).all(userId, ...channelIds, ...ownAuthorIds) as { channel_id: string; count: number }[];
    return Object.fromEntries(rows.map((row) => [row.channel_id, Math.min(99, row.count)]));
  }

  insertDirectMessage(message: DirectMessage) {
    this.database.prepare(`
      INSERT INTO direct_messages (
        id, from_user_id, to_user_id, from_discord_user_id, to_discord_user_id, author, author_avatar_url,
        recipient, recipient_avatar_url, text, sent_at, sent_at_ms,
        file_name, file_url, file_size, file_expires_at, file_expires_at_ms, file_deleted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.fromUserId,
      message.toUserId,
      message.fromDiscordUserId ?? null,
      message.toDiscordUserId ?? null,
      message.author,
      message.authorAvatarUrl ?? null,
      message.recipient,
      message.recipientAvatarUrl ?? null,
      message.text,
      message.sentAt,
      timestamp(message.sentAt),
      message.file?.name ?? null,
      message.file?.url ?? null,
      message.file?.size ?? null,
      message.file?.expiresAt ?? null,
      message.file?.expiresAt ? timestamp(message.file.expiresAt) : null,
      message.file?.expired ? 1 : 0,
    );
  }

  getDirectMessage(messageId: string) {
    const row = this.database.prepare("SELECT * FROM direct_messages WHERE id = ? LIMIT 1").get(messageId) as DirectMessageRow | undefined;
    return row ? directMessageFromRow(row) : undefined;
  }

  deleteDirectMessage(messageId: string) {
    this.database.prepare("DELETE FROM direct_messages WHERE id = ?").run(messageId);
  }

  directHistoryFor(userId: string, limit = 500) {
    const rows = this.database.prepare(`
      SELECT * FROM direct_messages
      WHERE from_user_id = ? OR to_user_id = ?
      ORDER BY sent_at_ms DESC LIMIT ?
    `).all(userId, userId, limit) as DirectMessageRow[];
    return rows.reverse().map(directMessageFromRow);
  }

  directConversationBetween(firstUserId: string, secondUserId: string, limit = 500) {
    const rows = this.database.prepare(`
      SELECT * FROM direct_messages
      WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)
      ORDER BY sent_at_ms DESC LIMIT ?
    `).all(firstUserId, secondUserId, secondUserId, firstUserId, limit) as DirectMessageRow[];
    return rows.reverse().map(directMessageFromRow);
  }

  directConversationBetweenAny(firstUserIds: string[], secondUserIds: string[], limit = 500) {
    if (firstUserIds.length === 0 || secondUserIds.length === 0) return [];
    const firstPlaceholders = firstUserIds.map(() => "?").join(",");
    const secondPlaceholders = secondUserIds.map(() => "?").join(",");
    const rows = this.database.prepare(`
      SELECT * FROM direct_messages
      WHERE (from_user_id IN (${firstPlaceholders}) AND to_user_id IN (${secondPlaceholders}))
        OR (from_user_id IN (${secondPlaceholders}) AND to_user_id IN (${firstPlaceholders}))
      ORDER BY sent_at_ms DESC LIMIT ?
    `).all(
      ...firstUserIds,
      ...secondUserIds,
      ...secondUserIds,
      ...firstUserIds,
      limit,
    ) as DirectMessageRow[];
    return rows.reverse().map(directMessageFromRow);
  }

  directConversationBetweenDiscordUsers(firstDiscordUserId: string, secondDiscordUserId: string, limit = 500) {
    const rows = this.database.prepare(`
      SELECT * FROM direct_messages
      WHERE (from_discord_user_id = ? AND to_discord_user_id = ?)
        OR (from_discord_user_id = ? AND to_discord_user_id = ?)
      ORDER BY sent_at_ms DESC LIMIT ?
    `).all(firstDiscordUserId, secondDiscordUserId, secondDiscordUserId, firstDiscordUserId, limit) as DirectMessageRow[];
    return rows.reverse().map(directMessageFromRow);
  }

  backfillDirectDiscordIdentity(kafcordUserId: string, discordUserId: string) {
    this.database.prepare(`
      UPDATE direct_messages SET from_discord_user_id = ?
      WHERE from_user_id = ? AND from_discord_user_id IS NULL
    `).run(discordUserId, kafcordUserId);
    this.database.prepare(`
      UPDATE direct_messages SET to_discord_user_id = ?
      WHERE to_user_id = ? AND to_discord_user_id IS NULL
    `).run(discordUserId, kafcordUserId);
  }

  lastDirectMessageBetween(firstUserId: string, secondUserId: string) {
    const row = this.database.prepare(`
      SELECT * FROM direct_messages
      WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)
      ORDER BY sent_at_ms DESC LIMIT 1
    `).get(firstUserId, secondUserId, secondUserId, firstUserId) as DirectMessageRow | undefined;
    return row ? directMessageFromRow(row) : undefined;
  }

  directUnreadFor(userId: string) {
    const rows = this.database.prepare(`
      SELECT message.from_user_id, COUNT(*) AS count
      FROM direct_messages AS message
      LEFT JOIN direct_reads AS read
        ON read.user_id = ? AND read.peer_user_id = message.from_user_id
      WHERE message.to_user_id = ? AND message.sent_at_ms > COALESCE(read.read_at, 0)
      GROUP BY message.from_user_id
    `).all(userId, userId) as { from_user_id: string; count: number }[];
    return Object.fromEntries(rows.map((row) => [row.from_user_id, Math.min(99, row.count)]));
  }

  markDirectRead(userId: string, peerUserId: string) {
    const latest = this.database.prepare(`
      SELECT MAX(sent_at_ms) AS sent_at_ms FROM direct_messages
      WHERE from_user_id = ? AND to_user_id = ?
    `).get(peerUserId, userId) as { sent_at_ms: number | null };
    const readAt = Math.max(Date.now(), latest.sent_at_ms ?? 0);
    this.database.prepare(`
      INSERT INTO direct_reads (user_id, peer_user_id, read_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id, peer_user_id) DO UPDATE SET read_at = excluded.read_at
    `).run(userId, peerUserId, readAt);
  }

  updateDirectAvatar(userId: string, avatarUrl: string) {
    this.database.prepare("UPDATE direct_messages SET author_avatar_url = ? WHERE from_user_id = ? AND author_avatar_url IS NULL")
      .run(avatarUrl, userId);
    this.database.prepare("UPDATE direct_messages SET recipient_avatar_url = ? WHERE to_user_id = ? AND recipient_avatar_url IS NULL")
      .run(avatarUrl, userId);
  }

  deleteDirectDataForUser(userId: string) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM direct_messages WHERE from_user_id = ? OR to_user_id = ?").run(userId, userId);
      this.database.prepare("DELETE FROM direct_reads WHERE user_id = ? OR peer_user_id = ?").run(userId, userId);
      this.database.prepare("DELETE FROM channel_reads WHERE user_id = ?").run(userId);
      this.database.prepare("DELETE FROM message_reactions WHERE user_id = ?").run(userId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    if (this.database.isOpen) this.database.close();
  }
}
