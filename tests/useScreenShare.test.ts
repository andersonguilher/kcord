// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScreenShare, type ScreenShareOptions } from "../src/hooks/useScreenShare.ts";

const mocks = vi.hoisted(() => ({
  appAudioApi: null as unknown,
  startAppAudio: vi.fn(),
  startCompatibleScreenCapture: vi.fn(),
  reportClientIssue: vi.fn(),
  desktopSystemInfo: vi.fn(),
  applyScreenEncoding: vi.fn(),
  screenCaptureSupported: { value: true },
}));

vi.mock("../src/appAudio.ts", () => ({
  appAudioBridge: () => mocks.appAudioApi,
  startAppAudio: mocks.startAppAudio,
}));
vi.mock("../src/compatibleScreenCapture.ts", () => ({ startCompatibleScreenCapture: mocks.startCompatibleScreenCapture }));
vi.mock("../src/lib/clientReports.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/clientReports.ts")>()),
  reportClientIssue: mocks.reportClientIssue,
  desktopSystemInfo: mocks.desktopSystemInfo,
}));
vi.mock("../src/lib/device.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/device.ts")>()),
  screenCaptureSupported: () => mocks.screenCaptureSupported.value,
}));
vi.mock("../src/lib/media.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/media.ts")>()),
  applyScreenEncoding: mocks.applyScreenEncoding,
}));

class FakeTrack {
  id = `s${Math.random().toString(36).slice(2)}`;
  kind: "audio" | "video";
  label = "Janela de teste";
  contentHint = "";
  stopped = false;
  listeners = new Map<string, () => void>();
  constructor(kind: "audio" | "video", private settings: { width?: number; height?: number } = { width: 1920, height: 1080 }) {
    this.kind = kind;
  }
  getSettings() {
    return this.settings;
  }
  stop() {
    this.stopped = true;
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener);
  }
}

class FakeStream {
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = [new FakeTrack("video")]) {
    this.tracks = tracks;
  }
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === "video");
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }
  addTrack(track: FakeTrack) {
    this.tracks.push(track);
  }
}

class FakePeer {
  added: Array<{ track: unknown; stream: unknown }> = [];
  removed: unknown[] = [];
  addTrack(track: unknown, stream: unknown) {
    this.added.push({ track, stream });
    return { track } as unknown as RTCRtpSender;
  }
  removeTrack(sender: unknown) {
    this.removed.push(sender);
  }
}

let socket: { emit: ReturnType<typeof vi.fn> };
let setNotice: ReturnType<typeof vi.fn>;
let makeOffer: ReturnType<typeof vi.fn>;
let createPeer: ReturnType<typeof vi.fn>;
let peers: Map<string, FakePeer>;
let screenSendersRef: { current: Map<string, never[]> };
let blocked: boolean;
let displayMedia: ReturnType<typeof vi.fn>;
let captures: FakeStream[];
let voiceChannelRef: { current: string | null };

function mount(overrides: Partial<ScreenShareOptions> = {}) {
  return renderHook((props: Partial<ScreenShareOptions>) => useScreenShare({
    socketRef: { current: socket as never },
    peersRef: { current: peers as never },
    screenSendersRef: screenSendersRef as never,
    voiceChannel: "cafe",
    voiceChannelRef,
    createPeer: createPeer as never,
    makeOffer: makeOffer as never,
    isBlockedInAfk: () => blocked,
    setNotice,
    ...props,
  }), { initialProps: overrides });
}

/** happy-dom has no window.confirm, so install one that answers as asked. */
function answerConfirmWith(answer: boolean) {
  const confirm = vi.fn(() => answer);
  (window as unknown as { confirm: typeof confirm }).confirm = confirm;
  return confirm;
}

