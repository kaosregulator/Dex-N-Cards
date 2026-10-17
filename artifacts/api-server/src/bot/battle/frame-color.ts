// Battle frame colours.
//
// image   samples the whole card picture, vehicle included.
// emoji   samples the rarity emoji that server already uses.
// custom  blends two colours an admin scrolled to.
// rainbow paints a rainbow frame.

import { getCanvas, type Ctx } from "../animations/engine.js";
import { loadCurrencyImage } from "../unbelievaboat/currency-canvas.js";
import { dominantColorFromBuffer } from "../images/raster.js";
import { extractArtColor } from "./image/vibrant-color.js";

export const FRAME_COLOR_MODES = ["image", "emoji", "custom", "rainbow"] as const;
export type FrameColorMode = (typeof FRAME_COLOR_MODES)[number];

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
  const cardY = 36;
  const cardW = 140;
  const cardH = 196;
  round(ctx, cardX - 8, cardY - 8, cardW + 16, cardH + 16, 22);
  if (opts.mode === "rainbow") {
    ctx.strokeStyle = rainbowGradient(ctx, cardX, cardY, cardW, cardH);
  } else if (opts.mode === "custom") {
    const g = ctx.createLinearGradient(cardX, cardY, cardX + cardW, cardY + cardH);
    g.addColorStop(0, hexOf(a));
    g.addColorStop(1, hexOf(b));
    ctx.strokeStyle = g;
  } else {
    ctx.strokeStyle = "#8b95a1";
  }
  ctx.lineWidth = 10;
  ctx.stroke();

  round(ctx, cardX, cardY, cardW, cardH, 16);
  ctx.fillStyle = "#111214";
  ctx.fill();
  ctx.fillStyle = "#f2f3f5";
  ctx.font = "700 13px DNSans, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(frameColorModeLabel(opts.mode), cardX + cardW / 2, cardY + 28);
  ctx.font = "500 11px DNSans, sans-serif";
  ctx.fillStyle = "#b5bac1";
  const caption = opts.mode === "image"
    ? "Samples the whole picture"
    : opts.mode === "emoji"
      ? "Samples the rarity emoji"
      : opts.mode === "rainbow"
        ? "Rainbow frame"
        : "Two colors, one frame";
  ctx.fillText(caption, cardX + cardW / 2, cardY + cardH - 24);

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
  artUrl?: string | null;
  rarityColor?: number | null;
  accentEmoji?: string | null;
  frameMode?: FrameColorMode;
  frameColorA?: number | null;
  frameColorB?: number | null;
  frameSlot?: "a" | "b";
  framePaint?: "solid" | "rainbow" | "blend";
  blendA?: number;
  blendB?: number;
}>(card: T): Promise<T> {
  if (!card.frameMode) return card;
  const accent = await resolveFrameAccent({
    mode: card.frameMode,
    artUrl: card.artUrl,
    rarityEmoji: card.accentEmoji,
    rarityColor: card.rarityColor,
    colorA: card.frameColorA,
    colorB: card.frameColorB,
    slot: card.frameSlot,
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
}): Promise<FrameAccent> {
  if (opts.mode === "rainbow") return { color: opts.rarityColor ?? 0xff4fd8, paint: "rainbow" };
  if (opts.mode === "custom") {
    const a = opts.colorA ?? null;
    const b = opts.colorB ?? null;
    if (a != null && b != null) return { color: opts.slot === "b" ? b : a, paint: "blend", blendA: a, blendB: b };
    const one = a ?? b;
    if (one != null) return { color: one, paint: "solid" };
  }
  if (opts.mode === "emoji") {
    const fromEmoji = await colorFromEmoji(opts.rarityEmoji);
    if (fromEmoji != null) return { color: fromEmoji, paint: "solid" };
  }
  const fromArt = await extractArtColor(opts.artUrl);
  if (fromArt != null) return { color: fromArt, paint: "solid" };
  return { color: opts.rarityColor ?? null, paint: "solid" };
}
