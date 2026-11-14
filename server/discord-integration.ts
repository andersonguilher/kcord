import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import express, { Router, type Request, type Response } from "express";
import type { CommunityConfig } from "./discord-template.ts";

type DiscordUser = {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
  bot?: boolean;
};

type DiscordGuild = {
  id: string;
  name: string;
  icon?: string | null;
  owner?: boolean;
  permissions?: string;
};

type DiscordRole = {
  id: string;
  name: string;
  color: number;
  permissions: string;
  position: number;
};

type DiscordMember = {
  user?: DiscordUser;
  nick?: string | null;
  avatar?: string | null;
  roles?: string[];
  joined_at?: string;
  pending?: boolean;
};

type PendingMember = {
  id: string;
  sourceGuildId: string;
  discordUserId: string;
  username: string;
  displayName: string;
  nickname: string | null;
  avatar: string | null;
  avatarUrl?: string | null;
  discordRoleIds: string[];
  discordRoleNames: string[];
  kafcordRoleIds: string[];
  importedAt: string;
  status: "pending" | "claimed";
  kafcordUserId: string | null;
};

type MemberPreview = {
  guild: { id: string; name: string };
  counts: { total: number; people: number; botsIgnored: number; roleAssignments: number; mappedAssignments: number };
  roleMappings: { discordId: string; discordName: string; kafcordRoleId: string | null }[];
  samples: { discordUserId: string; displayName: string; roleNames: string[]; avatarUrl: string | null }[];
  fetchedAt: string;
};

type ClaimedMembership = {
  sourceGuildId: string;
  displayName: string;
  kafcordRoleIds: string[];
  avatarUrl?: string | null;
};

type CachedPreview = { guildId: string; members: DiscordMember[]; roles: DiscordRole[]; preview: MemberPreview; expiresAt: number };
type OAuthPurpose = "login" | "admin";
type OAuthStatePayload = { nonce: string; purpose: OAuthPurpose; expiresAt: number };
type AuthSession = {
  id: string;
  user: DiscordUser;
  guilds: DiscordGuild[];
  purpose: OAuthPurpose;
  kafcordUserId: string;
  memberships: ClaimedMembership[];
  expiresAt: number;
  preview?: CachedPreview;
};

const discordApi = "https://discord.com/api/v10";
const manageGuild = 0x20n;
const administrator = 0x8n;
const manageMessages = 1n << 13n;
const muteMembers = 1n << 22n;
const deafenMembers = 1n << 23n;
const moveMembers = 1n << 24n;
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const previewLifetimeMs = 10 * 60 * 1000;
const sessionDataDirectory = join(process.cwd(), "data");
const sessionDataPath = join(sessionDataDirectory, "auth-sessions.json");

function configuration() {
  return {
    clientId: process.env.DISCORD_CLIENT_ID?.trim() ?? "",
    clientSecret: process.env.DISCORD_CLIENT_SECRET?.trim() ?? "",
    botToken: process.env.DISCORD_BOT_TOKEN?.trim() ?? "",
    redirectUri: process.env.DISCORD_REDIRECT_URI?.trim() ?? "http://localhost:3001/auth/discord/callback",
    sessionSecret: process.env.SESSION_SECRET?.trim() ?? "",
  };
}

function configured() {
  const value = configuration();
  return Boolean(value.clientId && value.clientSecret && value.botToken && value.sessionSecret && value.redirectUri);
}

export function isDiscordOwner(discordUserId: string | undefined) {
  const ownerDiscordUserId = process.env.KAFCORD_OWNER_DISCORD_ID?.trim();
  return Boolean(ownerDiscordUserId && discordUserId && ownerDiscordUserId === discordUserId);
}

function discordAvatarAsset(hash: string, path: string) {
  const extension = hash.startsWith("a_") ? "gif" : "webp";
  return `https://cdn.discordapp.com/${path}/${hash}.${extension}?size=128`;
}

function discordUserAvatarUrl(user: DiscordUser) {
  return user.avatar ? discordAvatarAsset(user.avatar, `avatars/${user.id}`) : null;
}

function discordMemberAvatarUrl(guildId: string, member: DiscordMember) {
  if (!member.user) return null;
  if (member.avatar) return discordAvatarAsset(member.avatar, `guilds/${guildId}/users/${member.user.id}/avatars`);
  return discordUserAvatarUrl(member.user);
}

function sessionSignature(id: string) {
  return createHmac("sha256", configuration().sessionSecret).update(id).digest("base64url");
}

