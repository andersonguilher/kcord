import {
  Room,
  RoomEvent,
  Track,
  type LocalAudioTrack,
  type LocalTrackPublication,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "livekit-client";
import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { Socket } from "socket.io-client";
import type { ScreenEncoding, ScreenPreview } from "../types";

export type LiveKitRoomOptions = {
  socketRef: RefObject<Socket | null>;
  /** The processed microphone stream (gain, sensitivity, push-to-talk gating): what gets published. */
  localAudioRef: RefObject<MediaStream | null>;
  /** Changes whenever a new microphone capture replaces the old one. */
  microphoneVersion: number;
  cameraStream: MediaStream | null;
  screenStream: MediaStream | null;
  screenEncodingRef: RefObject<ScreenEncoding | null>;
  setScreenPreviews: Dispatch<SetStateAction<Record<string, ScreenPreview>>>;
  /** The connection ended without the member asking for it. */
  onDisconnected: () => void;
};

type Streams = Record<string, MediaStream>;
type StreamSetter = Dispatch<SetStateAction<Streams>>;

/** A new track replaces any track of the same kind: an old video stays live but muted, and would be played instead. */
function withTrack(streams: Streams, peerId: string, track: MediaStreamTrack): Streams {
  const kept = (streams[peerId]?.getTracks() ?? []).filter((existing) => existing.kind !== track.kind && existing.readyState === "live");
  return { ...streams, [peerId]: new MediaStream([...kept, track]) };
}

function withoutTrack(streams: Streams, peerId: string, trackId: string): Streams {
  const current = streams[peerId];
  if (!current) return streams;
  const remaining = current.getTracks().filter((track) => track.id !== trackId);
  const next = { ...streams };
  if (remaining.length === 0) delete next[peerId];
  else next[peerId] = new MediaStream(remaining);
  return next;
}

function withoutPeer(streams: Streams, peerId: string): Streams {
  if (!(peerId in streams)) return streams;
  const next = { ...streams };
  delete next[peerId];
  return next;
}

const isScreenSource = (source: Track.Source) => source === Track.Source.ScreenShare || source === Track.Source.ScreenShareAudio;

/**
 * Voice, camera and screen sharing through a self-hosted LiveKit SFU, for the voice
 * channels the server lists as LiveKit channels. It mirrors the state the app already
 * keeps (the processed microphone, the camera and screen streams) into the room, and
 * hands back remote streams in the same shape the peer-to-peer mesh produces, keyed by
 * the member's socket id, so the tiles and audio players do not change.
 */
export function useLiveKitRoom(options: LiveKitRoomOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [remoteStreams, setRemoteStreams] = useState<Streams>({});
  const [remoteCameraStreams, setRemoteCameraStreams] = useState<Streams>({});
  const [remoteScreenStreams, setRemoteScreenStreams] = useState<Streams>({});
  /** Bumped once the room is connected, so the publish effects run for what already exists. */
  const [connectionVersion, setConnectionVersion] = useState(0);

  const roomRef = useRef<Room | null>(null);
  /** True while connected: the peer-to-peer handlers use it to stand aside. */
  const activeRef = useRef(false);
  /** Members whose screen the person chose to watch, by socket id. */
  const watchedRef = useRef(new Set<string>());
  const microphoneRef = useRef<LocalTrackPublication | null>(null);
  const publishedRef = useRef<{ camera: LocalTrackPublication[]; screen: LocalTrackPublication[] }>({ camera: [], screen: [] });

  const setterFor = (source: Track.Source): StreamSetter => {
    if (source === Track.Source.Camera) return setRemoteCameraStreams;
    if (isScreenSource(source)) return setRemoteScreenStreams;
    return setRemoteStreams;
  };

  /** Microphone and camera are always received; a screen only once someone chooses to watch it. */
  const considerSubscription = useCallback((publication: RemoteTrackPublication, participant: RemoteParticipant) => {
    const source = publication.source;
    const wanted = isScreenSource(source)
      ? watchedRef.current.has(participant.identity)
      : source === Track.Source.Microphone || source === Track.Source.Camera;
    if (wanted && !publication.isSubscribed) publication.setSubscribed(true);
  }, []);

  const handleSubscribed = useCallback((track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
    const peerId = participant.identity;
    setterFor(publication.source)((current) => withTrack(current, peerId, track.mediaStreamTrack));
    if (publication.source === Track.Source.ScreenShare) {
      optionsRef.current.setScreenPreviews((current) => current[peerId] ? { ...current, [peerId]: { ...current[peerId], live: true } } : current);
    }
  }, []);

  const handleUnsubscribed = useCallback((track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
    const peerId = participant.identity;
    setterFor(publication.source)((current) => withoutTrack(current, peerId, track.mediaStreamTrack.id));
    if (publication.source === Track.Source.ScreenShare) {
      optionsRef.current.setScreenPreviews((current) => current[peerId] ? { ...current, [peerId]: { ...current[peerId], live: false } } : current);
    }
  }, []);

  const forgetEverything = useCallback(() => {
    activeRef.current = false;
    watchedRef.current.clear();
    microphoneRef.current = null;
    publishedRef.current = { camera: [], screen: [] };
    setRemoteStreams({});
    setRemoteCameraStreams({});
    setRemoteScreenStreams({});
  }, []);

  /** Leaves the room. The app keeps ownership of its own tracks, so none is stopped here. */
  const leave = useCallback(() => {
    const room = roomRef.current;
    roomRef.current = null;
    if (room) {
      room.removeAllListeners();
      void room.disconnect(false);
    }
    forgetEverything();
  }, [forgetEverything]);

  /** Asks the server for a token for this channel and connects. Throws with a message fit to show. */
  const join = useCallback(async (channelId: string) => {
    leave();
    const socketId = optionsRef.current.socketRef.current?.id;
    if (!socketId) throw new Error("Sem conexão em tempo real. Tente novamente.");
    const response = await fetch("/api/livekit/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ socketId, channelId }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? "Não foi possível entrar na sala de voz.");
    }
    const { url, token } = await response.json() as { url: string; token: string };

    const room = new Room({ adaptiveStream: false, dynacast: true });
    room.on(RoomEvent.TrackPublished, considerSubscription);
    room.on(RoomEvent.TrackSubscribed, handleSubscribed);
    room.on(RoomEvent.TrackUnsubscribed, handleUnsubscribed);
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      setRemoteStreams((current) => withoutPeer(current, participant.identity));
      setRemoteCameraStreams((current) => withoutPeer(current, participant.identity));
      setRemoteScreenStreams((current) => withoutPeer(current, participant.identity));
    });
    room.on(RoomEvent.Disconnected, () => {
      if (roomRef.current !== room) return;
      roomRef.current = null;
      forgetEverything();
      optionsRef.current.onDisconnected();
    });
    // Nothing is received until asked for: the camera and microphone below, a screen on demand.
    await room.connect(url, token, { autoSubscribe: false });
    roomRef.current = room;
    activeRef.current = true;
    room.remoteParticipants.forEach((participant) => participant.trackPublications.forEach((publication) => considerSubscription(publication, participant)));
    setConnectionVersion((version) => version + 1);
  }, [considerSubscription, forgetEverything, handleSubscribed, handleUnsubscribed, leave]);

  // ---- what this member sends ----

  const publishMicrophone = useCallback(async () => {
    const room = roomRef.current;
    const track = optionsRef.current.localAudioRef.current?.getAudioTracks()[0];
    if (!room || !track) return;
    const existing = microphoneRef.current;
    if (existing?.track && existing.track.mediaStreamTrack === track) return;
    if (existing?.track) {
      await (existing.track as LocalAudioTrack).replaceTrack(track);
      return;
    }
    microphoneRef.current = await room.localParticipant.publishTrack(track, { source: Track.Source.Microphone, name: "microphone", dtx: true });
  }, []);

  useEffect(() => {
    if (connectionVersion === 0) return;
    void publishMicrophone().catch(() => undefined);
  }, [connectionVersion, options.microphoneVersion, publishMicrophone]);

  const syncVideo = useCallback(async (kind: "camera" | "screen", stream: MediaStream | null) => {
    const room = roomRef.current;
    if (!room) return;
    const published = publishedRef.current[kind];
    const wanted = stream?.getTracks() ?? [];
    const unchanged = published.length === wanted.length
      && published.every((publication) => wanted.some((track) => track === publication.track?.mediaStreamTrack));
    if (unchanged) return;
    for (const publication of published) {
      if (publication.track) await room.localParticipant.unpublishTrack(publication.track, false).catch(() => undefined);
    }
    publishedRef.current[kind] = [];
    if (!stream) return;
    const encoding = optionsRef.current.screenEncodingRef.current;
    for (const track of wanted) {
      const isVideo = track.kind === "video";
      const source = kind === "camera" ? Track.Source.Camera : isVideo ? Track.Source.ScreenShare : Track.Source.ScreenShareAudio;
      const publishOptions = kind === "screen" && isVideo && encoding
        ? { source, name: "screen", simulcast: false, videoEncoding: { maxBitrate: encoding.maxBitrate, maxFramerate: encoding.maxFramerate }, degradationPreference: encoding.degradationPreference }
        : { source, name: kind === "camera" ? "camera" : "screen-audio" };
      publishedRef.current[kind].push(await room.localParticipant.publishTrack(track, publishOptions));
    }
  }, []);

  useEffect(() => {
    if (connectionVersion === 0) return;
    void syncVideo("camera", options.cameraStream).catch(() => undefined);
  }, [connectionVersion, options.cameraStream, syncVideo]);

  useEffect(() => {
    if (connectionVersion === 0) return;
    void syncVideo("screen", options.screenStream).catch(() => undefined);
  }, [connectionVersion, options.screenStream, syncVideo]);

  // ---- what this member watches ----

  /** The person chose to watch a member's screen: start receiving it. */
  const subscribeScreen = useCallback((peerId: string) => {
    watchedRef.current.add(peerId);
    const participant = roomRef.current?.remoteParticipants.get(peerId);
    participant?.trackPublications.forEach((publication) => considerSubscription(publication, participant));
  }, [considerSubscription]);

  /** The person stopped watching: stop receiving it, which also saves the sharer's bandwidth. */
  const unsubscribeScreen = useCallback((peerId: string) => {
    watchedRef.current.delete(peerId);
    roomRef.current?.remoteParticipants.get(peerId)?.trackPublications.forEach((publication) => {
      if (isScreenSource(publication.source) && publication.isSubscribed) publication.setSubscribed(false);
    });
  }, []);

  useEffect(() => leave, [leave]);

  return {
    remoteStreams,
    remoteCameraStreams,
    remoteScreenStreams,
    liveKitActiveRef: activeRef,
    joinLiveKit: join,
    leaveLiveKit: leave,
    subscribeScreen,
    unsubscribeScreen,
  };
}
