// Animated battle turn / victory renderer.
// Generates GIFs for combat turns (attack, projectile, hit, damage, HP bars) and
// a separate victory flourish. The caller decides when to attach them to Discord.

import type { RenderCard } from "../battle/image/render.js";
import type { BattleAnimationInput, VictoryAnimationInput, AnimationSpeed, AnimationResult } from "./types.js";
import {
  encodeAnimation, BATTLE_CANVAS, lerp, easeOutBack, easeInOutCubic, clamp01,
  hexToRgba, drawGradientBackground, roundRectPath, getCanvas, type CanvasMod, type Ctx,
} from "./engine.js";
import {
  createBurst, drawParticles, drawDamageNumber, drawHealthBar,
  drawScreenFlash, drawRarityGlow, drawCardArt, drawCardFrame, drawRarityBadge,
  drawTextWithShadow, fitText, getRarityEffectColor,
} from "./effects.js";
import { drawAtmosphere, atmospherePreset } from "./atmosphere.js";
import { drawImageBackground } from "./arena-bg.js";
import { warmCanvasText } from "../unbelievaboat/canvas-emoji-text.js";
import { drawImpactDebris, physicsShake } from "./physics.js";
import { extractArtColor } from "../battle/image/vibrant-color.js";
import { stampCardAccent } from "../battle/frame-color.js";
import { applyRarityAccent } from "./card-frames.js";

// ── Encode tuning (animated fight) ───────────────────────────────────────────
// GIF encoding dominates the cost of an animated turn, and it scales with the
// PIXEL COUNT of the encoded frames (NeuQuant builds a palette and then maps
// every pixel through it, per frame). Measured on this renderer, one turn at the
// old 0.78 render scale spent ~2.3s of its ~4s inside the encoder alone.
//
// Two levers, both applied here:
//   • RENDER_SCALE — physical pixels per logical unit. 0.60 keeps the battle
//     canvas comfortably above Discord's inline display width while cutting
//     encoded pixels (and therefore encode time) to roughly a third.
//   • QUALITY — gifencoder's NeuQuant *sample factor*: HIGHER means the palette
//     is trained on fewer sampled pixels, so it is both faster and coarser.
//     Counter-intuitively the old value of 15 was the slowest setting in the
//     range; 26 is markedly faster and visually near-identical on these busy,
//     motion-heavy frames.
// Frame counts come down a little too — every frame costs both a draw and an
// encode pass.
const RENDER_SCALE = 0.6;
const IDLE_RENDER_SCALE = 0.56;
const QUALITY = 26;

// Vibrant colour extraction loads + quantizes the art, so resolve it once per
// combatant up-front rather than on every frame. Falls back to the card's
// rarity colour when extraction yields nothing.
async function resolveColor(card: RenderCard): Promise<number> {
  if (card.framePaint && card.rarityColor != null) return card.rarityColor;
  const stamped = await stampCardAccent(card);
  if (stamped.frameMode && stamped.rarityColor != null) return stamped.rarityColor;
  return (await extractArtColor(card.artUrl)) ?? card.rarityColor ?? getRarityEffectColor(card.rarity);
}

async function stampPair(a: RenderCard, b: RenderCard): Promise<[RenderCard, RenderCard]> {
  const [left, right] = await Promise.all([stampCardAccent(a), stampCardAccent(b)]);
  return [applyRarityAccent(left), applyRarityAccent(right)];
}

export async function renderBattleTurn(
  input: BattleAnimationInput,
  speed: AnimationSpeed,
): Promise<AnimationResult | null> {
  const [attacker, defender] = await stampPair(input.attacker, input.defender);
  const stamped = { ...input, attacker, defender };
  const [colorA, colorB] = await Promise.all([
    resolveColor(attacker),
    resolveColor(defender),
  ]);
  await warmFighterText([attacker, defender, input.moveName]);
  return encodeAnimation({
    width: BATTLE_CANVAS.width,
    height: BATTLE_CANVAS.height,
    speed,
    durationMs: 1800,
    maxFrames: 18,
    quality: QUALITY,
    renderScale: RENDER_SCALE,
    render: (frame) => renderBattleTurnFrame(frame, stamped, colorA, colorB),
  });
}

