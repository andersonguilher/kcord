// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { FormEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat, type ChatOptions } from "../src/hooks/useChat.ts";
import type { ChatMessage, DirectMessage } from "../src/types.ts";

type Emit = ReturnType<typeof vi.fn>;

let emit: Emit;
let setNotice: ReturnType<typeof vi.fn>;
let showDirectView: ReturnType<typeof vi.fn>;
let showTextView: ReturnType<typeof vi.fn>;
let closeDirectMessageMenu: ReturnType<typeof vi.fn>;
let refs: {
  mainView: { current: "text" | "voice" | "direct" };
  activeChannel: { current: string };
  currentUserId: { current: string | null };
};
let socket: { id: string; emit: Emit } | null;
let overrides: Partial<ChatOptions>;

const submit = () => ({ preventDefault: vi.fn() }) as unknown as FormEvent;

function chatMessage(id: string, channelId = "geral", extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, channelId, author: "Ana", text: `texto ${id}`, sentAt: "2026-11-14T10:00:00Z", ...extra } as ChatMessage;
}

function dm(id: string, from: string, to: string, sentAt = "2026-11-14T10:00:00Z", extra: Partial<DirectMessage> = {}): DirectMessage {
  return { id, fromUserId: from, toUserId: to, author: from, recipient: to, text: `dm ${id}`, sentAt, ...extra } as DirectMessage;
}

function mount() {
  return renderHook(
    (props: { activeChannel: string }) =>
      useChat({
        socketRef: { current: socket as never },
        mainViewRef: refs.mainView,
        activeChannelRef: refs.activeChannel,
        currentUserIdRef: refs.currentUserId,
        fileInputRef: { current: null },
        directFileInputRef: { current: null },
        activeChannel: props.activeChannel,
        authorName: "Ana",
        getAvatarUrl: () => "/avatars/ana.png",
        setNotice,
        showDirectView,
        showTextView,
        closeDirectMessageMenu,
        ...overrides,
      }),
    { initialProps: { activeChannel: "geral" } },
  );
}

/** The acknowledgement callback of the most recent emit with this event name. */
function lastAck(event: string) {
  const call = [...emit.mock.calls].reverse().find(([name]) => name === event);
  return call?.[call.length - 1] as (result: unknown) => void;
}

