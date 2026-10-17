// ─────────────────────────────────────────────────────────────────────────────
// DN Cards — Image card frames
//
// Opt-in ornate PNG frames drawn around card art wherever a card renders. When a
// guild enables frames and maps a rarity to a colour, the card's drawn border is
// replaced by the matching frame image, auto-scaled to whatever rect the card is
// drawn at (any size / aspect). When frames are off — the default — nothing
// changes: the existing thin drawn border is used.
//
// Integration is deliberately low-touch. A render entry point wraps its work in
// `withGuildFrames(guildId, () => …)`, which resolves the guild's frame map and
// preloads the needed images, then runs the render inside an AsyncLocalStorage
// scope. The two shared card helpers (drawCardArt / drawCardFrame in effects.ts)
// consult that scope synchronously: art is inset into the frame's window, and the
// frame image is drawn over the card rect. No scope (frames off / unmapped
// rarity / unwired call site) → both fall back to their original behaviour.
// ─────────────────────────────────────────────────────────────────────────────

import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Rarity } from "../cards-data.js";
import { getCanvas, type CanvasMod, type Ctx } from "./engine.js";
import { logger } from "../../lib/logger.js";

export interface RarityAccent {
  color: number | null;
  paint: "solid" | "rainbow" | "blend";
  blendA?: number;
  blendB?: number;
  ownsColor: boolean;
}

type LoadedImage = import("@napi-rs/canvas").Image;

export type FrameColor = "grey" | "blue" | "red" | "gold" | "rainbow";
export const FRAME_COLORS: readonly FrameColor[] = ["grey", "blue", "red", "gold", "rainbow"];

const FILE_STEM: Record<FrameColor, string> = {
  grey: "DN_Card_Frame_Grey",
  blue: "DN_Card_Frame_Blue",
  red: "DN_Card_Frame_Red",
  gold: "DN_Card_Frame_Gold",
  rainbow: "DN_Card_Frame_Rainbow",
};

// The frame art has a transparent central window; these are the window insets as
// a fraction of the frame image's own size (measured from the assets, consistent
// across the full / 256 / 128 variants). Card art is drawn into this window so
// the ornate border sits around it, and the whole frame fits the card's rect.
export const FRAME_INSET = { left: 0.165, right: 0.163, top: 0.079, bottom: 0.079 } as const;

// ── Progression (level) frames ───────────────────────────────────────────────
// A separate, unlock-and-equip cosmetic keyed by a card's LEVEL rather than its
// rarity. Tiers switch at level 1 / 50 / 100 (see progressionTierForLevel). When
// a card has an equipped progression frame it OVERRIDES the rarity frame; the
// look reflects how far the card has been levelled, so it travels with the card
// through trades and reads as a flex. Assets: DN_Progress_Frame_L1/L50/L100.
export type ProgTier = "l1" | "l50" | "l100";
export const PROG_TIERS: readonly ProgTier[] = ["l1", "l50", "l100"];

const PROG_FILE_STEM: Record<ProgTier, string> = {
  l1: "DN_Progress_Frame_L1",
  l50: "DN_Progress_Frame_L50",
  l100: "DN_Progress_Frame_L100",
};

// The transparent window differs per progression frame (measured from the art),
// so each tier carries its own insets — the ornate L100 has thicker side rails.
const PROG_INSET: Record<ProgTier, { left: number; right: number; top: number; bottom: number }> = {
  l1:   { left: 0.100, right: 0.098, top: 0.097, bottom: 0.151 },
  l50:  { left: 0.103, right: 0.103, top: 0.091, bottom: 0.137 },
  l100: { left: 0.158, right: 0.147, top: 0.107, bottom: 0.142 },
};

// Which progression tier a level qualifies for. Level 100 = top tier; 50–99 =
// mid; anything below = base. (A card is always at least level 1.)
export function progressionTierForLevel(level: number): ProgTier {
  if (level >= 100) return "l100";
  if (level >= 50) return "l50";
  return "l1";
}

// Per-rarity → frame colour, resolved for one guild. Only mapped rarities appear.
export type FrameMap = Partial<Record<Rarity, FrameColor>>;

interface FrameScope {
  images: FrameMap | null;
  accents: Partial<Record<Rarity, RarityAccent>> | null;
}

const frameStore = new AsyncLocalStorage<FrameScope>();

const FRAME_COLUMNS: [Rarity, string][] = [
  ["common", "cardFrameCommon"], ["uncommon", "cardFrameUncommon"], ["rare", "cardFrameRare"],
  ["epic", "cardFrameEpic"], ["legendary", "cardFrameLegendary"], ["mythic", "cardFrameMythic"],
];

export function readAssignedFrames(settings: Record<string, unknown>): FrameMap {
  const map: FrameMap = {};
  for (const [rarity, key] of FRAME_COLUMNS) {
    const v = settings[key];
    if (typeof v === "string" && (FRAME_COLORS as readonly string[]).includes(v)) map[rarity] = v as FrameColor;
  }
  return map;
}

