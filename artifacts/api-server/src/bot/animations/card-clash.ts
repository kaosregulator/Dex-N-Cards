// ─────────────────────────────────────────────────────────────────────────────
// Siege Battle — the CARD CLASH cinematic.
//
// An INTERNAL presentation beat after a resolved Siege action — never a
// separate battle mode or player navigation target. The formation field decides
// who fights; this paints the close-up HOW. Two featured fighters either side of
// a VS burst, with HP/energy/ultimate meters, commander life-point plates, a
// battle log rail, and the hand of Siege Battle Cards along the bottom.
//
// Same renderer seam as every other animation here: `@napi-rs/canvas` drawn onto
// a 2D context, GIFs through the shared `encodeAnimation`. Everything is
// best-effort — a missing asset, a stalled card image or an oversized encode all
// resolve to `null` and the caller keeps the previous frame. A siege must never
// break because a picture failed.
//
// This module RENDERS. It never computes an outcome: every number it draws
// (damage, HP, KO, energy) is handed to it by the resolver.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { spriteForPrefix } from "../hq/assets.js";
import {
  loadArt as loadArtShared,
  createBurst, drawParticles, drawDamageNumber, drawScreenFlash,
} from "./effects.js";
import { drawAtmosphere, atmospherePreset } from "./atmosphere.js";
import { drawImpactDebris, physicsShake } from "./physics.js";
import {
  encodeAnimation, getCanvas, clamp01, lerp, easeInOutCubic, easeOutBack,
  TITLE_FONT_FAMILY, hexToRgba,
  type CanvasMod, type Ctx,
} from "./engine.js";
import type { AnimationSpeed, AnimationResult } from "./types.js";
import { logger } from "../../lib/logger.js";

type CanvasImage = Awaited<ReturnType<CanvasMod["loadImage"]>>;

// ── Public input ─────────────────────────────────────────────────────────────

export interface ClashFighter {
  name: string;
  artUrl: string | null;
  rarity: string;
  rarityColor: number | null;
  hp: number;                 // AFTER the action
  maxHp: number;
  hpBefore?: number;          // BEFORE (drives the drain animation)
  energy?: number;            // 0..100
  ultimate?: number;          // 0..100
  /** Power number shown under the portrait, like the reference screen. */
  power?: number;
  stars?: number;             // 0..5 rarity pips
}

/** One card in the commander's hand, drawn along the bottom rail. */
export interface ClashHandCard {
  name: string;
  emoji: string;
  description: string;
  energyCost: number;
  /** Frame colour — maps to the installed siege-card frame art. */
  color: "red" | "blue" | "green" | "yellow" | "purple";
  /** Dimmed + un-selectable (not enough energy, on cooldown, conditions unmet). */
  disabled?: boolean;
  /** The card being played this frame — it lifts and glows. */
  playing?: boolean;
}

export interface CardClashInput {
  attacker: ClashFighter;      // left, blue
  defender: ClashFighter;      // right, red
  actingSide: 0 | 1;

  /** Commander plates across the top. */
  attackerCommander: { name: string; role: string; lp: number; lpMax: number };
  defenderCommander: { name: string; role: string; lp: number; lpMax: number };

  moveName: string;
  damage: number;
  isHit: boolean;
  isCrit: boolean;
  ko: boolean;
  accent: number;

  turnLabel?: string | null;
  /** Phase chips under the turn label (DRAW / MAIN / BATTLE / END). */
  phase?: "draw" | "main" | "battle" | "end";
  /** Newest-last log lines for the left rail. */
  log?: string[];
  /** The acting commander's hand. */
  hand?: ClashHandCard[];
  /** Energy pips shown bottom-left. */
  energy?: { current: number; max: number };
  arenaName?: string | null;
}

// Layout grid (logical units). Everything below is positioned off these so the
// panels cannot drift into each other:
//   y   0.. 96  commander plates + turn header
//   y 204..596  the two featured cards (side rails sit beside them, not over)
//   y 608..648  move banner
//   y 666..842  hand of Siege Battle Cards
const FIELD = { width: 1200, height: 860 } as const;
const CARD = { w: 268, h: 392, cy: 400, leftCx: 390, rightCx: 810 } as const;
const RAIL = { w: 236, y: 300, leftX: 16, rightX: 948 } as const;
const HAND = { cw: 140, ch: 186, gap: 12, y: 660 } as const;
const MAX_BYTES = 8_000_000;
const RENDER_SCALE = 0.55;

const BLUE = 0x3d7fd6, RED = 0xd6404a, GOLD = 0xe8c15a;
const INK = "#070b14";

// ── Assets ───────────────────────────────────────────────────────────────────

interface ClashAssets {
  frames: Partial<Record<string, CanvasImage | null>>;
  atkArt: CanvasImage | null;
  defArt: CanvasImage | null;
}

function sprite(prefix: string, key: string): string | null {
  try { return spriteForPrefix(prefix, key); } catch { return null; }
}
async function loadSpritePath(cmod: CanvasMod, path: string): Promise<CanvasImage | null> {
  try { return await cmod.loadImage(readFileSync(path)); } catch { return null; }
}
async function loadArt(cmod: CanvasMod, url: string | null): Promise<CanvasImage | null> {
  if (!url) return null;
  try { return await loadArtShared(cmod, url); } catch { return null; }
}

