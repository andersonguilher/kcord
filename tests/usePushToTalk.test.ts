// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePushToTalk } from "../src/hooks/usePushToTalk.ts";

type Options = Parameters<typeof usePushToTalk>[0];

let setNotice: ReturnType<typeof vi.fn>;
let playInterfaceCue: ReturnType<typeof vi.fn>;
let touchQuery: { matches: boolean; listener: (() => void) | null };

function options(overrides: Partial<Options> = {}): Options {
  return {
    voiceChannel: "cafe",
    micEnabled: true,
    serverMuted: false,
    serverDeafened: false,
    setNotice,
    playInterfaceCue,
    ...overrides,
  };
}

function mount(overrides: Partial<Options> = {}, mode: "ptt" | "voice" = "ptt") {
  localStorage.setItem("kafcord:input-mode", mode);
  return renderHook((props: Options) => usePushToTalk(props), { initialProps: options(overrides) });
}

function key(type: "keydown" | "keyup", code: string, init: KeyboardEventInit = {}, target: EventTarget = window) {
  const event = new KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  localStorage.clear();
  setNotice = vi.fn();
  playInterfaceCue = vi.fn(() => Promise.resolve());
  touchQuery = { matches: false, listener: null };
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return touchQuery.matches;
    },
    addEventListener: (_type: string, listener: () => void) => {
      touchQuery.listener = listener;
    },
    removeEventListener: () => {
      touchQuery.listener = null;
    },
  }));
  delete (window as { kafcordDesktop?: unknown }).kafcordDesktop;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as { kafcordDesktop?: unknown }).kafcordDesktop;
});

describe("settings", () => {
  it("defaults to voice activity, Right Shift and sounds on", () => {
    const { result } = renderHook(() => usePushToTalk(options()));
    expect(result.current).toMatchObject({
      inputMode: "voice",
      pttKey: "ShiftRight",
      touchOnly: false,
      recordingPttKey: false,
      pttPressed: false,
      pttSoundsEnabled: true,
    });
  });

  it("restores stored settings and saves changes", () => {
    localStorage.setItem("kafcord:ptt-key", "KeyV");
    localStorage.setItem("kafcord:ptt-sounds", "off");
    const { result } = mount();
    expect(result.current).toMatchObject({ inputMode: "ptt", pttKey: "KeyV", pttSoundsEnabled: false });
    act(() => {
      result.current.setInputMode("voice");
      result.current.setPttSoundsEnabled(true);
    });
    expect(localStorage.getItem("kafcord:input-mode")).toBe("voice");
    expect(localStorage.getItem("kafcord:ptt-sounds")).toBe("on");
    expect(localStorage.getItem("kafcord:ptt-key")).toBe("KeyV");
  });
});

describe("keyboard", () => {
  it("presses and releases with the configured key in push-to-talk mode", () => {
    const { result } = mount();
    const down = key("keydown", "ShiftRight");
    expect(down.defaultPrevented).toBe(true);
    expect(result.current.pttPressed).toBe(true);
    key("keyup", "ShiftRight");
    expect(result.current.pttPressed).toBe(false);
  });

  it("ignores other keys, voice-activity mode and typing in text fields", () => {
    const { result, rerender } = mount();
    key("keydown", "KeyA");
    expect(result.current.pttPressed).toBe(false);

    const input = document.createElement("input");
    document.body.appendChild(input);
    key("keydown", "ShiftRight", {}, input);
    expect(result.current.pttPressed).toBe(false);
    input.remove();

    act(() => result.current.setInputMode("voice"));
    rerender(options());
    key("keydown", "ShiftRight");
    expect(result.current.pttPressed).toBe(false);
  });

  it("releases when the window loses focus, unless the desktop hook owns the state", () => {
    const { result } = mount();
    key("keydown", "ShiftRight");
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(result.current.pttPressed).toBe(false);

    (window as { kafcordDesktop?: unknown }).kafcordDesktop = { onPttState: () => () => undefined, configurePtt: undefined };
    const desktop = mount();
    key("keydown", "ShiftRight");
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(desktop.result.current.pttPressed).toBe(true);
  });

  it("records a new key, saves it and stops recording; Escape cancels", () => {
    const { result } = mount();
    act(() => result.current.setRecordingPttKey(true));
    const captured = key("keydown", "KeyV");
    expect(captured.defaultPrevented).toBe(true);
    expect(result.current.pttKey).toBe("KeyV");
    expect(result.current.recordingPttKey).toBe(false);
    expect(localStorage.getItem("kafcord:ptt-key")).toBe("KeyV");

    act(() => result.current.setRecordingPttKey(true));
    key("keydown", "Escape");
    expect(result.current.pttKey).toBe("KeyV");
    expect(result.current.recordingPttKey).toBe(false);
  });
});

describe("touch-only devices", () => {
  it("detects touch screens, follows changes and stops key recording", () => {
    touchQuery.matches = true;
    const { result } = mount();
    expect(result.current.touchOnly).toBe(true);

    touchQuery.matches = false;
    act(() => touchQuery.listener?.());
    expect(result.current.touchOnly).toBe(false);

    act(() => result.current.setRecordingPttKey(true));
    expect(result.current.recordingPttKey).toBe(true);
    touchQuery.matches = true;
    act(() => touchQuery.listener?.());
    expect(result.current.recordingPttKey).toBe(false);
  });
});

