// Shared raster prep for every canvas that draws a remote image.
//
// Card uploads are often phone photos or full-resolution scans. Decoding one
// of those straight into @napi-rs/canvas keeps a bitmap of width×height×4
// bytes for as long as the art cache holds it. A few dozen of those is the
// difference between a few hundred megabytes and multiple gigabytes, and the
// canvases only ever paint the art into a window a few hundred pixels wide.
//
// libvips (sharp) shrinks on the way in. Callers then hand a modest PNG to
// Skia. @napi-rs/canvas stays the only canvas implementation — node-canvas
// (Cairo) and color-thief are not loaded.

import sharp from "sharp";
import { logger } from "../../lib/logger.js";
import "../../lib/native-memory.js";

/** Longest edge for card art. Covers the largest card window (reveal ~660px). */
export const CARD_ART_MAX_EDGE = 768;

/** Longest edge for arena / trophy backdrops (canvases are ~1000×560 to 1200×800). */
export const BACKDROP_MAX_EDGE = 1280;

/** Reject pathological uploads before libvips allocates the full bitmap. */
const MAX_INPUT_PIXELS = 32_000_000;

/**
 * First frame only, oriented, fitted inside `maxEdge`, encoded as PNG.
 * Returns null when the bytes are not an image or exceed MAX_INPUT_PIXELS.
 * Small sources are not enlarged.
 */
export async function shrinkArtBuffer(input: Buffer, maxEdge: number): Promise<Buffer | null> {
  try {
    return await sharp(input, {
      animated: false,
      limitInputPixels: MAX_INPUT_PIXELS,
      pages: 1,
    })
      .rotate()
      .resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 6 })
      .toBuffer();
  } catch (err) {
    logger.debug({ err, bytes: input.length, maxEdge }, "raster: could not shrink image");
    return null;
  }
}

/**
 * A single accent colour from a small cover-sample of the image.
 * Prefers a saturated mid-tone so near-black borders don't win.
 * Falls back to the average when the sample is all highlights or shadows.
 */
export async function dominantColorFromBuffer(input: Buffer): Promise<number | null> {
  try {
    const { data } = await sharp(input, {
      animated: false,
      limitInputPixels: MAX_INPUT_PIXELS,
      pages: 1,
    })
      .rotate()
      .resize(16, 16, { fit: "cover" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let best = 0;
    let bestScore = -1;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let count = 0;
    for (let i = 0; i + 2 < data.length; i += 3) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      sumR += r;
      sumG += g;
      sumB += b;
      count++;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) / max;
      const lum = (r + g + b) / 3;
      if (lum < 16 || lum > 245) continue;
      const score = sat * 3 + (1 - Math.abs(lum - 140) / 140);
      if (score > bestScore) {
        bestScore = score;
        best = (r << 16) | (g << 8) | b;
      }
    }
    if (!count) return null;
    if (bestScore >= 0) return best;
    const r = Math.round(sumR / count);
    const g = Math.round(sumG / count);
    const b = Math.round(sumB / count);
    return (r << 16) | (g << 8) | b;
  } catch (err) {
    logger.debug({ err }, "raster: dominant colour failed");
    return null;
  }
}
