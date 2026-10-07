// ─────────────────────────────────────────────────────────────────────────────
// Style previews rendered on the user's OWN image.
//
// Browsing used to show MakeEmoji's prerendered cat for every style, which
// answers "what does this effect do" but not the question people actually have:
// "what will this look like on MY image?"
//
// Previews are rendered by the offline engine, never by MakeEmoji. That matters
// for two reasons: browsing 473 styles through a headless browser would mean a
// Chromium run per style, and previews must stay available even when MakeEmoji
// is down. The final generation is untouched — it still goes through the
// MakeEmoji provider at full settings.
//
// A preview is deliberately cheap: small, short, and cached. It is a thumbnail
// of an idea, not the artefact.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { logger } from "../../../lib/logger.js";
import { renderOffline } from "../providers/offline/index.js";
import type { EmojiFormat } from "../types.js";

/**
 * Preview edge length. Small enough to render in well under a second and to
 * keep the cache light, large enough to read in Discord's embed image slot.
 */
const PREVIEW_SIZE = "64";

/** Previews are always animated — a still frame cannot show what a style does. */
const PREVIEW_FORMAT: EmojiFormat = "gif";

/**
 * Thumbnail edge length for the contact-sheet board. Bigger than the animated
 * preview because several are tiled into one canvas and then read at a glance.
 */
const THUMB_SIZE = "96";

/**
 * Bump when the preview pipeline changes in a way that makes stored bytes
 * wrong. It is part of the cache key, so old entries are ignored rather than
 * served.
 */
const PREVIEW_VERSION = 1;

/** Ceilings. Previews are image buffers, so this cannot grow unbounded. */
const MAX_ENTRIES = 160;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const TTL_MS = 30 * 60 * 1000;

interface PreviewEntry {
  key: string;
  buffer: Buffer;
  expiresAt: number;
  usedAt: number;
}

const entries = new Map<string, PreviewEntry>();
let totalBytes = 0;
let hits = 0;
let misses = 0;

/**
 * Identity of a target image, for cache keying.
 *
 * Hashing the CONTENT rather than a URL is what stops one person's avatar
 * preview being served for someone else's, and makes a re-uploaded but
 * different image miss instead of colliding.
 */
/** Same Buffer instance is hashed many times per board page — cache it. */
const hashByBuffer = new WeakMap<Buffer, string>();

export function targetHash(image: Buffer): string {
  const cached = hashByBuffer.get(image);
  if (cached) return cached;
  const hash = createHash("sha256").update(image).digest("hex").slice(0, 32);
  hashByBuffer.set(image, hash);
  return hash;
}

export function previewKey(hash: string, style: string): string {
  return `${PREVIEW_VERSION}:${hash}:${style}`;
}

function drop(entry: PreviewEntry): void {
  if (entries.delete(entry.key)) totalBytes -= entry.buffer.length;
}

/** Expire, then evict least-recently-used until back inside both ceilings. */
function enforceBounds(): void {
  const now = Date.now();
  for (const entry of [...entries.values()]) {
    if (entry.expiresAt <= now) drop(entry);
  }
  if (entries.size <= MAX_ENTRIES && totalBytes <= MAX_TOTAL_BYTES) return;

  for (const entry of [...entries.values()].sort((a, b) => a.usedAt - b.usedAt)) {
    if (entries.size <= MAX_ENTRIES && totalBytes <= MAX_TOTAL_BYTES) break;
    drop(entry);
  }
}

function getCached(key: string): Buffer | undefined {
  const entry = entries.get(key);
  if (!entry) { misses++; return undefined; }
  if (entry.expiresAt <= Date.now()) { drop(entry); misses++; return undefined; }
  entry.usedAt = Date.now();
  hits++;
  return entry.buffer;
}

function putCached(key: string, buffer: Buffer): void {
  const existing = entries.get(key);
  if (existing) drop(existing);
  entries.set(key, {
    key, buffer, expiresAt: Date.now() + TTL_MS, usedAt: Date.now(),
  });
  totalBytes += buffer.length;
  enforceBounds();
}

