// ─────────────────────────────────────────────────────────────────────────────
// HQ siege — the primary Siege Battle field.
//
// The LARGE battle screen for HQ / outpost assaults: a 1200×800 arena with ONE
// horizontal battle line per side — flat 2-D framed cards (DN card frames),
// blue LEFT vs red RIGHT:
//
//   [1] [2] [3] [4]   VS   [1] [2] [3] [4]
//
// No podium stands, no front/back ranks. The acting card slides horizontally
// toward the center on a strike, then returns to its exact line slot. Card art
// keeps its aspect ratio inside the frame window (never stretched).
//
// Same renderer seam as /battle: `@napi-rs/canvas` + shared `encodeAnimation`.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spriteForPrefix } from "../hq/assets.js";
import { queueRender } from "./render-queue.js";
import { getRarityEffectColor, loadArt as loadArtShared, createBurst, drawParticles, drawDamageNumber, drawScreenFlash } from "./effects.js";
import { drawAtmosphere, atmospherePreset } from "./atmosphere.js";
import { drawImpactDebris, physicsShake } from "./physics.js";
import { FRAME_INSET } from "./card-frames.js";
import { extractArtColor } from "../battle/image/vibrant-color.js";
import { encodeAnimation, getCanvas, TITLE_FONT_FAMILY, easeInOutCubic, easeOutBack, type CanvasMod, type Ctx } from "./engine.js";
import type { Rarity } from "../cards-data.js";
import type { AnimationSpeed, AnimationResult } from "./types.js";
import { logger } from "../../lib/logger.js";

type CanvasImage = Awaited<ReturnType<CanvasMod["loadImage"]>>;

// ── Public input ─────────────────────────────────────────────────────────────

export interface SiegeFieldFighter {
  name: string;
  artUrl: string | null;
  rarity: string;
  rarityColor: number | null;   // custom tier colour override
  hp: number;                   // AFTER the move resolves
  maxHp: number;
  hpBefore?: number;            // BEFORE the move (drives the HP-drain animation)
  energy?: number;              // 0..100
  ultimate?: number;            // 0..100
}

// A non-active card in a side's column — drawn as a small standee lining up
// behind the active fighter, so the 1-v-1 gauntlet reads as a full roster.
export interface SiegeFieldBenchCard {
  artUrl: string | null;
  rarity: string;
  rarityColor: number | null;
  fallen: boolean;              // already KO'd (dim + ✗) vs still to step up
}

// One card in a side's battle line — flat framed card on the horizontal rank.
export interface SiegeFieldLineupCard {
  name: string;
  artUrl: string | null;
  rarity: string;
  rarityColor: number | null;
  hp: number;                   // AFTER the move
  maxHp: number;
  hpBefore?: number;            // BEFORE the move — only set on the struck FOCUS card
  energy?: number;
  fallen: boolean;              // KO'd — dim + broken
  active: boolean;              // acting card this beat (drives the slide)
  struck?: boolean;             // took this turn's blow (white flash + knockback)
}

export interface SiegeFieldInput {
  attacker: SiegeFieldFighter;   // side 0 — stands on the LEFT (the acting/target pair)
  defender: SiegeFieldFighter;   // side 1 — stands on the RIGHT
  actingSide: 0 | 1;             // who dashes and strikes this turn
  moveName: string;
  damage: number;
  isHit: boolean;
  isCrit: boolean;
  ko: boolean;                   // did the target fall?
  accent: number;                // siege accent colour
  turnLabel?: string | null;     // e.g. "Turn 4"
  /** Current Siege phase chip — drives the cinematic overlay, not combat math. */
  phase?: "draw" | "main" | "battle" | "reinforce" | "end";
  /** Cards just drawn (DRAW cinematic). */
  drawnCards?: { name: string; emoji: string }[];
  backdropKey?: string | null;   // backdrop art key (castles/forest/desert/…)
  floorKey?: string | null;      // floor tile key (stone/marble/dirt/…)
  // The rest of each side's column, ordered "next to step up" first, then the
  // fallen — rendered as small standees behind the active fighter (legacy).
  attackerBench?: SiegeFieldBenchCard[];
  defenderBench?: SiegeFieldBenchCard[];
  // Full battle line for each side, ordered ACTIVE-first then the rest. When
  // present, the renderer draws every card on its own stand (up to 4/side) and
  // the active card slides forward to strike; the single attacker/defender above
  // are still used for the HUD life-plates. Absent → legacy single-stand look.
  attackerLineup?: SiegeFieldLineupCard[];
  defenderLineup?: SiegeFieldLineupCard[];
  aoe?: boolean;                 // team ultimate — the whole enemy line is struck
}

const FIELD = { width: 1200, height: 800 } as const;   // large primary battle screen (matches arena art)
const MAX_BYTES = 8_000_000;
// Physical pixels per logical unit at encode time. GIF encoding (NeuQuant) costs
// scale with pixel COUNT, and it dominates a turn's render time — drawing stays
// at the full logical resolution (crisp art + text) while the encoded frame is
// shrunk to keep a turn snappy. Slightly lower than /battle so the larger canvas
// still encodes in Discord's size budget.
const RENDER_SCALE = 0.55;

// ── Arena + flat card-frame config ───────────────────────────────────────────
// Arena skybox from siege-scene; cards use DN Card Frame PNGs (blue / red) —
// the same flat 2-D frame treatment as /battle, not 3-D podium stands.
const SCENE_PREFIX = "siege-scene";
const LINE_MAX = 4;
/** Flat portrait card size on the 1200×800 field — readable without zoom. */
const CARD = { w: 128, h: 178 } as const;
/** Top of the single horizontal battle line (both sides share this Y). */
const LINE_Y = 340;
const CARD_GAP = 14;
/** Open center lane between the two lines (VS / clash space). */
const CENTER_GAP = 88;
/** How far the acting card slides horizontally toward the center. */
const SLIDE_PX = 92;
const GROUND_Y = 680;

function framesDir(): string | null {
  const candidates = [
    fileURLToPath(new URL("../../../assets/frames/", import.meta.url)),
    join(process.cwd(), "artifacts/api-server/assets/frames"),
    join(process.cwd(), "assets/frames"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "DN_Card_Frame_Gold.png"))) return dir;
  }
  return null;
}

/** Slot rect for a flat card on the single horizontal line (no front/back ranks). */
function cardSlot(side: 0 | 1, index: number): { x: number; y: number; w: number; h: number } {
  const n = LINE_MAX;
  const rowW = n * CARD.w + (n - 1) * CARD_GAP;
  const leftOrigin = (FIELD.width / 2 - CENTER_GAP / 2) - rowW;
  const rightOrigin = FIELD.width / 2 + CENTER_GAP / 2;
  const origin = side === 0 ? leftOrigin : rightOrigin;
  const i = Math.max(0, Math.min(n - 1, index));
  return {
    x: origin + i * (CARD.w + CARD_GAP),
    y: LINE_Y,
    w: CARD.w,
    h: CARD.h,
  };
}

// Target play-through length by guild speed — same ballpark as renderBattleTurn
// (~1800ms) so /hq and /battle feel like one system. encodeAnimation plans fps
// + coalesces identical hold frames.
function speedDurationMs(speed: AnimationSpeed): number {
  switch (speed) {
    case "fast": return 1100;
    case "slow": return 1800;
    default: return 1400;
  }
}

