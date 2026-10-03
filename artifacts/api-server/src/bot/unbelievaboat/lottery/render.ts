import {
  encodeAnimation, hexToRgba, roundRectPath, clamp01,
  type Ctx, type CanvasMod,
} from "../../animations/engine.js";
import { drawConfetti } from "../../animations/particles.js";
import { loadArt } from "../../animations/effects.js";
import {
  GAME_DEFS,
  SCRATCH_TIERS,
  type LotteryGameKey,
  type ScratchTierKey,
} from "./catalog.js";
import {
  loadCurrencyImage,
  drawCurrencyAmount,
} from "../currency-canvas.js";

const W = 720;
const H = 400;

/** Local ease-out cubic (engine exports easeInOutCubic / easeOutBack, not this). */
function easeOutCubic(x: number): number {
  const t = clamp01(x);
  return 1 - (1 - t) ** 3;
}

function bg(ctx: Ctx, c0: string, c1: string, w = W, h = H) {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, c0);
  g.addColorStop(1, c1);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
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

export type StoreRow = {
  gameKey: LotteryGameKey;
  jackpot: number;
  ticketPrice: number;
  open: boolean;
};

/** Full store board — clean 2×2 game tiles with currency icons (no raw emoji markup). */
export async function renderLotteryStoreGif(opts: {
  rows: StoreRow[];
  symbol: string;
}): Promise<Buffer | null> {
  try {
    const result = await encodeAnimation({
      width: W,
      height: 460,
      speed: "normal",
      durationMs: 2000,
      maxFrames: 14,
      quality: 14,
      render: async ({ ctx, t, mod }) => {
        const symImg = await loadCurrencyImage(mod, opts.symbol);
        bg(ctx, "#0b1020", "#16102a", W, 460);

        // soft sparkle dust
        for (let i = 0; i < 36; i++) {
          const x = ((i * 89 + t * 90) % W);
          const y = ((i * 61 + 18) % 460);
          ctx.fillStyle = `rgba(254, 231, 92, ${0.08 + 0.2 * Math.sin(t * Math.PI * 2 + i)})`;
          ctx.fillRect(x, y, 2, 2);
        }

        const pop = easeOutCubic(clamp01(t * 1.4));
        ctx.globalAlpha = pop;

        // header bar
        roundRectPath(ctx, 28, 20, W - 56, 64, 16);
        ctx.fillStyle = "rgba(12,14,24,0.92)";
        ctx.fill();
        ctx.strokeStyle = "rgba(254,231,92,0.55)";
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = "#fee75c";
        ctx.font = "bold 28px Orbitron, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("LOTTERY STORE", W / 2, 48);
        ctx.fillStyle = "#949ba4";
        ctx.font = "14px sans-serif";
        ctx.fillText("UnbelievaBoat · pick a game · private number picks", W / 2, 72);

        const order: LotteryGameKey[] = ["classic", "powerball", "mega", "scratch"];
        const byKey = new Map(opts.rows.map(r => [r.gameKey, r]));
        const tileW = 320;
        const tileH = 150;
        const gapX = 20;
        const gapY = 16;
        const originX = 30;
        const originY = 104;

        for (let i = 0; i < 4; i++) {
          const key = order[i]!;
          const def = GAME_DEFS[key];
          const row = byKey.get(key);
          const col = i % 2;
          const r = Math.floor(i / 2);
          const x = originX + col * (tileW + gapX);
          const y = originY + r * (tileH + gapY);
          const bob = Math.sin(t * Math.PI * 2 + i) * 2;

          roundRectPath(ctx, x, y + bob, tileW, tileH, 18);
          ctx.fillStyle = "rgba(18,20,32,0.94)";
          ctx.fill();
          ctx.strokeStyle = hexToRgba(def.color, row?.open === false ? 0.35 : 0.85);
          ctx.lineWidth = 2.5;
          ctx.stroke();

          // accent strip
          ctx.fillStyle = hexToRgba(def.color, 0.9);
          ctx.fillRect(x + 14, y + bob + 18, 4, tileH - 36);

          ctx.fillStyle = hexToRgba(def.color, 1);
          ctx.font = "bold 20px Orbitron, sans-serif";
          ctx.textAlign = "left";
          ctx.fillText(`${def.emoji}  ${def.name}`, x + 30, y + bob + 42);

          const status = row?.open === false ? "CLOSED" : "OPEN";
          ctx.fillStyle = row?.open === false ? "#ed4245" : "#57f287";
          ctx.font = "bold 12px sans-serif";
          ctx.textAlign = "right";
          ctx.fillText(status, x + tileW - 18, y + bob + 40);

          ctx.textAlign = "left";
          ctx.fillStyle = "#949ba4";
          ctx.font = "13px sans-serif";
          const isScratch = key === "scratch";
          ctx.fillText(isScratch ? "From" : "Jackpot", x + 30, y + bob + 72);

          drawCurrencyAmount(
            ctx, symImg, opts.symbol,
            row?.jackpot ?? 0,
            x + 30, y + bob + 98,
            { iconSize: 22, font: "bold 24px Orbitron, sans-serif", color: "#fee75c", align: "left" },
          );

          ctx.fillStyle = "#949ba4";
          ctx.font = "13px sans-serif";
          ctx.fillText(isScratch ? "Tiers · daily stock" : "Ticket", x + 30, y + bob + 128);
          if (!isScratch) {
            drawCurrencyAmount(
              ctx, symImg, opts.symbol,
              row?.ticketPrice ?? def.ticketPrice,
              x + 90, y + bob + 128,
              { iconSize: 14, font: "bold 14px sans-serif", color: "#dbdee1", align: "left" },
            );
          } else {
            ctx.fillStyle = "#dbdee1";
            ctx.font = "bold 13px sans-serif";
            ctx.fillText("Copper → Diamond", x + 150, y + bob + 128);
          }
        }
        ctx.globalAlpha = 1;
      },
    });
    return result?.buffer ?? null;
  } catch {
    return null;
  }
}