async function loadClashAssets(cmod: CanvasMod, input: CardClashInput): Promise<ClashAssets> {
  const colors = [...new Set((input.hand ?? []).map(h => h.color))];
  const framePaths = colors.map(c => ({ c, p: sprite("siege-cards", `frame-${c}`) }));
  const [atkArt, defArt, ...frameImgs] = await Promise.all([
    loadArt(cmod, input.attacker.artUrl),
    loadArt(cmod, input.defender.artUrl),
    ...framePaths.map(f => (f.p ? loadSpritePath(cmod, f.p) : Promise.resolve(null))),
  ]);
  const frames: Partial<Record<string, CanvasImage | null>> = {};
  framePaths.forEach((f, i) => { frames[f.c] = frameImgs[i] ?? null; });
  return { frames, atkArt, defArt };
}

// ── Public entry points ──────────────────────────────────────────────────────

/** Freeze near connect so impact FX + damage numbers still read in static mode. */
const STILL_T = 0.46;
const STILL_SCALE = 0.85;

export async function renderCardClash(
  input: CardClashInput, speed: AnimationSpeed,
): Promise<AnimationResult | null> {
  const cmod = await getCanvas();
  if (!cmod) return null;
  try {
    const assets = await loadClashAssets(cmod, input);
    const result = await encodeAnimation({
      width: FIELD.width,
      height: FIELD.height,
      speed,
      durationMs: speed === "fast" ? 1600 : speed === "slow" ? 2400 : 2000,
      maxFrames: speed === "fast" ? 14 : speed === "slow" ? 20 : 18,
      quality: 28,
      renderScale: RENDER_SCALE,
      // encodeAnimation already applied renderScale to the context, so paint in
      // logical coordinates (pass 1 so paintClash does not scale twice).
      render: async ({ ctx, t }) => { await paintClash(ctx, input, assets, t, 1); },
    });
    if (!result) return null;
    if (result.buffer.length > MAX_BYTES) {
      logger.debug({ bytes: result.buffer.length }, "card clash: encoded GIF too large, dropping");
      return null;
    }
    return result;
  } catch (err) {
    logger.warn({ err }, "card clash render failed");
    return null;
  }
}

export async function renderCardClashStill(input: CardClashInput): Promise<Buffer | null> {
  const cmod = await getCanvas();
  if (!cmod) return null;
  try {
    const assets = await loadClashAssets(cmod, input);
    const w = Math.round(FIELD.width * STILL_SCALE), h = Math.round(FIELD.height * STILL_SCALE);
    const canvas = cmod.createCanvas(w, h);
    const ctx = canvas.getContext("2d") as unknown as Ctx;
    await paintClash(ctx, input, assets, STILL_T, STILL_SCALE);
    return await canvas.encode("png");
  } catch (err) {
    logger.warn({ err }, "card clash still failed");
    return null;
  }
}

// ── Painting ─────────────────────────────────────────────────────────────────

/**
 * Card Clash combat beat — same visual vocabulary as /battle:
 * idle → lunge → projectile/connect → recoil/flash/particles/debris → return.
 * MISS is a dodge/whiff, not a text-only label. CRIT and KO hit harder.
 */
