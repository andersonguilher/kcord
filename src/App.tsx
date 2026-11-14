import kcordAppIcon from "../build/icon-v2.png";
import kafcordLogo from "../logo.png";
import connectToChannelSound from "./assets/sounds/connect_to_channel.wav";
import disconnectFromChannelSound from "./assets/sounds/disconnect_from_channel.wav";
import { AttachmentImagePreview, IMAGE_ATTACHMENT_PATTERN } from "./components/attachments";
import { LinkCard, MessageText, ScreenshotCard } from "./components/cards";
import { CallIcon, NoticeToast, ParticipantTile, StreamVideo, UserAvatar } from "./components/common";
import { FLAT_VOICE_EQ, RemoteAudio, VOICE_EQ_BANDS, VOICE_EQ_PRESETS } from "./components/voiceAudio";
import { useAdminPanel } from "./hooks/useAdminPanel";
import { useAudioPreferences } from "./hooks/useAudioPreferences";
import { useAfkNotice } from "./hooks/useAfkNotice";
import { useAudioTests } from "./hooks/useAudioTests";
import { useCamera } from "./hooks/useCamera";
import { useScreenShare } from "./hooks/useScreenShare";
import { useScreenViewing } from "./hooks/useScreenViewing";
import { useChat } from "./hooks/useChat";
import { useDesktopUpdate } from "./hooks/useDesktopUpdate";
import { useInterfaceCue } from "./hooks/useInterfaceCue";
import { useLiveKitRoom } from "./hooks/useLiveKitRoom";
import { useMicrophone } from "./hooks/useMicrophone";
import { usePeerConnections } from "./hooks/usePeerConnections";
import { usePushToTalk } from "./hooks/usePushToTalk";
import { clientReportLabels, clientReportStatusLabels, clientReportSystem, desktopSystemInfo, reportClientIssue, reportPageError } from "./lib/clientReports";
import { isAppleMobile, isStandaloneApp, } from "./lib/device";
import { fileIsExpired, firstMessageUrl, formatFileExpiry, formatSize, formatTime, formatTraffic, isLinksChannel, isScreenshotChannel, keyLabel, memberVolumeKey } from "./lib/format";
import { blockedAudioListeners, resumeBlockedRemoteAudio, resumePausedRemoteAudio } from "./lib/remoteAudio";
import { LOGIN_HANDOFF_KEY, defaultCommunity, discordLoginFailureMessages, forgetStoredLoginHandoff, installDesktopUpdate, loadedClientBuild, readStoredLoginHandoff, reloadForClientBuild, saveVoiceResume, storedLocalGuestProfile, updateVoiceResumeChannelId } from "./lib/session";
import { useFittedTileWidth } from "./lib/tiles";
import type { AuthState, ChatMessage, ClientReportKind, ClientReportStatus, CommunityConfig, DirectContact, DirectMessage, DirectMessageContextMenu, DiscordMemberPreview, DiscordStatus, DiscordTemplatePreview, KcordProfile, LocalGuestProfile, LoginHandoff, Member, ScreenSenderBinding, UserContextMenu } from "./types";
import { type FormEvent, type CSSProperties, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type TouchEvent as ReactTouchEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Socket, io } from "socket.io-client";

