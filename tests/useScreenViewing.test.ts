// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScreenViewing, type ScreenViewingOptions } from "../src/hooks/useScreenViewing.ts";
import type { Member, ScreenAnnouncement, ScreenPreview } from "../src/types.ts";

const EXPANDED_KEY = "kafcord:live-expanded";

let emit: ReturnType<typeof vi.fn>;
let dropRemoteScreenStream: ReturnType<typeof vi.fn>;
let socketId: string | undefined;

function member(socketIdValue: string, extra: Partial<Member> = {}): Member {
  return {
    socketId: socketIdValue,
    name: socketIdValue,
    voiceChannelId: "cafe",
    screenSharing: false,
    discordUserId: `discord-${socketIdValue}`,
    ...extra,
  } as Member;
}

function announcement(peerId: string, extra: Partial<ScreenAnnouncement> = {}): ScreenAnnouncement {
  return { peerId, thumbnail: `thumb-${peerId}`, sharerDiscordUserId: `discord-${peerId}`, resolutionWidth: 1920, resolutionHeight: 1080, ...extra } as ScreenAnnouncement;
}

function mount(overrides: Partial<ScreenViewingOptions> = {}) {
  return renderHook((props: Partial<ScreenViewingOptions>) => useScreenViewing({
    socketRef: { current: { emit, id: socketId } as never },
    members: [],
    voiceChannel: "cafe",
    dropRemoteScreenStream: dropRemoteScreenStream as never,
    ...props,
  }), { initialProps: overrides });
}

