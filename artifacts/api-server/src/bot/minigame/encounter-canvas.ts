// ─────────────────────────────────────────────────────────────────────────────
// Wild-encounter intro — the Pokémon-style "A WILD CARD APPEARED!" opener that
// plays BEFORE any game. Composites the user-supplied pixel-art assets
// (assets/minigame/): a clean sunset Background, TWO DISTINCT grass islands (a
// clean island for the enemy side + a card-strewn island for the player side),
// the DN trainer figure (holding his special cards) sliding in from the left,
// the caught card (the REAL spawned card's art in its DN frame) sliding in from
// the right, an enemy name/HP box top-left, a pixel pokéball tray bottom-left,
// the joke menu box (bottom-right) and the wide dialogue box. All text is drawn
// in the bundled Press Start 2P bitmap font for the retro Game Boy look. Reuses
// the shared animation engine. Best-effort: any missing asset falls back to a
// drawn stand-in; a null render lets the flow fall back to text only.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getCanvas, hexToRgba, roundRectPath, encodeAnimation, clamp01, easeInOutCubic, lerp,
  PIXEL_FONT_FAMILY, type Ctx, type CanvasMod,
} from "../animations/engine.js";
import { queueRender } from "../animations/render-queue.js";
import { drawCardArt, drawCardFrame, drawRarityGlow, fitText } from "../animations/effects.js";
import type { Rarity } from "../cards-data.js";
import type { AnimationSpeed } from "../animations/types.js";
import { logger } from "../../lib/logger.js";

type Img = import("@napi-rs/canvas").Image;

export const ENCOUNTER_CANVAS = { width: 920, height: 500 } as const;
export const ENCOUNTER_GIF_FILE = "wild-encounter.gif";
export const ENCOUNTER_PNG_FILE = "wild-encounter.png";

// The bitmap font, with graceful fallbacks if it isn't registered.
const PIXEL_STACK = `"${PIXEL_FONT_FAMILY}", "DejaVu Sans", Arial, sans-serif`;

export interface WildEncounterInput {
  cardArtUrl: string | null;
  cardName: string;
  rarityLabel: string;
  rarityColor: number;
  rarity?: Rarity;
  avatarUrl: string | null;       // kept for compat; the figure sprite is the player
  menuLabels?: string[];          // the shuffled joke options shown in the menu box
}

// ── Bundled pixel-art assets (resolved like animations/arena-bg.ts) ───────────
let _assetsDir: string | null | undefined;
function assetsDir(): string | null {
  if (_assetsDir !== undefined) return _assetsDir;
  const candidates: string[] = [];
  try { candidates.push(fileURLToPath(new URL("../../../assets/minigame/", import.meta.url))); } catch { /* not ESM */ }
  candidates.push(join(process.cwd(), "assets/minigame"), join(process.cwd(), "artifacts/api-server/assets/minigame"));
  _assetsDir = candidates.find(d => existsSync(d)) ?? null;
  return _assetsDir;
}
const imgCache = new Map<string, Promise<Img | null>>();
function localImg(mod: CanvasMod, name: string): Promise<Img | null> {
  const cached = imgCache.get(name);
  if (cached) return cached;
  const p = (async () => {
    const dir = assetsDir();
    if (!dir) return null;
    const file = join(dir, name);
    if (!existsSync(file)) return null;
    try { return await mod.loadImage(readFileSync(file)); }
    catch (err) { logger.debug({ err, file }, "minigame asset load failed"); return null; }
  })();
  imgCache.set(name, p);
  return p;
}

function safe(s: string): string {
  return s.replace(/[\u{1F000}-\u{1FAFF}\u{FE00}-\u{FE0F}\u{2190}-\u{27BF}\u{2B00}-\u{2BFF}]/gu, "").replace(/\s{2,}/g, " ").trim();
}

