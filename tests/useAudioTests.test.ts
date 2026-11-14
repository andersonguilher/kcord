// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAudioTests } from "../src/hooks/useAudioTests.ts";

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  tracks = [new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
}

const contexts: FakeAudioContext[] = [];
let waveform = 128;

class FakeAudioContext {
  state = "running";
  currentTime = 0;
  closed = false;
  analyser = {
    fftSize: 0,
    getByteTimeDomainData: (samples: Uint8Array) => samples.fill(waveform),
  };
  inputGain = {
    gain: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(() => ({ connect: vi.fn() })),
  };
  constructor() {
    contexts.push(this);
  }
  createAnalyser() {
    return this.analyser;
  }
  createGain() {
    return this.inputGain;
  }
  createMediaStreamSource() {
    return { connect: vi.fn() };
  }
  createMediaStreamDestination() {
    return { stream: new FakeStream() };
  }
  createOscillator() {
    return {
      type: "",
      frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: () => ({ connect: vi.fn() }),
      start: vi.fn(),
      stop: vi.fn(),
    };
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

let micStream: FakeStream;
let getUserMedia: ReturnType<typeof vi.fn>;
let setAudioSettingsError: ReturnType<typeof vi.fn>;
let refreshAudioDevices: ReturnType<typeof vi.fn>;
let sinkIds: string[];
let audioPlayFails: boolean;

function mount(overrides: Partial<Parameters<typeof useAudioTests>[0]> = {}) {
  return renderHook(() =>
    useAudioTests({
      inputDeviceId: "mic-1",
      outputDeviceId: "out-1",
      inputVolume: 50,
      outputVolume: 40,
      echoCancellation: false,
      noiseSuppression: true,
      refreshAudioDevices,
      setAudioSettingsError,
      ...overrides,
    }),
  );
}

beforeEach(() => {
  contexts.length = 0;
  waveform = 128;
  micStream = new FakeStream();
  getUserMedia = vi.fn(() => Promise.resolve(micStream));
  setAudioSettingsError = vi.fn();
  refreshAudioDevices = vi.fn(() => Promise.resolve());
  sinkIds = [];
  audioPlayFails = false;
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("navigator", { ...globalThis.navigator, mediaDevices: { getUserMedia } });
  vi.stubGlobal("requestAnimationFrame", () => 7);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal(
    "Audio",
    class {
      volume = 1;
      srcObject: unknown;
      setSinkId(id: string) {
        sinkIds.push(id);
        return Promise.resolve();
      }
      play() {
        return audioPlayFails ? Promise.reject(new Error("blocked")) : Promise.resolve();
      }
      pause() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("microphone test", () => {
  it("starts monitoring with the selected device and processing options", async () => {
    const { result } = mount();
    await act(async () => {
      await result.current.toggleMicrophoneTest();
    });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { deviceId: { exact: "mic-1" }, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    expect(result.current.testingMicrophone).toBe(true);
    expect(result.current.microphoneTestStream).not.toBeNull();
    expect(result.current.microphoneTestStreamRef.current).toBe(micStream);
    expect(contexts[0].inputGain.gain.value).toBe(0.5);
    expect(refreshAudioDevices).toHaveBeenCalled();
    expect(setAudioSettingsError).toHaveBeenCalledWith("");
  });

  it("measures the input level and scales it to 0-100", async () => {
    waveform = 128 + 64;
    const { result } = mount();
    await act(async () => {
      await result.current.toggleMicrophoneTest();
    });
    // rms = 0.5, so round(0.5 * 320) is capped at 100
    expect(result.current.microphoneLevel).toBe(100);

    await act(async () => {
      await result.current.toggleMicrophoneTest();
    });
    waveform = 128 + 8;
    await act(async () => {
      await result.current.toggleMicrophoneTest();
    });
    // rms = 8 / 128 = 0.0625, so round(0.0625 * 320) = 20
    expect(result.current.microphoneLevel).toBe(20);
  });

  it("stops everything when toggled off", async () => {
    const { result } = mount();
    await act(async () => {
      await result.current.toggleMicrophoneTest();
    });
    await act(async () => {
      await result.current.toggleMicrophoneTest();
    });
    expect(result.current.testingMicrophone).toBe(false);
    expect(result.current.microphoneTestStream).toBeNull();
    expect(result.current.microphoneLevel).toBe(0);
    expect(micStream.tracks[0].stopped).toBe(true);
    expect(contexts[0].closed).toBe(true);
    expect(result.current.microphoneTestStreamRef.current).toBeNull();
  });

  it("stops when the component unmounts", async () => {
    const { result, unmount } = mount();
    await act(async () => {
      await result.current.toggleMicrophoneTest();
    });
    unmount();
    expect(micStream.tracks[0].stopped).toBe(true);
    expect(contexts[0].closed).toBe(true);
  });

  it("reports a failure and does not stay in test mode", async () => {
    getUserMedia.mockRejectedValueOnce(new Error("denied"));
    const { result } = mount();
    await act(async () => {
      await result.current.toggleMicrophoneTest();
    });
    expect(result.current.testingMicrophone).toBe(false);
    expect(setAudioSettingsError).toHaveBeenLastCalledWith("Não foi possível monitorar o microfone na saída selecionada.");
  });
});

describe("output test", () => {
  it("plays through the selected output device at the chosen volume", async () => {
    vi.useFakeTimers();
    const { result } = mount();
    let finished: Promise<void> = Promise.resolve();
    await act(async () => {
      finished = result.current.testOutput();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.testingOutput).toBe(true);
    expect(sinkIds).toEqual(["out-1"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
      await finished;
    });
    expect(result.current.testingOutput).toBe(false);
    expect(setAudioSettingsError).toHaveBeenCalledWith("");
    expect(contexts[0].closed).toBe(true);
  });

  it("reports playback failures and always clears the busy flag", async () => {
    audioPlayFails = true;
    const { result } = mount();
    await act(async () => {
      await result.current.testOutput();
    });
    expect(result.current.testingOutput).toBe(false);
    expect(setAudioSettingsError).toHaveBeenLastCalledWith("Não foi possível reproduzir o teste no dispositivo selecionado.");
  });
});
