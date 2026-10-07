// ─────────────────────────────────────────────────────────────────────────────
// Style Board — the visual heart of the /emoji dashboard.
//
// After a target is chosen, the browser is a *contact sheet*: the page's styles
// are each rendered on the user's own image and tiled into one canvas, numbered,
// so the whole page can be judged at a glance. The chosen style is ringed;
// favorites carry a star; the target itself is shown in the header.
//
// The board is fully ANIMATED. Each cell's style is rendered as a small GIF, the
// frames are decoded with gifuct-js, and they are tiled per frame into one
// looping board GIF (gifencoder). So every cell moves at once, on the user's own
// image. Canvas + frames are used only for this menu chrome — the emoji output
// itself still goes through the render engine.
//
// Performance notes (see board-bench):
//   • Cell thumb GIFs go through the shared render queue (concurrency 3). We
//     load cells with the same concurrency so one board cannot flood the queue.
//   • Decoded composited frames are cached (bounded) so warm boards skip decode.
//   • Finished board GIFs are cached (bounded) so identical pages are free.
//   • Board chrome is painted once and blitted; only thumbnails change per frame.
//   • Each cell advances on its own delay timeline (not f % length + avg delay).
//   • Board encode is serialized so concurrent /emoji users cannot stack encodes.
//
// If the canvas backend is missing, or nothing on the page actually animates, it
// degrades to a still PNG contact sheet, so browsing never breaks.
// ─────────────────────────────────────────────────────────────────────────────

import GIFEncoder from "gifencoder";
import { parseGIF, decompressFrames } from "gifuct-js";
import { getCanvas, type CanvasMod } from "../../animations/engine.js";
import { logger } from "../../../lib/logger.js";
import {
  previewKey, renderStyleThumb, renderStyleThumbGif, targetHash,
} from "../preview/index.js";
import { isFavorite } from "./favorites.js";
import type { StyleEntry } from "./styles-picker.js";

/** Styles shown on one board page. Eight fills a tidy 4×2 grid of live previews. */
export const BOARD_PAGE_SIZE = 8;

/** Attachment names — the extension follows whether the board animated. */
export const BOARD_FILENAME = "style-board.gif";
export const BOARD_FILENAME_STILL = "style-board.png";

/** Frame ceiling for the tiled board GIF — enough for smooth motion, small file. */
const BOARD_MAX_FRAMES = 14;

/**
 * NeuQuant sample factor. Profiled 12 vs 16 vs 20 on board-sized encodes: 16 is
 * ~15–20% faster than 12 with nearly identical byte size on this chrome-heavy
 * image; 20 saves more CPU but starts to dirty gradients. Keep size guard below.
 */
const BOARD_QUALITY = 16;

/** Give up on the animated board above this size and fall back to the still PNG. */
const BOARD_MAX_BYTES = 7_500_000;

/** Match the shared render-queue concurrency so one board does not flood it. */
const CELL_LOAD_CONCURRENCY = 3;

// Layout — plain pixels. Chrome is painted once; only cell thumbnails change
// per frame. Kept generous so labels stay legible when Discord scales the image.
const COLS = 4;
const CELL_W = 150;
const CELL_H = 168;
const THUMB = 104;
const GAP = 14;
const PAD = 20;
const HEADER_H = 100;

// Palette — Discord blurple family on a dark card, so the board sits naturally
// in both light and dark client themes.
const BG_TOP = "#2b2d42";
const BG_BOT = "#1e1f2e";
const CELL_BG = "#33364a";
const CELL_BG_SEL = "#3b4670";
const RING = "#5865f2";
const STAR = "#f1c40f";
const TEXT = "#eceef5";
const SUBTLE = "#aab0c4";
const BADGE_BG = "#12131c";

/** Anything with a width/height that a 2D context can draw — an Image or Canvas. */
type Drawable = { width: number; height: number };

/** Minimal 2D context surface the board uses — avoids pulling in the DOM lib. */
interface BoardCtx {
  fillStyle: string | object;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  globalAlpha: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, s: number, e: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
  save(): void;
  restore(): void;
  clip(): void;
  drawImage(img: unknown, dx: number, dy: number, dw?: number, dh?: number): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): {
    addColorStop(offset: number, color: string): void;
  };
}

