/**
 * Draw usernames / labels with Twemoji (and Discord custom emoji) on canvas.
 * Plain `fillText` tofu’s emoji — every leaderboard / duel name should use this.
 */

import type { CanvasMod, Ctx } from "../animations/engine.js";
import {
  setCanvasEmojiPainter,
  type EmojiPaintCtx,
  type EmojiPaintMode,
  type EmojiPaintOriginals,
} from "../canvas-fonts.js";
import { loadCurrencyImage, peekCurrencyImage, type CurrencyImg } from "./currency-canvas.js";

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

const CUSTOM_ONLY_SRC = "<(a)?:([\\w~]+):(\\d+)>";

/** Split Discord custom-emoji markup only. Unicode stays in the text so the emoji font draws it. */
export function segmentCustomEmoji(input: string): TextSegment[] {
  const raw = input ?? "";
  if (!raw) return [];
  const out: TextSegment[] = [];
  let last = 0;
  for (const m of raw.matchAll(new RegExp(CUSTOM_ONLY_SRC, "g"))) {
    const start = m.index ?? 0;
    if (start > last) out.push({ kind: "text", value: raw.slice(last, start) });
    out.push({ kind: "emoji", value: m[0]! });
    last = start + m[0]!.length;
  }
  if (last < raw.length) out.push({ kind: "text", value: raw.slice(last) });
  return out.filter(s => s.value.length > 0);
}

export function hasCustomEmoji(input: string): boolean {
  return new RegExp(CUSTOM_ONLY_SRC).test(input ?? "");
}

function customEmojiLabel(markup: string): string {
  const m = markup.match(/^<(a)?:([\w~]+):(\d+)>$/);
  const name = m?.[2] ?? "";
  if (!name || name === "_" || name.length < 2) return "";
  return name;
}

/** Fetch every custom emoji image referenced in `texts` into the sync cache. */
export async function warmCanvasText(
  mod: CanvasMod,
  texts: Array<string | null | undefined>,
): Promise<void> {
  const customs = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const seg of segmentCustomEmoji(text)) {
      if (seg.kind === "emoji") customs.add(seg.value);
    }
  }
  await Promise.all([...customs].map(symbol => loadCurrencyImage(mod, symbol).catch(() => null)));
}

export function measureCustomEmojiText(ctx: { font: string; measureText(text: string): { width: number } }, text: string): number {
  const emojiSize = Math.max(12, Math.floor(parseFontSize(ctx.font) * 1.05));
  let width = 0;
  for (const seg of segmentCustomEmoji(text)) {
    if (seg.kind === "text") width += ctx.measureText(seg.value).width;
    else if (peekCurrencyImage(seg.value)) width += emojiSize + 1;
    else {
      const label = customEmojiLabel(seg.value);
      if (label) width += ctx.measureText(label).width;
    }
  }
  return width;
}

/**
 * Draw `<:name:id>` as a cached image inside an existing fillText/strokeText.
 * Unicode emoji is left in the text runs for the emoji font. Returns false when
 * the string has no custom emoji so the caller uses the original method.
 */
export function paintCustomEmojiText(
  ctx: EmojiPaintCtx,
  text: string,
  x: number,
  y: number,
  maxWidth: number | undefined,
  mode: EmojiPaintMode,
  originals: EmojiPaintOriginals,
): boolean {
  if (!hasCustomEmoji(text)) return false;
  const segs = segmentCustomEmoji(text);
  if (!segs.some(s => s.kind === "emoji")) return false;

  const paintRun = (value: string, at: number) => {
    if (mode === "stroke") originals.strokeText.call(ctx, value, at, y);
    else originals.fillText.call(ctx, value, at, y);
  };

  if (maxWidth != null) {
    const plain = segs.map(s => s.kind === "text" ? s.value : customEmojiLabel(s.value)).join("");
    if (mode === "stroke") originals.strokeText.call(ctx, plain, x, y, maxWidth);
    else originals.fillText.call(ctx, plain, x, y, maxWidth);
    return true;
  }

  const emojiSize = Math.max(12, Math.floor(parseFontSize(ctx.font) * 1.05));
  const baseline = ctx.textBaseline || "alphabetic";
  const align = ctx.textAlign || "left";
  const widthOf = (seg: TextSegment) => {
    if (seg.kind === "text") return ctx.measureText(seg.value).width;
    if (peekCurrencyImage(seg.value)) return emojiSize + 1;
    const label = customEmojiLabel(seg.value);
    return label ? ctx.measureText(label).width : 0;
  };
  const total = segs.reduce((w, seg) => w + widthOf(seg), 0);
  let cursor = x;
  if (align === "center") cursor = x - total / 2;
  else if (align === "right" || align === "end") cursor = x - total;

  const prevAlign = ctx.textAlign;
  ctx.textAlign = "left";
  try {
    for (const seg of segs) {
      if (seg.kind === "text") {
        paintRun(seg.value, cursor);
        cursor += ctx.measureText(seg.value).width;
        continue;
      }
      const img = peekCurrencyImage(seg.value);
      if (mode === "fill" && img) {
        const iy = baseline === "middle" ? y - emojiSize / 2
          : baseline === "top" || baseline === "hanging" ? y
          : y - emojiSize * 0.85;
        ctx.drawImage(img, cursor, iy, emojiSize, emojiSize);
        cursor += emojiSize + 1;
        continue;
      }
      const label = customEmojiLabel(seg.value);
      if (!label) continue;
      paintRun(label, cursor);
      cursor += ctx.measureText(label).width;
    }
  } finally {
    ctx.textAlign = prevAlign;
  }
  return true;
}

setCanvasEmojiPainter(paintCustomEmojiText);

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
