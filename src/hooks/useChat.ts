import { useCallback, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type FormEvent, type RefObject } from "react";
import type { Socket } from "socket.io-client";
import { MAX_UPLOAD_BYTES, formatSize } from "../lib/format";
import type { ChatMessage, DirectContact, DirectMessage, FileAttachment } from "../types";

type MainView = "text" | "voice" | "direct";
type Ack = { ok: boolean; error?: string };

/** The chat part of the `session:ready` payload. */
export type SessionChatPayload = {
  messages: ChatMessage[];
  channelUnread?: Record<string, number>;
  directMessages?: DirectMessage[];
  directUnread?: Record<string, number>;
};

/** What the chat needs from the rest of the app. Read through a ref, so it is always current. */
export type ChatOptions = {
  socketRef: RefObject<Socket | null>;
  mainViewRef: RefObject<MainView>;
  activeChannelRef: RefObject<string>;
  currentUserIdRef: RefObject<string | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  directFileInputRef: RefObject<HTMLInputElement | null>;
  activeChannel: string;
  authorName: string;
  getAvatarUrl: () => string | null | undefined;
  setNotice: (text: string) => void;
  /** Switches the UI to the private-conversation view. */
  showDirectView: () => void;
  /** Switches the UI back to the text-channel view. */
  showTextView: () => void;
  /** Closes the private-message context menu, or only if it is open on `messageId`. */
  closeDirectMessageMenu: (messageId?: string) => void;
};

/** Newest 500 messages are kept in memory. */
const MESSAGE_LIMIT = 500;
const appendUnique = <T extends { id: string }>(list: T[], message: T) =>
  list.some((candidate) => candidate.id === message.id) ? list : [...list.slice(-(MESSAGE_LIMIT - 1)), message];

/**
 * Channel chat and private messages: messages, drafts, replies, edits, pins,
 * unread counters, uploads and the socket event handlers that keep them in
 * sync. App owns navigation; this hook asks it to switch views through options.
 */
