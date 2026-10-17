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
 * Dominant colour of the whole picture.
 * The sample is stretched to a 24×24 grid (`fit: fill`) so a vehicle at the
 * edge is included, not cropped away by a center cover. Center cells count
 * twice so a centred subject still leads a big flat sky. Saturated mid-tones
 * beat near-black borders.
 */
export async function dominantColorFromBuffer(input: Buffer): Promise<number | null> {
  try {
    const size = 24;
    const { data, info } = await sharp(input, {
      animated: false,
      limitInputPixels: MAX_INPUT_PIXELS,
      pages: 1,
    })
      .rotate()
      .resize(size, size, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const buckets = new Map<number, { r: number; g: number; b: number; w: number }>();
    const cols = info.width || size;
    const rows = info.height || size;
    let fallbackR = 0;
    let fallbackG = 0;
    let fallbackB = 0;
    let fallbackW = 0;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = (y * cols + x) * 3;
        const r = data[i] ?? 0;
        const g = data[i + 1] ?? 0;
        const b = data[i + 2] ?? 0;
        const cx = Math.abs(x - (cols - 1) / 2) / cols;
        const cy = Math.abs(y - (rows - 1) / 2) / rows;
        const center = cx < 0.22 && cy < 0.22 ? 2 : 1;
        fallbackR += r * center;
        fallbackG += g * center;
        fallbackB += b * center;
        fallbackW += center;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const sat = max === 0 ? 0 : (max - min) / max;
        const lum = (r + g + b) / 3;
        if (lum < 18 || lum > 242 || sat < 0.18) continue;
        const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
        const weight = center * (0.45 + sat);
        const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, w: 0 };
        bucket.r += r * weight;
        bucket.g += g * weight;
        bucket.b += b * weight;
        bucket.w += weight;
        buckets.set(key, bucket);
      }
    }
    let best: { r: number; g: number; b: number; w: number } | null = null;
    for (const bucket of buckets.values()) {
      if (!best || bucket.w > best.w) best = bucket;
    }
    if (best && best.w > 0) {
      return (Math.round(best.r / best.w) << 16) | (Math.round(best.g / best.w) << 8) | Math.round(best.b / best.w);
    }
    if (!fallbackW) return null;
    return (Math.round(fallbackR / fallbackW) << 16) | (Math.round(fallbackG / fallbackW) << 8) | Math.round(fallbackB / fallbackW);
  } catch (err) {
    logger.debug({ err }, "raster: dominant colour failed");
    return null;
  }
}
