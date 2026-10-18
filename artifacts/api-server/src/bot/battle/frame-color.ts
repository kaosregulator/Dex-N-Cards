// Battle frame colours.
//
// image   samples the whole card picture, vehicle included.
// emoji   samples the rarity emoji that server already uses.
// custom  blends two colours an admin scrolled to.
// rainbow paints a rainbow frame.

import sharp from "sharp";
import { getCanvas, type Ctx } from "../animations/engine.js";
import { drawStyledFrame, styleArtWindow, type FrameStyle } from "./frame-styles.js";
import { loadCurrencyImage } from "../unbelievaboat/currency-canvas.js";
import { dominantColorFromBuffer } from "../images/raster.js";
import { extractArtColor } from "./image/vibrant-color.js";

export const FRAME_COLOR_MODES = ["image", "emoji", "custom", "rainbow"] as const;
export type FrameColorMode = (typeof FRAME_COLOR_MODES)[number];

/** Ornate card-frame files. The same sampler reads whichever file is assigned. */
export const FRAME_IMAGE_COLORS = ["grey", "blue", "red", "gold", "rainbow"] as const;
export type FrameImageColor = (typeof FRAME_IMAGE_COLORS)[number];

export function frameColorModeOf(value: string | null | undefined): FrameColorMode {
  return value === "emoji" || value === "custom" || value === "rainbow" ? value : "image";
}

export function frameColorModeLabel(mode: FrameColorMode): string {
  if (mode === "emoji") return "Rarity emoji";
  if (mode === "custom") return "Two custom colors";
  if (mode === "rainbow") return "Rainbow";
  return "Whole card picture";
}

export interface ColorShade {
  id: string;
  label: string;
  hex: string;
  n: number;
}

export interface ColorFamily {
  id: string;
  label: string;
  shades: ColorShade[];
}

function shade(id: string, label: string, hex: string): ColorShade {
  return { id, label, hex, n: Number.parseInt(hex.slice(1), 16) };
}

export const COLOR_FAMILIES: ColorFamily[] = [
  family("crimson", "Crimson", ["#4a0d14", "#7a1420", "#b4232c", "#e23b3b", "#ff6b6b", "#ffb4b4"]),
  family("ember", "Ember", ["#4a1c08", "#8a3410", "#d35400", "#e67e22", "#f5a35c", "#ffd0a6"]),
  family("gold", "Gold", ["#4a3808", "#8a6a10", "#d4a017", "#f1c40f", "#ffe066", "#fff3b0"]),
  family("lime", "Lime", ["#1d3a0c", "#3d6b16", "#6aa832", "#a3d15c", "#c6ee7a", "#e4ffb0"]),
  family("emerald", "Emerald", ["#063026", "#0e5c45", "#14916c", "#1abc9c", "#5ee0c5", "#b8fff0"]),
  family("teal", "Teal", ["#063038", "#0e5c6b", "#1488a0", "#1ec6e0", "#7ae4f5", "#c8f7ff"]),
  family("azure", "Azure", ["#0a1e4a", "#143a8a", "#1f5ed0", "#3d8bfd", "#7eb6ff", "#c5dcff"]),
  family("indigo", "Indigo", ["#1a1040", "#32207a", "#4c3cc4", "#7a6cf0", "#b0a6ff", "#ddd8ff"]),
  family("violet", "Violet", ["#2a0a40", "#5a189a", "#8e44ad", "#b56bff", "#d7a6ff", "#f0dcff"]),
  family("magenta", "Magenta", ["#4a0830", "#8a1458", "#d41470", "#ff4fa3", "#ff8cc4", "#ffd0e6"]),
  family("rose", "Rose", ["#4a1820", "#8a3040", "#c45068", "#e88898", "#f5b8c2", "#ffe4ea"]),
  family("slate", "Slate", ["#1a1c20", "#3a3f48", "#5c6570", "#8b95a1", "#c5ccd4", "#eef1f4"]),
];

function family(id: string, label: string, hexes: string[]): ColorFamily {
  const names = ["Deep", "Rich", "Core", "Bright", "Light", "Pale"];
  return {
    id,
    label,
    shades: hexes.map((hex, i) => shade(`${id}-${i}`, names[i] ?? `Shade ${i + 1}`, hex)),
  };
}

export function parseHexColor(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = value.trim().match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return null;
  return Number.parseInt(m[1]!, 16);
}

export function hexOf(n: number): string {
  return `#${(n & 0xffffff).toString(16).padStart(6, "0")}`;
}

export function locateColor(n: number | null): { family: number; shade: number } {
  if (n == null) return { family: 2, shade: 3 };
  let bestF = 0;
  let bestS = 0;
  let best = Number.POSITIVE_INFINITY;
  COLOR_FAMILIES.forEach((fam, fi) => {
    fam.shades.forEach((s, si) => {
      const d = colorDistance(n, s.n);
      if (d < best) {
        best = d;
        bestF = fi;
        bestS = si;
      }
    });
  });
  return { family: bestF, shade: bestS };
}

