import { describe, expect, it } from "vitest";
import { applyChannelMoves, planChannelMoves, storedTextChannels } from "../scripts/move-channel-messages.ts";
import { AppStateStore } from "../server/app-state.ts";
import { ChatStore } from "../server/chat-store.ts";

const channels = [
  { id: "geral", name: "geral" },
  { id: "links", name: "🔗links" },
  { id: "prints", name: "📷screenshot" },
];

function storeWith(messages: Array<[id: string, channelId: string, text: string, fileName?: string]>) {
  const store = new ChatStore(":memory:");
  for (const [id, channelId, text, fileName] of messages) {
    store.insertPublicMessage({
      id,
      channelId,
      author: "Ana",
      text,
      sentAt: "2026-11-20T10:00:00Z",
      file: fileName ? { name: fileName, url: `/files/${id}`, size: 1 } : undefined,
    });
  }
  return store;
}

describe("moving misplaced channel messages", () => {
  it("swaps links and images between the two channels and leaves everything else", () => {
    const store = storeWith([
      ["link-certo", "links", "https://example.com"],
      ["imagem-errada", "links", "", "captura.png"],
      ["texto-em-links", "links", "bom dia"],
      ["imagem-certa", "prints", "", "voo.jpg"],
      ["link-errado", "prints", "veja https://example.com"],
      ["pdf-em-prints", "prints", "", "manual.pdf"],
      ["link-no-geral", "geral", "https://example.com"],
      ["imagem-no-geral", "geral", "", "foto.png"],
    ]);
    store.toggleReaction("link-errado", "👍", "user-1");
    const { moves, unmatched } = planChannelMoves(store.database, channels);
    expect(moves.map((move) => move.id).sort()).toEqual(["imagem-errada", "link-errado"]);
    expect(unmatched).toEqual({ "🔗links": 1, "📷screenshot": 1 });

    expect(applyChannelMoves(store.database, moves)).toBe(2);
    expect(store.getPublicMessage("imagem-errada")?.channelId).toBe("prints");
    expect(store.getPublicMessage("link-errado")).toMatchObject({ channelId: "links", reactions: { "👍": ["user-1"] } });
    expect(store.getPublicMessage("link-no-geral")?.channelId).toBe("geral");
    expect(planChannelMoves(store.database, channels).moves).toEqual([]);
    store.close();
  });

  it("reads the channel list the server saved in the database", () => {
    const state = new AppStateStore(":memory:");
    state.set("community", { textChannels: channels });
    expect(storedTextChannels((state as unknown as { database: Parameters<typeof storedTextChannels>[0] }).database)).toEqual(channels);
    state.close();
  });

  it("refuses to guess when a destination is missing or ambiguous", () => {
    const store = storeWith([]);
    expect(() => planChannelMoves(store.database, channels.slice(0, 2))).toThrow(/screenshot/);
    expect(() => planChannelMoves(store.database, [...channels, { id: "x", name: "links-antigos" }])).toThrow(/links/);
    store.close();
  });
});
