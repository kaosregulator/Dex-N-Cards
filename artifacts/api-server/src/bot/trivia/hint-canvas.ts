/**
 * Small landscape hint card — answer shown as painted letters (not Discord text),
 * so players can't click-spoiler or easily copy-paste the solution.
 */

import { AttachmentBuilder } from "discord.js";
import { getCanvas, hexToRgba, TITLE_FONT_FAMILY, type Ctx } from "../animations/engine.js";
import { maskAnswerHint } from "./hint.js";
import { logger } from "../../lib/logger.js";

export const TRIVIA_HINT_FILE = "trivia-hint.png";

const W = 640;
const H = 160;

export async function renderTriviaHintCard(opts: {
  answer: string;
  uniqueGuessCount: number;
  mode?: string;
}): Promise<AttachmentBuilder | null> {
  const mod = await getCanvas();
  if (!mod) return null;

  try {
    const hint = maskAnswerHint(opts.answer, opts.uniqueGuessCount);
    const canvas = mod.createCanvas(W, H);
    const ctx = canvas.getContext("2d") as unknown as Ctx;

    // Soft panel
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, "#12141c");
    bg.addColorStop(1, "#1a2030");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Accent bar
    ctx.fillStyle = hexToRgba(0x5865f2, 0.9);
    ctx.fillRect(0, 0, 6, H);

    // Title
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = `bold 13px ${TITLE_FONT_FAMILY}, sans-serif`;
    ctx.textAlign = "left";
    ctx.fillText("ANSWER HINT", 24, 28);

    ctx.fillStyle = hexToRgba(0x57f287, 0.85);
    ctx.font = "12px sans-serif";
    ctx.fillText(hint.stageLabel, 24, 48);

    // Masked answer — large mono-ish tracking
    ctx.fillStyle = "#f2f3f5";
    ctx.font = "bold 34px monospace, sans-serif";
    ctx.textAlign = "center";
    const display = hint.masked.length > 36 ? `${hint.masked.slice(0, 34)}…` : hint.masked;
    ctx.fillText(display, W / 2, 100);

    // Footer
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(
      `${hint.guessCount} guess${hint.guessCount === 1 ? "" : "es"} · more letters unlock as people try`,
      24,
      H - 18,
    );
    ctx.textAlign = "right";
    ctx.fillText("Image hint — not copyable text", W - 24, H - 18);

    const buffer = Buffer.from(await canvas.encode("png"));
    return new AttachmentBuilder(buffer, { name: TRIVIA_HINT_FILE });
  } catch (err) {
    logger.debug({ err }, "trivia hint card render failed");
    return null;
  }
}