function signedSessionId(id: string) {
  return `${id}.${sessionSignature(id)}`;
}

function oauthStateSignature(payload: string) {
  return createHmac("sha256", configuration().sessionSecret).update(`oauth:${payload}`).digest("base64url");
}

function createOAuthState(purpose: OAuthPurpose) {
  const value: OAuthStatePayload = {
    nonce: randomBytes(32).toString("base64url"),
    purpose,
    expiresAt: Date.now() + 10 * 60 * 1000,
  };
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${oauthStateSignature(payload)}`;
}

function verifiedOAuthState(value: string): OAuthStatePayload | undefined {
  const separator = value.lastIndexOf(".");
  if (separator < 1) return undefined;
  const payload = value.slice(0, separator);
  const supplied = Buffer.from(value.slice(separator + 1));
  const expected = Buffer.from(oauthStateSignature(payload));
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<OAuthStatePayload>;
    if (
      typeof parsed.nonce !== "string"
      || parsed.nonce.length < 32
      || (parsed.purpose !== "login" && parsed.purpose !== "admin")
      || typeof parsed.expiresAt !== "number"
      || parsed.expiresAt <= Date.now()
    ) return undefined;
    return parsed as OAuthStatePayload;
  } catch {
    return undefined;
  }
}

function verifiedSessionId(value: string | undefined) {
  if (!value) return undefined;
  const separator = value.lastIndexOf(".");
  if (separator < 1) return undefined;
  const id = value.slice(0, separator);
  const supplied = Buffer.from(value.slice(separator + 1));
  const expected = Buffer.from(sessionSignature(id));
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined;
  return id;
}

function loadSessions() {
  const activeSessions = new Map<string, AuthSession>();
  if (!existsSync(sessionDataPath)) return activeSessions;
  try {
    const stored = JSON.parse(readFileSync(sessionDataPath, "utf8")) as AuthSession[];
    if (!Array.isArray(stored)) throw new Error("Formato inválido");
    for (const session of stored) {
      if (
        typeof session?.id !== "string"
        || typeof session?.expiresAt !== "number"
        || session.expiresAt <= Date.now()
        || typeof session?.user?.id !== "string"
        || !Array.isArray(session.guilds)
        || !Array.isArray(session.memberships)
        || (session.purpose !== "login" && session.purpose !== "admin")
      ) continue;
      activeSessions.set(session.id, { ...session, preview: undefined });
    }
  } catch {
    console.warn("Sessões persistidas inválidas; iniciando sem sessões anteriores.");
  }
  return activeSessions;
}

const sessions = loadSessions();

function persistSessions() {
  mkdirSync(sessionDataDirectory, { recursive: true });
  const stored = [...sessions.values()]
    .filter((session) => session.expiresAt > Date.now())
    .map(({ preview: _preview, ...session }) => session);
  const temporaryPath = `${sessionDataPath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, sessionDataPath);
}

function refreshSession(session: AuthSession, response: Response) {
  session.expiresAt = Date.now() + sessionLifetimeMs;
  persistSessions();
  response.setHeader("Set-Cookie", cookie("kafcord_session", signedSessionId(session.id), sessionLifetimeMs / 1000));
}

function parseCookieHeader(header: string | undefined) {
  return Object.fromEntries((header ?? "").split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return [];
    return [[part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())]];
  }));
}

function parseCookies(request: Request) {
  return parseCookieHeader(request.headers.cookie);
}

function cookie(name: string, value: string, maxAgeSeconds: number) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

function clearCookie(name: string) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

function canManageGuild(guild: DiscordGuild) {
  if (guild.owner) return true;
  try {
    const permissions = BigInt(guild.permissions ?? "0");
    return (permissions & manageGuild) === manageGuild || (permissions & administrator) === administrator;
  } catch {
    return false;
  }
}

function getSession(request: Request) {
  const id = verifiedSessionId(parseCookies(request).kafcord_session);
  if (!id) return undefined;
  const session = sessions.get(id);
  if (!session || session.expiresAt <= Date.now()) {
    if (sessions.delete(id)) persistSessions();
    return undefined;
  }
  return session;
}

function getSessionFromCookieHeader(header: string | undefined) {
  const id = verifiedSessionId(parseCookieHeader(header).kafcord_session);
  if (!id) return undefined;
  const session = sessions.get(id);
  if (!session || session.expiresAt <= Date.now()) {
    if (sessions.delete(id)) persistSessions();
    return undefined;
  }
  return session;
}

