import type { Server, Socket } from "socket.io";
import {
  MAX_SCREEN_THUMBNAIL_LENGTH,
  mediaTrackMetaSchema,
  parsePayload,
  rtcSignalSchema,
  screenStartSchema,
  screenTargetSchema,
  screenThumbnailSchema,
  voiceJoinSchema,
  voiceMoveMemberSchema,
  voiceModerateMemberSchema,
  voiceStateSchema,
  type ChatAck,
} from "../shared/protocol.ts";
import { canDeafenVoiceMembers, canMoveVoiceMembers, canMuteVoiceMembers } from "./discord-integration.ts";
import type { CommunityConfig } from "./discord-template.ts";
import type { DailyTrafficStats } from "./traffic.ts";
import type { Member } from "./types.ts";

/** Live screen shares, their viewers and the optional post-restart voice recovery. */
export function createVoiceRegistry({ io, members }: { io: Server; members: Map<string, Member> }) {
  const activeScreens = new Map<string, {
    voiceChannelId: string;
    thumbnail: string;
    sharerDiscordUserId?: string;
    resolutionWidth?: number;
    resolutionHeight?: number;
  }>();
  const screenViewers = new Map<string, Set<string>>();
  const pendingVoiceRecovery = new Map<string, { stagingChannelId: string; targetChannelId: string }>();
  const completingVoiceRecovery = new Map<string, string>();

  const screensForVoiceChannel = (voiceChannelId: string) => [...activeScreens.entries()]
    .filter(([peerId, screen]) => {
      const member = members.get(peerId);
      return screen.voiceChannelId === voiceChannelId
        && member?.voiceChannelId === voiceChannelId
        && member.screenSharing;
    })
    .map(([peerId, screen]) => ({
      peerId,
      thumbnail: screen.thumbnail,
      sharerDiscordUserId: screen.sharerDiscordUserId,
      resolutionWidth: screen.resolutionWidth,
      resolutionHeight: screen.resolutionHeight,
    }));

  function emitScreenViewerCount(sharerId: string) {
    io.to(sharerId).emit("screen:viewer-count", { count: screenViewers.get(sharerId)?.size ?? 0 });
  }

  function removeScreenViewer(sharerId: string, viewerId: string) {
    const viewers = screenViewers.get(sharerId);
    if (!viewers?.delete(viewerId)) return;
    io.to(sharerId).emit("screen:viewer-left", { viewerId });
    emitScreenViewerCount(sharerId);
  }

  function removeViewerFromAllScreens(viewerId: string) {
    for (const sharerId of screenViewers.keys()) removeScreenViewer(sharerId, viewerId);
  }

  function clearScreenViewers(sharerId: string) {
    screenViewers.delete(sharerId);
    io.to(sharerId).emit("screen:viewer-count", { count: 0 });
  }

  // Takes one connection out of its voice room and tells the other participants.
  function removeFromVoice(target: Member) {
    if (!target.voiceChannelId) return;
    const room = `voice:${target.voiceChannelId}`;
    const targetSocket = io.sockets.sockets.get(target.socketId);
    removeViewerFromAllScreens(target.socketId);
    clearScreenViewers(target.socketId);
    activeScreens.delete(target.socketId);
    targetSocket?.leave(room);
    targetSocket?.to(room).emit("voice:member-left", target.socketId);
    targetSocket?.to(room).emit("screen:stop", { peerId: target.socketId });
    target.voiceChannelId = null;
    target.cameraEnabled = false;
    target.screenSharing = false;
    target.voiceDetected = false;
  }

  return {
    activeScreens,
    screenViewers,
    pendingVoiceRecovery,
    completingVoiceRecovery,
    screensForVoiceChannel,
    emitScreenViewerCount,
    removeScreenViewer,
    removeViewerFromAllScreens,
    clearScreenViewers,
    removeFromVoice,
  };
}

export type VoiceRegistry = ReturnType<typeof createVoiceRegistry>;

export type VoiceHandlerDependencies = {
  io: Server;
  members: Map<string, Member>;
  registry: VoiceRegistry;
  getCommunity: () => CommunityConfig;
  isAfkChannel: (channelId: string | null | undefined) => boolean;
  recordTraffic: (values: Partial<Omit<DailyTrafficStats, "date" | "uniqueUserIds">>, userId?: string) => void;
  broadcastMembers: () => void;
};

