// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCamera, type CameraOptions } from "../src/hooks/useCamera.ts";

const device = vi.hoisted(() => ({ touchOnly: false }));
vi.mock("../src/lib/device.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/device.ts")>()),
  isTouchOnlyDevice: () => device.touchOnly,
}));

class FakeTrack {
  id = `cam-${Math.random().toString(36).slice(2)}`;
  stopped = false;
  listeners = new Map<string, () => void>();
  stop() {
    this.stopped = true;
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener);
  }
}

class FakeStream {
  tracks = [new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks;
  }
}

class FakePeer {
  added: unknown[] = [];
  removed: unknown[] = [];
  addTrack(track: unknown) {
    const sender = { track };
    this.added.push(sender);
    return sender as unknown as RTCRtpSender;
  }
  removeTrack(sender: unknown) {
    this.removed.push(sender);
  }
}

let getUserMedia: ReturnType<typeof vi.fn>;
let emit: ReturnType<typeof vi.fn>;
let makeOffer: ReturnType<typeof vi.fn>;
let setNotice: ReturnType<typeof vi.fn>;
let blocked: boolean;
let peers: Map<string, FakePeer>;
let refs: { cameraRef: { current: FakeStream | null }; cameraSendersRef: { current: Map<string, RTCRtpSender> } };
let captures: FakeStream[];

function mount(overrides: Partial<CameraOptions> = {}) {
  return renderHook((props: Partial<CameraOptions>) => useCamera({
    cameraRef: refs.cameraRef as never,
    peersRef: { current: peers as never },
    cameraSendersRef: refs.cameraSendersRef,
    socketRef: { current: { emit } as never },
    makeOffer: makeOffer as never,
    voiceChannel: "cafe",
    isBlockedInAfk: () => blocked,
    setNotice,
    ...props,
  }), { initialProps: overrides });
}

