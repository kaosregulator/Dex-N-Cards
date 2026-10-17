// ─────────────────────────────────────────────────────────────────────────────
// Wild Mini-Game canvases — the animated intro/menu + per-step gameplay frames.
//
// Reuses the SHARED animation/battle/raid engine (no second renderer): the same
// getCanvas + drawGradientBackground + drawCardArt/Frame/Glow + drawTitle helpers
// the raid canvases (raid/canvas.ts) use, so a mini-game screen carries the same
// card art, DN frame, theme, and sizes as battles and raids. Layout matches the
// uploaded mockups: a dark panel with an accent left-edge bar, a big Orbitron
// banner + star divider on the left, prompt lines and a status box below it, and
// the caught card glowing on the right over an atmospheric, theme-tinted field.
//
// Best-effort like every other canvas: null on failure → the embed renders text
// only, exactly as the rest of the bot degrades.
// ─────────────────────────────────────────────────────────────────────────────

import {
  getCanvas, hexToRgba, roundRectPath, drawGradientBackground,
  encodeAnimation, clamp01, type Ctx, type CanvasMod,
} from "../animations/engine.js";
import { queueRender } from "../animations/render-queue.js";
import { drawAtmosphere, atmospherePreset } from "../animations/atmosphere.js";
import { drawEmbers } from "../animations/particles.js";
import {
  drawCardArt, drawCardFrame, drawRarityGlow, drawRarityBadge,
  drawTextWithShadow, drawTitle, fitText, TITLE_FONT,
} from "../animations/effects.js";
import type { AnimationSpeed } from "../animations/types.js";
import type { Rarity } from "../cards-data.js";
import { logger } from "../../lib/logger.js";

export const MG_CANVAS = { width: 920, height: 500 } as const;
export const MG_FILE = "minigame.png";
export const MG_GIF_FILE = "minigame.gif";
export const MG_MEMORY_FILE = "minigame-memory.png";

export interface MiniGameScreenSpec {
  // Accent/theme color for banner + glow + left bar (hex int).
  theme: number;
  // Emoji drawn before the title (best-effort — falls back to nothing).
  icon?: string;
  // Big banner. `title` renders in the theme color, `titleTail` (optional) in
  // white on the same line — mirrors "WILD CARD | DETECTED" in the mockups.
  title: string;
  titleTail?: string;
  // Small line under the title, e.g. "(Difficulty: LEGENDARY)".
  subtitle?: string;
  // Prompt body lines.
  lines: string[];
  // Status box, e.g. label "TIMERS:" value "8.2 seconds remaining…".
  statusLabel?: string;
  statusValue?: string;
  // The caught card.
  cardArtUrl: string | null;
  cardName: string;
  rarityLabel: string;
  rarityColor: number;
  // Rarity key for the image-frame mapping (falls back to color-only when absent).
  rarity?: Rarity;
  // Hide the real art (Choose-a-Card / Code Break) — show a facedown DN back
  // with a badge instead.
  hideCardArt?: boolean;
  cardBadge?: string;
}

// Emoji and custom emoji stay. The shared canvas font hook draws them.
function drawSafe(s: string): string {
  return s.replace(/\s{2,}/g, " ").trim();
}

interface PaintAnim {
  pulse: number;         // 0→1 glow/scan pulse
  cardShiftX?: number;   // horizontal card offset (escaping-card motion)
  speedLines?: boolean;  // draw motion streaks behind the card
}