function requireSession(request: Request, response: Response) {
  const session = getSession(request);
  if (!session) response.status(401).json({ error: "Conecte sua conta Discord para continuar." });
  return session;
}

function requireOwnerSession(request: Request, response: Response) {
  const session = requireSession(request, response);
  if (!session) return undefined;
  if (!isDiscordOwner(session.user.id)) {
    response.status(403).json({ error: "Somente o proprietário do Kafcord pode importar dados do Discord." });
    return undefined;
  }
  return session;
}

function guildForSession(session: AuthSession, guildId: string) {
  return session.guilds.find((guild) => guild.id === guildId && canManageGuild(guild));
}

class OAuthHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`A troca do código OAuth falhou (HTTP ${status}${code ? `, ${code}` : ""}).`);
  }
}

// Reads only Discord's short error code (e.g. "invalid_grant"); never logs the body.
async function oauthErrorCode(response: globalThis.Response) {
  try {
    const body = await response.json() as { error?: unknown };
    return typeof body.error === "string" ? body.error.replace(/[^a-z_]/gi, "").slice(0, 40) : "";
  } catch {
    return "";
  }
}

type OAuthFailureReason = "unreachable" | "busy" | "retry" | "error";

// Maps a callback failure to the login screen message the user should see.
function classifyOAuthFailure(error: unknown): { reason: OAuthFailureReason; detail: string } {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause && typeof error.cause === "object"
    ? (error.cause as { code?: unknown; message?: unknown })
    : undefined;
  const causeCode = typeof cause?.code === "string" ? cause.code : "";
  const detail = causeCode ? `${message} (${causeCode})` : message;
  if (error instanceof OAuthHttpError) {
    if (error.status === 429) return { reason: "busy", detail };
    if (error.code === "invalid_grant") return { reason: "retry", detail };
    return { reason: "error", detail };
  }
  if (message.includes("HTTP 429")) return { reason: "busy", detail };
  const name = error instanceof Error ? error.name : "";
  if (message === "fetch failed" || name === "TimeoutError" || name === "AbortError") {
    return { reason: "unreachable", detail };
  }
  return { reason: "error", detail };
}

