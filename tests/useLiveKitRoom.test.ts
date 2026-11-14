// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (...args: unknown[]) => void;

const fake = vi.hoisted(() => {
  class FakePublication {
    isSubscribed = false;
    subscribeCalls: boolean[] = [];
    constructor(public source: string) {}
    setSubscribed(value: boolean) {
      this.subscribeCalls.push(value);
      this.isSubscribed = value;
    }
  }
  class FakeParticipant {
    trackPublications = new Map<string, FakePublication>();
    constructor(public identity: string) {}
  }
  class FakeRoom {
    static last: FakeRoom | null = null;
    handlers = new Map<string, Handler>();
    remoteParticipants = new Map<string, FakeParticipant>();
    connectArgs: unknown[] = [];
    disconnectArgs: unknown[] = [];
    published: { track: MediaStreamTrack; options: Record<string, unknown>; replaced: MediaStreamTrack[]; publication: Record<string, unknown> }[] = [];
    unpublished: unknown[] = [];
    localParticipant = {
      publishTrack: async (track: MediaStreamTrack, options: Record<string, unknown>) => {
        const entry = { track, options, replaced: [] as MediaStreamTrack[], publication: {} as Record<string, unknown> };
        entry.publication = {
          track: {
            mediaStreamTrack: track,
            replaceTrack: async (next: MediaStreamTrack) => {
              entry.replaced.push(next);
              (entry.publication.track as { mediaStreamTrack: MediaStreamTrack }).mediaStreamTrack = next;
            },
          },
        };
        this.published.push(entry);
        return entry.publication;
      },
      unpublishTrack: async (track: unknown) => {
        this.unpublished.push(track);
      },
    };
    constructor(public options: unknown) {
      FakeRoom.last = this;
    }
    on(event: string, handler: Handler) {
      this.handlers.set(event, handler);
      return this;
    }
    removeAllListeners() {
      this.handlers.clear();
    }
    async connect(...args: unknown[]) {
      this.connectArgs = args;
    }
    async disconnect(...args: unknown[]) {
      this.disconnectArgs = args;
    }
    emit(event: string, ...args: unknown[]) {
      this.handlers.get(event)?.(...args);
    }
  }
  return { FakeRoom, FakePublication, FakeParticipant };
});

vi.mock("livekit-client", () => ({
  Room: fake.FakeRoom,
  RoomEvent: {
    TrackPublished: "trackPublished",
    TrackSubscribed: "trackSubscribed",
    TrackUnsubscribed: "trackUnsubscribed",
    ParticipantDisconnected: "participantDisconnected",
    Disconnected: "disconnected",
  },
  Track: { Source: { Microphone: "microphone", Camera: "camera", ScreenShare: "screen_share", ScreenShareAudio: "screen_share_audio" } },
}));

import { useLiveKitRoom, type LiveKitRoomOptions } from "../src/hooks/useLiveKitRoom.ts";

class FakeMediaTrack {
  static next = 0;
  id = `t${FakeMediaTrack.next++}`;
  readyState = "live";
  constructor(public kind: "audio" | "video") {}
}

class FakeMediaStream {
  private tracks: FakeMediaTrack[];
  constructor(tracks: FakeMediaTrack[] = []) {
    this.tracks = tracks;
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }
}

const asTrack = (track: FakeMediaTrack) => track as unknown as MediaStreamTrack;
const streamOf = (...tracks: FakeMediaTrack[]) => new FakeMediaStream(tracks) as unknown as MediaStream;

function setup(overrides: Partial<LiveKitRoomOptions> = {}) {
  const microphone = new FakeMediaTrack("audio");
  const options: LiveKitRoomOptions = {
    socketRef: { current: { id: "sock-1" } } as LiveKitRoomOptions["socketRef"],
    localAudioRef: { current: streamOf(microphone) },
    microphoneVersion: 1,
    cameraStream: null,
    screenStream: null,
    screenEncodingRef: { current: null },
    setScreenPreviews: vi.fn(),
    onDisconnected: vi.fn(),
    ...overrides,
  };
  const view = renderHook((props: LiveKitRoomOptions) => useLiveKitRoom(props), { initialProps: options });
  return { ...view, options, microphone };
}