function colorDistance(a: number, b: number): number {
  const dr = ((a >> 16) & 255) - ((b >> 16) & 255);
  const dg = ((a >> 8) & 255) - ((b >> 8) & 255);
  const db = (a & 255) - (b & 255);
  return dr * dr + dg * dg + db * db;
}

export function stepColor(n: number | null, dir: -1 | 1): number {
  const at = locateColor(n);
  const count = COLOR_FAMILIES.reduce((sum, fam) => sum + fam.shades.length, 0);
  let index = COLOR_FAMILIES.slice(0, at.family).reduce((sum, fam) => sum + fam.shades.length, 0) + at.shade;
  index = (index + dir + count) % count;
  for (const fam of COLOR_FAMILIES) {
    if (index < fam.shades.length) return fam.shades[index]!.n;
    index -= fam.shades.length;
  }
  return COLOR_FAMILIES[0]!.shades[0]!.n;
}

export function familyById(id: string): ColorFamily {
  return COLOR_FAMILIES.find(f => f.id === id) ?? COLOR_FAMILIES[0]!;
}

const RAINBOW = ["#ff4d4d", "#ff9f1a", "#ffe14d", "#3ddc6a", "#3dc6ff", "#7a5cff", "#ff4fd8"];

export function rainbowGradient(ctx: Ctx, x: number, y: number, w: number, h: number) {
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  RAINBOW.forEach((hex, i) => g.addColorStop(i / (RAINBOW.length - 1), hex));
  return g;
}

export async function renderFramePreview(opts: {
  mode: FrameColorMode;
  colorA: number | null;
  colorB: number | null;
  title?: string | null;
  style?: FrameStyle;
}): Promise<Buffer | null> {
  const mod = await getCanvas();
  if (!mod) return null;
  const W = 440;
  const H = 280;
  const canvas = mod.createCanvas(W, H);
  const ctx = canvas.getContext("2d") as unknown as Ctx;
  ctx.fillStyle = "#1e1f22";
  ctx.fillRect(0, 0, W, H);

  const a = opts.colorA ?? 0xf1c40f;
  const b = opts.colorB ?? 0x3d8bfd;
  const cardX = 150;
  const cardY = 28;
  const cardW = 140;
  const cardH = 196;
  const win = styleArtWindow(cardX, cardY, cardW, cardH);
  round(ctx, win.x, win.y, win.w, win.h, 10);
  ctx.fillStyle = "#111214";
  ctx.fill();
  ctx.fillStyle = "#f2f3f5";
  ctx.font = "700 13px DNSans, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(opts.title?.slice(0, 18) || frameColorModeLabel(opts.mode), win.x + win.w / 2, win.y + 28);
  ctx.font = "500 11px DNSans, sans-serif";
  ctx.fillStyle = "#b5bac1";
  const caption = opts.mode === "image"
    ? "Samples the picture"
    : opts.mode === "emoji"
      ? "Samples the emoji"
      : opts.mode === "rainbow"
        ? "Rainbow frame"
        : "Two colors";
  ctx.fillText(caption, win.x + win.w / 2, win.y + win.h - 18);
  const paint = opts.mode === "rainbow" ? "rainbow" : opts.mode === "custom" ? "blend" : "solid";
  drawStyledFrame(ctx, cardX, cardY, cardW, cardH, {
    style: opts.style ?? "crest",
    color: opts.mode === "custom" ? a : (opts.colorA ?? 0x8b95a1),
    paint,
    blendA: a,
    blendB: b,
  });

  drawSwatch(ctx, 28, 78, a, "A");
  drawSwatch(ctx, 348, 78, b, "B");
  ctx.textAlign = "left";
  return (canvas as unknown as { toBuffer(mime: "image/png"): Buffer }).toBuffer("image/png");
}

function drawSwatch(ctx: Ctx, x: number, y: number, color: number, label: string): void {
  round(ctx, x, y, 64, 64, 14);
  ctx.fillStyle = hexOf(color);
  ctx.fill();
  ctx.fillStyle = "#f2f3f5";
  ctx.font = "700 16px DNSans, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(label, x + 32, y + 84);
  ctx.font = "500 11px DNSans, sans-serif";
  ctx.fillStyle = "#b5bac1";
  ctx.fillText(hexOf(color), x + 32, y + 104);
}

