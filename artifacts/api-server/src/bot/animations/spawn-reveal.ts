// ─────────────────────────────────────────────────────────────────────────────
// DN Cards — Animated spawn reveals
//
// Turns the plain "card appeared" image into a short, looping reveal GIF that is
// generated automatically as part of the normal spawn render. Three modes, each
// mapped to a difficulty tier so rarer cards get a more dramatic reveal:
//
//   • Easy   → Blur Reveal       — starts heavily blurred, sharpens to clear.
//   • Medium → Puzzle Reveal     — puzzle tiles pop in randomly until complete.
//   • Hard   → Silhouette Reveal — starts as a dark, desaturated silhouette and
//                                  gains colour + light.
//
// Reuses the installed libraries: `sharp` for the heavy image processing (blur /
// brightness / saturation stages) and the existing canvas + gifencoder pipeline
// (engine.encodeAnimation) for compositing and encoding. Every path is
// best-effort: any failure returns null and the spawn falls back to the static
// card image, so the reveal can never break a spawn.
// ─────────────────────────────────────────────────────────────────────────────

import type { Rarity } from "../cards-data.js";
import type { AnimationSpeed } from "./types.js";
import {
  getCanvas, encodeAnimation, drawGradientBackground, hexToRgba, roundRectPath,
  clamp01, lerp, type Ctx,
} from "./engine.js";
import { queueRender } from "./render-queue.js";
import {
  loadArtBuffer, drawCardArt, drawRarityGlow, drawCardFrame, drawRarityBadge,
  drawFoilOverlay, drawHoloSparkles, drawShineSweep, drawTitle, drawTextWithShadow,
  fitText, TITLE_FONT, getRarityEffectColor,
} from "./effects.js";
import { logger } from "../../lib/logger.js";

export type RevealMode = "blur" | "puzzle" | "silhouette";

// Difficulty mapping: rarer cards earn a harder (more hidden) reveal. This is
// the automatic default; a caller may pass an explicit mode to override it.
export function revealModeForRarity(rarity: Rarity): RevealMode {
  switch (rarity) {
    case "common":
    case "uncommon":
      return "blur";       // Easy
    case "rare":
    case "epic":
      return "puzzle";     // Medium
    case "legendary":
    case "mythic":
      return "silhouette"; // Hard
    default:
      return "blur";
  }
}

export interface SpawnRevealInput {
  artUrl: string | null | undefined;
  rarity: Rarity;
  rarityLabel: string;
  rarityColor?: number | null;
  mode?: RevealMode;      // overrides the rarity-derived default
  appearMessage?: string; // headline drawn at the top (matches the embed title)
}

// Canvas geometry — a compact framed portrait. The spawn embed already carries
// the title/rarity/worth/hint text, so the reveal image is deliberately
// art-forward.
const WIDTH = 480;
const HEIGHT = 600;
const PANEL = { x: 34, y: 60, w: 412, h: 486 } as const;

// Puzzle grid — larger, clearer pieces so each one reads as it snaps in.
const PUZZLE_COLS = 4, PUZZLE_ROWS = 5, PUZZLE_TILES = PUZZLE_COLS * PUZZLE_ROWS;

type LoadedImage = import("@napi-rs/canvas").Image;

let _sharp: ((buf: Buffer) => SharpInstance) | null | undefined;
interface SharpInstance {
  resize(w: number, h: number, opts?: { fit?: string; position?: string }): SharpInstance;
  blur(sigma?: number): SharpInstance;
  modulate(opts: { brightness?: number; saturation?: number; hue?: number }): SharpInstance;
  png(): SharpInstance;
  toBuffer(): Promise<Buffer>;
}

async function loadSharp(): Promise<((buf: Buffer) => SharpInstance) | null> {
  if (_sharp !== undefined) return _sharp;
  try {
    const mod = await import("sharp");
    _sharp = (mod.default ?? mod) as unknown as (buf: Buffer) => SharpInstance;
  } catch (err) {
    logger.debug({ err }, "spawn-reveal: sharp not available");
    _sharp = null;
  }
  return _sharp;
}

