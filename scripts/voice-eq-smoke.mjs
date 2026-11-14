// Isolated server check: only the owner changes the community voice equalizer,
// values are clamped, everyone gets the change, and it survives for new sessions.
import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { io } from "socket.io-client";

const repo = process.cwd();
const work = mkdtempSync(join(tmpdir(), "kcord-voice-eq-"));
mkdirSync(join(work, "data"), { recursive: true });

const ownerId = "111111111111111111";
const secret = "voice-eq-test-secret";
const sign = (id) => `${id}.${createHmac("sha256", secret).update(id).digest("base64url")}`;
const session = (id, discordId, name) => ({
  id, purpose: "login", kafcordUserId: `user-${discordId}`, memberships: [], guilds: [],
  user: { id: discordId, username: name, global_name: name, avatar: null },
  expiresAt: Date.now() + 3_600_000,
});
writeFileSync(join(work, "data", "auth-sessions.json"), JSON.stringify([
  session("owner-session", ownerId, "Dono"),
  session("friend-session", "222222222222222222", "Amigo"),
  session("late-session", "333333333333333333", "Atrasado"),
]));

const port = Number(process.env.KCORD_TEST_PORT ?? 3312);
const server = spawn(process.execPath, [join(repo, "node_modules/tsx/dist/cli.mjs"), join(repo, "server/index.ts")], {
  cwd: work,
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", SESSION_SECRET: secret, DISCORD_CLIENT_ID: "x", DISCORD_CLIENT_SECRET: "x", DISCORD_BOT_TOKEN: "x", DISCORD_REDIRECT_URI: `http://127.0.0.1:${port}/auth/discord/callback`, KAFCORD_OWNER_DISCORD_ID: ownerId },
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
  return { socket, ready: await ready };
};
const noEvent = (socket, event, ms = 500) => new Promise((resolve) => {
  let seen = false;
  const handler = () => { seen = true; };
  socket.on(event, handler);
  setTimeout(() => { socket.off(event, handler); resolve(!seen); }, ms);
});

try {
  const owner = await client("owner-session");
  const friend = await client("friend-session");
  assert.deepEqual(owner.ready.voiceEq, { gains: [0, 0, 0, 0, 0] });
  console.log("OK sessão começa com o equalizador neutro.");

  const friendQuiet = noEvent(owner.socket, "voice:eq");
  friend.socket.emit("voice:eq:set", { gains: [6, 6, 6, 6, 6] });
  assert.equal(await friendQuiet, true, "usuário comum alterou o equalizador");
  console.log("OK usuário comum não consegue alterar.");

  const invalidQuiet = noEvent(friend.socket, "voice:eq");
  owner.socket.emit("voice:eq:set", { gains: [1, 2, 3] });
  owner.socket.emit("voice:eq:set", { gains: [1, 2, "x", 4, 5] });
  owner.socket.emit("voice:eq:set", null);
  assert.equal(await invalidQuiet, true, "valor inválido foi aceito");
  console.log("OK valores inválidos são recusados.");

  const broadcast = wait(friend.socket, "voice:eq");
  owner.socket.emit("voice:eq:set", { gains: [40, -40, 1.26, 0, -3] });
  assert.deepEqual(await broadcast, { gains: [12, -12, 1.5, 0, -3] });
  console.log("OK ajuste do dono chega a todos, limitado a ±12 dB em passos de 0,5.");

  assert.deepEqual(JSON.parse(readFileSync(join(work, "data", "voice-eq.json"), "utf8")), { gains: [12, -12, 1.5, 0, -3] });
  const late = await client("late-session");
  assert.deepEqual(late.ready.voiceEq, { gains: [12, -12, 1.5, 0, -3] });
  console.log("OK ajuste fica salvo e quem entra depois já recebe.");

  console.log("Smoke test aprovado: equalizador da comunidade só pelo dono, validado, transmitido e salvo.");
  owner.socket.disconnect(); friend.socket.disconnect(); late.socket.disconnect();
} catch (error) {
  console.error("FALHOU:", error.message, "\n", serverLog.slice(-1500));
  process.exitCode = 1;
} finally {
  server.kill();
  setTimeout(() => rmSync(work, { recursive: true, force: true }), 500);
}
