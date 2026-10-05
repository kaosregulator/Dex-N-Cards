/**
 * Art Show draft pipeline:
 * 1) Modal sets title/description → waiting for image upload
 * 2) Image arrives → draft with preview (Create / Cancel)
 * Discord modals cannot include file uploads.
 */

import type { Message } from "discord.js";

export type PendingArtMeta = {
  guildId: string;
  userId: string;
  channelId: string;
  title: string;
  description: string;
  expiresAt: number;
};

export type ArtDraft = {
  guildId: string;
  userId: string;
  channelId: string;
  title: string;
  description: string;
  imageUrl: string;
  orientation: "landscape" | "portrait" | "square";
  previewMessageId?: string;
  expiresAt: number;
};

const pendingMeta = new Map<string, PendingArtMeta>();
const drafts = new Map<string, ArtDraft>();
const META_TTL_MS = 120_000;
const DRAFT_TTL_MS = 180_000;

function keyOf(guildId: string, userId: string) {
  return `${guildId}:${userId}`;
}

export function beginArtCapture(opts: Omit<PendingArtMeta, "expiresAt">): void {
  // New capture replaces any unfinished draft.
  drafts.delete(keyOf(opts.guildId, opts.userId));
  pendingMeta.set(keyOf(opts.guildId, opts.userId), {
    ...opts,
    expiresAt: Date.now() + META_TTL_MS,
  });
}

export function cancelArtCapture(guildId: string, userId: string): boolean {
  const key = keyOf(guildId, userId);
  const a = pendingMeta.delete(key);
  const b = drafts.delete(key);
  return a || b;
}

export function peekArtCapture(guildId: string, userId: string): PendingArtMeta | null {
  const key = keyOf(guildId, userId);
  const p = pendingMeta.get(key);
  if (!p) return null;
  if (Date.now() > p.expiresAt) {
    pendingMeta.delete(key);
    return null;
  }
  return p;
}

export function takeArtCapture(guildId: string, userId: string): PendingArtMeta | null {
  const p = peekArtCapture(guildId, userId);
  if (!p) return null;
  pendingMeta.delete(keyOf(guildId, userId));
  return p;
}

export function putArtDraft(draft: Omit<ArtDraft, "expiresAt"> & { expiresAt?: number }): ArtDraft {
  const full: ArtDraft = {
    ...draft,
    expiresAt: draft.expiresAt ?? Date.now() + DRAFT_TTL_MS,
  };
  drafts.set(keyOf(draft.guildId, draft.userId), full);
  return full;
}

export function peekArtDraft(guildId: string, userId: string): ArtDraft | null {
  const key = keyOf(guildId, userId);
  const d = drafts.get(key);
  if (!d) return null;
  if (Date.now() > d.expiresAt) {
    drafts.delete(key);
    return null;
  }
  return d;
}

export function takeArtDraft(guildId: string, userId: string): ArtDraft | null {
  const d = peekArtDraft(guildId, userId);
  if (!d) return null;
  drafts.delete(keyOf(guildId, userId));
  return d;
}

export function setDraftPreviewMessage(
  guildId: string,
  userId: string,
  previewMessageId: string,
): void {
  const d = peekArtDraft(guildId, userId);
  if (!d) return;
  d.previewMessageId = previewMessageId;
  drafts.set(keyOf(guildId, userId), d);
}

/** First image attachment on a message, if any. */
export function extractImageAttachment(msg: Message): {
  url: string;
  contentType?: string | null;
  name?: string;
} | null {
  const att = msg.attachments.find(a => {
    const ct = a.contentType ?? "";
    if (ct.startsWith("image/")) return true;
    return /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.name ?? a.url);
  });
  if (!att) return null;
  return { url: att.url, contentType: att.contentType, name: att.name };
}
