/**
 * Canvas-safe UnbelievaBoat / Discord currency symbols.
 *
 * Embeds keep raw `<:name:id>` so Discord renders the emoji.
 * Canvas must never paint that markup — load CDN / Twemoji, else a short name chip.
 */

import { roundRectPath, type Ctx, type CanvasMod } from "../animations/engine.js";

/** `<:name:id>` or `<a:name:id>` — Discord custom emoji markup. */
const CUSTOM_EMOJI_RE = /^<(a)?:([\w~]+):(\d+)>$/;

export type CurrencyImg = { width: number; height: number };

const SYMBOL_IMG_CACHE = new Map<string, CurrencyImg | null>();

export function parseDiscordEmoji(symbol: string): {
  animated: boolean;
  name: string;
  id: string;
} | null {
  const m = symbol.trim().match(CUSTOM_EMOJI_RE);
  if (!m) return null;
  return { animated: Boolean(m[1]), name: m[2]!, id: m[3]! };
}

/** Short label for canvas / select descriptions (never dump raw `<:name:id>`). */
export function symbolDisplayName(symbol: string): string {
  const custom = parseDiscordEmoji(symbol);
  if (custom) return custom.name;
  if (symbol.length <= 4) return symbol;
  return "★";
}

/** Plain amount label for select menus / non-Discord-render surfaces. */
export function plainCashLabel(amount: number | string): string {
  const n = typeof amount === "number" ? amount.toLocaleString() : amount;
  return `${n} cash`;
}

function emojiToCode(emoji: string): string {
  const known: Record<string, string> = {
    "💵": "1f4b5",
    "💰": "1f4b0",
    "🪙": "1fa99",
    "¢": "a2",
    "🎟️": "1f39f",
    "🎫": "1f3ab",
    "🔴": "1f534",
    "💎": "1f48e",
    "🟤": "1f7e4",
    "⚪": "26aa",
    "🟡": "1f7e1",
    "🎱": "1f3b1",
    "🔢": "1f522",
    "⭐": "2b50",
    "🍒": "1f352",
    "🔔": "1f514",
    "7️⃣": "37-20e3",
  };
  if (known[emoji]) return known[emoji]!;
  const cps: number[] = [];
  for (const ch of emoji) {
    const cp = ch.codePointAt(0);
    if (cp == null || cp === 0xfe0f) continue;
    cps.push(cp);
  }
  return cps.map((c) => c.toString(16)).join("-");
}

/** Load any image URL into canvas (Discord emoji CDN, role icons, uploads). */
export async function loadImageUrl(
  mod: CanvasMod,
  url: string,
): Promise<CurrencyImg | null> {
  const key = `url:${url.trim()}`;
  if (!key || key === "url:") return null;
  if (SYMBOL_IMG_CACHE.has(key)) return SYMBOL_IMG_CACHE.get(key) ?? null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6_000) });
    if (!res.ok) {
      SYMBOL_IMG_CACHE.set(key, null);
      return null;
    }
    const img = await mod.loadImage(Buffer.from(await res.arrayBuffer()));
    SYMBOL_IMG_CACHE.set(key, img);
    return img;
  } catch {
    SYMBOL_IMG_CACHE.set(key, null);
    return null;
  }
}

/** Load Discord custom emoji (animated → GIF frame) or Twemoji; cached. */
export async function loadCurrencyImage(
  mod: CanvasMod,
  symbol: string,
  opts?: { preferAnimated?: boolean },
): Promise<CurrencyImg | null> {
  const key = symbol.trim();
  if (!key) return null;
  if (/^https?:\/\//i.test(key)) return loadImageUrl(mod, key);

  const cacheKey = opts?.preferAnimated ? `a:${key}` : key;
  if (SYMBOL_IMG_CACHE.has(cacheKey)) return SYMBOL_IMG_CACHE.get(cacheKey) ?? null;

  const custom = parseDiscordEmoji(key);
  try {
    let url: string;
    if (custom) {
      const wantGif = Boolean(opts?.preferAnimated && custom.animated);
      const ext = wantGif ? "gif" : "png";
      url = `https://cdn.discordapp.com/emojis/${custom.id}.${ext}?size=128&quality=lossless`;
      let img = await loadImageUrl(mod, url);
      if (!img && wantGif) {
        img = await loadImageUrl(
          mod,
          `https://cdn.discordapp.com/emojis/${custom.id}.png?size=128&quality=lossless`,
        );
      }
      SYMBOL_IMG_CACHE.set(cacheKey, img);
      return img;
    }
    const code = emojiToCode(key);
    if (!code) {
      SYMBOL_IMG_CACHE.set(cacheKey, null);
      return null;
    }
    url = `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/${code}.png`;
    const img = await loadImageUrl(mod, url);
    SYMBOL_IMG_CACHE.set(cacheKey, img);
    return img;
  } catch {
    SYMBOL_IMG_CACHE.set(cacheKey, null);
    return null;
  }
}

function drawSymbolFallback(ctx: Ctx, symbol: string, x: number, y: number, size: number) {
  const label = symbolDisplayName(symbol).slice(0, 4);
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = "#fbbf24";
  ctx.beginPath();
  ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#1a1a1a";
  ctx.font = `bold ${Math.max(9, Math.floor(size * 0.38))}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, 0, 1);
  ctx.restore();
}

/** Draw currency glyph (image or chip) centered at (x, y). */
export function drawCurrencyIcon(
  ctx: Ctx,
  img: CurrencyImg | null,
  symbol: string,
  x: number,
  y: number,
  size: number,
): void {
  if (img) {
    ctx.drawImage(img as never, x - size / 2, y - size / 2, size, size);
    return;
  }
  drawSymbolFallback(ctx, symbol, x, y, size);
}

/**
 * Draw `icon + amount` as a centered or left-aligned group.
 * Never paints raw `<:name:id>` text.
 */
export function drawCurrencyAmount(
  ctx: Ctx,
  img: CurrencyImg | null,
  symbol: string,
  amount: number | string,
  x: number,
  y: number,
  opts?: {
    iconSize?: number;
    font?: string;
    color?: string;
    align?: "center" | "left";
  },
): void {
  const iconSize = opts?.iconSize ?? 22;
  const font = opts?.font ?? "bold 22px Orbitron, sans-serif";
  const color = opts?.color ?? "#fee75c";
  const align = opts?.align ?? "center";
  const text = typeof amount === "number" ? amount.toLocaleString() : amount;

  ctx.save();
  ctx.font = font;
  ctx.textBaseline = "middle";
  const tw = ctx.measureText(text).width;
  const gap = 8;
  const total = iconSize + gap + tw;
  const left = align === "center" ? x - total / 2 : x;

  drawCurrencyIcon(ctx, img, symbol, left + iconSize / 2, y, iconSize);
  ctx.fillStyle = color;
  ctx.textAlign = "left";
  ctx.fillText(text, left + iconSize + gap, y);
  ctx.restore();
}

/** Tiny gold chip used when we need a compact badge without amount. */
export function drawCurrencyChip(
  ctx: Ctx,
  img: CurrencyImg | null,
  symbol: string,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  roundRectPath(ctx, x, y, w, h, 8);
  ctx.fillStyle = "rgba(251, 191, 36, 0.15)";
  ctx.fill();
  drawCurrencyIcon(ctx, img, symbol, x + w / 2, y + h / 2, Math.min(w, h) * 0.65);
}
