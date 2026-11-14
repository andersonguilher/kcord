import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type DailyTrafficStats = {
  date: string;
  httpRequests: number;
  bytesIn: number;
  bytesOut: number;
  downloadRequests: number;
  downloadBytesOut: number;
  sessions: number;
  uniqueUserIds: string[];
  publicMessages: number;
  privateMessages: number;
  voiceJoins: number;
  screenShares: number;
  fileUploads: number;
  uploadedBytes: number;
  // Every byte through the app container's network card: site, API, Socket.IO, downloads, outbound calls.
  networkBytesIn: number;
  networkBytesOut: number;
  // Voice/video relayed by coturn on the host, measured by nftables (deploy/relay-traffic).
  relayBytesIn: number;
  relayBytesOut: number;
};
export type RelayCounterSnapshot = { bootId: string; rxBytes: number; txBytes: number };
export type TrafficStatsStore = {
  version: 2;
  startedAt: string;
  networkSince?: string;
  relaySince?: string;
  relayCounter?: RelayCounterSnapshot;
  days: DailyTrafficStats[];
};

export function emptyTrafficDay(date: string): DailyTrafficStats {
  return {
    date,
    httpRequests: 0,
    bytesIn: 0,
    bytesOut: 0,
    downloadRequests: 0,
    downloadBytesOut: 0,
    sessions: 0,
    uniqueUserIds: [],
    publicMessages: 0,
    privateMessages: 0,
    voiceJoins: 0,
    screenShares: 0,
    fileUploads: 0,
    uploadedBytes: 0,
    networkBytesIn: 0,
    networkBytesOut: 0,
    relayBytesIn: 0,
    relayBytesOut: 0,
  };
}

const NETWORK_SAMPLE_INTERVAL_MS = 60_000;
const DEFAULT_CONTAINER_NETWORK_PATH = "/sys/class/net/eth0/statistics";

/**
 * Tracks daily traffic and usage counters, persisted under `dataDirectory`.
 * Sampling of the container network and the coturn relay starts immediately.
 * `containerNetworkPath` is the Linux interface-statistics folder; tests point it elsewhere
 * so they never depend on the machine they run on.
 */
