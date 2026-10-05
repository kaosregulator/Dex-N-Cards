/**
 * Badge evolution guide — how Art Show emblems grow from first hang → museum legend.
 */

import {
  encodeAnimation, hexToRgba, roundRectPath, clamp01, easeOutBack,
  TITLE_FONT_FAMILY, type Ctx,
} from "../animations/engine.js";
import { logger } from "../../lib/logger.js";

const W = 720;
const H = 400;

const STEPS: { emoji: string; title: string; how: string; color: number }[] = [
  { emoji: "🖼️", title: "Exhibitor", how: "Submit your first piece", color: 0xc4a574 },
  { emoji: "🎨", title: "Studio Regular", how: "Hang 5 pieces", color: 0x5ec8ff },
  { emoji: "🎟️", title: "Patron", how: "Cast 10 votes", color: 0xffd166 },
  { emoji: "✨", title: "Rising Artist", how: "One piece hits 10 ▲", color: 0xb388ff },
  { emoji: "🌟", title: "Crowd Favorite", how: "One piece hits 25 ▲", color: 0x80ffdb },
  { emoji: "🏆", title: "Hall Champion", how: "Win the weekly crown", color: 0xffe66d },
];

export async function renderArtBadgeGuideGif(opts?: {
  highlightId?: string | null;
}): Promise<Buffer | null> {
  try {
    const result = await encodeAnimation({
      width: W,
      height: H,
      speed: "normal",
      durationMs: 2200,
      maxFrames: 14,
      quality: 12,
      render: async ({ ctx, t }) => {
        const g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, "#1a1420");
        g.addColorStop(0.5, "#2a2030");
        g.addColorStop(1, "#121018");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);

        ctx.fillStyle = "#f5e6c8";
        ctx.font = `700 22px ${TITLE_FONT_FAMILY}, sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText("ART SHOW EMBLEMS", W / 2, 36);
        ctx.fillStyle = "#a89478";
        ctx.font = "13px sans-serif";
        ctx.fillText("Submit · Vote · Rise · Crown  —  emblems evolve with you", W / 2, 58);

        const cols = 3;
        const cardW = 210;
        const cardH = 120;
        const gapX = 18;
        const gapY = 16;
        const startX = (W - (cols * cardW + (cols - 1) * gapX)) / 2;
        const startY = 78;

        for (let i = 0; i < STEPS.length; i++) {
          const step = STEPS[i]!;
          const col = i % cols;
          const row = Math.floor(i / cols);
          const x = startX + col * (cardW + gapX);
          const y = startY + row * (cardH + gapY);
          const pop = easeOutBack(clamp01(t * 1.6 - i * 0.08));

          ctx.save();
          ctx.globalAlpha = clamp01(0.35 + pop * 0.65);
          roundRectPath(ctx, x, y + (1 - pop) * 12, cardW, cardH, 14);
          ctx.fillStyle = "rgba(18, 14, 22, 0.88)";
          ctx.fill();
          ctx.strokeStyle = hexToRgba(step.color, 0.65);
          ctx.lineWidth = 2;
          roundRectPath(ctx, x, y + (1 - pop) * 12, cardW, cardH, 14);
          ctx.stroke();

          const cy = y + (1 - pop) * 12;
          ctx.fillStyle = hexToRgba(step.color, 1);
          ctx.font = "28px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(step.emoji, x + cardW / 2, cy + 40);

          ctx.fillStyle = "#f5e6c8";
          ctx.font = `700 15px ${TITLE_FONT_FAMILY}, sans-serif`;
          ctx.fillText(step.title, x + cardW / 2, cy + 68);

          ctx.fillStyle = "#b8a890";
          ctx.font = "12px sans-serif";
          ctx.fillText(step.how, x + cardW / 2, cy + 92);
          ctx.restore();
        }

        ctx.fillStyle = "#8a7a68";
        ctx.font = "11px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(
          "Perks: Rising Artist → free daily bump  ·  Crowd Favorite → station feature  ·  Champion → museum center stage",
          W / 2,
          H - 18,
        );

        void opts;
      },
    });
    return result?.buffer ?? null;
  } catch (err) {
    logger.debug({ err }, "artshow guide render failed");
    return null;
  }
}
