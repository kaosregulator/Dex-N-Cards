// Card frames.
//
// "classic" is the original plain border: a thin rounded stroke in the rarity
// color, with the picture running to the edge. The other four are 9-slice
// metal frames. Their corners, gems, and rivets are sized from the border
// itself and stay on the rails, so they never sit on the artwork. Only the
// metal between those ornaments stretches.

import type { Rarity } from "../cards-data.js";
import { hexToRgba, type Ctx } from "../animations/engine.js";

/** Styles an admin can pick. Classic is what Default restores. */
export const FRAME_STYLES = ["crest", "laurel", "aegis", "relic"] as const;
const ALL_FRAME_STYLES = ["classic", ...FRAME_STYLES] as const;
export type FrameStyle = (typeof ALL_FRAME_STYLES)[number];

export const FRAME_STYLE_META: Record<FrameStyle, { label: string; emoji: string; blurb: string }> = {
  classic: { label: "Classic", emoji: "▫️", blurb: "The original thin border" },
  crest: { label: "Bulwark", emoji: "🔷", blurb: "Stone plate, corner gems, a glow channel" },
  laurel: { label: "Lancer", emoji: "⚔️", blurb: "Cut corners and a single keystone" },
  aegis: { label: "Crown", emoji: "👑", blurb: "A crown sitting in the top rail" },
  relic: { label: "Vault", emoji: "🧱", blurb: "Double band with rivets along the rails" },
};

/** Default is the original plain border for every rarity. */
export const DEFAULT_FRAME_STYLE: Record<Rarity, FrameStyle> = {
  common: "classic",
  uncommon: "classic",
  rare: "classic",
  epic: "classic",
  legendary: "classic",
  mythic: "classic",
};

/** Uniform inset for the ornate frames, so the art window matches the card. */
export const FRAME_WINDOW = 0.09;

export function isFrameStyle(value: string | null | undefined): value is FrameStyle {
  return !!value && (ALL_FRAME_STYLES as readonly string[]).includes(value);
}

export function defaultFrameStyle(_rarity: Rarity | string | null | undefined): FrameStyle {
  return "classic";
}

export function styleArtWindow(
  x: number, y: number, w: number, h: number,
): { x: number; y: number; w: number; h: number } {
  const t = FRAME_WINDOW;
  return { x: x + w * t, y: y + h * t, w: w * (1 - 2 * t), h: h * (1 - 2 * t) };
}

/** Classic keeps the full picture. Ornate frames inset into the metal band. */
export function artWindowFor(
  style: FrameStyle | null | undefined,
  x: number, y: number, w: number, h: number,
): { x: number; y: number; w: number; h: number } {
  if (!style || style === "classic") return { x, y, w, h };
  return styleArtWindow(x, y, w, h);
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
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (frame.style === "classic") drawClassic(ctx, x, y, w, h, frame);
  else if (frame.style === "laurel") drawLancer(ctx, x, y, w, h, frame);
  else if (frame.style === "aegis") drawCrown(ctx, x, y, w, h, frame);
  else if (frame.style === "relic") drawVault(ctx, x, y, w, h, frame);
  else drawBulwark(ctx, x, y, w, h, frame);
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
  return hexToRgba(color, 1);
}

