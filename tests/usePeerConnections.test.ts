// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePeerConnections } from "../src/hooks/usePeerConnections.ts";
import type { ScreenPreview } from "../src/types.ts";

const media = vi.hoisted(() => ({ tune: vi.fn() }));
vi.mock("../src/lib/media.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/media.ts")>()),
  tuneOutgoingMedia: media.tune,
}));

class FakeTrack {
  static next = 0;
  id = `t${FakeTrack.next++}`;
  muted = false;
  readyState: "live" | "ended" = "live";
  listeners = new Map<string, Array<() => void>>();
  constructor(public kind: "audio" | "video") {}
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string) {
    this.listeners.get(type)?.forEach((listener) => listener());
  }
}

class FakeStream {
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks];
  }
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === "video");
  }
  addTrack(track: FakeTrack) {
    this.tracks.push(track);
  }
  removeTrack(track: FakeTrack) {
    this.tracks = this.tracks.filter((candidate) => candidate !== track);
  }
}

class FakePeer {
  static instances: FakePeer[] = [];
  static lastConfiguration: RTCConfiguration | undefined;
  added: Array<{ track: FakeTrack; stream: FakeStream }> = [];
  closed = false;
  connectionState = "new";
  remoteDescription: unknown = null;
  localDescription: unknown = null;
  appliedCandidates: unknown[] = [];
  onicecandidate: ((event: { candidate: { toJSON: () => unknown } | null }) => void) | null = null;
  ontrack: ((event: { track: FakeTrack }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  failSetRemote = false;
  signalingState = "stable";
  /** What the last negotiation settled for each added track; a track an answer had no room for stays null. */
  directions = new Map<FakeTrack, string>();
  constructor(configuration: RTCConfiguration) {
    FakePeer.lastConfiguration = configuration;
    FakePeer.instances.push(this);
  }
  addTrack(track: FakeTrack, stream: FakeStream) {
    this.added.push({ track, stream });
    return { track } as unknown as RTCRtpSender;
  }
  createOffer() {
    return Promise.resolve({ type: "offer", sdp: "offer-sdp" });
  }
  createAnswer() {
    return Promise.resolve({ type: "answer", sdp: "answer-sdp" });
  }
  getTransceivers() {
    return this.added.map(({ track }) => ({ sender: { track }, currentDirection: this.directions.get(track) ?? null }));
  }
  setLocalDescription(description: unknown) {
    this.localDescription = description;
    const { type } = description as { type: string };
    this.signalingState = type === "offer" ? "have-local-offer" : "stable";
    return Promise.resolve();
  }
  setRemoteDescription(description: unknown) {
    if (this.failSetRemote) return Promise.reject(new Error("bad sdp"));
    this.remoteDescription = description;
    const { type } = description as { type: string };
    if (type === "answer") for (const { track } of this.added) this.directions.set(track, "sendrecv");
    this.signalingState = type === "offer" ? "have-remote-offer" : "stable";
    return Promise.resolve();
  }
  addIceCandidate(candidate: unknown) {
    this.appliedCandidates.push(candidate);
    return Promise.resolve();
  }
  close() {
    this.closed = true;
  }
}

let socket: { emit: ReturnType<typeof vi.fn> };
let setNotice: ReturnType<typeof vi.fn>;
let refs: {
  localAudioRef: { current: FakeStream | null };
  cameraRef: { current: FakeStream | null };
  peersRef: { current: Map<string, RTCPeerConnection> };
  cameraSendersRef: { current: Map<string, RTCRtpSender> };
  screenSendersRef: { current: Map<string, never[]> };
  activeScreenPeerIdRef: { current: string | null };
};

function useHarness() {
  const [screenPreviews, setScreenPreviews] = useState<Record<string, ScreenPreview>>({});
  const [activeScreenPeerId, setActiveScreenPeerId] = useState<string | null>(null);
  const [expandedScreenPeerId, setExpandedScreenPeerId] = useState<string | null>(null);
  const peers = usePeerConnections({
    socketRef: { current: socket as never },
    ...(refs as never),
    setScreenPreviews,
    setActiveScreenPeerId,
    setExpandedScreenPeerId,
    setNotice,
  });
  return { ...peers, screenPreviews, setScreenPreviews, activeScreenPeerId, setActiveScreenPeerId, expandedScreenPeerId, setExpandedScreenPeerId };
}

const peerOf = (id: string) => refs.peersRef.current.get(id) as unknown as FakePeer;
const track = (kind: "audio" | "video") => new FakeTrack(kind);

beforeEach(() => {
  FakePeer.instances = [];
  FakePeer.lastConfiguration = undefined;
  media.tune.mockReset();
  socket = { emit: vi.fn() };
  setNotice = vi.fn();
  refs = {
    localAudioRef: { current: null },
    cameraRef: { current: null },
    peersRef: { current: new Map() },
    cameraSendersRef: { current: new Map() },
    screenSendersRef: { current: new Map() },
    activeScreenPeerIdRef: { current: null },
  };
  vi.stubGlobal("RTCPeerConnection", FakePeer);
  vi.stubGlobal("MediaStream", FakeStream);
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("creating a peer", () => {
  it("reuses the connection for the same member", () => {
    const { result } = renderHook(useHarness);
    let first: unknown;
    let second: unknown;
    act(() => {
      first = result.current.createPeer("a");
      second = result.current.createPeer("a");
    });
    expect(second).toBe(first);
    expect(FakePeer.instances).toHaveLength(1);
    expect(refs.peersRef.current.get("a")).toBe(first);
  });

  it("sends the microphone, and the camera if it is on, announcing the camera track first", () => {
    const microphone = new FakeStream([track("audio")]);
    const camera = new FakeStream([track("video")]);
    refs.localAudioRef.current = microphone;
    refs.cameraRef.current = camera;
    const { result } = renderHook(useHarness);
    act(() => void result.current.createPeer("a"));
    const added = peerOf("a").added;
    expect(added.map((entry) => entry.track)).toEqual([microphone.tracks[0], camera.tracks[0]]);
    expect(socket.emit).toHaveBeenCalledWith("media:track-meta", { target: "a", trackId: camera.tracks[0].id, kind: "camera" });
    expect(refs.cameraSendersRef.current.has("a")).toBe(true);
  });

  it("sends nothing it does not have", () => {
    const { result } = renderHook(useHarness);
    act(() => void result.current.createPeer("a"));
    expect(peerOf("a").added).toEqual([]);
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it("forwards its ICE candidates and ignores the end-of-candidates marker", () => {
    const { result } = renderHook(useHarness);
    act(() => void result.current.createPeer("a"));
    const peer = peerOf("a");
    peer.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: "c1" }) } });
    peer.onicecandidate?.({ candidate: null });
    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith("rtc:signal", { target: "a", candidate: { candidate: "c1" } });
  });

  it("is closed and forgotten when the connection fails or closes", () => {
    const { result } = renderHook(useHarness);
    act(() => void result.current.createPeer("a"));
    const peer = peerOf("a");
    peer.connectionState = "connected";
    act(() => peer.onconnectionstatechange?.());
    expect(refs.peersRef.current.has("a")).toBe(true);
    peer.connectionState = "failed";
    act(() => peer.onconnectionstatechange?.());
    expect(refs.peersRef.current.has("a")).toBe(false);
    expect(peer.closed).toBe(true);
  });
});

describe("routing incoming tracks", () => {
  const arrive = (peerId: string, incoming: FakeTrack) => act(() => peerOf(peerId).ontrack?.({ track: incoming }));

  it("puts audio in the remote audio streams", () => {
    const { result } = renderHook(useHarness);
    act(() => void result.current.createPeer("a"));
    const audio = track("audio");
    arrive("a", audio);
    expect(result.current.remoteStreams.a.getTracks()).toEqual([audio]);
    expect(result.current.remoteCameraStreams).toEqual({});
  });

  it("routes video by what the sender declared", () => {
    const { result } = renderHook(useHarness);
    act(() => void result.current.createPeer("a"));
    const camera = track("video");
    const screen = track("video");
    act(() => {
      result.current.onTrackMeta({ from: "a", trackId: camera.id, kind: "camera" });
      result.current.onTrackMeta({ from: "a", trackId: screen.id, kind: "screen" });
    });
    arrive("a", camera);
    arrive("a", screen);
    expect(result.current.remoteCameraStreams.a.getTracks()).toEqual([camera]);
    expect(result.current.remoteScreenStreams.a.getTracks()).toEqual([screen]);
  });

  it("guesses undeclared video: a screen if that member's screen is being watched, otherwise a camera", () => {
    const { result } = renderHook(useHarness);
    act(() => void result.current.createPeer("a"));
    act(() => void result.current.createPeer("b"));
    refs.activeScreenPeerIdRef.current = "a";
    const forA = track("video");
    const forB = track("video");
    arrive("a", forA);
    arrive("b", forB);
    expect(result.current.remoteScreenStreams.a.getTracks()).toEqual([forA]);
    expect(result.current.remoteCameraStreams.b.getTracks()).toEqual([forB]);
  });

  it("uses a declared kind only once", () => {
    const { result } = renderHook(useHarness);
    act(() => void result.current.createPeer("a"));
    const first = track("video");
    act(() => result.current.onTrackMeta({ from: "a", trackId: first.id, kind: "screen" }));
    arrive("a", first);
    // The same id arriving again is no longer declared, so it falls back to the guess.
    const again = Object.assign(track("video"), { id: first.id });
    arrive("a", again);
    expect(result.current.remoteCameraStreams.a.getTracks()).toEqual([again]);
  });

  it("a new camera video replaces the old one, keeping only live non-video tracks", () => {
    const { result } = renderHook(useHarness);
    act(() => void result.current.createPeer("a"));
    const first = track("video");
    const second = track("video");
    act(() => {
      result.current.onTrackMeta({ from: "a", trackId: first.id, kind: "camera" });
      result.current.onTrackMeta({ from: "a", trackId: second.id, kind: "camera" });
    });
    arrive("a", first);
    const firstStream = result.current.remoteCameraStreams.a;
    arrive("a", second);
    expect(result.current.remoteCameraStreams.a).not.toBe(firstStream);
    expect(result.current.remoteCameraStreams.a.getTracks()).toEqual([second]);
  });

  it("does not add the same track twice", () => {
    const { result } = renderHook(useHarness);
    act(() => void result.current.createPeer("a"));
    const audio = track("audio");
    arrive("a", audio);
    arrive("a", audio);
    expect(result.current.remoteStreams.a.getTracks()).toHaveLength(1);
  });

  it("removes a track when it ends, and the stream once it is empty", () => {
    const { result } = renderHook(useHarness);
    act(() => void result.current.createPeer("a"));
    const first = track("audio");
    const second = track("audio");
    arrive("a", first);
    arrive("a", second);
    act(() => first.fire("ended"));
    expect(result.current.remoteStreams.a.getTracks()).toEqual([second]);
    act(() => second.fire("ended"));
    expect(result.current.remoteStreams).toEqual({});
  });

  it("tracks whether a watched screen is live, following mute and unmute", () => {
    const { result } = renderHook(useHarness);
    act(() => void result.current.createPeer("a"));
    act(() => result.current.setScreenPreviews({ a: { thumbnail: "t", live: false } as ScreenPreview }));
    const screen = track("video");
    act(() => result.current.onTrackMeta({ from: "a", trackId: screen.id, kind: "screen" }));
    arrive("a", screen);
    expect(result.current.screenPreviews.a.live).toBe(true);
    act(() => screen.fire("mute"));
    expect(result.current.screenPreviews.a.live).toBe(false);
    act(() => screen.fire("unmute"));
    expect(result.current.screenPreviews.a.live).toBe(true);
    act(() => screen.fire("ended"));
    expect(result.current.screenPreviews.a.live).toBe(false);
  });

  it("starts a screen as not live when its track arrives muted", () => {
    const { result } = renderHook(useHarness);
    act(() => void result.current.createPeer("a"));
    act(() => result.current.setScreenPreviews({ a: { thumbnail: "t", live: true } as ScreenPreview }));
    const screen = Object.assign(track("video"), { muted: true });
    act(() => result.current.onTrackMeta({ from: "a", trackId: screen.id, kind: "screen" }));
    arrive("a", screen);
    expect(result.current.screenPreviews.a.live).toBe(false);
  });
});

describe("closing and resetting", () => {
  function populate(result: { current: ReturnType<typeof useHarness> }) {
    act(() => {
      result.current.createPeer("a");
      result.current.createPeer("b");
    });
    act(() => peerOf("a").ontrack?.({ track: track("audio") }));
    act(() => peerOf("b").ontrack?.({ track: track("audio") }));
    act(() => {
      result.current.setScreenPreviews({ a: { live: true } as ScreenPreview, b: { live: true } as ScreenPreview });
      result.current.setActiveScreenPeerId("a");
      result.current.setExpandedScreenPeerId("a");
    });
  }

  it("closePeer forgets one member everywhere and leaves the others alone", async () => {
    const { result } = renderHook(useHarness);
    populate(result);
    refs.cameraSendersRef.current.set("a", {} as RTCRtpSender);
    refs.screenSendersRef.current.set("a", []);
    const peerA = peerOf("a");
    act(() => result.current.closePeer("a"));
    expect(peerA.closed).toBe(true);
    expect(refs.peersRef.current.has("a")).toBe(false);
    expect(refs.peersRef.current.has("b")).toBe(true);
    expect(refs.cameraSendersRef.current.has("a")).toBe(false);
    expect(refs.screenSendersRef.current.has("a")).toBe(false);
    expect(Object.keys(result.current.remoteStreams)).toEqual(["b"]);
    expect(Object.keys(result.current.screenPreviews)).toEqual(["b"]);
    expect(result.current.activeScreenPeerId).toBeNull();
    expect(result.current.expandedScreenPeerId).toBeNull();
  });

  it("closePeer keeps the watched screen of someone else", () => {
    const { result } = renderHook(useHarness);
    populate(result);
    act(() => result.current.closePeer("b"));
    expect(result.current.activeScreenPeerId).toBe("a");
    expect(result.current.expandedScreenPeerId).toBe("a");
  });

  it("reset closes every connection and clears all remote media and bookkeeping", () => {
    const { result } = renderHook(useHarness);
    populate(result);
    refs.cameraSendersRef.current.set("a", {} as RTCRtpSender);
    refs.screenSendersRef.current.set("a", []);
    refs.activeScreenPeerIdRef.current = "a";
    const peers = [peerOf("a"), peerOf("b")];
    act(() => result.current.resetRemoteVoiceConnections());
    expect(peers.every((peer) => peer.closed)).toBe(true);
    expect(refs.peersRef.current.size).toBe(0);
    expect(refs.cameraSendersRef.current.size).toBe(0);
    expect(refs.screenSendersRef.current.size).toBe(0);
    expect(refs.activeScreenPeerIdRef.current).toBeNull();
    expect(result.current.remoteStreams).toEqual({});
    expect(result.current.screenPreviews).toEqual({});
    expect(result.current.activeScreenPeerId).toBeNull();
    expect(result.current.expandedScreenPeerId).toBeNull();
  });

  it("dropRemoteScreenStream removes only that member's shared screen", () => {
    const { result } = renderHook(useHarness);
    act(() => {
      result.current.createPeer("a");
      result.current.createPeer("b");
    });
    const screenA = track("video");
    const screenB = track("video");
    const cameraA = track("video");
    act(() => {
      result.current.onTrackMeta({ from: "a", trackId: screenA.id, kind: "screen" });
      result.current.onTrackMeta({ from: "b", trackId: screenB.id, kind: "screen" });
      result.current.onTrackMeta({ from: "a", trackId: cameraA.id, kind: "camera" });
    });
    act(() => peerOf("a").ontrack?.({ track: screenA }));
    act(() => peerOf("b").ontrack?.({ track: screenB }));
    act(() => peerOf("a").ontrack?.({ track: cameraA }));
    act(() => result.current.dropRemoteScreenStream("a"));
    expect(Object.keys(result.current.remoteScreenStreams)).toEqual(["b"]);
    expect(Object.keys(result.current.remoteCameraStreams)).toEqual(["a"]);
  });
});

describe("signaling", () => {
  it("makeOffer creates and sends an offer, then tunes the outgoing media", async () => {
    refs.cameraRef.current = new FakeStream([track("video")]);
    const { result } = renderHook(useHarness);
    await act(async () => result.current.makeOffer("a"));
    expect(peerOf("a").localDescription).toEqual({ type: "offer", sdp: "offer-sdp" });
    expect(socket.emit).toHaveBeenCalledWith("rtc:signal", { target: "a", description: { type: "offer", sdp: "offer-sdp" } });
    expect(media.tune).toHaveBeenCalledWith(peerOf("a"), refs.cameraRef.current.tracks[0].id);
  });

  it("offers to every member already in the room, one after another", async () => {
    const { result } = renderHook(useHarness);
    await act(async () => result.current.onVoicePeers(["a", "b", "c"]));
    expect(FakePeer.instances).toHaveLength(3);
    const targets = socket.emit.mock.calls.filter(([event]) => event === "rtc:signal").map(([, payload]) => payload.target);
    expect(targets).toEqual(["a", "b", "c"]);
  });

  it("answers an offer", async () => {
    const { result } = renderHook(useHarness);
    await act(async () => result.current.onRtcSignal({ from: "a", description: { type: "offer", sdp: "x" } }));
    expect(peerOf("a").remoteDescription).toEqual({ type: "offer", sdp: "x" });
    expect(socket.emit).toHaveBeenCalledWith("rtc:signal", { target: "a", description: { type: "answer", sdp: "answer-sdp" } });
    expect(media.tune).toHaveBeenCalledTimes(1);
  });

  it("does not answer an answer", async () => {
    const { result } = renderHook(useHarness);
    await act(async () => result.current.onRtcSignal({ from: "a", description: { type: "answer", sdp: "x" } }));
    expect(peerOf("a").remoteDescription).toEqual({ type: "answer", sdp: "x" });
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it("queues ICE candidates that arrive before the description, then applies them in order", async () => {
    const { result } = renderHook(useHarness);
    await act(async () => result.current.onRtcSignal({ from: "a", candidate: { candidate: "c1" } }));
    await act(async () => result.current.onRtcSignal({ from: "a", candidate: { candidate: "c2" } }));
    expect(peerOf("a").appliedCandidates).toEqual([]);
    await act(async () => result.current.onRtcSignal({ from: "a", description: { type: "offer", sdp: "x" } }));
    expect(peerOf("a").appliedCandidates).toEqual([{ candidate: "c1" }, { candidate: "c2" }]);
  });

  it("drops queued candidates when the member's peer is closed, so a reconnection never gets stale ones", async () => {
    const { result } = renderHook(useHarness);
    await act(async () => result.current.onRtcSignal({ from: "a", candidate: { candidate: "stale" } }));
    act(() => result.current.closePeer("a"));
    await act(async () => result.current.onRtcSignal({ from: "a", description: { type: "offer", sdp: "x" } }));
    expect(peerOf("a").appliedCandidates).toEqual([]);
  });

  it("applies an ICE candidate immediately once the description is set", async () => {
    const { result } = renderHook(useHarness);
    await act(async () => result.current.onRtcSignal({ from: "a", description: { type: "offer", sdp: "x" } }));
    await act(async () => result.current.onRtcSignal({ from: "a", candidate: { candidate: "late" } }));
    expect(peerOf("a").appliedCandidates).toEqual([{ candidate: "late" }]);
  });

  it("tells the user when a connection cannot be synchronised", async () => {
    const { result } = renderHook(useHarness);
    act(() => void result.current.createPeer("a"));
    peerOf("a").failSetRemote = true;
    await act(async () => result.current.onRtcSignal({ from: "a", description: { type: "offer", sdp: "x" } }));
    expect(setNotice).toHaveBeenCalledWith("Não foi possível sincronizar uma conexão de voz.");
  });
});

describe("renegotiation", () => {
  const signals = (type: "offer" | "answer") => socket.emit.mock.calls
    .filter(([event, payload]) => event === "rtc:signal" && payload.description?.type === type).length;

  it("offers a camera that was already on when the member arrived, which the answer cannot carry", async () => {
    refs.cameraRef.current = new FakeStream([track("video")]);
    const { result } = renderHook(useHarness);
    await act(async () => result.current.onRtcSignal({ from: "a", description: { type: "offer", sdp: "x" } }));
    expect(signals("answer")).toBe(1);
    expect(signals("offer")).toBe(1);
  });

  it("holds an offer asked for during a negotiation and makes it once, after the answer", async () => {
    const { result } = renderHook(useHarness);
    await act(async () => result.current.makeOffer("a"));
    await act(async () => {
      await result.current.makeOffer("a");
      await result.current.makeOffer("a");
    });
    expect(signals("offer")).toBe(1);
    await act(async () => result.current.onRtcSignal({ from: "a", description: { type: "answer", sdp: "x" } }));
    expect(signals("offer")).toBe(2);
    await act(async () => result.current.onRtcSignal({ from: "a", description: { type: "answer", sdp: "y" } }));
    expect(signals("offer")).toBe(2);
  });

  it("accepts an offer that arrives while the answer to its own offer is still being applied", async () => {
    Object.assign(socket, { id: "a" }); // The side that would keep its own offer in a real collision.
    const { result } = renderHook(useHarness);
    await act(async () => result.current.makeOffer("b"));
    const peer = peerOf("b");
    const apply = peer.setRemoteDescription.bind(peer);
    let finishAnswer = () => {};
    // Like a browser, the answer takes a while and is applied before the offer that follows it.
    peer.setRemoteDescription = (description: unknown) => {
      if ((description as { type: string }).type === "answer") {
        return new Promise<void>((resolve) => {
          finishAnswer = () => void apply(description).then(resolve);
        });
      }
      finishAnswer();
      return apply(description);
    };
    await act(async () => {
      await Promise.all([
        result.current.onRtcSignal({ from: "b", description: { type: "answer", sdp: "x" } }),
        result.current.onRtcSignal({ from: "b", description: { type: "offer", sdp: "next" } }),
      ]);
    });
    expect(peer.remoteDescription).toEqual({ type: "offer", sdp: "next" });
    expect(signals("answer")).toBe(1);
  });

  it("keeps its own offer when both offered at once and its socket id is the lower one", async () => {
    Object.assign(socket, { id: "a" });
    const { result } = renderHook(useHarness);
    await act(async () => result.current.makeOffer("b"));
    await act(async () => result.current.onRtcSignal({ from: "b", description: { type: "offer", sdp: "theirs" } }));
    expect(peerOf("b").remoteDescription).toBeNull();
    expect(signals("answer")).toBe(0);
    expect(setNotice).not.toHaveBeenCalled();
  });

  it("gives way when both offered at once and its socket id is the higher one, then offers again", async () => {
    Object.assign(socket, { id: "b" });
    const { result } = renderHook(useHarness);
    await act(async () => result.current.makeOffer("a"));
    await act(async () => result.current.onRtcSignal({ from: "a", description: { type: "offer", sdp: "theirs" } }));
    expect(signals("answer")).toBe(1);
    expect(signals("offer")).toBe(2);
  });
});

describe("ICE configuration", () => {
  it("is fetched once, cached, and used by the peers created afterwards", async () => {
    const fetchMock = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ iceServers: [{ urls: "turn:t.example", username: "u", credential: "c" }], iceTransportPolicy: "relay" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(useHarness);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      await result.current.loadRtcConfiguration();
      await result.current.loadRtcConfiguration();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/rtc-config", { cache: "no-store" });
    act(() => void result.current.createPeer("a"));
    expect(FakePeer.lastConfiguration).toMatchObject({
      iceServers: [{ urls: "turn:t.example", username: "u", credential: "c" }],
      iceTransportPolicy: "relay",
      iceCandidatePoolSize: 8,
    });
  });

  it("falls back to public STUN when the server has none or is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    const { result } = renderHook(useHarness);
    await act(async () => {
      const configuration = await result.current.loadRtcConfiguration();
      expect(configuration.iceServers?.length).toBeGreaterThan(0);
    });
    act(() => void result.current.createPeer("a"));
    expect(FakePeer.lastConfiguration?.iceServers?.length).toBeGreaterThan(0);
  });

  it("uses public STUN when the server answers with an empty list", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ iceServers: [] }) })));
    const { result } = renderHook(useHarness);
    await act(async () => {
      const configuration = await result.current.loadRtcConfiguration();
      expect(configuration.iceTransportPolicy).toBe("all");
      expect(configuration.iceServers?.length).toBeGreaterThan(0);
    });
  });
});
