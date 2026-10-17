// Admin-uploaded battle backgrounds. Cover-fit an image the server chose and
// wash it so cards and HUD stay readable. Animated scene strips (Ember Field,
// Thunderstorm, and the rest) are not loaded or stored.

import type { CanvasMod, Ctx } from "./engine.js";
import { logger } from "../../lib/logger.js";

type LoadedImage = import("@napi-rs/canvas").Image;

const imageCache = new WeakMap<object, Promise<LoadedImage | null>>();
const urlCache = new Map<string, Promise<LoadedImage | null>>();
const URL_CACHE_MAX = 32;

function rememberUrl(url: string, pending: Promise<LoadedImage | null>): void {
  urlCache.set(url, pending);
  while (urlCache.size > URL_CACHE_MAX) {
    const oldest = urlCache.keys().next().value;
    if (oldest === undefined) break;
    urlCache.delete(oldest);
  }
}

async function loadBackdrop(mod: CanvasMod, image: Buffer | string): Promise<LoadedImage | null> {
  if (typeof image === "string") {
    const url = image.trim();
    if (!url) return null;
    const cached = urlCache.get(url);
    if (cached) return cached;
    const pending = (async () => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
        if (!res.ok) return null;
        return await mod.loadImage(Buffer.from(await res.arrayBuffer()));
      } catch (err) {
        logger.debug({ err }, "arena-bg: failed to decode backdrop image");
        return null;
      }
    })();
    rememberUrl(url, pending);
    return pending;
  }

  let pending = imageCache.get(image);
  if (!pending) {
    pending = (async () => {
      try { return await mod.loadImage(image); }
      catch (err) {
        logger.debug({ err }, "arena-bg: failed to decode backdrop image");
        return null;
      }
    })();
    imageCache.set(image, pending);
  }
  return pending;
}

/**
 * Draw an admin-uploaded (or siege) image as the backdrop, cover-fit to
 * (width, height) with a dark readability wash. `image` is raw bytes or a URL.
 * Returns false when it cannot be decoded so the caller keeps the gradient.
 */
export async function drawImageBackground(
  ctx: Ctx,
  mod: CanvasMod,
  image: Buffer | string | null | undefined,
  width: number,
  height: number,
): Promise<boolean> {
  if (!image) return false;
  const img = await loadBackdrop(mod, image);
  if (!img) return false;

  const s = Math.max(width / img.width, height / img.height);
  const dw = img.width * s, dh = img.height * s;
  const dx = (width - dw) / 2, dy = (height - dh) / 2;
  ctx.save();
  (ctx as unknown as {
    drawImage(img: LoadedImage, dx: number, dy: number, dw: number, dh: number): void;
  }).drawImage(img, dx, dy, dw, dh);
  ctx.fillStyle = "rgba(6,8,14,0.42)";
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
  return true;
}