function round(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export async function colorFromEmoji(emoji: string | null | undefined): Promise<number | null> {
  if (!emoji) return null;
  const mod = await getCanvas();
  if (!mod) return null;
  const img = await loadCurrencyImage(mod, emoji);
  if (!img) return null;
  try {
    const width = (img as { width: number }).width || 72;
    const height = (img as { height: number }).height || 72;
    const canvas = mod.createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img as never, 0, 0, width, height);
    const encoded = (canvas as unknown as { toBuffer(mime: "image/png"): Buffer }).toBuffer("image/png");
    return dominantColorFromBuffer(encoded);
  } catch {
    return null;
  }
}

export async function stampCardAccent<T extends {
  rarity?: string | null;
  artUrl?: string | null;
  rarityColor?: number | null;
  accentEmoji?: string | null;
  frameMode?: FrameColorMode;
  frameColorA?: number | null;
  frameColorB?: number | null;
  frameSlot?: "a" | "b";
  frameImage?: FrameImageColor | null;
  frameBuffer?: Buffer | null;
  framePaint?: "solid" | "rainbow" | "blend";
  blendA?: number;
  blendB?: number;
}>(card: T): Promise<T> {
  if (!card.frameMode && !card.frameImage && !card.frameBuffer) return card;
  const accent = await resolveFrameAccent({
    mode: card.frameMode ?? "image",
    artUrl: card.artUrl,
    rarityEmoji: card.accentEmoji,
    rarityColor: card.rarityColor,
    colorA: card.frameColorA,
    colorB: card.frameColorB,
    slot: card.frameSlot,
    frameImage: card.frameImage,
    frameBuffer: card.frameBuffer,
  });
  return {
    ...card,
    rarityColor: accent.color ?? card.rarityColor,
    framePaint: accent.paint,
    blendA: accent.blendA,
    blendB: accent.blendB,
  };
}

export interface FrameAccent {
  color: number | null;
  paint: "solid" | "rainbow" | "blend";
  blendA?: number;
  blendB?: number;
  /** Staff chose this tier, or a frame image is on it. Shared picture mode does not. */
  ownsColor: boolean;
}

const sampleCache = new Map<string, number>();

function rememberSample(key: string, color: number | null): number | null {
  if (color == null) return null;
  sampleCache.set(key, color);
  if (sampleCache.size > 128) {
    const oldest = sampleCache.keys().next().value;
    if (oldest !== undefined) sampleCache.delete(oldest);
  }
  return color;
}

/** One sampler for every frame source. The key is the frame that is on the card now. */
export async function sampleFrameBuffer(key: string, input: Buffer): Promise<number | null> {
  const cached = sampleCache.get(key);
  if (cached !== undefined) return cached;
  const color = await dominantColorFromBuffer(input);
  return rememberSample(key, color);
}

const frameImageCache = new Map<string, { color: number; rainbow: boolean }>();

function hsvOf(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/**
 * Colour of an ornate frame image.
 * Every frame shares the same bronze inner trim, so that trim is skipped and the
 * coloured edge is what gets sampled. A rainbow edge and a red edge take this
 * same path; a wide spread of hues is the rainbow.
 */
export async function sampleFrameImage(key: string, input: Buffer): Promise<{ color: number; rainbow: boolean } | null> {
  const cached = frameImageCache.get(key);
  if (cached) return cached;
  try {
    const size = 96;
    const { data, info } = await sharp(input, { animated: false, pages: 1 })
      .ensureAlpha()
      .resize(size, size, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const scored = scoreFramePixels(data, info.width || size, info.height || size, info.channels || 4);
    if (!scored) return null;
    frameImageCache.set(key, scored);
    if (frameImageCache.size > 32) {
      const oldest = frameImageCache.keys().next().value;
      if (oldest !== undefined) frameImageCache.delete(oldest);
    }
    return scored;
  } catch {
    return null;
  }
}

function scoreFramePixels(data: Buffer, cols: number, rows: number, channels: number): { color: number; rainbow: boolean } | null {
  const distinctive = collectFramePixels(data, cols, rows, channels, true);
  if (distinctive.kept >= 40) return finishFrameScore(distinctive);
  const includingTrim = collectFramePixels(data, cols, rows, channels, false);
  if (includingTrim.kept >= 20) return { color: includingTrim.color, rainbow: false };
  return null;
}

function collectFramePixels(data: Buffer, cols: number, rows: number, channels: number, skipSharedTrim: boolean): {
  kept: number;
  color: number;
  rainbow: boolean;
} {
  const buckets = new Map<number, { r: number; g: number; b: number; w: number }>();
  const hues = new Array<number>(12).fill(0);
  let kept = 0;
  let vivid = 0;
  let vividColor = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = (y * cols + x) * channels;
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      const a = channels > 3 ? (data[i + 3] ?? 255) : 255;
      if (a < 100) continue;
      const { h, s, v } = hsvOf(r, g, b);
      if (v < 0.18 || s < 0.35) continue;
      if (skipSharedTrim && h >= 25 && h <= 58) continue;
      kept++;
      hues[Math.floor(h / 30) % 12]!++;
      const strength = s * v;
      if (strength > vivid) {
        vivid = strength;
        vividColor = (r << 16) | (g << 8) | b;
      }
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const weight = s * (0.4 + v);
      const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, w: 0 };
      bucket.r += r * weight;
      bucket.g += g * weight;
      bucket.b += b * weight;
      bucket.w += weight;
      buckets.set(key, bucket);
    }
  }
  let best: { r: number; g: number; b: number; w: number } | null = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.w > best.w) best = bucket;
  }
  const averaged = best && best.w > 0
    ? (Math.round(best.r / best.w) << 16) | (Math.round(best.g / best.w) << 8) | Math.round(best.b / best.w)
    : vividColor;
  const spread = hues.filter(n => n > kept * 0.08).length;
  const rainbow = spread >= 5;
  return { kept, color: rainbow ? vividColor : averaged, rainbow };
}

