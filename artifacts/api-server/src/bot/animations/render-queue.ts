// ─────────────────────────────────────────────────────────────────────────────
// Global render queue (p-queue).
//
// Canvas renders (battles, raids, pack openings, collection/profile cards,
// leaderboards) are CPU-heavy. Under load — a busy raid, several battles, a
// flurry of pack opens — running them all at once spikes CPU and can stall the
// event loop or OOM. This funnels EVERY heavy render through one shared queue
// with a small concurrency cap, so jobs run a few at a time and simply wait
// their turn instead of piling up.
//
// IMPORTANT: only wrap LEAF renderers (functions that create + encode a canvas
// themselves). Never queue a function that awaits another queued function, or a
// full queue could deadlock (parents holding all slots while waiting on
// children that can't get one).
// ─────────────────────────────────────────────────────────────────────────────

import PQueue from "p-queue";
import { logger } from "../../lib/logger.js";

// Default 2, hard ceiling 4. Each job already keeps two canvases (see
// encodeAnimation); a higher default piled those up under a raid + battles.
// Raise with RENDER_CONCURRENCY when the host has RAM to spare.
const CONCURRENCY = Math.min(4, Math.max(1, Number(process.env["RENDER_CONCURRENCY"] ?? 2)));

const queue = new PQueue({ concurrency: CONCURRENCY });

let warnedDepth = 0;

/**
 * Priority bands for the shared queue. Higher runs first (p-queue semantics).
 * A user waiting on their final emoji should never sit behind speculative
 * preview/board work, so on-demand output outranks previews, which outrank
 * background prefetch/warm jobs.
 */
export const RENDER_PRIORITY = {
  /** The final emoji the user explicitly asked for (Apply / generate). */
  output: 10,
  /** A preview/board the user is actively looking at. */
  preview: 0,
  /** Speculative warm-ups (next page, avatar pre-warm) — always yield. */
  background: -10,
} as const;

/**
 * Run a heavy canvas render through the shared queue. Returns exactly what `fn`
 * returns (including null on best-effort renderers). `label` is for logging only.
 * `priority` orders jobs when the queue is saturated (see RENDER_PRIORITY).
 */
export function queueRender<T>(
  label: string, fn: () => Promise<T>, priority: number = RENDER_PRIORITY.preview,
): Promise<T> {
  // Light backpressure visibility: log once when the backlog gets deep so a
  // render storm is diagnosable, without spamming.
  const depth = queue.size + queue.pending;
  if (depth >= CONCURRENCY * 6 && depth - warnedDepth >= CONCURRENCY * 3) {
    warnedDepth = depth;
    logger.warn({ label, depth, concurrency: CONCURRENCY }, "render queue backlog is deep");
  } else if (depth < CONCURRENCY) {
    warnedDepth = 0;
  }
  return queue.add(fn, { priority }) as Promise<T>;
}

/** Current backlog (queued + in-flight) — handy for health/metrics. */
export function renderQueueDepth(): number {
  return queue.size + queue.pending;
}

export function renderQueueConcurrency(): number {
  return CONCURRENCY;
}
