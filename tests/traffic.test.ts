import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppStateStore } from "../server/app-state.ts";
import { createTrafficTracker, emptyTrafficDay } from "../server/traffic.ts";

let directory: string;
let state: AppStateStore;

/** Never read the real network counters of the machine running the tests. */
const isolated = () => ({ containerNetworkPath: join(directory, "no-such-interface") });

const databaseFile = () => join(directory, "state.sqlite");

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "kcord-traffic-"));
  state = new AppStateStore(databaseFile());
  vi.useFakeTimers();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  state.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("traffic tracker", () => {
  it("accumulates counters and unique users for today", () => {
    const { trafficStats, recordTraffic } = createTrafficTracker(state, directory, isolated());
    recordTraffic({ publicMessages: 2 }, "user-1");
    recordTraffic({ publicMessages: 1, voiceJoins: 1 }, "user-1");
    recordTraffic({ sessions: 1 }, "user-2");
    const today = trafficStats.days.at(-1);
    expect(today?.publicMessages).toBe(3);
    expect(today?.voiceJoins).toBe(1);
    expect(today?.uniqueUserIds).toEqual(["user-1", "user-2"]);
  });

  it("ignores non-finite values", () => {
    const { trafficStats, recordTraffic } = createTrafficTracker(state, directory, isolated());
    recordTraffic({ httpRequests: Number.NaN, bytesIn: Number.POSITIVE_INFINITY, bytesOut: 5 });
    const today = trafficStats.days.at(-1);
    expect(today?.httpRequests).toBe(0);
    expect(today?.bytesIn).toBe(0);
    expect(today?.bytesOut).toBe(5);
  });

  it("persists after a short delay and reloads, from a reopened database, without local guest ids", () => {
    const first = createTrafficTracker(state, directory, isolated());
    first.recordTraffic({ privateMessages: 4 }, "discord-user");
    first.recordTraffic({ privateMessages: 1 }, "local:guest");
    expect(state.has("traffic-stats")).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(state.get<{ version: number }>("traffic-stats")?.version).toBe(2);

    state.close();
    state = new AppStateStore(databaseFile());
    const second = createTrafficTracker(state, directory, isolated());
    const today = second.trafficStats.days.at(-1);
    expect(today?.privateMessages).toBe(5);
    expect(today?.uniqueUserIds).toEqual(["discord-user"]);
  });

  it("imports the statistics file of an older release on the first start, then prefers the database", () => {
    const day = { ...emptyTrafficDay("2026-11-01"), publicMessages: 7, uniqueUserIds: ["u1"] };
    writeFileSync(join(directory, "traffic-stats.json"), JSON.stringify({ version: 2, startedAt: "2026-10-30T00:00:00Z", days: [day] }));
    const first = createTrafficTracker(state, directory, isolated());
    expect(first.trafficStats.startedAt).toBe("2026-10-30T00:00:00Z");
    expect(first.trafficStats.days[0]).toMatchObject({ date: "2026-11-01", publicMessages: 7 });
    expect(readFileSync(join(directory, "traffic-stats.json"), "utf8")).toContain("publicMessages");

    writeFileSync(join(directory, "traffic-stats.json"), JSON.stringify({ version: 2, startedAt: "1999-01-01T00:00:00Z", days: [] }));
    const second = createTrafficTracker(state, directory, isolated());
    expect(second.trafficStats.startedAt).toBe("2026-10-30T00:00:00Z");
  });

  it("starts a new series when the stored file is invalid", () => {
    writeFileSync(join(directory, "traffic-stats.json"), "{not json");
    const { trafficStats } = createTrafficTracker(state, directory, isolated());
    expect(trafficStats.days).toEqual([]);
  });

  it("reads relay counters and counts only the growth after the first baseline", () => {
    const relayPath = join(directory, "relay-traffic.json");
    writeFileSync(relayPath, JSON.stringify({ bootId: "boot-a", rxBytes: 1000, txBytes: 2000, updatedAt: "2026-11-14T00:00:00Z" }));
    const { trafficStats, relayLastUpdatedAt } = createTrafficTracker(state, directory, isolated());
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
    const { trafficStats } = createTrafficTracker(state, directory, { containerNetworkPath: interfaceDirectory });
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
    const { trafficStats } = createTrafficTracker(state, directory, { containerNetworkPath: interfaceDirectory });
    expect(trafficStats.days).toEqual([]);
  });

  it("creates empty days with zeroed counters", () => {
    const day = emptyTrafficDay("2026-01-01");
    expect(day.date).toBe("2026-01-01");
    expect(day.uniqueUserIds).toEqual([]);
    expect(day.relayBytesOut).toBe(0);
  });
});