function speedMaxFrames(speed: AnimationSpeed): number {
  // Keep GIFs snappy for Discord size + encode cost on the larger 1200×800 field.
  switch (speed) {
    case "fast": return 12;
    case "slow": return 16;
    default: return 14;
  }
}

// ── Small maths helpers ──────────────────────────────────────────────────────
const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function easeInOut(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}
function easeOut(x: number): number { return 1 - Math.pow(1 - x, 3); }
// A 0→1→0 pulse peaking at `mid`, used for the lunge and impact windows.
function pulse(t: number, start: number, end: number): number {
  if (t <= start || t >= end) return 0;
  const p = (t - start) / (end - start);
  return Math.sin(p * Math.PI);
}
function hex(n: number): string {
  return `#${(n & 0xffffff).toString(16).padStart(6, "0")}`;
}
// A colour with alpha, from a packed int — for glows/shadows where Konva used a
// separate shadowOpacity.
function rgba(n: number, a: number): string {
  const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  return `rgba(${r},${g},${b},${clamp01(a)})`;
}
function fighterColor(f: SiegeFighterLike): number {
  return f.rarityColor ?? getRarityEffectColor(f.rarity as Rarity);
}
type SiegeFighterLike = { rarity: string; rarityColor: number | null };
const FONT = TITLE_FONT_FAMILY; // "Orbitron", registered by the engine loader

// The active fighter's accent, themed to its actual card art. Mirrors the
// `/battle` turn renderer: the dominant colour pulled from the artwork wins, so
// the frame, glow and nameplate all read as "this specific card"; a custom
// rarity-tier colour, then the rarity effect colour, are the fallbacks. Only the
// two active fighters get this (extraction loads + quantises the art); bench
// standees stay on their rarity colour.
// Extraction loads + quantises the artwork, so remember the dominant colour per
// URL for the process — a siege re-renders the same two cards every turn, and
// without this each turn would re-fetch and re-quantise their art just for the
// accent.
const colorCache = new Map<string, number>();
async function resolveFieldColor(f: SiegeFieldFighter): Promise<number> {
  const fallback = f.rarityColor ?? getRarityEffectColor(f.rarity as Rarity);
  if (!f.artUrl) return fallback;
  const cached = colorCache.get(f.artUrl);
  if (cached !== undefined) return cached;
  const art = await extractArtColor(f.artUrl).catch(() => null);
  const color = art ?? fallback;
  colorCache.set(f.artUrl, color);
  if (colorCache.size > 256) { const k = colorCache.keys().next().value; if (k !== undefined) colorCache.delete(k); }
  return color;
}

// ── Image loading (shared, cached, timeout-guarded) ──────────────────────────
const IMG_CACHE_MAX = 96;
const imgCache = new Map<string, Promise<CanvasImage | null>>();

function loadSpritePath(mod: CanvasMod, path: string): Promise<CanvasImage | null> {
  const key = `f:${path}`;
  let p = imgCache.get(key);
  if (!p) {
    p = (async () => {
      try { return await mod.loadImage(readFileSync(path)); }
      catch (err) { logger.debug({ err, path }, "siege-field: sprite decode failed"); return null; }
    })();
    imgCache.set(key, p);
    while (imgCache.size > IMG_CACHE_MAX) {
      const oldest = imgCache.keys().next().value;
      if (oldest === undefined) break;
      imgCache.delete(oldest);
    }
  }
  return p;
}

// Card art loads through the SAME shared loader `/battle` and `/raid` use
// (effects.ts `loadArt`). That path knows how to pull a card straight from
// object storage / GCS instead of round-tripping the app's own public URL — the
// server-side fetch of its own `…/api/storage/objects/…` link is exactly what
// failed on the old siege-only loader, leaving every fighter as a blank
// placeholder box (the "missing images" a siege showed). It also owns its own
// cache + decode-from-disk workaround, so a siege that re-renders the same two
// cards every turn never re-fetches them.
function loadArt(mod: CanvasMod, url: string | null): Promise<CanvasImage | null> {
  return loadArtShared(mod, url) as Promise<CanvasImage | null>;
}

function sprite(prefix: string, key: string): string | null {
  try { return spriteForPrefix(prefix, key); } catch { return null; }
}

// ── The renderer ─────────────────────────────────────────────────────────────

// Preload every image the scene needs once, up-front, so per-frame drawing is
// pure CPU. Shared by the animated GIF and the static still.
async function loadFieldAssets(cmod: CanvasMod, input: SiegeFieldInput): Promise<Assets> {
  const arenaPath = sprite(SCENE_PREFIX, "arena");
  const backdropPath = sprite("backdrop", input.backdropKey || "castles") ?? sprite("backdrop", "grass");
  const floorPath = sprite("floor", input.floorKey || "stone") ?? sprite("floor", "blue-stone");
  const flashPath = sprite("fx", "flash01") ?? sprite("fx", "flash00");
  const smokePath = sprite("fx", "smoke00") ?? sprite("fx", "white-puff00");
  const dir = framesDir();
  const blueFramePath = dir ? join(dir, "DN_Card_Frame_Blue_256px.png") : null;
  const redFramePath = dir ? join(dir, "DN_Card_Frame_Red_256px.png") : null;
  const blueFrameFull = dir ? join(dir, "DN_Card_Frame_Blue.png") : null;
  const redFrameFull = dir ? join(dir, "DN_Card_Frame_Red.png") : null;

  const allCards = [
    ...(input.attackerLineup ?? []), ...(input.defenderLineup ?? []),
    ...(input.attackerBench ?? []), ...(input.defenderBench ?? []),
  ];
  const artUrls = [...new Set([
    input.attacker.artUrl, input.defender.artUrl, ...allCards.map(c => c.artUrl),
  ].filter((u): u is string => !!u))];

  const [arena, backdrop, floor, flash, smoke, frameBlue, frameRed, ...artLoaded] = await Promise.all([
    arenaPath ? loadSpritePath(cmod, arenaPath) : null,
    backdropPath ? loadSpritePath(cmod, backdropPath) : null,
    floorPath ? loadSpritePath(cmod, floorPath) : null,
    flashPath ? loadSpritePath(cmod, flashPath) : null,
    smokePath ? loadSpritePath(cmod, smokePath) : null,
    blueFramePath && existsSync(blueFramePath) ? loadSpritePath(cmod, blueFramePath)
      : (blueFrameFull && existsSync(blueFrameFull) ? loadSpritePath(cmod, blueFrameFull) : null),
    redFramePath && existsSync(redFramePath) ? loadSpritePath(cmod, redFramePath)
      : (redFrameFull && existsSync(redFrameFull) ? loadSpritePath(cmod, redFrameFull) : null),
    ...artUrls.map(u => loadArt(cmod, u)),
  ]);
  const artByUrl = new Map<string, CanvasImage | null>();
  artUrls.forEach((u, i) => artByUrl.set(u, artLoaded[i] ?? null));
  const artFor = (url: string | null): CanvasImage | null => (url ? artByUrl.get(url) ?? null : null);
  const atkArt = artFor(input.attacker.artUrl);
  const defArt = artFor(input.defender.artUrl);

  const [atkColor, defColor] = await Promise.all([
    resolveFieldColor(input.attacker),
    resolveFieldColor(input.defender),
  ]);
  return { arena, backdrop, floor, flash, smoke, frameBlue, frameRed, atkArt, defArt, artByUrl, atkColor, defColor };
}

// Freeze near connect so impact FX + shared damage numbers still read in static mode.
const STILL_T = 0.46;
// Stills are cheap (no encode), so render them larger/crisper than a GIF frame.
const STILL_SCALE = 0.85;

