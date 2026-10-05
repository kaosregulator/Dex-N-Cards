// Animated GIFs for UnbelievaBoat casino — felt-table look, GIF-safe flats.

import { encodeAnimation, getCanvas, type Ctx, type CanvasMod } from "../animations/engine.js";
import type { AnimationResult } from "../animations/types.js";
import { loadArt } from "../animations/effects.js";
import { cardLabel, type Card } from "./cards.js";
import { drawTextWithEmojis, preloadEmojiTexts } from "./canvas-emoji-text.js";

const W = 480;
const H = 280;
const SLOTS_W = 560;
const SLOTS_H = 320;
const BJ_W = 560;
const BJ_H = 340;

function felt(ctx: Ctx, w = W, h = H) {
  // Deep casino felt with subtle vignette + wood rail (no flashy glows).
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

/** Draw a card with optional horizontal flip (0 = face-down edge, 1 = face-up). */
function drawCardFace(
  ctx: Ctx,
  x: number,
  y: number,
  label: string,
  faceDown = false,
  flip = 1,
  cardW = 56,
  cardH = 78,
) {
  const scaleX = Math.max(0.04, Math.abs(Math.cos(flip * Math.PI)));
  const showBack = faceDown || flip < 0.5;
  const cx = x + cardW / 2;
  const drawW = cardW * scaleX;
  const left = cx - drawW / 2;

  roundRect(ctx, left, y, drawW, cardH, 6 * scaleX);
  if (showBack) {
    // Simple blank card back — solid navy with a thin inner border (no busy pattern)
    ctx.fillStyle = "#1e3a5f";
    ctx.fill();
    if (drawW > 12) {
      ctx.strokeStyle = "#94a3b8";
      ctx.lineWidth = 2;
      ctx.stroke();
      roundRect(ctx, left + drawW * 0.12, y + cardH * 0.1, drawW * 0.76, cardH * 0.8, 4 * scaleX);
      ctx.strokeStyle = "#64748b";
      ctx.lineWidth = 1.5;
      ctx.stroke();
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

export async function renderCoinSpinGif(opts: {
  amount: number;
  symbol: string;
  streak: number;
}): Promise<AnimationResult | null> {
  const label = opts.symbol.length <= 4 ? opts.symbol : "💵";
  return encodeAnimation({
    width: W, height: H, durationMs: 1600, speed: "normal", maxFrames: 20, quality: 12,
    render: async ({ ctx, t }) => {
      felt(ctx);
      const cx = W / 2, cy = H / 2 - 16;
      const squash = Math.abs(Math.cos(t * Math.PI * 4));
      const r = 18 + 36 * squash;
      ctx.fillStyle = "#f5c84c";
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#c9922a";
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.62, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#fff6c8";
      ctx.font = "bold 28px sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      if (squash > 0.4) ctx.fillText(label, cx, cy);
      ctx.fillStyle = "#fde68a";
      ctx.font = "bold 22px sans-serif";
      ctx.fillText(`+${opts.amount}`, cx, H - 52);
      ctx.fillStyle = "#a7f3d0";
      ctx.font = "14px sans-serif";
      ctx.fillText(`streak ${opts.streak}`, cx, H - 28);
    },
  });
}

export async function renderRouletteGif(opts: {
  landing: number;
  color: "red" | "black" | "green";
}): Promise<AnimationResult | null> {
  const colors = ["#c0392b", "#111", "#c0392b", "#111", "#27ae60", "#c0392b", "#111", "#c0392b"];
  return encodeAnimation({
    width: W, height: H, durationMs: 2000, speed: "normal", maxFrames: 24, quality: 14,
    render: async ({ ctx, t }) => {
      felt(ctx);
      const cx = W / 2, cy = H / 2 - 4;
      const rot = t * Math.PI * 7 + (opts.landing / 37) * Math.PI * 2;
      const r = 88;
      for (let i = 0; i < 16; i++) {
        const a0 = rot + (i / 16) * Math.PI * 2;
        const a1 = rot + ((i + 1) / 16) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, r, a0, a1);
        ctx.closePath();
        ctx.fillStyle = colors[i % colors.length]!;
        ctx.fill();
      }
      ctx.fillStyle = "#f5c84c";
      ctx.beginPath(); ctx.arc(cx, cy, 26, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#111";
      ctx.font = "bold 18px sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(opts.landing), cx, cy);
      const br = r - 12;
      const ba = -Math.PI / 2 + (1 - t) * Math.PI * 10;
      ctx.fillStyle = "#f1f5f9";
      ctx.beginPath();
      ctx.arc(cx + Math.cos(ba) * br, cy + Math.sin(ba) * br, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = opts.color === "red" ? "#f87171" : opts.color === "green" ? "#4ade80" : "#e2e8f0";
      ctx.font = "bold 18px sans-serif";
      ctx.fillText(opts.color.toUpperCase(), cx, H - 24);
    },
  });
}

/** @deprecated use render-blackjack.js — kept as re-export for older imports */
export {
  renderBlackjackTableGif,
  renderBlackjackTablePng,
  renderBlackjackShuffleGif,
  renderBlackjackShufflePng,
} from "./render-blackjack.js";

/** @deprecated alias */
export async function renderBlackjackGif(opts: {
  playerTotal: number;
  dealerTotal: number;
  outcome: "win" | "lose" | "push";
}): Promise<AnimationResult | null> {
  return encodeAnimation({
    width: W, height: H, durationMs: 1200, speed: "normal", maxFrames: 12, quality: 12,
    render: async ({ ctx, t }) => {
      felt(ctx);
      ctx.fillStyle = "#ecfdf5";
      ctx.font = "bold 28px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`${opts.playerTotal} vs ${opts.dealerTotal}`, W / 2, H / 2 - 20);
      ctx.fillStyle = opts.outcome === "win" ? "#4ade80" : opts.outcome === "push" ? "#fbbf24" : "#f87171";
      if (t > 0.4) ctx.fillText(opts.outcome.toUpperCase(), W / 2, H / 2 + 30);
    },
  });
}

export async function renderHigherLowerGif(opts: {
  shown: string;
  next?: string;
  result?: "win" | "lose";
}): Promise<AnimationResult | null> {
  return encodeAnimation({
    width: W, height: H, durationMs: 1100, speed: "normal", maxFrames: 12, quality: 12,
    render: async ({ ctx, t }) => {
      felt(ctx);
      drawCardFace(ctx, W / 2 - 90, 90, opts.shown);
      if (opts.next && t > 0.45) drawCardFace(ctx, W / 2 + 30, 90, opts.next);
      else drawCardFace(ctx, W / 2 + 30, 90, "?", true);
      ctx.fillStyle = "#ecfdf5";
      ctx.font = "bold 18px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("HIGHER  or  LOWER?", W / 2, 50);
      if (opts.result && t > 0.55) {
        ctx.fillStyle = opts.result === "win" ? "#4ade80" : "#f87171";
        ctx.fillText(opts.result === "win" ? "NICE CALL" : "WRONG", W / 2, H - 36);
      }
    },
  });
}

export async function renderRedBlackGif(opts: {
  pick: "red" | "black";
  landed: "red" | "black";
  win: boolean;
}): Promise<AnimationResult | null> {
  return encodeAnimation({
    width: W, height: H, durationMs: 1400, speed: "normal", maxFrames: 16, quality: 12,
    render: async ({ ctx, t }) => {
      felt(ctx);
      const flip = Math.floor(t * 10) % 2 === 0 ? "#dc2626" : "#0f172a";
      roundRect(ctx, W / 2 - 50, 70, 100, 120, 12);
      ctx.fillStyle = t < 0.7 ? flip : (opts.landed === "red" ? "#dc2626" : "#0f172a");
      ctx.fill();
      ctx.fillStyle = "#f8fafc";
      ctx.font = "bold 22px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(t < 0.7 ? "?" : opts.landed.toUpperCase(), W / 2, 130);
      ctx.fillStyle = "#a7f3d0";
      ctx.font = "16px sans-serif";
      ctx.fillText(`You picked ${opts.pick}`, W / 2, 40);
      if (t > 0.75) {
        ctx.fillStyle = opts.win ? "#4ade80" : "#f87171";
        ctx.font = "bold 22px sans-serif";
        ctx.fillText(opts.win ? "WIN ×2" : "LOSE", W / 2, H - 36);
      }
    },
  });
}

export async function renderSlotsGif(opts: {
  reels: string[];
  win: boolean;
  /** Payout multiplier (0 if loss). */
  mult?: number;
  /** Server economy symbol for jackpot banner. */
  symbol?: string;
  /** Formatted payout text for the win banner. */
  payoutLabel?: string;
  /** "jackpot" | "line" | "pair" | "lose" */
  tier?: "jackpot" | "line" | "pair" | "lose";
}): Promise<AnimationResult | null> {
  const pool = ["🍒", "🍋", "🔔", "⭐", "💎", "7️⃣", "🃏", "💰"];
  const reelCount = opts.reels.length;
  // Staggered stop times — last reel locks near the end for a long live spin.
  const stopAt = reelCount === 5
    ? [0.42, 0.54, 0.66, 0.78, 0.88]
    : [0.45, 0.65, 0.82];
  const symbol = opts.symbol || "💵";
  const tier = opts.tier ?? (opts.win ? "line" : "lose");

  return encodeAnimation({
    width: SLOTS_W, height: SLOTS_H, durationMs: 5200, speed: "normal", maxFrames: 48, quality: 16,
    render: async ({ ctx, t }) => {
      felt(ctx, SLOTS_W, SLOTS_H);

      // Machine chrome
      roundRect(ctx, 28, 36, SLOTS_W - 56, 200, 18);
      ctx.fillStyle = "#111827";
      ctx.fill();
      ctx.strokeStyle = "#fbbf24";
      ctx.lineWidth = 3;
      ctx.stroke();

      // Title plate
      ctx.fillStyle = "#fbbf24";
      ctx.font = "bold 18px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("MEGA SLOTS", SLOTS_W / 2, 28);

      const cellW = Math.min(88, (SLOTS_W - 80) / reelCount - 8);
      const totalW = reelCount * (cellW + 8) - 8;
      const startX = (SLOTS_W - totalW) / 2;

      for (let i = 0; i < reelCount; i++) {
        const x = startX + i * (cellW + 8);
        const y = 70;
        roundRect(ctx, x, y, cellW, 140, 12);
        ctx.fillStyle = "#0f172a";
        ctx.fill();

        const stopped = t >= (stopAt[i] ?? 0.85);
        let sym: string;
        if (stopped) {
          sym = opts.reels[i]!;
        } else {
          // Blur-strip scroll before lock
          const scroll = Math.floor(t * 55 + i * 7);
          sym = pool[scroll % pool.length]!;
          // Motion streak
          ctx.fillStyle = "rgba(251, 191, 36, 0.08)";
          ctx.fillRect(x + 4, y + 4, cellW - 8, 132);
        }

        ctx.font = `${Math.floor(cellW * 0.55)}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        // Slight bounce when locking
        const bounce = stopped && t < (stopAt[i]! + 0.06)
          ? Math.sin(((t - stopAt[i]!) / 0.06) * Math.PI) * 6
          : 0;
        ctx.fillText(sym, x + cellW / 2, y + 70 + bounce);
      }

      // Payline
      if (t > 0.4) {
        ctx.strokeStyle = "rgba(251, 191, 36, 0.55)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(startX - 4, 140);
        ctx.lineTo(startX + totalW + 4, 140);
        ctx.stroke();
      }

      // Result banner
      if (t > 0.9) {
        const fade = Math.min(1, (t - 0.9) / 0.08);
        if (tier === "jackpot") {
          ctx.fillStyle = `rgba(251, 191, 36, ${0.9 * fade})`;
          ctx.font = "bold 26px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(`★ JACKPOT ${symbol} ★`, SLOTS_W / 2, 270);
          if (opts.payoutLabel) {
            ctx.fillStyle = `rgba(254, 243, 199, ${fade})`;
            ctx.font = "bold 20px sans-serif";
            ctx.fillText(opts.payoutLabel, SLOTS_W / 2, 300);
          }
        } else if (tier === "line" || tier === "pair") {
          ctx.fillStyle = `rgba(74, 222, 128, ${fade})`;
          ctx.font = "bold 22px sans-serif";
          ctx.textAlign = "center";
          const label = tier === "pair" ? "PAIR PAY" : "LINE WIN";
          ctx.fillText(
            opts.payoutLabel ? `${label} · ${opts.payoutLabel}` : label,
            SLOTS_W / 2,
            280,
          );
        } else {
          ctx.fillStyle = `rgba(148, 163, 184, ${fade})`;
          ctx.font = "bold 20px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText("No line — try again", SLOTS_W / 2, 280);
        }
      } else if (t > 0.15 && t < 0.9) {
        ctx.fillStyle = "#94a3b8";
        ctx.font = "14px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("spinning…", SLOTS_W / 2, 280);
      }
    },
  });
}

export async function renderRussianGif(opts: {
  survived: boolean;
  chamber: number;
}): Promise<AnimationResult | null> {
  return encodeAnimation({
    width: W, height: H, durationMs: 1700, speed: "normal", maxFrames: 20, quality: 12,
    render: async ({ ctx, t }) => {
      felt(ctx);
      const cx = W / 2, cy = H / 2 - 8;
      const spin = t * Math.PI * 5;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(spin);
      ctx.fillStyle = "#64748b";
      ctx.beginPath(); ctx.arc(0, 0, 60, 0, Math.PI * 2); ctx.fill();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        ctx.fillStyle = i === opts.chamber ? "#ef4444" : "#1e293b";
        ctx.beginPath();
        ctx.arc(Math.cos(a) * 34, Math.sin(a) * 34, 12, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      ctx.fillStyle = opts.survived ? "#4ade80" : "#f87171";
      ctx.font = "bold 24px sans-serif";
      ctx.textAlign = "center";
      if (t > 0.72) ctx.fillText(opts.survived ? "CLICK — safe" : "BANG!", cx, H - 32);
      else {
        ctx.fillStyle = "#cbd5e1";
        ctx.font = "16px sans-serif";
        ctx.fillText("spinning…", cx, H - 32);
      }
    },
  });
}

function drawStickBody(ctx: Ctx, x: number, y: number, color: string, run: number) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x, y - 18); ctx.lineTo(x, y + 10);
  ctx.moveTo(x, y - 8); ctx.lineTo(x - 14, y + 4 + Math.sin(run) * 4);
  ctx.moveTo(x, y - 8); ctx.lineTo(x + 14, y + 4 - Math.sin(run) * 4);
  ctx.moveTo(x, y + 10); ctx.lineTo(x - 10, y + 28 + Math.cos(run) * 3);
  ctx.moveTo(x, y + 10); ctx.lineTo(x + 10, y + 28 - Math.cos(run) * 3);
  ctx.stroke();
}

function drawAvatarHead(
  ctx: Ctx,
  img: Awaited<ReturnType<typeof loadArt>>,
  x: number,
  y: number,
  r: number,
) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (img) ctx.drawImage(img as never, x - r, y - r, r * 2, r * 2);
  else {
    ctx.fillStyle = "#475569";
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.restore();
  ctx.strokeStyle = "#0f172a";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
}

async function loadAvatar(mod: CanvasMod, url: string | null | undefined) {
  if (!url) return null;
  return loadArt(mod, url).catch(() => null);
}

export async function renderRobGif(opts: {
  success: boolean;
  thiefAvatarUrl?: string | null;
  victimAvatarUrl?: string | null;
  thiefName?: string;
  victimName?: string;
}): Promise<AnimationResult | null> {
  const mod = await getCanvas();
  if (!mod) return null;
  const [thiefImg, victimImg] = await Promise.all([
    loadAvatar(mod, opts.thiefAvatarUrl),
    loadAvatar(mod, opts.victimAvatarUrl),
  ]);
  const emojiImgs = await preloadEmojiTexts(mod, [opts.thiefName ?? "", opts.victimName ?? ""]);

  return encodeAnimation({
    width: W, height: H, durationMs: 1600, speed: "normal", maxFrames: 18, quality: 12,
    render: async ({ ctx, t }) => {
      felt(ctx);
      const thiefX = opts.success ? 80 + t * 220 : 80 + Math.min(t, 0.55) * 160;
      const headY = 102;
      drawStickBody(ctx, thiefX, 130, "#f472b6", t * 20);
      drawAvatarHead(ctx, thiefImg, thiefX, headY, 16);
      // bandit mask
      ctx.fillStyle = "rgba(15,23,42,0.75)";
      ctx.fillRect(thiefX - 14, headY - 2, 28, 8);
      drawStickBody(ctx, 340, 130, "#60a5fa", 0);
      drawAvatarHead(ctx, victimImg, 340, headY, 16);
      drawTextWithEmojis(ctx, opts.thiefName ?? "thief", thiefX, 175, emojiImgs, {
        font: "11px sans-serif", fillStyle: "#fbcfe8", align: "center", maxWidth: 90, emojiSize: 12,
      });
      drawTextWithEmojis(ctx, opts.victimName ?? "target", 340, 175, emojiImgs, {
        font: "11px sans-serif", fillStyle: "#bfdbfe", align: "center", maxWidth: 90, emojiSize: 12,
      });
      ctx.fillStyle = "#fbbf24";
      ctx.beginPath(); ctx.arc(thiefX + 18, 110, 10, 0, Math.PI * 2); ctx.fill();
      if (!opts.success && t > 0.55) {
        // jail bars slam
        ctx.fillStyle = "rgba(15,23,42,0.55)";
        ctx.fillRect(0, 0, W, H);
        ctx.strokeStyle = "#94a3b8";
        ctx.lineWidth = 6;
        for (let i = 0; i < 8; i++) {
          const x = 40 + i * 55;
          ctx.beginPath(); ctx.moveTo(x, 40); ctx.lineTo(x, H - 40); ctx.stroke();
        }
      }
      ctx.fillStyle = opts.success ? "#4ade80" : "#f87171";
      ctx.font = "bold 20px sans-serif";
      ctx.textAlign = "center";
      if (t > 0.65) ctx.fillText(opts.success ? "GOT AWAY!" : "BUSTED!", W / 2, H - 28);
    },
  });
}

/** Masked bandit heist — Discord avatar on the stick figure; jail on fail. */
export async function renderCrimeGif(opts: {
  success: boolean;
  avatarUrl?: string | null;
  displayName?: string;
  payout?: number;
}): Promise<AnimationResult | null> {
  const mod = await getCanvas();
  if (!mod) return null;
  const av = await loadAvatar(mod, opts.avatarUrl);
  const emojiImgs = await preloadEmojiTexts(mod, [opts.displayName ?? ""]);

  return encodeAnimation({
    width: W, height: H, durationMs: 1800, speed: "normal", maxFrames: 20, quality: 12,
    render: async ({ ctx, t }) => {
      felt(ctx);
      // city silhouette
      ctx.fillStyle = "rgba(15,23,42,0.45)";
      for (let i = 0; i < 6; i++) {
        const bw = 40 + (i % 3) * 12;
        const bh = 40 + ((i * 37) % 80);
        ctx.fillRect(30 + i * 75, H - 70 - bh, bw, bh);
      }

      const run = t * 18;
      const x = opts.success
        ? 60 + t * 280
        : 60 + Math.min(t, 0.5) * 180;
      const y = 140;
      drawStickBody(ctx, x, y, "#fbbf24", run);
      drawAvatarHead(ctx, av, x, y - 28, 18);
      // mask + beanie
      ctx.fillStyle = "#0f172a";
      ctx.beginPath();
      ctx.ellipse(x, y - 40, 16, 8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(15,23,42,0.8)";
      ctx.fillRect(x - 15, y - 30, 30, 9);
      // loot bag
      ctx.fillStyle = "#fbbf24";
      ctx.beginPath();
      ctx.arc(x + 20, y - 6, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#92400e";
      ctx.font = "bold 10px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("$", x + 20, y - 2);

      drawTextWithEmojis(ctx, opts.displayName ?? "bandit", x, y + 48, emojiImgs, {
        font: "bold 13px sans-serif", fillStyle: "#fde68a", align: "center", maxWidth: 140, emojiSize: 14,
      });

      if (opts.success) {
        // dust trail / getaway
        ctx.fillStyle = `rgba(251,191,36,${0.35 * (1 - t)})`;
        for (let i = 0; i < 5; i++) {
          ctx.beginPath();
          ctx.arc(x - 20 - i * 14, y + 20 + Math.sin(t * 20 + i) * 4, 4, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = "#4ade80";
        ctx.font = "bold 22px sans-serif";
        ctx.textAlign = "center";
        if (t > 0.6) {
          ctx.fillText("CLEAN GETAWAY!", W / 2, H - 36);
          if (opts.payout != null) {
            ctx.font = "16px sans-serif";
            ctx.fillStyle = "#a7f3d0";
            ctx.fillText(`+${opts.payout.toLocaleString()} cash`, W / 2, H - 14);
          }
        }
      } else {
        // siren flash → jail
        if (t > 0.35 && t < 0.7) {
          ctx.fillStyle = `rgba(239,68,68,${0.25 + 0.25 * Math.sin(t * 40)})`;
          ctx.fillRect(0, 0, W, H);
        }
        if (t > 0.55) {
          const jailT = Math.min(1, (t - 0.55) / 0.35);
          ctx.fillStyle = `rgba(15,23,42,${0.65 * jailT})`;
          ctx.fillRect(0, 0, W, H);
          ctx.strokeStyle = "#cbd5e1";
          ctx.lineWidth = 7;
          for (let i = 0; i < 9; i++) {
            const bx = 36 + i * 50;
            ctx.beginPath();
            ctx.moveTo(bx, 30);
            ctx.lineTo(bx, H - 30);
            ctx.stroke();
          }
          // locked avatar behind bars
          drawAvatarHead(ctx, av, W / 2, 120, 28);
          ctx.fillStyle = "#f87171";
          ctx.font = "bold 24px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText("BUSTED — JAIL", W / 2, H - 40);
        } else {
          ctx.fillStyle = "#fde68a";
          ctx.font = "bold 16px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText("Committing the crime…", W / 2, H - 28);
        }
      }
    },
  });
}

export async function renderBegGif(): Promise<AnimationResult | null> {
  return encodeAnimation({
    width: W, height: H, durationMs: 1400, speed: "normal", maxFrames: 16, quality: 12,
    render: async ({ ctx, t }) => {
      felt(ctx);
      ctx.fillStyle = "#fef3c7";
      roundRect(ctx, 110, 40, 260, 70, 10);
      ctx.fill();
      ctx.fillStyle = "#92400e";
      ctx.font = "bold 18px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("pls spare some cash?", W / 2, 70);
      ctx.font = "14px sans-serif";
      ctx.fillText("(PG · dramatic beg)", W / 2, 94);
      const bob = Math.sin(t * Math.PI * 4) * 4;
      ctx.strokeStyle = "#f9a8d4";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(W / 2, 160 + bob, 12, 0, Math.PI * 2);
      ctx.moveTo(W / 2, 172 + bob); ctx.lineTo(W / 2, 200);
      ctx.moveTo(W / 2, 180 + bob); ctx.lineTo(W / 2 - 30, 165 + bob);
      ctx.moveTo(W / 2, 180 + bob); ctx.lineTo(W / 2 + 30, 165 + bob);
      ctx.stroke();
      ctx.fillStyle = "#facc15";
      for (let i = 0; i < 5; i++) {
        const x = 70 + i * 80;
        const y = 230 - ((t * 80 + i * 20) % 60);
        ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fill();
      }
    },
  });
}

export async function renderWorkGif(opts: { payout: number }): Promise<AnimationResult | null> {
  return encodeAnimation({
    width: W, height: 200, durationMs: 1000, speed: "normal", maxFrames: 12, quality: 12,
    render: async ({ ctx, t }) => {
      felt(ctx);
      ctx.fillStyle = "#fde68a";
      ctx.font = "bold 22px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("SHIFT COMPLETE", W / 2, 70);
      ctx.fillStyle = "#a7f3d0";
      ctx.font = "18px sans-serif";
      if (t > 0.3) ctx.fillText(`+${opts.payout} cash`, W / 2, 120);
    },
  });
}
