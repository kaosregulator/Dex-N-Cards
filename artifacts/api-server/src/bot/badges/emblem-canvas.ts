/**
 * Animated shiny badge emblem GIF — evolves visually by level tier.
 * Center uses geometric sigils (canvas-safe) so we never depend on emoji fonts.
 * No diamonds / cash metaphors: light, aurora, corona, nebula, apex flare.
 */

import {
  encodeAnimation,
  hexToRgba,
  clamp01,
  easeOutBack,
  TITLE_FONT_FAMILY,
  type Ctx,
} from "../animations/engine.js";
import { seededRng } from "../animations/particles.js";
import { tierForLevel, type BadgeTier, BADGE_LEVEL_MAX } from "../../lib/badges/levels.js";
import { logger } from "../../lib/logger.js";

/** Landscape — fits Discord embed image width cleanly. */
const W = 640;
const H = 280;

export type EmblemRenderOpts = {
  name: string;
  emoji: string;
  level: number;
  subtitle?: string | null;
  seed?: string;
};

type SigilKind = "mind" | "bolt" | "sun" | "spiral" | "orbit" | "flame" | "crest";

function sigilFor(name: string, emoji: string): SigilKind {
  const key = `${name} ${emoji}`.toLowerCase();
  // More specific names first (brainiac before brain/trivia).
  if (/brainiac|🟣|spiral|🌀/.test(key)) return "spiral";
  if (/flash|bolt|⚡|zap|spark/.test(key)) return "bolt";
  if (/qotd|sun|☀️|day/.test(key)) return "sun";
  if (/friend|helper|🤝|orbit|chat|💬/.test(key)) return "orbit";
  if (/fire|streak|🔥|flame|creative|🎨/.test(key)) return "flame";
  if (/star|⭐|leader|👑/.test(key)) return "crest";
  if (/trivia|wise|owl|mind|brain|🍪|cookie/.test(key)) return "mind";
  return "crest";
}

