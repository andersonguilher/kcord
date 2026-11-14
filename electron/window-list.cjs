// Lists the windows that can be shared, straight from Windows (EnumWindows).
// Chromium's own list drops windows that take more than ~50 ms to answer a
// message, so a busy game such as X-Plane came and went from the picker.

const GW_OWNER = 4;
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_NOACTIVATE = 0x08000000;
const DWMWA_CLOAKED = 14;
const SW_RESTORE = 9;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const IGNORED_CLASSES = new Set(["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"]);

let api = null;
let loadError = null;
if (process.platform === "win32") {
  try {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");
    const dwmapi = koffi.load("dwmapi.dll");
    const EnumWindowsProc = koffi.proto("bool __stdcall EnumWindowsProc(void *hwnd, intptr_t lParam)");
    api = {
      koffi,
      EnumWindows: user32.func("bool __stdcall EnumWindows(EnumWindowsProc *callback, intptr_t lParam)"),
      EnumWindowsProc,
      IsWindowVisible: user32.func("bool __stdcall IsWindowVisible(void *hwnd)"),
      IsIconic: user32.func("bool __stdcall IsIconic(void *hwnd)"),
      GetWindow: user32.func("void * __stdcall GetWindow(void *hwnd, uint32_t cmd)"),
      GetWindowLongPtrW: user32.func("intptr_t __stdcall GetWindowLongPtrW(void *hwnd, int index)"),
      GetWindowTextW: user32.func("int __stdcall GetWindowTextW(void *hwnd, _Out_ uint8_t *text, int maxCount)"),
      GetClassNameW: user32.func("int __stdcall GetClassNameW(void *hwnd, _Out_ uint8_t *name, int maxCount)"),
      GetWindowThreadProcessId: user32.func("uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *processId)"),
      // Same function, taking the handle as the number found in a source id.
      GetWindowThreadProcessIdByHandle: user32.func("GetWindowThreadProcessId", "uint32_t", ["intptr_t", "_Out_ uint32_t *"]),
      DwmGetWindowAttribute: dwmapi.func("long __stdcall DwmGetWindowAttribute(void *hwnd, uint32_t attribute, _Out_ uint32_t *value, uint32_t size)"),
      IsIconicByHandle: user32.func("IsIconic", "bool", ["intptr_t"]),
      ShowWindowByHandle: user32.func("ShowWindow", "bool", ["intptr_t", "int"]),
    };
    try {
      // Only used to name the program in a diagnostic; the list works without it.
      const kernel32 = koffi.load("kernel32.dll");
      api.OpenProcess = kernel32.func("void * __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t processId)");
      api.QueryFullProcessImageNameW = kernel32.func("bool __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, _Out_ uint8_t *name, _Inout_ uint32_t *size)");
      api.CloseHandle = kernel32.func("bool __stdcall CloseHandle(void *handle)");
    } catch {
      api.OpenProcess = null;
    }
  } catch (error) {
    loadError = error;
  }
} else {
  loadError = new Error("Disponível somente no Windows.");
}

function readWide(read, hwnd) {
  const buffer = Buffer.alloc(512 * 2);
  const length = read(hwnd, buffer, 512);
  return length > 0 ? buffer.toString("utf16le", 0, length * 2) : "";
}

// Why a window is left out of the picker; an empty list means it can be shared.
// Minimized windows are listed and restored when chosen, so that is not a reason.
function exclusionReasons(hwnd) {
  const reasons = [];
  if (!api.IsWindowVisible(hwnd)) reasons.push("invisível");
  if (api.GetWindow(hwnd, GW_OWNER)) reasons.push("janela filha");
  const exStyle = Number(api.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  if (exStyle & WS_EX_TOOLWINDOW) reasons.push("ferramenta");
  if (exStyle & WS_EX_NOACTIVATE) reasons.push("sem foco");
  const cloaked = [0];
  if (api.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, cloaked, 4) === 0 && cloaked[0]) reasons.push("oculta pelo Windows");
  const processId = [0];
  api.GetWindowThreadProcessId(hwnd, processId);
  if (processId[0] === process.pid) reasons.push("KCord");
  if (IGNORED_CLASSES.has(readWide(api.GetClassNameW, hwnd))) reasons.push("sistema");
  return reasons;
}