async function discordFetch<T>(path: string, token: string, scheme: "Bot" | "Bearer") {
  const response = await fetch(`${discordApi}${path}`, {
    headers: { Authorization: `${scheme} ${token}`, "User-Agent": "Kafcord/0.1 (Discord migration)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const detail = response.status === 403
      ? "O Discord recusou o acesso. Verifique se o bot está no servidor e se a intenção de membros está ativada."
      : response.status === 401
        ? "A credencial do Discord foi recusada. Gere um novo token do bot."
        : `O Discord retornou HTTP ${response.status}.`;
    throw new Error(detail);
  }
  return await response.json() as T;
}

async function fetchAllMembers(guildId: string, botToken: string) {
  const members: DiscordMember[] = [];
  let after = "0";
  for (;;) {
    const page = await discordFetch<DiscordMember[]>(
      `/guilds/${encodeURIComponent(guildId)}/members?limit=1000&after=${encodeURIComponent(after)}`,
      botToken,
      "Bot",
    );
    members.push(...page);
    if (page.length < 1000) break;
    const finalId = page.at(-1)?.user?.id;
    if (!finalId || finalId === after) throw new Error("A paginação de membros do Discord não avançou.");
    after = finalId;
    if (members.length >= 100_000) throw new Error("O MVP limita a prévia a 100.000 membros.");
  }
  return members;
}

function makePreview(guild: DiscordGuild, members: DiscordMember[], roles: DiscordRole[], community: CommunityConfig): MemberPreview {
  const humans = members.filter((member) => member.user && !member.user.bot);
  const localRolesByName = new Map(community.roles.map((role) => [role.name.trim().toLocaleLowerCase("pt-BR"), role.id]));
  const rolesById = new Map(roles.map((role) => [role.id, role]));
  const roleMappings = roles
    .filter((role) => role.name !== "@everyone")
    .map((role) => ({
      discordId: role.id,
      discordName: role.name,
      kafcordRoleId: localRolesByName.get(role.name.trim().toLocaleLowerCase("pt-BR")) ?? null,
    }));
  const mappedRoleIds = new Set(roleMappings.filter((mapping) => mapping.kafcordRoleId).map((mapping) => mapping.discordId));
  const roleAssignments = humans.reduce((total, member) => total + (member.roles?.length ?? 0), 0);
  const mappedAssignments = humans.reduce(
    (total, member) => total + (member.roles?.filter((roleId) => mappedRoleIds.has(roleId)).length ?? 0),
    0,
  );
  return {
    guild: { id: guild.id, name: guild.name },
    counts: {
      total: members.length,
      people: humans.length,
      botsIgnored: members.length - humans.length,
      roleAssignments,
      mappedAssignments,
    },
    roleMappings,
    samples: humans.slice(0, 8).map((member) => ({
      discordUserId: member.user!.id,
      displayName: member.nick || member.user!.global_name || member.user!.username,
      roleNames: (member.roles ?? []).map((roleId) => rolesById.get(roleId)?.name).filter((name): name is string => Boolean(name)),
      avatarUrl: discordMemberAvatarUrl(guild.id, member),
    })),
    fetchedAt: new Date().toISOString(),
  };
}

function pendingMembers(preview: CachedPreview, community: CommunityConfig) {
  const localRolesByName = new Map(community.roles.map((role) => [role.name.trim().toLocaleLowerCase("pt-BR"), role.id]));
  const rolesById = new Map(preview.roles.map((role) => [role.id, role]));
  const importedAt = new Date().toISOString();
  return preview.members.flatMap((member): PendingMember[] => {
    if (!member.user || member.user.bot) return [];
    const discordRoleIds = member.roles ?? [];
    const discordRoleNames = discordRoleIds.map((roleId) => rolesById.get(roleId)?.name).filter((name): name is string => Boolean(name));
    const kafcordRoleIds = [...new Set(discordRoleNames
      .map((name) => localRolesByName.get(name.trim().toLocaleLowerCase("pt-BR")))
      .filter((id): id is string => Boolean(id)))];
    return [{
      id: `${preview.guildId}:${member.user.id}`,
      sourceGuildId: preview.guildId,
      discordUserId: member.user.id,
      username: member.user.username,
      displayName: member.nick || member.user.global_name || member.user.username,
      nickname: member.nick ?? null,
      avatar: member.avatar ?? member.user.avatar ?? null,
      avatarUrl: discordMemberAvatarUrl(preview.guildId, member),
      discordRoleIds,
      discordRoleNames,
      kafcordRoleIds,
      importedAt,
      status: "pending",
      kafcordUserId: null,
    }];
  });
}

function persistPendingMembers(nextMembers: PendingMember[]) {
  const directory = join(process.cwd(), "data");
  const path = join(directory, "discord-members.json");
  mkdirSync(directory, { recursive: true });
  let existing: PendingMember[] = [];
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(parsed)) existing = parsed;
    } catch {
      throw new Error("O arquivo local de membros está inválido; a importação foi interrompida.");
    }
  }
  const keys = new Set(nextMembers.map((member) => member.id));
  const merged = [...existing.filter((member) => !keys.has(member.id)), ...nextMembers];
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

function claimPendingMemberships(user: DiscordUser) {
  const path = join(process.cwd(), "data", "discord-members.json");
  let members: PendingMember[] = [];
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(parsed)) members = parsed;
    } catch {
      throw new Error("O arquivo local de membros está inválido; o login não alterou nenhum vínculo.");
    }
  }
  const matching = members.filter((member) => member.discordUserId === user.id);
  const existingUserId = matching.find((member) => member.kafcordUserId)?.kafcordUserId;
  const kafcordUserId = existingUserId ?? randomUUID();
  if (matching.length > 0) {
    const temporaryPath = `${path}.tmp`;
    const updated = members.map((member) => member.discordUserId === user.id
      ? { ...member, status: "claimed" as const, kafcordUserId }
      : member);
    writeFileSync(temporaryPath, `${JSON.stringify(updated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
  }
  return {
    kafcordUserId,
    memberships: matching.map((member) => ({
      sourceGuildId: member.sourceGuildId,
      displayName: member.displayName,
      kafcordRoleIds: member.kafcordRoleIds,
      avatarUrl: member.avatarUrl ?? (member.avatar
        ? member.avatar === user.avatar
          ? discordUserAvatarUrl(user)
          : discordAvatarAsset(member.avatar, `guilds/${member.sourceGuildId}/users/${member.discordUserId}/avatars`)
        : discordUserAvatarUrl(user)),
    })),
  };
}

// iOS home-screen apps run the Discord OAuth pages in a browser context whose
// cookies never reach the installed app, so the login is handed back: the app
// opens a short-lived request (secret kept in its own cookie), the browser that
// finished OAuth confirms the code shown in the app, and the app claims the session.
type LoginHandoff = {
  id: string;
  secretDigest: Buffer;
  code: string;
  expiresAt: number;
  sessionId?: string;
  confirmed: boolean;
};

const handoffLifetimeMs = 10 * 60 * 1000;
const maxPendingHandoffs = 200;
const handoffIdPattern = /^[A-Za-z0-9_-]{22}$/;
const handoffCodeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const loginHandoffs = new Map<string, LoginHandoff>();

function handoffSecretDigest(secret: string) {
  return createHash("sha256").update(secret).digest();
}

function activeHandoff(id: unknown) {
  const now = Date.now();
  for (const [key, handoff] of loginHandoffs) if (handoff.expiresAt <= now) loginHandoffs.delete(key);
  if (typeof id !== "string" || !handoffIdPattern.test(id)) return undefined;
  return loginHandoffs.get(id);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

function sendHandoffPage(response: Response, title: string, body: string) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  response.type("html").send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111318;color:#e9ebf0;font:16px/1.5 system-ui,-apple-system,sans-serif;padding:16px;box-sizing:border-box}
main{max-width:420px;text-align:center}h1{font-size:1.4rem}.code{font:700 2rem/1.2 ui-monospace,monospace;letter-spacing:.2em;background:#1d2029;border-radius:12px;padding:14px;margin:16px 0}
button,a.button{display:inline-block;background:#5865f2;color:#fff;border:0;border-radius:10px;padding:12px 20px;font:inherit;font-weight:600;text-decoration:none}small{display:block;color:#a3a8b5;margin-top:16px}
</style></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`);
}

