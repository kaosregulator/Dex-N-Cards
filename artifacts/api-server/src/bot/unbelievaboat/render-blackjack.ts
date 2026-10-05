/**
 * Blackjack felt animations — shuffle intro, one-shot poker flips, then still.
 * Discord GIFs loop forever, so callers play the GIF once (await durationMs)
 * then swap the attachment to the PNG still so cards never re-flip.
 */

import {
  encodeAnimation, getCanvas, clamp01, lerp, easeInOutCubic, easeOutBack,
  type Ctx,
} from "../animations/engine.js";
import type { AnimationResult } from "../animations/types.js";
import { cardLabel, type Card } from "./cards.js";

export const BJ_W = 560;
export const BJ_H = 340;

function felt(ctx: Ctx, w = BJ_W, h = BJ_H) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#0f4a38");
  g.addColorStop(0.5, "#0a3228");
  g.addColorStop(1, "#06221b");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.fillRect(18, 18, w - 36, h - 36);
  ctx.strokeStyle = "#6b4423";
  ctx.lineWidth = 14;
  ctx.strokeRect(7, 7, w - 14, h - 14);
  ctx.strokeStyle = "#c4a574";
  ctx.lineWidth = 2;
  ctx.strokeRect(14, 14, w - 28, h - 28);
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Poker-style card: flip 0 = edge/back, 1 = face-up settled. */
export function drawCardFace(
  ctx: Ctx,
  x: number,
  y: number,
  label: string,
  faceDown = false,
  flip = 1,
  cardW = 64,
  cardH = 90,
) {
  const scaleX = Math.max(0.04, Math.abs(Math.cos(flip * Math.PI)));
  const showBack = faceDown || flip < 0.5;
  const cx = x + cardW / 2;
  const drawW = cardW * scaleX;
  const left = cx - drawW / 2;

  roundRect(ctx, left, y, drawW, cardH, 6 * scaleX);
  if (showBack) {
    ctx.fillStyle = "#1e3a5f";
    ctx.fill();
    if (drawW > 12) {
      ctx.strokeStyle = "#94a3b8";
      ctx.lineWidth = 2;
      ctx.stroke();
      // diamond back pattern
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 1;
      roundRect(ctx, left + drawW * 0.15, y + cardH * 0.12, drawW * 0.7, cardH * 0.76, 4 * scaleX);
      ctx.stroke();
      if (drawW > 20) {
        ctx.fillStyle = "#60a5fa";
        ctx.font = `bold ${Math.max(8, Math.floor(14 * scaleX))}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("◆", cx, y + cardH / 2);
      }
    }
    return;
  }
  ctx.fillStyle = "#f8fafc";
  ctx.fill();
  if (drawW < 14) return;
  const red = label.includes("♥") || label.includes("♦");
  ctx.fillStyle = red ? "#dc2626" : "#0f172a";
  ctx.font = `bold ${Math.max(10, Math.floor(16 * scaleX))}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, cx, y + cardH / 2);
}

function drawCardBackAt(
  ctx: Ctx,
  x: number, y: number,
  w: number, h: number,
  rot = 0,
) {
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate(rot);
  roundRect(ctx, -w / 2, -h / 2, w, h, 5);
  ctx.fillStyle = "#1e3a5f";
  ctx.fill();
  ctx.strokeStyle = "#94a3b8";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = "#3b82f6";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("◆", 0, 0);
  ctx.restore();
}

function tableLabels(ctx: Ctx) {
  ctx.fillStyle = "rgba(16, 185, 129, 0.12)";
  ctx.beginPath();
  ctx.ellipse(BJ_W / 2, BJ_H / 2 + 10, 220, 110, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ecfdf5";
  ctx.font = "bold 15px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("DEALER", 40, 40);
  ctx.fillText("YOU", 40, 200);
}

export type BjTableOpts = {
  player: Card[];
  dealer: Card[];
  hideDealer: boolean;
  banner?: string;
  revealHole?: boolean;
  animatePlayerFrom?: number;
  animateDealerFrom?: number;
};

/** Map global t through motion window so the tail is a frozen hold. */
function motionT(t: number, motionEnd = 0.72): number {
  return clamp01(t / motionEnd);
}

function drawTableAt(
  ctx: Ctx,
  opts: BjTableOpts,
  tMotion: number,
) {
  felt(ctx);
  tableLabels(ctx);

  const cardW = 64;
  const cardH = 90;
  const gap = 14;
  const animatePlayerFrom = opts.animatePlayerFrom ?? 0;
  const animateDealerFrom = opts.animateDealerFrom ?? 0;
  const dealerY = 52;
  const playerY = 214;
  const dealerStartX = Math.max(40, (BJ_W - (opts.dealer.length * (cardW + gap) - gap)) / 2);
  const playerStartX = Math.max(40, (BJ_W - (opts.player.length * (cardW + gap) - gap)) / 2);

  opts.dealer.forEach((c, i) => {
    const x = dealerStartX + i * (cardW + gap);
    const stayDown = opts.hideDealer && i === 1 && !opts.revealHole;

    if (opts.revealHole && i === 1) {
      // Single poker flip of the hole card
      const flipT = clamp01((tMotion - 0.08) / 0.45);
      const eased = easeOutBack(flipT);
      drawCardFace(ctx, x, dealerY, cardLabel(c), false, eased, cardW, cardH);
      return;
    }

    const shouldAnimate = i >= animateDealerFrom;
    if (!shouldAnimate || stayDown) {
      drawCardFace(ctx, x, dealerY, cardLabel(c), stayDown, stayDown ? 0 : 1, cardW, cardH);
      return;
    }

    const localStart = 0.12 + (i - Math.max(animateDealerFrom, 0)) * 0.16;
    const dealT = clamp01((tMotion - localStart) / 0.42);
    if (dealT <= 0) return;
    const slideY = (1 - easeOutBack(dealT)) * -40;
    const flip = clamp01((dealT - 0.12) / 0.55);
    drawCardFace(ctx, x, dealerY + slideY, cardLabel(c), false, flip, cardW, cardH);
  });

  opts.player.forEach((c, i) => {
    const x = playerStartX + i * (cardW + gap);
    const shouldAnimate = i >= animatePlayerFrom;

    if (!shouldAnimate) {
      drawCardFace(ctx, x, playerY, cardLabel(c), false, 1, cardW, cardH);
      return;
    }

    const localStart = (i - animatePlayerFrom) * 0.14;
    const dealT = clamp01((tMotion - localStart) / 0.45);
    if (dealT <= 0) return;
    const slideY = (1 - easeOutBack(dealT)) * 36;
    const flip = clamp01((dealT - 0.15) / 0.55);
    drawCardFace(ctx, x, playerY + slideY, cardLabel(c), false, flip, cardW, cardH);
  });

  if (opts.banner && tMotion > 0.7) {
    const fade = clamp01((tMotion - 0.7) / 0.2);
    ctx.fillStyle = `rgba(251, 191, 36, ${fade})`;
    ctx.font = "bold 28px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(opts.banner, BJ_W / 2, BJ_H / 2 + 8);
  }
}

/**
 * Deal / hit / reveal GIF — motion then long hold (coalesced) so one play looks
 * like a poker flip; caller should still swap to PNG after durationMs.
 */
export async function renderBlackjackTableGif(opts: BjTableOpts): Promise<AnimationResult | null> {
  const animatePlayerFrom = opts.animatePlayerFrom ?? 0;
  const animateDealerFrom = opts.animateDealerFrom ?? 0;
  const onlyNew =
    animatePlayerFrom > 0
    || animateDealerFrom > 0
    || (!!opts.revealHole && opts.dealer.length <= 2);

  // Longer hold tail so Discord’s loop pause sits on the settled table
  const durationMs = opts.banner ? 2800 : onlyNew ? 1800 : 2400;
  const maxFrames = opts.banner ? 28 : onlyNew ? 20 : 26;

  return encodeAnimation({
    width: BJ_W, height: BJ_H, durationMs, speed: "normal", maxFrames, quality: 14,
    render: async ({ ctx, t }) => {
      drawTableAt(ctx, opts, motionT(t, 0.68));
    },
  });
}

/** Final settled table as PNG — no looping flips. */
export async function renderBlackjackTablePng(opts: BjTableOpts): Promise<Buffer | null> {
  const mod = await getCanvas();
  if (!mod) return null;
  try {
    const canvas = mod.createCanvas(BJ_W, BJ_H);
    const ctx = canvas.getContext("2d") as unknown as Ctx;
    drawTableAt(ctx, opts, 1);
    return await canvas.encode("png");
  } catch {
    return null;
  }
}

/**
 * Casino-grade shuffle intro: side riffle → bridge cascade → overhand → square-up.
 * Plays once; caller awaits duration then moves to the deal beat.
 */
export async function renderBlackjackShuffleGif(): Promise<AnimationResult | null> {
  const durationMs = 3600;
  const maxFrames = 36;
  const captionY = BJ_H - 28;

  return encodeAnimation({
    width: BJ_W, height: BJ_H, durationMs, speed: "normal", maxFrames, quality: 14,
    render: async ({ ctx, t }) => {
      felt(ctx);
      tableLabels(ctx);

      ctx.fillStyle = "#fde68a";
      ctx.font = "bold 18px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("SHUFFLING THE DECK", BJ_W / 2, 36);

      const cx = BJ_W / 2;
      const cy = BJ_H / 2 + 10;
      const cw = 48;
      const ch = 68;

      if (t < 0.28) {
        const p = easeInOutCubic(t / 0.28);
        const leftX = cx - 70 + Math.sin(p * Math.PI * 6) * 8;
        const rightX = cx + 22 - Math.sin(p * Math.PI * 6) * 8;
        for (let i = 0; i < 8; i++) {
          const weave = Math.sin((p * 8 + i) * Math.PI) * 10;
          const fromLeft = i % 2 === 0;
          const x = (fromLeft ? leftX : rightX) + weave * (fromLeft ? 1 : -1);
          const y = cy - 34 + i * 3 + Math.sin(p * Math.PI * 4 + i) * 4;
          drawCardBackAt(ctx, x, y, cw, ch, (fromLeft ? -1 : 1) * 0.08 * Math.sin(p * Math.PI * 3));
        }
        ctx.fillStyle = "#a7f3d0";
        ctx.font = "14px sans-serif";
        ctx.fillText("Side riffle…", cx, captionY);
      } else if (t < 0.55) {
        const p = easeInOutCubic((t - 0.28) / 0.27);
        const arch = Math.sin(p * Math.PI) * 55;
        const spread = lerp(40, 90, p);
        for (let i = 0; i < 10; i++) {
          const side = i < 5 ? -1 : 1;
          const idx = i < 5 ? i : i - 5;
          const frac = idx / 4;
          const x = cx + side * (spread * (0.3 + frac * 0.7)) - cw / 2;
          const y = cy - arch * Math.sin(frac * Math.PI) + (p > 0.55 ? (p - 0.55) * 80 * frac : 0);
          const rot = side * (0.35 + frac * 0.25) * (1 - p * 0.5);
          drawCardBackAt(ctx, x, y, cw, ch, rot);
        }
        if (p > 0.6) {
          const fall = (p - 0.6) / 0.4;
          for (let i = 0; i < 6; i++) {
            const x = cx - 60 + i * 22 + Math.sin(fall * 8 + i) * 6;
            const y = cy - 20 + fall * (40 + i * 8);
            drawCardBackAt(ctx, x, y, cw * 0.9, ch * 0.9, (i - 3) * 0.05);
          }
        }
        ctx.fillStyle = "#fbbf24";
        ctx.font = "14px sans-serif";
        ctx.fillText("Bridge cascade…", cx, captionY);
      } else if (t < 0.78) {
        const p = easeInOutCubic((t - 0.55) / 0.23);
        const packets = 5;
        for (let i = 0; i < packets; i++) {
          const start = i / packets;
          const local = clamp01((p - start) / 0.35);
          const x = lerp(cx + 50, cx - 70, easeOutBack(local));
          const y = cy - 30 + Math.sin(local * Math.PI) * -28 + i * 2;
          drawCardBackAt(ctx, x, y, cw, ch, lerp(0.15, -0.05, local));
        }
        for (let i = 0; i < 4; i++) {
          drawCardBackAt(ctx, cx + 50 + i * 1.5, cy - 30 + i * 1.5, cw, ch, 0.02);
        }
        ctx.fillStyle = "#cbd5e1";
        ctx.font = "14px sans-serif";
        ctx.fillText("Overhand shuffle…", cx, captionY);
      } else {
        const p = clamp01((t - 0.78) / 0.14);
        const jitter = (1 - p) * 6;
        for (let i = 0; i < 12; i++) {
          const x = cx - cw / 2 + (Math.sin(i * 2.1 + t * 20) * jitter);
          const y = cy - ch / 2 + i * 0.7 + (Math.cos(i * 1.7) * jitter * 0.4);
          drawCardBackAt(ctx, x, y, cw, ch, (1 - p) * (i - 6) * 0.01);
        }
        ctx.fillStyle = p > 0.85 ? "#4ade80" : "#e2e8f0";
        ctx.font = "bold 15px sans-serif";
        ctx.fillText(p > 0.85 ? "Deck ready — dealing…" : "Squaring up…", cx, captionY);
      }
    },
  });
}
