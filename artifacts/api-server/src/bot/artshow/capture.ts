/**
 * Art Show image helpers — submissions use a normal Discord attachment
 * (slash `/artshow submit` or drop a photo in the board channel).
 */

import type { Message } from "discord.js";

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

/** Title from message body, else cleaned attachment name, else fallback. */
export function titleFromDrop(content: string, attachmentName?: string): string {
  const fromBody = content.trim().split("\n")[0]?.trim() ?? "";
  if (fromBody) return fromBody.slice(0, 80);
  if (attachmentName) {
    const base = attachmentName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
    if (base) return base.slice(0, 80);
  }
  return "Untitled art";
}
