// Real-browser end-to-end check of the logged-in app. Starts an isolated server
// (throwaway data folder, fake Discord sessions) and drives two Edge/Chrome
// sessions through chat, voice, audio settings, the owner panel and a reload.
// Requires a built client (`npm run build`) and an installed Edge or Chrome.
import { createHmac } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const repo = process.cwd();
if (!existsSync(join(repo, "dist", "index.html"))) {
  console.error("dist/ is missing. Run `npm run build` first.");
  process.exit(2);
}

const port = Number(process.env.KCORD_UI_TEST_PORT ?? 3331);
const url = `http://127.0.0.1:${port}`;
const secret = "ui-smoke-test-secret";
const ownerDiscordId = "111111111111111111";
const sign = (id) => `${id}.${createHmac("sha256", secret).update(id).digest("base64url")}`;
const fakeSession = (id, discordId, name) => ({
  id, purpose: "login", kafcordUserId: `user-${discordId}`, memberships: [], guilds: [],
  user: { id: discordId, username: name.toLowerCase(), global_name: name, avatar: null },
  expiresAt: Date.now() + 3_600_000,
});

const work = mkdtempSync(join(tmpdir(), "kcord-ui-smoke-"));
mkdirSync(join(work, "data"), { recursive: true });
cpSync(join(repo, "dist"), join(work, "dist"), { recursive: true });
writeFileSync(join(work, "data", "auth-sessions.json"), JSON.stringify([
  fakeSession("ana-session", ownerDiscordId, "Ana"),
  fakeSession("bia-session", "222222222222222222", "Bia"),
]));
writeFileSync(join(work, "data", "community.json"), JSON.stringify({
  name: "KCord", categories: [], roles: [],
  textChannels: [
    { id: "geral", name: "geral", description: "x", categoryId: null, position: 0 },
    { id: "outro", name: "outro", description: "x", categoryId: null, position: 1 },
  ],
  voiceChannels: [{ id: "cafe", name: "Café aberto", categoryId: null, position: 0 }],
}));

// With KCORD_UI_LIVEKIT=1 the voice room runs on LiveKit instead of the peer-to-peer mesh.
// It expects a LiveKit server in dev mode already listening on 127.0.0.1:7880
// (key "devkey", secret "secret"); CI starts one as a container.
const useLiveKit = process.env.KCORD_UI_LIVEKIT === "1";
const liveKitEnv = useLiveKit
  ? { LIVEKIT_URL: "ws://127.0.0.1:7880", LIVEKIT_API_KEY: "devkey", LIVEKIT_API_SECRET: "secret", LIVEKIT_VOICE_CHANNEL_IDS: "cafe" }
  : {};
const server = spawn(process.execPath, [join(repo, "node_modules/tsx/dist/cli.mjs"), join(repo, "server/index.ts")], {
  cwd: work,
  env: {
    ...process.env, PORT: String(port), HOST: "127.0.0.1", SESSION_SECRET: secret,
    DISCORD_CLIENT_ID: "x", DISCORD_CLIENT_SECRET: "x", DISCORD_BOT_TOKEN: "x",
    DISCORD_REDIRECT_URI: `${url}/auth/discord/callback`, KAFCORD_OWNER_DISCORD_ID: ownerDiscordId,
    ...liveKitEnv,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (chunk) => { serverLog += chunk; });
server.stderr.on("data", (chunk) => { serverLog += chunk; });

async function stopEverything(browser) {
  await browser?.close().catch(() => undefined);
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 400));
  rmSync(work, { recursive: true, force: true });
}

