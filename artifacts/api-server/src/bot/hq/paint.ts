// ─────────────────────────────────────────────────────────────────────────────
// HQ — shared canvas primitives.
//
// The low-level drawing helpers every HQ renderer needs: the under-declared
// Skia methods (ellipse / drawImage source-rect), isometric polygon helpers, a
// deterministic RNG so a scene's scatter is stable between renders, and the
// header band that brands every HQ image.
//
// render.ts (rooms + bases), render-world.ts (the world map) and cinematic.ts
// (the siege intro) all draw through this module so they stay visually
// consistent. Nothing here touches the DB or the asset manifest beyond the
// sprite loader it is handed.
// ─────────────────────────────────────────────────────────────────────────────

import { hexToRgba, roundRectPath, type Ctx, type CanvasMod } from "../animations/engine.js";
import { loadArt, drawTextWithShadow, drawTitle, fitText, TITLE_FONT } from "../animations/effects.js";
import type { HqTheme } from "./defs/themes.js";

export interface Pt { x: number; y: number }

// `ellipse` exists on the Skia 2D context at runtime but is under-declared on
// the project's Ctx type (same story as drawImage's source-rect overload).
type EllipseCtx = { ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number): void };
export function ellipse(ctx: Ctx, x: number, y: number, rx: number, ry: number, rot = 0): void {
  (ctx as unknown as EllipseCtx).ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
}

type DrawImg = { drawImage(i: unknown, x: number, y: number, w: number, h: number): void };
export function blit(ctx: Ctx, img: unknown, x: number, y: number, w: number, h: number): void {
  (ctx as unknown as DrawImg).drawImage(img, x, y, w, h);
}

export function imgSize(img: unknown): { w: number; h: number } {
  return {
    w: Math.max(1, (img as { width: number }).width),
    h: Math.max(1, (img as { height: number }).height),
  };
}

export function lerpPt(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function diamond(cx: number, cy: number, hw: number, hh: number): Pt[] {
  return [{ x: cx, y: cy - hh }, { x: cx + hw, y: cy }, { x: cx, y: cy + hh }, { x: cx - hw, y: cy }];
}

export function polyPath(ctx: Ctx, pts: Pt[]): void {
  if (pts.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
  ctx.closePath();
}

// Deterministic RNG (mulberry32) so a base's scenery / a world's scatter is
// identical between renders instead of shimmering on every re-draw.
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Keeps emoji in canvas labels. The shared font hook draws unicode emoji, and
// the text painter draws Discord custom emoji once their images are warmed.
export function stripEmoji(s: string): string {
  return s.replace(/\s{2,}/g, " ").trim();
}

export function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Blit an image to fill a quad by clipping to it and drawing to its bounding
// box — good enough for a seamless wall/floor texture.
export function blitClippedQuad(ctx: Ctx, img: unknown, p: Pt[]): void {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const q of p) {
    minX = Math.min(minX, q.x); minY = Math.min(minY, q.y);
    maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y);
  }
  ctx.save();
  polyPath(ctx, p);
  ctx.clip();
  blit(ctx, img, minX, minY, maxX - minX, maxY - minY);
  ctx.restore();
}

// ── Header band ───────────────────────────────────────────────────────────────
// The fields the shared header needs — satisfied structurally by the room view,
// the base view, the world map and the cinematic, so one painter serves them all.
export interface HqHeaderInfo {
  ownerAvatarUrl: string | null;
  displayTitle: string;
  subtitle: string;
  theme: HqTheme;
  roomEmoji: string;
  roomName: string;
  hqLevel: number;
}

export const HQ_HEADER_H = 66;

