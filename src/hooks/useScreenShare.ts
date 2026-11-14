import { useCallback, useRef, useState, type RefObject } from "react";
import type { Socket } from "socket.io-client";
import { appAudioBridge, startAppAudio, type AppAudioCapture } from "../appAudio";
import { startCompatibleScreenCapture } from "../compatibleScreenCapture";
import { desktopSystemInfo, reportClientIssue } from "../lib/clientReports";
import { screenCaptureSupported } from "../lib/device";
import { SCREEN_THUMBNAIL_REFRESH_MS, formatShareDiagnosis } from "../lib/format";
import { applyScreenEncoding, screenEncodingFor } from "../lib/media";
import { saveVoiceResume } from "../lib/session";
import type { AudioPreferredDisplayOptions, BrowserCaptureControllerConstructor, ScreenEncoding, ScreenSenderBinding, ShareDefinition, ShareQuality } from "../types";

export type ScreenShareOptions = {
  socketRef: RefObject<Socket | null>;
  peersRef: RefObject<Map<string, RTCPeerConnection>>;
  /** One entry per viewer: the senders carrying the shared screen to that viewer. */
  screenSendersRef: RefObject<Map<string, ScreenSenderBinding[]>>;
  voiceChannel: string | null;
  voiceChannelRef: RefObject<string | null>;
  createPeer: (peerId: string) => RTCPeerConnection;
  makeOffer: (peerId: string) => Promise<void>;
  /** True while in the AFK channel, where sharing the screen is not allowed. */
  isBlockedInAfk: () => boolean;
  setNotice: (text: string) => void;
};

/**
 * Sharing the member's own screen or window: the desktop source picker and its
 * options, capture (with app-only audio and the compatible fallback), the
 * thumbnail announced to the room, and sending the stream to each member who
 * chooses to watch. Viewing someone else's screen is separate.
 */