// Draw the whole scene once. `anim` drives the glow/scan/motion so the same paint
// routine serves the still PNG, the pulsing intro GIF, and the chase motion GIF.
async function paint(ctx: Ctx, mod: CanvasMod, spec: MiniGameScreenSpec, anim: PaintAnim): Promise<void> {
  const { width, height } = MG_CANVAS;
  const accent = spec.theme;
  const pulse = anim.pulse;

  // Background: theme-tinted gradient + arena atmosphere (fog/dust/embers).
  drawGradientBackground(ctx, width, height, [
    [0, hexToRgba(accent, 0.32)],
    [0.55, "#0b0d12"],
    [1, "#050507"],
  ], 0.3);
  drawAtmosphere(ctx, width, height, atmospherePreset("arena"), {
    seed: `${spec.cardName}-mg`, color: accent, density: 0.5,
  });

  // Dark inner panel with an accent left-edge bar (the mockup "embed" body).
  const px = 14, py = 14, pw = width - 28, ph = height - 28;
  ctx.save();
  roundRectPath(ctx, px, py, pw, ph, 20);
  ctx.fillStyle = "rgba(10,11,15,0.82)";
  ctx.fill();
  ctx.restore();
  ctx.save();
  roundRectPath(ctx, px, py, 8, ph, 4);
  ctx.fillStyle = hexToRgba(accent, 0.95);
  ctx.fill();
  ctx.restore();

  // ── Card on the right ──────────────────────────────────────────────────────
  const cw = 248, ch = 348, cx0 = width - cw - 36, cy = (height - ch) / 2 - 8;
  const cx = cx0 + (anim.cardShiftX ?? 0);
  // Motion streaks trailing the escaping card (drawn behind it).
  if (anim.speedLines) {
    ctx.save();
    ctx.strokeStyle = hexToRgba(accent, 0.5);
    ctx.lineCap = "round";
    for (let i = 0; i < 9; i++) {
      const ly2 = cy + 24 + (ch - 48) * (i / 8);
      const len = 60 + (i % 3) * 40 + pulse * 40;
      ctx.lineWidth = 2 + (i % 2);
      ctx.globalAlpha = 0.25 + 0.5 * ((i % 3) / 2);
      ctx.beginPath();
      ctx.moveTo(cx - 20, ly2);
      ctx.lineTo(cx - 20 - len, ly2);
      ctx.stroke();
    }
    ctx.restore();
  }
  const glow = 0.55 + 0.4 * pulse;
  drawRarityGlow(ctx, cx, cy, cw, ch, spec.rarityColor, glow);
  if (spec.hideCardArt) {
    // Facedown DN back — dark card with the DN monogram.
    ctx.save();
    roundRectPath(ctx, cx, cy, cw, ch, 14);
    ctx.clip();
    drawGradientBackground(ctx, width, height, [
      [0, hexToRgba(accent, 0.4)], [1, "#0a0a10"],
    ], 0.2);
    ctx.restore();
    drawTitle(ctx, "DN", cx + cw / 2, cy + ch / 2 - 8, "#ffffff", 64);
    drawTextWithShadow(ctx, "CARDS", cx + cw / 2, cy + ch / 2 + 34, hexToRgba(accent, 1), 22);
  } else {
    await drawCardArt(ctx, mod, cx, cy, cw, ch, spec.cardArtUrl, spec.rarity);
  }
  drawCardFrame(ctx, cx, cy, cw, ch, spec.rarityColor, 8, spec.rarity);
  if (spec.cardBadge) drawRarityBadge(ctx, cx + cw - 14, cy + 16, drawSafe(spec.cardBadge), spec.rarityColor);
  drawEmbers(ctx, cx - 16, cy, cw + 32, ch, { color: accent, count: 22, seed: `${spec.cardName}-aura` });
  drawTextWithShadow(ctx, drawSafe(spec.cardName), cx + cw / 2, cy + ch + 20, "#ffffff",
    fitText(ctx, drawSafe(spec.cardName), cw + 40, 22, 12, TITLE_FONT), "center", TITLE_FONT);

  // ── Left column ────────────────────────────────────────────────────────────
  const lx = 44;
  let ly = 72;
  // Title (accent word + white tail), scaled to fit the left half.
  const titleText = drawSafe(spec.title);
  const titleTail = spec.titleTail ? drawSafe(spec.titleTail) : "";
  const titleSize = fitText(ctx, `${titleText} ${titleTail}`, 460, 44, 22, TITLE_FONT);
  drawTitle(ctx, titleText, lx, ly, hexToRgba(accent, 1), titleSize, "left");
  if (titleTail) {
    ctx.save();
    ctx.font = `bold ${titleSize}px "${TITLE_FONT}", "DejaVu Sans", Arial, sans-serif`;
    const tw = ctx.measureText(titleText + " ").width;
    ctx.restore();
    drawTitle(ctx, titleTail, lx + tw, ly, "#ffffff", titleSize, "left");
  }
  ly += 30;
  if (spec.subtitle) {
    drawTextWithShadow(ctx, drawSafe(spec.subtitle), lx, ly, hexToRgba(accent, 1), 20, "left");
    ly += 24;
  }
  // Star divider.
  ly += 8;
  ctx.save();
  ctx.strokeStyle = hexToRgba(accent, 0.6);
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + 340, ly); ctx.stroke();
  ctx.restore();
  drawTitle(ctx, "★", lx + 170, ly, hexToRgba(accent, 1), 18);
  ly += 32;

  // Prompt lines.
  for (const line of spec.lines.slice(0, 5)) {
    drawTextWithShadow(ctx, drawSafe(line), lx, ly, "#e8ebf0", 20, "left");
    ly += 28;
  }

  // Status box.
  if (spec.statusLabel || spec.statusValue) {
    ly += 12;
    if (spec.statusLabel) {
      drawTextWithShadow(ctx, drawSafe(spec.statusLabel), lx, ly, hexToRgba(accent, 1), 20, "left");
      ly += 30;
    }
    const boxW = 400, boxH = 46;
    ctx.save();
    roundRectPath(ctx, lx, ly, boxW, boxH, 8);
    ctx.strokeStyle = hexToRgba(accent, 0.8);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
    if (spec.statusValue) {
      drawTextWithShadow(ctx, drawSafe(spec.statusValue), lx + 16, ly + boxH / 2, hexToRgba(accent, 1), 22, "left");
    }
  }

  // Subtle scan line sweeping down the card for the animated version.
  if (pulse > 0) {
    const scanY = cy + ch * clamp01(pulse);
    ctx.save();
    ctx.strokeStyle = hexToRgba(accent, 0.5 * (1 - pulse));
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(cx, scanY); ctx.lineTo(cx + cw, scanY); ctx.stroke();
    ctx.restore();
  }
}