export async function drawHqHeader(
  ctx: Ctx, mod: CanvasMod, view: HqHeaderInfo, width: number, headerH = HQ_HEADER_H,
): Promise<void> {
  ctx.save();
  const g = ctx.createLinearGradient(0, 0, width, 0);
  g.addColorStop(0, "rgba(0,0,0,0.62)");
  g.addColorStop(1, "rgba(0,0,0,0.32)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, headerH);
  ctx.fillStyle = hexToRgba(view.theme.palette.accent, 0.8);
  ctx.fillRect(0, headerH, width, 2);
  ctx.restore();

  const av = 46, ax = 18, ay = (headerH - av) / 2;
  if (view.ownerAvatarUrl) {
    const img = await loadArt(mod, view.ownerAvatarUrl).catch(() => null);
    if (img) {
      ctx.save();
      ctx.beginPath(); ctx.arc(ax + av / 2, ay + av / 2, av / 2, 0, Math.PI * 2); ctx.clip();
      const { w: iw, h: ih } = imgSize(img);
      const sc = Math.max(av / iw, av / ih);
      blit(ctx, img, ax + (av - iw * sc) / 2, ay + (av - ih * sc) / 2, iw * sc, ih * sc);
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = hexToRgba(view.theme.palette.accent, 1); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(ax + av / 2, ay + av / 2, av / 2, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  }

  ctx.save();
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  const tx = ax + av + 14;
  // Left-align the banner name (drawTitle centres by default) so a long/custom
  // HQ name grows rightward instead of clipping the edge.
  const title = stripEmoji(view.displayTitle);
  drawTitle(ctx, title, tx, 24, "#ffffff", fitText(ctx, title, width - tx - 260, 22, 14, TITLE_FONT), "left");
  drawTextWithShadow(ctx, stripEmoji(view.subtitle), tx, 46, "rgba(225,225,230,0.85)", 13, "left");
  ctx.restore();

  ctx.save();
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  drawTextWithShadow(ctx, stripEmoji(view.roomName).toUpperCase(), width - 18, 22, "rgba(235,235,240,0.9)", 14, "right");
  const chip = `HQ LV ${view.hqLevel}`;
  ctx.font = `bold 13px "${TITLE_FONT}", "DejaVu Sans", Arial, sans-serif`;
  const cw = ctx.measureText(chip).width + 22;
  const cxp = width - 18 - cw, cyp = 38;
  ctx.fillStyle = hexToRgba(view.theme.palette.accent, 0.22);
  roundRectPath(ctx, cxp, cyp, cw, 20, 10); ctx.fill();
  ctx.strokeStyle = hexToRgba(view.theme.palette.accent, 0.8); ctx.lineWidth = 1;
  roundRectPath(ctx, cxp, cyp, cw, 20, 10); ctx.stroke();
  ctx.textAlign = "center";
  drawTextWithShadow(ctx, chip, cxp + cw / 2, cyp + 10, "#ffffff", 12);
  ctx.restore();
}

// ── Shared scenery pieces ─────────────────────────────────────────────────────
// One terraced slab: a grass top with a tile shimmer + sunlit rim, and two
// banded cliff faces, for the chunky floating-island look.
export function drawIslandTier(
  ctx: Ctx, cx: number, cy: number, hw: number, hh: number,
  opts: { raised?: boolean; thickness?: number; topA?: string; topB?: string } = {},
): void {
  const [top, right, bottom, left] = diamond(cx, cy, hw, hh) as [Pt, Pt, Pt, Pt];
  const thick = opts.thickness ?? (opts.raised ? 20 : 30);
  ctx.fillStyle = "#5b4327";
  polyPath(ctx, [left, bottom, { x: bottom.x, y: bottom.y + thick }, { x: left.x, y: left.y + thick }]); ctx.fill();
  ctx.fillStyle = "#463322";
  polyPath(ctx, [right, bottom, { x: bottom.x, y: bottom.y + thick }, { x: right.x, y: right.y + thick }]); ctx.fill();
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  polyPath(ctx, [{ x: left.x, y: left.y + thick - 6 }, { x: bottom.x, y: bottom.y + thick - 6 }, { x: bottom.x, y: bottom.y + thick }, { x: left.x, y: left.y + thick }]); ctx.fill();
  polyPath(ctx, [{ x: right.x, y: right.y + thick - 6 }, { x: bottom.x, y: bottom.y + thick - 6 }, { x: bottom.x, y: bottom.y + thick }, { x: right.x, y: right.y + thick }]); ctx.fill();

  polyPath(ctx, [top, right, bottom, left]);
  const gg = ctx.createLinearGradient(0, top.y, 0, bottom.y);
  gg.addColorStop(0, opts.topA ?? (opts.raised ? "#5a8a44" : "#4f7f3c"));
  gg.addColorStop(1, opts.topB ?? (opts.raised ? "#3f6a32" : "#365c2b"));
  ctx.fillStyle = gg; ctx.fill();

  ctx.save(); polyPath(ctx, [top, right, bottom, left]); ctx.clip();
  ctx.strokeStyle = "rgba(255,255,255,0.05)"; ctx.lineWidth = 1;
  const step = hw / 6;
  for (let i = -6; i <= 6; i++) {
    ctx.beginPath(); ctx.moveTo(cx + i * step, cy - hh); ctx.lineTo(cx + i * step + hw, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + i * step, cy - hh); ctx.lineTo(cx + i * step - hw, cy); ctx.stroke();
  }
  ctx.restore();

  ctx.strokeStyle = "rgba(180,220,150,0.5)"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(left.x, left.y); ctx.lineTo(top.x, top.y); ctx.lineTo(right.x, right.y); ctx.stroke();
}

export function drawPine(ctx: Ctx, x: number, y: number, s: number, tint = "#2f6b34"): void {
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.22)"; ctx.beginPath(); ellipse(ctx, x, y, 12 * s, 5 * s); ctx.fill();
  ctx.fillStyle = "#5a3d22"; ctx.fillRect(x - 2 * s, y - 10 * s, 4 * s, 10 * s);
  const shades = [tint, shiftColor(tint, 12), shiftColor(tint, 24)];
  for (let i = 0; i < 3; i++) {
    const ty = y - 6 * s - i * 12 * s, wsp = (16 - i * 3) * s;
    ctx.fillStyle = shades[i]!;
    ctx.beginPath(); ctx.moveTo(x, ty - 16 * s); ctx.lineTo(x + wsp, ty); ctx.lineTo(x - wsp, ty); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.beginPath(); ctx.moveTo(x, ty - 16 * s); ctx.lineTo(x - wsp, ty); ctx.lineTo(x - wsp * 0.4, ty); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

export function drawRock(ctx: Ctx, x: number, y: number, s: number): void {
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.22)"; ctx.beginPath(); ellipse(ctx, x, y, 16 * s, 6 * s); ctx.fill();
  ctx.fillStyle = "#8b9099"; ctx.beginPath();
  ctx.moveTo(x - 16 * s, y); ctx.lineTo(x - 8 * s, y - 16 * s); ctx.lineTo(x + 6 * s, y - 18 * s); ctx.lineTo(x + 16 * s, y - 4 * s); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#a9aeb6"; ctx.beginPath();
  ctx.moveTo(x - 8 * s, y - 16 * s); ctx.lineTo(x + 6 * s, y - 18 * s); ctx.lineTo(x + 2 * s, y - 8 * s); ctx.lineTo(x - 4 * s, y - 8 * s); ctx.closePath(); ctx.fill();
  ctx.restore();
}

// Lighten (positive) or darken (negative) a #rrggbb string by `amount` steps.
export function shiftColor(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(((n >> 16) & 0xff) + amount);
  const g = clamp(((n >> 8) & 0xff) + amount);
  const b = clamp((n & 0xff) + amount);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

// A centred pill label with a dark plate behind it — used for name plates on
// world markers and captions in the cinematic.
export function drawPlate(
  ctx: Ctx, text: string, cx: number, topY: number, color: string, size = 13, maxW = 220,
): void {
  ctx.save();
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.font = `bold ${size}px "${TITLE_FONT}", "DejaVu Sans", Arial, sans-serif`;
  const label = stripEmoji(text);
  const w = Math.min(maxW, ctx.measureText(label).width + 18);
  const h = size + 9;
  ctx.fillStyle = "rgba(0,0,0,0.68)"; roundRectPath(ctx, cx - w / 2, topY, w, h, h / 2); ctx.fill();
  drawTextWithShadow(ctx, label, cx, topY + h / 2, color, size);
  ctx.restore();
}

// A horizontal bar (health / progress) with a dark casing.
export function drawBar(
  ctx: Ctx, cx: number, y: number, w: number, h: number, frac: number, color?: string,
): void {
  const f = Math.max(0, Math.min(1, frac));
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.6)"; roundRectPath(ctx, cx - w / 2 - 2, y - 2, w + 4, h + 4, (h + 4) / 2); ctx.fill();
  ctx.fillStyle = "#1d261d"; roundRectPath(ctx, cx - w / 2, y, w, h, h / 2); ctx.fill();
  ctx.fillStyle = color ?? (f > 0.5 ? "#4fd06a" : f > 0.25 ? "#e0b83a" : "#d0483a");
  roundRectPath(ctx, cx - w / 2, y, Math.max(2, w * f), h, h / 2); ctx.fill();
  ctx.restore();
}
