import type { ScreenEncoding, ShareDefinition, ShareQuality } from "../types";
import { isTouchOnlyDevice } from "./device";

export function audioConstraints(deviceId: string, echoCancellation = true, noiseSuppression = true): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation,
    noiseSuppression,
    autoGainControl: true,
  };
}

export const fallbackRtcConfiguration: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.l.google.com:19302" },
  ],
  iceCandidatePoolSize: 8,
};

// Without these, Chromium treats every screen share as slides: it keeps the
// resolution and drops frames, and caps the bitrate low, so games stutter.
export const SCREEN_AUDIO_BITRATE = 128_000;

export function screenEncodingFor(quality: ShareQuality, definition: ShareDefinition, fps: number): ScreenEncoding {
  const hd = definition === "hd";
  if (quality === "games") return { maxBitrate: hd ? 8_000_000 : 4_500_000, maxFramerate: fps, degradationPreference: "maintain-framerate" };
  if (quality === "text") return { maxBitrate: hd ? 2_500_000 : 1_500_000, maxFramerate: fps, degradationPreference: "maintain-resolution" };
  return { maxBitrate: hd ? 5_000_000 : 3_000_000, maxFramerate: fps, degradationPreference: "balanced" };
}

export async function applyScreenEncoding(sender: RTCRtpSender, encoding: ScreenEncoding) {
  if (sender.track?.kind === "audio") {
    // Game and app audio needs more than Opus' 32 kbps voice default.
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) return;
    parameters.encodings = parameters.encodings.map((current) => ({ ...current, maxBitrate: SCREEN_AUDIO_BITRATE }));
    await sender.setParameters(parameters).catch(() => undefined);
    return;
  }
  if (sender.track?.kind !== "video") return;
  const parameters = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string };
  if (!parameters.encodings?.length) return;
  parameters.encodings = parameters.encodings.map((current) => ({
    ...current,
    maxBitrate: encoding.maxBitrate,
    maxFramerate: encoding.maxFramerate,
  }));
  parameters.degradationPreference = encoding.degradationPreference;
  await sender.setParameters(parameters).catch(() => undefined);
}

// Mesh calls send the camera once per peer, so an uncapped 720p stream can
// starve the voice track on phones. Voice gets network priority and the camera
// gets a bitrate ceiling; the screen share keeps its own quality settings.
export async function tuneOutgoingMedia(peer: RTCPeerConnection, cameraTrackId: string | undefined) {
  const mobile = isTouchOnlyDevice();
  await Promise.all(peer.getSenders().map(async (sender) => {
    const track = sender.track;
    if (!track) return;
    const isAudio = track.kind === "audio";
    if (!isAudio && track.id !== cameraTrackId) return;
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) return;
    parameters.encodings = parameters.encodings.map((encoding) => (isAudio
      ? { ...encoding, priority: "high", networkPriority: "high" }
      : {
        ...encoding,
        maxBitrate: mobile ? 350_000 : 900_000,
        maxFramerate: mobile ? 20 : 30,
        priority: "low",
        networkPriority: "low",
      }) as RTCRtpEncodingParameters);
    await sender.setParameters(parameters).catch(() => undefined);
  }));
}
