// One-off cleanup for messages posted before the channel content rules: links in
// the screenshot channel go to the links channel, images in the links channel go
// to the screenshot channel. Nothing else is touched and nothing is deleted.
//
//   node scripts/move-channel-messages.ts            lists what would move
//   node scripts/move-channel-messages.ts --apply    backs up the database, then moves
//
// Run from the application folder. The channel list comes from the database.

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { IMAGE_ATTACHMENT_PATTERN, firstMessageUrl, isLinksChannel, isScreenshotChannel } from "../shared/channel-rules.ts";

type Channel = { id: string; name: string };
type Row = { id: string; channel_id: string; author: string; text: string; sent_at: string; file_name: string | null };
export type Move = { id: string; from: string; to: string; author: string; sentAt: string; content: string };

function onlyChannel(channels: Channel[], matches: (name: string) => boolean, label: string) {
  const found = channels.filter((channel) => matches(channel.name));
  if (found.length !== 1) throw new Error(`Esperava exatamente um canal de ${label}; encontrei ${found.length}.`);
  return found[0];
}

/** Which messages belong in the other channel, and how many fit neither of the two. */
export function planChannelMoves(database: DatabaseSync, channels: Channel[]) {
  const links = onlyChannel(channels, isLinksChannel, "links");
  const screenshots = onlyChannel(channels, isScreenshotChannel, "screenshot");
  if (links.id === screenshots.id) throw new Error("O mesmo canal é de links e de screenshot.");
  const rows = database.prepare(`
    SELECT id, channel_id, author, text, sent_at, file_name FROM public_messages
    WHERE channel_id IN (?, ?) ORDER BY sent_at_ms
  `).all(links.id, screenshots.id) as Row[];

  const moves: Move[] = [];
  const unmatched = { [links.name]: 0, [screenshots.name]: 0 };
  for (const row of rows) {
    const isImage = row.file_name !== null && IMAGE_ATTACHMENT_PATTERN.test(row.file_name);
    const isLink = row.file_name === null && firstMessageUrl(row.text) !== null;
    const inLinks = row.channel_id === links.id;
    if (inLinks ? isLink : isImage) continue;
    const [source, target] = inLinks ? [links, screenshots] : [screenshots, links];
    if (inLinks ? !isImage : !isLink) {
      unmatched[source.name] += 1;
      continue;
    }
    moves.push({ id: row.id, from: source.id, to: target.id, author: row.author, sentAt: row.sent_at, content: row.file_name ?? row.text });
  }
  return { links, screenshots, moves, unmatched };
}

export function applyChannelMoves(database: DatabaseSync, moves: Move[]) {
  const update = database.prepare("UPDATE public_messages SET channel_id = ? WHERE id = ? AND channel_id = ?");
  database.exec("BEGIN IMMEDIATE");
  try {
    let moved = 0;
    for (const move of moves) moved += Number(update.run(move.to, move.id, move.from).changes);
    database.exec("COMMIT");
    return moved;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** The community's text channels, as the server stored them in the database. */
export function storedTextChannels(database: DatabaseSync) {
  const row = database.prepare("SELECT value FROM app_state WHERE key = 'community'").get() as { value: string } | undefined;
  if (!row) throw new Error("A comunidade não está salva no banco.");
  return (JSON.parse(row.value) as { textChannels: Channel[] }).textChannels;
}

function main() {
  const apply = process.argv.includes("--apply");
  const databasePath = process.env.KAFCORD_CHAT_DATABASE_PATH?.trim() || join(process.cwd(), "data", "kafcord.sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: !apply });
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const { links, screenshots, moves, unmatched } = planChannelMoves(database, storedTextChannels(database));
    const nameOf = (id: string) => (id === links.id ? links.name : screenshots.name);
    for (const move of moves) {
      console.log(`#${nameOf(move.from)} -> #${nameOf(move.to)} | ${move.sentAt} | ${move.author} | ${move.content.replace(/\s+/g, " ").slice(0, 90)}`);
    }
    console.log(`\n${moves.length} mensagem(ns) para mover.`);
    for (const [name, count] of Object.entries(unmatched)) {
      if (count) console.log(`${count} mensagem(ns) em #${name} não são link nem imagem e ficam onde estão.`);
    }
    if (!apply) {
      console.log("Nada foi alterado. Use --apply para mover.");
      return;
    }
    if (moves.length === 0) return;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
    const folder = dirname(databasePath);
    const backupPath = join(folder, `kafcord-before-channel-move-${stamp}.sqlite`);
    database.prepare("VACUUM INTO ?").run(backupPath);
    const logPath = join(folder, `channel-move-${stamp}.json`);
    writeFileSync(logPath, `${JSON.stringify(moves.map(({ id, from, to }) => ({ id, from, to })), null, 2)}\n`, { mode: 0o600 });
    console.log(`Backup: ${backupPath}\nRegistro: ${logPath}`);
    console.log(`${applyChannelMoves(database, moves)} mensagem(ns) movida(s).`);
  } finally {
    database.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