describe("press and release sounds", () => {
  it("plays a cue on each change while talking in push-to-talk mode", () => {
    mount();
    key("keydown", "ShiftRight");
    expect(playInterfaceCue).toHaveBeenCalledTimes(1);
    key("keyup", "ShiftRight");
    expect(playInterfaceCue).toHaveBeenCalledTimes(2);
    expect(playInterfaceCue.mock.calls[0][0]).not.toBe(playInterfaceCue.mock.calls[1][0]);
  });

  it.each([
    ["sounds are off", () => localStorage.setItem("kafcord:ptt-sounds", "off"), {}],
    ["the user is not in a voice channel", () => undefined, { voiceChannel: null }],
    ["the microphone is off", () => undefined, { micEnabled: false }],
  ])("stays silent when %s", (_label, setup, overrides) => {
    setup();
    mount(overrides as Partial<Options>);
    key("keydown", "ShiftRight");
    key("keyup", "ShiftRight");
    expect(playInterfaceCue).not.toHaveBeenCalled();
  });

  it("stays silent in voice-activity mode", () => {
    mount({}, "voice");
    key("keydown", "ShiftRight");
    expect(playInterfaceCue).not.toHaveBeenCalled();
  });
});

describe("desktop global hook", () => {
  type Desktop = {
    onPttState: ReturnType<typeof vi.fn>;
    configurePtt: ReturnType<typeof vi.fn>;
    learnPttKey: ReturnType<typeof vi.fn>;
  };
  let desktop: Desktop;
  let emitPttState: (pressed: boolean) => void;

  beforeEach(() => {
    desktop = {
      onPttState: vi.fn((callback: (pressed: boolean) => void) => {
        emitPttState = callback;
        return () => undefined;
      }),
      configurePtt: vi.fn(() => Promise.resolve({ ok: true })),
      learnPttKey: vi.fn(() => Promise.resolve({ hookRunning: true, keyCode: 54 })),
    };
    (window as { kafcordDesktop?: unknown }).kafcordDesktop = desktop;
  });

  it("follows the pressed state reported by the desktop process", () => {
    const { result } = mount();
    act(() => emitPttState(true));
    expect(result.current.pttPressed).toBe(true);
    act(() => emitPttState(false));
    expect(result.current.pttPressed).toBe(false);
  });

  it("enables the global key only while it can transmit, and disables it on cleanup", async () => {
    const { rerender, unmount } = mount();
    await waitFor(() => expect(desktop.configurePtt).toHaveBeenCalledWith("ShiftRight", true, null));

    rerender(options({ serverMuted: true }));
    await waitFor(() => expect(desktop.configurePtt).toHaveBeenCalledWith("ShiftRight", false));

    rerender(options({ voiceChannel: null }));
    rerender(options());
    unmount();
    expect(desktop.configurePtt).toHaveBeenLastCalledWith("ShiftRight", false);
  });

  it("is turned off while a new key is being recorded and back on afterwards", async () => {
    const { result } = mount();
    await waitFor(() => expect(desktop.configurePtt).toHaveBeenLastCalledWith("ShiftRight", true, null));
    act(() => result.current.setRecordingPttKey(true));
    await waitFor(() => expect(desktop.configurePtt).toHaveBeenLastCalledWith("ShiftRight", false, null));
    key("keydown", "KeyV");
    await waitFor(() => expect(desktop.configurePtt).toHaveBeenLastCalledWith("KeyV", true, null));
  });

  it("is disabled in voice-activity mode", async () => {
    mount({}, "voice");
    await waitFor(() => expect(desktop.configurePtt).toHaveBeenCalledWith("ShiftRight", false, null));
    expect(desktop.configurePtt.mock.calls.some(([, enabled]) => enabled === true)).toBe(false);
  });

  it("shows the desktop error when the global key cannot be enabled", async () => {
    desktop.configurePtt.mockResolvedValue({ ok: false, error: "Hook indisponível" });
    mount();
    await waitFor(() => expect(setNotice).toHaveBeenCalledWith("Hook indisponível"));
  });

  it("learns the key code reported by the hook and reuses it", async () => {
    const first = mount();
    key("keydown", "ShiftRight");
    await waitFor(() => expect(localStorage.getItem("kafcord:ptt-learned-key")).toBe(JSON.stringify({ code: "ShiftRight", keyCode: 54 })));
    first.unmount();

    desktop.configurePtt.mockClear();
    mount();
    await waitFor(() => expect(desktop.configurePtt).toHaveBeenCalledWith("ShiftRight", true, 54));
  });

  it("does not relearn on key repeat and warns once when the hook gets no keys", async () => {
    desktop.learnPttKey.mockResolvedValue({ hookRunning: true, keyCode: null });
    mount();
    key("keydown", "ShiftRight", { repeat: true });
    expect(desktop.learnPttKey).not.toHaveBeenCalled();
    key("keydown", "ShiftRight");
    key("keyup", "ShiftRight");
    key("keydown", "ShiftRight");
    await waitFor(() => expect(desktop.learnPttKey).toHaveBeenCalledTimes(2));
    expect(setNotice).toHaveBeenCalledTimes(1);
    expect(setNotice.mock.calls[0][0]).toContain("PTT global não está recebendo teclas");
  });
});
