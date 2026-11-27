const { app, BrowserWindow, desktopCapturer, ipcMain, Menu, screen, session, shell, Tray } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { recordIssue, takeIssues, onIssue } = require("./desktop-issues.cjs");
const { acquireInstanceLock } = require("./instance-lock.cjs");
const { createKeyPoller, virtualKeyForCode, pollAvailable, pollLoadError } = require("./ptt-poll.cjs");
const { createPttHook } = require("./ptt-hook.cjs");
const windowList = require("./window-list.cjs");
const { listWindows, windowProcessId } = windowList;
const { createAppAudio } = require("./app-audio.cjs");
const { createWindowState } = require("./window-state.cjs");
const { captureEnvironment, parseCaptureMode, serializeCaptureMode, captureEnvironmentChanged } = require("./capture-mode.cjs");

let uIOhook = null;
let UiohookKey = {};
let hookLoadError = null;
try {
  ({ uIOhook, UiohookKey } = require("uiohook-napi"));
} catch (error) {
  hookLoadError = String(error?.message || error);
  console.warn("PTT global indisponível; usando somente o atalho com a janela em foco.", error);
  recordIssue("módulo uiohook-napi (PTT global)", error);
}
const pttHook = createPttHook(uIOhook);

process.on("uncaughtException", (error) => {
  console.error("Erro não tratado no processo do desktop.", error);
  recordIssue("erro não tratado (desktop)", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("Promessa rejeitada sem tratamento no processo do desktop.", reason);
  recordIssue("promessa rejeitada (desktop)", reason);
});

// Some PCs cannot start Windows Graphics Capture for a whole screen ("Could not
// start video source"). The user can switch screens to the older capturer; the
// choice is saved here and applied at the next start.
const captureModePath = path.join(app.getPath("userData"), "capture-mode.json");
function readCaptureMode() {
  try {
    return parseCaptureMode(fs.readFileSync(captureModePath, "utf8"));
  } catch {
    return parseCaptureMode("");
  }
}
const savedCaptureMode = readCaptureMode();
const screenCaptureMode = savedCaptureMode.screen;

// Prefer Windows Graphics Capture for normal sharing. Compatibility mode uses
// repeated desktopCapturer snapshots in the renderer instead, because Chromium
// 151+ forces WGC for monitor tracks on Windows 11 24H2 and no longer honors the
// old feature switch that selected DXGI.
if (process.platform === "win32" && screenCaptureMode === "wgc") {
  app.commandLine.appendSwitch(
    "enable-features",
    "AllowWgcWindowCapturer,AllowWgcScreenCapturer,AllowWgcDesktopCapturer,AllowWgcZeroHz",
  );
}

const productionUrl = "https://kafcord.kafly.com.br";
const startUrl = process.env.KAFCORD_DESKTOP_URL || productionUrl;
const trustedOrigins = new Set([
  new URL(productionUrl).origin,
  new URL(startUrl).origin,
  "http://localhost:5173",
]);

let mainWindow = null;
let tray = null;
let isQuitting = false;
let trayBalloonShown = false;
// True while the page shows an overlay (e.g. an enlarged image) that the close button should dismiss first.
let overlayOpen = false;
let pendingShare = null;
// Sources shown in the picker, by id. Only these can be shared.
const sharedSourceNames = new Map();
let updateCheckTimer = null;
let updateStatus = { state: "idle", currentVersion: app.getVersion() };
const windowTitle = `KCord ${app.getVersion()} - O discord da Kafly`;
// Codes that trigger PTT: the one mapped from the browser key code, plus the one
// learned from the hook itself (keyboards/layouts where the mapping differs).
let globalPttKeyCodes = new Set();
let lastHookKeydown = null;
let pendingPttLearn = null;
let globalPttPressed = false;
let globalPttHookRunning = false;
let hookPttPressed = false;
let pollPttPressed = false;
let hookStartError = null;
// What each detector saw last, shown in the settings to diagnose PTT on other PCs.
const pttDiagnostics = { lastHookAnyKeyUnfocusedAt: null, lastHookPttUnfocusedAt: null, lastPollPttUnfocusedAt: null };
const pttPoller = createKeyPoller((pressed) => {
  pollPttPressed = pressed;
  if (pressed && !isMainWindowFocused()) pttDiagnostics.lastPollPttUnfocusedAt = Date.now();
  refreshPttState();
});

function isMainWindowFocused() {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused());
}