function bridge(extra: Record<string, unknown> = {}) {
  (window as { kafcordDesktop?: unknown }).kafcordDesktop = {
    listShareSources: vi.fn(() => Promise.resolve([{ id: "window:1:0", name: "App" }])),
    selectShareSource: vi.fn(() => true),
    restoreShareSource: vi.fn(() => Promise.resolve(true)),
    cancelShareSelection: vi.fn(() => Promise.resolve()),
    captureMode: "wgc",
    ...extra,
  };
  return (window as unknown as { kafcordDesktop: Record<string, ReturnType<typeof vi.fn>> }).kafcordDesktop;
}

beforeEach(() => {
  mocks.appAudioApi = null;
  mocks.screenCaptureSupported.value = true;
  mocks.startAppAudio.mockReset();
  mocks.startCompatibleScreenCapture.mockReset();
  mocks.reportClientIssue.mockReset();
  mocks.desktopSystemInfo.mockReset().mockResolvedValue({ screenCaptureMode: "wgc" });
  mocks.applyScreenEncoding.mockReset().mockResolvedValue(undefined);
  localStorage.clear();
  blocked = false;
  captures = [];
  socket = { emit: vi.fn() };
  setNotice = vi.fn();
  makeOffer = vi.fn(() => Promise.resolve());
  peers = new Map();
  createPeer = vi.fn((peerId: string) => {
    const peer = peers.get(peerId) ?? new FakePeer();
    peers.set(peerId, peer);
    return peer;
  });
  screenSendersRef = { current: new Map() };
  voiceChannelRef = { current: "cafe" };
  displayMedia = vi.fn(() => {
    const stream = new FakeStream([new FakeTrack("video"), new FakeTrack("audio")]);
    captures.push(stream);
    return Promise.resolve(stream);
  });
  delete (window as { kafcordDesktop?: unknown }).kafcordDesktop;
  vi.stubGlobal("navigator", { ...globalThis.navigator, mediaDevices: { getDisplayMedia: displayMedia } });
  vi.stubGlobal("MediaStream", FakeStream);
  vi.spyOn(window, "focus").mockImplementation(() => undefined);
  // happy-dom only accepts a real MediaStream; the tests use fakes.
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
    configurable: true,
    get() {
      return (this as { _srcObject?: unknown })._srcObject ?? null;
    },
    set(value) {
      (this as { _srcObject?: unknown })._srcObject = value;
    },
  });
  vi.spyOn(HTMLVideoElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLVideoElement.prototype, "pause").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (window as { kafcordDesktop?: unknown }).kafcordDesktop;
  delete (window as { confirm?: unknown }).confirm;
});

