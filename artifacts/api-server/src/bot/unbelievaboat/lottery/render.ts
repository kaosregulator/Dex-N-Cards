import {
  encodeAnimation, getCanvas, hexToRgba, roundRectPath, clamp01, easeOutCubic,
  type Ctx,
} from "../../animations/engine.js";
import { drawConfetti } from "../../animations/particles.js";
import { GAME_DEFS, type LotteryGameKey } from "./catalog.js";

const W = 720;
const H = 400;

function bg(ctx: Ctx, c0: string, c1: string) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, c0);
  g.addColorStop(1, c1);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function ball(
  ctx: Ctx,
  x: number,
  y: number,
  r: number,
  num: number,
  color: string,
  glow = false,
) {
  if (glow) {
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }
  const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(0.35, color);
  g.addColorStop(1, "#1a1a1a");
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = "#0b0b0f";
  ctx.font = `bold ${Math.floor(r * 0.85)}px Orbitron, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(String(num), x, y + Math.floor(r * 0.12));
}

/** Store teaser card for a game. */
export async function renderStoreCardGif(opts: {
  gameKey: LotteryGameKey;
  jackpot: number;
  ticketPrice: number;
  symbol: string;
}): Promise<Buffer | null> {
  const def = GAME_DEFS[opts.gameKey];
  try {
    const result = await encodeAnimation({
      width: W,
      height: H,
      speed: 1,
      durationMs: 1800,
      maxFrames: 14,
      quality: 14,
      render: async ({ ctx, t }) => {
        bg(ctx, "#0d1020", "#1a0f2e");
        // sparkles
        for (let i = 0; i < 40; i++) {
          const x = ((i * 97 + t * 120) % W);
          const y = ((i * 53 + 20) % H);
          ctx.fillStyle = hexToRgba(def.color, 0.15 + 0.35 * Math.sin(t * Math.PI * 2 + i));
          ctx.fillRect(x, y, 2, 2);
        }
        const pop = easeOutCubic(clamp01(t * 1.5));
        roundRectPath(ctx, 40, 40, W - 80, H - 80, 28);
        ctx.fillStyle = "rgba(12,14,24,0.88)";
        ctx.fill();
        ctx.strokeStyle = hexToRgba(def.color, 0.9);
        ctx.lineWidth = 3;
        ctx.stroke();

        ctx.fillStyle = hexToRgba(def.color, 1);
        ctx.font = "bold 36px Orbitron, sans-serif";
        ctx.textAlign = "center";
        ctx.globalAlpha = pop;
        ctx.fillText(`${def.emoji}  ${def.name}`, W / 2, 110);

        ctx.fillStyle = "#fee75c";
        ctx.font = "bold 40px Orbitron, sans-serif";
        ctx.fillText(`JACKPOT ${opts.symbol}${opts.jackpot.toLocaleString()}`, W / 2, 185);

        ctx.fillStyle = "#dbdee1";
        ctx.font = "22px sans-serif";
        ctx.fillText(`Ticket ${opts.symbol}${opts.ticketPrice.toLocaleString()}  ·  ${def.blurb}`, W / 2, 250);

        // decorative balls
        const cols = opts.gameKey === "scratch" ? 0 : 5;
        for (let i = 0; i < cols; i++) {
          const bx = 160 + i * 90;
          const by = 320 + Math.sin(t * Math.PI * 2 + i) * 8;
          ball(ctx, bx, by, 28, (i + 1) * 7 + 3, i === 4 && opts.gameKey !== "classic" ? "#ed4245" : "#f2f3f5");
        }
        ctx.globalAlpha = 1;
      },
    });
    return result?.buffer ?? null;
  } catch {
    return null;
  }
}

/** Live ball reveal — `revealed` balls already locked, rest spinning. */
export async function renderBallRevealGif(opts: {
  title: string;
  numbers: number[];
  bonus?: number | null;
  bonusLabel?: string | null;
  revealedCount: number;
  jackpot: number;
  symbol: string;
}): Promise<Buffer | null> {
  try {
    const total = opts.numbers.length + (opts.bonus != null ? 1 : 0);
    const result = await encodeAnimation({
      width: W,
      height: H,
      speed: 1,
      durationMs: 2200,
      maxFrames: 16,
      quality: 12,
      render: async ({ ctx, t, frameIndex }) => {
        bg(ctx, "#050816", "#1a0530");
        drawConfetti(ctx, W, H, {
          count: 30,
          seed: `balls-${frameIndex}`,
          colors: [0xffd54a, 0xed4245, 0x57f287, 0x5865f2, 0xffffff],
        });

        ctx.fillStyle = "#fee75c";
        ctx.font = "bold 28px Orbitron, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(opts.title, W / 2, 48);
        ctx.fillStyle = "#dbdee1";
        ctx.font = "18px sans-serif";
        ctx.fillText(`Jackpot ${opts.symbol}${opts.jackpot.toLocaleString()}`, W / 2, 78);

        const items: Array<{ n: number; color: string; label?: string }> = opts.numbers.map(n => ({
          n, color: "#f2f3f5",
        }));
        if (opts.bonus != null) {
          items.push({ n: opts.bonus, color: "#ed4245", label: opts.bonusLabel ?? "Bonus" });
        }

        const gap = W / (items.length + 1);
        for (let i = 0; i < items.length; i++) {
          const item = items[i]!;
          const x = gap * (i + 1);
          const locked = i < opts.revealedCount;
          let display = item.n;
          let y = 220;
          if (!locked) {
            display = 1 + ((frameIndex * 13 + i * 17) % 69);
            y = 220 + Math.sin(t * Math.PI * 4 + i) * 18;
          } else {
            y = 220 + (1 - easeOutCubic(clamp01((opts.revealedCount - i) * 0.3 + t))) * -40;
          }
          ball(ctx, x, y, 42, display, item.color, locked);
          if (item.label && locked) {
            ctx.fillStyle = "#ed4245";
            ctx.font = "bold 14px sans-serif";
            ctx.fillText(item.label, x, y + 62);
          }
        }

        ctx.fillStyle = "#949ba4";
        ctx.font = "16px sans-serif";
        ctx.fillText(
          opts.revealedCount >= total ? "FINAL NUMBERS" : `Drawing ball ${Math.min(opts.revealedCount + 1, total)} of ${total}…`,
          W / 2,
          360,
        );
      },
    });
    return result?.buffer ?? null;
  } catch {
    return null;
  }
}

/** Scratch card — `revealedCount` cells peeled. */
export async function renderScratchGif(opts: {
  cells: Array<{ label: string; value: number }>;
  revealedCount: number;
  prize: number;
  symbol: string;
}): Promise<Buffer | null> {
  try {
    const result = await encodeAnimation({
      width: 640,
      height: 420,
      speed: 1,
      durationMs: 1200,
      maxFrames: 10,
      quality: 14,
      render: async ({ ctx, t }) => {
        bg(ctx, "#2a1030", "#0f1a2a");
        roundRectPath(ctx, 30, 24, 580, 372, 22);
        ctx.fillStyle = "#1a1228";
        ctx.fill();
        ctx.strokeStyle = "#eb459e";
        ctx.lineWidth = 3;
        ctx.stroke();

        ctx.fillStyle = "#eb459e";
        ctx.font = "bold 26px Orbitron, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("✦ LUCKY SCRATCH ✦", 320, 58);

        const startX = 70;
        const startY = 90;
        const cw = 150;
        const ch = 80;
        for (let i = 0; i < 9; i++) {
          const col = i % 3;
          const row = Math.floor(i / 3);
          const x = startX + col * (cw + 16);
          const y = startY + row * (ch + 14);
          const revealed = i < opts.revealedCount;
          roundRectPath(ctx, x, y, cw, ch, 12);
          if (revealed) {
            const cell = opts.cells[i]!;
            ctx.fillStyle = cell.label === "WIN" ? "#1a3d2e" : "#2b2d31";
            ctx.fill();
            ctx.strokeStyle = cell.label === "WIN" ? "#57f287" : "#4e5058";
            ctx.stroke();
            ctx.fillStyle = cell.label === "WIN" ? "#57f287" : "#dbdee1";
            ctx.font = "bold 20px sans-serif";
            ctx.fillText(cell.label, x + cw / 2, y + 30);
            ctx.font = "18px sans-serif";
            ctx.fillText(
              cell.value > 0 ? `${opts.symbol}${cell.value}` : "—",
              x + cw / 2,
              y + 58,
            );
          } else {
            // foil
            const g = ctx.createLinearGradient(x, y, x + cw, y + ch);
            g.addColorStop(0, `hsl(${280 + t * 40}, 40%, ${35 + Math.sin(t * 6 + i) * 8}%)`);
            g.addColorStop(1, `hsl(${320 + t * 20}, 50%, 25%)`);
            ctx.fillStyle = g;
            ctx.fill();
            ctx.fillStyle = "rgba(255,255,255,0.35)";
            ctx.font = "bold 16px sans-serif";
            ctx.fillText("SCRATCH", x + cw / 2, y + ch / 2 + 5);
          }
        }

        if (opts.revealedCount >= 9) {
          ctx.fillStyle = opts.prize > 0 ? "#fee75c" : "#949ba4";
          ctx.font = "bold 22px Orbitron, sans-serif";
          ctx.fillText(
            opts.prize > 0 ? `YOU WON ${opts.symbol}${opts.prize.toLocaleString()}!` : "No prize — better luck next time",
            320,
            390,
          );
        } else {
          ctx.fillStyle = "#dbdee1";
          ctx.font = "16px sans-serif";
          ctx.fillText(`Tap Scratch · ${opts.revealedCount}/9 revealed`, 320, 390);
        }
      },
    });
    return result?.buffer ?? null;
  } catch {
    return null;
  }
}

export async function renderLotteryWinnerGif(opts: {
  displayName: string;
  title: string;
  amount: number;
  symbol: string;
  numbersLine: string;
}): Promise<Buffer | null> {
  try {
    const result = await encodeAnimation({
      width: W,
      height: H,
      speed: 1,
      durationMs: 2400,
      maxFrames: 18,
      quality: 12,
      render: async ({ ctx, t, frameIndex }) => {
        bg(ctx, "#1a1440", "#0f2a3d");
        drawConfetti(ctx, W, H, {
          count: 60,
          seed: `lotto-win-${frameIndex}`,
          colors: [0xff5e78, 0xffd54a, 0x4ad991, 0x4a9ff5, 0xb56bff, 0xffffff],
        });
        const pop = easeOutCubic(clamp01(t * 1.3));
        roundRectPath(ctx, 70, 50, W - 140, H - 100, 24);
        ctx.globalAlpha = pop;
        ctx.fillStyle = "rgba(15,18,28,0.85)";
        ctx.fill();
        ctx.strokeStyle = "#fee75c";
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.fillStyle = "#fee75c";
        ctx.font = "bold 34px Orbitron, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(opts.title, W / 2, 120);
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 28px sans-serif";
        ctx.fillText(opts.displayName, W / 2, 170);
        ctx.fillStyle = "#57f287";
        ctx.font = "bold 40px Orbitron, sans-serif";
        ctx.fillText(`${opts.symbol}${opts.amount.toLocaleString()}`, W / 2, 230);
        ctx.fillStyle = "#dbdee1";
        ctx.font = "18px sans-serif";
        ctx.fillText(opts.numbersLine.slice(0, 60), W / 2, 290);
        ctx.globalAlpha = 1;
      },
    });
    return result?.buffer ?? null;
  } catch {
    return null;
  }
}
