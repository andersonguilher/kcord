// Owns the uiohook-napi lifecycle without trusting the native module's state.
// On Windows, stop() can fail after the worker thread has already disappeared.
// uiohook-napi then keeps its internal "running" flag set, so that instance
// cannot be started or stopped reliably again and must not be reused.

function messageFor(error) {
  return String(error?.message || error);
}

function createPttHook(nativeHook) {
  let hook = nativeHook;
  let running = false;
  let lastError = null;

  return {
    available: () => hook !== null,
    isRunning: () => running,
    lastError: () => lastError,

    start() {
      if (!hook) return { ok: false, error: lastError };
      try {
        hook.start();
        running = true;
        lastError = null;
        return { ok: true, error: null };
      } catch (error) {
        running = false;
        lastError = messageFor(error);
        return { ok: false, error };
      }
    },

    stop() {
      if (!running || !hook) return { ok: true, error: null };
      const activeHook = hook;
      // Clear our state first so a native exception cannot leave the app in a
      // false "running" state and make every later reconfiguration fail again.
      running = false;
      try {
        activeHook.stop();
        return { ok: true, error: null };
      } catch (error) {
        lastError = messageFor(error);
        // uiohook-napi only clears its own running flag after a successful
        // stop. A failed instance is therefore poisoned for this process.
        hook = null;
        return { ok: false, error };
      }
    },
  };
}

module.exports = { createPttHook };