/** Registers voice rooms, moderation, screen sharing and WebRTC signaling handlers. */
export function registerVoiceHandlers(socket: Socket, dependencies: VoiceHandlerDependencies) {
  const { io, members, registry, getCommunity, isAfkChannel, recordTraffic, broadcastMembers } = dependencies;
  const {
    activeScreens,
    screenViewers,
    pendingVoiceRecovery,
    completingVoiceRecovery,
    screensForVoiceChannel,
    emitScreenViewerCount,
    removeScreenViewer,
    removeViewerFromAllScreens,
    clearScreenViewers,
    removeFromVoice,
  } = registry;

  socket.on("voice:join", async (payload: unknown) => {
    const { channelId: cleanChannelId } = parsePayload(voiceJoinSchema, payload);
    const member = members.get(socket.id);
    if (!member || !getCommunity().voiceChannels.some((channel) => channel.id === cleanChannelId)) return;

    const changedChannel = member.voiceChannelId !== cleanChannelId;
    member.lastActiveAt = Date.now();
    if (member.voiceChannelId) {
      removeViewerFromAllScreens(socket.id);
      clearScreenViewers(socket.id);
      activeScreens.delete(socket.id);
      socket.leave(`voice:${member.voiceChannelId}`);
      socket.to(`voice:${member.voiceChannelId}`).emit("voice:member-left", socket.id);
      socket.to(`voice:${member.voiceChannelId}`).emit("screen:stop", { peerId: socket.id });
    }
    member.voiceChannelId = cleanChannelId;
    const inAfkChannel = isAfkChannel(cleanChannelId);
    if (inAfkChannel) {
      member.micEnabled = false;
      member.deafened = true;
      member.voiceDetected = false;
      member.cameraEnabled = false;
      member.screenSharing = false;
    }
    if (member.serverMuted || member.serverDeafened) {
      member.micEnabled = false;
      member.deafened = member.serverDeafened;
      member.voiceDetected = false;
    }
    const room = `voice:${cleanChannelId}`;
    const sockets = await io.in(room).fetchSockets();
    socket.join(room);
    socket.emit("voice:moderation", {
      serverMuted: member.serverMuted,
      serverDeafened: member.serverDeafened,
    });
    // No audio connections are created in the AFK channel, so no sound flows either way.
    socket.emit("voice:peers", inAfkChannel ? [] : sockets.map((peer) => peer.id));
    socket.emit("screen:list", inAfkChannel ? [] : screensForVoiceChannel(cleanChannelId));
    if (changedChannel) recordTraffic({ voiceJoins: 1 }, member.metricsUserId);
    broadcastMembers();
    const recovery = pendingVoiceRecovery.get(socket.id);
    if (recovery?.stagingChannelId === cleanChannelId) {
      pendingVoiceRecovery.delete(socket.id);
      completingVoiceRecovery.set(socket.id, recovery.targetChannelId);
      setTimeout(() => {
        if (!members.has(socket.id)) return;
        socket.emit("voice:moved", {
          channelId: recovery.targetChannelId,
          channelName: getCommunity().voiceChannels.find((channel) => channel.id === recovery.targetChannelId)?.name ?? "sala anterior",
          movedBy: "KCord",
        });
      }, 900).unref();
    } else if (completingVoiceRecovery.get(socket.id) === cleanChannelId) {
      completingVoiceRecovery.delete(socket.id);
      console.info("Uma sessão de voz anterior foi recuperada automaticamente.");
    }
  });

  socket.on("voice:move-member", (payload: unknown, acknowledge?: (result: ChatAck) => void) => {
    const { targetSocketId: cleanTargetSocketId, channelId: cleanChannelId } = parsePayload(voiceMoveMemberSchema, payload);
    const moderator = members.get(socket.id);
    const target = members.get(cleanTargetSocketId);
    const destination = getCommunity().voiceChannels.find((channel) => channel.id === cleanChannelId);

    if (!moderator || !canMoveVoiceMembers(moderator.discordUserId, moderator.roleIds, getCommunity())) {
      acknowledge?.({ ok: false, error: "Você não tem permissão para mover membros." });
      return;
    }
    if (!target?.voiceChannelId) {
      acknowledge?.({ ok: false, error: "Esse usuário não está mais em uma sala de voz." });
      return;
    }
    if (!destination) {
      acknowledge?.({ ok: false, error: "A sala de destino não existe." });
      return;
    }
    if (target.socketId === moderator.socketId) {
      acknowledge?.({ ok: false, error: "Entre na sala desejada clicando nela." });
      return;
    }
    if (target.voiceChannelId === destination.id) {
      acknowledge?.({ ok: false, error: "O usuário já está nessa sala." });
      return;
    }

    io.to(target.socketId).emit("voice:moved", {
      channelId: destination.id,
      channelName: destination.name,
      movedBy: moderator.name,
    });
    acknowledge?.({ ok: true });
  });

  socket.on("voice:moderate-member", (payload: unknown, acknowledge?: (result: ChatAck) => void) => {
    const { targetSocketId, action: cleanAction, enabled } = parsePayload(voiceModerateMemberSchema, payload);
    const moderator = members.get(socket.id);
    const target = members.get(targetSocketId);
    const permitted = Boolean(moderator && (
      (cleanAction === "mute" && canMuteVoiceMembers(moderator.discordUserId, moderator.roleIds, getCommunity()))
      || (cleanAction === "deafen" && canDeafenVoiceMembers(moderator.discordUserId, moderator.roleIds, getCommunity()))
      || (cleanAction === "disconnect" && canMoveVoiceMembers(moderator.discordUserId, moderator.roleIds, getCommunity()))
    ));

    if (!permitted) {
      acknowledge?.({ ok: false, error: "Você não tem permissão para executar essa ação." });
      return;
    }
    if (!target?.voiceChannelId) {
      acknowledge?.({ ok: false, error: "Esse usuário não está mais em uma sala de voz." });
      return;
    }
    if (target.socketId === moderator?.socketId) {
      acknowledge?.({ ok: false, error: "Use seus próprios controles de áudio." });
      return;
    }

    if (cleanAction === "disconnect") {
      removeFromVoice(target);
      io.to(target.socketId).emit("voice:disconnected", { moderatedBy: moderator?.name });
      broadcastMembers();
      acknowledge?.({ ok: true });
      return;
    }

    if (cleanAction === "mute") {
      target.serverMuted = enabled;
      if (target.serverMuted) {
        target.micEnabled = false;
        target.voiceDetected = false;
      }
    } else if (cleanAction === "deafen") {
      target.serverDeafened = enabled;
      target.deafened = target.serverDeafened;
      if (target.serverDeafened) {
        target.micEnabled = false;
        target.voiceDetected = false;
      }
    }
    io.to(target.socketId).emit("voice:moderation", {
      serverMuted: target.serverMuted,
      serverDeafened: target.serverDeafened,
      moderatedBy: moderator?.name,
      action: cleanAction,
      enabled: enabled,
    });
    broadcastMembers();
    acknowledge?.({ ok: true });
  });

  socket.on("screen:list:request", () => {
    const member = members.get(socket.id);
    if (!member?.voiceChannelId) return;
    for (const [peerId, screen] of activeScreens) {
      const sharer = members.get(peerId);
      if (!sharer?.screenSharing || sharer.voiceChannelId !== screen.voiceChannelId) {
        activeScreens.delete(peerId);
        clearScreenViewers(peerId);
      }
    }
    socket.emit("screen:list", screensForVoiceChannel(member.voiceChannelId));
  });

  socket.on("voice:leave", () => {
    const member = members.get(socket.id);
    if (!member?.voiceChannelId) return;
    const room = `voice:${member.voiceChannelId}`;
    removeViewerFromAllScreens(socket.id);
    clearScreenViewers(socket.id);
    activeScreens.delete(socket.id);
    socket.leave(room);
    socket.to(room).emit("voice:member-left", socket.id);
    socket.to(room).emit("screen:stop", { peerId: socket.id });
    member.voiceChannelId = null;
    member.deafened = false;
    member.cameraEnabled = false;
    member.screenSharing = false;
    member.voiceDetected = false;
    broadcastMembers();
  });

  socket.on("voice:state", (payload: unknown) => {
    const { micEnabled, deafened, cameraEnabled, screenSharing, voiceDetected } = parsePayload(voiceStateSchema, payload);
    const member = members.get(socket.id);
    if (!member?.voiceChannelId) return;
    const wasScreenSharing = member.screenSharing || activeScreens.has(socket.id);
    const inAfkChannel = isAfkChannel(member.voiceChannelId);
    member.micEnabled = inAfkChannel || member.serverMuted || member.serverDeafened ? false : micEnabled;
    member.deafened = inAfkChannel || member.serverDeafened || deafened;
    member.cameraEnabled = !inAfkChannel && cameraEnabled;
    member.screenSharing = !inAfkChannel && screenSharing;
    if (wasScreenSharing && !member.screenSharing) {
      activeScreens.delete(socket.id);
      clearScreenViewers(socket.id);
      io.to(`voice:${member.voiceChannelId}`).emit("screen:stop", { peerId: socket.id });
    }
    member.voiceDetected = member.micEnabled && voiceDetected;
    if (member.voiceDetected || member.screenSharing || member.cameraEnabled) member.lastActiveAt = Date.now();
    broadcastMembers();
  });

  socket.on("media:track-meta", (payload: unknown) => {
    const { target, trackId, kind } = parsePayload(mediaTrackMetaSchema, payload);
    const sender = members.get(socket.id);
    const recipient = members.get(target);
    if (!sender?.voiceChannelId || sender.voiceChannelId !== recipient?.voiceChannelId) return;
    if (!trackId || !["camera", "screen"].includes(kind)) return;
    io.to(target).emit("media:track-meta", { from: socket.id, trackId, kind });
  });

  socket.on("screen:start", (payload: unknown) => {
    const { thumbnail: image, resolutionWidth: cleanResolutionWidth, resolutionHeight: cleanResolutionHeight } = parsePayload(screenStartSchema, payload);
    const member = members.get(socket.id);
    if (!member?.voiceChannelId || isAfkChannel(member.voiceChannelId) || !image.startsWith("data:image/jpeg;base64,") || image.length > MAX_SCREEN_THUMBNAIL_LENGTH) return;
    const startingNewShare = !activeScreens.has(socket.id);
    member.screenSharing = true;
    activeScreens.set(socket.id, {
      voiceChannelId: member.voiceChannelId,
      thumbnail: image,
      sharerDiscordUserId: member.discordUserId,
      resolutionWidth: Number.isFinite(cleanResolutionWidth) && cleanResolutionWidth >= 1 && cleanResolutionWidth <= 8192 ? cleanResolutionWidth : undefined,
      resolutionHeight: Number.isFinite(cleanResolutionHeight) && cleanResolutionHeight >= 1 && cleanResolutionHeight <= 8192 ? cleanResolutionHeight : undefined,
    });
    if (startingNewShare) screenViewers.set(socket.id, new Set());
    emitScreenViewerCount(socket.id);
    if (startingNewShare) recordTraffic({ screenShares: 1 }, member.metricsUserId);
    socket.to(`voice:${member.voiceChannelId}`).emit("screen:available", {
      peerId: socket.id,
      thumbnail: image,
      sharerDiscordUserId: member.discordUserId,
      resolutionWidth: Number.isFinite(cleanResolutionWidth) && cleanResolutionWidth >= 1 && cleanResolutionWidth <= 8192 ? cleanResolutionWidth : undefined,
      resolutionHeight: Number.isFinite(cleanResolutionHeight) && cleanResolutionHeight >= 1 && cleanResolutionHeight <= 8192 ? cleanResolutionHeight : undefined,
    });
    broadcastMembers();
  });

  socket.on("screen:thumbnail", (payload: unknown) => {
    const { thumbnail: image } = parsePayload(screenThumbnailSchema, payload);
    const member = members.get(socket.id);
    const current = activeScreens.get(socket.id);
    if (!member?.voiceChannelId || !current || !image.startsWith("data:image/jpeg;base64,") || image.length > MAX_SCREEN_THUMBNAIL_LENGTH) return;
    current.thumbnail = image;
    socket.to(`voice:${member.voiceChannelId}`).emit("screen:thumbnail", { peerId: socket.id, thumbnail: image });
  });

  socket.on("screen:stop", () => {
    const member = members.get(socket.id);
    if (!member?.voiceChannelId) return;
    activeScreens.delete(socket.id);
    clearScreenViewers(socket.id);
    member.screenSharing = false;
    socket.to(`voice:${member.voiceChannelId}`).emit("screen:stop", { peerId: socket.id });
    broadcastMembers();
  });

  socket.on("screen:subscribe", (payload: unknown) => {
    const { target: cleanTarget } = parsePayload(screenTargetSchema, payload);
    const viewer = members.get(socket.id);
    const sharer = members.get(cleanTarget);
    if (!cleanTarget || cleanTarget === socket.id || !viewer?.voiceChannelId || viewer.voiceChannelId !== sharer?.voiceChannelId || !activeScreens.has(cleanTarget)) return;
    const viewers = screenViewers.get(cleanTarget) ?? new Set<string>();
    screenViewers.set(cleanTarget, viewers);
    if (viewers.has(socket.id)) return;
    viewers.add(socket.id);
    io.to(cleanTarget).emit("screen:viewer-join", { viewerId: socket.id });
    emitScreenViewerCount(cleanTarget);
  });

  socket.on("screen:unsubscribe", (payload: unknown) => {
    const { target: cleanTarget } = parsePayload(screenTargetSchema, payload);
    if (!cleanTarget || cleanTarget === socket.id) return;
    removeScreenViewer(cleanTarget, socket.id);
  });

  socket.on("rtc:signal", (payload: unknown) => {
    const { target, description, candidate } = parsePayload(rtcSignalSchema, payload);
    const sender = members.get(socket.id);
    const recipient = members.get(target);
    if (!sender?.voiceChannelId || sender.voiceChannelId !== recipient?.voiceChannelId || isAfkChannel(sender.voiceChannelId)) return;
    io.to(target).emit("rtc:signal", { from: socket.id, description, candidate });
  });
}
