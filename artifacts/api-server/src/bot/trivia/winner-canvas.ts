import {
  encodeAnimation, getCanvas, hexToRgba, roundRectPath, clamp01, easeOutBack,
  type Ctx, type CanvasMod,
} from "../animations/engine.js";
import { drawConfetti } from "../animations/particles.js";
import { loadArt } from "../animations/effects.js";
import { logger } from "../../lib/logger.js";

const W = 720;
const H = 420;

async function drawAvatar(
  ctx: Ctx,
  mod: CanvasMod,
  url: string | null | undefined,
  x: number,
  y: number,
  size: number,
): Promise<void> {
  const img = await loadArt(mod, url ?? null);
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (img) {
    ctx.drawImage(img, x, y, size, size);
  } else {
    ctx.fillStyle = "#2b2d31";
    ctx.fillRect(x, y, size, size);
  }
  ctx.restore();
  ctx.strokeStyle = "#fee75c";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2 + 2, 0, Math.PI * 2);
  ctx.stroke();
}

export async function renderTriviaWinnerGif(opts: {
  displayName: string;
  avatarUrl?: string | null;
  title?: string;
  subtitle?: string;
  roleLabel?: string | null;
}): Promise<Buffer | null> {
  try {
    const result = await encodeAnimation({
      width: W,
      height: H,
      speed: 1,
      durationMs: 2200,
      maxFrames: 18,
      quality: 12,
      render: async ({ ctx, t, mod, frameIndex }) => {
        // Soft celebration background
        const g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, "#1a1440");
        g.addColorStop(0.55, "#2b215c");
        g.addColorStop(1, "#0f2a3d");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);

        // Animated confetti burst intensity
        drawConfetti(ctx, W, H, {
          count: 55 + Math.floor(20 * Math.sin(t * Math.PI)),
          seed: `trivia-win-${frameIndex}`,
          colors: [0xff5e78, 0xffd54a, 0x4ad991, 0x4a9ff5, 0xb56bff, 0xffffff],
        });

        // Card panel
        const pop = easeOutBack(clamp01(t * 1.4));
        const panelW = 560;
        const panelH = 280;
        const px = (W - panelW) / 2;
        const py = (H - panelH) / 2 + (1 - pop) * 40;
        ctx.save();
        ctx.globalAlpha = clamp01(pop);
        roundRectPath(ctx, px, py, panelW, panelH, 24);
        ctx.fillStyle = "rgba(15, 18, 28, 0.82)";
        ctx.fill();
        ctx.strokeStyle = hexToRgba(0xfee75c, 0.85);
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.restore();

        const avatarSize = 110;
        await drawAvatar(
          ctx,
          mod,
          opts.avatarUrl,
          W / 2 - avatarSize / 2,
          py + 28,
          avatarSize,
        );

        ctx.fillStyle = "#fee75c";
        ctx.font = "bold 34px Orbitron, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(opts.title ?? "WINNER!", W / 2, py + 175);

        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 26px sans-serif";
        const name = (opts.displayName || "Player").slice(0, 32);
        ctx.fillText(name, W / 2, py + 212);

        if (opts.subtitle) {
          ctx.fillStyle = "rgba(255,255,255,0.75)";
          ctx.font = "16px sans-serif";
          ctx.fillText(opts.subtitle.slice(0, 64), W / 2, py + 238);
        }

        if (opts.roleLabel) {
          ctx.fillStyle = hexToRgba(0x57f287, 0.95);
          ctx.font = "bold 15px sans-serif";
          ctx.fillText(`Role awarded · ${opts.roleLabel}`, W / 2, py + 262);
        }
      },
    });
    return result?.buffer ?? null;
  } catch (err) {
    logger.warn({ err }, "trivia winner gif failed");
    return null;
  }
}
