// ─────────────────────────────────────────────────────────────────────────────
// Battle Prep canvases — the visual half of the new prep phase.
//
//   • renderPrepBoard   — a private "peep" board of your top-leveled cards, each
//                         with Star Rank, level and current battle stats, so you
//                         pick by sight instead of paging a dropdown.
//   • renderCardConfirm — the private confirm screen: your chosen card, big, with
//                         its full current stats, signature move, special and the
//                         equipped item, shown before you lock in.
//   • renderCoinFlip    — a short animated coin toss (GIF) that lands on the real
//                         result, played in the shared intro before combat.
//
// All three take pre-computed data (stats are resolved by the caller via the
// existing stat engine) so this module does no DB work and renders offline.
// Stars, emoji, and custom emoji are drawn with the shared canvas font stack.
// ─────────────────────────────────────────────────────────────────────────────

import {
  getCanvas, hexToRgba, roundRectPath, drawGradientBackground, encodeAnimation,
  clamp01, type Ctx,
} from "../animations/engine.js";

// Decelerating ease so the coin spins fast then settles (engine only ships
// easeInOutCubic / easeOutBack; this is the plain cubic-out we want here).
function easeOutCubic(x: number): number { return 1 - Math.pow(1 - x, 3); }
import type { AnimationResult } from "../animations/types.js";
import {
  drawCardArt, drawCardFrame, drawRarityGlow, drawRarityBadge, drawTextWithShadow,
  drawTitle, fitText, getRarityEffectColor, TITLE_FONT,
} from "../animations/effects.js";
import { queueRender } from "../animations/render-queue.js";
import { toAbsoluteImageUrl } from "../image-url.js";
import type { Rarity } from "../cards-data.js";
import { logger } from "../../lib/logger.js";
import { warmCanvasText } from "../unbelievaboat/canvas-emoji-text.js";

const BOARD_CANVAS = { width: 1000, height: 560 } as const;
const CONFIRM_CANVAS = { width: 900, height: 520 } as const;
const COIN_CANVAS = { width: 460, height: 460 } as const;

export interface PrepCardStat {
  cardId: number;
  name: string;
  rarity: string;
  rarityLabel: string;
  rarityColor: number | null;
  imageUrl: string | null;
  level: number;
  star: number;
  maxLevel: number;
  hp: number;
  atk: number;
  def: number;
  spd: number;
}

function starText(star: number): string {
  const s = Math.max(0, Math.min(5, star));
  return "★".repeat(s) + "☆".repeat(5 - s);
}

// ── Top-leveled board ────────────────────────────────────────────────────────
export async function renderPrepBoard(
  ownerName: string, cards: PrepCardStat[], selectedId: number | null,
): Promise<Buffer | null> {
  return queueRender("battle-prep-board", async () => {
    const mod = await getCanvas();
    if (!mod) return null;
    try {
      await warmCanvasText(mod, [ownerName, ...cards.flatMap(c => [c.name, c.rarityLabel])]);
      const { width, height } = BOARD_CANVAS;
      const canvas = mod.createCanvas(width, height);
      const ctx = canvas.getContext("2d") as unknown as Ctx;
      const accent = 0xed4245;

      drawGradientBackground(ctx, width, height, [
        [0, hexToRgba(accent, 0.28)],
        [0.55, "#0d0f16"],
        [1, "#070810"],
      ], 0.3);

      drawTitle(ctx, "CHOOSE YOUR FIGHTER", width / 2, 46, "#ffffff", 34);
      drawTextWithShadow(ctx, `${ownerName} · your strongest cards`, width / 2, 80, "#c9ccd8", 17);

      const shown = cards.slice(0, 5);
      const cw = 158, ch = 210, gap = 20;
      const totalW = shown.length * cw + Math.max(0, shown.length - 1) * gap;
      const startX = (width - totalW) / 2;
      const y = 116;

      for (let i = 0; i < shown.length; i++) {
        const c = shown[i]!;
        const x = startX + i * (cw + gap);
        const color = c.rarityColor ?? getRarityEffectColor(c.rarity as Rarity);
        const picked = c.cardId === selectedId;

        drawRarityGlow(ctx, x, y, cw, ch, picked ? 0xffd54a : color, picked ? 0.85 : 0.5);
        await drawCardArt(ctx, mod, x, y, cw, ch, toAbsoluteImageUrl(c.imageUrl), c.rarity as Rarity);
        drawCardFrame(ctx, x, y, cw, ch, picked ? 0xffd54a : color, picked ? 6 : 5, c.rarity as Rarity);
        drawRarityBadge(ctx, x + cw - 10, y + 10, c.rarityLabel, color);
        drawTextWithShadow(ctx, `#${i + 1}`, x + 15, y + 18, "#ffffff", 15);
        if (picked) drawTextWithShadow(ctx, "PICKED", x + cw / 2, y + ch - 16, "#ffd54a", 16);

        // Name + star + level under the art.
        const labelY = y + ch + 22;
        drawTextWithShadow(ctx, c.name, x + cw / 2, labelY, "#ffffff", fitText(ctx, c.name, cw + 18, 15, 11, TITLE_FONT));
        drawTextWithShadow(ctx, `${starText(c.star)}  Lv ${c.level}`, x + cw / 2, labelY + 20, "#ffd54a", 14);

        // Compact current-stat chips (HP / ATK / DEF / SPD).
        const chipY = labelY + 38;
        drawStatStrip(ctx, x, chipY, cw, c);
      }

      if (shown.length === 0) {
        drawTextWithShadow(ctx, "No battle-eligible cards yet — catch and level some first!", width / 2, height / 2, "#c9ccd8", 20);
      }

      return Buffer.from(await canvas.encode("png"));
    } catch (err) {
      logger.debug({ err }, "renderPrepBoard failed");
      return null;
    }
  });
}