// Crisp pixel-font text with a 2px drop shadow (no heavy outline — keeps the
// blocky glyphs legible at small sizes). Positions are TOP-anchored by default.
type PixAlign = "left" | "right" | "center";
function drawPixelText(
  ctx: Ctx, text: string, x: number, y: number,
  color: string, size: number, align: PixAlign = "left",
  baseline: "top" | "middle" = "top",
): void {
  ctx.save();
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.font = `${size}px ${PIXEL_STACK}`;
  ctx.fillStyle = "rgba(0,0,0,0.82)";
  ctx.fillText(text, x + 2, y + 2);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

// Cover-fit an image across a rect (crops overflow, like CSS background-size:cover).
function drawCover(ctx: Ctx, img: Img, x: number, y: number, w: number, h: number): void {
  const s = Math.max(w / img.width, h / img.height);
  const dw = img.width * s, dh = img.height * s;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

// Draw an image scaled to a target width, horizontally centered on cx, with its
// BOTTOM at anchorBottomY (feet/base placement).
function drawImgBottom(ctx: Ctx, img: Img, cx: number, anchorBottomY: number, targetW: number): void {
  const s = targetW / img.width;
  const w = targetW, h = img.height * s;
  ctx.drawImage(img, cx - w / 2, anchorBottomY - h, w, h);
}

function drawFallbackPlatform(ctx: Ctx, cx: number, cy: number, rx: number, ry: number): void {
  const e = ctx as unknown as { ellipse(cx: number, cy: number, rx: number, ry: number, r: number, a0: number, a1: number): void };
  ctx.save(); ctx.beginPath(); e.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.fillStyle = "#4e8f3a"; ctx.fill();
  ctx.beginPath(); e.ellipse(cx, cy - ry * 0.25, rx * 0.9, ry * 0.7, 0, 0, Math.PI * 2); ctx.fillStyle = "#6ab04c"; ctx.fill(); ctx.restore();
}

// A single pixel-art pokéball.
function drawPokeball(ctx: Ctx, cx: number, cy: number, r: number): void {
  const arc = (rad: number, a0: number, a1: number, fill: string) => {
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, rad, a0, a1); ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
  };
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = "#141418"; ctx.fill(); // outline
  arc(r - 2, Math.PI, 0, "#e02626");        // top red half
  arc(r - 2, 0, Math.PI, "#f0f0f0");        // bottom white half
  ctx.fillStyle = "#141418"; ctx.fillRect(cx - (r - 2), cy - 2, (r - 2) * 2, 4); // band
  ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fillStyle = "#141418"; ctx.fill();
  ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fillStyle = "#f5f5f5"; ctx.fill();
}

// The trainer's pokéball tray (bottom-left) — a dark rounded bar of balls.
function drawPokeballTray(ctx: Ctx, x: number, y: number, w: number, h: number, n: number): void {
  roundRectPath(ctx, x, y, w, h, 9);
  ctx.fillStyle = "rgba(38,38,46,0.96)"; ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = "rgba(96,96,112,0.9)"; ctx.stroke();
  const r = Math.round(h * 0.32), gap = w / n;
  for (let i = 0; i < n; i++) drawPokeball(ctx, Math.round(x + gap * (i + 0.5)), Math.round(y + h / 2), r);
}

async function paint(ctx: Ctx, mod: CanvasMod, input: WildEncounterInput, t: number): Promise<void> {
  const { width, height } = ENCOUNTER_CANVAS;
  const accent = input.rarityColor;
  const [bg, enemyIsland, playerIsland, textbox, menubox, trainer] = await Promise.all([
    localImg(mod, "background.png"), localImg(mod, "island2.png"), localImg(mod, "island1.png"),
    localImg(mod, "textbox.png"), localImg(mod, "menubox.png"), localImg(mod, "trainer.png"),
  ]);

  // Background — the supplied clean sunset, or a matching gradient fallback.
  if (bg) {
    drawCover(ctx, bg, 0, 0, width, height);
  } else {
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, "#c15f39"); sky.addColorStop(0.5, "#9c5a2b"); sky.addColorStop(1, "#7b4a24");
    ctx.fillStyle = sky; ctx.fillRect(0, 0, width, height);
  }

  // Slower slide-in (eases over the first ~72% of the timeline).
  const slide = easeInOutCubic(clamp01(t / 0.72));

  // Enemy island (upper-right) + the wild card, centered on its island, sliding
  // in from the right. Raised so it sits clearly ABOVE the menu box, per ref.
  const epx = 640, epBottom = 248;
  if (enemyIsland) drawImgBottom(ctx, enemyIsland, epx, epBottom, 300);
  else drawFallbackPlatform(ctx, epx, epBottom - 16, 150, 36);
  const cw = 168, ch = 236, cardBottom = 246;
  const cardCx = lerp(width + 80, epx, slide);
  const cardX = cardCx - cw / 2, cardY = cardBottom - ch;
  drawRarityGlow(ctx, cardX, cardY, cw, ch, accent, 0.85);
  await drawCardArt(ctx, mod, cardX, cardY, cw, ch, input.cardArtUrl, input.rarity);
  drawCardFrame(ctx, cardX, cardY, cw, ch, accent, 6, input.rarity);

  // Player side + the trainer sliding in from the left. The figure is large
  // (foreground); its grass island is ALMOST HIDDEN — pushed well below the frame
  // so only a hill of grass peeks out at the feet, mostly behind the figure and
  // the dialogue box — mirroring the reference mockup.
  const ppx = 150, ppBottom = 560;
  if (playerIsland) drawImgBottom(ctx, playerIsland, ppx, ppBottom, 480);
  else drawFallbackPlatform(ctx, ppx, 430, 160, 34);
  const figCx = lerp(-180, 210, slide);
  if (trainer) drawImgBottom(ctx, trainer, figCx, 430, 280);

  // Enemy name/HP box — top-left (fades in with the slide).
  ctx.save();
  ctx.globalAlpha = slide;
  const bx = 18, by = 14, bw = 380, bh = 78;
  roundRectPath(ctx, bx, by, bw, bh, 11);
  ctx.fillStyle = "rgba(20,18,16,0.9)"; ctx.fill();
  ctx.lineWidth = 3; ctx.strokeStyle = hexToRgba(accent, 0.95); ctx.stroke();
  const name = safe(input.cardName).toUpperCase();
  drawPixelText(ctx, name, bx + 16, by + 22, "#ffffff",
    fitText(ctx, name, bw - 150, 15, 9, PIXEL_FONT_FAMILY));
  const rarity = safe(input.rarityLabel).toUpperCase();
  drawPixelText(ctx, rarity, bx + bw - 14, by + 24, hexToRgba(accent, 1),
    fitText(ctx, rarity, 120, 12, 8, PIXEL_FONT_FAMILY), "right");
  const hbx = bx + 52, hby = by + 52, hbw = bw - 68, hbh = 16;
  drawPixelText(ctx, "HP", bx + 16, hby + 3, "#ffcf3f", 13);
  roundRectPath(ctx, hbx, hby, hbw, hbh, 7); ctx.fillStyle = "#2b2b2b"; ctx.fill();
  ctx.save(); roundRectPath(ctx, hbx + 2, hby + 2, hbw - 4, hbh - 4, 5); ctx.clip();
  ctx.fillStyle = "#4caf50"; ctx.fillRect(hbx + 2, hby + 2, hbw - 4, hbh - 4); ctx.restore();
  // The trainer's pokéball tray, bottom-left.
  drawPokeballTray(ctx, 18, 360, 220, 34, 6);
  ctx.restore();

  // Menu box (bottom-right) listing the shuffled joke options, then the wide
  // dialogue box (bottom) — both fade up after the combatants are in.
  const uiAlpha = clamp01((t - 0.62) / 0.3);
  if (uiAlpha > 0) {
    ctx.save();
    ctx.globalAlpha = uiAlpha;
    // Joke menu box (the asset carries its own ▶ cursor beside the first option).
    const mx = 548, my = 262, mw = 354, mh = 148;
    if (menubox) ctx.drawImage(menubox, mx, my, mw, mh);
    else { roundRectPath(ctx, mx, my, mw, mh, 12); ctx.fillStyle = "rgba(240,238,230,0.96)"; ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = "#2b2b33"; ctx.stroke(); }
    const opts = ((input.menuLabels && input.menuLabels.length ? input.menuLabels : ["ENGAGE", "THROW CARD", "CARD INFO", "RUN"])).slice(0, 4);
    const lineH = 28, tx = mx + 18, ty0 = my + 18;
    opts.forEach((label, k) => {
      const line = `${k + 1}. ${label.toUpperCase()}`;
      drawPixelText(ctx, line, tx, ty0 + k * lineH, "#2b2b33",
        fitText(ctx, line, mw - 36, 13, 8, PIXEL_FONT_FAMILY));
    });

    // Wide dialogue box.
    const dx = 16, dw = width - 32, dh = 72, dy = height - dh - 8;
    if (textbox) ctx.drawImage(textbox, dx, dy, dw, dh);
    else { roundRectPath(ctx, dx, dy, dw, dh, 12); ctx.fillStyle = "rgba(245,242,235,0.96)"; ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = "#2b2b33"; ctx.stroke(); }
    const line1 = `A WILD ${name} APPEARED!`;
    drawPixelText(ctx, line1, dx + 24, dy + 16, "#2b2b33",
      fitText(ctx, line1, dw - 48, 15, 9, PIXEL_FONT_FAMILY));
    drawPixelText(ctx, "PREPARE FOR BATTLE!", dx + 24, dy + 42, "#7a4a2a", 12);
    ctx.restore();
  }
}

export async function renderWildEncounterIntro(
  input: WildEncounterInput, speed: AnimationSpeed = "normal",
): Promise<Buffer | null> {
  const { width, height } = ENCOUNTER_CANVAS;
  const result = await encodeAnimation({
    // Slower + a touch longer than the game intros so the entrance lands.
    width, height, speed, durationMs: 3400, maxFrames: 30, quality: 18, renderScale: 0.5,
    render: async ({ ctx, mod, t }) => { await paint(ctx as unknown as Ctx, mod, input, t); },
  });
  return result?.buffer ?? null;
}

export async function renderWildEncounterStill(input: WildEncounterInput): Promise<Buffer | null> {
  return queueRender("wild-encounter-still", async () => {
    const mod = await getCanvas();
    if (!mod) return null;
    try {
      const { width, height } = ENCOUNTER_CANVAS;
      const canvas = mod.createCanvas(width, height);
      const ctx = canvas.getContext("2d") as unknown as Ctx;
      await paint(ctx, mod, input, 1);
      return await canvas.encode("png");
    } catch (err) {
      logger.debug({ err }, "wild-encounter still: render failed");
      return null;
    }
  });
}