beforeEach(() => {
  device.touchOnly = false;
  blocked = false;
  captures = [];
  peers = new Map([["a", new FakePeer()], ["b", new FakePeer()]]);
  refs = { cameraRef: { current: null }, cameraSendersRef: { current: new Map() } };
  emit = vi.fn();
  makeOffer = vi.fn(() => Promise.resolve());
  setNotice = vi.fn();
  getUserMedia = vi.fn(() => {
    const stream = new FakeStream();
    captures.push(stream);
    return Promise.resolve(stream);
  });
  vi.stubGlobal("navigator", { ...globalThis.navigator, mediaDevices: { getUserMedia } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("turning the camera on", () => {
  it("needs a voice room", async () => {
    const { result } = mount({ voiceChannel: null });
    await act(async () => result.current.toggleCamera());
    expect(setNotice).toHaveBeenCalledWith("Entre em uma sala de voz antes de ligar a câmera.");
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("is refused in the AFK channel", async () => {
    blocked = true;
    const { result } = mount();
    await act(async () => result.current.toggleCamera());
    expect(setNotice).toHaveBeenCalledWith("No canal AFK não é possível ligar a câmera.");
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("asks for 720p at 30 fps on a computer and a lighter 360p on a phone", async () => {
    const desktop = mount();
    await act(async () => desktop.result.current.toggleCamera());
    expect(getUserMedia).toHaveBeenLastCalledWith({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
      audio: false,
    });
    device.touchOnly = true;
    refs.cameraRef.current = null;
    const phone = mount();
    await act(async () => phone.result.current.toggleCamera());
    expect(getUserMedia).toHaveBeenLastCalledWith({
      video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 20, max: 24 } },
      audio: false,
    });
  });

  it("sends the video to every peer already in the room, announcing it first", async () => {
    const { result } = mount();
    await act(async () => result.current.toggleCamera());
    const track = captures[0].tracks[0];
    expect(refs.cameraRef.current).toBe(captures[0]);
    expect(result.current.cameraStream).toBe(captures[0]);
    expect(emit).toHaveBeenCalledWith("media:track-meta", { target: "a", trackId: track.id, kind: "camera" });
    expect(emit).toHaveBeenCalledWith("media:track-meta", { target: "b", trackId: track.id, kind: "camera" });
    expect(peers.get("a")?.added).toHaveLength(1);
    expect(peers.get("b")?.added).toHaveLength(1);
    expect([...refs.cameraSendersRef.current.keys()]).toEqual(["a", "b"]);
    expect(makeOffer.mock.calls.map(([peerId]) => peerId)).toEqual(["a", "b"]);
  });

  it("works in an empty room: nothing to send yet, the camera is still on", async () => {
    peers.clear();
    const { result } = mount();
    await act(async () => result.current.toggleCamera());
    expect(result.current.cameraStream).toBe(captures[0]);
    expect(makeOffer).not.toHaveBeenCalled();
  });

  it("reports a camera that cannot be opened and stays off", async () => {
    getUserMedia.mockRejectedValueOnce(new Error("denied"));
    const { result } = mount();
    await act(async () => result.current.toggleCamera());
    expect(setNotice).toHaveBeenCalledWith("A câmera não pôde ser aberta. Verifique a permissão do navegador.");
    expect(result.current.cameraStream).toBeNull();
    expect(refs.cameraRef.current).toBeNull();
  });

  it("turns itself off when the device takes the camera away", async () => {
    const { result } = mount();
    await act(async () => result.current.toggleCamera());
    act(() => captures[0].tracks[0].listeners.get("ended")?.());
    expect(result.current.cameraStream).toBeNull();
    expect(refs.cameraRef.current).toBeNull();
    expect(captures[0].tracks[0].stopped).toBe(true);
  });
});

describe("turning the camera off", () => {
  it("toggling again stops it, removing the video from every peer and renegotiating", async () => {
    const { result } = mount();
    await act(async () => result.current.toggleCamera());
    const senders = [...refs.cameraSendersRef.current.values()];
    makeOffer.mockClear();
    await act(async () => result.current.toggleCamera());
    expect(captures[0].tracks[0].stopped).toBe(true);
    expect(result.current.cameraStream).toBeNull();
    expect(refs.cameraRef.current).toBeNull();
    expect(peers.get("a")?.removed).toEqual([senders[0]]);
    expect(peers.get("b")?.removed).toEqual([senders[1]]);
    expect(makeOffer.mock.calls.map(([peerId]) => peerId)).toEqual(["a", "b"]);
    expect(refs.cameraSendersRef.current.size).toBe(0);
  });

  it("can be turned off in the AFK channel even though it cannot be turned on there", async () => {
    const { result } = mount();
    await act(async () => result.current.toggleCamera());
    blocked = true;
    await act(async () => result.current.toggleCamera());
    expect(result.current.cameraStream).toBeNull();
    expect(setNotice).not.toHaveBeenCalled();
  });

  it("skips senders whose peer is gone and survives a failed renegotiation", async () => {
    const { result } = mount();
    await act(async () => result.current.toggleCamera());
    peers.delete("a");
    makeOffer.mockClear();
    makeOffer.mockRejectedValueOnce(new Error("closed"));
    await expect(act(async () => result.current.stopCamera())).resolves.not.toThrow();
    expect(makeOffer.mock.calls.map(([peerId]) => peerId)).toEqual(["b"]);
  });

  it("stopCamera does nothing when the camera is already off", () => {
    const { result } = mount();
    act(() => result.current.stopCamera());
    expect(makeOffer).not.toHaveBeenCalled();
    expect(result.current.cameraStream).toBeNull();
  });

  it("releaseCamera stops the capture without touching the connections", async () => {
    const { result } = mount();
    await act(async () => result.current.toggleCamera());
    makeOffer.mockClear();
    act(() => result.current.releaseCamera());
    expect(captures[0].tracks[0].stopped).toBe(true);
    expect(result.current.cameraStream).toBeNull();
    expect(refs.cameraRef.current).toBeNull();
    expect(peers.get("a")?.removed).toEqual([]);
    expect(makeOffer).not.toHaveBeenCalled();
    expect(() => act(() => result.current.releaseCamera())).not.toThrow();
  });
});