describe("starting a share", () => {
  it("needs a voice room", async () => {
    const { result } = mount({ voiceChannel: null });
    await act(async () => result.current.startScreenShare());
    expect(setNotice).toHaveBeenCalledWith("Entre em uma sala de voz antes de compartilhar a tela.");
    expect(displayMedia).not.toHaveBeenCalled();
  });

  it("captures the screen in the browser at 1280x720 and publishes it to the room", async () => {
    const { result } = mount();
    await act(async () => result.current.startScreenShare());
    expect(displayMedia).toHaveBeenCalledTimes(1);
    expect(displayMedia.mock.calls[0][0]).toMatchObject({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
      audio: { suppressLocalAudioPlayback: false },
      selfBrowserSurface: "exclude",
    });
    expect(result.current.screenStream).toBe(captures[0]);
    expect(result.current.screenRef.current).toBe(captures[0]);
    expect(result.current.screenResolutionHeight).toBe(1080);
    expect(result.current.screenResolutionRef.current).toEqual({ width: 1920, height: 1080 });
    expect(result.current.screenLabel).toBe("Janela de teste");
    expect(window.focus).toHaveBeenCalled();
  });

  it("says whether the audio came along", async () => {
    const { result } = mount();
    await act(async () => result.current.startScreenShare());
    expect(setNotice).toHaveBeenLastCalledWith("Tela e áudio estão sendo compartilhados.");

    displayMedia.mockResolvedValueOnce(new FakeStream([new FakeTrack("video")]));
    const silent = mount();
    await act(async () => silent.result.current.startScreenShare());
    expect(setNotice).toHaveBeenLastCalledWith(expect.stringContaining("Tela compartilhada sem áudio."));
  });

  it("ending the capture from the browser stops the share", async () => {
    const { result } = mount();
    await act(async () => result.current.startScreenShare());
    act(() => captures[0].tracks[0].listeners.get("ended")?.());
    expect(result.current.screenStream).toBeNull();
    expect(socket.emit).toHaveBeenCalledWith("screen:stop");
  });

  it("does not report a cancelled picker as a failure", async () => {
    displayMedia.mockRejectedValueOnce(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }));
    const { result } = mount();
    await act(async () => result.current.startScreenShare());
    expect(mocks.reportClientIssue).not.toHaveBeenCalled();
    expect(setNotice).toHaveBeenCalledWith("O compartilhamento de tela foi cancelado.");
    expect(result.current.screenStream).toBeNull();
  });

  it("reports a real failure to the owner and shows its message", async () => {
    displayMedia.mockRejectedValueOnce(new Error("Could not start video source"));
    const { result } = mount();
    await act(async () => result.current.startScreenShare());
    expect(mocks.reportClientIssue).toHaveBeenCalledWith("screen-share", expect.any(Error), {});
    expect(setNotice).toHaveBeenCalledWith("Could not start video source");
  });

  it("retries without audio when Windows refuses the system audio loopback", async () => {
    const audioError = Object.assign(new DOMException("Could not start audio source", "NotReadableError"));
    displayMedia.mockRejectedValueOnce(audioError);
    displayMedia.mockImplementationOnce(() => Promise.resolve(new FakeStream([new FakeTrack("video")])));
    const { result } = mount();
    await act(async () => result.current.startScreenShare());
    expect(displayMedia).toHaveBeenCalledTimes(2);
    expect(displayMedia.mock.calls[1][0]).toMatchObject({ audio: false });
    expect(setNotice).toHaveBeenLastCalledWith(expect.stringContaining("sem áudio: o Windows não liberou o som do sistema"));
    expect(result.current.screenStream).not.toBeNull();
  });

  it("does not retry a video failure", async () => {
    displayMedia.mockRejectedValue(new DOMException("Could not start video source", "NotReadableError"));
    const { result } = mount();
    await act(async () => result.current.startScreenShare());
    expect(displayMedia).toHaveBeenCalledTimes(1);
    expect(result.current.screenStream).toBeNull();
  });
});

