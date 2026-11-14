import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type UserProfile = {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  updatedAt: string;
};

/** Persistent display name and avatar overrides, keyed by immutable KCord user ID. */
export function createProfileStore(dataDirectory: string) {
  const dataPath = join(dataDirectory, "profiles.json");

  function load() {
    if (!existsSync(dataPath)) return new Map<string, UserProfile>();
    try {
      const stored = JSON.parse(readFileSync(dataPath, "utf8")) as UserProfile[];
      if (!Array.isArray(stored)) return new Map<string, UserProfile>();
      return new Map(stored
        .filter((profile) => profile && typeof profile.userId === "string" && typeof profile.displayName === "string")
        .map((profile) => [profile.userId, profile]));
    } catch {
      console.warn("Perfis persistidos inválidos; iniciando sem personalizações.");
      return new Map<string, UserProfile>();
    }
  }

  const profiles = load();

  return {
    get: (userId: string) => profiles.get(userId),
    /** Stores the profile and writes all profiles to disk atomically. */
    save(profile: UserProfile) {
      profiles.set(profile.userId, profile);
      const temporaryPath = `${dataPath}.tmp`;
      writeFileSync(temporaryPath, `${JSON.stringify([...profiles.values()], null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporaryPath, dataPath);
    },
  };
}