export function createTrafficTracker(dataDirectory: string, { containerNetworkPath = DEFAULT_CONTAINER_NETWORK_PATH }: { containerNetworkPath?: string } = {}) {
  const trafficStatsDataPath = join(dataDirectory, "traffic-stats.json");
  function loadTrafficStats(): TrafficStatsStore {
    if (!existsSync(trafficStatsDataPath)) return { version: 2, startedAt: new Date().toISOString(), days: [] };
    try {
      const stored = JSON.parse(readFileSync(trafficStatsDataPath, "utf8")) as Partial<TrafficStatsStore>;
      if (!stored || !Array.isArray(stored.days)) throw new Error("invalid stats");
      const isLegacyStore = stored.version !== 2;
      if (isLegacyStore) {
        console.warn("Estatisticas HTTP antigas reiniciadas para separar downloads do trafego do aplicativo.");
      }
      const relayCounter = stored.relayCounter;
      return {
        version: 2,
        startedAt: stored.startedAt || new Date().toISOString(),
        networkSince: typeof stored.networkSince === "string" ? stored.networkSince : undefined,
        relaySince: typeof stored.relaySince === "string" ? stored.relaySince : undefined,
        relayCounter: relayCounter && typeof relayCounter.bootId === "string"
          && Number.isFinite(relayCounter.rxBytes) && Number.isFinite(relayCounter.txBytes)
          ? { bootId: relayCounter.bootId, rxBytes: relayCounter.rxBytes, txBytes: relayCounter.txBytes }
          : undefined,
        days: stored.days.slice(-365).map((storedDay) => ({
          ...emptyTrafficDay(String(storedDay.date ?? new Date().toISOString().slice(0, 10))),
          ...storedDay,
          httpRequests: isLegacyStore ? 0 : Number(storedDay.httpRequests) || 0,
          bytesIn: isLegacyStore ? 0 : Number(storedDay.bytesIn) || 0,
          bytesOut: isLegacyStore ? 0 : Number(storedDay.bytesOut) || 0,
          downloadRequests: isLegacyStore ? 0 : Number(storedDay.downloadRequests) || 0,
          downloadBytesOut: isLegacyStore ? 0 : Number(storedDay.downloadBytesOut) || 0,
          networkBytesIn: Number(storedDay.networkBytesIn) || 0,
          networkBytesOut: Number(storedDay.networkBytesOut) || 0,
          relayBytesIn: Number(storedDay.relayBytesIn) || 0,
          relayBytesOut: Number(storedDay.relayBytesOut) || 0,
          uniqueUserIds: Array.isArray(storedDay.uniqueUserIds)
            ? storedDay.uniqueUserIds.filter((userId) => typeof userId === "string" && !userId.startsWith("local:"))
            : [],
        })),
      };
    } catch {
      console.warn("EstatÃ­sticas persistidas invÃ¡lidas; iniciando uma nova sÃ©rie.");
      return { version: 2, startedAt: new Date().toISOString(), days: [] };
    }
  }

  const trafficStats = loadTrafficStats();
  let trafficPersistTimer: ReturnType<typeof setTimeout> | null = null;

  function persistTrafficStats() {
    if (trafficPersistTimer) clearTimeout(trafficPersistTimer);
    trafficPersistTimer = null;
    const temporaryPath = `${trafficStatsDataPath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(trafficStats, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, trafficStatsDataPath);
  }

  function scheduleTrafficPersist() {
    if (trafficPersistTimer) return;
    trafficPersistTimer = setTimeout(persistTrafficStats, 750);
    trafficPersistTimer.unref?.();
  }

  function currentTrafficDay() {
    const date = new Date().toISOString().slice(0, 10);
    let day = trafficStats.days.find((entry) => entry.date === date);
    if (!day) {
      day = emptyTrafficDay(date);
      trafficStats.days.push(day);
      trafficStats.days = trafficStats.days.slice(-365);
    }
    return day;
  }

  function recordTraffic(values: Partial<Omit<DailyTrafficStats, "date" | "uniqueUserIds">>, userId?: string) {
    const day = currentTrafficDay();
    for (const [key, value] of Object.entries(values)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const metric = key as keyof Omit<DailyTrafficStats, "date" | "uniqueUserIds">;
      day[metric] += value;
    }
    if (userId && !day.uniqueUserIds.includes(userId)) day.uniqueUserIds.push(userId);
    scheduleTrafficPersist();
  }

  const relayTrafficPath = join(dataDirectory, "relay-traffic.json");
  // The container's network counters start at zero with the container, which starts with this process.
  let lastNetworkCounter = { rxBytes: 0, txBytes: 0 };
  let relayLastUpdatedAt: string | null = null;

  function readCounter(path: string) {
    const value = Number(readFileSync(path, "utf8").trim());
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  function sampleContainerNetwork() {
    if (!existsSync(containerNetworkPath)) return;
    try {
      const rxBytes = readCounter(join(containerNetworkPath, "rx_bytes"));
      const txBytes = readCounter(join(containerNetworkPath, "tx_bytes"));
      if (rxBytes === null || txBytes === null) return;
      // A smaller value means the counters restarted; count everything since then.
      const deltaIn = rxBytes >= lastNetworkCounter.rxBytes ? rxBytes - lastNetworkCounter.rxBytes : rxBytes;
      const deltaOut = txBytes >= lastNetworkCounter.txBytes ? txBytes - lastNetworkCounter.txBytes : txBytes;
      lastNetworkCounter = { rxBytes, txBytes };
      trafficStats.networkSince ??= new Date().toISOString();
      if (deltaIn || deltaOut) recordTraffic({ networkBytesIn: deltaIn, networkBytesOut: deltaOut });
    } catch (error) {
      console.warn("Não foi possível ler o tráfego de rede do container.", error);
    }
  }

  // The host writes coturn's nftables counters to data/relay-traffic.json every minute.
  function sampleRelayTraffic() {
    if (!existsSync(relayTrafficPath)) return;
    try {
      const stored = JSON.parse(readFileSync(relayTrafficPath, "utf8")) as Partial<RelayCounterSnapshot & { updatedAt: string }>;
      const bootId = typeof stored.bootId === "string" ? stored.bootId.slice(0, 64) : "";
      const rxBytes = Number(stored.rxBytes);
      const txBytes = Number(stored.txBytes);
      if (!bootId || !Number.isFinite(rxBytes) || !Number.isFinite(txBytes) || rxBytes < 0 || txBytes < 0) return;
      relayLastUpdatedAt = typeof stored.updatedAt === "string" ? stored.updatedAt.slice(0, 40) : null;
      const previous = trafficStats.relayCounter;
      const sameSeries = previous && previous.bootId === bootId && rxBytes >= previous.rxBytes && txBytes >= previous.txBytes;
      // First reading only sets the baseline; after a reboot or counter reset, everything counted so far is new.
      const deltaIn = !previous ? 0 : sameSeries ? rxBytes - previous.rxBytes : rxBytes;
      const deltaOut = !previous ? 0 : sameSeries ? txBytes - previous.txBytes : txBytes;
      trafficStats.relayCounter = { bootId, rxBytes, txBytes };
      trafficStats.relaySince ??= new Date().toISOString();
      if (deltaIn || deltaOut) recordTraffic({ relayBytesIn: deltaIn, relayBytesOut: deltaOut });
      else scheduleTrafficPersist();
    } catch (error) {
      console.warn("Não foi possível ler o tráfego do relay de voz.", error);
    }
  }

  function sampleServerTraffic() {
    sampleContainerNetwork();
    sampleRelayTraffic();
  }

  sampleServerTraffic();
  setInterval(sampleServerTraffic, NETWORK_SAMPLE_INTERVAL_MS).unref?.();

  return {
    trafficStats,
    recordTraffic,
    relayLastUpdatedAt: () => relayLastUpdatedAt,
  };
}