function processImageName(hwnd) {
  if (!api.OpenProcess) return "";
  const processId = [0];
  api.GetWindowThreadProcessId(hwnd, processId);
  const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId[0]);
  if (!handle) return "";
  try {
    const buffer = Buffer.alloc(1024 * 2);
    const size = [1024];
    if (!api.QueryFullProcessImageNameW(handle, 0, buffer, size)) return "";
    return buffer.toString("utf16le", 0, size[0] * 2).split("\\").pop() || "";
  } finally {
    api.CloseHandle(handle);
  }
}

// Returns [{ id: "window:<hwnd>:0", name, minimized }] in Windows z-order (top
// first), the same id format Chromium uses, or [] when the API is unavailable.
function listWindows() {
  if (!api) return [];
  const windows = [];
  api.EnumWindows((hwnd) => {
    try {
      if (exclusionReasons(hwnd).length > 0) return true;
      const name = readWide(api.GetWindowTextW, hwnd).trim();
      if (name) windows.push({ id: `window:${api.koffi.address(hwnd)}:0`, name, minimized: Boolean(api.IsIconic(hwnd)) });
    } catch {
      // Skip a window that closed while we looked at it.
    }
    return true;
  }, 0);
  return windows;
}

// Every titled top-level window with its program and why it is left out.
// Sent only when the user asks for a diagnostic from the picker.
function inspectWindows(limit = 120) {
  if (!api) return [];
  const windows = [];
  api.EnumWindows((hwnd) => {
    if (windows.length >= 400) return false;
    try {
      const name = readWide(api.GetWindowTextW, hwnd).trim();
      if (!name) return true;
      windows.push({
        id: `window:${api.koffi.address(hwnd)}:0`,
        name,
        program: processImageName(hwnd),
        className: readWide(api.GetClassNameW, hwnd),
        minimized: Boolean(api.IsIconic(hwnd)),
        reasons: exclusionReasons(hwnd),
      });
    } catch (error) {
      windows.push({ id: "", name: "?", program: "", className: "", minimized: false, reasons: [`erro: ${error.message}`] });
    }
    return true;
  }, 0);
  // Visible windows first: hidden system helpers would otherwise fill the limit.
  const rank = (window) => (window.reasons.length === 0 ? 0 : window.reasons.includes("invisível") ? 2 : 1);
  return windows.sort((a, b) => rank(a) - rank(b)).slice(0, limit);
}

function windowHandle(sourceId) {
  const match = /^window:(\d+):\d+$/.exec(String(sourceId));
  return match ? BigInt(match[1]) : null;
}

function isWindowMinimized(sourceId) {
  const handle = api ? windowHandle(sourceId) : null;
  if (handle === null) return false;
  try {
    return Boolean(api.IsIconicByHandle(handle));
  } catch {
    return false;
  }
}

// A minimized window cannot be captured, so bring it back before sharing.
function restoreWindow(sourceId) {
  const handle = api ? windowHandle(sourceId) : null;
  if (handle === null) return false;
  try {
    if (!api.IsIconicByHandle(handle)) return false;
    api.ShowWindowByHandle(handle, SW_RESTORE);
    return true;
  } catch {
    return false;
  }
}

// Process that owns a shared window ("window:<hwnd>:0"), or 0 when unknown.
function windowProcessId(sourceId) {
  if (!api) return 0;
  const match = /^window:(\d+):\d+$/.exec(String(sourceId));
  if (!match) return 0;
  try {
    const processId = [0];
    if (!api.GetWindowThreadProcessIdByHandle(BigInt(match[1]), processId)) return 0;
    return processId[0] >>> 0;
  } catch {
    return 0;
  }
}

module.exports = {
  listWindows,
  inspectWindows,
  isWindowMinimized,
  restoreWindow,
  windowProcessId,
  available: () => Boolean(api),
  loadError: () => loadError,
};
