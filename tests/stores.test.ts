import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProfileStore } from "../server/profiles.ts";
import { VOICE_EQ_BANDS, createVoiceEqStore, sanitizeVoiceEq } from "../server/voice-eq.ts";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "kcord-stores-"));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
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
  it("starts flat, persists changes and reloads them", () => {
    const first = createVoiceEqStore(directory);
    expect(first.get().gains).toEqual(Array(VOICE_EQ_BANDS).fill(0));
    first.set({ gains: [3, -2, 0, 1.5, -6] });
    expect(JSON.parse(readFileSync(join(directory, "voice-eq.json"), "utf8")).gains).toEqual([3, -2, 0, 1.5, -6]);
    expect(createVoiceEqStore(directory).get().gains).toEqual([3, -2, 0, 1.5, -6]);
  });

  it("falls back to flat when the saved file is invalid", () => {
    writeFileSync(join(directory, "voice-eq.json"), "{broken");
    expect(createVoiceEqStore(directory).get().gains).toEqual(Array(VOICE_EQ_BANDS).fill(0));
  });
});

describe("profile store", () => {
  const profile = { userId: "user-1", displayName: "Ana", avatarUrl: null, updatedAt: "2026-11-14T00:00:00Z" };

  it("saves, reads and reloads profiles by user id", () => {
    const store = createProfileStore(directory);
    expect(store.get("user-1")).toBeUndefined();
    store.save(profile);
    expect(store.get("user-1")?.displayName).toBe("Ana");
    expect(createProfileStore(directory).get("user-1")).toEqual(profile);
  });

  it("drops malformed entries and survives a corrupt file", () => {
    writeFileSync(join(directory, "profiles.json"), JSON.stringify([profile, { userId: 5 }, null, { userId: "x" }]));
    const store = createProfileStore(directory);
    expect(store.get("user-1")).toBeDefined();
    expect(store.get("x")).toBeUndefined();

    writeFileSync(join(directory, "profiles.json"), "nope");
    expect(createProfileStore(directory).get("user-1")).toBeUndefined();
  });
});
