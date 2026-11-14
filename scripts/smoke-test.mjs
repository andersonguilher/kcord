import assert from "node:assert/strict";
import { io } from "socket.io-client";

const endpoint = process.env.KAFCORD_URL ?? "http://localhost:3001";

function waitFor(socket, event, predicate = () => true, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Tempo esgotado aguardando ${event}`));
    }, timeoutMs);
    const handler = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

const health = await fetch(`${endpoint}/api/health`).then((response) => response.json());
assert.equal(health.ok, true);

const unauthorizedImport = await fetch(`${endpoint}/api/import/discord-template/preview`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ source: "pNTb9KZuGEPX" }),
});
assert.equal(unauthorizedImport.status, 401);

const unauthorizedProfileRead = await fetch(`${endpoint}/api/profile`);
assert.equal(unauthorizedProfileRead.status, 401);

const unauthorizedProfileWrite = await fetch(`${endpoint}/api/profile`, {
  method: "POST",
  body: new FormData(),
});
assert.equal(unauthorizedProfileWrite.status, 401);

const unauthorizedAdminStats = await fetch(`${endpoint}/api/admin/stats?days=30`);
assert.equal(unauthorizedAdminStats.status, 401);

const rtcConfig = await fetch(`${endpoint}/api/rtc-config`).then((response) => response.json());
assert.equal(Array.isArray(rtcConfig.iceServers), true);
assert.equal(rtcConfig.iceServers.length > 0, true);
assert.equal(rtcConfig.iceServers.some((server) =>
  (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) => String(url).startsWith("stun:"))), true);

const visitor = io(endpoint, { transports: ["websocket"], forceNew: true });

try {
  await waitFor(visitor, "connect");
  const denied = waitFor(visitor, "session:error");
  visitor.emit("session:join", { name: "Visitante não autorizado" });
  const denial = await denied;
  assert.match(String(denial.message), /Discord/i);

  const rejectedDirectMessage = await new Promise((resolve) => {
    visitor.emit("dm:send", { recipientUserId: "usuario-inexistente", text: "teste privado" }, resolve);
  });
  assert.equal(rejectedDirectMessage.ok, false);

  const rejectedDirectHistory = await new Promise((resolve) => {
    visitor.emit("dm:history", { peerUserId: "usuario-inexistente" }, resolve);
  });
  assert.equal(rejectedDirectHistory.ok, false);

  const rejectedDirectDelete = await new Promise((resolve) => {
    visitor.emit("dm:delete", { messageId: "mensagem-inexistente" }, resolve);
  });
  assert.equal(rejectedDirectDelete.ok, false);

  const rejectedVoiceMove = await new Promise((resolve) => {
    visitor.emit("voice:move-member", { targetSocketId: "usuario-inexistente", channelId: "cafe" }, resolve);
  });
  assert.equal(rejectedVoiceMove.ok, false);
  assert.match(String(rejectedVoiceMove.error), /permissão/i);

  const rejectedVoiceModeration = await new Promise((resolve) => {
    visitor.emit("voice:moderate-member", { targetSocketId: "usuario-inexistente", action: "mute", enabled: true }, resolve);
  });
  assert.equal(rejectedVoiceModeration.ok, false);
  assert.match(String(rejectedVoiceModeration.error), /permissão/i);

  const rejectedMessageEdit = await new Promise((resolve) => {
    visitor.emit("chat:edit", { messageId: "mensagem-inexistente", text: "alterada" }, resolve);
  });
  assert.equal(rejectedMessageEdit.ok, false);

  const rejectedMessageDelete = await new Promise((resolve) => {
    visitor.emit("chat:delete", { messageId: "mensagem-inexistente" }, resolve);
  });
  assert.equal(rejectedMessageDelete.ok, false);
  assert.match(String(rejectedMessageDelete.error), /permissão/i);

  const rejectedReaction = await new Promise((resolve) => {
    visitor.emit("chat:react", { messageId: "mensagem-inexistente", emoji: "👍" }, resolve);
  });
  assert.equal(rejectedReaction.ok, false);

  const rejectedPin = await new Promise((resolve) => {
    visitor.emit("chat:pin", { messageId: "mensagem-inexistente", pinned: true }, resolve);
  });
  assert.equal(rejectedPin.ok, false);
  assert.match(String(rejectedPin.error), /permissão/i);

  console.log(`Smoke test aprovado: saúde, RTC, painel administrativo protegido, acesso local restrito, histórico/mensagens privadas e moderação autenticados (${health.community}).`);
} finally {
  visitor.disconnect();
}
