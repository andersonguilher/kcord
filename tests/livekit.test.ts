import type { Server } from "node:http";
import express from "express";
import { TokenVerifier } from "livekit-server-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueLiveKitToken, liveKitRoomName, readLiveKitConfig, usesLiveKit, type LiveKitConfig } from "../server/livekit.ts";
import { createLiveKitRouter } from "../server/livekit-routes.ts";
import type { Member } from "../server/types.ts";

const environment = {
  LIVEKIT_URL: "wss://example.test/livekit",
  LIVEKIT_API_KEY: "devkey",
  LIVEKIT_API_SECRET: "a-long-test-secret-that-is-at-least-32-chars",
  LIVEKIT_VOICE_CHANNEL_IDS: "cafe,estudio",
};

const config: LiveKitConfig = readLiveKitConfig(environment) as LiveKitConfig;

async function decode(token: string) {
  return new TokenVerifier(config.apiKey, config.apiSecret).verify(token);
}

describe("reading the configuration", () => {
  it("is off unless every setting is present", () => {
    expect(readLiveKitConfig({})).toBeNull();
    for (const missing of Object.keys(environment)) {
      const partial = { ...environment, [missing]: "" };
      expect(readLiveKitConfig(partial), `without ${missing}`).toBeNull();
    }
  });

  it("only accepts a WebSocket URL", () => {
    expect(readLiveKitConfig({ ...environment, LIVEKIT_URL: "https://example.test" })).toBeNull();
    expect(readLiveKitConfig({ ...environment, LIVEKIT_URL: "example.test" })).toBeNull();
    expect(readLiveKitConfig({ ...environment, LIVEKIT_URL: "ws://localhost:7880" })?.url).toBe("ws://localhost:7880");
  });

  it("reads a list of channels, trimming spaces and empty entries", () => {
    const parsed = readLiveKitConfig({ ...environment, LIVEKIT_VOICE_CHANNEL_IDS: " cafe , ,estudio ," });
    const channels = parsed?.channelIds as Set<string>;
    expect([...channels]).toEqual(["cafe", "estudio"]);
  });

  it("reads * as every channel, and refuses a list with nothing in it", () => {
    expect(readLiveKitConfig({ ...environment, LIVEKIT_VOICE_CHANNEL_IDS: "*" })?.channelIds).toBe("*");
    expect(readLiveKitConfig({ ...environment, LIVEKIT_VOICE_CHANNEL_IDS: " , ," })).toBeNull();
  });
});

describe("which channels use LiveKit", () => {
  it("never does without a configuration", () => {
    expect(usesLiveKit(null, "cafe")).toBe(false);
  });

  it("follows the configured list", () => {
    expect(usesLiveKit(config, "cafe")).toBe(true);
    expect(usesLiveKit(config, "outra")).toBe(false);
  });

  it("serves every channel for *", () => {
    const all = readLiveKitConfig({ ...environment, LIVEKIT_VOICE_CHANNEL_IDS: "*" });
    expect(usesLiveKit(all, "qualquer")).toBe(true);
  });

  it("names the room after the channel", () => {
    expect(liveKitRoomName("cafe")).toBe("voice:cafe");
  });
});

describe("the token", () => {
  const request = { identity: "socket-1", name: "Ana", channelId: "cafe", serverMuted: false, serverDeafened: false };

  it("is signed with the configured secret, for one room and one identity", async () => {
    const { url, token } = await issueLiveKitToken(config, request);
    expect(url).toBe(config.url);
    const claims = await decode(token);
    expect(claims.sub).toBe("socket-1");
    expect(claims.name).toBe("Ana");
    expect(claims.iss).toBe("devkey");
    expect(claims.video).toMatchObject({ roomJoin: true, room: "voice:cafe" });
  });

  it("is only good for joining for ten minutes", async () => {
    const claims = await decode((await issueLiveKitToken(config, request)).token);
    expect((claims.exp ?? 0) - (claims.nbf ?? 0)).toBe(600);
  });

  it("lets a normal member publish microphone, camera and screen, and listen", async () => {
    const { video } = await decode((await issueLiveKitToken(config, request)).token);
    expect(video).toMatchObject({ canPublish: true, canSubscribe: true, canPublishData: false });
    expect(video?.canPublishSources).toEqual(expect.arrayContaining(["microphone", "camera", "screen_share", "screen_share_audio"]));
  });

  it("takes the microphone away from a member the server muted, but not camera or screen", async () => {
    const { video } = await decode((await issueLiveKitToken(config, { ...request, serverMuted: true })).token);
    expect(video?.canPublishSources).not.toContain("microphone");
    expect(video?.canPublishSources).toEqual(expect.arrayContaining(["camera", "screen_share"]));
  });

  it("stops a member the server deafened from receiving anything", async () => {
    const { video } = await decode((await issueLiveKitToken(config, { ...request, serverDeafened: true })).token);
    expect(video?.canSubscribe).toBe(false);
    expect(video?.canPublish).toBe(true);
  });

  it("never lets a member publish arbitrary data", async () => {
    const { video } = await decode((await issueLiveKitToken(config, request)).token);
    expect(video?.canPublishData).toBe(false);
  });

  it("truncates a very long display name", async () => {
    const claims = await decode((await issueLiveKitToken(config, { ...request, name: "n".repeat(300) })).token);
    expect(claims.name).toHaveLength(64);
  });

  it("is rejected by anyone holding a different secret", async () => {
    const { token } = await issueLiveKitToken(config, request);
    await expect(new TokenVerifier("devkey", "another-secret-that-is-also-long-enough-32").verify(token)).rejects.toThrow();
  });
});

