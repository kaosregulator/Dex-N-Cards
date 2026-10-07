// Accent colours for battle art.
//
// The sample is taken from the same shrunk PNG the canvas draws, so a fight
// does not download and decode the full upload a second time just to pick a
// glow colour. node-vibrant used to do that fetch on its own.

import { logger } from "../../../lib/logger.js";
import { loadArtBuffer } from "../../animations/effects.js";
import { dominantColorFromBuffer } from "../../images/raster.js";

const colorCache = new Map<string, number>();
const COLOR_CACHE_MAX = 512;

function remember(url: string, color: number): void {
  colorCache.delete(url);
  colorCache.set(url, color);
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
    remember(artUrl, cached);
    return cached;
  }

  try {
    const png = await loadArtBuffer(artUrl);
    if (!png) return null;
    const color = await dominantColorFromBuffer(png);
    if (color == null) return null;
    remember(artUrl, color);
    return color;
  } catch (err) {
    logger.debug({ err, artUrl }, "battle image: accent extraction failed");
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
