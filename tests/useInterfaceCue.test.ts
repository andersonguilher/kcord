// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInterfaceCue } from "../src/hooks/useInterfaceCue.ts";

type FakeAudio = {
  source: string;
  volume: number;
  preload: string;
  sinkId?: string;
  paused: boolean;
  listeners: Map<string, () => void>;
  setSinkId?: (id: string) => Promise<void>;
};

let instances: FakeAudio[];
let sinkSupported: boolean;
let sinkFails: boolean;
let playFails: boolean;

beforeEach(() => {
  instances = [];
  sinkSupported = true;
  sinkFails = false;
  playFails = false;
  vi.stubGlobal(
    "Audio",
    class {
      source: string;
      volume = 1;
      preload = "";
      sinkId?: string;
      paused = false;
      listeners = new Map<string, () => void>();
      setSinkId?: (id: string) => Promise<void>;
      constructor(source: string) {
        this.source = source;
        if (sinkSupported) {
          this.setSinkId = (id: string) => {
            if (sinkFails) return Promise.reject(new Error("sink"));
            this.sinkId = id;
            return Promise.resolve();
          };
        }
        instances.push(this as unknown as FakeAudio);
      }
      addEventListener(type: string, listener: () => void) {
        this.listeners.set(type, listener);
      }
      pause() {
        this.paused = true;
      }
      play() {
        return playFails ? Promise.reject(new Error("blocked")) : Promise.resolve();
      }
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useInterfaceCue", () => {
  it("plays on the selected output device at the output volume", async () => {
    const { result } = renderHook(() => useInterfaceCue("out-2", 40));
    await act(async () => {
      await result.current.playInterfaceCue("/join.wav");
    });
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({ source: "/join.wav", volume: 0.4, preload: "auto", sinkId: "out-2" });
  });

  it("skips the sink when no device is chosen or the browser cannot route output", async () => {
    const { result, rerender } = renderHook(({ device }) => useInterfaceCue(device, 100), { initialProps: { device: "" } });
    await act(async () => {
      await result.current.playInterfaceCue("/a.wav");
    });
    expect(instances[0].sinkId).toBeUndefined();

    sinkSupported = false;
    rerender({ device: "out-1" });
    await act(async () => {
      await result.current.playInterfaceCue("/b.wav");
    });
    expect(instances[1].sinkId).toBeUndefined();
  });

  it("pauses the previous cue when a new one starts", async () => {
    const { result } = renderHook(() => useInterfaceCue("", 100));
    await act(async () => {
      await result.current.playInterfaceCue("/one.wav");
    });
    await act(async () => {
      await result.current.playInterfaceCue("/two.wav");
    });
    expect(instances[0].paused).toBe(true);
    expect(instances[1].paused).toBe(false);
  });

  it("never throws when routing or playback is refused", async () => {
    sinkFails = true;
    playFails = true;
    const { result } = renderHook(() => useInterfaceCue("out-1", 100));
    await expect(
      act(async () => {
        await result.current.playInterfaceCue("/x.wav");
      }),
    ).resolves.not.toThrow();
  });

  it("pauses the current cue when unmounted", async () => {
    const { result, unmount } = renderHook(() => useInterfaceCue("", 100));
    await act(async () => {
      await result.current.playInterfaceCue("/x.wav");
    });
    unmount();
    expect(instances[0].paused).toBe(true);
  });

  it("uses the latest volume after it changes", async () => {
    const { result, rerender } = renderHook(({ volume }) => useInterfaceCue("", volume), { initialProps: { volume: 100 } });
    rerender({ volume: 25 });
    await act(async () => {
      await result.current.playInterfaceCue("/x.wav");
    });
    expect(instances[0].volume).toBe(0.25);
  });
});