describe("POST /api/livekit/token", () => {
  let server: Server;
  let base: string;
  let members: Map<string, Member>;
  let signedIn: { discordUserId: string } | null;
  let afkChannel: string;

  function member(socketId: string, extra: Partial<Member> = {}): Member {
    return {
      socketId, name: "Ana", voiceChannelId: null, authenticated: true, discordUserId: "discord-ana",
      authDiscordUserId: "discord-ana", kafcordUserId: "user-ana", roleIds: [], micEnabled: true, deafened: false,
      serverMuted: false, serverDeafened: false, cameraEnabled: false, screenSharing: false, voiceDetected: false,
      lastActiveAt: 0, ...extra,
    } as Member;
  }

  async function start(routerConfig: LiveKitConfig | null = config) {
    const app = express();
    app.use(express.json());
    app.use(createLiveKitRouter({
      config: routerConfig,
      members,
      getCommunity: () => ({ name: "T", categories: [], roles: [], textChannels: [], voiceChannels: [
        { id: "cafe", name: "Café", categoryId: null, position: 0 },
        { id: "afk", name: "AFK", categoryId: null, position: 1 },
        { id: "outra", name: "Outra", categoryId: null, position: 2 },
      ] }),
      identify: () => signedIn,
      isAfkChannel: (channelId) => channelId === afkChannel,
    }));
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    base = `http://127.0.0.1:${address.port}`;
  }

  const post = (body: unknown) => fetch(`${base}/api/livekit/token`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

  beforeEach(() => {
    members = new Map([["sock-1", member("sock-1")]]);
    signedIn = { discordUserId: "discord-ana" };
    afkChannel = "afk";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    vi.restoreAllMocks();
  });

  it("answers 404, as if it did not exist, when LiveKit is not configured", async () => {
    await start(null);
    expect((await post({ socketId: "sock-1", channelId: "cafe" })).status).toBe(404);
  });

  it("requires a signed-in account", async () => {
    await start();
    signedIn = null;
    expect((await post({ socketId: "sock-1", channelId: "cafe" })).status).toBe(401);
  });

  it("only serves the owner of the live socket", async () => {
    await start();
    expect((await post({ socketId: "unknown", channelId: "cafe" })).status).toBe(409);
    signedIn = { discordUserId: "discord-someone-else" };
    expect((await post({ socketId: "sock-1", channelId: "cafe" })).status).toBe(409);
    members.set("guest", member("guest", { kafcordUserId: undefined }));
    signedIn = { discordUserId: "discord-ana" };
    expect((await post({ socketId: "guest", channelId: "cafe" })).status).toBe(409);
  });

  it("survives a malformed body, never answering with a server error", async () => {
    await start();
    // The JSON parser turns away bare null, strings and numbers before the endpoint is reached.
    for (const body of [null, "texto", 42]) expect((await post(body)).status).toBe(400);
    // Anything that parses but names no live socket is refused as a changed session.
    for (const body of [[], {}, { socketId: { nested: true } }]) expect((await post(body)).status).toBe(409);
  });

  it("refuses channels that do not exist or are not served by LiveKit", async () => {
    await start();
    expect((await post({ socketId: "sock-1", channelId: "nao-existe" })).status).toBe(404);
    expect((await post({ socketId: "sock-1", channelId: "outra" })).status).toBe(404);
  });

  it("gives the AFK channel no voice", async () => {
    await start(readLiveKitConfig({ ...environment, LIVEKIT_VOICE_CHANNEL_IDS: "cafe,afk" }));
    expect((await post({ socketId: "sock-1", channelId: "afk" })).status).toBe(403);
  });

  it("issues a token with the socket id as identity, and never caches it", async () => {
    await start();
    const response = await post({ socketId: "sock-1", channelId: "cafe" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { url, token } = await response.json() as { url: string; token: string };
    expect(url).toBe(config.url);
    const claims = await decode(token);
    expect(claims.sub).toBe("sock-1");
    expect(claims.video?.room).toBe("voice:cafe");
  });

  it("reflects the member's moderation state in the token", async () => {
    members.set("sock-1", member("sock-1", { serverMuted: true, serverDeafened: true }));
    await start();
    const { token } = await (await post({ socketId: "sock-1", channelId: "cafe" })).json() as { token: string };
    const { video } = await decode(token);
    expect(video?.canPublishSources).not.toContain("microphone");
    expect(video?.canSubscribe).toBe(false);
  });
});
