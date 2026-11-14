// iPhone/iPad (every iOS browser is WebKit; iPadOS reports itself as a Mac).
export function isAppleMobile() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

// Installed home-screen app (Android/iOS), as opposed to a browser tab.
export function isStandaloneApp() {
  return window.matchMedia("(display-mode: standalone)").matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export const TOUCH_ONLY_QUERY = "(hover: none) and (pointer: coarse)";

export function isTouchOnlyDevice() {
  return window.matchMedia(TOUCH_ONLY_QUERY).matches;
}

export function screenCaptureSupported() {
  return Boolean(window.kafcordDesktop) || typeof navigator.mediaDevices?.getDisplayMedia === "function";
}