export async function renderSiegeField(
  input: SiegeFieldInput,
  speed: AnimationSpeed,
): Promise<AnimationResult | null> {
  // Shared encode path with /battle: frame planning, NeuQuant quality, and
  // consecutive-frame coalescing. One queue slot via encodeAnimation("gif").
  const cmod = await getCanvas();
  if (!cmod) return null;

  let assets: Assets;
  try {
    assets = await loadFieldAssets(cmod, input);
  } catch (err) {
    logger.error({ err }, "siege-field: asset load failed");
    return null;
  }

  const result = await encodeAnimation({
    width: FIELD.width,
    height: FIELD.height,
    speed,
    durationMs: speedDurationMs(speed),
    maxFrames: speedMaxFrames(speed),
    quality: 28,
    renderScale: RENDER_SCALE,
    render: async ({ ctx, t }) => {
      // encodeAnimation already applied renderScale on the context; paint in
      // logical coords (paintFrame scales again — pass 1 so we don't double).
      await paintFrame(ctx, input, assets, t, 1);
    },
  });

  if (!result) return null;
  if (result.buffer.length > MAX_BYTES) {
    logger.debug({ bytes: result.buffer.length }, "siege-field: encoded GIF too large, dropping");
    return null;
  }
  return result;
}

// A single frozen frame of the same battlefield, as a PNG — for guilds that run
// battles on static frames (no GIF). It captures the strike at its peak so the
// move still reads clearly: the acting card lunged in, the impact + damage
// number are up, the target is recoiling. Same scene, one moment.
export async function renderSiegeFieldStill(input: SiegeFieldInput): Promise<Buffer | null> {
  return queueRender("siege-field-still", async () => {
    const cmod = await getCanvas();
    if (!cmod) return null;
    try {
      const assets = await loadFieldAssets(cmod, input);
      const physW = Math.round(FIELD.width * STILL_SCALE);
      const physH = Math.round(FIELD.height * STILL_SCALE);
      const canvas = cmod.createCanvas(physW, physH);
      const ctx = canvas.getContext("2d") as unknown as Ctx;
      await paintFrame(ctx, input, assets, STILL_T, STILL_SCALE);
      return await canvas.encode("png");
    } catch (err) {
      logger.error({ err }, "siege-field: still render failed");
      return null;
    }
  });
}

// ── Scene composition ────────────────────────────────────────────────────────

interface Assets {
  arena: CanvasImage | null;
  backdrop: CanvasImage | null; floor: CanvasImage | null;
  flash: CanvasImage | null; smoke: CanvasImage | null;
  frameBlue: CanvasImage | null;
  frameRed: CanvasImage | null;
  atkArt: CanvasImage | null; defArt: CanvasImage | null;
  artByUrl: Map<string, CanvasImage | null>;
  atkColor: number; defColor: number;
}

function lineupFromFighter(f: SiegeFieldFighter): SiegeFieldLineupCard {
  return { name: f.name, artUrl: f.artUrl, rarity: f.rarity, rarityColor: f.rarityColor,
    hp: f.hp, maxHp: f.maxHp, hpBefore: f.hpBefore, energy: f.energy, fallen: false, active: true };
}

// Smoothstep 0→1 as t goes a→b.
function smooth01(t: number, a: number, b: number): number {
  const x = clamp01((t - a) / (b - a));
  return x * x * (3 - 2 * x);
}

/**
 * Paint the whole scene at `t`.
 *
 * Formation (FINAL RULE): one horizontal battle line per side —
 *   BLUE [1][2][3][4]  VS  [1][2][3][4] RED
 * Flat DN card frames (no podium stands). Acting card slides horizontally
 * toward the center, impact/MISS, then returns to its exact slot.
 * Combat FX reuse the shared /battle stack (shake, flash, particles, debris).
 */
