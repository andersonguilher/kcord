import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore, type ChatMessage, type DirectMessage } from "../server/chat-store.ts";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "kafcord-chat-store-"));
const databasePath = join(temporaryDirectory, "chat.sqlite");
let store = new ChatStore(databasePath);

try {
  const first: ChatMessage = {
    id: "public-1",
    channelId: "geral",
    author: "Anderson",
    authorUserId: "user-1",
    text: "Mensagem original",
    sentAt: "2026-10-25T12:00:00.000Z",
  };
  const second: ChatMessage = {
    id: "public-2",
    channelId: "geral",
    author: "Convidado",
    authorUserId: "user-2",
    text: "Resposta",
    sentAt: "2026-10-25T12:01:00.000Z",
    replyTo: { id: first.id, author: first.author, text: first.text },
    file: {
      name: "manual.pdf",
      url: "/files/manual.pdf",
      size: 1234,
      expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    },
  };

  store.insertPublicMessage(first);
  store.insertPublicMessage(second);
  assert.equal(store.listPublicMessages().length, 2);
  assert.equal(store.attachmentByUrl(second.file!.url)?.file_name, second.file!.name);
  assert.equal(store.expiredAttachments().length, 0);
  assert.deepEqual(store.channelUnreadFor("user-1", ["geral"]), { geral: 1 });

  store.editPublicMessage(first.id, "Mensagem editada", "2026-10-25T12:02:00.000Z");
  store.toggleReaction(first.id, "👍", "user-2");
  store.setPublicMessagePinned(first.id, true);
  const persisted = store.getPublicMessage(first.id);
  assert.equal(persisted?.text, "Mensagem editada");
  assert.equal(persisted?.pinned, true);
  assert.deepEqual(persisted?.reactions, { "👍": ["user-2"] });

  store.close();
  store = new ChatStore(databasePath);
  const afterRestart = store.getPublicMessage(first.id);
  assert.equal(afterRestart?.text, "Mensagem editada");
  assert.equal(afterRestart?.pinned, true);
  assert.deepEqual(afterRestart?.reactions, { "👍": ["user-2"] });

  store.markChannelRead("user-1", "geral");
  assert.deepEqual(store.channelUnreadFor("user-1", ["geral"]), {});
  assert.equal(store.markChannelUnread("user-1", "geral"), 1);
  assert.deepEqual(store.channelUnreadFor("user-1", ["geral"]), { geral: 1 });
  store.mergeChannelReadIdentity("discord:1", ["user-1"]);
  store.insertPublicMessage({
    id: "public-alias",
    channelId: "geral",
    author: "Anderson antigo",
    authorUserId: "user-1-old",
    text: "Mensagem escrita por uma identidade anterior da mesma conta",
    sentAt: "2026-10-25T12:01:30.000Z",
  });
  assert.deepEqual(store.channelUnreadFor("discord:1", ["geral"], ["user-1", "user-1-old"]), { geral: 1 });
  store.markChannelRead("discord:1", "geral");
  assert.deepEqual(store.channelUnreadFor("discord:1", ["geral"], ["user-1", "user-1-old"]), {});

  store.toggleReaction(first.id, "👍", "user-2");
  assert.equal(store.getPublicMessage(first.id)?.reactions, undefined);
  store.deletePublicMessage(first.id);
  assert.equal(store.getPublicMessage(first.id), undefined);
  assert.equal(store.expiredAttachments(Date.now() + 4 * 24 * 60 * 60 * 1000)[0]?.id, second.id);
  store.markAttachmentDeleted(second.id);
  assert.equal(store.getPublicMessage(second.id)?.file?.expired, true);

  const direct: DirectMessage = {
    id: "direct-1",
    fromUserId: "user-2",
    toUserId: "user-1",
    author: "Convidado",
    recipient: "Anderson",
    text: "Mensagem privada",
    sentAt: "2026-10-25T12:03:00.000Z",
    file: {
      name: "privado.txt",
      url: "/files/privado.txt",
      size: 42,
      expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    },
  };
  store.insertDirectMessage(direct);
  store.backfillDirectDiscordIdentity("user-1", "discord-user-1");
  store.backfillDirectDiscordIdentity("user-2", "discord-user-2");
  assert.deepEqual(store.directUnreadFor("user-1"), { "user-2": 1 });
  assert.equal(store.directHistoryFor("user-1")[0]?.text, direct.text);
  assert.equal(store.directHistoryFor("user-1")[0]?.file?.name, direct.file?.name);
  assert.equal(store.directConversationBetween("user-1", "user-2")[0]?.file?.name, direct.file?.name);
  assert.equal(store.directConversationBetweenAny(["legacy-user-1", "user-1"], ["user-2"])[0]?.file?.name, direct.file?.name);
  assert.equal(store.directConversationBetweenDiscordUsers("discord-user-1", "discord-user-2")[0]?.file?.name, direct.file?.name);
  assert.equal(store.attachmentByUrl(direct.file!.url)?.file_name, direct.file!.name);
  assert.equal(store.attachmentByUrl(direct.file!.url)?.scope, "direct");
  assert.equal(store.lastDirectMessageBetween("user-1", "user-2")?.id, direct.id);
  assert.equal(store.getDirectMessage(direct.id)?.file?.name, direct.file?.name);
  const deletableDirect = { ...direct, id: "direct-delete", text: "apagar", file: undefined };
  store.insertDirectMessage(deletableDirect);
  store.deleteDirectMessage(deletableDirect.id);
  assert.equal(store.getDirectMessage(deletableDirect.id), undefined);

  store.markDirectRead("user-1", "user-2");
  assert.deepEqual(store.directUnreadFor("user-1"), {});
  store.deleteDirectDataForUser("user-2");
  assert.equal(store.directHistoryFor("user-1").length, 0);

  console.log("Smoke test aprovado: SQLite persiste mensagens, reações, fixados e leituras públicas e privadas.");
} finally {
  store.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
