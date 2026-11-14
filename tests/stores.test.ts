import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppStateStore } from "../server/app-state.ts";
import { createProfileStore } from "../server/profiles.ts";
import { VOICE_EQ_BANDS, createVoiceEqStore, sanitizeVoiceEq } from "../server/voice-eq.ts";

let directory: string;
let state: AppStateStore;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "kcord-stores-"));
  state = new AppStateStore(join(directory, "state.sqlite"));
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  state.close();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe("sanitizeVoiceEq", () => {
  it("clamps to ±12 dB and rounds to 0.5 dB steps", () => {
    expect(sanitizeVoiceEq({ gains: [20, -20, 1.26, 0, -3.74] })?.gains).toEqual([12, -12, 1.5, 0, -3.5]);
  });

  it("rejects wrong lengths, non-numbers and non-finite values", () => {
    expect(sanitizeVoiceEq({ gains: [0, 0, 0, 0] })).toBeNull();
    expect(sanitizeVoiceEq({ gains: [0, 0, 0, 0, "1"] })).toBeNull();
    expect(sanitizeVoiceEq({ gains: [0, 0, 0, 0, Number.NaN] })).toBeNull();
    expect(sanitizeVoiceEq({ gains: [0, 0, 0, 0, Number.POSITIVE_INFINITY] })).toBeNull();
    expect(sanitizeVoiceEq(null)).toBeNull();
    expect(sanitizeVoiceEq("gains")).toBeNull();
  });
});

describe("voice EQ store", () => {
  it("starts flat, persists changes and reloads them from a reopened database", () => {
    const first = createVoiceEqStore(state, directory);
    expect(first.get().gains).toEqual(Array(VOICE_EQ_BANDS).fill(0));
    first.set({ gains: [3, -2, 0, 1.5, -6] });
    expect(state.get<{ gains: number[] }>("voice-eq")?.gains).toEqual([3, -2, 0, 1.5, -6]);
    state.close();
    state = new AppStateStore(join(directory, "state.sqlite"));
    expect(createVoiceEqStore(state, directory).get().gains).toEqual([3, -2, 0, 1.5, -6]);
  });

  it("imports the equalizer file of an older release once, then prefers the database", () => {
    writeFileSync(join(directory, "voice-eq.json"), JSON.stringify({ gains: [1, 2, 3, 4, 5] }));
    expect(createVoiceEqStore(state, directory).get().gains).toEqual([1, 2, 3, 4, 5]);
    writeFileSync(join(directory, "voice-eq.json"), JSON.stringify({ gains: [9, 9, 9, 9, 9] }));
    expect(createVoiceEqStore(state, directory).get().gains).toEqual([1, 2, 3, 4, 5]);
  });

  it("falls back to flat when the saved file is invalid", () => {
    writeFileSync(join(directory, "voice-eq.json"), "{broken");
    expect(createVoiceEqStore(state, directory).get().gains).toEqual(Array(VOICE_EQ_BANDS).fill(0));
  });
});

describe("profile store", () => {
  const profile = { userId: "user-1", displayName: "Ana", avatarUrl: null, updatedAt: "2026-11-14T00:00:00Z" };

  it("saves, reads and reloads profiles by user id", () => {
    const store = createProfileStore(state, directory);
    expect(store.get("user-1")).toBeUndefined();
    store.save(profile);
    expect(store.get("user-1")?.displayName).toBe("Ana");
    expect(createProfileStore(state, directory).get("user-1")).toEqual(profile);
  });

  it("imports profiles from an older release's file, dropping malformed entries", () => {
    writeFileSync(join(directory, "profiles.json"), JSON.stringify([profile, { userId: 5 }, null, { userId: "x" }]));
    const store = createProfileStore(state, directory);
    expect(store.get("user-1")).toEqual(profile);
    expect(store.get("x")).toBeUndefined();
  });

  it("starts empty when the older file is corrupt, and keeps that file untouched", () => {
    writeFileSync(join(directory, "profiles.json"), "nope");
    expect(createProfileStore(state, directory).get("user-1")).toBeUndefined();
    expect(readFileSync(join(directory, "profiles.json"), "utf8")).toBe("nope");
  });

  it("prefers the database over an older file once profiles were saved", () => {
    const store = createProfileStore(state, directory);
    store.save(profile);
    writeFileSync(join(directory, "profiles.json"), JSON.stringify([{ ...profile, displayName: "Antigo" }]));
    expect(createProfileStore(state, directory).get("user-1")?.displayName).toBe("Ana");
  });
});