/** Frames that are actually drawn. Off, or nothing mapped, is an empty map. */
export function assignedFrameColors(settings: Record<string, unknown>): FrameMap {
  if (settings["cardFramesEnabled"] !== true) return {};
  return readAssignedFrames(settings);
}

export function readFramePng(color: FrameColor): Buffer | null {
  const file = fileFor(color, "128");
  if (!file || !existsSync(file)) return null;
  try { return readFileSync(file); } catch { return null; }
}

// Decoded-image cache, keyed by `${color}:${size}`. Loaded once, reused forever.
type FrameSize = "full" | "256" | "128";
const decoded = new Map<string, LoadedImage | null>();
const loading = new Map<string, Promise<LoadedImage | null>>();

function resolveFramesDir(): string | null {
  const candidates = [
    fileURLToPath(new URL("../../../assets/frames/", import.meta.url)),
    join(process.cwd(), "assets/frames"),
    join(process.cwd(), "artifacts/api-server/assets/frames"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "DN_Card_Frame_Gold.png"))) return dir;
  }
  return null;
}

function fileFor(color: FrameColor, size: FrameSize): string | null {
  const dir = resolveFramesDir();
  if (!dir) return null;
  const suffix = size === "full" ? "" : size === "256" ? "_256px" : "_128px";
  const p = join(dir, `${FILE_STEM[color]}${suffix}.png`);
  return existsSync(p) ? p : join(dir, `${FILE_STEM[color]}.png`); // fall back to full
}

async function loadFrame(mod: CanvasMod, color: FrameColor, size: FrameSize): Promise<LoadedImage | null> {
  const key = `${color}:${size}`;
  if (decoded.has(key)) return decoded.get(key)!;
  const inflight = loading.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const file = fileFor(color, size);
      if (!file) return null;
      const img = await mod.loadImage(file);
      decoded.set(key, img);
      return img;
    } catch (err) {
      logger.debug({ err, color, size }, "card-frames: failed to load frame image");
      decoded.set(key, null);
      return null;
    } finally {
      loading.delete(key);
    }
  })();
  loading.set(key, p);
  return p;
}

// Pick the smallest cached variant that comfortably covers the target width, so
// small thumbnails use the 128/256px art and hero cards use the full image.
function pickSize(targetW: number): FrameSize {
  if (targetW <= 150) return "128";
  if (targetW <= 300) return "256";
  return "full";
}

// ── Progression-frame image loading (shares the decoded cache) ────────────────
function progFileFor(tier: ProgTier, size: FrameSize): string | null {
  const dir = resolveFramesDir();
  if (!dir) return null;
  const suffix = size === "full" ? "" : size === "256" ? "_256px" : "_128px";
  const p = join(dir, `${PROG_FILE_STEM[tier]}${suffix}.png`);
  return existsSync(p) ? p : join(dir, `${PROG_FILE_STEM[tier]}.png`);
}

async function loadProgFrame(mod: CanvasMod, tier: ProgTier, size: FrameSize): Promise<LoadedImage | null> {
  const key = `prog:${tier}:${size}`;
  if (decoded.has(key)) return decoded.get(key)!;
  const inflight = loading.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const file = progFileFor(tier, size);
      if (!file) return null;
      const img = await mod.loadImage(file);
      decoded.set(key, img);
      return img;
    } catch (err) {
      logger.debug({ err, tier, size }, "card-frames: failed to load progression frame");
      decoded.set(key, null);
      return null;
    } finally {
      loading.delete(key);
    }
  })();
  loading.set(key, p);
  return p;
}

// Preload every progression frame (all tiers × sizes). Best-effort.
export async function preloadProgressionFrames(): Promise<void> {
  const mod = await getCanvas();
  if (!mod) return;
  await Promise.all(PROG_TIERS.flatMap(t => (["full", "256", "128"] as FrameSize[]).map(s => loadProgFrame(mod, t, s))));
}

// The art window inside the card rect for a progression tier (else the rect).
export function progressionArtWindow(x: number, y: number, w: number, h: number, tier: ProgTier): { x: number; y: number; w: number; h: number } {
  const ins = PROG_INSET[tier];
  return { x: x + w * ins.left, y: y + h * ins.top, w: w * (1 - ins.left - ins.right), h: h * (1 - ins.top - ins.bottom) };
}

// Draw a progression frame over the card rect. Returns true if drawn (a preload
// must have run, or the sync cache is empty and it no-ops → false).
export function drawProgressionOverlay(ctx: Ctx, x: number, y: number, w: number, h: number, tier: ProgTier): boolean {
  const size = pickSize(w);
  const img = decoded.get(`prog:${tier}:${size}`) ?? decoded.get(`prog:${tier}:full`) ?? decoded.get(`prog:${tier}:256`) ?? decoded.get(`prog:${tier}:128`);
  if (!img) return false;
  try { ctx.drawImage(img, x, y, w, h); return true; } catch { return false; }
}