// Deterministic tile order for the puzzle reveal (stable per card art so a card
// always reveals the same way). Fisher–Yates seeded by a hash of the URL.
function seededTileOrder(count: number, seedStr: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619); }
  const rand = () => {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h >>>= 0;
    return h / 0xffffffff;
  };
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

// Clip to the rounded art panel and paint a solid backer (so any gaps read as
// dark card stock, never transparent).
function clipPanel(ctx: Ctx): void {
  roundRectPath(ctx, PANEL.x, PANEL.y, PANEL.w, PANEL.h, 16);
  ctx.clip();
  ctx.fillStyle = "#0b0c11";
  ctx.fillRect(PANEL.x, PANEL.y, PANEL.w, PANEL.h);
}

// Allocate a canvas, draw, encode a single PNG. Best-effort → null. Routed
// through the shared render queue so a spawn frame never spikes CPU next to a
// battle/pack render.
async function renderPng(width: number, height: number, draw: (ctx: Ctx) => void): Promise<Buffer | null> {
  return queueRender("reveal", async () => {
    const mod = await getCanvas();
    if (!mod) return null;
    try {
      const canvas = mod.createCanvas(width, height);
      const ctx = canvas.getContext("2d") as unknown as Ctx;
      draw(ctx);
      return await canvas.encode("png");
    } catch (err) {
      logger.debug({ err }, "spawn-reveal: png render failed");
      return null;
    }
  });
}

// A live spawn reveal. Prepares the art once, then renders a single framed PNG
// for any progress in [0,1] — 0 = fully hidden, 1 = fully revealed. The spawn
// manager posts frame 0 and edits the message with rising progress across the
// WHOLE catch window, so the reveal lasts the entire guessing period and stops
// the instant the card is caught or the window ends. All best-effort.
export interface SpawnRevealSession {
  mode: RevealMode;
  maxSteps: number;     // natural number of reveal steps (puzzle = tile count)
  renderFrame(progress: number): Promise<Buffer | null>;
}