function handoffForSession(request: Request, id: unknown) {
  const handoff = activeHandoff(id);
  const session = getSession(request);
  if (!handoff?.sessionId || !session || session.id !== handoff.sessionId) return undefined;
  return handoff;
}

const handoffDonePage = `<p>Pronto! Volte ao app KCord: toque em <strong>OK</strong> ou <strong>Concluído</strong> no canto da tela.</p><p><a class="button" href="/">Abrir o KCord</a></p>`;
const handoffExpiredPage = `<p>Este pedido de login expirou ou já foi usado. Volte ao app KCord e toque em <strong>Entrar com Discord</strong> de novo.</p>`;

function beginOAuth(response: Response, purpose: OAuthPurpose, handoffId?: string) {
  const config = configuration();
  if (!configured()) {
    response.status(503).send("A integração Discord ainda não foi configurada no .env.");
    return;
  }
  const state = createOAuthState(purpose);
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", purpose === "admin" ? "identify guilds" : "identify");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "consent");
  response.setHeader("Set-Cookie", [
    cookie("kafcord_oauth_state", state, 600),
    handoffId ? cookie("kafcord_oauth_handoff", handoffId, 600) : clearCookie("kafcord_oauth_handoff"),
  ]);
  response.redirect(url.toString());
}

export function getDiscordSocketIdentity(cookieHeader: string | undefined) {
  const session = getSessionFromCookieHeader(cookieHeader);
  if (!session) return undefined;
  const roleIds = [...new Set(session.memberships.flatMap((membership) => membership.kafcordRoleIds))];
  const avatarUrl = session.memberships.find((membership) => membership.avatarUrl)?.avatarUrl ?? discordUserAvatarUrl(session.user);
  return {
    kafcordUserId: session.kafcordUserId,
    discordUserId: session.user.id,
    displayName: session.user.global_name || session.user.username,
    avatarUrl,
    roleIds,
    authenticated: true as const,
  };
}

export function kafcordUserIdsForDiscordUser(discordUserId: string) {
  const userIds = new Set([...sessions.values()]
    .filter((session) => session.user.id === discordUserId)
    .map((session) => session.kafcordUserId));
  const importedMembersPath = join(process.cwd(), "data", "discord-members.json");
  if (existsSync(importedMembersPath)) {
    try {
      const importedMembers = JSON.parse(readFileSync(importedMembersPath, "utf8")) as PendingMember[];
      for (const member of importedMembers) {
        if (member.discordUserId === discordUserId && member.kafcordUserId) userIds.add(member.kafcordUserId);
      }
    } catch {
      // Invalid import data is handled by the import workflow; active sessions remain usable here.
    }
  }
  return [...userIds];
}

