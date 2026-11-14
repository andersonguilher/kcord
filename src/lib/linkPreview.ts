import type { LinkPreview } from "../types";

export const linkPreviewRequests = new Map<string, Promise<LinkPreview | null>>();

export function requestLinkPreview(url: string) {
  let pending = linkPreviewRequests.get(url);
  if (!pending) {
    pending = fetch(`/api/link-preview?url=${encodeURIComponent(url)}`, { credentials: "same-origin" })
      .then((response) => response.ok ? response.json() as Promise<LinkPreview> : null)
      .catch(() => null);
    linkPreviewRequests.set(url, pending);
    // Failed lookups are retried on a later render instead of sticking forever.
    void pending.then((preview) => { if (!preview) linkPreviewRequests.delete(url); });
  }
  return pending;
}
