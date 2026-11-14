import assert from "node:assert/strict";
import { isPublicAddress, normalizePreviewUrl, parsePreviewMetadata } from "../server/link-preview.ts";

// Internal and reserved addresses must never be fetched.
for (const address of ["127.0.0.1", "10.0.0.5", "172.20.1.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
  assert.equal(isPublicAddress(address), false, address);
}
for (const address of ["8.8.8.8", "104.21.3.4", "2606:4700::1111"]) assert.equal(isPublicAddress(address), true, address);

for (const url of ["http://localhost/x", "http://127.0.0.1/", "http://[::1]/", "file:///etc/passwd", "http://user:pw@example.com/", "http://example.com:8080/", "http://intranet/"]) {
  assert.equal(normalizePreviewUrl(url), null, url);
}
assert.equal(normalizePreviewUrl("https://aerohub.st/addon/x#top"), "https://aerohub.st/addon/x");

const metadata = parsePreviewMetadata(`<html><head><title>Fallback</title>
  <meta property="og:site_name" content="AeroHub" />
  <meta content="FS Ozone Studio &amp; Co | AeroHub" property="og:title">
  <meta property="og:image" content="/img/cover.jpg"></head>`, "https://aerohub.st/addon/fs-ozone-studio-14a81e");
assert.deepEqual(metadata, { title: "FS Ozone Studio & Co", siteName: "AeroHub", image: "https://aerohub.st/img/cover.jpg" });
assert.equal(parsePreviewMetadata(`<meta property="og:image" content="http://192.168.0.1/a.png">`, "https://example.com/").image, null);

console.log("link preview checks passed");