export default function App() {
  const initialDiscordResult = new URLSearchParams(location.search).get("discord");
  const [localGuestProfile, setLocalGuestProfile] = useState<LocalGuestProfile | null>(() => storedLocalGuestProfile());
  const [localGuestMode, setLocalGuestMode] = useState(() => localStorage.getItem("kafcord:local-guest-mode") === "true");
  const [showLocalGuestDialog, setShowLocalGuestDialog] = useState(false);
  const [localGuestNameDraft, setLocalGuestNameDraft] = useState(() => storedLocalGuestProfile()?.name ?? "");
  const [name, setName] = useState(() => {
    const localProfile = storedLocalGuestProfile();
    return localStorage.getItem("kafcord:local-guest-mode") === "true" && localProfile
      ? localProfile.name
      : localStorage.getItem("kafcord:name") ?? "";
  });
  const [joined, setJoined] = useState(() => Boolean(
    (localStorage.getItem("kafcord:local-guest-mode") === "true" && storedLocalGuestProfile())
    || (localStorage.getItem("kafcord:name") && new URLSearchParams(location.search).get("discord") === "connected"),
  ));
  const [connected, setConnected] = useState(false);
  const [activeChannel, setActiveChannel] = useState("geral");
  const [mainView, setMainView] = useState<"text" | "voice" | "direct">("text");
  const [mobileView, setMobileView] = useState<"channels" | "content">("channels");
  const [showMobileMembers, setShowMobileMembers] = useState(false);
  const [sessionReplaced, setSessionReplaced] = useState(false);
  const [loginHandoff, setLoginHandoff] = useState<LoginHandoff | null>(readStoredLoginHandoff);
  const [loginHandoffMessage, setLoginHandoffMessage] = useState("");
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const [selectedVoiceChannel, setSelectedVoiceChannel] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [voiceChannel, setVoiceChannel] = useState<string | null>(null);
  const [micEnabled, setMicEnabled] = useState(true);
  const [deafened, setDeafened] = useState(false);
  const [notice, setNoticeState] = useState(() => discordLoginFailureMessages[initialDiscordResult ?? ""]
    ?? "Entre para acompanhar a conversa ao vivo.");
  // Every notice also pops up as a toast; the id lets the same text show again.
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const setNotice = useCallback((text: string) => {
    setNoticeState(text);
    setToast((current) => ({ id: (current?.id ?? 0) + 1, text }));
  }, []);
  const closeToast = useCallback(() => setToast(null), []);
  const [community, setCommunity] = useState<CommunityConfig>(defaultCommunity);
  const [showImporter, setShowImporter] = useState(false);
  const [templateSource, setTemplateSource] = useState("https://discord.new/pNTb9KZuGEPX");
  const [importPreview, setImportPreview] = useState<DiscordTemplatePreview | null>(null);
  const [importError, setImportError] = useState("");
  const [importing, setImporting] = useState(false);
  const [discordStatus, setDiscordStatus] = useState<DiscordStatus | null>(null);
  const [selectedGuildId, setSelectedGuildId] = useState("");
  const [memberPreview, setMemberPreview] = useState<DiscordMemberPreview | null>(null);
  const [memberImporting, setMemberImporting] = useState(false);
  const [memberImportMessage, setMemberImportMessage] = useState("");
  const [authState, setAuthState] = useState<AuthState | null>(null);
  const [kcordProfile, setKcordProfile] = useState<KcordProfile | null>(null);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [showProfileEditor, setShowProfileEditor] = useState(false);
  const [profileNameDraft, setProfileNameDraft] = useState("");
  const [profileAvatarFile, setProfileAvatarFile] = useState<File | null>(null);
  const [profileAvatarPreview, setProfileAvatarPreview] = useState<string | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState("");
  const {
    showAdminStats,
    setShowAdminStats,
    adminStats,
    adminStatsRange,
    setAdminStatsRange,
    adminStatsLoading,
    adminStatsError,
    loadAdminStats,
    clientReports,
    clientReportFilter,
    setClientReportFilter,
    updatingClientReportId,
    updateClientReportStatus,
    unseenClientReports,
    visibleClientReports,
    clientReportCounts,
    clientReportAlertRef
  } = useAdminPanel(Boolean(authState?.canImportDiscordModel), setNotice);
  const [showAudioSettings, setShowAudioSettings] = useState(false);
  const {
    audioInputs,
    audioOutputs,
    refreshAudioDevices,
    inputDeviceId,
    setInputDeviceId,
    outputDeviceId,
    setOutputDeviceId,
    inputVolume,
    setInputVolume,
    outputVolume,
    setOutputVolume,
    inputSensitivity,
    setInputSensitivity,
    noiseSuppression,
    setNoiseSuppression,
    echoCancellation,
    setEchoCancellation,
    voiceLeveling,
    setVoiceLeveling
  } = useAudioPreferences();
  const { playInterfaceCue } = useInterfaceCue(outputDeviceId, outputVolume);
  const [settingsTab, setSettingsTab] = useState<"voice" | "windows">("voice");
  const [autoStart, setAutoStart] = useState<{ supported: boolean; enabled: boolean } | null>(null);
  const [desktopCaptureMode, setDesktopCaptureMode] = useState<"wgc" | "legacy" | null>(null);
  const [audioSettingsError, setAudioSettingsError] = useState("");
  const {
    testingMicrophone,
    microphoneTestStream,
    testingOutput,
    microphoneLevel,
    toggleMicrophoneTest,
    testOutput,
    stopMicrophoneTest,
    microphoneTestStreamRef
  } = useAudioTests({
    inputDeviceId,
    outputDeviceId,
    inputVolume,
    outputVolume,
    echoCancellation,
    noiseSuppression,
    refreshAudioDevices,
    setAudioSettingsError,
  });
  const [voiceEq, setVoiceEq] = useState<number[]>(FLAT_VOICE_EQ);
  const voiceEqSendTimerRef = useRef<number | undefined>(undefined);
  const [userContextMenu, setUserContextMenu] = useState<UserContextMenu | null>(null);
  const [directMessageContextMenu, setDirectMessageContextMenu] = useState<DirectMessageContextMenu | null>(null);
  const [draggedVoiceMemberId, setDraggedVoiceMemberId] = useState<string | null>(null);
  const [voiceDropTargetId, setVoiceDropTargetId] = useState<string | null>(null);
  const draggedVoiceMemberIdRef = useRef<string | null>(null);
  const [userVolumes, setUserVolumes] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem("kafcord:user-volumes") ?? "{}") as Record<string, number>;
    } catch {
      return {};
    }
  });

  const socketRef = useRef<Socket | null>(null);
  const mainViewRef = useRef(mainView);
  const activeChannelRef = useRef(activeChannel);
  const currentUserIdRef = useRef<string | null>(null);
  const peersRef = useRef(new Map<string, RTCPeerConnection>());
  const voiceChannelRef = useRef<string | null>(null);
  const { desktopUpdate, setDesktopUpdate, restartCountdown } = useDesktopUpdate(voiceChannelRef);
  const reloadVoiceChannelRef = useRef<string | null>((() => {
    try {
      const reloaded = sessionStorage.getItem("kafcord:voice-channel-id");
      if (reloaded) return reloaded;
    } catch {
      // Fall through to the update handoff.
    }
    return updateVoiceResumeChannelId;
  })());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const directFileInputRef = useRef<HTMLInputElement>(null);
  const {
    messages,
    directMessages,
    directMessageDraft,
    setDirectMessageDraft,
    activeDirectUserId,
    activeDirectContactHint,
    activeDirectUserIdRef,
    directUnread,
    directUnreadOrder,
    messageDraft,
    setMessageDraft,
    replyingTo,
    setReplyingTo,
    editingMessageId,
    setEditingMessageId,
    editingMessageDraft,
    setEditingMessageDraft,
    channelUnread,
    setChannelUnread,
    showPinnedMessages,
    setShowPinnedMessages,
    uploading,
    loadSession,
    onChatMessage,
    onChatReadState,
    onChatUpdate,
    onChatDelete,
    onDirectMessage,
    onDirectDelete,
    onDirectIdentityRemoved,
    sendMessage,
    editMessage,
    deleteMessage,
    toggleMessageReaction,
    toggleMessagePin,
    startEditingMessage,
    startReplyingToMessage,
    deleteDirectMessage,
    sendDirectMessage,
    clearDirectInterface,
    uploadFile,
    pasteFile,
    openDirectChat: openDirectConversation,
  } = useChat({
    socketRef,
    mainViewRef,
    activeChannelRef,
    currentUserIdRef,
    fileInputRef,
    directFileInputRef,
    activeChannel,
    authorName: name,
    getAvatarUrl: () => (localGuestMode ? undefined : currentAvatarUrl),
    setNotice,
    showDirectView: () => {
      mainViewRef.current = "direct";
      setMainView("direct");
      setSelectedVoiceChannel(null);
      setMobileView("content");
      setUserContextMenu(null);
    },
    showTextView: () => {
      mainViewRef.current = "text";
      setMainView("text");
    },
    closeDirectMessageMenu: (messageId) => setDirectMessageContextMenu((current) => (messageId === undefined || current?.message.id === messageId ? null : current)),
  });
  const profileAvatarInputRef = useRef<HTMLInputElement>(null);
  const profileNameInputRef = useRef<HTMLInputElement>(null);
  const suppressLeaveCueRef = useRef(false);
  const micBeforeDeafenRef = useRef(true);
  // Microphone/audio state from before an AFK move, restored when joining another channel.
  const { showAfkDialog, hideAfkDialogNextTime, setHideAfkDialogNextTime, announceAfkMove, closeAfkDialog, confirmAfkDialog } = useAfkNotice();
  const afkRestoreRef = useRef<{ mic: boolean; deafened: boolean } | null>(null);
  const joinVoiceRef = useRef<(channelId: string) => Promise<void>>(async () => undefined);
  const leaveVoiceRef = useRef<() => void>(() => undefined);
  const cameraRef = useRef<MediaStream | null>(null);
  const pendingClientBuildRef = useRef<string | null>(null);
  const cameraSendersRef = useRef(new Map<string, RTCRtpSender>());
  const screenSendersRef = useRef(new Map<string, ScreenSenderBinding[]>());
  const voiceStateRef = useRef({ micEnabled: true, deafened: false, transmitting: false });
  const callStageRef = useRef<HTMLElement | null>(null);

  const textChannels = community.textChannels;
  const voiceChannels = community.voiceChannels;
  const activeChannelData = textChannels.find((channel) => channel.id === activeChannel) ?? textChannels[0];
  const linksChannelActive = Boolean(activeChannelData && isLinksChannel(activeChannelData.name));
  const screenshotChannelActive = Boolean(activeChannelData && isScreenshotChannel(activeChannelData.name));
  const channelSections = useMemo(() => {
    const sections = [
      ...community.categories.map((category) => ({ id: category.id, name: category.name })),
      { id: null, name: community.categories.length ? "Sem categoria" : "Canais" },
    ];
    return sections
      .map((section) => ({
        ...section,
        textChannels: textChannels.filter((channel) => channel.categoryId === section.id),
        voiceChannels: voiceChannels.filter((channel) => channel.categoryId === section.id),
      }))
      .filter((section) => section.textChannels.length > 0 || section.voiceChannels.length > 0);
  }, [community.categories, textChannels, voiceChannels]);
  const channelMessages = useMemo(
    () => messages.filter((message) => message.channelId === activeChannel),
    [activeChannel, messages],
  );
  const pinnedMessages = useMemo(
    () => channelMessages.filter((message) => message.pinned),
    [channelMessages],
  );
  const currentMember = members.find((member) => member.socketId === socketRef.current?.id);
  const contextVoiceMember = userContextMenu
    ? members.find((member) => member.socketId === userContextMenu.member.socketId) ?? userContextMenu.member
    : null;
  const serverMuted = currentMember?.serverMuted === true;
  const serverDeafened = currentMember?.serverDeafened === true;
  const {
    inputMode,
    setInputMode,
    pttKey,
    touchOnly,
    recordingPttKey,
    setRecordingPttKey,
    pttPressed,
    setPttPressed,
    pttSoundsEnabled,
    setPttSoundsEnabled
  } = usePushToTalk({
    voiceChannel,
    micEnabled,
    serverMuted,
    serverDeafened,
    setNotice,
    playInterfaceCue,
  });
  const {
    voiceDetected,
    microphoneVersion,
    localAudioRef,
    rawAudioRef,
    inputAudioContextRef,
    recoverMicrophoneRef,
    startMicrophone,
    releaseMicrophone,
    resumeInputContext,
    changeInputDevice,
  } = useMicrophone({
    inputDeviceId,
    setInputDeviceId,
    inputVolume,
    inputSensitivity,
    echoCancellation,
    noiseSuppression,
    micEnabled,
    inputMode,
    pttPressed,
    voiceChannel,
    afkChannelId: community.afkChannelId,
    serverMuted,
    serverDeafened,
    voiceChannelRef,
    peersRef,
    setAudioSettingsError,
  });
  const {
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
  } = useScreenViewing({
    socketRef,
    members,
    voiceChannel,
    // The peer layer is created just below, so this reaches it once everything is set up.
    dropRemoteScreenStream: (peerId) => dropRemoteScreenStream(peerId),
    onScreenWatched: (peerId) => subscribeScreen(peerId),
    onScreenUnwatched: (peerId) => unsubscribeScreen(peerId),
  });
  const {
    remoteStreams: meshRemoteStreams,
    remoteCameraStreams: meshRemoteCameraStreams,
    remoteScreenStreams: meshRemoteScreenStreams,
    loadRtcConfiguration,
    isLiveKitChannel,
    createPeer,
    closePeer,
    makeOffer,
    resetRemoteVoiceConnections,
    dropRemoteScreenStream,
    onVoicePeers,
    onTrackMeta,
    onRtcSignal,
  } = usePeerConnections({
    socketRef,
    localAudioRef,
    cameraRef,
    peersRef,
    cameraSendersRef,
    screenSendersRef,
    activeScreenPeerIdRef,
    setScreenPreviews,
    setActiveScreenPeerId,
    setExpandedScreenPeerId,
    setNotice,
  });
  const { cameraStream, toggleCamera, releaseCamera } = useCamera({
    cameraRef,
    peersRef,
    cameraSendersRef,
    socketRef,
    makeOffer,
    voiceChannel,
    isBlockedInAfk: () => blockedInAfkChannel(),
    setNotice,
  });
  const {
    screenStream,
    screenViewerCount,
    screenResolutionHeight,
    screenLabel,
    screenRef,
    screenEncodingRef,
    latestScreenThumbnailRef,
    screenResolutionRef,
    showDesktopShareDialog,
    desktopShareType,
    desktopShareSources,
    selectedDesktopShareId,
    setSelectedDesktopShareId,
    loadingDesktopSources,
    desktopShareError,
    desktopShareAudio,
    setDesktopShareAudio,
    desktopShareQuality,
    setDesktopShareQuality,
    desktopShareDefinition,
    setDesktopShareDefinition,
    showDesktopShareSettings,
    setShowDesktopShareSettings,
    sendingShareDiagnosis,
    missingShareAppName,
    setMissingShareAppName,
    startScreenShare,
    toggleScreen,
    stopSharing,
    sendShareDiagnosis,
    loadDesktopShareSources,
    closeDesktopShareDialog,
    onViewerJoin,
    onViewerLeft,
    onViewerCount,
    resetViewerCount,
    resumeScreenAnnouncement,
    releaseScreenShare,
  } = useScreenShare({
    socketRef,
    peersRef,
    screenSendersRef,
    voiceChannel,
    voiceChannelRef,
    createPeer,
    makeOffer,
    isBlockedInAfk: () => blockedInAfkChannel(),
    setNotice,
  });
  const {
    remoteStreams: liveKitRemoteStreams,
    remoteCameraStreams: liveKitRemoteCameraStreams,
    remoteScreenStreams: liveKitRemoteScreenStreams,
    liveKitActiveRef,
    joinLiveKit,
    leaveLiveKit,
    subscribeScreen,
    unsubscribeScreen,
  } = useLiveKitRoom({
    socketRef,
    localAudioRef,
    microphoneVersion,
    cameraStream,
    screenStream,
    screenEncodingRef,
    setScreenPreviews,
    onDisconnected: () => {
      setNotice("A conexão de voz foi interrompida.");
      leaveVoiceRef.current();
    },
  });
  // A room uses one backend, so at most one of the two sets has anything in it.
  const remoteStreams = useMemo(() => ({ ...meshRemoteStreams, ...liveKitRemoteStreams }), [meshRemoteStreams, liveKitRemoteStreams]);
  const remoteCameraStreams = useMemo(() => ({ ...meshRemoteCameraStreams, ...liveKitRemoteCameraStreams }), [meshRemoteCameraStreams, liveKitRemoteCameraStreams]);
  const remoteScreenStreams = useMemo(() => ({ ...meshRemoteScreenStreams, ...liveKitRemoteScreenStreams }), [meshRemoteScreenStreams, liveKitRemoteScreenStreams]);
  const microphoneLockedByServer = serverMuted || serverDeafened;
  const currentUserId = currentMember?.kafcordUserId ?? (localGuestMode ? null : authState?.user?.kafcordUserId) ?? null;
  const currentAvatarUrl = currentMember?.avatarUrl ?? (localGuestMode ? null : kcordProfile?.avatarUrl ?? authState?.user?.avatarUrl);
  const normalizeMembers = useCallback((incomingMembers: Member[]) => {
    const localSocketId = socketRef.current?.id;
    const authenticatedAvatarUrl = localGuestMode ? null : kcordProfile?.avatarUrl ?? authState?.user?.avatarUrl;
    if (!localSocketId || !authenticatedAvatarUrl) return incomingMembers;
    return incomingMembers.map((member) => member.socketId === localSocketId && !member.avatarUrl
      ? { ...member, avatarUrl: authenticatedAvatarUrl }
      : member);
  }, [authState?.user?.avatarUrl, kcordProfile?.avatarUrl, localGuestMode]);
  const directContacts = useMemo(() => {
    const contacts = new Map<string, DirectContact>();
    for (const member of members) {
      if (!member.kafcordUserId || member.kafcordUserId === currentUserId) continue;
      contacts.set(member.kafcordUserId, {
        userId: member.kafcordUserId,
        name: member.name,
        avatarUrl: member.avatarUrl,
        online: true,
      });
    }
    for (const message of directMessages) {
      if (!currentUserId) continue;
      const peerIsAuthor = message.fromUserId !== currentUserId;
      const userId = peerIsAuthor ? message.fromUserId : message.toUserId;
      if (userId === currentUserId) continue;
      const existing = contacts.get(userId);
      const messageName = peerIsAuthor ? message.author : message.recipient;
      const messageAvatarUrl = peerIsAuthor ? message.authorAvatarUrl : message.recipientAvatarUrl;
      contacts.set(userId, {
        userId,
        name: existing?.online ? existing.name : messageName,
        avatarUrl: existing?.online ? existing.avatarUrl : messageAvatarUrl ?? existing?.avatarUrl,
        online: existing?.online ?? false,
      });
    }
    return contacts;
  }, [currentUserId, directMessages, members]);
  const mappedActiveDirectContact = activeDirectUserId ? directContacts.get(activeDirectUserId) : undefined;
  const activeDirectContact = activeDirectUserId
    ? activeDirectContactHint?.userId === activeDirectUserId
      ? {
        ...activeDirectContactHint,
        name: mappedActiveDirectContact?.online ? mappedActiveDirectContact.name : activeDirectContactHint.name,
        avatarUrl: mappedActiveDirectContact?.online ? mappedActiveDirectContact.avatarUrl : activeDirectContactHint.avatarUrl,
        online: mappedActiveDirectContact?.online ?? false,
      }
      : mappedActiveDirectContact ?? null
    : null;
  const directConversation = useMemo(() => directMessages.filter((message) => currentUserId && activeDirectUserId
    && ((message.fromUserId === currentUserId && message.toUserId === activeDirectUserId)
      || (message.fromUserId === activeDirectUserId && message.toUserId === currentUserId))),
  [activeDirectUserId, currentUserId, directMessages]);
  const profileRole = useMemo(() => {
    if (localGuestMode) return undefined;
    const roleIds = authState?.memberships.flatMap((membership) => membership.kafcordRoleIds) ?? [];
    return [...community.roles].reverse().find((role) => roleIds.includes(role.id))?.name;
  }, [authState, community.roles, localGuestMode]);
  const voiceParticipants = useMemo(
    () => members.filter((member) => member.voiceChannelId === voiceChannel),
    [members, voiceChannel],
  );
  const selectedVoiceData = voiceChannels.find((channel) => channel.id === selectedVoiceChannel);
  const selectedVoiceMembers = members.filter((member) => member.voiceChannelId === selectedVoiceChannel);
  // The same account open on PC and phone is listed once; the session in voice wins.
  const presentMembers = useMemo(() => {
    const byAccount = new Map<string, Member>();
    for (const member of members) {
      const key = member.kafcordUserId ?? member.socketId;
      const current = byAccount.get(key);
      if (!current || (!current.voiceChannelId && member.voiceChannelId)) byAccount.set(key, member);
    }
    return [...byAccount.values()];
  }, [members]);
  const availableScreens = Object.entries(screenPreviews);
  const activeScreenMember = activeScreenPeerId ? members.find((member) => member.socketId === activeScreenPeerId) : undefined;
  const communityDisplayName = community.importedFrom?.sourceName || community.name;
  const viewingVoice = Boolean(voiceChannel && mainView === "voice");
  const viewingDirect = mainView === "direct" && Boolean(activeDirectContact);
  const callTileCount = voiceParticipants.length + availableScreens.length + (screenStream ? 1 : 0);
  // State, not a ref: the grid mounts and unmounts with the voice view.
  const [callGridElement, setCallGridElement] = useState<HTMLDivElement | null>(null);
  const callGridTileWidth = useFittedTileWidth(callGridElement, callTileCount, !expandedScreenPeerId);
  const screenViewerLabel = `${screenViewerCount} ${screenViewerCount === 1 ? "pessoa assistindo" : "pessoas assistindo"}`;
  const canChooseOutput = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
  const transmitting = micEnabled && !serverMuted && !serverDeafened && (inputMode === "voice" ? voiceDetected : pttPressed);
  voiceStateRef.current = {
    micEnabled: micEnabled && !serverMuted && !serverDeafened,
    deafened: deafened || serverDeafened,
    transmitting,
  };

  useEffect(() => {
    mainViewRef.current = mainView;
    if (mainView !== "text") setShowPinnedMessages(false);
  }, [mainView]);
  useEffect(() => { activeChannelRef.current = activeChannel; }, [activeChannel]);
  // Load the new version held back by a live screen or camera once both end.
  useEffect(() => {
    if (screenStream || cameraStream || !pendingClientBuildRef.current) return;
    const build = pendingClientBuildRef.current;
    pendingClientBuildRef.current = null;
    reloadForClientBuild(build);
  }, [screenStream, cameraStream]);
  useEffect(() => { activeDirectUserIdRef.current = activeDirectUserId; }, [activeDirectUserId]);
  useEffect(() => { currentUserIdRef.current = currentUserId; }, [currentUserId]);
  useEffect(() => { localStorage.setItem("kafcord:user-volumes", JSON.stringify(userVolumes)); }, [userVolumes]);





  useEffect(() => {
    if (!userContextMenu) return;
    const close = () => setUserContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [userContextMenu]);

  useEffect(() => {
    if (!directMessageContextMenu) return;
    const close = () => setDirectMessageContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [directMessageContextMenu]);

  useEffect(() => {
    if (!voiceChannel || !socketRef.current) return;
    socketRef.current.emit("voice:state", {
      micEnabled: micEnabled && !serverMuted && !serverDeafened,
      deafened: deafened || serverDeafened,
      cameraEnabled: Boolean(cameraStream),
      screenSharing: Boolean(screenStream),
      voiceDetected: transmitting,
    });
  }, [cameraStream, deafened, micEnabled, screenStream, serverDeafened, serverMuted, transmitting, voiceChannel]);

  useEffect(() => {
    let active = true;
    void fetch("/api/auth/me")
      .then((response) => response.json() as Promise<AuthState>)
      .then((result) => {
        if (!active) return;
        setAuthState(result);
        if (result.canImportDiscordModel && initialDiscordResult === "connected") setShowImporter(true);
        if (!result.authenticated || !result.user) return;
        if (localGuestMode && result.canUseLocalGuest && localGuestProfile) {
          localStorage.setItem("kafcord:name", localGuestProfile.name);
          setName(localGuestProfile.name);
          setJoined(true);
          setNotice("Perfil de convidado local ativado pela conta proprietária.");
          return;
        }
        if (localGuestMode) {
          localStorage.removeItem("kafcord:local-guest-mode");
          setLocalGuestMode(false);
        }
        const displayName = result.user.displayName.slice(0, 32);
        localStorage.setItem("kafcord:name", displayName);
        setName(displayName);
        setJoined(true);
        setNotice(result.memberships.length > 0
          ? "Identidade Discord reconhecida. Seus cargos importados foram ativados."
          : "Identidade Discord confirmada. Você entrou sem vínculo importado.");
      })
      .catch(() => {
        if (active) setAuthState({
          authenticated: false,
          user: null,
          memberships: [],
          canImportDiscordModel: false,
          canUseLocalGuest: false,
          canMoveMembers: false,
          canMuteMembers: false,
          canDeafenMembers: false,
          canManageMessages: false,
        });
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!authState?.authenticated) return;
    let active = true;
    void fetch("/api/profile", { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json() as KcordProfile & { error?: string };
        if (!response.ok) throw new Error(result.error ?? "Não foi possível carregar o perfil.");
        return result;
      })
      .then((profile) => {
        if (!active) return;
        setKcordProfile(profile);
        setProfileNameDraft(profile.displayName);
        if (!localGuestMode) {
          setName(profile.displayName);
          localStorage.setItem("kafcord:name", profile.displayName);
        }
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [authState?.authenticated, localGuestMode]);

  useEffect(() => () => {
    if (profileAvatarPreview?.startsWith("blob:")) URL.revokeObjectURL(profileAvatarPreview);
  }, [profileAvatarPreview]);

  useEffect(() => {
    if (localGuestMode || !currentAvatarUrl || !socketRef.current?.connected) return;
    socketRef.current.emit("profile:sync", { avatarUrl: currentAvatarUrl });
  }, [currentAvatarUrl, localGuestMode]);

  useEffect(() => {
    if (!textChannels.some((channel) => channel.id === activeChannel)) {
      setActiveChannel(textChannels[0]?.id ?? "geral");
    }
  }, [activeChannel, textChannels]);




  const openAudioSettings = async () => {
    setShowAudioSettings(true);
    setSettingsTab("voice");
    setAudioSettingsError("");
    void window.kafcordDesktop?.getAutoStart?.().then(setAutoStart).catch(() => setAutoStart(null));
    void desktopSystemInfo().then((info) => setDesktopCaptureMode(info?.screenCaptureMode ?? null));
    try {
      const knownDevices = await navigator.mediaDevices.enumerateDevices();
      if (!knownDevices.some((device) => device.kind === "audioinput" && device.label)) {
        const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        permissionStream.getTracks().forEach((track) => track.stop());
      }
      await refreshAudioDevices();
    } catch {
      setAudioSettingsError("Libere o microfone no navegador para listar e testar os dispositivos.");
      await refreshAudioDevices().catch(() => undefined);
    }
  };


  // Mobile browsers may leave the mic's AudioContext suspended after joining or
  // interrupt it later; any touch while in voice is a gesture that can resume it.
  useEffect(() => {
    if (!voiceChannel) return;
    const resumeInput = () => {
      resumeInputContext();
      resumeBlockedRemoteAudio();
    };
    // iOS grants playback permission on touchend/click rather than pointerdown.
    const gestureEvents = ["pointerdown", "touchend", "click"] as const;
    gestureEvents.forEach((name) => window.addEventListener(name, resumeInput, true));
    let wasBlocked = false;
    const onBlockedChange = (blocked: boolean) => {
      if (blocked && !wasBlocked) setNotice("Toque em qualquer lugar da tela para ativar o som da chamada.");
      wasBlocked = blocked;
    };
    blockedAudioListeners.add(onBlockedChange);
    return () => {
      gestureEvents.forEach((name) => window.removeEventListener(name, resumeInput, true));
      blockedAudioListeners.delete(onBlockedChange);
    };
  }, [resumeInputContext, voiceChannel]);


  // Installed app on iOS: the Discord login finished in a separate browser, so
  // the app keeps asking the server for the confirmed session until it arrives.
  useEffect(() => {
    if (!loginHandoff) return;
    let stopped = false;
    const finish = (message: string) => {
      stopped = true;
      forgetStoredLoginHandoff();
      setLoginHandoff(null);
      setLoginHandoffMessage(message);
    };
    const claim = async () => {
      if (stopped) return;
      if (loginHandoff.expiresAt <= Date.now()) {
        finish("O pedido de login expirou. Toque em Entrar com Discord de novo.");
        return;
      }
      try {
        const response = await fetch("/api/auth/handoff/claim", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ id: loginHandoff.id }),
        });
        const result = await response.json().catch(() => ({})) as { status?: string };
        if (stopped) return;
        if (result.status === "done") {
          finish("");
          location.replace("/?discord=login");
        } else if (result.status === "expired" || result.status === "forbidden") {
          finish("O pedido de login expirou. Toque em Entrar com Discord de novo.");
        }
      } catch {
        // Offline for a moment; the next attempt retries.
      }
    };
    void claim();
    const timer = window.setInterval(() => { void claim(); }, 2000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void claim();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [loginHandoff]);

  const startDiscordLogin = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!isStandaloneApp()) return;
    event.preventDefault();
    setLoginHandoffMessage("");
    try {
      const response = await fetch("/api/auth/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: "{}",
      });
      if (!response.ok) throw new Error("handoff unavailable");
      const handoff = await response.json() as LoginHandoff;
      try {
        localStorage.setItem(LOGIN_HANDOFF_KEY, JSON.stringify(handoff));
      } catch {
        // The page keeps the request in memory while it stays open.
      }
      setLoginHandoff(handoff);
      window.location.href = `/auth/discord/login?handoff=${encodeURIComponent(handoff.id)}`;
    } catch {
      window.location.href = "/auth/discord/login";
    }
  };

  const cancelLoginHandoff = () => {
    forgetStoredLoginHandoff();
    setLoginHandoff(null);
  };

  // A locked phone pauses the web app like minimizing does, so on touch devices
  // the screen stays awake while in a voice room (not in AFK). The system drops
  // the lock whenever the page is hidden, so it is requested again on return.
  useEffect(() => {
    const inAfkChannel = voiceChannel === community.afkChannelId;
    if (!voiceChannel || inAfkChannel || !touchOnly || !("wakeLock" in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let requesting = false;
    let cancelled = false;
    const acquire = async () => {
      if (cancelled || requesting || document.visibilityState !== "visible") return;
      if (sentinel && !sentinel.released) return;
      requesting = true;
      try {
        sentinel = await navigator.wakeLock.request("screen");
        if (cancelled) void sentinel.release().catch(() => undefined);
      } catch {
        // Battery saver or no user gesture yet; the next tap or return retries.
      } finally {
        requesting = false;
      }
    };
    const onEvent = () => { void acquire(); };
    void acquire();
    document.addEventListener("visibilitychange", onEvent);
    window.addEventListener("touchend", onEvent, true);
    window.addEventListener("click", onEvent, true);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onEvent);
      window.removeEventListener("touchend", onEvent, true);
      window.removeEventListener("click", onEvent, true);
      void sentinel?.release().catch(() => undefined);
    };
  }, [community.afkChannelId, touchOnly, voiceChannel]);

  // Phones (iOS above all) pause the page in background: the microphone stops
  // and peer connections drop. On return, restore the mic and rebuild the call.
  useEffect(() => {
    if (!voiceChannel) return;
    let hiddenAt = 0;
    let recovering = false;
    const onVisibility = async () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      const wasHiddenFor = hiddenAt ? Date.now() - hiddenAt : 0;
      hiddenAt = 0;
      resumeInputContext();
      resumePausedRemoteAudio();
      if (recovering || wasHiddenFor < 2000) return;
      recovering = true;
      try {
        const micReplaced = await recoverMicrophoneRef.current();
        const socket = socketRef.current;
        const channelId = voiceChannelRef.current;
        const peersHealthy = [...peersRef.current.values()].every((peer) => peer.connectionState === "connected");
        // A disconnected socket rejoins through session:ready; otherwise rejoin here.
        if (socket?.connected && channelId && (micReplaced || !peersHealthy)) {
          resetRemoteVoiceConnections();
          socket.emit("voice:join", { channelId });
          socket.emit("voice:state", {
            ...voiceStateRef.current,
            cameraEnabled: Boolean(cameraRef.current),
            screenSharing: Boolean(screenRef.current),
          });
          socket.emit("screen:list:request");
          if (isAppleMobile()) setNotice("No iPhone a chamada pausa enquanto o KCord fica minimizado. Áudio reconectado.");
        }
      } catch {
        setNotice("Não foi possível reativar o microfone. Saia e entre de novo na sala de voz.");
      } finally {
        recovering = false;
      }
    };
    const onVisibilityEvent = () => { void onVisibility(); };
    document.addEventListener("visibilitychange", onVisibilityEvent);
    window.addEventListener("pageshow", onVisibilityEvent);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityEvent);
      window.removeEventListener("pageshow", onVisibilityEvent);
    };
  }, [resetRemoteVoiceConnections, resumeInputContext, voiceChannel]);





  // Tells the server the user is still around, so they are not moved to the AFK channel.
  useEffect(() => {
    if (!voiceChannel) return;
    let lastPingAt = 0;
    const ping = () => {
      const now = Date.now();
      if (now - lastPingAt < 60_000) return;
      lastPingAt = now;
      socketRef.current?.emit("activity:ping");
    };
    const events = ["pointerdown", "keydown", "wheel", "focus"] as const;
    events.forEach((name) => window.addEventListener(name, ping, { passive: true }));
    return () => events.forEach((name) => window.removeEventListener(name, ping));
  }, [voiceChannel]);


  // Owner only (the server checks again). The slider moves locally right away;
  // the server, and through it everyone else, gets at most a few updates a second.
  const changeVoiceEq = (gains: number[]) => {
    setVoiceEq(gains);
    window.clearTimeout(voiceEqSendTimerRef.current);
    voiceEqSendTimerRef.current = window.setTimeout(() => socketRef.current?.emit("voice:eq:set", { gains }), 200);
  };

  const closeAudioSettings = () => {
    stopMicrophoneTest();
    setRecordingPttKey(false);
    setShowAudioSettings(false);
  };

  const loadDiscordStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/discord/status");
      const result = await response.json() as DiscordStatus;
      setDiscordStatus(result);
      setSelectedGuildId((current) => current || result.manageableGuilds[0]?.id || "");
    } catch {
      setImportError("Não foi possível consultar a integração Discord.");
    }
  }, []);

  useEffect(() => {
    if (showImporter) void loadDiscordStatus();
  }, [loadDiscordStatus, showImporter]);

  useEffect(() => {
    if (!joined) return;

    const socket = io({ transports: ["websocket", "polling"] });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      setNoticeState("Conectado ao pulso da comunidade.");
      socket.emit("session:join", {
        name,
        avatarUrl: localGuestMode ? undefined : kcordProfile?.avatarUrl ?? authState?.user?.avatarUrl,
        localGuest: localGuestMode && localGuestProfile
          ? { name: localGuestProfile.name }
          : undefined,
      });
    });
    socket.on("session:error", ({ message }: { message?: string }) => {
      setConnected(false);
      setJoined(false);
      setNotice(message ?? "Entre com Discord para acessar o KCord.");
    });
    // The same account signed in on another device; this one stays offline until the
    // user picks it again, so two devices never keep kicking each other.
    socket.on("session:replaced", () => {
      leaveVoiceRef.current();
      try {
        sessionStorage.removeItem("kafcord:voice-channel-id");
      } catch {
        // Nothing to forget.
      }
      setSessionReplaced(true);
    });
    socket.on("disconnect", (reason) => {
      setConnected(false);
      resetViewerCount();
      resetRemoteVoiceConnections();
      setNotice(reason === "io server disconnect" ? "Sessão encerrada pelo servidor." : "Conexão interrompida. Tentando reconectar…");
    });
    socket.on("session:ready", (payload: { messages: ChatMessage[]; channelUnread?: Record<string, number>; directMessages?: DirectMessage[]; directUnread?: Record<string, number>; members: Member[]; community: CommunityConfig; voiceEq?: { gains?: number[] }; clientBuild?: string | null }) => {
      if (payload.clientBuild && loadedClientBuild && payload.clientBuild !== loadedClientBuild) {
        // A reload rejoins the voice room, but would end a live screen or camera.
        if (screenRef.current || cameraRef.current) {
          pendingClientBuildRef.current = payload.clientBuild;
          setNotice("Há uma nova versão do KCord. Ela será carregada quando você encerrar a transmissão.");
        } else if (reloadForClientBuild(payload.clientBuild)) {
          return;
        }
      }
      loadSession(payload);
      setMembers(normalizeMembers(payload.members));
      setCommunity(payload.community);
      if (payload.voiceEq?.gains?.length === VOICE_EQ_BANDS.length) setVoiceEq(payload.voiceEq.gains);
      const resumeChannelId = voiceChannelRef.current;
      const reloadChannelId = !resumeChannelId ? reloadVoiceChannelRef.current : null;
      if (resumeChannelId && payload.community.voiceChannels.some((channel) => channel.id === resumeChannelId)) {
        socket.emit("voice:join", { channelId: resumeChannelId });
        socket.emit("voice:state", {
          ...voiceStateRef.current,
          cameraEnabled: Boolean(cameraRef.current),
          screenSharing: Boolean(screenRef.current),
        });
        resumeScreenAnnouncement();
        socket.emit("screen:list:request");
        if (isLiveKitChannel(resumeChannelId)) {
          joinLiveKit(resumeChannelId).catch((error: unknown) => {
            setNotice(error instanceof Error ? error.message : "Não foi possível voltar à sala de voz.");
            leaveVoiceRef.current();
          });
        }
        const channelName = payload.community.voiceChannels.find((channel) => channel.id === resumeChannelId)?.name;
        setNotice(`Reconectado automaticamente a ${channelName ?? "sua sala de voz"}.`);
      } else if (resumeChannelId) {
        leaveVoiceRef.current();
        setNotice("A sala de voz anterior não está mais disponível.");
      } else if (reloadChannelId && payload.community.voiceChannels.some((channel) => channel.id === reloadChannelId)) {
        reloadVoiceChannelRef.current = null;
        void joinVoiceRef.current(reloadChannelId).then(() => {
          const channelName = payload.community.voiceChannels.find((channel) => channel.id === reloadChannelId)?.name;
          setNotice(`Reconectado automaticamente a ${channelName ?? "sua sala de voz"} após recarregar.`);
        });
      } else if (reloadChannelId) {
        reloadVoiceChannelRef.current = null;
        try {
          sessionStorage.removeItem("kafcord:voice-channel-id");
        } catch {
          // Session storage may be unavailable in restricted browser modes.
        }
      }
    });
    socket.on("members:update", (nextMembers: Member[]) => setMembers(normalizeMembers(nextMembers)));
    socket.on("admin:client-report", (report: { displayName: string; kind: ClientReportKind; message: string }) => clientReportAlertRef.current(report));
    socket.on("voice:eq", (next: { gains?: number[] }) => {
      if (next?.gains?.length === VOICE_EQ_BANDS.length) setVoiceEq(next.gains);
    });
    socket.on("community:update", (nextCommunity: CommunityConfig) => {
      setCommunity(nextCommunity);
      setNotice(`A estrutura de ${nextCommunity.name} foi atualizada.`);
    });
    socket.on("chat:message", onChatMessage);
    socket.on("chat:read-state", onChatReadState);
    socket.on("chat:update", onChatUpdate);
    socket.on("chat:delete", onChatDelete);
    socket.on("dm:message", onDirectMessage);
    socket.on("dm:delete", onDirectDelete);
    socket.on("dm:identity-removed", onDirectIdentityRemoved);
    socket.on("media:track-meta", (meta: Parameters<typeof onTrackMeta>[0]) => { if (!liveKitActiveRef.current) onTrackMeta(meta); });
    socket.on("screen:list", onScreenList);
    socket.on("screen:available", onScreenAvailable);
    socket.on("screen:thumbnail", onScreenThumbnail);
    socket.on("screen:stop", onScreenStop);
    socket.on("screen:viewer-join", (viewer: Parameters<typeof onViewerJoin>[0]) => { if (!liveKitActiveRef.current) onViewerJoin(viewer); });
    socket.on("screen:viewer-left", (viewer: Parameters<typeof onViewerLeft>[0]) => { if (!liveKitActiveRef.current) onViewerLeft(viewer); });
    socket.on("screen:viewer-count", onViewerCount);
    socket.on("voice:afk", ({ channelId }: { channelId?: string }) => {
      if (typeof channelId !== "string" || !voiceChannelRef.current || voiceChannelRef.current === channelId) return;
      void joinVoiceRef.current(channelId);
      announceAfkMove();
    });
    socket.on("voice:moved", ({ channelId, channelName, movedBy }: { channelId?: string; channelName?: string; movedBy?: string }) => {
      if (typeof channelId !== "string" || !voiceChannelRef.current || voiceChannelRef.current === channelId) return;
      void joinVoiceRef.current(channelId).then(() => {
        setNotice(`${String(movedBy || "Um administrador").slice(0, 32)} moveu você para ${String(channelName || "outra sala").slice(0, 80)}.`);
      });
    });
    socket.on("voice:moderation", ({ serverMuted: mutedByServer, serverDeafened: deafenedByServer, moderatedBy, action, enabled }: {
      serverMuted?: boolean;
      serverDeafened?: boolean;
      moderatedBy?: string;
      action?: "mute" | "deafen";
      enabled?: boolean;
    }) => {
      if (mutedByServer || deafenedByServer) {
        setMicEnabled(false);
        setPttPressed(false);
      }
      if (deafenedByServer) setDeafened(true);
      if (action === "deafen" && enabled === false) setDeafened(false);
      if (moderatedBy && action) {
        const description = action === "mute" ? "seu microfone no servidor" : "seu áudio no servidor";
        setNotice(`${String(moderatedBy).slice(0, 32)} ${enabled ? "desativou" : "reativou"} ${description}.`);
      }
    });
    socket.on("voice:disconnected", ({ moderatedBy }: { moderatedBy?: string }) => {
      leaveVoiceRef.current();
      setNotice(`${String(moderatedBy || "Um administrador").slice(0, 32)} desconectou você da sala de voz.`);
    });
    socket.on("voice:peers", (peerIds: string[]) => { if (!liveKitActiveRef.current) void onVoicePeers(peerIds); });
    socket.on("voice:member-left", closePeer);
    socket.on("rtc:signal", (signal: Parameters<typeof onRtcSignal>[0]) => { if (!liveKitActiveRef.current) void onRtcSignal(signal); });

    return () => {
      socket.disconnect();
      socketRef.current = null;
      peersRef.current.forEach((peer) => peer.close());
      peersRef.current.clear();
    };
  }, [authState?.user?.avatarUrl, closePeer, isLiveKitChannel, joinLiveKit, joined, kcordProfile?.avatarUrl, liveKitActiveRef, loadSession, localGuestMode, localGuestProfile, name, normalizeMembers, onChatDelete, onChatMessage, onChatReadState, onChatUpdate, onDirectDelete, onDirectIdentityRemoved, onDirectMessage, onRtcSignal, onScreenAvailable, onScreenList, onScreenStop, onScreenThumbnail, onTrackMeta, onVoicePeers, resetRemoteVoiceConnections]);

  const openUserContextMenu = (event: ReactMouseEvent<HTMLElement>, member: Member) => {
    if (member.socketId === socketRef.current?.id) return;
    event.preventDefault();
    setDirectMessageContextMenu(null);
    setUserContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 280)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 430)),
      member,
    });
  };

  const canMoveVoiceMembers = Boolean(authState?.canMoveMembers && !localGuestMode);
  const canMuteVoiceMembers = Boolean(authState?.canMuteMembers && !localGuestMode);
  const canDeafenVoiceMembers = Boolean(authState?.canDeafenMembers && !localGuestMode);

  const requestVoiceMemberMove = (target: Member, channelId: string) => {
    if (!canMoveVoiceMembers || !target.voiceChannelId || target.voiceChannelId === channelId) return;
    socketRef.current?.emit("voice:move-member", { targetSocketId: target.socketId, channelId }, (result: { ok: boolean; error?: string }) => {
      if (!result?.ok) {
        setNotice(result?.error ?? "Não foi possível mover o usuário.");
        return;
      }
      const channelName = voiceChannels.find((channel) => channel.id === channelId)?.name ?? "outra sala";
      setNotice(`${target.name} está sendo movido para ${channelName}.`);
      setUserContextMenu(null);
    });
  };

  const moderateVoiceMember = (target: Member, action: "mute" | "deafen" | "disconnect", enabled?: boolean) => {
    socketRef.current?.emit("voice:moderate-member", { targetSocketId: target.socketId, action, enabled }, (result: { ok: boolean; error?: string }) => {
      if (!result?.ok) {
        setNotice(result?.error ?? "Não foi possível moderar o usuário.");
        return;
      }
      const actionLabel = action === "disconnect"
        ? "desconectado da sala"
        : action === "mute"
          ? `${enabled ? "silenciado" : "reativado"} no servidor`
          : `${enabled ? "ensurdecido" : "reativado"} no servidor`;
      setNotice(`${target.name} foi ${actionLabel}.`);
      setUserContextMenu(null);
    });
  };

  const beginVoiceMemberDrag = (event: ReactDragEvent<HTMLElement>, member: Member) => {
    if (!canMoveVoiceMembers || !member.voiceChannelId || member.socketId === socketRef.current?.id) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-kafcord-voice-member", member.socketId);
    draggedVoiceMemberIdRef.current = member.socketId;
    setDraggedVoiceMemberId(member.socketId);
    setVoiceDropTargetId(null);
    setUserContextMenu(null);
  };

  const allowVoiceMemberDrop = (event: ReactDragEvent<HTMLElement>, channelId: string) => {
    const draggedMember = members.find((member) => member.socketId === draggedVoiceMemberIdRef.current);
    if (!canMoveVoiceMembers || !draggedMember || draggedMember.voiceChannelId === channelId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setVoiceDropTargetId(channelId);
  };

  const moveVoiceMember = (event: ReactDragEvent<HTMLElement>, channelId: string) => {
    event.preventDefault();
    event.stopPropagation();
    const targetSocketId = event.dataTransfer.getData("application/x-kafcord-voice-member") || draggedVoiceMemberIdRef.current;
    const target = members.find((member) => member.socketId === targetSocketId);
    draggedVoiceMemberIdRef.current = null;
    setDraggedVoiceMemberId(null);
    setVoiceDropTargetId(null);
    if (!target) return;
    requestVoiceMemberMove(target, channelId);
  };

  const finishVoiceMemberDrag = () => {
    draggedVoiceMemberIdRef.current = null;
    setDraggedVoiceMemberId(null);
    setVoiceDropTargetId(null);
  };

  const openDirectChat = (userId: string, preferredContact?: DirectContact) => {
    if (!currentUserId || userId === currentUserId) return;
    openDirectConversation(userId, preferredContact ?? directContacts.get(userId) ?? null);
  };

  const setMemberVolume = (member: Member, volume: number) => {
    const key = memberVolumeKey(member);
    setUserVolumes((current) => ({ ...current, [key]: volume }));
  };

  const leaveVoice = useCallback(() => {
    const wasConnected = Boolean(voiceChannelRef.current);
    const shouldPlayCue = wasConnected && !suppressLeaveCueRef.current;
    suppressLeaveCueRef.current = false;
    socketRef.current?.emit("screen:stop");
    socketRef.current?.emit("voice:leave");
    leaveLiveKit();
    resetRemoteVoiceConnections();
    releaseMicrophone();
    releaseScreenShare();
    releaseCamera();
    voiceChannelRef.current = null;
    try {
      sessionStorage.removeItem("kafcord:voice-channel-id");
    } catch {
      // Session storage may be unavailable in restricted browser modes.
    }
    setPttPressed(false);
    setVoiceChannel(null);
    watchedScreenDiscordUserIdRef.current = null;
    setSelectedVoiceChannel(null);
    setMainView("text");
    setMobileView("channels");
    if (shouldPlayCue) void playInterfaceCue(disconnectFromChannelSound);
  }, [leaveLiveKit, playInterfaceCue, releaseCamera, releaseScreenShare, resetRemoteVoiceConnections]);
  leaveVoiceRef.current = leaveVoice;

  const openProfileEditor = () => {
    if (localGuestMode || !authState?.authenticated) return;
    setProfileNameDraft(kcordProfile?.displayName ?? authState.user?.displayName ?? name);
    setProfileAvatarFile(null);
    setProfileAvatarPreview(kcordProfile?.avatarUrl ?? authState.user?.avatarUrl ?? null);
    setProfileError("");
    setProfileMenuOpen(false);
    setShowProfileEditor(true);
  };

  const closeProfileEditor = () => {
    if (profileSaving) return;
    setShowProfileEditor(false);
    setProfileAvatarFile(null);
    setProfileAvatarPreview(null);
    setProfileError("");
  };

  const selectProfileAvatar = (file: File | undefined) => {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) {
      setProfileError("Escolha uma imagem JPG, PNG, WEBP ou GIF.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setProfileError("A imagem deve ter no máximo 2 MB.");
      return;
    }
    setProfileError("");
    setProfileAvatarFile(file);
    setProfileAvatarPreview(URL.createObjectURL(file));
  };

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    const displayName = profileNameDraft.trim().slice(0, 32);
    if (displayName.length < 2) {
      setProfileError("O nome precisa ter pelo menos 2 caracteres.");
      return;
    }
    setProfileSaving(true);
    setProfileError("");
    try {
      const body = new FormData();
      body.append("displayName", displayName);
      if (profileAvatarFile) body.append("avatar", profileAvatarFile);
      const response = await fetch("/api/profile", { method: "POST", body });
      const result = await response.json() as KcordProfile & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Não foi possível salvar o perfil.");
      setKcordProfile(result);
      setName(result.displayName);
      localStorage.setItem("kafcord:name", result.displayName);
      setMembers((current) => current.map((member) => member.kafcordUserId === result.userId && member.authenticated
        ? { ...member, name: result.displayName, avatarUrl: result.avatarUrl }
        : member));
      setShowProfileEditor(false);
      setProfileAvatarFile(null);
      setProfileAvatarPreview(null);
      setNotice("Perfil atualizado.");
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Não foi possível salvar o perfil.");
    } finally {
      setProfileSaving(false);
    }
  };

  const copyCurrentUserId = async () => {
    if (!currentUserId) return;
    await navigator.clipboard.writeText(currentUserId).catch(() => undefined);
    setProfileMenuOpen(false);
    setNotice("ID do usuário copiado.");
  };

  const enterAsLocalGuest = (event: FormEvent) => {
    event.preventDefault();
    const cleanName = localGuestNameDraft.trim().slice(0, 32);
    if (!authState?.canUseLocalGuest || !cleanName) return;
    if (voiceChannelRef.current) leaveVoice();
    const profile = { name: cleanName };
    localStorage.setItem("kafcord:local-guest-profile", JSON.stringify(profile));
    localStorage.setItem("kafcord:local-guest-mode", "true");
    localStorage.setItem("kafcord:name", cleanName);
    clearDirectInterface();
    setLocalGuestProfile(profile);
    setLocalGuestMode(true);
    setName(cleanName);
    setJoined(true);
    setShowLocalGuestDialog(false);
    setNotice(`Você entrou como convidado local: ${cleanName}.`);
  };

  const returnToDiscordIdentity = () => {
    if (!authState?.user) return;
    if (voiceChannelRef.current) leaveVoice();
    const displayName = (kcordProfile?.displayName ?? authState.user.displayName).slice(0, 32);
    localStorage.removeItem("kafcord:local-guest-mode");
    localStorage.setItem("kafcord:name", displayName);
    clearDirectInterface();
    setLocalGuestMode(false);
    setName(displayName);
    setJoined(true);
    setShowLocalGuestDialog(false);
    setNotice("Você voltou para sua identidade do Discord. O ID e o chat do convidado foram apagados.");
  };

  useEffect(() => {
    if (voiceChannel && !voiceChannels.some((channel) => channel.id === voiceChannel)) {
      leaveVoice();
    }
  }, [leaveVoice, voiceChannel, voiceChannels]);

  const joinVoice = async (channelId: string) => {
    if (voiceChannelRef.current === channelId) {
      leaveVoice();
      return;
    }
    // The AFK channel keeps microphone and audio off; any other channel restores them.
    let micOn = micEnabled;
    if (channelId === community.afkChannelId) {
      afkRestoreRef.current ??= { mic: deafened ? micBeforeDeafenRef.current : micEnabled, deafened };
      micOn = false;
      setMicEnabled(false);
      setDeafened(true);
      setPttPressed(false);
    } else if (afkRestoreRef.current) {
      const restore = afkRestoreRef.current;
      afkRestoreRef.current = null;
      micOn = restore.deafened ? false : restore.mic;
      micBeforeDeafenRef.current = restore.mic;
      setMicEnabled(micOn);
      setDeafened(restore.deafened);
    }
    try {
      if (voiceChannelRef.current) suppressLeaveCueRef.current = true;
      leaveVoice();
      await loadRtcConfiguration();
      await startMicrophone(inputDeviceId, micOn && inputMode === "voice");
      if (isLiveKitChannel(channelId)) {
        try {
          await joinLiveKit(channelId);
        } catch (error) {
          releaseMicrophone();
          setNotice(error instanceof Error ? error.message : "Não foi possível entrar na sala de voz.");
          return;
        }
      }
      voiceChannelRef.current = channelId;
      try {
        sessionStorage.setItem("kafcord:voice-channel-id", channelId);
      } catch {
        // Voice still works when session storage is unavailable.
      }
      setVoiceChannel(channelId);
      setSelectedVoiceChannel(channelId);
      setMainView("voice");
      setMobileView("content");
      socketRef.current?.emit("voice:join", { channelId });
      socketRef.current?.emit("screen:list:request");
      const channelName = voiceChannels.find((channel) => channel.id === channelId)?.name;
      setNotice(`Você entrou em ${channelName}.`);
      void playInterfaceCue(connectToChannelSound);
    } catch (error) {
      reportClientIssue("microphone", error, { step: "join-voice" });
      setNotice("Libere o microfone no navegador para entrar na sala de voz.");
    }
  };
  joinVoiceRef.current = joinVoice;

  // Like Discord, microphone and audio stay off while in the AFK channel.
  const blockedInAfkChannel = () => Boolean(voiceChannel && voiceChannel === community.afkChannelId);

  const openTextChannel = (channelId: string) => {
    activeChannelRef.current = channelId;
    mainViewRef.current = "text";
    setActiveChannel(channelId);
    setChannelUnread((current) => ({ ...current, [channelId]: 0 }));
    socketRef.current?.emit("chat:read", { channelId });
    setReplyingTo(null);
    setEditingMessageId(null);
    setShowPinnedMessages(false);
    setSelectedVoiceChannel(null);
    setMainView("text");
    if (window.matchMedia("(max-width: 720px)").matches) setMobileView("content");
  };

  const openVoiceChannel = (channelId: string) => {
    if (voiceChannelRef.current === channelId) {
      setSelectedVoiceChannel(channelId);
      setMainView("voice");
      setMobileView("content");
      return;
    }
    if (!window.matchMedia("(max-width: 720px)").matches) {
      void joinVoice(channelId);
      return;
    }
    if (voiceChannelRef.current) {
      void joinVoice(channelId);
      return;
    }
    setSelectedVoiceChannel(channelId);
    setMobileView("channels");
  };

  const returnToMobileChannels = () => {
    setMobileView("channels");
    setShowMobileMembers(false);
    setSelectedVoiceChannel(voiceChannelRef.current);
  };

  // On phones the content view is a history entry, so the system back button
  // (and the installed webapp's back gesture) returns to the channel list.
  const goBackToMobileChannels = () => {
    if ((history.state as { kcordView?: string } | null)?.kcordView === "content") history.back();
    else returnToMobileChannels();
  };

  const beginEdgeSwipe = (event: ReactTouchEvent) => {
    const touch = event.touches[0];
    swipeStartRef.current = touch && touch.clientX < 28 ? { x: touch.clientX, y: touch.clientY } : null;
  };

  const finishEdgeSwipe = (event: ReactTouchEvent) => {
    const start = swipeStartRef.current;
    const touch = event.changedTouches[0];
    swipeStartRef.current = null;
    if (!start || !touch) return;
    if (touch.clientX - start.x > 80 && Math.abs(touch.clientY - start.y) < 60) goBackToMobileChannels();
  };

  useEffect(() => {
    if (!joined || mobileView !== "content" || !window.matchMedia("(max-width: 720px)").matches) return;
    const state = history.state as Record<string, unknown> | null;
    if (state?.kcordView !== "content") history.pushState({ ...(state ?? {}), kcordView: "content" }, "");
  }, [joined, mobileView]);

  useEffect(() => {
    const handlePopState = () => {
      setMobileView("channels");
      setShowMobileMembers(false);
      setSelectedVoiceChannel(voiceChannelRef.current);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  // Hold-to-talk on the call bar. Capturing the pointer keeps the press alive when the
  // finger drifts, and the long-press menu/selection is blocked so the OS does not cancel it.
  const beginMobilePtt = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // Phones suspend or interrupt the mic's AudioContext (the sent track then carries
    // silence); a touch is a valid gesture to bring it back.
    resumeInputContext();
    if (!voiceChannel || blockedInAfkChannel() || !micEnabled || serverMuted || serverDeafened || inputMode !== "ptt") return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Capture is an enhancement; pointerup still ends the press.
    }
    setPttPressed(true);
  };

  const endMobilePtt = () => setPttPressed(false);

  const toggleMicrophone = () => {
    if (blockedInAfkChannel() || serverMuted || serverDeafened) return;
    setMicEnabled((current) => !current);
  };

  const toggleDeafen = () => {
    if (blockedInAfkChannel() || serverDeafened) return;
    if (deafened) {
      setDeafened(false);
      setMicEnabled(micBeforeDeafenRef.current);
      return;
    }
    micBeforeDeafenRef.current = micEnabled;
    setMicEnabled(false);
    setDeafened(true);
    setPttPressed(false);
  };

  const changeDesktopCaptureMode = async (mode: "wgc" | "legacy") => {
    const desktop = window.kafcordDesktop;
    if (!desktop?.setScreenCaptureMode || desktopCaptureMode === mode) return;
    const label = mode === "legacy" ? "Compatível (até 10 fps)" : "Desempenho (WGC)";
    if (!window.confirm(`Reiniciar o KCord para usar o modo ${label}?`)) return;
    saveVoiceResume(voiceChannelRef.current);
    if (!await desktop.setScreenCaptureMode(mode)) {
      setAudioSettingsError("Não foi possível alterar o modo de captura.");
      return;
    }
    setDesktopCaptureMode(mode);
  };

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await callStageRef.current?.requestFullscreen();
    } catch {
      setNotice("O navegador não permitiu abrir a chamada em tela cheia.");
    }
  };

  const previewTemplate = async (event: FormEvent) => {
    event.preventDefault();
    setImporting(true);
    setImportError("");
    setImportPreview(null);
    try {
      const response = await fetch("/api/import/discord-template/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: templateSource }),
      });
      const result = await response.json() as DiscordTemplatePreview & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Não foi possível ler o modelo.");
      setImportPreview(result);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Não foi possível ler o modelo.");
    } finally {
      setImporting(false);
    }
  };

  const applyTemplate = async () => {
    setImporting(true);
    setImportError("");
    try {
      const response = await fetch("/api/import/discord-template/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: templateSource, confirmation: "IMPORTAR" }),
      });
      const result = await response.json() as { community?: CommunityConfig; error?: string };
      if (!response.ok || !result.community) throw new Error(result.error ?? "Não foi possível aplicar o modelo.");
      setCommunity(result.community);
      setNotice(`Modelo ${result.community.name} importado com sucesso.`);
      setShowImporter(false);
      setImportPreview(null);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Não foi possível aplicar o modelo.");
    } finally {
      setImporting(false);
    }
  };

  const previewDiscordMembers = async () => {
    if (!selectedGuildId) return;
    setMemberImporting(true);
    setMemberImportMessage("");
    setImportError("");
    setMemberPreview(null);
    try {
      const response = await fetch("/api/discord/members/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guildId: selectedGuildId }),
      });
      const result = await response.json() as DiscordMemberPreview & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Não foi possível consultar os membros.");
      setMemberPreview(result);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Não foi possível consultar os membros.");
    } finally {
      setMemberImporting(false);
    }
  };

  const applyDiscordMembers = async () => {
    if (!selectedGuildId || !memberPreview) return;
    setMemberImporting(true);
    setMemberImportMessage("");
    setImportError("");
    try {
      const response = await fetch("/api/discord/members/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guildId: selectedGuildId, confirmation: "IMPORTAR MEMBROS" }),
      });
      const result = await response.json() as { imported?: number; botsIgnored?: number; error?: string };
      if (!response.ok || result.imported === undefined) throw new Error(result.error ?? "Não foi possível importar os membros.");
      setMemberImportMessage(`${result.imported} pessoas foram preparadas para vinculação. ${result.botsIgnored ?? 0} bots foram ignorados.`);
      setNotice(`${result.imported} membros do Discord aguardam o primeiro login no KCord.`);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Não foi possível importar os membros.");
    } finally {
      setMemberImporting(false);
    }
  };


  // Any unhandled error on this page is reported (a few per page load at most).
  useEffect(() => {
    const report = reportPageError;
    const onError = (event: ErrorEvent) => report(event.error ?? event.message, event.message);
    const onRejection = (event: PromiseRejectionEvent) => report(event.reason, "Promessa rejeitada");
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  // Failures in the desktop process wait there until a signed-in page sends them.
  useEffect(() => {
    const desktop = window.kafcordDesktop;
    if (!currentUserId || !desktop?.takeDesktopIssues) return undefined;
    const forward = () => {
      void desktop.takeDesktopIssues?.().then((issues) => {
        for (const issue of issues) reportClientIssue("desktop-error", new Error(`${issue.area}: ${issue.message}`), {}, issue.details);
      }).catch(() => undefined);
    };
    forward();
    return desktop.onDesktopIssues?.(forward);
  }, [currentUserId]);


  const adminChartMax = Math.max(1, ...(adminStats?.days.map((day) => day.sessions + day.publicMessages + day.privateMessages) ?? [1]));
  const adminDayAppBytes = (day: { networkBytesIn: number; networkBytesOut: number }) => day.networkBytesIn + day.networkBytesOut;
  const adminDayRelayBytes = (day: { relayBytesIn: number; relayBytesOut: number }) => day.relayBytesIn + day.relayBytesOut;
  const adminBandwidthMax = Math.max(1, ...(adminStats?.days.map((day) => adminDayAppBytes(day) + adminDayRelayBytes(day)) ?? [1]));
  const adminAppBytes = adminStats ? adminDayAppBytes(adminStats.totals) : 0;
  const adminRelayBytes = adminStats ? adminDayRelayBytes(adminStats.totals) : 0;

  if (!joined) {
    return (
      <main className="entry-shell">
        <section className="entry-card" aria-labelledby="entry-title">
          <div className="entry-brand-panel">
            <div className="entry-brand-lockup">
              <span className="entry-logo"><img src={kafcordLogo} alt="" /></span>
              <span><strong>KCord</strong><small>O Discord da Kafly</small></span>
            </div>

            <div className="entry-hero">
              <p className="eyebrow">VOZ · TEXTO · TRANSMISSÃO</p>
              <h1 id="entry-title">Sua comunidade.<br /><em>No mesmo canal.</em></h1>
              <p className="entry-copy">
                Converse, compartilhe sua tela e acompanhe sua turma sem perder o ritmo.
              </p>
            </div>

            <div className="entry-signal" aria-hidden="true">
              <i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i />
            </div>

            <div className="entry-presence">
              <span><i /> KCord pronto</span>
              <small>voz em tempo real</small>
              <small>transmissão sob demanda</small>
            </div>
          </div>

          <div className="entry-access-panel">
            <div className="entry-access-heading">
              <p className="eyebrow">ACESSO SEGURO</p>
              <h2>Entre no KCord.</h2>
              <p>Continue com sua conta do Discord para recuperar seu perfil, avatar e cargos.</p>
            </div>

            {initialDiscordResult && initialDiscordResult in discordLoginFailureMessages && notice && <p className="entry-alert" role="status">{notice}</p>}

            {loginHandoffMessage && <p className="entry-alert" role="status">{loginHandoffMessage}</p>}
            {loginHandoff && (
              <div className="entry-alert login-handoff" role="status">
                <span>Código de confirmação</span>
                <strong>{loginHandoff.code}</strong>
                <span>Na janela do Discord, confira se aparece este mesmo código e toque em <b>O código é igual</b>. Depois toque em <b>OK</b> ou <b>Concluído</b> para voltar: o KCord entra sozinho.</span>
                <button type="button" onClick={cancelLoginHandoff}>Cancelar</button>
              </div>
            )}

            <a className="discord-login" href="/auth/discord/login" onClick={(event) => void startDiscordLogin(event)}>
              <span className="credential-stamp" aria-hidden="true">
                <svg viewBox="0 0 24 24" focusable="false">
                  <path d="M7.2 7.1a13.6 13.6 0 0 1 9.6 0l.8 1.1c1.6 2.3 2.2 4.7 2.1 7.2a11.8 11.8 0 0 1-3.3 1.7l-.8-1.1c.7-.3 1.3-.6 1.8-1-3.5 1.6-7.3 1.6-10.8 0 .6.4 1.2.7 1.8 1l-.8 1.1a11.8 11.8 0 0 1-3.3-1.7c-.1-2.5.5-4.9 2.1-7.2l.8-1.1Zm2.2 7c.7 0 1.3-.7 1.3-1.5s-.6-1.5-1.3-1.5-1.3.7-1.3 1.5.6 1.5 1.3 1.5Zm5.2 0c.7 0 1.3-.7 1.3-1.5s-.6-1.5-1.3-1.5-1.3.7-1.3 1.5.6 1.5 1.3 1.5Z" />
                </svg>
              </span>
              <span><strong>Entrar com Discord</strong><small>Autenticação oficial do Discord</small></span>
              <b aria-hidden="true">→</b>
            </a>

            <p className="entry-note"><span aria-hidden="true">◇</span> O KCord recebe apenas sua identidade pública. Sua senha nunca é compartilhada.</p>

            {authState?.canUseLocalGuest && <>
              <div className="entry-divider"><span>acesso do proprietário</span></div>
              <form onSubmit={enterAsLocalGuest}>
                <label htmlFor="display-name">Convidado local temporário</label>
                <div className="entry-field">
                  <input
                    id="display-name"
                    value={localGuestNameDraft}
                    onChange={(event) => setLocalGuestNameDraft(event.target.value)}
                    placeholder="Nome do convidado"
                    maxLength={32}
                  />
                  <button type="submit">Entrar</button>
                </div>
              </form>
            </>}

            <p className="app-credit">KCord · by Anderson Guilherme</p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <div className={`app-shell ${voiceChannel ? "voice-active" : ""} ${viewingVoice ? "viewing-voice" : ""} ${viewingDirect ? "viewing-direct" : ""} ${mobileView === "channels" ? "mobile-channels" : "mobile-content"} ${selectedVoiceChannel && !voiceChannel ? "has-voice-preview" : ""}`}>
      <aside className="community-rail" aria-label="Comunidades">
        <button className="brand-mark logo-mark active" title={communityDisplayName}><img src={kafcordLogo} alt="KCord" /></button>
        <div className="rail-line" />
        {authState?.canImportDiscordModel && <button className="community-add" title="Importar modelo do Discord" onClick={() => setShowImporter(true)}>⇩</button>}
        {authState?.canImportDiscordModel && <button className="community-add admin-stats-button" title="Estatísticas administrativas" aria-label="Abrir estatísticas administrativas" onClick={() => setShowAdminStats(true)}>▥{unseenClientReports > 0 && <b className="admin-alert-badge" aria-label={`${unseenClientReports} falhas novas nos apps`}>{unseenClientReports > 9 ? "9+" : unseenClientReports}</b>}</button>}
        {authState?.canUseLocalGuest && <button
          type="button"
          className={`community-add local-guest-toggle ${localGuestMode ? "active" : ""}`}
          title={localGuestMode ? "Gerenciar convidado local" : "Entrar como convidado local"}
          aria-label={localGuestMode ? "Gerenciar convidado local" : "Entrar como convidado local"}
          onClick={() => {
            setLocalGuestNameDraft(localGuestProfile?.name ?? "");
            setShowLocalGuestDialog(true);
          }}
        >G</button>}
        {directUnreadOrder.length > 0 && <div className="direct-unread-list" aria-label="Mensagens privadas não lidas">
          {directUnreadOrder.map((userId) => {
            const contact = directContacts.get(userId);
            const count = directUnread[userId] ?? 0;
            if (!contact || count < 1) return null;
            return (
              <button key={userId} type="button" className="direct-unread-avatar" title={`${count} ${count === 1 ? "mensagem não lida" : "mensagens não lidas"} de ${contact.name}`} onClick={() => openDirectChat(userId)}>
                <UserAvatar name={contact.name} url={contact.avatarUrl} className="direct-avatar" />
                <b>{count > 99 ? "99+" : count}</b>
              </button>
            );
          })}
        </div>}
      </aside>

      <aside className="channel-panel">
        <header>
          <p className="eyebrow">COMUNIDADE</p>
          <h2>{communityDisplayName}</h2>
        </header>
        <nav aria-label="Canais">
          {channelSections.map((section) => (
            <section className="channel-section" key={section.id ?? "uncategorized"}>
              <p className="section-label">{section.name}</p>
              {section.textChannels.map((channel) => (
                <button
                  key={channel.id}
                  className={`channel-button ${mainView === "text" && activeChannel === channel.id ? "active" : ""} ${channelUnread[channel.id] ? "unread" : ""}`}
                  onClick={() => openTextChannel(channel.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setChannelUnread((current) => ({ ...current, [channel.id]: Math.max(1, current[channel.id] ?? 0) }));
                    socketRef.current?.emit("chat:mark-unread", { channelId: channel.id });
                    setNotice(`#${channel.name} foi marcado como não lido.`);
                  }}
                >
                  <span>#</span>{channel.name}
                  {Boolean(channelUnread[channel.id]) && <b>{channelUnread[channel.id] > 99 ? "99+" : channelUnread[channel.id]}</b>}
                </button>
              ))}
              {section.voiceChannels.length > 0 && section.textChannels.length > 0 && <p className="subsection-label">Voz</p>}
              {section.voiceChannels.map((channel) => (
                <div
                  key={channel.id}
                  className={`voice-channel-drop-zone ${voiceDropTargetId === channel.id ? "drop-target" : ""}`}
                  onDragEnter={(event) => allowVoiceMemberDrop(event, channel.id)}
                  onDragOver={(event) => allowVoiceMemberDrop(event, channel.id)}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setVoiceDropTargetId(null);
                  }}
                  onDrop={(event) => moveVoiceMember(event, channel.id)}
                >
                  <button
                    className={`channel-button voice ${voiceChannel === channel.id ? "connected" : ""} ${mainView === "voice" && (voiceChannel === channel.id || selectedVoiceChannel === channel.id) ? "active" : ""}`}
                    onClick={() => openVoiceChannel(channel.id)}
                  >
                    <span className="signal-icon"><CallIcon kind="speaker" /></span>{channel.name}
                  </button>
                  <div className="voice-members">
                    {members.filter((member) => member.voiceChannelId === channel.id).map((member) => (
                      <span
                        key={member.socketId}
                        className={`${member.voiceDetected ? "is-speaking" : ""} ${draggedVoiceMemberId === member.socketId ? "is-dragging" : ""}`}
                        draggable={canMoveVoiceMembers && member.socketId !== socketRef.current?.id}
                        aria-grabbed={draggedVoiceMemberId === member.socketId}
                        title={canMoveVoiceMembers && member.socketId !== socketRef.current?.id ? `Arraste ${member.name} para outra sala` : undefined}
                        onDragStart={(event) => beginVoiceMemberDrag(event, member)}
                        onDragEnd={finishVoiceMemberDrag}
                        onContextMenu={(event) => openUserContextMenu(event, member)}
                      >
                        <UserAvatar name={member.name} url={member.avatarUrl} className="voice-member-avatar" />{member.name}
                        {member.screenSharing && <b>AO VIVO</b>}
                        {member.cameraEnabled && <b>CAM</b>}
                        {(member.micEnabled === false || member.deafened) && (
                          <em className="voice-member-status">
                            {member.micEnabled === false && <span title={member.serverMuted ? "Silenciado pelo servidor" : "Microfone desativado"}><CallIcon kind="mic-off" /></span>}
                            {member.deafened && <span title={member.serverDeafened ? "Áudio desativado pelo servidor" : "Áudio desativado"}><CallIcon kind="headphones-off" /></span>}
                          </em>
                        )}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </section>
          ))}
        </nav>
        {screenStream && (
          <article className="sidebar-active-stream">
            <span className="active-stream-icon"><CallIcon kind="screen" /></span>
            <span className="active-stream-copy"><strong>{screenLabel}</strong><small>AO VIVO · {screenViewerLabel}</small></span>
            <button type="button" onClick={stopSharing} title="Parar compartilhamento" aria-label="Parar compartilhamento"><span>×</span><CallIcon kind="screen" /></button>
          </article>
        )}
        {voiceChannel && (
          <section className="sidebar-voice-panel" aria-label="Conexão de voz">
            <div className="voice-status sidebar-voice-status">
              <div className="connection-glyph" aria-hidden="true"><CallIcon kind="connection" /></div>
              <div className="voice-status-copy"><strong>Voz conectada</strong><span>{voiceChannels.find((channel) => channel.id === voiceChannel)?.name} / {communityDisplayName}</span></div>
              <div className="voice-status-actions">
                <div className="mini-waveform" aria-label="Qualidade da conexão">{[12, 20, 28, 18, 24].map((height, index) => <i key={index} style={{ height }} />)}</div>
                <button type="button" className="disconnect" title="Desconectar" aria-label="Desconectar da chamada" onClick={leaveVoice}><CallIcon kind="hangup" /></button>
              </div>
            </div>
            <div className="sidebar-media-actions" aria-label="Ações da chamada">
              <button type="button" className={cameraStream ? "active" : ""} title={cameraStream ? "Desligar câmera" : "Ligar câmera"} onClick={() => void toggleCamera()}><CallIcon kind="camera" /></button>
              <button type="button" className={screenStream ? "active screen-stop" : ""} title={screenStream ? "Parar compartilhamento" : "Compartilhar tela"} onClick={() => void toggleScreen()}><CallIcon kind="screen" /></button>
              <button type="button" disabled title="Atividades (em breve)" aria-label="Atividades, ainda não implementadas"><CallIcon kind="activities" /></button>
              <button type="button" disabled title="Efeitos sonoros (em breve)" aria-label="Efeitos sonoros, ainda não implementados"><CallIcon kind="effects" /></button>
            </div>
          </section>
        )}
        {profileMenuOpen && <button type="button" className="profile-menu-scrim" aria-label="Fechar menu do perfil" onClick={() => setProfileMenuOpen(false)} />}
        {profileMenuOpen && !localGuestMode && (
          <section className="profile-popover" aria-label="Menu do perfil">
            <div className="profile-popover-banner" />
            <div className="profile-popover-identity">
              <UserAvatar name={name} url={currentAvatarUrl} className="profile-popover-avatar" />
              <strong>{name}</strong>
              <span>@{authState?.user?.username ?? "usuário"}</span>
            </div>
            <div className="profile-popover-actions">
              <button type="button" onClick={openProfileEditor}><span aria-hidden="true">✎</span><strong>Editar perfil</strong><small>Nome e foto no KCord</small><b aria-hidden="true">›</b></button>
              <button type="button" onClick={() => void copyCurrentUserId()} disabled={!currentUserId}><span aria-hidden="true">▣</span><strong>Copiar ID do usuário</strong><b aria-hidden="true">›</b></button>
            </div>
          </section>
        )}
        <footer
          className={`profile-card ${!localGuestMode ? "profile-card-clickable" : ""}`}
          role={!localGuestMode ? "button" : undefined}
          tabIndex={!localGuestMode ? 0 : undefined}
          aria-expanded={!localGuestMode ? profileMenuOpen : undefined}
          onClick={(event) => {
            if (localGuestMode || (event.target as HTMLElement).closest("button")) return;
            setProfileMenuOpen((current) => !current);
          }}
          onKeyDown={(event) => {
            if (localGuestMode || (event.key !== "Enter" && event.key !== " ")) return;
            event.preventDefault();
            setProfileMenuOpen((current) => !current);
          }}
        >
          <UserAvatar name={name} url={currentAvatarUrl} className="avatar small" />
          <div><strong>{name}</strong><span>{localGuestMode ? "convidado local temporário" : profileRole || (authState?.authenticated ? "Discord verificado" : connected ? "online" : "reconectando")}</span></div>
          <i className={`status-dot ${connected ? "online" : ""}`} />
          <div className="profile-controls">
            <button type="button" className={`profile-audio-control ${!micEnabled || microphoneLockedByServer ? "danger" : ""}`} disabled={deafened || microphoneLockedByServer} title={microphoneLockedByServer ? "Microfone desativado pelo servidor" : deafened ? "Reative o áudio primeiro" : micEnabled ? "Desligar microfone" : "Ligar microfone"} aria-label={microphoneLockedByServer ? "Microfone desativado pelo servidor" : micEnabled ? "Desligar microfone" : "Ligar microfone"} onClick={toggleMicrophone}><CallIcon kind="mic" /><span className="control-chevron">⌄</span></button>
            <button type="button" className={`profile-audio-control ${deafened || serverDeafened ? "danger" : ""}`} disabled={serverDeafened} title={serverDeafened ? "Áudio desativado pelo servidor" : deafened ? "Reativar áudio" : "Desativar áudio"} aria-label={serverDeafened ? "Áudio desativado pelo servidor" : deafened ? "Reativar áudio" : "Desativar áudio"} onClick={toggleDeafen}><CallIcon kind="headphones" /><span className="control-chevron">⌄</span></button>
            <button type="button" title="Configurações de áudio" aria-label="Configurações de áudio" onClick={() => void openAudioSettings()}><CallIcon kind="settings" /></button>
          </div>
        </footer>
      </aside>

      <main className="conversation-panel" onTouchStart={beginEdgeSwipe} onTouchEnd={finishEdgeSwipe}>
        <header className="conversation-header">
          <div>
            {viewingDirect && activeDirectContact
              ? <UserAvatar name={activeDirectContact.name} url={activeDirectContact.avatarUrl} className="header-direct-avatar" />
              : <span className="channel-hash">{viewingVoice ? "◖" : "#"}</span>}
            <div><h1>{viewingDirect && activeDirectContact ? activeDirectContact.name : viewingVoice ? voiceChannels.find((channel) => channel.id === voiceChannel)?.name : activeChannelData.name}</h1><p>{viewingDirect && activeDirectContact ? (activeDirectContact.online ? "Mensagem direta · online" : "Mensagem direta") : viewingVoice ? `${voiceParticipants.length} participante(s) na frequência` : activeChannelData.description}</p></div>
          </div>
          <div className="mobile-conversation-nav">
            <button type="button" onClick={goBackToMobileChannels} aria-label="Voltar para canais"><CallIcon kind="chevron-left" /></button>
            {viewingDirect && activeDirectContact
              ? <UserAvatar name={activeDirectContact.name} url={activeDirectContact.avatarUrl} className="mobile-title-avatar" />
              : <span className="mobile-title-hash" aria-hidden="true">#</span>}
            <span className="mobile-title-copy">
              <strong>{viewingDirect && activeDirectContact ? activeDirectContact.name : activeChannelData.name}</strong>
              <small>{viewingDirect && activeDirectContact ? (activeDirectContact.online ? "online" : "mensagem direta") : activeChannelData.description}</small>
            </span>
          </div>
          {!viewingVoice && <button
            type="button"
            className={`mobile-members-toggle ${showMobileMembers ? "active" : ""}`}
            onClick={() => setShowMobileMembers((current) => !current)}
            aria-expanded={showMobileMembers}
            aria-label={`Ver membros presentes (${presentMembers.length})`}
          ><CallIcon kind="users" /></button>}
          {!viewingVoice && !viewingDirect && <button
            type="button"
            className={`pinned-messages-toggle ${showPinnedMessages ? "active" : ""}`}
            data-count={pinnedMessages.length}
            onClick={() => setShowPinnedMessages((current) => !current)}
            aria-expanded={showPinnedMessages}
            aria-label="Ver mensagens fixadas"
            title="Mensagens fixadas"
          ><CallIcon kind="pin" /><span>{pinnedMessages.length}</span></button>}
          <span className="connection-state"><i className={connected ? "online" : ""} />{connected ? "ao vivo" : "conectando"}</span>
        </header>

        {showPinnedMessages && !viewingVoice && !viewingDirect && <aside className="pinned-messages-panel" aria-label="Mensagens fixadas">
          <header><strong>Mensagens fixadas</strong><button type="button" onClick={() => setShowPinnedMessages(false)} aria-label="Fechar mensagens fixadas">×</button></header>
          <div>
            {pinnedMessages.length === 0 ? <p>Nenhuma mensagem fixada neste canal.</p> : pinnedMessages.map((message) => (
              <button
                type="button"
                className="pinned-message-card"
                key={message.id}
                onClick={() => {
                  document.getElementById(`message-${message.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
                  setShowPinnedMessages(false);
                }}
              >
                <UserAvatar name={message.author} url={message.authorAvatarUrl} className="avatar small" />
                <span><strong>{message.author}</strong><small>{message.text || message.file?.name || "Anexo"}</small></span>
                <time>{formatTime(message.sentAt)}</time>
              </button>
            ))}
          </div>
        </aside>}

        {viewingVoice ? (
          <section className="call-stage" ref={callStageRef} aria-label="Chamada em andamento">
            <header className="mobile-call-header">
              <button type="button" onClick={goBackToMobileChannels} aria-label="Voltar para canais"><CallIcon kind="chevron-down" /></button>
              <strong>{voiceChannels.find((channel) => channel.id === voiceChannel)?.name}</strong>
              <button type="button" onClick={() => void openAudioSettings()} aria-label="Configurar saída de áudio"><CallIcon kind="sound" /></button>
            </header>
            {(() => {
              const ownStreamTile = screenStream ? (
                <article key="own-stream" className="call-tile stream-tile own-stream-tile">
                  <StreamVideo stream={screenStream} label="Sua tela compartilhada" muted />
                  <span className="stream-viewer-count" aria-live="polite">Assistindo: {screenViewerCount}</span>
                  <div className="stream-quality">{screenResolutionHeight ? `${screenResolutionHeight}P` : desktopShareDefinition === "hd" ? "1080P" : "720P"}</div>
                  <span className="stream-live-badge">AO VIVO</span>
                  {screenStream.getAudioTracks().length === 0 && (
                    <span className="stream-no-audio own" title="Sua transmissão está sem o som do computador.">SEM ÁUDIO</span>
                  )}
                  <footer><strong>{name}</strong><span>Sua tela · {screenViewerLabel}</span></footer>
                </article>
              ) : null;

              const screenTiles = availableScreens.map(([peerId, preview]) => {
                const participant = members.find((member) => member.socketId === peerId);
                const participantName = participant?.name ?? "Participante";
                const watching = activeScreenPeerId === peerId;
                const liveStream = remoteScreenStreams[peerId];
                const isLive = watching && preview.live && Boolean(liveStream?.getVideoTracks().length);
                return (
                  <article key={peerId} className={`call-tile stream-tile ${watching ? "watching" : ""} ${expandedScreenPeerId === peerId ? "expanded-stream" : ""}`}>
                    {isLive ? (
                      <StreamVideo stream={liveStream} label={`Tela de ${participantName}`} muted />
                    ) : (
                      <button type="button" className="stream-poster" onClick={() => watchScreen(peerId)} aria-label={`Assistir tela de ${participantName}`}>
                        <img src={preview.thumbnail} alt={`Prévia da tela de ${participantName}`} />
                        <span>{watching ? "Conectando…" : "Clique para assistir"}</span>
                      </button>
                    )}
                    <div className="stream-quality">{preview.resolutionHeight ? `${preview.resolutionHeight}P` : "RESOLUÇÃO AUTO"}</div>
                    <span className="stream-live-badge">AO VIVO</span>
                    {isLive && liveStream.getAudioTracks().length === 0 && (
                      <span className="stream-no-audio" title={`${participantName} está transmitindo sem o som do computador.`}>SEM ÁUDIO</span>
                    )}
                    {watching && (
                      <div className="stream-tile-actions">
                        <button type="button" onClick={() => toggleExpandedScreen(peerId)} title={expandedScreenPeerId === peerId ? "Retornar à grade" : "Expandir transmissão na grade"} aria-label={expandedScreenPeerId === peerId ? "Retornar à grade" : "Expandir transmissão na grade"}><CallIcon kind="expand" /></button>
                        <button type="button" onClick={closeWatchedScreen} title="Parar de assistir" aria-label="Parar de assistir">×</button>
                      </div>
                    )}
                    <footer><strong>{participantName}</strong><span>Compartilhando a tela</span></footer>
                  </article>
                );
              });

              const participantTiles = voiceParticipants.map((member) => {
                const local = member.socketId === socketRef.current?.id;
                return (
                  <ParticipantTile
                    key={member.socketId}
                    name={member.name}
                    avatarUrl={member.avatarUrl}
                    cameraStream={local ? cameraStream : member.cameraEnabled ? remoteCameraStreams[member.socketId] : undefined}
                    local={local}
                    speaking={local ? transmitting : member.voiceDetected}
                    muted={local ? !micEnabled : member.micEnabled === false}
                    onContextMenu={local ? undefined : (event) => openUserContextMenu(event, member)}
                  />
                );
              });

              // An enlarged live keeps everyone else visible in a strip below it.
              const focusedIndex = expandedScreenPeerId
                ? availableScreens.findIndex(([peerId]) => peerId === expandedScreenPeerId)
                : -1;
              if (focusedIndex >= 0) {
                const others = [ownStreamTile, ...screenTiles.filter((_tile, index) => index !== focusedIndex), ...participantTiles].filter(Boolean);
                return (
                  <div className="call-focus">
                    <div className="call-focus-main">{screenTiles[focusedIndex]}</div>
                    {others.length > 0 && <div className="call-filmstrip" aria-label="Participantes da chamada">{others}</div>}
                  </div>
                );
              }
              return (
                <div ref={setCallGridElement} className={`call-grid ${callGridTileWidth ? "fitted" : ""}`} style={callGridTileWidth ? { "--tile-w": `${callGridTileWidth}px` } as CSSProperties : undefined}>
                  {ownStreamTile}
                  {screenTiles}
                  {participantTiles}
                </div>
              );
            })()}

            <footer className="fullscreen-call-actions" aria-label="Controles da chamada em tela cheia">
              <button disabled={microphoneLockedByServer} title={microphoneLockedByServer ? "Microfone desativado pelo servidor" : micEnabled ? "Desligar microfone" : "Ligar microfone"} aria-label={microphoneLockedByServer ? "Microfone desativado pelo servidor" : micEnabled ? "Desligar microfone" : "Ligar microfone"} onClick={toggleMicrophone} className={!micEnabled || microphoneLockedByServer ? "danger" : transmitting ? "active" : ""}><CallIcon kind="mic" /></button>
              <button title="Câmera" aria-label="Câmera" onClick={() => void toggleCamera()} className={cameraStream ? "active" : ""}><CallIcon kind="camera" /></button>
              <button title={screenStream ? "Parar compartilhamento" : "Compartilhar tela"} aria-label={screenStream ? "Parar compartilhamento" : "Compartilhar tela"} onClick={() => void toggleScreen()} className={screenStream ? "active screen-stop" : ""}><CallIcon kind="screen" /></button>
              <button title="Sair da tela cheia" aria-label="Sair da tela cheia" onClick={() => void toggleFullscreen()}><CallIcon kind="expand" /></button>
              <button title="Desligar" aria-label="Desligar" className="hangup" onClick={leaveVoice}><CallIcon kind="hangup" /></button>
            </footer>
          </section>
        ) : viewingDirect && activeDirectContact ? (
          <>
            <section className="message-list direct-message-list" aria-live="polite">
              <div className="channel-intro direct-intro">
                <UserAvatar name={activeDirectContact.name} url={activeDirectContact.avatarUrl} className="direct-intro-avatar" />
                <h2>{activeDirectContact.name}</h2>
                <p>Este é o início da conversa privada com {activeDirectContact.name}.</p>
              </div>
              {directConversation.map((message) => {
                const ownsMessage = message.fromUserId === currentUserId;
                return <article
                  className={`message direct-message ${ownsMessage ? "own" : ""}`}
                  key={message.id}
                  onContextMenu={ownsMessage ? (event) => {
                    event.preventDefault();
                    setUserContextMenu(null);
                    setDirectMessageContextMenu({
                      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 190)),
                      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 70)),
                      message,
                    });
                  } : undefined}
                >
                  <UserAvatar name={message.author} url={message.authorAvatarUrl ?? (message.fromUserId === currentUserId ? currentAvatarUrl : directContacts.get(message.fromUserId)?.avatarUrl)} />
                  <div className="message-body">
                    <header><strong>{message.author}</strong><time>{formatTime(message.sentAt)}</time></header>
                    {message.text ? <MessageText text={message.text} /> : null}
                    {message.file && (fileIsExpired(message.file) ? (
                      <div className="file-card expired" aria-label={`${message.file.name}, arquivo expirado`}>
                        <span className="file-icon">↗</span>
                        <span><strong>{message.file.name}</strong><small>{formatSize(message.file.size)} · Expirou e foi removido</small></span>
                      </div>
                    ) : (<>
                      <AttachmentImagePreview file={message.file} />
                      <a className="file-card" href={message.file.url} target="_blank" rel="noreferrer" title="Arquivos enviados são removidos após 3 dias">
                        <span className="file-icon">↗</span>
                        <span><strong>{message.file.name}</strong><small>{formatSize(message.file.size)} · {message.file.expiresAt ? `Disponível até ${formatFileExpiry(message.file.expiresAt)}` : "Disponível por até 3 dias"}</small></span>
                      </a>
                    </>))}
                  </div>
                  {ownsMessage && <div className="message-actions" aria-label="Ações da mensagem privada">
                    <button type="button" className="danger" title="Excluir para todos" aria-label="Excluir mensagem privada" onClick={() => deleteDirectMessage(message)}>×</button>
                  </div>}
                </article>
              })}
            </section>

            <form className="composer direct-composer" onSubmit={sendDirectMessage}>
              <input ref={directFileInputRef} type="file" hidden onChange={(event) => void uploadFile(event.target.files?.[0], activeDirectContact.userId)} />
              <button type="button" className="attach-button" onClick={() => directFileInputRef.current?.click()} aria-label="Enviar arquivo, máximo 10 MB e disponível por 3 dias" title="Enviar arquivo · máximo 10 MB · disponível por 3 dias" disabled={uploading}>
                {uploading ? "…" : <><CallIcon kind="attach" /><small>Arquivo</small></>}
              </button>
              <input value={directMessageDraft} onChange={(event) => setDirectMessageDraft(event.target.value)} onPaste={(event) => pasteFile(event, activeDirectContact.userId)} placeholder={`Mensagem para @${activeDirectContact.name}`} maxLength={2000} autoFocus />
              <button type="submit" className="send-button" aria-label="Enviar mensagem"><CallIcon kind="send" /><span>Enviar</span></button>
            </form>
          </>
        ) : (
          <>
            <section className={`message-list ${linksChannelActive || screenshotChannelActive ? "links-grid" : ""}`} aria-live="polite">
              <div className="channel-intro">
                <span>#</span><h2>Começo de #{activeChannelData.name}</h2><p>{activeChannelData.description}.</p>
              </div>
              {channelMessages.map((message) => {
                const ownsMessage = Boolean(currentUserId && message.authorUserId === currentUserId);
                const canDeleteMessage = ownsMessage || authState?.canManageMessages;
                const cardUrl = linksChannelActive && !message.file && editingMessageId !== message.id && message.text ? firstMessageUrl(message.text) : null;
                const screenshotFile = screenshotChannelActive && message.file && !fileIsExpired(message.file) && IMAGE_ATTACHMENT_PATTERN.test(message.file.name)
                  ? message.file
                  : null;
                const cardTile = Boolean(cardUrl || screenshotFile);
                return (
                  <article id={`message-${message.id}`} className={`message ${message.pinned ? "pinned" : ""} ${cardTile ? "link-tile" : ""}`} key={message.id}>
                    {cardUrl
                      ? <LinkCard url={cardUrl} text={message.text} author={message.author} authorAvatarUrl={message.authorAvatarUrl} sentAt={message.sentAt} />
                      : screenshotFile
                        ? <ScreenshotCard file={screenshotFile} author={message.author} authorAvatarUrl={message.authorAvatarUrl} sentAt={message.sentAt} />
                        : <UserAvatar name={message.author} url={message.authorAvatarUrl} />}
                    <div className="message-body">
                      {message.replyTo && !cardTile && <button
                        type="button"
                        className="message-reply-reference"
                        onClick={() => document.getElementById(`message-${message.replyTo?.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
                      ><strong>@{message.replyTo.author}</strong><span>{message.replyTo.text}</span></button>}
                      {!cardTile && <header>
                        <strong>{message.author}</strong>
                        <time>{formatTime(message.sentAt)}</time>
                        {message.editedAt && <small>(editada)</small>}
                        {message.pinned && <b>FIXADA</b>}
                      </header>}
                      {cardTile ? null : editingMessageId === message.id ? (
                        <form className="message-edit-form" onSubmit={(event) => editMessage(event, message.id)}>
                          <input value={editingMessageDraft} onChange={(event) => setEditingMessageDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setEditingMessageId(null); }} maxLength={2000} autoFocus />
                          <small>Enter para salvar · <button type="button" onClick={() => setEditingMessageId(null)}>Esc cancelar</button></small>
                        </form>
                      ) : message.text ? <MessageText text={message.text} /> : null}
                      {message.file && !screenshotFile && (fileIsExpired(message.file) ? (
                        <div className="file-card expired" aria-label={`${message.file.name}, arquivo expirado`}>
                          <span className="file-icon">↗</span>
                          <span><strong>{message.file.name}</strong><small>{formatSize(message.file.size)} · Expirou e foi removido</small></span>
                        </div>
                      ) : (<>
                        <AttachmentImagePreview file={message.file} />
                        <a className="file-card" href={message.file.url} target="_blank" rel="noreferrer" title="Arquivos enviados são removidos após 3 dias">
                          <span className="file-icon">↗</span>
                          <span><strong>{message.file.name}</strong><small>{formatSize(message.file.size)} · {message.file.expiresAt ? `Disponível até ${formatFileExpiry(message.file.expiresAt)}` : "Disponível por até 3 dias"}</small></span>
                        </a>
                      </>))}
                      {message.reactions && Object.entries(message.reactions).some(([, users]) => users.length > 0) && <div className="message-reactions">
                        {Object.entries(message.reactions).filter(([, users]) => users.length > 0).map(([emoji, users]) => (
                          <button key={emoji} type="button" className={currentUserId && users.includes(currentUserId) ? "mine" : ""} onClick={() => toggleMessageReaction(message.id, emoji)}>
                            <span>{emoji}</span><b>{users.length}</b>
                          </button>
                        ))}
                      </div>}
                    </div>
                    <div className="message-actions" aria-label={`Ações da mensagem de ${message.author}`}>
                      {["👍", "❤️", "😂", "🎉", "👀", "👎"].map((emoji) => <button key={emoji} type="button" title={`Reagir com ${emoji}`} onClick={() => toggleMessageReaction(message.id, emoji)}>{emoji}</button>)}
                      <button type="button" title="Responder" aria-label="Responder" onClick={() => startReplyingToMessage(message)}>↩</button>
                      {ownsMessage && !message.file && <button type="button" title="Editar" aria-label="Editar" onClick={() => startEditingMessage(message)}>✎</button>}
                      {authState?.canManageMessages && <button type="button" title={message.pinned ? "Desafixar" : "Fixar"} aria-label={message.pinned ? "Desafixar mensagem" : "Fixar mensagem"} onClick={() => toggleMessagePin(message)}>⌖</button>}
                      {canDeleteMessage && <button type="button" className="danger" title="Excluir" aria-label="Excluir mensagem" onClick={() => deleteMessage(message)}>×</button>}
                    </div>
                  </article>
                );
              })}
            </section>

            {replyingTo && <div className="composer-replying">
              <span>Respondendo a <strong>@{replyingTo.author}</strong></span>
              <button type="button" onClick={() => setReplyingTo(null)} aria-label="Cancelar resposta">×</button>
            </div>}
            <form className="composer" onSubmit={sendMessage}>
              <input ref={fileInputRef} type="file" hidden onChange={(event) => void uploadFile(event.target.files?.[0])} />
              <button type="button" className="attach-button" onClick={() => fileInputRef.current?.click()} aria-label="Enviar arquivo, máximo 10 MB e disponível por 3 dias" title="Enviar arquivo · máximo 10 MB · disponível por 3 dias" disabled={uploading}>
                {uploading ? "…" : <><CallIcon kind="attach" /><small>Arquivo</small></>}
              </button>
              <input value={messageDraft} onChange={(event) => setMessageDraft(event.target.value)} onPaste={(event) => pasteFile(event)} placeholder={`Mensagem em #${activeChannelData.name}`} maxLength={2000} />
              <button type="submit" className="send-button" aria-label="Enviar mensagem"><CallIcon kind="send" /><span>Enviar</span></button>
            </form>
          </>
        )}
        {microphoneTestStream && (
          <div className="remote-audio-bank" aria-hidden="true">
            <RemoteAudio stream={microphoneTestStream} outputDeviceId={outputDeviceId} outputVolume={outputVolume} level={voiceLeveling} eqGains={voiceEq} />
          </div>
        )}
        {voiceChannel && (
          <div className="remote-audio-bank" aria-hidden="true">
            {voiceParticipants.filter((member) => member.socketId !== socketRef.current?.id).map((member) => (
              <RemoteAudio
                key={member.socketId}
                stream={remoteStreams[member.socketId] ?? null}
                outputDeviceId={outputDeviceId}
                outputVolume={deafened ? 0 : Math.round(outputVolume * ((userVolumes[memberVolumeKey(member)] ?? 100) / 100))}
                level={voiceLeveling}
                eqGains={voiceEq}
              />
            ))}
            {activeScreenPeerId && (
              <RemoteAudio
                key={`screen-${activeScreenPeerId}`}
                stream={remoteScreenStreams[activeScreenPeerId] ?? null}
                outputDeviceId={outputDeviceId}
                outputVolume={deafened ? 0 : Math.round(outputVolume * ((activeScreenMember ? userVolumes[memberVolumeKey(activeScreenMember)] : 100) ?? 100) / 100)}
              />
            )}
          </div>
        )}
      </main>

      {showMobileMembers && <button type="button" className="mobile-members-scrim" aria-label="Fechar lista de membros" onClick={() => setShowMobileMembers(false)} />}
      <aside className={`member-panel ${showMobileMembers ? "mobile-open" : ""}`}>
        <header className="mobile-members-header">
          <strong>Membros</strong>
          <button type="button" onClick={() => setShowMobileMembers(false)} aria-label="Fechar lista de membros"><CallIcon kind="chevron-down" /></button>
        </header>
        <p className="section-label">Presentes — {presentMembers.length}</p>
        {presentMembers.map((member) => (
          <div className="member-row" key={member.socketId} onContextMenu={(event) => openUserContextMenu(event, member)}>
            <UserAvatar name={member.name} url={member.avatarUrl} className="avatar small" />
            <div><strong>{member.name}</strong><span>{member.voiceChannelId
              ? "em voz"
              : [...community.roles].reverse().find((role) => member.roleIds?.includes(role.id))?.name || (member.authenticated ? "Discord verificado" : "convidado")}</span></div>
            <i className="status-dot online" />
          </div>
        ))}
      </aside>

      {voiceChannel && <footer className="voice-dock connected">
        <div className="voice-actions">
          <button className={`mic-action ${!micEnabled || microphoneLockedByServer ? "danger" : transmitting ? "active" : ""}`} title={microphoneLockedByServer ? "Microfone desativado pelo servidor" : micEnabled ? (inputMode === "ptt" ? (touchOnly ? "Segure para falar" : `Apertar para falar: ${keyLabel(pttKey)}`) : "Desligar microfone") : "Ligar microfone"} aria-label={microphoneLockedByServer ? "Microfone desativado pelo servidor" : micEnabled ? "Desligar microfone" : "Ligar microfone"} onClick={() => { if (!micEnabled || inputMode !== "ptt") toggleMicrophone(); }} onPointerDown={beginMobilePtt} onPointerUp={endMobilePtt} onPointerCancel={endMobilePtt} onLostPointerCapture={endMobilePtt} onContextMenu={(event) => event.preventDefault()} disabled={!voiceChannel || microphoneLockedByServer}><CallIcon kind="mic" /><small>{inputMode === "ptt" ? "PTT" : "Voz"}</small></button>
          <button className={`camera-action ${cameraStream ? "active" : ""}`} title={cameraStream ? "Parar live" : "Iniciar live"} aria-label={cameraStream ? "Parar live" : "Iniciar live"} onClick={() => void toggleCamera()} disabled={!voiceChannel}><CallIcon kind="camera" /><small>Live</small></button>
          <button className={`screen-action ${screenStream ? "active screen-stop" : ""}`} title={screenStream ? "Parar compartilhamento" : "Compartilhar tela"} aria-label={screenStream ? "Parar compartilhamento" : "Compartilhar tela"} onClick={() => void toggleScreen()} disabled={!voiceChannel}><CallIcon kind="screen" /><small>{screenStream ? "Parar" : "Tela"}</small></button>
          <button className="desktop-call-action" title="Tela cheia" aria-label="Tela cheia" onClick={() => void toggleFullscreen()} disabled={!voiceChannel}><CallIcon kind="expand" /></button>
          <button className="sound-action mobile-call-action" title="Tocar som (em breve)" aria-label="Tocar som, ainda não implementado" disabled><CallIcon kind="sound" /><small>Som</small></button>
          <button title="Desligar" aria-label="Desligar" className="hangup hangup-action" onClick={leaveVoice}><CallIcon kind="hangup" /><small>Sair</small></button>
        </div>
      </footer>}

      {userContextMenu && (
        <section
          className="user-context-menu"
          role="menu"
          aria-label={`Opções para ${userContextMenu.member.name}`}
          style={{ left: userContextMenu.x, top: userContextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <header>
            <UserAvatar name={userContextMenu.member.name} url={userContextMenu.member.avatarUrl} className="context-avatar" />
            <span><strong>{userContextMenu.member.name}</strong><small>{userContextMenu.member.authenticated ? "Conta Discord" : "Convidado"}</small></span>
          </header>
          <button
            type="button"
            role="menuitem"
            className="context-message-action"
            disabled={!contextVoiceMember?.kafcordUserId || !currentUserId}
            onClick={() => contextVoiceMember?.kafcordUserId && openDirectChat(contextVoiceMember.kafcordUserId, {
              userId: contextVoiceMember.kafcordUserId,
              name: contextVoiceMember.name,
              avatarUrl: contextVoiceMember.avatarUrl,
              online: true,
            })}
          >
            <CallIcon kind="chat" />
            <span>Mensagem</span>
          </button>
          {contextVoiceMember?.voiceChannelId && (canMoveVoiceMembers || canMuteVoiceMembers || canDeafenVoiceMembers) && (
            <div className="context-voice-actions" aria-label="Moderação de voz">
              <span>MODERAÇÃO DE VOZ</span>
              {canMuteVoiceMembers && <button
                type="button"
                role="menuitem"
                onClick={() => moderateVoiceMember(contextVoiceMember, "mute", !contextVoiceMember.serverMuted)}
              >
                <CallIcon kind="mic-off" />
                {contextVoiceMember.serverMuted ? "Remover silêncio do servidor" : "Silenciar no servidor"}
              </button>}
              {canDeafenVoiceMembers && <button
                type="button"
                role="menuitem"
                onClick={() => moderateVoiceMember(contextVoiceMember, "deafen", !contextVoiceMember.serverDeafened)}
              >
                <CallIcon kind="headphones-off" />
                {contextVoiceMember.serverDeafened ? "Remover áudio desativado" : "Desativar áudio no servidor"}
              </button>}
              {canMoveVoiceMembers && <button
                type="button"
                role="menuitem"
                className="danger"
                onClick={() => moderateVoiceMember(contextVoiceMember, "disconnect")}
              >
                <CallIcon kind="hangup" />
                Desconectar da sala
              </button>}
            </div>
          )}
          <label className="context-volume-control">
            <span><b>Volume do usuário</b><output>{userVolumes[memberVolumeKey(userContextMenu.member)] ?? 100}%</output></span>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              value={userVolumes[memberVolumeKey(userContextMenu.member)] ?? 100}
              onChange={(event) => setMemberVolume(userContextMenu.member, Number(event.target.value))}
            />
          </label>
        </section>
      )}

      {directMessageContextMenu && (
        <section
          className="direct-message-context-menu"
          role="menu"
          aria-label="Ações da mensagem privada"
          style={{ left: directMessageContextMenu.x, top: directMessageContextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button type="button" role="menuitem" onClick={() => deleteDirectMessage(directMessageContextMenu.message)}>
            <span>Excluir para todos</span><b aria-hidden="true">×</b>
          </button>
        </section>
      )}

      {showAdminStats && authState?.canImportDiscordModel && (
        <div className="modal-backdrop admin-stats-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setShowAdminStats(false);
        }}>
          <section className="admin-stats-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-stats-title">
            <header>
              <div>
                <span className="admin-kicker">PAINEL DO PROPRIETÁRIO</span>
                <h2 id="admin-stats-title">Tráfego do servidor KCord</h2>
                <p>Métricas persistentes coletadas pelo backend no servidor, não pelo aplicativo local.</p>
              </div>
              <div className="admin-header-actions">
                <button type="button" className="admin-refresh" onClick={() => void loadAdminStats()} disabled={adminStatsLoading}>{adminStatsLoading ? "Atualizando…" : "Atualizar"}</button>
                <button type="button" className="dialog-close" onClick={() => setShowAdminStats(false)} aria-label="Fechar">×</button>
              </div>
            </header>

            <div className="admin-range" aria-label="Período das estatísticas">
              {[7, 30, 90].map((days) => <button type="button" key={days} className={adminStatsRange === days ? "active" : ""} onClick={() => setAdminStatsRange(days)}>{days} dias</button>)}
            </div>

            {adminStatsError && <p className="admin-stats-error" role="alert">{adminStatsError}</p>}
            {!adminStats && adminStatsLoading && <div className="admin-loading">Lendo o histórico persistente…</div>}

            {adminStats && (
              <div className="admin-stats-content">
                <section className="admin-live-strip" aria-label="Agora">
                  <div><i /><span><b>{adminStats.live.connections}</b> conexões agora</span></div>
                  <div><span><b>{adminStats.live.voiceUsers}</b> em voz</span></div>
                  <div><span><b>{adminStats.live.activeStreams}</b> transmissões</span></div>
                  <small>Atualizado {formatTime(adminStats.generatedAt)}</small>
                </section>

                <section className="admin-metric-grid" aria-label={`Resumo de ${adminStats.range} dias`}>
                  <article><span>SESSÕES</span><strong>{adminStats.totals.sessions.toLocaleString("pt-BR")}</strong><small>{adminStats.totals.uniqueUsers} usuários únicos</small></article>
                  <article><span>MENSAGENS</span><strong>{(adminStats.totals.publicMessages + adminStats.totals.privateMessages).toLocaleString("pt-BR")}</strong><small>{adminStats.totals.privateMessages} privadas</small></article>
                  <article><span>CHAMADAS</span><strong>{adminStats.totals.voiceJoins.toLocaleString("pt-BR")}</strong><small>{adminStats.totals.screenShares} compartilhamentos</small></article>
                  <article><span>BANDA TOTAL DO SERVIDOR</span><strong>{adminStats.networkSince ? formatTraffic(adminAppBytes + adminRelayBytes) : "—"}</strong><small>{adminStats.networkSince ? `App ${formatTraffic(adminAppBytes)} · relay de voz ${adminStats.relaySince ? formatTraffic(adminRelayBytes) : "não medido"}` : "Medição ainda não iniciada"}</small></article>
                </section>

                <section className="admin-chart-card">
                  <header><div><span>ATIVIDADE DIÁRIA</span><h3>Sessões e mensagens</h3></div><small>A barra reúne os eventos de cada dia</small></header>
                  <div className="admin-chart" role="img" aria-label="Gráfico de atividade diária">
                    {adminStats.days.map((day) => {
                      const activity = day.sessions + day.publicMessages + day.privateMessages;
                      return <div className="admin-chart-column" key={day.date} title={`${day.date}: ${activity} eventos`}>
                        <i style={{ height: `${Math.max(activity ? 8 : 2, (activity / adminChartMax) * 100)}%` }} />
                        {(adminStats.days.length <= 30 || day.date.endsWith("-01")) && <span>{day.date.slice(8)}</span>}
                      </div>;
                    })}
                  </div>
                </section>

                <section className="admin-chart-card">
                  <header><div><span>BANDA DIÁRIA</span><h3>Tudo que entrou e saiu do servidor</h3></div><small className="admin-chart-legend"><i className="app" />App e downloads <i className="relay" />Relay de voz e vídeo</small></header>
                  <div className="admin-chart" role="img" aria-label="Gráfico de banda diária do servidor">
                    {adminStats.days.map((day) => {
                      const appBytes = adminDayAppBytes(day);
                      const relayBytes = adminDayRelayBytes(day);
                      return <div className="admin-chart-column" key={day.date} title={`${day.date}: app ${formatTraffic(appBytes)} · relay ${formatTraffic(relayBytes)}`}>
                        <div className="admin-chart-stack" style={{ height: `${Math.max(appBytes + relayBytes ? 4 : 0, ((appBytes + relayBytes) / adminBandwidthMax) * 100)}%` }}>
                          {relayBytes > 0 && <i className="relay" style={{ flexGrow: relayBytes }} />}
                          {appBytes > 0 && <i style={{ flexGrow: appBytes }} />}
                        </div>
                        {(adminStats.days.length <= 30 || day.date.endsWith("-01")) && <span>{day.date.slice(8)}</span>}
                      </div>;
                    })}
                  </div>
                </section>

                <section className="admin-breakdown admin-client-reports">
                  <header><span>FALHAS NOS APPS</span><h3>Relatadas automaticamente pelos usuários</h3></header>
                  {clientReports.length > 0 && <div className="admin-report-filters" role="group" aria-label="Estado dos relatos">
                    {(["open", "resolved", "ignored"] as ClientReportStatus[]).map((status) => <button
                      type="button"
                      key={status}
                      className={clientReportFilter === status ? "active" : ""}
                      onClick={() => setClientReportFilter(status)}
                      aria-pressed={clientReportFilter === status}
                    >{clientReportStatusLabels[status]} <b>{clientReportCounts[status]}</b></button>)}
                  </div>}
                  {clientReports.length === 0 ? <p>Nenhuma falha relatada.</p> : visibleClientReports.length === 0 ? <p>Nenhum relato com este estado.</p> : <ol>
                    {visibleClientReports.slice(0, 30).map((report) => <li key={report.id} className={`report-${report.status}`}>
                      <div>
                        <strong>{report.displayName}</strong>
                        <span>{clientReportLabels[report.kind] ?? report.kind}{report.context.sourceType ? ` (${report.context.sourceType === "screen" ? "Tela" : "Aplicativo"})` : ""}</span>
                        <em className={`admin-report-status status-${report.status}`}>{clientReportStatusLabels[report.status]}</em>
                        <time>{new Date(report.at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</time>
                      </div>
                      <code>{report.message}</code>
                      {report.details && <details><summary>Detalhes</summary><pre>{report.details}</pre></details>}
                      <small title={report.userAgent}>{clientReportSystem(report)}</small>
                      <div className="admin-report-actions">
                        {report.status !== "open" && <button type="button" onClick={() => void updateClientReportStatus(report.id, "open")} disabled={updatingClientReportId === report.id}>Reabrir</button>}
                        {report.status !== "resolved" && <button type="button" onClick={() => void updateClientReportStatus(report.id, "resolved")} disabled={updatingClientReportId === report.id}>Marcar resolvido</button>}
                        {report.status !== "ignored" && <button type="button" onClick={() => void updateClientReportStatus(report.id, "ignored")} disabled={updatingClientReportId === report.id}>Ignorar</button>}
                      </div>
                    </li>)}
                  </ol>}
                </section>

                <section className="admin-breakdown">
                  <header><span>DETALHAMENTO</span><h3>O que passou pelo servidor</h3></header>
                  <dl>
                    <div><dt>App: recebido / enviado</dt><dd>{formatTraffic(adminStats.totals.networkBytesIn)} / {formatTraffic(adminStats.totals.networkBytesOut)}</dd></div>
                    <div><dt>Relay de voz e vídeo: recebido / enviado</dt><dd>{adminStats.relaySince ? `${formatTraffic(adminStats.totals.relayBytesIn)} / ${formatTraffic(adminStats.totals.relayBytesOut)}` : "Não medido"}</dd></div>
                    <div><dt>Instaladores e atualizações</dt><dd>{adminStats.totals.downloadRequests.toLocaleString("pt-BR")} · {formatTraffic(adminStats.totals.downloadBytesOut)}</dd></div>
                    <div><dt>Uploads dos usuários</dt><dd>{adminStats.totals.fileUploads} · {formatTraffic(adminStats.totals.uploadedBytes)}</dd></div>
                    <div><dt>Site e API (HTTP)</dt><dd>{adminStats.totals.httpRequests.toLocaleString("pt-BR")} · {formatTraffic(adminStats.totals.bytesIn + adminStats.totals.bytesOut)}</dd></div>
                  </dl>
                  <p>
                    A banda do app é medida na placa de rede do servidor do KCord e inclui site, chat em tempo real, arquivos, instaladores e atualizações.
                    O relay conta a voz, a câmera e as transmissões que passam pelo coturn quando a conexão direta entre usuários não é possível; chamadas diretas (ponto a ponto) não usam banda do servidor.
                    {adminStats.networkSince && ` Medindo desde ${new Date(adminStats.networkSince).toLocaleDateString("pt-BR")}.`}
                    {adminStats.relayUpdatedAt && ` Relay lido às ${formatTime(adminStats.relayUpdatedAt)}.`}
                  </p>
                </section>
              </div>
            )}
          </section>
        </div>
      )}

      {showProfileEditor && !localGuestMode && (
        <div className="modal-backdrop profile-editor-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeProfileEditor();
        }}>
          <section className="profile-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-editor-title">
            <header>
              <div><span>PERFIL PRINCIPAL</span><h2 id="profile-editor-title">Editar perfil</h2></div>
              <button type="button" className="dialog-close" onClick={closeProfileEditor} aria-label="Fechar">×</button>
            </header>
            <form onSubmit={(event) => void saveProfile(event)}>
              <div className="profile-editor-layout">
                <aside>
                  <strong>Sua identidade no KCord</strong>
                  <p>A foto e o nome personalizados aparecem nas chamadas, mensagens e conversas privadas.</p>
                  <div className="profile-editor-tip"><span>01</span>Clique na foto para substituí-la.</div>
                  <div className="profile-editor-tip"><span>02</span>Clique no nome para editá-lo.</div>
                </aside>
                <div className="profile-preview-editor">
                  <div className="profile-preview-banner" />
                  <button type="button" className="profile-avatar-editor" onClick={() => profileAvatarInputRef.current?.click()} aria-label="Alterar foto do perfil">
                    <UserAvatar name={profileNameDraft || name} url={profileAvatarPreview ?? currentAvatarUrl} className="profile-editor-avatar" />
                    <span><b>＋</b> Alterar foto</span>
                  </button>
                  <input
                    ref={profileAvatarInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    hidden
                    onChange={(event) => selectProfileAvatar(event.target.files?.[0])}
                  />
                  <div className="profile-name-editor">
                    <label htmlFor="profile-display-name">Nome exibido</label>
                    <div>
                      <input
                        ref={profileNameInputRef}
                        id="profile-display-name"
                        value={profileNameDraft}
                        onChange={(event) => setProfileNameDraft(event.target.value)}
                        maxLength={32}
                        autoComplete="off"
                      />
                      <button type="button" onClick={() => profileNameInputRef.current?.focus()} aria-label="Editar nome">✎</button>
                    </div>
                    <small>@{authState?.user?.username ?? "usuário"} · conta Discord vinculada</small>
                  </div>
                </div>
              </div>
              {profileError && <p className="profile-editor-error" role="alert">{profileError}</p>}
              <footer>
                <span>JPG, PNG, WEBP ou GIF · máximo de 2 MB</span>
                <div><button type="button" className="profile-cancel" onClick={closeProfileEditor}>Cancelar</button><button type="submit" className="profile-save" disabled={profileSaving}>{profileSaving ? "Salvando…" : "Salvar alterações"}</button></div>
              </footer>
            </form>
          </section>
        </div>
      )}

      {showLocalGuestDialog && authState?.canUseLocalGuest && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setShowLocalGuestDialog(false);
        }}>
          <section className="local-guest-dialog" role="dialog" aria-modal="true" aria-labelledby="local-guest-title">
            <header>
              <div><span className="owner-tool-label">FERRAMENTA DO PROPRIETÁRIO</span><h2 id="local-guest-title">Convidado local</h2></div>
              <button type="button" className="dialog-close" onClick={() => setShowLocalGuestDialog(false)} aria-label="Fechar">×</button>
            </header>
            <p>Crie uma identidade temporária para testes. Ela poderá trocar mensagens privadas com usuários conectados.</p>
            <form onSubmit={enterAsLocalGuest}>
              <label htmlFor="local-guest-name">Nome do convidado</label>
              <input id="local-guest-name" value={localGuestNameDraft} onChange={(event) => setLocalGuestNameDraft(event.target.value)} maxLength={32} placeholder="Ex.: Convidado de teste" autoFocus />
              <small>Ao sair, o ID temporário, as conversas e os avisos desse convidado serão apagados.</small>
              <footer>
                {localGuestMode && <button type="button" className="guest-return-button" onClick={returnToDiscordIdentity}>Voltar para minha conta</button>}
                <button type="button" className="guest-cancel-button" onClick={() => setShowLocalGuestDialog(false)}>Cancelar</button>
                <button type="submit" className="guest-enter-button" disabled={!localGuestNameDraft.trim()}>{localGuestMode ? "Trocar convidado" : "Entrar como convidado"}</button>
              </footer>
            </form>
          </section>
        </div>
      )}

      {sessionReplaced && (
        <div className="modal-backdrop session-replaced-backdrop" role="presentation">
          <section className="session-replaced-dialog" role="alertdialog" aria-modal="true" aria-labelledby="session-replaced-title">
            <h2 id="session-replaced-title">Sessão aberta em outro dispositivo</h2>
            <p>Você entrou no KCord com esta conta em outro computador ou celular, então esta janela foi desconectada.</p>
            <button
              type="button"
              autoFocus
              onClick={() => {
                setSessionReplaced(false);
                socketRef.current?.connect();
              }}
            >Usar aqui</button>
            <small>Ao usar aqui, o outro dispositivo é que será desconectado.</small>
          </section>
        </div>
      )}

      {selectedVoiceData && !voiceChannel && (
        <section className="mobile-voice-sheet" aria-label={`Entrar em ${selectedVoiceData.name}`}>
          <header>
            <button type="button" onClick={() => setSelectedVoiceChannel(null)} aria-label="Fechar prévia"><CallIcon kind="chevron-down" /></button>
            <strong>{selectedVoiceData.name}</strong>
          </header>
          <p>{selectedVoiceMembers.length} {selectedVoiceMembers.length === 1 ? "pessoa em voz" : "pessoas em voz"}</p>
          <div className="mobile-voice-members">
            {selectedVoiceMembers.length === 0 && <span className="empty-voice">Ninguém está nesta sala agora.</span>}
            {selectedVoiceMembers.map((member) => (
              <div key={member.socketId} onContextMenu={(event) => openUserContextMenu(event, member)}>
                <UserAvatar name={member.name} url={member.avatarUrl} />
                <strong>{member.name}</strong>
                {member.screenSharing && <b>AO VIVO</b>}
              </div>
            ))}
          </div>
          <footer>
            <button type="button" className={!micEnabled ? "muted" : ""} onClick={toggleMicrophone} aria-label={micEnabled ? "Entrar com microfone ligado" : "Entrar com microfone desligado"}><CallIcon kind="mic" /></button>
            <button type="button" className="join-voice-button" onClick={() => void joinVoice(selectedVoiceData.id)}>Entrar na voz</button>
            <button type="button" disabled title="Bate-papo da voz (em breve)" aria-label="Bate-papo da voz, ainda não implementado"><CallIcon kind="chat" /></button>
          </footer>
        </section>
      )}

      {showDesktopShareDialog && (
        <div className="modal-backdrop share-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeDesktopShareDialog();
        }}>
          <section className="share-dialog desktop-share-dialog" role="dialog" aria-modal="true" aria-label="Compartilhar tela">
            <header className="share-source-tabs" role="tablist" aria-label="Tipo de compartilhamento">
              <button type="button" role="tab" aria-selected={desktopShareType === "window"} className={desktopShareType === "window" ? "active" : ""} onClick={() => void loadDesktopShareSources("window")}><span className="share-tab-window" />Aplicativos</button>
              <button type="button" role="tab" aria-selected={desktopShareType === "screen"} className={desktopShareType === "screen" ? "active" : ""} onClick={() => void loadDesktopShareSources("screen")}><CallIcon kind="screen" />Tela inteira</button>
            </header>

            <div className="share-source-stage desktop-source-stage">
              {loadingDesktopSources && (
                <div className="desktop-source-loading" role="status"><i /><span>Procurando {desktopShareType === "window" ? "aplicativos" : "telas"}…</span></div>
              )}
              {!loadingDesktopSources && desktopShareError && (
                <div className="desktop-source-empty" role="alert"><strong>Não foi possível mostrar as fontes.</strong><span>{desktopShareError}</span><button type="button" onClick={() => void loadDesktopShareSources(desktopShareType)}>Tentar novamente</button></div>
              )}
              {!loadingDesktopSources && !desktopShareError && desktopShareSources.length === 0 && (
                <div className="desktop-source-empty"><strong>Nenhuma fonte disponível.</strong><span>Abra um aplicativo ou conecte uma tela e tente novamente.</span><button type="button" onClick={() => void loadDesktopShareSources(desktopShareType)}>Atualizar</button></div>
              )}
              {!loadingDesktopSources && !desktopShareError && desktopShareSources.length > 0 && (
                <div className="desktop-source-grid">
                  {desktopShareSources.map((source) => (
                    <button
                      type="button"
                      key={source.id}
                      className={`desktop-source-card ${selectedDesktopShareId === source.id ? "selected" : ""}`}
                      onClick={() => setSelectedDesktopShareId(source.id)}
                      onDoubleClick={() => void startScreenShare(source.id)}
                      aria-pressed={selectedDesktopShareId === source.id}
                    >
                      <span className="desktop-source-thumbnail">{source.thumbnail ? <img src={source.thumbnail} alt="" /> : <span className="desktop-source-no-preview">Sem prévia</span>}</span>
                      <span className="desktop-source-name">
                        {source.appIcon ? <img src={source.appIcon} alt="" /> : <CallIcon kind="screen" />}
                        <strong>{source.name}</strong>
                        {source.minimized && <small className="desktop-source-minimized" title="O KCord restaura a janela ao começar a live">minimizada</small>}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {!loadingDesktopSources && desktopShareType === "window" && window.kafcordDesktop?.diagnoseShareSources && (
                <div className="desktop-source-diagnosis">
                  <label htmlFor="missing-share-app">Não encontrou um aplicativo?</label>
                  <div>
                    <input
                      id="missing-share-app"
                      value={missingShareAppName}
                      onChange={(event) => setMissingShareAppName(event.target.value.slice(0, 80))}
                      placeholder="Nome, por exemplo: X-Plane 12"
                      maxLength={80}
                      disabled={sendingShareDiagnosis}
                    />
                    <button type="button" className="desktop-source-missing" onClick={() => void sendShareDiagnosis()} disabled={sendingShareDiagnosis || !missingShareAppName.trim()}>
                      {sendingShareDiagnosis ? "Enviando…" : "Enviar diagnóstico"}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <footer className="share-dialog-footer desktop-share-footer">
              <div className="share-quality-summary">
                <strong>{desktopShareQuality === "games" ? "Jogos" : desktopShareQuality === "text" ? "Compartilhamento de tela" : "Personalizada"}</strong>
                <span>{desktopShareQuality === "games" ? "Vídeo mais suave" : desktopShareQuality === "text" ? "Texto mais claro" : "Equilíbrio personalizado"} · {desktopShareDefinition === "hd" ? "1080p" : "720p"} · {desktopShareQuality === "games" ? "60" : desktopShareQuality === "text" ? "5" : "30"} fps</span>
              </div>
              <div className="share-quality-actions">
                <div className="share-definition" aria-label="Resolução da transmissão">
                  <button type="button" className={desktopShareDefinition === "sd" ? "active" : ""} onClick={() => setDesktopShareDefinition("sd")}>SD</button>
                  <button type="button" className={desktopShareDefinition === "hd" ? "active" : ""} onClick={() => setDesktopShareDefinition("hd")}>HD</button>
                </div>
                <button type="button" className={`share-settings-button ${showDesktopShareSettings ? "active" : ""}`} onClick={() => setShowDesktopShareSettings((current) => !current)} aria-label="Configurações da transmissão"><CallIcon kind="settings" /></button>
              </div>

              {showDesktopShareSettings && (
                <aside className="share-settings-popover">
                  <span>Modo de transmissão</span>
                  <label className={desktopShareQuality === "games" ? "selected" : ""}>
                    <span><strong>Jogos</strong><small>Vídeo mais suave (720p, 60fps)</small></span>
                    <input type="radio" name="desktop-share-quality" checked={desktopShareQuality === "games"} onChange={() => setDesktopShareQuality("games")} />
                  </label>
                  <label className={desktopShareQuality === "text" ? "selected" : ""}>
                    <span><strong>Compartilhamento de tela</strong><small>Texto mais claro (Fonte, 5fps)</small></span>
                    <input type="radio" name="desktop-share-quality" checked={desktopShareQuality === "text"} onChange={() => setDesktopShareQuality("text")} />
                  </label>
                  <label className={desktopShareQuality === "custom" ? "selected" : ""}>
                    <span><strong>Personalizada</strong><small>Equilíbrio entre nitidez e movimento</small></span>
                    <input type="radio" name="desktop-share-quality" checked={desktopShareQuality === "custom"} onChange={() => setDesktopShareQuality("custom")} />
                  </label>
                  <label className="share-audio-option">
                    <span><strong>Compartilhar áudio</strong><small>Inclui o som do computador na transmissão.</small></span>
                    <input type="checkbox" checked={desktopShareAudio} onChange={(event) => setDesktopShareAudio(event.target.checked)} />
                  </label>
                </aside>
              )}

              <div className="share-dialog-buttons">
                <button type="button" className="share-cancel" onClick={closeDesktopShareDialog}>Cancelar</button>
                <button type="button" className="share-confirm" disabled={!selectedDesktopShareId || loadingDesktopSources} onClick={() => void startScreenShare(selectedDesktopShareId)}><CallIcon kind="screen" />Transmitir ao vivo</button>
              </div>
            </footer>
          </section>
        </div>
      )}

      {showAudioSettings && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeAudioSettings();
        }}>
          <section className="audio-dialog" role="dialog" aria-modal="true" aria-labelledby="audio-title">
            <aside className="audio-settings-nav">
              <div className="settings-profile"><UserAvatar name={name} url={currentAvatarUrl} /><span><strong>{name}</strong><small>Configurações de usuário</small></span></div>
              <label>Configurações do KCord</label>
              <button className={settingsTab === "voice" ? "active" : ""} onClick={() => setSettingsTab("voice")}><span>◉</span> Voz e vídeo</button>
              {autoStart?.supported && <button className={settingsTab === "windows" ? "active" : ""} onClick={() => setSettingsTab("windows")}><span>⊞</span> Windows</button>}
              <button disabled><span>▣</span> Câmera</button>
              <button disabled><span>▤</span> Transmissão</button>
              <button disabled><span>◇</span> Avançado</button>
              <p className="settings-nav-note">As alterações são salvas automaticamente neste dispositivo.</p>
            </aside>
            <div className="audio-settings-main">
              <header>
                {settingsTab === "voice"
                  ? <div><span className="settings-kicker">ÁUDIO</span><h2 id="audio-title">Voz e vídeo</h2><p>Configure como você ouve e como as outras pessoas ouvem você.</p></div>
                  : <div><span className="settings-kicker">APLICATIVO</span><h2 id="audio-title">Windows</h2><p>Ajuste como o KCord se comporta neste computador.</p></div>}
                <button className="dialog-close" onClick={closeAudioSettings} aria-label="Fechar">×</button>
              </header>
              <div className="audio-settings-body">
              {settingsTab === "windows" && autoStart?.supported ? (
                <section>
                  <div className="processing-grid">
                    <label>
                      <span><strong>Iniciar com o Windows</strong><small>Abre o KCord automaticamente quando você entra no Windows.</small></span>
                      <span className="settings-switch"><input type="checkbox" checked={autoStart.enabled} onChange={(event) => {
                        const enabled = event.target.checked;
                        setAutoStart({ ...autoStart, enabled });
                        void window.kafcordDesktop?.setAutoStart?.(enabled).then(setAutoStart).catch(() => setAudioSettingsError("Não foi possível alterar a inicialização com o Windows."));
                      }} /><i /></span>
                    </label>
                    {desktopCaptureMode && <div className="capture-mode-setting">
                      <span><strong>Captura de tela inteira</strong><small>Desempenho usa WGC. Compatível envia quadros por um caminho independente quando o Windows recusa a captura normal.</small></span>
                      <div role="group" aria-label="Modo de captura de tela">
                        <button type="button" className={desktopCaptureMode === "wgc" ? "active" : ""} onClick={() => void changeDesktopCaptureMode("wgc")}>Desempenho</button>
                        <button type="button" className={desktopCaptureMode === "legacy" ? "active" : ""} onClick={() => void changeDesktopCaptureMode("legacy")}>Compatível</button>
                      </div>
                    </div>}
                  </div>
                </section>
              ) : (<>
              <section className="discord-voice-section">
                <h3>Voz</h3>
                <div className="discord-device-grid">
                  <div className="discord-device-column">
                    <label htmlFor="audio-input">Microfone</label>
                    <div className="discord-device-select">
                      <CallIcon kind="mic" />
                      <select id="audio-input" value={inputDeviceId} onChange={(event) => void changeInputDevice(event.target.value)}>
                        {audioInputs.length === 0 && <option value="">Microfone padrão</option>}
                        {audioInputs.map((device, index) => (
                          <option key={device.deviceId} value={device.deviceId}>{device.label || `Microfone ${index + 1}`}</option>
                        ))}
                      </select>
                    </div>
                    <label className="discord-volume-control" htmlFor="input-volume">
                      <span>Volume do Microfone</span>
                      <input id="input-volume" type="range" min="0" max="150" value={inputVolume} onChange={(event) => setInputVolume(Number(event.target.value))} />
                    </label>
                  </div>

                  <div className="discord-device-column">
                    <label htmlFor="audio-output">Alto-falante</label>
                    <div className="discord-device-select">
                      <CallIcon kind="headphones" />
                      <select id="audio-output" value={outputDeviceId} disabled={!canChooseOutput} onChange={(event) => setOutputDeviceId(event.target.value)}>
                        {audioOutputs.length === 0 && <option value="">Saída padrão</option>}
                        {audioOutputs.map((device, index) => (
                          <option key={device.deviceId} value={device.deviceId}>{device.label || `Saída ${index + 1}`}</option>
                        ))}
                      </select>
                    </div>
                    <label className="discord-volume-control" htmlFor="output-volume">
                      <span>Volume do Alto-falante</span>
                      <input id="output-volume" type="range" min="0" max="100" value={outputVolume} onChange={(event) => setOutputVolume(Number(event.target.value))} />
                    </label>
                  </div>
                </div>

                <div className="discord-microphone-test">
                  <button type="button" className={testingMicrophone ? "testing" : ""} onClick={() => void toggleMicrophoneTest()}>{testingMicrophone ? "Parar teste" : "Teste do microfone"}</button>
                  <div className="discord-level-meter" aria-label={`Nível do microfone: ${microphoneLevel}%`}>
                    {Array.from({ length: 64 }, (_, index) => <i key={index} className={index < Math.round((microphoneLevel / 100) * 64) ? "active" : ""} />)}
                  </div>
                </div>
                <p className="discord-voice-help">No teste você se ouve com o equalizador e o nivelamento, como os outros te ouvem. Use fone para não dar microfonia.</p>
                <p className="discord-voice-help">Precisa de ajuda? Confira nosso <span>guia de solução de problemas.</span></p>
              </section>

              <section className="input-mode-card">
                <header><span>TRANSMISSÃO</span><h3>Modo de entrada</h3><p>Escolha quando o microfone deve transmitir sua voz.</p></header>
                <div className="input-mode-options">
                  <label className={`mode-option ${inputMode === "voice" ? "selected" : ""}`}>
                    <input type="radio" name="input-mode" checked={inputMode === "voice"} onChange={() => setInputMode("voice")} />
                    <i>◌</i><span><strong>Atividade de voz</strong><small>O KCord abre o microfone quando você fala.</small></span><b>Automático</b>
                  </label>
                  <label className={`mode-option ${inputMode === "ptt" ? "selected" : ""}`}>
                    <input type="radio" name="input-mode" checked={inputMode === "ptt"} onChange={() => setInputMode("ptt")} />
                    <i>{touchOnly ? "◉" : "⌨"}</i><span><strong>Apertar para falar</strong><small>{touchOnly ? "Transmite apenas enquanto você segura o botão do microfone na chamada." : "Transmite apenas enquanto a tecla é pressionada."}</small></span><b>PTT</b>
                  </label>
                </div>
                {inputMode === "ptt" && touchOnly && (
                  <div className="ptt-binding ptt-touch-hint">
                    <div><span>NO CELULAR</span><strong>Segure o botão do microfone na barra da chamada para falar e solte para parar.</strong></div>
                  </div>
                )}
                {inputMode === "ptt" && !touchOnly && (
                  <div className={`ptt-binding ${recordingPttKey ? "recording" : ""}`}>
                    <div><span>ATALHO PTT</span><strong>{recordingPttKey ? "Pressione uma tecla…" : keyLabel(pttKey)}</strong></div>
                    <button type="button" onClick={() => setRecordingPttKey((current) => !current)}>
                      {recordingPttKey ? "Cancelar" : "Definir tecla"}
                    </button>
                  </div>
                )}
                {inputMode === "ptt" && (
                  <div className="processing-grid">
                    <label>
                      <span><strong>Som do PTT</strong><small>{touchOnly ? "Toca um aviso ao segurar e soltar o botão do microfone." : "Toca um aviso ao apertar e soltar a tecla."}</small></span>
                      <span className="settings-switch"><input type="checkbox" checked={pttSoundsEnabled} onChange={(event) => setPttSoundsEnabled(event.target.checked)} /><i /></span>
                    </label>
                  </div>
                )}
                {inputMode === "voice" && (
                  <label className="volume-control sensitivity" htmlFor="input-sensitivity">
                    <span>Sensibilidade <strong>{inputSensitivity}%</strong></span>
                    <input id="input-sensitivity" type="range" min="0" max="100" value={inputSensitivity} onChange={(event) => setInputSensitivity(Number(event.target.value))} />
                  </label>
                )}
                <div className="processing-grid">
                  <label>
                    <span><strong>Supressão de ruído</strong><small>Reduz ruído contínuo capturado pelo navegador.</small></span>
                    <span className="settings-switch"><input type="checkbox" checked={noiseSuppression} onChange={(event) => {
                      const enabled = event.target.checked;
                      setNoiseSuppression(enabled);
                      void rawAudioRef.current?.getAudioTracks()[0]?.applyConstraints({ noiseSuppression: enabled }); void microphoneTestStreamRef.current?.getAudioTracks()[0]?.applyConstraints({ noiseSuppression: enabled });
                    }} /><i /></span>
                  </label>
                  <label>
                    <span><strong>Cancelamento de eco</strong><small>Evita que o alto-falante retorne ao microfone.</small></span>
                    <span className="settings-switch"><input type="checkbox" checked={echoCancellation} onChange={(event) => {
                      const enabled = event.target.checked;
                      setEchoCancellation(enabled);
                      void rawAudioRef.current?.getAudioTracks()[0]?.applyConstraints({ echoCancellation: enabled }); void microphoneTestStreamRef.current?.getAudioTracks()[0]?.applyConstraints({ echoCancellation: enabled });
                    }} /><i /></span>
                  </label>
                  <label>
                    <span><strong>Nivelar volume das vozes</strong><small>Aproxima o volume de quem fala muito alto ou muito baixo.</small></span>
                    <span className="settings-switch"><input type="checkbox" checked={voiceLeveling} onChange={(event) => setVoiceLeveling(event.target.checked)} /><i /></span>
                  </label>
                </div>
              </section>
              {authState?.canImportDiscordModel && (
                <section className="voice-eq-section">
                  <h3>Equalizador da comunidade</h3>
                  <p>Muda o som das vozes para todos na hora. Só você vê e altera este ajuste; não vale no iPhone/iPad.</p>
                  <div className="voice-eq-presets">
                    {VOICE_EQ_PRESETS.map((preset) => (
                      <button
                        type="button"
                        key={preset.label}
                        className={preset.gains.every((gain, index) => gain === voiceEq[index]) ? "active" : ""}
                        onClick={() => changeVoiceEq(preset.gains)}
                      >{preset.label}</button>
                    ))}
                  </div>
                  <div className="voice-eq-bands">
                    {VOICE_EQ_BANDS.map((band, index) => (
                      <label className="volume-control" key={band.label}>
                        <span>{band.label} <small>{band.frequency >= 1000 ? `${band.frequency / 1000} kHz` : `${band.frequency} Hz`}</small> <strong>{voiceEq[index] > 0 ? "+" : ""}{voiceEq[index]} dB</strong></span>
                        <input
                          type="range"
                          min="-12"
                          max="12"
                          step="0.5"
                          value={voiceEq[index]}
                          aria-label={`${band.label} em decibéis`}
                          onChange={(event) => changeVoiceEq(voiceEq.map((gain, bandIndex) => bandIndex === index ? Number(event.target.value) : gain))}
                        />
                      </label>
                    ))}
                  </div>
                </section>
              )}
              </>)}

              {audioSettingsError && <p className="audio-settings-error" role="alert">{audioSettingsError}</p>}
              </div>
            </div>
          </section>
        </div>
      )}

      {showImporter && authState?.canImportDiscordModel && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setShowImporter(false);
        }}>
          <section className="import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
            <header>
              <div>
                <p className="eyebrow">MIGRAÇÃO · DISCORD</p>
                <h2 id="import-title">Importar modelo</h2>
              </div>
              <button className="dialog-close" onClick={() => setShowImporter(false)} aria-label="Fechar">×</button>
            </header>
            <p className="dialog-copy">
              Copie categorias, canais, salas de voz, cargos e permissões de um link oficial. Nada será alterado no Discord.
            </p>
            <form className="template-form" onSubmit={previewTemplate}>
              <label htmlFor="template-source">Link ou código do modelo</label>
              <div>
                <input
                  id="template-source"
                  value={templateSource}
                  onChange={(event) => {
                    setTemplateSource(event.target.value);
                    setImportPreview(null);
                  }}
                  placeholder="https://discord.new/..."
                  autoFocus
                />
                <button type="submit" disabled={importing}>{importing ? "Consultando…" : "Ver prévia"}</button>
              </div>
            </form>
            {importError && <p className="import-error" role="alert">{importError}</p>}
            {importPreview && (
              <div className="import-preview">
                <div className="preview-heading">
                  <div><span>MODELO ENCONTRADO</span><strong>{importPreview.templateName}</strong><small>Origem: {importPreview.sourceGuildName}</small></div>
                  <span className="preview-code">{importPreview.code}</span>
                </div>
                <dl>
                  <div><dt>Categorias</dt><dd>{importPreview.summary.categories}</dd></div>
                  <div><dt>Texto</dt><dd>{importPreview.summary.textChannels}</dd></div>
                  <div><dt>Voz</dt><dd>{importPreview.summary.voiceChannels}</dd></div>
                  <div><dt>Cargos</dt><dd>{importPreview.summary.roles}</dd></div>
                </dl>
                <div className="preview-channels">
                  {importPreview.community.categories.map((category) => <span key={category.id}>{category.name}</span>)}
                </div>
                <ul>{importPreview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
                <div className="import-actions">
                  <button type="button" onClick={() => setImportPreview(null)}>Voltar</button>
                  <button type="button" className="apply-import" onClick={() => void applyTemplate()} disabled={importing}>
                    {importing ? "Importando…" : "Aplicar cópia"}
                  </button>
                </div>
              </div>
            )}
            <section className="member-import">
              <div className="member-import-heading">
                <div><span>ETAPA 2</span><h3>Importar membros</h3></div>
                {discordStatus?.connected && <small>Conectado como {discordStatus.user?.globalName || discordStatus.user?.username}</small>}
              </div>
              <p>
                O bot lê a lista autorizada, preserva IDs, apelidos e cargos, mas não cria contas ativas. Cada pessoa confirma sua identidade no primeiro login com Discord.
              </p>
              {!discordStatus && <p className="member-import-state">Verificando integração…</p>}
              {discordStatus && !discordStatus.configured && <p className="member-import-state error">Complete as credenciais no arquivo .env.</p>}
              {discordStatus?.configured && (!discordStatus.connected || discordStatus.purpose !== "admin") && (
                <a className="discord-connect" href="/auth/discord">Conectar minha conta Discord</a>
              )}
              {discordStatus?.connected && discordStatus.purpose === "admin" && (
                <>
                  <label htmlFor="source-guild">Servidor que você administra</label>
                  <div className="guild-picker">
                    <select
                      id="source-guild"
                      value={selectedGuildId}
                      onChange={(event) => {
                        setSelectedGuildId(event.target.value);
                        setMemberPreview(null);
                        setMemberImportMessage("");
                      }}
                    >
                      {discordStatus.manageableGuilds.map((guild) => <option key={guild.id} value={guild.id}>{guild.name}</option>)}
                    </select>
                    <button type="button" onClick={() => void previewDiscordMembers()} disabled={!selectedGuildId || memberImporting}>
                      {memberImporting ? "Consultando…" : "Ver membros"}
                    </button>
                  </div>
                  {discordStatus.manageableGuilds.length === 0 && <p className="member-import-state error">Sua conta não gerencia nenhum servidor acessível.</p>}
                  {selectedGuildId && (
                    <a className="bot-reinstall" href={`/auth/discord/bot-invite?guildId=${encodeURIComponent(selectedGuildId)}`}>Instalar ou conferir o bot neste servidor</a>
                  )}
                </>
              )}
              {memberPreview && (
                <div className="member-preview">
                  <div className="member-counts">
                    <span><strong>{memberPreview.counts.people}</strong> pessoas</span>
                    <span><strong>{memberPreview.counts.botsIgnored}</strong> bots ignorados</span>
                    <span><strong>{memberPreview.counts.mappedAssignments}/{memberPreview.counts.roleAssignments}</strong> cargos mapeados</span>
                  </div>
                  <ul>
                    {memberPreview.samples.map((member) => (
                      <li key={member.discordUserId}><UserAvatar name={member.displayName} url={member.avatarUrl} className="avatar small" /><strong>{member.displayName}</strong><span>{member.roleNames.join(", ") || "sem cargo"}</span></li>
                    ))}
                  </ul>
                  <button className="apply-members" type="button" onClick={() => void applyDiscordMembers()} disabled={memberImporting}>
                    {memberImporting ? "Importando…" : `Confirmar ${memberPreview.counts.people} membros`}
                  </button>
                </div>
              )}
              {memberImportMessage && <p className="member-import-success">{memberImportMessage}</p>}
            </section>
          </section>
        </div>
      )}
      {showAfkDialog && (
        <div className="modal-backdrop" role="presentation">
          <section className="afk-dialog" role="dialog" aria-modal="true" aria-labelledby="afk-dialog-title">
            <header>
              <h2 id="afk-dialog-title">Olá, alguém aí?</h2>
              <button type="button" className="dialog-close" onClick={closeAfkDialog} aria-label="Fechar">×</button>
            </header>
            <p>Parece que você está ausente. Movemos você para o canal de ausentes.</p>
            <footer>
              <label><input type="checkbox" checked={hideAfkDialogNextTime} onChange={(event) => setHideAfkDialogNextTime(event.target.checked)} /> Não mostrar novamente</label>
              <button type="button" onClick={confirmAfkDialog}>Ok</button>
            </footer>
          </section>
        </div>
      )}
      {toast && <NoticeToast key={toast.id} text={toast.text} onClose={closeToast} />}
      {desktopUpdate && !["idle", "checking", "development"].includes(desktopUpdate.state) && (
        <aside className={`desktop-update-notice state-${desktopUpdate.state}`} role="status" aria-live="assertive">
          <img src={kcordAppIcon} alt="" />
          <div className="desktop-update-copy">
            <span>ATUALIZAÇÃO DO KCORD</span>
            <strong>{desktopUpdate.state === "available"
              ? `Nova versão ${desktopUpdate.version ?? ""} encontrada`
              : desktopUpdate.state === "downloading"
                ? `Baixando a versão ${desktopUpdate.version ?? "nova"}`
                : desktopUpdate.state === "downloaded"
                  ? "Atualização pronta para instalar"
                  : "A atualização não foi concluída"}</strong>
            <small>{desktopUpdate.state === "available"
              ? "O download começará automaticamente. Você pode continuar usando o aplicativo."
              : desktopUpdate.state === "downloading"
                ? `${Math.round(desktopUpdate.percent ?? 0)}% concluído · mantenha o KCord aberto`
                : desktopUpdate.state === "downloaded"
                  ? `O KCord salvará a atualização e reiniciará em ${restartCountdown} segundo${restartCountdown === 1 ? "" : "s"}.`
                  : desktopUpdate.message ?? "Verifique sua conexão e tente novamente."}</small>
            {(desktopUpdate.state === "available" || desktopUpdate.state === "downloading") && (
              <div className="desktop-update-progress" aria-label={`${Math.round(desktopUpdate.percent ?? 0)}% baixado`}><i style={{ width: `${desktopUpdate.percent ?? 0}%` }} /></div>
            )}
          </div>
          <div className="desktop-update-actions">
            {desktopUpdate.state === "downloaded" && <button type="button" onClick={() => installDesktopUpdate(voiceChannelRef.current)}>Atualizar agora</button>}
            {desktopUpdate.state === "error" && <>
              <button type="button" className="secondary" onClick={() => setDesktopUpdate(null)}>Continuar usando</button>
              <button type="button" onClick={() => void window.kafcordDesktop?.checkForUpdates()}>Tentar novamente</button>
            </>}
          </div>
        </aside>
      )}
    </div>
  );
}
