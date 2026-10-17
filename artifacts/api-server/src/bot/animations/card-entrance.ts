// ─────────────────────────────────────────────────────────────────────────────
// DN Cards — Card entrance animations (spawn pre-intro)
//
// A short "the card enters" motion used only when the spawn reveal is set to
// "off" (image-only). The GIF stays on the spawn and loops: the motion plays,
// holds on the card for about a second, then replays. Catch and escape play
// that same motion backwards and finish in a smoke vanish. Admins pick the
// motion and the skin in /config. "Off" keeps a truly static card image.
//
//   Motions:  Fly In · Teleport In · Bounce In · Warp In · Flip In  (+ Random)
//   Skins:    rarity (backdrop tinted by the card's rarity) · tactical · holo
//
// Reuses the shared canvas + gifencoder pipeline (engine.encodeAnimation) and the
// existing card-draw helpers. Every path is best-effort: any failure returns null
// and the spawn falls back to the plain static image, so an entrance can never
// break a spawn.
// ─────────────────────────────────────────────────────────────────────────────

import type { Rarity } from "../cards-data.js";
import type { AnimationSpeed } from "./types.js";
import {
  getCanvas, encodeAnimation, drawGradientBackground, hexToRgba, roundRectPath,
  clamp01, lerp, easeOutBack, easeInOutCubic, type Ctx, type CanvasMod,
} from "./engine.js";
import {
  drawCardArt, drawCardFrame, drawRarityGlow, getRarityEffectColor,
} from "./effects.js";
import { logger } from "../../lib/logger.js";

export type EntranceType = "flyin" | "teleport" | "bounce" | "warp" | "flip";
export type EntranceSkin = "rarity" | "tactical" | "holo";

const ENTRANCE_TYPES: readonly EntranceType[] = ["flyin", "teleport", "bounce", "warp", "flip"];

// Resolve a stored setting value ("off" | "random" | a specific type) to the
// concrete motion to render this spawn — or null when entrances are off.
export function resolveEntranceType(value: string | null | undefined): EntranceType | null {
  if (!value || value === "off") return null;
  if (value === "random") return ENTRANCE_TYPES[Math.floor(Math.random() * ENTRANCE_TYPES.length)]!;
  return (ENTRANCE_TYPES as readonly string[]).includes(value) ? (value as EntranceType) : null;
}

export interface CardEntranceInput {
  artUrl: string | null | undefined;
  rarity: Rarity;
  rarityColor?: number | null;
  type: EntranceType;
  skin?: EntranceSkin;
  speed?: AnimationSpeed;
}

// Canvas geometry — a portrait framed card centred in the viewport with room to
// travel in from any edge.
const WIDTH = 480;
const HEIGHT = 600;
const CARD_W = 300;
const CARD_H = 420;
const CX = WIDTH / 2;
const CY = HEIGHT / 2 + 6;

// ── Skins ────────────────────────────────────────────────────────────────────
interface SkinSpec {
  accent: number;
  background(ctx: Ctx): void;
  overlay(ctx: Ctx, t: number): void; // drawn on top of the card (veil / HUD)
}

function rarityBg(color: number): (ctx: Ctx) => void {
  return (ctx) => {
    drawGradientBackground(ctx, WIDTH, HEIGHT, [
      [0, hexToRgba(color, 0.28)],
      [0.55, "#0c0e14"],
      [1, "#07080d"],
    ], Math.PI / 2);
    // Soft vignette.
    const g = ctx.createRadialGradient(CX, CY, 60, CX, CY, HEIGHT * 0.75);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  };
}

