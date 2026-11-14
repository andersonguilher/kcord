import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createClientReportsRouter, sanitizeClientReport } from "../server/client-reports.ts";

// Unknown kinds, empty messages and odd fields never reach storage.
assert.equal(sanitizeClientReport({ kind: "rm -rf", message: "x" }), null);
assert.equal(sanitizeClientReport({ kind: "microphone", message: "   " }), null);
// Diagnostics keep line breaks but lose other control characters.
assert.equal(sanitizeClientReport({ kind: "desktop-error", message: "x", details: "linha 1\r\nlinha 2\u0007" })?.details, "linha 1\nlinha 2");
assert.equal(sanitizeClientReport({ kind: "desktop-error", message: "x" })?.details, undefined);
const cleaned = sanitizeClientReport({
  kind: "share-sources",
  message: "Falhou\nlinha falsa",
  client: "desktop",
  appVersion: "0.1.13<script>",
  context: { sourceType: "screen", "bad key": "x", nested: { a: 1 } },
});
assert.deepEqual(cleaned, { kind: "share-sources", message: "Falhou linha falsa", client: "desktop", appVersion: null, userAgent: "", context: { sourceType: "screen" } });

const dataDirectory = mkdtempSync(join(tmpdir(), "kcord-reports-"));
const app = express();
app.use(express.json());
app.use(createClientReportsRouter({
  dataDirectory,
  identify: (request) => request.headers["x-user"] ? { discordUserId: String(request.headers["x-user"]), displayName: "Alice" } : null,
  isOwner: (request) => request.headers["x-user"] === "owner",
}));
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const send = (user: string | null, body: unknown) => fetch(`${base}/api/client-reports`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(user ? { "x-user": user } : {}) },
  body: JSON.stringify(body),
});

try {
  assert.equal((await send(null, { kind: "microphone", message: "x" })).status, 401);
  assert.equal((await send("u1", { kind: "nope", message: "x" })).status, 400);
  assert.equal((await send("u1", { kind: "share-sources", message: "Failed to get sources.", client: "desktop", appVersion: "0.1.13", context: { sourceType: "screen" } })).status, 202);
  // Pressing "try again" sends the same failure; it is stored once.
  assert.equal((await send("u1", { kind: "share-sources", message: "Failed to get sources.", client: "desktop" })).status, 202);
  for (let index = 0; index < 30; index += 1) await send("u2", { kind: "microphone", message: `erro ${index}` });
  assert.equal((await send("u2", { kind: "microphone", message: "mais um" })).status, 429);

  assert.equal((await fetch(`${base}/api/admin/client-reports`, { headers: { "x-user": "u1" } })).status, 403);
  const listed = await (await fetch(`${base}/api/admin/client-reports`, { headers: { "x-user": "owner" } })).json() as { reports: { id: string; discordUserId: string; message: string; status: string }[] };
  assert.equal(listed.reports.filter((report) => report.discordUserId === "u1").length, 1);
  assert.equal(listed.reports.length, 31);
  assert.equal(listed.reports.every((report) => report.status === "open"), true);
  const reportId = listed.reports[0].id;
  assert.equal((await fetch(`${base}/api/admin/client-reports/${reportId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-user": "u1" },
    body: JSON.stringify({ status: "resolved" }),
  })).status, 403);
  assert.equal((await fetch(`${base}/api/admin/client-reports/${reportId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-user": "owner" },
    body: JSON.stringify({ status: "nope" }),
  })).status, 400);
  const updated = await (await fetch(`${base}/api/admin/client-reports/${reportId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-user": "owner" },
    body: JSON.stringify({ status: "resolved" }),
  })).json() as { report: { status: string; statusChangedAt?: string } };
  assert.equal(updated.report.status, "resolved");
  assert.ok(updated.report.statusChangedAt);
  const stored = JSON.parse(readFileSync(join(dataDirectory, "client-reports.json"), "utf8")) as { id: string; status: string }[];
  assert.equal(stored.length, 31);
  assert.equal(stored.find((report) => report.id === reportId)?.status, "resolved");
  console.log("client report checks passed");
} finally {
  server.close();
  rmSync(dataDirectory, { recursive: true, force: true });
}