describe("sharing from the desktop app", () => {
  it("uses the quality and definition chosen in the picker", async () => {
    bridge();
    const { result } = mount();
    act(() => {
      result.current.setDesktopShareQuality("text");
      result.current.setDesktopShareDefinition("hd");
    });
    await act(async () => result.current.startScreenShare("window:1:0"));
    expect(displayMedia.mock.calls[0][0]).toMatchObject({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 5, max: 5 } },
    });
    expect(captures[0].tracks[0].contentHint).toBe("text");
  });

  it("asks for game quality by default: 60 fps and motion priority", async () => {
    bridge();
    const { result } = mount();
    await act(async () => result.current.startScreenShare("window:1:0"));
    expect(displayMedia.mock.calls[0][0]).toMatchObject({ video: { frameRate: { ideal: 60, max: 60 } } });
    expect(captures[0].tracks[0].contentHint).toBe("motion");
  });

  it("selects the source with system audio, restoring a minimised window first", async () => {
    const desktop = bridge();
    const { result } = mount();
    await act(async () => result.current.startScreenShare("window:1:0"));
    expect(desktop.restoreShareSource).toHaveBeenCalledWith("window:1:0");
    expect(desktop.selectShareSource).toHaveBeenCalledWith("window:1:0", true);
  });

  it("does not ask the system for audio when it is switched off in the picker", async () => {
    const desktop = bridge();
    const { result } = mount();
    act(() => result.current.setDesktopShareAudio(false));
    await act(async () => result.current.startScreenShare("window:1:0"));
    expect(desktop.selectShareSource).toHaveBeenCalledWith("window:1:0", false);
    expect(displayMedia.mock.calls[0][0]).toMatchObject({ audio: false });
  });

  it("fails clearly when the chosen source is gone", async () => {
    bridge({ selectShareSource: vi.fn(() => false) });
    const { result } = mount();
    await act(async () => result.current.startScreenShare("window:1:0"));
    expect(setNotice).toHaveBeenCalledWith("A fonte escolhida não está mais disponível.");
    expect(displayMedia).not.toHaveBeenCalled();
  });

  it("shares only the application's audio when the native helper is available", async () => {
    bridge();
    mocks.appAudioApi = { available: true };
    const appTrack = new FakeTrack("audio");
    const stop = vi.fn();
    mocks.startAppAudio.mockResolvedValue({ track: appTrack, stop });
    displayMedia.mockImplementationOnce(() => Promise.resolve(new FakeStream([new FakeTrack("video")])));
    const { result } = mount();
    await act(async () => result.current.startScreenShare("window:1:0"));
    expect(displayMedia.mock.calls[0][0]).toMatchObject({ audio: false });
    expect(result.current.screenRef.current?.getTracks()).toContain(appTrack);
    expect(setNotice).toHaveBeenLastCalledWith("Tela e som do aplicativo estão sendo compartilhados.");
    act(() => result.current.releaseScreenShare());
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("falls back to system audio and reports when the application's audio cannot be captured", async () => {
    bridge();
    mocks.appAudioApi = { available: true };
    mocks.startAppAudio.mockRejectedValue(new Error("0x40010004"));
    const { result } = mount();
    await act(async () => result.current.startScreenShare("window:1:0"));
    expect(mocks.reportClientIssue).toHaveBeenCalledWith("screen-share", expect.objectContaining({ message: expect.stringContaining("0x40010004") }), { sourceType: "window" });
    expect(displayMedia.mock.calls[0][0]).toMatchObject({ audio: { suppressLocalAudioPlayback: false } });
    expect(setNotice).toHaveBeenLastCalledWith(expect.stringContaining("o som só do aplicativo não pôde ser capturado: 0x40010004"));
  });

  it("uses the independent snapshot capture for a whole screen in compatible mode", async () => {
    bridge({ captureShareSnapshot: vi.fn() });
    mocks.desktopSystemInfo.mockResolvedValue({ screenCaptureMode: "legacy" });
    mocks.startCompatibleScreenCapture.mockResolvedValue(new FakeStream([new FakeTrack("video")]));
    const { result } = mount();
    await act(async () => result.current.startScreenShare("screen:0:0"));
    expect(mocks.startCompatibleScreenCapture).toHaveBeenCalledTimes(1);
    expect(mocks.startCompatibleScreenCapture.mock.calls[0].slice(1)).toEqual(["screen:0:0", 1280, 720, 10]);
    expect(displayMedia).not.toHaveBeenCalled();
    expect(setNotice).toHaveBeenLastCalledWith(expect.stringContaining("modo compatível a até 10 fps"));
  });

  it("offers compatible mode and remembers the room when Windows cannot start a screen capture", async () => {
    const desktop = bridge({ setScreenCaptureMode: vi.fn(() => Promise.resolve(true)) });
    displayMedia.mockRejectedValue(new DOMException("Could not start video source", "NotReadableError"));
    answerConfirmWith(true);
    const { result } = mount();
    await act(async () => result.current.startScreenShare("screen:0:0"));
    await act(async () => Promise.resolve());
    expect(desktop.setScreenCaptureMode).toHaveBeenCalledWith("legacy");
    expect(JSON.parse(localStorage.getItem("kafcord:update-voice-resume") ?? "null").channelId).toBe("cafe");
  });

  it("does not restart the app when the person declines compatible mode", async () => {
    const desktop = bridge({ setScreenCaptureMode: vi.fn(() => Promise.resolve(true)) });
    displayMedia.mockRejectedValue(new DOMException("Could not start video source", "NotReadableError"));
    answerConfirmWith(false);
    const { result } = mount();
    await act(async () => result.current.startScreenShare("screen:0:0"));
    await act(async () => Promise.resolve());
    expect(desktop.setScreenCaptureMode).not.toHaveBeenCalled();
  });
});