export async function createSpawnRevealSession(input: SpawnRevealInput): Promise<SpawnRevealSession | null> {
  const mod = await getCanvas();
  if (!mod) return null;
  const src = await loadArtBuffer(input.artUrl);
  if (!src) return null;
  const sharpFn = await loadSharp();
  if (!sharpFn) return null;

  const mode = input.mode ?? revealModeForRarity(input.rarity);
  const color = input.rarityColor ?? getRarityEffectColor(input.rarity);
  const appearMessage = input.appearMessage ?? "A DN CARD APPEARS";

  // Cover-fit the art once; per-frame effects run on this buffer.
  let base: Buffer;
  try {
    base = await sharpFn(src).resize(PANEL.w, PANEL.h, { fit: "cover", position: "center" }).png().toBuffer();
  } catch (err) {
    logger.debug({ err }, "spawn-reveal: base resize failed");
    return null;
  }

  // Puzzle draws the clear art clipped to revealed tiles — decode it once.
  const clearImg = mode === "puzzle" ? await mod.loadImage(base).catch(() => null) : null;
  if (mode === "puzzle" && !clearImg) return null;
  const tileOrder = mode === "puzzle" ? seededTileOrder(PUZZLE_TILES, String(input.artUrl)) : [];

  // Prebake a small ladder of blur/silhouette stages once. Progressive spawn
  // edits used to call sharp+loadImage on every tick (up to ~24× per spawn),
  // which stacked with battles under multi-guild load. Nearest-keyframe lookup
  // keeps the reveal smooth without per-tick native image work.
  const KEYFRAMES = 10;
  let keyframeArts: LoadedImage[] | null = null;
  if (mode === "blur" || mode === "silhouette") {
    try {
      const frames: LoadedImage[] = [];
      for (let i = 0; i < KEYFRAMES; i++) {
        const progress = i / (KEYFRAMES - 1);
        let buf: Buffer;
        if (mode === "blur") {
          const sigma = (1 - progress) * 26;
          buf = sigma > 0.4
            ? await sharpFn(base).blur(sigma).png().toBuffer()
            : base;
        } else {
          const brightness = 0.06 + progress * 0.94;
          const saturation = 0.12 + progress * 0.88;
          const sBlur = (1 - progress) * 5;
          let p = sharpFn(base).modulate({ brightness, saturation });
          if (sBlur > 0.4) p = p.blur(sBlur);
          buf = await p.png().toBuffer();
        }
        const img = await mod.loadImage(buf).catch(() => null);
        if (!img) throw new Error("keyframe decode failed");
        frames.push(img);
      }
      keyframeArts = frames;
    } catch (err) {
      logger.debug({ err }, "spawn-reveal: keyframe bake failed");
      return null;
    }
  }

  // Draw the framed card at a given progress with an already-prepared art image
  // (blur/silhouette). Puzzle ignores `art` and reveals clear-art tiles instead.
  const drawFrame = (ctx: Ctx, progress: number, art: LoadedImage | null): void => {
    drawGradientBackground(ctx, WIDTH, HEIGHT, [
      [0, hexToRgba(color, 0.3)],
      [0.55, "#0c0e14"],
      [1, "#07080d"],
    ], 0.32);
    // Fit the (variable-length) headline into the top band so longer lines
    // shrink to stay on one line instead of overflowing the card.
    drawTextWithShadow(ctx, appearMessage, WIDTH / 2, 34, "#d7dbe6", fitText(ctx, appearMessage, WIDTH - 44, 20, 12));
    drawRarityGlow(ctx, PANEL.x, PANEL.y, PANEL.w, PANEL.h, color, 0.35 + 0.5 * progress);

    ctx.save();
    clipPanel(ctx); // dark backer — this IS the "completely hidden" starting state
    if (mode === "puzzle") {
      const revealed = Math.round(progress * PUZZLE_TILES);
      const tw = PANEL.w / PUZZLE_COLS, th = PANEL.h / PUZZLE_ROWS;
      for (let k = 0; k < revealed; k++) {
        const tile = tileOrder[k]!;
        const cx = tile % PUZZLE_COLS, cy = Math.floor(tile / PUZZLE_COLS);
        const dx = PANEL.x + cx * tw, dy = PANEL.y + cy * th;
        ctx.save();
        roundRectPath(ctx, dx, dy, tw, th, 3);
        ctx.clip();
        if (clearImg) ctx.drawImage(clearImg, PANEL.x, PANEL.y, PANEL.w, PANEL.h);
        ctx.restore();
        // Freshly-placed pieces flash a bright white edge — the "snap" pop.
        const fresh = k >= revealed - 2;
        ctx.save();
        ctx.lineWidth = fresh ? 2.5 : 1;
        ctx.strokeStyle = fresh ? "rgba(255,255,255,0.9)" : hexToRgba(color, 0.45);
        roundRectPath(ctx, dx + 0.75, dy + 0.75, tw - 1.5, th - 1.5, 3);
        ctx.stroke();
        ctx.restore();
      }
      // Seams so the un-revealed area reads as a grid of pieces to fill.
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      for (let c = 1; c < PUZZLE_COLS; c++) {
        const gx = PANEL.x + c * tw;
        ctx.beginPath(); ctx.moveTo(gx, PANEL.y); ctx.lineTo(gx, PANEL.y + PANEL.h); ctx.stroke();
      }
      for (let r = 1; r < PUZZLE_ROWS; r++) {
        const gy = PANEL.y + r * th;
        ctx.beginPath(); ctx.moveTo(PANEL.x, gy); ctx.lineTo(PANEL.x + PANEL.w, gy); ctx.stroke();
      }
      ctx.restore();
    } else if (art) {
      ctx.drawImage(art, PANEL.x, PANEL.y, PANEL.w, PANEL.h);
    }
    ctx.restore();

    drawCardFrame(ctx, PANEL.x, PANEL.y, PANEL.w, PANEL.h, color, 6, input.rarity);
    drawRarityBadge(ctx, PANEL.x + PANEL.w - 12, PANEL.y + 12, input.rarityLabel, color);
  };

  const renderFrame = async (progressIn: number): Promise<Buffer | null> => {
    const progress = clamp01(progressIn);
    let art: LoadedImage | null = clearImg;
    if (keyframeArts && keyframeArts.length > 0) {
      const idx = Math.min(
        keyframeArts.length - 1,
        Math.round(progress * (keyframeArts.length - 1)),
      );
      art = keyframeArts[idx] ?? clearImg;
    }
    return renderPng(WIDTH, HEIGHT, ctx => drawFrame(ctx, progress, art));
  };

  return { mode, maxSteps: mode === "puzzle" ? PUZZLE_TILES : KEYFRAMES, renderFrame };
}