beforeEach(() => {
  localStorage.clear();
  emit = vi.fn();
  dropRemoteScreenStream = vi.fn();
  socketId = "me";
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("previews from the server", () => {
  it("replaces the whole list, leaves out my own screen and keeps the live flag of known ones", () => {
    const { result } = mount({ members: [member("a", { screenSharing: true }), member("b", { screenSharing: true })] });
    act(() => result.current.onScreenList([announcement("a"), announcement("b"), announcement("me")]));
    expect(Object.keys(result.current.screenPreviews)).toEqual(["a", "b"]);
    expect(result.current.screenPreviews.a).toMatchObject({ thumbnail: "thumb-a", live: false, sharerDiscordUserId: "discord-a", resolutionWidth: 1920 });

    act(() => result.current.setScreenPreviews({ a: { thumbnail: "x", live: true } as ScreenPreview }));
    act(() => result.current.onScreenList([announcement("a", { thumbnail: "fresh" })]));
    expect(result.current.screenPreviews).toEqual({
      a: expect.objectContaining({ thumbnail: "fresh", live: true }),
    });
  });

  it("adds a newly announced screen as not live yet", () => {
    const { result } = mount({ members: [member("a", { screenSharing: true })] });
    act(() => result.current.onScreenAvailable(announcement("a")));
    expect(result.current.screenPreviews.a).toMatchObject({ thumbnail: "thumb-a", live: false });
    expect(result.current.screenPreviews.a).not.toHaveProperty("peerId");
  });

  it("updates a thumbnail only for a screen it already knows", () => {
    const { result } = mount({ members: [member("a", { screenSharing: true })] });
    act(() => result.current.onScreenAvailable(announcement("a")));
    act(() => result.current.onScreenThumbnail({ peerId: "a", thumbnail: "new" }));
    act(() => result.current.onScreenThumbnail({ peerId: "ghost", thumbnail: "x" }));
    expect(result.current.screenPreviews.a.thumbnail).toBe("new");
    expect(result.current.screenPreviews.ghost).toBeUndefined();
  });

  it("removing a screen drops its preview and stream, and stops watching it", () => {
    const { result } = mount({ members: [member("a", { discordUserId: "discord-a" })] });
    act(() => result.current.onScreenAvailable(announcement("a")));
    act(() => result.current.watchScreen("a"));
    act(() => result.current.onScreenStop({ peerId: "a" }));
    expect(result.current.screenPreviews).toEqual({});
    expect(dropRemoteScreenStream).toHaveBeenCalledWith("a");
    expect(result.current.activeScreenPeerId).toBeNull();
    expect(result.current.expandedScreenPeerId).toBeNull();
    expect(result.current.activeScreenPeerIdRef.current).toBeNull();
    expect(result.current.watchedScreenDiscordUserIdRef.current).toBeNull();
  });

  it("another person's screen ending leaves what I am watching alone", () => {
    const { result } = mount({ members: [member("a")] });
    act(() => result.current.onScreenAvailable(announcement("a")));
    act(() => result.current.onScreenAvailable(announcement("b")));
    act(() => result.current.watchScreen("a"));
    act(() => result.current.onScreenStop({ peerId: "b" }));
    expect(result.current.activeScreenPeerId).toBe("a");
    expect(result.current.activeScreenPeerIdRef.current).toBe("a");
    expect(Object.keys(result.current.screenPreviews)).toEqual(["a"]);
  });
});

describe("choosing what to watch", () => {
  it("subscribes, marks the screen as not yet live, and remembers who it is by Discord id", () => {
    const { result } = mount({ members: [member("a", { discordUserId: "d-a" })] });
    act(() => result.current.onScreenAvailable(announcement("a")));
    act(() => result.current.setScreenPreviews({ a: { thumbnail: "t", live: true } as ScreenPreview }));
    act(() => result.current.watchScreen("a"));
    expect(emit).toHaveBeenCalledWith("screen:subscribe", { target: "a" });
    expect(result.current.activeScreenPeerId).toBe("a");
    expect(result.current.activeScreenPeerIdRef.current).toBe("a");
    expect(result.current.watchedScreenDiscordUserIdRef.current).toBe("d-a");
    expect(result.current.screenPreviews.a.live).toBe(false);
  });

  it("does nothing when already watching that screen", () => {
    const { result } = mount({ members: [member("a")] });
    act(() => result.current.watchScreen("a"));
    emit.mockClear();
    act(() => result.current.watchScreen("a"));
    expect(emit).not.toHaveBeenCalled();
  });

  it("switching screens stops the previous stream first", () => {
    const { result } = mount({ members: [member("a"), member("b")] });
    act(() => result.current.onScreenAvailable(announcement("a")));
    act(() => result.current.onScreenAvailable(announcement("b")));
    act(() => result.current.watchScreen("a"));
    act(() => result.current.setScreenPreviews({ a: { thumbnail: "t", live: true } as ScreenPreview, b: { thumbnail: "t", live: false } as ScreenPreview }));
    emit.mockClear();
    act(() => result.current.watchScreen("b"));
    expect(emit.mock.calls.map(([event, payload]) => [event, payload.target])).toEqual([
      ["screen:unsubscribe", "a"],
      ["screen:subscribe", "b"],
    ]);
    expect(dropRemoteScreenStream).toHaveBeenCalledWith("a");
    expect(result.current.screenPreviews.a.live).toBe(false);
    expect(result.current.activeScreenPeerId).toBe("b");
  });

  it("opens expanded only when that is the saved preference", () => {
    const normal = mount({ members: [member("a")] });
    act(() => normal.result.current.watchScreen("a"));
    expect(normal.result.current.expandedScreenPeerId).toBeNull();

    localStorage.setItem(EXPANDED_KEY, "1");
    const expanded = mount({ members: [member("a")] });
    act(() => expanded.result.current.watchScreen("a"));
    expect(expanded.result.current.expandedScreenPeerId).toBe("a");
  });

  it("toggling the expanded view saves the preference for next time", () => {
    const { result } = mount({ members: [member("a")] });
    act(() => result.current.toggleExpandedScreen("a"));
    expect(result.current.expandedScreenPeerId).toBe("a");
    expect(localStorage.getItem(EXPANDED_KEY)).toBe("1");
    act(() => result.current.toggleExpandedScreen("a"));
    expect(result.current.expandedScreenPeerId).toBeNull();
    expect(localStorage.getItem(EXPANDED_KEY)).toBe("0");
  });

  it("still toggles when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    try {
      const { result } = mount();
      expect(() => act(() => result.current.toggleExpandedScreen("a"))).not.toThrow();
      expect(result.current.expandedScreenPeerId).toBe("a");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("closing what is watched unsubscribes, drops the stream and forgets who it was", () => {
    const { result } = mount({ members: [member("a")] });
    act(() => result.current.onScreenAvailable(announcement("a")));
    act(() => result.current.watchScreen("a"));
    emit.mockClear();
    act(() => result.current.closeWatchedScreen());
    expect(emit).toHaveBeenCalledWith("screen:unsubscribe", { target: "a" });
    expect(dropRemoteScreenStream).toHaveBeenCalledWith("a");
    expect(result.current.activeScreenPeerId).toBeNull();
    expect(result.current.expandedScreenPeerId).toBeNull();
    expect(result.current.watchedScreenDiscordUserIdRef.current).toBeNull();
    expect(result.current.screenPreviews.a.live).toBe(false);
  });

  it("closing with nothing watched is harmless", () => {
    const { result } = mount();
    act(() => result.current.closeWatchedScreen());
    expect(emit).not.toHaveBeenCalled();
    expect(dropRemoteScreenStream).not.toHaveBeenCalled();
  });
});

describe("watching the same person after a reconnect", () => {
  it("subscribes to their new socket when their screen is announced again", () => {
    const { result } = mount({ members: [member("old", { discordUserId: "d-ana" })] });
    act(() => result.current.watchScreen("old"));
    emit.mockClear();
    act(() => result.current.onScreenList([announcement("new", { sharerDiscordUserId: "d-ana" })]));
    expect(emit).toHaveBeenCalledWith("screen:subscribe", { target: "new" });
    expect(result.current.activeScreenPeerId).toBe("new");
    expect(result.current.activeScreenPeerIdRef.current).toBe("new");
  });

  it("also works from a single new announcement", () => {
    const { result } = mount({ members: [member("old", { discordUserId: "d-ana" })] });
    act(() => result.current.watchScreen("old"));
    emit.mockClear();
    act(() => result.current.onScreenAvailable(announcement("new", { sharerDiscordUserId: "d-ana" })));
    expect(emit).toHaveBeenCalledWith("screen:subscribe", { target: "new" });
  });

  it("does nothing when nobody was being watched, or someone else shares", () => {
    const idle = mount();
    act(() => idle.result.current.onScreenList([announcement("a")]));
    expect(emit).not.toHaveBeenCalled();

    const { result } = mount({ members: [member("old", { discordUserId: "d-ana" })] });
    act(() => result.current.watchScreen("old"));
    emit.mockClear();
    act(() => result.current.onScreenList([announcement("x", { sharerDiscordUserId: "d-someone-else" })]));
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not subscribe again to the screen already being watched, nor to my own", () => {
    const { result } = mount({ members: [member("a", { discordUserId: "d-ana" })] });
    act(() => result.current.watchScreen("a"));
    emit.mockClear();
    act(() => result.current.onScreenList([announcement("a", { sharerDiscordUserId: "d-ana" })]));
    expect(emit).not.toHaveBeenCalled();
    act(() => result.current.onScreenList([announcement("me", { sharerDiscordUserId: "d-ana" })]));
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("keeping previews in sync with the room", () => {
  it("asks for the list when a member shares in my room and no preview arrived", () => {
    const { rerender } = mount({ members: [] });
    rerender({ members: [member("a", { screenSharing: true })] });
    expect(emit).toHaveBeenCalledWith("screen:list:request");
  });

  it.each([
    ["the member is not sharing", { screenSharing: false }, "cafe"],
    ["the member is in another room", { screenSharing: true, voiceChannelId: "estudio" }, "cafe"],
    ["it is my own socket", { screenSharing: true, socketId: "me" }, "cafe"],
  ])("does not ask when %s", (_label, extra, room) => {
    const { rerender } = mount({ members: [], voiceChannel: room });
    rerender({ members: [member(String((extra as { socketId?: string }).socketId ?? "a"), extra as Partial<Member>)], voiceChannel: room });
    expect(emit).not.toHaveBeenCalledWith("screen:list:request");
  });

  it("does not ask while I am not in a voice room", () => {
    const { rerender } = mount({ members: [], voiceChannel: null });
    rerender({ members: [member("a", { screenSharing: true })], voiceChannel: null });
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not ask again once the preview is there", () => {
    const { result, rerender } = mount({ members: [] });
    act(() => result.current.onScreenAvailable(announcement("a")));
    emit.mockClear();
    rerender({ members: [member("a", { screenSharing: true })] });
    expect(emit).not.toHaveBeenCalledWith("screen:list:request");
  });

  it("drops previews of members who stopped sharing, left the room, or are me", () => {
    const sharing = [member("a", { screenSharing: true }), member("b", { screenSharing: true }), member("c", { screenSharing: true })];
    const { result, rerender } = mount({ members: sharing });
    act(() => result.current.setScreenPreviews({
      a: { thumbnail: "t" } as ScreenPreview,
      b: { thumbnail: "t" } as ScreenPreview,
      c: { thumbnail: "t" } as ScreenPreview,
      me: { thumbnail: "t" } as ScreenPreview,
      ghost: { thumbnail: "t" } as ScreenPreview,
    }));
    // A new members list (as the server sends on every change) triggers the sync.
    rerender({ members: [...sharing] });
    expect(Object.keys(result.current.screenPreviews).sort()).toEqual(["a", "b", "c"]);

    rerender({ members: [member("a", { screenSharing: true }), member("b", { screenSharing: false }), member("c", { screenSharing: true, voiceChannelId: "estudio" })] });
    expect(Object.keys(result.current.screenPreviews)).toEqual(["a"]);
  });

  it("never previews my own screen, even though I am a member who is sharing", () => {
    const { result, rerender } = mount({ members: [member("me", { screenSharing: true }), member("a", { screenSharing: true })] });
    act(() => result.current.setScreenPreviews({ me: { thumbnail: "t" } as ScreenPreview, a: { thumbnail: "t" } as ScreenPreview }));
    rerender({ members: [member("me", { screenSharing: true }), member("a", { screenSharing: true })] });
    expect(Object.keys(result.current.screenPreviews)).toEqual(["a"]);
  });

  it("keeps the same previews object when nothing needs to change", () => {
    const sharing = [member("a", { screenSharing: true })];
    const { result, rerender } = mount({ members: sharing });
    act(() => result.current.setScreenPreviews({ a: { thumbnail: "t" } as ScreenPreview }));
    const before = result.current.screenPreviews;
    rerender({ members: [member("a", { screenSharing: true })] });
    expect(result.current.screenPreviews).toBe(before);
  });
});