/** Context surface used while decoding GIF frames onto working canvases. */
interface FrameCtx {
  createImageData(w: number, h: number): { data: Uint8ClampedArray };
  putImageData(image: { data: Uint8ClampedArray }, dx: number, dy: number): void;
  drawImage(img: unknown, dx: number, dy: number): void;
  drawImage(
    img: unknown,
    sx: number, sy: number, sw: number, sh: number,
    dx: number, dy: number, dw: number, dh: number,
  ): void;
  clearRect(x: number, y: number, w: number, h: number): void;
}

function roundRect(
  ctx: BoardCtx, x: number, y: number, w: number, h: number, r: number,
): void {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

/** Truncate a label to fit `maxWidth`, adding an ellipsis when it overflows. */
function fitText(ctx: BoardCtx, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) {
    t = t.slice(0, -1);
  }
  return `${t}…`;
}

/** Draw an image centered and contained inside a square box. */
function drawContain(
  ctx: BoardCtx, img: Drawable, x: number, y: number, box: number,
): void {
  const scale = Math.min(box / img.width, box / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img as unknown, x + (box - w) / 2, y + (box - h) / 2, w, h);
}

export interface BoardOptions {
  image: Buffer;
  targetLabel: string;
  styles: StyleEntry[];
  focusValue: string;
  userId: string;
  page: number;
  pages: number;
  total: number;
  format: string;
  /** Speculative warm/prefetch — encodes only when no on-demand board is waiting. */
  background?: boolean;
}

/** What renderBoard hands back: the encoded image and the attachment name to use. */
export interface BoardResult {
  buffer: Buffer;
  name: string;
  animated: boolean;
}

/** Board canvas dimensions for a page of `count` cells. */
function boardDims(count: number): { width: number; height: number; gridW: number; rows: number } {
  const rows = Math.max(1, Math.ceil(count / COLS));
  const gridW = COLS * CELL_W + (COLS - 1) * GAP;
  const width = PAD * 2 + gridW;
  const height = HEADER_H + PAD + rows * CELL_H + (rows - 1) * GAP + PAD;
  return { width, height, gridW, rows };
}

/** Layout: cell origin + thumb origin for cell index `i`. */
function cellLayout(
  stylesLen: number, i: number, gridW: number,
): { x: number; y: number; tx: number; ty: number } {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const rowCount = Math.min(COLS, stylesLen - row * COLS);
  const rowW = rowCount * CELL_W + (rowCount - 1) * GAP;
  const rowStart = PAD + (gridW - rowW) / 2;
  const x = rowStart + col * (CELL_W + GAP);
  const y = HEADER_H + PAD + row * (CELL_H + GAP);
  return { x, y, tx: x + (CELL_W - THUMB) / 2, ty: y + 16 };
}

/**
 * Draw the complete board onto `ctx` using `cellImages[i]` for cell i. Shared by
 * the still path and (via chrome + overlay) the animated path.
 */