describe("toggleScreen", () => {
  it("is refused in the AFK channel, but can still stop a share", async () => {
    blocked = true;
    const { result } = mount();
    await act(async () => result.current.toggleScreen());
    expect(setNotice).toHaveBeenCalledWith("No canal AFK não é possível compartilhar a tela.");
    blocked = false;
    await act(async () => result.current.toggleScreen());
    blocked = true;
    setNotice.mockClear();
    await act(async () => result.current.toggleScreen());
    expect(result.current.screenStream).toBeNull();
    expect(setNotice).not.toHaveBeenCalled();
  });

  it("needs a voice room and a browser that can capture", async () => {
    const noRoom = mount({ voiceChannel: null });
    await act(async () => noRoom.result.current.toggleScreen());
    expect(setNotice).toHaveBeenCalledWith("Entre em uma sala de voz antes de compartilhar a tela.");
    mocks.screenCaptureSupported.value = false;
    const phone = mount();
    await act(async () => phone.result.current.toggleScreen());
    expect(setNotice).toHaveBeenLastCalledWith(expect.stringContaining("Este navegador não permite compartilhar a tela"));
    expect(displayMedia).not.toHaveBeenCalled();
  });

  it("starts straight away in the browser", async () => {
    const { result } = mount();
    await act(async () => result.current.toggleScreen());
    expect(displayMedia).toHaveBeenCalledTimes(1);
    expect(result.current.showDesktopShareDialog).toBe(false);
  });

  it("opens the source picker, on the windows tab, in the desktop app", async () => {
    const desktop = bridge();
    const { result } = mount();
    await act(async () => result.current.toggleScreen());
    expect(displayMedia).not.toHaveBeenCalled();
    expect(result.current.showDesktopShareDialog).toBe(true);
    expect(desktop.listShareSources).toHaveBeenCalledWith("window");
    expect(result.current.desktopShareSources).toEqual([{ id: "window:1:0", name: "App" }]);
  });

  it("goes straight to the system picker when the desktop app uses it", async () => {
    bridge({ captureMode: "system-picker" });
    const { result } = mount();
    await act(async () => result.current.toggleScreen());
    expect(displayMedia).toHaveBeenCalledTimes(1);
    expect(result.current.showDesktopShareDialog).toBe(false);
  });

  it("toggling during a share stops it", async () => {
    const { result } = mount();
    await act(async () => result.current.toggleScreen());
    await act(async () => result.current.toggleScreen());
    expect(result.current.screenStream).toBeNull();
    expect(captures[0].tracks.every((track) => track.stopped)).toBe(true);
  });
});

describe("stopping a share", () => {
  it("stops everything, tells the room, and removes the video from each viewer", async () => {
    const { result } = mount();
    await act(async () => result.current.startScreenShare());
    await act(async () => result.current.onViewerJoin({ viewerId: "v1" }));
    const senders = screenSendersRef.current.get("v1") as unknown as Array<{ sender: unknown }>;
    makeOffer.mockClear();
    act(() => result.current.stopSharing());
    expect(captures[0].tracks.every((track) => track.stopped)).toBe(true);
    expect(socket.emit).toHaveBeenCalledWith("screen:stop");
    expect(peers.get("v1")?.removed).toEqual(senders.map((binding) => binding.sender));
    expect(makeOffer).toHaveBeenCalledWith("v1");
    expect(screenSendersRef.current.size).toBe(0);
    expect(result.current.screenStream).toBeNull();
    expect(result.current.screenViewerCount).toBe(0);
    expect(result.current.screenLabel).toBe("Tela compartilhada");
    expect(result.current.screenResolutionHeight).toBeNull();
  });

  it("does nothing when nothing is being shared", () => {
    const { result } = mount();
    act(() => result.current.stopSharing());
    expect(socket.emit).not.toHaveBeenCalled();
  });
});

