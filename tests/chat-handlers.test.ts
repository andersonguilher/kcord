import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatStore } from "../server/chat-store.ts";
import { registerChatHandlers } from "../server/chat-handlers.ts";
import type { Member } from "../server/types.ts";

const communityRoom = "community:test";
const community = {
  name: "Test",
  categories: [],
  textChannels: [
    { id: "geral", name: "geral", description: "", categoryId: null, position: 0 },
    { id: "outro", name: "outro", description: "", categoryId: null, position: 1 },
  ],
  voiceChannels: [],
  roles: [],
};

type Ack = { ok: boolean; error?: string; messages?: Array<{ id: string }> };

let directory: string;
let httpServer: HttpServer;
let ioServer: Server;
let store: ChatStore;
let members: Map<string, Member>;
let clients: ClientSocket[];
let recordTraffic: ReturnType<typeof vi.fn>;
let readUserIds: string[];

function member(socketId: string, userId: string, name: string): Member {
  return {
    socketId,
    name,
    voiceChannelId: null,
    authenticated: true,
    discordUserId: `discord-${userId}`,
    authDiscordUserId: `discord-${userId}`,
    kafcordUserId: userId,
    metricsUserId: userId,
    roleIds: [],
    avatarUrl: null,
    micEnabled: true,
    deafened: false,
    serverMuted: false,
    serverDeafened: false,
    cameraEnabled: false,
    screenSharing: false,
    voiceDetected: false,
    lastActiveAt: 0,
  };
}

/** Connects a client; `userId` empty means a guest without a KCord user id. */
async function connectAs(userId: string, name = userId): Promise<ClientSocket> {
  const client = connect(`http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`, {
    transports: ["websocket"],
    auth: { userId, name },
    forceNew: true,
  });
  clients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve());
    client.once("connect_error", reject);
  });
  // Let the server finish registering the connection before the test emits.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return client;
}

function ask(client: ClientSocket, event: string, payload: unknown): Promise<Ack> {
  return new Promise((resolve) => client.emit(event, payload, resolve));
}