function pttKeyCode(code) {
  if (/^Key[A-Z]$/.test(code)) return UiohookKey[code.slice(3)];
  if (/^Digit[0-9]$/.test(code)) return UiohookKey[code.slice(5)];
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) return UiohookKey[code];
  if (/^Numpad[0-9]$/.test(code)) return UiohookKey[code];
  const aliases = {
    Backspace: "Backspace", Tab: "Tab", Enter: "Enter", CapsLock: "CapsLock", Escape: "Escape", Space: "Space",
    PageUp: "PageUp", PageDown: "PageDown", End: "End", Home: "Home", ArrowLeft: "ArrowLeft", ArrowUp: "ArrowUp",
    ArrowRight: "ArrowRight", ArrowDown: "ArrowDown", Insert: "Insert", Delete: "Delete", NumpadMultiply: "NumpadMultiply",
    NumpadAdd: "NumpadAdd", NumpadSubtract: "NumpadSubtract", NumpadDecimal: "NumpadDecimal", NumpadDivide: "NumpadDivide",
    NumpadEnter: "NumpadEnter", Semicolon: "Semicolon", Equal: "Equal", Comma: "Comma", Minus: "Minus", Period: "Period",
    Slash: "Slash", Backquote: "Backquote", BracketLeft: "BracketLeft", Backslash: "Backslash", BracketRight: "BracketRight",
    Quote: "Quote", ControlLeft: "Ctrl", ControlRight: "CtrlRight", AltLeft: "Alt", AltRight: "AltRight", ShiftLeft: "Shift",
    ShiftRight: "ShiftRight", MetaLeft: "Meta", MetaRight: "MetaRight", NumLock: "NumLock", ScrollLock: "ScrollLock",
    PrintScreen: "PrintScreen",
  };
  const key = aliases[code];
  return key ? UiohookKey[key] : undefined;
}

function refreshPttState() {
  publishPttState(hookPttPressed || pollPttPressed);
}

function publishPttState(pressed) {
  if (globalPttPressed === pressed) return;
  globalPttPressed = pressed;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("ptt:state", pressed);
}

function stopGlobalPttHook() {
  pttPoller.stop();
  hookPttPressed = false;
  pollPttPressed = false;
  publishPttState(false);
  globalPttKeyCodes = new Set();
  if (!globalPttHookRunning) return;
  // Clear app state before entering native code. uiohook-napi can throw when
  // its Windows worker has already ended, and retaining "running" here would
  // repeat the same failure on every PTT reconfiguration.
  globalPttHookRunning = false;
  const result = pttHook.stop();
  if (!result.ok) {
    hookLoadError = pttHook.lastError();
    console.warn("Não foi possível encerrar o hook global do PTT; usando somente a leitura direta de teclas nesta sessão.", result.error);
    // The independent GetAsyncKeyState poller remains the supported fallback.
    // Do not create an owner-facing incident merely for discarding this
    // poisoned native instance; a later activation reports if no detector works.
  }
}

function isHookKeyCode(value) {
  return Number.isInteger(value) && value > 0 && value <= 0xffff;
}

function configureGlobalPtt(code, enabled, learnedKeyCode) {
  stopGlobalPttHook();
  hookStartError = null;
  if (!enabled) return { ok: true };
  // Two independent detectors: the polled key state and the keyboard hook.
  const polling = pttPoller.start(virtualKeyForCode(code));
  let hookKnowsKey = false;
  if (pttHook.available()) {
    const keyCodes = [pttKeyCode(code), learnedKeyCode].filter(isHookKeyCode);
    globalPttKeyCodes = new Set(keyCodes);
    hookKnowsKey = keyCodes.length > 0;
    try {
      // Start even without a known code so the key can be learned while focused.
      const result = pttHook.start();
      if (!result.ok) throw result.error;
      globalPttHookRunning = pttHook.isRunning();
    } catch (error) {
      globalPttKeyCodes = new Set();
      hookKnowsKey = false;
      hookStartError = String(error?.message || error);
      console.warn("Não foi possível iniciar o hook global do PTT.", error);
      recordIssue("PTT global (iniciar)", error);
    }
  }
  if (polling || hookKnowsKey) return { ok: true };
  if (globalPttHookRunning) return { ok: false, error: "Aperte a tecla do PTT uma vez com o KCord em foco para ativar o PTT fora dele." };
  return { ok: false, error: "Não foi possível ativar o PTT fora de foco neste computador." };
}