/** Store teaser card for a single game (jackpot boards / admin announce). */
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
      speed: "normal",
      durationMs: 1800,
      maxFrames: 14,
      quality: 14,
      render: async ({ ctx, t, mod }) => {
        const symImg = await loadCurrencyImage(mod, opts.symbol);
        bg(ctx, "#0d1020", "#1a0f2e");
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

        ctx.fillStyle = "#949ba4";
        ctx.font = "16px sans-serif";
        ctx.fillText("JACKPOT", W / 2, 155);
        drawCurrencyAmount(
          ctx, symImg, opts.symbol, opts.jackpot,
          W / 2, 190,
          { iconSize: 32, font: "bold 36px Orbitron, sans-serif", color: "#fee75c", align: "center" },
        );

        ctx.fillStyle = "#949ba4";
        ctx.font = "15px sans-serif";
        ctx.fillText("Ticket", W / 2 - 80, 250);
        drawCurrencyAmount(
          ctx, symImg, opts.symbol, opts.ticketPrice,
          W / 2 + 20, 250,
          { iconSize: 16, font: "bold 18px sans-serif", color: "#dbdee1", align: "left" },
        );
        ctx.fillStyle = "#dbdee1";
        ctx.font = "16px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(def.blurb, W / 2, 285);

        const cols = opts.gameKey === "scratch" ? 0 : 5;
        for (let i = 0; i < cols; i++) {
          const bx = 160 + i * 90;
          const by = 330 + Math.sin(t * Math.PI * 2 + i) * 8;
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
      speed: "normal",
      durationMs: 2200,
      maxFrames: 16,
      quality: 12,
      render: async ({ ctx, t, frameIndex, mod }) => {
        const symImg = await loadCurrencyImage(mod, opts.symbol);
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
        ctx.fillStyle = "#949ba4";
        ctx.font = "14px sans-serif";
        ctx.fillText("Jackpot", W / 2, 72);
        drawCurrencyAmount(
          ctx, symImg, opts.symbol, opts.jackpot,
          W / 2, 96,
          { iconSize: 18, font: "bold 18px sans-serif", color: "#dbdee1", align: "center" },
        );

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
          let y = 230;
          if (!locked) {
            display = 1 + ((frameIndex * 13 + i * 17) % 69);
            y = 230 + Math.sin(t * Math.PI * 4 + i) * 18;
          } else {
            y = 230 + (1 - easeOutCubic(clamp01((opts.revealedCount - i) * 0.3 + t))) * -40;
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

/** Scratch card — tier-themed foil ticket with currency icons. */
export async function renderScratchGif(opts: {
  cells: Array<{ label: string; value: number }>;
  revealedCount: number;
  prize: number;
  symbol: string;
  tierKey?: ScratchTierKey | string | null;
}): Promise<Buffer | null> {
  const tier = (opts.tierKey && opts.tierKey in SCRATCH_TIERS)
    ? SCRATCH_TIERS[opts.tierKey as ScratchTierKey]
    : SCRATCH_TIERS.silver;
  const c = tier.canvas;
  try {
    const result = await encodeAnimation({
      width: 640,
      height: 440,
      speed: "normal",
      durationMs: 1200,
      maxFrames: 10,
      quality: 14,
      render: async ({ ctx, t, mod }) => {
        const symImg = await loadCurrencyImage(mod, opts.symbol);
        bg(ctx, c.bg0, c.bg1, 640, 440);

        // ticket body
        roundRectPath(ctx, 24, 18, 592, 404, 20);
        ctx.fillStyle = "#12141c";
        ctx.fill();
        ctx.strokeStyle = c.accent;
        ctx.lineWidth = 3;
        ctx.stroke();

        // perforated stub edge
        ctx.strokeStyle = "rgba(255,255,255,0.12)";
        ctx.setLineDash([4, 6]);
        ctx.beginPath();
        ctx.moveTo(24, 78);
        ctx.lineTo(616, 78);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = c.accent;
        ctx.font = "bold 24px Orbitron, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(c.title, 320, 52);
        ctx.fillStyle = "#949ba4";
        ctx.font = "12px sans-serif";
        ctx.fillText(`${tier.emoji} ${tier.name} · Instant Win`, 320, 70);

        const startX = 56;
        const startY = 96;
        const cw = 160;
        const ch = 84;
        for (let i = 0; i < 9; i++) {
          const col = i % 3;
          const row = Math.floor(i / 3);
          const x = startX + col * (cw + 14);
          const y = startY + row * (ch + 12);
          const revealed = i < opts.revealedCount;
          roundRectPath(ctx, x, y, cw, ch, 12);
          if (revealed) {
            const cell = opts.cells[i]!;
            const win = cell.label === "WIN";
            ctx.fillStyle = win ? "#143528" : "#23262e";
            ctx.fill();
            ctx.strokeStyle = win ? "#57f287" : "#3f424a";
            ctx.lineWidth = win ? 2.5 : 1.5;
            ctx.stroke();
            ctx.fillStyle = win ? "#57f287" : "#dbdee1";
            ctx.font = "bold 18px Orbitron, sans-serif";
            ctx.textAlign = "center";
            ctx.fillText(cell.label === "—" ? "MISS" : cell.label, x + cw / 2, y + 28);
            if (cell.value > 0) {
              drawCurrencyAmount(
                ctx, symImg, opts.symbol, cell.value,
                x + cw / 2, y + 58,
                {
                  iconSize: 16,
                  font: "bold 16px sans-serif",
                  color: win ? "#fee75c" : "#dbdee1",
                  align: "center",
                },
              );
            } else {
              ctx.fillStyle = "#6d6f78";
              ctx.font = "14px sans-serif";
              ctx.fillText("—", x + cw / 2, y + 58);
            }
          } else {
            const g = ctx.createLinearGradient(x, y, x + cw, y + ch);
            const shimmer = 30 + Math.sin(t * 6 + i) * 10;
            g.addColorStop(0, `hsl(${c.foil0 + t * 20}, 35%, ${shimmer}%)`);
            g.addColorStop(0.5, `hsl(${c.foil1}, 45%, ${shimmer + 8}%)`);
            g.addColorStop(1, `hsl(${c.foil0}, 30%, ${shimmer - 6}%)`);
            ctx.fillStyle = g;
            ctx.fill();
            // scratch streaks
            ctx.strokeStyle = "rgba(255,255,255,0.18)";
            ctx.lineWidth = 2;
            for (let s = 0; s < 4; s++) {
              ctx.beginPath();
              ctx.moveTo(x + 12 + s * 18, y + 10);
              ctx.lineTo(x + 40 + s * 22, y + ch - 10);
              ctx.stroke();
            }
            ctx.fillStyle = "rgba(255,255,255,0.55)";
            ctx.font = "bold 15px Orbitron, sans-serif";
            ctx.textAlign = "center";
            ctx.fillText("SCRATCH", x + cw / 2, y + ch / 2 + 5);
          }
        }

        if (opts.revealedCount >= 9) {
          if (opts.prize > 0) {
            ctx.fillStyle = "#fee75c";
            ctx.font = "bold 18px Orbitron, sans-serif";
            ctx.textAlign = "center";
            ctx.fillText("YOU WON", 320, 392);
            drawCurrencyAmount(
              ctx, symImg, opts.symbol, opts.prize,
              320, 418,
              { iconSize: 22, font: "bold 22px Orbitron, sans-serif", color: "#57f287", align: "center" },
            );
          } else {
            ctx.fillStyle = "#949ba4";
            ctx.font = "bold 18px Orbitron, sans-serif";
            ctx.textAlign = "center";
            ctx.fillText("No prize — better luck next time", 320, 408);
          }
        } else {
          ctx.fillStyle = "#dbdee1";
          ctx.font = "15px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(`Peel the foil · ${opts.revealedCount}/9 revealed`, 320, 408);
        }
      },
    });
    return result?.buffer ?? null;
  } catch {
    return null;
  }
}

/** Scratch shop shelf — tier cards with stock meters. */
export async function renderScratchShopGif(opts: {
  symbol: string;
  stock: Record<string, number>;
}): Promise<Buffer | null> {
  try {
    const result = await encodeAnimation({
      width: W,
      height: 420,
      speed: "normal",
      durationMs: 1800,
      maxFrames: 12,
      quality: 14,
      render: async ({ ctx, t, mod }) => {
        const symImg = await loadCurrencyImage(mod, opts.symbol);
        bg(ctx, "#140a18", "#0a1020", W, 420);
        for (let i = 0; i < 28; i++) {
          ctx.fillStyle = `rgba(235, 69, 158, ${0.1 + 0.15 * Math.sin(t * 5 + i)})`;
          ctx.fillRect((i * 73 + t * 40) % W, (i * 47) % 420, 2, 2);
        }

        roundRectPath(ctx, 24, 16, W - 48, 52, 14);
        ctx.fillStyle = "rgba(20,12,28,0.95)";
        ctx.fill();
        ctx.strokeStyle = "#eb459e";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = "#eb459e";
        ctx.font = "bold 24px Orbitron, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("SCRATCH SHOP", W / 2, 42);
        ctx.fillStyle = "#949ba4";
        ctx.font = "12px sans-serif";
        ctx.fillText("Daily stock · restocks 00:00 UTC", W / 2, 58);

        const keys = Object.keys(SCRATCH_TIERS) as ScratchTierKey[];
        const tileW = 155;
        const gap = 12;
        const startX = (W - (tileW * 4 + gap * 3)) / 2;
        for (let i = 0; i < keys.length; i++) {
          const tier = SCRATCH_TIERS[keys[i]!];
          const x = startX + i * (tileW + gap);
          const y = 90 + Math.sin(t * Math.PI * 2 + i) * 3;
          const left = opts.stock[tier.key] ?? 0;
          const soldOut = left <= 0;

          roundRectPath(ctx, x, y, tileW, 290, 16);
          ctx.fillStyle = soldOut ? "rgba(30,20,28,0.9)" : "rgba(18,16,28,0.95)";
          ctx.fill();
          ctx.strokeStyle = soldOut ? "#4e5058" : tier.canvas.accent;
          ctx.lineWidth = 2;
          ctx.stroke();

          ctx.fillStyle = tier.canvas.accent;
          ctx.font = "bold 16px Orbitron, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(tier.emoji, x + tileW / 2, y + 36);
          ctx.fillText(tier.name.replace(" Scratch", ""), x + tileW / 2, y + 62);

          ctx.fillStyle = "#949ba4";
          ctx.font = "11px sans-serif";
          ctx.fillText("Price", x + tileW / 2, y + 100);
          drawCurrencyAmount(
            ctx, symImg, opts.symbol, tier.price,
            x + tileW / 2, y + 126,
            { iconSize: 18, font: "bold 18px Orbitron, sans-serif", color: "#fee75c", align: "center" },
          );

          // stock bar
          const barX = x + 18;
          const barY = y + 170;
          const barW = tileW - 36;
          roundRectPath(ctx, barX, barY, barW, 12, 6);
          ctx.fillStyle = "#2b2d31";
          ctx.fill();
          const pct = Math.max(0, Math.min(1, left / tier.dailyStock));
          if (pct > 0) {
            roundRectPath(ctx, barX, barY, barW * pct, 12, 6);
            ctx.fillStyle = soldOut ? "#ed4245" : tier.canvas.accent;
            ctx.fill();
          }
          ctx.fillStyle = soldOut ? "#ed4245" : "#dbdee1";
          ctx.font = "bold 13px sans-serif";
          ctx.fillText(soldOut ? "SOLD OUT" : `${left} left today`, x + tileW / 2, y + 210);

          ctx.fillStyle = "#6d6f78";
          ctx.font = "11px sans-serif";
          const words = tier.blurb.split(" · ");
          ctx.fillText(words[0] ?? "", x + tileW / 2, y + 245);
          if (words[1]) ctx.fillText(words[1], x + tileW / 2, y + 262);
        }
      },
    });
    return result?.buffer ?? null;
  } catch {
    return null;
  }
}

async function drawAvatarCircle(
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
  if (img) ctx.drawImage(img, x, y, size, size);
  else {
    ctx.fillStyle = "#2b2d31";
    ctx.fillRect(x, y, size, size);
  }
  ctx.restore();
  ctx.strokeStyle = "#fee75c";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2 + 1, 0, Math.PI * 2);
  ctx.stroke();
}

export type WinnerPortrait = {
  displayName: string;
  avatarUrl?: string | null;
  amount: number;
  numbersLine: string;
  ticketId: number;
  tier: string;
};

export async function renderLotteryWinnerGif(opts: {
  displayName: string;
  title: string;
  amount: number;
  symbol: string;
  numbersLine: string;
  avatarUrl?: string | null;
}): Promise<Buffer | null> {
  return renderLotteryWinnersGif({
    title: opts.title,
    symbol: opts.symbol,
    winners: [{
      displayName: opts.displayName,
      avatarUrl: opts.avatarUrl,
      amount: opts.amount,
      numbersLine: opts.numbersLine,
      ticketId: 0,
      tier: "Winner",
    }],
  });
}

/** One or many winners (ties) — public celebration card with Discord avatars. */
export async function renderLotteryWinnersGif(opts: {
  title: string;
  symbol: string;
  winners: WinnerPortrait[];
}): Promise<Buffer | null> {
  const winners = opts.winners.slice(0, 3);
  if (winners.length === 0) return null;
  const multi = winners.length > 1;
  try {
    const result = await encodeAnimation({
      width: multi ? 840 : W,
      height: multi ? 460 : H,
      speed: "normal",
      durationMs: 2600,
      maxFrames: 18,
      quality: 12,
      render: async ({ ctx, t, frameIndex, mod }) => {
        const symImg = await loadCurrencyImage(mod, opts.symbol);
        const width = multi ? 840 : W;
        const height = multi ? 460 : H;
        bg(ctx, "#1a1440", "#0f2a3d", width, height);
        drawConfetti(ctx, width, height, {
          count: multi ? 80 : 60,
          seed: `lotto-win-${frameIndex}`,
          colors: [0xff5e78, 0xffd54a, 0x4ad991, 0x4a9ff5, 0xb56bff, 0xffffff],
        });
        const pop = easeOutCubic(clamp01(t * 1.3));
        ctx.globalAlpha = pop;
        roundRectPath(ctx, 40, 30, width - 80, height - 60, 24);
        ctx.fillStyle = "rgba(15,18,28,0.88)";
        ctx.fill();
        ctx.strokeStyle = "#fee75c";
        ctx.lineWidth = 3;
        ctx.stroke();

        ctx.fillStyle = "#fee75c";
        ctx.font = multi ? "bold 36px Orbitron, sans-serif" : "bold 34px Orbitron, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(opts.title, width / 2, 78);

        if (!multi) {
          const w0 = winners[0]!;
          await drawAvatarCircle(ctx, mod, w0.avatarUrl, width / 2 - 48, 100, 96);
          ctx.fillStyle = "#ffffff";
          ctx.font = "bold 26px sans-serif";
          ctx.fillText(w0.displayName.slice(0, 24), width / 2, 230);
          drawCurrencyAmount(
            ctx, symImg, opts.symbol, w0.amount,
            width / 2, 275,
            { iconSize: 28, font: "bold 32px Orbitron, sans-serif", color: "#57f287", align: "center" },
          );
          ctx.fillStyle = "#dbdee1";
          ctx.font = "16px sans-serif";
          ctx.fillText(w0.numbersLine.slice(0, 64), width / 2, 315);
          if (w0.ticketId) {
            ctx.fillStyle = "#949ba4";
            ctx.fillText(`Ticket #${w0.ticketId} · ${w0.tier}`, width / 2, 350);
          }
        } else {
          const slotW = (width - 100) / winners.length;
          for (let i = 0; i < winners.length; i++) {
            const w = winners[i]!;
            const cx = 50 + slotW * i + slotW / 2;
            await drawAvatarCircle(ctx, mod, w.avatarUrl, cx - 44, 110, 88);
            ctx.fillStyle = "#ffffff";
            ctx.font = "bold 20px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText(w.displayName.slice(0, 18), cx, 230);
            drawCurrencyAmount(
              ctx, symImg, opts.symbol, w.amount,
              cx, 262,
              { iconSize: 18, font: "bold 22px Orbitron, sans-serif", color: "#57f287", align: "center" },
            );
            ctx.fillStyle = "#fee75c";
            ctx.font = "14px sans-serif";
            ctx.fillText(w.tier, cx, 288);
            ctx.fillStyle = "#dbdee1";
            ctx.font = "13px sans-serif";
            const nums = w.numbersLine.replace(/\*\*/g, "").slice(0, 42);
            ctx.fillText(nums, cx, 318);
            ctx.fillStyle = "#949ba4";
            ctx.fillText(`Ticket #${w.ticketId}`, cx, 345);
          }
          ctx.fillStyle = "#ed4245";
          ctx.font = "bold 18px Orbitron, sans-serif";
          ctx.fillText("TIE — JACKPOT SPLIT!", width / 2, 390);
        }
        ctx.globalAlpha = 1;
      },
    });
    return result?.buffer ?? null;
  } catch {
    return null;
  }
}
