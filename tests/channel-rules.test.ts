import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isImageUpload } from "../server/files.ts";
import { LINKS_CHANNEL_ERROR, SCREENSHOT_CHANNEL_ERROR, channelFileError, channelTextError } from "../shared/channel-rules.ts";

describe("channel content rules", () => {
  it("keeps the links channel to links only", () => {
    expect(channelTextError("🔗links", "veja https://example.com")).toBeNull();
    expect(channelTextError("🔗links", "só texto")).toBe(LINKS_CHANNEL_ERROR);
    expect(channelFileError("🔗links", "captura.png")).toBe(LINKS_CHANNEL_ERROR);
  });

  it("keeps the screenshot channel to images only", () => {
    expect(channelFileError("📷screenshot", "Captura.PNG")).toBeNull();
    expect(channelFileError("📷screenshot", "manual.pdf")).toBe(SCREENSHOT_CHANNEL_ERROR);
    expect(channelTextError("📷screenshot", "https://example.com")).toBe(SCREENSHOT_CHANNEL_ERROR);
  });

  it("does not restrict other channels", () => {
    expect(channelTextError("💭bate-papo", "oi")).toBeNull();
    expect(channelFileError("💭bate-papo", "manual.pdf")).toBeNull();
  });

  it("checks the bytes of an upload, not only its name", () => {
    const directory = mkdtempSync(join(tmpdir(), "kcord-image-"));
    try {
      const image = join(directory, "image");
      const text = join(directory, "text");
      const empty = join(directory, "empty");
      writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]));
      writeFileSync(text, "https://example.com");
      writeFileSync(empty, "");
      expect(isImageUpload(image)).toBe(true);
      expect(isImageUpload(text)).toBe(false);
      expect(isImageUpload(empty)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