function pttDiagnosticsReport() {
  return {
    hook: { loaded: pttHook.available(), running: globalPttHookRunning, error: hookLoadError ?? hookStartError, keyCodes: [...globalPttKeyCodes] },
    poll: { available: pollAvailable(), running: pttPoller.isRunning(), error: pollLoadError() },
    ...pttDiagnostics,
    now: Date.now(),
  };
}

// Called when the focused page sees the PTT key: the hook event for the same
// physical key arrives within a few milliseconds, before or after this call.
function learnPttKey() {
  if (!globalPttHookRunning) return Promise.resolve(null);
  const now = Date.now();
  if (lastHookKeydown && now - lastHookKeydown.at <= 300) return Promise.resolve(lastHookKeydown.keycode);
  pendingPttLearn?.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingPttLearn?.resolve === finish) pendingPttLearn = null;
      resolve(null);
    }, 300);
    const finish = (keycode) => {
      clearTimeout(timer);
      resolve(keycode);
    };
    pendingPttLearn = { resolve: finish };
  });
}

uIOhook?.on("keydown", (event) => {
  lastHookKeydown = { keycode: event.keycode, at: Date.now() };
  const focused = isMainWindowFocused();
  if (!focused) pttDiagnostics.lastHookAnyKeyUnfocusedAt = lastHookKeydown.at;
  if (pendingPttLearn) {
    const { resolve } = pendingPttLearn;
    pendingPttLearn = null;
    resolve(event.keycode);
  }
  if (!globalPttKeyCodes.has(event.keycode)) return;
  if (!focused) pttDiagnostics.lastHookPttUnfocusedAt = lastHookKeydown.at;
  hookPttPressed = true;
  refreshPttState();
});
uIOhook?.on("keyup", (event) => {
  if (!globalPttKeyCodes.has(event.keycode)) return;
  hookPttPressed = false;
  refreshPttState();
});

function publishUpdateStatus(nextStatus) {
  updateStatus = { ...updateStatus, ...nextStatus, currentVersion: app.getVersion() };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("update:status", updateStatus);
}

function configureUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  // Existing offline-NSIS installations must be allowed to migrate to the
  // smaller web installer used for future releases.
  autoUpdater.disableWebInstaller = false;

  autoUpdater.on("checking-for-update", () => {
    updateStatus = { state: "checking", currentVersion: app.getVersion() };
  });
  autoUpdater.on("update-available", (info) => {
    publishUpdateStatus({ state: "available", version: info.version, percent: 0 });
  });
  autoUpdater.on("download-progress", (progress) => {
    publishUpdateStatus({
      state: "downloading",
      version: updateStatus.version,
      percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
      transferred: progress.transferred,
      total: progress.total,
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    publishUpdateStatus({ state: "downloaded", version: info.version, percent: 100 });
  });
  autoUpdater.on("update-not-available", () => {
    updateStatus = { state: "idle", currentVersion: app.getVersion() };
  });
  autoUpdater.on("error", (error) => {
    recordIssue("atualização automática", error, `estado: ${updateStatus.state}`);
    if (["available", "downloading", "downloaded"].includes(updateStatus.state)) {
      publishUpdateStatus({ state: "error", message: error?.message || "Não foi possível baixar a atualização." });
    } else {
      updateStatus = { state: "idle", currentVersion: app.getVersion() };
    }
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => undefined);
  setTimeout(check, 8000);
  updateCheckTimer = setInterval(check, 60 * 1000);
  updateCheckTimer.unref?.();
}

function isTrustedUrl(value) {
  try {
    return trustedOrigins.has(new URL(value).origin);
  } catch {
    return false;
  }
}

function isDiscordUrl(value) {
  try {
    return new URL(value).origin === "https://discord.com";
  } catch {
    return false;
  }
}

function isTrustedIpcEvent(event) {
  return Boolean(event?.senderFrame && isTrustedUrl(event.senderFrame.url));
}

async function listSources(type) {
  const sourceType = type === "screen" ? "screen" : "window";
  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: [sourceType],
      thumbnailSize: { width: 640, height: 360 },
      fetchWindowIcons: sourceType === "window",
    });
  } catch (error) {
    // On some PCs (drivers, older Windows builds) grabbing the previews fails and
    // the whole listing fails with it. Retry without previews or icons.
    console.warn("Falha ao listar fontes com prévia; tentando sem prévia.", error);
    recordIssue(`lista de fontes com prévia (${sourceType})`, error);
    try {
      sources = await desktopCapturer.getSources({
        types: [sourceType],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
      });
    } catch (retryError) {
      // Windows can still list the windows by itself; screens have no fallback.
      // Both reasons go into the message so the app's failure report carries them.
      if (sourceType !== "window") {
        const first = error instanceof Error ? error.message : String(error);
        const second = retryError instanceof Error ? retryError.message : String(retryError);
        throw new Error(`${second} (com prévia: ${first})`);
      }
      console.warn("Falha ao listar janelas pelo Chromium; usando só a lista do Windows.", retryError);
      recordIssue("lista de janelas do Chromium", retryError);
      sources = [];
    }
  }

  const listed = sources.map((source) => ({
    id: source.id,
    name: source.name,
    thumbnail: source.thumbnail && !source.thumbnail.isEmpty() ? source.thumbnail.toDataURL() : "",
    appIcon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null,
    type: sourceType,
    minimized: sourceType === "window" && windowList.isWindowMinimized(source.id),
  }));
  // Chromium skips windows that are slow to answer (a busy game), so add the
  // ones Windows itself reports. They have no preview, only the name.
  if (sourceType === "window") {
    const known = new Set(listed.map((source) => source.id));
    try {
      for (const window of listWindows()) {
        if (!known.has(window.id)) listed.push({ ...window, thumbnail: "", appIcon: null, type: "window" });
      }
    } catch (error) {
      console.warn("Lista de janelas do Windows indisponível.", error);
      recordIssue("lista de janelas do Windows", error);
    }
  }
  for (const id of sharedSourceNames.keys()) {
    if (id.startsWith(`${sourceType}:`)) sharedSourceNames.delete(id);
  }
  for (const source of listed) sharedSourceNames.set(source.id, source.name);
  return listed;
}

function configureCapture() {
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => (
    isTrustedUrl(requestingOrigin) && (permission === "media" || permission === "display-capture")
  ));

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(isTrustedUrl(webContents.getURL()) && (permission === "media" || permission === "display-capture"));
  });

  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    const selection = pendingShare;
    pendingShare = null;
    if (!selection) {
      callback({});
      return;
    }

    // Use the id picked from the list directly: listing again could miss a busy
    // window that was there a moment ago.
    const name = sharedSourceNames.get(selection.sourceId);
    if (!name) {
      callback({});
      return;
    }
    const video = { id: selection.sourceId, name };
    callback(selection.includeAudio ? { video, audio: "loopback" } : { video });
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  mainWindow.setSkipTaskbar(false);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function hideMainWindowToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setSkipTaskbar(true);
  mainWindow.hide();
  if (process.platform === "win32" && tray && !trayBalloonShown) {
    trayBalloonShown = true;
    tray.displayBalloon({
      title: "KCord continua aberto",
      content: "Clique no ícone da bandeja para voltar ao KCord.",
      iconType: "info",
      noSound: true,
    });
  }
}