beforeEach(() => {
  emit = vi.fn();
  socket = { id: "sock-1", emit };
  setNotice = vi.fn();
  showDirectView = vi.fn();
  showTextView = vi.fn();
  closeDirectMessageMenu = vi.fn();
  refs = { mainView: { current: "text" }, activeChannel: { current: "geral" }, currentUserId: { current: "me" } };
  overrides = {};
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("window", Object.assign(window, { confirm: vi.fn(() => true) }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("loading a session", () => {
  it("restores history and unread counters, and reads the open channel", () => {
    const { result } = mount();
    act(() => result.current.loadSession({
      messages: [chatMessage("a"), chatMessage("b", "outro")],
      channelUnread: { outro: 3, geral: 9 },
      directMessages: [dm("d1", "u1", "me"), dm("d2", "u2", "me", "2026-11-14T11:00:00Z")],
      directUnread: { u1: 2, u2: 1, u3: 0 },
    }));
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.channelUnread).toEqual({ outro: 3, geral: 0 });
    expect(emit).toHaveBeenCalledWith("chat:read", { channelId: "geral" });
    expect(result.current.directMessages).toHaveLength(2);
    expect(result.current.directUnread).toEqual({ u1: 2, u2: 1, u3: 0 });
    // Newest conversation first, and conversations with nothing unread are left out.
    expect(result.current.directUnreadOrder).toEqual(["u2", "u1"]);
  });

  it("copes with a payload that has no private messages", () => {
    const { result } = mount();
    act(() => result.current.loadSession({ messages: [] }));
    expect(result.current.directMessages).toEqual([]);
    expect(result.current.directUnreadOrder).toEqual([]);
  });
});

describe("incoming channel events", () => {
  it("marks the channel read when it is open on the text view", () => {
    const { result } = mount();
    act(() => result.current.onChatMessage(chatMessage("a", "geral")));
    expect(result.current.messages.map((message) => message.id)).toEqual(["a"]);
    expect(emit).toHaveBeenCalledWith("chat:read", { channelId: "geral" });
    expect(result.current.channelUnread).toEqual({});
  });

  it("counts unread for other channels and for non-text views, capped at 99", () => {
    const { result } = mount();
    act(() => result.current.onChatMessage(chatMessage("a", "outro")));
    expect(result.current.channelUnread.outro).toBe(1);
    refs.mainView.current = "voice";
    act(() => result.current.onChatMessage(chatMessage("b", "geral")));
    expect(result.current.channelUnread.geral).toBe(1);
    act(() => {
      for (let index = 0; index < 120; index += 1) result.current.onChatMessage(chatMessage(`m${index}`, "outro"));
    });
    expect(result.current.channelUnread.outro).toBe(99);
    expect(emit).not.toHaveBeenCalledWith("chat:read", expect.anything());
  });

  it("keeps only the newest 500 messages", () => {
    const { result } = mount();
    act(() => {
      for (let index = 0; index < 505; index += 1) result.current.onChatMessage(chatMessage(`m${index}`));
    });
    expect(result.current.messages).toHaveLength(500);
    expect(result.current.messages[0].id).toBe("m5");
    expect(result.current.messages.at(-1)?.id).toBe("m504");
  });

  it("applies server read-state, clamping and ignoring bad values", () => {
    const { result } = mount();
    act(() => result.current.onChatReadState({ channelId: "outro", count: 5 }));
    act(() => result.current.onChatReadState({ channelId: "geral", count: 500 }));
    act(() => result.current.onChatReadState({ channelId: "x", count: -3 }));
    act(() => result.current.onChatReadState({ channelId: "y", count: Number.NaN }));
    act(() => result.current.onChatReadState({ count: 4 }));
    expect(result.current.channelUnread).toEqual({ outro: 5, geral: 99, x: 0, y: 0 });
  });

  it("replaces an updated message and drops a deleted one, cancelling reply and edit on it", () => {
    const { result } = mount();
    act(() => result.current.onChatMessage(chatMessage("a")));
    act(() => result.current.onChatMessage(chatMessage("b")));
    act(() => result.current.onChatUpdate(chatMessage("a", "geral", { text: "novo" })));
    expect(result.current.messages[0].text).toBe("novo");

    act(() => result.current.startReplyingToMessage(chatMessage("a")));
    act(() => result.current.onChatDelete({ messageId: "b" }));
    expect(result.current.replyingTo?.id).toBe("a");
    act(() => result.current.onChatDelete({ messageId: "a" }));
    expect(result.current.messages).toEqual([]);
    expect(result.current.replyingTo).toBeNull();
    act(() => result.current.onChatDelete({}));
  });
});

describe("incoming private messages", () => {
  it("stores a message once and ignores duplicates", () => {
    const { result } = mount();
    act(() => result.current.onDirectMessage(dm("d1", "u1", "me")));
    act(() => result.current.onDirectMessage(dm("d1", "u1", "me")));
    expect(result.current.directMessages).toHaveLength(1);
  });

  it("does not count messages I sent as unread", () => {
    const { result } = mount();
    act(() => result.current.onDirectMessage(dm("d1", "me", "u1")));
    expect(result.current.directUnread).toEqual({});
  });

  it("counts unread and brings the sender to the front of the order", () => {
    const { result } = mount();
    act(() => result.current.onDirectMessage(dm("d1", "u1", "me")));
    act(() => result.current.onDirectMessage(dm("d2", "u2", "me")));
    act(() => result.current.onDirectMessage(dm("d3", "u1", "me")));
    expect(result.current.directUnread).toEqual({ u1: 2, u2: 1 });
    expect(result.current.directUnreadOrder).toEqual(["u1", "u2"]);
    expect(emit).not.toHaveBeenCalledWith("dm:read", expect.anything());
  });

  it("marks the conversation read instead of counting it when it is open", () => {
    const { result } = mount();
    act(() => result.current.openDirectChat("u1", null));
    emit.mockClear();
    refs.mainView.current = "direct";
    act(() => result.current.onDirectMessage(dm("d1", "u1", "me")));
    expect(emit).toHaveBeenCalledWith("dm:read", { peerUserId: "u1" });
    expect(result.current.directUnread).toEqual({});
  });

  it("removes a deleted message and closes its menu", () => {
    const { result } = mount();
    act(() => result.current.onDirectMessage(dm("d1", "u1", "me")));
    act(() => result.current.onDirectDelete({ messageId: "d1" }));
    expect(result.current.directMessages).toEqual([]);
    expect(closeDirectMessageMenu).toHaveBeenCalledWith("d1");
    closeDirectMessageMenu.mockClear();
    act(() => result.current.onDirectDelete({}));
    expect(closeDirectMessageMenu).not.toHaveBeenCalled();
  });

  it("forgets a removed guest and leaves their open conversation", () => {
    const { result } = mount();
    act(() => result.current.onDirectMessage(dm("d1", "guest", "me")));
    act(() => result.current.onDirectMessage(dm("d2", "u2", "me")));
    act(() => result.current.openDirectChat("guest", null));
    showTextView.mockClear();
    act(() => result.current.onDirectIdentityRemoved({ userId: "guest" }));
    expect(result.current.directMessages.map((message) => message.id)).toEqual(["d2"]);
    expect(result.current.directUnread).toEqual({ u2: 1 });
    expect(result.current.directUnreadOrder).toEqual(["u2"]);
    expect(result.current.activeDirectUserId).toBeNull();
    expect(result.current.activeDirectContactHint).toBeNull();
    expect(showTextView).toHaveBeenCalledTimes(1);
  });

  it("keeps the view when a different guest is removed", () => {
    const { result } = mount();
    act(() => result.current.openDirectChat("u1", null));
    showTextView.mockClear();
    act(() => result.current.onDirectIdentityRemoved({ userId: "someone-else" }));
    expect(result.current.activeDirectUserId).toBe("u1");
    expect(showTextView).not.toHaveBeenCalled();
  });
});

describe("sending and editing channel messages", () => {
  it("sends the trimmed text with channel, avatar and reply target, then clears the draft", () => {
    const { result } = mount();
    act(() => result.current.setMessageDraft("  olá  "));
    act(() => result.current.startReplyingToMessage(chatMessage("a")));
    const event = submit();
    act(() => result.current.sendMessage(event));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith("chat:send", { channelId: "geral", text: "olá", avatarUrl: "/avatars/ana.png", replyToId: "a" });
    expect(result.current.messageDraft).toBe("");
    expect(result.current.replyingTo).toBeNull();
  });

  it("sends to the channel that is currently active", () => {
    const { result, rerender } = mount();
    rerender({ activeChannel: "outro" });
    act(() => result.current.setMessageDraft("oi"));
    act(() => result.current.sendMessage(submit()));
    expect(emit).toHaveBeenCalledWith("chat:send", expect.objectContaining({ channelId: "outro" }));
  });

  it("does nothing for an empty draft or without a connection", () => {
    const { result } = mount();
    act(() => result.current.setMessageDraft("   "));
    act(() => result.current.sendMessage(submit()));
    expect(emit).not.toHaveBeenCalled();
    socket = null;
    const offline = mount();
    act(() => offline.result.current.setMessageDraft("oi"));
    act(() => offline.result.current.sendMessage(submit()));
    expect(offline.result.current.messageDraft).toBe("oi");
  });

  it("start editing and start replying cancel each other", () => {
    const { result } = mount();
    const message = chatMessage("a", "geral", { text: "original" });
    act(() => result.current.startReplyingToMessage(message));
    act(() => result.current.startEditingMessage(message));
    expect(result.current.replyingTo).toBeNull();
    expect(result.current.editingMessageId).toBe("a");
    expect(result.current.editingMessageDraft).toBe("original");
    act(() => result.current.startReplyingToMessage(message));
    expect(result.current.editingMessageId).toBeNull();
    expect(result.current.replyingTo?.id).toBe("a");
  });

  it("finishes editing on success and reports a rejection", () => {
    const { result } = mount();
    act(() => result.current.startEditingMessage(chatMessage("a", "geral", { text: "antes" })));
    act(() => result.current.setEditingMessageDraft("  depois  "));
    act(() => result.current.editMessage(submit(), "a"));
    expect(emit).toHaveBeenCalledWith("chat:edit", { messageId: "a", text: "depois" }, expect.any(Function));

    act(() => lastAck("chat:edit")({ ok: false, error: "Sem permissão" }));
    expect(setNotice).toHaveBeenCalledWith("Sem permissão");
    expect(result.current.editingMessageId).toBe("a");

    act(() => lastAck("chat:edit")({ ok: true }));
    expect(result.current.editingMessageId).toBeNull();
    expect(result.current.editingMessageDraft).toBe("");
  });

  it("does not send an edit with empty text", () => {
    const { result } = mount();
    act(() => result.current.setEditingMessageDraft("   "));
    act(() => result.current.editMessage(submit(), "a"));
    expect(emit).not.toHaveBeenCalled();
  });

  it("asks before deleting and reports failures", () => {
    const { result } = mount();
    const message = chatMessage("a");
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    act(() => result.current.deleteMessage(message));
    expect(emit).not.toHaveBeenCalled();
    act(() => result.current.deleteMessage(message));
    expect(emit).toHaveBeenCalledWith("chat:delete", { messageId: "a" }, expect.any(Function));
    act(() => lastAck("chat:delete")({ ok: false }));
    expect(setNotice).toHaveBeenCalledWith("Não foi possível excluir a mensagem.");
  });

  it("reacts and pins with the right notices", () => {
    const { result } = mount();
    act(() => result.current.toggleMessageReaction("a", "👍"));
    expect(emit).toHaveBeenCalledWith("chat:react", { messageId: "a", emoji: "👍" }, expect.any(Function));
    act(() => lastAck("chat:react")({ ok: false, error: "Reação inválida." }));
    expect(setNotice).toHaveBeenLastCalledWith("Reação inválida.");

    act(() => result.current.toggleMessagePin(chatMessage("a")));
    expect(emit).toHaveBeenCalledWith("chat:pin", { messageId: "a", pinned: true }, expect.any(Function));
    act(() => lastAck("chat:pin")({ ok: true }));
    expect(setNotice).toHaveBeenLastCalledWith("Mensagem fixada.");
    act(() => result.current.toggleMessagePin(chatMessage("a", "geral", { pinned: true })));
    expect(emit).toHaveBeenCalledWith("chat:pin", { messageId: "a", pinned: false }, expect.any(Function));
    act(() => lastAck("chat:pin")({ ok: true }));
    expect(setNotice).toHaveBeenLastCalledWith("Mensagem desafixada.");
    act(() => lastAck("chat:pin")({ ok: false }));
    expect(setNotice).toHaveBeenLastCalledWith("Não foi possível alterar a mensagem fixada.");
  });
});

describe("private conversations", () => {
  it("opening one selects it, switches view, clears its unread and loads history", () => {
    const { result } = mount();
    act(() => result.current.onDirectMessage(dm("d1", "u1", "me")));
    act(() => result.current.openDirectChat("u1", { userId: "u1", name: "Bia", online: true }));
    expect(result.current.activeDirectUserId).toBe("u1");
    expect(result.current.activeDirectContactHint?.name).toBe("Bia");
    expect(result.current.activeDirectUserIdRef.current).toBe("u1");
    expect(showDirectView).toHaveBeenCalledTimes(1);
    expect(result.current.directUnread).toEqual({});
    expect(result.current.directUnreadOrder).toEqual([]);
    expect(emit).toHaveBeenCalledWith("dm:read", { peerUserId: "u1" });
    expect(emit).toHaveBeenCalledWith("dm:history", { peerUserId: "u1" }, expect.any(Function));
  });

  it("merges loaded history without duplicates, sorted by time", () => {
    const { result } = mount();
    act(() => result.current.onDirectMessage(dm("late", "u1", "me", "2026-11-14T12:00:00Z")));
    act(() => result.current.openDirectChat("u1", null));
    act(() => lastAck("dm:history")({
      ok: true,
      messages: [dm("early", "u1", "me", "2026-11-14T09:00:00Z"), dm("late", "u1", "me", "2026-11-14T12:00:00Z")],
    }));
    expect(result.current.directMessages.map((message) => message.id)).toEqual(["early", "late"]);
  });

  it("reports a history failure", () => {
    const { result } = mount();
    act(() => result.current.openDirectChat("u1", null));
    act(() => lastAck("dm:history")({ ok: false, error: "Indisponível" }));
    expect(setNotice).toHaveBeenCalledWith("Indisponível");
  });

  it("sends only inside an open conversation, clearing the draft on success", () => {
    const { result } = mount();
    act(() => result.current.setDirectMessageDraft("oi"));
    act(() => result.current.sendDirectMessage(submit()));
    expect(emit).not.toHaveBeenCalled();

    act(() => result.current.openDirectChat("u1", null));
    act(() => result.current.sendDirectMessage(submit()));
    expect(emit).toHaveBeenCalledWith("dm:send", { recipientUserId: "u1", text: "oi", avatarUrl: "/avatars/ana.png" }, expect.any(Function));
    act(() => lastAck("dm:send")({ ok: false, error: "Falhou" }));
    expect(setNotice).toHaveBeenCalledWith("Falhou");
    expect(result.current.directMessageDraft).toBe("oi");
    act(() => lastAck("dm:send")({ ok: true }));
    expect(result.current.directMessageDraft).toBe("");
  });

  it("deletes after confirming, with a stronger warning for files", () => {
    const { result } = mount();
    act(() => result.current.onDirectMessage(dm("d1", "me", "u1")));
    act(() => result.current.deleteDirectMessage(dm("d1", "me", "u1")));
    expect(closeDirectMessageMenu).toHaveBeenCalled();
    expect(vi.mocked(window.confirm).mock.calls[0][0]).toContain("para todos");
    act(() => result.current.deleteDirectMessage(dm("d2", "me", "u1", undefined, { file: { name: "a.txt", url: "/files/x", size: 1 } })));
    expect(vi.mocked(window.confirm).mock.calls[1][0]).toContain("arquivo");

    act(() => lastAck("dm:delete")({ ok: false }));
    expect(setNotice).toHaveBeenCalledWith("Não foi possível excluir a mensagem privada.");
    expect(result.current.directMessages).toHaveLength(1);
  });

  it("removes the message locally once the server confirms the delete", () => {
    const { result } = mount();
    act(() => result.current.onDirectMessage(dm("d1", "me", "u1")));
    act(() => result.current.deleteDirectMessage(dm("d1", "me", "u1")));
    act(() => lastAck("dm:delete")({ ok: true }));
    expect(result.current.directMessages).toEqual([]);
  });

  it("does not delete when the confirmation is declined", () => {
    const { result } = mount();
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    act(() => result.current.deleteDirectMessage(dm("d1", "me", "u1")));
    expect(emit).not.toHaveBeenCalled();
  });

  it("clearing the interface forgets everything private and returns to the text view", () => {
    const { result } = mount();
    act(() => result.current.onDirectMessage(dm("d1", "u1", "me")));
    act(() => result.current.openDirectChat("u1", null));
    act(() => result.current.setDirectMessageDraft("rascunho"));
    showTextView.mockClear();
    act(() => result.current.clearDirectInterface());
    expect(result.current).toMatchObject({
      directMessages: [],
      directUnread: {},
      directUnreadOrder: [],
      activeDirectUserId: null,
      activeDirectContactHint: null,
      directMessageDraft: "",
    });
    expect(result.current.activeDirectUserIdRef.current).toBeNull();
    expect(showTextView).toHaveBeenCalledTimes(1);
  });
});

describe("uploads", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ message: chatMessage("file-1", "geral", { text: "" }) }) }));
    vi.stubGlobal("fetch", fetchMock);
  });

  const file = (name = "nota.txt", size = 10, type = "text/plain") => {
    const made = new File(["x"], name, { type });
    Object.defineProperty(made, "size", { value: size });
    return made;
  };

  it("rejects files over 10 MB without asking or uploading", async () => {
    const { result } = mount();
    await act(async () => result.current.uploadFile(file("grande.bin", 10 * 1024 * 1024 + 1)));
    expect(setNotice).toHaveBeenCalledWith("Esse arquivo excede o limite de 10 MB.");
    expect(window.confirm).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not upload when the confirmation is declined", async () => {
    const { result } = mount();
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await act(async () => result.current.uploadFile(file()));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.uploading).toBe(false);
  });

  it("posts a channel file with sender, channel and author, then shows the message once", async () => {
    const { result } = mount();
    await act(async () => result.current.uploadFile(file()));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/files");
    const body = init.body as FormData;
    expect(body.get("senderSocketId")).toBe("sock-1");
    expect(body.get("channelId")).toBe("geral");
    expect(body.get("recipientUserId")).toBeNull();
    expect(body.get("author")).toBe("Ana");
    expect((body.get("file") as File).name).toBe("nota.txt");
    expect(result.current.messages.map((message) => message.id)).toEqual(["file-1"]);
    expect(setNotice).toHaveBeenCalledWith("nota.txt foi enviado e ficará disponível por 3 dias.");
    expect(result.current.uploading).toBe(false);

    // The same message arriving over the socket afterwards must not duplicate it.
    await act(async () => result.current.uploadFile(file()));
    expect(result.current.messages).toHaveLength(1);
  });

  it("posts a private file to the recipient and files it under private messages", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ message: dm("d-file", "me", "u1") }) });
    const { result } = mount();
    await act(async () => result.current.uploadFile(file(), "u1"));
    const body = fetchMock.mock.calls[0][1].body as FormData;
    expect(body.get("recipientUserId")).toBe("u1");
    expect(body.get("channelId")).toBeNull();
    expect(result.current.directMessages.map((message) => message.id)).toEqual(["d-file"]);
    expect(result.current.messages).toEqual([]);
  });

  it("shows the server error and always clears the busy flag", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: () => Promise.resolve({ error: "Tipo não permitido" }) });
    const { result } = mount();
    await act(async () => result.current.uploadFile(file()));
    expect(setNotice).toHaveBeenCalledWith("Tipo não permitido");
    expect(result.current.uploading).toBe(false);

    fetchMock.mockRejectedValue(new Error("rede caiu"));
    await act(async () => result.current.uploadFile(file()));
    expect(setNotice).toHaveBeenLastCalledWith("rede caiu");
  });

  it("is busy while the upload is running", async () => {
    let finish: (value: unknown) => void = () => undefined;
    fetchMock.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const { result } = mount();
    let upload: Promise<void> = Promise.resolve();
    act(() => { upload = result.current.uploadFile(file()); });
    await waitFor(() => expect(result.current.uploading).toBe(true));
    await act(async () => {
      finish({ ok: true, json: () => Promise.resolve({}) });
      await upload;
    });
    expect(result.current.uploading).toBe(false);
  });

  it("does nothing without a file or a connection", async () => {
    const { result } = mount();
    await act(async () => result.current.uploadFile(undefined));
    socket = null;
    const offline = mount();
    await act(async () => offline.result.current.uploadFile(file()));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("pasting files", () => {
  const paste = (files: File[]) => {
    const event = { clipboardData: { files }, preventDefault: vi.fn() };
    return event as unknown as Parameters<ReturnType<typeof mount>["result"]["current"]["pasteFile"]>[0];
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })));
  });

  it("ignores pastes with no file so normal text paste still works", () => {
    const { result } = mount();
    const event = paste([]);
    act(() => result.current.pasteFile(event));
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("names a pasted screenshot by date and time", async () => {
    const { result } = mount();
    const event = paste([new File(["x"], "image.png", { type: "image/png" })]);
    await act(async () => result.current.pasteFile(event));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(vi.mocked(window.confirm).mock.calls[0][0]).toMatch(/captura-\d{4}-\d{2}-\d{2}-\d{6}\.png/);
  });

  it("keeps the name of a pasted file that is not a screenshot", async () => {
    const { result } = mount();
    await act(async () => result.current.pasteFile(paste([new File(["x"], "relatorio.pdf", { type: "application/pdf" })])));
    expect(vi.mocked(window.confirm).mock.calls[0][0]).toContain("relatorio.pdf");
  });
});