function skinFor(skin: EntranceSkin, rarityColor: number): SkinSpec {
  switch (skin) {
    case "tactical": {
      const accent = 0xeba33d;
      return {
        accent,
        background: (ctx) => {
          drawGradientBackground(ctx, WIDTH, HEIGHT, [
            [0, "#141a24"],
            [0.6, "#0a0d14"],
            [1, "#070a10"],
          ], Math.PI / 2);
          // Scanlines.
          ctx.save();
          ctx.globalAlpha = 0.06;
          ctx.fillStyle = "#ffffff";
          for (let y = 0; y < HEIGHT; y += 3) ctx.fillRect(0, y, WIDTH, 1);
          ctx.restore();
        },
        overlay: (ctx, t) => {
          // Corner targeting ticks that snap tighter as the card settles.
          const inset = lerp(46, 20, clamp01(t));
          const L = 26;
          ctx.save();
          ctx.strokeStyle = hexToRgba(accent, 0.7);
          ctx.lineWidth = 2;
          const corners: [number, number, number, number][] = [
            [inset, inset, 1, 1], [WIDTH - inset, inset, -1, 1],
            [inset, HEIGHT - inset, 1, -1], [WIDTH - inset, HEIGHT - inset, -1, -1],
          ];
          for (const [x, y, sx, sy] of corners) {
            ctx.beginPath();
            ctx.moveTo(x + L * sx, y); ctx.lineTo(x, y); ctx.lineTo(x, y + L * sy);
            ctx.stroke();
          }
          ctx.restore();
        },
      };
    }
    case "holo": {
      const accent = 0x48e7ff;
      return {
        accent,
        background: (ctx) => {
          drawGradientBackground(ctx, WIDTH, HEIGHT, [
            [0, "#241a52"],
            [0.6, "#120e2c"],
            [1, "#0a0820"],
          ], Math.PI / 2);
        },
        overlay: (ctx, t) => {
          // Sweeping prism veil that tracks the card in.
          ctx.save();
          const sweep = lerp(-0.4, 1.2, clamp01(t));
          const g = ctx.createLinearGradient(WIDTH * (sweep - 0.3), 0, WIDTH * (sweep + 0.3), HEIGHT);
          g.addColorStop(0, "rgba(72,231,255,0)");
          g.addColorStop(0.5, "rgba(72,231,255,0.16)");
          g.addColorStop(0.52, "rgba(255,84,214,0.16)");
          g.addColorStop(1, "rgba(255,84,214,0)");
          (ctx as unknown as { globalCompositeOperation: string }).globalCompositeOperation = "screen";
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, WIDTH, HEIGHT);
          ctx.restore();
        },
      };
    }
    default:
      return { accent: rarityColor, background: rarityBg(rarityColor), overlay: () => { /* clean */ } };
  }
}

// ── Motion ───────────────────────────────────────────────────────────────────
// Each motion maps t (0→1) to a transform for the card panel. `flipBack` signals
// the flip motion is currently showing the card's back face.
interface Pose {
  ox: number; oy: number;   // centre offset
  sx: number; sy: number;   // scale
  rot: number;              // radians
  alpha: number;
  flipBack?: boolean;
}

function easeOutBounce(x: number): number {
  const n1 = 7.5625, d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) { x -= 1.5 / d1; return n1 * x * x + 0.75; }
  if (x < 2.5 / d1) { x -= 2.25 / d1; return n1 * x * x + 0.9375; }
  x -= 2.625 / d1; return n1 * x * x + 0.984375;
}

function poseFor(type: EntranceType, t: number): Pose {
  switch (type) {
    case "flyin": {
      const p = easeOutBack(clamp01(t));
      return { ox: lerp(-WIDTH * 1.05, 0, p), oy: 0, sx: 1, sy: 1, rot: lerp(-0.16, 0, clamp01(t * 1.2)), alpha: clamp01(t * 4) };
    }
    case "bounce": {
      const p = easeOutBounce(clamp01(t));
      const land = clamp01((t - 0.55) / 0.45);
      const squash = Math.sin(land * Math.PI) * 0.12;
      return { ox: 0, oy: lerp(-HEIGHT * 0.95, 0, p), sx: 1 + squash, sy: 1 - squash, rot: 0, alpha: clamp01(t * 6) };
    }
    case "teleport": {
      if (t < 0.4) {
        const g = clamp01(t / 0.4);
        return { ox: 0, oy: 0, sx: 0.04, sy: g, rot: 0, alpha: g };
      }
      const p = easeOutBack(clamp01((t - 0.4) / 0.6));
      return { ox: 0, oy: 0, sx: lerp(0.04, 1, p), sy: 1, rot: 0, alpha: 1 };
    }
    case "warp": {
      const p = easeInOutCubic(clamp01(t));
      const s = lerp(0.05, 1, p);
      return { ox: 0, oy: 0, sx: s, sy: s, rot: lerp(-0.7, 0, p), alpha: clamp01(t * 3) };
    }
    case "flip": {
      const a = lerp(Math.PI, 0, easeInOutCubic(clamp01(t)));
      const c = Math.cos(a); // −1 → +1
      return { ox: 0, oy: 0, sx: Math.max(0.02, Math.abs(c)), sy: 1, rot: 0, alpha: 1, flipBack: c < 0 };
    }
  }
}

