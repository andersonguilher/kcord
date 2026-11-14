import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { Socket } from "socket.io-client";
import { fallbackRtcConfiguration, tuneOutgoingMedia } from "../lib/media";
import type { RemoteTrackKind, RtcConfigResponse, ScreenPreview, ScreenSenderBinding, Signal } from "../types";

export type PeerConnectionOptions = {
  socketRef: RefObject<Socket | null>;
  /** The microphone stream every peer receives. */
  localAudioRef: RefObject<MediaStream | null>;
  /** The local camera, sent to peers that join while it is on. */
  cameraRef: RefObject<MediaStream | null>;
  /** One connection per other member in the room, by socket id. Shared with the microphone and sharing code. */
  peersRef: RefObject<Map<string, RTCPeerConnection>>;
  cameraSendersRef: RefObject<Map<string, RTCRtpSender>>;
  screenSendersRef: RefObject<Map<string, ScreenSenderBinding[]>>;
  /** The screen being watched, which decides how an untagged incoming video track is routed. */
  activeScreenPeerIdRef: RefObject<string | null>;
  setScreenPreviews: Dispatch<SetStateAction<Record<string, ScreenPreview>>>;
  setActiveScreenPeerId: Dispatch<SetStateAction<string | null>>;
  setExpandedScreenPeerId: Dispatch<SetStateAction<string | null>>;
  setNotice: (text: string) => void;
};

type Streams = Record<string, MediaStream>;
const without = <T>(record: Record<string, T>, key: string) => {
  const next = { ...record };
  delete next[key];
  return next;
};

/**
 * The WebRTC mesh: one RTCPeerConnection per other member in the voice room,
 * offer/answer and ICE exchange over the socket, and routing of the incoming
 * tracks into remote audio, camera and screen streams. Everything returned
 * with a stable identity is safe to register once as a socket handler.
 */
