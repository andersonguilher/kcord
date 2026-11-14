// Failures in the desktop process (native modules, capture, updates, crashes).
// They wait here until the page takes them and sends them to the server, which
// alerts the owner. Kept small so a failure loop cannot grow memory.

const MAX_PENDING = 50;
const pending = [];
const recent = new Map();
let notify = null;

function describe(error) {
  if (error instanceof Error) return { message: error.message || error.name, stack: error.stack || "" };
  return { message: String(error), stack: "" };
}

function recordIssue(area, error, extra = "") {
  const { message, stack } = describe(error);
  const key = `${area}|${message}`;
  const now = Date.now();
  // The same failure repeating (a timer, a retry loop) is recorded once a minute.
  if (now - (recent.get(key) ?? 0) < 60_000) return;
  recent.set(key, now);
  if (recent.size > 200) recent.clear();
  pending.push({
    area: String(area).slice(0, 64),
    message: String(message).slice(0, 900),
    details: [extra, stack].filter(Boolean).join("\n").slice(0, 6000),
    at: new Date(now).toISOString(),
  });
  if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING);
  try {
    notify?.();
  } catch {
    // The window may be gone; the page takes the queue when it loads.
  }
}

function takeIssues() {
  return pending.splice(0, pending.length);
}

function onIssue(callback) {
  notify = callback;
}

module.exports = { recordIssue, takeIssues, onIssue };