async function paintClash(ctx: Ctx, input: CardClashInput, a: ClashAssets, t: number, scale: number): Promise<void> {
  ctx.save();
  ctx.scale(scale, scale);

  drawBackdrop(ctx, input, t);

  // Same phase windows as battle.ts: idle → lunge → hit → aftermath.
  const lungeT = clamp01((t - 0.18) / 0.22);
  const hitT = clamp01((t - 0.40) / 0.15);
  const afterT = clamp01((t - 0.55) / 0.40);
  const lungePeak = input.isHit ? (input.isCrit || input.ko ? 128 : 118) : 108;
  const lungeAmt = lungeT < 1
    ? lerp(0, lungePeak, easeInOutCubic(lungeT))
    : lerp(lungePeak, 0, easeInOutCubic(afterT));

  const shakeIntensity = !input.isHit || hitT <= 0 || hitT >= 1 ? 0
    : input.ko ? 18 : input.isCrit ? 14 : 8;
  const shake = shakeIntensity > 0
    ? await physicsShake(shakeIntensity, hitT, `${input.attacker.name}-clash`)
    : { dx: 0, dy: 0 };

  drawCommanderPlate(ctx, 0, input.attackerCommander, BLUE);
  drawCommanderPlate(ctx, 1, input.defenderCommander, RED);
  drawTurnHeader(ctx, input);

  // Combat subjects shake on impact; HUD stays framed.
  ctx.save();
  ctx.translate(shake.dx, shake.dy);

  const actingLeft = input.actingSide === 0;
  const struckSide: 0 | 1 = actingLeft ? 1 : 0;
  const atkLunge = actingLeft ? lungeAmt : 0;
  const defLunge = actingLeft ? 0 : -lungeAmt;

  // Hit: defender recoils hard. Miss: defender dodges aside + up (whiff).
  const hitRecoil = input.isHit && hitT > 0
    ? lerp(0, input.ko ? 52 : input.isCrit ? 44 : 36, easeOutBack(Math.min(1, hitT * 1.15)))
    : 0;
  const dodgeAmt = !input.isHit && hitT > 0
    ? lerp(0, 48, easeOutBack(Math.min(1, hitT * 1.2)))
    : 0;
  const dodgeY = !input.isHit && hitT > 0
    ? lerp(0, -28, easeOutBack(Math.min(1, hitT)))
    : 0;
  // Attacker slight settle after connect / miss.
  const atkSettle = (hitT > 0 ? lerp(0, 12, easeOutBack(Math.min(1, hitT))) : 0);

  const atkX = CARD.leftCx + atkLunge
    - (actingLeft ? atkSettle : hitRecoil)
    - (!actingLeft && !input.isHit ? dodgeAmt : 0);
  const defX = CARD.rightCx + defLunge
    + (!actingLeft ? atkSettle : hitRecoil)
    + (actingLeft && !input.isHit ? dodgeAmt : 0);
  const atkY = CARD.cy + (!actingLeft && !input.isHit ? dodgeY : 0);
  const defY = CARD.cy + (actingLeft && !input.isHit ? dodgeY : 0);

  const impactFlash = input.isHit && hitT > 0 ? Math.max(0, 1 - hitT) : 0;

  drawFeatureCard(ctx, atkX, atkY, input.attacker, a.atkArt, BLUE, 0,
    struckSide === 0 ? impactFlash : 0, input, t);
  drawFeatureCard(ctx, defX, defY, input.defender, a.defArt, RED, 1,
    struckSide === 1 ? impactFlash : 0, input, t);

  // Motion streak behind the lunging attacker (live readability).
  if (lungeAmt > 8 && afterT < 0.85) {
    const ax = actingLeft ? atkX : defX;
    const ay = actingLeft ? atkY : defY;
    drawLungeStreak(ctx, ax, ay, actingLeft ? 1 : -1, clamp01(lungeAmt / lungePeak),
      actingLeft ? BLUE : RED);
  }

  // Projectile spark racing toward the target during connect window.
  if (lungeT >= 1 && hitT > 0 && hitT < 1) {
    const fromX = actingLeft ? atkX + CARD.w * 0.35 : defX - CARD.w * 0.35;
    const toX = actingLeft ? defX - CARD.w * 0.2 : atkX + CARD.w * 0.2;
    const px = lerp(fromX, toX, hitT);
    const py = (actingLeft ? atkY : defY);
    const size = 6 + hitT * (input.isCrit ? 28 : 20);
    ctx.save();
    ctx.fillStyle = hexToRgba(input.accent || (actingLeft ? BLUE : RED), 1 - hitT * 0.45);
    ctx.shadowColor = hexToRgba(GOLD, 0.9);
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(px, py, size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  const impactCx = actingLeft ? defX : atkX;
  const impactCy = actingLeft ? defY : atkY;

  if (input.isHit && hitT > 0 && hitT < 1) {
    drawImpactBurst(ctx, impactCx, impactCy, impactFlash, input);
    const burstCount = input.ko ? 90 : input.isCrit ? 80 : 45;
    const burst = createBurst(impactCx, impactCy, input.accent || GOLD, burstCount, input.isCrit ? 200 : 150);
    for (let i = 0; i < burst.length; i++) {
      const p = burst[i]!;
      p.x += p.vx * hitT * 10;
      p.y += p.vy * hitT * 10;
    }
    drawParticles(ctx, burst);
    await drawImpactDebris(ctx, impactCx, impactCy, {
      color: input.accent || GOLD,
      count: input.ko ? 30 : input.isCrit ? 26 : 14,
      power: input.ko ? 17 : input.isCrit ? 15 : 10,
      steps: Math.max(2, Math.round(hitT * 16)),
      seed: `${input.moveName}-clash-shard`,
    });
  } else if (!input.isHit && hitT > 0 && hitT < 0.85) {
    // Subtle whiff spark at the miss point (attack passes through empty air).
    drawWhiffSpark(ctx, (atkX + defX) / 2, CARD.cy, hitT);
  }

  drawVsMark(ctx, impactFlash);
  ctx.restore(); // end shaken combat group

  if (input.isHit && hitT > 0 && hitT < 0.65) {
    drawScreenFlash(ctx, FIELD.width, FIELD.height, hitT / 0.65,
      input.ko ? RED : input.isCrit ? GOLD : (input.accent || BLUE));
  }

  // Floating damage / MISS — shared /battle treatment.
  if (hitT > 0) {
    const tx = actingLeft ? defX : atkX;
    const ty = (actingLeft ? defY : atkY) - CARD.h * 0.42;
    if (input.isHit && input.damage > 0) {
      drawDamageNumber(ctx, input.damage, tx, ty, hitT, input.isCrit);
    } else if (!input.isHit) {
      drawDamageNumber(ctx, 0, tx, ty, hitT, false, true);
    }
  }

  drawMoveBanner(ctx, input);
  drawBattleLog(ctx, input);
  drawSideInfo(ctx, input);
  drawHand(ctx, input, a, t);
  drawEnergyMeter(ctx, input);

  if (input.ko && t > 0.42) {
    drawKoStamp(ctx, impactCx, Math.max(impactFlash, clamp01((t - 0.42) / 0.35)));
  }

  ctx.restore();
}

function drawBackdrop(ctx: Ctx, input: CardClashInput, t = STILL_T): void {
  // Storm-lit ruin wash — dark enough that the two featured cards read first.
  ctx.fillStyle = vGradient(ctx, 0, 0, FIELD.height, [
    [0, "#141c2e"], [0.42, "#1b2438"], [0.72, "#141a26"], [1, "#080b12"],
  ]);
  ctx.fillRect(0, 0, FIELD.width, FIELD.height);

  // Side tint so blue/red ownership is instant.
  const split = ctx.createLinearGradient(0, 0, FIELD.width, 0);
  split.addColorStop(0, hexA(BLUE, 0.20));
  split.addColorStop(0.5, "rgba(0,0,0,0)");
  split.addColorStop(1, hexA(RED, 0.20));
  ctx.fillStyle = split;
  ctx.fillRect(0, 0, FIELD.width, FIELD.height);

  // Shared battlefield atmosphere (embers/dust) — same stack as /battle.
  drawAtmosphere(ctx, FIELD.width, FIELD.height, atmospherePreset("battlefield"), {
    seed: `${input.attacker.name}-clash`,
    t,
    color: input.accent || GOLD,
    density: 0.55,
  });

  // Ground haze under the cards.
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = vGradient(ctx, 0, 470, 640, [[0, "rgba(0,0,0,0)"], [1, hexA(input.accent, 0.55)]]);
  ctx.fillRect(0, 470, FIELD.width, 200);
  ctx.restore();

  // Vignette.
  const vg = ctx.createRadialGradient(FIELD.width / 2, FIELD.height / 2, 260, FIELD.width / 2, FIELD.height / 2, 780);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(0,0,0,0.55)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, FIELD.width, FIELD.height);
}

function drawLungeStreak(ctx: Ctx, cx: number, cy: number, dir: number, k: number, color: number): void {
  const bandTop = cy - CARD.h * 0.32, bandBot = cy + CARD.h * 0.32;
  const lines = 5;
  ctx.save();
  ctx.lineCap = "round";
  for (let i = 0; i < lines; i++) {
    const f = i / (lines - 1);
    const y = lerp(bandTop, bandBot, f);
    const centre = 1 - Math.abs(f - 0.5) * 2;
    const len = (36 + centre * 70) * k;
    if (len < 4) continue;
    const x0 = cx - dir * (CARD.w * 0.18);
    const x1 = x0 - dir * len;
    ctx.globalAlpha = k * (0.2 + centre * 0.45);
    ctx.strokeStyle = hex(color);
    ctx.lineWidth = 2.2 + centre * 3.2;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawImpactBurst(ctx: Ctx, cx: number, cy: number, impact: number, input: CardClashInput): void {
  if (impact < 0.02) return;
  const scale = (input.isCrit || input.ko ? 1.35 : 1) * (0.65 + impact * 0.9);
  ctx.save();
  ctx.globalAlpha = impact * 0.95;
  const g = ctx.createRadialGradient(cx, cy, 6, cx, cy, 210 * scale);
  g.addColorStop(0, "rgba(255,245,210,0.95)");
  g.addColorStop(0.4, hexA(input.isCrit ? GOLD : input.accent || GOLD, 0.55));
  g.addColorStop(1, "rgba(255,180,60,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, 210 * scale, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = hexA(GOLD, 0.9 * impact);
  ctx.lineWidth = 4 * scale;
  ctx.beginPath();
  ctx.arc(cx, cy, (28 + (1 - impact) * 70) * scale, 0, Math.PI * 2);
  ctx.stroke();

  const sparks = input.ko ? 14 : input.isCrit ? 12 : 8;
  ctx.lineCap = "round";
  for (let i = 0; i < sparks; i++) {
    const ang = (i / sparks) * Math.PI * 2 + impact * 0.55;
    const r0 = 22 * scale, r1 = r0 + (50 + impact * 80) * scale;
    ctx.strokeStyle = hexA(GOLD, 0.9 * impact);
    ctx.lineWidth = 2.6 * scale;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
    ctx.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
    ctx.stroke();
  }
  // Slash streak through the impact.
  ctx.globalAlpha = impact * 0.9;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 6 * scale;
  ctx.shadowColor = hexA(GOLD, impact);
  ctx.shadowBlur = 16;
  ctx.beginPath();
  ctx.moveTo(cx - 70 * scale, cy + 38 * scale);
  ctx.lineTo(cx + 70 * scale, cy - 38 * scale);
  ctx.stroke();
  ctx.restore();
}

function drawWhiffSpark(ctx: Ctx, cx: number, cy: number, hitT: number): void {
  const k = 1 - hitT;
  ctx.save();
  ctx.globalAlpha = 0.55 * k;
  ctx.strokeStyle = "rgba(200,214,238,0.85)";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx - 40, cy - 8);
  ctx.lineTo(cx + 36, cy + 10);
  ctx.stroke();
  ctx.globalAlpha = 0.35 * k;
  ctx.beginPath();
  ctx.arc(cx + 20, cy, 10 + hitT * 18, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawVsMark(ctx: Ctx, impact: number): void {
  const cx = FIELD.width / 2, cy = CARD.cy;
  const pop = 1 + impact * 0.28;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(pop, pop);
  drawText(ctx, {
    x: -60, y: -22, w: 120, align: "center", text: "VS", size: 44, weight: 900,
    fill: hex(GOLD), shadow: "rgba(0,0,0,0.8)", shadowBlur: 10,
  });
  ctx.restore();
}

function drawMoveBanner(ctx: Ctx, input: CardClashInput): void {
  const cx = FIELD.width / 2;
  fillRoundRect(ctx, cx - 210, 608, 420, 40, 20, "rgba(8,12,20,0.9)");
  strokeRoundRect(ctx, cx - 210, 608, 420, 40, 20, hexA(GOLD, 0.75), 2);
  drawText(ctx, {
    x: cx - 200, y: 619, w: 400, align: "center",
    text: ellipsize(ctx, input.moveName, 390, 17, 800), size: 17, weight: 800, fill: "#f2f6ff",
  });
}

// ── Commander plates (top corners) ───────────────────────────────────────────

function drawCommanderPlate(
  ctx: Ctx, side: 0 | 1,
  c: { name: string; role: string; lp: number; lpMax: number }, color: number,
): void {
  const w = 380, h = 78;
  const x = side === 0 ? 16 : FIELD.width - 16 - w;
  const y = 18;

  fillRoundRect(ctx, x, y, w, h, 12, "rgba(8,12,20,0.82)");
  strokeRoundRect(ctx, x, y, w, h, 12, hexA(color, 0.85), 2);

  // Name on the outer edge, LP on the inner — mirrored per side.
  const outer = side === 0 ? "left" : "right";
  const inner = side === 0 ? "right" : "left";
  drawText(ctx, {
    x: x + 14, y: y + 9, w: w - 28, align: outer,
    text: ellipsize(ctx, c.name.toUpperCase(), w - 150, 21), size: 21, weight: 900, fill: "#f2f6ff",
  });
  drawText(ctx, {
    x: x + 14, y: y + 34, w: w - 28, align: outer,
    text: c.role, size: 12, weight: 700, fill: hex(color),
  });
  drawText(ctx, {
    x: x + 14, y: y + 28, w: w - 28, align: inner,
    text: `LP ${c.lp.toLocaleString()}`, size: 22, weight: 900, fill: "#ffffff",
  });

  const bx = x + 14, bw = w - 28, by = y + 58, bh = 10;
  fillRoundRect(ctx, bx, by, bw, bh, 5, "rgba(255,255,255,0.10)");
  const frac = clamp01(c.lpMax > 0 ? c.lp / c.lpMax : 0);
  if (frac > 0) fillRoundRect(ctx, bx, by, Math.max(4, bw * frac), bh, 5, hex(color));
}

function drawTurnHeader(ctx: Ctx, input: CardClashInput): void {
  const w = 280, x = (FIELD.width - w) / 2, y = 22, h = 34;
  fillRoundRect(ctx, x, y, w, h, 8, "rgba(8,12,20,0.86)");
  strokeRoundRect(ctx, x, y, w, h, 8, hexA(GOLD, 0.8), 2);
  drawText(ctx, {
    x, y: y + 8, w, align: "center",
    text: (input.turnLabel ?? "TURN").toUpperCase(), size: 18, weight: 900, fill: hex(GOLD),
  });

  // Phase chips.
  const phases: CardClashInput["phase"][] = ["draw", "main", "battle", "end"];
  const cw = w / phases.length;
  phases.forEach((p, i) => {
    const active = (input.phase ?? "battle") === p;
    drawText(ctx, {
      x: x + i * cw, y: y + h + 8, w: cw, align: "center",
      text: (p ?? "").toUpperCase(), size: 12, weight: active ? 900 : 700,
      fill: active ? "#ffffff" : "rgba(200,214,238,0.45)",
    });
  });
}

// ── The two featured cards ───────────────────────────────────────────────────

function drawFeatureCard(
  ctx: Ctx, cx: number, cy: number, f: ClashFighter, art: CanvasImage | null,
  color: number, side: 0 | 1, struck: number, input: CardClashInput, t: number,
): void {
  const w = CARD.w, h = CARD.h;
  const x = cx - w / 2 + (struck > 0 ? (side === 0 ? -1 : 1) * struck * 12 : 0);
  const y = cy - h / 2;

  // Glow behind the acting card.
  if (input.actingSide === side) {
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.shadowColor = hexA(color, 0.95);
    ctx.shadowBlur = 46;
    fillRoundRect(ctx, x, y, w, h, 16, hexA(color, 0.25));
    ctx.restore();
  }

  // Frame + art window.
  fillRoundRect(ctx, x, y, w, h, 16, "rgba(6,10,18,0.95)");
  strokeRoundRect(ctx, x, y, w, h, 16, hexA(color, 0.95), 3);

  const pad = 14;
  const ax = x + pad, ay = y + 44, aw = w - pad * 2, ah = h - 44 - 74;
  ctx.save();
  roundRectPath(ctx, ax, ay, aw, ah, 8);
  ctx.clip();
  ctx.fillStyle = "#0a1120";
  ctx.fillRect(ax, ay, aw, ah);
  if (art) {
    const c = cover(art.width, art.height, aw, ah);
    ctx.drawImage(art as never, ax + c.dx, ay + c.dy, c.dw, c.dh);
  } else {
    drawText(ctx, {
      x: ax, y: ay + ah / 2 - 26, w: aw, align: "center",
      text: (f.name[0] || "?").toUpperCase(), size: 62, weight: 900, fill: hexA(color, 0.85),
    });
  }
  // White flash on the struck card.
  if (struck > 0.01) {
    ctx.globalAlpha = 0.62 * struck;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(ax, ay, aw, ah);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  strokeRoundRect(ctx, ax, ay, aw, ah, 8, "rgba(255,255,255,0.14)", 1);

  // Name bar.
  drawText(ctx, {
    x: x + 14, y: y + 14, w: w - 28, align: "left",
    text: ellipsize(ctx, f.name.toUpperCase(), w - 60, 19), size: 19, weight: 900, fill: "#f4f8ff",
  });
  drawText(ctx, {
    x: x + 14, y: y + 14, w: w - 28, align: "right",
    text: (f.rarity || "").slice(0, 2).toUpperCase(), size: 15, weight: 900, fill: hex(GOLD),
  });

  // Footer row: rarity pips on the left, the power readout on the right.
  const stars = Math.max(0, Math.min(5, f.stars ?? 0));
  for (let i = 0; i < stars; i++) {
    drawStar(ctx, x + 24 + i * 22, y + h - 58, 5, 4, 8, hex(GOLD), 0.95);
  }
  if (f.power != null) {
    drawText(ctx, {
      x: x + 14, y: y + h - 72, w: w - 28, align: "right",
      text: f.power.toLocaleString(), size: 24, weight: 900, fill: hex(color),
    });
  }

  // Meters: HP (with drain ghost), energy, ultimate.
  const mx = x + 14, mw = w - 28;
  const my = y + h - 20;
  drawMeter(ctx, mx, my, mw, 8, f.hp / Math.max(1, f.maxHp),
    f.hpBefore != null ? f.hpBefore / Math.max(1, f.maxHp) : undefined, hex(color), t);
  // Energy / ultimate slivers just above the frame edge.
  if (f.energy != null) drawMeter(ctx, mx, y + h - 34, mw * 0.48, 5, f.energy / 100, undefined, "#4fc3f7", t);
  if (f.ultimate != null) drawMeter(ctx, mx + mw * 0.52, y + h - 34, mw * 0.48, 5, f.ultimate / 100, undefined, hex(GOLD), t);
}

function drawMeter(
  ctx: Ctx, x: number, y: number, w: number, h: number,
  frac: number, ghost: number | undefined, color: string, t: number,
): void {
  fillRoundRect(ctx, x, y, w, h, h / 2, "rgba(255,255,255,0.10)");
  if (ghost != null && ghost > frac) {
    // The pre-hit level drains away across the frame — reads as damage taken.
    const g = lerp(ghost, frac, clamp01((t - 0.44) / 0.4));
    fillRoundRect(ctx, x, y, Math.max(2, w * clamp01(g)), h, h / 2, "rgba(255,90,90,0.75)");
  }
  if (frac > 0) fillRoundRect(ctx, x, y, Math.max(2, w * clamp01(frac)), h, h / 2, color);
}

// ── Rails: battle log (left) and battle info (right) ─────────────────────────

function drawBattleLog(ctx: Ctx, input: CardClashInput): void {
  const lines = (input.log ?? []).slice(-9);
  if (!lines.length) return;
  const x = RAIL.leftX, y = RAIL.y, w = RAIL.w, h = 34 + lines.length * 22;
  fillRoundRect(ctx, x, y, w, h, 10, "rgba(6,10,18,0.80)");
  strokeRoundRect(ctx, x, y, w, h, 10, hexA(BLUE, 0.55), 2);
  drawText(ctx, { x: x + 12, y: y + 10, text: "BATTLE LOG", size: 13, weight: 900, fill: hex(BLUE) });
  lines.forEach((line, i) => {
    drawText(ctx, {
      x: x + 12, y: y + 34 + i * 22, w: w - 24, align: "left",
      text: ellipsize(ctx, stripMd(line), w - 24, 12, 600), size: 12, weight: 600, fill: "rgba(226,236,252,0.92)",
    });
  });
}

function drawSideInfo(ctx: Ctx, input: CardClashInput): void {
  const x = RAIL.rightX, y = RAIL.y, w = RAIL.w, h = 96;
  fillRoundRect(ctx, x, y, w, h, 10, "rgba(6,10,18,0.80)");
  strokeRoundRect(ctx, x, y, w, h, 10, hexA(RED, 0.55), 2);
  drawText(ctx, { x: x + 12, y: y + 10, text: "BATTLE INFO", size: 13, weight: 900, fill: hex(RED) });
  drawText(ctx, {
    x: x + 12, y: y + 36, w: w - 24, align: "left",
    text: ellipsize(ctx, `Arena: ${input.arenaName ?? "Siege Grounds"}`, w - 24, 12, 600),
    size: 12, weight: 600, fill: "rgba(226,236,252,0.9)",
  });
  drawText(ctx, {
    x: x + 12, y: y + 58, w: w - 24, align: "left",
    text: input.ko ? "A card has fallen" : input.isCrit ? "Critical hit!" : "Engagement in progress",
    size: 12, weight: 600, fill: "rgba(226,236,252,0.72)",
  });
}

// ── The hand of Siege Battle Cards ───────────────────────────────────────────

function drawHand(ctx: Ctx, input: CardClashInput, a: ClashAssets, t: number): void {
  const hand = input.hand ?? [];
  if (!hand.length) return;
  const cw = HAND.cw, ch = HAND.ch, gap = HAND.gap;
  const total = hand.length * cw + (hand.length - 1) * gap;
  const startX = (FIELD.width - total) / 2;
  const baseY = HAND.y;

  hand.forEach((card, i) => {
    const lift = card.playing ? 16 + Math.sin(t * Math.PI) * 10 : 0;
    const x = startX + i * (cw + gap);
    const y = baseY - lift;

    ctx.save();
    if (card.disabled) ctx.globalAlpha = 0.42;

    if (card.playing) {
      ctx.shadowColor = hexA(GOLD, 0.95);
      ctx.shadowBlur = 28;
    }
    const frame = a.frames[card.color] ?? null;
    if (frame) {
      ctx.drawImage(frame as never, x, y, cw, ch);
    } else {
      fillRoundRect(ctx, x, y, cw, ch, 8, "rgba(10,15,26,0.95)");
      strokeRoundRect(ctx, x, y, cw, ch, 8, hexA(cardColor(card.color), 0.9), 2);
    }
    ctx.shadowBlur = 0;

    // Title + cost + blurb inside the frame's inner window.
    const inner = cw - 44;                 // the frame art's usable window
    drawText(ctx, {
      x: x + 22, y: y + 38, w: cw - 44, align: "center",
      text: ellipsize(ctx, card.name.toUpperCase(), inner, 10), size: 10, weight: 900, fill: "#f4f8ff",
    });
    drawSchoolBadge(ctx, x + cw / 2, y + ch / 2 + 2, cardColor(card.color));
    drawWrapped(ctx, card.description, x + 22, y + ch - 56, inner, 11, 3,
      { size: 9, weight: 600, fill: "rgba(220,232,250,0.88)" });

    // Energy cost pip, top-left.
    ctx.beginPath();
    ctx.arc(x + 18, y + 18, 12, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(8,12,20,0.92)";
    ctx.fill();
    ctx.strokeStyle = hexA(GOLD, 0.9); ctx.lineWidth = 2; ctx.stroke();
    drawText(ctx, {
      x: x + 6, y: y + 11, w: 24, align: "center",
      text: String(card.energyCost), size: 13, weight: 900, fill: hex(GOLD),
    });

    ctx.restore();
  });
}

function drawEnergyMeter(ctx: Ctx, input: CardClashInput): void {
  const e = input.energy;
  if (!e) return;
  const x = 16, y = HAND.y + 8, w = 200, h = 74;
  fillRoundRect(ctx, x, y, w, h, 10, "rgba(6,10,18,0.82)");
  strokeRoundRect(ctx, x, y, w, h, 10, hexA(BLUE, 0.6), 2);
  drawText(ctx, { x: x + 14, y: y + 10, text: "ENERGY", size: 12, weight: 900, fill: hex(BLUE) });
  drawText(ctx, { x: x + 14, y: y + 28, text: `${e.current} / ${e.max}`, size: 24, weight: 900, fill: "#f2f6ff" });
  // Pips.
  const pips = Math.min(8, e.max);
  for (let i = 0; i < pips; i++) {
    const filled = i < Math.round((e.current / Math.max(1, e.max)) * pips);
    const px = x + 14 + i * 22, py = y + 58;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = filled ? hex(BLUE) : "rgba(255,255,255,0.14)";
    ctx.fillRect(-6, -6, 12, 12);
    ctx.restore();
  }
}

function drawKoStamp(ctx: Ctx, cx: number, k: number): void {
  const pop = lerp(1.45, 1.0, easeOutBack(clamp01(k * 1.2)));
  ctx.save();
  ctx.globalAlpha = Math.min(1, k * 1.7);
  ctx.translate(cx, CARD.cy);
  ctx.rotate(-0.18);
  ctx.scale(pop, pop);
  // Dark punch plate behind the stamp so it reads over busy impact FX.
  fillRoundRect(ctx, -170, -42, 340, 78, 10, "rgba(8,6,10,0.72)");
  strokeRoundRect(ctx, -170, -42, 340, 78, 10, hexA(RED, 0.95), 3);
  drawText(ctx, {
    x: -160, y: -28, w: 320, align: "center", text: "DESTROYED",
    size: 48, weight: 900, fill: "#ff5a5a", shadow: "rgba(0,0,0,0.95)", shadowBlur: 16,
  });
  ctx.restore();
}

/**
 * The school mark on a hand card: a filled diamond over a soft disc, tinted to
 * the card's school.
 */
function drawSchoolBadge(ctx: Ctx, cx: number, cy: number, color: number): void {
  ctx.save();
  const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, 26);
  g.addColorStop(0, hexA(color, 0.55));
  g.addColorStop(1, hexA(color, 0));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, 26, 0, Math.PI * 2); ctx.fill();

  ctx.translate(cx, cy);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = hexA(color, 0.95);
  ctx.fillRect(-11, -11, 22, 22);
  ctx.strokeStyle = "rgba(255,255,255,0.75)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-11, -11); ctx.lineTo(11, -11); ctx.lineTo(11, 11); ctx.lineTo(-11, 11);
  ctx.closePath(); ctx.stroke();
  ctx.restore();
}

/** Word-wrap a blurb into at most `maxLines` lines, ellipsising the last one. */
function drawWrapped(
  ctx: Ctx, text: string, x: number, y: number, w: number, lineH: number,
  maxLines: number, style: { size: number; weight: number; fill: string },
): void {
  ctx.save();
  ctx.font = `${style.weight} ${style.size}px "${TITLE_FONT_FAMILY}"`;
  // Greedily wrap into ALL the lines the text needs, then keep the first
  // maxLines. Doing the wrap in full (rather than breaking early) is what lets
  // the last shown line ellipsise honestly when the blurb overflows.
  const words = text.split(/\s+/).filter(Boolean);
  const all: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= w) { line = next; continue; }
    if (line) all.push(line);
    line = word;
  }
  if (line) all.push(line);
  ctx.restore();
  const shown = all.slice(0, maxLines);
  const truncated = all.length > maxLines;
  shown.forEach((l, i) => {
    const isLast = i === shown.length - 1;
    drawText(ctx, {
      x, y: y + i * lineH, w, align: "center",
      // The last visible line carries an ellipsis only when text was dropped.
      text: isLast && truncated ? ellipsize(ctx, `${l}…`, w, style.size, style.weight) : l,
      size: style.size, weight: style.weight, fill: style.fill,
    });
  });
}

// ── Small drawing helpers (kept local, mirroring siege-field.ts) ─────────────

const hex = (n: number) => `#${(n & 0xffffff).toString(16).padStart(6, "0")}`;
function hexA(n: number, a: number): string {
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${clamp01(a)})`;
}
function cardColor(c: string): number {
  return ({ red: RED, blue: BLUE, green: 0x49c17a, yellow: GOLD, purple: 0x9b6bd6 } as Record<string, number>)[c] ?? GOLD;
}
function stripMd(s: string): string {
  return s.replace(/\*\*/g, "").replace(/~~/g, "");
}
function vGradient(ctx: Ctx, x0: number, y0: number, y1: number, stops: [number, string][]) {
  const g = ctx.createLinearGradient(x0, y0, x0, y1);
  for (const [at, c] of stops) g.addColorStop(at, c);
  return g;
}
function roundRectPath(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
function fillRoundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, fill: string): void {
  roundRectPath(ctx, x, y, w, h, r); ctx.fillStyle = fill; ctx.fill();
}
function strokeRoundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, stroke: string, lw: number): void {
  roundRectPath(ctx, x, y, w, h, r); ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke();
}
function drawStar(ctx: Ctx, x: number, y: number, pts: number, inner: number, outer: number, fill: string, alpha: number): void {
  ctx.save(); ctx.globalAlpha = alpha; ctx.fillStyle = fill; ctx.beginPath();
  const step = Math.PI / pts;
  for (let i = 0; i < pts * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const ang = i * step - Math.PI / 2;
    const sx = x + Math.cos(ang) * r, sy = y + Math.sin(ang) * r;
    if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
  }
  ctx.closePath(); ctx.fill(); ctx.restore();
}

interface TextOpts {
  x: number; y: number; text: string; size: number; fill: string;
  w?: number; align?: "left" | "right" | "center";
  weight?: number; alpha?: number; shadow?: string; shadowBlur?: number;
  xOverride?: number;
}
function drawText(ctx: Ctx, o: TextOpts): void {
  ctx.save();
  ctx.globalAlpha = o.alpha ?? 1;
  ctx.fillStyle = o.fill;
  ctx.font = `${o.weight ?? 700} ${o.size}px "${TITLE_FONT_FAMILY}"`;
  ctx.textBaseline = "top";
  const align = o.align ?? "left";
  ctx.textAlign = align;
  if (o.shadow) { ctx.shadowColor = o.shadow; ctx.shadowBlur = o.shadowBlur ?? 0; }
  let x = o.xOverride ?? o.x;
  if (o.xOverride == null && o.w != null) {
    if (align === "center") x = o.x + o.w / 2;
    else if (align === "right") x = o.x + o.w;
  }
  ctx.fillText(safeText(o.text), x, o.y);
  ctx.restore();
}
/**
 * Trim `text` to fit `w`. The measurement MUST happen in the font the text will
 * actually be drawn in, so callers pass the size/weight they are about to use —
 * measuring in a stale font is what silently clipped hand-card titles mid-word.
 */
function ellipsize(ctx: Ctx, text: string, w: number, size?: number, weight = 900): string {
  const t = safeText(text);
  ctx.save();
  if (size != null) ctx.font = `${weight} ${size}px "${TITLE_FONT_FAMILY}"`;
  const fits = ctx.measureText(t).width <= w;
  let out = t;
  if (!fits) {
    while (out.length > 1 && ctx.measureText(`${out}…`).width > w) out = out.slice(0, -1);
    out = `${out}…`;
  }
  ctx.restore();
  return out;
}

/** Collapse spacing. Emoji and symbols stay for the shared canvas font fallback. */
function safeText(s: string): string {
  return s.replace(/\s{2,}/g, " ").trim();
}
function cover(iw: number, ih: number, w: number, h: number): { dw: number; dh: number; dx: number; dy: number } {
  if (!iw || !ih) return { dw: w, dh: h, dx: 0, dy: 0 };
  const s = Math.max(w / iw, h / ih);
  const dw = iw * s, dh = ih * s;
  return { dw, dh, dx: (w - dw) / 2, dy: (h - dh) / 2 };
}
