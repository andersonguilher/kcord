import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import multer from "multer";
import { Server } from "socket.io";
import { ChatStore, type ChatMessage, type DirectMessage } from "./chat-store.ts";
import { fetchDiscordTemplate, type CommunityConfig } from "./discord-template.ts";
import { createLinkPreviewRouter, warmLinkPreview } from "./link-preview.ts";
import { createClientReportsRouter } from "./client-reports.ts";
import { createTrafficTracker, emptyTrafficDay } from "./traffic.ts";
import { registerChatHandlers } from "./chat-handlers.ts";
import { createVoiceRegistry, registerVoiceHandlers } from "./voice-handlers.ts";
import { parsePayload, profileSyncSchema, sessionJoinSchema } from "../shared/protocol.ts";
import { SCREENSHOT_CHANNEL_ERROR, channelFileError, firstMessageUrl, isLinksChannel, isScreenshotChannel } from "../shared/channel-rules.ts";
import type { Member } from "./types.ts";
import { createFileStorage, isImageUpload } from "./files.ts";
import { readLiveKitConfig } from "./livekit.ts";
import { createLiveKitRouter } from "./livekit-routes.ts";
import { createDownloadsRouter } from "./downloads.ts";
import { appState, defaultDatabasePath } from "./app-state.ts";
import { createProfileStore, type UserProfile } from "./profiles.ts";
import { createVoiceEqStore, sanitizeVoiceEq } from "./voice-eq.ts";
import {
  createDiscordIntegrationRouter,
  getDiscordSocketIdentity,
  isDiscordOwner,
  kafcordDiscordIdentityMappings,
  kafcordUserIdsForDiscordUser,
} from "./discord-integration.ts";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST?.trim() || "0.0.0.0";
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const FILE_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const FILE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const communityRoom = "community:kafcord";
const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });
const members = new Map<string, Member>();
const voiceRegistry = createVoiceRegistry({ io, members });
const { activeScreens, pendingVoiceRecovery, completingVoiceRecovery, removeViewerFromAllScreens, clearScreenViewers } = voiceRegistry;
const voiceRecoveryStagingChannelId = process.env.VOICE_RECOVERY_STAGING_CHANNEL_ID?.trim() ?? "";
const voiceRecoveryTargetChannelId = process.env.VOICE_RECOVERY_TARGET_CHANNEL_ID?.trim() ?? "";
const voiceRecoveryDeadline = Date.now() + Math.min(5 * 60_000, Math.max(0, Number(process.env.VOICE_RECOVERY_WINDOW_MS) || 0));
const stunUrls = (process.env.RTC_STUN_URLS ?? "stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);
const turnUrls = (process.env.TURN_URLS ?? "")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);
const turnSharedSecret = process.env.TURN_SHARED_SECRET?.trim() ?? "";
const turnRealm = process.env.TURN_REALM?.trim() || "kafcord.kafly.com.br";
// Null unless LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET and LIVEKIT_VOICE_CHANNEL_IDS are all set.
const liveKitConfig = readLiveKitConfig();
const defaultCommunity: CommunityConfig = {
  name: "KCord",
  categories: [],
  textChannels: [
    { id: "geral", name: "geral", description: "A praça central da comunidade", categoryId: null, position: 0 },
    { id: "projetos", name: "projetos", description: "Ideias, progresso e colaboração", categoryId: null, position: 1 },
    { id: "musica", name: "música", description: "Faixas, referências e escuta coletiva", categoryId: null, position: 2 },
  ],
  voiceChannels: [
    { id: "cafe", name: "Café aberto", categoryId: null, position: 0 },
    { id: "estudio", name: "Estúdio", categoryId: null, position: 1 },
  ],
  roles: [],
};

function warmChannelLinkPreview(channelId: string, text: string, userId?: string) {
  if (!userId) return;
  const channel = community.textChannels.find((candidate) => candidate.id === channelId);
  const url = channel && isLinksChannel(channel.name) ? firstMessageUrl(text) : null;
  if (!url) return;
  void warmLinkPreview(url, userId).catch((error) => {
    console.warn("Não foi possível aquecer uma prévia do canal de links.", error);
  });
}

const dataDirectory = join(process.cwd(), "data");
const communityDataPath = join(dataDirectory, "community.json");
const chatDatabasePath = defaultDatabasePath();
mkdirSync(dataDirectory, { recursive: true });
// Sessions, profiles, reports and settings live in the same database file as the chat.
const state = appState();
const chatStore = new ChatStore(chatDatabasePath);
chatStore.backfillAttachmentExpiry(FILE_RETENTION_MS);
for (const mapping of kafcordDiscordIdentityMappings()) {
  chatStore.backfillDirectDiscordIdentity(mapping.kafcordUserId, mapping.discordUserId);
}



