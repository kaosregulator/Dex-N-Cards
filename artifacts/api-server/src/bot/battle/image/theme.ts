// ─────────────────────────────────────────────────────────────────────────────
// Battle-image THEME / ASSET REGISTRY.
//
// Everything the layered renderer draws is configured here — nothing about
// geometry, colours, backgrounds, frames, element icons, or fonts lives inside
// the renderer itself. Swap a background, recolour a frame, or add an element
// icon by editing this file only; render.ts never changes.
//
// Assets are referenced by URL or local path (loaded at runtime) with pure
// canvas-drawn fallbacks, so a missing asset degrades gracefully instead of
// producing a broken image.
// ─────────────────────────────────────────────────────────────────────────────

import { RARITY_COLORS, type Rarity } from "../../cards-data.js";

// ── Canvas geometry ──────────────────────────────────────────────────────────
export const CANVAS = {
  width: 1000,
  height: 560,
  pad: 40,
};

// Where each card sits. Two cards, left & right, with the VS badge between.
export const CARD_BOX = {
  width: 340,
  height: 470,
  y: 45,
  leftX: 70,
  rightX: 590,
  radius: 18,
  borderWidth: 6,
  artInset: 10,        // gap between frame border and the art
};

export const VS_BADGE = {
  cx: CANVAS.width / 2,
  cy: CANVAS.height / 2,
  fontPx: 120,
};

// ── Backgrounds (modular — add/replace freely) ───────────────────────────────
// The renderer picks `default` unless a caller names another key. Each entry is
// a URL/path the renderer tries to load; if it fails, `fallbackGradient` draws.
export interface BackgroundAsset {
  key: string;
  label: string;
  src: string | null;   // remote URL or local file path; null = gradient only
  /** two-stop gradient used when `src` is null or fails to load */
  fallbackGradient: [string, string];
  /** diagonal split tint drawn over the background (the classic VS look) */
  splitTint?: string;
}

export const BACKGROUNDS: Record<string, BackgroundAsset> = {
  default: {
    key: "default",
    label: "Battlefield",
    src: process.env["BATTLE_BG_DEFAULT"] ?? null,
    fallbackGradient: ["#0b1622", "#1c2f45"],
    splitTint: "rgba(0,0,0,0.28)",
  },
  storm: {
    key: "storm",
    label: "Storm Sea",
    src: process.env["BATTLE_BG_STORM"] ?? null,
    fallbackGradient: ["#0a0f1e", "#243b55"],
    splitTint: "rgba(10,20,40,0.30)",
  },
  ember: {
    key: "ember",
    label: "Ember Front",
    src: process.env["BATTLE_BG_EMBER"] ?? null,
    fallbackGradient: ["#1a0d0a", "#3b1e14"],
    splitTint: "rgba(40,10,0,0.30)",
  },
};

export function resolveBackground(key?: string | null): BackgroundAsset {
  return (key && BACKGROUNDS[key]) || BACKGROUNDS["default"]!;
}

// ── Rarity frame palette (drives border colour + glow) ───────────────────────
// Reuses the project's canonical rarity colours so the battle image matches the
// rest of the game. Accepts a runtime override colour (custom /rarity tiers).
export function rarityHex(rarity: Rarity, overrideColor?: number | null): string {
  const n = overrideColor ?? RARITY_COLORS[rarity] ?? 0x5865f2;
  return `#${n.toString(16).padStart(6, "0")}`;
}

export const RARITY_BADGE_BG = "rgba(20,20,24,0.82)";
export const RARITY_BADGE_FG = "#ffffff";

// ── Frame overlays (modular — your own frame PNGs) ───────────────────────────
// Drop-in frame artwork drawn OVER each card box. Transparent PNGs sized to the
// card work best. Leave a slot's `src` null to use the drawn rarity border for
// that band. You have three, so there are three bands: low / mid / high rarity.
// Point each at a URL or a local path (or set the env var) — the renderer
// overlays it automatically; nothing else changes.
export interface FrameAsset { key: string; label: string; src: string | null }

export const FRAMES: Record<string, FrameAsset> = {
  low:  { key: "low",  label: "Common / Uncommon", src: process.env["BATTLE_FRAME_LOW"] ?? null },
  mid:  { key: "mid",  label: "Rare / Epic",       src: process.env["BATTLE_FRAME_MID"] ?? null },
  high: { key: "high", label: "Legendary / Mythic", src: process.env["BATTLE_FRAME_HIGH"] ?? null },
};

// Which of the three frames a rarity uses. Adjust the bands freely.
export function resolveFrameAsset(rarity: Rarity): FrameAsset | null {
  const band =
    rarity === "common" || rarity === "uncommon" ? "low" :
    rarity === "rare" || rarity === "epic" ? "mid" : "high";
  const f = FRAMES[band];
  return f && f.src ? f : null;
}

// ── Element icons (modular — maps card type → drawn glyph) ────────────────────
// Each element is a coloured disc plus a unicode glyph. Those glyphs use the
// shared symbol font. Discord custom emoji in names and rarity labels is drawn
// from the emoji image cache. Add a type by adding an entry.
export interface ElementIcon {
  glyph: string;    // unicode drawn in the disc
  disc: string;     // disc fill colour
  ring: string;     // disc ring colour
}

export const ELEMENTS: Record<string, ElementIcon> = {
  tank:      { glyph: "⚙", disc: "#3b4a5a", ring: "#8fa9c4" },
  aircraft:  { glyph: "✈", disc: "#2f5d86", ring: "#8fd0ff" },
  ship:      { glyph: "⚓", disc: "#1f4f6b", ring: "#7fd6ff" },
  vehicle:   { glyph: "▲", disc: "#5a4a2f", ring: "#e0c07a" },
  infantry:  { glyph: "✦", disc: "#4a5a3b", ring: "#b7d68a" },
  boss:      { glyph: "☠", disc: "#3a2340", ring: "#c58cff" },
  community: { glyph: "♛", disc: "#5a4620", ring: "#ffd36b" },
  event:     { glyph: "✺", disc: "#5a2040", ring: "#ff8ac0" },
  achievement:{ glyph: "★", disc: "#5a5220", ring: "#ffe08a" },
  limited:   { glyph: "◆", disc: "#204a5a", ring: "#8ae0ff" },
};

export function resolveElement(cardType: string | null | undefined): ElementIcon {
  return ELEMENTS[(cardType ?? "").toLowerCase()] ?? { glyph: "?", disc: "#3a3a42", ring: "#9aa0aa" };
}

// ── Fonts ─────────────────────────────────────────────────────────────────────
// Registered lazily by the renderer if the files exist; otherwise the canvas
// default sans is used. Keep names stable — layers reference them by family.
export const FONTS = {
  display: "DNBattleDisplay",   // heavy — VS badge, names
  body: "DNBattleBody",         // regular — series, ids, chips
};

// Optional font files (drop .ttf/.otf here to upgrade typography). Absent = ok.
export const FONT_FILES: { path: string; family: string; weight?: string }[] = [
  { path: process.env["BATTLE_FONT_DISPLAY"] ?? "", family: FONTS.display, weight: "800" },
  { path: process.env["BATTLE_FONT_BODY"] ?? "", family: FONTS.body, weight: "500" },
];
