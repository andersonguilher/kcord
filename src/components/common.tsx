import { initials } from "../lib/format";
import type { CallIconKind } from "../types";
import { type MouseEvent as ReactMouseEvent, type ReactNode, useEffect, useRef, useState } from "react";

export function CallIcon({ kind }: { kind: CallIconKind }) {
  const paths: Record<CallIconKind, ReactNode> = {
    mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" /></>,
    headphones: <><path d="M4 14v-2a8 8 0 0 1 16 0v2" /><path d="M4 14a2 2 0 0 1 2-2h2v8H6a2 2 0 0 1-2-2zM20 14a2 2 0 0 0-2-2h-2v8h2a2 2 0 0 0 2-2z" /></>,
    "mic-off": <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6M3 3l18 18" /></>,
    "headphones-off": <><path d="M4 14v-2a8 8 0 0 1 16 0v2" /><path d="M4 14a2 2 0 0 1 2-2h2v8H6a2 2 0 0 1-2-2zM20 14a2 2 0 0 0-2-2h-2v8h2a2 2 0 0 0 2-2zM3 3l18 18" /></>,
    camera: <><rect x="3" y="6" width="13" height="12" rx="2" /><path d="m16 10 5-3v10l-5-3z" /></>,
    screen: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4M8 11l4-4 4 4M12 7v7" /></>,
    expand: <><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /><path d="m3 8 5-5M21 8l-5-5M3 16l5 5M21 16l-5 5" /></>,
    hangup: <path d="M4.4 15.6c4.7-4.7 10.5-4.7 15.2 0l-2.8 2.8-3-2v-2.1a10 10 0 0 0-3.6 0v2.1l-3 2z" />,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z" /></>,
    sound: <><path d="M12 4v16M8.5 7.5 12 4l3.5 3.5M8.5 16.5 12 20l3.5-3.5M4 9v6M20 9v6" /></>,
    chat: <path d="M21 12a8 8 0 0 1-8 8H6l-4 2 1.4-4.2A8 8 0 1 1 21 12Z" />,
    connection: <><path d="M5 9a10 10 0 0 1 14 0M8 12a6 6 0 0 1 8 0M11 15a2 2 0 0 1 2 0" /><circle cx="12" cy="18" r="1" /></>,
    activities: <><path d="m12 3 3.2 3.2L12 9.4 8.8 6.2zM12 14.6l3.2 3.2L12 21l-3.2-3.2zM3 12l3.2-3.2L9.4 12l-3.2 3.2zM14.6 12l3.2-3.2L21 12l-3.2 3.2z" /></>,
    effects: <><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l2.8 2.8M16.2 16.2 19 19M19 5l-2.8 2.8M7.8 16.2 5 19" /><circle cx="12" cy="12" r="3" /></>,
    "chevron-left": <path d="m15 5-7 7 7 7" />,
    "chevron-down": <path d="m5 9 7 7 7-7" />,
    users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14a6.5 6.5 0 0 1 3.5 6" /></>,
    pin: <><path d="M9 3h6l-1 6 4 4H6l4-4z" /><path d="M12 13v8" /></>,
    attach: <path d="m20 11.5-8.2 8.2a5.5 5.5 0 0 1-7.8-7.8L12.6 3.3a3.7 3.7 0 0 1 5.2 5.2L9.2 17a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9" />,
    send: <><path d="M4 12 20 4l-4 16-4-6.5z" /><path d="m12 13.5 8-9.5" /></>,
    speaker: <><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" /><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" /></>,
  };
  return <svg className="call-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[kind]}</svg>;
}

export function UserAvatar({ name, url, className = "avatar" }: { name: string; url?: string | null; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return (
    <div className={`${className} user-avatar`} aria-label={`Avatar de ${name}`}>
      {url && !failed
        ? <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
        : <span>{initials(name)}</span>}
    </div>
  );
}

export function StreamVideo({ stream, label, muted = false }: { stream: MediaStream; label: string; muted?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  return <video ref={videoRef} autoPlay playsInline muted={muted} aria-label={label} />;
}

// Longer messages stay a little longer; hovering keeps the toast open.
export function NoticeToast({ text, onClose }: { text: string; onClose: () => void }) {
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (hovered) return;
    const timeoutId = window.setTimeout(onClose, Math.min(12_000, 4_000 + text.length * 50));
    return () => window.clearTimeout(timeoutId);
  }, [hovered, text, onClose]);
  return (
    <div className="notice-toast" role="status" aria-live="polite" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <p>{text}</p>
      <button type="button" onClick={onClose} aria-label="Fechar aviso">×</button>
    </div>
  );
}

export function ParticipantTile({ name, avatarUrl, cameraStream, local, speaking, muted, onContextMenu }: {
  name: string;
  avatarUrl?: string | null;
  cameraStream?: MediaStream | null;
  local?: boolean;
  speaking?: boolean;
  muted?: boolean;
  onContextMenu?: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = cameraStream ?? null;
  }, [cameraStream]);

  return (
    <article className={`call-tile participant-tile ${cameraStream ? "has-camera" : ""} ${speaking ? "speaking" : ""}`} onContextMenu={onContextMenu}>
      {cameraStream ? <video ref={videoRef} autoPlay playsInline muted={local} /> : <UserAvatar name={name} url={avatarUrl} className="participant-avatar" />}
      <footer><strong>{name}{local ? " · você" : ""}</strong><span>{muted ? "microfone desligado" : speaking ? "falando" : "em voz"}</span></footer>
    </article>
  );
}
