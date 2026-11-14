const assert = require("node:assert/strict");
const { acquireInstanceLock } = require("../electron/instance-lock.cjs");

const scheduled = [];
let requests = 0;
let acquired = 0;
let unavailable = 0;

acquireInstanceLock({
  requestLock: () => {
    requests += 1;
    return requests === 3;
  },
  shouldRetry: true,
  onAcquired: () => { acquired += 1; },
  onUnavailable: () => { unavailable += 1; },
  schedule: (callback, delay) => {
    assert.equal(delay, 500);
    scheduled.push(callback);
  },
});

while (scheduled.length > 0) scheduled.shift()();

assert.equal(requests, 3);
assert.equal(acquired, 1);
assert.equal(unavailable, 0);

let immediateUnavailable = 0;
acquireInstanceLock({
  requestLock: () => false,
  shouldRetry: false,
  onAcquired: () => assert.fail("Uma segunda instância comum não deve adquirir o bloqueio."),
  onUnavailable: () => { immediateUnavailable += 1; },
  schedule: () => assert.fail("Uma segunda instância comum não deve agendar nova tentativa."),
});

assert.equal(immediateUnavailable, 1);
console.log("Smoke test aprovado: relançamento pós-atualização recupera o bloqueio de instância.");
