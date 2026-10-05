/**
 * Hall of Fame museum — stamped real gallery hall, famous PD masterpieces
 * in ornate gold frames (shuffled world wings), classical statues on pedestals,
 * and the community champion BIG and bold at center stage.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  encodeAnimation, getCanvas, hexToRgba, roundRectPath, clamp01, easeOutBack,
  TITLE_FONT_FAMILY, type Ctx, type CanvasMod,
} from "../animations/engine.js";
import { loadArt } from "../animations/effects.js";
import { logger } from "../../lib/logger.js";
import {
  pickHall, pickWingArt, pickStatues,
} from "./museum-assets.js";

const W = 960;
const H = 560;

type Img = { width: number; height: number };

async function loadLocal(mod: CanvasMod, absPath: string): Promise<Img | null> {
  try {
    if (!existsSync(absPath)) return null;
    const buf = await readFile(absPath);
    return await mod.loadImage(buf);
  } catch {
    return null;
  }
}

function drawCover(ctx: Ctx, img: Img, x: number, y: number, w: number, h: number): void {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(
    img as Parameters<Ctx["drawImage"]>[0],
    x + (w - dw) / 2,
    y + (h - dh) / 2,
    dw,
    dh,
  );
}

/** Letterbox — never crop the champion photo. */
function drawContain(
  ctx: Ctx, img: Img, x: number, y: number, w: number, h: number, mat = "#1a1510",
): void {
  ctx.fillStyle = mat;
  ctx.fillRect(x, y, w, h);
  const scale = Math.min(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(
    img as Parameters<Ctx["drawImage"]>[0],
    x + (w - dw) / 2,
    y + (h - dh) / 2,
    dw,
    dh,
  );
}

function drawOrnateFrame(
  ctx: Ctx, x: number, y: number, w: number, h: number, opts?: { thick?: number; glow?: number },
): void {
  const thick = opts?.thick ?? 10;
  const glow = opts?.glow ?? 0.45;
  // Outer shadow
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(x - thick - 2, y - thick + 4, w + thick * 2 + 4, h + thick * 2 + 4);

  // Dark wood
  ctx.fillStyle = "#3a2a18";
  ctx.fillRect(x - thick, y - thick, w + thick * 2, h + thick * 2);

  // Antique gold lip
  const gold = ctx.createLinearGradient(x - thick, y, x + w + thick, y + h);
  gold.addColorStop(0, "#e8d48b");
  gold.addColorStop(0.35, "#c5a059");
  gold.addColorStop(0.7, "#f0e2b0");
  gold.addColorStop(1, "#a67c2a");
  ctx.strokeStyle = gold as unknown as string;
  ctx.lineWidth = Math.max(3, thick * 0.55);
  ctx.strokeRect(x - thick + 2, y - thick + 2, w + thick * 2 - 4, h + thick * 2 - 4);

  // Inner gold hairline
  ctx.strokeStyle = hexToRgba(0xffe6a0, glow);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x - 1, y - 1, w + 2, h + 2);
}

function drawPedestal(ctx: Ctx, cx: number, top: number, w: number, h: number): void {
  // Column
  const grad = ctx.createLinearGradient(cx - w / 2, top, cx + w / 2, top + h);
  grad.addColorStop(0, "#e8e4dc");
  grad.addColorStop(0.5, "#cfc8bc");
  grad.addColorStop(1, "#a8a095");
  ctx.fillStyle = grad;
  roundRectPath(ctx, cx - w / 2, top, w, h, 4);
  ctx.fill();
  // Cap
  ctx.fillStyle = "#f2efe8";
  roundRectPath(ctx, cx - w / 2 - 8, top - 6, w + 16, 12, 3);
  ctx.fill();
  // Base
  ctx.fillStyle = "#9a9288";
  roundRectPath(ctx, cx - w / 2 - 10, top + h - 4, w + 20, 10, 3);
  ctx.fill();
}