export async function renderBattleVictory(
  input: VictoryAnimationInput,
  speed: AnimationSpeed,
): Promise<AnimationResult | null> {
  const [winner, loser] = await stampPair(input.winner, input.loser);
  const stamped = { ...input, winner, loser };
  const [colorA, colorB] = await Promise.all([
    resolveColor(winner),
    resolveColor(loser),
  ]);
  await warmFighterText([winner, loser]);
  return encodeAnimation({
    width: BATTLE_CANVAS.width,
    height: BATTLE_CANVAS.height,
    speed,
    durationMs: 2000,
    maxFrames: 20,
    quality: QUALITY,
    renderScale: RENDER_SCALE,
    render: (frame) => renderVictoryFrame(frame, stamped, colorA, colorB),
  });
}

// A light looping "idle" scene shown BETWEEN turns: both cards stand and
// breathe over the animated arena, HP bars steady. Discord loops the GIF, so the
// battlefield stays alive while waiting for the next move. Cheap: few frames,
// no combat FX.
export async function renderBattleIdle(
  input: BattleAnimationInput,
  speed: AnimationSpeed,
): Promise<AnimationResult | null> {
  const [attacker, defender] = await stampPair(input.attacker, input.defender);
  const stamped = { ...input, attacker, defender };
  const [colorA, colorB] = await Promise.all([
    resolveColor(attacker),
    resolveColor(defender),
  ]);
  await warmFighterText([attacker, defender]);
  return encodeAnimation({
    width: BATTLE_CANVAS.width,
    height: BATTLE_CANVAS.height,
    speed,
    durationMs: 1600,
    maxFrames: 12,
    quality: QUALITY,
    renderScale: IDLE_RENDER_SCALE,
    render: (frame) => renderBattleIdleFrame(frame, stamped, colorA, colorB),
  });
}

async function renderBattleIdleFrame(
  frame: import("./engine.js").FrameCtx,
  input: BattleAnimationInput,
  colorA: number,
  colorB: number,
): Promise<void> {
  const { ctx, t, mod } = frame;
  const { width, height } = BATTLE_CANVAS;
  await drawBattleBackground(ctx, mod, width, height, colorA, colorB, t, `${input.attacker.name}-idle`, input.backgroundImage);

  const left = { x: 70, y: 45, w: 340, h: 470 };
  const right = { x: 590, y: 45, w: 340, h: 470 };
  const cx = width / 2, cy = height / 2;

  // Gentle out-of-phase vertical breathing so the fighters feel alive.
  const bobA = Math.sin(t * Math.PI * 2) * 6;
  const bobB = Math.sin(t * Math.PI * 2 + Math.PI) * 6;
  await drawBattleCard(ctx, mod, left.x, left.y + bobA, left.w, left.h, input.attacker, colorA);
  await drawBattleCard(ctx, mod, right.x, right.y + bobB, right.w, right.h, input.defender, colorB);

  const barW = 320, barH = 18;
  drawHealthBar(ctx, left.x + 10, left.y + left.h + 18, barW, barH, input.attackerHp, input.attackerMaxHp, colorA, 1, input.attackerHp);
  drawHealthBar(ctx, right.x + 10, right.y + right.h + 18, barW, barH, input.defenderHp, input.defenderMaxHp, colorB, 1, input.defenderHp);
  drawTextWithShadow(ctx, "VS", cx, cy, "#ffcc33", 80);
}

