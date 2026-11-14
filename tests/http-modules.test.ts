import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatStore } from "../server/chat-store.ts";
import { createDownloadsRouter } from "../server/downloads.ts";
import { createFileStorage } from "../server/files.ts";

let directory: string;
let server: Server | undefined;
const openStores: ChatStore[] = [];

function openStore() {
  const store = new ChatStore(join(directory, "chat.sqlite"));
  openStores.push(store);
  return store;
}

async function listen(router: express.Router) {
  const app = express();
  app.use(router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server?.address();
  if (!address || typeof address === "string") throw new Error("server did not start");
  return `http://127.0.0.1:${address.port}`;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "kcord-http-"));
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  for (const store of openStores.splice(0)) store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("downloads router", () => {
  it("answers 503 when no installer is published", async () => {
    const base = await listen(createDownloadsRouter(directory));
    const response = await fetch(`${base}/download`, { redirect: "manual" });
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("redirects to the installer named by latest.yml", async () => {
    writeFileSync(join(directory, "KCord-Setup-1.2.3.exe"), "binary");
    writeFileSync(join(directory, "latest.yml"), "version: 1.2.3\npath: KCord-Setup-1.2.3.exe\n");
    const base = await listen(createDownloadsRouter(directory));
    const redirect = await fetch(`${base}/download`, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/downloads/KCord-Setup-1.2.3.exe");

    const file = await fetch(`${base}/downloads/KCord-Setup-1.2.3.exe`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toBe("attachment");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(file.headers.get("cache-control")).toBe("public, max-age=3600");

    const manifest = await fetch(`${base}/downloads/latest.yml`);
    expect(manifest.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses manifest paths that are not KCord installers", async () => {
    writeFileSync(join(directory, "evil.exe"), "x");
    writeFileSync(join(directory, "latest.yml"), "path: evil.exe\n");
    const base = await listen(createDownloadsRouter(directory));
    expect((await fetch(`${base}/download`, { redirect: "manual" })).status).toBe(503);
  });

  it("never lists directories or serves dotfiles", async () => {
    writeFileSync(join(directory, ".secret"), "x");
    const base = await listen(createDownloadsRouter(directory));
    expect((await fetch(`${base}/downloads/`)).status).toBe(404);
    expect((await fetch(`${base}/downloads/.secret`)).status).toBe(404);
  });
});

describe("file storage", () => {
  const retentionMs = 3 * 24 * 60 * 60 * 1000;

  function setup() {
    const uploadDirectory = join(directory, "uploads");
    const avatarDirectory = join(uploadDirectory, "avatars");
    mkdirSync(avatarDirectory, { recursive: true });
    const store = openStore();
    const storage = createFileStorage({
      chatStore: store,
      uploadDirectory,
      avatarDirectory,
      retentionMs,
      cleanupIntervalMs: 60 * 60 * 1000,
    });
    return { uploadDirectory, store, storage };
  }

  function publicFileMessage(name: string, expiresAt: string) {
    return {
      id: `m-${name}`,
      channelId: "geral",
      author: "Ana",
      authorUserId: "user-1",
      text: "",
      sentAt: new Date().toISOString(),
      file: { name: "relatorio.pdf", url: `/files/${name}`, size: 6, expiresAt },
    };
  }

  it("serves a valid attachment as a forced download with protective headers", async () => {
    const { uploadDirectory, store, storage } = setup();
    writeFileSync(join(uploadDirectory, "abc123"), "hello!");
    store.insertPublicMessage(publicFileMessage("abc123", new Date(Date.now() + 60_000).toISOString()));
    const base = await listen(storage.router);
    const response = await fetch(`${base}/files/abc123`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("content-disposition")).toContain("relatorio.pdf");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(await response.text()).toBe("hello!");
  });

  it("rejects unsafe names and answers 410 for unknown or expired files", async () => {
    const { uploadDirectory, store, storage } = setup();
    writeFileSync(join(uploadDirectory, "old1"), "x");
    store.insertPublicMessage(publicFileMessage("old1", new Date(Date.now() - 1000).toISOString()));
    const base = await listen(storage.router);
    expect((await fetch(`${base}/files/..%2Fchat.sqlite`)).status).toBe(404);
    expect((await fetch(`${base}/files/not.valid`)).status).toBe(404);
    expect((await fetch(`${base}/files/unknown`)).status).toBe(410);
    expect((await fetch(`${base}/files/old1`)).status).toBe(410);
    expect(existsSync(join(uploadDirectory, "old1"))).toBe(false);
  });

  it("blocks private-conversation files for anonymous visitors", async () => {
    const { uploadDirectory, store, storage } = setup();
    writeFileSync(join(uploadDirectory, "priv1"), "secret");
    store.insertDirectMessage({
      id: "d1",
      fromUserId: "user-1",
      toUserId: "user-2",
      fromDiscordUserId: "111111111111111111",
      toDiscordUserId: "222222222222222222",
      author: "Ana",
      recipient: "Bia",
      text: "",
      sentAt: new Date().toISOString(),
      file: { name: "p.txt", url: "/files/priv1", size: 6, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
    const base = await listen(storage.router);
    expect((await fetch(`${base}/files/priv1`)).status).toBe(403);
  });

  it("deleteStoredUpload only touches generated upload names", () => {
    const { uploadDirectory, storage } = setup();
    writeFileSync(join(uploadDirectory, "keep-me"), "x");
    writeFileSync(join(directory, "outside"), "x");
    storage.deleteStoredUpload("/files/../outside");
    storage.deleteStoredUpload("/other/keep-me");
    expect(existsSync(join(directory, "outside"))).toBe(true);
    expect(existsSync(join(uploadDirectory, "keep-me"))).toBe(true);
    storage.deleteStoredUpload("/files/keep-me");
    expect(existsSync(join(uploadDirectory, "keep-me"))).toBe(false);
  });

  it("removes orphaned uploads older than the retention period on startup", () => {
    const uploadDirectory = join(directory, "uploads");
    mkdirSync(join(uploadDirectory, "avatars"), { recursive: true });
    const orphan = join(uploadDirectory, "orphan");
    const fresh = join(uploadDirectory, "fresh");
    writeFileSync(orphan, "x");
    writeFileSync(fresh, "x");
    const old = new Date(Date.now() - retentionMs - 60_000);
    utimesSync(orphan, old, old);
    createFileStorage({
      chatStore: openStore(),
      uploadDirectory,
      avatarDirectory: join(uploadDirectory, "avatars"),
      retentionMs,
      cleanupIntervalMs: 60 * 60 * 1000,
    });
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});
