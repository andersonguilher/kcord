// Acceptance test for moving the JSON state files into the SQLite database.
// Boots a real server on the files an older release left behind, checks that every
// store arrives (login sessions, profile, community, equalizer, reports, traffic,
// imported members), then restarts it with those files tampered with and checks
// that the database wins and the old files are left in place for a rollback.
import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { io } from "socket.io-client";

const repo = process.cwd();
const work = mkdtempSync(join(tmpdir(), "kcord-state-migration-"));
const data = join(work, "data");
mkdirSync(data, { recursive: true });

const secret = "state-migration-test-secret";
const ownerDiscordId = "111111111111111111";
const sign = (id) => `${id}.${createHmac("sha256", secret).update(id).digest("base64url")}`;
const session = (id, discordId, name) => ({
  id, purpose: "login", kafcordUserId: `user-${discordId}`, memberships: [], guilds: [],
  user: { id: discordId, username: name, global_name: name, avatar: null },
  expiresAt: Date.now() + 3_600_000,
});
const legacy = (name, value) => writeFileSync(join(data, name), JSON.stringify(value));

legacy("auth-sessions.json", [session("owner-session", ownerDiscordId, "Dona"), session("friend-session", "222222222222222222", "Amigo")]);
legacy("community.json", {
  name: "Comunidade Migrada", categories: [], roles: [],
  textChannels: [{ id: "geral", name: "geral", description: "x", categoryId: null, position: 0 }],
  voiceChannels: [{ id: "cafe", name: "Café", categoryId: null, position: 0 }],
});
legacy("profiles.json", [{ userId: `user-${ownerDiscordId}`, displayName: "Nome Antigo", avatarUrl: null, updatedAt: "2026-11-01T00:00:00.000Z" }]);
legacy("voice-eq.json", { gains: [3, 0, 0, 0, -3] });
legacy("client-reports.json", [{
  id: "report-1", at: "2026-11-10T10:00:00.000Z", kind: "microphone", message: "falha antiga", displayName: "Alguém",
  client: "browser", appVersion: null, userAgent: "", context: {}, status: "open",
}]);
const today = new Date().toISOString().slice(0, 10);
legacy("traffic-stats.json", {
  version: 2, startedAt: "2026-10-30T00:00:00.000Z",
  days: [{ date: today, httpRequests: 0, bytesIn: 0, bytesOut: 0, downloadRequests: 0, downloadBytesOut: 0, sessions: 0, uniqueUserIds: [], publicMessages: 5, privateMessages: 0, voiceJoins: 0, screenShares: 0, fileUploads: 0, uploadedBytes: 0, networkBytesIn: 0, networkBytesOut: 0, relayBytesIn: 0, relayBytesOut: 0 }],
});
legacy("discord-members.json", [{
  id: "guild:friend", sourceGuildId: "guild", discordUserId: "222222222222222222", username: "amigo", displayName: "Amigo",
  nickname: null, avatar: null, discordRoleIds: [], discordRoleNames: [], kafcordRoleIds: [], importedAt: "2026-11-01T00:00:00.000Z",
  status: "claimed", kafcordUserId: "user-222222222222222222",
}]);

const port = Number(process.env.KCORD_TEST_PORT ?? 3313);
const url = `http://127.0.0.1:${port}`;
let server;
let serverLog = "";

async function start() {
  server = spawn(process.execPath, [join(repo, "node_modules/tsx/dist/cli.mjs"), join(repo, "server/index.ts")], {
    cwd: work,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", SESSION_SECRET: secret, DISCORD_CLIENT_ID: "x", DISCORD_CLIENT_SECRET: "x", DISCORD_BOT_TOKEN: "x", DISCORD_REDIRECT_URI: `${url}/auth/discord/callback`, KAFCORD_OWNER_DISCORD_ID: ownerDiscordId },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => { serverLog += chunk; });
  server.stderr.on("data", (chunk) => { serverLog += chunk; });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(`${url}/api/health`)).ok) return; } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("server did not start");
}

async function stop() {
  server.kill();
  await new Promise((resolve) => server.once("exit", resolve));
  await new Promise((resolve) => setTimeout(resolve, 300));
}

const cookie = (id) => `kafcord_session=${sign(id)}`;
const wait = (socket, event, ms = 5000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
  socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
});
async function join_(sessionId) {
  const socket = io(url, { transports: ["websocket"], forceNew: true, reconnection: false, extraHeaders: { cookie: cookie(sessionId) } });
  await wait(socket, "connect");
  const ready = wait(socket, "session:ready");
  socket.emit("session:join", { name: "x" });
  return { socket, ready: await ready };
}
const getJson = async (path, sessionId) => (await fetch(`${url}${path}`, { headers: { cookie: cookie(sessionId) } })).json();

