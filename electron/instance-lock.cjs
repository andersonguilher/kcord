function acquireInstanceLock({
  requestLock,
  shouldRetry = false,
  onAcquired,
  onUnavailable,
  maxRetries = 20,
  retryDelayMs = 500,
  schedule = setTimeout,
}) {
  let retries = 0;
  let settled = false;

  const tryAcquire = () => {
    if (settled) return;
    if (requestLock()) {
      settled = true;
      onAcquired();
      return;
    }
    if (!shouldRetry || retries >= maxRetries) {
      settled = true;
      onUnavailable();
      return;
    }
    retries += 1;
    schedule(tryAcquire, retryDelayMs);
  };

  tryAcquire();
}

module.exports = { acquireInstanceLock };