async function paintFrame(ctx: Ctx, input: SiegeFieldInput, a: Assets, t: number, scale: number): Promise<void> {
  ctx.save();
  ctx.scale(scale, scale);
  ctx.textBaseline = "top";

  drawArena(ctx, a, input.accent);
  drawAtmosphere(ctx, FIELD.width, FIELD.height, atmospherePreset("battlefield"), {
    seed: `${input.attacker.name}-siege`,
    t,
    color: input.accent || GOLD,
    density: 0.45,
  });

  const acting = input.actingSide;
  const targetSide: 0 | 1 = acting === 0 ? 1 : 0;
  const atkLine = (input.attackerLineup && input.attackerLineup.length ? input.attackerLineup : [lineupFromFighter(input.attacker)]);
  const defLine = (input.defenderLineup && input.defenderLineup.length ? input.defenderLineup : [lineupFromFighter(input.defender)]);
  const lineOf = (s: 0 | 1) => (s === 0 ? atkLine : defLine);

  const foeLine = lineOf(targetSide);
  let focusDepth = foeLine.findIndex(c => c.hpBefore != null);
  if (focusDepth < 0) focusDepth = foeLine.findIndex(c => c.struck);
  if (focusDepth < 0) focusDepth = 0;

  const combatBeat = input.phase === "battle" || input.isHit || input.damage > 0 || input.ko;
  const lungeT = combatBeat ? smooth01(t, 0.18, 0.40) : 0;
  const hitT = combatBeat ? clamp01((t - 0.40) / 0.15) : 0;
  const afterT = combatBeat ? smooth01(t, 0.55, 0.92) : 0;
  const connected = combatBeat && t >= 0.40 && input.isHit;
  const impact = combatBeat ? pulse(t, 0.40, 0.68) : 0;
  const slidePeak = input.isCrit || input.ko ? SLIDE_PX + 16 : SLIDE_PX;
  const slideAmt = !combatBeat ? 0
    : lungeT < 1
      ? lerp(0, slidePeak, easeInOutCubic(lungeT))
      : lerp(slidePeak, 0, easeInOutCubic(afterT));
  const toward = acting === 0 ? 1 : -1;

  const hitRecoil = connected
    ? lerp(0, input.ko ? 28 : input.isCrit ? 24 : 18, easeOutBack(Math.min(1, hitT * 1.2)))
    : 0;
  // MISS: defender dodges aside — attack whiffs, not a text-only label.
  const dodgeAmt = combatBeat && !input.isHit && hitT > 0
    ? lerp(0, 26, easeOutBack(Math.min(1, hitT * 1.15)))
    : 0;
  const dodgeY = combatBeat && !input.isHit && hitT > 0
    ? lerp(0, -14, easeOutBack(Math.min(1, hitT)))
    : 0;

  const shakeIntensity = connected && hitT > 0 && hitT < 1
    ? (input.ko ? 12 : input.isCrit ? 10 : 6)
    : 0;
  const shake = shakeIntensity > 0
    ? await physicsShake(shakeIntensity, hitT, `${input.moveName}-field`)
    : { dx: 0, dy: 0 };

  const actingDepth = Math.max(0, lineOf(acting).findIndex(c => c.active));
  const isActing = (s: 0 | 1, d: number) => s === acting && d === (actingDepth < 0 ? 0 : actingDepth);
  const isTarget = (s: 0 | 1, d: number) => s === targetSide && d === focusDepth;

  const place = (s: 0 | 1, d: number): { x: number; y: number; w: number; h: number; flash: number } => {
    const slot = cardSlot(s, d);
    let x = slot.x;
    let y = slot.y;
    let flash = 0;
    if (isActing(s, d) && combatBeat) x += toward * slideAmt;
    if (isTarget(s, d) && connected) {
      flash = impact;
      x += (targetSide === 0 ? -1 : 1) * hitRecoil;
    } else if (isTarget(s, d) && combatBeat && !input.isHit && hitT > 0) {
      x += (targetSide === 0 ? -1 : 1) * dodgeAmt;
      y += dodgeY;
    }
    return { x, y, w: slot.w, h: slot.h, flash };
  };

  // Combat subjects shake; HUD stays framed.
  ctx.save();
  ctx.translate(shake.dx, shake.dy);

  const drawOne = (s: 0 | 1, d: number) => {
    const line = lineOf(s);
    const card = line[d]; if (!card) return;
    const pos = place(s, d);
    const art = card.artUrl ? a.artByUrl.get(card.artUrl) ?? null : null;
    const frame = s === 0 ? a.frameBlue : a.frameRed;
    const color = s === 0 ? BLUE : RED;
    drawFlatCard(ctx, {
      x: pos.x, y: pos.y, w: pos.w, h: pos.h,
      side: s, art, frame, color, card, flashWhite: pos.flash,
    });
  };

  // Draw non-actors first, then target + actor on top.
  for (const s of [0, 1] as const) {
    for (let d = 0; d < Math.min(lineOf(s).length, LINE_MAX); d++) {
      if (!isActing(s, d) && !isTarget(s, d)) drawOne(s, d);
    }
  }

  if (slideAmt > 6 && lungeT > 0.1 && afterT < 0.85) {
    const ap = place(acting, actingDepth);
    drawDashStreak(ctx, ap.x + ap.w / 2, toward, clamp01(slideAmt / slidePeak), acting === 0 ? BLUE : RED);
  }

  drawOne(targetSide, focusDepth);
  drawOne(acting, actingDepth);

  const tp = place(targetSide, focusDepth);
  const targetX = tp.x + tp.w / 2, targetY = tp.y + tp.h * 0.35;
  if (connected && hitT > 0) {
    drawImpact(ctx, a, targetX, targetY, impact, input);
    if (hitT < 1) {
      const burst = createBurst(targetX, targetY, input.accent || GOLD,
        input.ko ? 55 : input.isCrit ? 45 : 28, input.isCrit ? 140 : 100);
      for (let i = 0; i < burst.length; i++) {
        const p = burst[i]!;
        p.x += p.vx * hitT * 8;
        p.y += p.vy * hitT * 8;
      }
      drawParticles(ctx, burst);
      await drawImpactDebris(ctx, targetX, targetY, {
        color: input.accent || GOLD,
        count: input.ko ? 22 : input.isCrit ? 18 : 10,
        power: input.ko ? 13 : input.isCrit ? 11 : 8,
        steps: Math.max(2, Math.round(hitT * 14)),
        seed: `${input.moveName}-field-shard`,
      });
    }
  } else if (combatBeat && t >= 0.40 && !input.isHit) {
    drawWhiffSparkField(ctx, targetX - toward * 30, targetY, hitT);
    drawDamageNumber(ctx, 0, targetX, targetY - 36, Math.max(0.05, hitT), false, true);
  }

  ctx.restore(); // end shaken combat group

  if (connected && hitT > 0 && hitT < 0.6) {
    drawScreenFlash(ctx, FIELD.width, FIELD.height, hitT / 0.6,
      input.ko ? RED : input.isCrit ? GOLD : (input.accent || BLUE));
  }
  if (connected && input.damage > 0 && hitT > 0) {
    drawDamageNumber(ctx, input.damage, targetX, targetY - 48, hitT, input.isCrit);
  }

  drawLifePlate(ctx, 0, input.attacker, a.atkArt, a.atkColor);
  drawLifePlate(ctx, 1, input.defender, a.defArt, a.defColor);
  drawVsCrest(ctx);
  drawPhaseChips(ctx, input);
  drawMoveBanner(ctx, input);
  drawTurnBar(ctx, input);
  if (input.phase === "draw") drawDrawReveal(ctx, input, t);
  if (input.phase === "main") drawMainBanner(ctx, input, t);
  if (input.phase === "reinforce") drawReinforceBanner(ctx, t);
  if (input.phase === "end") drawEndBanner(ctx, input, t);
  if (input.ko && t > 0.72) drawKoStamp(ctx, targetX, clamp01((t - 0.72) / 0.28));

  ctx.restore();
}

function drawWhiffSparkField(ctx: Ctx, cx: number, cy: number, hitT: number): void {
  const k = 1 - hitT;
  ctx.save();
  ctx.globalAlpha = 0.5 * k;
  ctx.strokeStyle = "rgba(200,214,238,0.9)";
  ctx.lineWidth = 2.4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx - 28, cy - 6);
  ctx.lineTo(cx + 24, cy + 8);
  ctx.stroke();
  ctx.restore();
}

// ── 2D drawing primitives ─────────────────────────────────────────────────────

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
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}

function strokeRoundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, stroke: string, lineWidth: number): void {
  roundRectPath(ctx, x, y, w, h, r);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

// The napi 2D context exposes arc() (circles only), so an oval is a scaled
// circle drawn under a temporary transform.
function ellipse(ctx: Ctx, x: number, y: number, rx: number, ry: number, fill: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, ry / rx);
  ctx.beginPath();
  ctx.arc(0, 0, rx, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
}

interface TextOpts {
  x: number; y: number; w?: number; align?: "left" | "center" | "right";
  text: string; size: number; weight?: number | string; fill: string;
  shadow?: string; shadowBlur?: number; alpha?: number; maxWidth?: number;
}
// Konva Text drew top-anchored inside a box [x, x+width] with an align. We mirror
// that: textBaseline is "top", and centre/right alignment resolves against the box.
function drawText(ctx: Ctx, o: TextOpts): void {
  ctx.save();
  ctx.globalAlpha = o.alpha ?? 1;
  ctx.fillStyle = o.fill;
  ctx.font = `${o.weight ?? 700} ${o.size}px "${FONT}"`;
  ctx.textBaseline = "top";
  const align = o.align ?? "left";
  ctx.textAlign = align;
  if (o.shadow) { ctx.shadowColor = o.shadow; ctx.shadowBlur = o.shadowBlur ?? 0; }
  let text = o.text;
  const limit = o.maxWidth ?? o.w;
  if (limit) text = ellipsize(ctx, text, limit);
  let x = o.x;
  if (o.w != null) {
    if (align === "center") x = o.x + o.w / 2;
    else if (align === "right") x = o.x + o.w;
  }
  ctx.fillText(text, x, o.y);
  ctx.restore();
}

// Trim to fit `w`, appending an ellipsis — the napi context has measureText.
function ellipsize(ctx: Ctx, text: string, w: number): string {
  if (ctx.measureText(text).width <= w) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + "…").width > w) s = s.slice(0, -1);
  return s + "…";
}

// A linear vertical gradient from an array of [stop, colour] pairs.
function vGradient(ctx: Ctx, x0: number, y0: number, y1: number, stops: [number, string][]): ReturnType<Ctx["createLinearGradient"]> {
  const g = ctx.createLinearGradient(x0, y0, x0, y1);
  for (const [at, col] of stops) g.addColorStop(at, col);
  return g;
}