try {
  console.log("1) first start on the files of an older release");
  await start();
  assert.match(serverLog, /importados de/, "the server should log the import");
  const owner = await join_("owner-session");
  assert.equal(owner.ready.community.name, "Comunidade Migrada", "community configuration");
  assert.deepEqual(owner.ready.voiceEq, { gains: [3, 0, 0, 0, -3] }, "voice equalizer");
  assert.equal((await getJson("/api/profile", "owner-session")).displayName, "Nome Antigo", "profile");
  const reports = await getJson("/api/admin/client-reports", "owner-session");
  assert.equal(reports.reports[0]?.id, "report-1", "client reports");
  const stats = await getJson("/api/admin/stats?days=30", "owner-session");
  assert.equal(stats.totals.publicMessages, 5, "traffic statistics");
  const friend = await join_("friend-session");
  assert.ok(friend.ready.members.length >= 1, "a second saved login session works");
  console.log("   ok: sessions, community, equalizer, profile, reports and traffic all arrived");

  console.log("2) changes made now must be saved in the database");
  const changed = wait(owner.socket, "voice:eq");
  owner.socket.emit("voice:eq:set", { gains: [1, 1, 1, 1, 1] });
  assert.deepEqual(await changed, { gains: [1, 1, 1, 1, 1] });
  const patched = await fetch(`${url}/api/admin/client-reports/report-1`, {
    method: "PATCH", headers: { "Content-Type": "application/json", cookie: cookie("owner-session") }, body: JSON.stringify({ status: "resolved" }),
  });
  assert.equal(patched.status, 200);
  // Using a session renews it for 30 days, and logging out ends one: both must be saved.
  const refreshed = await fetch(`${url}/api/auth/me`, { headers: { cookie: cookie("owner-session") } });
  assert.equal(refreshed.status, 200);
  const loggedOut = await fetch(`${url}/api/discord/logout`, { method: "POST", headers: { cookie: cookie("friend-session") } });
  assert.equal(loggedOut.status, 204, "logout");
  owner.socket.disconnect();
  friend.socket.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 1200)); // traffic statistics are saved after a short delay
  await stop();

  const database = new DatabaseSync(join(data, "kafcord.sqlite"), { readOnly: true });
  const keys = database.prepare("SELECT key FROM app_state ORDER BY key").all().map((row) => row.key);
  const storedSessions = JSON.parse(database.prepare("SELECT value FROM app_state WHERE key = 'auth-sessions'").get().value);
  database.close();
  const ownerSession = storedSessions.find((entry) => entry.id === "owner-session");
  assert.ok(ownerSession.expiresAt > Date.now() + 29 * 24 * 3_600_000, "the renewed session lifetime was saved");
  assert.ok(!storedSessions.some((entry) => entry.id === "friend-session"), "the logged-out session was removed");
  assert.deepEqual(keys, ["auth-sessions", "client-reports", "community", "discord-members", "profiles", "traffic-stats", "voice-eq"], "every store is in the database");
  for (const name of ["auth-sessions", "community", "profiles", "voice-eq", "client-reports", "traffic-stats", "discord-members"]) {
    assert.ok(existsSync(join(data, `${name}.json`)), `${name}.json is left in place for a rollback`);
  }
  console.log("   ok: all seven stores are in the database, and the old files are untouched");

  console.log("3) restart with the old files tampered with: the database must win");
  legacy("voice-eq.json", { gains: [9, 9, 9, 9, 9] });
  legacy("profiles.json", [{ userId: `user-${ownerDiscordId}`, displayName: "ADULTERADO", avatarUrl: null, updatedAt: "2026-11-01T00:00:00.000Z" }]);
  legacy("community.json", { name: "Adulterada", categories: [], roles: [], textChannels: [{ id: "x", name: "x", description: "", categoryId: null, position: 0 }], voiceChannels: [] });
  writeFileSync(join(data, "auth-sessions.json"), "{corrupt");
  serverLog = "";
  await start();
  const again = await join_("owner-session");
  assert.equal(again.ready.community.name, "Comunidade Migrada", "community kept");
  assert.deepEqual(again.ready.voiceEq, { gains: [1, 1, 1, 1, 1] }, "equalizer kept");
  assert.equal((await getJson("/api/profile", "owner-session")).displayName, "Nome Antigo", "profile kept");
  const afterRestart = await getJson("/api/admin/client-reports", "owner-session");
  assert.equal(afterRestart.reports[0]?.status, "resolved", "report status kept");
  assert.equal((await getJson("/api/auth/me", "owner-session")).authenticated, true, "the owner's login survives the restart even with a corrupt old file");
  assert.notEqual((await getJson("/api/auth/me", "friend-session")).authenticated, true, "a session ended before the restart stays ended");
  assert.doesNotMatch(serverLog, /importados de/, "nothing is imported a second time");
  console.log("   ok: the database was used, the tampered and corrupt files were ignored");

  assert.equal(readFileSync(join(data, "auth-sessions.json"), "utf8"), "{corrupt", "a corrupt old file is never modified");
  console.log("Smoke test aprovado: migração dos arquivos JSON para o banco, com a base vencendo os arquivos antigos.");
} catch (error) {
  console.error("FALHOU:", error.message);
  console.error(serverLog.slice(-1500));
  process.exitCode = 1;
} finally {
  if (server && server.exitCode === null) await stop().catch(() => undefined);
  rmSync(work, { recursive: true, force: true });
}
