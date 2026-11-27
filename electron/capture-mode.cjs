// The screen capture mode saved in capture-mode.json, with the environment it
// was chosen in. Compatible mode exists because Windows Graphics Capture failed
// on that PC; after Windows, the graphics driver or Chromium changes, the normal
// mode may work again, so the app tells the person instead of keeping them at
// 10 fps without knowing there is a way out. Nothing switches by itself.

/** What may decide whether WGC starts: Windows build, graphics drivers, Chromium. */
function captureEnvironment({ osRelease, chrome, gpuDevices }) {
  const gpu = (gpuDevices ?? [])
    .map((device) => `${device.vendorId?.toString(16) ?? "?"}:${device.deviceId?.toString(16) ?? "?"}:${device.driverVersion ?? ""}`)
    .sort()
    .join(",");
  return { osRelease: String(osRelease ?? ""), chrome: String(chrome ?? ""), gpu };
}

function isEnvironment(value) {
  return Boolean(value)
    && typeof value.osRelease === "string"
    && typeof value.chrome === "string"
    && typeof value.gpu === "string";
}

/** Reads the saved file's text. Anything unreadable means the normal mode. */
function parseCaptureMode(text) {
  try {
    const stored = JSON.parse(text);
    return {
      screen: stored?.screen === "legacy" ? "legacy" : "wgc",
      environment: isEnvironment(stored?.environment) ? stored.environment : null,
    };
  } catch {
    return { screen: "wgc", environment: null };
  }
}

function serializeCaptureMode(screen, environment) {
  return JSON.stringify({ screen, environment });
}

/**
 * True when compatible mode was chosen in a different environment. A file saved
 * before the environment was recorded is not flagged: nothing is known about it.
 */
function captureEnvironmentChanged(saved, current) {
  if (saved.screen !== "legacy" || !saved.environment) return false;
  return saved.environment.osRelease !== current.osRelease
    || saved.environment.chrome !== current.chrome
    || saved.environment.gpu !== current.gpu;
}

module.exports = { captureEnvironment, parseCaptureMode, serializeCaptureMode, captureEnvironmentChanged };
