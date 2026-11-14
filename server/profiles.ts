import { join } from "node:path";
import type { AppStateStore } from "./app-state.ts";

export type UserProfile = {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  updatedAt: string;
};

const STATE_KEY = "profiles";

/**
 * Persistent display name and avatar overrides, keyed by immutable KCord user ID.
 * `legacyDirectory` is where an older release kept `profiles.json`, imported once.
 */
export function createProfileStore(state: AppStateStore, legacyDirectory?: string) {
  function load() {
    if (legacyDirectory && state.importLegacyJson(STATE_KEY, join(legacyDirectory, "profiles.json")) === "invalid") {
      console.warn("Perfis persistidos inválidos; iniciando sem personalizações.");
    }
    const stored = state.get<UserProfile[]>(STATE_KEY);
    if (!Array.isArray(stored)) return new Map<string, UserProfile>();
    return new Map(stored
      .filter((profile) => profile && typeof profile.userId === "string" && typeof profile.displayName === "string")
      .map((profile) => [profile.userId, profile]));
  }

  const profiles = load();

  return {
    get: (userId: string) => profiles.get(userId),
    /** Stores the profile and saves all profiles in one atomic write. */
    save(profile: UserProfile) {
      profiles.set(profile.userId, profile);
      state.set(STATE_KEY, [...profiles.values()]);
    },
  };
}
