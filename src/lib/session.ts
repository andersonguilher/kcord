import type { CommunityConfig, LocalGuestProfile, LoginHandoff } from "../types";

export const defaultCommunity: CommunityConfig = {
  name: "KCord",
  categories: [],
  textChannels: [
    { id: "geral", name: "geral", description: "A praça central da comunidade", categoryId: null, position: 0 },
    { id: "projetos", name: "projetos", description: "Ideias, progresso e colaboração", categoryId: null, position: 1 },
    { id: "musica", name: "música", description: "Faixas, referências e escuta coletiva", categoryId: null, position: 2 },
  ],
  voiceChannels: [
    { id: "cafe", name: "Café aberto", categoryId: null, position: 0 },
    { id: "estudio", name: "Estúdio", categoryId: null, position: 1 },
  ],
  roles: [],
};

export function storedLocalGuestProfile(): LocalGuestProfile | null {
  try {
    const stored = JSON.parse(localStorage.getItem("kafcord:local-guest-profile") ?? "null") as Partial<LocalGuestProfile> | null;
    if (!stored || typeof stored.name !== "string" || !stored.name.trim()) return null;
    return { name: stored.name.trim().slice(0, 32) };
  } catch {
    return null;
  }
}

export const LIVE_EXPANDED_KEY = "kafcord:live-expanded";

export const LOGIN_HANDOFF_KEY = "kafcord:login-handoff";

export function readStoredLoginHandoff(): LoginHandoff | null {
  try {
    const stored = JSON.parse(localStorage.getItem(LOGIN_HANDOFF_KEY) ?? "null") as LoginHandoff | null;
    if (!stored || typeof stored.id !== "string" || typeof stored.code !== "string" || !(stored.expiresAt > Date.now())) return null;
    return stored;
  } catch {
    return null;
  }
}

export function forgetStoredLoginHandoff() {
  try {
    localStorage.removeItem(LOGIN_HANDOFF_KEY);
  } catch {
    // Nothing stored.
  }
}

// The desktop update closes the app, which clears sessionStorage. Keep the voice
// room in localStorage for a few minutes so the new version rejoins it.
export const UPDATE_VOICE_RESUME_KEY = "kafcord:update-voice-resume";

export const UPDATE_VOICE_RESUME_MAX_AGE_MS = 10 * 60 * 1000;

export function saveVoiceResume(voiceChannelId: string | null) {
  try {
    if (voiceChannelId) {
      localStorage.setItem(UPDATE_VOICE_RESUME_KEY, JSON.stringify({ channelId: voiceChannelId, savedAt: Date.now() }));
    }
  } catch {
    // The app still restarts; the user just rejoins by hand.
  }
}

export function installDesktopUpdate(voiceChannelId: string | null) {
  saveVoiceResume(voiceChannelId);
  window.kafcordDesktop?.installUpdate();
}

export function takeUpdateVoiceResume(): string | null {
  try {
    const raw = localStorage.getItem(UPDATE_VOICE_RESUME_KEY);
    if (!raw) return null;
    localStorage.removeItem(UPDATE_VOICE_RESUME_KEY);
    const saved = JSON.parse(raw) as { channelId?: unknown; savedAt?: unknown };
    const fresh = typeof saved.savedAt === "number" && Date.now() - saved.savedAt < UPDATE_VOICE_RESUME_MAX_AGE_MS;
    return fresh && typeof saved.channelId === "string" ? saved.channelId : null;
  } catch {
    return null;
  }
}

// Read once at startup: the entry is consumed so a later launch does not rejoin.
export const updateVoiceResumeChannelId = takeUpdateVoiceResume();

// Client bundle this page loaded, compared with the one the server ships so a
// page left open across a deploy reloads itself (Ctrl+R) instead of running old code.
export const loadedClientBuild = (() => {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]');
  return script ? new URL(script.src).pathname.split("/").pop() ?? null : null;
})();

export const RELOADED_FOR_BUILD_KEY = "kafcord:reloaded-for-build";

// Reloads at most once per server build, so a mismatch can never loop.
export function reloadForClientBuild(serverBuild: string) {
  try {
    if (sessionStorage.getItem(RELOADED_FOR_BUILD_KEY) === serverBuild) return false;
    sessionStorage.setItem(RELOADED_FOR_BUILD_KEY, serverBuild);
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

// Login screen messages for each `?discord=` failure the server redirects with.
export const discordLoginFailureMessages: Record<string, string> = {
  expired: "O login do Discord expirou. Clique em Entrar com Discord e tente novamente.",
  retry: "Esse link de login já foi usado. Clique em Entrar com Discord uma vez e aguarde.",
  busy: "O Discord limitou as tentativas de login. Aguarde um minuto e tente de novo.",
  unreachable: "O servidor do KCord não conseguiu falar com o Discord. Avise a administração; tentar de novo não resolve.",
  error: "O Discord não concluiu o login. Tente conectar novamente.",
};