// ── Shiny reveal ─────────────────────────────────────────────────────────────
// A looping sparkle/shine animation played when a SHINY is caught or pulled, so
// a shiny is instantly recognisable. Reuses the same canvas+gifencoder pipeline
// and the existing holo/foil/shine effect helpers. Best-effort → null (caller
// falls back to the static shiny canvas + ✨ badge).
// Shiny reveal styles. "classic" is the original gold shine; the rest are the
// admin-selectable looks configured in the Shiny Hub. "random" is resolved to a
// concrete style at call time (see resolveShinyStyle).
export type ShinyStyle = "classic" | "holofoil" | "rainbow" | "cosmic" | "prism" | "radiance";
const SHINY_STYLES: readonly ShinyStyle[] = ["classic", "holofoil", "rainbow", "cosmic", "prism", "radiance"];

export function resolveShinyStyle(value: string | null | undefined): ShinyStyle {
  if (value === "random") return SHINY_STYLES[Math.floor(Math.random() * SHINY_STYLES.length)]!;
  return (SHINY_STYLES as readonly string[]).includes(value ?? "") ? (value as ShinyStyle) : "classic";
}

export interface ShinyRevealInput {
  artUrl: string | null | undefined;
  rarity: Rarity;
  rarityLabel: string;
  rarityColor?: number | null;
  name: string;
  speed?: AnimationSpeed;
  style?: ShinyStyle;
}

