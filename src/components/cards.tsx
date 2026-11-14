import { formatFileExpiry, formatSize, formatTime, linkHostname } from "../lib/format";
import { requestLinkPreview } from "../lib/linkPreview";
import type { FileAttachment, LinkPreview } from "../types";
import { AttachmentLightbox, useAttachmentPreviewUrl } from "./attachments";
import { UserAvatar } from "./common";
import { useEffect, useState } from "react";

export function MessageText({ text }: { text: string }) {
  return <p>{text.split(/(https?:\/\/[^\s]+)/gi).map((part, index) => /^https?:\/\//i.test(part)
    ? <a key={`${part}-${index}`} href={part} target="_blank" rel="noopener noreferrer">{part}</a>
    : part)}</p>;
}

export function LinkCard({ url, text, author, authorAvatarUrl, sentAt }: {
  url: string;
  text: string;
  author: string;
  authorAvatarUrl?: string | null;
  sentAt: string;
}) {
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setPreview(null);
    setImageFailed(false);
    void requestLinkPreview(url).then((result) => { if (active) setPreview(result); });
    return () => { active = false; };
  }, [url]);
  const hostname = linkHostname(url);
  const note = text.replace(/https?:\/\/[^\s<>"]+/gi, "").replace(/\s+/g, " ").trim();
  const title = preview?.title || note || hostname;
  const site = preview?.siteName || hostname;
  const showImage = Boolean(preview?.image) && !imageFailed;
  return (
    <a className="link-card" href={url} target="_blank" rel="noopener noreferrer" title={url}>
      <span className="link-card-thumb">
        {showImage
          ? <img src={preview?.image ?? undefined} alt="" loading="lazy" onError={() => setImageFailed(true)} />
          : <span className="link-card-fallback" aria-hidden="true"><b>{hostname.charAt(0).toUpperCase()}</b><small>{hostname}</small></span>}
        <span className="link-card-badge">{site}</span>
      </span>
      <span className="link-card-body">
        <strong>{title}</strong>
        {note && note !== title ? <span className="link-card-note">{note}</span> : null}
        <span className="link-card-meta">
          <UserAvatar name={author} url={authorAvatarUrl} className="avatar link-card-avatar" />
          <span>{author}</span>
          <time>{formatTime(sentAt)}</time>
        </span>
      </span>
    </a>
  );
}

export function ScreenshotCard({ file, author, authorAvatarUrl, sentAt }: {
  file: FileAttachment;
  author: string;
  authorAvatarUrl?: string | null;
  sentAt: string;
}) {
  const { previewUrl, status } = useAttachmentPreviewUrl(file);
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="link-card screenshot-card">
      <button
        type="button"
        className="link-card-thumb screenshot-card-thumb"
        title={previewUrl ? "Ampliar captura" : status === "loading" ? "Carregando captura" : "Prévia da captura indisponível"}
        aria-label={previewUrl ? "Ampliar captura" : status === "loading" ? "Carregando captura" : "Prévia da captura indisponível"}
        aria-busy={status === "loading"}
        disabled={!previewUrl}
        onClick={() => setExpanded(true)}
      >
        {previewUrl
          ? <img src={previewUrl} alt="Captura de tela" loading="lazy" />
          : <span className="link-card-fallback screenshot-card-fallback" aria-hidden="true"><b>▧</b><small>{status === "loading" ? "Carregando captura…" : "Prévia indisponível"}</small></span>}
        <span className="link-card-badge">SCREENSHOT</span>
      </button>
      <span className="link-card-body">
        <span className="link-card-note">
          {formatSize(file.size)}{file.expiresAt ? ` · disponível até ${formatFileExpiry(file.expiresAt)}` : ""}
          <a href={file.url} target="_blank" rel="noreferrer">Baixar original</a>
        </span>
        <span className="link-card-meta">
          <UserAvatar name={author} url={authorAvatarUrl} className="avatar link-card-avatar" />
          <span>{author}</span>
          <time>{formatTime(sentAt)}</time>
        </span>
      </span>
      {expanded && previewUrl && <AttachmentLightbox file={file} previewUrl={previewUrl} showFileName={false} onClose={() => setExpanded(false)} />}
    </div>
  );
}