describe("viewers", () => {
  it("sends the screen to a viewer, announcing each track first, and applies the encoding", async () => {
    const { result } = mount();
    await act(async () => result.current.startScreenShare());
    await act(async () => result.current.onViewerJoin({ viewerId: "v1" }));
    const stream = captures[0];
    for (const track of stream.tracks) {
      expect(socket.emit).toHaveBeenCalledWith("media:track-meta", { target: "v1", trackId: track.id, kind: "screen" });
    }
    expect(peers.get("v1")?.added.map((entry) => entry.track)).toEqual(stream.tracks);
    expect(makeOffer).toHaveBeenCalledWith("v1");
    expect(mocks.applyScreenEncoding).toHaveBeenCalledTimes(stream.tracks.length);
  });

  it("ignores a viewer when nothing is being shared", async () => {
    const { result } = mount();
    await act(async () => result.current.onViewerJoin({ viewerId: "v1" }));
    expect(createPeer).not.toHaveBeenCalled();
  });

  it("tells the user when starting the stream for a viewer fails", async () => {
    const { result } = mount();
    await act(async () => result.current.startScreenShare());
    makeOffer.mockRejectedValueOnce(new Error("closed"));
    await act(async () => result.current.onViewerJoin({ viewerId: "v1" }));
    expect(setNotice).toHaveBeenLastCalledWith("Não foi possível iniciar a transmissão para esse participante.");
  });

  it("stops sending to a viewer who left, and ignores unknown ones", async () => {
    const { result } = mount();
    await act(async () => result.current.startScreenShare());
    await act(async () => result.current.onViewerJoin({ viewerId: "v1" }));
    makeOffer.mockClear();
    await act(async () => result.current.onViewerLeft({ viewerId: "v1" }));
    expect(peers.get("v1")?.removed).toHaveLength(captures[0].tracks.length);
    expect(screenSendersRef.current.has("v1")).toBe(false);
    expect(makeOffer).toHaveBeenCalledWith("v1");
    makeOffer.mockClear();
    await act(async () => result.current.onViewerLeft({ viewerId: "nobody" }));
    expect(makeOffer).not.toHaveBeenCalled();
  });

  it("keeps the viewer count between 0 and 9999 and ignores nonsense", () => {
    const { result } = mount();
    act(() => result.current.onViewerCount({ count: 3 }));
    expect(result.current.screenViewerCount).toBe(3);
    act(() => result.current.onViewerCount({ count: 123456 }));
    expect(result.current.screenViewerCount).toBe(9999);
    act(() => result.current.onViewerCount({ count: -5 }));
    expect(result.current.screenViewerCount).toBe(0);
    act(() => result.current.onViewerCount({ count: 7.9 }));
    expect(result.current.screenViewerCount).toBe(7);
    act(() => result.current.onViewerCount({ count: Number.NaN }));
    expect(result.current.screenViewerCount).toBe(0);
    act(() => result.current.onViewerCount({ count: 4 }));
    act(() => result.current.resetViewerCount());
    expect(result.current.screenViewerCount).toBe(0);
  });
});