// HSL → {r,g,b} in 0..255, shared by the rainbow/prism hue-cycling helpers.
function hslRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
function hsla(h: number, s: number, l: number, a: number): string {
  const [r, g, b] = hslRgb(h, s, l);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
function hslHex(h: number, s: number, l: number): number {
  const [r, g, b] = hslRgb(h, s, l);
  return (r << 16) | (g << 8) | b;
}

// Diagonal multi-band rainbow sheen sweeping across the card (rainbow / holo).
function drawRainbowSweep(ctx: Ctx, x: number, y: number, w: number, h: number, t: number, alpha = 0.5): void {
  ctx.save();
  roundRectPath(ctx, x, y, w, h, 18);
  ctx.clip();
  (ctx as unknown as { globalCompositeOperation: string }).globalCompositeOperation = "screen";
  const offset = (t * 1.6 - 0.3) * (w + h);
  const g = ctx.createLinearGradient(x + offset - h, y, x + offset, y + h);
  for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, hsla(i * 60 + t * 360, 90, 60, alpha * (i % 2 ? 0.5 : 0.9)));
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

// A dense twinkling starfield (cosmic).
function drawStarfield(ctx: Ctx, x: number, y: number, w: number, h: number, t: number, count = 60): void {
  ctx.save();
  roundRectPath(ctx, x, y, w, h, 18);
  ctx.clip();
  const seed = (n: number) => ((Math.sin(n * 127.1) * 43758.5453) % 1 + 1) % 1;
  for (let i = 0; i < count; i++) {
    const sx = x + seed(i) * w, sy = y + seed(i + 313) * h;
    const tw = Math.sin(t * Math.PI * 2 + i * 0.7) * 0.5 + 0.5;
    ctx.globalAlpha = 0.25 + tw * 0.75;
    ctx.fillStyle = i % 7 === 0 ? "#bfeaff" : "#ffffff";
    ctx.beginPath();
    ctx.arc(sx, sy, 0.6 + tw * 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

// Radiating light beams from the card centre (prism = multicolour, radiance = gold rays).
function drawRays(ctx: Ctx, cx: number, cy: number, t: number, opts: { count: number; len: number; prism?: boolean; color?: number }): void {
  ctx.save();
  (ctx as unknown as { globalCompositeOperation: string }).globalCompositeOperation = "screen";
  const spin = t * Math.PI * (opts.prism ? 0.6 : 0.4);
  for (let i = 0; i < opts.count; i++) {
    const ang = (i / opts.count) * Math.PI * 2 + spin;
    const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 + i);
    const len = opts.len * (0.7 + 0.3 * pulse);
    const stroke = opts.prism ? hsla((i / opts.count) * 360 + t * 200, 95, 62, 0.22 + pulse * 0.18) : hexToRgba(opts.color ?? 0xf1c40f, 0.16 + pulse * 0.2);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = opts.prism ? 3 : 6;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(ang) * len, cy + Math.sin(ang) * len);
    ctx.stroke();
  }
  ctx.restore();
}

// Per-style config: backdrop, the glow/frame colour, title, behind-card aura and
// the on-card overlay stack. Keeps renderShinyReveal a single, shared pipeline.
interface ShinyStyleSpec {
  title: string;
  titleColor: (t: number) => string;
  frameColor: (t: number) => number;
  glowColor: number;
  background: (ctx: Ctx, t: number) => void;
  aura?: (ctx: Ctx, t: number) => void;                                   // behind the card
  overlay: (ctx: Ctx, x: number, y: number, w: number, h: number, t: number) => void; // clipped on the card
}

const GOLD = 0xf1c40f;

function shinyStyleSpec(style: ShinyStyle): ShinyStyleSpec {
  switch (style) {
    case "holofoil":
      return {
        title: "✨ HOLO FOIL ✨",
        titleColor: () => "#c9fff4",
        frameColor: () => 0x8fe9df,
        glowColor: 0x5fe6d6,
        background: (ctx) => drawGradientBackground(ctx, WIDTH, HEIGHT, [[0, "rgba(95,230,214,0.28)"], [0.5, "#08110f"], [1, "#050807"]], 0.4),
        overlay: (ctx, x, y, w, h, t) => {
          drawFoilOverlay(ctx, x, y, w, h, t);
          drawRainbowSweep(ctx, x, y, w, h, (t + 0.5) % 1, 0.35);
          drawHoloSparkles(ctx, x, y, w, h, t, 22);
          drawShineSweep(ctx, x, y, w, h, t, 0xd6fff7);
        },
      };
    case "rainbow":
      return {
        title: "🌈 RAINBOW SHINY 🌈",
        titleColor: (t) => hsla(t * 360, 90, 70, 1),
        frameColor: (t) => 0xffffff, // recoloured per-frame in the render via aura ring
        glowColor: 0xff5fd0,
        background: (ctx, t) => drawGradientBackground(ctx, WIDTH, HEIGHT, [[0, hsla(t * 360, 80, 22, 1)], [0.5, "#0a0810"], [1, "#060409"]], 0.5),
        overlay: (ctx, x, y, w, h, t) => {
          drawRainbowSweep(ctx, x, y, w, h, t, 0.6);
          drawRainbowSweep(ctx, x, y, w, h, (t + 0.33) % 1, 0.4);
          drawHoloSparkles(ctx, x, y, w, h, t, 30);
        },
      };
    case "cosmic":
      return {
        title: "🌌 COSMIC SHINY 🌌",
        titleColor: () => "#cbb8ff",
        frameColor: () => 0x8a7bff,
        glowColor: 0x7b6cff,
        background: (ctx) => drawGradientBackground(ctx, WIDTH, HEIGHT, [[0, "rgba(90,60,180,0.30)"], [0.45, "#0b0a1f"], [1, "#050410"]], 1.2),
        aura: (ctx, t) => {
          // Two drifting nebula glows.
          for (const [ox, oy, hue] of [[-70, -40, 265], [80, 60, 300]] as const) {
            const g = ctx.createRadialGradient(WIDTH / 2 + ox, HEIGHT / 2 + oy, 10, WIDTH / 2 + ox, HEIGHT / 2 + oy, 220);
            g.addColorStop(0, hsla(hue + t * 30, 80, 60, 0.22));
            g.addColorStop(1, "rgba(0,0,0,0)");
            ctx.fillStyle = g; ctx.fillRect(0, 0, WIDTH, HEIGHT);
          }
        },
        overlay: (ctx, x, y, w, h, t) => {
          drawStarfield(ctx, x, y, w, h, t, 70);
          drawShineSweep(ctx, x, y, w, h, t, 0xbfa8ff);
        },
      };
    case "prism":
      return {
        title: "🔷 PRISM SHINY 🔷",
        titleColor: (t) => hsla(t * 360 + 180, 90, 72, 1),
        frameColor: () => 0xffffff,
        glowColor: 0x66ccff,
        background: (ctx) => drawGradientBackground(ctx, WIDTH, HEIGHT, [[0, "rgba(120,220,255,0.18)"], [0.5, "#0a0d16"], [1, "#05070d"]], 0.6),
        aura: (ctx, t) => drawRays(ctx, WIDTH / 2, HEIGHT / 2, t, { count: 16, len: 300, prism: true }),
        overlay: (ctx, x, y, w, h, t) => {
          drawFoilOverlay(ctx, x, y, w, h, t);
          drawRainbowSweep(ctx, x, y, w, h, t, 0.45);
          drawShineSweep(ctx, x, y, w, h, (t + 0.5) % 1, 0xffffff);
          drawHoloSparkles(ctx, x, y, w, h, t, 18);
        },
      };
    case "radiance":
      return {
        title: "☀️ GOLD RADIANCE ☀️",
        titleColor: () => "#ffe9a8",
        frameColor: () => GOLD,
        glowColor: GOLD,
        background: (ctx) => drawGradientBackground(ctx, WIDTH, HEIGHT, [[0, "rgba(241,196,15,0.34)"], [0.5, "#171003"], [1, "#0a0702"]], 0.5),
        aura: (ctx, t) => drawRays(ctx, WIDTH / 2, HEIGHT / 2, t, { count: 20, len: 320, color: 0xffcf4d }),
        overlay: (ctx, x, y, w, h, t) => {
          drawFoilOverlay(ctx, x, y, w, h, t);
          drawShineSweep(ctx, x, y, w, h, t, 0xfff2c4);
          drawHoloSparkles(ctx, x, y, w, h, t, 20);
        },
      };
    case "classic":
    default:
      return {
        title: "✨ SHINY! ✨",
        titleColor: () => "#ffe27a",
        frameColor: () => GOLD,
        glowColor: GOLD,
        background: (ctx) => drawGradientBackground(ctx, WIDTH, HEIGHT, [[0, hexToRgba(GOLD, 0.32)], [0.5, "#141007"], [1, "#0a0803"]], 0.32),
        overlay: (ctx, x, y, w, h, t) => {
          drawFoilOverlay(ctx, x, y, w, h, t);
          drawHoloSparkles(ctx, x, y, w, h, t, 28);
          drawShineSweep(ctx, x, y, w, h, t, 0xffffff);
        },
      };
  }
}

export async function renderShinyReveal(input: ShinyRevealInput): Promise<Buffer | null> {
  const mod = await getCanvas();
  if (!mod) return null;
  // Require the art to be loadable up-front so we don't emit a frame-less card.
  const probe = await loadArtBuffer(input.artUrl);
  if (!probe) return null;

  const color = input.rarityColor ?? getRarityEffectColor(input.rarity);
  const spec = shinyStyleSpec(input.style ?? "classic");
  try {
    const result = await encodeAnimation({
      width: WIDTH,
      height: HEIGHT,
      speed: input.speed ?? "normal",
      durationMs: 2400,
      maxFrames: 24,
      quality: 20,
      render: async ({ ctx, t, mod: m }) => {
        spec.background(ctx, t);
        drawTitle(ctx, spec.title, WIDTH / 2, 36, spec.titleColor(t), 26);

        // Behind-card aura (rays / nebula), then a pulsing rarity glow.
        spec.aura?.(ctx, t);
        const pulse = 0.7 + 0.3 * Math.sin(t * Math.PI * 2);
        // Rainbow style cycles the glow hue for a shifting halo.
        const glow = input.style === "rainbow" ? hslHex(t * 360, 90, 55) : spec.glowColor;
        drawRarityGlow(ctx, PANEL.x, PANEL.y, PANEL.w, PANEL.h, glow, pulse);

        // Card art + the style's on-card overlay stack.
        ctx.save();
        clipPanel(ctx);
        await drawCardArt(ctx, m, PANEL.x, PANEL.y, PANEL.w, PANEL.h, input.artUrl, input.rarity);
        spec.overlay(ctx, PANEL.x, PANEL.y, PANEL.w, PANEL.h, t);
        ctx.restore();

        const frameCol = input.style === "rainbow" ? glow : spec.frameColor(t);
        drawCardFrame(ctx, PANEL.x, PANEL.y, PANEL.w, PANEL.h, frameCol, 6, input.rarity);
        drawRarityBadge(ctx, PANEL.x + PANEL.w - 12, PANEL.y + 12, input.rarityLabel, color);

        // Name below the card.
        const nameY = PANEL.y + PANEL.h + 32;
        drawTitle(ctx, `✨ ${input.name}`, WIDTH / 2, nameY, "#ffffff", fitText(ctx, `✨ ${input.name}`, WIDTH - 60, 28, 14, TITLE_FONT));
      },
    });
    return result?.buffer ?? null;
  } catch (err) {
    logger.debug({ err }, "shiny-reveal: encode failed");
    return null;
  }
}

// ── Shiny showcase ───────────────────────────────────────────────────────────
// A premium, looping "show off" animation for the /show-shiny command. It reuses
// the exact holo/foil/shine effect stack as the shiny catch reveal, but dressed
// as a trophy showcase: the owner's chosen shiny front-and-centre with its
// level, star rank and shiny copy-count called out. Best-effort → null (the
// caller falls back to a plain embed).
export interface ShinyShowcaseInput {
  artUrl: string | null | undefined;
  rarity: Rarity;
  rarityLabel: string;
  rarityColor?: number | null;
  name: string;
  ownerName: string;
  level?: number;
  stars?: number;       // 0–5 filled
  shinyCount?: number;  // shiny copies owned
  shinyLabel?: string;  // the guild's shiny name (default "Shiny")
  speed?: AnimationSpeed;
}

// Compact showcase geometry: a slightly shorter card panel than the catch
// reveal, leaving room below for the card name AND a meta line.
const SHOWCASE_PANEL = { x: 40, y: 66, w: 400, h: 452 } as const;

export async function renderShinyShowcase(input: ShinyShowcaseInput): Promise<Buffer | null> {
  const mod = await getCanvas();
  if (!mod) return null;
  // Require the art to be loadable up-front so we never emit a frame-less card.
  const probe = await loadArtBuffer(input.artUrl);
  if (!probe) return null;

  const color = input.rarityColor ?? getRarityEffectColor(input.rarity);
  const gold = 0xf1c40f;
  const stars = Math.max(0, Math.min(5, Math.round(input.stars ?? 0)));
  const P = SHOWCASE_PANEL;
  try {
    const result = await encodeAnimation({
      width: WIDTH,
      height: HEIGHT,
      speed: input.speed ?? "normal",
      durationMs: 2600,
      maxFrames: 20,
      // GIF encode time scales with encoded pixel count, so the showcase is
      // rendered at ~0.72 scale (346×432 — still comfortably above Discord's
      // inline display size) with a coarser NeuQuant sample factor. Keeps the
      // command feeling instant instead of spending seconds in the encoder.
      quality: 26,
      renderScale: 0.72,
      render: async ({ ctx, t, mod: m }) => {
        // Warm, shiny gold-tinted backdrop.
        drawGradientBackground(ctx, WIDTH, HEIGHT, [
          [0, hexToRgba(gold, 0.30)],
          [0.5, "#141007"],
          [1, "#0a0803"],
        ], 0.30);

        // Owner banner up top.
        const banner = `✨ ${input.ownerName}'s Shiny ✨`;
        drawTitle(ctx, banner, WIDTH / 2, 36, "#ffe27a", fitText(ctx, banner, WIDTH - 48, 24, 14, TITLE_FONT));

        // Pulsing glow behind the card.
        const pulse = 0.7 + 0.3 * Math.sin(t * Math.PI * 2);
        drawRarityGlow(ctx, P.x, P.y, P.w, P.h, gold, pulse);

        // Card art + animated holo/foil/shine layered on top.
        ctx.save();
        roundRectPath(ctx, P.x, P.y, P.w, P.h, 16);
        ctx.clip();
        ctx.fillStyle = "#0b0c11";
        ctx.fillRect(P.x, P.y, P.w, P.h);
        await drawCardArt(ctx, m, P.x, P.y, P.w, P.h, input.artUrl, input.rarity);
        drawFoilOverlay(ctx, P.x, P.y, P.w, P.h, t);
        drawHoloSparkles(ctx, P.x, P.y, P.w, P.h, t, 30);
        drawShineSweep(ctx, P.x, P.y, P.w, P.h, t, 0xffffff);
        ctx.restore();

        drawCardFrame(ctx, P.x, P.y, P.w, P.h, gold, 6, input.rarity);
        drawRarityBadge(ctx, P.x + P.w - 12, P.y + 12, input.rarityLabel, color);

        // Name below the card.
        const nameY = P.y + P.h + 30;
        const nameText = `✨ ${input.name}`;
        drawTitle(ctx, nameText, WIDTH / 2, nameY, "#ffffff", fitText(ctx, nameText, WIDTH - 60, 26, 14, TITLE_FONT));

        // Meta line: level · stars · shiny count.
        const meta: string[] = [];
        if (input.level && input.level > 1) meta.push(`Lv ${input.level}`);
        if (stars > 0) meta.push("★".repeat(stars) + "☆".repeat(5 - stars));
        const count = input.shinyCount ?? 0;
        if (count > 0) meta.push(`${input.shinyLabel ?? "Shiny"} ×${count}`);
        if (meta.length) {
          drawTextWithShadow(ctx, meta.join("   ·   "), WIDTH / 2, nameY + 28, "#ffe27a", 16);
        }
      },
    });
    return result?.buffer ?? null;
  } catch (err) {
    logger.debug({ err }, "shiny-showcase: encode failed");
    return null;
  }
}