// Build a guild's frame map from its settings. Returns null when frames are off
// or nothing is mapped, so callers cheaply skip the whole system.
function buildFrameMap(settings: Record<string, unknown>): FrameMap | null {
  const map = assignedFrameColors(settings);
  return Object.keys(map).length > 0 ? map : null;
}

// Resolve a guild's frame map and preload every image it can use (all three
// sizes for each mapped colour), so the synchronous draw hooks always find a
// decoded image. Best-effort: a failed preload just leaves that colour unframed.
export async function resolveGuildFrames(settings: Record<string, unknown>): Promise<FrameMap | null> {
  const map = buildFrameMap(settings);
  if (!map) return null;
  const mod = await getCanvas();
  if (!mod) return null;
  const colors = Array.from(new Set(Object.values(map))) as FrameColor[];
  await Promise.all(colors.flatMap(c => (["full", "256", "128"] as FrameSize[]).map(s => loadFrame(mod, c, s))));
  return map;
}

// Run `fn` inside a frame scope for this guild. Resolves + preloads first; if
// frames are off/unmapped/unavailable, runs `fn` with no scope (zero overhead,
// original behaviour). `settings` is the guild's GuildSettings row.
export async function withGuildFrames<T>(settings: Record<string, unknown> | null | undefined, fn: () => Promise<T>): Promise<T> {
  if (!settings) return fn();
  const map = await resolveGuildFrames(settings).catch(() => null);
  let accents: Partial<Record<Rarity, RarityAccent>> | null = null;
  const guildId = typeof settings["guildId"] === "string" ? settings["guildId"] : null;
  if (guildId) {
    try {
      const { loadRarityAccents } = await import("../battle/frame-scope.js");
      const buffers: Partial<Record<FrameColor, Buffer>> = {};
      const assigned = map ?? {};
      for (const color of new Set(Object.values(assigned))) {
        const buf = readFramePng(color);
        if (buf) buffers[color] = buf;
      }
      accents = await loadRarityAccents(guildId, assigned, buffers);
    } catch (err) {
      logger.debug({ err }, "card-frames: rarity frame colours skipped");
    }
  }
  if (!map && !accents) return fn();
  return frameStore.run({ images: map, accents }, fn);
}

// ── Synchronous hooks used by effects.ts drawCardArt / drawCardFrame ──────────
// True when a frame scope is active and this rarity maps to a (loaded) colour.
export function frameColorForRarity(rarity: Rarity | string | null | undefined): FrameColor | null {
  const map = frameStore.getStore()?.images;
  if (!map || rarity == null) return null;
  return map[rarity as Rarity] ?? null;
}

/** The colour staff saved for this rarity, when this render is inside a guild frame scope. */
export function accentForRarity(rarity: Rarity | string | null | undefined): RarityAccent | null {
  if (rarity == null) return null;
  const accent = frameStore.getStore()?.accents?.[rarity as Rarity];
  if (!accent?.ownsColor || accent.color == null) return null;
  return accent;
}

export function applyRarityAccent<T extends {
  rarity?: string | null;
  rarityColor?: number | null;
  framePaint?: "solid" | "rainbow" | "blend";
  blendA?: number;
  blendB?: number;
  frameMode?: string;
}>(card: T): T {
  const live = accentForRarity(card.rarity);
  if (!live) return card;
  return {
    ...card,
    rarityColor: live.color ?? card.rarityColor,
    framePaint: live.paint,
    blendA: live.blendA,
    blendB: live.blendB,
    frameMode: card.frameMode ?? "custom",
  };
}

// The art window inside the card rect when a frame is active — else the rect
// unchanged. Lets drawCardArt inset the art so the ornate border frames it.
export function frameArtWindow(x: number, y: number, w: number, h: number, rarity: Rarity | string | null | undefined): { x: number; y: number; w: number; h: number } {
  if (!frameColorForRarity(rarity)) return { x, y, w, h };
  return {
    x: x + w * FRAME_INSET.left,
    y: y + h * FRAME_INSET.top,
    w: w * (1 - FRAME_INSET.left - FRAME_INSET.right),
    h: h * (1 - FRAME_INSET.top - FRAME_INSET.bottom),
  };
}

// Draw the mapped frame over the card rect. Returns true if a frame was drawn
// (the caller then skips its drawn border); false → nothing mapped/loaded.
export function drawFrameOverlay(ctx: Ctx, x: number, y: number, w: number, h: number, rarity: Rarity | string | null | undefined): boolean {
  const color = frameColorForRarity(rarity);
  if (!color) return false;
  const size = pickSize(w);
  const img = decoded.get(`${color}:${size}`) ?? decoded.get(`${color}:full`) ?? decoded.get(`${color}:256`) ?? decoded.get(`${color}:128`);
  if (!img) return false;
  try {
    ctx.drawImage(img, x, y, w, h);
    return true;
  } catch {
    return false;
  }
}
