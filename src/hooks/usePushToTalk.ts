import { useCallback, useEffect, useRef, useState } from "react";
import pttPressedSound from "../assets/sounds/ptt_pressed.wav";
import pttReleaseSound from "../assets/sounds/ptt_release.wav";
import { TOUCH_ONLY_QUERY } from "../lib/device";
import type { InputMode } from "../types";

type PushToTalkOptions = {
  voiceChannel: string | null;
  micEnabled: boolean;
  serverMuted: boolean;
  serverDeafened: boolean;
  setNotice: (text: string) => void;
  playInterfaceCue: (source: string) => Promise<void>;
};

/**
 * Voice-activity vs push-to-talk input mode: the PTT key (in-page and the
 * desktop global hook, which also learns the key code), touch-only detection
 * and the press/release sounds. Settings persist in localStorage.
 */
export function usePushToTalk({ voiceChannel, micEnabled, serverMuted, serverDeafened, setNotice, playInterfaceCue }: PushToTalkOptions) {
  const [inputMode, setInputMode] = useState<InputMode>(() => localStorage.getItem("kafcord:input-mode") === "ptt" ? "ptt" : "voice");
  const [pttKey, setPttKey] = useState(() => localStorage.getItem("kafcord:ptt-key") ?? "ShiftRight");
  // Phones and tablets have no keyboard to bind: PTT there is the hold-to-talk mic button.
  const [touchOnly, setTouchOnly] = useState(() => window.matchMedia(TOUCH_ONLY_QUERY).matches);
  const [recordingPttKey, setRecordingPttKey] = useState(false);
  const [pttPressed, setPttPressed] = useState(false);
  const [pttSoundsEnabled, setPttSoundsEnabled] = useState(() => localStorage.getItem("kafcord:ptt-sounds") !== "off");
  const previousPttPressedRef = useRef(false);
  // Key code reported by the desktop global hook for the current PTT key.
  const pttLearnedKeyRef = useRef<{ code: string; keyCode: number } | null>((() => {
    try {
      const stored = JSON.parse(localStorage.getItem("kafcord:ptt-learned-key") ?? "null") as { code?: unknown; keyCode?: unknown } | null;
      return typeof stored?.code === "string" && typeof stored.keyCode === "number" ? { code: stored.code, keyCode: stored.keyCode } : null;
    } catch {
      return null;
    }
  })());
  const pttHookWarningShownRef = useRef(false);

  useEffect(() => {
    const desktopBridge = window.kafcordDesktop;
    if (typeof desktopBridge?.onPttState !== "function") return;
    return desktopBridge.onPttState(setPttPressed);
  }, []);

  useEffect(() => {
    const desktopBridge = window.kafcordDesktop;
    const configurePtt = desktopBridge?.configurePtt;
    if (typeof configurePtt !== "function") return;
    const enabled = inputMode === "ptt" && Boolean(voiceChannel) && micEnabled && !serverMuted && !serverDeafened && !recordingPttKey;
    let active = true;
    const learned = pttLearnedKeyRef.current?.code === pttKey ? pttLearnedKeyRef.current.keyCode : null;
    void configurePtt(pttKey, enabled, learned).then((result) => {
      if (active && enabled && !result.ok) setNotice(result.error ?? "Não foi possível ativar o PTT global.");
    });
    return () => {
      active = false;
      void configurePtt(pttKey, false);
    };
  }, [inputMode, micEnabled, pttKey, recordingPttKey, serverDeafened, serverMuted, setNotice, voiceChannel]);

  useEffect(() => { localStorage.setItem("kafcord:input-mode", inputMode); }, [inputMode]);
  useEffect(() => { localStorage.setItem("kafcord:ptt-key", pttKey); }, [pttKey]);
  useEffect(() => {
    const query = window.matchMedia(TOUCH_ONLY_QUERY);
    const update = () => setTouchOnly(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => { if (touchOnly) setRecordingPttKey(false); }, [touchOnly]);
  useEffect(() => { localStorage.setItem("kafcord:ptt-sounds", pttSoundsEnabled ? "on" : "off"); }, [pttSoundsEnabled]);

  useEffect(() => {
    const wasPressed = previousPttPressedRef.current;
    previousPttPressedRef.current = pttPressed;
    if (wasPressed === pttPressed || inputMode !== "ptt" || !voiceChannel || !micEnabled || !pttSoundsEnabled) return;
    void playInterfaceCue(pttPressed ? pttPressedSound : pttReleaseSound);
  }, [inputMode, micEnabled, playInterfaceCue, pttPressed, pttSoundsEnabled, voiceChannel]);

  // While focused, the desktop hook sees the same key press; remember its code so
  // PTT keeps working out of focus even when the key mapping differs on this PC.
  const learnGlobalPttKey = useCallback((code: string) => {
    const learnPttKey = window.kafcordDesktop?.learnPttKey;
    if (typeof learnPttKey !== "function") return;
    void learnPttKey().then((result) => {
      if (!result.hookRunning) return;
      if (result.keyCode === null) {
        if (!pttHookWarningShownRef.current) {
          pttHookWarningShownRef.current = true;
          setNotice("O PTT global não está recebendo teclas neste computador. O PTT só funcionará com o KCord em foco.");
        }
        return;
      }
      if (pttLearnedKeyRef.current?.code === code && pttLearnedKeyRef.current.keyCode === result.keyCode) return;
      pttLearnedKeyRef.current = { code, keyCode: result.keyCode };
      try {
        localStorage.setItem("kafcord:ptt-learned-key", JSON.stringify(pttLearnedKeyRef.current));
      } catch {
        // Learning still applies for this session.
      }
    }).catch(() => undefined);
  }, [setNotice]);

  useEffect(() => {
    const isTyping = (target: EventTarget | null) => {
      const element = target as HTMLElement | null;
      return element?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element?.tagName ?? "");
    };
    const press = (event: KeyboardEvent) => {
      if (recordingPttKey) {
        event.preventDefault();
        if (event.code !== "Escape") setPttKey(event.code);
        setRecordingPttKey(false);
        return;
      }
      if (inputMode !== "ptt" || event.code !== pttKey || isTyping(event.target)) return;
      event.preventDefault();
      setPttPressed(true);
      if (!event.repeat) learnGlobalPttKey(event.code);
    };
    const release = (event: KeyboardEvent) => {
      if (event.code === pttKey) setPttPressed(false);
    };
    const reset = () => {
      if (typeof window.kafcordDesktop?.onPttState !== "function") setPttPressed(false);
    };
    window.addEventListener("keydown", press);
    window.addEventListener("keyup", release);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", press);
      window.removeEventListener("keyup", release);
      window.removeEventListener("blur", reset);
    };
  }, [inputMode, learnGlobalPttKey, pttKey, recordingPttKey]);

  return {
    inputMode,
    setInputMode,
    pttKey,
    touchOnly,
    recordingPttKey,
    setRecordingPttKey,
    pttPressed,
    setPttPressed,
    pttSoundsEnabled,
    setPttSoundsEnabled,
  };
}
