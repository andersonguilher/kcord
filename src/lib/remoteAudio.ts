// One AudioContext shared by every voice's leveling chain, created on first use,
// so a tap anywhere in the page can resume all of them at once.
let levelingContext: AudioContext | null = null;

export function sharedLevelingContext() {
  levelingContext ??= new AudioContext();
  return levelingContext;
}

// Audio elements whose play() the browser refused (autoplay policy, mostly
// iOS). They are retried on the next tap anywhere in the page.
export const blockedRemoteAudio = new Set<HTMLAudioElement>();

export const blockedAudioListeners = new Set<(blocked: boolean) => void>();

export function notifyBlockedAudio() {
  blockedAudioListeners.forEach((listener) => listener(blockedRemoteAudio.size > 0));
}

// Restarts remote voices the browser paused while the app was in background.
export function resumePausedRemoteAudio() {
  document.querySelectorAll<HTMLAudioElement>(".remote-audio-bank audio").forEach((audio) => {
    if (!audio.srcObject || !audio.paused) return;
    void audio.play().catch(() => {
      blockedRemoteAudio.add(audio);
      notifyBlockedAudio();
    });
  });
}

export function resumeBlockedRemoteAudio() {
  if (levelingContext?.state === "suspended") void levelingContext.resume().catch(() => undefined);
  if (!blockedRemoteAudio.size) return;
  for (const audio of [...blockedRemoteAudio]) {
    if (!audio.srcObject) {
      blockedRemoteAudio.delete(audio);
      continue;
    }
    void audio.play().then(() => {
      blockedRemoteAudio.delete(audio);
      notifyBlockedAudio();
    }).catch(() => undefined);
  }
  notifyBlockedAudio();
}
