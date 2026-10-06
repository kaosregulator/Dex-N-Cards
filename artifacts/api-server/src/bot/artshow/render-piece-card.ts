/**
 * Clean Art Show piece card — warm gold board like the champion announce,
 * big title, photos letterboxed (never cropped) in a tidy grid for any shape.
 */

import {
  getCanvas, roundRectPath, TITLE_FONT_FAMILY, type Ctx,
} from "../animations/engine.js";
import { loadArt } from "../animations/effects.js";
import { logger } from "../../lib/logger.js";

export type PieceCardOpts = {
  title: string;
  artistName: string;
  description?: string | null;
  /** Absolute / loadable image URLs (1–10) */
  imageUrls: string[];
  votes?: number;
};

type Img = { width: number; height: number };

function gridFor(n: number): { cols: number; rows: number } {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n === 3) return { cols: 3, rows: 1 };
  if (n === 4) return { cols: 2, rows: 2 };
  if (n <= 6) return { cols: 3, rows: 2 };
  if (n <= 9) return { cols: 3, rows: 3 };
  return { cols: 5, rows: 2 };
}

/** Contain (letterbox) — never crop. Soft mat fills unused space. */
function drawContain(
  ctx: Ctx,
  img: Img,
  x: number, y: number, w: number, h: number,
): void {
  ctx.fillStyle = "#1c1712";
  roundRectPath(ctx, x, y, w, h, 10);
  ctx.fill();

  const pad = 8;
  const iw = w - pad * 2;
  const ih = h - pad * 2;
  const scale = Math.min(iw / img.width, ih / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;

  ctx.save();
  roundRectPath(ctx, x + 2, y + 2, w - 4, h - 4, 8);
  ctx.clip();
  ctx.drawImage(img as CanvasImageSource, dx, dy, dw, dh);
  ctx.restore();

  ctx.strokeStyle = "rgba(212, 175, 55, 0.45)";
  ctx.lineWidth = 1.5;
  roundRectPath(ctx, x + 1, y + 1, w - 2, h - 2, 10);
  ctx.stroke();
}

type CanvasImageSource = Parameters<Ctx["drawImage"]>[0];

function paintBackground(ctx: Ctx, W: number, H: number): void {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#2e261c");
  g.addColorStop(0.45, "#231c16");
  g.addColorStop(1, "#16110e");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // Soft vignette
  const v = ctx.createRadialGradient(W / 2, H * 0.35, W * 0.1, W / 2, H * 0.5, W * 0.75);
  v.addColorStop(0, "rgba(255, 220, 140, 0.06)");
  v.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);

  // Gold accent bar (champion-card vibe)
  const bar = ctx.createLinearGradient(0, 0, 0, H);
  bar.addColorStop(0, "#f0d078");
  bar.addColorStop(0.5, "#c4a574");
  bar.addColorStop(1, "#8a7040");
  ctx.fillStyle = bar;
  ctx.fillRect(0, 0, 8, H);
}

function paintTitle(
  ctx: Ctx,
  opts: PieceCardOpts,
  W: number,
  titleY: number,
): number {
  const title = opts.title.length > 48 ? `${opts.title.slice(0, 46)}…` : opts.title;
  ctx.textAlign = "left";
  ctx.fillStyle = "#f5e6c8";
  ctx.font = `800 36px ${TITLE_FONT_FAMILY}, sans-serif`;
  ctx.fillText(title, 28, titleY);

  ctx.fillStyle = "#c4b49a";
  ctx.font = "500 16px sans-serif";
  ctx.fillText(`by ${opts.artistName}`, 28, titleY + 28);

  if (typeof opts.votes === "number") {
    ctx.textAlign = "right";
    ctx.fillStyle = "#ffe08a";
    ctx.font = `700 22px ${TITLE_FONT_FAMILY}, sans-serif`;
    ctx.fillText(`▲ ${opts.votes}`, W - 24, titleY + 4);
  }

  return titleY + 48;
}

export async function renderPieceCardPng(opts: PieceCardOpts): Promise<Buffer | null> {
  const urls = opts.imageUrls.filter(Boolean).slice(0, 10);
  if (!urls.length) return null;

  try {
    const mod = await getCanvas();
    if (!mod) return null;

    const loaded: Img[] = [];
    for (const url of urls) {
      const img = await loadArt(mod, url);
      if (img && img.width && img.height) loaded.push(img);
    }
    if (!loaded.length) return null;

    const n = loaded.length;
    const { cols, rows } = gridFor(n);
    const W = n === 1 ? 840 : 960;
    const headerH = 96;
    const margin = 24;
    const gap = 14;
    const cellW = (W - margin * 2 - gap * (cols - 1)) / cols;

    // Cell height from average aspect, clamped so portraits/landscapes both fit cleanly.
    let cellH: number;
    if (n === 1) {
      const img = loaded[0]!;
      const ratio = img.width / img.height;
      if (ratio > 1.15) cellH = Math.min(520, cellW / ratio + 40);
      else if (ratio < 0.85) cellH = Math.min(640, cellW / ratio);
      else cellH = cellW;
      cellH = Math.max(320, Math.min(640, cellH));
    } else {
      cellH = Math.min(280, cellW * 0.95);
      cellH = Math.max(180, cellH);
    }

    const gridH = rows * cellH + (rows - 1) * gap;
    const H = headerH + gridH + margin + 20;

    const canvas = mod.createCanvas(W, Math.ceil(H));
    const ctx = canvas.getContext("2d") as Ctx;
    paintBackground(ctx, W, H);
    paintTitle(ctx, opts, W, 48);

    const gridTop = headerH;
    for (let i = 0; i < n; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      // Center leftover cells on the last row
      const cellsInRow = row === rows - 1 ? n - row * cols : cols;
      const rowOffset = ((cols - cellsInRow) * (cellW + gap)) / 2;
      const x = margin + rowOffset + col * (cellW + gap);
      const y = gridTop + row * (cellH + gap);
      drawContain(ctx, loaded[i]!, x, y, cellW, cellH);
    }

    if (n > 1) {
      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(196, 180, 154, 0.85)";
      ctx.font = "500 13px sans-serif";
      ctx.fillText(`${n} photos`, W - 24, H - 12);
    }

    return Buffer.from(await canvas.encode("png"));
  } catch (err) {
    logger.debug({ err }, "artshow piece card render failed");
    return null;
  }
}