function drawArena(ctx: Ctx, a: Assets, accent: number): void {
  // Base wash — always drawn, so a missing arena still looks deliberate.
  ctx.fillStyle = vGradient(ctx, 0, 0, FIELD.height, [[0, "#101827"], [0.5, "#182236"], [1, "#0a0e16"]]);
  ctx.fillRect(0, 0, FIELD.width, FIELD.height);

  if (a.arena) {
    // The raid arena plate (mountain skybox + stone lists). TOP-anchored so the
    // full sky + mountains stay visible; the lowest floor is what gets cropped.
    const sf = Math.max(FIELD.width / a.arena.width, FIELD.height / a.arena.height);
    const dw = a.arena.width * sf, dh = a.arena.height * sf;
    ctx.drawImage(a.arena as never, (FIELD.width - dw) / 2, 0, dw, dh);
  } else {
    // Legacy procedural stage (backdrop strip + tiled floor band).
    if (a.backdrop) {
      const { dw, dh, dx, dy } = cover(a.backdrop.width, a.backdrop.height, FIELD.width, FIELD.height * 0.82);
      ctx.save(); ctx.globalAlpha = 0.9; ctx.drawImage(a.backdrop as never, dx, dy, dw, dh); ctx.restore();
    }
    const bandTop = GROUND_Y - 44;
    if (a.floor) {
      const tile = 84;
      ctx.save(); ctx.globalAlpha = 0.96;
      for (let x = 0; x < FIELD.width; x += tile) ctx.drawImage(a.floor as never, x, bandTop, tile, FIELD.height - bandTop);
      ctx.restore();
    }
  }

  // Warm/cool split glow along the centre line — sells the "your side vs theirs"
  // divide and ties the stage to the siege accent.
  ctx.save();
  ctx.globalAlpha = 0.20;
  const split = ctx.createLinearGradient(0, 0, FIELD.width, 0);
  split.addColorStop(0, "rgba(56,120,220,0.9)");
  split.addColorStop(0.5, "rgba(0,0,0,0)");
  split.addColorStop(1, "rgba(214,64,64,0.9)");
  ctx.fillStyle = split;
  ctx.fillRect(0, 0, FIELD.width, FIELD.height);
  ctx.restore();

  // Accent haze low on the floor.
  ctx.save();
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = vGradient(ctx, 0, GROUND_Y - 40, GROUND_Y + 40, [[0, "rgba(0,0,0,0)"], [1, hex(accent)]]);
  ctx.fillRect(0, GROUND_Y - 40, FIELD.width, 80);
  ctx.restore();

  // Light cinematic vignette — kept soft so the mountains stay visible. Just a
  // slim scrim under the two top HUD plates (top corners), not across the sky.
  const vg = ctx.createRadialGradient(FIELD.width / 2, FIELD.height * 0.58, 320, FIELD.width / 2, FIELD.height * 0.58, 640);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(0,0,0,0.34)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, FIELD.width, FIELD.height);
  // Corner scrims behind the life-plates only (leave the centre sky clear).
  for (const cx of [0, FIELD.width]) {
    const g = ctx.createRadialGradient(cx, 24, 20, cx, 24, 320);
    g.addColorStop(0, "rgba(6,9,16,0.5)"); g.addColorStop(1, "rgba(6,9,16,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, FIELD.width, 90);
  }
}

interface FlatCardOpts {
  x: number; y: number; w: number; h: number; side: 0 | 1;
  art: CanvasImage | null; frame: CanvasImage | null;
  color: number; card: SiegeFieldLineupCard; flashWhite: number;
}

/**
 * Flat 2-D DN card frame — art keeps its aspect ratio inside the frame window
 * (object-fit: cover, never stretched). Team frame (blue/red) preserves corners.
 */
function drawFlatCard(ctx: Ctx, o: FlatCardOpts): void {
  const { x, y, w, h } = o;
  const fallen = o.card.fallen;
  const cx = x + w / 2;

  // Soft contact shadow so the card feels seated on the arena floor.
  ellipse(ctx, cx, y + h + 4, w * 0.42, 10, "rgba(0,0,0,0.45)");

  if (o.card.active) {
    ctx.save();
    ctx.shadowColor = rgba(o.color, 0.9);
    ctx.shadowBlur = 22;
    fillRoundRect(ctx, x - 2, y - 2, w + 4, h + 4, 14, rgba(o.color, 0.2));
    ctx.restore();
  }

  // Dark backing + art (aspect preserved via cover into the frame window).
  fillRoundRect(ctx, x, y, w, h, 12, "#0b1220");
  const inset = FRAME_INSET;
  const ax = x + w * inset.left;
  const ay = y + h * inset.top;
  const aw = w * (1 - inset.left - inset.right);
  const ah = h * (1 - inset.top - inset.bottom);
  ctx.save();
  roundRectPath(ctx, ax, ay, aw, ah, 8);
  ctx.clip();
  ctx.fillStyle = "#0e0e12";
  ctx.fillRect(ax, ay, aw, ah);
  if (o.art) {
    const c = cover(o.art.width, o.art.height, aw, ah);
    ctx.drawImage(o.art as never, ax + c.dx, ay + c.dy, c.dw, c.dh);
  } else {
    drawText(ctx, {
      x: ax, y: ay + ah / 2 - 18, w: aw, align: "center",
      text: (o.card.name[0] || "?").toUpperCase(),
      weight: 900, size: 42, fill: rgba(o.color, 0.85),
    });
  }
  if (fallen) { ctx.globalAlpha = 0.55; ctx.fillStyle = "#05070c"; ctx.fillRect(ax, ay, aw, ah); }
  if (o.flashWhite > 0.01) { ctx.globalAlpha = 0.55 * o.flashWhite; ctx.fillStyle = "#ffffff"; ctx.fillRect(ax, ay, aw, ah); }
  ctx.restore();

  // 9-slice-style frame overlay (DN Card Frame) — corners preserved by the PNG.
  if (o.frame) {
    if (fallen) ctx.save(), ctx.globalAlpha = 0.75;
    ctx.drawImage(o.frame as never, x, y, w, h);
    if (fallen) ctx.restore();
  } else {
    strokeRoundRect(ctx, x, y, w, h, 12, hex(o.color), 3);
    strokeRoundRect(ctx, x + 4, y + 4, w - 8, h - 8, 9, "rgba(255,255,255,0.2)", 1.2);
  }

  if (fallen) {
    const mx = cx, my = y + h * 0.45, r = 18;
    ctx.save(); ctx.globalAlpha = 0.9; ctx.strokeStyle = "#ff5a5a"; ctx.lineWidth = 3.5; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(mx - r, my - r); ctx.lineTo(mx + r, my + r);
    ctx.moveTo(mx + r, my - r); ctx.lineTo(mx - r, my + r); ctx.stroke(); ctx.restore();
  }

  // Name chip + HP under the card.
  drawText(ctx, {
    x, y: y + h + 8, w, align: "center",
    text: o.card.name.slice(0, 14).toUpperCase(),
    weight: 800, size: 11, fill: "#e2e8f0",
    shadow: "rgba(0,0,0,0.9)", shadowBlur: 2, maxWidth: w,
  });
  drawCardHp(ctx, cx, y + h + 24, w * 0.88, o.card, o.color, fallen);
}

