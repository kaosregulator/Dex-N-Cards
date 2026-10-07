// ─────────────────────────────────────────────────────────────────────────────
// User-Hub header banner — a generated canvas that fronts the Progression page.
//
// Draws the player's Discord avatar, account level + XP bar, and a compact row
// of key stats onto one banner image. Theming is pulled from the avatar's
// dominant colour (one download, shared with the portrait) blended with the
// existing rarity palette — it augments, never replaces, what's already there.
//
// Best-effort: if @napi-rs/canvas isn't available or a draw throws, it returns
// null and the caller falls back to the plain embed (no header image).
// ─────────────────────────────────────────────────────────────────────────────

import { getCanvas, hexToRgba, roundRectPath, drawGradientBackground, type Ctx, type CanvasMod } from "../animations/engine.js";
import { drawTextWithShadow, fitText } from "../animations/effects.js";
import { queueRender } from "../animations/render-queue.js";
import { dominantColorFromBuffer, shrinkArtBuffer } from "../images/raster.js";
import { logger } from "../../lib/logger.js";

export const HUB_HEADER = { width: 900, height: 260 } as const;
export const HUB_HEADER_FILE = "hub-header.png";

export interface HubHeaderInput {
  username: string;
  avatarUrl: string | null;
  level: number;
  xp: number;
  xpInto: number;      // xp into the current level
  xpSpan: number;      // xp needed to reach next level
  stats: { label: string; value: string; emoji: string }[]; // up to 4 chips
  accent?: number | null; // optional pre-resolved accent; else derived from avatar
}

// One fetch for both the portrait and its accent. Avatars are drawn at 168px;
// shrinking first keeps a 4096px Discord CDN image from landing in Skia whole.
async function loadAvatar(mod: CanvasMod, url: string | null): Promise<{
  img: Awaited<ReturnType<CanvasMod["loadImage"]>> | null;
  accent: number | null;
}> {
  if (!url) return { img: null, accent: null };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { img: null, accent: null };
    const raw = Buffer.from(await res.arrayBuffer());
    const png = await shrinkArtBuffer(raw, 384);
    if (!png) return { img: null, accent: null };
    const [img, accent] = await Promise.all([
      mod.loadImage(png),
      dominantColorFromBuffer(png),
    ]);
    return { img, accent };
  } catch (err) {
    logger.debug({ err }, "hub-header: avatar load failed");
    return { img: null, accent: null };
  }
}

export async function renderHubHeader(input: HubHeaderInput): Promise<Buffer | null> {
  return queueRender("hub-header", async () => {
  const mod = await getCanvas();
  if (!mod) return null;
  const { width, height } = HUB_HEADER;
  try {
    const avatar = await loadAvatar(mod, input.avatarUrl);
    const accent = input.accent ?? avatar.accent ?? 0x5865f2;
    const canvas = mod.createCanvas(width, height);
    const ctx = canvas.getContext("2d") as unknown as Ctx;

    // Background: accent-tinted gradient with a soft vignette.
    drawGradientBackground(ctx, width, height, [
      [0, hexToRgba(accent, 0.5)],
      [0.55, "#0d1017"],
      [1, "#070810"],
    ], 0.35);

    // Avatar (circular) on the left.
    const av = 168, ax = 46, ay = (height - av) / 2;
    const img = avatar.img;
    ctx.save();
    ctx.beginPath();
    ctx.arc(ax + av / 2, ay + av / 2, av / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    if (img) {
      ctx.drawImage(img, ax, ay, av, av);
    } else {
      ctx.fillStyle = hexToRgba(accent, 0.6);
      ctx.fillRect(ax, ay, av, av);
      drawTextWithShadow(ctx, input.username.slice(0, 1).toUpperCase(), ax + av / 2, ay + av / 2 - 18, "#ffffff", 72);
    }
    ctx.restore();
    // Accent ring around the avatar.
    ctx.save();
    ctx.lineWidth = 6;
    ctx.strokeStyle = hexToRgba(accent, 1);
    ctx.beginPath();
    ctx.arc(ax + av / 2, ay + av / 2, av / 2 + 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Right column: name, level, XP bar, stat chips.
    const cx = ax + av + 40;
    const rightW = width - cx - 46;
    drawTextWithShadow(ctx, input.username, cx, 44, "#ffffff", fitText(ctx, input.username, rightW, 40), "left");
    drawTextWithShadow(ctx, `LEVEL ${input.level}`, cx, 84, hexToRgba(accent, 1), 26, "left");

    // XP bar.
    const barX = cx, barY = 104, barW = rightW, barH = 22;
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.10)";
    roundRectPath(ctx, barX, barY, barW, barH, 11);
    ctx.fill();
    const pct = input.xpSpan > 0 ? Math.max(0, Math.min(1, input.xpInto / input.xpSpan)) : 1;
    if (pct > 0) {
      ctx.fillStyle = hexToRgba(accent, 1);
      roundRectPath(ctx, barX, barY, Math.max(barH, barW * pct), barH, 11);
      ctx.fill();
    }
    ctx.restore();
    drawTextWithShadow(ctx, `${input.xpInto.toLocaleString()} / ${input.xpSpan.toLocaleString()} XP`, barX + barW, barY + barH + 20, "#c8d0e0", 18, "right");

    // Stat chips row (up to 4).
    const chips = input.stats.slice(0, 4);
    if (chips.length) {
      const gap = 12;
      const chipW = (rightW - gap * (chips.length - 1)) / chips.length;
      const chipY = 178, chipH = 56;
      for (let i = 0; i < chips.length; i++) {
        const chx = cx + i * (chipW + gap);
        ctx.save();
        ctx.fillStyle = "rgba(255,255,255,0.06)";
        roundRectPath(ctx, chx, chipY, chipW, chipH, 12);
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = hexToRgba(accent, 0.5);
        roundRectPath(ctx, chx, chipY, chipW, chipH, 12);
        ctx.stroke();
        ctx.restore();
        drawTextWithShadow(ctx, `${chips[i]!.emoji} ${chips[i]!.label}`, chx + chipW / 2, chipY + 20, "#aab2c5", 14);
        drawTextWithShadow(ctx, chips[i]!.value, chx + chipW / 2, chipY + 44, "#ffffff", 20);
      }
    }

    return await canvas.encode("png");
  } catch (err) {
    logger.debug({ err }, "hub-header: render failed");
    return null;
  }
  });
}
