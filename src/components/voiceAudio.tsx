import { isAppleMobile } from "../lib/device";
import { blockedRemoteAudio, notifyBlockedAudio, sharedLevelingContext } from "../lib/remoteAudio";
import type { SinkAudioElement } from "../types";
import { useEffect, useRef, useState } from "react";

// Every incoming voice goes through: owner's equalizer -> optional leveling
// (slow automatic gain plus a compressor) -> a limiter so a strong equalizer
// boost cannot clip.
export const VOICE_EQ_BANDS: { label: string; frequency: number; type: BiquadFilterType }[] = [
  { label: "Graves", frequency: 100, type: "lowshelf" },
  { label: "Médio-graves", frequency: 300, type: "peaking" },
  { label: "Médios", frequency: 1000, type: "peaking" },
  { label: "Presença", frequency: 3000, type: "peaking" },
  { label: "Agudos", frequency: 8000, type: "highshelf" },
];

export const FLAT_VOICE_EQ = VOICE_EQ_BANDS.map(() => 0);

export const VOICE_EQ_PRESETS: { label: string; gains: number[] }[] = [
  { label: "Padrão", gains: FLAT_VOICE_EQ },
  { label: "Voz mais clara", gains: [-2, -1, 1, 4, 2] },
  { label: "Menos chiado", gains: [0, 0, 0, -1, -6] },
  { label: "Voz mais encorpada", gains: [4, 2, 0, 0, -1] },
];

export const LEVEL_TARGET_RMS = 0.08;

 // about -22 dBFS while talking
export const LEVEL_SPEECH_RMS = 0.006;

 // below this (about -44 dBFS) counts as silence
export const LEVEL_MIN_GAIN = 0.35;

export const LEVEL_MAX_GAIN = 3;

export function useVoiceChain(stream: MediaStream | null, level: boolean, eqGains: number[]) {
  const [processed, setProcessed] = useState<MediaStream | null>(null);
  const audioTrackId = stream?.getAudioTracks()[0]?.id ?? "";
  const levelRef = useRef(level);
  const eqRef = useRef(eqGains);
  const filtersRef = useRef<BiquadFilterNode[]>([]);

  useEffect(() => {
    levelRef.current = level;
  }, [level]);

  useEffect(() => {
    eqRef.current = eqGains;
    const filters = filtersRef.current;
    filters.forEach((filter, index) => filter.gain.setTargetAtTime(eqGains[index] ?? 0, filter.context.currentTime, 0.05));
  }, [eqGains]);

  useEffect(() => {
    setProcessed(null);
    if (!stream || stream.getAudioTracks().length === 0 || isAppleMobile()) return;
    let context: AudioContext;
    try {
      context = sharedLevelingContext();
    } catch {
      return;
    }
    // Chrome only feeds a remote WebRTC track into Web Audio while a media
    // element is also playing it.
    const keepAlive = new Audio();
    keepAlive.muted = true;
    keepAlive.srcObject = stream;
    void keepAlive.play().catch(() => undefined);

    const source = context.createMediaStreamSource(stream);
    const filters = VOICE_EQ_BANDS.map((band, index) => {
      const filter = context.createBiquadFilter();
      filter.type = band.type;
      filter.frequency.value = band.frequency;
      if (band.type === "peaking") filter.Q.value = 1;
      filter.gain.value = eqRef.current[index] ?? 0;
      return filter;
    });
    filtersRef.current = filters;
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    const gain = context.createGain();
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -20;
    compressor.knee.value = 10;
    compressor.ratio.value = levelRef.current ? 4 : 1;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.25;
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.1;
    const destination = context.createMediaStreamDestination();
    const equalized = filters.reduce<AudioNode>((previous, filter) => previous.connect(filter), source);
    // Leveling measures after the equalizer, so a boost does not change loudness.
    equalized.connect(analyser);
    equalized.connect(gain).connect(compressor).connect(limiter).connect(destination);

    const samples = new Float32Array(analyser.fftSize);
    let loudness = 0;
    let speechTicks = 0;
    const intervalId = window.setInterval(() => {
      if (context.state === "suspended") void context.resume().catch(() => undefined);
      if (!levelRef.current) {
        compressor.ratio.value = 1;
        gain.gain.setTargetAtTime(1, context.currentTime, 0.1);
        return;
      }
      compressor.ratio.value = 4;
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const rms = Math.sqrt(sum / samples.length);
      if (rms < LEVEL_SPEECH_RMS) return;
      // About 3 s of talking to settle, so a shout or a laugh barely moves it.
      loudness = speechTicks === 0 ? rms : loudness * 0.97 + rms * 0.03;
      speechTicks += 1;
      if (speechTicks < 10) return;
      const target = Math.min(LEVEL_MAX_GAIN, Math.max(LEVEL_MIN_GAIN, LEVEL_TARGET_RMS / loudness));
      gain.gain.setTargetAtTime(target, context.currentTime, 0.4);
    }, 100);

    if (context.state === "suspended") void context.resume().catch(() => undefined);
    setProcessed(destination.stream);
    return () => {
      window.clearInterval(intervalId);
      if (filtersRef.current === filters) filtersRef.current = [];
      source.disconnect();
      filters.forEach((filter) => filter.disconnect());
      gain.disconnect();
      compressor.disconnect();
      limiter.disconnect();
      keepAlive.pause();
      keepAlive.srcObject = null;
    };
  }, [stream, audioTrackId]);

  return processed;
}

export function RemoteAudio({ stream, outputDeviceId, outputVolume, level = false, eqGains }: {
  stream: MediaStream | null;
  outputDeviceId: string;
  outputVolume: number;
  level?: boolean;
  // Only voices pass a value; screen-share audio is played untouched.
  eqGains?: number[];
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const voiceStream = useVoiceChain(eqGains ? stream : null, level, eqGains ?? FLAT_VOICE_EQ);
  // While the chain is starting (or unavailable, as on iOS) play the raw voice.
  const playedStream = voiceStream ?? stream;

  useEffect(() => {
    if (!audioRef.current) return;
    const audio = audioRef.current as SinkAudioElement;
    if (audio.srcObject !== playedStream) audio.srcObject = playedStream;
    audio.volume = outputVolume / 100;
    // iOS ignores element volume, so deafen/zero volume must also mute.
    audio.muted = outputVolume <= 0;
    if (!stream) {
      audio.pause();
      blockedRemoteAudio.delete(audio);
      notifyBlockedAudio();
      return;
    }
    void (async () => {
      if (outputDeviceId && audio.setSinkId) await audio.setSinkId(outputDeviceId).catch(() => undefined);
      try {
        await audio.play();
        blockedRemoteAudio.delete(audio);
      } catch {
        blockedRemoteAudio.add(audio);
      }
      notifyBlockedAudio();
    })();
  }, [stream, playedStream, outputDeviceId, outputVolume]);

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      if (!audio) return;
      blockedRemoteAudio.delete(audio);
      notifyBlockedAudio();
    };
  }, []);

  return <audio ref={audioRef} autoPlay playsInline />;
}
