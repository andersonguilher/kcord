// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAudioPreferences } from "../src/hooks/useAudioPreferences.ts";

function device(kind: MediaDeviceKind, deviceId: string): MediaDeviceInfo {
  return { kind, deviceId, label: deviceId, groupId: "", toJSON: () => ({}) } as MediaDeviceInfo;
}

let devices: MediaDeviceInfo[];
let listeners: Map<string, () => void>;
let enumerateDevices: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  devices = [
    device("audioinput", "mic-1"),
    device("audioinput", "mic-2"),
    device("audiooutput", "out-1"),
    device("audiooutput", "out-2"),
    device("videoinput", "cam-1"),
  ];
  listeners = new Map();
  enumerateDevices = vi.fn(() => Promise.resolve(devices));
  vi.stubGlobal("navigator", {
    ...globalThis.navigator,
    mediaDevices: {
      enumerateDevices,
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useAudioPreferences", () => {
  it("starts from sensible defaults", () => {
    const { result } = renderHook(() => useAudioPreferences());
    expect(result.current).toMatchObject({
      inputDeviceId: "",
      outputDeviceId: "",
      inputVolume: 100,
      outputVolume: 100,
      inputSensitivity: 55,
      noiseSuppression: true,
      echoCancellation: true,
      voiceLeveling: true,
    });
    expect(result.current.audioInputs).toEqual([]);
  });

  it("restores stored values, treating only the literal string false as off", () => {
    localStorage.setItem("kafcord:audio-input", "mic-2");
    localStorage.setItem("kafcord:input-volume", "40");
    localStorage.setItem("kafcord:input-sensitivity", "70");
    localStorage.setItem("kafcord:noise-suppression", "false");
    localStorage.setItem("kafcord:echo-cancellation", "yes");
    localStorage.setItem("kafcord:voice-leveling", "false");
    const { result } = renderHook(() => useAudioPreferences());
    expect(result.current).toMatchObject({
      inputDeviceId: "mic-2",
      inputVolume: 40,
      inputSensitivity: 70,
      noiseSuppression: false,
      echoCancellation: true,
      voiceLeveling: false,
    });
  });

  it("saves every change to localStorage", () => {
    const { result } = renderHook(() => useAudioPreferences());
    act(() => {
      result.current.setInputDeviceId("mic-1");
      result.current.setOutputDeviceId("out-2");
      result.current.setInputVolume(80);
      result.current.setOutputVolume(65);
      result.current.setInputSensitivity(30);
      result.current.setNoiseSuppression(false);
      result.current.setEchoCancellation(false);
      result.current.setVoiceLeveling(false);
    });
    expect(Object.fromEntries(["audio-input", "audio-output", "input-volume", "output-volume", "input-sensitivity", "noise-suppression", "echo-cancellation", "voice-leveling"]
      .map((key) => [key, localStorage.getItem(`kafcord:${key}`)]))).toEqual({
      "audio-input": "mic-1",
      "audio-output": "out-2",
      "input-volume": "80",
      "output-volume": "65",
      "input-sensitivity": "30",
      "noise-suppression": "false",
      "echo-cancellation": "false",
      "voice-leveling": "false",
    });
  });

  it("splits inputs and outputs and falls back to the first device when the saved one is gone", async () => {
    localStorage.setItem("kafcord:audio-input", "unplugged-mic");
    localStorage.setItem("kafcord:audio-output", "out-2");
    const { result } = renderHook(() => useAudioPreferences());
    await act(async () => {
      await result.current.refreshAudioDevices();
    });
    expect(result.current.audioInputs.map((entry) => entry.deviceId)).toEqual(["mic-1", "mic-2"]);
    expect(result.current.audioOutputs.map((entry) => entry.deviceId)).toEqual(["out-1", "out-2"]);
    expect(result.current.inputDeviceId).toBe("mic-1");
    expect(result.current.outputDeviceId).toBe("out-2");
  });

  it("clears the selection when no devices remain", async () => {
    localStorage.setItem("kafcord:audio-input", "mic-1");
    devices = [];
    const { result } = renderHook(() => useAudioPreferences());
    await act(async () => {
      await result.current.refreshAudioDevices();
    });
    expect(result.current.inputDeviceId).toBe("");
    expect(result.current.outputDeviceId).toBe("");
  });

  it("refreshes when devices change and stops listening on unmount", async () => {
    const { result, unmount } = renderHook(() => useAudioPreferences());
    expect(listeners.has("devicechange")).toBe(true);
    listeners.get("devicechange")?.();
    await waitFor(() => expect(result.current.audioInputs).toHaveLength(2));
    unmount();
    expect(listeners.has("devicechange")).toBe(false);
  });
});
