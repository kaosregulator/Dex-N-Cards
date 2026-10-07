// Animation engine — low-level frame management and GIF encoding.
// Lazy-loads @napi-rs/canvas and gifencoder so missing native deps never break
// commands that don't use animation.

import GIFEncoder from "gifencoder";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Canvas, SKRSContext2D } from "@napi-rs/canvas";
import type { AnimationSpeed, AnimationResult } from "./types.js";
import { queueRender } from "./render-queue.js";
import { logger } from "../../lib/logger.js";

export type CanvasMod = typeof import("@napi-rs/canvas");

// The 2D context type used across the animation system. Mirrors the existing
// battle-image renderer, which types the napi-rs context rather than pulling in
// the DOM lib. Kept as a single alias so effects/pack/battle stay consistent.
//
// The shipped @napi-rs/canvas declarations under-declare a few standard 2D
// methods in this project's module resolution (scale/transform/setTransform/
// quadraticCurveTo). They exist at runtime on the spec-complete Skia context,
// so we re-declare them here to keep the animation code fully typed.
export type Ctx = SKRSContext2D & {
  scale(x: number, y: number): void;
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): { data: Uint8ClampedArray };
  // Additive-blend layers (atmosphere embers/sparks/dust, physics glows) set
  // this; it exists on the spec-complete Skia context but is under-declared.
  globalCompositeOperation: string;
  // Line styling — spec-complete on the Skia context but under-declared here.
  lineJoin: string;
  lineCap: string;
  setLineDash(segments: number[]): void;
  rect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  ellipse(
    x: number, y: number, radiusX: number, radiusY: number,
    rotation: number, startAngle: number, endAngle: number,
  ): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): {
    addColorStop(offset: number, color: string): void;
  };
  shadowOffsetX: number;
  shadowOffsetY: number;
};

// Horizontal text alignment values accepted by the napi-rs 2D context. Declared
// locally because the project intentionally excludes the DOM lib.
export type TextAlign = "left" | "right" | "center" | "start" | "end";

export const PACK_CANVAS = { width: 800, height: 520 } as const;
export const BATTLE_CANVAS = { width: 1000, height: 560 } as const;

// Discord's default (non-boosted) attachment limit is 8 MiB. Stay safely under
// it: an animation that would exceed this is dropped (treated like an encode
// failure) so the command still succeeds with its static embed instead of the
// attach throwing after rewards were already granted.
export const MAX_ANIMATION_BYTES = 8_000_000;

let _canvas: CanvasMod | null | undefined;

export async function getCanvas(): Promise<CanvasMod | null> {
  if (_canvas !== undefined) return _canvas;
  try {
    _canvas = await import("@napi-rs/canvas");
    registerFonts(_canvas);
  } catch (err) {
    logger.debug({ err }, "animation engine: @napi-rs/canvas not available");
    _canvas = null;
  }
  return _canvas;
}

// The display font used for canvas TITLES (see TITLE_FONT in effects.ts). Body
// text stays on the system sans. Orbitron is a bundled OFL font — registering it
// with @napi-rs/canvas makes `ctx.font = '... "Orbitron" ...'` resolve.
export const TITLE_FONT_FAMILY = "Orbitron";
// A bundled OFL bitmap font (Press Start 2P) for the retro Game Boy / Pokémon
// look — used by the wild-encounter intro's boxes, name/HP header and dialogue.
export const PIXEL_FONT_FAMILY = "Early GameBoy";
let _fontsRegistered = false;

// Resolve the bundled fonts dir across dev (tsx from src) and prod (bundled
// dist), trying each likely location and using the first that actually exists.
function resolveFontsDir(): string | null {
  const candidates = [
    fileURLToPath(new URL("../../../assets/fonts/", import.meta.url)),
    join(process.cwd(), "assets/fonts"),
    join(process.cwd(), "artifacts/api-server/assets/fonts"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "Orbitron-Black.ttf"))) return dir;
  }
  return null;
}