// Single still frame (per-step gameplay screens).
export async function renderMiniGameStill(spec: MiniGameScreenSpec): Promise<Buffer | null> {
  return queueRender("minigame-still", async () => {
    const mod = await getCanvas();
    if (!mod) return null;
    try {
      const { width, height } = MG_CANVAS;
      const canvas = mod.createCanvas(width, height);
      const ctx = canvas.getContext("2d") as unknown as Ctx;
      await paint(ctx, mod, spec, { pulse: 0.35 });
      return await canvas.encode("png");
    } catch (err) {
      logger.debug({ err }, "minigame still canvas: render failed");
      return null;
    }
  });
}

// Animated intro GIF — a pulsing glow + downward scan over ~1.4s. Renders at half
// scale to stay well under the attachment ceiling.
export async function renderMiniGameIntro(
  spec: MiniGameScreenSpec, speed: AnimationSpeed = "normal",
): Promise<Buffer | null> {
  const { width, height } = MG_CANVAS;
  const result = await encodeAnimation({
    width, height, speed, durationMs: 1400, maxFrames: 16, quality: 18, renderScale: 0.5,
    render: async ({ ctx, mod, t }) => {
      // Ping-pong the pulse so the loop breathes rather than jumping.
      const pulse = t < 0.5 ? t * 2 : (1 - t) * 2;
      await paint(ctx as unknown as Ctx, mod, spec, { pulse });
    },
  });
  return result?.buffer ?? null;
}

// ── Memory Match board ───────────────────────────────────────────────────────
export interface MemoryCell {
  state: "down" | "up" | "matched";
  artUrl: string | null;
  rarityColor: number;
  rarity?: Rarity;
}
export interface MemoryBoardInput {
  theme: number;
  title: string;
  subtitle: string;
  cols: number;
  cells: MemoryCell[];
}

// Draw a small facedown DN card back at (x,y,w,h).
function drawCardBack(ctx: Ctx, x: number, y: number, w: number, h: number, accent: number): void {
  ctx.save();
  roundRectPath(ctx, x, y, w, h, 12);
  ctx.clip();
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, hexToRgba(accent, 0.35));
  g.addColorStop(1, "#0a0a10");
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
  drawTitle(ctx, "DN", x + w / 2, y + h / 2 - 6, "#ffffff", Math.round(w * 0.28));
  drawTextWithShadow(ctx, "CARDS", x + w / 2, y + h / 2 + Math.round(h * 0.14), hexToRgba(accent, 1), Math.round(w * 0.11));
  drawCardFrame(ctx, x, y, w, h, accent, 4);
}

