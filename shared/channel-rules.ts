// Content rules that depend on the channel name, shared so the client and the
// server agree: link channels take only links, screenshot channels only images.

export const IMAGE_ATTACHMENT_PATTERN = /\.(png|jpe?g|gif|webp)$/i;

export const LINKS_CHANNEL_ERROR = "Este canal aceita apenas links (mensagens com http:// ou https://).";
export const SCREENSHOT_CHANNEL_ERROR = "Este canal aceita apenas imagens (PNG, JPG, GIF ou WEBP).";

const channelNameWords = (name: string) => name.normalize("NFD").toLowerCase().split(/[^a-z0-9]+/);

// Channels named like "links" show messages as a grid of link cards.
export function isLinksChannel(name: string) {
  return channelNameWords(name).some((word) => word.startsWith("link"));
}

// Screenshot/capture channels show image attachments as the same gallery cards used by links.
export function isScreenshotChannel(name: string) {
  return channelNameWords(name).some((word) => word.startsWith("screenshot") || word.startsWith("captura"));
}

// First URL in a message, without trailing punctuation that is usually prose.
export function firstMessageUrl(text: string) {
  const match = /https?:\/\/[^\s<>"]+/i.exec(text);
  if (!match) return null;
  return match[0].replace(/[).,;:!?\]}'"]+$/, "");
}

// Detects the real image type from the first bytes; never trusts the file name alone.
export function sniffImageType(bytes: Uint8Array): string | null {
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

/** Why a text message cannot be posted in this channel, or null when it can. */
export function channelTextError(channelName: string, text: string) {
  if (isScreenshotChannel(channelName)) return SCREENSHOT_CHANNEL_ERROR;
  if (isLinksChannel(channelName) && !firstMessageUrl(text)) return LINKS_CHANNEL_ERROR;
  return null;
}

/** Why a file cannot be posted in this channel, judging by its name. The server also checks the bytes. */
export function channelFileError(channelName: string, fileName: string) {
  if (isLinksChannel(channelName)) return LINKS_CHANNEL_ERROR;
  if (isScreenshotChannel(channelName) && !IMAGE_ATTACHMENT_PATTERN.test(fileName)) return SCREENSHOT_CHANNEL_ERROR;
  return null;
}