function nextEvent<T = unknown>(client: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), 2000);
    client.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "kcord-chat-"));
  store = new ChatStore(join(directory, "chat.sqlite"));
  members = new Map();
  clients = [];
  readUserIds = [];
  recordTraffic = vi.fn();
  httpServer = createServer();
  ioServer = new Server(httpServer);
  ioServer.on("connection", (socket) => {
    const { userId, name } = socket.handshake.auth as { userId: string; name: string };
    const joined = member(socket.id, userId, name);
    if (!userId) joined.kafcordUserId = undefined;
    members.set(socket.id, joined);
    void socket.join(communityRoom);
    registerChatHandlers(socket, {
      io: ioServer,
      communityRoom,
      members,
      chatStore: store,
      getCommunity: () => community,
      recordTraffic,
      deleteStoredUpload: () => undefined,
      warmChannelLinkPreview: () => undefined,
      syncAuthenticatedMemberAvatar: () => false,
      broadcastMembers: () => undefined,
      channelReadUserIdFor: (current) => current.kafcordUserId ?? "",
      channelAuthorUserIdsFor: (current) => [current.kafcordUserId ?? ""],
      broadcastChannelReadState: (_member, channelId) => readUserIds.push(channelId),
      directConversationFor: (requester, peerUserId) => store.directConversationBetween(requester.kafcordUserId ?? "", peerUserId),
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
});

afterEach(async () => {
  for (const client of clients) client.disconnect();
  await ioServer.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("channel chat", () => {
  it("stores and broadcasts a message, trimming the text and counting traffic", async () => {
    const ana = await connectAs("user-1", "Ana");
    const bia = await connectAs("user-2", "Bia");
    const received = nextEvent<{ text: string; author: string; channelId: string }>(bia, "chat:message");
    ana.emit("chat:send", { channelId: "outro", text: "  olá  " });
    const message = await received;
    expect(message).toMatchObject({ text: "olá", author: "Ana", channelId: "outro" });
    expect(store.listPublicMessages()).toHaveLength(1);
    expect(recordTraffic).toHaveBeenCalledWith({ publicMessages: 1 }, "user-1");
  });

  it("falls back to the first channel for unknown channels and ignores empty text", async () => {
    const ana = await connectAs("user-1", "Ana");
    const received = nextEvent<{ channelId: string }>(ana, "chat:message");
    ana.emit("chat:send", { channelId: "inexistente", text: "   " });
    ana.emit("chat:send", { channelId: "inexistente", text: "oi" });
    expect((await received).channelId).toBe("geral");
    expect(store.listPublicMessages()).toHaveLength(1);
  });

  it("only links a reply to a message in the same channel", async () => {
    const ana = await connectAs("user-1", "Ana");
    const first = nextEvent<{ id: string }>(ana, "chat:message");
    ana.emit("chat:send", { channelId: "geral", text: "original" });
    const { id } = await first;
    const sameChannel = nextEvent<{ replyTo?: { id: string } }>(ana, "chat:message");
    ana.emit("chat:send", { channelId: "geral", text: "resposta", replyToId: id });
    expect((await sameChannel).replyTo?.id).toBe(id);
    const otherChannel = nextEvent<{ replyTo?: { id: string } }>(ana, "chat:message");
    ana.emit("chat:send", { channelId: "outro", text: "outra", replyToId: id });
    expect((await otherChannel).replyTo).toBeUndefined();
  });

  it("lets only the author edit, and only with non-empty text", async () => {
    const ana = await connectAs("user-1", "Ana");
    const bia = await connectAs("user-2", "Bia");
    const sent = nextEvent<{ id: string }>(ana, "chat:message");
    ana.emit("chat:send", { channelId: "geral", text: "v1" });
    const { id } = await sent;

    expect((await ask(bia, "chat:edit", { messageId: id, text: "hack" })).ok).toBe(false);
    expect((await ask(ana, "chat:edit", { messageId: id, text: "   " })).ok).toBe(false);
    const updated = nextEvent<{ text: string; editedAt?: string }>(bia, "chat:update");
    expect((await ask(ana, "chat:edit", { messageId: id, text: " v2 " })).ok).toBe(true);
    expect(await updated).toMatchObject({ text: "v2" });
    expect(store.getPublicMessage(id)?.text).toBe("v2");
  });

  it("lets only the author (or a moderator) delete", async () => {
    const ana = await connectAs("user-1", "Ana");
    const bia = await connectAs("user-2", "Bia");
    const sent = nextEvent<{ id: string }>(ana, "chat:message");
    ana.emit("chat:send", { channelId: "geral", text: "apagar" });
    const { id } = await sent;

    const denied = await ask(bia, "chat:delete", { messageId: id });
    expect(denied.ok).toBe(false);
    expect(store.getPublicMessage(id)).toBeDefined();

    const deleted = nextEvent<{ messageId: string }>(bia, "chat:delete");
    expect((await ask(ana, "chat:delete", { messageId: id })).ok).toBe(true);
    expect((await deleted).messageId).toBe(id);
    expect(store.getPublicMessage(id)).toBeUndefined();
  });

  it("accepts only the allowed reactions and toggles them", async () => {
    const ana = await connectAs("user-1", "Ana");
    const sent = nextEvent<{ id: string }>(ana, "chat:message");
    ana.emit("chat:send", { channelId: "geral", text: "reaja" });
    const { id } = await sent;

    expect(await ask(ana, "chat:react", { messageId: id, emoji: "💩" })).toMatchObject({ ok: false, error: "Reação inválida." });
    expect((await ask(ana, "chat:react", { messageId: id, emoji: "👍" })).ok).toBe(true);
    expect(store.getPublicMessage(id)?.reactions?.["👍"]).toEqual(["user-1"]);
    expect((await ask(ana, "chat:react", { messageId: id, emoji: "👍" })).ok).toBe(true);
    expect(store.getPublicMessage(id)?.reactions?.["👍"]).toBeUndefined();
  });

  it("refuses to pin without moderation permission", async () => {
    const ana = await connectAs("user-1", "Ana");
    const sent = nextEvent<{ id: string }>(ana, "chat:message");
    ana.emit("chat:send", { channelId: "geral", text: "fixar" });
    const { id } = await sent;
    expect(await ask(ana, "chat:pin", { messageId: id, pinned: true })).toMatchObject({ ok: false });
    expect(store.getPublicMessage(id)?.pinned).toBeFalsy();
  });

  it("marks only real channels as read", async () => {
    const ana = await connectAs("user-1", "Ana");
    expect((await ask(ana, "chat:read", { channelId: "geral" })).ok).toBe(true);
    expect((await ask(ana, "chat:read", { channelId: "nao-existe" })).ok).toBe(false);
    expect((await ask(ana, "chat:mark-unread", { channelId: "geral" })).ok).toBe(true);
    expect(readUserIds).toEqual(["geral", "geral"]);
  });

  it("survives malformed payloads", async () => {
    const ana = await connectAs("user-1", "Ana");
    for (const payload of [null, undefined, "texto", 42, [], { text: { nested: true } }]) {
      ana.emit("chat:send", payload);
    }
    expect((await ask(ana, "chat:edit", null)).ok).toBe(false);
    expect((await ask(ana, "chat:react", [])).ok).toBe(false);
    expect((await ask(ana, "dm:send", "lixo")).ok).toBe(false);
    const ok = nextEvent<{ text: string }>(ana, "chat:message");
    ana.emit("chat:send", { text: "ainda funciona" });
    expect((await ok).text).toBe("ainda funciona");
  });
});

describe("direct messages", () => {
  it("rejects guests, self-messages, empty text and unknown recipients", async () => {
    const guest = await connectAs("", "Visitante");
    const ana = await connectAs("user-1", "Ana");
    expect((await ask(guest, "dm:send", { recipientUserId: "user-1", text: "oi" })).ok).toBe(false);
    expect((await ask(ana, "dm:send", { recipientUserId: "user-1", text: "eu" })).ok).toBe(false);
    expect((await ask(ana, "dm:send", { recipientUserId: "user-2", text: "   " })).ok).toBe(false);
    expect(await ask(ana, "dm:send", { recipientUserId: "ninguem", text: "oi" })).toMatchObject({
      ok: false,
      error: "Esse usuário não está disponível para mensagens.",
    });
  });

  it("delivers a message to both participants and keeps third parties out", async () => {
    const ana = await connectAs("user-1", "Ana");
    const bia = await connectAs("user-2", "Bia");
    const caio = await connectAs("user-3", "Caio");
    const toBia = nextEvent<{ text: string; fromUserId: string; recipient: string }>(bia, "dm:message");
    const toAna = nextEvent<{ text: string }>(ana, "dm:message");
    const leaked = vi.fn();
    caio.on("dm:message", leaked);
    expect((await ask(ana, "dm:send", { recipientUserId: "user-2", text: " segredo " })).ok).toBe(true);
    expect(await toBia).toMatchObject({ text: "segredo", fromUserId: "user-1", recipient: "Bia" });
    expect((await toAna).text).toBe("segredo");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(leaked).not.toHaveBeenCalled();
    expect(recordTraffic).toHaveBeenCalledWith({ privateMessages: 1 }, "user-1");
  });

  it("returns history to participants and refuses invalid peers", async () => {
    const ana = await connectAs("user-1", "Ana");
    await connectAs("user-2", "Bia");
    await ask(ana, "dm:send", { recipientUserId: "user-2", text: "um" });
    const history = await ask(ana, "dm:history", { peerUserId: "user-2" });
    expect(history.ok).toBe(true);
    expect(history.messages).toHaveLength(1);
    expect((await ask(ana, "dm:history", { peerUserId: "user-1" })).ok).toBe(false);
    expect((await ask(ana, "dm:history", { peerUserId: "ninguem" })).ok).toBe(false);
  });

  it("lets only the sender delete a private message and notifies both sides", async () => {
    const ana = await connectAs("user-1", "Ana");
    const bia = await connectAs("user-2", "Bia");
    const delivered = nextEvent<{ id: string }>(bia, "dm:message");
    await ask(ana, "dm:send", { recipientUserId: "user-2", text: "apague" });
    const { id } = await delivered;

    expect((await ask(bia, "dm:delete", { messageId: id })).ok).toBe(false);
    expect(store.getDirectMessage(id)).toBeDefined();

    const notified = nextEvent<{ messageId: string }>(bia, "dm:delete");
    expect((await ask(ana, "dm:delete", { messageId: id })).ok).toBe(true);
    expect((await notified).messageId).toBe(id);
    expect(store.getDirectMessage(id)).toBeUndefined();
  });
});
