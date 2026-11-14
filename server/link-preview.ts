import express from "express";
import { createHash } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { join } from "node:path";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

// Link cards for chat: the server reads the page's preview metadata (og:image etc.)
// and stores that image locally, so clients never contact third-party hosts directly
// and opening an already-known card does not depend on the source site.

export type LinkPreview = {
  url: string;
  title: string | null;
  siteName: string | null;
  image: string | null;
};

const MAX_URL_LENGTH = 2048;
const MAX_HTML_BYTES = 768 * 1024;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const REQUEST_TIMEOUT_MS = 8_000;
const PREVIEW_TTL_MS = 6 * 60 * 60 * 1000;
const FAILED_PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_PREVIEWS = 1000;
const MAX_CACHED_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_PERSISTED_IMAGE_BYTES = 256 * 1024 * 1024;
const REQUESTS_PER_MINUTE = 120;
const USER_AGENT = "Mozilla/5.0 (compatible; KCordLinkPreview/1.0; +https://kafcord.kafly.com.br)";
// SVG is excluded on purpose: it can carry scripts.
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
const cacheDirectory = process.env.KAFCORD_LINK_PREVIEW_CACHE_PATH?.trim()
  || join(process.cwd(), "data", "link-preview-cache");
const previewCacheDirectory = join(cacheDirectory, "previews");
const imageCacheDirectory = join(cacheDirectory, "images");

// Rejects loopback, private, link-local, CGNAT, multicast and reserved ranges.
export function isPublicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = address.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && [0, 2].includes(Number(address.split(".")[2]))))) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    if (mapped) return isPublicAddress(mapped[1]);
    if (normalized === "::" || normalized === "::1") return false;
    if (normalized.startsWith("::ffff:") || normalized.startsWith("64:ff9b:")) return false;
    const first = parseInt(normalized.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return false; // multicast
    if (first === 0x2001 && parseInt(normalized.split(":")[1] || "0", 16) === 0xdb8) return false;
    return true;
  }
  return false;
}

// Checked at connect time, so a DNS answer cannot change between validation and use.
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, "", 0);
      return;
    }
    const list = addresses as LookupAddress[];
    if (list.length === 0 || list.some((entry) => !isPublicAddress(entry.address))) {
      callback(Object.assign(new Error("Endereço de rede não permitido."), { code: "EBLOCKED" }), "", 0);
      return;
    }
    if (options.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  });
};

export function normalizePreviewUrl(value: unknown) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== "80" && url.port !== "443") return null;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) && !isPublicAddress(hostname)) return null;
  if (!hostname.includes(".") || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname === "localhost") return null;
  url.hash = "";
  return url.toString();
}

type FetchResult = { finalUrl: string; contentType: string; body: Buffer };

function fetchOnce(url: string, accept: string, maxBytes: number): Promise<{ status: number; location?: string; contentType: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const send = parsed.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(parsed, {
      method: "GET",
      lookup: publicOnlyLookup,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: accept,
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
      },
    }, (response: IncomingMessage) => {
      const status = response.statusCode ?? 0;
      const contentType = String(response.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (status >= 300 && status < 400) {
        response.resume();
        resolve({ status, location: response.headers.location, contentType, body: Buffer.alloc(0) });
        return;
      }
      const declaredLength = Number(response.headers["content-length"] ?? 0);
      if (declaredLength > maxBytes && !accept.startsWith("text/html")) {
        response.destroy();
        reject(new Error("Resposta grande demais."));
        return;
      }
      const encoding = String(response.headers["content-encoding"] ?? "").toLowerCase();
      const stream = encoding === "gzip" ? response.pipe(createGunzip())
        : encoding === "deflate" ? response.pipe(createInflate())
          : encoding === "br" ? response.pipe(createBrotliDecompress())
            : response;
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (truncated: boolean) => {
        if (settled) return;
        settled = true;
        // HTML may be cut short: the metadata lives in <head>. Images must be complete.
        if (truncated && !accept.startsWith("text/html")) {
          reject(new Error("Resposta grande demais."));
          return;
        }
        resolve({ status, contentType, body: Buffer.concat(chunks) });
      };
      stream.on("data", (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > maxBytes) {
          chunks.push(chunk.subarray(0, Math.max(0, maxBytes - (size - chunk.length))));
          finish(true);
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      stream.on("end", () => finish(false));
      stream.on("error", (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("Tempo esgotado.")));
    request.on("error", reject);
    request.end();
  });
}

async function safeFetch(url: string, accept: string, maxBytes: number): Promise<FetchResult> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const result = await fetchOnce(current, accept, maxBytes);
    if (result.status >= 300 && result.status < 400) {
      if (!result.location) throw new Error("Redirecionamento inválido.");
      const next = normalizePreviewUrl(new URL(result.location, current).toString());
      if (!next) throw new Error("Redirecionamento não permitido.");
      current = next;
      continue;
    }
    if (result.status < 200 || result.status >= 300) throw new Error(`Status ${result.status}.`);
    return { finalUrl: current, contentType: result.contentType, body: result.body };
  }
  throw new Error("Redirecionamentos demais.");
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
function decodeEntities(value: string) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const point = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    }
    return entities[code.toLowerCase()] ?? match;
  });
}

