import { z } from "zod";

/**
 * Shared Socket.IO payload contracts for the chat events.
 *
 * Every field is coerced leniently on purpose: the server has always treated
 * a malformed payload as "empty" rather than throwing, so parsing never fails
 * and the handler keeps its own authorization and existence checks.
 */

/** Coerces any value to a string, optionally trimmed, capped at `max` characters. */
const text = (max: number, options: { trim?: boolean } = {}) =>
  z.preprocess((value) => {
    const coerced = String(value ?? "");
    return (options.trim ? coerced.trim() : coerced).slice(0, max);
  }, z.string());

/** Maximum chat message length shared by client and server. */
export const MAX_MESSAGE_LENGTH = 2000;

/** The only reactions the server accepts. */
export const ALLOWED_REACTIONS = ["👍", "❤️", "😂", "🎉", "👀", "👎"] as const;

export const chatSendSchema = z.object({
  channelId: text(100),
  text: text(MAX_MESSAGE_LENGTH, { trim: true }),
  avatarUrl: z.preprocess((value) => (typeof value === "string" ? value : undefined), z.string().optional()),
  replyToId: text(100),
});

export const chatEditSchema = z.object({
  messageId: text(100),
  text: text(MAX_MESSAGE_LENGTH, { trim: true }),
});

export const chatMessageRefSchema = z.object({ messageId: text(100) });

export const chatReactSchema = z.object({
  messageId: text(100),
  emoji: text(32),
});

export const chatPinSchema = z.object({
  messageId: text(100),
  pinned: z.preprocess((value) => value === true, z.boolean()),
});

export const chatChannelRefSchema = z.object({ channelId: text(100) });

export const dmSendSchema = z.object({
  recipientUserId: text(100, { trim: true }),
  text: text(MAX_MESSAGE_LENGTH, { trim: true }),
  avatarUrl: z.preprocess((value) => (typeof value === "string" ? value : undefined), z.string().optional()),
});

export const dmPeerRefSchema = z.object({ peerUserId: text(100, { trim: true }) });

export const dmMessageRefSchema = z.object({ messageId: text(100, { trim: true }) });

/** Truthy coercion, as in `Boolean(value)`. */
const truthy = z.preprocess((value) => Boolean(value), z.boolean());
/** Strict boolean: only a literal `true` counts. */
const strictTrue = z.preprocess((value) => value === true, z.boolean());
/** Any value, passed through untouched (WebRTC descriptions and candidates). */
const passthrough = z.preprocess((value) => value, z.custom<unknown>(() => true));
/** Rounded number; NaN is kept so callers can range-check it themselves. */
const roundedNumber = z.preprocess((value) => Math.round(Number(value)), z.custom<number>(() => true));

export const sessionJoinSchema = z.object({
  localGuest: z.preprocess(
    (value) => (typeof value === "object" && value !== null && !Array.isArray(value)
      ? { name: String((value as { name?: unknown }).name ?? "").trim().slice(0, 32) }
      : undefined),
    z.object({ name: z.string() }).optional(),
  ),
  avatarUrl: z.preprocess((value) => (typeof value === "string" ? value : undefined), z.string().optional()),
});

export const profileSyncSchema = z.object({
  avatarUrl: z.preprocess((value) => (typeof value === "string" ? value : undefined), z.string().optional()),
});

export const voiceJoinSchema = z.object({ channelId: text(40) });

export const voiceMoveMemberSchema = z.object({
  targetSocketId: text(100, { trim: true }),
  channelId: text(40, { trim: true }),
});

export const voiceModerateMemberSchema = z.object({
  targetSocketId: text(100, { trim: true }),
  action: text(32),
  enabled: strictTrue,
});

export const voiceStateSchema = z.object({
  micEnabled: truthy,
  deafened: strictTrue,
  cameraEnabled: truthy,
  screenSharing: truthy,
  voiceDetected: truthy,
});

export const mediaTrackMetaSchema = z.object({
  target: text(100),
  trackId: text(100),
  kind: text(20),
});

/** Maximum size of a screen thumbnail data URL, in characters. */
export const MAX_SCREEN_THUMBNAIL_LENGTH = 120_000;

export const screenStartSchema = z.object({
  // Not capped on purpose: the handler rejects oversized thumbnails instead of truncating them.
  thumbnail: text(Number.POSITIVE_INFINITY),
  resolutionWidth: roundedNumber,
  resolutionHeight: roundedNumber,
});

export const screenThumbnailSchema = z.object({ thumbnail: text(Number.POSITIVE_INFINITY) });

export const screenTargetSchema = z.object({ target: text(100, { trim: true }) });

export const rtcSignalSchema = z.object({
  target: text(100),
  description: passthrough,
  candidate: passthrough,
});

/** Body of `POST /api/livekit/token`: which live socket is asking, and for which voice channel. */
export const liveKitTokenRequestSchema = z.object({
  socketId: text(100, { trim: true }),
  channelId: text(40, { trim: true }),
});

export type ChatSendPayload = z.output<typeof chatSendSchema>;
export type ChatEditPayload = z.output<typeof chatEditSchema>;
export type ChatReactPayload = z.output<typeof chatReactSchema>;
export type ChatPinPayload = z.output<typeof chatPinSchema>;

/** Acknowledgement sent back to the client for chat actions. */
export type ChatAck = { ok: boolean; error?: string };

/** Parses an untrusted payload; non-objects are treated as an empty payload. */
export function parsePayload<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const input = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {};
  return schema.parse(input);
}
