import { AccessToken, TrackSource } from "livekit-server-sdk";

/** Connection settings for a self-hosted LiveKit server. Absent unless fully configured. */
export type LiveKitConfig = {
  /** The public WebSocket URL browsers connect to, for example `wss://kafcord.kafly.com.br/livekit`. */
  url: string;
  apiKey: string;
  apiSecret: string;
  /** Voice channels that use LiveKit; every other channel keeps the peer-to-peer mesh. `"*"` means all. */
  channelIds: ReadonlySet<string> | "*";
};

/** How long a token is valid to *join*; an established connection keeps running afterwards. */
export const LIVEKIT_TOKEN_TTL = "10m";

/**
 * Reads LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET and LIVEKIT_VOICE_CHANNEL_IDS
 * (a comma-separated list of channel ids, or `*`). Returns null when the feature is
 * not fully configured, which keeps every voice channel on the mesh.
 */
export function readLiveKitConfig(environment: NodeJS.ProcessEnv = process.env): LiveKitConfig | null {
  const url = environment.LIVEKIT_URL?.trim() ?? "";
  const apiKey = environment.LIVEKIT_API_KEY?.trim() ?? "";
  const apiSecret = environment.LIVEKIT_API_SECRET?.trim() ?? "";
  const channels = environment.LIVEKIT_VOICE_CHANNEL_IDS?.trim() ?? "";
  if (!url || !apiKey || !apiSecret || !channels || !/^wss?:\/\//.test(url)) return null;
  const channelIds = channels === "*"
    ? "*" as const
    : new Set(channels.split(",").map((id) => id.trim()).filter(Boolean));
  if (channelIds !== "*" && channelIds.size === 0) return null;
  return { url, apiKey, apiSecret, channelIds };
}

/** True when this voice channel is served by LiveKit instead of the peer-to-peer mesh. */
export function usesLiveKit(config: LiveKitConfig | null, channelId: string) {
  if (!config) return false;
  return config.channelIds === "*" || config.channelIds.has(channelId);
}

/** The LiveKit room name for a voice channel. */
export function liveKitRoomName(channelId: string) {
  return `voice:${channelId}`;
}

export type LiveKitTokenRequest = {
  /** The member's socket id: it becomes the LiveKit identity, so peers keep the ids the app already uses. */
  identity: string;
  name: string;
  channelId: string;
  /** Moderator mute: the microphone cannot be published. */
  serverMuted: boolean;
  /** Moderator deafen: nothing can be received. */
  serverDeafened: boolean;
};

/** A short-lived token that lets one member join one voice room, with only the permissions they currently have. */
export async function issueLiveKitToken(config: LiveKitConfig, request: LiveKitTokenRequest) {
  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity: request.identity,
    name: request.name.slice(0, 64),
    ttl: LIVEKIT_TOKEN_TTL,
  });
  const publishSources = [TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO];
  if (!request.serverMuted) publishSources.unshift(TrackSource.MICROPHONE);
  token.addGrant({
    roomJoin: true,
    room: liveKitRoomName(request.channelId),
    canPublish: true,
    canPublishSources: publishSources,
    canSubscribe: !request.serverDeafened,
    canPublishData: false,
  });
  return { url: config.url, token: await token.toJwt() };
}
