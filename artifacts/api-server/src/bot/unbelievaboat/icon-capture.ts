/**
 * Capture a Discord-native emoji / GIF from chat for store role icons.
 * Admin clicks "Pick in chat" → sends emoji/GIF with Discord’s own bar →
 * we apply it and delete their message.
 */

import type { Message } from "discord.js";
import { parseDiscordEmoji } from "./currency-canvas.js";
import {
  discordEmojiCdnUrl,
  formatGuildEmoji,
  isHttpImageUrl,
  normalizeStoreIconInput,
} from "./store-icons.js";

export type CapturedIcon = {
  emoji: string;
  imageUrl?: string;
  animated: boolean;
  source: "custom_emoji" | "unicode" | "attachment";
};

type PendingIconCapture = {
  guildId: string;
  userId: string;
  linkId: number;
  channelId: string;
  expiresAt: number;
  confirm: (icon: CapturedIcon) => Promise<void>;
  abort: () => Promise<void>;
  onExpire?: () => void;
};

const pending = new Map<string, PendingIconCapture>();
const TTL_MS = 90_000;

function keyOf(guildId: string, userId: string) {
  return `${guildId}:${userId}`;
}

export function beginIconCapture(opts: Omit<PendingIconCapture, "expiresAt">): void {
  const key = keyOf(opts.guildId, opts.userId);
  const prev = pending.get(key);
  if (prev?.onExpire) {
    try { prev.onExpire(); } catch { /* ignore */ }
  }
  pending.set(key, { ...opts, expiresAt: Date.now() + TTL_MS });
}

export function cancelIconCapture(guildId: string, userId: string): boolean {
  return pending.delete(keyOf(guildId, userId));
}

export function hasIconCapture(guildId: string, userId: string): boolean {
  const p = pending.get(keyOf(guildId, userId));
  if (!p) return false;
  if (Date.now() > p.expiresAt) {
    pending.delete(keyOf(guildId, userId));
    return false;
  }
  return true;
}

function looksLikeImageUrl(url: string): boolean {
  return isHttpImageUrl(url)
    || /discord(?:app)?\.(?:com|net)/i.test(url)
    || /(?:tenor|giphy|media\.tenor)\./i.test(url);
}

function iconFromImageUrl(url: string, hintName = ""): CapturedIcon {
  const lower = `${url} ${hintName}`.toLowerCase();
  const animated = lower.includes(".gif") || lower.includes("tenor") || lower.includes("giphy");
  return {
    emoji: animated ? "🎞️" : "🖼️",
    imageUrl: url,
    animated,
    source: "attachment",
  };
}

