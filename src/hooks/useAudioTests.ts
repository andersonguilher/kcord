import { useCallback, useEffect, useRef, useState } from "react";
import { audioConstraints } from "../lib/media";
import type { SinkAudioElement } from "../types";

type AudioTestOptions = {
  inputDeviceId: string;
  outputDeviceId: string;
  inputVolume: number;
  outputVolume: number;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  refreshAudioDevices: () => Promise<void>;
  setAudioSettingsError: (message: string) => void;
};

/** The Settings > Voice microphone monitor (with level meter) and the output test tone. */
export function useAudioTests({
  inputDeviceId,
  outputDeviceId,
  inputVolume,
  outputVolume,
  echoCancellation,
  noiseSuppression,
  refreshAudioDevices,
  setAudioSettingsError,
}: AudioTestOptions) {
  const [testingMicrophone, setTestingMicrophone] = useState(false);
  // The mic test plays back through the same chain as call voices (owner
  // equalizer and leveling), so you hear yourself as the others hear you.
  const [microphoneTestStream, setMicrophoneTestStream] = useState<MediaStream | null>(null);
  const [testingOutput, setTestingOutput] = useState(false);
  const [microphoneLevel, setMicrophoneLevel] = useState(0);
  const microphoneTestStreamRef = useRef<MediaStream | null>(null);
  const microphoneTestContextRef = useRef<AudioContext | null>(null);
  const microphoneTestFrameRef = useRef<number | null>(null);

  const stopMicrophoneTest = useCallback(() => {
    if (microphoneTestFrameRef.current !== null) cancelAnimationFrame(microphoneTestFrameRef.current);
    microphoneTestFrameRef.current = null;
    microphoneTestStreamRef.current?.getTracks().forEach((track) => track.stop());
    microphoneTestStreamRef.current = null;
    if (microphoneTestContextRef.current) void microphoneTestContextRef.current.close();
    microphoneTestContextRef.current = null;
    setTestingMicrophone(false);
    setMicrophoneTestStream(null);
    setMicrophoneLevel(0);
  }, []);

  useEffect(() => () => stopMicrophoneTest(), [stopMicrophoneTest]);

  const toggleMicrophoneTest = async () => {
    if (testingMicrophone) {
      stopMicrophoneTest();
      return;
    }
    setAudioSettingsError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints(inputDeviceId, echoCancellation, noiseSuppression),
        video: false,
      });
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      const inputGain = context.createGain();
      const monitorDestination = context.createMediaStreamDestination();
      analyser.fftSize = 256;
      inputGain.gain.value = inputVolume / 100;
      context.createMediaStreamSource(stream).connect(inputGain);
      inputGain.connect(analyser);
      inputGain.connect(monitorDestination);
      microphoneTestStreamRef.current = stream;
      microphoneTestContextRef.current = context;
      if (context.state === "suspended") await context.resume();
      setMicrophoneTestStream(monitorDestination.stream);
      const samples = new Uint8Array(analyser.fftSize);
      setTestingMicrophone(true);
      const measure = () => {
        analyser.getByteTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length);
        setMicrophoneLevel(Math.min(100, Math.round(rms * 320)));
        microphoneTestFrameRef.current = requestAnimationFrame(measure);
      };
      measure();
      await refreshAudioDevices();
    } catch {
      stopMicrophoneTest();
      setAudioSettingsError("Não foi possível monitorar o microfone na saída selecionada.");
    }
  };

  const testOutput = async () => {
    setTestingOutput(true);
    setAudioSettingsError("");
    try {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const destination = context.createMediaStreamDestination();
      const audio = new Audio() as SinkAudioElement;
      audio.volume = outputVolume / 100;
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(520, context.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(780, context.currentTime + .55);
      gain.gain.setValueAtTime(.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(.12, context.currentTime + .04);
      gain.gain.exponentialRampToValueAtTime(.0001, context.currentTime + .7);
      oscillator.connect(gain).connect(destination);
      audio.srcObject = destination.stream;
      if (outputDeviceId && audio.setSinkId) await audio.setSinkId(outputDeviceId);
      await audio.play();
      oscillator.start();
      oscillator.stop(context.currentTime + .72);
      await new Promise((resolve) => window.setTimeout(resolve, 850));
      audio.pause();
      destination.stream.getTracks().forEach((track) => track.stop());
      await context.close();
    } catch {
      setAudioSettingsError("Não foi possível reproduzir o teste no dispositivo selecionado.");
    } finally {
      setTestingOutput(false);
    }
  };

  return {
    testingMicrophone,
    microphoneTestStream,
    testingOutput,
    microphoneLevel,
    toggleMicrophoneTest,
    testOutput,
    stopMicrophoneTest,
    microphoneTestStreamRef,
  };
}