const room = () => fake.FakeRoom.last as InstanceType<typeof fake.FakeRoom>;

async function join(view: ReturnType<typeof setup>) {
  await act(async () => {
    await view.result.current.joinLiveKit("cafe");
  });
}

function addRemote(identity: string, sources: string[]) {
  const participant = new fake.FakeParticipant(identity);
  const publications = sources.map((source) => new fake.FakePublication(source));
  publications.forEach((publication, index) => participant.trackPublications.set(String(index), publication));
  room().remoteParticipants.set(identity, participant);
  return { participant, publications };
}

beforeEach(() => {
  fake.FakeRoom.last = null;
  vi.stubGlobal("MediaStream", FakeMediaStream);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ url: "wss://lk.test", token: "jwt" }) })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("joining", () => {
  it("asks the server for a token for this socket and channel, then connects without auto-subscribing", async () => {
    const view = setup();
    await join(view);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/livekit/token");
    expect(JSON.parse(init.body as string)).toEqual({ socketId: "sock-1", channelId: "cafe" });
    expect(room().connectArgs).toEqual(["wss://lk.test", "jwt", { autoSubscribe: false }]);
    expect(room().options).toMatchObject({ adaptiveStream: false, dynacast: true });
    expect(view.result.current.liveKitActiveRef.current).toBe(true);
  });

  it("throws the server's message when the token is refused, and stays inactive", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ error: "Essa sala de voz não usa LiveKit." }) })));
    const view = setup();
    await expect(act(async () => { await view.result.current.joinLiveKit("cafe"); })).rejects.toThrow("Essa sala de voz não usa LiveKit.");
    expect(view.result.current.liveKitActiveRef.current).toBe(false);
    expect(fake.FakeRoom.last).toBeNull();
  });

  it("needs a live socket", async () => {
    const view = setup({ socketRef: { current: null } });
    await expect(act(async () => { await view.result.current.joinLiveKit("cafe"); })).rejects.toThrow(/tempo real/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("sending", () => {
  it("publishes the processed microphone once connected", async () => {
    const view = setup();
    await join(view);
    expect(room().published).toHaveLength(1);
    expect(room().published[0].track).toBe(asTrack(view.microphone));
    expect(room().published[0].options).toMatchObject({ source: "microphone", dtx: true });
  });

  it("replaces the track, without publishing again, when a new capture takes over", async () => {
    const view = setup();
    await join(view);
    const next = new FakeMediaTrack("audio");
    view.options.localAudioRef.current = streamOf(next);
    view.rerender({ ...view.options, microphoneVersion: 2 });
    await act(async () => {});
    expect(room().published).toHaveLength(1);
    expect(room().published[0].replaced).toEqual([asTrack(next)]);
  });

  it("does nothing when the microphone track did not change", async () => {
    const view = setup();
    await join(view);
    view.rerender({ ...view.options, microphoneVersion: 2 });
    await act(async () => {});
    expect(room().published[0].replaced).toEqual([]);
  });

  it("publishes the camera and unpublishes it when it is turned off", async () => {
    const view = setup();
    await join(view);
    const camera = new FakeMediaTrack("video");
    view.rerender({ ...view.options, cameraStream: streamOf(camera) });
    await act(async () => {});
    const published = room().published.find((entry) => entry.options.source === "camera");
    expect(published?.track).toBe(asTrack(camera));
    view.rerender({ ...view.options, cameraStream: null });
    await act(async () => {});
    expect(room().unpublished).toHaveLength(1);
  });

  it("publishes a screen with its encoding, no simulcast, and its audio as screen audio", async () => {
    const encoding = { maxBitrate: 6_000_000, maxFramerate: 60, degradationPreference: "maintain-framerate" };
    const view = setup({ screenEncodingRef: { current: encoding } as unknown as LiveKitRoomOptions["screenEncodingRef"] });
    await join(view);
    const video = new FakeMediaTrack("video");
    const audio = new FakeMediaTrack("audio");
    view.rerender({ ...view.options, screenStream: streamOf(video, audio) });
    await act(async () => {});
    const screen = room().published.find((entry) => entry.options.source === "screen_share");
    expect(screen?.options).toMatchObject({ simulcast: false, videoEncoding: { maxBitrate: 6_000_000, maxFramerate: 60 } });
    expect(room().published.find((entry) => entry.options.source === "screen_share_audio")?.track).toBe(asTrack(audio));
  });

  it("publishes what already exists when the room connects", async () => {
    const camera = new FakeMediaTrack("video");
    const view = setup({ cameraStream: streamOf(camera) });
    expect(fake.FakeRoom.last).toBeNull();
    await join(view);
    expect(room().published.map((entry) => entry.options.source).sort()).toEqual(["camera", "microphone"]);
  });
});

describe("receiving", () => {
  it("subscribes to microphone and camera, but not to a screen nobody chose to watch", async () => {
    const view = setup();
    await join(view);
    const { participant, publications } = addRemote("sock-2", ["microphone", "camera", "screen_share", "screen_share_audio"]);
    publications.forEach((publication) => room().emit("trackPublished", publication, participant));
    expect(publications.map((publication) => publication.isSubscribed)).toEqual([true, true, false, false]);
  });

  it("subscribes to a screen once it is watched, and stops when it is not", async () => {
    const view = setup();
    await join(view);
    const { publications } = addRemote("sock-2", ["microphone", "screen_share", "screen_share_audio"]);
    act(() => view.result.current.subscribeScreen("sock-2"));
    expect(publications.map((publication) => publication.isSubscribed)).toEqual([true, true, true]);
    act(() => view.result.current.unsubscribeScreen("sock-2"));
    expect(publications[1].isSubscribed).toBe(false);
    expect(publications[2].isSubscribed).toBe(false);
  });

  it("subscribes to a screen published after it was already being watched", async () => {
    const view = setup();
    await join(view);
    act(() => view.result.current.subscribeScreen("sock-2"));
    const { participant, publications } = addRemote("sock-2", ["screen_share"]);
    room().emit("trackPublished", publications[0], participant);
    expect(publications[0].isSubscribed).toBe(true);
  });

  it("subscribes to what people published before this member arrived", async () => {
    const view = setup();
    const existing = new fake.FakeParticipant("sock-3");
    const microphone = new fake.FakePublication("microphone");
    existing.trackPublications.set("a", microphone);
    // The room is created inside join, so seed it as soon as it exists.
    const original = fake.FakeRoom.prototype.connect;
    fake.FakeRoom.prototype.connect = async function (this: InstanceType<typeof fake.FakeRoom>, ...args: unknown[]) {
      this.remoteParticipants.set("sock-3", existing);
      return original.apply(this, args);
    };
    try {
      await join(view);
    } finally {
      fake.FakeRoom.prototype.connect = original;
    }
    expect(microphone.isSubscribed).toBe(true);
  });

  it("exposes remote tracks keyed by the member, by kind", async () => {
    const view = setup();
    await join(view);
    const { participant, publications } = addRemote("sock-2", ["microphone", "camera", "screen_share"]);
    const audio = new FakeMediaTrack("audio");
    const camera = new FakeMediaTrack("video");
    const screen = new FakeMediaTrack("video");
    act(() => {
      room().emit("trackSubscribed", { mediaStreamTrack: audio }, publications[0], participant);
      room().emit("trackSubscribed", { mediaStreamTrack: camera }, publications[1], participant);
      room().emit("trackSubscribed", { mediaStreamTrack: screen }, publications[2], participant);
    });
    expect(view.result.current.remoteStreams["sock-2"].getTracks()).toEqual([audio]);
    expect(view.result.current.remoteCameraStreams["sock-2"].getTracks()).toEqual([camera]);
    expect(view.result.current.remoteScreenStreams["sock-2"].getTracks()).toEqual([screen]);
  });

  it("replaces an older track of the same kind instead of keeping both", async () => {
    const view = setup();
    await join(view);
    const { participant, publications } = addRemote("sock-2", ["camera"]);
    const first = new FakeMediaTrack("video");
    const second = new FakeMediaTrack("video");
    act(() => {
      room().emit("trackSubscribed", { mediaStreamTrack: first }, publications[0], participant);
      room().emit("trackSubscribed", { mediaStreamTrack: second }, publications[0], participant);
    });
    expect(view.result.current.remoteCameraStreams["sock-2"].getTracks()).toEqual([second]);
  });

  it("drops a track when it is unsubscribed, and everything when the member leaves", async () => {
    const view = setup();
    await join(view);
    const { participant, publications } = addRemote("sock-2", ["microphone", "camera"]);
    const audio = new FakeMediaTrack("audio");
    const camera = new FakeMediaTrack("video");
    act(() => {
      room().emit("trackSubscribed", { mediaStreamTrack: audio }, publications[0], participant);
      room().emit("trackSubscribed", { mediaStreamTrack: camera }, publications[1], participant);
    });
    act(() => room().emit("trackUnsubscribed", { mediaStreamTrack: camera }, publications[1], participant));
    expect(view.result.current.remoteCameraStreams["sock-2"]).toBeUndefined();
    expect(view.result.current.remoteStreams["sock-2"]).toBeDefined();
    act(() => room().emit("participantDisconnected", participant));
    expect(view.result.current.remoteStreams["sock-2"]).toBeUndefined();
  });

  it("marks a screen preview live while its track flows", async () => {
    const setScreenPreviews = vi.fn();
    const view = setup({ setScreenPreviews });
    await join(view);
    const { participant, publications } = addRemote("sock-2", ["screen_share"]);
    act(() => room().emit("trackSubscribed", { mediaStreamTrack: new FakeMediaTrack("video") }, publications[0], participant));
    const update = setScreenPreviews.mock.calls[0][0] as (previews: Record<string, { live: boolean }>) => Record<string, { live: boolean }>;
    expect(update({ "sock-2": { live: false } })["sock-2"].live).toBe(true);
    expect(update({})).toEqual({});
  });
});

describe("leaving", () => {
  it("disconnects without stopping the app's own tracks, and clears everything", async () => {
    const view = setup();
    await join(view);
    const { participant, publications } = addRemote("sock-2", ["microphone"]);
    act(() => room().emit("trackSubscribed", { mediaStreamTrack: new FakeMediaTrack("audio") }, publications[0], participant));
    const connected = room();
    act(() => view.result.current.leaveLiveKit());
    expect(connected.disconnectArgs).toEqual([false]);
    expect(view.result.current.liveKitActiveRef.current).toBe(false);
    expect(view.result.current.remoteStreams).toEqual({});
  });

  it("does not report a deliberate leave as a lost connection", async () => {
    const view = setup();
    await join(view);
    const connected = room();
    act(() => view.result.current.leaveLiveKit());
    connected.emit("disconnected");
    expect(view.options.onDisconnected).not.toHaveBeenCalled();
  });

  it("reports a connection the server ended", async () => {
    const view = setup();
    await join(view);
    act(() => room().emit("disconnected"));
    expect(view.options.onDisconnected).toHaveBeenCalledTimes(1);
    expect(view.result.current.liveKitActiveRef.current).toBe(false);
  });

  it("leaves when the component unmounts", async () => {
    const view = setup();
    await join(view);
    const connected = room();
    view.unmount();
    expect(connected.disconnectArgs).toEqual([false]);
  });
});
