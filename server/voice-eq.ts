import { join } from "node:path";
import type { AppStateStore } from "./app-state.ts";

export const VOICE_EQ_BANDS = 5;
export const VOICE_EQ_LIMIT_DB = 12;

export type VoiceEq = { gains: number[] };

/** Validates an untrusted equalizer payload; clamps to ±12 dB in 0.5 dB steps. */
export function sanitizeVoiceEq(value: unknown): VoiceEq | null {
  const gains = (value as { gains?: unknown } | null)?.gains;
  if (!Array.isArray(gains) || gains.length !== VOICE_EQ_BANDS) return null;
  if (!gains.every((gain) => typeof gain === "number" && Number.isFinite(gain))) return null;
  return {
    gains: gains.map((gain) => Math.round(Math.max(-VOICE_EQ_LIMIT_DB, Math.min(VOICE_EQ_LIMIT_DB, gain)) * 2) / 2),
  };
}

const STATE_KEY = "voice-eq";

/**
 * Voice equalizer set by the owner and applied by every client to the voices it
 * hears. Kept out of the community configuration so a template import does not
 * reset it. `legacyDirectory` is where an older release kept `voice-eq.json`.
 */
export function createVoiceEqStore(state: AppStateStore, legacyDirectory?: string) {
  function load(): VoiceEq {
    const flat = { gains: Array<number>(VOICE_EQ_BANDS).fill(0) };
    if (legacyDirectory && state.importLegacyJson(STATE_KEY, join(legacyDirectory, "voice-eq.json")) === "invalid") {
      console.warn("Equalizador de voz salvo inválido; usando o padrão.");
    }
    return sanitizeVoiceEq(state.get(STATE_KEY)) ?? flat;
  }

  let current = load();

  return {
    get: () => current,
    /** Replaces the equalizer and saves it. */
    set(next: VoiceEq) {
      current = next;
      state.set(STATE_KEY, current);
    },
  };
}