async function drawStatue(
  ctx: Ctx, mod: CanvasMod, abs: string, cx: number, floorY: number, maxH: number, t: number,
): Promise<void> {
  const img = await loadLocal(mod, abs);
  const pedH = 36;
  const pedW = 52;
  const artH = maxH - pedH - 8;
  const artW = 70;
  drawPedestal(ctx, cx, floorY - pedH, pedW, pedH);

  // Soft glow behind statue
  const pulse = 0.12 + 0.06 * Math.sin(t * Math.PI * 2);
  const glow = ctx.createRadialGradient(cx, floorY - pedH - artH * 0.45, 4, cx, floorY - pedH - artH * 0.4, artW);
  glow.addColorStop(0, `rgba(255,248,230,${pulse})`);
  glow.addColorStop(1, "rgba(255,248,230,0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.ellipse(cx, floorY - pedH - artH * 0.4, artW * 0.7, artH * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();

  if (img) {
    const x = cx - artW / 2;
    const y = floorY - pedH - artH;
    // Marble-ish matte
    ctx.fillStyle = "rgba(245,242,236,0.15)";
    ctx.fillRect(x, y, artW, artH);
    drawContain(ctx, img, x, y, artW, artH, "rgba(236,232,224,0.9)");
  } else {
    // Fallback silhouette
    ctx.fillStyle = "#e8e4dc";
    ctx.beginPath();
    ctx.ellipse(cx, floorY - pedH - artH + 22, 16, 20, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(cx - 14, floorY - pedH - artH + 40, 28, artH - 48);
  }
}

export type MuseumRenderOpts = {
  championTitle: string;
  championArtist: string;
  championImageUrl: string;
  votes: number;
  weekLabel: string;
  pastUrls?: string[];
  /** Override shuffle seed (defaults to week + title) */
  seed?: string;
};

export async function renderMuseumGif(opts: MuseumRenderOpts): Promise<Buffer | null> {
  try {
    const seed = opts.seed ?? `${opts.weekLabel}-${opts.championTitle}-${opts.votes}`;
    const hallFile = pickHall(seed);
    const wings = pickWingArt(seed);
    const statues = pickStatues(seed);

    const result = await encodeAnimation({
      width: W,
      height: H,
      speed: "normal",
      durationMs: 2200,
      maxFrames: 12,
      quality: 12,
      render: async ({ ctx, t, mod }) => {
        // ── Stamped gallery hall background ──────────────────────────────
        const hall = await loadLocal(mod, hallFile);
        if (hall) {
          drawCover(ctx, hall, 0, 0, W, H);
        } else {
          const g = ctx.createLinearGradient(0, 0, 0, H);
          g.addColorStop(0, "#2B3D4F");
          g.addColorStop(1, "#1a2430");
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, W, H);
        }

        // Soft Apple-clean wash — cool teal lift + vignette
        const wash = ctx.createLinearGradient(0, 0, 0, H);
        wash.addColorStop(0, "rgba(255,255,255,0.10)");
        wash.addColorStop(0.45, "rgba(43,61,79,0.18)");
        wash.addColorStop(1, "rgba(10,12,16,0.45)");
        ctx.fillStyle = wash;
        ctx.fillRect(0, 0, W, H);

        const vig = ctx.createRadialGradient(W / 2, H * 0.4, H * 0.15, W / 2, H * 0.5, H * 0.75);
        vig.addColorStop(0, "rgba(0,0,0,0)");
        vig.addColorStop(1, "rgba(0,0,0,0.35)");
        ctx.fillStyle = vig;
        ctx.fillRect(0, 0, W, H);

        // Polished floor reflection band
        const floorY = H * 0.82;
        const floor = ctx.createLinearGradient(0, floorY, 0, H);
        floor.addColorStop(0, "rgba(210,200,188,0.18)");
        floor.addColorStop(1, "rgba(40,36,32,0.55)");
        ctx.fillStyle = floor;
        ctx.fillRect(0, floorY, W, H - floorY);

        // Header glass pill
        roundRectPath(ctx, W / 2 - 210, 14, 420, 44, 14);
        ctx.fillStyle = "rgba(255,255,255,0.72)";
        ctx.fill();
        ctx.strokeStyle = "rgba(197,160,89,0.55)";
        ctx.lineWidth = 1.5;
        roundRectPath(ctx, W / 2 - 210, 14, 420, 44, 14);
        ctx.stroke();

        ctx.fillStyle = "#1a1a1e";
        ctx.font = `700 18px ${TITLE_FONT_FAMILY}, sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText("HALL OF FAME", W / 2, 34);
        ctx.fillStyle = "#6b6560";
        ctx.font = "600 11px sans-serif";
        ctx.fillText(opts.weekLabel, W / 2, 50);

        // ── World wings — 3 left + 3 right (shuffled countries) ───────────
        const leftWings = wings.slice(0, 3);
        const rightWings = wings.slice(3, 6);
        const frameW = 92;
        const frameH = 112;
        const startY = 78;
        const gap = 14;

        for (let i = 0; i < leftWings.length; i++) {
          const item = leftWings[i]!;
          const x = 28;
          const y = startY + i * (frameH + gap);
          const art = await loadLocal(mod, item.abs);
          drawOrnateFrame(ctx, x, y, frameW, frameH, { thick: 8, glow: 0.35 });
          if (art) drawCover(ctx, art, x, y, frameW, frameH);
          else {
            ctx.fillStyle = "#2B3D4F";
            ctx.fillRect(x, y, frameW, frameH);
          }
          // Country plaque
          ctx.fillStyle = "rgba(20,18,16,0.72)";
          ctx.fillRect(x, y + frameH - 18, frameW, 18);
          ctx.fillStyle = "#f5e6c8";
          ctx.font = "600 10px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(item.wing.label, x + frameW / 2, y + frameH - 5);
        }

        for (let i = 0; i < rightWings.length; i++) {
          const item = rightWings[i]!;
          const x = W - 28 - frameW;
          const y = startY + i * (frameH + gap);
          const art = await loadLocal(mod, item.abs);
          drawOrnateFrame(ctx, x, y, frameW, frameH, { thick: 8, glow: 0.35 });
          if (art) drawCover(ctx, art, x, y, frameW, frameH);
          else {
            ctx.fillStyle = "#2B3D4F";
            ctx.fillRect(x, y, frameW, frameH);
          }
          ctx.fillStyle = "rgba(20,18,16,0.72)";
          ctx.fillRect(x, y + frameH - 18, frameW, 18);
          ctx.fillStyle = "#f5e6c8";
          ctx.font = "600 10px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(item.wing.label, x + frameW / 2, y + frameH - 5);
        }

        // Extra two wings tucked as smaller salon pieces above center (countries 7–8)
        const extras = wings.slice(6, 8);
        for (let i = 0; i < extras.length; i++) {
          const item = extras[i]!;
          const fw = 70;
          const fh = 84;
          const x = W / 2 + (i === 0 ? -200 : 130);
          const y = 72;
          const art = await loadLocal(mod, item.abs);
          drawOrnateFrame(ctx, x, y, fw, fh, { thick: 6, glow: 0.3 });
          if (art) drawCover(ctx, art, x, y, fw, fh);
          ctx.fillStyle = "rgba(20,18,16,0.7)";
          ctx.fillRect(x, y + fh - 16, fw, 16);
          ctx.fillStyle = "#f5e6c8";
          ctx.font = "600 9px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(item.wing.label, x + fw / 2, y + fh - 4);
        }

        // ── Classical statues flanking center stage ───────────────────────
        await drawStatue(ctx, mod, statues.left, 168, floorY + 8, 168, t);
        await drawStatue(ctx, mod, statues.right, W - 168, floorY + 8, 168, t);

        // ── CENTER STAGE — champion big & bold ───────────────────────────
        const pop = easeOutBack(clamp01(t * 1.35));
        const cw = 340;
        const ch = 300;
        const cx = (W - cw) / 2;
        const cy = 88 + (1 - pop) * 28;

        ctx.save();
        ctx.globalAlpha = clamp01(0.55 + pop * 0.45);

        // Museum spotlight cone
        const spotPulse = 0.22 + 0.08 * Math.sin(t * Math.PI * 2);
        const spot = ctx.createRadialGradient(W / 2, 64, 8, W / 2, cy + ch * 0.45, 260);
        spot.addColorStop(0, `rgba(255,248,220,${spotPulse})`);
        spot.addColorStop(0.55, `rgba(255,236,190,${spotPulse * 0.35})`);
        spot.addColorStop(1, "rgba(255,220,160,0)");
        ctx.fillStyle = spot;
        ctx.beginPath();
        ctx.moveTo(W / 2 - 36, 58);
        ctx.lineTo(W / 2 + 36, 58);
        ctx.lineTo(cx + cw + 50, cy + ch + 20);
        ctx.lineTo(cx - 50, cy + ch + 20);
        ctx.closePath();
        ctx.fill();

        // Fixture
        ctx.fillStyle = "#c5a059";
        roundRectPath(ctx, W / 2 - 22, 52, 44, 12, 4);
        ctx.fill();

        // Deep ornate gold frame (thicker = hero)
        drawOrnateFrame(ctx, cx, cy, cw, ch, { thick: 16, glow: 0.7 });
        // Extra outer glow ring
        ctx.strokeStyle = hexToRgba(0xffe08a, 0.35 + 0.15 * Math.sin(t * Math.PI * 2));
        ctx.lineWidth = 3;
        roundRectPath(ctx, cx - 20, cy - 20, cw + 40, ch + 40, 6);
        ctx.stroke();

        const champ = await loadArt(mod, opts.championImageUrl);
        if (champ) drawContain(ctx, champ, cx, cy, cw, ch, "#14110e");
        else {
          ctx.fillStyle = "#14110e";
          ctx.fillRect(cx, cy, cw, ch);
        }

        // Glass plaque under hero
        const ppY = cy + ch + 18;
        roundRectPath(ctx, cx - 8, ppY, cw + 16, 56, 12);
        ctx.fillStyle = "rgba(255,255,255,0.88)";
        ctx.fill();
        ctx.strokeStyle = "rgba(197,160,89,0.7)";
        ctx.lineWidth = 1.5;
        roundRectPath(ctx, cx - 8, ppY, cw + 16, 56, 12);
        ctx.stroke();

        ctx.fillStyle = "#1a1a1e";
        ctx.font = `700 17px ${TITLE_FONT_FAMILY}, sans-serif`;
        ctx.textAlign = "center";
        const title = opts.championTitle.length > 36
          ? `${opts.championTitle.slice(0, 34)}…`
          : opts.championTitle;
        ctx.fillText(title, W / 2, ppY + 22);
        ctx.fillStyle = "#6b6560";
        ctx.font = "600 12px sans-serif";
        ctx.fillText(
          `${opts.championArtist}  ·  ▲ ${opts.votes}  ·  CENTER STAGE`,
          W / 2,
          ppY + 42,
        );

        ctx.restore();

        // Footer credit strip
        ctx.fillStyle = "rgba(255,255,255,0.55)";
        ctx.font = "500 9px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(
          "World wings · public-domain masterpieces  ·  statues · classical marble  ·  your piece owns the lights",
          W / 2,
          H - 10,
        );
      },
    });
    return result?.buffer ?? null;
  } catch (err) {
    logger.debug({ err }, "artshow museum render failed");
    return null;
  }
}

export async function renderMuseumPng(opts: MuseumRenderOpts): Promise<Buffer | null> {
  // Single-frame still via GIF path (first encode) — good enough for attach fallback
  return renderMuseumGif(opts);
}
