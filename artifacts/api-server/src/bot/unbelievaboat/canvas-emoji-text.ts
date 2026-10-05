/**
 * Draw usernames / labels with Twemoji (and Discord custom emoji) on canvas.
 * Plain `fillText` tofu’s emoji — every leaderboard / duel name should use this.
 */

import type { CanvasMod, Ctx } from "../animations/engine.js";
import { loadCurrencyImage, type CurrencyImg } from "./currency-canvas.js";

const CUSTOM_IN_TEXT_RE = /<(a)?:([\w~]+):(\d+)>/g;
const EMOJI_RE =
  /(?:\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*)|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3/gu;

export type TextSegment =
  | { kind: "text"; value: string }
  | { kind: "emoji"; value: string };

/** Split a string into plain text vs emoji / custom-emoji tokens. */
export function segmentEmojiText(input: string): TextSegment[] {
  const raw = input ?? "";
  if (!raw) return [];
  const out: TextSegment[] = [];
  const customMatches = [...raw.matchAll(CUSTOM_IN_TEXT_RE)];
  if (!customMatches.length) {
    pushUnicodeSegments(raw, out);
    return out.filter(s => s.value.length > 0);
  }
  let cursor = 0;
  for (const m of customMatches) {
    const start = m.index ?? 0;
    if (start > cursor) pushUnicodeSegments(raw.slice(cursor, start), out);
    out.push({ kind: "emoji", value: m[0]! });
    cursor = start + m[0]!.length;
  }
  if (cursor < raw.length) pushUnicodeSegments(raw.slice(cursor), out);
  return out.filter(s => s.value.length > 0);
}

function pushUnicodeSegments(text: string, out: TextSegment[]) {
  let last = 0;
  for (const m of text.matchAll(EMOJI_RE)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ kind: "text", value: text.slice(last, start) });
    out.push({ kind: "emoji", value: m[0]! });
    last = start + m[0]!.length;
  }
  if (last < text.length) out.push({ kind: "text", value: text.slice(last) });
}

/** Preload every emoji image referenced in `text`. */
export async function preloadEmojiText(
  mod: CanvasMod,
  text: string,
): Promise<Map<string, CurrencyImg | null>> {
  const map = new Map<string, CurrencyImg | null>();
  const segs = segmentEmojiText(text);
  await Promise.all(
    segs
      .filter((s): s is TextSegment & { kind: "emoji" } => s.kind === "emoji")
      .map(async s => {
        if (map.has(s.value)) return;
        map.set(s.value, await loadCurrencyImage(mod, s.value));
      }),
  );
  return map;
}

export async function preloadEmojiTexts(
  mod: CanvasMod,
  texts: string[],
): Promise<Map<string, CurrencyImg | null>> {
  const merged = new Map<string, CurrencyImg | null>();
  for (const t of texts) {
    const part = await preloadEmojiText(mod, t);
    for (const [k, v] of part) merged.set(k, v);
  }
  return merged;
}

export type DrawEmojiTextOpts = {
  font?: string;
  fillStyle?: string;
  align?: "left" | "right" | "center" | "start" | "end";
  baseline?: "top" | "hanging" | "middle" | "alphabetic" | "ideographic" | "bottom";
  maxWidth?: number;
  emojiSize?: number;
  /** When true, truncate with … to fit maxWidth */
  ellipsis?: boolean;
};

/**
 * Draw mixed text+emoji centered/aligned like fillText.
 * Returns the rendered width.
 */
export function drawTextWithEmojis(
  ctx: Ctx,
  text: string,
  x: number,
  y: number,
  images: Map<string, CurrencyImg | null>,
  opts: DrawEmojiTextOpts = {},
): number {
  const font = opts.font ?? "14px sans-serif";
  const fill = opts.fillStyle ?? "#ffffff";
  const align = opts.align ?? "left";
  const baseline = opts.baseline ?? "alphabetic";
  const emojiSize = opts.emojiSize ?? Math.max(12, Math.floor(parseFontSize(font) * 1.05));

  ctx.save();
  ctx.font = font;
  ctx.fillStyle = fill;
  ctx.textAlign = "left";
  ctx.textBaseline = baseline;

  let segs = segmentEmojiText(text);
  let width = measureSegs(ctx, segs, images, emojiSize);

  if (opts.maxWidth && width > opts.maxWidth && opts.ellipsis !== false) {
    segs = truncateSegs(ctx, segs, images, emojiSize, opts.maxWidth);
    width = measureSegs(ctx, segs, images, emojiSize);
  }

  let cursorX = x;
  if (align === "center") cursorX = x - width / 2;
  else if (align === "right") cursorX = x - width;

  for (const seg of segs) {
    if (seg.kind === "text") {
      ctx.fillText(seg.value, cursorX, y);
      cursorX += ctx.measureText(seg.value).width;
      continue;
    }
    const img = images.get(seg.value);
    if (img) {
      const iy = baselineCenterY(y, baseline, emojiSize);
      ctx.drawImage(img as never, cursorX, iy, emojiSize, emojiSize);
      cursorX += emojiSize + 1;
    } else {
      // Fallback: skip tofu — draw a short placeholder
      const fallback = "•";
      ctx.fillText(fallback, cursorX, y);
      cursorX += ctx.measureText(fallback).width;
    }
  }

  ctx.restore();
  return width;
}

function parseFontSize(font: string): number {
  const m = font.match(/(\d+(?:\.\d+)?)px/);
  return m ? Number(m[1]) : 14;
}

function baselineCenterY(
  y: number,
  baseline: NonNullable<DrawEmojiTextOpts["baseline"]>,
  size: number,
): number {
  if (baseline === "middle") return y - size / 2;
  if (baseline === "top" || baseline === "hanging") return y;
  // alphabetic / bottom — sit emoji roughly on the text line
  return y - size * 0.85;
}

function measureSegs(
  ctx: Ctx,
  segs: TextSegment[],
  images: Map<string, CurrencyImg | null>,
  emojiSize: number,
): number {
  let w = 0;
  for (const seg of segs) {
    if (seg.kind === "text") w += ctx.measureText(seg.value).width;
    else w += (images.get(seg.value) ? emojiSize + 1 : ctx.measureText("•").width);
  }
  return w;
}

function truncateSegs(
  ctx: Ctx,
  segs: TextSegment[],
  images: Map<string, CurrencyImg | null>,
  emojiSize: number,
  maxWidth: number,
): TextSegment[] {
  const ell = "…";
  const ellW = ctx.measureText(ell).width;
  const out: TextSegment[] = [];
  let w = 0;
  for (const seg of segs) {
    if (seg.kind === "emoji") {
      const add = images.get(seg.value) ? emojiSize + 1 : ctx.measureText("•").width;
      if (w + add + ellW > maxWidth) {
        out.push({ kind: "text", value: ell });
        return out;
      }
      out.push(seg);
      w += add;
      continue;
    }
    for (const ch of seg.value) {
      const cw = ctx.measureText(ch).width;
      if (w + cw + ellW > maxWidth) {
        out.push({ kind: "text", value: ell });
        return out;
      }
      const last = out[out.length - 1];
      if (last?.kind === "text") last.value += ch;
      else out.push({ kind: "text", value: ch });
      w += cw;
    }
  }
  return out;
}
