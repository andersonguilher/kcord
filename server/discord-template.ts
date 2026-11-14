export type CommunityCategory = { id: string; name: string; position: number };
export type TextChannel = {
  id: string;
  name: string;
  description: string;
  categoryId: string | null;
  position: number;
};
export type VoiceChannel = {
  id: string;
  name: string;
  categoryId: string | null;
  position: number;
};
export type CommunityRole = {
  id: string;
  name: string;
  color: number;
  permissions: string;
  position: number;
};
export type CommunityConfig = {
  name: string;
  categories: CommunityCategory[];
  textChannels: TextChannel[];
  voiceChannels: VoiceChannel[];
  roles: CommunityRole[];
  // Voice channel that idle members are moved to, and how long they may stay idle.
  afkChannelId?: string | null;
  afkTimeoutSeconds?: number;
  importedFrom?: { provider: "discord-template"; code: string; sourceName: string; sourceId?: string };
};

export type DiscordTemplatePreview = {
  code: string;
  templateName: string;
  sourceGuildName: string;
  community: CommunityConfig;
  summary: {
    categories: number;
    textChannels: number;
    voiceChannels: number;
    roles: number;
    unsupportedChannels: number;
  };
  warnings: string[];
};

type DiscordTemplateChannel = {
  id?: string;
  type?: number;
  name?: string;
  topic?: string | null;
  parent_id?: string | null;
  position?: number;
};

type DiscordTemplateRole = {
  id?: string;
  name?: string;
  color?: number;
  permissions?: string;
  position?: number;
};

type DiscordTemplatePayload = {
  code?: string;
  name?: string;
  source_guild_id?: string;
  serialized_source_guild?: {
    id?: string;
    name?: string;
    channels?: DiscordTemplateChannel[];
    roles?: DiscordTemplateRole[];
    afk_channel_id?: string | number | null;
    afk_timeout?: number;
  };
};

const textChannelTypes = new Set([0, 5, 15, 16]);
const voiceChannelTypes = new Set([2, 13]);

export function extractDiscordTemplateCode(input: string) {
  const value = input.trim();
  if (/^[A-Za-z0-9-]{2,64}$/.test(value)) return value;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Informe um link discord.new ou um código de modelo válido.");
  }

  const hostname = url.hostname.toLowerCase();
  if (!["discord.new", "www.discord.new", "discord.com", "www.discord.com"].includes(hostname)) {
    throw new Error("Somente links oficiais de modelo do Discord são aceitos.");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const code = hostname.endsWith("discord.new") ? parts[0] : parts[0] === "template" ? parts[1] : undefined;
  if (!code || !/^[A-Za-z0-9-]{2,64}$/.test(code)) {
    throw new Error("O link não contém um código de modelo válido.");
  }
  return code;
}

function cleanName(value: unknown, fallback: string) {
  const result = String(value ?? "").trim().slice(0, 100);
  return result || fallback;
}

function numericPosition(value: unknown) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

