import type { FileAttachment } from "../types";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export const IMAGE_ATTACHMENT_PATTERN = /\.(png|jpe?g|gif|webp)$/i;

// Detects the real image type from the first bytes; never trusts the file name alone.
export function sniffImageType(bytes: Uint8Array): string | null {
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

// Uploads are served as downloads, so image previews are fetched, verified, and shown from a blob URL.
export function useAttachmentPreviewUrl(file: FileAttachment) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const isImageName = IMAGE_ATTACHMENT_PATTERN.test(file.name);
  useEffect(() => {
    setPreviewUrl(null);
    setStatus(isImageName ? "loading" : "failed");
    if (!isImageName) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const response = await fetch(file.url, { credentials: "same-origin", signal: controller.signal });
        if (!response.ok) {
          if (!controller.signal.aborted) setStatus("failed");
          return;
        }
        const buffer = await response.arrayBuffer();
        const type = sniffImageType(new Uint8Array(buffer, 0, Math.min(12, buffer.byteLength)));
        if (!type || controller.signal.aborted) {
          if (!controller.signal.aborted) setStatus("failed");
          return;
        }
        objectUrl = URL.createObjectURL(new Blob([buffer], { type }));
        setPreviewUrl(objectUrl);
        setStatus("ready");
      } catch {
        if (!controller.signal.aborted) setStatus("failed");
      }
    })();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.url, isImageName]);
  return { previewUrl, status };
}

export function AttachmentLightbox({ file, previewUrl, onClose, showFileName = true }: {
  file: FileAttachment;
  previewUrl: string;
  onClose: () => void;
  showFileName?: boolean;
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    // If the window is hidden (e.g. the desktop close button sends it to the tray), drop the overlay too.
    const closeWhenHidden = () => { if (document.visibilityState === "hidden") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    document.addEventListener("visibilitychange", closeWhenHidden);
    // Desktop app: the window close button closes the image instead of hiding KCord.
    window.kafcordDesktop?.setOverlayOpen?.(true);
    const stopDesktopClose = window.kafcordDesktop?.onCloseOverlay?.(onClose);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("visibilitychange", closeWhenHidden);
      window.kafcordDesktop?.setOverlayOpen?.(false);
      stopDesktopClose?.();
    };
  }, [onClose]);
  return createPortal((
    <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={showFileName ? file.name : "Visualização da captura"} onClick={onClose}>
      <button type="button" className="image-lightbox-close" title="Fechar imagem (Esc)" aria-label="Fechar imagem" onClick={(event) => { event.stopPropagation(); onClose(); }}>×</button>
      <img src={previewUrl} alt={showFileName ? file.name : "Captura de tela"} onClick={(event) => event.stopPropagation()} />
      <div className="image-lightbox-bar" onClick={(event) => event.stopPropagation()}>
        {showFileName && <span>{file.name}</span>}
        <a href={file.url} target="_blank" rel="noreferrer">Baixar</a>
        <button type="button" aria-label="Fechar imagem" onClick={onClose} autoFocus>Fechar <kbd>Esc</kbd></button>
      </div>
    </div>
  ), document.body);
}

export function AttachmentImagePreview({ file }: { file: FileAttachment }) {
  const { previewUrl } = useAttachmentPreviewUrl(file);
  const [expanded, setExpanded] = useState(false);
  if (!previewUrl) return null;
  return (
    <>
      <button type="button" className="attachment-image" title={`Ampliar ${file.name}`} onClick={() => setExpanded(true)}>
        <img src={previewUrl} alt={file.name} loading="lazy" />
      </button>
      {expanded && <AttachmentLightbox file={file} previewUrl={previewUrl} onClose={() => setExpanded(false)} />}
    </>
  );
}