function registerFonts(mod: CanvasMod): void {
  if (_fontsRegistered) return;
  _fontsRegistered = true;
  try {
    const reg = (mod as unknown as { GlobalFonts?: { registerFromPath(p: string, name?: string): boolean } }).GlobalFonts;
    const fontsDir = resolveFontsDir();
    if (!reg || !fontsDir) return;
    reg.registerFromPath(join(fontsDir, "Orbitron-Black.ttf"), TITLE_FONT_FAMILY);
    reg.registerFromPath(join(fontsDir, "Orbitron-Bold.ttf"), TITLE_FONT_FAMILY);
    // Optional bitmap font — best-effort; text falls back to the title/system font.
    // Early GameBoy is the preferred pixel face; Press Start 2P is a fallback.
    if (existsSync(join(fontsDir, "EarlyGameBoy.ttf"))) {
      reg.registerFromPath(join(fontsDir, "EarlyGameBoy.ttf"), PIXEL_FONT_FAMILY);
    } else if (existsSync(join(fontsDir, "PressStart2P-Regular.ttf"))) {
      reg.registerFromPath(join(fontsDir, "PressStart2P-Regular.ttf"), PIXEL_FONT_FAMILY);
    }
    logger.info({ fontsDir }, "animation engine: registered Orbitron + pixel fonts");
  } catch (err) {
    // Non-fatal: titles fall back to the system sans if registration fails.
    logger.debug({ err }, "animation engine: font registration skipped");
  }
}

// Target frame rate per speed preset. Lower fps → fewer frames → much smaller
// GIFs (gifencoder writes every frame in full, so frame count is the dominant
// size lever). These are deliberately modest: 10–14fps reads as smooth for the
// short, punchy clips we produce while keeping files small.
function targetFps(speed: AnimationSpeed): number {
  switch (speed) {
    case "slow": return 10;
    case "fast": return 14;
    default: return 12;
  }
}

export interface FramePlan {
  frameCount: number;
  delayMs: number;      // per-frame display delay (multiple of 10ms — GIF granularity)
}

// Adaptive frame timing: derive a frame count from the requested duration and
// target fps, then hard-cap it at `maxFrames` and stretch the per-frame delay to
// preserve the intended wall-clock duration. This keeps long animations from
// ballooning in size while short ones stay smooth.
export function planFrames(durationMs: number, speed: AnimationSpeed, maxFrames: number): FramePlan {
  const fps = targetFps(speed);
  const ideal = Math.round((durationMs / 1000) * fps);
  const frameCount = Math.max(2, Math.min(maxFrames, ideal));
  // GIF delays are stored in centiseconds; round to 10ms and clamp to a sane floor.
  const delayMs = Math.max(20, Math.round(durationMs / frameCount / 10) * 10);
  return { frameCount, delayMs };
}

export interface FrameCtx {
  canvas: Canvas;
  ctx: Ctx;
  t: number;          // 0 → 1 across the whole animation
  frameIndex: number;
  frameCount: number;
  mod: CanvasMod;
}

export interface EncodeOptions {
  width: number;        // logical drawing width (renderer coordinate space)
  height: number;       // logical drawing height
  speed: AnimationSpeed;
  durationMs: number;
  render: (frame: FrameCtx) => Promise<void> | void;
  maxFrames?: number;   // hard cap on frame count (size guard)
  quality?: number;     // gifencoder NeuQuant sample factor: 1 best/slow … 30 coarse/small
  renderScale?: number; // physical pixels per logical unit (<1 shrinks output, 0 renderer changes)
}

// Cheap FNV-1a hash over a subsample of the frame's pixels. Used only to detect
// *identical* consecutive frames for coalescing; a rare hash collision would at
// worst merge two truly-different frames, so subsampling is safe.
function frameSignature(ctx: Ctx, physW: number, physH: number): number {
  const data = ctx.getImageData(0, 0, physW, physH).data;
  let h = 0x811c9dc5;
  // Step by a prime so the sample walks across scanlines, not down one column.
  for (let k = 0; k < data.length; k += 389) {
    h = Math.imul(h ^ data[k]!, 0x01000193);
  }
  return h >>> 0;
}

interface FrameSurface {
  canvas: Canvas;
  ctx: Ctx;
}

