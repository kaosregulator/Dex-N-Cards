/**
 * Art hall wall canvas — piece hung under a spotlight.
 * Never crops the artist's photo: letterbox (contain) inside the frame.
 * Landscape / portrait / square pick different wall proportions & décor.
 */

import {
  encodeAnimation, getCanvas, hexToRgba, roundRectPath, clamp01, easeOutBack,
  TITLE_FONT_FAMILY, type Ctx, type CanvasMod,
} from "../animations/engine.js";
import { loadArt } from "../animations/effects.js";
import { logger } from "../../lib/logger.js";

export type HallRenderOpts = {
  title: string;
  artistName: string;
  description?: string | null;
  imageUrl: string;
  orientation: "landscape" | "portrait" | "square";
  votes?: number;
  weekLabel?: string | null;
  animated?: boolean;
};

function dimsFor(orientation: HallRenderOpts["orientation"]): { W: number; H: number } {
  if (orientation === "portrait") return { W: 560, H: 720 };
  if (orientation === "square") return { W: 640, H: 640 };
  return { W: 800, H: 480 };
}

/** Draw image fully visible (contain) centered in rect — never crop. */
function drawContain(
  ctx: Ctx,
  img: { width: number; height: number },
  x: number, y: number, w: number, h: number,
): void {
  const scale = Math.min(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;
  // Soft mat behind the photo
  ctx.fillStyle = "#1a1510";
  ctx.fillRect(x, y, w, h);
  ctx.drawImage(img as CanvasImageSource, dx, dy, dw, dh);
}

type CanvasImageSource = Parameters<Ctx["drawImage"]>[0];

function drawWall(ctx: Ctx, W: number, H: number, orientation: string, t: number): void {
  // Warm gallery plaster
  const g = ctx.createLinearGradient(0, 0, W, H);
  if (orientation === "portrait") {
    g.addColorStop(0, "#2a221c");
    g.addColorStop(0.45, "#3d3128");
    g.addColorStop(1, "#1c1612");
  } else if (orientation === "square") {
    g.addColorStop(0, "#243028");
    g.addColorStop(0.5, "#2f3d34");
    g.addColorStop(1, "#1a221c");
  } else {
    g.addColorStop(0, "#2c2430");
    g.addColorStop(0.4, "#3a2e38");
    g.addColorStop(1, "#1a141c");
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // Subtle wall texture lines
  ctx.strokeStyle = "rgba(255,255,255,0.03)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 14; i++) {
    const y = (H / 14) * i + Math.sin(t * Math.PI * 2 + i) * 1.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  // Floor strip
  const floorY = H * 0.88;
  const floor = ctx.createLinearGradient(0, floorY, 0, H);
  floor.addColorStop(0, "rgba(20,14,10,0.55)");
  floor.addColorStop(1, "rgba(8,6,5,0.95)");
  ctx.fillStyle = floor;
  ctx.fillRect(0, floorY, W, H - floorY);
}

function drawSpotlight(
  ctx: Ctx, cx: number, top: number, spread: number, t: number,
): void {
  const pulse = 0.85 + 0.15 * Math.sin(t * Math.PI * 2);
  // Fixture
  ctx.fillStyle = "#c9b896";
  roundRectPath(ctx, cx - 18, top - 8, 36, 14, 4);
  ctx.fill();
  ctx.fillStyle = "#8a7a5a";
  ctx.fillRect(cx - 3, top + 4, 6, 10);

  // Cone
  const grad = ctx.createRadialGradient(cx, top + 20, 4, cx, top + spread * 0.55, spread * 0.7);
  grad.addColorStop(0, `rgba(255, 236, 190, ${0.35 * pulse})`);
  grad.addColorStop(0.45, `rgba(255, 220, 150, ${0.12 * pulse})`);
  grad.addColorStop(1, "rgba(255,200,120,0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(cx - 22, top + 14);
  ctx.lineTo(cx + 22, top + 14);
  ctx.lineTo(cx + spread * 0.55, top + spread);
  ctx.lineTo(cx - spread * 0.55, top + spread);
  ctx.closePath();
  ctx.fill();
}

function drawFrame(ctx: Ctx, x: number, y: number, w: number, h: number, _accent: string): void {
  // Soft drop shadow (Apple-clean depth)
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  roundRectPath(ctx, x - 12, y - 10, w + 28, h + 30, 8);
  ctx.fill();

  // Dark wood + antique gold lip
  ctx.fillStyle = "#3a2a18";
  roundRectPath(ctx, x - 14, y - 14, w + 28, h + 28, 6);
  ctx.fill();

  const gold = ctx.createLinearGradient(x - 14, y, x + w + 14, y + h);
  gold.addColorStop(0, "#e8d48b");
  gold.addColorStop(0.4, "#c5a059");
  gold.addColorStop(1, "#f0e2b0");
  ctx.strokeStyle = gold as unknown as string;
  ctx.lineWidth = 4;
  roundRectPath(ctx, x - 12, y - 12, w + 26, h + 26, 5);
  ctx.stroke();

  ctx.fillStyle = "#1c1612";
  roundRectPath(ctx, x - 5, y - 5, w + 12, h + 12, 3);
  ctx.fill();

  ctx.strokeStyle = "rgba(255,230,160,0.55)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x - 1, y - 1, w + 2, h + 2);
}

async function paintHall(
  ctx: Ctx,
  mod: CanvasMod,
  opts: HallRenderOpts,
  W: number,
  H: number,
  t: number,
): Promise<void> {
  drawWall(ctx, W, H, opts.orientation, t);

  const margin = opts.orientation === "portrait" ? 48 : 56;
  const plaqueH = 72;
  const frameTop = opts.orientation === "portrait" ? 56 : 48;
  const frameH = H - frameTop - plaqueH - 36;
  const frameW = W - margin * 2;
  const frameX = margin;
  const frameY = frameTop + 18;

  drawSpotlight(ctx, W / 2, 18, frameH * 0.9, t);

  const pop = easeOutBack(clamp01(t * 1.35));
  ctx.save();
  ctx.globalAlpha = clamp01(0.4 + pop * 0.6);
  drawFrame(ctx, frameX, frameY, frameW, frameH, "#e8c872");

  const img = await loadArt(mod, opts.imageUrl);
  if (img) {
    drawContain(ctx, img, frameX, frameY, frameW, frameH);
  } else {
    ctx.fillStyle = "#1a1510";
    ctx.fillRect(frameX, frameY, frameW, frameH);
    ctx.fillStyle = "#c9b896";
    ctx.font = `600 22px ${TITLE_FONT_FAMILY}, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("Artwork loading…", W / 2, frameY + frameH / 2);
  }
  ctx.restore();

  // Plaque
  const px = margin;
  const py = H - plaqueH - 16;
  roundRectPath(ctx, px, py, W - margin * 2, plaqueH, 8);
  ctx.fillStyle = "rgba(18, 14, 12, 0.88)";
  ctx.fill();
  ctx.strokeStyle = "rgba(212, 175, 55, 0.55)";
  ctx.lineWidth = 1.5;
  roundRectPath(ctx, px, py, W - margin * 2, plaqueH, 8);
  ctx.stroke();

  ctx.fillStyle = "#f5e6c8";
  ctx.font = `700 20px ${TITLE_FONT_FAMILY}, sans-serif`;
  ctx.textAlign = "left";
  const title = opts.title.length > 42 ? `${opts.title.slice(0, 40)}…` : opts.title;
  ctx.fillText(title, px + 16, py + 28);

  ctx.fillStyle = "#c4b49a";
  ctx.font = "500 14px sans-serif";
  ctx.fillText(`by ${opts.artistName}`, px + 16, py + 50);

  if (typeof opts.votes === "number") {
    ctx.textAlign = "right";
    ctx.fillStyle = "#ffe08a";
    ctx.font = `700 16px ${TITLE_FONT_FAMILY}, sans-serif`;
    ctx.fillText(`▲ ${opts.votes}`, W - margin - 16, py + 30);
    if (opts.weekLabel) {
      ctx.fillStyle = "#9a8b74";
      ctx.font = "12px sans-serif";
      ctx.fillText(opts.weekLabel, W - margin - 16, py + 50);
    }
  }
}

export async function renderArtHallGif(opts: HallRenderOpts): Promise<Buffer | null> {
  const { W, H } = dimsFor(opts.orientation);
  try {
    if (opts.animated === false) {
      const mod = await getCanvas();
      if (!mod) return null;
      const canvas = mod.createCanvas(W, H);
      const ctx = canvas.getContext("2d") as Ctx;
      await paintHall(ctx, mod, opts, W, H, 0.55);
      return Buffer.from(await canvas.encode("png"));
    }
    const result = await encodeAnimation({
      width: W,
      height: H,
      speed: "normal",
      durationMs: 2000,
      maxFrames: 14,
      quality: 12,
      render: async ({ ctx, t, mod }) => {
        await paintHall(ctx, mod, opts, W, H, t);
      },
    });
    return result?.buffer ?? null;
  } catch (err) {
    logger.debug({ err }, "artshow hall render failed");
    return null;
  }
}

export async function renderArtHallPng(opts: HallRenderOpts): Promise<Buffer | null> {
  return renderArtHallGif({ ...opts, animated: false });
}

/** Infer orientation from image pixel size (defaults landscape). */
export async function detectOrientation(imageUrl: string): Promise<"landscape" | "portrait" | "square"> {
  try {
    const mod = await getCanvas();
    if (!mod) return "landscape";
    const img = await loadArt(mod, imageUrl);
    if (!img || !img.width || !img.height) return "landscape";
    const ratio = img.width / img.height;
    if (ratio > 1.12) return "landscape";
    if (ratio < 0.88) return "portrait";
    return "square";
  } catch {
    return "landscape";
  }
}