function drawCardHp(ctx: Ctx, cx: number, y: number, w: number, card: SiegeFieldLineupCard, color: number, fallen: boolean): void {
  const x = cx - w / 2, h = 7;
  const now = clamp01(card.hp / Math.max(1, card.maxHp));
  const ghost = clamp01((card.hpBefore ?? card.hp) / Math.max(1, card.maxHp));
  fillRoundRect(ctx, x, y, w, h, 3.5, "rgba(8,11,18,0.9)");
  if (!fallen) {
    fillRoundRect(ctx, x + 1, y + 1, (w - 2) * ghost, h - 2, 2.5, "rgba(220,60,60,0.4)");
    const c = now > 0.5 ? hex(color) : now > 0.22 ? "#f1c40f" : "#e74c3c";
    fillRoundRect(ctx, x + 1, y + 1, Math.max(0, (w - 2) * now), h - 2, 2.5, c);
  }
  strokeRoundRect(ctx, x, y, w, h, 3.5, "rgba(0,0,0,0.6)", 1);
}

// ── Raid HUD: corner life-plates, VS crest, turn bar ─────────────────────────
// Side identity colours — the raider is always blue, the garrison red.
const BLUE = 0x2f6fd0, RED = 0xd6404a, GOLD = 0xe8c15a, INK = "#0c1220";

// One corner life-plate (side 0 = top-left / blue "raider", side 1 = top-right /
// red "garrison"): a beveled panel with a portrait chip on the outer edge, the
// card name, a big HP readout and an HP bar that drains from its pre-hit ghost.
function drawLifePlate(ctx: Ctx, side: 0 | 1, f: SiegeFieldFighter, art: CanvasImage | null, accent: number): void {
  const theme = side === 0 ? BLUE : RED;
  const W = 296, H = 66, M = 12;
  const x = side === 0 ? M : FIELD.width - M - W;
  const y = 12;
  const chip = H;                                  // square portrait chip
  const chipX = side === 0 ? x : x + W - chip;     // chip on the OUTER edge
  const panelX = side === 0 ? x + chip - 6 : x - 6 + 0; // panel overlaps chip inner edge
  const bodyX = side === 0 ? x + chip + 6 : x;
  const bodyW = W - chip - 6;

  // Panel body.
  ctx.save(); ctx.shadowColor = "rgba(0,0,0,0.55)"; ctx.shadowBlur = 8;
  fillRoundRect(ctx, bodyX, y, bodyW, H, 10, "rgba(10,14,22,0.92)");
  ctx.restore();
  // Accent header strip.
  ctx.save(); roundRectPath(ctx, bodyX, y, bodyW, H, 10); ctx.clip();
  ctx.fillStyle = vGradient(ctx, 0, y, y + 22, [[0, rgba(theme, 0.55)], [1, "rgba(0,0,0,0)"]]);
  ctx.fillRect(bodyX, y, bodyW, 24);
  ctx.restore();
  strokeRoundRect(ctx, bodyX, y, bodyW, H, 10, hex(GOLD), 2);
  strokeRoundRect(ctx, bodyX, y, bodyW, H, 10, "rgba(0,0,0,0.6)", 0.6);

  // Portrait chip.
  ctx.save(); ctx.shadowColor = rgba(accent, 0.8); ctx.shadowBlur = 12;
  fillRoundRect(ctx, chipX, y, chip, H, 10, hex(theme)); ctx.restore();
  ctx.save(); roundRectPath(ctx, chipX + 3, y + 3, chip - 6, H - 6, 8); ctx.clip();
  if (art) { const c = cover(art.width, art.height, chip - 6, H - 6); ctx.drawImage(art as never, chipX + 3 + c.dx, y + 3 + c.dy, c.dw, c.dh); }
  else { ctx.fillStyle = rgba(theme, 0.6); ctx.fillRect(chipX + 3, y + 3, chip - 6, H - 6); }
  ctx.restore();
  strokeRoundRect(ctx, chipX, y, chip, H, 10, hex(GOLD), 2);

  // Name + LP number + bar inside the body.
  const pad = 12;
  const nameX = bodyX + pad, nameW = bodyW - pad * 2;
  drawText(ctx, { x: nameX, y: y + 7, w: nameW, align: side === 0 ? "left" : "right",
    text: f.name.toUpperCase(), weight: 800, size: 15, fill: "#f2f6fb", shadow: "rgba(0,0,0,0.9)", shadowBlur: 3, maxWidth: nameW });

  const hpNow = clamp01(f.hp / Math.max(1, f.maxHp));
  const hpGhost = clamp01((f.hpBefore ?? f.hp) / Math.max(1, f.maxHp));
  drawText(ctx, { x: nameX, y: y + 27, w: nameW, align: side === 0 ? "left" : "right",
    text: `LP ${Math.max(0, Math.round(f.hp))}`, weight: 900, size: 20, fill: "#ffffff", shadow: "rgba(0,0,0,0.9)", shadowBlur: 3 });

  const barY = y + H - 13, barH = 8;
  fillRoundRect(ctx, nameX, barY, nameW, barH, 4, INK);
  fillRoundRect(ctx, nameX + 1, barY + 1, (nameW - 2) * hpGhost, barH - 2, 3, "rgba(220,60,60,0.4)");
  fillRoundRect(ctx, nameX + 1, barY + 1, Math.max(0, (nameW - 2) * hpNow), barH - 2, 3, hex(theme));
  // Energy pip under the bar.
  const energy = clamp01((f.energy ?? 0) / 100);
  if (energy > 0) { fillRoundRect(ctx, nameX, barY + barH + 1, nameW, 3, 1.5, "#0a0f18"); fillRoundRect(ctx, nameX, barY + barH + 1, nameW * energy, 3, 1.5, "#38bdf8"); }
}

// The central VS crest — a gold-rimmed shield with "VS", sitting between the two
// life-plates like the mockup's medallion.
function drawVsCrest(ctx: Ctx): void {
  const cx = FIELD.width / 2, cy = 40, r = 30;
  ctx.save();
  // outer shield glow
  ctx.shadowColor = rgba(GOLD, 0.7); ctx.shadowBlur = 16;
  drawStar(ctx, cx, cy, 6, r * 0.62, r + 6, hex(GOLD), 0.95);
  ctx.restore();
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r - 3, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(12,16,24,0.95)"; ctx.fill();
  ctx.lineWidth = 3; ctx.strokeStyle = hex(GOLD); ctx.stroke();
  ctx.restore();
  drawText(ctx, { x: cx - 40, y: cy - 13, w: 80, align: "center", text: "VS", weight: 900, size: 26, fill: hex(GOLD), shadow: "rgba(0,0,0,0.9)", shadowBlur: 3 });
}

// Phase chip strip under the VS crest — DRAW / MAIN / BATTLE / REINFORCE / END.
function drawPhaseChips(ctx: Ctx, input: SiegeFieldInput): void {
  const phases: NonNullable<SiegeFieldInput["phase"]>[] = ["draw", "main", "battle", "reinforce", "end"];
  const labels = ["DRAW", "MAIN", "BATTLE", "REINFORCE", "END"];
  const active = input.phase ?? "main";
  const totalW = 560, h = 24, y = 72;
  const x0 = (FIELD.width - totalW) / 2;
  const cw = totalW / phases.length;
  for (let i = 0; i < phases.length; i++) {
    const on = phases[i] === active;
    const x = x0 + i * cw + 2;
    fillRoundRect(ctx, x, y, cw - 4, h, 7, on ? "rgba(241,196,15,0.95)" : "rgba(8,12,20,0.82)");
    strokeRoundRect(ctx, x, y, cw - 4, h, 7, on ? hex(GOLD) : "rgba(148,163,184,0.28)", on ? 1.8 : 1);
    drawText(ctx, {
      x, y: y + 5, w: cw - 4, align: "center",
      text: labels[i]!, weight: 800, size: 11,
      fill: on ? "#1a1408" : "rgba(226,232,240,0.72)",
      shadow: on ? undefined : "rgba(0,0,0,0.8)", shadowBlur: on ? 0 : 2,
    });
  }
}

