import type { FileAttachment, Member } from "../types";

export const formatTime = (value: string) =>
  new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));

export const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const SCREEN_THUMBNAIL_REFRESH_MS = 60_000;

export const fileIsExpired = (file: FileAttachment) => file.expired === true
  || Boolean(file.expiresAt && Date.parse(file.expiresAt) <= Date.now());

export const formatFileExpiry = (value: string) => new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
}).format(new Date(value));

export const formatTraffic = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

export function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

export function memberVolumeKey(member: Member) {
  return member.kafcordUserId ?? member.discordUserId ?? member.socketId;
}

export function keyLabel(code: string) {
  const aliases: Record<string, string> = {
    Space: "Espaço",
    ShiftLeft: "Shift esquerdo",
    ShiftRight: "Shift direito",
    ControlLeft: "Ctrl esquerdo",
    ControlRight: "Ctrl direito",
    AltLeft: "Alt esquerdo",
    AltRight: "Alt direito",
  };
  return aliases[code] ?? code.replace(/^Key/, "").replace(/^Digit/, "");
}

export function describeError(error: unknown) {
  if (error instanceof Error) return error.name && error.name !== "Error" ? `${error.name}: ${error.message}` : error.message;
  return String(error);
}

// Text sent with "app not found": what each window list saw and why a window was left out.
export function formatShareDiagnosis(diagnosis: DesktopShareDiagnosis) {
  const lines = [
    `Lista do Windows (koffi): ${diagnosis.windowsApiAvailable ? "ok" : `indisponível — ${diagnosis.windowsApiError ?? "motivo desconhecido"}`}`,
    `Lista do Chromium: ${diagnosis.chromiumError ? `erro — ${diagnosis.chromiumError}` : `${diagnosis.chromiumWindows.length} janelas`}`,
    "",
    "Janelas abertas (programa · nome · situação):",
  ];
  const chromiumIds = new Set(diagnosis.chromiumWindows.map((window) => window.id));
  for (const window of diagnosis.windows) {
    const status = window.reasons.length ? `fora: ${window.reasons.join(", ")}` : "listada";
    const extra = [window.minimized ? "minimizada" : "", chromiumIds.has(window.id) ? "Chromium vê" : "Chromium não vê"].filter(Boolean).join(", ");
    lines.push(`- ${window.program || "?"} · ${window.name} · ${status} (${extra}) [${window.className}]`);
  }
  const windowsIds = new Set(diagnosis.windows.map((window) => window.id));
  for (const window of diagnosis.chromiumWindows) {
    if (!windowsIds.has(window.id)) lines.push(`- (só Chromium) ${window.name}`);
  }
  return lines.join("\n");
}

export function linkHostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
