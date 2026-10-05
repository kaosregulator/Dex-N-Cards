/**
 * After the submit modal, wait for the artist's next image attachment
 * in the show channel (Discord modals cannot include file uploads).
 */

import type { Message } from "discord.js";

export type PendingArtSubmit = {
  guildId: string;
  userId: string;
  channelId: string;
  title: string;
  description: string;
  expiresAt: number;
};

const pending = new Map<string, PendingArtSubmit>();
const TTL_MS = 120_000;

function keyOf(guildId: string, userId: string) {
  return `${guildId}:${userId}`;
}

export function beginArtCapture(opts: Omit<PendingArtSubmit, "expiresAt">): void {
  pending.set(keyOf(opts.guildId, opts.userId), {
    ...opts,
    expiresAt: Date.now() + TTL_MS,
  });
}

export function cancelArtCapture(guildId: string, userId: string): boolean {
  return pending.delete(keyOf(guildId, userId));
}

export function peekArtCapture(guildId: string, userId: string): PendingArtSubmit | null {
  const key = keyOf(guildId, userId);
  const p = pending.get(key);
  if (!p) return null;
  if (Date.now() > p.expiresAt) {
    pending.delete(key);
    return null;
  }
  return p;
}

export function takeArtCapture(guildId: string, userId: string): PendingArtSubmit | null {
  const p = peekArtCapture(guildId, userId);
  if (!p) return null;
  pending.delete(keyOf(guildId, userId));
  return p;
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