/** DRAW cinematic: newly drawn Siege Battle Cards fan up from the bottom. */
function drawDrawReveal(ctx: Ctx, input: SiegeFieldInput, t: number): void {
  const cards = input.drawnCards ?? [];
  const rise = easeOut(clamp01(t / 0.55));
  const y = FIELD.height - 118 + (1 - rise) * 70;
  const titleAlpha = clamp01(t * 2);
  // Soft vignette so the draw fan reads against the busy field.
  ctx.save();
  ctx.globalAlpha = 0.28 * titleAlpha;
  fillRoundRect(ctx, 40, FIELD.height - 200, FIELD.width - 80, 160, 18, "rgba(2,6,14,0.92)");
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = 0.65 * titleAlpha;
  fillRoundRect(ctx, FIELD.width / 2 - 170, 108, 340, 38, 10, "rgba(8,12,20,0.9)");
  strokeRoundRect(ctx, FIELD.width / 2 - 170, 108, 340, 38, 10, hex(GOLD), 1.4);
  ctx.restore();
  drawText(ctx, {
    x: FIELD.width / 2 - 170, y: 118, w: 340, align: "center",
    text: cards.length ? `DRAWING ${cards.length} CARD${cards.length === 1 ? "" : "S"}` : "DRAW PHASE",
    weight: 900, size: 16, fill: "#f8fafc", shadow: "rgba(0,0,0,0.9)", shadowBlur: 3,
  });
  if (cards.length === 0) return;
  const n = Math.min(cards.length, 5);
  const gap = 118;
  const startX = FIELD.width / 2 - ((n - 1) * gap) / 2;
  for (let i = 0; i < n; i++) {
    const c = cards[i]!;
    const appear = easeOut(clamp01((t - i * 0.08) / 0.4));
    const x = startX + i * gap;
    const cy = y - appear * 8;
    const tilt = (i - (n - 1) / 2) * 0.04;
    ctx.save();
    ctx.globalAlpha = appear;
    ctx.translate(x, cy + 36);
    ctx.rotate(tilt);
    fillRoundRect(ctx, -52, -36, 104, 72, 10, "rgba(15,23,42,0.96)");
    strokeRoundRect(ctx, -52, -36, 104, 72, 10, hex(GOLD), 1.8);
    drawText(ctx, {
      x: -48, y: -24, w: 96, align: "center",
      text: c.emoji, weight: 700, size: 22, fill: "#fff",
    });
    drawText(ctx, {
      x: -48, y: 6, w: 96, align: "center",
      text: c.name.slice(0, 12), weight: 800, size: 11, fill: "#e2e8f0",
      maxWidth: 96,
    });
    ctx.restore();
  }
}

/** MAIN cinematic: pulse the command strip so it feels like "your turn" unlocks. */
function drawMainBanner(ctx: Ctx, input: SiegeFieldInput, t: number): void {
  const pulse = 0.55 + 0.35 * Math.sin(t * Math.PI * 2);
  const label = (input.moveName || "MAIN PHASE").toUpperCase();
  const y = 110;
  ctx.save();
  ctx.globalAlpha = pulse;
  fillRoundRect(ctx, FIELD.width / 2 - 200, y, 400, 40, 12, "rgba(59,130,246,0.9)");
  strokeRoundRect(ctx, FIELD.width / 2 - 200, y, 400, 40, 12, "#bfdbfe", 2);
  ctx.restore();
  drawText(ctx, {
    x: FIELD.width / 2 - 200, y: y + 10, w: 400, align: "center",
    text: label.slice(0, 36),
    weight: 900, size: 17, fill: "#f8fafc", shadow: "rgba(0,0,0,0.85)", shadowBlur: 3,
  });
}

function drawReinforceBanner(ctx: Ctx, t: number): void {
  const pulseA = 0.55 + 0.35 * Math.sin(t * Math.PI * 2);
  const y = 110;
  // Sweeping light bar behind the banner.
  const sweep = ((t * 1.4) % 1);
  ctx.save();
  ctx.globalAlpha = 0.25;
  fillRoundRect(ctx, 80 + sweep * (FIELD.width - 360), y - 8, 200, 56, 14, "rgba(125,211,252,0.9)");
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = pulseA;
  fillRoundRect(ctx, FIELD.width / 2 - 220, y, 440, 44, 12, "rgba(14,165,233,0.92)");
  strokeRoundRect(ctx, FIELD.width / 2 - 220, y, 440, 44, 12, "#e0f2fe", 2);
  ctx.restore();
  drawText(ctx, {
    x: FIELD.width / 2 - 220, y: y + 10, w: 440, align: "center",
    text: "REINFORCEMENTS DEPLOYING",
    weight: 900, size: 18, fill: "#f8fafc", shadow: "rgba(0,0,0,0.85)", shadowBlur: 3,
  });
}

function drawEndBanner(ctx: Ctx, input: SiegeFieldInput, t: number): void {
  const appear = easeOut(clamp01(t / 0.4));
  ctx.save();
  ctx.globalAlpha = appear;
  fillRoundRect(ctx, FIELD.width / 2 - 220, 118, 440, 56, 14, "rgba(15,23,42,0.94)");
  strokeRoundRect(ctx, FIELD.width / 2 - 220, 118, 440, 56, 14, hex(GOLD), 2.2);
  drawText(ctx, {
    x: FIELD.width / 2 - 220, y: 134, w: 440, align: "center",
    text: (input.moveName || "SIEGE COMPLETE").toUpperCase().slice(0, 40),
    weight: 900, size: 20, fill: "#fef3c7", shadow: "rgba(0,0,0,0.9)", shadowBlur: 3,
  });
  ctx.restore();
}

// The bottom turn bar — "PLAYER TURN" (blue, left) / "TURN N" plate (centre) /
// "OPPONENT TURN" (red, right). Whoever is acting this frame lights up.
function drawTurnBar(ctx: Ctx, input: SiegeFieldInput): void {
  const y = FIELD.height - 38, h = 28;
  const raiderActive = input.actingSide === 0;
  const tag = (side: 0 | 1, label: string) => {
    const theme = side === 0 ? BLUE : RED;
    const w = 150; const x = side === 0 ? 14 : FIELD.width - 14 - w;
    const on = input.actingSide === side;
    fillRoundRect(ctx, x, y, w, h, 8, on ? rgba(theme, 0.9) : "rgba(12,16,24,0.8)");
    strokeRoundRect(ctx, x, y, w, h, 8, hex(on ? GOLD : theme), on ? 2 : 1.4);
    drawText(ctx, { x, y: y + 7, w, align: "center", text: label, weight: 800, size: 13, fill: on ? "#ffffff" : rgba(theme, 0.95), shadow: "rgba(0,0,0,0.8)", shadowBlur: 2 });
  };
  tag(0, "RAIDER TURN");
  tag(1, "GARRISON TURN");
  // Centre turn plate.
  const label = (input.turnLabel || "TURN 1").toUpperCase();
  const cw = 118, cx = FIELD.width / 2 - cw / 2;
  fillRoundRect(ctx, cx, y, cw, h, 8, "rgba(12,16,24,0.88)");
  strokeRoundRect(ctx, cx, y, cw, h, 8, hex(GOLD), 1.6);
  drawText(ctx, { x: cx, y: y + 7, w: cw, align: "center", text: label, weight: 800, size: 13, fill: "#f2e4b8", shadow: "rgba(0,0,0,0.8)", shadowBlur: 2 });
  void raiderActive;
}

