import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Socket } from "socket.io-client";
import { LIVE_EXPANDED_KEY } from "../lib/session";
import type { Member, ScreenAnnouncement, ScreenPreview } from "../types";

export type ScreenViewingOptions = {
  socketRef: RefObject<Socket | null>;
  members: Member[];
  voiceChannel: string | null;
  /** Stops showing someone's shared screen stream; provided by the peer layer, which is created later. */
  dropRemoteScreenStream: (peerId: string) => void;
  /** The person chose to watch this screen. A transport that sends screens on demand starts receiving it. */
  onScreenWatched?: (peerId: string) => void;
  /** The person stopped watching this screen, or it ended. */
  onScreenUnwatched?: (peerId: string) => void;
};

/**
 * Watching other members' shared screens: the previews announced by the server,
 * choosing which one to watch (and keeping watching the same person across a
 * reconnect), and the expanded view. Sending your own screen is separate.
 */
export function useScreenViewing(options: ScreenViewingOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const { members, voiceChannel, socketRef } = options;

  const [screenPreviews, setScreenPreviews] = useState<Record<string, ScreenPreview>>({});
  const [activeScreenPeerId, setActiveScreenPeerId] = useState<string | null>(null);
  const [expandedScreenPeerId, setExpandedScreenPeerId] = useState<string | null>(null);
  const [preferExpandedLive, setPreferExpandedLive] = useState(() => {
    try {
      return localStorage.getItem(LIVE_EXPANDED_KEY) === "1";
    } catch {
      return false;
    }
  });
  /** Read by the peer layer to route an untagged incoming video track. */
  const activeScreenPeerIdRef = useRef<string | null>(null);
  /** Who is being watched, by Discord id: a reconnect gives them a new socket id. */
  const watchedScreenDiscordUserIdRef = useRef<string | null>(null);

  // A member is sharing but no preview arrived (e.g. joined mid-share): ask the server for the list.
  useEffect(() => {
    if (!voiceChannel || !socketRef.current) return;
    const missingPreview = members.some((member) =>
      member.socketId !== socketRef.current?.id
      && member.voiceChannelId === voiceChannel
      && member.screenSharing
      && !screenPreviews[member.socketId]);
    if (missingPreview) socketRef.current.emit("screen:list:request");
  }, [members, voiceChannel]);

  // Drop previews of members who stopped sharing, left the room, or are the local socket.
  useEffect(() => {
    const localSocketId = socketRef.current?.id;
    setScreenPreviews((current) => {
      let changed = false;
      const next = { ...current };
      for (const peerId of Object.keys(next)) {
        const member = members.find((candidate) => candidate.socketId === peerId);
        if (peerId === localSocketId || !member?.screenSharing || member.voiceChannelId !== voiceChannel) {
          delete next[peerId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [members, voiceChannel]);

  // ---- choosing what to watch ----

  const watchScreen = (peerId: string) => {
    const { socketRef: socket, members: current, dropRemoteScreenStream } = optionsRef.current;
    if (activeScreenPeerId === peerId) return;
    if (activeScreenPeerId) {
      socket.current?.emit("screen:unsubscribe", { target: activeScreenPeerId });
      setScreenPreviews((previews) => previews[activeScreenPeerId]
        ? { ...previews, [activeScreenPeerId]: { ...previews[activeScreenPeerId], live: false } }
        : previews);
      dropRemoteScreenStream(activeScreenPeerId);
      optionsRef.current.onScreenUnwatched?.(activeScreenPeerId);
    }
    setScreenPreviews((previews) => previews[peerId]
      ? { ...previews, [peerId]: { ...previews[peerId], live: false } }
      : previews);
    setExpandedScreenPeerId(preferExpandedLive ? peerId : null);
    activeScreenPeerIdRef.current = peerId;
    watchedScreenDiscordUserIdRef.current = current.find((member) => member.socketId === peerId)?.discordUserId ?? null;
    setActiveScreenPeerId(peerId);
    socket.current?.emit("screen:subscribe", { target: peerId });
    optionsRef.current.onScreenWatched?.(peerId);
  };

  // Remembers the choice: the next live watched opens the same way.
  const toggleExpandedScreen = (peerId: string) => {
    const expand = expandedScreenPeerId !== peerId;
    setExpandedScreenPeerId(expand ? peerId : null);
    setPreferExpandedLive(expand);
    try {
      localStorage.setItem(LIVE_EXPANDED_KEY, expand ? "1" : "0");
    } catch {
      // Private mode: keep the choice for this session only.
    }
  };

  const closeWatchedScreen = () => {
    const { socketRef: socket, dropRemoteScreenStream } = optionsRef.current;
    if (activeScreenPeerId) {
      socket.current?.emit("screen:unsubscribe", { target: activeScreenPeerId });
      setScreenPreviews((previews) => previews[activeScreenPeerId]
        ? { ...previews, [activeScreenPeerId]: { ...previews[activeScreenPeerId], live: false } }
        : previews);
      dropRemoteScreenStream(activeScreenPeerId);
      optionsRef.current.onScreenUnwatched?.(activeScreenPeerId);
    }
    activeScreenPeerIdRef.current = null;
    watchedScreenDiscordUserIdRef.current = null;
    setActiveScreenPeerId(null);
    setExpandedScreenPeerId(null);
  };

  // ---- socket events (stable identities: safe to register once) ----

  /** After a reconnect the same person has a new socket id: watch them again. */
  const restoreWatchedScreen = useCallback((screens: ScreenAnnouncement[]) => {
    const watchedDiscordUserId = watchedScreenDiscordUserIdRef.current;
    if (!watchedDiscordUserId) return;
    const localSocketId = optionsRef.current.socketRef.current?.id;
    const restored = screens.find((screen) => screen.sharerDiscordUserId === watchedDiscordUserId && screen.peerId !== localSocketId);
    if (!restored || activeScreenPeerIdRef.current === restored.peerId) return;
    activeScreenPeerIdRef.current = restored.peerId;
    setActiveScreenPeerId(restored.peerId);
    optionsRef.current.socketRef.current?.emit("screen:subscribe", { target: restored.peerId });
    optionsRef.current.onScreenWatched?.(restored.peerId);
  }, []);

  /** The full list of live screens in the room. */
  const onScreenList = useCallback((screens: ScreenAnnouncement[]) => {
    const localSocketId = optionsRef.current.socketRef.current?.id;
    setScreenPreviews((current) => Object.fromEntries(screens
      .filter((screen) => screen.peerId !== localSocketId)
      .map((screen) => [screen.peerId, {
        thumbnail: screen.thumbnail,
        live: current[screen.peerId]?.live ?? false,
        sharerDiscordUserId: screen.sharerDiscordUserId,
        resolutionWidth: screen.resolutionWidth,
        resolutionHeight: screen.resolutionHeight,
      }])));
    restoreWatchedScreen(screens);
  }, [restoreWatchedScreen]);

  /** Someone started sharing. */
  const onScreenAvailable = useCallback((screen: ScreenAnnouncement) => {
    const { peerId, ...preview } = screen;
    setScreenPreviews((current) => ({ ...current, [peerId]: { ...preview, live: current[peerId]?.live ?? false } }));
    restoreWatchedScreen([screen]);
  }, [restoreWatchedScreen]);

  const onScreenThumbnail = useCallback(({ peerId, thumbnail }: { peerId: string; thumbnail: string }) => {
    setScreenPreviews((current) => current[peerId]
      ? { ...current, [peerId]: { ...current[peerId], thumbnail } }
      : current);
  }, []);

  /** Someone stopped sharing. */
  const onScreenStop = useCallback(({ peerId }: { peerId: string }) => {
    setScreenPreviews((current) => {
      const next = { ...current };
      delete next[peerId];
      return next;
    });
    optionsRef.current.dropRemoteScreenStream(peerId);
    optionsRef.current.onScreenUnwatched?.(peerId);
    setActiveScreenPeerId((current) => current === peerId ? null : current);
    setExpandedScreenPeerId((current) => current === peerId ? null : current);
    if (activeScreenPeerIdRef.current === peerId) {
      activeScreenPeerIdRef.current = null;
      watchedScreenDiscordUserIdRef.current = null;
    }
  }, []);

  return {
    screenPreviews,
    setScreenPreviews,
    activeScreenPeerId,
    setActiveScreenPeerId,
    expandedScreenPeerId,
    setExpandedScreenPeerId,
    activeScreenPeerIdRef,
    watchedScreenDiscordUserIdRef,
    watchScreen,
    toggleExpandedScreen,
    closeWatchedScreen,
    onScreenList,
    onScreenAvailable,
    onScreenThumbnail,
    onScreenStop,
  };
}
