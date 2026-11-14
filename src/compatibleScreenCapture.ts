// Chromium 151+ forces Windows Graphics Capture for full monitor tracks on
// Windows 11 24H2. This compatibility path uses Electron's independent screen
// snapshot capturer and turns the frames into a bounded-rate canvas track.

type SnapshotBridge = Required<Pick<KafcordDesktopBridge, "captureShareSnapshot">>;

function loadImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("O quadro compatível recebido está inválido."));
    image.src = dataUrl;
  });
}

export async function startCompatibleScreenCapture(
  bridge: SnapshotBridge,
  sourceId: string,
  width: number,
  height: number,
  requestedFps: number,
) {
  const fps = Math.max(2, Math.min(10, Math.round(requestedFps)));
  const first = await bridge.captureShareSnapshot(sourceId, width, height);
  if (!first) throw new Error("O modo compatível não conseguiu capturar esta tela.");
  const firstImage = await loadImage(first.dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = first.width || firstImage.naturalWidth || width;
  canvas.height = first.height || firstImage.naturalHeight || height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("O navegador não criou a superfície de captura compatível.");
  context.drawImage(firstImage, 0, 0, canvas.width, canvas.height);

  const stream = canvas.captureStream(fps);
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error("O navegador não criou a faixa de vídeo compatível.");
  track.contentHint = "motion";
  const interval = Math.round(1000 / fps);
  const isEnded = () => track.readyState === "ended";

  const pump = async () => {
    if (isEnded()) return;
    try {
      const snapshot = await bridge.captureShareSnapshot(sourceId, width, height);
      if (snapshot) {
        const image = await loadImage(snapshot.dataUrl);
        const nextWidth = snapshot.width || image.naturalWidth;
        const nextHeight = snapshot.height || image.naturalHeight;
        if (nextWidth > 0 && nextHeight > 0 && (canvas.width !== nextWidth || canvas.height !== nextHeight)) {
          canvas.width = nextWidth;
          canvas.height = nextHeight;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
      }
    } catch {
      // Keep the last good frame and try again. A transient DXGI reset should
      // not tear down an active call.
    }
    if (!isEnded()) window.setTimeout(() => void pump(), interval);
  };
  window.setTimeout(() => void pump(), interval);
  return stream;
}
