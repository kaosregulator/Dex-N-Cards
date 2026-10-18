// Nine-slice card frames.
//
// The border is a band whose thickness is a percent of the card, so the art
// window keeps the card's own aspect and larger pictures are not cropped by an
// uneven window. Corners, rivets, leaves, and emblems are drawn at a size
// taken from the short side. Only the rails between those ornaments stretch.

import type { Rarity } from "../cards-data.js";
import { hexToRgba, type Ctx } from "../animations/engine.js";

export const FRAME_STYLES = ["crest", "laurel", "aegis", "relic"] as const;
export type FrameStyle = (typeof FRAME_STYLES)[number];

export const FRAME_STYLE_META: Record<FrameStyle, { label: string; emoji: string; blurb: string }> = {
  crest: { label: "Crest", emoji: "🛡️", blurb: "Riveted plate with a shield" },
  laurel: { label: "Laurel", emoji: "🌿", blurb: "Slim rails and side leaves" },
  aegis: { label: "Aegis", emoji: "🏅", blurb: "Chamfered armor and a medal" },
  relic: { label: "Relic", emoji: "💠", blurb: "Stepped rails, scrolls, and a gem" },
};

/** Built-in style for each rarity. Default restores this. */
export const DEFAULT_FRAME_STYLE: Record<Rarity, FrameStyle> = {
  common: "crest",
  uncommon: "laurel",
  rare: "aegis",
  epic: "relic",
  legendary: "aegis",
  mythic: "relic",
};

/** Uniform inset so the art window matches the card's aspect. */
export const FRAME_WINDOW = 0.072;

export function isFrameStyle(value: string | null | undefined): value is FrameStyle {
  return !!value && (FRAME_STYLES as readonly string[]).includes(value);
}

export function defaultFrameStyle(rarity: Rarity | string | null | undefined): FrameStyle {
  if (rarity && rarity in DEFAULT_FRAME_STYLE) return DEFAULT_FRAME_STYLE[rarity as Rarity];
  return "crest";
}

export function styleArtWindow(
  x: number, y: number, w: number, h: number,
): { x: number; y: number; w: number; h: number } {
  const t = FRAME_WINDOW;
  return { x: x + w * t, y: y + h * t, w: w * (1 - 2 * t), h: h * (1 - 2 * t) };
}

export interface FrameDraw {
  style: FrameStyle;
  color: number;
  paint?: "solid" | "rainbow" | "blend";
  blendA?: number;
  blendB?: number;
}

type Paint = string | ReturnType<Ctx["createLinearGradient"]>;

const RAINBOW = ["#ff4d4d", "#ff9f1a", "#ffe14d", "#3ddc6a", "#3dc6ff", "#7a5cff", "#ff4fd8"];

export function drawStyledFrame(
  ctx: Ctx, x: number, y: number, w: number, h: number, frame: FrameDraw,
): void {
  if (w < 8 || h < 8) return;
  const paint = frame.paint ?? "solid";
  const stroke = paintOf(ctx, x, y, w, h, frame.color, paint, frame.blendA, frame.blendB);
  const hi = lighten(frame.color, 0.55);
  const ink = "rgba(8,10,16,0.55)";
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (frame.style === "laurel") drawLaurel(ctx, x, y, w, h, stroke, hi, ink);
  else if (frame.style === "aegis") drawAegis(ctx, x, y, w, h, stroke, hi, ink);
  else if (frame.style === "relic") drawRelic(ctx, x, y, w, h, stroke, hi, ink);
  else drawCrest(ctx, x, y, w, h, stroke, hi, ink);
  ctx.restore();
}

function paintOf(
  ctx: Ctx, x: number, y: number, w: number, h: number,
  color: number, paint: "solid" | "rainbow" | "blend", blendA?: number, blendB?: number,
): Paint {
  if (paint === "rainbow") {
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    RAINBOW.forEach((hex, i) => g.addColorStop(i / (RAINBOW.length - 1), hex));
    return g;
  }
  if (paint === "blend" && blendA != null && blendB != null) {
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, hexToRgba(blendA, 1));
    g.addColorStop(1, hexToRgba(blendB, 1));
    return g;
  }
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, lighten(color, 0.28));
  g.addColorStop(0.45, hexToRgba(color, 1));
  g.addColorStop(1, shade(color, 0.28));
  return g;
}

