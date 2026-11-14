import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVoiceRegistry, registerVoiceHandlers } from "../server/voice-handlers.ts";
import type { Member } from "../server/types.ts";

const community = {
  name: "Test",
  categories: [],
  textChannels: [],
  voiceChannels: [
    { id: "cafe", name: "Café", categoryId: null, position: 0 },
    { id: "estudio", name: "Estúdio", categoryId: null, position: 1 },
    { id: "afk", name: "AFK", categoryId: null, position: 2 },
  ],
  roles: [],
};

const jpeg = "data:image/jpeg;base64,AAAA";

type Ack = { ok: boolean; error?: string };

let httpServer: HttpServer;
let ioServer: Server;
let members: Map<string, Member>;
let clients: ClientSocket[];
let broadcasts: number;
let recordTraffic: ReturnType<typeof vi.fn>;
let ownerEnvironment: string | undefined;

function newMember(socketId: string, userId: string, name: string): Member {
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
  await settle();
  return client;
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Resolves true if the event never arrives within the window. */
async function never(client: ClientSocket, event: string, ms = 120) {
  const handler = vi.fn();
  client.on(event, handler);
  await settle(ms);
  client.off(event, handler);
  return handler.mock.calls.length === 0;
}

function memberFor(client: ClientSocket) {
  const found = members.get(client.id as string);
  if (!found) throw new Error("member not registered");
  return found;
}

async function joinVoice(client: ClientSocket, channelId: string) {
  client.emit("voice:join", { channelId });
  await settle();
}

beforeEach(async () => {
  ownerEnvironment = process.env.KAFCORD_OWNER_DISCORD_ID;
  process.env.KAFCORD_OWNER_DISCORD_ID = "discord-mod";
  members = new Map();
  clients = [];
  broadcasts = 0;
  recordTraffic = vi.fn();
  httpServer = createServer();
  ioServer = new Server(httpServer);
  const registry = createVoiceRegistry({ io: ioServer, members });
  ioServer.on("connection", (socket) => {
    const { userId, name } = socket.handshake.auth as { userId: string; name: string };
    members.set(socket.id, newMember(socket.id, userId, name));
    registerVoiceHandlers(socket, {
      io: ioServer,
      members,
      registry,
      getCommunity: () => community,
      isAfkChannel: (channelId) => channelId === "afk",
      recordTraffic,
      broadcastMembers: () => {
        broadcasts += 1;
      },
    });
    socket.on("disconnect", () => members.delete(socket.id));
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
});

afterEach(async () => {
  for (const client of clients) client.disconnect();
  await ioServer.close();
  if (ownerEnvironment === undefined) delete process.env.KAFCORD_OWNER_DISCORD_ID;
  else process.env.KAFCORD_OWNER_DISCORD_ID = ownerEnvironment;
});

describe("voice rooms", () => {
  it("ignores unknown channels and joins real ones, counting traffic once per change", async () => {
    const ana = await connectAs("ana");
    await joinVoice(ana, "nao-existe");
    expect(memberFor(ana).voiceChannelId).toBeNull();
    await joinVoice(ana, "cafe");
    expect(memberFor(ana).voiceChannelId).toBe("cafe");
    await joinVoice(ana, "cafe");
    expect(recordTraffic).toHaveBeenCalledTimes(1);
    expect(recordTraffic).toHaveBeenCalledWith({ voiceJoins: 1 }, "ana");
    expect(broadcasts).toBeGreaterThan(0);
  });

  it("tells a newcomer who is already in the room, and others when someone leaves", async () => {
    const ana = await connectAs("ana");
    const bia = await connectAs("bia");
    await joinVoice(ana, "cafe");
    const peers = nextEvent<string[]>(bia, "voice:peers");
    bia.emit("voice:join", { channelId: "cafe" });
    expect(await peers).toEqual([ana.id]);

    const left = nextEvent<string>(ana, "voice:member-left");
    bia.emit("voice:leave");
    expect(await left).toBe(bia.id);
    expect(memberFor(bia).voiceChannelId).toBeNull();
  });

  it("does not leak peers across rooms", async () => {
    const ana = await connectAs("ana");
    const bia = await connectAs("bia");
    await joinVoice(ana, "cafe");
    const peers = nextEvent<string[]>(bia, "voice:peers");
    bia.emit("voice:join", { channelId: "estudio" });
    expect(await peers).toEqual([]);
  });

  it("silences members who join the AFK channel and gives them no peers", async () => {
    const ana = await connectAs("ana");
    const bia = await connectAs("bia");
    await joinVoice(ana, "cafe");
    const peers = nextEvent<string[]>(bia, "voice:peers");
    bia.emit("voice:join", { channelId: "afk" });
    expect(await peers).toEqual([]);
    expect(memberFor(bia)).toMatchObject({ micEnabled: false, deafened: true, cameraEnabled: false, screenSharing: false });
  });

  it("applies voice:state only inside a room and keeps AFK members muted", async () => {
    const ana = await connectAs("ana");
    ana.emit("voice:state", { micEnabled: false, deafened: true });
    await settle();
    expect(memberFor(ana).deafened).toBe(false);

    await joinVoice(ana, "cafe");
    ana.emit("voice:state", { micEnabled: true, deafened: false, cameraEnabled: true, voiceDetected: true });
    await settle();
    expect(memberFor(ana)).toMatchObject({ micEnabled: true, cameraEnabled: true, voiceDetected: true });

    await joinVoice(ana, "afk");
    ana.emit("voice:state", { micEnabled: true, deafened: false, cameraEnabled: true });
    await settle();
    expect(memberFor(ana)).toMatchObject({ micEnabled: false, deafened: true, cameraEnabled: false });
  });
});

describe("moderation", () => {
  it("refuses mute, deafen, disconnect and move for regular members", async () => {
    const ana = await connectAs("ana");
    const bia = await connectAs("bia");
    await joinVoice(bia, "cafe");
    for (const action of ["mute", "deafen", "disconnect"]) {
      const result = await ask(ana, "voice:moderate-member", { targetSocketId: bia.id, action, enabled: true });
      expect(result.ok).toBe(false);
    }
    expect((await ask(ana, "voice:move-member", { targetSocketId: bia.id, channelId: "estudio" })).ok).toBe(false);
    expect(memberFor(bia).serverMuted).toBe(false);
    expect(memberFor(bia).voiceChannelId).toBe("cafe");
  });

  it("lets the owner mute a member, who then cannot re-enable the microphone", async () => {
    const mod = await connectAs("mod");
    const bia = await connectAs("bia");
    await joinVoice(bia, "cafe");
    const notice = nextEvent<{ serverMuted: boolean; action?: string }>(bia, "voice:moderation");
    const result = await ask(mod, "voice:moderate-member", { targetSocketId: bia.id, action: "mute", enabled: true });
    expect(result.ok).toBe(true);
    expect(await notice).toMatchObject({ serverMuted: true, action: "mute" });
    expect(memberFor(bia)).toMatchObject({ serverMuted: true, micEnabled: false });

    bia.emit("voice:state", { micEnabled: true });
    await settle();
    expect(memberFor(bia).micEnabled).toBe(false);
  });

  it("disconnects a member from voice and notifies them", async () => {
    const mod = await connectAs("mod");
    const bia = await connectAs("bia");
    await joinVoice(bia, "cafe");
    const notice = nextEvent<{ moderatedBy?: string }>(bia, "voice:disconnected");
    expect((await ask(mod, "voice:moderate-member", { targetSocketId: bia.id, action: "disconnect" })).ok).toBe(true);
    expect((await notice).moderatedBy).toBe("mod");
    expect(memberFor(bia).voiceChannelId).toBeNull();
  });

  it("validates targets: not in voice, self and unknown channel or action", async () => {
    const mod = await connectAs("mod");
    const bia = await connectAs("bia");
    expect((await ask(mod, "voice:moderate-member", { targetSocketId: bia.id, action: "mute", enabled: true })).ok).toBe(false);
    await joinVoice(bia, "cafe");
    await joinVoice(mod, "cafe");
    expect((await ask(mod, "voice:moderate-member", { targetSocketId: mod.id, action: "mute", enabled: true })).ok).toBe(false);
    expect((await ask(mod, "voice:moderate-member", { targetSocketId: bia.id, action: "ban" })).ok).toBe(false);
    expect((await ask(mod, "voice:move-member", { targetSocketId: bia.id, channelId: "nao-existe" })).ok).toBe(false);
    expect((await ask(mod, "voice:move-member", { targetSocketId: bia.id, channelId: "cafe" })).ok).toBe(false);
  });

  it("asks the target client to move when the owner moves them", async () => {
    const mod = await connectAs("mod");
    const bia = await connectAs("bia");
    await joinVoice(bia, "cafe");
    const moved = nextEvent<{ channelId: string; movedBy: string }>(bia, "voice:moved");
    expect((await ask(mod, "voice:move-member", { targetSocketId: bia.id, channelId: "estudio" })).ok).toBe(true);
    expect(await moved).toMatchObject({ channelId: "estudio", movedBy: "mod" });
  });
});

describe("screen sharing", () => {
  it("rejects invalid, oversized and AFK thumbnails instead of truncating them", async () => {
    const ana = await connectAs("ana");
    await joinVoice(ana, "cafe");
    ana.emit("screen:start", { thumbnail: "data:image/png;base64,AAAA" });
    ana.emit("screen:start", { thumbnail: `data:image/jpeg;base64,${"A".repeat(120_000)}` });
    await settle();
    expect(memberFor(ana).screenSharing).toBe(false);

    await joinVoice(ana, "afk");
    ana.emit("screen:start", { thumbnail: jpeg });
    await settle();
    expect(memberFor(ana).screenSharing).toBe(false);
  });

  it("announces a share to the room with sanitized resolution and lists it for newcomers", async () => {
    const ana = await connectAs("ana");
    const bia = await connectAs("bia");
    await joinVoice(ana, "cafe");
    await joinVoice(bia, "cafe");
    const available = nextEvent<{ peerId: string; resolutionWidth?: number; resolutionHeight?: number }>(bia, "screen:available");
    ana.emit("screen:start", { thumbnail: jpeg, resolutionWidth: 1920.4, resolutionHeight: 99_999 });
    const announced = await available;
    expect(announced).toMatchObject({ peerId: ana.id, resolutionWidth: 1920 });
    expect(announced.resolutionHeight).toBeUndefined();
    expect(memberFor(ana).screenSharing).toBe(true);
    expect(recordTraffic).toHaveBeenCalledWith({ screenShares: 1 }, "ana");

    const caio = await connectAs("caio");
    const list = nextEvent<Array<{ peerId: string }>>(caio, "screen:list");
    caio.emit("voice:join", { channelId: "cafe" });
    expect((await list).map((screen) => screen.peerId)).toEqual([ana.id]);
  });

  it("only lets members of the same room watch, and reports viewers to the sharer", async () => {
    const ana = await connectAs("ana");
    const bia = await connectAs("bia");
    const caio = await connectAs("caio");
    await joinVoice(ana, "cafe");
    await joinVoice(bia, "cafe");
    await joinVoice(caio, "estudio");
    ana.emit("screen:start", { thumbnail: jpeg });
    await settle();

    const outsiderJoined = never(ana, "screen:viewer-join");
    caio.emit("screen:subscribe", { target: ana.id });
    expect(await outsiderJoined).toBe(true);

    const joined = nextEvent<{ viewerId: string }>(ana, "screen:viewer-join");
    const count = nextEvent<{ count: number }>(ana, "screen:viewer-count");
    bia.emit("screen:subscribe", { target: ana.id });
    expect((await joined).viewerId).toBe(bia.id);
    expect((await count).count).toBe(1);

    const left = nextEvent<{ viewerId: string }>(ana, "screen:viewer-left");
    bia.emit("screen:unsubscribe", { target: ana.id });
    expect((await left).viewerId).toBe(bia.id);
  });

  it("stops the share for the room and clears the viewers when the sharer leaves voice", async () => {
    const ana = await connectAs("ana");
    const bia = await connectAs("bia");
    await joinVoice(ana, "cafe");
    await joinVoice(bia, "cafe");
    ana.emit("screen:start", { thumbnail: jpeg });
    await settle();
    const stopped = nextEvent<{ peerId: string }>(bia, "screen:stop");
    ana.emit("voice:leave");
    expect((await stopped).peerId).toBe(ana.id);
    expect(memberFor(ana).screenSharing).toBe(false);
  });

  it("updates the thumbnail only for an active share", async () => {
    const ana = await connectAs("ana");
    const bia = await connectAs("bia");
    await joinVoice(ana, "cafe");
    await joinVoice(bia, "cafe");
    const idle = never(bia, "screen:thumbnail");
    ana.emit("screen:thumbnail", { thumbnail: jpeg });
    expect(await idle).toBe(true);

    ana.emit("screen:start", { thumbnail: jpeg });
    await settle();
    const update = nextEvent<{ peerId: string; thumbnail: string }>(bia, "screen:thumbnail");
    ana.emit("screen:thumbnail", { thumbnail: "data:image/jpeg;base64,BBBB" });
    expect(await update).toEqual({ peerId: ana.id, thumbnail: "data:image/jpeg;base64,BBBB" });
  });
});

describe("signaling", () => {
  it("relays WebRTC signals only inside the same non-AFK room", async () => {
    const ana = await connectAs("ana");
    const bia = await connectAs("bia");
    const caio = await connectAs("caio");
    await joinVoice(ana, "cafe");
    await joinVoice(bia, "cafe");
    await joinVoice(caio, "estudio");

    const signal = nextEvent<{ from: string; description: unknown; candidate: unknown }>(bia, "rtc:signal");
    ana.emit("rtc:signal", { target: bia.id, description: { type: "offer", sdp: "v=0" } });
    expect(await signal).toEqual({ from: ana.id, description: { type: "offer", sdp: "v=0" } });

    const crossRoom = never(caio, "rtc:signal");
    ana.emit("rtc:signal", { target: caio.id, description: { type: "offer" } });
    expect(await crossRoom).toBe(true);

    await joinVoice(ana, "afk");
    await joinVoice(bia, "afk");
    const afk = never(bia, "rtc:signal");
    ana.emit("rtc:signal", { target: bia.id, candidate: { candidate: "x" } });
    expect(await afk).toBe(true);
  });

  it("forwards track metadata only for known kinds within the room", async () => {
    const ana = await connectAs("ana");
    const bia = await connectAs("bia");
    await joinVoice(ana, "cafe");
    await joinVoice(bia, "cafe");
    const invalid = never(bia, "media:track-meta");
    ana.emit("media:track-meta", { target: bia.id, trackId: "t1", kind: "malware" });
    ana.emit("media:track-meta", { target: bia.id, trackId: "", kind: "camera" });
    expect(await invalid).toBe(true);

    const meta = nextEvent<{ from: string; trackId: string; kind: string }>(bia, "media:track-meta");
    ana.emit("media:track-meta", { target: bia.id, trackId: "t1", kind: "screen" });
    expect(await meta).toEqual({ from: ana.id, trackId: "t1", kind: "screen" });
  });
});

describe("malformed payloads", () => {
  const events = [
    "voice:join",
    "voice:move-member",
    "voice:moderate-member",
    "voice:state",
    "voice:leave",
    "screen:list:request",
    "screen:start",
    "screen:thumbnail",
    "screen:stop",
    "screen:subscribe",
    "screen:unsubscribe",
    "media:track-meta",
    "rtc:signal",
  ];

  it("never crashes the server, whatever a client sends", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    try {
      const ana = await connectAs("ana");
      await joinVoice(ana, "cafe");
      for (const event of events) {
        for (const payload of [null, undefined, "texto", 42, [], {}, { target: { nested: true }, thumbnail: 5 }]) {
          ana.emit(event, payload);
        }
        // Acknowledgement variants must also tolerate garbage.
        ana.emit(event, null, () => undefined);
      }
      await settle(200);
      expect(uncaught).toEqual([]);
      const state = nextEvent(ana, "voice:peers");
      ana.emit("voice:join", { channelId: "estudio" });
      await state;
      expect(memberFor(ana).voiceChannelId).toBe("estudio");
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
});
