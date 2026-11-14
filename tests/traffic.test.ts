import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrafficTracker, emptyTrafficDay } from "../server/traffic.ts";

let directory: string;

/** Never read the real network counters of the machine running the tests. */
const isolated = () => ({ containerNetworkPath: join(directory, "no-such-interface") });

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "kcord-traffic-"));
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});

describe("traffic tracker", () => {
  it("accumulates counters and unique users for today", () => {
    const { trafficStats, recordTraffic } = createTrafficTracker(directory, isolated());
    recordTraffic({ publicMessages: 2 }, "user-1");
    recordTraffic({ publicMessages: 1, voiceJoins: 1 }, "user-1");
    recordTraffic({ sessions: 1 }, "user-2");
    const today = trafficStats.days.at(-1);
    expect(today?.publicMessages).toBe(3);
    expect(today?.voiceJoins).toBe(1);
    expect(today?.uniqueUserIds).toEqual(["user-1", "user-2"]);
  });

  it("ignores non-finite values", () => {
    const { trafficStats, recordTraffic } = createTrafficTracker(directory, isolated());
    recordTraffic({ httpRequests: Number.NaN, bytesIn: Number.POSITIVE_INFINITY, bytesOut: 5 });
    const today = trafficStats.days.at(-1);
    expect(today?.httpRequests).toBe(0);
    expect(today?.bytesIn).toBe(0);
    expect(today?.bytesOut).toBe(5);
  });

  it("persists after a short delay and reloads without local guest ids", () => {
    const first = createTrafficTracker(directory, isolated());
    first.recordTraffic({ privateMessages: 4 }, "discord-user");
    first.recordTraffic({ privateMessages: 1 }, "local:guest");
    vi.advanceTimersByTime(1000);
    const stored = JSON.parse(readFileSync(join(directory, "traffic-stats.json"), "utf8"));
    expect(stored.version).toBe(2);

    const second = createTrafficTracker(directory, isolated());
    const today = second.trafficStats.days.at(-1);
    expect(today?.privateMessages).toBe(5);
    expect(today?.uniqueUserIds).toEqual(["discord-user"]);
  });

  it("starts a new series when the stored file is invalid", () => {
    writeFileSync(join(directory, "traffic-stats.json"), "{not json");
    const { trafficStats } = createTrafficTracker(directory, isolated());
    expect(trafficStats.days).toEqual([]);
  });

  it("reads relay counters and counts only the growth after the first baseline", () => {
    const relayPath = join(directory, "relay-traffic.json");
    writeFileSync(relayPath, JSON.stringify({ bootId: "boot-a", rxBytes: 1000, txBytes: 2000, updatedAt: "2026-11-14T00:00:00Z" }));
    const { trafficStats, relayLastUpdatedAt } = createTrafficTracker(directory, isolated());
    expect(relayLastUpdatedAt()).toBe("2026-11-14T00:00:00Z");
    expect(trafficStats.relayCounter).toEqual({ bootId: "boot-a", rxBytes: 1000, txBytes: 2000 });
    expect(trafficStats.days.at(-1)?.relayBytesIn ?? 0).toBe(0);

    writeFileSync(relayPath, JSON.stringify({ bootId: "boot-a", rxBytes: 1500, txBytes: 2600 }));
    vi.advanceTimersByTime(60_000);
    const today = trafficStats.days.at(-1);
    expect(today?.relayBytesIn).toBe(500);
    expect(today?.relayBytesOut).toBe(600);
  });

  it("samples the container network: the first reading counts since start, then only the growth", () => {
    const interfaceDirectory = join(directory, "net");
    mkdirSync(interfaceDirectory);
    const writeCounters = (rx: number, tx: number) => {
      writeFileSync(join(interfaceDirectory, "rx_bytes"), `${rx}
`);
      writeFileSync(join(interfaceDirectory, "tx_bytes"), `${tx}
`);
    };
    writeCounters(1000, 400);
    const { trafficStats } = createTrafficTracker(directory, { containerNetworkPath: interfaceDirectory });
    expect(trafficStats.days.at(-1)).toMatchObject({ networkBytesIn: 1000, networkBytesOut: 400 });
    expect(trafficStats.networkSince).toBeTypeOf("string");

    writeCounters(1600, 900);
    vi.advanceTimersByTime(60_000);
    expect(trafficStats.days.at(-1)).toMatchObject({ networkBytesIn: 1600, networkBytesOut: 900 });

    // The container restarted: counters went back to a small number, so everything since then is new.
    writeCounters(50, 20);
    vi.advanceTimersByTime(60_000);
    expect(trafficStats.days.at(-1)).toMatchObject({ networkBytesIn: 1650, networkBytesOut: 920 });
  });

  it("ignores unreadable network counters", () => {
    const interfaceDirectory = join(directory, "net");
    mkdirSync(interfaceDirectory);
    writeFileSync(join(interfaceDirectory, "rx_bytes"), "not a number");
    writeFileSync(join(interfaceDirectory, "tx_bytes"), "5");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { trafficStats } = createTrafficTracker(directory, { containerNetworkPath: interfaceDirectory });
    expect(trafficStats.days).toEqual([]);
  });

  it("creates empty days with zeroed counters", () => {
    const day = emptyTrafficDay("2026-01-01");
    expect(day.date).toBe("2026-01-01");
    expect(day.uniqueUserIds).toEqual([]);
    expect(day.relayBytesOut).toBe(0);
  });
});
