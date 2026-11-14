// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDesktopUpdate } from "../src/hooks/useDesktopUpdate.ts";

type Status = { state: string; version?: string; percent?: number };

let initialStatus: Status;
let emit: (status: Status) => void;
let unsubscribe: ReturnType<typeof vi.fn>;
let installUpdate: ReturnType<typeof vi.fn>;

function installBridge() {
  unsubscribe = vi.fn();
  installUpdate = vi.fn();
  (window as { kafcordDesktop?: unknown }).kafcordDesktop = {
    getUpdateStatus: vi.fn(() => Promise.resolve(initialStatus)),
    onUpdateStatus: vi.fn((listener: (status: Status) => void) => {
      emit = listener;
      return unsubscribe;
    }),
    installUpdate,
  };
}

function mount(channel: string | null = null) {
  const voiceChannelRef = { current: channel };
  const rendered = renderHook(() => useDesktopUpdate(voiceChannelRef));
  return { ...rendered, voiceChannelRef };
}

beforeEach(() => {
  localStorage.clear();
  initialStatus = { state: "idle" };
  installBridge();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as { kafcordDesktop?: unknown }).kafcordDesktop;
});

describe("update status", () => {
  it("does nothing outside the desktop app", () => {
    delete (window as { kafcordDesktop?: unknown }).kafcordDesktop;
    const { result } = mount();
    expect(result.current.desktopUpdate).toBeNull();
    expect(result.current.restartCountdown).toBe(12);
  });

  it.each(["idle", "checking", "development"])("hides the %s state it finds on startup", async (state) => {
    initialStatus = { state };
    const { result } = mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.desktopUpdate).toBeNull();
  });

  it("shows an update already in progress when the page opens", async () => {
    initialStatus = { state: "downloading", version: "1.2.3", percent: 40 };
    const { result } = mount();
    await waitFor(() => expect(result.current.desktopUpdate).toEqual(initialStatus));
  });

  it("follows status changes pushed by the desktop process and can dismiss an error", async () => {
    const { result } = mount();
    act(() => emit({ state: "available", version: "2.0.0" }));
    expect(result.current.desktopUpdate?.state).toBe("available");
    act(() => emit({ state: "error" }));
    expect(result.current.desktopUpdate?.state).toBe("error");
    act(() => result.current.setDesktopUpdate(null));
    expect(result.current.desktopUpdate).toBeNull();
  });

  it("stops listening for updates when unmounted", () => {
    const { unmount } = mount();
    expect(unsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("restart countdown", () => {
  it("stays at 12 until an update is downloaded", () => {
    const { result } = mount();
    act(() => emit({ state: "downloading", percent: 80 }));
    expect(result.current.restartCountdown).toBe(12);
    expect(installUpdate).not.toHaveBeenCalled();
  });

  it("counts down once a second and restarts after 12 seconds", async () => {
    vi.useFakeTimers();
    const { result } = mount();
    act(() => emit({ state: "downloaded", version: "2.0.0" }));
    expect(result.current.restartCountdown).toBe(12);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.restartCountdown).toBe(9);
    expect(installUpdate).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(9000);
    });
    expect(result.current.restartCountdown).toBe(0);
    expect(installUpdate).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(installUpdate).toHaveBeenCalledTimes(1);
  });

  it("remembers the current voice room so the call resumes after the restart", () => {
    vi.useFakeTimers();
    const { voiceChannelRef } = mount("cafe");
    act(() => emit({ state: "downloaded" }));
    voiceChannelRef.current = "estudio";
    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    const saved = JSON.parse(localStorage.getItem("kafcord:update-voice-resume") ?? "null");
    expect(saved.channelId).toBe("estudio");
    expect(typeof saved.savedAt).toBe("number");
  });

  it("restarts without saving anything when not in a voice room", () => {
    vi.useFakeTimers();
    mount(null);
    act(() => emit({ state: "downloaded" }));
    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    expect(installUpdate).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("kafcord:update-voice-resume")).toBeNull();
  });

  it("resets and cancels the countdown if the update state changes", () => {
    vi.useFakeTimers();
    const { result } = mount();
    act(() => emit({ state: "downloaded" }));
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current.restartCountdown).toBe(7);
    act(() => emit({ state: "error" }));
    expect(result.current.restartCountdown).toBe(12);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(installUpdate).not.toHaveBeenCalled();
  });
});