const profileStore = createProfileStore(state, dataDirectory);
const voiceEqStore = createVoiceEqStore(state, dataDirectory);
const { trafficStats, recordTraffic, relayLastUpdatedAt } = createTrafficTracker(state, dataDirectory);

const COMMUNITY_STATE_KEY = "community";

function loadCommunity() {
  if (state.importLegacyJson(COMMUNITY_STATE_KEY, communityDataPath) === "invalid") {
    console.warn("Configuração persistida inválida; usando a comunidade padrão.");
    return defaultCommunity;
  }
  try {
    const stored = state.get<CommunityConfig>(COMMUNITY_STATE_KEY);
    if (!stored) return defaultCommunity;
    if (!stored.name || !Array.isArray(stored.textChannels) || stored.textChannels.length === 0) {
      return defaultCommunity;
    }
    return stored;
  } catch {
    console.warn("Configuração persistida inválida; usando a comunidade padrão.");
    return defaultCommunity;
  }
}

function persistCommunity(nextCommunity: CommunityConfig) {
  state.set(COMMUNITY_STATE_KEY, nextCommunity);
}

let community = loadCommunity();

const AFK_CHECK_INTERVAL_MS = 15_000;

// The AFK channel is for inactive members: nobody there talks, hears or shares.
function isAfkChannel(channelId: string | null | undefined) {
  return Boolean(channelId && channelId === community.afkChannelId);
}

// Returns the AFK channel and timeout when the community has a valid one configured.
function afkSettings() {
  const channelId = community.afkChannelId;
  if (!channelId || !community.voiceChannels.some((channel) => channel.id === channelId)) return null;
  const seconds = Math.min(3600, Math.max(60, Math.round(Number(community.afkTimeoutSeconds) || 1800)));
  return { channelId, timeoutMs: seconds * 1000 };
}

const uploadDirectory = join(process.cwd(), "uploads");
mkdirSync(uploadDirectory, { recursive: true });
const avatarDirectory = join(uploadDirectory, "avatars");
mkdirSync(avatarDirectory, { recursive: true });
const downloadDirectory = process.env.KCORD_DOWNLOADS_DIR?.trim() || join(process.cwd(), "downloads");
mkdirSync(downloadDirectory, { recursive: true });
const upload = multer({
  dest: uploadDirectory,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});