// The card's back face — a simple framed emblem shown mid-flip.
function drawCardBack(ctx: Ctx, w: number, h: number, accent: number): void {
  ctx.save();
  roundRectPath(ctx, 0, 0, w, h, 14);
  ctx.clip();
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, "#141821");
  g.addColorStop(1, "#0c1019");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // Diagonal weave.
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = hexToRgba(accent, 0.18);
  ctx.lineWidth = 2;
  for (let i = -h; i < w; i += 14) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + h, h); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = hexToRgba(accent, 0.9);
  ctx.font = 'bold 54px "Orbitron", "DejaVu Sans", sans-serif';
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("DN", w / 2, h / 2);
  ctx.restore();
}

// ── FX per motion (drawn in the viewport, not on the card) ─────────────────────
function drawEntranceFx(ctx: Ctx, type: EntranceType, t: number, accent: number): void {
  if (type === "teleport") {
    // Bright vertical beam during the materialise phase + a flash as it snaps in.
    if (t < 0.45) {
      const a = 0.8 * (1 - t / 0.45);
      ctx.save();
      (ctx as unknown as { globalCompositeOperation: string }).globalCompositeOperation = "screen";
      const g = ctx.createLinearGradient(CX, CY - CARD_H / 2, CX, CY + CARD_H / 2);
      g.addColorStop(0, hexToRgba(accent, 0));
      g.addColorStop(0.5, hexToRgba(accent, a));
      g.addColorStop(1, hexToRgba(accent, 0));
      ctx.fillStyle = g;
      ctx.fillRect(CX - 4, CY - CARD_H / 2, 8, CARD_H);
      ctx.restore();
    }
    if (t > 0.35 && t < 0.6) {
      const a = 0.55 * Math.sin(((t - 0.35) / 0.25) * Math.PI);
      ctx.save();
      (ctx as unknown as { globalCompositeOperation: string }).globalCompositeOperation = "screen";
      const g = ctx.createRadialGradient(CX, CY, 20, CX, CY, WIDTH * 0.5);
      g.addColorStop(0, hexToRgba(accent, a));
      g.addColorStop(1, hexToRgba(accent, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.restore();
    }
  } else if (type === "warp") {
    // Radial speed streaks that fade as the card settles.
    const a = clamp01(1 - t * 1.3);
    if (a <= 0.02) return;
    ctx.save();
    (ctx as unknown as { globalCompositeOperation: string }).globalCompositeOperation = "screen";
    ctx.strokeStyle = hexToRgba(accent, a * 0.6);
    ctx.lineWidth = 2;
    const rings = 14;
    for (let i = 0; i < rings; i++) {
      const ang = (i / rings) * Math.PI * 2 + t * 2;
      const r0 = lerp(40, 150, t), r1 = r0 + lerp(120, 20, t);
      ctx.beginPath();
      ctx.moveTo(CX + Math.cos(ang) * r0, CY + Math.sin(ang) * r0);
      ctx.lineTo(CX + Math.cos(ang) * r1, CY + Math.sin(ang) * r1);
      ctx.stroke();
    }
    ctx.restore();
  }
}

async function drawEntranceCard(
  ctx: Ctx, mod: CanvasMod, artUrl: string | null | undefined,
  pose: Pose, color: number, accent: number, rarity: Rarity,
): Promise<void> {
  ctx.save();
  ctx.globalAlpha = clamp01(pose.alpha);
  ctx.translate(CX + pose.ox, CY + pose.oy);
  ctx.rotate(pose.rot);
  ctx.scale(pose.sx, pose.sy);
  ctx.translate(-CARD_W / 2, -CARD_H / 2);
  // Glow grows as the card commits to its resting pose.
  drawRarityGlow(ctx, 0, 0, CARD_W, CARD_H, color, 0.35 + 0.4 * clamp01(pose.alpha));
  if (pose.flipBack) {
    drawCardBack(ctx, CARD_W, CARD_H, accent);
  } else {
    await drawCardArt(ctx, mod, 0, 0, CARD_W, CARD_H, artUrl, rarity);
  }
  drawCardFrame(ctx, 0, 0, CARD_W, CARD_H, color, 6, rarity);
  ctx.restore();
}

/** Motion length follows the speed setting, then the card holds for a second. */
export function entranceTimeline(speed: AnimationSpeed = "normal"): { durationMs: number; motionEnd: number; holdMs: number } {
  const motionMs = speed === "slow" ? 2200 : speed === "fast" ? 1200 : 1700;
  const holdMs = 1000;
  const durationMs = motionMs + holdMs;
  return { durationMs, motionEnd: motionMs / durationMs, holdMs };
}

/** How long the catch/escape vanish plays before the message shows its final embed. */
export const CARD_EXIT_MS = 2000;

export async function renderCardEntrance(input: CardEntranceInput): Promise<Buffer | null> {
  const mod = await getCanvas();
  if (!mod) return null;

  const color = input.rarityColor ?? getRarityEffectColor(input.rarity);
  const skin = skinFor(input.skin ?? "rarity", color);
  const { durationMs, motionEnd } = entranceTimeline(input.speed ?? "normal");
  try {
    const result = await encodeAnimation({
      width: WIDTH,
      height: HEIGHT,
      speed: input.speed ?? "normal",
      durationMs,
      maxFrames: 28,
      quality: 18,
      render: async ({ ctx, t, mod: m }) => {
        const mt = clamp01(t / motionEnd); // holds at 1 through the pause, then the GIF loops
        skin.background(ctx);
        drawEntranceFx(ctx, input.type, mt, skin.accent);
        await drawEntranceCard(ctx, m, input.artUrl, poseFor(input.type, mt), color, skin.accent, input.rarity);
        skin.overlay(ctx, mt);
      },
    });
    return result?.buffer ?? null;
  } catch (err) {
    logger.debug({ err }, "card-entrance: encode failed");
    return null;
  }
}

/**
 * The entrance played backwards, then a smoke poof as the card teleports away.
 * Used for both a catch and an escape. Best-effort: null falls back to the
 * plain caught/escaped embed.
 */
export async function renderCardExit(input: CardEntranceInput): Promise<Buffer | null> {
  const mod = await getCanvas();
  if (!mod) return null;

  const color = input.rarityColor ?? getRarityEffectColor(input.rarity);
  const skin = skinFor(input.skin ?? "rarity", color);
  const MOTION_END = 0.62;
  try {
    const result = await encodeAnimation({
      width: WIDTH,
      height: HEIGHT,
      speed: input.speed ?? "normal",
      durationMs: CARD_EXIT_MS,
      maxFrames: 24,
      quality: 18,
      render: async ({ ctx, t, mod: m }) => {
        const mt = clamp01(1 - t / MOTION_END);
        const vanish = clamp01((t - 0.4) / 0.28);
        const smoke = clamp01((t - 0.36) / 0.64);
        skin.background(ctx);
        const pose = poseFor(input.type, mt);
        pose.alpha *= 1 - vanish;
        const shrink = 1 - vanish * 0.55;
        pose.sx *= shrink;
        pose.sy *= shrink;
        drawEntranceFx(ctx, input.type, mt, skin.accent);
        await drawEntranceCard(ctx, m, input.artUrl, pose, color, skin.accent, input.rarity);
        skin.overlay(ctx, mt);
        if (smoke > 0.02) {
          // Cloud where the card rested, plus a trail if the motion carries it off-screen.
          drawVanishSmoke(ctx, smoke, CX, CY);
          if (Math.hypot(pose.ox, pose.oy) > 24) drawVanishSmoke(ctx, smoke * 0.7, CX + pose.ox, CY + pose.oy);
        }
      },
    });
    return result?.buffer ?? null;
  } catch (err) {
    logger.debug({ err }, "card-exit: encode failed");
    return null;
  }
}

/** Expanding cloud that fades out — the card's teleport-away. */
function drawVanishSmoke(ctx: Ctx, p: number, x: number, y: number): void {
  const puff = Math.sin(Math.min(1, p) * Math.PI);
  ctx.save();
  const spots = 8;
  for (let i = 0; i < spots; i++) {
    const ang = (i / spots) * Math.PI * 2 + 0.5;
    const dist = lerp(6, 110, p) * (0.45 + (i % 3) * 0.22);
    const rad = lerp(16, 78, p) * (0.65 + (i % 2) * 0.4);
    const a = puff * 0.62;
    const px = x + Math.cos(ang) * dist;
    const py = y + Math.sin(ang) * dist * 0.7 - p * 28;
    const g = ctx.createRadialGradient(px, py, 2, px, py, rad);
    g.addColorStop(0, `rgba(250,250,252,${a})`);
    g.addColorStop(0.4, `rgba(186,188,198,${a * 0.72})`);
    g.addColorStop(1, "rgba(120,122,132,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, rad, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