function lighten(n: number, t: number): string {
  const ch = (shift: number) => Math.round(((n >> shift) & 255) + (255 - ((n >> shift) & 255)) * t);
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
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

function traceChamfer(ctx: Ctx, x: number, y: number, w: number, h: number, cut: number): void {
  const c = Math.max(3, Math.min(cut, w / 3, h / 3));
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

function fillRing(
  ctx: Ctx, x: number, y: number, w: number, h: number,
  radius: number, style: Paint, chamfer = false,
): void {
  const ix = x + w * FRAME_WINDOW;
  const iy = y + h * FRAME_WINDOW;
  const iw = w * (1 - 2 * FRAME_WINDOW);
  const ih = h * (1 - 2 * FRAME_WINDOW);
  ctx.beginPath();
  if (chamfer) {
    traceChamfer(ctx, x, y, w, h, radius);
    traceChamfer(ctx, ix, iy, iw, ih, radius * 0.55);
  } else {
    traceRound(ctx, x, y, w, h, radius, 1);
    traceRound(ctx, ix, iy, iw, ih, Math.max(2, radius * 0.45), -1);
  }
  ctx.fillStyle = style as string;
  (ctx as { fill(rule?: string): void }).fill("evenodd");
}

function metal(ctx: Ctx, x: number, y: number, h: number): Paint {
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, "#8d7b62");
  g.addColorStop(0.18, "#3c342b");
  g.addColorStop(0.5, "#241e18");
  g.addColorStop(0.82, "#4a3f34");
  g.addColorStop(1, "#16130f");
  return g;
}

function bands(w: number, h: number): { sx: number; sy: number } {
  return { sx: w * FRAME_WINDOW, sy: h * FRAME_WINDOW };
}

function glowStroke(
  ctx: Ctx, x: number, y: number, w: number, h: number,
  color: Paint, chamfer: boolean, cut: number,
): void {
  const { sx, sy } = bands(w, h);
  const glow = Math.max(2.2, Math.min(sx, sy) * 0.28);
  const gx = x + sx - glow / 2;
  const gy = y + sy - glow / 2;
  const gw = w - sx * 2 + glow;
  const gh = h - sy * 2 + glow;
  ctx.beginPath();
  if (chamfer) traceChamfer(ctx, gx, gy, gw, gh, Math.max(3, cut * 0.55));
  else traceRound(ctx, gx, gy, gw, gh, Math.max(3, cut * 0.4), 1);
  ctx.strokeStyle = color as string;
  ctx.lineWidth = glow;
  ctx.stroke();
  ctx.lineWidth = Math.max(1, glow * 0.28);
  ctx.strokeStyle = "rgba(255,255,255,0.8)";
  ctx.stroke();
}

function strokeOuter(ctx: Ctx, x: number, y: number, w: number, h: number, radius: number, chamfer: boolean): void {
  ctx.beginPath();
  if (chamfer) traceChamfer(ctx, x + 1, y + 1, w - 2, h - 2, radius);
  else traceRound(ctx, x + 1, y + 1, w - 2, h - 2, radius, 1);
  ctx.strokeStyle = "rgba(255,236,210,0.45)";
  ctx.lineWidth = 1.6;
  ctx.stroke();
  const inner = styleArtWindow(x, y, w, h);
  ctx.beginPath();
  if (chamfer) traceChamfer(ctx, inner.x, inner.y, inner.w, inner.h, radius * 0.45);
  else traceRound(ctx, inner.x, inner.y, inner.w, inner.h, Math.max(2, radius * 0.35), 1);
  ctx.strokeStyle = "rgba(0,0,0,0.72)";
  ctx.lineWidth = 2;
  ctx.stroke();
}

function diamond(ctx: Ctx, cx: number, cy: number, rx: number, ry: number, fill: Paint): void {
  ctx.beginPath();
  ctx.moveTo(cx, cy - ry);
  ctx.lineTo(cx + rx, cy);
  ctx.lineTo(cx, cy + ry);
  ctx.lineTo(cx - rx, cy);
  ctx.closePath();
  ctx.fillStyle = fill as string;
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = Math.max(1, Math.min(rx, ry) * 0.18);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, cy - ry * 0.55);
  ctx.lineTo(cx, cy + ry * 0.15);
  ctx.strokeStyle = "rgba(255,255,255,0.7)";
  ctx.lineWidth = Math.max(0.8, Math.min(rx, ry) * 0.12);
  ctx.stroke();
}

function cornerGems(ctx: Ctx, x: number, y: number, w: number, h: number, fill: Paint): void {
  const { sx, sy } = bands(w, h);
  const rx = sx * 0.34;
  const ry = sy * 0.34;
  for (const [cx, cy] of [
    [x + sx * 0.5, y + sy * 0.5],
    [x + w - sx * 0.5, y + sy * 0.5],
    [x + sx * 0.5, y + h - sy * 0.5],
    [x + w - sx * 0.5, y + h - sy * 0.5],
  ] as const) {
    diamond(ctx, cx, cy, rx, ry, fill);
  }
}

