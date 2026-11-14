// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMicrophone, type MicrophoneOptions } from "../src/hooks/useMicrophone.ts";

const appleMobile = vi.hoisted(() => ({ value: false }));
vi.mock("../src/lib/device.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/device.ts")>()),
  isAppleMobile: () => appleMobile.value,
}));

class FakeTrack {
  enabled = true;
  readyState: "live" | "ended" = "live";
  muted = false;
  kind = "audio";
  id = `track-${Math.random().toString(36).slice(2)}`;
  stop() {
    this.readyState = "ended";
  }
}

class FakeStream {
  tracks = [new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state = "running";
  closed = false;
  resumed = 0;
  gain = { gain: { value: -1 } };
  analyser = { fftSize: 0, getByteTimeDomainData: (samples: Uint8Array) => samples.fill(waveform) };
  destinationStream = new FakeStream();
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createMediaStreamSource() {
    const source = { connect: vi.fn(() => ({ connect: vi.fn() })) };
    return source;
  }
  createGain() {
    return this.gain;
  }
  createAnalyser() {
    return this.analyser;
  }
  createMediaStreamDestination() {
    return { stream: this.destinationStream };
  }
  resume() {
    this.resumed += 1;
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

let waveform = 128;
let captures: FakeStream[];
let getUserMedia: ReturnType<typeof vi.fn>;
let frameCallbacks: Array<(time: number) => void>;
let setInputDeviceId: ReturnType<typeof vi.fn>;
let setAudioSettingsError: ReturnType<typeof vi.fn>;
let peers: Map<string, RTCPeerConnection>;
let voiceChannelRef: { current: string | null };

function baseOptions(overrides: Partial<MicrophoneOptions> = {}): MicrophoneOptions {
  return {
    inputDeviceId: "mic-1",
    setInputDeviceId,
    inputVolume: 50,
    inputSensitivity: 50,
    echoCancellation: false,
    noiseSuppression: true,
    micEnabled: true,
    inputMode: "voice",
    pttPressed: false,
    voiceChannel: null,
    afkChannelId: "afk",
    serverMuted: false,
    serverDeafened: false,
    voiceChannelRef,
    peersRef: { current: peers },
    setAudioSettingsError,
    ...overrides,
  };
}

function mount(overrides: Partial<MicrophoneOptions> = {}) {
  return renderHook((props: MicrophoneOptions) => useMicrophone(props), { initialProps: baseOptions(overrides) });
}

/** Runs the next animation frame, as the browser would, at the given timestamp. */
function frame(time: number) {
  const callbacks = frameCallbacks.splice(0);
  act(() => callbacks.forEach((callback) => callback(time)));
}

const lastContext = () => FakeAudioContext.instances.at(-1) as FakeAudioContext;
const outgoingTrack = (result: { current: ReturnType<typeof useMicrophone> }) => result.current.localAudioRef.current?.getAudioTracks()[0] as unknown as FakeTrack;

beforeEach(() => {
  waveform = 128;
  appleMobile.value = false;
  FakeAudioContext.instances = [];
  captures = [];
  frameCallbacks = [];
  peers = new Map();
  voiceChannelRef = { current: null };
  setInputDeviceId = vi.fn();
  setAudioSettingsError = vi.fn();
  getUserMedia = vi.fn(() => {
    const stream = new FakeStream();
    captures.push(stream);
    return Promise.resolve(stream);
  });
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("navigator", { ...globalThis.navigator, mediaDevices: { getUserMedia } });
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => frameCallbacks.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("starting and stopping the microphone", () => {
  it("captures the chosen device with the processing options and applies the input gain", async () => {
    const { result } = mount();
    await act(async () => result.current.startMicrophone("mic-2", true));
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { deviceId: { exact: "mic-2" }, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    expect(lastContext().gain.gain.value).toBe(0.5);
    expect(result.current.rawAudioRef.current).toBe(captures[0]);
    expect(result.current.localAudioRef.current).toBe(lastContext().destinationStream);
    expect(result.current.inputAudioContextRef.current).toBe(lastContext());
  });

  it("starts the outgoing track enabled or disabled as asked", async () => {
    const { result } = mount();
    await act(async () => result.current.startMicrophone("mic-1", false));
    expect(outgoingTrack(result).enabled).toBe(false);
    await act(async () => result.current.startMicrophone("mic-1", true));
    expect(outgoingTrack(result).enabled).toBe(true);
  });

  it("replaces a previous capture cleanly: stops its tracks and closes its audio context", async () => {
    const { result } = mount();
    await act(async () => result.current.startMicrophone("mic-1", true));
    const firstContext = lastContext();
    const firstRaw = captures[0];
    const firstOutgoing = result.current.localAudioRef.current as unknown as FakeStream;
    await act(async () => result.current.startMicrophone("mic-1", true));
    expect(firstContext.closed).toBe(true);
    expect(firstRaw.tracks[0].readyState).toBe("ended");
    expect(firstOutgoing.tracks[0].readyState).toBe("ended");
  });

  it("sends the raw microphone track directly on iPhones, where Web Audio distorts it", async () => {
    appleMobile.value = true;
    const { result } = mount();
    await act(async () => result.current.startMicrophone("mic-1", true));
    expect(result.current.localAudioRef.current).toBe(captures[0]);
  });

  it("resumes an audio context that starts suspended", async () => {
    vi.stubGlobal("AudioContext", class extends FakeAudioContext {
      state = "suspended";
    });
    const { result } = mount();
    await act(async () => result.current.startMicrophone("mic-1", true));
    expect(lastContext().resumed).toBe(1);
  });

  it("releasing stops the capture and forgets every node", async () => {
    const { result } = mount();
    await act(async () => result.current.startMicrophone("mic-1", true));
    const context = lastContext();
    const raw = captures[0];
    const outgoing = result.current.localAudioRef.current as unknown as FakeStream;
    act(() => result.current.releaseMicrophone());
    expect(raw.tracks[0].readyState).toBe("ended");
    expect(outgoing.tracks[0].readyState).toBe("ended");
    expect(context.closed).toBe(true);
    expect(result.current.localAudioRef.current).toBeNull();
    expect(result.current.rawAudioRef.current).toBeNull();
    expect(result.current.inputAudioContextRef.current).toBeNull();
    expect(() => act(() => result.current.releaseMicrophone())).not.toThrow();
  });

  it("follows the input volume while the call is running", async () => {
    const { result, rerender } = mount();
    await act(async () => result.current.startMicrophone("mic-1", true));
    rerender(baseOptions({ inputVolume: 120 }));
    expect(lastContext().gain.gain.value).toBe(1.2);
  });

  it("resumes a suspended input context only when it is not already running", async () => {
    const { result } = mount();
    act(() => result.current.resumeInputContext());
    await act(async () => result.current.startMicrophone("mic-1", true));
    act(() => result.current.resumeInputContext());
    expect(lastContext().resumed).toBe(0);
    lastContext().state = "suspended";
    act(() => result.current.resumeInputContext());
    expect(lastContext().resumed).toBe(1);
  });
});

describe("when the outgoing track is live", () => {
  /** Joins like the app does: the capture starts first, then the room is set. */
  async function trackWith(overrides: Partial<MicrophoneOptions>) {
    const rendered = mount({ ...overrides, voiceChannel: null });
    await act(async () => rendered.result.current.startMicrophone("mic-1", true));
    rendered.rerender(baseOptions({ voiceChannel: "cafe", ...overrides }));
    return outgoingTrack(rendered.result).enabled;
  }

  it.each([
    ["voice activity with the mic on", {}, true],
    ["the mic is switched off", { micEnabled: false }, false],
    ["the server muted the member", { serverMuted: true }, false],
    ["the server deafened the member", { serverDeafened: true }, false],
    ["in the AFK channel", { voiceChannel: "afk" }, false],
    ["push-to-talk and the key is not held", { inputMode: "ptt" as const }, false],
    ["push-to-talk and the key is held", { inputMode: "ptt" as const, pttPressed: true }, true],
  ])("%s", async (_label, overrides, expected) => {
    expect(await trackWith(overrides)).toBe(expected);
  });

  it("follows the push-to-talk key as it is pressed and released", async () => {
    const { result, rerender } = mount({ voiceChannel: "cafe", inputMode: "ptt" });
    await act(async () => result.current.startMicrophone("mic-1", false));
    rerender(baseOptions({ voiceChannel: "cafe", inputMode: "ptt", pttPressed: true }));
    expect(outgoingTrack(result).enabled).toBe(true);
    rerender(baseOptions({ voiceChannel: "cafe", inputMode: "ptt", pttPressed: false }));
    expect(outgoingTrack(result).enabled).toBe(false);
  });
});

describe("speech detection", () => {
  it("never reports speech outside a voice room", async () => {
    const { result } = mount({ voiceChannel: null });
    await act(async () => result.current.startMicrophone("mic-1", true));
    waveform = 255;
    frame(100);
    expect(result.current.voiceDetected).toBe(false);
  });

  it("detects speech above the threshold and releases 260 ms after it stops", async () => {
    const { result } = mount({ voiceChannel: "cafe" });
    await act(async () => result.current.startMicrophone("mic-1", true));
    waveform = 255;
    frame(1000);
    expect(result.current.voiceDetected).toBe(true);
    waveform = 128;
    frame(1200);
    expect(result.current.voiceDetected).toBe(true);
    frame(1300);
    expect(result.current.voiceDetected).toBe(false);
  });

  it("is more sensitive at a higher sensitivity setting", async () => {
    // rms 0.04 sits between the thresholds for sensitivity 0 (0.085) and 100 (0.013).
    const quiet = 128 + 5;
    const lowSensitivity = mount({ voiceChannel: "cafe", inputSensitivity: 0 });
    await act(async () => lowSensitivity.result.current.startMicrophone("mic-1", true));
    waveform = quiet;
    frame(1000);
    expect(lowSensitivity.result.current.voiceDetected).toBe(false);

    const highSensitivity = mount({ voiceChannel: "cafe", inputSensitivity: 100 });
    await act(async () => highSensitivity.result.current.startMicrophone("mic-1", true));
    frame(1000);
    expect(highSensitivity.result.current.voiceDetected).toBe(true);
  });

  it("resets when the member leaves the room", async () => {
    const { result, rerender } = mount({ voiceChannel: "cafe" });
    await act(async () => result.current.startMicrophone("mic-1", true));
    waveform = 255;
    frame(1000);
    expect(result.current.voiceDetected).toBe(true);
    rerender(baseOptions({ voiceChannel: null }));
    expect(result.current.voiceDetected).toBe(false);
  });
});

describe("switching device during a call", () => {
  function sender(track: FakeTrack | null = null) {
    return { track, replaceTrack: vi.fn(() => Promise.resolve()) };
  }

  it("only records the choice when no call is running", async () => {
    const { result } = mount();
    await act(async () => result.current.changeInputDevice("mic-2"));
    expect(setInputDeviceId).toHaveBeenCalledWith("mic-2");
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("opens the new microphone, swaps it into every peer and installs it", async () => {
    const { result } = mount({ voiceChannel: "cafe" });
    await act(async () => result.current.startMicrophone("mic-1", true));
    const oldTrack = outgoingTrack(result);
    const audioSender = sender(oldTrack);
    peers.set("p1", { getSenders: () => [audioSender] } as unknown as RTCPeerConnection);
    await act(async () => result.current.changeInputDevice("mic-2"));
    expect(getUserMedia).toHaveBeenLastCalledWith(expect.objectContaining({ audio: expect.objectContaining({ deviceId: { exact: "mic-2" } }) }));
    const newTrack = outgoingTrack(result);
    expect(newTrack).not.toBe(oldTrack);
    expect(audioSender.replaceTrack).toHaveBeenCalledWith(newTrack);
    expect(oldTrack.readyState).toBe("ended");
  });

  it("gives the new track the right enabled state for push-to-talk", async () => {
    const { result } = mount({ voiceChannel: "cafe", inputMode: "ptt", pttPressed: false });
    await act(async () => result.current.startMicrophone("mic-1", false));
    peers.set("p1", { getSenders: () => [sender(outgoingTrack(result))] } as unknown as RTCPeerConnection);
    await act(async () => result.current.changeInputDevice("mic-2"));
    expect(outgoingTrack(result).enabled).toBe(false);
  });

  it("goes back to the previous device and says so when the new one fails", async () => {
    const { result } = mount({ voiceChannel: "cafe" });
    await act(async () => result.current.startMicrophone("mic-1", true));
    const oldTrack = outgoingTrack(result);
    getUserMedia.mockRejectedValueOnce(new Error("busy"));
    await act(async () => result.current.changeInputDevice("mic-2"));
    expect(setInputDeviceId).toHaveBeenNthCalledWith(1, "mic-2");
    expect(setInputDeviceId).toHaveBeenNthCalledWith(2, "mic-1");
    expect(setAudioSettingsError).toHaveBeenCalledWith("Não foi possível trocar o microfone durante a chamada.");
    expect(outgoingTrack(result)).toBe(oldTrack);
    expect(oldTrack.readyState).toBe("live");
  });
});

describe("recovering the microphone", () => {
  it("does nothing outside a call or without a capture", async () => {
    const { result } = mount();
    expect(await result.current.recoverMicrophoneRef.current()).toBe(false);
    voiceChannelRef.current = "cafe";
    expect(await result.current.recoverMicrophoneRef.current()).toBe(false);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("leaves a healthy capture alone", async () => {
    voiceChannelRef.current = "cafe";
    const { result } = mount({ voiceChannel: "cafe" });
    await act(async () => result.current.startMicrophone("mic-1", true));
    let recovered = true;
    await act(async () => {
      recovered = await result.current.recoverMicrophoneRef.current();
    });
    expect(recovered).toBe(false);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("installs a fresh capture when the old one ended, and re-applies the transmit state", async () => {
    voiceChannelRef.current = "cafe";
    const { result } = mount({ voiceChannel: "cafe" });
    await act(async () => result.current.startMicrophone("mic-1", true));
    captures[0].tracks[0].readyState = "ended";
    let recovered = false;
    await act(async () => {
      recovered = await result.current.recoverMicrophoneRef.current();
    });
    expect(recovered).toBe(true);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(result.current.rawAudioRef.current).toBe(captures[1]);
    // The pipeline version changed, so the effect enabled the new track again (voice mode, mic on).
    expect(outgoingTrack(result).enabled).toBe(true);
  });

  it("waits a moment for a muted capture to come back by itself", async () => {
    vi.useFakeTimers();
    voiceChannelRef.current = "cafe";
    const { result } = mount({ voiceChannel: "cafe" });
    await act(async () => result.current.startMicrophone("mic-1", true));
    captures[0].tracks[0].muted = true;
    let recovered: boolean | undefined;
    const pending = result.current.recoverMicrophoneRef.current().then((value) => { recovered = value; });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(recovered).toBeUndefined();
    // The system hands the microphone back within the grace period.
    captures[0].tracks[0].muted = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
      await pending;
    });
    expect(recovered).toBe(false);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("replaces a capture that stays muted after the grace period", async () => {
    vi.useFakeTimers();
    voiceChannelRef.current = "cafe";
    const { result } = mount({ voiceChannel: "cafe" });
    await act(async () => result.current.startMicrophone("mic-1", true));
    captures[0].tracks[0].muted = true;
    let recovered: boolean | undefined;
    const pending = result.current.recoverMicrophoneRef.current().then((value) => { recovered = value; });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
      await pending;
    });
    expect(recovered).toBe(true);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });
});
