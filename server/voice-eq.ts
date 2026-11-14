import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

/**
 * Voice equalizer set by the owner and applied by every client to the voices it
 * hears. Kept out of community.json so a template import does not reset it.
 */
export function createVoiceEqStore(dataDirectory: string) {
  const dataPath = join(dataDirectory, "voice-eq.json");

  function load(): VoiceEq {
    const flat = { gains: Array<number>(VOICE_EQ_BANDS).fill(0) };
    if (!existsSync(dataPath)) return flat;
    try {
      return sanitizeVoiceEq(JSON.parse(readFileSync(dataPath, "utf8"))) ?? flat;
    } catch {
      console.warn("Equalizador de voz salvo inválido; usando o padrão.");
      return flat;
    }
  }

  let current = load();

  return {
    get: () => current,
    /** Replaces the equalizer and writes it to disk atomically. */
    set(next: VoiceEq) {
      current = next;
      const temporaryPath = `${dataPath}.tmp`;
      writeFileSync(temporaryPath, `${JSON.stringify(current, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporaryPath, dataPath);
    },
  };
}