function drawStar(ctx: Ctx, x: number, y: number, points: number, inner: number, outer: number, fill: string, alpha: number): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = fill;
  ctx.beginPath();
  const step = Math.PI / points;
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const ang = i * step - Math.PI / 2;
    const sx = x + Math.cos(ang) * r, sy = y + Math.sin(ang) * r;
    if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// Motion-blur speed lines trailing the charging fighter. `dir` is +1 when it
// moves right (attacker) / −1 when it moves left (defender); the streaks stream
// out BEHIND it. Cheap: a handful of tapered accent lines, no image work.
function drawDashStreak(ctx: Ctx, x: number, dir: number, k: number, color: number): void {
  const bandTop = LINE_Y + 20, bandBot = LINE_Y + CARD.h - 20;
  const tailX = x - dir * (CARD.w * 0.28);
  const lines = 5;
  ctx.save();
  ctx.lineCap = "round";
  for (let i = 0; i < lines; i++) {
    const f = i / (lines - 1);
    const y = lerp(bandTop, bandBot, f);
    const centre = 1 - Math.abs(f - 0.5) * 2;
    const len = (28 + centre * 52) * k;
    if (len < 4) continue;
    const x0 = tailX - dir * (6 + f * 10);
    const x1 = x0 - dir * len;
    const alpha = k * (0.22 + centre * 0.4);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = hex(color);
    ctx.lineWidth = 2 + centre * 3;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
    if (centre > 0.5) {
      ctx.globalAlpha = alpha * 0.9;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(lerp(x0, x1, 0.7), y);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawImpact(ctx: Ctx, a: Assets, x: number, y: number, k: number, input: SiegeFieldInput): void {
  const color = input.isCrit ? 0xffd54a : 0xffffff;
  const scale = (input.isCrit ? 1.35 : 1.0) * (0.6 + k * 0.9);
  if (a.flash) {
    const sz = 150 * scale;
    ctx.save();
    ctx.globalAlpha = k;
    ctx.shadowColor = rgba(color, k);
    ctx.shadowBlur = 30;
    ctx.drawImage(a.flash as never, x - sz / 2, y - sz / 2, sz, sz);
    ctx.restore();
  } else {
    drawStar(ctx, x, y, 8, 18 * scale, 52 * scale, hex(color), k);
  }
  // Shockwave ring — an expanding hoop that reads as the force of the blow
  // landing, brightest at the moment of contact.
  ctx.save();
  ctx.globalAlpha = k * 0.85;
  ctx.strokeStyle = hex(color);
  ctx.lineWidth = (5 * scale) * (0.4 + k * 0.6);
  ctx.shadowColor = rgba(color, k);
  ctx.shadowBlur = 18;
  ctx.beginPath();
  ctx.arc(x, y, (26 + (1 - k) * 62) * scale, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  // Radial spark burst from the point of contact.
  const sparks = input.isCrit ? 9 : 6;
  ctx.save();
  ctx.globalAlpha = k * 0.8;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2.4 * scale;
  ctx.lineCap = "round";
  ctx.shadowColor = rgba(color, k);
  ctx.shadowBlur = 10;
  for (let i = 0; i < sparks; i++) {
    const ang = (i / sparks) * Math.PI * 2 + k * 0.6;
    const r0 = 18 * scale, r1 = (46 + k * 40) * scale;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(ang) * r0, y + Math.sin(ang) * r0);
    ctx.lineTo(x + Math.cos(ang) * r1, y + Math.sin(ang) * r1);
    ctx.stroke();
  }
  ctx.restore();
  // Slash streak.
  ctx.save();
  ctx.globalAlpha = k * 0.85;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 6 * scale;
  ctx.lineCap = "round";
  ctx.shadowColor = rgba(color, k);
  ctx.shadowBlur = 16;
  ctx.beginPath();
  ctx.moveTo(x - 60 * scale, y + 34 * scale);
  ctx.lineTo(x + 60 * scale, y - 34 * scale);
  ctx.stroke();
  ctx.restore();
  if (a.smoke) {
    const sz = 120 * scale;
    ctx.save();
    ctx.globalAlpha = k * 0.7;
    ctx.drawImage(a.smoke as never, x - sz / 2, y - sz / 2, sz, sz);
    ctx.restore();
  }
  // Damage numbers are drawn via shared drawDamageNumber in paintFrame.
}

function drawFloatingText(ctx: Ctx, cx: number, y: number, text: string, color: number, k: number): void {
  drawText(ctx, {
    x: cx - 100, y: y - k * 20, w: 200, align: "center", text,
    weight: 900, size: 30, fill: hex(color), shadow: "rgba(0,0,0,1)", shadowBlur: 4, alpha: 1 - k,
  });
}

function drawMoveBanner(ctx: Ctx, input: SiegeFieldInput): void {
  const actor = input.actingSide === 0 ? input.attacker : input.defender;
  // Bullet (U+2022) not middle-dot (U+00B7): Orbitron ships the former, and
  // @napi-rs/canvas renders a missing glyph as a tofu box rather than falling
  // back per-glyph the way the old cairo backend did.
  const text = `${actor.name} • ${input.moveName}`;
  const w = Math.min(540, 64 + text.length * 12);
  // The move caption floats above the turn bar, between the two stand bases.
  const x = FIELD.width / 2 - w / 2, y = FIELD.height - 78;
  const side = input.actingSide === 0 ? BLUE : RED;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 10;
  fillRoundRect(ctx, x, y, w, 34, 17, "rgba(10,14,20,0.82)");
  ctx.restore();
  ctx.save(); roundRectPath(ctx, x, y, w, 34, 17); ctx.clip();
  ctx.fillStyle = vGradient(ctx, 0, y, y + 34, [[0, rgba(side, 0.45)], [1, "rgba(0,0,0,0)"]]);
  ctx.fillRect(x, y, w, 34); ctx.restore();
  strokeRoundRect(ctx, x, y, w, 34, 17, hex(GOLD), 1.6);
  drawText(ctx, { x, y: y + 9, w, align: "center", text, weight: 700, size: 16, fill: "#f5f7fa", maxWidth: w - 24 });
}

function drawKoStamp(ctx: Ctx, x: number, k: number): void {
  const s = lerp(1.6, 1.0, easeOut(k));
  const cyStamp = GROUND_Y - 150 + 32;
  ctx.save();
  ctx.translate(x, cyStamp);
  ctx.rotate((-8 * Math.PI) / 180);
  ctx.globalAlpha = clamp01(k * 1.4);
  ctx.fillStyle = "#ff3b3b";
  ctx.font = `900 ${64 * s}px "${FONT}"`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,1)";
  ctx.shadowBlur = 8;
  ctx.fillText("K.O.", 0, 0);
  ctx.restore();
}

// object-fit: cover — returns the draw dims + offset to fill wxh with the image.
function cover(iw: number, ih: number, w: number, h: number): { dw: number; dh: number; dx: number; dy: number } {
  if (!iw || !ih) return { dw: w, dh: h, dx: 0, dy: 0 };
  const scale = Math.max(w / iw, h / ih);
  const dw = iw * scale, dh = ih * scale;
  return { dw, dh, dx: (w - dw) / 2, dy: (h - dh) / 2 };
}