function drawStatStrip(ctx: Ctx, x: number, y: number, w: number, c: PrepCardStat): void {
  const stats: [string, number, number][] = [
    ["HP", c.hp, 0x2ecc71],
    ["ATK", c.atk, 0xe67e22],
    ["DEF", c.def, 0x3498db],
    ["SPD", c.spd, 0x9b59b6],
  ];
  const chipH = 16, chipGap = 4;
  const chipW = (w - chipGap) / 2;
  for (let i = 0; i < stats.length; i++) {
    const [label, val, col] = stats[i]!;
    const cxp = x + (i % 2) * (chipW + chipGap);
    const cyp = y + Math.floor(i / 2) * (chipH + chipGap);
    ctx.save();
    ctx.fillStyle = hexToRgba(col, 0.16);
    roundRectPath(ctx, cxp, cyp, chipW, chipH, 5);
    ctx.fill();
    ctx.restore();
    drawTextWithShadow(ctx, `${label} ${val}`, cxp + chipW / 2, cyp + chipH / 2 + 1, "#e8ecf4", 11);
  }
}

// ── Private confirm preview ──────────────────────────────────────────────────
export async function renderCardConfirm(
  card: PrepCardStat,
  move: { name: string; emoji: string; description: string } | null,
  special: { name: string; emoji: string; description: string } | null,
  itemName: string | null,
  coin: string | null,
): Promise<Buffer | null> {
  return queueRender("battle-prep-confirm", async () => {
    const mod = await getCanvas();
    if (!mod) return null;
    try {
      await warmCanvasText(mod, [
        card.name, card.rarityLabel, move?.name, move?.emoji, special?.name, special?.emoji, itemName,
      ]);
      const { width, height } = CONFIRM_CANVAS;
      const canvas = mod.createCanvas(width, height);
      const ctx = canvas.getContext("2d") as unknown as Ctx;
      const color = card.rarityColor ?? getRarityEffectColor(card.rarity as Rarity);

      drawGradientBackground(ctx, width, height, [
        [0, hexToRgba(color, 0.32)],
        [0.55, "#0d0f16"],
        [1, "#070810"],
      ], 0.3);

      // Big card art on the left.
      const cw = 240, chh = 320, cx = 54, cy = 100;
      drawRarityGlow(ctx, cx, cy, cw, chh, color, 0.7);
      await drawCardArt(ctx, mod, cx, cy, cw, chh, toAbsoluteImageUrl(card.imageUrl), card.rarity as Rarity);
      drawCardFrame(ctx, cx, cy, cw, chh, color, 6, card.rarity as Rarity);
      drawRarityBadge(ctx, cx + cw - 10, cy + 12, card.rarityLabel, color);

      drawTitle(ctx, "READY TO FIGHT?", 54, 46, "#ffffff", 30, "left");
      drawTextWithShadow(ctx, "Confirm your fighter below", 54, 78, "#c9ccd8", 15, "left");

      // Right column: name, star/level, stat grid, move, special, item.
      const rx = cx + cw + 46;
      let ry = cy + 6;
      drawTextWithShadow(ctx, card.name, rx, ry, "#ffffff", fitText(ctx, card.name, width - rx - 40, 30, 18, TITLE_FONT), "left");
      ry += 30;
      drawTextWithShadow(ctx, `${starText(card.star)}   Lv ${card.level}/${card.maxLevel}`, rx, ry, "#ffd54a", 17, "left");
      ry += 30;

      const grid: [string, number, number][] = [
        ["HEALTH", card.hp, 0x2ecc71],
        ["ATTACK", card.atk, 0xe67e22],
        ["DEFENSE", card.def, 0x3498db],
        ["SPEED", card.spd, 0x9b59b6],
      ];
      const gW = (width - rx - 40 - 12) / 2, gH = 46;
      for (let i = 0; i < grid.length; i++) {
        const [label, val, col] = grid[i]!;
        const gx = rx + (i % 2) * (gW + 12);
        const gy = ry + Math.floor(i / 2) * (gH + 10);
        ctx.save();
        ctx.fillStyle = hexToRgba(col, 0.16);
        roundRectPath(ctx, gx, gy, gW, gH, 9);
        ctx.fill();
        ctx.strokeStyle = hexToRgba(col, 0.5); ctx.lineWidth = 1;
        roundRectPath(ctx, gx, gy, gW, gH, 9); ctx.stroke();
        ctx.restore();
        drawTextWithShadow(ctx, label, gx + 12, gy + 15, "#aeb6c6", 11, "left");
        drawTextWithShadow(ctx, String(val), gx + 12, gy + 33, "#ffffff", 20, "left");
      }
      ry += 2 * (gH + 10) + 8;

      if (move) {
        drawTextWithShadow(ctx, `Move:  ${move.name}`, rx, ry, "#e8ecf4", 15, "left");
        ry += 24;
      }
      if (special) {
        drawTextWithShadow(ctx, `Special:  ${special.name}`, rx, ry, "#e8ecf4", 15, "left");
        ry += 24;
      }
      const foot = [itemName ? `Item: ${itemName}` : "Item: none", coin ? `Coin: ${coin.toUpperCase()}` : null]
        .filter(Boolean).join("     ");
      drawTextWithShadow(ctx, foot, rx, ry, "#c9ccd8", 14, "left");

      return Buffer.from(await canvas.encode("png"));
    } catch (err) {
      logger.debug({ err }, "renderCardConfirm failed");
      return null;
    }
  });
}