const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: avatarDirectory,
    filename: (_request, file, callback) => {
      const extensions: Record<string, string> = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
      };
      callback(null, `${randomUUID()}${extensions[file.mimetype] ?? ".img"}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => callback(null, ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.mimetype)),
});

app.use((request, response, next) => {
  const bytesIn = Number(request.headers["content-length"] ?? 0) || 0;
  const isDownloadRequest = request.path === "/download" || request.path === "/downloads" || request.path.startsWith("/downloads/");
  response.once("finish", () => {
    const bytesOut = Number(response.getHeader("content-length") ?? 0) || 0;
    if (isDownloadRequest) {
      recordTraffic({ downloadRequests: 1, downloadBytesOut: bytesOut });
      return;
    }
    recordTraffic({ httpRequests: 1, bytesIn, bytesOut });
  });
  next();
});

// Browser clients do not send compressed JSON. Rejecting it removes an unnecessary
// decompression surface and mitigates body-parser compressed-body DoS advisories.
app.use(express.json({ limit: "32kb", inflate: false }));
app.use(createDiscordIntegrationRouter(() => community));
app.use(createLinkPreviewRouter((request) => getDiscordSocketIdentity(request.headers.cookie)?.kafcordUserId ?? null));
app.use(createClientReportsRouter({
  state,
  dataDirectory,
  identify: (request) => {
    const identity = getDiscordSocketIdentity(request.headers.cookie);
    return identity ? { discordUserId: identity.discordUserId, displayName: profileStore.get(identity.kafcordUserId)?.displayName || identity.displayName } : null;
  },
  isOwner: (request) => {
    const identity = getDiscordSocketIdentity(request.headers.cookie);
    return Boolean(identity && isDiscordOwner(identity.discordUserId));
  },
  // Owners online get the alert right away; the panel keeps the full list.
  onReport: (report) => {
    for (const [socketId, member] of members) {
      if (!member.authDiscordUserId || !isDiscordOwner(member.authDiscordUserId)) continue;
      io.to(socketId).emit("admin:client-report", { id: report.id, at: report.at, kind: report.kind, message: report.message, displayName: report.displayName });
    }
  },
}));
const { router: fileRouter, deleteStoredUpload } = createFileStorage({
  chatStore,
  uploadDirectory,
  avatarDirectory,
  retentionMs: FILE_RETENTION_MS,
  cleanupIntervalMs: FILE_CLEANUP_INTERVAL_MS,
});
app.use(fileRouter);
app.use(createDownloadsRouter(downloadDirectory));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, service: "kafcord-realtime", community: community.name });
});

app.get("/api/rtc-config", (request, response) => {
  const iceServers: { urls: string[]; username?: string; credential?: string }[] = [];
  if (stunUrls.length > 0) iceServers.push({ urls: stunUrls });

  if (turnUrls.length > 0 && turnSharedSecret) {
    const identity = getDiscordSocketIdentity(request.headers.cookie);
    const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60;
    const subject = identity?.kafcordUserId || randomUUID();
    const username = `${expiresAt}:${subject}`;
    const credential = createHmac("sha1", turnSharedSecret).update(username).digest("base64");
    iceServers.push({ urls: turnUrls, username, credential });
  }

  response.setHeader("Cache-Control", "no-store");
  response.json({
    iceServers,
    iceTransportPolicy: "all",
    turnRealm,
    // Voice channels served by LiveKit; every other channel uses the peer-to-peer mesh.
    ...(liveKitConfig ? { livekitChannelIds: liveKitConfig.channelIds === "*" ? "*" : [...liveKitConfig.channelIds] } : {}),
  });
});

app.use(createLiveKitRouter({
  config: liveKitConfig,
  members,
  getCommunity: () => community,
  identify: (request) => getDiscordSocketIdentity(request.headers.cookie),
  isAfkChannel,
}));

app.get("/api/profile", (request, response) => {
  const identity = getDiscordSocketIdentity(request.headers.cookie);
  if (!identity) {
    response.status(401).json({ error: "Entre com sua conta Discord para abrir o perfil." });
    return;
  }
  const profile = profileStore.get(identity.kafcordUserId);
  response.setHeader("Cache-Control", "no-store");
  response.json({
    userId: identity.kafcordUserId,
    displayName: profile?.displayName || identity.displayName,
    avatarUrl: profile?.avatarUrl ?? identity.avatarUrl ?? null,
  });
});

app.post("/api/profile", (request, response, next) => {
  if (!getDiscordSocketIdentity(request.headers.cookie)) {
    response.status(401).json({ error: "Entre com sua conta Discord para editar o perfil." });
    return;
  }
  next();
}, avatarUpload.single("avatar"), (request, response) => {
  const identity = getDiscordSocketIdentity(request.headers.cookie);
  if (!identity) {
    response.status(401).json({ error: "Entre com sua conta Discord para editar o perfil." });
    return;
  }
  const previous = profileStore.get(identity.kafcordUserId);
  const displayName = String(request.body.displayName ?? previous?.displayName ?? identity.displayName).trim().slice(0, 32);
  if (displayName.length < 2) {
    response.status(400).json({ error: "O nome precisa ter pelo menos 2 caracteres." });
    return;
  }
  const profile: UserProfile = {
    userId: identity.kafcordUserId,
    displayName,
    avatarUrl: request.file ? `/avatars/${request.file.filename}` : previous?.avatarUrl ?? identity.avatarUrl ?? null,
    updatedAt: new Date().toISOString(),
  };
  profileStore.save(profile);
  for (const member of members.values()) {
    if (member.kafcordUserId !== profile.userId || !member.authenticated) continue;
    member.name = profile.displayName;
    member.avatarUrl = profile.avatarUrl;
  }
  broadcastMembers();
  response.json(profile);
});

function requireCommunityOwner(request: express.Request, response: express.Response) {
  const identity = getDiscordSocketIdentity(request.headers.cookie);
  if (!identity) {
    response.status(401).json({ error: "Entre com sua conta Discord para continuar." });
    return false;
  }
  if (!isDiscordOwner(identity.discordUserId)) {
    response.status(403).json({ error: "Somente o proprietário do KCord pode importar modelos." });
    return false;
  }
  return true;
}

app.get("/api/admin/stats", (request, response) => {
  if (!requireCommunityOwner(request, response)) return;
  const requestedDays = Number(request.query.days ?? 30);
  const range = Math.max(7, Math.min(365, Number.isFinite(requestedDays) ? Math.round(requestedDays) : 30));
  const storedByDate = new Map(trafficStats.days.map((day) => [day.date, day]));
  const days = Array.from({ length: range }, (_, index) => {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - (range - index - 1));
    const key = date.toISOString().slice(0, 10);
    return storedByDate.get(key) ?? emptyTrafficDay(key);
  });
  const totals = days.reduce((summary, day) => ({
    httpRequests: summary.httpRequests + day.httpRequests,
    bytesIn: summary.bytesIn + day.bytesIn,
    bytesOut: summary.bytesOut + day.bytesOut,
    downloadRequests: summary.downloadRequests + day.downloadRequests,
    downloadBytesOut: summary.downloadBytesOut + day.downloadBytesOut,
    sessions: summary.sessions + day.sessions,
    uniqueUsers: summary.uniqueUsers + day.uniqueUserIds.length,
    publicMessages: summary.publicMessages + day.publicMessages,
    privateMessages: summary.privateMessages + day.privateMessages,
    voiceJoins: summary.voiceJoins + day.voiceJoins,
    screenShares: summary.screenShares + day.screenShares,
    fileUploads: summary.fileUploads + day.fileUploads,
    uploadedBytes: summary.uploadedBytes + day.uploadedBytes,
    networkBytesIn: summary.networkBytesIn + day.networkBytesIn,
    networkBytesOut: summary.networkBytesOut + day.networkBytesOut,
    relayBytesIn: summary.relayBytesIn + day.relayBytesIn,
    relayBytesOut: summary.relayBytesOut + day.relayBytesOut,
  }), {
    httpRequests: 0,
    bytesIn: 0,
    bytesOut: 0,
    downloadRequests: 0,
    downloadBytesOut: 0,
    sessions: 0,
    uniqueUsers: 0,
    publicMessages: 0,
    privateMessages: 0,
    voiceJoins: 0,
    screenShares: 0,
    fileUploads: 0,
    uploadedBytes: 0,
    networkBytesIn: 0,
    networkBytesOut: 0,
    relayBytesIn: 0,
    relayBytesOut: 0,
  });
  const uniqueUsers = new Set(days.flatMap((day) => day.uniqueUserIds)).size;
  response.setHeader("Cache-Control", "no-store");
  response.json({
    generatedAt: new Date().toISOString(),
    collectingSince: trafficStats.startedAt,
    networkSince: trafficStats.networkSince ?? null,
    relaySince: trafficStats.relaySince ?? null,
    relayUpdatedAt: relayLastUpdatedAt(),
    range,
    live: {
      connections: members.size,
      uniqueUsers: new Set(memberList().map((member) => member.kafcordUserId).filter(Boolean)).size,
      voiceUsers: memberList().filter((member) => member.voiceChannelId).length,
      activeStreams: activeScreens.size,
    },
    totals: { ...totals, uniqueUsers },
    days: days.map(({ uniqueUserIds, ...day }) => ({ ...day, uniqueUsers: uniqueUserIds.length })),
  });
});

app.post("/api/import/discord-template/preview", async (request, response) => {
  if (!requireCommunityOwner(request, response)) return;
  try {
    const preview = await fetchDiscordTemplate(String(request.body.source ?? ""));
    response.json(preview);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Não foi possível ler o modelo.";
    response.status(400).json({ error: message });
  }
});

app.post("/api/import/discord-template/apply", async (request, response) => {
  if (!requireCommunityOwner(request, response)) return;
  if (request.body.confirmation !== "IMPORTAR") {
    response.status(400).json({ error: "Confirmação de importação ausente." });
    return;
  }
  try {
    const preview = await fetchDiscordTemplate(String(request.body.source ?? ""));
    community = preview.community;
    persistCommunity(community);
    io.to(communityRoom).emit("community:update", community);
    response.json({ community, summary: preview.summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Não foi possível aplicar o modelo.";
    response.status(400).json({ error: message });
  }
});

app.post("/api/files", (request, response) => {
  const identity = getDiscordSocketIdentity(request.headers.cookie);
  if (!identity) {
    response.status(401).json({ error: "Entre com Discord para enviar arquivos." });
    return;
  }

  upload.single("file")(request, response, (uploadError) => {
    if (uploadError instanceof multer.MulterError && uploadError.code === "LIMIT_FILE_SIZE") {
      response.status(413).json({ error: "O arquivo excede o limite de 10 MB." });
      return;
    }
    if (uploadError) {
      response.status(400).json({ error: "Não foi possível receber o arquivo." });
      return;
    }
    if (!request.file) {
      response.status(400).json({ error: "Arquivo ausente." });
      return;
    }

    const requestedChannelId = String(request.body.channelId ?? "").slice(0, 100);
    const channelId = community.textChannels.some((channel) => channel.id === requestedChannelId)
      ? requestedChannelId
      : community.textChannels[0].id;
    const sentAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(sentAt) + FILE_RETENTION_MS).toISOString();
    const fileUrl = `/files/${request.file.filename}`;
    const senderSocketId = String(request.body.senderSocketId ?? "").trim().slice(0, 100);
    const sender = members.get(senderSocketId);
    if (!sender?.kafcordUserId || sender.authDiscordUserId !== identity.discordUserId) {
      deleteStoredUpload(fileUrl);
      response.status(409).json({ error: "Sua sessão em tempo real mudou. Reconecte o KCord e tente novamente." });
      return;
    }
    const senderUserId = sender.kafcordUserId;
    const requestedRecipientUserId = String(request.body.recipientUserId ?? "").trim().slice(0, 100);
    if (requestedRecipientUserId) {
      const recipient = [...members.values()].find((member) => member.kafcordUserId === requestedRecipientUserId);
      const previousMessage = chatStore.lastDirectMessageBetween(senderUserId, requestedRecipientUserId);
      if (requestedRecipientUserId === senderUserId || (!recipient && !previousMessage)) {
        deleteStoredUpload(fileUrl);
        response.status(400).json({ error: "Destinatário inválido ou indisponível para mensagens." });
        return;
      }
      const directMessage: DirectMessage = {
        id: randomUUID(),
        fromUserId: senderUserId,
        toUserId: requestedRecipientUserId,
        fromDiscordUserId: sender.authDiscordUserId,
        toDiscordUserId: recipient?.authDiscordUserId ?? (previousMessage?.fromUserId === requestedRecipientUserId
          ? previousMessage?.fromDiscordUserId
          : previousMessage?.toDiscordUserId),
        author: sender.name,
        authorAvatarUrl: sender.avatarUrl,
        recipient: recipient?.name ?? (previousMessage?.fromUserId === requestedRecipientUserId ? previousMessage.author : previousMessage?.recipient) ?? "Usuário",
        recipientAvatarUrl: recipient?.avatarUrl ?? (previousMessage?.fromUserId === requestedRecipientUserId ? previousMessage.authorAvatarUrl : previousMessage?.recipientAvatarUrl),
        text: "",
        sentAt,
        file: {
          name: request.file.originalname.slice(0, 160),
          url: fileUrl,
          size: request.file.size,
          expiresAt,
        },
      };
      try {
        chatStore.insertDirectMessage(directMessage);
      } catch (error) {
        deleteStoredUpload(fileUrl);
        console.error("Não foi possível persistir o upload privado.", error);
        response.status(500).json({ error: "Não foi possível salvar o arquivo." });
        return;
      }
      recordTraffic({ privateMessages: 1, fileUploads: 1, uploadedBytes: request.file.size }, identity.kafcordUserId);
      for (const participant of members.values()) {
        if (participant.kafcordUserId === senderUserId || participant.kafcordUserId === requestedRecipientUserId) {
          io.to(participant.socketId).emit("dm:message", directMessage);
        }
      }
      response.status(201).json({ file: directMessage.file, message: directMessage });
      return;
    }
    const channelName = community.textChannels.find((channel) => channel.id === channelId)?.name ?? "";
    const channelError = channelFileError(channelName, request.file.originalname.slice(0, 160))
      ?? (isScreenshotChannel(channelName) && !isImageUpload(request.file.path) ? SCREENSHOT_CHANNEL_ERROR : null);
    if (channelError) {
      deleteStoredUpload(fileUrl);
      response.status(415).json({ error: channelError });
      return;
    }
    const message: ChatMessage = {
      id: randomUUID(),
      channelId,
      author: sender.name,
      authorUserId: senderUserId,
      text: "",
      sentAt,
      authorAvatarUrl: sender.avatarUrl,
      file: {
        name: request.file.originalname.slice(0, 160),
        url: fileUrl,
        size: request.file.size,
        expiresAt,
      },
    };
    try {
      chatStore.insertPublicMessage(message);
    } catch (error) {
      deleteStoredUpload(fileUrl);
      console.error("Não foi possível persistir o upload.", error);
      response.status(500).json({ error: "Não foi possível salvar o arquivo." });
      return;
    }
    recordTraffic({ publicMessages: 1, fileUploads: 1, uploadedBytes: request.file.size }, identity.kafcordUserId);
    io.to(communityRoom).emit("chat:message", message);
    response.status(201).json({ file: message.file, message });
  });
});

function directConversationFor(requester: Member, peerUserId: string) {
  const peer = [...members.values()].find((member) => member.kafcordUserId === peerUserId);
  const requesterAliases = requester.authenticated && requester.authDiscordUserId
    ? [...new Set([requester.kafcordUserId!, ...kafcordUserIdsForDiscordUser(requester.authDiscordUserId)])]
    : [requester.kafcordUserId!];
  const peerAliases = peer?.authenticated && peer.authDiscordUserId
    ? [...new Set([peerUserId, ...kafcordUserIdsForDiscordUser(peer.authDiscordUserId)])]
    : [peerUserId];
  const requesterAliasSet = new Set(requesterAliases);
  const storedMessages = requester.authDiscordUserId && peer?.authDiscordUserId
    ? chatStore.directConversationBetweenDiscordUsers(requester.authDiscordUserId, peer.authDiscordUserId)
    : chatStore.directConversationBetweenAny(requesterAliases, peerAliases);
  return storedMessages.map((message) => {
    const requesterIsAuthor = message.fromDiscordUserId && requester.authDiscordUserId
      ? message.fromDiscordUserId === requester.authDiscordUserId
      : requesterAliasSet.has(message.fromUserId);
    return {
      ...message,
      fromUserId: requesterIsAuthor ? requester.kafcordUserId! : peerUserId,
      toUserId: requesterIsAuthor ? peerUserId : requester.kafcordUserId!,
      author: requesterIsAuthor ? requester.name : peer?.name ?? message.author,
      authorAvatarUrl: requesterIsAuthor ? requester.avatarUrl : peer?.avatarUrl ?? message.authorAvatarUrl,
      recipient: requesterIsAuthor ? peer?.name ?? message.recipient : requester.name,
      recipientAvatarUrl: requesterIsAuthor ? peer?.avatarUrl ?? message.recipientAvatarUrl : requester.avatarUrl,
    };
  });
}

app.get("/api/direct-messages/:peerUserId", (request, response) => {
  const identity = getDiscordSocketIdentity(request.headers.cookie);
  if (!identity) {
    response.status(401).json({ error: "Entre com Discord para acessar mensagens privadas." });
    return;
  }
  const senderSocketId = String(request.query.senderSocketId ?? "").trim().slice(0, 100);
  const requester = members.get(senderSocketId);
  if (!requester?.kafcordUserId || requester.authDiscordUserId !== identity.discordUserId) {
    response.status(409).json({ error: "Sua sessão em tempo real mudou. Reconecte o KCord e tente novamente." });
    return;
  }
  const peerUserId = String(request.params.peerUserId ?? "").trim().slice(0, 100);
  if (!peerUserId || peerUserId === requester.kafcordUserId) {
    response.status(400).json({ error: "Conversa privada inválida." });
    return;
  }
  response.json({ messages: directConversationFor(requester, peerUserId) });
});

function memberList() {
  // Idle time stays on the server.
  return [...members.values()].map(({ lastActiveAt: _lastActiveAt, metricsUserId: _metricsUserId, authDiscordUserId: _authDiscordUserId, ...member }) => member);
}

function broadcastMembers() {
  io.to(communityRoom).emit("members:update", memberList());
}

function verifiedMemberAvatarUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const candidate = value.trim();
  if (/^\/avatars\/[a-f0-9-]+\.(?:jpg|png|webp|gif)$/i.test(candidate)) return candidate;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:") return undefined;
    if (url.hostname !== "cdn.discordapp.com" && url.hostname !== "media.discordapp.net") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function syncAuthenticatedMemberAvatar(member: Member, candidate: unknown) {
  if (!member.authenticated) return false;
  const avatarUrl = verifiedMemberAvatarUrl(candidate);
  if (!avatarUrl || avatarUrl === member.avatarUrl) return false;
  member.avatarUrl = avatarUrl;
  if (member.kafcordUserId) chatStore.updateDirectAvatar(member.kafcordUserId, avatarUrl);
  return true;
}

function directHistoryFor(userId: string) {
  return chatStore.directHistoryFor(userId);
}

function directUnreadFor(userId: string) {
  return chatStore.directUnreadFor(userId);
}

function clearLocalGuestData(userId: string) {
  chatStore.deleteDirectDataForUser(userId);
}

function channelReadUserIdFor(member: Member) {
  return member.authenticated && member.authDiscordUserId
    ? `discord:${member.authDiscordUserId}`
    : member.kafcordUserId!;
}

function channelAuthorUserIdsFor(member: Member) {
  return member.authenticated && member.authDiscordUserId
    ? [...new Set([member.kafcordUserId!, ...kafcordUserIdsForDiscordUser(member.authDiscordUserId)])]
    : [member.kafcordUserId!];
}

function sameChannelReadIdentity(left: Member, right: Member) {
  return left.authenticated && left.authDiscordUserId
    ? right.authenticated && right.authDiscordUserId === left.authDiscordUserId
    : right.kafcordUserId === left.kafcordUserId;
}

function broadcastChannelReadState(member: Member, channelId: string, count: number) {
  for (const candidate of members.values()) {
    if (sameChannelReadIdentity(member, candidate)) {
      io.to(candidate.socketId).emit("chat:read-state", { channelId, count });
    }
  }
}

io.on("connection", (socket) => {
  socket.on("session:join", (payload: unknown) => {
    const { localGuest, avatarUrl } = parsePayload(sessionJoinSchema, payload);
    const identity = getDiscordSocketIdentity(socket.request.headers.cookie);
    const requestedLocalGuestName = localGuest?.name ?? "";
    const validLocalGuest = Boolean(
      identity
      && isDiscordOwner(identity.discordUserId)
      && localGuest
      && requestedLocalGuestName,
    );

    if (!identity) {
      socket.emit("session:error", { message: "Entre com Discord para acessar o KCord." });
      return;
    }

    // One live session per Discord account: the newest device wins and every older
    // session of the same account (another PC, phone or tab) is disconnected.
    if (!validLocalGuest) {
      for (const other of [...members.values()]) {
        if (other.socketId === socket.id || !other.authenticated || other.authDiscordUserId !== identity.discordUserId) continue;
        const otherSocket = io.sockets.sockets.get(other.socketId);
        otherSocket?.emit("session:replaced");
        otherSocket?.disconnect(true);
      }
    }

    const localGuestUserId = validLocalGuest ? `local:${randomUUID()}` : undefined;
    const effectiveUserId = localGuestUserId ?? identity.kafcordUserId;
    const channelReadUserId = validLocalGuest ? effectiveUserId : `discord:${identity.discordUserId}`;
    const authorUserIds = validLocalGuest
      ? [effectiveUserId]
      : [...new Set([identity.kafcordUserId, ...kafcordUserIdsForDiscordUser(identity.discordUserId)])];
    if (!validLocalGuest) chatStore.mergeChannelReadIdentity(channelReadUserId, authorUserIds);
    const profile = profileStore.get(identity.kafcordUserId);
    const cleanName = validLocalGuest ? requestedLocalGuestName : (profile?.displayName || identity.displayName).slice(0, 32);
    members.set(socket.id, {
      socketId: socket.id,
      name: cleanName,
      voiceChannelId: null,
      authenticated: !validLocalGuest,
      discordUserId: validLocalGuest ? undefined : identity.discordUserId,
      authDiscordUserId: identity.discordUserId,
      kafcordUserId: effectiveUserId,
      metricsUserId: identity.kafcordUserId,
      roleIds: validLocalGuest ? [] : identity.roleIds,
      avatarUrl: validLocalGuest ? undefined : profile?.avatarUrl ?? identity.avatarUrl ?? verifiedMemberAvatarUrl(avatarUrl),
      micEnabled: true,
      deafened: false,
      serverMuted: false,
      serverDeafened: false,
      cameraEnabled: false,
      screenSharing: false,
      voiceDetected: false,
      lastActiveAt: Date.now(),
    });
    socket.join(communityRoom);
    socket.emit("session:ready", {
      messages: chatStore.listPublicMessages(),
      channelUnread: chatStore.channelUnreadFor(channelReadUserId, community.textChannels.map((channel) => channel.id), authorUserIds),
      directMessages: directHistoryFor(effectiveUserId),
      directUnread: directUnreadFor(effectiveUserId),
      members: memberList(),
      community,
      voiceEq: voiceEqStore.get(),
      clientBuild,
    });
    recordTraffic({ sessions: 1 }, identity.kafcordUserId);
    broadcastMembers();
    if (
      Date.now() < voiceRecoveryDeadline
      && voiceRecoveryStagingChannelId
      && voiceRecoveryTargetChannelId
      && voiceRecoveryStagingChannelId !== voiceRecoveryTargetChannelId
      && community.voiceChannels.some((channel) => channel.id === voiceRecoveryStagingChannelId)
      && community.voiceChannels.some((channel) => channel.id === voiceRecoveryTargetChannelId)
    ) {
      pendingVoiceRecovery.set(socket.id, {
        stagingChannelId: voiceRecoveryStagingChannelId,
        targetChannelId: voiceRecoveryTargetChannelId,
      });
      setTimeout(() => {
        const current = members.get(socket.id);
        if (!current || current.voiceChannelId) {
          pendingVoiceRecovery.delete(socket.id);
          return;
        }
        socket.emit("voice:moved", {
          channelId: voiceRecoveryStagingChannelId,
          channelName: "recuperação da chamada",
          movedBy: "KCord",
        });
      }, 750).unref();
      setTimeout(() => pendingVoiceRecovery.delete(socket.id), 20_000).unref();
    }
  });

  // Only the owner's own Discord session may change it (not a local guest
  // opened from the owner's account).
  socket.on("voice:eq:set", (payload: unknown) => {
    const member = members.get(socket.id);
    if (!member?.authenticated || !isDiscordOwner(member.authDiscordUserId)) return;
    const next = sanitizeVoiceEq(payload);
    if (!next) return;
    voiceEqStore.set(next);
    io.to(communityRoom).emit("voice:eq", voiceEqStore.get());
  });

  // Sent by the client, at most about once a minute, while the user interacts with the app.
  socket.on("activity:ping", () => {
    const member = members.get(socket.id);
    if (member) member.lastActiveAt = Date.now();
  });

  socket.on("profile:sync", (payload: unknown) => {
    const { avatarUrl } = parsePayload(profileSyncSchema, payload);
    const member = members.get(socket.id);
    if (member && syncAuthenticatedMemberAvatar(member, avatarUrl)) broadcastMembers();
  });

  registerChatHandlers(socket, {
    io,
    communityRoom,
    members,
    chatStore,
    getCommunity: () => community,
    recordTraffic,
    deleteStoredUpload,
    warmChannelLinkPreview,
    syncAuthenticatedMemberAvatar,
    broadcastMembers,
    channelReadUserIdFor,
    channelAuthorUserIdsFor,
    broadcastChannelReadState,
    directConversationFor,
  });

  registerVoiceHandlers(socket, {
    io,
    members,
    registry: voiceRegistry,
    getCommunity: () => community,
    isAfkChannel,
    recordTraffic,
    broadcastMembers,
  });

  socket.on("disconnect", () => {
    pendingVoiceRecovery.delete(socket.id);
    completingVoiceRecovery.delete(socket.id);
    const member = members.get(socket.id);
    removeViewerFromAllScreens(socket.id);
    clearScreenViewers(socket.id);
    if (member?.voiceChannelId) {
      activeScreens.delete(socket.id);
      socket.to(`voice:${member.voiceChannelId}`).emit("voice:member-left", socket.id);
      socket.to(`voice:${member.voiceChannelId}`).emit("screen:stop", { peerId: socket.id });
    }
    if (member?.kafcordUserId?.startsWith("local:")) {
      clearLocalGuestData(member.kafcordUserId);
      io.to(communityRoom).emit("dm:identity-removed", { userId: member.kafcordUserId });
    }
    members.delete(socket.id);
    broadcastMembers();
  });
});

// Moves idle voice members to the AFK channel. The client performs the move,
// which also mutes the microphone and audio until the member picks another channel.
setInterval(() => {
  const afk = afkSettings();
  if (!afk) return;
  const now = Date.now();
  for (const member of members.values()) {
    if (!member.voiceChannelId || member.voiceChannelId === afk.channelId) continue;
    if (member.voiceDetected || member.screenSharing || member.cameraEnabled) {
      member.lastActiveAt = now;
      continue;
    }
    if (now - member.lastActiveAt < afk.timeoutMs) continue;
    // Reset so an unresponsive client is not asked again on every check.
    member.lastActiveAt = now;
    io.to(member.socketId).emit("voice:afk", { channelId: afk.channelId });
  }
}, AFK_CHECK_INTERVAL_MS).unref();

const staticDirectory = join(process.cwd(), "dist");
// Name of the client bundle this server ships (e.g. "index-Lbqn0vKH.js"). Clients
// still running an older bundle reload when they reconnect after a deploy.
const clientBuild = (() => {
  try {
    return readFileSync(join(staticDirectory, "index.html"), "utf8").match(/\/assets\/(index-[\w-]+\.js)/)?.[1] ?? null;
  } catch {
    return null;
  }
})();
if (existsSync(staticDirectory)) {
  app.use(express.static(staticDirectory));
  app.use((_request, response) => response.sendFile(join(staticDirectory, "index.html")));
}

server.listen(port, host, () => {
  console.log(`KCord disponível em http://${host}:${port}`);
});
