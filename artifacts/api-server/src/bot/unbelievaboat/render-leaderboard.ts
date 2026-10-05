// Fancy Dex N Cards × UnbelievaBoat cash leaderboard — spinning top-3 pedestals.

import {
  encodeAnimation, getCanvas, hexToRgba, type Ctx,
} from "../animations/engine.js";
import { loadArt } from "../animations/effects.js";
import type { AnimationResult } from "../animations/types.js";
import { brandAsset, BRAND_LOGO_FILE, BRAND_NAME } from "../help-banners.js";
import { UNBELIEVABOAT_COLOR, UNBELIEVABOAT_NAME } from "./branding.js";
import { drawTextWithEmojis, preloadEmojiTexts } from "./canvas-emoji-text.js";
import { loadCurrencyImage } from "./currency-canvas.js";

const W = 900;
const H = 560;

export type UbLbRow = {
  rank: number;
  userId: string;
  name: string;
  avatarUrl: string | null;
  cash: number;
  bank: number;
  total: number;
};

const MEDAL = [0xffd54a, 0xc0c8d0, 0xcd7f32];

function fmt(n: number) {
  return new Intl.NumberFormat().format(Math.trunc(n));
}

function pedestal(ctx: Ctx, x: number, y: number, w: number, h: number, color: number, shine: number) {
  ctx.fillStyle = hexToRgba(color, 0.35 + shine * 0.25);
  ctx.beginPath();
  ctx.moveTo(x - w / 2, y);
  ctx.lineTo(x + w / 2, y);
  ctx.lineTo(x + w / 2 + 10, y + h);
  ctx.lineTo(x - w / 2 - 10, y + h);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = hexToRgba(color, 0.85);
  ctx.lineWidth = 2;
  ctx.stroke();
  // Shiny sweep
  ctx.fillStyle = `rgba(255,255,255,${0.08 + shine * 0.2})`;
  ctx.fillRect(x - w / 2 + 8, y + 6, w * 0.28, h - 12);
}