export function usePeerConnections(options: PeerConnectionOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [remoteStreams, setRemoteStreams] = useState<Streams>({});
  const [remoteCameraStreams, setRemoteCameraStreams] = useState<Streams>({});
  const [remoteScreenStreams, setRemoteScreenStreams] = useState<Streams>({});
  /** ICE candidates that arrived before their peer had a remote description. */
  const pendingIceCandidatesRef = useRef(new Map<string, RTCIceCandidateInit[]>());
  const rtcConfigurationRef = useRef<RTCConfiguration>(fallbackRtcConfiguration);
  const rtcConfigurationPromiseRef = useRef<Promise<RTCConfiguration> | null>(null);
  /** Voice channels the server serves through LiveKit; every other channel uses this peer-to-peer mesh. */
  const livekitChannelIdsRef = useRef<string[] | "*">([]);
  /** What the sender said each incoming video track is (camera or screen), by `peerId:trackId`. */
  const remoteTrackKindsRef = useRef(new Map<string, RemoteTrackKind>());

  const closePeer = useCallback((peerId: string) => {
    const { peersRef, cameraSendersRef, screenSendersRef, setScreenPreviews, setActiveScreenPeerId, setExpandedScreenPeerId } = optionsRef.current;
    peersRef.current?.get(peerId)?.close();
    peersRef.current?.delete(peerId);
    pendingIceCandidatesRef.current.delete(peerId);
    cameraSendersRef.current?.delete(peerId);
    screenSendersRef.current?.delete(peerId);
    setRemoteStreams((current) => without(current, peerId));
    setRemoteCameraStreams((current) => without(current, peerId));
    setRemoteScreenStreams((current) => without(current, peerId));
    setScreenPreviews((current) => without(current, peerId));
    setActiveScreenPeerId((current) => current === peerId ? null : current);
    setExpandedScreenPeerId((current) => current === peerId ? null : current);
  }, []);

  /** Closes every connection and forgets all remote media, e.g. when leaving the room. */
  const resetRemoteVoiceConnections = useCallback(() => {
    const { peersRef, cameraSendersRef, screenSendersRef, activeScreenPeerIdRef, setScreenPreviews, setActiveScreenPeerId, setExpandedScreenPeerId } = optionsRef.current;
    peersRef.current?.forEach((peer) => peer.close());
    peersRef.current?.clear();
    pendingIceCandidatesRef.current.clear();
    cameraSendersRef.current?.clear();
    screenSendersRef.current?.clear();
    remoteTrackKindsRef.current.clear();
    setRemoteStreams({});
    setRemoteCameraStreams({});
    setRemoteScreenStreams({});
    setScreenPreviews({});
    activeScreenPeerIdRef.current = null;
    setActiveScreenPeerId(null);
    setExpandedScreenPeerId(null);
  }, []);

  const createPeer = useCallback((peerId: string) => {
    const { socketRef, localAudioRef, cameraRef, peersRef, cameraSendersRef, activeScreenPeerIdRef, setScreenPreviews } = optionsRef.current;
    const existing = peersRef.current?.get(peerId);
    if (existing) return existing;

    const peer = new RTCPeerConnection(rtcConfigurationRef.current);
    localAudioRef.current?.getTracks().forEach((track) => peer.addTrack(track, localAudioRef.current as MediaStream));
    const cameraTrack = cameraRef.current?.getVideoTracks()[0];
    if (cameraTrack && cameraRef.current) {
      socketRef.current?.emit("media:track-meta", { target: peerId, trackId: cameraTrack.id, kind: "camera" });
      cameraSendersRef.current?.set(peerId, peer.addTrack(cameraTrack, cameraRef.current));
    }

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current?.emit("rtc:signal", { target: peerId, candidate: event.candidate.toJSON() });
      }
    };
    peer.ontrack = (event) => {
      const trackKey = `${peerId}:${event.track.id}`;
      const declaredKind = remoteTrackKindsRef.current.get(trackKey);
      remoteTrackKindsRef.current.delete(trackKey);
      const kind = declaredKind
        ?? (event.track.kind === "audio" ? "audio" : activeScreenPeerIdRef.current === peerId ? "screen" : "camera");
      const update = kind === "audio" ? setRemoteStreams : kind === "screen" ? setRemoteScreenStreams : setRemoteCameraStreams;
      update((current) => {
        // A new camera or screen video replaces the previous one: the old track stays live but
        // muted forever, and a video element would keep playing that first, frozen track.
        const stream = (kind === "screen" || kind === "camera") && event.track.kind === "video"
          ? new MediaStream((current[peerId]?.getTracks() ?? []).filter((track) => track.kind !== "video" && track.readyState === "live"))
          : current[peerId] ?? new MediaStream();
        if (!stream.getTracks().some((track) => track.id === event.track.id)) {
          stream.addTrack(event.track);
        }
        return { ...current, [peerId]: stream };
      });
      if (kind === "screen" && event.track.kind === "video") {
        setScreenPreviews((current) => current[peerId]
          ? { ...current, [peerId]: { ...current[peerId], live: !event.track.muted } }
          : current);
        event.track.addEventListener("mute", () => {
          setScreenPreviews((current) => current[peerId]
            ? { ...current, [peerId]: { ...current[peerId], live: false } }
            : current);
        });
        event.track.addEventListener("unmute", () => {
          setScreenPreviews((current) => current[peerId]
            ? { ...current, [peerId]: { ...current[peerId], live: true } }
            : current);
        });
      }
      event.track.addEventListener("ended", () => {
        update((current) => {
          const stream = current[peerId];
          if (!stream) return current;
          stream.removeTrack(event.track);
          if (stream.getTracks().length > 0) return { ...current, [peerId]: stream };
          return without(current, peerId);
        });
        if (kind === "screen" && event.track.kind === "video") {
          setScreenPreviews((current) => current[peerId]
            ? { ...current, [peerId]: { ...current[peerId], live: false } }
            : current);
        }
      });
    };
    peer.onconnectionstatechange = () => {
      if (["failed", "closed"].includes(peer.connectionState)) closePeer(peerId);
    };
    peersRef.current?.set(peerId, peer);
    return peer;
  }, [closePeer]);

  const makeOffer = useCallback(async (peerId: string) => {
    const { socketRef, cameraRef } = optionsRef.current;
    const peer = createPeer(peerId);
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    socketRef.current?.emit("rtc:signal", { target: peerId, description: peer.localDescription });
    void tuneOutgoingMedia(peer, cameraRef.current?.getVideoTracks()[0]?.id);
  }, [createPeer]);

  /** ICE servers (STUN plus short-lived TURN credentials), fetched once; falls back to public STUN. */
  const loadRtcConfiguration = useCallback(async () => {
    if (!rtcConfigurationPromiseRef.current) {
      rtcConfigurationPromiseRef.current = fetch("/api/rtc-config", { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) throw new Error("RTC config unavailable");
          const result = await response.json() as RtcConfigResponse;
          const configuration: RTCConfiguration = {
            iceServers: result.iceServers?.length ? result.iceServers : fallbackRtcConfiguration.iceServers,
            iceTransportPolicy: result.iceTransportPolicy ?? "all",
            iceCandidatePoolSize: 8,
          };
          rtcConfigurationRef.current = configuration;
          livekitChannelIdsRef.current = result.livekitChannelIds ?? [];
          return configuration;
        })
        .catch(() => fallbackRtcConfiguration);
    }
    return rtcConfigurationPromiseRef.current;
  }, []);

  useEffect(() => { void loadRtcConfiguration(); }, [loadRtcConfiguration]);

  /** True when the server serves this voice channel through LiveKit. Known once the configuration has loaded. */
  const isLiveKitChannel = useCallback((channelId: string) => {
    const channels = livekitChannelIdsRef.current;
    return channels === "*" || channels.includes(channelId);
  }, []);

  // ---- socket events ----

  /** The server lists who is already in the room: the newcomer offers to each of them. */
  const onVoicePeers = useCallback(async (peerIds: string[]) => {
    for (const peerId of peerIds) await makeOffer(peerId);
  }, [makeOffer]);

  /** The sender says what its next video track is, so the receiver can route it. */
  const onTrackMeta = useCallback(({ from, trackId, kind }: { from: string; trackId: string; kind: RemoteTrackKind }) => {
    remoteTrackKindsRef.current.set(`${from}:${trackId}`, kind);
  }, []);

  /** Offer, answer and ICE candidates from another member. Candidates wait until their description is set. */
  const onRtcSignal = useCallback(async ({ from, description, candidate }: Signal & { from: string }) => {
    const { socketRef, cameraRef, setNotice } = optionsRef.current;
    try {
      const peer = createPeer(from);
      if (description) {
        await peer.setRemoteDescription(description);
        const queuedCandidates = pendingIceCandidatesRef.current.get(from) ?? [];
        pendingIceCandidatesRef.current.delete(from);
        for (const queuedCandidate of queuedCandidates) await peer.addIceCandidate(queuedCandidate);
        if (description.type === "offer") {
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          socketRef.current?.emit("rtc:signal", { target: from, description: peer.localDescription });
          void tuneOutgoingMedia(peer, cameraRef.current?.getVideoTracks()[0]?.id);
        }
      }
      if (candidate) {
        if (peer.remoteDescription) await peer.addIceCandidate(candidate);
        else pendingIceCandidatesRef.current.set(from, [
          ...(pendingIceCandidatesRef.current.get(from) ?? []),
          candidate,
        ]);
      }
    } catch {
      setNotice("Não foi possível sincronizar uma conexão de voz.");
    }
  }, [createPeer]);

  /** Stops showing someone's shared screen without touching their other media. */
  const dropRemoteScreenStream = useCallback((peerId: string) => {
    setRemoteScreenStreams((current) => without(current, peerId));
  }, []);

  return {
    remoteStreams,
    remoteCameraStreams,
    remoteScreenStreams,
    loadRtcConfiguration,
    isLiveKitChannel,
    createPeer,
    closePeer,
    makeOffer,
    resetRemoteVoiceConnections,
    dropRemoteScreenStream,
    onVoicePeers,
    onTrackMeta,
    onRtcSignal,
  };
}
