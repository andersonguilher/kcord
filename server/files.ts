import { closeSync, existsSync, openSync, readSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { sniffImageType } from "../shared/channel-rules.ts";
import type { ChatStore } from "./chat-store.ts";
import { getDiscordSocketIdentity, kafcordUserIdsForDiscordUser } from "./discord-integration.ts";

type FileStorageOptions = {
  chatStore: ChatStore;
  uploadDirectory: string;
  avatarDirectory: string;
  retentionMs: number;
  cleanupIntervalMs: number;
};

/** Whether a received upload starts with the signature of a supported image. */
export function isImageUpload(filePath: string) {
  const head = Buffer.alloc(12);
  const descriptor = openSync(filePath, "r");
  try {
    const length = readSync(descriptor, head, 0, head.length, 0);
    return sniffImageType(head.subarray(0, length)) !== null;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Serves stored attachments (forced download, nosniff, private-conversation
 * checks) and avatars, and removes expired or orphaned uploads on a schedule.
 */
export function createFileStorage({ chatStore, uploadDirectory, avatarDirectory, retentionMs, cleanupIntervalMs }: FileStorageOptions) {
  const router = express.Router();

  function storedUploadName(fileUrl: string) {
    return /^\/files\/([a-zA-Z0-9_-]+)$/.exec(fileUrl)?.[1];
  }

  function deleteStoredUpload(fileUrl: string) {
    const fileName = storedUploadName(fileUrl);
    if (!fileName) return;
    const filePath = join(uploadDirectory, fileName);
    if (existsSync(filePath)) unlinkSync(filePath);
  }

  function cleanupExpiredUploads() {
    const now = Date.now();
    for (const attachment of chatStore.expiredAttachments(now)) {
      try {
        deleteStoredUpload(attachment.file_url);
        chatStore.markAttachmentDeleted(attachment.id);
      } catch (error) {
        console.warn(`Não foi possível remover o upload expirado ${attachment.id}.`, error);
      }
    }

    for (const entry of readdirSync(uploadDirectory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const fileUrl = `/files/${entry.name}`;
      if (chatStore.attachmentByUrl(fileUrl)) continue;
      const filePath = join(uploadDirectory, entry.name);
      try {
        if (statSync(filePath).mtimeMs <= now - retentionMs) unlinkSync(filePath);
      } catch (error) {
        console.warn(`Não foi possível verificar o upload órfão ${entry.name}.`, error);
      }
    }
  }

  cleanupExpiredUploads();
  setInterval(cleanupExpiredUploads, cleanupIntervalMs).unref();

  router.get("/files/:fileName", (request, response) => {
    const fileName = String(request.params.fileName ?? "");
    if (!/^[a-zA-Z0-9_-]+$/.test(fileName)) {
      response.status(404).end();
      return;
    }
    const fileUrl = `/files/${fileName}`;
    const attachment = chatStore.attachmentByUrl(fileUrl);
    const expired = !attachment
      || attachment.file_deleted === 1
      || attachment.file_expires_at_ms === null
      || attachment.file_expires_at_ms <= Date.now();
    if (expired) {
      if (attachment && attachment.file_deleted !== 1) {
        try {
          deleteStoredUpload(fileUrl);
          chatStore.markAttachmentDeleted(attachment.id);
        } catch (error) {
          console.warn(`Não foi possível remover o upload expirado ${attachment.id}.`, error);
        }
      }
      response.status(410).type("text/plain; charset=utf-8").send("Este arquivo expirou e foi removido após 3 dias.");
      return;
    }
    if (attachment.scope === "direct") {
      const identity = getDiscordSocketIdentity(request.headers.cookie);
      const allowedUserIds = identity ? new Set([
        identity.kafcordUserId,
        ...kafcordUserIdsForDiscordUser(identity.discordUserId),
      ]) : new Set<string>();
      const discordParticipant = identity && (
        identity.discordUserId === attachment.from_discord_user_id
        || identity.discordUserId === attachment.to_discord_user_id
      );
      if (!identity || (!discordParticipant && !allowedUserIds.has(attachment.from_user_id ?? "") && !allowedUserIds.has(attachment.to_user_id ?? ""))) {
        response.status(403).json({ error: "Este arquivo pertence a uma conversa privada." });
        return;
      }
    }
    const filePath = join(uploadDirectory, fileName);
    if (!existsSync(filePath)) {
      chatStore.markAttachmentDeleted(attachment.id);
      response.status(410).type("text/plain; charset=utf-8").send("Este arquivo não está mais disponível.");
      return;
    }
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.download(filePath, attachment.file_name);
  });
  router.use("/avatars", express.static(avatarDirectory, {
    dotfiles: "deny",
    index: false,
    maxAge: "7d",
    setHeaders: (response) => {
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Content-Disposition", "inline");
      response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    },
  }));

  return { router, deleteStoredUpload };
}
