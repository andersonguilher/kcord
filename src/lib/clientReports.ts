import type { ClientReport, ClientReportKind, ClientReportStatus } from "../types";
import { describeError } from "./format";

export const clientReportLabels: Record<ClientReportKind, string> = {
  "share-sources": "Lista de fontes da live",
  "share-sources-missing": "Aplicativo não aparece na live",
  "screen-share": "Início da live",
  microphone: "Microfone",
  "app-error": "Erro na página do app",
  "desktop-error": "Falha no app desktop",
};

export const clientReportStatusLabels: Record<ClientReportStatus, string> = {
  open: "Aberto",
  resolved: "Resolvido",
  ignored: "Ignorado",
};

export function normalizeClientReports(reports: ClientReport[]): ClientReport[] {
  return reports.map((report) => ({
    ...report,
    status: (report.status === "resolved" || report.status === "ignored" ? report.status : "open") as ClientReportStatus,
  }));
}

// "Windows NT 10.0" covers Windows 10 and 11; the browser cannot tell them apart.
export function clientReportSystem(report: ClientReport) {
  const app = report.client === "desktop" ? `App ${report.appVersion ?? "?"}` : "Navegador";
  const windows = /Windows NT [\d.]+/.exec(report.userAgent)?.[0];
  const chrome = /Chrome\/(\d+)/.exec(report.userAgent)?.[1];
  const build = report.context.windowsBuild ? `Windows ${report.context.windowsBuild}` : windows ? windows.replace("Windows NT", "Windows") : null;
  const capture = report.context.captureMode === "legacy" ? "captura compatível" : null;
  return [app, build, chrome ? `Chromium ${chrome}` : null, report.context.gpu ? `GPU ${report.context.gpu}` : null, capture].filter(Boolean).join(" · ");
}

// Sends a failure from this app to the owner's panel. Best effort: never throws.
export let desktopSystemInfoPromise: Promise<DesktopSystemInfo | null> | null = null;

export function desktopSystemInfo() {
  desktopSystemInfoPromise ??= window.kafcordDesktop?.getSystemInfo?.().catch(() => null) ?? Promise.resolve(null);
  return desktopSystemInfoPromise;
}

// Sends a failure from this app to the owner's panel. Best effort: never throws.
export function reportClientIssue(kind: ClientReportKind, error: unknown, context: Record<string, string> = {}, details = "") {
  void (async () => {
    const desktop = window.kafcordDesktop;
    let appVersion: string | undefined;
    try {
      appVersion = (await desktop?.getUpdateStatus?.())?.currentVersion;
    } catch {
      // The version is optional.
    }
    const system = await desktopSystemInfo();
    if (system) {
      context = { windowsBuild: system.osRelease, gpu: system.gpu, captureMode: system.screenCaptureMode, ...context };
    }
    if (!details && error instanceof Error && error.stack) details = error.stack;
    await fetch("/api/client-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        kind,
        message: describeError(error).slice(0, 1000),
        client: desktop?.isDesktop ? "desktop" : "browser",
        appVersion,
        userAgent: navigator.userAgent,
        context,
        details: details.slice(0, 12000),
      }),
    });
  })().catch(() => undefined);
}

const APP_ERROR_LIMIT_PER_PAGE = 20;

let appErrorsReported = 0;

// Browser noise that is not a KCord failure.
export function isIgnoredPageError(message: string) {
  return /ResizeObserver loop|Script error\.?$|extension:\/\//i.test(message);
}

/** Reports an unhandled page error, a few per page load at most. */
export function reportPageError(error: unknown, fallback: string) {
  const message = error instanceof Error ? describeError(error) : String(error ?? fallback);
  if (isIgnoredPageError(message) || appErrorsReported >= APP_ERROR_LIMIT_PER_PAGE) return;
  appErrorsReported += 1;
  reportClientIssue("app-error", error instanceof Error ? error : new Error(message));
}
