// ─────────────────────────────────────────────────────────────────────────────
// Result cache.
//
// A generation costs a browser launch and a round trip to someone else's site,
// so repeating one is expensive for us and rude to them. Popular images get
// requested with identical settings constantly — the same server avatar through
// the same animation — and those should cost nothing the second time.
//
// The key is the SHA-256 of the source bytes plus every setting that changes the
// output. Hashing the content rather than the URL means the same picture hits
// the same entry whether it arrived as an attachment, an avatar or a link, and
// that a re-uploaded but different image never collides with the old one.
//
// Bounded by entry count, total bytes and age, because this holds finished image
// buffers and an unbounded one is a slow memory leak.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { logger } from "../../../lib/logger.js";
import type { GenerateOptions, GenerateResult } from "../types.js";

/** Entries expire after this. Short: MakeEmoji's output could change. */
const TTL_MS = 15 * 60 * 1000;

/** Ceilings on what the cache may hold (tuned for ~512 MB Railway boxes). */
const MAX_ENTRIES = 64;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

interface CacheEntry {
  key: string;
  result: GenerateResult;
  expiresAt: number;
  /** Last read, so eviction can drop the least recently used. */
  usedAt: number;
}

const entries = new Map<string, CacheEntry>();
let totalBytes = 0;

let hits = 0;
let misses = 0;

/**
 * Cache key for a request.
 *
 * Every field that can change the bytes is included; `signal` and `debug` are
 * not, because neither alters the output.
 */
export function cacheKey(options: GenerateOptions): string {
  const hash = createHash("sha256");
  hash.update(options.image);
  hash.update("\0");
  hash.update(JSON.stringify([
    options.animation,
    options.speed ?? "",
    options.direction ?? "",
    options.size ?? "",
    options.color ?? "",
    options.format,
    options.quality ?? "",
    options.platform ?? "",
  ]));
  return hash.digest("hex");
}

function drop(entry: CacheEntry): void {
  if (entries.delete(entry.key)) totalBytes -= entry.result.bytes;
}

/** Remove expired entries, then evict least-recently-used until within bounds. */
function enforceBounds(): void {
  const now = Date.now();
  for (const entry of [...entries.values()]) {
    if (entry.expiresAt <= now) drop(entry);
  }

  if (entries.size <= MAX_ENTRIES && totalBytes <= MAX_TOTAL_BYTES) return;

  const byAge = [...entries.values()].sort((a, b) => a.usedAt - b.usedAt);
  for (const entry of byAge) {
    if (entries.size <= MAX_ENTRIES && totalBytes <= MAX_TOTAL_BYTES) break;
    drop(entry);
  }
}

/** A cached result, or undefined. The returned result is marked `cached`. */
export function getCached(key: string): GenerateResult | undefined {
  const entry = entries.get(key);
  if (!entry) {
    misses++;
    return undefined;
  }
  if (entry.expiresAt <= Date.now()) {
    drop(entry);
    misses++;
    return undefined;
  }

  entry.usedAt = Date.now();
  hits++;
  return { ...entry.result, cached: true };
}

/** Store a result. Oversized results are skipped rather than evicting everything. */
export function putCached(key: string, result: GenerateResult): void {
  if (result.bytes > MAX_TOTAL_BYTES / 4) return;

  const existing = entries.get(key);
  if (existing) drop(existing);

  entries.set(key, {
    key,
    // Store it as a miss; `getCached` marks the copies it hands out.
    result: { ...result, cached: false },
    expiresAt: Date.now() + TTL_MS,
    usedAt: Date.now(),
  });
  totalBytes += result.bytes;
  enforceBounds();
}

/** Run `generate` unless an identical request is already cached. */
export async function withCache(
  options: GenerateOptions,
  generate: () => Promise<GenerateResult>,
): Promise<GenerateResult> {
  const key = cacheKey(options);

  const cached = getCached(key);
  if (cached) {
    logger.debug({ key: key.slice(0, 12), animation: options.animation }, "emoji cache hit");
    return cached;
  }

  const result = await generate();
  putCached(key, result);
  return result;
}

export interface CacheStats {
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
}

export function cacheStats(): CacheStats {
  return { entries: entries.size, bytes: totalBytes, hits, misses };
}

/** Empty the cache. Used by tests and by an admin "clear cache" action. */
export function clearCache(): void {
  entries.clear();
  totalBytes = 0;
  hits = 0;
  misses = 0;
}
