import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";

/** Desktop installer downloads and the stable `/download` link to the latest one. */
export function createDownloadsRouter(downloadDirectory: string) {
  const router = express.Router();

  // Stable public link: always resolves to the installer named by the updater manifest.
  function latestInstallerName() {
    try {
      const manifest = readFileSync(join(downloadDirectory, "latest.yml"), "utf8");
      const name = /^path:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(manifest)?.[1];
      if (!name || !/^KCord-(?:Web-)?Setup-\d+\.\d+\.\d+\.exe$/.test(name)) return null;
      return existsSync(join(downloadDirectory, name)) ? name : null;
    } catch {
      return null;
    }
  }

  router.get("/download", (_request, response) => {
    const installer = latestInstallerName();
    response.setHeader("Cache-Control", "no-store");
    if (!installer) {
      response.status(503).type("text/plain; charset=utf-8").send("Instalador indisponível no momento.");
      return;
    }
    response.redirect(302, `/downloads/${encodeURIComponent(installer)}`);
  });
  router.use("/downloads", express.static(downloadDirectory, {
    dotfiles: "deny",
    index: false,
    setHeaders: (response, filePath) => {
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Content-Disposition", "attachment");
      response.setHeader("Cache-Control", filePath.endsWith("latest.yml") ? "no-store" : "public, max-age=3600");
    },
  }));

  return router;
}
