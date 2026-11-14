/** A connected socket in the community: identity, voice state and activity. */
export type Member = {
  socketId: string;
  name: string;
  voiceChannelId: string | null;
  authenticated: boolean;
  discordUserId?: string;
  authDiscordUserId?: string;
  kafcordUserId?: string;
  metricsUserId?: string;
  roleIds: string[];
  avatarUrl?: string | null;
  micEnabled: boolean;
  deafened: boolean;
  serverMuted: boolean;
  serverDeafened: boolean;
  cameraEnabled: boolean;
  screenSharing: boolean;
  voiceDetected: boolean;
  lastActiveAt: number;
};