function lighten(n: number, t: number): string {
  const ch = (shift: number) => {
    const c = (n >> shift) & 255;
    return Math.round(c + (255 - c) * t);
  };
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}

function shade(n: number, t: number): string {
  const ch = (shift: number) => Math.round(((n >> shift) & 255) * (1 - t));
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}

function fillRing(
  ctx: Ctx, x: number, y: number, w: number, h: number,
  radius: number, style: Paint,
): void {
  const ix = x + w * FRAME_WINDOW;
  const iy = y + h * FRAME_WINDOW;
  const iw = w * (1 - 2 * FRAME_WINDOW);
  const ih = h * (1 - 2 * FRAME_WINDOW);
  const ir = Math.max(2, radius * 0.55);
  ctx.beginPath();
  traceRound(ctx, x, y, w, h, radius, 1);
  traceRound(ctx, ix, iy, iw, ih, ir, -1);
  ctx.fillStyle = style as string;
  (ctx as { fill(rule?: string): void }).fill("evenodd");
}

function traceRound(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, dir: 1 | -1): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  if (dir === 1) {
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
  } else {
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x, y, x, y + h, radius);
    ctx.arcTo(x, y + h, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x + w, y, radius);
    ctx.arcTo(x + w, y, x, y, radius);
  }
  ctx.closePath();
}

function strokeRound(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, style: string, width: number): void {
  ctx.beginPath();
  traceRound(ctx, x, y, w, h, r, 1);
  ctx.strokeStyle = style;
  ctx.lineWidth = width;
  ctx.stroke();
}

function plate(w: number, h: number): number {
  return Math.max(11, Math.min(34, Math.round(Math.min(w, h) * 0.15)));
}

function drawCrest(
  ctx: Ctx, x: number, y: number, w: number, h: number, stroke: Paint, hi: string, ink: string,
): void {
  const p = plate(w, h);
  fillRing(ctx, x, y, w, h, p * 0.55, stroke);
  strokeRound(ctx, x + 1.5, y + 1.5, w - 3, h - 3, p * 0.5, ink, 2);
  const inner = styleArtWindow(x, y, w, h);
  strokeRound(ctx, inner.x, inner.y, inner.w, inner.h, p * 0.28, "rgba(255,255,255,0.45)", 1.4);
  const rivet = Math.max(2.4, p * 0.16);
  for (const [cx, cy] of cornerPoints(x, y, w, h, p * 0.42)) {
    ctx.beginPath();
    ctx.arc(cx, cy, rivet, 0, Math.PI * 2);
    ctx.fillStyle = hi;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = ink;
    ctx.stroke();
  }
  shield(ctx, x + w / 2, y + 1, p * 1.35, stroke, hi);
}

function cornerPoints(x: number, y: number, w: number, h: number, inset: number): Array<[number, number]> {
  return [
    [x + inset, y + inset],
    [x + w - inset, y + inset],
    [x + inset, y + h - inset],
    [x + w - inset, y + h - inset],
  ];
}

function shield(ctx: Ctx, cx: number, top: number, size: number, fill: Paint, hi: string): void {
  const sw = size * 1.35;
  const sh = size * 1.55;
  ctx.beginPath();
  ctx.moveTo(cx, top + sh);
  ctx.lineTo(cx - sw / 2, top + sh * 0.62);
  ctx.lineTo(cx - sw / 2, top + sh * 0.22);
  ctx.quadraticCurveTo(cx - sw / 2, top, cx, top + sh * 0.16);
  ctx.quadraticCurveTo(cx + sw / 2, top, cx + sw / 2, top + sh * 0.22);
  ctx.lineTo(cx + sw / 2, top + sh * 0.62);
  ctx.closePath();
  ctx.fillStyle = fill as string;
  ctx.fill();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = hi;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - sw * 0.18, top + sh * 0.48);
  ctx.lineTo(cx, top + sh * 0.34);
  ctx.lineTo(cx + sw * 0.18, top + sh * 0.48);
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = Math.max(1.3, size * 0.08);
  ctx.stroke();
}

