(() => {
  if (window.kafcordDesktop || !window.__TAURI__?.core?.invoke) return;

  const invoke = window.__TAURI__.core.invoke;
  const updateStatus = Object.freeze({ state: "development", currentVersion: "0.1.8" });
  const systemPickerThumbnail = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360">
      <rect width="640" height="360" rx="20" fill="#17191f"/>
      <rect x="145" y="70" width="350" height="210" rx="12" fill="#242832" stroke="#5865f2" stroke-width="8"/>
      <path d="M260 309h120M320 280v29" stroke="#9aa4ff" stroke-width="12" stroke-linecap="round"/>
      <path d="m288 142 80 38-80 38z" fill="#9aa4ff"/>
    </svg>
  `)}`;

  Object.defineProperty(window, "kafcordDesktop", {
    configurable: false,
    writable: false,
    value: Object.freeze({
      isDesktop: true,
      platform: "win32",
      captureMode: "system-picker",
      // Compatibility for the currently deployed frontend. The next web build
      // reads captureMode and opens getDisplayMedia directly.
      listShareSources: (type) => Promise.resolve([{
        id: "system-picker",
        name: type === "screen" ? "Escolher uma tela no Windows" : "Escolher no Windows",
        thumbnail: systemPickerThumbnail,
        appIcon: null,
      }]),
      selectShareSource: (sourceId) => sourceId === "system-picker",
      cancelShareSelection: () => Promise.resolve(),
      configurePtt: (code, enabled) => invoke("configure_ptt", { code, enabled }),
      onPttState: (listener) => {
        const handler = (event) => listener(Boolean(event.detail));
        window.addEventListener("kafcord:ptt-state", handler);
        return () => window.removeEventListener("kafcord:ptt-state", handler);
      },
      getAutoStart: () => invoke("get_auto_start"),
      setAutoStart: (enabled) => invoke("set_auto_start", { enabled: enabled === true }),
      getUpdateStatus: () => Promise.resolve(updateStatus),
      checkForUpdates: () => Promise.resolve(updateStatus),
      installUpdate: () => undefined,
      onUpdateStatus: () => () => undefined,
    }),
  });
})();
