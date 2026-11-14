import { useCallback, useRef, useState, type RefObject } from "react";
import type { Socket } from "socket.io-client";
import { isTouchOnlyDevice } from "../lib/device";

export type CameraOptions = {
  /** The local camera stream, also read by the peer layer to send it to members who join later. */
  cameraRef: RefObject<MediaStream | null>;
  peersRef: RefObject<Map<string, RTCPeerConnection>>;
  /** The sender each peer uses for the camera video, so it can be removed again. */
  cameraSendersRef: RefObject<Map<string, RTCRtpSender>>;
  socketRef: RefObject<Socket | null>;
  /** Renegotiates with one peer after its tracks changed. */
  makeOffer: (peerId: string) => Promise<void>;
  voiceChannel: string | null;
  /** True while in the AFK channel, where the camera cannot be turned on. */
  isBlockedInAfk: () => boolean;
  setNotice: (text: string) => void;
};

/** The member's own camera: turning it on for everyone in the room, and off again. */
export function useCamera(options: CameraOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);

  /** Turns the camera off and tells every peer, which renegotiates without the video. */
  const stopCamera = useCallback(() => {
    const { cameraRef, peersRef, cameraSendersRef, makeOffer } = optionsRef.current;
    const stream = cameraRef.current;
    if (!stream) return;
    cameraRef.current = null;
    setCameraStream(null);
    stream.getTracks().forEach((track) => track.stop());
    for (const [peerId, sender] of cameraSendersRef.current ?? []) {
      const peer = peersRef.current?.get(peerId);
      if (peer) {
        peer.removeTrack(sender);
        void makeOffer(peerId).catch(() => undefined);
      }
    }
    cameraSendersRef.current?.clear();
  }, []);

  /** Stops the capture without renegotiating, for when every connection is being torn down anyway. */
  const releaseCamera = useCallback(() => {
    const { cameraRef } = optionsRef.current;
    cameraRef.current?.getTracks().forEach((track) => track.stop());
    cameraRef.current = null;
    setCameraStream(null);
  }, []);

  const toggleCamera = async () => {
    const { cameraRef, peersRef, cameraSendersRef, socketRef, makeOffer, voiceChannel, isBlockedInAfk, setNotice } = optionsRef.current;
    if (isBlockedInAfk() && !(cameraRef.current)) {
      setNotice("No canal AFK não é possível ligar a câmera.");
      return;
    }
    if (!voiceChannel) {
      setNotice("Entre em uma sala de voz antes de ligar a câmera.");
      return;
    }
    if (cameraRef.current) {
      stopCamera();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: isTouchOnlyDevice()
          ? { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 20, max: 24 } }
          : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
        audio: false,
      });
      cameraRef.current = stream;
      setCameraStream(stream);
      const track = stream.getVideoTracks()[0];
      track.addEventListener("ended", stopCamera, { once: true });
      for (const [peerId, peer] of peersRef.current ?? []) {
        socketRef.current?.emit("media:track-meta", { target: peerId, trackId: track.id, kind: "camera" });
        cameraSendersRef.current?.set(peerId, peer.addTrack(track, stream));
        await makeOffer(peerId);
      }
    } catch {
      setNotice("A câmera não pôde ser aberta. Verifique a permissão do navegador.");
    }
  };

  return { cameraStream, toggleCamera, stopCamera, releaseCamera };
}
