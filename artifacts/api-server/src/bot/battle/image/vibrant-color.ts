// Battle image — extract dominant art colours with node-vibrant.
// Colours are cached per URL so repeated battles / board refreshes don't
// re-download images. Failures are silent; callers fall back to rarity colours.

import { Vibrant } from "node-vibrant/node";
import { logger } from "../../../lib/logger.js";

/** Cap URL→colour map so long-running bots don't retain every art URL forever. */
const COLOR_CACHE_MAX = 256;
const colorCache = new Map<string, number>();

function hexToDecimal(hex: string): number | null {
  const cleaned = hex.replace("#", "").trim();
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) return null;
  const parsed = parseInt(cleaned, 16);
  return Number.isNaN(parsed) ? null : parsed;
}

function rememberColor(artUrl: string, color: number): void {
  if (colorCache.has(artUrl)) colorCache.delete(artUrl);
  colorCache.set(artUrl, color);
  while (colorCache.size > COLOR_CACHE_MAX) {
    const oldest = colorCache.keys().next().value;
    if (oldest === undefined) break;
    colorCache.delete(oldest);
  }
}

/** Extract a dominant colour from a card-art URL. Returns null on failure. */
export async function extractArtColor(artUrl: string | null | undefined): Promise<number | null> {
  if (!artUrl) return null;
  const cached = colorCache.get(artUrl);
  if (cached != null) {
    // Refresh LRU order on hit.
    rememberColor(artUrl, cached);
    return cached;
  }

  try {
    const palette = await Vibrant.from(artUrl).getPalette();
    const swatch = palette.Vibrant ?? palette.Dominant ?? palette.Muted;
    if (!swatch) return null;
    const color = hexToDecimal(swatch.hex);
    if (color == null) return null;
    rememberColor(artUrl, color);
    return color;
  } catch (err) {
    logger.debug({ err, artUrl }, "battle image: vibrant extraction failed");
    return null;
  }
}

/** Blend two colours into a CSS-compatible gradient string. */
export function blendColors(a: number | null, b: number | null, fallback: string): [string, string] {
  const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;
  if (a != null && b != null) return [hex(a), hex(b)];
  if (a != null) return [hex(a), "#0b1622"];
  if (b != null) return ["#0b1622", hex(b)];
  return [fallback, fallback];
}
