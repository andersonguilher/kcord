import express from "express";
import { liveKitTokenRequestSchema, parsePayload } from "../shared/protocol.ts";
import type { CommunityConfig } from "./discord-template.ts";
import { issueLiveKitToken, usesLiveKit, type LiveKitConfig } from "./livekit.ts";
import type { Member } from "./types.ts";

type LiveKitRouterOptions = {
  /** Null when LiveKit is not configured: the endpoint then answers 404, as if it did not exist. */
  config: LiveKitConfig | null;
  members: Map<string, Member>;
  getCommunity: () => CommunityConfig;
  /** The signed-in Discord account behind the request cookie. */
  identify: (request: express.Request) => { discordUserId: string } | null | undefined;
  isAfkChannel: (channelId: string) => boolean;
};

/**
 * `POST /api/livekit/token { socketId, channelId }` gives a signed-in member a
 * short-lived LiveKit token for one voice channel. The request has to come from
 * the member's own live socket, the same proof the upload endpoint requires.
 */
export function createLiveKitRouter({ config, members, getCommunity, identify, isAfkChannel }: LiveKitRouterOptions) {
  const router = express.Router();

  router.post("/api/livekit/token", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (!config) {
      response.status(404).json({ error: "LiveKit não está ativado." });
      return;
    }
    const identity = identify(request);
    if (!identity) {
      response.status(401).json({ error: "Entre com Discord para entrar na voz." });
      return;
    }
    const { socketId, channelId } = parsePayload(liveKitTokenRequestSchema, request.body);
    const member = members.get(socketId);
    if (!member?.kafcordUserId || member.authDiscordUserId !== identity.discordUserId) {
      response.status(409).json({ error: "Sua sessão em tempo real mudou. Reconecte o KCord e tente novamente." });
      return;
    }
    if (!getCommunity().voiceChannels.some((channel) => channel.id === channelId) || !usesLiveKit(config, channelId)) {
      response.status(404).json({ error: "Essa sala de voz não usa LiveKit." });
      return;
    }
    if (isAfkChannel(channelId)) {
      response.status(403).json({ error: "O canal de ausentes não tem voz." });
      return;
    }
    try {
      response.json(await issueLiveKitToken(config, {
        identity: member.socketId,
        name: member.name,
        channelId,
        serverMuted: member.serverMuted,
        serverDeafened: member.serverDeafened,
      }));
    } catch (error) {
      console.warn("Não foi possível emitir o token do LiveKit.", error);
      response.status(500).json({ error: "Não foi possível entrar na sala de voz." });
    }
  });

  return router;
}