// ── Animated coin flip ───────────────────────────────────────────────────────
export async function renderCoinFlip(result: "heads" | "tails"): Promise<AnimationResult | null> {
  const { width, height } = COIN_CANVAS;
  const cx = width / 2, cy = height / 2 + 6;
  const R = 96;
  const HALF_TURNS = 8; // even → lands showing the front face

  return encodeAnimation({
    width, height,
    speed: "normal",
    durationMs: 1400,
    maxFrames: 26,
    quality: 16,
    renderScale: 0.85,
    render: (frame) => {
      const { ctx, t } = frame;
      drawGradientBackground(ctx, width, height, [
        [0, "#1a1024"],
        [0.6, "#0d0f16"],
        [1, "#070810"],
      ], 0.3);
      drawTitle(ctx, "COIN TOSS", cx, 42, "#ffffff", 26);

      const eased = easeOutCubic(clamp01(t));
      const angle = eased * Math.PI * HALF_TURNS;
      const cosang = Math.cos(angle);
      const scaleX = Math.max(0.05, Math.abs(cosang));
      const frontShowing = cosang >= 0;
      // Front face carries the real result; back face is the other side.
      const face = frontShowing ? result : (result === "heads" ? "tails" : "heads");
      const faceGold = frontShowing ? [0xf6d365, 0xc9971e] : [0xe7b84a, 0xa9800f];

      // Squash horizontally via ctx.transform (declared on Ctx; multiplies onto
      // the engine's renderScale matrix, unlike setTransform). arc() then draws a
      // circle that comes out as the flattened coin.
      const sx = Math.max(0.02, scaleX);
      const disc = (radius: number, yOff: number, style: string, stroke: boolean) => {
        ctx.save();
        ctx.transform(sx, 0, 0, 1, cx, cy + yOff);
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        if (stroke) { ctx.strokeStyle = style; ctx.lineWidth = 3 / sx; ctx.stroke(); }
        else { ctx.fillStyle = style; ctx.fill(); }
        ctx.restore();
      };
      disc(R + 4, 6, "#8a6a10", false);                       // coin edge / thickness
      disc(R, 0, hexToRgba(faceGold[1]!, 1), false);          // face base
      disc(R - 6, 0, hexToRgba(faceGold[0]!, 1), false);      // lighter sheen
      disc(R - 10, 0, hexToRgba(0xffef9e, 0.7), true);        // inner ring

      // Face label only when the coin is flat enough to read.
      if (scaleX > 0.4) {
        ctx.save();
        ctx.globalAlpha = Math.min(1, (scaleX - 0.4) / 0.4);
        drawTextWithShadow(ctx, face === "heads" ? "H" : "T", cx, cy + 2, "#5a3d05", Math.round(R * 1.0));
        ctx.restore();
      }

      // Result banner once it settles.
      if (t > 0.9) {
        ctx.save();
        ctx.globalAlpha = Math.min(1, (t - 0.9) / 0.1);
        drawTitle(ctx, result.toUpperCase(), cx, height - 34, "#ffd54a", 30);
        ctx.restore();
      }
    },
  });
}