/**
 * Render `style` over `image` as a small animated preview.
 *
 * Returns null when the style cannot be previewed locally — the caller then
 * falls back to MakeEmoji's CDN thumbnail. A preview is a convenience, so a
 * failure here must never surface as a command error.
 */
export async function renderStylePreview(
  image: Buffer, style: string,
): Promise<Buffer | null> {
  const key = previewKey(targetHash(image), style);

  const cached = getCached(key);
  if (cached) return cached;

  try {
    const result = await renderOffline({
      image,
      animation: style,
      format: PREVIEW_FORMAT,
      size: PREVIEW_SIZE,
      preview: true,
    });
    if (!result.buffer.length) return null;
    putCached(key, result.buffer);
    return result.buffer;
  } catch (err) {
    logger.debug(
      { style, err: err instanceof Error ? err.message : String(err) },
      "style preview unavailable; falling back to the CDN thumbnail",
    );
    return null;
  }
}

/**
 * Render `style` over `image` as a single still PNG thumbnail for the board.
 *
 * The contact sheet needs one representative frame per cell, drawn together in a
 * canvas. A GIF cannot be tiled without decoding, so the board asks for a still
 * instead — cheap to render, cheap to `loadImage`. Cached under its own key
 * namespace so it never collides with the animated preview bytes.
 *
 * Returns null when the style cannot be rendered locally; the board then draws a
 * placeholder cell so browsing never breaks on one unsupported style.
 */
export async function renderStyleThumb(
  image: Buffer, style: string,
): Promise<Buffer | null> {
  const key = `thumb:${previewKey(targetHash(image), style)}`;

  const cached = getCached(key);
  if (cached) return cached;

  try {
    const result = await renderOffline({
      image,
      animation: style,
      format: "png",
      size: THUMB_SIZE,
      preview: true,
    });
    if (!result.buffer.length) return null;
    putCached(key, result.buffer);
    return result.buffer;
  } catch (err) {
    logger.debug(
      { style, err: err instanceof Error ? err.message : String(err) },
      "style thumbnail unavailable; board will draw a placeholder cell",
    );
    return null;
  }
}

/**
 * Render `style` over `image` as an animated GIF sized for a board cell.
 *
 * The fully-animated board decodes these back into frames and tiles them, so it
 * needs motion at a larger size than the tiny hover preview. Cached under its own
 * key namespace; returns null when the style can't be rendered locally (the board
 * then falls back to a still thumbnail for that cell).
 */
export async function renderStyleThumbGif(
  image: Buffer, style: string,
): Promise<Buffer | null> {
  const key = `thumbgif:${previewKey(targetHash(image), style)}`;

  const cached = getCached(key);
  if (cached) return cached;

  try {
    const result = await renderOffline({
      image,
      animation: style,
      format: "gif",
      size: THUMB_SIZE,
      preview: true,
    });
    if (!result.buffer.length) return null;
    putCached(key, result.buffer);
    return result.buffer;
  } catch (err) {
    logger.debug(
      { style, err: err instanceof Error ? err.message : String(err) },
      "animated style thumbnail unavailable; board cell falls back to a still",
    );
    return null;
  }
}

/**
 * Warm previews for styles the user is about to see.
 *
 * Fire-and-forget: browsing must not wait on it, and a failure is already
 * handled by `renderStylePreview` returning null on the real request.
 */
export function prefetchStylePreviews(image: Buffer, styles: string[]): void {
  for (const style of styles.slice(0, 6)) {
    const key = previewKey(targetHash(image), style);
    if (entries.has(key)) continue;
    void renderStylePreview(image, style).catch(() => {});
  }
}

export interface PreviewCacheStats {
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
}

export function previewCacheStats(): PreviewCacheStats {
  return { entries: entries.size, bytes: totalBytes, hits, misses };
}

export function clearPreviewRenderCache(): void {
  entries.clear();
  totalBytes = 0;
  hits = 0;
  misses = 0;
}

export { PREVIEW_SIZE, PREVIEW_FORMAT, PREVIEW_VERSION };
