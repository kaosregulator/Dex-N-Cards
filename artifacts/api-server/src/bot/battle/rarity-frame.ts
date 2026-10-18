// Per-rarity battle frame colours.
//
// Rarities stay the source of truth. Each built-in rarity already has a default
// frame (the level-1 frame for that tier). Staff can give one rarity its own
// colour recipe in the frame editor; every other rarity keeps what it had.
// A rarity with no saved recipe still follows the shared frame setting.

import type { Rarity } from "../cards-data.js";
import { RARITY_ORDER } from "../cards-data.js";
import { defaultFrameForRarity } from "../cards/frames.js";
import { frameColorModeOf, hexOf, parseHexColor, type FrameColorMode } from "./frame-color.js";
import { defaultFrameStyle, isFrameStyle, type FrameStyle } from "./frame-styles.js";

export interface RarityFrameRecipe {
  mode: FrameColorMode;
  a: string | null;
  b: string | null;
  style: FrameStyle;
}

export type RarityFrameMap = Partial<Record<Rarity, RarityFrameRecipe>>;

export interface RarityFrameSettings {
  battleFrameColorMode?: string | null;
  battleFrameColorA?: string | null;
  battleFrameColorB?: string | null;
  battleFrameByRarity?: unknown;
}

export interface ResolvedRarityFrame {
  rarity: Rarity;
  mode: FrameColorMode;
  colorA: number | null;
  colorB: number | null;
  style: FrameStyle;
  /** rarity = staff saved this tier; shared = the guild-wide frame setting. */
  origin: "rarity" | "shared";
}

export function isBuiltinRarity(value: string | null | undefined): value is Rarity {
  return !!value && (RARITY_ORDER as readonly string[]).includes(value);
}

function lighten(n: number): number {
  const channel = (shift: number) => {
    const c = (n >> shift) & 255;
    return Math.round(c + (255 - c) * 0.38);
  };
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

/** The colour pair and border style this rarity starts with. Default restores both. */
export function builtinRarityFrame(rarity: Rarity): RarityFrameRecipe {
  const frame = defaultFrameForRarity(rarity);
  return { mode: "custom", a: hexOf(frame.color), b: hexOf(lighten(frame.color)), style: defaultFrameStyle(rarity) };
}

export function parseRarityFrameMap(value: unknown): RarityFrameMap {
  if (!value || typeof value !== "object") return {};
  const out: RarityFrameMap = {};
  for (const rarity of RARITY_ORDER) {
    const raw = (value as Record<string, unknown>)[rarity];
    if (!raw || typeof raw !== "object") continue;
    const row = raw as { mode?: unknown; a?: unknown; b?: unknown; style?: unknown };
    const mode = frameColorModeOf(typeof row.mode === "string" ? row.mode : null);
    const a = typeof row.a === "string" && parseHexColor(row.a) != null ? row.a : null;
    const b = typeof row.b === "string" && parseHexColor(row.b) != null ? row.b : null;
    const rawStyle = typeof row.style === "string" ? row.style : null;
    const style = isFrameStyle(rawStyle) ? rawStyle : defaultFrameStyle(rarity);
    out[rarity] = { mode, a, b, style };
  }
  return out;
}

export function putRarityFrame(
  current: unknown,
  rarity: Rarity,
  next: { mode: FrameColorMode; a: string | null; b: string | null; style?: FrameStyle },
): RarityFrameMap {
  const parsed = parseRarityFrameMap(current);
  const prev = parsed[rarity];
  return {
    ...parsed,
    [rarity]: {
      mode: next.mode,
      a: next.a,
      b: next.b,
      style: next.style ?? prev?.style ?? defaultFrameStyle(rarity),
    },
  };
}

export function resolveRarityFrame(settings: RarityFrameSettings, rarity: Rarity): ResolvedRarityFrame {
  const saved = parseRarityFrameMap(settings.battleFrameByRarity)[rarity];
  if (saved) {
    return {
      rarity,
      mode: saved.mode,
      colorA: parseHexColor(saved.a),
      colorB: parseHexColor(saved.b),
      style: saved.style,
      origin: "rarity",
    };
  }
  const sharedA = parseHexColor(settings.battleFrameColorA);
  const sharedB = parseHexColor(settings.battleFrameColorB);
  const sharedMode = settings.battleFrameColorMode;
  const sharedTouched = (sharedMode != null && sharedMode !== "image") || sharedA != null || sharedB != null;
  if (sharedTouched) {
    return {
      rarity,
      mode: frameColorModeOf(sharedMode),
      colorA: sharedA,
      colorB: sharedB,
      style: defaultFrameStyle(rarity),
      origin: "shared",
    };
  }
  const builtin = builtinRarityFrame(rarity);
  return {
    rarity,
    mode: builtin.mode,
    colorA: parseHexColor(builtin.a),
    colorB: parseHexColor(builtin.b),
    style: builtin.style,
    origin: "shared",
  };
}
