const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kafcordDesktop", Object.freeze({
  isDesktop: true,
  platform: process.platform,
  listShareSources: (type) => ipcRenderer.invoke("desktop-share:list", type),
  restoreShareSource: (sourceId) => ipcRenderer.invoke("desktop-share:restore", sourceId),
  diagnoseShareSources: () => ipcRenderer.invoke("desktop-share:diagnose"),
  takeDesktopIssues: () => ipcRenderer.invoke("desktop-issues:take"),
  onDesktopIssues: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("desktop-issues:pending", handler);
    return () => ipcRenderer.removeListener("desktop-issues:pending", handler);
  },
  getSystemInfo: () => ipcRenderer.invoke("system:info"),
  getDisplayInfo: () => ipcRenderer.invoke("system:displays"),
  captureShareSnapshot: (sourceId, width, height) => ipcRenderer.invoke("desktop-share:snapshot", { sourceId, width, height }),
  setScreenCaptureMode: (mode) => ipcRenderer.invoke("capture:set-screen-mode", mode),
  selectShareSource: (sourceId, includeAudio) => ipcRenderer.sendSync("desktop-share:select", { sourceId, includeAudio }),
  cancelShareSelection: () => ipcRenderer.invoke("desktop-share:cancel"),
  // Audio of the shared app only: 48 kHz stereo float PCM chunks.
  startAppAudio: (sourceId) => ipcRenderer.invoke("app-audio:start", sourceId),
  stopAppAudio: () => ipcRenderer.send("app-audio:stop"),
  onAppAudio: (onData, onEnded) => {
    const dataHandler = (_event, chunk) => onData(chunk);
    const endedHandler = () => onEnded();
    ipcRenderer.on("app-audio:data", dataHandler);
    ipcRenderer.on("app-audio:ended", endedHandler);
    return () => {
      ipcRenderer.removeListener("app-audio:data", dataHandler);
      ipcRenderer.removeListener("app-audio:ended", endedHandler);
    };
  },
  configurePtt: (code, enabled, learnedKeyCode) => ipcRenderer.invoke("ptt:configure", { code, enabled, learnedKeyCode }),
  learnPttKey: () => ipcRenderer.invoke("ptt:learn"),
  getPttDiagnostics: () => ipcRenderer.invoke("ptt:diagnostics"),
  onPttState: (listener) => {
    const handler = (_event, pressed) => listener(Boolean(pressed));
    ipcRenderer.on("ptt:state", handler);
    return () => ipcRenderer.removeListener("ptt:state", handler);
  },
  getAutoStart: () => ipcRenderer.invoke("autostart:get"),
  setAutoStart: (enabled) => ipcRenderer.invoke("autostart:set", enabled === true),
  getUpdateStatus: () => ipcRenderer.invoke("update:get-status"),
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.send("update:install"),
  onUpdateStatus: (listener) => {
    const handler = (_event, status) => listener(status);
    ipcRenderer.on("update:status", handler);
    return () => ipcRenderer.removeListener("update:status", handler);
  },
  // While an in-app overlay is open, the window close button closes the overlay instead.
  setOverlayOpen: (open) => ipcRenderer.send("overlay:state", open === true),
  onCloseOverlay: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("overlay:close", handler);
    return () => ipcRenderer.removeListener("overlay:close", handler);
  },
}));
