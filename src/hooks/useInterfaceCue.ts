import { useCallback, useEffect, useRef } from "react";
import type { SinkAudioElement } from "../types";

/** Plays short interface sounds (join, leave, push-to-talk) on the chosen output device. */
export function useInterfaceCue(outputDeviceId: string, outputVolume: number) {
  const interfaceCueAudioRef = useRef<SinkAudioElement | null>(null);

  const playInterfaceCue = useCallback(async (source: string) => {
    interfaceCueAudioRef.current?.pause();
    const audio = new Audio(source) as SinkAudioElement;
    audio.preload = "auto";
    audio.volume = outputVolume / 100;
    interfaceCueAudioRef.current = audio;
    if (outputDeviceId && audio.setSinkId) {
      await audio.setSinkId(outputDeviceId).catch(() => undefined);
    }
    audio.addEventListener("ended", () => {
      if (interfaceCueAudioRef.current === audio) interfaceCueAudioRef.current = null;
    }, { once: true });
    await audio.play().catch(() => undefined);
  }, [outputDeviceId, outputVolume]);

  useEffect(() => () => {
    interfaceCueAudioRef.current?.pause();
    interfaceCueAudioRef.current = null;
  }, []);

  return { playInterfaceCue };
}