function finishFrameScore(scored: { color: number; rainbow: boolean; kept: number }): { color: number; rainbow: boolean } {
  return { color: scored.color, rainbow: scored.rainbow };
}

function mixChannels(a: number, b: number, t: number): number {
  const channel = (shift: number) => Math.round((((a >> shift) & 255) * (1 - t)) + (((b >> shift) & 255) * t));
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

function rainbowAt(t: number): number {
  const scaled = Math.max(0, Math.min(0.9999, t)) * (RAINBOW.length - 1);
  const i = Math.floor(scaled);
  const from = parseHexColor(RAINBOW[i]!) ?? 0xff4d4d;
  const to = parseHexColor(RAINBOW[Math.min(RAINBOW.length - 1, i + 1)]!) ?? from;
  return mixChannels(from, to, scaled - i);
}

/** Paint a rainbow or a two-colour frame into a picture, then sample it like any other image. */
export async function samplePaintedFrame(kind: "rainbow" | "swatch", a: number, b: number): Promise<number | null> {
  const key = kind === "rainbow" ? "paint:rainbow" : `paint:${hexOf(a)}:${hexOf(b)}`;
  const cached = sampleCache.get(key);
  if (cached !== undefined) return cached;
  const width = 24;
  const height = 24;
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = (x + y) / (width + height - 2);
      const color = kind === "rainbow" ? rainbowAt(t) : mixChannels(a, b, t);
      const i = (y * width + x) * 3;
      data[i] = (color >> 16) & 255;
      data[i + 1] = (color >> 8) & 255;
      data[i + 2] = color & 255;
    }
  }
  const png = await sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
  return sampleFrameBuffer(key, png);
}

export async function resolveFrameAccent(opts: {
  mode: FrameColorMode;
  artUrl?: string | null;
  rarityEmoji?: string | null;
  rarityColor?: number | null;
  colorA?: number | null;
  colorB?: number | null;
  /** Which custom colour this card wears when only one of the two is set. */
  slot?: "a" | "b";
  /** Ornate frame currently assigned to this rarity, when frames are on. */
  frameImage?: FrameImageColor | null;
  frameBuffer?: Buffer | null;
}): Promise<FrameAccent> {
  if (opts.mode === "rainbow") {
    const sampled = await samplePaintedFrame("rainbow", 0, 0);
    return { color: sampled ?? opts.rarityColor ?? 0xff4fd8, paint: "rainbow", ownsColor: true };
  }
  if (opts.mode === "custom") {
    const a = opts.colorA ?? null;
    const b = opts.colorB ?? null;
    if (a != null && b != null) {
      const sampled = await samplePaintedFrame("swatch", a, b);
      return { color: sampled ?? (opts.slot === "b" ? b : a), paint: "blend", blendA: a, blendB: b, ownsColor: true };
    }
    const one = a ?? b;
    if (one != null) {
      const sampled = await samplePaintedFrame("swatch", one, one);
      return { color: sampled ?? one, paint: "solid", ownsColor: true };
    }
  }
  if (opts.mode === "emoji") {
    const fromEmoji = await colorFromEmoji(opts.rarityEmoji);
    if (fromEmoji != null) return { color: fromEmoji, paint: "solid", ownsColor: true };
  }
  if (opts.frameImage && opts.frameBuffer) {
    const sampled = await sampleFrameImage(`png:${opts.frameImage}`, opts.frameBuffer);
    if (sampled) {
      return {
        color: sampled.color,
        paint: sampled.rainbow ? "rainbow" : "solid",
        ownsColor: true,
      };
    }
  }
  const fromArt = await extractArtColor(opts.artUrl);
  if (fromArt != null) return { color: fromArt, paint: "solid", ownsColor: false };
  return { color: opts.rarityColor ?? null, paint: "solid", ownsColor: false };
}