for (let attempt = 0; attempt < 80; attempt += 1) {
  try { if ((await fetch(`${url}/api/health`)).ok) break; } catch { /* still starting */ }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

const results = [];
async function step(name, run) {
  try {
    await run();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    const lines = String(error.message ?? error).split("\n");
    const shown = process.env.KCORD_UI_TEST_VERBOSE ? lines.slice(0, 12) : lines.slice(0, 1);
    console.log(`  FAIL ${name}\n       ${shown.join("\n       ")}`);
  }
}

const launchOptions = {
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--auto-select-desktop-capture-source=Entire screen",
    "--autoplay-policy=no-user-gesture-required",
  ],
};
let browser;
for (const channel of ["msedge", "chrome", undefined]) {
  try { browser = await chromium.launch({ ...launchOptions, ...(channel ? { channel } : {}) }); break; } catch { /* try the next browser */ }
}
if (!browser) {
  console.error("No Edge, Chrome or Chromium available for the UI smoke test.");
  await stopEverything(undefined);
  process.exit(2);
}

const pageErrors = [];
async function openAs(sessionId, label) {
  const context = await browser.newContext({ permissions: ["microphone"] });
  await context.addCookies([{ name: "kafcord_session", value: sign(sessionId), url }]);
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(`${label}: ${error.message}`));
  page.on("dialog", (dialog) => { void dialog.accept(); });
  page.on("console", (message) => { if (message.type() === "error") pageErrors.push(`${label} console: ${message.text()}`); });
  await page.goto(url);
  await page.locator(".app-shell").waitFor({ timeout: 15_000 });
  return page;
}
const storage = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