function drawBoard(
  ctx: BoardCtx,
  opts: BoardOptions,
  target: Drawable | null,
  cellImages: (Drawable | null)[],
): void {
  const { styles, focusValue, userId } = opts;
  const { width, height, gridW } = boardDims(styles.length);

  // Card background.
  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, BG_TOP);
  bg.addColorStop(1, BG_BOT);
  ctx.fillStyle = bg as unknown as string;
  ctx.fillRect(0, 0, width, height);

  // Header: title on the left, the target thumbnail + label on the right.
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = TEXT;
  ctx.font = `700 26px "Orbitron", sans-serif`;
  ctx.fillText("Style Board", PAD, 46);

  ctx.fillStyle = SUBTLE;
  ctx.font = `500 15px sans-serif`;
  ctx.fillText(
    `Page ${opts.page + 1}/${opts.pages} · ${opts.total} styles · ${opts.format.toUpperCase()}`,
    PAD, 74,
  );

  // Target chip (right-aligned): the picture everything below is rendered on.
  const chip = 56;
  const chipX = width - PAD - chip;
  const chipY = 26;
  ctx.fillStyle = BADGE_BG;
  roundRect(ctx, chipX - 6, chipY - 6, chip + 12, chip + 12, 12);
  ctx.fill();
  if (target) {
    ctx.save();
    roundRect(ctx, chipX, chipY, chip, chip, 8);
    ctx.clip();
    drawContain(ctx, target, chipX, chipY, chip);
    ctx.restore();
  }
  ctx.fillStyle = SUBTLE;
  ctx.font = `500 12px sans-serif`;
  ctx.textAlign = "right";
  const label = fitText(ctx, opts.targetLabel, 150);
  ctx.fillText("Your target", chipX - 12, 44);
  ctx.fillStyle = TEXT;
  ctx.font = `600 13px sans-serif`;
  ctx.fillText(label, chipX - 12, 66);
  ctx.textAlign = "left";

  // Cells.
  styles.forEach((style, i) => {
    const { x, y, tx, ty } = cellLayout(styles.length, i, gridW);
    const selected = style.value === focusValue;
    const fav = isFavorite(userId, style.value);
    const img = cellImages[i];

    // Cell background + selection ring.
    ctx.fillStyle = selected ? CELL_BG_SEL : CELL_BG;
    roundRect(ctx, x, y, CELL_W, CELL_H, 14);
    ctx.fill();
    if (selected) {
      ctx.strokeStyle = RING;
      ctx.lineWidth = 3;
      roundRect(ctx, x + 1.5, y + 1.5, CELL_W - 3, CELL_H - 3, 13);
      ctx.stroke();
    }

    // Thumbnail (or placeholder).
    if (img) {
      ctx.save();
      roundRect(ctx, tx, ty, THUMB, THUMB, 10);
      ctx.clip();
      drawContain(ctx, img, tx, ty, THUMB);
      ctx.restore();
    } else {
      ctx.fillStyle = BADGE_BG;
      roundRect(ctx, tx, ty, THUMB, THUMB, 10);
      ctx.fill();
      ctx.fillStyle = SUBTLE;
      ctx.font = `500 12px sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("no preview", x + CELL_W / 2, ty + THUMB / 2 + 4);
      ctx.textAlign = "left";
    }

    // Number badge (top-left of the cell).
    const bx = x + 16;
    const by = y + 16;
    ctx.fillStyle = selected ? RING : BADGE_BG;
    ctx.beginPath();
    ctx.arc(bx, by, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = TEXT;
    ctx.font = `700 15px "Orbitron", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(i + 1), bx, by + 1);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";

    // Favorite star (top-right of the cell).
    if (fav) {
      ctx.fillStyle = STAR;
      ctx.font = `700 18px sans-serif`;
      ctx.textAlign = "right";
      ctx.fillText("★", x + CELL_W - 12, by + 6);
      ctx.textAlign = "left";
    }

    // Label under the thumbnail.
    ctx.fillStyle = selected ? TEXT : SUBTLE;
    ctx.font = `600 14px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(fitText(ctx, style.label, CELL_W - 24), x + CELL_W / 2, y + CELL_H - 16);
    ctx.textAlign = "left";
  });
}

interface DecodedGif { frames: Drawable[]; delays: number[] }

// ── Decoded-frame cache (bounded) ────────────────────────────────────────────
// Preview cache stores GIF *bytes*. Warm boards were still re-decoding those
// into canvases. Cache composited frames for recent cells only — never all 473.
const DECODED_MAX_ENTRIES = 12;
const DECODED_MAX_BYTES = 6 * 1024 * 1024;
const DECODED_TTL_MS = 15 * 60 * 1000;

interface DecodedCacheEntry {
  key: string;
  value: DecodedGif;
  bytes: number;
  expiresAt: number;
  usedAt: number;
}

const decodedCache = new Map<string, DecodedCacheEntry>();
let decodedBytes = 0;

function estimateDecodedBytes(gif: DecodedGif): number {
  let n = 0;
  for (const f of gif.frames) n += Math.max(1, f.width) * Math.max(1, f.height) * 4;
  return n;
}

function dropDecoded(entry: DecodedCacheEntry): void {
  if (decodedCache.delete(entry.key)) decodedBytes -= entry.bytes;
}

function enforceDecodedBounds(): void {
  const now = Date.now();
  for (const entry of [...decodedCache.values()]) {
    if (entry.expiresAt <= now) dropDecoded(entry);
  }
  if (decodedCache.size <= DECODED_MAX_ENTRIES && decodedBytes <= DECODED_MAX_BYTES) return;
  for (const entry of [...decodedCache.values()].sort((a, b) => a.usedAt - b.usedAt)) {
    if (decodedCache.size <= DECODED_MAX_ENTRIES && decodedBytes <= DECODED_MAX_BYTES) break;
    dropDecoded(entry);
  }
}

function getDecoded(key: string): DecodedGif | undefined {
  const entry = decodedCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) { dropDecoded(entry); return undefined; }
  entry.usedAt = Date.now();
  return entry.value;
}

function putDecoded(key: string, value: DecodedGif): void {
  const existing = decodedCache.get(key);
  if (existing) dropDecoded(existing);
  const bytes = estimateDecodedBytes(value);
  decodedCache.set(key, {
    key, value, bytes, expiresAt: Date.now() + DECODED_TTL_MS, usedAt: Date.now(),
  });
  decodedBytes += bytes;
  enforceDecodedBounds();
}

/** Test/bench helper — does not clear the GIF-buffer preview cache. */
export function clearBoardDecodedCache(): void {
  decodedCache.clear();
  decodedBytes = 0;
}

/**
 * Decode a GIF into fully-composited per-frame canvases.
 *
 * Our thumbnails come from the emoji encoder, which writes full frames with a
 * transparent key and "restore to background" disposal. Compositing with
 * `drawImage` (source-over) keeps the previous frame where a patch is
 * transparent; a disposal of 2 clears the region first — between them this draws
 * every frame correctly regardless of how the encoder optimised it.
 *
 * One reusable patch canvas (max frame dims) replaces a new patch per source
 * frame. Snapshots remain one canvas per composited frame — those are what the
 * board draws. Long source GIFs are evenly subsampled to BOARD_MAX_FRAMES.
 */
function decodeGif(mod: CanvasMod, buffer: Buffer): DecodedGif | null {
  try {
    const ab = buffer.buffer.slice(
      buffer.byteOffset, buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;
    const gif = parseGIF(ab);
    const frames = decompressFrames(gif, true);
    if (frames.length === 0) return null;

    const W = gif.lsd.width;
    const H = gif.lsd.height;
    const work = mod.createCanvas(W, H);
    const wctx = work.getContext("2d") as unknown as FrameCtx;

    let maxW = 1;
    let maxH = 1;
    for (const f of frames) {
      maxW = Math.max(maxW, f.dims.width);
      maxH = Math.max(maxH, f.dims.height);
    }
    const patch = mod.createCanvas(maxW, maxH);
    const pctx = patch.getContext("2d") as unknown as FrameCtx;

    // Walk every source frame for correct disposal, but only snapshot the
    // evenly-spaced keep-set — avoids N full canvases when N ≫ BOARD_MAX_FRAMES.
    const n = frames.length;
    const keepIdx = new Set<number>();
    const keepCount = Math.min(BOARD_MAX_FRAMES, n);
    for (let i = 0; i < keepCount; i++) {
      keepIdx.add(n <= BOARD_MAX_FRAMES ? i : Math.floor((i * n) / keepCount));
    }

    const out: Drawable[] = [];
    const delays: number[] = [];
    let runDelay = 0;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i]!;
      const id = pctx.createImageData(f.dims.width, f.dims.height);
      id.data.set(f.patch);
      pctx.putImageData(id, 0, 0);

      wctx.drawImage(
        patch as unknown,
        0, 0, f.dims.width, f.dims.height,
        f.dims.left, f.dims.top, f.dims.width, f.dims.height,
      );

      runDelay += f.delay && f.delay > 0 ? f.delay : 90;

      if (keepIdx.has(i)) {
        const snap = mod.createCanvas(W, H);
        (snap.getContext("2d") as unknown as FrameCtx).drawImage(work as unknown, 0, 0);
        out.push(snap as unknown as Drawable);
        delays.push(Math.max(20, runDelay));
        runDelay = 0;
      }

      if (f.disposalType === 2) {
        wctx.clearRect(f.dims.left, f.dims.top, f.dims.width, f.dims.height);
      }
    }
    if (out.length === 0) return null;
    // Delays already merged while walking; no second subsample pass needed.
    return { frames: out, delays };
  } catch (err) {
    logger.debug({ err }, "board cell GIF decode failed");
    return null;
  }
}

/** One cell's frames (≥1) plus the delays that produced them. */
interface Cell { frames: (Drawable | null)[]; delays: number[] }

/** Run `items` through `fn` with at most `limit` in flight. */
async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  }
  const n = Math.min(Math.max(1, limit), Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

/** Fetch a cell as decoded animated frames, falling back to a single still. */
async function loadCell(mod: CanvasMod, image: Buffer, style: string): Promise<Cell> {
  const gif = await renderStyleThumbGif(image, style).catch(() => null);
  if (gif) {
    // The thumb GIF is uniquely identified by (target image, style) — the same
    // key the buffer cache uses — so key the decoded cache by identity too. That
    // is collision-free and avoids fingerprinting bytes on every cell load.
    const key = `decoded:${previewKey(targetHash(image), style)}`;
    let decoded = getDecoded(key);
    if (!decoded) {
      decoded = decodeGif(mod, gif) ?? undefined;
      if (decoded) putDecoded(key, decoded);
    }
    if (decoded && decoded.frames.length > 1) {
      return { frames: decoded.frames, delays: decoded.delays };
    }
  }
  const still = await renderStyleThumb(image, style).catch(() => null);
  const img = still ? await mod.loadImage(still).catch(() => null) : null;
  return { frames: [img as unknown as Drawable | null], delays: [90] };
}

// ── Board result cache (bounded) ─────────────────────────────────────────────
// Warm path without this still re-decoded + re-encoded (~0.6s). Cache a few
// recent page GIFs keyed by target + styles + focus + favorites.
const BOARD_RESULT_MAX_ENTRIES = 4;
const BOARD_RESULT_MAX_BYTES = 8 * 1024 * 1024;
const BOARD_RESULT_TTL_MS = 10 * 60 * 1000;

interface BoardCacheEntry {
  key: string;
  result: BoardResult;
  expiresAt: number;
  usedAt: number;
}

const boardResultCache = new Map<string, BoardCacheEntry>();
let boardResultBytes = 0;

function dropBoardResult(entry: BoardCacheEntry): void {
  if (boardResultCache.delete(entry.key)) boardResultBytes -= entry.result.buffer.length;
}

function enforceBoardResultBounds(): void {
  const now = Date.now();
  for (const entry of [...boardResultCache.values()]) {
    if (entry.expiresAt <= now) dropBoardResult(entry);
  }
  if (
    boardResultCache.size <= BOARD_RESULT_MAX_ENTRIES
    && boardResultBytes <= BOARD_RESULT_MAX_BYTES
  ) return;
  for (const entry of [...boardResultCache.values()].sort((a, b) => a.usedAt - b.usedAt)) {
    if (
      boardResultCache.size <= BOARD_RESULT_MAX_ENTRIES
      && boardResultBytes <= BOARD_RESULT_MAX_BYTES
    ) break;
    dropBoardResult(entry);
  }
}

function boardCacheKey(opts: BoardOptions): string {
  const favs = opts.styles
    .filter(s => isFavorite(opts.userId, s.value))
    .map(s => s.value)
    .join(",");
  return [
    "board:v2",
    targetHash(opts.image),
    opts.styles.map(s => s.value).join(","),
    opts.focusValue,
    String(opts.page),
    String(opts.pages),
    String(opts.total),
    opts.format,
    opts.targetLabel,
    favs,
  ].join("|");
}

function getBoardCached(key: string): BoardResult | undefined {
  const entry = boardResultCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) { dropBoardResult(entry); return undefined; }
  entry.usedAt = Date.now();
  return {
    buffer: entry.result.buffer,
    name: entry.result.name,
    animated: entry.result.animated,
  };
}

function putBoardCached(key: string, result: BoardResult): void {
  const existing = boardResultCache.get(key);
  if (existing) dropBoardResult(existing);
  boardResultCache.set(key, {
    key, result, expiresAt: Date.now() + BOARD_RESULT_TTL_MS, usedAt: Date.now(),
  });
  boardResultBytes += result.buffer.length;
  enforceBoardResultBounds();
}

export function clearBoardResultCache(): void {
  boardResultCache.clear();
  boardResultBytes = 0;
}

// Serialize board *encode* work across users. Cell renders already go through
// the shared render queue; encoding a ~682×490×14 GIF is the other CPU spike.
// Do NOT wrap this in queueRender — loadCell awaits queued offline renders and
// would deadlock (cells are loaded before the encode, so this lane never nests).
//
// Two lanes: a foreground job (a board the user is waiting on) always runs
// before any queued background job (a speculative warm or neighbour prefetch),
// so speculative encodes can never delay an on-demand one. Still one at a time,
// so concurrent users can't stack encodes.
const composeFg: (() => void)[] = [];
const composeBg: (() => void)[] = [];
let composing = false;

function pumpCompose(): void {
  if (composing) return;
  const job = composeFg.shift() ?? composeBg.shift();
  if (!job) return;
  composing = true;
  job();
}

function withBoardCompose<T>(fn: () => T | Promise<T>, background = false): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const job = (): void => {
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        composing = false;
        pumpCompose();
      });
    };
    (background ? composeBg : composeFg).push(job);
    pumpCompose();
  });
}

function cellCycleMs(cell: Cell): number {
  if (cell.frames.length <= 1) return 0;
  return cell.delays.reduce((a, b) => a + (b > 0 ? b : 90), 0);
}

/** Pick the frame that should show at time `tMs` into this cell's loop. */
function frameAt(cell: Cell, tMs: number): Drawable | null {
  const frames = cell.frames;
  if (frames.length === 0) return null;
  if (frames.length === 1) return frames[0] ?? null;
  const cycle = cellCycleMs(cell) || 90 * frames.length;
  let t = ((tMs % cycle) + cycle) % cycle;
  for (let i = 0; i < frames.length; i++) {
    const d = cell.delays[i] && cell.delays[i]! > 0 ? cell.delays[i]! : 90;
    t -= d;
    if (t < 0) return frames[i] ?? null;
  }
  return frames[frames.length - 1] ?? null;
}

/**
 * Render the contact-sheet board for one page of styles — animated when the page
 * has motion, a still PNG otherwise.
 *
 * Returns null when the canvas backend is unavailable, so the caller can drop the
 * board image and keep the rest of the dashboard.
 */
export async function renderBoard(opts: BoardOptions): Promise<BoardResult | null> {
  const cacheKey = boardCacheKey(opts);
  const cached = getBoardCached(cacheKey);
  if (cached) return cached;

  const mod = await getCanvas();
  if (!mod) return null;

  const { image, styles } = opts;

  // Hash once up-front so thumb cache keys reuse the WeakMap-cached digest.
  targetHash(image);

  const [target, cells] = await Promise.all([
    mod.loadImage(image).catch(() => null) as Promise<Drawable | null>,
    mapPool(styles, CELL_LOAD_CONCURRENCY, s => loadCell(mod, image, s.value)),
  ]);

  const { width, height } = boardDims(styles.length);

  const result = await withBoardCompose(async () => {
    // Another caller may have finished the same page while we loaded cells.
    const raced = getBoardCached(cacheKey);
    if (raced) return raced;

    const animatedCount = cells.filter(c => c.frames.length > 1).length;
    if (animatedCount === 0) {
      return renderStill(mod, opts, target, cells, width, height);
    }

    const animated = renderAnimated(mod, opts, target, cells, width, height);
    if (animated && animated.buffer.length <= BOARD_MAX_BYTES) return animated;
    if (animated) {
      logger.debug(
        { bytes: animated.buffer.length },
        "animated board over size budget; using still fallback",
      );
    }
    return await renderStill(mod, opts, target, cells, width, height);
  }, opts.background ?? false);

  if (result) putBoardCached(cacheKey, result);
  return result;
}

/**
 * Tile the cells' frames into one looping board GIF.
 *
 * Timing: each cell advances on its own delay timeline (not `f % length` with a
 * global average). Board ticks are uniform; per-tick we sample each cell at the
 * same wall-clock `t`. Chrome (bg/header/labels/rings) is painted once and
 * blitted each frame; only thumbnails are redrawn. Badges/stars are redrawn on
 * top so they stay above the animated thumb.
 */
function renderAnimated(
  mod: CanvasMod,
  opts: BoardOptions,
  target: Drawable | null,
  cells: Cell[],
  width: number,
  height: number,
): BoardResult | null {
  try {
    const canvas = mod.createCanvas(width, height);
    const ctx = canvas.getContext("2d") as unknown as BoardCtx;

    const maxCycle = Math.max(1, ...cells.map(cellCycleMs));
    const frameCount = Math.min(
      BOARD_MAX_FRAMES,
      Math.max(2, Math.round(maxCycle / 90)),
    );
    const tickMs = Math.min(140, Math.max(50, Math.round(maxCycle / frameCount)));

    // Static chrome once — stand-in thumbs so "no preview" is not baked in for
    // cells that will receive real frames, while empty cells keep their placeholder.
    const chrome = mod.createCanvas(width, height);
    const chromeCtx = chrome.getContext("2d") as unknown as BoardCtx;
    const standIn = mod.createCanvas(1, 1) as unknown as Drawable;
    const standIns = cells.map(c => (c.frames[0] ? standIn : null));
    drawBoard(chromeCtx, opts, target, standIns);

    const { gridW } = boardDims(opts.styles.length);

    const encoder = new GIFEncoder(width, height);
    encoder.start();
    encoder.setRepeat(0);
    encoder.setQuality(BOARD_QUALITY);
    encoder.setDelay(tickMs);

    for (let f = 0; f < frameCount; f++) {
      const t = f * tickMs;
      ctx.drawImage(chrome as unknown, 0, 0, width, height);

      for (let i = 0; i < cells.length; i++) {
        const img = frameAt(cells[i]!, t);
        if (!img) continue;
        const { tx, ty } = cellLayout(opts.styles.length, i, gridW);
        ctx.save();
        roundRect(ctx, tx, ty, THUMB, THUMB, 10);
        ctx.clip();
        drawContain(ctx, img, tx, ty, THUMB);
        ctx.restore();
      }

      // Badges + stars above the thumb (same stacking as the still path).
      for (let i = 0; i < opts.styles.length; i++) {
        const style = opts.styles[i]!;
        const { x, y } = cellLayout(opts.styles.length, i, gridW);
        const selected = style.value === opts.focusValue;
        const fav = isFavorite(opts.userId, style.value);
        const bx = x + 16;
        const by = y + 16;
        ctx.fillStyle = selected ? RING : BADGE_BG;
        ctx.beginPath();
        ctx.arc(bx, by, 15, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = TEXT;
        ctx.font = `700 15px "Orbitron", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(i + 1), bx, by + 1);
        ctx.textBaseline = "alphabetic";
        ctx.textAlign = "left";
        if (fav) {
          ctx.fillStyle = STAR;
          ctx.font = `700 18px sans-serif`;
          ctx.textAlign = "right";
          ctx.fillText("★", x + CELL_W - 12, by + 6);
          ctx.textAlign = "left";
        }
      }

      encoder.addFrame(ctx as unknown as never);
    }
    encoder.finish();

    return { buffer: encoder.out.getData(), name: BOARD_FILENAME, animated: true };
  } catch (err) {
    logger.debug({ err }, "animated board encode failed");
    return null;
  }
}

/** Draw a one-frame board and encode it as a PNG. */
async function renderStill(
  mod: CanvasMod,
  opts: BoardOptions,
  target: Drawable | null,
  cells: Cell[],
  width: number,
  height: number,
): Promise<BoardResult | null> {
  try {
    const canvas = mod.createCanvas(width, height);
    const ctx = canvas.getContext("2d") as unknown as BoardCtx;
    drawBoard(ctx, opts, target, cells.map(c => c.frames[0] ?? null));
    const buffer = await canvas.encode("png");
    return { buffer, name: BOARD_FILENAME_STILL, animated: false };
  } catch (err) {
    logger.debug({ err }, "still board encode failed");
    return null;
  }
}
