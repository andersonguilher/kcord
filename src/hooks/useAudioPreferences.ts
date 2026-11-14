import { useCallback, useEffect, useState } from "react";

/**
 * Audio devices and the settings people tune in Settings > Voice (volumes,
 * sensitivity, noise suppression, echo cancellation, voice leveling). Every
 * value is restored from, and saved to, localStorage.
 */
export function useAudioPreferences() {
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [inputDeviceId, setInputDeviceId] = useState(() => localStorage.getItem("kafcord:audio-input") ?? "");
  const [outputDeviceId, setOutputDeviceId] = useState(() => localStorage.getItem("kafcord:audio-output") ?? "");
  const [inputVolume, setInputVolume] = useState(() => Number(localStorage.getItem("kafcord:input-volume") ?? 100));
  const [outputVolume, setOutputVolume] = useState(() => Number(localStorage.getItem("kafcord:output-volume") ?? 100));
  const [inputSensitivity, setInputSensitivity] = useState(() => Number(localStorage.getItem("kafcord:input-sensitivity") ?? 55));
  const [noiseSuppression, setNoiseSuppression] = useState(() => localStorage.getItem("kafcord:noise-suppression") !== "false");
  const [echoCancellation, setEchoCancellation] = useState(() => localStorage.getItem("kafcord:echo-cancellation") !== "false");
  const [voiceLeveling, setVoiceLeveling] = useState(() => localStorage.getItem("kafcord:voice-leveling") !== "false");

  useEffect(() => { localStorage.setItem("kafcord:audio-input", inputDeviceId); }, [inputDeviceId]);
  useEffect(() => { localStorage.setItem("kafcord:audio-output", outputDeviceId); }, [outputDeviceId]);
  useEffect(() => { localStorage.setItem("kafcord:input-volume", String(inputVolume)); }, [inputVolume]);
  useEffect(() => { localStorage.setItem("kafcord:output-volume", String(outputVolume)); }, [outputVolume]);
  useEffect(() => { localStorage.setItem("kafcord:input-sensitivity", String(inputSensitivity)); }, [inputSensitivity]);
  useEffect(() => { localStorage.setItem("kafcord:noise-suppression", String(noiseSuppression)); }, [noiseSuppression]);
  useEffect(() => { localStorage.setItem("kafcord:echo-cancellation", String(echoCancellation)); }, [echoCancellation]);
  useEffect(() => { localStorage.setItem("kafcord:voice-leveling", String(voiceLeveling)); }, [voiceLeveling]);

  const refreshAudioDevices = useCallback(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((device) => device.kind === "audioinput");
    const outputs = devices.filter((device) => device.kind === "audiooutput");
    setAudioInputs(inputs);
    setAudioOutputs(outputs);
    setInputDeviceId((current) => inputs.some((device) => device.deviceId === current) ? current : inputs[0]?.deviceId ?? "");
    setOutputDeviceId((current) => outputs.some((device) => device.deviceId === current) ? current : outputs[0]?.deviceId ?? "");
  }, []);

  useEffect(() => {
    const handleDeviceChange = () => { void refreshAudioDevices(); };
    navigator.mediaDevices?.addEventListener("devicechange", handleDeviceChange);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", handleDeviceChange);
  }, [refreshAudioDevices]);

  return {
    audioInputs,
    audioOutputs,
    refreshAudioDevices,
    inputDeviceId,
    setInputDeviceId,
    outputDeviceId,
    setOutputDeviceId,
    inputVolume,
    setInputVolume,
    outputVolume,
    setOutputVolume,
    inputSensitivity,
    setInputSensitivity,
    noiseSuppression,
    setNoiseSuppression,
    echoCancellation,
    setEchoCancellation,
    voiceLeveling,
    setVoiceLeveling,
  };
}