function edgeGems(ctx: Ctx, x: number, y: number, w: number, h: number, fill: Paint, which: "all" | "top"): void {
  const { sx, sy } = bands(w, h);
  diamond(ctx, x + w / 2, y + sy * 0.5, sx * 0.28, sy * 0.36, fill);
  if (which === "top") return;
  diamond(ctx, x + w / 2, y + h - sy * 0.5, sx * 0.28, sy * 0.36, fill);
  diamond(ctx, x + sx * 0.5, y + h / 2, sx * 0.36, sy * 0.22, fill);
  diamond(ctx, x + w - sx * 0.5, y + h / 2, sx * 0.36, sy * 0.22, fill);
}

function drawClassic(ctx: Ctx, x: number, y: number, w: number, h: number, frame: FrameDraw): void {
  const paint = frame.paint ?? "solid";
  const stroke = paint === "rainbow"
    ? paintOf(ctx, x, y, w, h, frame.color, "rainbow")
    : paint === "blend" && frame.blendA != null
      ? hexToRgba(frame.blendA, 1)
      : hexToRgba(frame.color, 1);
  const radius = Math.max(8, Math.min(18, Math.min(w, h) * 0.06));
  const thick = Math.max(4, Math.min(8, Math.min(w, h) * 0.025));
  ctx.beginPath();
  traceRound(ctx, x + thick / 2, y + thick / 2, w - thick, h - thick, radius, 1);
  ctx.strokeStyle = stroke as string;
  ctx.lineWidth = thick;
  ctx.stroke();
  ctx.beginPath();
  traceRound(ctx, x + thick + 1, y + thick + 1, w - (thick + 1) * 2, h - (thick + 1) * 2, Math.max(4, radius - 4), 1);
  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawBulwark(ctx: Ctx, x: number, y: number, w: number, h: number, frame: FrameDraw): void {
  const radius = Math.max(6, Math.min(bands(w, h).sx, bands(w, h).sy) * 0.35);
  const color = paintOf(ctx, x, y, w, h, frame.color, frame.paint ?? "solid", frame.blendA, frame.blendB);
  fillRing(ctx, x, y, w, h, radius, metal(ctx, x, y, h));
  strokeOuter(ctx, x, y, w, h, radius, false);
  glowStroke(ctx, x, y, w, h, color, false, radius);
  cornerGems(ctx, x, y, w, h, color);
  edgeGems(ctx, x, y, w, h, color, "all");
}

function drawLancer(ctx: Ctx, x: number, y: number, w: number, h: number, frame: FrameDraw): void {
  const { sx, sy } = bands(w, h);
  const cut = Math.max(sx, sy) * 1.35;
  const color = paintOf(ctx, x, y, w, h, frame.color, frame.paint ?? "solid", frame.blendA, frame.blendB);
  fillRing(ctx, x, y, w, h, cut, metal(ctx, x, y, h), true);
  strokeOuter(ctx, x, y, w, h, cut, true);
  glowStroke(ctx, x, y, w, h, color, true, cut);
  cornerGems(ctx, x, y, w, h, color);
  edgeGems(ctx, x, y, w, h, color, "top");
  ctx.strokeStyle = color as string;
  ctx.lineWidth = Math.max(1.4, Math.min(sx, sy) * 0.12);
  const marks = 3;
  for (let i = 0; i < marks; i++) {
    const t = (i + 1) / (marks + 1);
    chevron(ctx, x + sx * 0.5, y + h * t, sy * 0.18, 1);
    chevron(ctx, x + w - sx * 0.5, y + h * t, sy * 0.18, -1);
  }
}

function chevron(ctx: Ctx, x: number, y: number, size: number, dir: 1 | -1): void {
  ctx.beginPath();
  ctx.moveTo(x - dir * size, y - size);
  ctx.lineTo(x + dir * size * 0.2, y);
  ctx.lineTo(x - dir * size, y + size);
  ctx.stroke();
}

function drawCrown(ctx: Ctx, x: number, y: number, w: number, h: number, frame: FrameDraw): void {
  const radius = Math.max(8, Math.min(bands(w, h).sx, bands(w, h).sy) * 0.55);
  const color = paintOf(ctx, x, y, w, h, frame.color, frame.paint ?? "solid", frame.blendA, frame.blendB);
  fillRing(ctx, x, y, w, h, radius, metal(ctx, x, y, h));
  strokeOuter(ctx, x, y, w, h, radius, false);
  glowStroke(ctx, x, y, w, h, color, false, radius);
  cornerGems(ctx, x, y, w, h, color);
  const { sx, sy } = bands(w, h);
  const peak = sy * 0.72;
  const crowns = 3;
  for (let i = 0; i < crowns; i++) {
    const cx = x + w * ((i + 1) / (crowns + 1));
    ctx.beginPath();
    ctx.moveTo(cx - sx * 0.28, y + sy * 0.82);
    ctx.lineTo(cx, y + sy * 0.82 - peak);
    ctx.lineTo(cx + sx * 0.28, y + sy * 0.82);
    ctx.closePath();
    ctx.fillStyle = "#c4a574";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,236,210,0.7)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
  diamond(ctx, x + w / 2, y + sy * 0.42, sx * 0.22, sy * 0.28, color);
}

function drawVault(ctx: Ctx, x: number, y: number, w: number, h: number, frame: FrameDraw): void {
  const radius = 5;
  const color = paintOf(ctx, x, y, w, h, frame.color, frame.paint ?? "solid", frame.blendA, frame.blendB);
  fillRing(ctx, x, y, w, h, radius, metal(ctx, x, y, h));
  strokeOuter(ctx, x, y, w, h, radius, false);
  glowStroke(ctx, x, y, w, h, color, false, radius);
  const { sx, sy } = bands(w, h);
  const inset = 0.045;
  const ox = x + w * inset;
  const oy = y + h * inset;
  const ow = w * (1 - inset * 2);
  const oh = h * (1 - inset * 2);
  ctx.beginPath();
  traceRound(ctx, ox, oy, ow, oh, 4, 1);
  ctx.strokeStyle = color as string;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = Math.max(1.2, Math.min(sx, sy) * 0.1);
  ctx.stroke();
  ctx.globalAlpha = 1;
  rivets(ctx, x, y, w, h, color);
}

function rivets(ctx: Ctx, x: number, y: number, w: number, h: number, fill: Paint): void {
  const { sx, sy } = bands(w, h);
  const r = Math.max(1.4, Math.min(sx, sy) * 0.13);
  const gap = Math.max(14, Math.min(sx, sy) * 1.8);
  const place = (x0: number, x1: number, y0: number, horizontal: boolean) => {
    const len = horizontal ? x1 - x0 : y0;
    const n = Math.max(0, Math.floor((horizontal ? x1 - x0 : y0) / gap) - 1);
    if (n <= 0 || len <= 0) return;
    for (let i = 1; i <= n; i++) {
      const t = i / (n + 1);
      const cx = horizontal ? x0 + (x1 - x0) * t : x0;
      const cy = horizontal ? y0 : y + sy + (h - sy * 2) * t;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = fill as string;
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  };
  place(x + sx * 1.6, x + w - sx * 1.6, y + sy * 0.5, true);
  place(x + sx * 1.6, x + w - sx * 1.6, y + h - sy * 0.5, true);
  const sideTop = y + sy * 1.6;
  const sideBot = y + h - sy * 1.6;
  const sideN = Math.max(0, Math.floor((sideBot - sideTop) / gap) - 1);
  for (let i = 1; i <= sideN; i++) {
    const cy = sideTop + (sideBot - sideTop) * (i / (sideN + 1));
    for (const cx of [x + sx * 0.5, x + w - sx * 0.5]) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = fill as string;
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}