export function normalizeDiscordTemplate(raw: DiscordTemplatePayload, requestedCode: string): DiscordTemplatePreview {
  const source = raw.serialized_source_guild;
  if (!source || !Array.isArray(source.channels) || !Array.isArray(source.roles)) {
    throw new Error("O Discord não retornou uma estrutura de servidor válida.");
  }

  const sourceGuildName = cleanName(source.name, "Servidor do Discord");
  const channels = source.channels;
  const categories = channels
    .filter((channel) => channel.type === 4)
    .map((channel) => ({
      id: `discord-${String(channel.id ?? crypto.randomUUID())}`,
      sourceId: String(channel.id ?? ""),
      name: cleanName(channel.name, "Categoria"),
      position: numericPosition(channel.position),
    }))
    .sort((left, right) => left.position - right.position);
  const categoryIds = new Map(categories.map((category) => [category.sourceId, category.id]));

  const textChannels = channels
    .filter((channel) => textChannelTypes.has(Number(channel.type)))
    .map((channel) => ({
      id: `discord-${String(channel.id ?? crypto.randomUUID())}`,
      name: cleanName(channel.name, "canal"),
      description: cleanName(channel.topic, `Canal importado de ${sourceGuildName}`),
      categoryId: channel.parent_id ? categoryIds.get(String(channel.parent_id)) ?? null : null,
      position: numericPosition(channel.position),
    }))
    .sort((left, right) => left.position - right.position);

  const voiceChannels = channels
    .filter((channel) => voiceChannelTypes.has(Number(channel.type)))
    .map((channel) => ({
      id: `discord-${String(channel.id ?? crypto.randomUUID())}`,
      name: cleanName(channel.name, "Sala de voz"),
      categoryId: channel.parent_id ? categoryIds.get(String(channel.parent_id)) ?? null : null,
      position: numericPosition(channel.position),
    }))
    .sort((left, right) => left.position - right.position);

  if (textChannels.length === 0) {
    textChannels.push({
      id: "imported-geral",
      name: "geral",
      description: `Canal inicial de ${sourceGuildName}`,
      categoryId: null,
      position: 0,
    });
  }

  const roles = source.roles
    .map((role) => ({
      id: `discord-${String(role.id ?? crypto.randomUUID())}`,
      name: cleanName(role.name, "Cargo"),
      color: Number(role.color ?? 0),
      permissions: String(role.permissions ?? "0"),
      position: numericPosition(role.position),
    }))
    .sort((left, right) => right.position - left.position);

  const unsupportedChannels = channels.filter((channel) =>
    !textChannelTypes.has(Number(channel.type)) &&
    !voiceChannelTypes.has(Number(channel.type)) &&
    channel.type !== 4,
  ).length;
  const warnings = [
    "Membros, mensagens, arquivos, bots e integrações não fazem parte do modelo.",
    "As permissões serão preservadas para mapeamento, mas ainda não são aplicadas pelo MVP.",
  ];
  if (unsupportedChannels > 0) {
    warnings.push(`${unsupportedChannels} canal(is) de tipo ainda não suportado serão ignorados.`);
  }

  const code = cleanName(raw.code, requestedCode);
  const afkChannelId = source.afk_channel_id === null || source.afk_channel_id === undefined
    ? null
    : `discord-${String(source.afk_channel_id)}`;
  const community: CommunityConfig = {
    name: cleanName(raw.name, sourceGuildName),
    afkChannelId: voiceChannels.some((channel) => channel.id === afkChannelId) ? afkChannelId : null,
    afkTimeoutSeconds: Number.isFinite(Number(source.afk_timeout)) ? Number(source.afk_timeout) : undefined,
    categories: categories.map(({ sourceId: _sourceId, ...category }) => category),
    textChannels,
    voiceChannels,
    roles,
    importedFrom: {
      provider: "discord-template",
      code,
      sourceName: sourceGuildName,
      sourceId: String(raw.source_guild_id ?? source.id ?? ""),
    },
  };

  return {
    code,
    templateName: cleanName(raw.name, sourceGuildName),
    sourceGuildName,
    community,
    summary: {
      categories: community.categories.length,
      textChannels: textChannels.length,
      voiceChannels: voiceChannels.length,
      roles: roles.length,
      unsupportedChannels,
    },
    warnings,
  };
}

export async function fetchDiscordTemplate(input: string) {
  const code = extractDiscordTemplateCode(input);
  const response = await fetch(`https://discord.com/api/v10/guilds/templates/${encodeURIComponent(code)}`, {
    headers: { "User-Agent": "Kafcord/0.1 (Discord template importer)" },
    signal: AbortSignal.timeout(10_000),
  });

  if (response.status === 404) throw new Error("Modelo não encontrado ou link expirado.");
  if (response.status === 429) throw new Error("O Discord limitou as consultas. Tente novamente em instantes.");
  if (!response.ok) throw new Error(`O Discord recusou a consulta (${response.status}).`);

  return normalizeDiscordTemplate(await response.json() as DiscordTemplatePayload, code);
}