async function renderBattleTurnFrame(
  frame: import("./engine.js").FrameCtx,
  input: BattleAnimationInput,
  colorA: number,
  colorB: number,
): Promise<void> {
  const { ctx, t, mod } = frame;
  const { width, height } = BATTLE_CANVAS;

  // Draw the battlefield background + advancing arena atmosphere (behind cards).
  await drawBattleBackground(ctx, mod, width, height, colorA, colorB, t, `${input.attacker.name}-turn`, input.backgroundImage);

  const left = { x: 70, y: 45, w: 340, h: 470 };
  const right = { x: 590, y: 45, w: 340, h: 470 };
  const cx = width / 2, cy = height / 2;

  // Phase timing: 0-0.2 idle, 0.2-0.4 lunge, 0.4-0.55 projectile/hit, 0.55-1.0 aftermath
  const lungeT = clamp01((t - 0.20) / 0.20);
  const hitT = clamp01((t - 0.40) / 0.15);
  const afterT = clamp01((t - 0.55) / 0.45);

  // Physics screen-shake on the moment of impact — a kicked spring that overshoots
  // and settles. Applied to the combat subjects only (not the background), so the
  // arena stays framed while the fighters jolt. Zero offset outside the hit window.
  const shake = input.isHit && hitT > 0 && hitT < 1
    ? await physicsShake(input.isCrit ? 14 : 8, hitT, `${input.attacker.name}-hit`)
    : { dx: 0, dy: 0 };
  ctx.save();
  ctx.translate(shake.dx, shake.dy);

  // Attacker lunge.
  const attackerOffset = lungeT < 1 ? lerp(0, 120, easeInOutCubic(lungeT)) : lerp(120, 0, easeInOutCubic(afterT));
  const attackerRecoil = input.isHit && hitT > 0 ? lerp(0, 15, easeOutBack(hitT)) : 0;
  const attackerX = left.x + attackerOffset - attackerRecoil;

  // Defender recoil when hit.
  const defenderRecoil = input.isHit && hitT > 0 ? lerp(0, 40, easeOutBack(hitT)) : 0;
  const defenderX = right.x + defenderRecoil;

  // Draw cards.
  await drawBattleCard(ctx, mod, attackerX, left.y, left.w, left.h, input.attacker, colorA);
  await drawBattleCard(ctx, mod, defenderX, right.y, right.w, right.h, input.defender, colorB);

  // Move name banner above attacker.
  drawTextWithShadow(ctx, input.moveName, attackerX + left.w / 2, left.y - 22, "#ffcc33", 22);

  // Projectile / hit flash.
  if (input.isHit && lungeT >= 1 && hitT > 0 && hitT < 1) {
    const px = lerp(attackerX + left.w, defenderX, hitT);
    const py = cy;
    const size = 8 + hitT * 24;
    ctx.save();
    ctx.fillStyle = hexToRgba(colorA, 1 - hitT * 0.5);
    ctx.beginPath();
    ctx.arc(px, py, size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Hit flash.
  if (input.isHit && hitT > 0 && hitT < 0.6) {
    drawScreenFlash(ctx, width, height, hitT / 0.6, colorA);
  }

  // Damage number.
  if (input.isHit && hitT > 0) {
    drawDamageNumber(ctx, input.damage, defenderX + right.w / 2, right.y + 60, hitT, input.isCrit);
  } else if (!input.isHit && hitT > 0) {
    drawDamageNumber(ctx, 0, defenderX + right.w / 2, right.y + 60, hitT, false, true);
  }

  // Burst on hit.
  let particles = createBurst(0, 0, 0, 0); // dummy
  if (input.isHit && hitT > 0 && hitT < 1) {
    const burst = createBurst(defenderX + right.w / 2, right.y + right.h / 2, colorA, input.isCrit ? 80 : 45, 160);
    for (let i = 0; i < burst.length; i++) {
      burst[i]!.x += burst[i]!.vx * hitT * 10;
      burst[i]!.y += burst[i]!.vy * hitT * 10;
    }
    particles = burst;
  }
  drawParticles(ctx, particles);

  // Physics debris shards flung from the point of impact — heavier on a crit.
  if (input.isHit && hitT > 0 && hitT < 1) {
    await drawImpactDebris(ctx, defenderX + right.w / 2, right.y + right.h / 2, {
      color: colorA, count: input.isCrit ? 26 : 14, power: input.isCrit ? 15 : 10,
      steps: Math.max(2, Math.round(hitT * 16)), seed: `${input.attacker.name}-shard`,
    });
  }

  // End of the shaken combat group — HP bars + VS stay steady (UI, not subjects).
  ctx.restore();

  // Health bars.
  const barW = 320, barH = 18;
  drawHealthBar(ctx, left.x + 10, left.y + left.h + 18, barW, barH, input.attackerHp, input.attackerMaxHp, colorA, 1, input.attackerHp);
  drawHealthBar(ctx, defenderX + 10, right.y + right.h + 18, barW, barH, input.defenderHp, input.defenderMaxHp, colorB, afterT, input.defenderHp + input.damage);

  // VS badge.
  drawTextWithShadow(ctx, "VS", cx, cy, "#ffcc33", 80);
}

async function renderVictoryFrame(
  frame: import("./engine.js").FrameCtx,
  input: VictoryAnimationInput,
  colorA: number,
  colorB: number,
): Promise<void> {
  const { ctx, t, mod } = frame;
  const { width, height } = BATTLE_CANVAS;
  await drawBattleBackground(ctx, mod, width, height, colorA, colorB, t, `${input.winner.name}-win`, input.backgroundImage);
  // Embers + sparks rising behind the champion (behind the card).
  drawAtmosphere(ctx, width, height, atmospherePreset("ember"), { seed: `${input.winner.name}-victory`, t, color: colorA });

  const winnerBox = { x: 220, y: 50, w: 420, h: 440 };
  const scale = 0.9 + 0.1 * Math.sin(t * Math.PI * 4);
  ctx.save();
  ctx.translate(winnerBox.x + winnerBox.w / 2, winnerBox.y + winnerBox.h / 2);
  ctx.scale(scale, scale);
  ctx.translate(-winnerBox.w / 2, -winnerBox.h / 2);
  await drawBattleCard(ctx, mod, winnerBox.x, winnerBox.y, winnerBox.w, winnerBox.h, input.winner, colorA);
  ctx.restore();

  // Victory banner.
  drawTextWithShadow(ctx, "VICTORY", width / 2, 38, "#ffd700", 42);

  // Confetti burst at the start.
  let particles: import("./effects.js").Particle[] = [];
  if (t < 0.6) {
    particles = createBurst(width / 2, height / 2, colorA, 160, 280);
    for (const p of particles) {
      p.x += p.vx * t * 15;
      p.y += p.vy * t * 15;
      p.life = 1 - t / 0.6;
    }
  }
  drawParticles(ctx, particles);
}

async function warmFighterText(parts: Array<import("../battle/image/render.js").RenderCard | string | null | undefined>): Promise<void> {
  const mod = await getCanvas();
  if (!mod) return;
  const texts: Array<string | null | undefined> = [];
  for (const part of parts) {
    if (!part) continue;
    if (typeof part === "string") { texts.push(part); continue; }
    texts.push(part.name, part.series, part.rarityLabel, part.special, part.accentEmoji);
  }
  await warmCanvasText(mod, texts);
}

async function drawBattleBackground(
  ctx: Ctx,
  mod: CanvasMod,
  width: number, height: number,
  colorA: number, colorB: number,
  t: number,
  seed: string,
  backgroundImage?: Buffer | string | null,
): Promise<void> {
  // An admin-uploaded image (or the siege castle) is the backdrop. When it
  // cannot be decoded, the fight keeps the gradient.
  if (await drawImageBackground(ctx, mod, backgroundImage, width, height)) {
    drawAtmosphere(ctx, width, height, atmospherePreset("battlefield"), { seed, t, color: colorA, density: 0.4 });
    return;
  }

  drawGradientBackground(ctx, width, height, [
    [0, hexToRgba(colorA, 0.22)],
    [0.5, "#0b1622"],
    [1, hexToRgba(colorB, 0.22)],
  ], 0.2);
  // Diagonal split tint.
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(width, height); ctx.lineTo(width, 0); ctx.closePath();
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.fill();
  ctx.restore();
  // Living arena: dust/fog/spark ambience that advances with the frame phase and
  // loops seamlessly. Behind the cards, drawn before any combatant.
  drawAtmosphere(ctx, width, height, atmospherePreset("battlefield"), { seed, t, color: colorA });
}

async function drawBattleCard(
  ctx: Ctx,
  mod: CanvasMod,
  x: number, y: number, w: number, h: number,
  card: RenderCard,
  vibrantColor: number,
): Promise<void> {
  const color = card.rarityColor ?? getRarityEffectColor(card.rarity);
  drawRarityGlow(ctx, x, y, w, h, color, 0.6);
  await drawCardArt(ctx, mod, x + 8, y + 8, w - 16, h - 16, card.artUrl, card.rarity, card.progTier);
  drawCardFrame(ctx, x, y, w, h, color, 7, card.rarity, card.progTier, card.framePaint, card.blendA, card.blendB);
  if (card.rarity === "legendary" || card.rarity === "mythic") {
    drawRarityGlow(ctx, x, y, w, h, color, 0.3);
  }
  drawRarityBadge(ctx, x + w - 20, y + 16, card.rarityLabel, color);
  if (card.level) {
    ctx.fillStyle = "rgba(245,245,245,0.92)";
    roundRectPath(ctx, x + 16, y + 16, 42, 34, 6);
    ctx.fill();
    drawTextWithShadow(ctx, String(card.level), x + 37, y + 33, "#111111", 20);
  }
  drawTextWithShadow(ctx, card.name, x + w / 2, y + h - 22, "#ffffff", fitText(ctx, card.name, w - 24, 24));
}

