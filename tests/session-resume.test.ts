// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDesktopUpdate, saveVoiceResume, takeUpdateVoiceResume } from "../src/lib/session.ts";

const KEY = "kafcord:update-voice-resume";
const MAX_AGE_MS = 10 * 60 * 1000;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-14T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (window as { kafcordDesktop?: unknown }).kafcordDesktop;
});

describe("voice resume across an app update", () => {
  it("saves the room and its time, but nothing when not in a room", () => {
    saveVoiceResume(null);
    expect(localStorage.getItem(KEY)).toBeNull();
    saveVoiceResume("cafe");
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual({ channelId: "cafe", savedAt: Date.now() });
  });

  it("returns a fresh room once and forgets it", () => {
    saveVoiceResume("cafe");
    vi.advanceTimersByTime(MAX_AGE_MS - 1000);
    expect(takeUpdateVoiceResume()).toBe("cafe");
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(takeUpdateVoiceResume()).toBeNull();
  });

  it("ignores, and still removes, an entry older than ten minutes", () => {
    saveVoiceResume("cafe");
    vi.advanceTimersByTime(MAX_AGE_MS + 1000);
    expect(takeUpdateVoiceResume()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it.each([
    ["not JSON", "{oops"],
    ["no timestamp", JSON.stringify({ channelId: "cafe" })],
    ["no channel", JSON.stringify({ savedAt: Date.now() })],
    ["a numeric channel", JSON.stringify({ channelId: 5, savedAt: Date.now() })],
  ])("rejects an entry that is %s", (_label, raw) => {
    localStorage.setItem(KEY, raw);
    expect(takeUpdateVoiceResume()).toBeNull();
  });

  it("survives unavailable storage", () => {
    const fail = () => {
      throw new Error("storage unavailable");
    };
    vi.stubGlobal("localStorage", { getItem: fail, setItem: fail, removeItem: fail });
    expect(() => saveVoiceResume("cafe")).not.toThrow();
    expect(takeUpdateVoiceResume()).toBeNull();
  });

  it("installing an update saves the room first, then asks the app to restart", () => {
    const order: string[] = [];
    (window as { kafcordDesktop?: unknown }).kafcordDesktop = {
      installUpdate: () => order.push(`install:${localStorage.getItem(KEY) ? "saved" : "unsaved"}`),
    };
    installDesktopUpdate("estudio");
    expect(order).toEqual(["install:saved"]);
  });

  it("does not fail outside the desktop app", () => {
    expect(() => installDesktopUpdate("cafe")).not.toThrow();
  });
});