function drawStarField(ctx: Ctx, t: number, seed: string, density: number, color: number): void {
  const rng = seededRng(`${seed}-stars`);
  for (let i = 0; i < density; i++) {
    const x = rng.range(8, W - 8);
    const y = rng.range(8, H - 8);
    const twinkle = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2 + i * 0.7));
    const r = rng.range(0.6, 1.8);
    ctx.fillStyle = hexToRgba(color, 0.15 + twinkle * 0.55);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawHex(ctx: Ctx, cx: number, cy: number, radius: number): void {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 3;
    const x = cx + Math.cos(a) * radius;
    const y = cy + Math.sin(a) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawOrbitSparks(
  ctx: Ctx,
  cx: number,
  cy: number,
  radius: number,
  t: number,
  count: number,
  color: number,
): void {
  for (let i = 0; i < count; i++) {
    const a = t * Math.PI * 2 + (i / count) * Math.PI * 2;
    const pulse = 0.55 + 0.45 * Math.sin(t * Math.PI * 4 + i);
    const x = cx + Math.cos(a) * radius;
    const y = cy + Math.sin(a) * (radius * 0.72);
    ctx.fillStyle = hexToRgba(color, 0.35 + pulse * 0.55);
    ctx.beginPath();
    ctx.arc(x, y, 2.2 + pulse * 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawLightSweep(ctx: Ctx, cx: number, cy: number, radius: number, t: number): void {
  const angle = -0.4 + t * Math.PI * 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  const grad = ctx.createLinearGradient(-radius, 0, radius, 0);
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(0.45, "rgba(255,255,255,0)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.55)");
  grad.addColorStop(0.55, "rgba(255,255,255,0)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(0, 0, radius * 0.95, radius * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function glowStroke(ctx: Ctx, color: number, width: number, alpha: number): void {
  ctx.strokeStyle = hexToRgba(color, alpha);
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
}

function drawSigil(
  ctx: Ctx,
  kind: SigilKind,
  cx: number,
  cy: number,
  scale: number,
  t: number,
  accent: number,
  glow: number,
): void {
  const pulse = 1 + 0.04 * Math.sin(t * Math.PI * 2);
  const s = scale * pulse;
  ctx.save();
  ctx.translate(cx, cy);

  // Soft core glow
  const core = ctx.createRadialGradient(0, 0, 2, 0, 0, s * 0.85);
  core.addColorStop(0, hexToRgba(glow, 0.55));
  core.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(0, 0, s * 0.85, 0, Math.PI * 2);
  ctx.fill();

  glowStroke(ctx, accent, 3.2, 0.95);

  if (kind === "mind") {
    // Neural triad — three nodes linked
    const nodes = [
      [0, -s * 0.42],
      [-s * 0.38, s * 0.28],
      [s * 0.38, s * 0.28],
    ] as const;
    for (const [x, y] of nodes) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    glowStroke(ctx, glow, 2.2, 0.85);
    for (const [x, y] of nodes) {
      ctx.beginPath();
      ctx.arc(x, y, s * 0.12, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(accent, 0.95);
      ctx.fill();
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(0, 0, s * 0.14, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(0xffffff, 0.9);
    ctx.fill();
  } else if (kind === "bolt") {
    ctx.beginPath();
    ctx.moveTo(-s * 0.12, -s * 0.5);
    ctx.lineTo(s * 0.18, -s * 0.05);
    ctx.lineTo(s * 0.02, -s * 0.05);
    ctx.lineTo(s * 0.22, s * 0.5);
    ctx.lineTo(-s * 0.16, s * 0.02);
    ctx.lineTo(s * 0.02, s * 0.02);
    ctx.closePath();
    ctx.fillStyle = hexToRgba(accent, 0.92);
    ctx.fill();
    ctx.strokeStyle = hexToRgba(0xffffff, 0.55);
    ctx.lineWidth = 1.5;
    ctx.stroke();
  } else if (kind === "sun") {
    const rays = 10;
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI * 2 + t * 0.6;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * s * 0.28, Math.sin(a) * s * 0.28);
      ctx.lineTo(Math.cos(a) * s * 0.55, Math.sin(a) * s * 0.55);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(0, 0, s * 0.22, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(accent, 0.95);
    ctx.fill();
    ctx.strokeStyle = hexToRgba(0xffffff, 0.5);
    ctx.lineWidth = 2;
    ctx.stroke();
  } else if (kind === "spiral") {
    ctx.beginPath();
    for (let i = 0; i <= 60; i++) {
      const p = i / 60;
      const a = p * Math.PI * 3.2 + t * Math.PI * 2;
      const r = s * 0.08 + p * s * 0.48;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, s * 0.1, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(glow, 0.95);
    ctx.fill();
  } else if (kind === "orbit") {
    ctx.beginPath();
    ctx.ellipse(0, 0, s * 0.48, s * 0.22, t * Math.PI, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0, 0, s * 0.22, s * 0.48, -t * Math.PI, 0, Math.PI * 2);
    glowStroke(ctx, glow, 2.4, 0.8);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, s * 0.12, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(accent, 0.95);
    ctx.fill();
  } else if (kind === "flame") {
    ctx.beginPath();
    ctx.moveTo(0, s * 0.48);
    ctx.bezierCurveTo(-s * 0.4, s * 0.1, -s * 0.28, -s * 0.2, 0, -s * 0.52);
    ctx.bezierCurveTo(s * 0.28, -s * 0.2, s * 0.4, s * 0.1, 0, s * 0.48);
    ctx.closePath();
    ctx.fillStyle = hexToRgba(accent, 0.9);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, s * 0.28);
    ctx.bezierCurveTo(-s * 0.16, s * 0.05, -s * 0.1, -s * 0.05, 0, -s * 0.22);
    ctx.bezierCurveTo(s * 0.1, -s * 0.05, s * 0.16, s * 0.05, 0, s * 0.28);
    ctx.fillStyle = hexToRgba(0xffffff, 0.55);
    ctx.fill();
  } else {
    // Crest — six-point radiant (not a diamond)
    const points = 6;
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / points;
      const r = i % 2 === 0 ? s * 0.5 : s * 0.22;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = hexToRgba(accent, 0.9);
    ctx.fill();
    ctx.strokeStyle = hexToRgba(0xffffff, 0.45);
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, s * 0.1, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(0xffffff, 0.85);
    ctx.fill();
  }

  ctx.restore();
}

function medallionPalette(tier: BadgeTier): { bg0: string; bg1: string; metal: number } {
  switch (tier.key) {
    case "kindling":
      return { bg0: "#1a120c", bg1: "#3a2416", metal: 0xd4a574 };
    case "aurora":
      return { bg0: "#0a1628", bg1: "#1a3a5c", metal: 0x7dd3fc };
    case "radiant":
      return { bg0: "#1a1408", bg1: "#4a3210", metal: 0xffd166 };
    case "eclipse":
      return { bg0: "#0c0618", bg1: "#2a1048", metal: 0xc4b5fd };
    case "celestial":
      return { bg0: "#061820", bg1: "#123848", metal: 0x99f6e4 };
    case "apex":
      return { bg0: "#140810", bg1: "#3a1028", metal: 0xffe66d };
  }
}

export async function renderBadgeEmblemGif(opts: EmblemRenderOpts): Promise<Buffer | null> {
  const level = Math.max(1, Math.min(BADGE_LEVEL_MAX, Math.floor(opts.level || 1)));
  const tier = tierForLevel(level);
  const seed = opts.seed ?? `${opts.name}-${level}-${tier.key}`;
  const palette = medallionPalette(tier);
  const sigil = sigilFor(opts.name, opts.emoji);

  try {
    const result = await encodeAnimation({
      width: W,
      height: H,
      speed: "normal",
      durationMs: tier.key === "apex" ? 2400 : 2000,
      maxFrames: tier.key === "kindling" ? 16 : 22,
      quality: 12,
      render: async ({ ctx, t }) => {
        const pop = easeOutBack(clamp01(t * 1.5));

        const bg = ctx.createLinearGradient(0, 0, W, H);
        bg.addColorStop(0, palette.bg0);
        bg.addColorStop(1, palette.bg1);
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);

        const vig = ctx.createRadialGradient(150, H / 2, 30, W / 2, H / 2, 340);
        vig.addColorStop(0, "rgba(0,0,0,0)");
        vig.addColorStop(1, "rgba(0,0,0,0.5)");
        ctx.fillStyle = vig;
        ctx.fillRect(0, 0, W, H);

        const starCount = tier.key === "kindling" ? 16
          : tier.key === "aurora" ? 24
          : tier.key === "radiant" ? 32
          : tier.key === "eclipse" ? 38
          : tier.key === "celestial" ? 48
          : 60;
        drawStarField(ctx, t, seed, starCount, tier.glow);

        // Medallion on the left — text block on the right (landscape embed).
        const cx = 150;
        const cy = H / 2;
        const baseR = 78 * (0.92 + 0.08 * pop);

        const bloom = ctx.createRadialGradient(cx, cy, baseR * 0.2, cx, cy, baseR * 1.85);
        bloom.addColorStop(0, hexToRgba(tier.glow, 0.35 + 0.2 * Math.sin(t * Math.PI * 2)));
        bloom.addColorStop(0.55, hexToRgba(tier.accent, 0.12));
        bloom.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = bloom;
        ctx.beginPath();
        ctx.arc(cx, cy, baseR * 1.85, 0, Math.PI * 2);
        ctx.fill();

        if (tier.minLevel >= 10) {
          drawOrbitSparks(ctx, cx, cy, baseR + 24, t, tier.key === "apex" ? 12 : 7, tier.accent);
        }
        if (tier.minLevel >= 50) {
          drawOrbitSparks(ctx, cx, cy, baseR + 38, 1 - t, 5, tier.glow);
        }

        ctx.save();
        ctx.globalAlpha = clamp01(0.85 + 0.15 * pop);
        drawHex(ctx, cx, cy, baseR);
        const metal = ctx.createLinearGradient(cx - baseR, cy - baseR, cx + baseR, cy + baseR);
        metal.addColorStop(0, hexToRgba(palette.metal, 0.95));
        metal.addColorStop(0.45, hexToRgba(tier.accent, 0.9));
        metal.addColorStop(1, hexToRgba(tier.glow, 0.85));
        ctx.fillStyle = metal;
        ctx.fill();

        drawHex(ctx, cx, cy, baseR * 0.78);
        ctx.fillStyle = "rgba(12, 14, 22, 0.9)";
        ctx.fill();

        drawHex(ctx, cx, cy, baseR);
        ctx.strokeStyle = hexToRgba(0xffffff, 0.35 + 0.25 * Math.sin(t * Math.PI * 2));
        ctx.lineWidth = tier.key === "apex" ? 5 : 3.5;
        ctx.stroke();
        drawHex(ctx, cx, cy, baseR * 0.78);
        ctx.strokeStyle = hexToRgba(tier.accent, 0.75);
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();

        ctx.save();
        drawHex(ctx, cx, cy, baseR * 0.76);
        ctx.clip();
        drawLightSweep(ctx, cx, cy, baseR, t);
        if (tier.minLevel >= 75) {
          drawLightSweep(ctx, cx, cy, baseR, (t + 0.33) % 1);
        }
        ctx.restore();

        drawSigil(ctx, sigil, cx, cy, 46, t, tier.accent, tier.glow);

        const ticks = 12;
        for (let i = 0; i < ticks; i++) {
          const a = -Math.PI / 2 + (i / ticks) * Math.PI * 2 + t * 0.15;
          const on = i / ticks <= level / BADGE_LEVEL_MAX;
          const r0 = baseR + 8;
          const r1 = baseR + (on ? 16 : 12);
          ctx.strokeStyle = hexToRgba(on ? tier.accent : 0xffffff, on ? 0.85 : 0.15);
          ctx.lineWidth = on ? 2.2 : 1.1;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
          ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
          ctx.stroke();
        }

        // Right-side copy
        const textX = 290;
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";

        ctx.fillStyle = "rgba(255,255,255,0.45)";
        ctx.font = `bold 12px ${TITLE_FONT_FAMILY}, sans-serif`;
        ctx.fillText("EMBLEM", textX, 72);

        ctx.fillStyle = "#ffffff";
        ctx.font = `bold 28px ${TITLE_FONT_FAMILY}, sans-serif`;
        ctx.fillText((opts.name || "Badge").slice(0, 26), textX, 110);

        ctx.fillStyle = hexToRgba(tier.accent, 0.95);
        ctx.font = "bold 20px sans-serif";
        ctx.fillText(`Lv. ${level}  ·  ${tier.label}`, textX, 148);

        const sub = opts.subtitle?.slice(0, 48)
          || "Evolves as you participate — no roles, no cash";
        ctx.fillStyle = "rgba(255,255,255,0.6)";
        ctx.font = "14px sans-serif";
        ctx.fillText(sub, textX, 180);

        // Progress ticks under text
        const barW = 280;
        const filled = Math.round((level / BADGE_LEVEL_MAX) * barW);
        ctx.fillStyle = "rgba(255,255,255,0.12)";
        ctx.fillRect(textX, 208, barW, 8);
        const barGrad = ctx.createLinearGradient(textX, 0, textX + barW, 0);
        barGrad.addColorStop(0, hexToRgba(tier.accent, 0.95));
        barGrad.addColorStop(1, hexToRgba(tier.glow, 0.95));
        ctx.fillStyle = barGrad;
        ctx.fillRect(textX, 208, Math.max(4, filled), 8);
      },
    });
    return result?.buffer ?? null;
  } catch (err) {
    logger.warn({ err, level, tier: tier.key }, "badge emblem gif failed");
    return null;
  }
}
