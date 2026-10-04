// Mario/Sonic-style reverse coin collect — rings/coins fly INTO the wallet.
// Used by /casino daily and /casino collect.

import { encodeAnimation, type Ctx } from "../animations/engine.js";
import type { AnimationResult } from "../animations/types.js";

const W = 520;
const H = 320;

type Particle = {
  ox: number;
  oy: number;
  phase: number;
  size: number;
  kind: "coin" | "ring";
};

function seeded(n: number) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function buildParticles(count: number): Particle[] {
  const out: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const a = seeded(i * 3.1) * Math.PI * 2;
    const r = 70 + seeded(i * 7.7) * 160;
    out.push({
      ox: W / 2 + Math.cos(a) * r,
      oy: H / 2 - 10 + Math.sin(a) * r * 0.72,
      phase: seeded(i * 1.9),
      size: 7 + seeded(i * 4.2) * 9,
      kind: i % 3 === 0 ? "ring" : "coin",
    });
  }
  return out;
}

function drawCoin(ctx: Ctx, x: number, y: number, r: number, squash: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(squash, 1);
  ctx.fillStyle = "#f5c84c";
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#c9922a";
  ctx.beginPath(); ctx.arc(0, 0, r * 0.62, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#fff6c8";
  ctx.font = `bold ${Math.max(10, Math.floor(r))}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("$", 0, 1);
  ctx.restore();
}

function drawRing(ctx: Ctx, x: number, y: number, r: number) {
  ctx.strokeStyle = "#fbbf24";
  ctx.lineWidth = Math.max(2, r * 0.28);
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = "#fde68a";
  ctx.lineWidth = Math.max(1, r * 0.12);
  ctx.beginPath(); ctx.arc(x, y, r * 0.72, 0, Math.PI * 2); ctx.stroke();
}

function easeInCubic(t: number) {
  return t * t * t;
}

function wallet(ctx: Ctx, cx: number, cy: number, open: number) {
  // Soft glow
  ctx.fillStyle = `rgba(245, 200, 76, ${0.12 + open * 0.18})`;
  ctx.beginPath(); ctx.arc(cx, cy, 54 + open * 10, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = "#1e3a5f";
  ctx.beginPath();
  ctx.moveTo(cx - 48, cy - 10);
  ctx.lineTo(cx + 48, cy - 10);
  ctx.lineTo(cx + 42, cy + 34);
  ctx.lineTo(cx - 42, cy + 34);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#2a4f7a";
  ctx.fillRect(cx - 48, cy - 22 - open * 8, 96, 18);

  ctx.fillStyle = "#f5c84c";
  ctx.beginPath(); ctx.arc(cx + 28, cy + 8, 6, 0, Math.PI * 2); ctx.fill();
}

/**
 * Coins/rings scatter around the wallet, then reverse-collect inward while
 * the balance count-up animates. Mario/Sonic energy — collection, not payout.
 */
export async function renderCoinCollectGif(opts: {
  amount: number;
  symbol: string;
  newCash: number;
  newBank: number;
  title?: string;
  roleLines?: string[];
}): Promise<AnimationResult | null> {
  const particles = buildParticles(22);
  const title = opts.title ?? "COLLECTED";
  const label = opts.symbol.length <= 4 ? opts.symbol : "💵";

  return encodeAnimation({
    width: W, height: H, durationMs: 2400, speed: "normal", maxFrames: 28, quality: 12,
    render: async ({ ctx, t }) => {
      // Velvet casino backdrop
      ctx.fillStyle = "#0a1628";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#0d2137";
      ctx.fillRect(12, 12, W - 24, H - 24);
      ctx.strokeStyle = "#c9a227";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.rect(18, 18, W - 36, H - 36);
      ctx.stroke();

      const cx = W / 2;
      const cy = H / 2 + 18;
      const gather = Math.min(1, Math.max(0, (t - 0.18) / 0.55));
      const g = easeInCubic(gather);
      const open = t < 0.75 ? Math.sin(t * Math.PI * 2) * 0.5 + 0.5 : 1;

      wallet(ctx, cx, cy, open);

      for (const p of particles) {
        const localT = Math.min(1, Math.max(0, (gather - p.phase * 0.15) / 0.85));
        const eg = easeInCubic(localT);
        const x = p.ox + (cx - p.ox) * eg;
        const y = p.oy + (cy - 6 - p.oy) * eg;
        const fade = 1 - eg * 0.85;
        if (fade < 0.05) continue;
        ctx.globalAlpha = fade;
        const squash = 0.55 + Math.abs(Math.cos((t + p.phase) * Math.PI * 6)) * 0.45;
        if (p.kind === "ring") drawRing(ctx, x, y, p.size * (1 - eg * 0.4));
        else drawCoin(ctx, x, y, p.size * (1 - eg * 0.35), squash);
        ctx.globalAlpha = 1;
      }

      // Title + amount
      ctx.fillStyle = "#fde68a";
      ctx.font = "bold 22px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(title, cx, 42);

      const shownAmt = Math.floor(opts.amount * Math.min(1, t / 0.85));
      ctx.fillStyle = "#4ade80";
      ctx.font = "bold 28px sans-serif";
      ctx.fillText(`+${shownAmt.toLocaleString()} ${label}`, cx, 74);

      if (opts.roleLines?.length && t > 0.35) {
        ctx.fillStyle = "#94a3b8";
        ctx.font = "12px sans-serif";
        const lines = opts.roleLines.slice(0, 3);
        if (opts.roleLines.length > 3) {
          lines[2] = `${opts.roleLines.length} roles total`;
        }
        lines.forEach((line, i) => {
          ctx.fillText(line.slice(0, 58), cx, 96 + i * 15);
        });
      }

      if (t > 0.7) {
        const balT = Math.min(1, (t - 0.7) / 0.3);
        const cashShow = Math.floor(opts.newCash * balT + opts.newCash * (1 - balT) * 0.92);
        ctx.fillStyle = "#e2e8f0";
        ctx.font = "bold 16px sans-serif";
        ctx.fillText(
          `Wallet  cash ${cashShow.toLocaleString()}  ·  bank ${opts.newBank.toLocaleString()}`,
          cx,
          H - 36,
        );
      }
    },
  });
}

/** Deposit animation — cash stacks slide into a bank vault. */
export async function renderDepositGif(opts: {
  amount: number;
  symbol: string;
  newCash: number;
  newBank: number;
}): Promise<AnimationResult | null> {
  const label = opts.symbol.length <= 4 ? opts.symbol : "💵";
  return encodeAnimation({
    width: W, height: 260, durationMs: 1800, speed: "normal", maxFrames: 22, quality: 12,
    render: async ({ ctx, t }) => {
      ctx.fillStyle = "#0a1628";
      ctx.fillRect(0, 0, W, 260);
      ctx.fillStyle = "#c9a227";
      ctx.font = "bold 20px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("CASINO DEPOSIT", W / 2, 36);

      // Cash stack left → vault right
      const x = 80 + t * 260;
      drawCoin(ctx, x, 120, 22, 0.7 + Math.abs(Math.cos(t * Math.PI * 4)) * 0.3);
      drawCoin(ctx, x - 14, 132, 18, 0.8);
      drawCoin(ctx, x + 12, 136, 16, 0.75);

      // Vault
      ctx.fillStyle = "#334155";
      ctx.fillRect(360, 70, 110, 110);
      ctx.fillStyle = "#64748b";
      ctx.beginPath(); ctx.arc(415, 125, 28, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#f5c84c";
      ctx.beginPath(); ctx.arc(415, 125, 10, 0, Math.PI * 2); ctx.fill();

      if (t > 0.55) {
        ctx.fillStyle = "#4ade80";
        ctx.font = "bold 22px sans-serif";
        ctx.fillText(`+${opts.amount.toLocaleString()} → bank`, W / 2, 210);
        ctx.fillStyle = "#94a3b8";
        ctx.font = "14px sans-serif";
        ctx.fillText(
          `cash ${opts.newCash.toLocaleString()} ${label} · bank ${opts.newBank.toLocaleString()}`,
          W / 2,
          236,
        );
      }
    },
  });
}

export async function renderWithdrawGif(opts: {
  amount: number;
  symbol: string;
  newCash: number;
  newBank: number;
}): Promise<AnimationResult | null> {
  const label = opts.symbol.length <= 4 ? opts.symbol : "💵";
  return encodeAnimation({
    width: W, height: 260, durationMs: 1800, speed: "normal", maxFrames: 22, quality: 12,
    render: async ({ ctx, t }) => {
      ctx.fillStyle = "#0a1628";
      ctx.fillRect(0, 0, W, 260);
      ctx.fillStyle = "#c9a227";
      ctx.font = "bold 20px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("CASINO WITHDRAW", W / 2, 36);

      const x = 420 - t * 260;
      ctx.fillStyle = "#334155";
      ctx.fillRect(40, 70, 110, 110);
      ctx.fillStyle = "#64748b";
      ctx.beginPath(); ctx.arc(95, 125, 28, 0, Math.PI * 2); ctx.fill();

      drawCoin(ctx, x, 120, 22, 0.7 + Math.abs(Math.cos(t * Math.PI * 4)) * 0.3);
      drawCoin(ctx, x + 16, 134, 16, 0.8);

      if (t > 0.55) {
        ctx.fillStyle = "#4ade80";
        ctx.font = "bold 22px sans-serif";
        ctx.fillText(`bank → +${opts.amount.toLocaleString()} cash`, W / 2, 210);
        ctx.fillStyle = "#94a3b8";
        ctx.font = "14px sans-serif";
        ctx.fillText(
          `cash ${opts.newCash.toLocaleString()} ${label} · bank ${opts.newBank.toLocaleString()}`,
          W / 2,
          236,
        );
      }
    },
  });
}