/** Extract emoji markup / unicode / image attachment from a user message. */
export function extractIconFromMessage(msg: Message): CapturedIcon | null {
  const content = msg.content?.trim() ?? "";

  // Custom Discord emoji (animated or static) — first match wins.
  const customMatch = content.match(/<(a)?:([\w~]+):(\d+)>/);
  if (customMatch) {
    const animated = Boolean(customMatch[1]);
    const name = customMatch[2]!;
    const id = customMatch[3]!;
    const emoji = formatGuildEmoji({ id, name, animated });
    return {
      emoji,
      imageUrl: discordEmojiCdnUrl(id, animated),
      animated,
      source: "custom_emoji",
    };
  }

  // Shortcode `:Angel:` → resolve against guild cache
  const short = content.match(/^:([\w~]+):$/);
  if (short && msg.guild) {
    const name = short[1]!;
    const cache = msg.guild.emojis.cache;
    const values = typeof cache?.values === "function" ? [...cache.values()] : [];
    const ge = values.find(e => e.name === name)
      ?? values.find(e => e.name?.toLowerCase() === name.toLowerCase());
    if (ge) {
      const animated = Boolean(ge.animated);
      const emoji = formatGuildEmoji({ id: ge.id, name: ge.name || name, animated });
      return {
        emoji,
        imageUrl: discordEmojiCdnUrl(ge.id, animated),
        animated,
        source: "custom_emoji",
      };
    }
  }

  // Unicode / pictographic (Discord emoji bar → unicode)
  if (content && !content.includes("<") && /\p{Extended_Pictographic}/u.test(content)) {
    const icon = normalizeStoreIconInput(content);
    return { emoji: icon.emoji, imageUrl: icon.imageUrl, animated: false, source: "unicode" };
  }

  // Attachment — GIF / PNG / WebP from Discord’s native file / GIF bar
  const att = msg.attachments.find(a => {
    const type = a.contentType?.toLowerCase() ?? "";
    const name = a.name?.toLowerCase() ?? "";
    if (type.startsWith("image/")) return true;
    return /\.(gif|png|jpe?g|webp)$/i.test(name);
  });
  if (att) {
    const imageUrl = att.proxyURL || att.url;
    if (imageUrl && looksLikeImageUrl(imageUrl)) {
      return iconFromImageUrl(imageUrl, att.name ?? "");
    }
  }

  // Discord GIF picker often posts as an embed (Tenor/Giphy), not an attachment.
  for (const emb of msg.embeds ?? []) {
    const url = emb.image?.proxyURL || emb.image?.url
      || emb.thumbnail?.proxyURL || emb.thumbnail?.url
      || emb.url
      || null;
    if (url && looksLikeImageUrl(url)) {
      return iconFromImageUrl(url, emb.title ?? "");
    }
  }

  // Bare image URL in chat
  if (/^https?:\/\/\S+$/i.test(content) && looksLikeImageUrl(content)) {
    return iconFromImageUrl(content);
  }

  return null;
}

/**
 * If this message is an admin’s pending icon pick, apply it and delete the msg.
 * Returns true when consumed (caller should stop further message handling).
 */
export async function tryConsumeIconCaptureMessage(msg: Message): Promise<boolean> {
  if (!msg.guild || msg.author.bot) return false;
  const key = keyOf(msg.guild.id, msg.author.id);
  const session = pending.get(key);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    pending.delete(key);
    return false;
  }
  // Must be same channel they started from (ephemeral instructions point here).
  if (msg.channelId !== session.channelId) return false;

  if (/^cancel$/i.test(msg.content.trim())) {
    pending.delete(key);
    await msg.delete().catch(() => {});
    await session.abort().catch(() => {});
    return true;
  }

  const icon = extractIconFromMessage(msg);
  if (!icon) {
    // Soft nudge — don't delete non-icon chatter accidentally.
    await msg.reply({
      content: "Send a **Discord emoji** (emoji bar) or a **GIF/image** (GIF / file bar). Type `cancel` to abort.",
    }).then(m => setTimeout(() => m.delete().catch(() => {}), 8_000)).catch(() => {});
    return true; // consume so prefix commands don't fire mid-pick
  }

  pending.delete(key);
  await msg.delete().catch(() => {});
  await session.confirm(icon);
  return true;
}

/** Resolve `:name:` shortcodes using guild emoji cache (for leftover paste paths). */
export function resolveEmojiShortcode(
  raw: string,
  guildEmojis: Iterable<{ id: string; name: string | null; animated: boolean | null }>,
): ReturnType<typeof normalizeStoreIconInput> {
  const trimmed = raw.trim();
  const custom = parseDiscordEmoji(trimmed);
  if (custom) {
    return {
      emoji: trimmed,
      imageUrl: discordEmojiCdnUrl(custom.id, custom.animated),
      animated: custom.animated,
    };
  }
  const short = trimmed.match(/^:([\w~]+):$/);
  if (short) {
    const want = short[1]!.toLowerCase();
    for (const e of guildEmojis) {
      if ((e.name || "").toLowerCase() === want) {
        const animated = Boolean(e.animated);
        const emoji = formatGuildEmoji({ id: e.id, name: e.name || short[1]!, animated });
        return {
          emoji,
          imageUrl: discordEmojiCdnUrl(e.id, animated),
          animated,
        };
      }
    }
  }
  return normalizeStoreIconInput(trimmed);
}