function createTray() {
  if (tray) return;
  tray = new Tray(path.join(__dirname, "..", "build", "icon-v2.ico"));
  tray.setToolTip(windowTitle);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Abrir KCord", click: showMainWindow },
    { type: "separator" },
    {
      label: "Encerrar KCord",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
  tray.on("click", showMainWindow);
  tray.on("double-click", showMainWindow);
}

function createWindow() {
  const windowState = createWindowState({
    app,
    screen,
    defaults: { width: 1440, height: 900, minWidth: 940, minHeight: 620 },
  });
  const savedState = windowState.load();
  mainWindow = new BrowserWindow({
    width: savedState.width,
    height: savedState.height,
    ...(savedState.x !== undefined ? { x: savedState.x, y: savedState.y } : {}),
    minWidth: 940,
    minHeight: 620,
    backgroundColor: "#111214",
    autoHideMenuBar: true,
    show: false,
    title: windowTitle,
    icon: path.join(__dirname, "..", "build", "icon-v2.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  windowState.track(mainWindow);
  mainWindow.once("ready-to-show", () => {
    if (savedState.maximized) mainWindow.maximize();
    showMainWindow();
  });
  // Keep the version visible instead of the web page's <title>.
  mainWindow.on("page-title-updated", (event) => event.preventDefault());
  mainWindow.on("minimize", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    hideMainWindowToTray();
  });
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    if (overlayOpen) {
      overlayOpen = false;
      mainWindow.webContents.send("overlay:close");
      return;
    }
    hideMainWindowToTray();
  });
  mainWindow.webContents.on("did-start-loading", () => {
    overlayOpen = false;
    appAudio.stop();
  });
  mainWindow.on("closed", () => {
    stopGlobalPttHook();
    appAudio.stop();
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedUrl(url) || isDiscordUrl(url)) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isTrustedUrl(url) || isDiscordUrl(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
  void mainWindow.loadURL(startUrl);
}

ipcMain.handle("desktop-share:list", (event, type) => (isTrustedIpcEvent(event) ? listSources(type) : []));
ipcMain.handle("desktop-issues:take", (event) => (isTrustedIpcEvent(event) ? takeIssues() : []));
onIssue(() => mainWindow?.webContents.send("desktop-issues:pending"));
async function gpuDevices() {
  try {
    return (await app.getGPUInfo("basic"))?.gpuDevice ?? [];
  } catch {
    return [];
  }
}
async function currentCaptureEnvironment() {
  return captureEnvironment({ osRelease: os.release(), chrome: process.versions.chrome, gpuDevices: await gpuDevices() });
}
function saveCaptureMode(screen, environment) {
  fs.writeFileSync(captureModePath, serializeCaptureMode(screen, environment));
}
// Windows build and graphics card go with every report from this app.
ipcMain.handle("system:info", async (event) => {
  if (!isTrustedIpcEvent(event)) return null;
  const devices = await gpuDevices();
  const gpu = devices.map((device) => `${device.active ? "*" : ""}${device.vendorId?.toString(16) ?? "?"}:${device.deviceId?.toString(16) ?? "?"}${device.driverVersion ? ` driver ${device.driverVersion}` : ""}`).join(", ");
  const environment = captureEnvironment({ osRelease: os.release(), chrome: process.versions.chrome, gpuDevices: devices });
  // Compatible mode saved by an older release has no environment: record the
  // current one, so a later Windows, driver or Chromium update can be noticed.
  if (screenCaptureMode === "legacy" && !savedCaptureMode.environment) {
    try {
      saveCaptureMode("legacy", environment);
      savedCaptureMode.environment = environment;
    } catch (error) {
      recordIssue("salvar ambiente do modo de captura", error);
    }
  }
  const captureEnvironmentUpdated = captureEnvironmentChanged(savedCaptureMode, environment);
  return { osRelease: os.release(), arch: process.arch, gpu, screenCaptureMode, captureEnvironmentUpdated };
});
// Monitors and the screens offered in the picker, sent when a screen share fails.
ipcMain.handle("system:displays", (event) => {
  if (!isTrustedIpcEvent(event)) return null;
  const primaryId = screen.getPrimaryDisplay().id;
  const displays = screen.getAllDisplays().map((display) => ({
    id: display.id,
    primary: display.id === primaryId,
    size: `${display.size.width}x${display.size.height}`,
    bounds: `${display.bounds.x},${display.bounds.y}`,
    scaleFactor: display.scaleFactor,
    rotation: display.rotation,
    colorDepth: display.colorDepth,
    colorSpace: display.colorSpace,
    frequency: display.displayFrequency,
    internal: display.internal,
  }));
  const screens = [...sharedSourceNames.entries()]
    .filter(([id]) => id.startsWith("screen:"))
    .map(([id, name]) => ({ id, name }));
  return { displays, screens };
});
// Compatibility capture: desktopCapturer's snapshot path still uses the DXGI
// thumbnail capturer on Windows builds where Chromium forces WGC for live tracks.
// The renderer turns these bounded JPEG frames into a canvas MediaStreamTrack.
ipcMain.handle("desktop-share:snapshot", async (event, request) => {
  if (!isTrustedIpcEvent(event) || screenCaptureMode !== "legacy") return null;
  const sourceId = typeof request?.sourceId === "string" ? request.sourceId : "";
  if (!sourceId.startsWith("screen:") || !sharedSourceNames.has(sourceId)) return null;
  const width = Math.max(320, Math.min(1920, Math.round(Number(request?.width) || 1280)));
  const height = Math.max(180, Math.min(1080, Math.round(Number(request?.height) || 720)));
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width, height },
      fetchWindowIcons: false,
    });
    const source = sources.find((candidate) => candidate.id === sourceId);
    if (!source || source.thumbnail.isEmpty()) return null;
    const size = source.thumbnail.getSize();
    return {
      dataUrl: `data:image/jpeg;base64,${source.thumbnail.toJPEG(78).toString("base64")}`,
      width: size.width,
      height: size.height,
    };
  } catch (error) {
    console.warn("Falha ao capturar quadro no modo compatível.", error);
    return null;
  }
});
// Saves the chosen capturer and restarts, since Chromium reads it only at start.
ipcMain.handle("capture:set-screen-mode", async (event, mode) => {
  if (!isTrustedIpcEvent(event) || (mode !== "legacy" && mode !== "wgc")) return false;
  try {
    saveCaptureMode(mode, await currentCaptureEnvironment());
  } catch (error) {
    recordIssue("salvar modo de captura", error);
    return false;
  }
  isQuitting = true;
  app.relaunch();
  app.exit(0);
  return true;
});
// Restores a minimized window and gives it a moment to draw before capture.
ipcMain.handle("desktop-share:restore", async (event, sourceId) => {
  if (!isTrustedIpcEvent(event) || typeof sourceId !== "string") return false;
  if (!windowList.restoreWindow(sourceId)) return false;
  await new Promise((resolve) => setTimeout(resolve, 500));
  return true;
});
// What both window lists see, for the "app not found" report the user sends.
ipcMain.handle("desktop-share:diagnose", async (event) => {
  if (!isTrustedIpcEvent(event)) return null;
  let chromiumWindows = [];
  let chromiumError = null;
  try {
    const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
    chromiumWindows = sources.map((source) => ({ id: source.id, name: source.name }));
  } catch (error) {
    chromiumError = error instanceof Error ? error.message : String(error);
  }
  let windows = [];
  let windowsError = null;
  try {
    windows = windowList.inspectWindows();
  } catch (error) {
    windowsError = error instanceof Error ? error.message : String(error);
  }
  return {
    appVersion: app.getVersion(),
    windowsApiAvailable: windowList.available(),
    windowsApiError: windowList.loadError()?.message ?? windowsError,
    chromiumWindows,
    chromiumError,
    windows,
  };
});
ipcMain.on("desktop-share:select", (event, selection) => {
  if (!isTrustedIpcEvent(event) || !selection || typeof selection.sourceId !== "string") {
    event.returnValue = false;
    return;
  }
  pendingShare = {
    sourceId: selection.sourceId,
    includeAudio: selection.includeAudio !== false,
  };
  event.returnValue = true;
});
const appAudio = createAppAudio({ app, windowProcessId });
ipcMain.handle("app-audio:start", (event, sourceId) => {
  if (!isTrustedIpcEvent(event) || typeof sourceId !== "string" || !sharedSourceNames.has(sourceId)) {
    return { ok: false, error: "Fonte de áudio inválida." };
  }
  return appAudio.start(sourceId, event.sender);
});
ipcMain.on("app-audio:stop", (event) => {
  if (isTrustedIpcEvent(event)) appAudio.stop();
});
ipcMain.handle("desktop-share:cancel", (event) => {
  if (!isTrustedIpcEvent(event)) return false;
  pendingShare = null;
  return true;
});
ipcMain.on("overlay:state", (event, open) => {
  if (isTrustedIpcEvent(event)) overlayOpen = open === true;
});
ipcMain.handle("ptt:configure", (event, configuration) => {
  if (!isTrustedIpcEvent(event)) return { ok: false, error: "Origem não autorizada." };
  const code = typeof configuration?.code === "string" ? configuration.code.slice(0, 40) : "";
  return configureGlobalPtt(code, configuration?.enabled === true, configuration?.learnedKeyCode);
});
ipcMain.handle("ptt:diagnostics", (event) => (isTrustedIpcEvent(event) ? pttDiagnosticsReport() : null));
ipcMain.handle("ptt:learn", async (event) => {
  if (!isTrustedIpcEvent(event) || !globalPttHookRunning) return { hookRunning: false, keyCode: null };
  const keyCode = await learnPttKey();
  if (!isHookKeyCode(keyCode)) return { hookRunning: globalPttHookRunning, keyCode: null };
  if (globalPttHookRunning) globalPttKeyCodes.add(keyCode);
  return { hookRunning: globalPttHookRunning, keyCode };
});
function autoStartStatus() {
  // Only the installed app can register itself; in development it would register electron.exe.
  const supported = app.isPackaged && process.platform === "win32";
  return { supported, enabled: supported && app.getLoginItemSettings().openAtLogin };
}
ipcMain.handle("autostart:get", (event) => (isTrustedIpcEvent(event) ? autoStartStatus() : { supported: false, enabled: false }));
ipcMain.handle("autostart:set", (event, enabled) => {
  if (!isTrustedIpcEvent(event)) return { supported: false, enabled: false };
  if (autoStartStatus().supported) app.setLoginItemSettings({ openAtLogin: enabled === true });
  return autoStartStatus();
});
ipcMain.handle("update:get-status", (event) => (isTrustedIpcEvent(event) ? updateStatus : { state: "unavailable" }));
ipcMain.handle("update:check", async (event) => {
  if (!isTrustedIpcEvent(event)) return { state: "unavailable" };
  if (!app.isPackaged) return { state: "development", currentVersion: app.getVersion() };
  await autoUpdater.checkForUpdates();
  return updateStatus;
});
ipcMain.on("update:install", (event) => {
  if (!isTrustedIpcEvent(event)) return;
  if (updateStatus.state === "downloaded") autoUpdater.quitAndInstall(true, true);
});