describe("the thumbnail announced to the room", () => {
  let jpeg: string;

  beforeEach(() => {
    jpeg = "data:image/jpeg;base64,AAAA";
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => jpeg);
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 640 });
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => 360 });
  });

  it("is announced once, then refreshed only when the picture changes", async () => {
    const { result } = mount();
    await act(async () => {
      await result.current.startScreenShare();
      await vi.advanceTimersByTimeAsync(0);
    });
    const starts = () => socket.emit.mock.calls.filter(([event]) => event === "screen:start");
    const updates = () => socket.emit.mock.calls.filter(([event]) => event === "screen:thumbnail");
    expect(starts()).toHaveLength(1);
    expect(starts()[0][1]).toMatchObject({ thumbnail: jpeg, resolutionWidth: 1920, resolutionHeight: 1080 });
    expect(result.current.latestScreenThumbnailRef.current).toBe(jpeg);

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(updates()).toHaveLength(0);

    jpeg = "data:image/jpeg;base64,BBBB";
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(updates()).toHaveLength(1);
    expect(updates()[0][1]).toMatchObject({ thumbnail: jpeg });
  });

  it("is announced again with the last picture after the connection comes back", async () => {
    const { result } = mount();
    await act(async () => {
      await result.current.startScreenShare();
      await vi.advanceTimersByTimeAsync(0);
    });
    socket.emit.mockClear();
    act(() => result.current.resumeScreenAnnouncement());
    expect(socket.emit).toHaveBeenCalledWith("screen:start", { thumbnail: jpeg, resolutionWidth: 1920, resolutionHeight: 1080 });
  });

  it("says nothing on reconnect when no screen is being shared", () => {
    const { result } = mount();
    act(() => result.current.resumeScreenAnnouncement());
    expect(socket.emit).not.toHaveBeenCalled();
  });
});

describe("leaving the room", () => {
  it("releaseScreenShare ends the share and the app-audio helper without renegotiating", async () => {
    bridge();
    mocks.appAudioApi = { available: true };
    const stop = vi.fn();
    mocks.startAppAudio.mockResolvedValue({ track: new FakeTrack("audio"), stop });
    displayMedia.mockImplementationOnce(() => Promise.resolve(new FakeStream([new FakeTrack("video")])));
    const { result } = mount();
    await act(async () => result.current.startScreenShare("window:1:0"));
    makeOffer.mockClear();
    act(() => result.current.releaseScreenShare());
    expect(stop).toHaveBeenCalledTimes(1);
    expect(result.current.screenStream).toBeNull();
    expect(result.current.screenRef.current).toBeNull();
    expect(result.current.latestScreenThumbnailRef.current).toBe("");
    expect(result.current.screenResolutionRef.current).toEqual({});
    expect(makeOffer).not.toHaveBeenCalled();
    expect(() => act(() => result.current.releaseScreenShare())).not.toThrow();
  });
});

describe("the desktop source picker", () => {
  it("lists sources for the chosen tab and clears the selection", async () => {
    const desktop = bridge();
    const { result } = mount();
    act(() => result.current.setSelectedDesktopShareId("old"));
    await act(async () => result.current.loadDesktopShareSources("screen"));
    expect(desktop.listShareSources).toHaveBeenCalledWith("screen");
    expect(result.current.desktopShareType).toBe("screen");
    expect(result.current.selectedDesktopShareId).toBe("");
    expect(result.current.loadingDesktopSources).toBe(false);
    expect(result.current.desktopShareError).toBe("");
  });

  it("only lets the latest request fill the list", async () => {
    let finishWindows: (value: unknown) => void = () => undefined;
    const desktop = bridge();
    desktop.listShareSources.mockImplementation((type: string) => type === "window"
      ? new Promise((resolve) => { finishWindows = resolve; })
      : Promise.resolve([{ id: "screen:0:0", name: "Tela 1" }]));
    const { result } = mount();
    let slow: Promise<void> = Promise.resolve();
    act(() => { slow = result.current.loadDesktopShareSources("window"); });
    await act(async () => result.current.loadDesktopShareSources("screen"));
    await act(async () => {
      finishWindows([{ id: "window:9:9", name: "Atrasada" }]);
      await slow;
    });
    expect(result.current.desktopShareSources).toEqual([{ id: "screen:0:0", name: "Tela 1" }]);
    expect(result.current.desktopShareType).toBe("screen");
  });

  it("gives up after 15 seconds with a specific message and reports it", async () => {
    vi.useFakeTimers();
    const desktop = bridge();
    desktop.listShareSources.mockReturnValue(new Promise(() => undefined));
    const { result } = mount();
    let loading: Promise<void> = Promise.resolve();
    act(() => { loading = result.current.loadDesktopShareSources("window"); });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
      await loading;
    });
    expect(result.current.desktopShareError).toContain("O Windows demorou demais para listar os aplicativos");
    expect(result.current.desktopShareSources).toEqual([]);
    expect(result.current.loadingDesktopSources).toBe(false);
    expect(mocks.reportClientIssue).toHaveBeenCalledWith("share-sources", expect.any(Error), { sourceType: "window" });
  });

  it("does nothing without the desktop app", async () => {
    const { result } = mount();
    await act(async () => result.current.loadDesktopShareSources("window"));
    expect(result.current.desktopShareType).toBe("window");
    expect(result.current.loadingDesktopSources).toBe(false);
  });

  it("closing the picker resets it and cancels the system selection", async () => {
    const desktop = bridge();
    const { result } = mount();
    await act(async () => result.current.toggleScreen());
    act(() => {
      result.current.setSelectedDesktopShareId("window:1:0");
      result.current.setShowDesktopShareSettings(true);
    });
    act(() => result.current.closeDesktopShareDialog());
    expect(result.current.showDesktopShareDialog).toBe(false);
    expect(result.current.showDesktopShareSettings).toBe(false);
    expect(result.current.selectedDesktopShareId).toBe("");
    expect(desktop.cancelShareSelection).toHaveBeenCalled();
  });
});

