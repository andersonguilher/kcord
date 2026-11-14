// Isolated server check: one live session per Discord account (newest device wins)
// and a silent AFK channel. Uses a throwaway data folder and fake sessions only.
import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { io } from "socket.io-client";

const repo = process.cwd();
const work = mkdtempSync(join(tmpdir(), "kcord-session-afk-"));
mkdirSync(join(work, "data"), { recursive: true });

const secret = "single-session-test-secret";
const sign = (id) => `${id}.${createHmac("sha256", secret).update(id).digest("base64url")}`;
const session = (id, discordId, name) => ({
  id, purpose: "login", kafcordUserId: `user-${discordId}`, memberships: [], guilds: [],
  user: { id: discordId, username: name, global_name: name, avatar: null },
  expiresAt: Date.now() + 3_600_000,
});
writeFileSync(join(work, "data", "auth-sessions.json"), JSON.stringify([
  session("pc-session", "111111111111111111", "Anderson"),
  session("phone-session", "111111111111111111", "Anderson"),
  session("friend-session", "222222222222222222", "Amigo"),
]));

writeFileSync(join(work, "data", "community.json"), JSON.stringify({
  name: "KCord", categories: [], roles: [],
  textChannels: [{ id: "geral", name: "geral", description: "x", categoryId: null, position: 0 }],
  voiceChannels: [
    { id: "cafe", name: "Café aberto", categoryId: null, position: 0 },
    { id: "dormiu", name: "DORMIU DANÇOU", categoryId: null, position: 1 },
  ],
  afkChannelId: "dormiu",
}));

const port = Number(process.env.KCORD_TEST_PORT ?? 3311);
const server = spawn(process.execPath, [join(repo, "node_modules/tsx/dist/cli.mjs"), join(repo, "server/index.ts")], {
  cwd: work,
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", SESSION_SECRET: secret, DISCORD_CLIENT_ID: "x", DISCORD_CLIENT_SECRET: "x", DISCORD_BOT_TOKEN: "x", DISCORD_REDIRECT_URI: `http://127.0.0.1:${port}/auth/discord/callback`, KAFCORD_OWNER_DISCORD_ID: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d; });
server.stderr.on("data", (d) => { serverLog += d; });
const url = `http://127.0.0.1:${port}`;
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${url}/api/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

const wait = (socket, event, ms = 4000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout waiting ${event}`)), ms);
  socket.once(event, (payload) => { clearTimeout(t); resolve(payload); });
});
const client = async (sessionId) => {
  const socket = io(url, { transports: ["websocket"], forceNew: true, reconnection: false, extraHeaders: { cookie: `kafcord_session=${sign(sessionId)}` } });
  await wait(socket, "connect");
  const ready = wait(socket, "session:ready");
  socket.emit("session:join", { name: "x" });
  await ready;
  return socket;
};

try {
  const friend = await client("friend-session");
  const pc = await client("pc-session");
  pc.emit("voice:join", { channelId: "cafe" });
  await new Promise((r) => setTimeout(r, 300));

  const replaced = wait(pc, "session:replaced");
  const pcDisconnected = wait(pc, "disconnect");
  const listAfterPhone = new Promise((resolve) => {
    const handler = (list) => { if (list.filter((m) => m.discordUserId === "111111111111111111").length === 1 && !list.some((m) => m.voiceChannelId)) { friend.off("members:update", handler); resolve(list); } };
    friend.on("members:update", handler);
  });
  const phone = await client("phone-session");
  await replaced;
  assert.equal(await pcDisconnected, "io server disconnect");
  const list = await listAfterPhone;
  const anderson = list.filter((m) => m.discordUserId === "111111111111111111");
  assert.equal(anderson.length, 1);
  assert.equal(anderson[0].socketId, phone.id);
  console.log("OK celular substitui PC: PC recebeu session:replaced, foi desconectado e saiu da voz; lista tem 1 Anderson.");

  // "Usar aqui" on the PC takes the session back from the phone.
  const phoneReplaced = wait(phone, "session:replaced");
  pc.connect();
  await wait(pc, "connect");
  const back = wait(pc, "session:ready");
  pc.emit("session:join", { name: "x" });
  await back;
  await phoneReplaced;
  console.log("OK 'Usar aqui' no PC derruba o celular.");

  // Another account is never affected.
  assert.equal(friend.connected, true);
  console.log("OK outra conta continua conectada.");
  // AFK channel: no peers, no signaling, and the state stays muted and deafened.
  phone.disconnect();
  await new Promise((r) => setTimeout(r, 200));
  pc.emit("voice:join", { channelId: "dormiu" });
  assert.deepEqual(await wait(pc, "voice:peers"), []);
  const friendPeers = wait(friend, "voice:peers");
  friend.emit("voice:join", { channelId: "dormiu" });
  assert.deepEqual(await friendPeers, [], "AFK não pode entregar pares para conectar áudio");
  let leaked = false;
  pc.on("rtc:signal", () => { leaked = true; });
  friend.emit("rtc:signal", { target: pc.id, description: { type: "offer", sdp: "v=0" } });
  const afkState = new Promise((resolve) => {
    const handler = (list) => { const me = list.find((m) => m.socketId === friend.id); if (me?.voiceChannelId === "dormiu") { friend.off("members:update", handler); resolve(me); } };
    friend.on("members:update", handler);
  });
  friend.emit("voice:state", { micEnabled: true, deafened: false, cameraEnabled: true, screenSharing: true, voiceDetected: true });
  const me = await afkState;
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(leaked, false, "sinal WebRTC passou no AFK");
  assert.equal(me.micEnabled, false); assert.equal(me.deafened, true);
  assert.equal(me.voiceDetected, false); assert.equal(me.cameraEnabled, false); assert.equal(me.screenSharing, false);
  console.log("OK AFK: sem pares, sem sinal WebRTC, estado forçado mudo e sem áudio mesmo se o cliente pedir o contrário.");

  // Leaving AFK restores normal voice.
  friend.emit("voice:join", { channelId: "cafe" });
  pc.emit("voice:join", { channelId: "cafe" });
  const peers = await wait(pc, "voice:peers");
  assert.deepEqual(peers, [friend.id]);
  console.log("OK fora do AFK a voz volta ao normal.");
  console.log("Smoke test aprovado: uma sessão por conta (último dispositivo vence) e canal AFK sem voz nem áudio.");
  friend.disconnect(); pc.disconnect();
} catch (error) {
  console.error("FALHOU:", error.message, "\n", serverLog.slice(-1500));
  process.exitCode = 1;
} finally {
  server.kill();
  setTimeout(() => rmSync(work, { recursive: true, force: true }), 500);
}