function startApplication() {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId("br.com.kafly.kcord");
    // Native helpers that failed to load leave features silently degraded.
    if (process.platform === "win32" && windowList.loadError()) recordIssue("módulo koffi (lista de janelas do Windows)", windowList.loadError());
    if (process.platform === "win32" && pollLoadError?.()) recordIssue("módulo de leitura de teclas (PTT)", pollLoadError());
    app.on("render-process-gone", (_event, _contents, details) => {
      recordIssue("página do KCord encerrada", new Error(`${details.reason} (código ${details.exitCode})`));
    });
    const gpuCrashTimes = [];
    app.on("child-process-gone", (_event, details) => {
      if (details.reason === "clean-exit") return;
      if (details.type === "GPU") {
        // Chromium restarts a crashed GPU process by itself, so one crash is
        // usually invisible to the user. Report only repeated crashes.
        const now = Date.now();
        gpuCrashTimes.push(now);
        while (gpuCrashTimes.length && now - gpuCrashTimes[0] > 10 * 60 * 1000) gpuCrashTimes.shift();
        if (gpuCrashTimes.length < 3) return;
        recordIssue("processo GPU encerrado repetidamente", new Error(`${details.reason} (código ${details.exitCode}), ${gpuCrashTimes.length} vezes em 10 min`));
        gpuCrashTimes.length = 0;
        return;
      }
      recordIssue(`processo ${details.type} encerrado`, new Error(`${details.reason} (código ${details.exitCode})${details.name ? ` ${details.name}` : ""}`));
    });
    configureCapture();
    createTray();
    createWindow();
    configureUpdates();
    app.on("activate", () => {
      showMainWindow();
    });
  });
}

acquireInstanceLock({
  requestLock: () => app.requestSingleInstanceLock(),
  shouldRetry: process.argv.includes("--updated"),
  onAcquired: startApplication,
  onUnavailable: () => app.quit(),
});

app.on("before-quit", () => {
  isQuitting = true;
  appAudio.stop();
  stopGlobalPttHook();
  if (updateCheckTimer) clearInterval(updateCheckTimer);
});

app.on("window-all-closed", () => {
  if (isQuitting || process.platform !== "darwin") app.quit();
});
