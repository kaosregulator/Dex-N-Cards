// ─────────────────────────────────────────────────────────────────────────────
// HQ — theme registry (data-only).
//
// A theme is the entire PRESENTATION layer for a Headquarters: wall/floor
// colours, accent, glass tint, lighting mood and ambient particles. The engine
// and renderer know only these generic fields — nothing here says "military" or
// "castle" in code; that meaning lives in the data + (later) an asset pack keyed
// by `spritePrefix`. Add a theme = append to HQ_THEMES.
//
// Registry shape matches bot/cards/frames.ts (Map index + resolve-to-default).
// ─────────────────────────────────────────────────────────────────────────────

import type { AtmospherePreset } from "../../animations/atmosphere.js";
import type { UnlockRule } from "./unlock-rules.js";

export type HqLighting = "dawn" | "dusk" | "night" | "neon";

export interface HqPalette {
  wallTop: string;    // back-wall gradient (top → bottom)
  wallBottom: string;
  floorNear: string;  // perspective floor (near → far)
  floorFar: string;
  glass: string;      // display-case tint (rgba)
  light: string;      // key-light tint (rgba)
  accent: number;     // embed accent + procedural highlights
}

export interface HqTheme {
  id: string;
  name: string;
  emoji: string;
  lighting: HqLighting;
  atmosphere: AtmospherePreset;
  palette: HqPalette;
  // Asset-pack prefix. The asset manager looks up `${spritePrefix}/${key}`; when
  // no art is bundled every lookup misses and the renderer draws procedurally.
  spritePrefix: string;
  unlock: UnlockRule;
}

export const HQ_THEMES: HqTheme[] = [
  {
    id: "command",
    name: "Command Post",
    emoji: "🎖️",
    lighting: "dusk",
    atmosphere: "ember",
    spritePrefix: "command",
    unlock: { kind: "always" },
    palette: {
      wallTop: "#2b3327", wallBottom: "#171c14",
      floorNear: "#3a3f31", floorFar: "#20241b",
      glass: "rgba(183,162,74,0.14)", light: "rgba(255,214,120,0.16)",
      accent: 0xb7a24a,
    },
  },
  {
    id: "arcane",
    name: "Arcane Sanctum",
    emoji: "🏰",
    lighting: "night",
    atmosphere: "arena",
    spritePrefix: "arcane",
    unlock: { kind: "accountLevel", n: 10 },
    palette: {
      wallTop: "#241b3a", wallBottom: "#120d20",
      floorNear: "#2e2350", floorFar: "#161029",
      glass: "rgba(155,89,182,0.16)", light: "rgba(190,140,255,0.18)",
      accent: 0x9b59b6,
    },
  },
  {
    id: "void",
    name: "Void Station",
    emoji: "🛰️",
    lighting: "neon",
    atmosphere: "none",
    spritePrefix: "void",
    unlock: { kind: "accountLevel", n: 25 },
    palette: {
      wallTop: "#0b1418", wallBottom: "#05090c",
      floorNear: "#0e1c22", floorFar: "#050b0e",
      glass: "rgba(47,212,212,0.16)", light: "rgba(47,212,212,0.18)",
      accent: 0x2fd4d4,
    },
  },
];

export const DEFAULT_THEME_ID = "command";

const THEME_BY_ID = new Map<string, HqTheme>(HQ_THEMES.map(t => [t.id, t]));

// Resolve a theme id to its definition, degrading to the default (never throws)
// so a stale/removed id can't break a render — same self-healing contract as
// resolveActiveFrame in cards/frames.ts.
export function resolveTheme(id: string | null | undefined): HqTheme {
  return (id && THEME_BY_ID.get(id)) || THEME_BY_ID.get(DEFAULT_THEME_ID)!;
}

export function getThemeById(id: string): HqTheme | undefined {
  return THEME_BY_ID.get(id);
}