export function kafcordDiscordIdentityMappings() {
  const mappings = new Map<string, string>();
  for (const session of sessions.values()) mappings.set(session.kafcordUserId, session.user.id);
  const importedMembersPath = join(process.cwd(), "data", "discord-members.json");
  if (existsSync(importedMembersPath)) {
    try {
      const importedMembers = JSON.parse(readFileSync(importedMembersPath, "utf8")) as PendingMember[];
      for (const member of importedMembers) {
        if (member.kafcordUserId) mappings.set(member.kafcordUserId, member.discordUserId);
      }
    } catch {
      // Invalid import data is handled by the import workflow; session mappings remain usable here.
    }
  }
  return [...mappings].map(([kafcordUserId, discordUserId]) => ({ kafcordUserId, discordUserId }));
}

function hasCommunityPermission(
  discordUserId: string | undefined,
  roleIds: string[],
  community: CommunityConfig,
  permission: bigint,
) {
  if (isDiscordOwner(discordUserId)) return true;
  const assignedRoles = new Set(roleIds);
  return community.roles.some((role) => {
    if (!assignedRoles.has(role.id)) return false;
    try {
      const permissions = BigInt(role.permissions);
      return (permissions & administrator) === administrator || (permissions & permission) === permission;
    } catch {
      return false;
    }
  });
}

export const canMoveVoiceMembers = (discordUserId: string | undefined, roleIds: string[], community: CommunityConfig) =>
  hasCommunityPermission(discordUserId, roleIds, community, moveMembers);

export const canMuteVoiceMembers = (discordUserId: string | undefined, roleIds: string[], community: CommunityConfig) =>
  hasCommunityPermission(discordUserId, roleIds, community, muteMembers);

export const canDeafenVoiceMembers = (discordUserId: string | undefined, roleIds: string[], community: CommunityConfig) =>
  hasCommunityPermission(discordUserId, roleIds, community, deafenMembers);

export const canManageMessages = (discordUserId: string | undefined, roleIds: string[], community: CommunityConfig) =>
  hasCommunityPermission(discordUserId, roleIds, community, manageMessages);