function drawLaurel(
  ctx: Ctx, x: number, y: number, w: number, h: number, stroke: Paint, hi: string, ink: string,
): void {
  const p = plate(w, h);
  fillRing(ctx, x, y, w, h, p * 0.42, stroke);
  strokeRound(ctx, x + 1.5, y + 1.5, w - 3, h - 3, p * 0.38, ink, 1.6);
  const inner = styleArtWindow(x, y, w, h);
  strokeRound(ctx, inner.x, inner.y, inner.w, inner.h, p * 0.2, hi, 1.2);
  const leaves = 4;
  const size = Math.max(7, p * 0.42);
  for (let i = 0; i < leaves; i++) {
    const t = (i + 1) / (leaves + 1);
    leaf(ctx, x + w * FRAME_WINDOW * 0.55, y + h * t, size, -0.85, stroke, hi);
    leaf(ctx, x + w - w * FRAME_WINDOW * 0.55, y + h * t, size, 0.85, stroke, hi);
  }
  diamond(ctx, x + w / 2, y + p * 0.15, p * 0.62, stroke, hi);
}

function leaf(ctx: Ctx, x: number, y: number, size: number, rot: number, fill: Paint, hi: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.beginPath();
  ctx.ellipse(0, 0, size * 0.38, size, 0, 0, Math.PI * 2);
  ctx.fillStyle = fill as string;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, -size * 0.75);
  ctx.lineTo(0, size * 0.75);
  ctx.strokeStyle = hi;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function diamond(ctx: Ctx, cx: number, cy: number, r: number, fill: Paint, hi: string): void {
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r * 0.72, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r * 0.72, cy);
  ctx.closePath();
  ctx.fillStyle = fill as string;
  ctx.fill();
  ctx.strokeStyle = hi;
  ctx.lineWidth = 1.4;
  ctx.stroke();
}

function traceChamfer(ctx: Ctx, x: number, y: number, w: number, h: number, cut: number): void {
  const c = Math.max(4, Math.min(cut, w / 3, h / 3));
  ctx.moveTo(x + c, y);
  ctx.lineTo(x + w - c, y);
  ctx.lineTo(x + w, y + c);
  ctx.lineTo(x + w, y + h - c);
  ctx.lineTo(x + w - c, y + h);
  ctx.lineTo(x + c, y + h);
  ctx.lineTo(x, y + h - c);
  ctx.lineTo(x, y + c);
  ctx.closePath();
}

function chamferPath(ctx: Ctx, x: number, y: number, w: number, h: number, cut: number): void {
  ctx.beginPath();
  traceChamfer(ctx, x, y, w, h, cut);
}

function fillChamferRing(ctx: Ctx, x: number, y: number, w: number, h: number, cut: number, style: Paint): void {
  const ix = x + w * FRAME_WINDOW;
  const iy = y + h * FRAME_WINDOW;
  const iw = w * (1 - 2 * FRAME_WINDOW);
  const ih = h * (1 - 2 * FRAME_WINDOW);
  ctx.beginPath();
  traceChamfer(ctx, x, y, w, h, cut);
  traceChamfer(ctx, ix, iy, iw, ih, cut * 0.62);
  ctx.fillStyle = style as string;
  (ctx as { fill(rule?: string): void }).fill("evenodd");
}

