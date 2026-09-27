// Numbered search-results canvas for the Vault trade calculator.
// Clean grid: # · image · name · gem price — pick via Discord select (multi).

import {
  getCanvas, hexToRgba, roundRectPath, type Ctx, type CanvasMod,
} from "../animations/engine.js";
import { loadArt, fitText, drawTextWithShadow } from "../animations/effects.js";
import { queueRender } from "../animations/render-queue.js";
import { logger } from "../../lib/logger.js";

/** Minimal item shape so this module stays free of mttvalues circular imports. */
export type CalcResultItem = {
  name: string;
  image: string | null;
  rarity: string[];
  valueMin: number | null;
  valueMax: number | null;
};

function formatGem(item: CalcResultItem): string {
  const min = item.valueMin;
  const max = item.valueMax;
  if (min == null && max == null) return "—";
  if (min != null && max != null && min !== max) {
    return `${min.toLocaleString()}–${max.toLocaleString()}`;
  }
  return (max ?? min ?? 0).toLocaleString();
}

export const CALC_RESULTS_FILE = "calc-results.png";
const W = 900;
const H = 520;
const COLS = 5;
const PAD = 16;
const GAP = 12;

export async function renderCalcResultsCanvas(items: CalcResultItem[]): Promise<Buffer | null> {
  const slice = items.slice(0, 10);
  if (!slice.length) return null;

  return queueRender("calc-results", async () => {
    const mod = await getCanvas();
    if (!mod) return null;
    try {
      const canvas = mod.createCanvas(W, H);
      const ctx = canvas.getContext("2d") as unknown as Ctx;

      const bg = ctx.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, "#0f172a");
      bg.addColorStop(1, "#1e293b");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      ctx.fillStyle = "rgba(148,163,184,0.12)";
      roundRectPath(ctx, 8, 8, W - 16, H - 16, 12);
      ctx.fill();

      drawTextWithShadow(ctx, "Search results — pick one or more below", 28, 36, "#e2e8f0", 20, "left");
      drawTextWithShadow(
        ctx,
        `${slice.length} match${slice.length === 1 ? "" : "es"}`,
        W - 28,
        36,
        "#94a3b8",
        16,
        "right",
      );

      const rows = Math.ceil(slice.length / COLS);
      const gridTop = 56;
      const gridH = H - gridTop - PAD;
      const cellW = (W - PAD * 2 - GAP * (COLS - 1)) / COLS;
      const cellH = (gridH - GAP * Math.max(0, rows - 1)) / Math.max(rows, 1);

      for (let i = 0; i < slice.length; i++) {
        const item = slice[i]!;
        const col = i % COLS;
        const row = Math.floor(i / COLS);
        const x = PAD + col * (cellW + GAP);
        const y = gridTop + row * (cellH + GAP);
        await drawResultCard(ctx, mod, item, i + 1, x, y, cellW, cellH);
      }

      return await canvas.encode("png");
    } catch (err) {
      logger.debug({ err }, "calc-results canvas failed");
      return null;
    }
  });
}

async function drawResultCard(
  ctx: Ctx,
  mod: CanvasMod,
  item: CalcResultItem,
  num: number,
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<void> {
  ctx.fillStyle = "rgba(15,23,42,0.92)";
  roundRectPath(ctx, x, y, w, h, 10);
  ctx.fill();
  ctx.strokeStyle = "rgba(148,163,184,0.35)";
  ctx.lineWidth = 1.5;
  roundRectPath(ctx, x, y, w, h, 10);
  ctx.stroke();

  const badge = 28;
  ctx.fillStyle = "#38bdf8";
  roundRectPath(ctx, x + 8, y + 8, badge, badge, 6);
  ctx.fill();
  drawTextWithShadow(ctx, String(num), x + 8 + badge / 2, y + 8 + badge / 2 + 1, "#0f172a", 15, "center");

  const imgTop = y + 44;
  const imgSize = Math.min(w - 24, h - 110);
  const imgX = x + (w - imgSize) / 2;
  const art = await loadArt(mod, item.image);
  if (art) {
    ctx.save();
    roundRectPath(ctx, imgX, imgTop, imgSize, imgSize, 8);
    ctx.clip();
    const s = Math.max(imgSize / art.width, imgSize / art.height);
    const dw = art.width * s;
    const dh = art.height * s;
    ctx.drawImage(art, imgX + (imgSize - dw) / 2, imgTop + (imgSize - dh) / 2, dw, dh);
    ctx.restore();
  } else {
    ctx.fillStyle = "rgba(51,65,85,0.9)";
    roundRectPath(ctx, imgX, imgTop, imgSize, imgSize, 8);
    ctx.fill();
    drawTextWithShadow(ctx, "?", imgX + imgSize / 2, imgTop + imgSize / 2, "#64748b", 28, "center");
  }

  const nameY = imgTop + imgSize + 18;
  let name = item.name;
  const namePx = fitText(ctx, name, w - 16, 13, 10);
  while (ctx.measureText(name).width > w - 16 && name.length > 4) {
    name = name.slice(0, -2) + "…";
  }
  drawTextWithShadow(ctx, name, x + w / 2, nameY, "#f1f5f9", namePx, "center");

  drawTextWithShadow(ctx, `💎 ${formatGem(item)}`, x + w / 2, nameY + 18, "#7dd3fc", 12, "center");

  const rarity = (item.rarity[0] ?? "").slice(0, 16);
  if (rarity) {
    drawTextWithShadow(ctx, rarity, x + w / 2, nameY + 34, hexToRgba(0x94a3b8, 1), 11, "center");
  }
}
