export type Channel = { id: string; name: string; description: string; categoryId: string | null; position: number };

export type VoiceChannel = { id: string; name: string; categoryId: string | null; position: number };

export type CommunityConfig = {
  name: string;
  categories: { id: string; name: string; position: number }[];
  textChannels: Channel[];
  voiceChannels: VoiceChannel[];
  roles: { id: string; name: string; color: number; permissions: string; position: number }[];
  afkChannelId?: string | null;
  afkTimeoutSeconds?: number;
  importedFrom?: { provider: "discord-template"; code: string; sourceName: string; sourceId?: string };
};

export type DiscordTemplatePreview = {
  code: string;
  templateName: string;
  sourceGuildName: string;
  community: CommunityConfig;
  summary: { categories: number; textChannels: number; voiceChannels: number; roles: number; unsupportedChannels: number };
  warnings: string[];
};

export type DiscordStatus = {
  configured: boolean;
  connected: boolean;
  user: { id: string; username: string; globalName: string | null; avatarUrl?: string | null } | null;
  purpose: "login" | "admin" | null;
  memberships: { sourceGuildId: string; displayName: string; kafcordRoleIds: string[] }[];
  manageableGuilds: { id: string; name: string; icon: string | null }[];
};

export type AuthState = {
  authenticated: boolean;
  user: { kafcordUserId: string; discordUserId: string; username: string; displayName: string; avatarUrl?: string | null } | null;
  memberships: { sourceGuildId: string; displayName: string; kafcordRoleIds: string[] }[];
  canImportDiscordModel: boolean;
  canUseLocalGuest: boolean;
  canMoveMembers: boolean;
  canMuteMembers: boolean;
  canDeafenMembers: boolean;
  canManageMessages: boolean;
};

export type DiscordMemberPreview = {
  guild: { id: string; name: string };
  counts: { total: number; people: number; botsIgnored: number; roleAssignments: number; mappedAssignments: number };
  roleMappings: { discordId: string; discordName: string; kafcordRoleId: string | null }[];
  samples: { discordUserId: string; displayName: string; roleNames: string[]; avatarUrl?: string | null }[];
  fetchedAt: string;
};

export type Member = {
  socketId: string;
  name: string;
  voiceChannelId: string | null;
  authenticated?: boolean;
  discordUserId?: string;
  kafcordUserId?: string;
  roleIds?: string[];
  avatarUrl?: string | null;
  micEnabled?: boolean;
  deafened?: boolean;
  serverMuted?: boolean;
  serverDeafened?: boolean;
  cameraEnabled?: boolean;
  screenSharing?: boolean;
  voiceDetected?: boolean;
};

export type FileAttachment = { name: string; url: string; size: number; expiresAt?: string; expired?: boolean };

export type ChatMessage = {
  id: string;
  channelId: string;
  author: string;
  authorUserId?: string;
  text: string;
  sentAt: string;
  editedAt?: string;
  pinned?: boolean;
  replyTo?: { id: string; author: string; text: string };
  reactions?: Record<string, string[]>;
  authorAvatarUrl?: string | null;
  file?: FileAttachment;
};

export type DirectMessage = {
  id: string;
  fromUserId: string;
  toUserId: string;
  author: string;
  authorAvatarUrl?: string | null;
  recipient: string;
  recipientAvatarUrl?: string | null;
  text: string;
  sentAt: string;
  file?: FileAttachment;
};

export type DirectContact = { userId: string; name: string; avatarUrl?: string | null; online: boolean };

export type LocalGuestProfile = { name: string };

export type KcordProfile = { userId: string; displayName: string; avatarUrl: string | null };

export type UserContextMenu = { x: number; y: number; member: Member };

export type DirectMessageContextMenu = { x: number; y: number; message: DirectMessage };

export type ClientReport = {
  id: string;
  at: string;
  kind: ClientReportKind;
  message: string;
  displayName: string;
  client: "desktop" | "browser";
  appVersion: string | null;
  userAgent: string;
  context: Record<string, string>;
  details?: string;
  status: ClientReportStatus;
  statusChangedAt?: string;
};

export type ClientReportStatus = "open" | "resolved" | "ignored";

export type AdminStats = {
  generatedAt: string;
  collectingSince: string;
  range: number;
  live: { connections: number; uniqueUsers: number; voiceUsers: number; activeStreams: number };
  totals: {
    httpRequests: number;
    bytesIn: number;
    bytesOut: number;
    downloadRequests: number;
    downloadBytesOut: number;
    sessions: number;
    uniqueUsers: number;
    publicMessages: number;
    privateMessages: number;
    voiceJoins: number;
    screenShares: number;
    fileUploads: number;
    uploadedBytes: number;
    networkBytesIn: number;
    networkBytesOut: number;
    relayBytesIn: number;
    relayBytesOut: number;
  };
  networkSince: string | null;
  relaySince: string | null;
  relayUpdatedAt: string | null;
  days: Array<{
    date: string;
    httpRequests: number;
    bytesIn: number;
    bytesOut: number;
    downloadRequests: number;
    downloadBytesOut: number;
    sessions: number;
    uniqueUsers: number;
    publicMessages: number;
    privateMessages: number;
    voiceJoins: number;
    screenShares: number;
    fileUploads: number;
    uploadedBytes: number;
    networkBytesIn: number;
    networkBytesOut: number;
    relayBytesIn: number;
    relayBytesOut: number;
  }>;
};

export type Signal = { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };

export type InputMode = "voice" | "ptt";

export type ShareQuality = "games" | "text" | "custom";

export type ShareDefinition = "sd" | "hd";

export type RemoteTrackKind = "camera" | "screen";

export type ScreenSenderBinding = { sender: RTCRtpSender };

export type ScreenAnnouncement = {
  peerId: string;
  thumbnail: string;
  sharerDiscordUserId?: string;
  resolutionWidth?: number;
  resolutionHeight?: number;
};

export type ScreenPreview = Omit<ScreenAnnouncement, "peerId"> & { live: boolean };

export type SinkAudioElement = HTMLAudioElement & { setSinkId?: (deviceId: string) => Promise<void> };

export type RtcConfigResponse = { iceServers?: RTCIceServer[]; iceTransportPolicy?: RTCIceTransportPolicy };

export type BrowserCaptureController = { setFocusBehavior: (behavior: "no-focus-change") => void };

export type BrowserCaptureControllerConstructor = new () => BrowserCaptureController;

export type AudioPreferredDisplayOptions = DisplayMediaStreamOptions & {
  controller?: BrowserCaptureController;
  monitorTypeSurfaces?: "include" | "exclude";
  selfBrowserSurface?: "include" | "exclude";
  surfaceSwitching?: "include" | "exclude";
  systemAudio?: "include" | "exclude";
  windowAudio?: "exclude" | "window" | "system";
};

export type CallIconKind = "mic" | "mic-off" | "headphones" | "headphones-off" | "camera" | "screen" | "expand" | "hangup" | "settings" | "sound" | "chat" | "connection" | "activities" | "effects" | "chevron-left" | "chevron-down" | "users" | "pin" | "attach" | "send" | "speaker";

export type LoginHandoff = { id: string; code: string; expiresAt: number };

export type ClientReportKind = "share-sources" | "share-sources-missing" | "screen-share" | "microphone" | "app-error" | "desktop-error";

export type LinkPreview = { url: string; title: string | null; siteName: string | null; image: string | null };

export type ScreenEncoding = {
  maxBitrate: number;
  maxFramerate: number;
  degradationPreference: "maintain-framerate" | "maintain-resolution" | "balanced";
};