function drawAegis(
  ctx: Ctx, x: number, y: number, w: number, h: number, stroke: Paint, hi: string, ink: string,
): void {
  const p = plate(w, h);
  const cut = p * 0.85;
  fillChamferRing(ctx, x, y, w, h, cut, stroke);
  chamferPath(ctx, x + 1.5, y + 1.5, w - 3, h - 3, cut);
  ctx.strokeStyle = ink;
  ctx.lineWidth = 2;
  ctx.stroke();
  const inner = styleArtWindow(x, y, w, h);
  chamferPath(ctx, inner.x, inner.y, inner.w, inner.h, cut * 0.55);
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.lineWidth = 1.3;
  ctx.stroke();
  const len = p * 0.55;
  bracket(ctx, x + p * 0.28, y + p * 0.28, len, 1, 1, hi);
  bracket(ctx, x + w - p * 0.28, y + p * 0.28, len, -1, 1, hi);
  bracket(ctx, x + p * 0.28, y + h - p * 0.28, len, 1, -1, hi);
  bracket(ctx, x + w - p * 0.28, y + h - p * 0.28, len, -1, -1, hi);
  medal(ctx, x + w / 2, y + 2, p * 0.62, stroke, hi);
}

function bracket(ctx: Ctx, x: number, y: number, len: number, sx: number, sy: number, color: string): void {
  ctx.beginPath();
  ctx.moveTo(x, y + sy * len);
  ctx.lineTo(x, y);
  ctx.lineTo(x + sx * len, y);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.4;
  ctx.stroke();
}

function medal(ctx: Ctx, cx: number, top: number, r: number, fill: Paint, hi: string): void {
  const cy = top + r;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = fill as string;
  ctx.fill();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = hi;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.46, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, cy - r * 0.22);
  ctx.lineTo(cx + r * 0.16, cy + r * 0.18);
  ctx.lineTo(cx - r * 0.16, cy + r * 0.18);
  ctx.closePath();
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.fill();
}

function drawRelic(
  ctx: Ctx, x: number, y: number, w: number, h: number, stroke: Paint, hi: string, ink: string,
): void {
  const p = plate(w, h);
  fillRing(ctx, x, y, w, h, 8, stroke);
  strokeRound(ctx, x + 1.5, y + 1.5, w - 3, h - 3, 7, ink, 2);
  const inner = styleArtWindow(x, y, w, h);
  strokeRound(ctx, inner.x, inner.y, inner.w, inner.h, 5, hi, 1.3);
  const curl = p * 0.72;
  cornerScroll(ctx, x + curl * 0.15, y + curl * 0.15, curl, 0, hi);
  cornerScroll(ctx, x + w - curl * 0.15, y + curl * 0.15, curl, Math.PI / 2, hi);
  cornerScroll(ctx, x + w - curl * 0.15, y + h - curl * 0.15, curl, Math.PI, hi);
  cornerScroll(ctx, x + curl * 0.15, y + h - curl * 0.15, curl, -Math.PI / 2, hi);
  gem(ctx, x + w / 2, y + 2, p * 0.55, stroke, hi);
  ctx.strokeStyle = hi;
  ctx.lineWidth = 1.6;
  const ticks = Math.max(3, Math.min(7, Math.round(w / 70)));
  for (let i = 0; i < ticks; i++) {
    const tx = x + w * ((i + 1) / (ticks + 1));
    ctx.beginPath();
    ctx.moveTo(tx, y + h - h * FRAME_WINDOW * 0.28);
    ctx.lineTo(tx, y + h - h * FRAME_WINDOW * 0.72);
    ctx.stroke();
  }
}

function gem(ctx: Ctx, cx: number, top: number, r: number, fill: Paint, hi: string): void {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 3;
    const px = cx + Math.cos(a) * r;
    const py = top + r + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = fill as string;
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 1.3;
  ctx.stroke();
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 3;
    const px = cx + Math.cos(a) * r * 0.45;
    const py = top + r + Math.sin(a) * r * 0.45;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.strokeStyle = hi;
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

function cornerScroll(ctx: Ctx, x: number, y: number, size: number, rot: number, color: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.beginPath();
  ctx.arc(size * 0.42, size * 0.42, size * 0.34, Math.PI, Math.PI * 1.72);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.8, size * 0.14);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(size * 0.42, size * 0.42, size * 0.16, Math.PI * 0.2, Math.PI * 1.35);
  ctx.lineWidth = Math.max(1.2, size * 0.08);
  ctx.stroke();
  ctx.restore();
}