console.log(`UI smoke test against ${url}${useLiveKit ? " (voice on LiveKit)" : ""}`);
let ana;
let bia;
try {
  await step("logged-in shell renders channels, voice room and the user", async () => {
    ana = await openAs("ana-session", "ana");
    await ana.getByText("Café aberto").first().waitFor();
    await ana.getByRole("button", { name: /geral/ }).first().waitFor();
    await ana.getByText("Discord verificado").first().waitFor();
  });

  await step("presence: a second member appears for both", async () => {
    bia = await openAs("bia-session", "bia");
    await ana.getByText(/presentes — 2/i).waitFor({ timeout: 10_000 });
    await bia.getByText(/presentes — 2/i).waitFor({ timeout: 10_000 });
  });

  await step("chat: a message sent by one member reaches the other in real time", async () => {
    // The send button only exists on phones; on desktop Enter submits.
    await ana.getByPlaceholder("Mensagem em #geral").fill("olá da Ana");
    await ana.getByPlaceholder("Mensagem em #geral").press("Enter");
    await ana.locator(".message-list").getByText("olá da Ana").waitFor();
    await bia.locator(".message-list").getByText("olá da Ana").waitFor({ timeout: 10_000 });
  });

  await step("chat: switching channels shows an empty channel and keeps its own draft box", async () => {
    await bia.getByRole("button", { name: /outro/ }).first().click();
    await bia.getByPlaceholder("Mensagem em #outro").waitFor();
    await bia.locator(".message-list").getByText("olá da Ana").waitFor({ state: "detached" });
  });

  const message = (page, text) => page.locator(".message-list .message").filter({ hasText: text });
  const channelButton = (page, name) => page.locator("button.channel-button", { hasText: name });

  await step("chat: unread badge counts messages in another channel and clears when opened", async () => {
    // Bia is looking at #outro while Ana writes in #geral.
    await ana.getByPlaceholder("Mensagem em #geral").fill("segunda mensagem");
    await ana.getByPlaceholder("Mensagem em #geral").press("Enter");
    await channelButton(bia, "geral").locator("b").filter({ hasText: "1" }).waitFor({ timeout: 10_000 });
    await channelButton(bia, "geral").click();
    await channelButton(bia, "geral").locator("b").waitFor({ state: "detached" });
    await message(bia, "segunda mensagem").waitFor();
  });

  await step("chat: replying shows the original message to everyone", async () => {
    await message(bia, "olá da Ana").hover();
    await message(bia, "olá da Ana").getByRole("button", { name: "Responder" }).click();
    await bia.locator(".composer-replying").getByText("Respondendo a").waitFor();
    await bia.getByPlaceholder("Mensagem em #geral").fill("é uma resposta");
    await bia.getByPlaceholder("Mensagem em #geral").press("Enter");
    await bia.locator(".composer-replying").waitFor({ state: "detached" });
    await message(ana, "é uma resposta").locator(".message-reply-reference").waitFor({ timeout: 10_000 });
  });

  await step("chat: editing your own message updates it for everyone", async () => {
    await message(ana, "olá da Ana").first().hover();
    await message(ana, "olá da Ana").first().getByRole("button", { name: "Editar" }).click();
    await ana.locator(".message-edit-form input").fill("olá editado");
    await ana.locator(".message-edit-form input").press("Enter");
    await message(ana, "olá editado").waitFor();
    await message(bia, "olá editado").waitFor({ timeout: 10_000 });
    if (await message(bia, "olá da Ana").locator(".message-body", { hasText: /^olá da Ana/ }).count()) throw new Error("old text still visible");
  });

  await step("chat: reactions appear for everyone", async () => {
    await message(bia, "olá editado").hover();
    await message(bia, "olá editado").getByTitle("Reagir com 👍").click();
    await message(ana, "olá editado").locator(".message-reactions").getByText("👍").waitFor({ timeout: 10_000 });
    await message(bia, "olá editado").locator(".message-reactions").getByText("👍").waitFor();
  });

  await step("chat: the owner can pin and unpin, members cannot", async () => {
    await message(bia, "olá editado").hover();
    if (await message(bia, "olá editado").getByRole("button", { name: /Fixar mensagem/ }).count()) throw new Error("pin button visible to a member");
    await message(ana, "olá editado").hover();
    await message(ana, "olá editado").getByRole("button", { name: "Fixar mensagem" }).click();
    await bia.locator('button[aria-label="Ver mensagens fixadas"][data-count="1"]').waitFor({ timeout: 10_000 });
    await bia.getByRole("button", { name: "Ver mensagens fixadas" }).click();
    await bia.locator(".pinned-messages-panel").getByText("olá editado").waitFor();
    await bia.getByRole("button", { name: "Fechar mensagens fixadas" }).click();
    await message(ana, "olá editado").hover();
    await message(ana, "olá editado").getByRole("button", { name: "Desafixar mensagem" }).click();
    await bia.locator('button[aria-label="Ver mensagens fixadas"][data-count="0"]').waitFor({ timeout: 10_000 });
  });

  await step("chat: a file upload shows up for everyone", async () => {
    await ana.locator('.composer input[type="file"]').first().setInputFiles({ name: "nota.txt", mimeType: "text/plain", buffer: Buffer.from("conteúdo de teste") });
    await message(ana, "nota.txt").waitFor({ timeout: 15_000 });
    await message(bia, "nota.txt").waitFor({ timeout: 15_000 });
  });

  await step("chat: only the author (or a moderator) can delete, and it vanishes for everyone", async () => {
    await message(bia, "segunda mensagem").hover();
    if (await message(bia, "segunda mensagem").getByRole("button", { name: "Excluir mensagem" }).count()) throw new Error("delete button visible on someone else's message");
    await message(ana, "segunda mensagem").hover();
    await message(ana, "segunda mensagem").getByRole("button", { name: "Excluir mensagem" }).click();
    await message(ana, "segunda mensagem").waitFor({ state: "detached" });
    await message(bia, "segunda mensagem").waitFor({ state: "detached", timeout: 10_000 });
  });

  await step("private messages: delivery, unread badge, reply and deletion", async () => {
    await ana.locator(".member-row", { hasText: "Bia" }).click({ button: "right" });
    await ana.locator(".user-context-menu").getByRole("menuitem", { name: "Mensagem" }).click();
    await ana.getByPlaceholder("Mensagem para @Bia").fill("oi Bia");
    await ana.getByPlaceholder("Mensagem para @Bia").press("Enter");
    await ana.locator(".direct-message-list").getByText("oi Bia").waitFor();
    // Bia is in a channel, so the message shows as an unread badge instead.
    await bia.locator('.direct-unread-avatar[title*="1 mensagem não lida de Ana"]').waitFor({ timeout: 10_000 });
    await bia.locator(".direct-unread-avatar").click();
    await bia.locator(".direct-message-list").getByText("oi Bia").waitFor();
    await bia.locator(".direct-unread-avatar").waitFor({ state: "detached" });
    await bia.getByPlaceholder("Mensagem para @Ana").fill("oi Ana");
    await bia.getByPlaceholder("Mensagem para @Ana").press("Enter");
    await ana.locator(".direct-message-list").getByText("oi Ana").waitFor({ timeout: 10_000 });
    if (await ana.locator(".direct-unread-avatar").count()) throw new Error("open conversation should not count as unread");
    // Only the sender can delete, and it disappears on both sides.
    await ana.locator(".direct-message", { hasText: "oi Bia" }).hover();
    await ana.locator(".direct-message", { hasText: "oi Bia" }).getByRole("button", { name: "Excluir mensagem privada" }).click();
    await ana.locator(".direct-message-list").getByText("oi Bia").waitFor({ state: "detached" });
    await bia.locator(".direct-message-list").getByText("oi Bia").waitFor({ state: "detached", timeout: 10_000 });
    // Ana cannot delete Bia's message, only her own.
    await ana.locator(".direct-message", { hasText: "oi Ana" }).hover();
    if (await ana.locator(".direct-message", { hasText: "oi Ana" }).getByRole("button", { name: "Excluir mensagem privada" }).count()) throw new Error("delete button visible on a peer's private message");
    await channelButton(ana, "geral").click();
    await channelButton(bia, "geral").click();
  });

  await step("voice: both members join the room and hear each other", async () => {
    await ana.getByRole("button", { name: /Café aberto/ }).first().click();
    await ana.getByRole("button", { name: "Desconectar da chamada" }).waitFor({ timeout: 10_000 });
    await bia.getByRole("button", { name: /Café aberto/ }).first().click();
    await bia.getByRole("button", { name: "Desconectar da chamada" }).waitFor({ timeout: 10_000 });
    // The element exists as soon as the member is listed; it only has a track once the connection delivered one.
    const hearsSomeone = () => [...document.querySelectorAll("audio")].some((audio) => (audio.srcObject?.getAudioTracks().length ?? 0) > 0);
    await ana.waitForFunction(hearsSomeone, null, { timeout: 20_000 });
    await bia.waitForFunction(hearsSomeone, null, { timeout: 20_000 });
    if (useLiveKit) {
      const rtc = await (await fetch(`${url}/api/rtc-config`)).json();
      if (!JSON.stringify(rtc.livekitChannelIds ?? []).includes("cafe")) throw new Error("the server did not list the channel as LiveKit");
    }
  });

  // A video element with real dimensions means frames actually arrived over WebRTC.
  // With `advancing`, playback must also move forward, so a frozen last frame does not count.
  const framesArrive = (locator, { what, advancing = false, timeout = 20_000 }) =>
    locator.evaluate((video, options) => new Promise((resolve, reject) => {
      const started = Date.now();
      const before = video.currentTime;
      const poll = () => {
        const playing = video.videoWidth > 0 && video.readyState >= 2 && (!options.advancing || video.currentTime > before);
        if (playing) resolve(true);
        else if (Date.now() - started > options.timeout) reject(new Error(`no frames arrived: ${options.what}`));
        else setTimeout(poll, 200);
      };
      poll();
    }), { what, advancing, timeout });

  await step("voice: the camera reaches the other member as live video, and stops with it", async () => {
    const anaCameraTile = bia.locator(".participant-tile.has-camera", { hasText: "Ana" });
    if (await anaCameraTile.count()) throw new Error("camera tile visible before the camera was turned on");
    await ana.locator('button[title="Ligar câmera"]').first().click();
    await ana.locator('button[title="Desligar câmera"]').first().waitFor({ timeout: 15_000 });
    await anaCameraTile.waitFor({ timeout: 20_000 });
    await framesArrive(anaCameraTile.locator("video"), { what: "camera" });
    await ana.locator('button[title="Desligar câmera"]').first().click();
    await ana.locator('button[title="Ligar câmera"]').first().waitFor();
    await anaCameraTile.waitFor({ state: "detached", timeout: 15_000 });

    // Turning it back on must bring the video back, not a frozen or empty tile.
    await ana.locator('button[title="Ligar câmera"]').first().click();
    await anaCameraTile.waitFor({ timeout: 20_000 });
    await framesArrive(anaCameraTile.locator("video"), { advancing: true, what: "camera after turning it on again" });
    await ana.locator('button[title="Desligar câmera"]').first().click();
    await anaCameraTile.waitFor({ state: "detached", timeout: 15_000 });
  });

  await step("voice: a member who joins later sees a camera that was already on", async () => {
    const leave = bia.getByRole("button", { name: "Desconectar da chamada" });
    await leave.click();
    await leave.waitFor({ state: "detached" });
    await ana.locator('button[title="Ligar câmera"]').first().click();
    await ana.locator('button[title="Desligar câmera"]').first().waitFor({ timeout: 15_000 });
    await bia.getByRole("button", { name: /Café aberto/ }).first().click();
    const anaCameraTile = bia.locator(".participant-tile.has-camera", { hasText: "Ana" });
    await anaCameraTile.waitFor({ timeout: 20_000 });
    await framesArrive(anaCameraTile.locator("video"), { advancing: true, what: "camera that was on before joining" });
    await ana.locator('button[title="Desligar câmera"]').first().click();
    await anaCameraTile.waitFor({ state: "detached", timeout: 15_000 });
  });

  await step("voice: a screen share is announced, only streams once watched, and stops cleanly", async () => {
    const watchButton = bia.getByRole("button", { name: /Assistir tela de/ });
    const watchedVideo = bia.locator('video[aria-label="Tela de Ana"]');
    // Twice, because a second share must not reuse the first one's stale track.
    for (let round = 0; round < 2; round += 1) {
      await ana.locator('button[title="Compartilhar tela"]').first().click();
      await ana.locator('button[title="Parar compartilhamento"]').first().waitFor({ timeout: 20_000 });
      await watchButton.waitFor({ timeout: 20_000 });
      // Nothing is streamed to a member who has not chosen to watch.
      if (await watchedVideo.count()) throw new Error("screen video present before the viewer subscribed");
      await watchButton.click();
      await watchedVideo.waitFor({ timeout: 20_000 });
      await framesArrive(watchedVideo, { what: "screen share" });
      await ana.getByText(/assistindo/).first().waitFor({ timeout: 15_000 });
      await ana.locator('button[title="Parar compartilhamento"]').first().click();
      await ana.locator('button[title="Compartilhar tela"]').first().waitFor();
      await watchButton.waitFor({ state: "detached", timeout: 15_000 });
      await watchedVideo.waitFor({ state: "detached", timeout: 15_000 });
    }
  });

  await step("voice: muting and unmuting the microphone updates the control", async () => {
    const micControl = (title) => ana.locator(`button.profile-audio-control[title="${title}"]`);
    await micControl("Desligar microfone").click();
    await micControl("Ligar microfone").waitFor();
    await micControl("Ligar microfone").click();
    await micControl("Desligar microfone").waitFor();
  });

  await step("audio settings: volume and input mode are applied and persisted", async () => {
    await ana.getByRole("button", { name: "Configurações de áudio", exact: true }).click();
    await ana.getByRole("heading", { name: "Voz e vídeo" }).waitFor();
    await ana.locator("#input-volume").fill("80");
    await ana.locator("#output-volume").fill("65");
    await ana.getByText("Apertar para falar").click();
    await ana.getByText("ATALHO PTT").waitFor();
    await ana.waitForFunction(() => localStorage.getItem("kafcord:input-mode") === "ptt");
    if ((await storage(ana, "kafcord:input-volume")) !== "80") throw new Error("input volume was not saved");
    if ((await storage(ana, "kafcord:output-volume")) !== "65") throw new Error("output volume was not saved");
  });

  await step("audio settings: a new push-to-talk key can be recorded", async () => {
    await ana.getByRole("button", { name: "Definir tecla" }).click();
    await ana.getByText("Pressione uma tecla…").waitFor();
    await ana.keyboard.press("KeyV");
    await ana.getByText("ATALHO PTT").locator("xpath=following-sibling::strong").filter({ hasText: /^V$/ }).waitFor();
    if ((await storage(ana, "kafcord:ptt-key")) !== "KeyV") throw new Error("PTT key was not saved");
  });

  await step("audio settings: the microphone test starts and stops", async () => {
    await ana.getByRole("button", { name: "Teste do microfone" }).click();
    await ana.getByRole("button", { name: "Parar teste" }).waitFor({ timeout: 10_000 });
    await ana.getByRole("button", { name: "Parar teste" }).click();
    await ana.getByRole("button", { name: "Teste do microfone" }).waitFor();
    await ana.locator(".audio-dialog").getByRole("button", { name: "Fechar" }).click();
    await ana.getByRole("heading", { name: "Voz e vídeo" }).waitFor({ state: "detached" });
  });

  await step("owner panel: statistics open, load without error and close", async () => {
    await ana.getByRole("button", { name: "Abrir estatísticas administrativas" }).click();
    await ana.getByRole("heading", { name: "Tráfego do servidor KCord" }).waitFor();
    await ana.waitForFunction(() => !document.querySelector(".admin-refresh")?.textContent?.includes("Atualizando"), null, { timeout: 10_000 });
    if (await ana.locator(".admin-stats-error").count()) throw new Error(await ana.locator(".admin-stats-error").innerText());
    await ana.locator(".admin-stats-dialog").getByRole("button", { name: "Fechar" }).click();
    await ana.getByRole("heading", { name: "Tráfego do servidor KCord" }).waitFor({ state: "detached" });
  });

  await step("owner panel: a regular member does not get the owner controls", async () => {
    if (await bia.getByRole("button", { name: "Abrir estatísticas administrativas" }).count()) throw new Error("owner button visible to a member");
    if (await bia.getByRole("button", { name: "Importar modelo do Discord" }).count()) throw new Error("import button visible to a member");
  });

  await step("voice: leaving the call returns to the channel view", async () => {
    await bia.getByRole("button", { name: "Desconectar da chamada" }).click();
    await bia.getByRole("button", { name: "Desconectar da chamada" }).waitFor({ state: "detached" });
  });

  await step("reload: the session survives and the saved settings are restored", async () => {
    await ana.reload();
    await ana.locator(".app-shell").waitFor({ timeout: 15_000 });
    await ana.getByRole("button", { name: "Configurações de áudio", exact: true }).click();
    await ana.getByRole("heading", { name: "Voz e vídeo" }).waitFor();
    if ((await ana.locator("#input-volume").inputValue()) !== "80") throw new Error("input volume not restored");
    if ((await ana.locator("#output-volume").inputValue()) !== "65") throw new Error("output volume not restored");
    await ana.getByText("ATALHO PTT").waitFor();
  });

  await step("no page errors or console errors were reported", async () => {
    const relevant = pageErrors.filter((entry) => !/favicon|ERR_ABORTED/i.test(entry));
    if (relevant.length) throw new Error(relevant.slice(0, 3).join(" | "));
  });
} finally {
  await stopEverything(browser);
}

const failed = results.filter((result) => !result.ok);
console.log(failed.length === 0
  ? `UI smoke test passed (${results.length} checks).`
  : `UI smoke test FAILED: ${failed.length} of ${results.length} checks.`);
if (failed.length > 0 && process.env.KCORD_UI_TEST_VERBOSE) console.log(serverLog.slice(-1500));
process.exit(failed.length === 0 ? 0 : 1);
