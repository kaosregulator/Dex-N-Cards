/**
 * Default perk-store icons + helpers for unicode / custom Discord emoji.
 */

import { parseDiscordEmoji } from "./currency-canvas.js";

export type StoreIconPreset = {
  id: string;
  label: string;
  /** Unicode or `<:name:id>` for Discord select/embed */
  emoji: string;
  /** Landscape-friendly PNG for embed thumbnail / purchase art */
  imageUrl: string;
};

/** Twemoji PNGs — stable CDN, no Discord attachment needed. */
function twemoji(code: string): string {
  return `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/${code}.png`;
}

export const DEFAULT_STORE_ICONS: StoreIconPreset[] = [
  { id: "sparkle", label: "Sparkle", emoji: "✨", imageUrl: twemoji("2728") },
  { id: "crown", label: "Crown", emoji: "👑", imageUrl: twemoji("1f451") },
  { id: "star", label: "Star", emoji: "⭐", imageUrl: twemoji("2b50") },
  { id: "fire", label: "Fire", emoji: "🔥", imageUrl: twemoji("1f525") },
  { id: "rocket", label: "Rocket", emoji: "🚀", imageUrl: twemoji("1f680") },
  { id: "gift", label: "Gift", emoji: "🎁", imageUrl: twemoji("1f381") },
  { id: "trophy", label: "Trophy", emoji: "🏆", imageUrl: twemoji("1f3c6") },
  { id: "heart", label: "Heart", emoji: "💜", imageUrl: twemoji("1f49c") },
  { id: "ticket", label: "Ticket", emoji: "🎟️", imageUrl: twemoji("1f39f") },
  { id: "shield", label: "Shield", emoji: "🛡️", imageUrl: twemoji("1f6e1") },
];

export function presetById(id: string): StoreIconPreset | undefined {
  return DEFAULT_STORE_ICONS.find(p => p.id === id);
}

/** Discord select-menu emoji resolver (unicode OR custom guild emoji). */
export function resolveSelectEmoji(
  raw: string | null | undefined,
): { id: string; name: string; animated?: boolean } | string | undefined {
  if (!raw?.trim()) return undefined;
  const custom = parseDiscordEmoji(raw.trim());
  if (custom) {
    return custom.animated
      ? { id: custom.id, name: custom.name, animated: true }
      : { id: custom.id, name: custom.name };
  }
  // First grapheme if it looks like an emoji
  const ch = [...raw.trim()][0];
  if (ch && /\p{Extended_Pictographic}/u.test(ch)) return ch;
  return undefined;
}

/** Normalize modal/emoji input into stored emoji + optional image from custom emoji CDN. */
export function normalizeStoreIconInput(input: string): {
  emoji: string;
  imageUrl?: string;
} {
  const trimmed = input.trim();
  if (!trimmed) return { emoji: "✨" };
  const custom = parseDiscordEmoji(trimmed);
  if (custom) {
    const ext = custom.animated ? "gif" : "png";
    return {
      emoji: trimmed,
      imageUrl: `https://cdn.discordapp.com/emojis/${custom.id}.${ext}?size=128&quality=lossless`,
    };
  }
  return { emoji: trimmed.slice(0, 64) };
}

export function isHttpImageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return /\.(png|jpe?g|gif|webp)(\?|$)/i.test(u.pathname) || u.hostname.includes("discord");
  } catch {
    return false;
  }
}
