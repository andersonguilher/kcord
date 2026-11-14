import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppStateStore, appState, closeAppState, defaultDatabasePath } from "../server/app-state.ts";

let directory: string;
let stores: AppStateStore[];

function open(path = join(directory, "state.sqlite")) {
  const store = new AppStateStore(path);
  stores.push(store);
  return store;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "kcord-state-"));
  stores = [];
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const store of stores) store.close();
  closeAppState();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe("storing documents", () => {
  it("reads back what was written, whatever its JSON shape", () => {
    const store = open();
    store.set("list", [1, "dois", { tres: 3 }]);
    store.set("object", { nested: { ok: true } });
    store.set("text", "olá");
    store.set("zero", 0);
    expect(store.get("list")).toEqual([1, "dois", { tres: 3 }]);
    expect(store.get("object")).toEqual({ nested: { ok: true } });
    expect(store.get("text")).toBe("olá");
    expect(store.get("zero")).toBe(0);
  });

  it("reports a missing key as undefined and tells has() apart from a falsy value", () => {
    const store = open();
    expect(store.get("nothing")).toBeUndefined();
    expect(store.has("nothing")).toBe(false);
    store.set("empty", []);
    expect(store.has("empty")).toBe(true);
    expect(store.get("empty")).toEqual([]);
  });

  it("overwrites a key and deletes it", () => {
    const store = open();
    store.set("k", { v: 1 });
    store.set("k", { v: 2 });
    expect(store.get("k")).toEqual({ v: 2 });
    store.delete("k");
    expect(store.has("k")).toBe(false);
    expect(() => store.delete("k")).not.toThrow();
  });

  it("keeps the data after the database is closed and reopened", () => {
    const first = open();
    first.set("sessions", [{ id: "a" }]);
    first.close();
    expect(open().get("sessions")).toEqual([{ id: "a" }]);
  });

  it("shares one file between connections, like the chat store does", () => {
    const writer = open();
    const reader = open();
    writer.set("shared", { by: "writer" });
    expect(reader.get("shared")).toEqual({ by: "writer" });
  });

  it("treats an unreadable stored value as absent instead of crashing", () => {
    const store = open();
    store.set("good", 1);
    const raw = new DatabaseSync(join(directory, "state.sqlite"));
    raw.prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)").run("broken", "{not json", "2026-01-01");
    raw.close();
    expect(store.get("broken")).toBeUndefined();
    expect(store.get("good")).toBe(1);
  });

  it("works in memory, for tests", () => {
    const store = new AppStateStore(":memory:");
    store.set("a", 1);
    expect(store.get("a")).toBe(1);
    store.close();
  });

  it("creates the data folder when it does not exist", () => {
    const store = open(join(directory, "nested", "deeper", "state.sqlite"));
    store.set("a", 1);
    expect(store.get("a")).toBe(1);
  });
});

describe("importing files from an older release", () => {
  const legacy = () => join(directory, "legacy.json");

  it("imports the document once and leaves the file in place for a rollback", () => {
    writeFileSync(legacy(), JSON.stringify([{ id: "x" }]));
    const store = open();
    expect(store.importLegacyJson("profiles", legacy())).toBe("imported");
    expect(store.get("profiles")).toEqual([{ id: "x" }]);
    expect(readFileSync(legacy(), "utf8")).toBe(JSON.stringify([{ id: "x" }]));
  });

  it("never overwrites data already in the database, even if the file changed", () => {
    const store = open();
    store.set("profiles", [{ id: "current" }]);
    writeFileSync(legacy(), JSON.stringify([{ id: "old" }]));
    expect(store.importLegacyJson("profiles", legacy())).toBe("already-present");
    expect(store.get("profiles")).toEqual([{ id: "current" }]);
  });

  it("is a no-op for a missing file, and does not create the key", () => {
    const store = open();
    expect(store.importLegacyJson("profiles", legacy())).toBe("no-file");
    expect(store.has("profiles")).toBe(false);
  });

  it("refuses a corrupt file without storing anything, and keeps the file", () => {
    writeFileSync(legacy(), "{oops");
    const store = open();
    expect(store.importLegacyJson("profiles", legacy())).toBe("invalid");
    expect(store.has("profiles")).toBe(false);
    expect(readFileSync(legacy(), "utf8")).toBe("{oops");
  });

  it("imports only on the first start, so a later start finds it already present", () => {
    writeFileSync(legacy(), JSON.stringify({ a: 1 }));
    const first = open();
    expect(first.importLegacyJson("k", legacy())).toBe("imported");
    first.close();
    expect(open().importLegacyJson("k", legacy())).toBe("already-present");
  });
});

describe("the shared store", () => {
  it("follows the chat database path, so both live in the same file", () => {
    vi.stubEnv("KAFCORD_CHAT_DATABASE_PATH", join(directory, "chat.sqlite"));
    expect(defaultDatabasePath()).toBe(join(directory, "chat.sqlite"));
    appState().set("k", 1);
    closeAppState();
    expect(open(join(directory, "chat.sqlite")).get("k")).toBe(1);
  });

  it("falls back to data/kafcord.sqlite under the working folder", () => {
    vi.stubEnv("KAFCORD_CHAT_DATABASE_PATH", "");
    expect(defaultDatabasePath()).toBe(join(process.cwd(), "data", "kafcord.sqlite"));
  });

  it("is one instance until it is closed", () => {
    vi.stubEnv("KAFCORD_CHAT_DATABASE_PATH", join(directory, "chat.sqlite"));
    expect(Object.is(appState(), appState())).toBe(true);
    const first = appState();
    closeAppState();
    // Compared by identity: vitest cannot describe a closed database object.
    expect(Object.is(appState(), first)).toBe(false);
  });
});
