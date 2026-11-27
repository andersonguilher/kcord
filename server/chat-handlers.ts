import { randomUUID } from "node:crypto";
import type { Server, Socket } from "socket.io";
import {
  ALLOWED_REACTIONS,
  chatChannelRefSchema,
  chatEditSchema,
  chatMessageRefSchema,
  chatPinSchema,
  chatReactSchema,
  chatSendSchema,
  dmMessageRefSchema,
  dmPeerRefSchema,
  dmSendSchema,
  parsePayload,
  type ChatAck,
} from "../shared/protocol.ts";
import { channelTextError } from "../shared/channel-rules.ts";
import type { ChatMessage, ChatStore, DirectMessage } from "./chat-store.ts";
import { canManageMessages } from "./discord-integration.ts";
import type { CommunityConfig } from "./discord-template.ts";
import type { DailyTrafficStats } from "./traffic.ts";
import type { Member } from "./types.ts";

export type ChatHandlerDependencies = {
  io: Server;
  communityRoom: string;
  members: Map<string, Member>;
  chatStore: ChatStore;
  getCommunity: () => CommunityConfig;
  recordTraffic: (values: Partial<Omit<DailyTrafficStats, "date" | "uniqueUserIds">>, userId?: string) => void;
  deleteStoredUpload: (fileUrl: string) => void;
  warmChannelLinkPreview: (channelId: string, text: string, userId?: string) => void;
  syncAuthenticatedMemberAvatar: (member: Member, candidate: unknown) => boolean;
  broadcastMembers: () => void;
  channelReadUserIdFor: (member: Member) => string;
  channelAuthorUserIdsFor: (member: Member) => string[];
  broadcastChannelReadState: (member: Member, channelId: string, count: number) => void;
  directConversationFor: (requester: Member, peerUserId: string) => DirectMessage[];
};

