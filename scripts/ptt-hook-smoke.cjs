const assert = require("node:assert/strict");
const { createPttHook } = require("../electron/ptt-hook.cjs");

let starts = 0;
let stops = 0;
const healthy = createPttHook({
  start: () => { starts += 1; },
  stop: () => { stops += 1; },
});

assert.deepEqual(healthy.start(), { ok: true, error: null });
assert.equal(healthy.isRunning(), true);
assert.deepEqual(healthy.stop(), { ok: true, error: null });
assert.equal(healthy.isRunning(), false);
assert.equal(starts, 1);
assert.equal(stops, 1);

const stopFailure = new Error("An unknown hook error occurred.");
let failedStops = 0;
const poisoned = createPttHook({
  start: () => {},
  stop: () => {
    failedStops += 1;
    throw stopFailure;
  },
});

assert.equal(poisoned.start().ok, true);
assert.deepEqual(poisoned.stop(), { ok: false, error: stopFailure });
assert.equal(poisoned.isRunning(), false);
assert.equal(poisoned.available(), false);
assert.equal(poisoned.lastError(), stopFailure.message);
assert.deepEqual(poisoned.stop(), { ok: true, error: null });
assert.deepEqual(poisoned.start(), { ok: false, error: stopFailure.message });
assert.equal(failedStops, 1, "um hook envenenado não deve ser parado novamente");

let startAttempts = 0;
const retryable = createPttHook({
  start: () => {
    startAttempts += 1;
    if (startAttempts === 1) throw new Error("falha temporária");
  },
  stop: () => {},
});

assert.equal(retryable.start().ok, false);
assert.equal(retryable.available(), true);
assert.equal(retryable.start().ok, true);

console.log("Smoke test aprovado: ciclo de vida do hook de PTT se recupera sem reutilizar uma instância envenenada.");