describe("missing-application diagnosis", () => {
  const diagnosis = { windowsApiAvailable: true, chromiumWindows: [], windows: [] };

  it("needs the application's name first", async () => {
    bridge({ diagnoseShareSources: vi.fn(() => Promise.resolve(diagnosis)) });
    const { result } = mount();
    await act(async () => result.current.sendShareDiagnosis());
    expect(setNotice).toHaveBeenCalledWith("Informe qual aplicativo você esperava encontrar.");
    expect(mocks.reportClientIssue).not.toHaveBeenCalled();
  });

  it("sends nothing unless the person agrees", async () => {
    const desktop = bridge({ diagnoseShareSources: vi.fn(() => Promise.resolve(diagnosis)) });
    answerConfirmWith(false);
    const { result } = mount();
    act(() => result.current.setMissingShareAppName("X-Plane 12"));
    await act(async () => result.current.sendShareDiagnosis());
    expect(desktop.diagnoseShareSources).not.toHaveBeenCalled();
    expect(mocks.reportClientIssue).not.toHaveBeenCalled();
  });

  it("reports the missing application and clears the field on success", async () => {
    bridge({ diagnoseShareSources: vi.fn(() => Promise.resolve(diagnosis)) });
    answerConfirmWith(true);
    const { result } = mount();
    act(() => result.current.setMissingShareAppName("  X-Plane 12  "));
    await act(async () => result.current.sendShareDiagnosis());
    expect(mocks.reportClientIssue).toHaveBeenCalledWith(
      "share-sources-missing",
      expect.objectContaining({ message: expect.stringContaining("X-Plane 12 não aparece na lista") }),
      { sourceType: "window", missingApp: "X-Plane 12" },
      expect.stringContaining("Aplicativo procurado: X-Plane 12"),
    );
    expect(result.current.missingShareAppName).toBe("");
    expect(setNotice).toHaveBeenLastCalledWith("Diagnóstico enviado ao administrador. Obrigado!");
    expect(result.current.sendingShareDiagnosis).toBe(false);
  });

  it("reports an unavailable diagnosis and always clears the busy flag", async () => {
    bridge({ diagnoseShareSources: vi.fn(() => Promise.resolve(null)) });
    answerConfirmWith(true);
    const { result } = mount();
    act(() => result.current.setMissingShareAppName("App"));
    await act(async () => result.current.sendShareDiagnosis());
    expect(setNotice).toHaveBeenLastCalledWith("Diagnóstico indisponível.");
    expect(result.current.sendingShareDiagnosis).toBe(false);
  });
});
