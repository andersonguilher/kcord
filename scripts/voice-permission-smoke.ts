import assert from "node:assert/strict";
import { canDeafenVoiceMembers, canManageMessages, canMoveVoiceMembers, canMuteVoiceMembers } from "../server/discord-integration.ts";
import type { CommunityConfig } from "../server/discord-template.ts";

const community = {
  name: "Teste",
  categories: [],
  textChannels: [{ id: "geral", name: "geral", description: "", categoryId: null, position: 0 }],
  voiceChannels: [
    { id: "um", name: "Sala um", categoryId: null, position: 0 },
    { id: "dois", name: "Sala dois", categoryId: null, position: 1 },
  ],
  roles: [
    { id: "messages", name: "Gerenciar mensagens", color: 0, permissions: String(1n << 13n), position: 1 },
    { id: "mute", name: "Mute", color: 0, permissions: String(1n << 22n), position: 1 },
    { id: "deafen", name: "Deafen", color: 0, permissions: String(1n << 23n), position: 1 },
    { id: "move", name: "Move", color: 0, permissions: String(1n << 24n), position: 1 },
    { id: "admin", name: "Admin", color: 0, permissions: "8", position: 2 },
    { id: "ordinary", name: "Comum", color: 0, permissions: "0", position: 0 },
    { id: "invalid", name: "Inválido", color: 0, permissions: "não-numérico", position: 0 },
  ],
} satisfies CommunityConfig;

assert.equal(canMoveVoiceMembers(undefined, ["move"], community), true);
assert.equal(canManageMessages(undefined, ["messages"], community), true);
assert.equal(canManageMessages(undefined, ["admin"], community), true);
assert.equal(canManageMessages(undefined, ["ordinary"], community), false);
assert.equal(canMoveVoiceMembers(undefined, ["admin"], community), true);
assert.equal(canMuteVoiceMembers(undefined, ["mute"], community), true);
assert.equal(canDeafenVoiceMembers(undefined, ["deafen"], community), true);
assert.equal(canMuteVoiceMembers(undefined, ["move"], community), false);
assert.equal(canDeafenVoiceMembers(undefined, ["mute"], community), false);
assert.equal(canMoveVoiceMembers(undefined, ["ordinary"], community), false);
assert.equal(canMoveVoiceMembers(undefined, ["invalid"], community), false);
assert.equal(canMoveVoiceMembers(undefined, ["inexistente"], community), false);

console.log("Smoke test aprovado: permissões Administrador, Gerenciar mensagens, Mover, Silenciar e Ensurdecer são respeitadas.");
