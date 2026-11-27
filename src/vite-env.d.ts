/// <reference types="vite/client" />

type DesktopShareSource = {
  id: string;
  name: string;
  thumbnail: string;
  appIcon: string | null;
  type: "window" | "screen";
  minimized?: boolean;
};

type DesktopShareDiagnosis = {
  appVersion: string;
  windowsApiAvailable: boolean;
  windowsApiError: string | null;
  chromiumWindows: { id: string; name: string }[];
  chromiumError: string | null;
  windows: { id: string; name: string; program: string; className: string; minimized: boolean; reasons: string[] }[];
};

type DesktopIssue = { area: string; message: string; details: string; at: string };

type DesktopSystemInfo = {
  osRelease: string;
  arch: string;
  gpu: string;
  screenCaptureMode: "wgc" | "legacy";
  /** Compatible mode was chosen before a Windows, graphics driver or Chromium update. Absent in older desktop releases. */
  captureEnvironmentUpdated?: boolean;
};
type DesktopShareSnapshot = { dataUrl: string; width: number; height: number };

type DesktopUpdateStatus = {
  state: "idle" | "checking" | "available" | "downloading" | "downloaded" | "error" | "development";
  currentVersion?: string;
  version?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  message?: string;
};

type KafcordDesktopBridge = {
  isDesktop: true;
  platform: string;
  captureMode?: "electron-sources" | "system-picker";
  listShareSources?: (type: "window" | "screen") => Promise<DesktopShareSource[]>;
  selectShareSource?: (sourceId: string, includeAudio: boolean) => boolean;
  restoreShareSource?: (sourceId: string) => Promise<boolean>;
  diagnoseShareSources?: () => Promise<DesktopShareDiagnosis | null>;
  takeDesktopIssues?: () => Promise<DesktopIssue[]>;
  onDesktopIssues?: (listener: () => void) => () => void;
  getSystemInfo?: () => Promise<DesktopSystemInfo | null>;
  getDisplayInfo?: () => Promise<{ displays: Record<string, unknown>[]; screens: { id: string; name: string }[] } | null>;
  captureShareSnapshot?: (sourceId: string, width: number, height: number) => Promise<DesktopShareSnapshot | null>;
  setScreenCaptureMode?: (mode: "wgc" | "legacy") => Promise<boolean>;
  cancelShareSelection?: () => Promise<void>;
  startAppAudio?: (sourceId: string) => Promise<{ ok: boolean; error?: string }>;
  stopAppAudio?: () => void;
  onAppAudio?: (onData: (chunk: Uint8Array) => void, onEnded: () => void) => () => void;
  configurePtt?: (code: string, enabled: boolean, learnedKeyCode?: number | null) => Promise<{ ok: boolean; error?: string }>;
  learnPttKey?: () => Promise<{ hookRunning: boolean; keyCode: number | null }>;
  onPttState?: (listener: (pressed: boolean) => void) => () => void;
  getAutoStart?: () => Promise<{ supported: boolean; enabled: boolean }>;
  setAutoStart?: (enabled: boolean) => Promise<{ supported: boolean; enabled: boolean }>;
  getUpdateStatus: () => Promise<DesktopUpdateStatus>;
  checkForUpdates: () => Promise<DesktopUpdateStatus>;
  installUpdate: () => void;
  onUpdateStatus: (listener: (status: DesktopUpdateStatus) => void) => () => void;
  setOverlayOpen?: (open: boolean) => void;
  onCloseOverlay?: (listener: () => void) => () => void;
};

interface Window {
  kafcordDesktop?: KafcordDesktopBridge;
}