// Drawing state (clip, transform, alpha) survives clearRect. Restore back to
// the clean snapshot taken when the surface was created, then clear pixels.
function resetSurface(surface: FrameSurface, physW: number, physH: number, renderScale: number): void {
  surface.ctx.restore();
  surface.ctx.save();
  surface.ctx.setTransform(1, 0, 0, 1, 0, 0);
  surface.ctx.clearRect(0, 0, physW, physH);
  if (renderScale !== 1) surface.ctx.scale(renderScale, renderScale);
}

export async function encodeAnimation(opts: EncodeOptions): Promise<AnimationResult | null> {
  return queueRender("gif", async () => {
  const mod = await getCanvas();
  if (!mod) return null;
  const {
    width, height, speed, durationMs, render,
    maxFrames = 32, quality = 16, renderScale = 1,
  } = opts;
  try {
    const { frameCount, delayMs } = planFrames(durationMs, speed, maxFrames);
    const physW = Math.max(1, Math.round(width * renderScale));
    const physH = Math.max(1, Math.round(height * renderScale));

    const encoder = new GIFEncoder(physW, physH);
    encoder.start();
    encoder.setRepeat(0);        // loop forever
    encoder.setQuality(quality); // higher = coarser palette = smaller file

    // Two surfaces, not one per frame. Holding every canvas until the GIF was
    // finished kept a full bitmap for each frame alive at once (a siege turn
    // is ~14 frames; three of those in parallel was a multi-hundred-MB spike).
    // Identical consecutive frames are still coalesced: the held surface is
    // only swapped when the picture actually changes, then encoded with the
    // summed delay. gifencoder copies pixels inside addFrame, so the held
    // surface can be reused immediately after.
    const makeSurface = (): FrameSurface => {
      const canvas = mod.createCanvas(physW, physH);
      const ctx = canvas.getContext("2d") as unknown as Ctx;
      ctx.save();
      return { canvas, ctx };
    };
    let current = makeSurface();
    let spare: FrameSurface | null = null;
    let hold: { surface: FrameSurface; sig: number; run: number } | null = null;
    let emitted = 0;

    for (let i = 0; i < frameCount; i++) {
      resetSurface(current, physW, physH, renderScale);
      const t = frameCount <= 1 ? 1 : i / (frameCount - 1);
      await render({ canvas: current.canvas, ctx: current.ctx, t, frameIndex: i, frameCount, mod });
      const sig = frameSignature(current.ctx, physW, physH);
      if (hold && hold.sig === sig) {
        hold.run += 1;
        continue;
      }
      if (hold) {
        encoder.setDelay(delayMs * hold.run);
        encoder.addFrame(hold.surface.ctx);
        emitted++;
        spare = hold.surface;
      }
      hold = { surface: current, sig, run: 1 };
      current = spare ?? makeSurface();
      spare = null;
    }
    if (hold) {
      encoder.setDelay(delayMs * hold.run);
      encoder.addFrame(hold.surface.ctx);
      emitted++;
    }
    encoder.finish();

    const buffer = encoder.out.getData();
    if (buffer.length > MAX_ANIMATION_BYTES) {
      logger.debug(
        { bytes: buffer.length, max: MAX_ANIMATION_BYTES },
        "animation engine: encoded GIF exceeds attachment limit, falling back to static",
      );
      return null;
    }
    return {
      buffer,
      width: physW,
      height: physH,
      frameCount: emitted,
      durationMs: frameCount * delayMs,
    };
  } catch (err) {
    logger.error({ err }, "animation engine: encode failed");
    return null;
  }
  });
}

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function easeOutBack(x: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

export function easeOutElastic(x: number): number {
  const c4 = (2 * Math.PI) / 3;
  return x === 0 ? 0 : x === 1 ? 1 : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1;
}

export function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function hexToRgba(hex: number, alpha: number): string {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function roundRectPath(
  ctx: Ctx,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  // Uses arcTo (not quadraticCurveTo) to match the battle-image renderer, whose
  // context type is the source of truth for what the napi-rs canvas exposes.
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

export function drawGradientBackground(
  ctx: Ctx,
  width: number,
  height: number,
  stops: [number, string][],
  angleRad = 0,
): void {
  const cx = width / 2, cy = height / 2;
  const dx = Math.cos(angleRad) * width * 0.5;
  const dy = Math.sin(angleRad) * height * 0.5;
  const g = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  for (const [offset, color] of stops) g.addColorStop(offset, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);
}
