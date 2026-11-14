import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { isAppleMobile } from "../lib/device";
import { audioConstraints } from "../lib/media";
import type { InputMode } from "../types";

export type MicrophoneOptions = {
  inputDeviceId: string;
  setInputDeviceId: (deviceId: string) => void;
  inputVolume: number;
  inputSensitivity: number;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  micEnabled: boolean;
  inputMode: InputMode;
  pttPressed: boolean;
  voiceChannel: string | null;
  afkChannelId?: string | null;
  serverMuted: boolean;
  serverDeafened: boolean;
  /** Always holds the room being joined or left, even between renders. */
  voiceChannelRef: RefObject<string | null>;
  /** Peer connections whose outgoing audio track is replaced when the device changes. */
  peersRef: RefObject<Map<string, RTCPeerConnection>>;
  setAudioSettingsError: (message: string) => void;
};

/**
 * The microphone for the call: capture, input gain, the analyser that detects
 * speech, switching device mid-call, and recovering after a phone suspends the
 * capture. The track in `localAudioRef` is what peers send; it is only enabled
 * while the member should actually be heard.
 */
export function useMicrophone(options: MicrophoneOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const {
    inputVolume, inputSensitivity, micEnabled, inputMode, pttPressed, voiceChannel, afkChannelId, serverMuted, serverDeafened,
  } = options;

  const [voiceDetected, setVoiceDetected] = useState(false);
  /** Bumped when the capture was replaced, so the track enabled state is applied again. */
  const [micPipelineVersion, setMicPipelineVersion] = useState(0);
  /** Changes whenever a capture is installed, so a transport that publishes the track can swap it. */
  const [microphoneVersion, setMicrophoneVersion] = useState(0);
  const localAudioRef = useRef<MediaStream | null>(null);
  const rawAudioRef = useRef<MediaStream | null>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const inputGainRef = useRef<GainNode | null>(null);
  const inputAnalyserRef = useRef<AnalyserNode | null>(null);
  const voiceActivityFrameRef = useRef<number | null>(null);
  const recoverMicrophoneRef = useRef<() => Promise<boolean>>(async () => false);

  const createInputPipeline = async (deviceId: string) => {
    const { echoCancellation, noiseSuppression } = optionsRef.current;
    const rawStream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints(deviceId, echoCancellation, noiseSuppression),
      video: false,
    });
    const context = new AudioContext();
    const source = context.createMediaStreamSource(rawStream);
    const gain = context.createGain();
    const analyser = context.createAnalyser();
    gain.gain.value = optionsRef.current.inputVolume / 100;
    analyser.fftSize = 256;
    source.connect(analyser);
    if (context.state === "suspended") await context.resume().catch(() => undefined);
    // Safari distorts a Web Audio destination track sent over WebRTC, so iOS
    // sends the microphone track directly; Web Audio only feeds the meter there.
    if (isAppleMobile()) return { rawStream, context, gain, analyser, stream: rawStream };
    const destination = context.createMediaStreamDestination();
    source.connect(gain).connect(destination);
    return { rawStream, context, gain, analyser, stream: destination.stream };
  };

  const installInputPipeline = (pipeline: Awaited<ReturnType<typeof createInputPipeline>>) => {
    rawAudioRef.current?.getTracks().forEach((track) => track.stop());
    localAudioRef.current?.getTracks().forEach((track) => track.stop());
    if (inputAudioContextRef.current) void inputAudioContextRef.current.close();
    rawAudioRef.current = pipeline.rawStream;
    localAudioRef.current = pipeline.stream;
    inputAudioContextRef.current = pipeline.context;
    inputGainRef.current = pipeline.gain;
    inputAnalyserRef.current = pipeline.analyser;
    setMicrophoneVersion((version) => version + 1);
  };

  useEffect(() => {
    if (inputGainRef.current) inputGainRef.current.gain.value = inputVolume / 100;
  }, [inputVolume]);

  // Speech detection: the input counts as speaking for 260 ms after it last crossed the sensitivity threshold.
  useEffect(() => {
    if (!voiceChannel) {
      setVoiceDetected(false);
      return;
    }
    const samples = new Uint8Array(256);
    let lastVoiceAt = 0;
    const measure = (time: number) => {
      const analyser = inputAnalyserRef.current;
      if (analyser) {
        analyser.getByteTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length);
        const threshold = .085 - (Math.min(100, Math.max(0, inputSensitivity)) * .00072);
        if (rms >= threshold) lastVoiceAt = time;
        setVoiceDetected(time - lastVoiceAt < 260);
      }
      voiceActivityFrameRef.current = requestAnimationFrame(measure);
    };
    voiceActivityFrameRef.current = requestAnimationFrame(measure);
    return () => {
      if (voiceActivityFrameRef.current !== null) cancelAnimationFrame(voiceActivityFrameRef.current);
      voiceActivityFrameRef.current = null;
      setVoiceDetected(false);
    };
  }, [inputSensitivity, voiceChannel]);

  // The outgoing track is only live while the member should be heard.
  useEffect(() => {
    const inAfkChannel = Boolean(voiceChannel && voiceChannel === afkChannelId);
    const shouldTransmit = !inAfkChannel && micEnabled && !serverMuted && !serverDeafened && (inputMode === "voice" || pttPressed);
    localAudioRef.current?.getAudioTracks().forEach((track) => { track.enabled = shouldTransmit; });
  }, [afkChannelId, inputMode, micEnabled, micPipelineVersion, pttPressed, serverDeafened, serverMuted, voiceChannel]);

  /** Opens the microphone for a call; `enabled` is whether it starts out transmitting. */
  const startMicrophone = async (deviceId: string, enabled: boolean) => {
    const pipeline = await createInputPipeline(deviceId);
    pipeline.stream.getAudioTracks().forEach((track) => {
      track.enabled = enabled;
    });
    installInputPipeline(pipeline);
  };

  /** Stops the capture and forgets every audio node. */
  const releaseMicrophone = () => {
    localAudioRef.current?.getTracks().forEach((track) => track.stop());
    rawAudioRef.current?.getTracks().forEach((track) => track.stop());
    rawAudioRef.current = null;
    if (inputAudioContextRef.current) void inputAudioContextRef.current.close();
    inputAudioContextRef.current = null;
    inputGainRef.current = null;
    inputAnalyserRef.current = null;
    localAudioRef.current = null;
  };

  /** Phones suspend or interrupt the mic's AudioContext; any gesture may bring it back. */
  const resumeInputContext = useCallback(() => {
    const inputContext = inputAudioContextRef.current;
    if (inputContext && inputContext.state !== "running") void inputContext.resume().catch(() => undefined);
  }, []);

  /** Switches microphone during a call, replacing the track every peer is already sending. */
  const changeInputDevice = async (deviceId: string) => {
    const { inputDeviceId, setInputDeviceId, micEnabled: enabled, inputMode: mode, pttPressed: pressed, peersRef, setAudioSettingsError } = optionsRef.current;
    const previous = inputDeviceId;
    setInputDeviceId(deviceId);
    if (!localAudioRef.current) return;
    try {
      const pipeline = await createInputPipeline(deviceId);
      const replacementTrack = pipeline.stream.getAudioTracks()[0];
      replacementTrack.enabled = enabled && (mode === "voice" || pressed);
      const oldTrack = localAudioRef.current.getAudioTracks()[0];
      await Promise.all([...(peersRef.current?.values() ?? [])].map(async (peer) => {
        const sender = peer.getSenders().find((candidate) => candidate.track?.id === oldTrack?.id || candidate.track?.kind === "audio");
        if (sender) await sender.replaceTrack(replacementTrack);
      }));
      installInputPipeline(pipeline);
    } catch {
      setInputDeviceId(previous);
      setAudioSettingsError("Não foi possível trocar o microfone durante a chamada.");
    }
  };

  // iOS ends or mutes the microphone capture while the app is in background.
  // Returns true when a fresh microphone track had to be installed.
  const recoverMicrophone = async () => {
    const { voiceChannelRef, inputDeviceId } = optionsRef.current;
    const current = rawAudioRef.current?.getAudioTracks()[0];
    if (!voiceChannelRef.current || !localAudioRef.current) return false;
    if (current?.readyState === "live" && current.muted) {
      // Give the system a moment to hand the microphone back by itself.
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
    }
    if (current?.readyState === "live" && !current.muted) return false;
    const pipeline = await createInputPipeline(inputDeviceId);
    pipeline.stream.getAudioTracks().forEach((track) => { track.enabled = false; });
    installInputPipeline(pipeline);
    setMicPipelineVersion((version) => version + 1);
    return true;
  };
  recoverMicrophoneRef.current = recoverMicrophone;

  return {
    voiceDetected,
    microphoneVersion,
    localAudioRef,
    rawAudioRef,
    inputAudioContextRef,
    recoverMicrophoneRef,
    startMicrophone,
    releaseMicrophone,
    resumeInputContext,
    changeInputDevice,
  };
}
