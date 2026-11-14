import { describe, expect, it } from "vitest";
import {
  ALLOWED_REACTIONS,
  chatPinSchema,
  chatReactSchema,
  chatSendSchema,
  parsePayload,
} from "../shared/protocol.ts";

describe("chat protocol", () => {
  it("trims and caps message text and ids", () => {
    const parsed = parsePayload(chatSendSchema, {
      channelId: "c".repeat(150),
      text: `  ${"a".repeat(2500)}  `,
      replyToId: "r".repeat(150),
    });
    expect(parsed.text).toHaveLength(2000);
    expect(parsed.channelId).toHaveLength(100);
    expect(parsed.replyToId).toHaveLength(100);
  });

  it("treats missing or non-object payloads as empty", () => {
    for (const raw of [undefined, null, "oops", 42, []]) {
      const parsed = parsePayload(chatSendSchema, raw);
      expect(parsed.text).toBe("");
      expect(parsed.channelId).toBe("");
      expect(parsed.avatarUrl).toBeUndefined();
    }
  });

  it("coerces non-string fields instead of throwing", () => {
    const parsed = parsePayload(chatSendSchema, { text: 123, channelId: { a: 1 }, avatarUrl: 5 });
    expect(parsed.text).toBe("123");
    expect(parsed.avatarUrl).toBeUndefined();
  });

  it("pins only on a literal true", () => {
    expect(parsePayload(chatPinSchema, { messageId: "m", pinned: true }).pinned).toBe(true);
    for (const pinned of ["true", 1, null, undefined]) {
      expect(parsePayload(chatPinSchema, { messageId: "m", pinned }).pinned).toBe(false);
    }
  });

  it("exposes the allowed reactions and keeps them within the emoji cap", () => {
    for (const emoji of ALLOWED_REACTIONS) {
      expect(parsePayload(chatReactSchema, { messageId: "m", emoji }).emoji).toBe(emoji);
    }
  });
});
