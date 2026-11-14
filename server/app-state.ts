import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** What happened when a legacy JSON file was considered for import. */
export type LegacyImportResult = "imported" | "already-present" | "no-file" | "invalid";

/**
 * Durable application state (sessions, profiles, reports, settings...) kept as
 * JSON documents in the same SQLite file as the chat. One file to back up, and
 * every write is a single atomic statement instead of a temp file and a rename.
 */
export class AppStateStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      const parent = dirname(databasePath);
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    }
    this.database = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:") {
      try {
        chmodSync(databasePath, 0o600);
      } catch {
        // Windows may not apply POSIX modes; the containing data directory still scopes access.
      }
    }
    // The timeout comes first: switching the journal mode needs a lock other connections may hold.
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  /** The stored document, or undefined when the key is absent (or somehow unreadable). */
  get<T>(key: string): T | undefined {
    const row = this.database.prepare("SELECT value FROM app_state WHERE key = ?").get(key) as { value: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return undefined;
    }
  }

  has(key: string) {
    return Boolean(this.database.prepare("SELECT 1 FROM app_state WHERE key = ?").get(key));
  }

  set(key: string, value: unknown) {
    this.database.prepare(`
      INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), new Date().toISOString());
  }

  delete(key: string) {
    this.database.prepare("DELETE FROM app_state WHERE key = ?").run(key);
  }

  /**
   * Imports a JSON file written by an older release, once: only when the key is
   * not in the database yet. The file is left in place, so rolling back to the
   * previous release still finds its data.
   */
  importLegacyJson(key: string, filePath: string): LegacyImportResult {
    if (this.has(key)) return "already-present";
    if (!existsSync(filePath)) return "no-file";
    try {
      this.set(key, JSON.parse(readFileSync(filePath, "utf8")));
    } catch {
      return "invalid";
    }
    console.info(`Dados de ${key} importados de ${filePath} para o banco.`);
    return "imported";
  }

  close() {
    if (this.database.isOpen) this.database.close();
  }
}

/** Where the database lives, the same rule the chat store follows. */
export function defaultDatabasePath() {
  return process.env.KAFCORD_CHAT_DATABASE_PATH?.trim() || join(process.cwd(), "data", "kafcord.sqlite");
}

let shared: AppStateStore | null = null;

/** The process-wide store, opened on first use (some modules need it while loading). */
export function appState() {
  shared ??= new AppStateStore(defaultDatabasePath());
  return shared;
}

/** Closes and forgets the shared store; for tests that change the database path. */
export function closeAppState() {
  shared?.close();
  shared = null;
}
