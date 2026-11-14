// Remembers the main window's size, position and maximized state between runs,
// in window-state.json inside the KCord user data folder.

const fs = require("node:fs");
const path = require("node:path");

const MIN_VISIBLE = 80;

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// The saved spot must still be on a connected monitor (a laptop that left its
// external screen would otherwise open KCord off screen).
function visibleOnSomeDisplay(bounds, screen) {
  return screen.getAllDisplays().some(({ workArea }) => {
    const overlapX = Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x);
    const overlapY = Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y);
    return overlapX >= MIN_VISIBLE && overlapY >= MIN_VISIBLE;
  });
}

function createWindowState({ app, screen, defaults }) {
  const file = path.join(app.getPath("userData"), "window-state.json");

  function load() {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      const state = { width: defaults.width, height: defaults.height, maximized: saved.maximized === true };
      if (isNumber(saved.width) && isNumber(saved.height)) {
        state.width = Math.max(defaults.minWidth, Math.round(saved.width));
        state.height = Math.max(defaults.minHeight, Math.round(saved.height));
      }
      if (isNumber(saved.x) && isNumber(saved.y)) {
        const bounds = { x: Math.round(saved.x), y: Math.round(saved.y), width: state.width, height: state.height };
        if (visibleOnSomeDisplay(bounds, screen)) {
          state.x = bounds.x;
          state.y = bounds.y;
        }
      }
      return state;
    } catch {
      return { width: defaults.width, height: defaults.height, maximized: false };
    }
  }

  let timer = null;
  function save(window) {
    clearTimeout(timer);
    timer = null;
    // Minimized (sent to the tray) and fullscreen calls are not a size to keep.
    if (!window || window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
    const maximized = window.isMaximized();
    const bounds = maximized ? window.getNormalBounds() : window.getBounds();
    try {
      fs.writeFileSync(file, JSON.stringify({ ...bounds, maximized }));
    } catch (error) {
      console.warn("Não foi possível salvar o tamanho da janela.", error);
      require("./desktop-issues.cjs").recordIssue("salvar tamanho da janela", error);
    }
  }

  // Saves shortly after the user stops moving or resizing, and right away on
  // maximize/restore and when the window closes.
  function track(window) {
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(() => save(window), 500);
    };
    const now = () => save(window);
    window.on("resize", later);
    window.on("move", later);
    window.on("maximize", now);
    window.on("unmaximize", now);
    window.on("close", now);
  }

  return { load, save, track };
}

module.exports = { createWindowState };