function tagAttributes(tag: string) {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(/([a-zA-Z_:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    attributes.set(match[1].toLowerCase(), decodeEntities(match[3] ?? match[4] ?? match[5] ?? "").trim());
  }
  return attributes;
}

function cleanText(value: string | undefined, maxLength: number) {
  const text = value?.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, maxLength) : null;
}

// Pulls title, site name and the page's own preview image from the HTML head.
export function parsePreviewMetadata(html: string, pageUrl: string) {
  const head = html.slice(0, MAX_HTML_BYTES);
  const meta = new Map<string, string>();
  for (const match of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = tagAttributes(match[0]);
    const key = (attributes.get("property") ?? attributes.get("name") ?? attributes.get("itemprop") ?? "").toLowerCase();
    const content = attributes.get("content");
    if (key && content && !meta.has(key)) meta.set(key, content);
  }
  let imageSrcLink: string | undefined;
  for (const match of head.matchAll(/<link\b[^>]*>/gi)) {
    const attributes = tagAttributes(match[0]);
    if ((attributes.get("rel") ?? "").toLowerCase().split(/\s+/).includes("image_src")) {
      imageSrcLink = attributes.get("href");
      break;
    }
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const rawImage = meta.get("og:image:secure_url") ?? meta.get("og:image") ?? meta.get("og:image:url")
    ?? meta.get("twitter:image") ?? meta.get("twitter:image:src") ?? meta.get("image") ?? imageSrcLink;
  let image: string | null = null;
  if (rawImage) {
    try {
      image = normalizePreviewUrl(new URL(rawImage, pageUrl).toString());
    } catch {
      image = null;
    }
  }
  const siteName = cleanText(meta.get("og:site_name") ?? meta.get("application-name"), 80);
  let title = cleanText(meta.get("og:title") ?? meta.get("twitter:title") ?? (titleTag ? decodeEntities(titleTag) : undefined), 200);
  // "Addon | AeroHub" → "Addon": the card already shows the site name.
  if (title && siteName) {
    const suffix = new RegExp(`\\s*[|\\-–—·:]\\s*${siteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
    title = title.replace(suffix, "").trim() || title;
  }
  return { title, siteName, image };
}

type CachedPreview = { preview: LinkPreview; imageUrl: string | null; expiresAt: number };
type CachedImage = { contentType: string; body: Buffer };
type StoredPreview = {
  version: 1;
  url: string;
  title: string | null;
  siteName: string | null;
  imageUrl: string | null;
  cachedAt: string;
};
type StoredImage = { version: 1; url: string; contentType: string; cachedAt: string };

const previews = new Map<string, CachedPreview>();
const pendingPreviews = new Map<string, Promise<CachedPreview>>();
// Only images that a fetched page pointed at can go through the proxy.
const allowedImageUrls = new Map<string, number>();
const images = new Map<string, CachedImage>();
const usage = new Map<string, { windowStart: number; count: number }>();
let cachedImageBytes = 0;

function consumePreviewRequest(userId: string) {
  const now = Date.now();
  const entry = usage.get(userId);
  if (!entry || now - entry.windowStart > 60_000) {
    usage.set(userId, { windowStart: now, count: 1 });
    if (usage.size > 5000) usage.clear();
    return true;
  }
  entry.count += 1;
  return entry.count <= REQUESTS_PER_MINUTE;
}

function imageProxyPath(imageUrl: string) {
  return `/api/link-preview/image?url=${encodeURIComponent(imageUrl)}`;
}

function cacheKey(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function ensureCacheDirectories() {
  mkdirSync(previewCacheDirectory, { recursive: true });
  mkdirSync(imageCacheDirectory, { recursive: true });
}

function atomicWrite(path: string, contents: string | Buffer) {
  ensureCacheDirectories();
  const temporaryPath = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  writeFileSync(temporaryPath, contents);
  renameSync(temporaryPath, path);
}

function storedImagePaths(url: string) {
  const key = cacheKey(url);
  return {
    body: join(imageCacheDirectory, `${key}.bin`),
    metadata: join(imageCacheDirectory, `${key}.json`),
  };
}

function readStoredImage(url: string): CachedImage | null {
  const paths = storedImagePaths(url);
  if (!existsSync(paths.body) || !existsSync(paths.metadata)) return null;
  try {
    const metadata = JSON.parse(readFileSync(paths.metadata, "utf8")) as Partial<StoredImage>;
    if (metadata.version !== 1 || metadata.url !== url || !metadata.contentType || !IMAGE_TYPES.has(metadata.contentType)) return null;
    const body = readFileSync(paths.body);
    if (body.length === 0 || body.length > MAX_IMAGE_BYTES) return null;
    return { contentType: metadata.contentType, body };
  } catch {
    return null;
  }
}

function pruneStoredImages() {
  const stored = readdirSync(imageCacheDirectory)
    .filter((name) => /^[a-f0-9]{64}\.bin$/.test(name))
    .map((name) => {
      const path = join(imageCacheDirectory, name);
      const stats = statSync(path);
      return { name, path, size: stats.size, modifiedAt: stats.mtimeMs };
    })
    .sort((left, right) => left.modifiedAt - right.modifiedAt);
  let total = stored.reduce((sum, file) => sum + file.size, 0);
  for (const file of stored) {
    if (total <= MAX_PERSISTED_IMAGE_BYTES) break;
    unlinkSync(file.path);
    const metadataPath = join(imageCacheDirectory, file.name.replace(/\.bin$/, ".json"));
    if (existsSync(metadataPath)) unlinkSync(metadataPath);
    total -= file.size;
  }
}

function persistImage(url: string, image: CachedImage) {
  const paths = storedImagePaths(url);
  const metadata: StoredImage = { version: 1, url, contentType: image.contentType, cachedAt: new Date().toISOString() };
  atomicWrite(paths.body, image.body);
  atomicWrite(paths.metadata, JSON.stringify(metadata));
  pruneStoredImages();
}

function persistPreview(url: string, entry: CachedPreview) {
  const stored: StoredPreview = {
    version: 1,
    url,
    title: entry.preview.title,
    siteName: entry.preview.siteName,
    imageUrl: entry.imageUrl,
    cachedAt: new Date().toISOString(),
  };
  atomicWrite(join(previewCacheDirectory, `${cacheKey(url)}.json`), JSON.stringify(stored));
}

function readStoredPreview(url: string): CachedPreview | null {
  const path = join(previewCacheDirectory, `${cacheKey(url)}.json`);
  if (!existsSync(path)) return null;
  try {
    const stored = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredPreview>;
    if (stored.version !== 1 || stored.url !== url) return null;
    const title = typeof stored.title === "string" ? stored.title : null;
    const siteName = typeof stored.siteName === "string" ? stored.siteName : null;
    const imageUrl = typeof stored.imageUrl === "string" && normalizePreviewUrl(stored.imageUrl) === stored.imageUrl
      ? stored.imageUrl
      : null;
    if (imageUrl && !readStoredImage(imageUrl)) return null;
    return {
      preview: { url, title, siteName, image: imageUrl ? imageProxyPath(imageUrl) : null },
      imageUrl,
      // A captured preview belongs to the posted message. It is intentionally
      // durable instead of being refreshed while somebody is opening the card.
      expiresAt: Number.MAX_SAFE_INTEGER,
    };
  } catch {
    return null;
  }
}

function rememberImage(url: string, image: CachedImage, persist = true) {
  if (image.body.length > MAX_CACHED_IMAGE_BYTES / 4) return;
  const previous = images.get(url);
  if (previous) cachedImageBytes -= previous.body.length;
  images.delete(url);
  images.set(url, image);
  cachedImageBytes += image.body.length;
  while (cachedImageBytes > MAX_CACHED_IMAGE_BYTES) {
    const oldest = images.keys().next().value as string;
    cachedImageBytes -= images.get(oldest)?.body.length ?? 0;
    images.delete(oldest);
  }
  if (persist) {
    try {
      persistImage(url, image);
    } catch (error) {
      console.warn("Não foi possível persistir uma imagem de prévia de link.", error);
    }
  }
}

async function fetchAndRememberImage(url: string) {
  const stored = readStoredImage(url);
  if (stored) {
    rememberImage(url, stored, false);
    return stored;
  }
  const result = await safeFetch(url, "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9", MAX_IMAGE_BYTES);
  if (!IMAGE_TYPES.has(result.contentType)) throw new Error("Tipo de imagem não suportado.");
  const image = { contentType: result.contentType, body: result.body };
  rememberImage(url, image);
  return image;
}

async function loadPreview(url: string): Promise<CachedPreview> {
  try {
    const result = await safeFetch(url, "text/html,application/xhtml+xml;q=0.9,image/*;q=0.8,*/*;q=0.5", MAX_HTML_BYTES);
    if (IMAGE_TYPES.has(result.contentType)) {
      // The HTML request may stop after MAX_HTML_BYTES. Fetch an image response
      // with the image-specific size limit so a truncated file is never cached.
      await fetchAndRememberImage(result.finalUrl);
      return { preview: { url, title: null, siteName: null, image: imageProxyPath(result.finalUrl) }, imageUrl: result.finalUrl, expiresAt: Date.now() + PREVIEW_TTL_MS };
    }
    if (result.contentType !== "text/html" && result.contentType !== "application/xhtml+xml") {
      return { preview: { url, title: null, siteName: null, image: null }, imageUrl: null, expiresAt: Date.now() + PREVIEW_TTL_MS };
    }
    const metadata = parsePreviewMetadata(result.body.toString("utf8"), result.finalUrl);
    let imageUrl = metadata.image;
    let expiresAt = Date.now() + PREVIEW_TTL_MS;
    if (imageUrl) {
      try {
        await fetchAndRememberImage(imageUrl);
      } catch {
        // Do not leave a card that will fetch from the source when it is opened.
        imageUrl = null;
        // The page did advertise an image, so retry capture later instead of
        // persisting a temporary image failure as the permanent card.
        expiresAt = Date.now() + FAILED_PREVIEW_TTL_MS;
      }
    }
    return {
      preview: { url, title: metadata.title, siteName: metadata.siteName, image: imageUrl ? imageProxyPath(imageUrl) : null },
      imageUrl,
      expiresAt,
    };
  } catch {
    return { preview: { url, title: null, siteName: null, image: null }, imageUrl: null, expiresAt: Date.now() + FAILED_PREVIEW_TTL_MS };
  }
}

async function getPreview(url: string) {
  const cached = previews.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const stored = readStoredPreview(url);
  if (stored) {
    rememberPreview(url, stored);
    return stored;
  }
  const pending = pendingPreviews.get(url);
  if (pending) return pending;
  const task = loadPreview(url).then((entry) => {
    rememberPreview(url, entry);
    if (entry.expiresAt - Date.now() >= PREVIEW_TTL_MS - 1000) {
      try {
        persistPreview(url, entry);
      } catch (error) {
        console.warn("Não foi possível persistir uma prévia de link.", error);
      }
    }
    return entry;
  }).finally(() => pendingPreviews.delete(url));
  pendingPreviews.set(url, task);
  return task;
}

function rememberPreview(url: string, entry: CachedPreview) {
  previews.delete(url);
  previews.set(url, entry);
  while (previews.size > MAX_PREVIEWS) previews.delete(previews.keys().next().value as string);
  if (entry.imageUrl) {
    allowedImageUrls.delete(entry.imageUrl);
    allowedImageUrls.set(entry.imageUrl, entry.expiresAt);
    while (allowedImageUrls.size > MAX_PREVIEWS) allowedImageUrls.delete(allowedImageUrls.keys().next().value as string);
  }
}

// Called when a message is posted in a links channel. Starting this before the
// chat event is broadcast makes the fetch belong to message creation, while any
// simultaneous preview request joins the same pending promise.
export async function warmLinkPreview(value: unknown, userId: string) {
  if (!userId || !consumePreviewRequest(userId)) return null;
  const url = normalizePreviewUrl(value);
  if (!url) return null;
  return (await getPreview(url)).preview;
}

export function createLinkPreviewRouter(identify: (request: express.Request) => string | null) {
  const router = express.Router();

  function allow(request: express.Request, response: express.Response) {
    const userId = identify(request);
    if (!userId) {
      response.status(401).json({ error: "Entre com sua conta Discord para ver prévias de links." });
      return false;
    }
    if (!consumePreviewRequest(userId)) {
      response.status(429).json({ error: "Muitas prévias de links. Aguarde um instante." });
      return false;
    }
    return true;
  }

  router.get("/api/link-preview", async (request, response) => {
    if (!allow(request, response)) return;
    const url = normalizePreviewUrl(request.query.url);
    if (!url) {
      response.status(400).json({ error: "Link inválido." });
      return;
    }
    const entry = await getPreview(url);
    response.setHeader("Cache-Control", "private, max-age=3600");
    response.json(entry.preview);
  });

  router.get("/api/link-preview/image", async (request, response) => {
    if (!allow(request, response)) return;
    const url = normalizePreviewUrl(request.query.url);
    const allowedUntil = url ? allowedImageUrls.get(url) : undefined;
    if (!url || !allowedUntil || allowedUntil < Date.now()) {
      response.status(404).end();
      return;
    }
    let image = images.get(url);
    if (!image) {
      try {
        image = readStoredImage(url) ?? undefined;
        if (!image) throw new Error("Imagem não encontrada no cache local.");
        rememberImage(url, image, false);
      } catch {
        response.status(404).end();
        return;
      }
    }
    response.setHeader("Content-Type", image.contentType);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Cache-Control", "private, max-age=86400");
    response.end(image.body);
  });

  return router;
}
