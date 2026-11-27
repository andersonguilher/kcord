import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

type Environment = { osRelease: string; chrome: string; gpu: string };
type Saved = { screen: "wgc" | "legacy"; environment: Environment | null };
const { captureEnvironment, parseCaptureMode, serializeCaptureMode, captureEnvironmentChanged } = createRequire(import.meta.url)("../electron/capture-mode.cjs") as {
  captureEnvironment: (input: { osRelease: string; chrome: string; gpuDevices: { vendorId?: number; deviceId?: number; driverVersion?: string; active?: boolean }[] }) => Environment;
  parseCaptureMode: (text: string) => Saved;
  serializeCaptureMode: (screen: "wgc" | "legacy", environment: Environment) => string;
  captureEnvironmentChanged: (saved: Saved, current: Environment) => boolean;
};

const nvidia = { vendorId: 0x10de, deviceId: 0x2684, driverVersion: "32.0.15.6094", active: true };
const intel = { vendorId: 0x8086, deviceId: 0xa780, driverVersion: "31.0.101.5186", active: false };
const base = captureEnvironment({ osRelease: "10.0.26100", chrome: "151.0.7000.10", gpuDevices: [nvidia, intel] });

describe("capture mode file", () => {
  it("round-trips the mode with its environment", () => {
    expect(parseCaptureMode(serializeCaptureMode("legacy", base))).toEqual({ screen: "legacy", environment: base });
  });

  it("reads a file from before the environment was saved, and anything broken as the normal mode", () => {
    expect(parseCaptureMode(JSON.stringify({ screen: "legacy" }))).toEqual({ screen: "legacy", environment: null });
    expect(parseCaptureMode("{oops")).toEqual({ screen: "wgc", environment: null });
    expect(parseCaptureMode(JSON.stringify({ screen: "dxgi", environment: { osRelease: 1 } }))).toEqual({ screen: "wgc", environment: null });
  });
});

describe("captureEnvironmentChanged", () => {
  const legacy: Saved = { screen: "legacy", environment: base };

  it("stays quiet while nothing that decides WGC changed", () => {
    // Which GPU is active and the order they are listed in flip on hybrid laptops.
    const same = captureEnvironment({ osRelease: "10.0.26100", chrome: "151.0.7000.10", gpuDevices: [{ ...intel, active: true }, { ...nvidia, active: false }] });
    expect(captureEnvironmentChanged(legacy, same)).toBe(false);
  });

  it("notices a Windows build, graphics driver or Chromium update", () => {
    expect(captureEnvironmentChanged(legacy, { ...base, osRelease: "10.0.26200" })).toBe(true);
    expect(captureEnvironmentChanged(legacy, { ...base, chrome: "152.0.7100.4" })).toBe(true);
    const newDriver = captureEnvironment({ osRelease: "10.0.26100", chrome: "151.0.7000.10", gpuDevices: [{ ...nvidia, driverVersion: "32.0.15.7000" }, intel] });
    expect(captureEnvironmentChanged(legacy, newDriver)).toBe(true);
  });

  it("never flags the normal mode or a compatible mode with no saved environment", () => {
    expect(captureEnvironmentChanged({ screen: "wgc", environment: base }, { ...base, osRelease: "x" })).toBe(false);
    expect(captureEnvironmentChanged({ screen: "legacy", environment: null }, base)).toBe(false);
  });
});