// Render the memory board: a grid of small cards, each facedown, face-up (real
// card art), or matched (dimmed with a ✓). Positions are numbered 1..n to map to
// the flip buttons.
export async function renderMemoryBoard(input: MemoryBoardInput): Promise<Buffer | null> {
  return queueRender("minigame-memory", async () => {
    const mod = await getCanvas();
    if (!mod) return null;
    try {
      const { width, height } = MG_CANVAS;
      const canvas = mod.createCanvas(width, height);
      const ctx = canvas.getContext("2d") as unknown as Ctx;
      const accent = input.theme;

      drawGradientBackground(ctx, width, height, [
        [0, hexToRgba(accent, 0.3)], [0.55, "#0b0d12"], [1, "#050507"],
      ], 0.3);
      drawAtmosphere(ctx, width, height, atmospherePreset("arena"), { seed: "memory-mg", color: accent, density: 0.4 });

      drawTitle(ctx, drawSafe(input.title), width / 2, 40, "#ffffff", 34);
      drawTextWithShadow(ctx, drawSafe(input.subtitle), width / 2, 74, hexToRgba(accent, 1), 20);

      const n = input.cells.length;
      const cols = input.cols;
      const rows = Math.ceil(n / cols);
      const gap = 22;
      const areaTop = 96, areaBottom = height - 40;
      const availH = areaBottom - areaTop;
      const ch = Math.min(190, Math.floor((availH - (rows - 1) * gap) / rows));
      const cw = Math.round(ch * 0.72);
      const gridW = cols * cw + (cols - 1) * gap;
      const x0 = Math.round((width - gridW) / 2);
      const gridH = rows * ch + (rows - 1) * gap;
      const y0 = Math.round(areaTop + (availH - gridH) / 2);

      for (let i = 0; i < n; i++) {
        const cell = input.cells[i]!;
        const col = i % cols, row = Math.floor(i / cols);
        const x = x0 + col * (cw + gap);
        const y = y0 + row * (ch + gap);
        if (cell.state === "down") {
          drawCardBack(ctx, x, y, cw, ch, accent);
          drawTextWithShadow(ctx, String(i + 1), x + cw / 2, y + ch + 16, "rgba(255,255,255,0.75)", 18);
        } else {
          const col2 = cell.rarityColor;
          drawRarityGlow(ctx, x, y, cw, ch, col2, cell.state === "matched" ? 0.4 : 0.75);
          await drawCardArt(ctx, mod, x, y, cw, ch, cell.artUrl, cell.rarity);
          drawCardFrame(ctx, x, y, cw, ch, cell.state === "matched" ? 0x2ecc71 : col2, 5, cell.rarity);
          if (cell.state === "matched") {
            ctx.save();
            roundRectPath(ctx, x, y, cw, ch, 12); ctx.clip();
            ctx.fillStyle = "rgba(0,0,0,0.4)"; ctx.fillRect(x, y, cw, ch);
            ctx.restore();
            drawTitle(ctx, "✓", x + cw / 2, y + ch / 2, "#2ecc71", Math.round(cw * 0.5));
          }
        }
      }
      return await canvas.encode("png");
    } catch (err) {
      logger.debug({ err }, "memory board canvas: render failed");
      return null;
    }
  });
}

// The "card is escaping" motion GIF (Chase): the card lunges toward the edge and
// snaps back, trailing speed lines — a looping struggle-to-flee. Loops forever.
export async function renderChaseIntro(
  spec: MiniGameScreenSpec, speed: AnimationSpeed = "normal",
): Promise<Buffer | null> {
  const { width, height } = MG_CANVAS;
  const result = await encodeAnimation({
    width, height, speed, durationMs: 1600, maxFrames: 20, quality: 18, renderScale: 0.5,
    render: async ({ ctx, mod, t }) => {
      // Ease the card outward then back — like it keeps trying to bolt.
      const lunge = Math.sin(t * Math.PI * 2);
      const cardShiftX = Math.max(0, lunge) * 46;
      await paint(ctx as unknown as Ctx, mod, spec, {
        pulse: 0.4 + 0.6 * Math.abs(lunge), cardShiftX, speedLines: true,
      });
    },
  });
  return result?.buffer ?? null;
}