export function useChat(options: ChatOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [directMessages, setDirectMessages] = useState<DirectMessage[]>([]);
  const [directMessageDraft, setDirectMessageDraft] = useState("");
  const [activeDirectUserId, setActiveDirectUserId] = useState<string | null>(null);
  const [activeDirectContactHint, setActiveDirectContactHint] = useState<DirectContact | null>(null);
  const [directUnread, setDirectUnread] = useState<Record<string, number>>({});
  const [directUnreadOrder, setDirectUnreadOrder] = useState<string[]>([]);
  const [messageDraft, setMessageDraft] = useState("");
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingMessageDraft, setEditingMessageDraft] = useState("");
  const [channelUnread, setChannelUnread] = useState<Record<string, number>>({});
  const [showPinnedMessages, setShowPinnedMessages] = useState(false);
  const [uploading, setUploading] = useState(false);
  const activeDirectUserIdRef = useRef<string | null>(null);

  // ---- socket events (stable identities: safe to register once) ----

  /** Initial history and unread counters after (re)connecting. */
  const loadSession = useCallback((payload: SessionChatPayload) => {
    const { socketRef, activeChannelRef } = optionsRef.current;
    setMessages(payload.messages);
    setChannelUnread({ ...(payload.channelUnread ?? {}), [activeChannelRef.current]: 0 });
    socketRef.current?.emit("chat:read", { channelId: activeChannelRef.current });
    const initialDirectMessages = payload.directMessages ?? [];
    const initialDirectUnread = payload.directUnread ?? {};
    setDirectMessages(initialDirectMessages);
    setDirectUnread(initialDirectUnread);
    setDirectUnreadOrder(Object.keys(initialDirectUnread).filter((userId) => initialDirectUnread[userId] > 0).sort((left, right) => {
      const lastFrom = (userId: string) => [...initialDirectMessages].reverse().find((message) => message.fromUserId === userId)?.sentAt ?? "";
      return lastFrom(right).localeCompare(lastFrom(left));
    }));
  }, []);

  const onChatMessage = useCallback((message: ChatMessage) => {
    const { socketRef, mainViewRef, activeChannelRef } = optionsRef.current;
    setMessages((current) => [...current.slice(-(MESSAGE_LIMIT - 1)), message]);
    if (mainViewRef.current !== "text" || activeChannelRef.current !== message.channelId) {
      setChannelUnread((current) => ({ ...current, [message.channelId]: Math.min(99, (current[message.channelId] ?? 0) + 1) }));
    } else {
      socketRef.current?.emit("chat:read", { channelId: message.channelId });
    }
  }, []);

  const onChatReadState = useCallback(({ channelId, count }: { channelId?: string; count?: number }) => {
    if (typeof channelId !== "string") return;
    const unreadCount = Number.isFinite(Number(count)) ? Math.max(0, Math.min(99, Math.trunc(Number(count)))) : 0;
    setChannelUnread((current) => ({ ...current, [channelId]: unreadCount }));
  }, []);

  const onChatUpdate = useCallback((message: ChatMessage) => {
    setMessages((current) => current.map((candidate) => candidate.id === message.id ? message : candidate));
  }, []);

  const onChatDelete = useCallback(({ messageId }: { messageId?: string }) => {
    if (typeof messageId !== "string") return;
    setMessages((current) => current.filter((message) => message.id !== messageId));
    setReplyingTo((current) => current?.id === messageId ? null : current);
    setEditingMessageId((current) => current === messageId ? null : current);
  }, []);

  const onDirectMessage = useCallback((message: DirectMessage) => {
    const { socketRef, mainViewRef, currentUserIdRef } = optionsRef.current;
    setDirectMessages((current) => appendUnique(current, message));
    if (message.toUserId !== currentUserIdRef.current) return;
    const conversationIsOpen = mainViewRef.current === "direct" && activeDirectUserIdRef.current === message.fromUserId;
    if (conversationIsOpen) {
      socketRef.current?.emit("dm:read", { peerUserId: message.fromUserId });
      return;
    }
    setDirectUnread((current) => ({ ...current, [message.fromUserId]: (current[message.fromUserId] ?? 0) + 1 }));
    setDirectUnreadOrder((current) => [message.fromUserId, ...current.filter((userId) => userId !== message.fromUserId)]);
  }, []);

  const onDirectDelete = useCallback(({ messageId }: { messageId?: string }) => {
    if (typeof messageId !== "string") return;
    setDirectMessages((current) => current.filter((message) => message.id !== messageId));
    optionsRef.current.closeDirectMessageMenu(messageId);
  }, []);

  /** A local guest left: forget their conversations, and leave theirs if it was open. */
  const onDirectIdentityRemoved = useCallback(({ userId }: { userId: string }) => {
    setDirectMessages((current) => current.filter((message) => message.fromUserId !== userId && message.toUserId !== userId));
    setDirectUnread((current) => {
      const next = { ...current };
      delete next[userId];
      return next;
    });
    setDirectUnreadOrder((current) => current.filter((entry) => entry !== userId));
    if (activeDirectUserIdRef.current === userId) setActiveDirectContactHint(null);
    setActiveDirectUserId((current) => {
      if (current !== userId) return current;
      activeDirectUserIdRef.current = null;
      optionsRef.current.showTextView();
      return null;
    });
  }, []);

  // ---- channel chat ----

  const sendMessage = (event: FormEvent) => {
    event.preventDefault();
    const { socketRef, activeChannel, getAvatarUrl } = optionsRef.current;
    const text = messageDraft.trim();
    if (!text || !socketRef.current) return;
    socketRef.current.emit("chat:send", {
      channelId: activeChannel,
      text,
      avatarUrl: getAvatarUrl() ?? undefined,
      replyToId: replyingTo?.id,
    });
    setMessageDraft("");
    setReplyingTo(null);
  };

  const editMessage = (event: FormEvent, messageId: string) => {
    event.preventDefault();
    const { socketRef, setNotice } = optionsRef.current;
    const text = editingMessageDraft.trim();
    if (!text) return;
    socketRef.current?.emit("chat:edit", { messageId, text }, (result: Ack) => {
      if (!result?.ok) {
        setNotice(result?.error ?? "Não foi possível editar a mensagem.");
        return;
      }
      setEditingMessageId(null);
      setEditingMessageDraft("");
    });
  };

  const deleteMessage = (message: ChatMessage) => {
    const { socketRef, setNotice } = optionsRef.current;
    if (!window.confirm("Excluir esta mensagem? Essa ação não pode ser desfeita.")) return;
    socketRef.current?.emit("chat:delete", { messageId: message.id }, (result: Ack) => {
      if (!result?.ok) setNotice(result?.error ?? "Não foi possível excluir a mensagem.");
    });
  };

  const toggleMessageReaction = (messageId: string, emoji: string) => {
    const { socketRef, setNotice } = optionsRef.current;
    socketRef.current?.emit("chat:react", { messageId, emoji }, (result: Ack) => {
      if (!result?.ok) setNotice(result?.error ?? "Não foi possível reagir à mensagem.");
    });
  };

  const toggleMessagePin = (message: ChatMessage) => {
    const { socketRef, setNotice } = optionsRef.current;
    socketRef.current?.emit("chat:pin", { messageId: message.id, pinned: !message.pinned }, (result: Ack) => {
      if (!result?.ok) {
        setNotice(result?.error ?? "Não foi possível alterar a mensagem fixada.");
        return;
      }
      setNotice(message.pinned ? "Mensagem desafixada." : "Mensagem fixada.");
    });
  };

  const startEditingMessage = (message: ChatMessage) => {
    setEditingMessageId(message.id);
    setEditingMessageDraft(message.text);
    setReplyingTo(null);
  };

  const startReplyingToMessage = (message: ChatMessage) => {
    setReplyingTo(message);
    setEditingMessageId(null);
  };

  // ---- private messages ----

  const deleteDirectMessage = (message: DirectMessage) => {
    const { socketRef, setNotice, closeDirectMessageMenu } = optionsRef.current;
    closeDirectMessageMenu();
    const description = message.file
      ? "Excluir este arquivo da conversa e removê-lo imediatamente do servidor?"
      : "Excluir esta mensagem para todos? Essa ação não pode ser desfeita.";
    if (!window.confirm(description)) return;
    socketRef.current?.emit("dm:delete", { messageId: message.id }, (result: Ack) => {
      if (!result?.ok) {
        setNotice(result?.error ?? "Não foi possível excluir a mensagem privada.");
        return;
      }
      setDirectMessages((current) => current.filter((candidate) => candidate.id !== message.id));
    });
  };

  /** Opens a private conversation and loads its history. `contactHint` names the peer while offline. */
  const openDirectChat = (userId: string, contactHint: DirectContact | null) => {
    const { socketRef, setNotice, showDirectView } = optionsRef.current;
    activeDirectUserIdRef.current = userId;
    setActiveDirectContactHint(contactHint);
    setActiveDirectUserId(userId);
    showDirectView();
    setDirectUnread((current) => {
      const next = { ...current };
      delete next[userId];
      return next;
    });
    setDirectUnreadOrder((current) => current.filter((entry) => entry !== userId));
    socketRef.current?.emit("dm:read", { peerUserId: userId });
    socketRef.current?.emit("dm:history", { peerUserId: userId }, (result: { ok: boolean; messages?: DirectMessage[]; error?: string }) => {
      if (!result?.ok) {
        setNotice(result?.error ?? "Não foi possível carregar a conversa privada.");
        return;
      }
      setDirectMessages((current) => {
        const merged = new Map(current.map((message) => [message.id, message]));
        for (const message of result.messages ?? []) merged.set(message.id, message);
        return [...merged.values()]
          .sort((left, right) => Date.parse(left.sentAt) - Date.parse(right.sentAt))
          .slice(-MESSAGE_LIMIT);
      });
    });
  };

  const sendDirectMessage = (event: FormEvent) => {
    event.preventDefault();
    const { socketRef, setNotice, getAvatarUrl } = optionsRef.current;
    const text = directMessageDraft.trim();
    if (!text || !activeDirectUserId || !socketRef.current) return;
    socketRef.current.emit("dm:send", { recipientUserId: activeDirectUserId, text, avatarUrl: getAvatarUrl() ?? undefined }, (result: Ack) => {
      if (!result.ok) {
        setNotice(result.error ?? "Não foi possível enviar a mensagem privada.");
        return;
      }
      setDirectMessageDraft("");
    });
  };

  /** Forgets every private conversation, e.g. on logout. */
  const clearDirectInterface = () => {
    setDirectMessages([]);
    setDirectUnread({});
    setDirectUnreadOrder([]);
    setActiveDirectUserId(null);
    setActiveDirectContactHint(null);
    activeDirectUserIdRef.current = null;
    setDirectMessageDraft("");
    optionsRef.current.showTextView();
  };

  // ---- uploads ----

  const uploadFile = async (file?: File, recipientUserId?: string) => {
    const { socketRef, fileInputRef, directFileInputRef, activeChannel, authorName, setNotice } = optionsRef.current;
    if (!file || !socketRef.current) return;
    const clearFileInputs = () => {
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (directFileInputRef.current) directFileInputRef.current.value = "";
    };
    if (file.size > MAX_UPLOAD_BYTES) {
      setNotice("Esse arquivo excede o limite de 10 MB.");
      clearFileInputs();
      return;
    }
    if (!window.confirm(`Enviar ${file.name} (${formatSize(file.size)})?\n\nO limite é 10 MB e o arquivo será removido automaticamente após 3 dias.`)) {
      clearFileInputs();
      return;
    }
    setUploading(true);
    const body = new FormData();
    body.append("file", file);
    body.append("senderSocketId", socketRef.current.id ?? "");
    if (recipientUserId) body.append("recipientUserId", recipientUserId);
    else body.append("channelId", activeChannel);
    body.append("author", authorName);
    try {
      const response = await fetch("/api/files", { method: "POST", body });
      const result = await response.json() as {
        error?: string;
        file?: FileAttachment;
        message?: ChatMessage | DirectMessage;
      };
      if (!response.ok) throw new Error(result.error ?? "Não foi possível enviar o arquivo.");
      if (result.message) {
        if ("fromUserId" in result.message) {
          setDirectMessages((current) => appendUnique(current, result.message as DirectMessage));
        } else {
          setMessages((current) => appendUnique(current, result.message as ChatMessage));
        }
      }
      setNotice(`${file.name} foi enviado e ficará disponível por 3 dias.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Não foi possível enviar o arquivo.");
    } finally {
      setUploading(false);
      clearFileInputs();
    }
  };

  // A screenshot copied with Print Screen or Win+Shift+S reaches the paste
  // event as a file, usually named just "image.png".
  const pasteFile = (event: ReactClipboardEvent<HTMLInputElement>, recipientUserId?: string) => {
    const file = Array.from(event.clipboardData.files)[0];
    if (!file) return;
    event.preventDefault();
    if (uploading) return;
    const isScreenshot = file.type.startsWith("image/") && (!file.name || /^image\.\w+$/i.test(file.name));
    if (!isScreenshot) {
      void uploadFile(file, recipientUserId);
      return;
    }
    const extension = file.type.split("/")[1]?.replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "") || "png";
    const stamp = new Date().toISOString().slice(0, 19).replace("T", "-").replace(/:/g, "");
    void uploadFile(new File([file], `captura-${stamp}.${extension}`, { type: file.type }), recipientUserId);
  };

  return {
    messages,
    directMessages,
    directMessageDraft, setDirectMessageDraft,
    activeDirectUserId,
    activeDirectContactHint,
    activeDirectUserIdRef,
    directUnread,
    directUnreadOrder,
    messageDraft, setMessageDraft,
    replyingTo, setReplyingTo,
    editingMessageId, setEditingMessageId,
    editingMessageDraft, setEditingMessageDraft,
    channelUnread, setChannelUnread,
    showPinnedMessages, setShowPinnedMessages,
    uploading,
    loadSession, onChatMessage, onChatReadState, onChatUpdate, onChatDelete,
    onDirectMessage, onDirectDelete, onDirectIdentityRemoved,
    sendMessage, editMessage, deleteMessage, toggleMessageReaction, toggleMessagePin,
    startEditingMessage, startReplyingToMessage,
    deleteDirectMessage, openDirectChat, sendDirectMessage, clearDirectInterface,
    uploadFile, pasteFile,
  };
}