export async function renderUbLeaderboardGif(opts: {
  rows: UbLbRow[];
  sort: string;
  symbol: string;
}): Promise<AnimationResult | null> {
  const mod = await getCanvas();
  if (!mod) return null;

  const rows = opts.rows.slice(0, 10);
  const top3 = rows.slice(0, 3);
  const rest = rows.slice(3);

  const logoBuf = brandAsset(BRAND_LOGO_FILE);
  let logoImg: Awaited<ReturnType<typeof loadArt>> = null;
  if (logoBuf) {
    try {
      logoImg = await mod.loadImage(logoBuf);
    } catch { /* ignore */ }
  }

  const avatars: Array<Awaited<ReturnType<typeof loadArt>>> = [];
  for (const r of rows) {
    avatars.push(await loadArt(mod, r.avatarUrl).catch(() => null));
  }

  const emojiImgs = await preloadEmojiTexts(mod, [
    ...rows.map(r => r.name),
    opts.symbol,
    `${BRAND_NAME} × ${UNBELIEVABOAT_NAME}`,
  ]);
  const symbolImg = await loadCurrencyImage(mod, opts.symbol);

  return encodeAnimation({
    width: W, height: H, durationMs: 2200, speed: "normal", maxFrames: 24, quality: 14,
    render: async ({ ctx, t }) => {
      // Deep casino gradient
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, "#1a0a18");
      g.addColorStop(0.45, "#0c0e14");
      g.addColorStop(1, "#07080c");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      // Soft brand glow
      ctx.fillStyle = hexToRgba(UNBELIEVABOAT_COLOR, 0.12);
      ctx.beginPath(); ctx.arc(W / 2, 120, 180, 0, Math.PI * 2); ctx.fill();

      // Logo + title
      if (logoImg) {
        ctx.drawImage(logoImg as never, 28, 18, 56, 56);
      }
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 28px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(`${BRAND_NAME} × ${UNBELIEVABOAT_NAME}`, 98, 36);
      ctx.fillStyle = hexToRgba(UNBELIEVABOAT_COLOR, 1);
      ctx.font = "16px sans-serif";
      ctx.fillText(`Integrated cash leaderboard · sort ${opts.sort}`, 98, 62);

      // Top-3 pedestals (2nd · 1st · 3rd layout)
      const order = [
        { slot: 0, px: W / 2 - 220, rankIdx: 1, ph: 70 },
        { slot: 1, px: W / 2, rankIdx: 0, ph: 100 },
        { slot: 2, px: W / 2 + 220, rankIdx: 2, ph: 55 },
      ];
      const baseY = 310;

      for (const o of order) {
        const row = top3[o.rankIdx];
        if (!row) continue;
        const medal = MEDAL[o.rankIdx]!;
        const shine = 0.5 + 0.5 * Math.sin(t * Math.PI * 4 + o.rankIdx);
        pedestal(ctx, o.px, baseY, 120, o.ph, medal, shine);

        // Spinning avatar ring
        const spin = t * Math.PI * 2;
        const ar = 36;
        const ay = baseY - 50 - (o.rankIdx === 0 ? 18 : 0);
        ctx.save();
        ctx.translate(o.px, ay);
        ctx.rotate(spin * (o.rankIdx === 0 ? 1 : -0.7));
        ctx.strokeStyle = hexToRgba(medal, 0.9);
        ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(0, 0, ar + 6, 0, Math.PI * 1.4); ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.beginPath(); ctx.arc(o.px, ay, ar, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
        const av = avatars[o.rankIdx];
        if (av) ctx.drawImage(av as never, o.px - ar, ay - ar, ar * 2, ar * 2);
        else {
          ctx.fillStyle = "rgba(255,255,255,0.15)";
          ctx.fillRect(o.px - ar, ay - ar, ar * 2, ar * 2);
        }
        ctx.restore();

        // Sparkle on #1
        if (o.rankIdx === 0) {
          for (let i = 0; i < 6; i++) {
            const a = spin + (i / 6) * Math.PI * 2;
            const sx = o.px + Math.cos(a) * (ar + 16);
            const sy = ay + Math.sin(a) * (ar + 16);
            ctx.fillStyle = `rgba(255,213,74,${0.4 + 0.6 * Math.sin(t * 8 + i)})`;
            ctx.beginPath(); ctx.arc(sx, sy, 3, 0, Math.PI * 2); ctx.fill();
          }
        }

        drawTextWithEmojis(ctx, `#${row.rank} ${row.name}`, o.px, baseY + o.ph + 18, emojiImgs, {
          font: "bold 15px sans-serif",
          fillStyle: "#fff",
          align: "center",
          maxWidth: 160,
          emojiSize: 16,
        });
        // Total + currency icon (Twemoji / custom — never tofu)
        const totalLabel = fmt(row.total);
        ctx.font = "bold 18px sans-serif";
        ctx.fillStyle = hexToRgba(medal, 1);
        ctx.textAlign = "center";
        const tw = ctx.measureText(totalLabel).width;
        const iconSz = 18;
        const groupW = tw + (symbolImg ? iconSz + 6 : 0);
        const gx = o.px - groupW / 2;
        ctx.textAlign = "left";
        ctx.fillText(totalLabel, gx, baseY + o.ph + 40);
        if (symbolImg) {
          ctx.drawImage(
            symbolImg as never,
            gx + tw + 4,
            baseY + o.ph + 40 - iconSz + 2,
            iconSz,
            iconSz,
          );
        } else {
          drawTextWithEmojis(
            ctx,
            opts.symbol,
            gx + tw + 8,
            baseY + o.ph + 40,
            emojiImgs,
            { font: "bold 16px sans-serif", fillStyle: hexToRgba(medal, 1), align: "left", emojiSize: 16 },
          );
        }
      }

      // Rows 4–10
      let y = 430;
      for (let i = 0; i < rest.length; i++) {
        const r = rest[i]!;
        const idx = i + 3;
        ctx.fillStyle = "rgba(255,255,255,0.05)";
        ctx.fillRect(40, y - 14, W - 80, 26);
        drawTextWithEmojis(ctx, `#${r.rank}  ${r.name}`, 52, y, emojiImgs, {
          font: "14px sans-serif",
          fillStyle: "#aab0c0",
          align: "left",
          maxWidth: 320,
          emojiSize: 14,
        });
        ctx.textAlign = "right";
        ctx.fillStyle = hexToRgba(UNBELIEVABOAT_COLOR, 1);
        ctx.font = "14px sans-serif";
        ctx.fillText(
          `cash ${fmt(r.cash)} · bank ${fmt(r.bank)} · ${fmt(r.total)}`,
          W - 52,
          y,
        );
        y += 28;
        if (idx >= 9) break;
      }

      if (rows.length === 0) {
        ctx.fillStyle = "#aab0c0";
        ctx.font = "20px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("No balances yet — be the first!", W / 2, H / 2);
      }
    },
  });
}
