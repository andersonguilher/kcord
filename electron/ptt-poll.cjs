// Second PTT detector: polls the key state straight from Windows
// (GetAsyncKeyState). It keeps working on PCs where the low-level keyboard
// hook stops receiving keys while another window is focused.

const POLL_INTERVAL_MS = 15;

let GetAsyncKeyState = null;
let loadError = null;
if (process.platform === "win32") {
  try {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");
    GetAsyncKeyState = user32.func("short __stdcall GetAsyncKeyState(int vKey)");
  } catch (error) {
    loadError = error;
  }
} else {
  loadError = new Error("Disponível somente no Windows.");
}

const namedKeys = {
  Backspace: 0x08, Tab: 0x09, Enter: 0x0d, NumpadEnter: 0x0d, Pause: 0x13, CapsLock: 0x14, Escape: 0x1b,
  Space: 0x20, PageUp: 0x21, PageDown: 0x22, End: 0x23, Home: 0x24, ArrowLeft: 0x25, ArrowUp: 0x26,
  ArrowRight: 0x27, ArrowDown: 0x28, PrintScreen: 0x2c, Insert: 0x2d, Delete: 0x2e,
  MetaLeft: 0x5b, MetaRight: 0x5c, ContextMenu: 0x5d,
  NumpadMultiply: 0x6a, NumpadAdd: 0x6b, NumpadSubtract: 0x6d, NumpadDecimal: 0x6e, NumpadDivide: 0x6f,
  NumLock: 0x90, ScrollLock: 0x91,
  ShiftLeft: 0xa0, ShiftRight: 0xa1, ControlLeft: 0xa2, ControlRight: 0xa3, AltLeft: 0xa4, AltRight: 0xa5,
  Semicolon: 0xba, Equal: 0xbb, Comma: 0xbc, Minus: 0xbd, Period: 0xbe, Slash: 0xbf, Backquote: 0xc0,
  IntlRo: 0xc1, BracketLeft: 0xdb, Backslash: 0xdc, BracketRight: 0xdd, Quote: 0xde, IntlBackslash: 0xe2,
};

// Maps a browser KeyboardEvent.code to a Windows virtual-key code.
function virtualKeyForCode(code) {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  if (/^Numpad[0-9]$/.test(code)) return 0x60 + Number(code.slice(6));
  const fn = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
  if (fn) return 0x6f + Number(fn[1]);
  return namedKeys[code];
}

function createKeyPoller(onChange) {
  let timer = null;
  let pressed = false;

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
    if (pressed) {
      pressed = false;
      onChange(false);
    }
  };

  const start = (virtualKey) => {
    stop();
    if (!GetAsyncKeyState || typeof virtualKey !== "number") return false;
    timer = setInterval(() => {
      let down = false;
      try {
        down = (GetAsyncKeyState(virtualKey) & 0x8000) !== 0;
      } catch {
        down = false;
      }
      if (down === pressed) return;
      pressed = down;
      onChange(down);
    }, POLL_INTERVAL_MS);
    return true;
  };

  return { start, stop, isRunning: () => timer !== null };
}

module.exports = {
  createKeyPoller,
  virtualKeyForCode,
  pollAvailable: () => GetAsyncKeyState !== null,
  pollLoadError: () => (loadError ? String(loadError.message || loadError) : null),
};