export function useScreenShare(options: ScreenShareOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [screenViewerCount, setScreenViewerCount] = useState(0);
  const [screenResolutionHeight, setScreenResolutionHeight] = useState<number | null>(null);
  const [screenLabel, setScreenLabel] = useState("Tela compartilhada");
  const [showDesktopShareDialog, setShowDesktopShareDialog] = useState(false);
  const [desktopShareType, setDesktopShareType] = useState<"window" | "screen">("window");
  const [desktopShareSources, setDesktopShareSources] = useState<DesktopShareSource[]>([]);
  const [selectedDesktopShareId, setSelectedDesktopShareId] = useState("");
  const [loadingDesktopSources, setLoadingDesktopSources] = useState(false);
  const [desktopShareError, setDesktopShareError] = useState("");
  const [desktopShareAudio, setDesktopShareAudio] = useState(true);
  const [desktopShareQuality, setDesktopShareQuality] = useState<ShareQuality>("games");
  const [desktopShareDefinition, setDesktopShareDefinition] = useState<ShareDefinition>("sd");
  const [showDesktopShareSettings, setShowDesktopShareSettings] = useState(false);
  const [sendingShareDiagnosis, setSendingShareDiagnosis] = useState(false);
  const [missingShareAppName, setMissingShareAppName] = useState("");
  const screenRef = useRef<MediaStream | null>(null);
  const appAudioRef = useRef<AppAudioCapture | null>(null);
  const thumbnailTimerRef = useRef<number | null>(null);
  const thumbnailVideoRef = useRef<HTMLVideoElement | null>(null);
  const latestScreenThumbnailRef = useRef("");
  const screenResolutionRef = useRef<{ width?: number; height?: number }>({});
  const screenEncodingRef = useRef<ScreenEncoding | null>(null);
  const desktopSourcesRequestRef = useRef(0);

  const startThumbnailPublishing = useCallback((stream: MediaStream) => {
    const { socketRef, setNotice } = optionsRef.current;
    const video = document.createElement("video");
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    thumbnailVideoRef.current = video;
    let announced = false;
    const publish = () => {
      if (!video.videoWidth || !video.videoHeight) return false;
      const context = canvas.getContext("2d");
      if (!context) return false;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const thumbnail = canvas.toDataURL("image/jpeg", .42);
      // A static screen yields the same JPEG; skip resending it to the room.
      if (announced && thumbnail === latestScreenThumbnailRef.current) return true;
      latestScreenThumbnailRef.current = thumbnail;
      socketRef.current?.emit(announced ? "screen:thumbnail" : "screen:start", {
        thumbnail,
        resolutionWidth: screenResolutionRef.current.width,
        resolutionHeight: screenResolutionRef.current.height,
      });
      announced = true;
      return true;
    };
    void video.play().then(() => {
      const scheduleNext = () => {
        const sent = publish();
        // Thumbnails go to everyone in the voice room, so refresh them rarely to save data.
        thumbnailTimerRef.current = window.setTimeout(scheduleNext, sent ? SCREEN_THUMBNAIL_REFRESH_MS : 250);
      };
      scheduleNext();
    }).catch(() => setNotice("Não foi possível gerar a miniatura da transmissão."));
  }, []);

  const stopSharing = useCallback(() => {
    const { socketRef, peersRef, screenSendersRef, makeOffer } = optionsRef.current;
    const stream = screenRef.current;
    if (!stream) return;
    screenRef.current = null;
    appAudioRef.current?.stop();
    appAudioRef.current = null;
    setScreenStream(null);
    setScreenViewerCount(0);
    setScreenResolutionHeight(null);
    screenResolutionRef.current = {};
    setScreenLabel("Tela compartilhada");
    socketRef.current?.emit("screen:stop");
    if (thumbnailTimerRef.current !== null) window.clearTimeout(thumbnailTimerRef.current);
    thumbnailTimerRef.current = null;
    thumbnailVideoRef.current?.pause();
    thumbnailVideoRef.current = null;
    latestScreenThumbnailRef.current = "";
    stream.getTracks().forEach((track) => track.stop());
    for (const [peerId, bindings] of screenSendersRef.current ?? []) {
      const peer = peersRef.current?.get(peerId);
      if (peer) {
        bindings.forEach(({ sender }) => peer.removeTrack(sender));
        void makeOffer(peerId).catch(() => undefined);
      }
    }
    screenSendersRef.current?.clear();
  }, []);

  const shareScreenWithViewer = useCallback(async (viewerId: string) => {
    const { socketRef, screenSendersRef, createPeer, makeOffer } = optionsRef.current;
    const stream = screenRef.current;
    if (!stream) return;
    const peer = createPeer(viewerId);
    const bindings = stream.getTracks().map((track) => {
      socketRef.current?.emit("media:track-meta", { target: viewerId, trackId: track.id, kind: "screen" });
      return { sender: peer.addTrack(track, stream) };
    });
    screenSendersRef.current?.set(viewerId, bindings);
    await makeOffer(viewerId);
    const encoding = screenEncodingRef.current;
    if (encoding) await Promise.all(bindings.map(({ sender }) => applyScreenEncoding(sender, encoding)));
  }, []);

  const stopScreenForViewer = useCallback(async (viewerId: string) => {
    const { peersRef, screenSendersRef, makeOffer } = optionsRef.current;
    const peer = peersRef.current?.get(viewerId);
    const bindings = screenSendersRef.current?.get(viewerId);
    if (!peer || !bindings) return;
    bindings.forEach(({ sender }) => peer.removeTrack(sender));
    screenSendersRef.current?.delete(viewerId);
    await makeOffer(viewerId);
  }, []);
  const startScreenShare = async (desktopSourceId?: string) => {
    const { voiceChannel, setNotice } = optionsRef.current;
    if (!voiceChannel) {
      setNotice("Entre em uma sala de voz antes de compartilhar a tela.");
      return;
    }
    let appAudio: AppAudioCapture | null = null;
    let appAudioError = "";
    try {
      const desktopBridge = window.kafcordDesktop;
      // Like Discord: only the shared app's audio (the whole computer minus KCord
      // for a full screen). Falls back to the system loopback when unavailable.
      const appAudioApi = appAudioBridge(desktopBridge);
      if (desktopSourceId && desktopShareAudio && appAudioApi) {
        appAudio = await startAppAudio(appAudioApi, desktopSourceId).catch((error: unknown) => {
          appAudioError = error instanceof Error ? error.message : String(error);
          reportClientIssue("screen-share", new Error(`Som só do aplicativo: ${appAudioError}`), { sourceType: desktopSourceId.split(":")[0] });
          return null;
        });
      }
      const systemInfo = desktopSourceId?.startsWith("screen:") ? await desktopSystemInfo() : null;
      const snapshotCapture = desktopBridge?.captureShareSnapshot;
      const compatibleCapture = Boolean(desktopSourceId?.startsWith("screen:")
        && systemInfo?.screenCaptureMode === "legacy"
        && snapshotCapture);
      const systemAudio = desktopShareAudio && !appAudio && !compatibleCapture;
      if (desktopSourceId?.startsWith("window:")) await desktopBridge?.restoreShareSource?.(desktopSourceId).catch(() => false);
      const CaptureControllerApi = (globalThis as typeof globalThis & {
        CaptureController?: BrowserCaptureControllerConstructor;
      }).CaptureController;
      const captureController = !compatibleCapture && CaptureControllerApi ? new CaptureControllerApi() : undefined;
      captureController?.setFocusBehavior("no-focus-change");
      const fps = desktopBridge
        ? desktopShareQuality === "games" ? 60 : desktopShareQuality === "text" ? 5 : 30
        : 30;
      const width = desktopBridge && desktopShareDefinition === "hd" ? 1920 : 1280;
      const height = desktopBridge && desktopShareDefinition === "hd" ? 1080 : 720;
      const displayOptions: AudioPreferredDisplayOptions = {
        video: {
          width: { ideal: width },
          height: { ideal: height },
          frameRate: { ideal: fps, max: fps },
        },
        audio: desktopBridge && !systemAudio
          ? false
          : { suppressLocalAudioPlayback: false } as MediaTrackConstraints,
        monitorTypeSurfaces: "include",
        selfBrowserSurface: "exclude",
        surfaceSwitching: "include",
        systemAudio: "include",
        windowAudio: "system",
      };
      if (captureController) displayOptions.controller = captureController;
      let audioFallback = compatibleCapture && desktopShareAudio && !appAudio;
      let stream: MediaStream;
      const captureFps = compatibleCapture ? Math.min(fps, 10) : fps;
      if (compatibleCapture && snapshotCapture && desktopSourceId) {
        stream = await startCompatibleScreenCapture({ captureShareSnapshot: snapshotCapture }, desktopSourceId, width, height, captureFps);
      } else {
        if (desktopSourceId && desktopBridge?.selectShareSource && !desktopBridge.selectShareSource(desktopSourceId, systemAudio)) {
          throw new Error("A fonte escolhida não está mais disponível.");
        }
        try {
          stream = await navigator.mediaDevices.getDisplayMedia(displayOptions);
        } catch (error) {
          // Windows sometimes refuses the system audio loopback (no output device,
          // exclusive mode, Bluetooth hands-free). Share the video without audio.
          const audioFailed = error instanceof DOMException
            && error.name === "NotReadableError"
            && /audio/i.test(error.message);
          if (!audioFailed || displayOptions.audio === false) throw error;
          if (desktopSourceId && desktopBridge?.selectShareSource && !desktopBridge.selectShareSource(desktopSourceId, false)) {
            throw new Error("A fonte escolhida não está mais disponível.");
          }
          // A CaptureController works for a single getDisplayMedia call only.
          const retryController = CaptureControllerApi ? new CaptureControllerApi() : undefined;
          retryController?.setFocusBehavior("no-focus-change");
          const retryOptions: AudioPreferredDisplayOptions = { ...displayOptions, audio: false };
          if (retryController) retryOptions.controller = retryController;
          else delete retryOptions.controller;
          stream = await navigator.mediaDevices.getDisplayMedia(retryOptions);
          audioFallback = true;
        }
      }
      if (!captureController && !compatibleCapture) window.focus();
      if (appAudio) {
        stream.addTrack(appAudio.track);
        appAudioRef.current = appAudio;
        appAudio = null;
      }
      const videoTrack = stream.getVideoTracks()[0];
      const shareQuality: ShareQuality = desktopBridge ? desktopShareQuality : "custom";
      if (videoTrack && shareQuality !== "custom") videoTrack.contentHint = shareQuality === "games" ? "motion" : "text";
      screenEncodingRef.current = screenEncodingFor(shareQuality, desktopBridge ? desktopShareDefinition : "sd", captureFps);
      const trackSettings = videoTrack?.getSettings();
      const actualWidth = Math.round(Number(trackSettings?.width ?? width));
      const actualHeight = Math.round(Number(trackSettings?.height ?? height));
      screenResolutionRef.current = {
        width: Number.isFinite(actualWidth) ? actualWidth : undefined,
        height: Number.isFinite(actualHeight) ? actualHeight : undefined,
      };
      screenRef.current = stream;
      setScreenStream(stream);
      setScreenResolutionHeight(Number.isFinite(actualHeight) ? actualHeight : null);
      setScreenLabel(videoTrack?.label || "Tela compartilhada");
      setShowDesktopShareDialog(false);
      setShowDesktopShareSettings(false);
      videoTrack?.addEventListener("ended", stopSharing, { once: true });
      startThumbnailPublishing(stream);
      setNotice(compatibleCapture
        ? appAudioRef.current
          ? `Tela compartilhada no modo compatível a até ${captureFps} fps, com áudio do computador.`
          : `Tela compartilhada no modo compatível a até ${captureFps} fps${audioFallback ? ", sem áudio" : ""}.`
        : audioFallback
        ? "Tela compartilhada sem áudio: o Windows não liberou o som do sistema. Verifique se há um dispositivo de saída de áudio ativo."
        : appAudioRef.current
          ? desktopSourceId?.startsWith("screen:")
            ? "Tela e som do computador estão sendo compartilhados (sem as vozes da chamada)."
            : "Tela e som do aplicativo estão sendo compartilhados."
          : stream.getAudioTracks().length > 0
            ? appAudioError
              ? `Tela e som de todo o computador estão sendo compartilhados (o som só do aplicativo não pôde ser capturado: ${appAudioError}).`
              : "Tela e áudio estão sendo compartilhados."
            : "Tela compartilhada sem áudio. Ative “Compartilhar com áudio” no seletor do navegador.");
    } catch (error) {
      appAudio?.stop();
      const message = error instanceof Error ? error.message : "O compartilhamento de tela foi cancelado.";
      // Closing the picker is not a failure.
      if (!(error instanceof Error && (error.name === "NotAllowedError" || error.name === "AbortError"))) {
        const context: Record<string, string> = desktopSourceId ? { sourceType: desktopSourceId.split(":")[0], sourceId: desktopSourceId } : {};
        // A screen that will not start: send the monitor setup to find out why.
        if (desktopSourceId?.startsWith("screen:") && window.kafcordDesktop?.getDisplayInfo) {
          void window.kafcordDesktop.getDisplayInfo().then((info) => {
            const details = info ? [
              `Tela escolhida: ${desktopSourceId}`,
              `Telas oferecidas: ${info.screens.map((source) => `${source.id} (${source.name})`).join(", ") || "nenhuma"}`,
              "Monitores:",
              ...info.displays.map((display) => `- ${JSON.stringify(display)}`),
            ].join("\n") : "";
            reportClientIssue("screen-share", error, context, details);
          }).catch(() => reportClientIssue("screen-share", error, context));
        } else {
          reportClientIssue("screen-share", error, context);
        }
      }
      if (error instanceof Error && error.name === "NotReadableError" && desktopSourceId?.startsWith("screen:")) {
        void offerCompatibleScreenCapture();
      }
      if (window.kafcordDesktop?.listShareSources && showDesktopShareDialog) setDesktopShareError(message);
      setNotice(message === "Permission denied" ? "O compartilhamento de tela foi cancelado." : message);
    }
  };

  // Windows Graphics Capture cannot start a whole screen on some PCs. Restart
  // into the independent snapshot path, which does not create a WGC video track.
  const offerCompatibleScreenCapture = async () => {
    const { voiceChannelRef, setNotice } = optionsRef.current;
    const desktop = window.kafcordDesktop;
    if (!desktop?.setScreenCaptureMode) return;
    const system = await desktopSystemInfo();
    if (system?.screenCaptureMode !== "wgc") return;
    const accepted = window.confirm("O Windows não iniciou a captura desta tela.\n\nReiniciar o KCord no modo de captura compatível? Você volta para a sala de voz automaticamente.");
    if (!accepted) return;
    saveVoiceResume(voiceChannelRef.current);
    if (!await desktop.setScreenCaptureMode("legacy")) setNotice("Não foi possível trocar o modo de captura.");
  };

  // "App not found": sends what both window lists saw, after the user agrees.
  const sendShareDiagnosis = async () => {
    const { setNotice } = optionsRef.current;
    const desktop = window.kafcordDesktop;
    if (!desktop?.diagnoseShareSources || sendingShareDiagnosis) return;
    const missingApp = missingShareAppName.trim().slice(0, 80);
    if (!missingApp) {
      setNotice("Informe qual aplicativo você esperava encontrar.");
      return;
    }
    if (!window.confirm("Enviar ao administrador do KCord a lista de janelas abertas neste computador (nomes e programas) para descobrir por que o aplicativo não aparece?")) return;
    setSendingShareDiagnosis(true);
    try {
      const diagnosis = await desktop.diagnoseShareSources();
      if (!diagnosis) throw new Error("Diagnóstico indisponível.");
      reportClientIssue(
        "share-sources-missing",
        new Error(`${missingApp} não aparece na lista (${desktopShareSources.length} fontes mostradas)`),
        { sourceType: "window", missingApp },
        `Aplicativo procurado: ${missingApp}\n\n${formatShareDiagnosis(diagnosis)}`,
      );
      setMissingShareAppName("");
      setNotice("Diagnóstico enviado ao administrador. Obrigado!");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Não foi possível montar o diagnóstico.");
    } finally {
      setSendingShareDiagnosis(false);
    }
  };

  const loadDesktopShareSources = async (type: "window" | "screen") => {
    const desktopBridge = window.kafcordDesktop;
    if (!desktopBridge?.listShareSources) return;
    setDesktopShareType(type);
    setSelectedDesktopShareId("");
    setDesktopShareError("");
    setLoadingDesktopSources(true);
    // Only the latest request may fill the list: a slow window listing used to
    // land after a fast screen listing (or the reverse) under the wrong tab.
    const requestId = ++desktopSourcesRequestRef.current;
    let timeoutId: number | undefined;
    try {
      const sources = await Promise.race([
        desktopBridge.listShareSources(type),
        new Promise<never>((_resolve, reject) => {
          timeoutId = window.setTimeout(() => reject(new Error(type === "window"
            ? "O Windows demorou demais para listar os aplicativos. Um programa pode estar travado; tente novamente ou use Tela inteira."
            : "O Windows demorou demais para listar as telas. Tente novamente.")), 15_000);
        }),
      ]);
      if (requestId !== desktopSourcesRequestRef.current) return;
      setDesktopShareSources(sources);
    } catch (error) {
      if (requestId !== desktopSourcesRequestRef.current) return;
      setDesktopShareSources([]);
      setDesktopShareError(error instanceof Error ? error.message : "Não foi possível listar as fontes disponíveis.");
      reportClientIssue("share-sources", error, { sourceType: type });
    } finally {
      window.clearTimeout(timeoutId);
      if (requestId === desktopSourcesRequestRef.current) setLoadingDesktopSources(false);
    }
  };

  const closeDesktopShareDialog = () => {
    desktopSourcesRequestRef.current += 1;
    setLoadingDesktopSources(false);
    setShowDesktopShareDialog(false);
    setShowDesktopShareSettings(false);
    setSelectedDesktopShareId("");
    void window.kafcordDesktop?.cancelShareSelection?.();
  };

  const toggleScreen = async () => {
    const { voiceChannel, isBlockedInAfk, setNotice } = optionsRef.current;
    if (isBlockedInAfk() && !(screenStream)) {
      setNotice("No canal AFK não é possível compartilhar a tela.");
      return;
    }
    if (!voiceChannel) {
      setNotice("Entre em uma sala de voz antes de compartilhar a tela.");
      return;
    }
    if (!screenRef.current && !screenCaptureSupported()) {
      setNotice("Este navegador não permite compartilhar a tela (Android e iPhone não oferecem esse recurso para sites). Use a Live com a câmera ou compartilhe pelo KCord no PC.");
      return;
    }
    if (screenRef.current) {
      stopSharing();
      return;
    }
    if (window.kafcordDesktop?.captureMode !== "system-picker" && window.kafcordDesktop?.listShareSources) {
      setShowDesktopShareSettings(false);
      setShowDesktopShareDialog(true);
      await loadDesktopShareSources("window");
      return;
    }
    await startScreenShare();
  };

  // ---- socket events ----

  /** Someone chose to watch: start sending them the screen. */
  const onViewerJoin = useCallback(({ viewerId }: { viewerId: string }) => {
    void shareScreenWithViewer(viewerId).catch(() => optionsRef.current.setNotice("Não foi possível iniciar a transmissão para esse participante."));
  }, [shareScreenWithViewer]);

  /** A viewer stopped watching: stop sending them the screen. */
  const onViewerLeft = useCallback(({ viewerId }: { viewerId: string }) => {
    void stopScreenForViewer(viewerId).catch(() => undefined);
  }, [stopScreenForViewer]);

  const onViewerCount = useCallback(({ count }: { count?: number }) => {
    const parsedCount = Number(count);
    setScreenViewerCount(Number.isFinite(parsedCount) ? Math.max(0, Math.min(9999, Math.trunc(parsedCount))) : 0);
  }, []);

  const resetViewerCount = useCallback(() => setScreenViewerCount(0), []);

  /** After reconnecting, tells the room again that this screen is live, with its last thumbnail. */
  const resumeScreenAnnouncement = useCallback(() => {
    if (screenRef.current && latestScreenThumbnailRef.current) {
      optionsRef.current.socketRef.current?.emit("screen:start", {
        thumbnail: latestScreenThumbnailRef.current,
        resolutionWidth: screenResolutionRef.current.width,
        resolutionHeight: screenResolutionRef.current.height,
      });
    }
  }, []);

  /** Ends the share without renegotiating, for when every connection is being torn down anyway. */
  const releaseScreenShare = useCallback(() => {
    screenRef.current?.getTracks().forEach((track) => track.stop());
    appAudioRef.current?.stop();
    appAudioRef.current = null;
    if (thumbnailTimerRef.current !== null) window.clearTimeout(thumbnailTimerRef.current);
    thumbnailTimerRef.current = null;
    thumbnailVideoRef.current?.pause();
    thumbnailVideoRef.current = null;
    latestScreenThumbnailRef.current = "";
    screenRef.current = null;
    setScreenStream(null);
    setScreenViewerCount(0);
    setScreenResolutionHeight(null);
    screenResolutionRef.current = {};
  }, []);

  return {
    screenStream,
    screenViewerCount,
    screenResolutionHeight,
    screenLabel,
    screenRef,
    screenEncodingRef,
    latestScreenThumbnailRef,
    screenResolutionRef,
    showDesktopShareDialog,
    desktopShareType,
    desktopShareSources,
    selectedDesktopShareId,
    setSelectedDesktopShareId,
    loadingDesktopSources,
    desktopShareError,
    desktopShareAudio,
    setDesktopShareAudio,
    desktopShareQuality,
    setDesktopShareQuality,
    desktopShareDefinition,
    setDesktopShareDefinition,
    showDesktopShareSettings,
    setShowDesktopShareSettings,
    sendingShareDiagnosis,
    missingShareAppName,
    setMissingShareAppName,
    startScreenShare,
    toggleScreen,
    stopSharing,
    sendShareDiagnosis,
    loadDesktopShareSources,
    closeDesktopShareDialog,
    onViewerJoin,
    onViewerLeft,
    onViewerCount,
    resetViewerCount,
    resumeScreenAnnouncement,
    releaseScreenShare,
  };
}