export function createDiscordIntegrationRouter(getCommunity: () => CommunityConfig) {
  const router = Router();

  router.get("/auth/discord", (_request, response) => beginOAuth(response, "admin"));
  router.get("/auth/discord/login", (request, response) => {
    const handoff = activeHandoff(request.query.handoff);
    beginOAuth(response, "login", handoff && !handoff.sessionId ? handoff.id : undefined);
  });

  router.post("/api/auth/handoff", (_request, response) => {
    if (!configured()) {
      response.status(503).json({ error: "A integração Discord ainda não foi configurada." });
      return;
    }
    activeHandoff(undefined);
    if (loginHandoffs.size >= maxPendingHandoffs) {
      response.status(429).json({ error: "Muitos logins pendentes. Tente novamente em alguns minutos." });
      return;
    }
    const id = randomBytes(16).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    const code = Array.from({ length: 6 }, () => handoffCodeAlphabet[randomInt(handoffCodeAlphabet.length)]).join("");
    const expiresAt = Date.now() + handoffLifetimeMs;
    loginHandoffs.set(id, { id, secretDigest: handoffSecretDigest(secret), code, expiresAt, confirmed: false });
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Set-Cookie", cookie("kafcord_handoff", secret, handoffLifetimeMs / 1000));
    response.json({ id, code, expiresAt });
  });

  router.get("/auth/discord/handoff", (request, response) => {
    const handoff = handoffForSession(request, request.query.id);
    if (!handoff) {
      sendHandoffPage(response, "Login expirado", handoffExpiredPage);
      return;
    }
    if (handoff.confirmed) {
      sendHandoffPage(response, "Login concluído", handoffDonePage);
      return;
    }
    sendHandoffPage(response, "Confirme o login no app", `<p>Confira se o app KCord mostra este mesmo código:</p><div class="code">${escapeHtml(handoff.code)}</div>
<form method="post" action="/auth/discord/handoff"><input type="hidden" name="id" value="${escapeHtml(handoff.id)}"><button type="submit">O código é igual, entrar no app</button></form>
<small>Só confirme se foi você quem tocou em Entrar com Discord no app KCord agora há pouco. Se o código for diferente, feche esta janela.</small>`);
  });

  router.post("/auth/discord/handoff", express.urlencoded({ extended: false, limit: "1kb", inflate: false }), (request, response) => {
    const handoff = handoffForSession(request, (request.body as { id?: unknown } | undefined)?.id);
    if (!handoff) {
      sendHandoffPage(response, "Login expirado", handoffExpiredPage);
      return;
    }
    handoff.confirmed = true;
    sendHandoffPage(response, "Login concluído", handoffDonePage);
  });

  router.post("/api/auth/handoff/claim", (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const handoff = activeHandoff((request.body as { id?: unknown } | undefined)?.id);
    if (!handoff) {
      response.status(410).json({ status: "expired" });
      return;
    }
    const secret = parseCookies(request).kafcord_handoff;
    const digest = secret ? handoffSecretDigest(secret) : undefined;
    if (!digest || !timingSafeEqual(digest, handoff.secretDigest)) {
      response.status(403).json({ status: "forbidden" });
      return;
    }
    if (!handoff.confirmed || !handoff.sessionId) {
      response.json({ status: "pending" });
      return;
    }
    loginHandoffs.delete(handoff.id);
    const session = sessions.get(handoff.sessionId);
    if (!session || session.expiresAt <= Date.now()) {
      response.status(410).json({ status: "expired" });
      return;
    }
    response.setHeader("Set-Cookie", [
      cookie("kafcord_session", signedSessionId(session.id), sessionLifetimeMs / 1000),
      clearCookie("kafcord_handoff"),
    ]);
    response.json({ status: "done" });
  });

  router.get("/auth/discord/callback", async (request, response) => {
    const config = configuration();
    const code = String(request.query.code ?? "");
    const state = String(request.query.state ?? "");
    const expectedState = parseCookies(request).kafcord_oauth_state;
    const pendingState = verifiedOAuthState(state);
    response.setHeader("Set-Cookie", clearCookie("kafcord_oauth_state"));
    if (!code || !state || state !== expectedState || !pendingState) {
      response.redirect(303, "/?discord=expired");
      return;
    }
    let step = "troca do código";
    try {
      const tokenResponse = await fetch(`${discordApi}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: config.redirectUri,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!tokenResponse.ok) {
        throw new OAuthHttpError(tokenResponse.status, await oauthErrorCode(tokenResponse));
      }
      const token = await tokenResponse.json() as { access_token?: string; expires_in?: number };
      if (!token.access_token) throw new Error("O Discord não retornou um token OAuth.");
      step = "perfil do usuário";
      const user = await discordFetch<DiscordUser>("/users/@me", token.access_token, "Bearer");
      step = "vínculo local";
      if (pendingState.purpose === "admin" && !isDiscordOwner(user.id)) {
        response.redirect(303, "/?discord=forbidden");
        return;
      }
      const guilds = pendingState.purpose === "admin"
        ? await discordFetch<DiscordGuild[]>("/users/@me/guilds", token.access_token, "Bearer")
        : [];
      const identity = claimPendingMemberships(user);
      const id = randomBytes(32).toString("base64url");
      sessions.set(id, {
        id,
        user,
        guilds,
        purpose: pendingState.purpose,
        kafcordUserId: identity.kafcordUserId,
        memberships: identity.memberships,
        expiresAt: Date.now() + sessionLifetimeMs,
      });
      persistSessions();
      response.setHeader("Set-Cookie", [
        cookie("kafcord_session", signedSessionId(id), sessionLifetimeMs / 1000),
        clearCookie("kafcord_oauth_state"),
        clearCookie("kafcord_oauth_handoff"),
      ]);
      const handoff = pendingState.purpose === "login" ? activeHandoff(parseCookies(request).kafcord_oauth_handoff) : undefined;
      if (handoff && !handoff.sessionId) {
        handoff.sessionId = id;
        response.redirect(303, `/auth/discord/handoff?id=${encodeURIComponent(handoff.id)}`);
        return;
      }
      response.redirect(pendingState.purpose === "admin" ? "/?discord=connected" : "/?discord=login");
    } catch (error) {
      const failure = classifyOAuthFailure(error);
      console.warn(`Falha no OAuth do Discord (${step}, ${failure.reason}): ${failure.detail}`);
      response.redirect(303, `/?discord=${failure.reason}`);
    }
  });

  router.get("/api/discord/status", (request, response) => {
    const session = getSession(request);
    if (session) refreshSession(session, response);
    response.json({
      configured: configured(),
      connected: Boolean(session),
      user: session ? { id: session.user.id, username: session.user.username, globalName: session.user.global_name ?? null, avatarUrl: discordUserAvatarUrl(session.user) } : null,
      purpose: session?.purpose ?? null,
      memberships: session?.memberships ?? [],
      manageableGuilds: session && isDiscordOwner(session.user.id)
        ? session.guilds.filter(canManageGuild).map((guild) => ({ id: guild.id, name: guild.name, icon: guild.icon ?? null }))
        : [],
    });
  });

  router.get("/api/auth/me", (request, response) => {
    const session = getSession(request);
    if (session) refreshSession(session, response);
    const avatarUrl = session?.memberships.find((membership) => membership.avatarUrl)?.avatarUrl
      ?? (session ? discordUserAvatarUrl(session.user) : null);
    const roleIds = session ? [...new Set(session.memberships.flatMap((membership) => membership.kafcordRoleIds))] : [];
    response.json({
      authenticated: Boolean(session),
      user: session ? {
        kafcordUserId: session.kafcordUserId,
        discordUserId: session.user.id,
        username: session.user.username,
        displayName: session.user.global_name || session.user.username,
        avatarUrl,
      } : null,
      memberships: session?.memberships ?? [],
      canImportDiscordModel: Boolean(session && isDiscordOwner(session.user.id)),
      canUseLocalGuest: Boolean(session && isDiscordOwner(session.user.id)),
      canMoveMembers: Boolean(session && canMoveVoiceMembers(
        session.user.id,
        roleIds,
        getCommunity(),
      )),
      canMuteMembers: Boolean(session && canMuteVoiceMembers(session.user.id, roleIds, getCommunity())),
      canDeafenMembers: Boolean(session && canDeafenVoiceMembers(session.user.id, roleIds, getCommunity())),
      canManageMessages: Boolean(session && canManageMessages(session.user.id, roleIds, getCommunity())),
    });
  });

  router.post("/api/discord/logout", (request, response) => {
    const id = verifiedSessionId(parseCookies(request).kafcord_session);
    if (id && sessions.delete(id)) persistSessions();
    response.setHeader("Set-Cookie", clearCookie("kafcord_session"));
    response.status(204).end();
  });

  router.get("/auth/discord/bot-invite", (request, response) => {
    const session = requireOwnerSession(request, response);
    if (!session) return;
    const guildId = String(request.query.guildId ?? "");
    if (!guildForSession(session, guildId)) {
      response.status(403).send("Você precisa gerenciar o servidor selecionado.");
      return;
    }
    const url = new URL("https://discord.com/oauth2/authorize");
    url.searchParams.set("client_id", configuration().clientId);
    url.searchParams.set("scope", "bot");
    url.searchParams.set("permissions", "66688");
    url.searchParams.set("guild_id", guildId);
    url.searchParams.set("disable_guild_select", "true");
    response.redirect(url.toString());
  });

  router.post("/api/discord/members/preview", async (request, response) => {
    const session = requireOwnerSession(request, response);
    if (!session) return;
    const guildId = String(request.body.guildId ?? "");
    const guild = guildForSession(session, guildId);
    if (!guild) {
      response.status(403).json({ error: "Você precisa ser proprietário ou ter Gerenciar servidor." });
      return;
    }
    try {
      const token = configuration().botToken;
      const [members, roles] = await Promise.all([
        fetchAllMembers(guildId, token),
        discordFetch<DiscordRole[]>(`/guilds/${encodeURIComponent(guildId)}/roles`, token, "Bot"),
      ]);
      const preview = makePreview(guild, members, roles, getCommunity());
      session.preview = { guildId, members, roles, preview, expiresAt: Date.now() + previewLifetimeMs };
      response.json(preview);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Não foi possível consultar os membros.";
      response.status(502).json({ error: message });
    }
  });

  router.post("/api/discord/members/apply", (request, response) => {
    const session = requireOwnerSession(request, response);
    if (!session) return;
    const guildId = String(request.body.guildId ?? "");
    if (!guildForSession(session, guildId)) {
      response.status(403).json({ error: "Você precisa gerenciar o servidor selecionado." });
      return;
    }
    if (request.body.confirmation !== "IMPORTAR MEMBROS") {
      response.status(400).json({ error: "Confirmação de importação ausente." });
      return;
    }
    const cached = session.preview;
    if (!cached || cached.guildId !== guildId || cached.expiresAt <= Date.now()) {
      response.status(409).json({ error: "A prévia expirou. Consulte os membros novamente antes de importar." });
      return;
    }
    try {
      const pending = pendingMembers(cached, getCommunity());
      persistPendingMembers(pending);
      response.json({ imported: pending.length, pending: pending.length, botsIgnored: cached.preview.counts.botsIgnored });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Não foi possível persistir os membros.";
      response.status(500).json({ error: message });
    }
  });

  return router;
}
