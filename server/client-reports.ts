import express from "express";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AppStateStore } from "./app-state.ts";

// Failures that happen inside a user's app (for example the share source list)
// are reported here so the owner can see them without asking for screenshots.

export const CLIENT_REPORT_KINDS = ["share-sources", "share-sources-missing", "screen-share", "microphone", "app-error", "desktop-error"] as const;
export type ClientReportKind = typeof CLIENT_REPORT_KINDS[number];
export const CLIENT_REPORT_STATUSES = ["open", "resolved", "ignored"] as const;
export type ClientReportStatus = typeof CLIENT_REPORT_STATUSES[number];

export type ClientReport = {
  id: string;
  at: string;
  kind: ClientReportKind;
  message: string;
  discordUserId: string;
  displayName: string;
  client: "desktop" | "browser";
  appVersion: string | null;
  userAgent: string;
  context: Record<string, string>;
  details?: string;
  status: ClientReportStatus;
  statusChangedAt?: string;
};

type Reporter = { discordUserId: string; displayName: string };

const MAX_STORED_REPORTS = 300;
const MAX_REPORTS_PER_HOUR = 30;
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
const MAX_CONTEXT_KEYS = 8;

function text(value: unknown, maxLength: number) {
  if (typeof value !== "string") return "";
  // Control characters are dropped so a report cannot fake extra log lines.
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, maxLength);
}

// Long diagnostics keep their line breaks; other control characters are dropped.
function multilineText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ").trim().slice(0, maxLength);
}

// Accepts only a known kind and short plain-text fields; everything else is dropped.
export function sanitizeClientReport(body: unknown) {
  if (!body || typeof body !== "object") return null;
  const input = body as Record<string, unknown>;
  const kind = CLIENT_REPORT_KINDS.find((candidate) => candidate === input.kind);
  const message = text(input.message, 1000);
  if (!kind || !message) return null;
  const context: Record<string, string> = {};
  if (input.context && typeof input.context === "object" && !Array.isArray(input.context)) {
    for (const [key, value] of Object.entries(input.context as Record<string, unknown>).slice(0, MAX_CONTEXT_KEYS)) {
      if (!/^[a-zA-Z][a-zA-Z0-9]{0,31}$/.test(key)) continue;
      const cleaned = text(value, 200);
      if (cleaned) context[key] = cleaned;
    }
  }
  const appVersion = text(input.appVersion, 32);
  const details = multilineText(input.details, 12000);
  return {
    ...(details ? { details } : {}),
    kind,
    message,
    client: input.client === "desktop" ? "desktop" as const : "browser" as const,
    appVersion: /^[0-9A-Za-z.+-]+$/.test(appVersion) ? appVersion : null,
    userAgent: text(input.userAgent, 300),
    context,
  };
}

export function createClientReportsRouter(options: {
  state: AppStateStore;
  /** Where an older release kept `client-reports.json`, imported once. */
  dataDirectory: string;
  identify: (request: express.Request) => Reporter | null;
  isOwner: (request: express.Request) => boolean;
  onReport?: (report: ClientReport) => void;
}) {
  const reports = loadReports(options.state, options.dataDirectory);
  const usage = new Map<string, number[]>();
  const router = express.Router();

  function persist() {
    options.state.set(REPORTS_STATE_KEY, reports);
  }

  router.post("/api/client-reports", (request, response) => {
    const reporter = options.identify(request);
    if (!reporter) {
      response.status(401).json({ error: "Entre com sua conta Discord para enviar relatórios." });
      return;
    }
    const report = sanitizeClientReport(request.body);
    if (!report) {
      response.status(400).json({ error: "Relatório inválido." });
      return;
    }
    const now = Date.now();
    const recent = (usage.get(reporter.discordUserId) ?? []).filter((time) => now - time < 60 * 60 * 1000);
    if (recent.length >= MAX_REPORTS_PER_HOUR) {
      response.status(429).json({ error: "Relatórios demais. Tente mais tarde." });
      return;
    }
    // The "try again" button repeats the same failure; one copy is enough.
    const duplicate = reports.find((stored) => stored.discordUserId === reporter.discordUserId
      && stored.status === "open"
      && stored.kind === report.kind
      && stored.message === report.message
      && now - Date.parse(stored.at) < DUPLICATE_WINDOW_MS);
    if (duplicate) {
      response.status(202).json({ ok: true });
      return;
    }
    recent.push(now);
    usage.set(reporter.discordUserId, recent);
    if (usage.size > 5000) usage.clear();
    const stored: ClientReport = {
      id: randomUUID(),
      at: new Date(now).toISOString(),
      discordUserId: reporter.discordUserId,
      displayName: text(reporter.displayName, 64),
      status: "open",
      ...report,
    };
    reports.unshift(stored);
    reports.splice(MAX_STORED_REPORTS);
    try {
      persist();
    } catch (error) {
      console.warn("Não foi possível salvar o relatório de falha.", error);
    }
    console.warn(`Falha relatada pelo app (${stored.kind}) de ${stored.displayName} [${stored.client} ${stored.appVersion ?? "?"}]: ${stored.message}`);
    try {
      options.onReport?.(stored);
    } catch (error) {
      console.warn("Não foi possível avisar o dono sobre a falha relatada.", error);
    }
    response.status(202).json({ ok: true });
  });

  router.get("/api/admin/client-reports", (request, response) => {
    if (!options.identify(request)) {
      response.status(401).json({ error: "Entre com sua conta Discord para continuar." });
      return;
    }
    if (!options.isOwner(request)) {
      response.status(403).json({ error: "Somente o proprietário do KCord vê as falhas relatadas." });
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.json({ reports: reports.slice(0, 100) });
  });

  router.patch("/api/admin/client-reports/:id", (request, response) => {
    if (!options.identify(request)) {
      response.status(401).json({ error: "Entre com sua conta Discord para continuar." });
      return;
    }
    if (!options.isOwner(request)) {
      response.status(403).json({ error: "Somente o proprietário do KCord altera as falhas relatadas." });
      return;
    }
    const status = CLIENT_REPORT_STATUSES.find((candidate) => candidate === request.body?.status);
    if (!status) {
      response.status(400).json({ error: "Estado de relatório inválido." });
      return;
    }
    const report = reports.find((candidate) => candidate.id === request.params.id);
    if (!report) {
      response.status(404).json({ error: "Relatório não encontrado." });
      return;
    }
    report.status = status;
    report.statusChangedAt = new Date().toISOString();
    try {
      persist();
    } catch (error) {
      console.warn("Não foi possível salvar o estado do relatório de falha.", error);
      response.status(500).json({ error: "Não foi possível salvar o estado do relatório." });
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.json({ report });
  });

  return router;
}

const REPORTS_STATE_KEY = "client-reports";

function loadReports(state: AppStateStore, legacyDirectory: string): ClientReport[] {
  if (state.importLegacyJson(REPORTS_STATE_KEY, join(legacyDirectory, "client-reports.json")) === "invalid") {
    console.warn("Relatórios de falha salvos estão inválidos; começando vazio.");
    return [];
  }
  try {
    const stored = state.get<ClientReport[]>(REPORTS_STATE_KEY);
    return Array.isArray(stored) ? stored
      .filter((report) => report && typeof report.id === "string")
      .map((report) => ({
        ...report,
        status: CLIENT_REPORT_STATUSES.includes(report.status) ? report.status : "open",
      }))
      .slice(0, MAX_STORED_REPORTS) : [];
  } catch {
    console.warn("Relatórios de falha salvos estão inválidos; começando vazio.");
    return [];
  }
}