/** Registers channel chat (send, edit, delete, react, pin, read state) and direct-message handlers. */
export function registerChatHandlers(socket: Socket, dependencies: ChatHandlerDependencies) {
  const {
    io,
    communityRoom,
    members,
    chatStore,
    getCommunity,
    recordTraffic,
    deleteStoredUpload,
    warmChannelLinkPreview,
    syncAuthenticatedMemberAvatar,
    broadcastMembers,
    channelReadUserIdFor,
    channelAuthorUserIdsFor,
    broadcastChannelReadState,
    directConversationFor,
  } = dependencies;

  socket.on("chat:send", (payload: unknown, acknowledge?: (result: ChatAck) => void) => {
    const { channelId, text: cleanText, avatarUrl, replyToId } = parsePayload(chatSendSchema, payload);
    const member = members.get(socket.id);
    if (!member || !cleanText) return;
    member.lastActiveAt = Date.now();
    if (syncAuthenticatedMemberAvatar(member, avatarUrl)) broadcastMembers();

    const channel = getCommunity().textChannels.find((candidate) => candidate.id === channelId)
      ?? getCommunity().textChannels[0];
    const validChannelId = channel.id;
    const channelError = channelTextError(channel.name, cleanText);
    if (channelError) {
      acknowledge?.({ ok: false, error: channelError });
      return;
    }
    const storedReplyTarget = chatStore.getPublicMessage(replyToId);
    const replyTarget = storedReplyTarget?.channelId === validChannelId ? storedReplyTarget : undefined;
    const message: ChatMessage = {
      id: randomUUID(),
      channelId: validChannelId,
      author: member.name,
      authorUserId: member.kafcordUserId,
      text: cleanText,
      sentAt: new Date().toISOString(),
      authorAvatarUrl: member.avatarUrl,
      replyTo: replyTarget ? {
        id: replyTarget.id,
        author: replyTarget.author,
        text: (replyTarget.text || replyTarget.file?.name || "Anexo").slice(0, 180),
      } : undefined,
    };
    warmChannelLinkPreview(validChannelId, cleanText, member.authenticated ? member.kafcordUserId : undefined);
    chatStore.insertPublicMessage(message);
    recordTraffic({ publicMessages: 1 }, member.metricsUserId);
    io.to(communityRoom).emit("chat:message", message);
  });

  socket.on("chat:edit", (payload: unknown, acknowledge?: (result: ChatAck) => void) => {
    const { messageId, text: cleanText } = parsePayload(chatEditSchema, payload);
    const member = members.get(socket.id);
    const message = chatStore.getPublicMessage(messageId);
    if (!member?.kafcordUserId || !message || message.authorUserId !== member.kafcordUserId) {
      acknowledge?.({ ok: false, error: "Você só pode editar suas próprias mensagens." });
      return;
    }
    if (!cleanText || message.file) {
      acknowledge?.({ ok: false, error: "Essa mensagem não pode ser editada." });
      return;
    }
    const channelName = getCommunity().textChannels.find((channel) => channel.id === message.channelId)?.name ?? "";
    const channelError = channelTextError(channelName, cleanText);
    if (channelError) {
      acknowledge?.({ ok: false, error: channelError });
      return;
    }
    const editedAt = new Date().toISOString();
    warmChannelLinkPreview(message.channelId, cleanText, member.authenticated ? member.kafcordUserId : undefined);
    chatStore.editPublicMessage(message.id, cleanText, editedAt);
    io.to(communityRoom).emit("chat:update", { ...message, text: cleanText, editedAt });
    acknowledge?.({ ok: true });
  });

  socket.on("chat:delete", (payload: unknown, acknowledge?: (result: ChatAck) => void) => {
    const { messageId } = parsePayload(chatMessageRefSchema, payload);
    const member = members.get(socket.id);
    const message = chatStore.getPublicMessage(messageId);
    const ownsMessage = Boolean(member?.kafcordUserId && message?.authorUserId === member.kafcordUserId);
    const canModerate = Boolean(member && canManageMessages(member.discordUserId, member.roleIds, getCommunity()));
    if (!message || (!ownsMessage && !canModerate)) {
      acknowledge?.({ ok: false, error: "Você não tem permissão para excluir essa mensagem." });
      return;
    }
    chatStore.deletePublicMessage(message.id);
    if (message.file) {
      try {
        deleteStoredUpload(message.file.url);
      } catch (error) {
        console.warn(`Não foi possível remover o anexo da mensagem excluída ${message.id}.`, error);
      }
    }
    io.to(communityRoom).emit("chat:delete", { messageId: message.id, channelId: message.channelId });
    acknowledge?.({ ok: true });
  });

  socket.on("chat:react", (payload: unknown, acknowledge?: (result: ChatAck) => void) => {
    const { messageId: cleanMessageId, emoji: cleanEmoji } = parsePayload(chatReactSchema, payload);
    const member = members.get(socket.id);
    const message = chatStore.getPublicMessage(cleanMessageId);
    const allowedReactions = new Set<string>(ALLOWED_REACTIONS);
    if (!member?.kafcordUserId || !message || !allowedReactions.has(cleanEmoji)) {
      acknowledge?.({ ok: false, error: "Reação inválida." });
      return;
    }
    chatStore.toggleReaction(cleanMessageId, cleanEmoji, member.kafcordUserId);
    io.to(communityRoom).emit("chat:update", chatStore.getPublicMessage(cleanMessageId));
    acknowledge?.({ ok: true });
  });

  socket.on("chat:pin", (payload: unknown, acknowledge?: (result: ChatAck) => void) => {
    const { messageId, pinned } = parsePayload(chatPinSchema, payload);
    const member = members.get(socket.id);
    const message = chatStore.getPublicMessage(messageId);
    if (!member || !canManageMessages(member.discordUserId, member.roleIds, getCommunity())) {
      acknowledge?.({ ok: false, error: "Você não tem permissão para fixar mensagens." });
      return;
    }
    if (!message) {
      acknowledge?.({ ok: false, error: "A mensagem não existe mais." });
      return;
    }
    const isPinned = pinned;
    chatStore.setPublicMessagePinned(message.id, isPinned);
    io.to(communityRoom).emit("chat:update", { ...message, pinned: isPinned || undefined });
    acknowledge?.({ ok: true });
  });

  socket.on("chat:read", (payload: unknown, acknowledge?: (result: ChatAck) => void) => {
    const { channelId: cleanChannelId } = parsePayload(chatChannelRefSchema, payload);
    const member = members.get(socket.id);
    if (!member?.kafcordUserId || !getCommunity().textChannels.some((channel) => channel.id === cleanChannelId)) {
      acknowledge?.({ ok: false });
      return;
    }
    const readUserId = channelReadUserIdFor(member);
    chatStore.markChannelRead(readUserId, cleanChannelId);
    broadcastChannelReadState(member, cleanChannelId, 0);
    acknowledge?.({ ok: true });
  });

  socket.on("chat:mark-unread", (payload: unknown, acknowledge?: (result: ChatAck) => void) => {
    const { channelId: cleanChannelId } = parsePayload(chatChannelRefSchema, payload);
    const member = members.get(socket.id);
    if (!member?.kafcordUserId || !getCommunity().textChannels.some((channel) => channel.id === cleanChannelId)) {
      acknowledge?.({ ok: false });
      return;
    }
    const readUserId = channelReadUserIdFor(member);
    const authorUserIds = channelAuthorUserIdsFor(member);
    const count = chatStore.markChannelUnread(readUserId, cleanChannelId, authorUserIds);
    broadcastChannelReadState(member, cleanChannelId, count);
    acknowledge?.({ ok: true });
  });

  socket.on("dm:send", (payload: unknown, acknowledge?: (result: ChatAck) => void) => {
    const { recipientUserId: cleanRecipientUserId, text: cleanText, avatarUrl } = parsePayload(dmSendSchema, payload);
    const sender = members.get(socket.id);
    if (!sender?.kafcordUserId) {
      acknowledge?.({ ok: false, error: "Entre com Discord para enviar mensagens privadas." });
      return;
    }
    if (!cleanRecipientUserId || cleanRecipientUserId === sender.kafcordUserId || !cleanText) {
      acknowledge?.({ ok: false, error: "Destinatário ou mensagem inválida." });
      return;
    }
    sender.lastActiveAt = Date.now();
    if (syncAuthenticatedMemberAvatar(sender, avatarUrl)) broadcastMembers();

    const recipient = [...members.values()].find((member) => member.kafcordUserId === cleanRecipientUserId);
    const previousMessage = chatStore.lastDirectMessageBetween(sender.kafcordUserId, cleanRecipientUserId);
    const knownConversation = Boolean(previousMessage);
    if (!recipient && !knownConversation) {
      acknowledge?.({ ok: false, error: "Esse usuário não está disponível para mensagens." });
      return;
    }

    const message: DirectMessage = {
      id: randomUUID(),
      fromUserId: sender.kafcordUserId,
      toUserId: cleanRecipientUserId,
      fromDiscordUserId: sender.authDiscordUserId,
      toDiscordUserId: recipient?.authDiscordUserId ?? (previousMessage?.fromUserId === cleanRecipientUserId
        ? previousMessage?.fromDiscordUserId
        : previousMessage?.toDiscordUserId),
      author: sender.name,
      authorAvatarUrl: sender.avatarUrl,
      recipient: recipient?.name ?? (previousMessage?.fromUserId === cleanRecipientUserId ? previousMessage.author : previousMessage?.recipient) ?? "Usuário",
      recipientAvatarUrl: recipient?.avatarUrl ?? (previousMessage?.fromUserId === cleanRecipientUserId ? previousMessage.authorAvatarUrl : previousMessage?.recipientAvatarUrl),
      text: cleanText,
      sentAt: new Date().toISOString(),
    };
    chatStore.insertDirectMessage(message);
    recordTraffic({ privateMessages: 1 }, sender.metricsUserId);

    for (const participant of members.values()) {
      if (participant.kafcordUserId === sender.kafcordUserId || participant.kafcordUserId === cleanRecipientUserId) {
        io.to(participant.socketId).emit("dm:message", message);
      }
    }
    acknowledge?.({ ok: true });
  });

  socket.on("dm:read", (payload: unknown) => {
    const { peerUserId: cleanPeerUserId } = parsePayload(dmPeerRefSchema, payload);
    const reader = members.get(socket.id);
    if (!reader?.kafcordUserId || !cleanPeerUserId || cleanPeerUserId === reader.kafcordUserId) return;
    chatStore.markDirectRead(reader.kafcordUserId, cleanPeerUserId);
  });

  socket.on("dm:history", (
    payload: unknown,
    acknowledge?: (result: { ok: boolean; messages?: DirectMessage[]; error?: string }) => void,
  ) => {
    const { peerUserId: cleanPeerUserId } = parsePayload(dmPeerRefSchema, payload);
    const requester = members.get(socket.id);
    if (!requester?.kafcordUserId || !cleanPeerUserId || cleanPeerUserId === requester.kafcordUserId) {
      acknowledge?.({ ok: false, error: "Conversa privada inválida." });
      return;
    }
    const peer = [...members.values()].find((member) => member.kafcordUserId === cleanPeerUserId);
    const messages = directConversationFor(requester, cleanPeerUserId);
    if (!peer && messages.length === 0) {
      acknowledge?.({ ok: false, error: "Esse usuário não está disponível para mensagens." });
      return;
    }
    acknowledge?.({ ok: true, messages });
  });

  socket.on("dm:delete", (payload: unknown, acknowledge?: (result: ChatAck) => void) => {
    const { messageId } = parsePayload(dmMessageRefSchema, payload);
    const requester = members.get(socket.id);
    const message = chatStore.getDirectMessage(messageId);
    const ownsMessage = Boolean(requester?.kafcordUserId && message && (
      (requester.authDiscordUserId && message.fromDiscordUserId === requester.authDiscordUserId)
      || message.fromUserId === requester.kafcordUserId
    ));
    if (!message || !ownsMessage) {
      acknowledge?.({ ok: false, error: "Você só pode excluir mensagens privadas enviadas por você." });
      return;
    }
    if (message.file) {
      try {
        deleteStoredUpload(message.file.url);
      } catch (error) {
        console.warn(`Não foi possível remover o anexo privado ${message.id}.`, error);
        acknowledge?.({ ok: false, error: "Não foi possível remover o arquivo do servidor." });
        return;
      }
    }
    chatStore.deleteDirectMessage(message.id);
    for (const participant of members.values()) {
      const participatesByDiscord = Boolean(participant.authDiscordUserId && (
        participant.authDiscordUserId === message.fromDiscordUserId
        || participant.authDiscordUserId === message.toDiscordUserId
      ));
      if (participatesByDiscord || participant.kafcordUserId === message.fromUserId || participant.kafcordUserId === message.toUserId) {
        io.to(participant.socketId).emit("dm:delete", { messageId: message.id });
      }
    }
    acknowledge?.({ ok: true });
  });
}
