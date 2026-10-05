// Mario/Sonic-style reverse coin collect — rings/coins fly INTO the wallet.
// Used by /casino daily and /casino collect.

import { encodeAnimation, type Ctx } from "../animations/engine.js";
import type { AnimationResult } from "../animations/types.js";
import {
  drawCurrencyIcon,
  loadCurrencyImage,
  loadImageUrl,
  symbolDisplayName,
} from "./currency-canvas.js";

const W = 560;

type Particle = {
  ox: number;
  oy: number;
  phase: number;
  size: number;
  kind: "coin" | "ring";
};

export type CollectBoardRole = {
  name: string;
  income: number;
  /** Unicode or `<:name:id>` — loaded as image on the board */
  emoji?: string;
  /** Uploaded GIF / Discord emoji CDN / role icon — preferred over emoji markup */
  imageUrl?: string;
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
      oy: H_BASE / 2 - 10 + Math.sin(a) * r * 0.72,
      phase: seeded(i * 1.9),
      size: 7 + seeded(i * 4.2) * 9,
      kind: i % 3 === 0 ? "ring" : "coin",
    });
  }
  return out;
}

const H_BASE = 320;

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

function boardHeight(roleCount: number): number {
  const n = Math.min(12, Math.max(0, roleCount));
  // Header + amount + role rows + wallet + footer
  return Math.min(720, 280 + n * 28 + (n > 0 ? 40 : 0));
}

/**
 * Coins/rings scatter around the wallet, then reverse-collect inward while
 * the balance count-up animates. Lists every collected role with its icon.
 */
export async function renderCoinCollectGif(opts: {
  amount: number;
  symbol: string;
  newCash: number;
  newBank: number;
  title?: string;
  /** @deprecated prefer `roles` */
  roleLines?: string[];
  roles?: CollectBoardRole[];
}): Promise<AnimationResult | null> {
  const roles: CollectBoardRole[] = opts.roles?.length
    ? opts.roles
    : (opts.roleLines ?? []).map(line => ({ name: line, income: 0 }));

  const H = boardHeight(roles.length);
  const particles = buildParticles(18);
  // Re-seed particle origins for taller boards
  for (let i = 0; i < particles.length; i++) {
    const a = seeded(i * 3.1) * Math.PI * 2;
    const r = 60 + seeded(i * 7.7) * Math.min(140, H * 0.35);
    particles[i]!.ox = W / 2 + Math.cos(a) * r;
    particles[i]!.oy = H * 0.55 + Math.sin(a) * r * 0.55;
  }

  const title = opts.title ?? "COLLECTED";
  const { getCanvas } = await import("../animations/engine.js");
  const mod = await getCanvas();
  if (!mod) return null;
  const symbolImg = await loadCurrencyImage(mod, opts.symbol);
  const roleImgs = await Promise.all(
    roles.map(async (r) => {
      if (r.imageUrl) {
        const fromUrl = await loadImageUrl(mod, r.imageUrl);
        if (fromUrl) return fromUrl;
      }
      if (r.emoji) return loadCurrencyImage(mod, r.emoji, { preferAnimated: true });
      return null;
    }),
  );

  const cashLabel = symbolDisplayName(opts.symbol);

  return encodeAnimation({
    width: W, height: H, durationMs: 2600, speed: "normal", maxFrames: 30, quality: 12,
    render: async ({ ctx, t }) => {
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
      const listTop = 108;
      const listH = Math.min(roles.length, 12) * 28;
      const walletCy = Math.min(H - 70, listTop + listH + 70);

      const gather = Math.min(1, Math.max(0, (t - 0.15) / 0.55));
      const open = t < 0.75 ? Math.sin(t * Math.PI * 2) * 0.5 + 0.5 : 1;

      wallet(ctx, cx, walletCy, open);

      for (const p of particles) {
        const localT = Math.min(1, Math.max(0, (gather - p.phase * 0.15) / 0.85));
        const eg = easeInCubic(localT);
        const x = p.ox + (cx - p.ox) * eg;
        const y = p.oy + (walletCy - 6 - p.oy) * eg;
        const fade = 1 - eg * 0.85;
        if (fade < 0.05) continue;
        ctx.globalAlpha = fade;
        const squash = 0.55 + Math.abs(Math.cos((t + p.phase) * Math.PI * 6)) * 0.45;
        if (p.kind === "ring") drawRing(ctx, x, y, p.size * (1 - eg * 0.4));
        else drawCoin(ctx, x, y, p.size * (1 - eg * 0.35), squash);
        ctx.globalAlpha = 1;
      }

      ctx.fillStyle = "#fde68a";
      ctx.font = "bold 22px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(title, cx, 40);

      const shownAmt = Math.floor(opts.amount * Math.min(1, t / 0.85));
      ctx.fillStyle = "#4ade80";
      ctx.font = "bold 28px sans-serif";
      const amtText = `+${shownAmt.toLocaleString()}`;
      ctx.fillText(amtText, cx - 18, 72);
      drawCurrencyIcon(ctx, symbolImg, opts.symbol, cx + ctx.measureText(amtText).width / 2 + 6, 72, 26);

      if (roles.length && t > 0.28) {
        const show = roles.slice(0, 12);
        show.forEach((role, i) => {
          const y = listTop + i * 28;
          const img = roleImgs[i] ?? null;
          const left = 48;
          drawCurrencyIcon(ctx, img, role.emoji || "✨", left + 10, y, 20);
          ctx.fillStyle = "#e2e8f0";
          ctx.font = "bold 14px sans-serif";
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          const name = role.name.slice(0, 28);
          ctx.fillText(name, left + 28, y);
          ctx.fillStyle = "#4ade80";
          ctx.textAlign = "right";
          const sign = role.income >= 0 ? "+" : "";
          ctx.fillText(`${sign}${role.income.toLocaleString()}`, W - 48, y);
        });
        if (roles.length > 12) {
          ctx.fillStyle = "#94a3b8";
          ctx.font = "12px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(`+${roles.length - 12} more roles`, cx, listTop + 12 * 28);
        }
      }

      if (t > 0.72) {
        const balT = Math.min(1, (t - 0.72) / 0.28);
        const cashShow = Math.floor(opts.newCash * balT + opts.newCash * (1 - balT) * 0.92);
        ctx.fillStyle = "#e2e8f0";
        ctx.font = "bold 14px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(
          `Wallet  cash ${cashShow.toLocaleString()} ${cashLabel}  ·  bank ${opts.newBank.toLocaleString()}`,
          cx,
          H - 32,
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
  const label = symbolDisplayName(opts.symbol);
  return encodeAnimation({
    width: W, height: 260, durationMs: 1800, speed: "normal", maxFrames: 22, quality: 12,
    render: async ({ ctx, t }) => {
      ctx.fillStyle = "#0a1628";
      ctx.fillRect(0, 0, W, 260);
      ctx.fillStyle = "#c9a227";
      ctx.font = "bold 20px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("CASINO DEPOSIT", W / 2, 36);

      const x = 80 + t * 260;
      drawCoin(ctx, x, 120, 22, 0.7 + Math.abs(Math.cos(t * Math.PI * 4)) * 0.3);
      drawCoin(ctx, x - 14, 132, 18, 0.8);
      drawCoin(ctx, x + 12, 136, 16, 0.75);

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
  const label = symbolDisplayName(opts.symbol);
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
