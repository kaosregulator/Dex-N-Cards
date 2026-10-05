/**
 * Hall of Fame museum — world wings (stylized cultural abstracts, not
 * copyrighted masterpieces) frame the crowned piece center stage.
 */

import {
  encodeAnimation, getCanvas, hexToRgba, roundRectPath, clamp01, easeOutBack,
  TITLE_FONT_FAMILY, type Ctx, type CanvasMod,
} from "../animations/engine.js";
import { loadArt } from "../animations/effects.js";
import { seededRng } from "../animations/particles.js";
import { logger } from "../../lib/logger.js";

const W = 900;
const H = 520;

type Wing = { code: string; label: string; hue: number };

const WORLD_WINGS: Wing[] = [
  { code: "RU", label: "Russia", hue: 0xc41e3a },
  { code: "UK", label: "United Kingdom", hue: 0x00247d },
  { code: "US", label: "United States", hue: 0xb22234 },
  { code: "ES", label: "Spain", hue: 0xaa151b },
  { code: "CN", label: "China", hue: 0xde2910 },
  { code: "JP", label: "Japan", hue: 0xbc002d },
  { code: "FR", label: "France", hue: 0x0055a4 },
  { code: "BR", label: "Brazil", hue: 0x009c3b },
];

function drawAbstractWing(
  ctx: Ctx, x: number, y: number, w: number, h: number, wing: Wing, seed: string, t: number,
): void {
  const rng = seededRng(`${seed}-${wing.code}`);
  // Frame
  ctx.fillStyle = "#3a2f24";
  ctx.fillRect(x - 4, y - 4, w + 8, h + 8);
  ctx.strokeStyle = hexToRgba(0xd4af37, 0.55);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x - 4, y - 4, w + 8, h + 8);

  // Stylized abstract "masterwork" — geometric, not a real painting
  const bg = ctx.createLinearGradient(x, y, x + w, y + h);
  bg.addColorStop(0, hexToRgba(wing.hue, 0.55));
  bg.addColorStop(1, "#1a1410");
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, w, h);

  for (let i = 0; i < 6; i++) {
    const a = rng.range(0.15, 0.7);
    ctx.fillStyle = hexToRgba(0xfff3d0, a * (0.35 + 0.25 * Math.sin(t * Math.PI * 2 + i)));
    const rx = x + rng.range(4, w - 20);
    const ry = y + rng.range(4, h - 20);
    const rw = rng.range(10, w * 0.45);
    const rh = rng.range(8, h * 0.4);
    ctx.beginPath();
    if (rng.range(0, 1) > 0.5) {
      ctx.ellipse(rx + rw / 2, ry + rh / 2, rw / 2, rh / 2, rng.range(0, 1), 0, Math.PI * 2);
    } else {
      ctx.rect(rx, ry, rw, rh);
    }
    ctx.fill();
  }

  // Plaque
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(x, y + h - 18, w, 18);
  ctx.fillStyle = "#f0e2c0";
  ctx.font = "600 10px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(wing.label, x + w / 2, y + h - 5);
}

function drawContain(
  ctx: Ctx,
  img: { width: number; height: number },
  x: number, y: number, w: number, h: number,
): void {
  const scale = Math.min(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.fillStyle = "#120e0c";
  ctx.fillRect(x, y, w, h);
  ctx.drawImage(
    img as Parameters<Ctx["drawImage"]>[0],
    x + (w - dw) / 2,
    y + (h - dh) / 2,
    dw,
    dh,
  );
}

export type MuseumRenderOpts = {
  championTitle: string;
  championArtist: string;
  championImageUrl: string;
  votes: number;
  weekLabel: string;
  /** Past fame thumbnails (image urls) for side shelves — optional */
  pastUrls?: string[];
};

export async function renderMuseumGif(opts: MuseumRenderOpts): Promise<Buffer | null> {
  try {
    const result = await encodeAnimation({
      width: W,
      height: H,
      speed: "normal",
      durationMs: 2400,
      maxFrames: 16,
      quality: 11,
      render: async ({ ctx, t, mod }) => {
        // Grand hall
        const g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, "#1a120e");
        g.addColorStop(0.5, "#2a1f18");
        g.addColorStop(1, "#0e0a08");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);

        // Ceiling lights
        for (let i = 0; i < 5; i++) {
          const lx = 80 + i * 180;
          const pulse = 0.2 + 0.15 * Math.sin(t * Math.PI * 2 + i);
          const glow = ctx.createRadialGradient(lx, 30, 2, lx, 80, 90);
          glow.addColorStop(0, `rgba(255,230,170,${pulse})`);
          glow.addColorStop(1, "rgba(255,200,100,0)");
          ctx.fillStyle = glow;
          ctx.fillRect(lx - 100, 0, 200, 160);
        }

        ctx.fillStyle = "#f5e6c8";
        ctx.font = `700 22px ${TITLE_FONT_FAMILY}, sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText("HALL OF FAME  ·  WORLD MUSEUM", W / 2, 34);
        ctx.fillStyle = "#a89478";
        ctx.font = "13px sans-serif";
        ctx.fillText(opts.weekLabel, W / 2, 54);

        // Side wings
        const wingW = 88;
        const wingH = 110;
        const leftX = 28;
        const rightX = W - 28 - wingW;
        const startY = 78;
        for (let i = 0; i < 4; i++) {
          drawAbstractWing(ctx, leftX, startY + i * (wingH + 14), wingW, wingH, WORLD_WINGS[i]!, "L", t);
          drawAbstractWing(ctx, rightX, startY + i * (wingH + 14), wingW, wingH, WORLD_WINGS[i + 4]!, "R", t);
        }

        // Center stage pedestal + frame
        const pop = easeOutBack(clamp01(t * 1.25));
        const cw = 360;
        const ch = 300;
        const cx = (W - cw) / 2;
        const cy = 78 + (1 - pop) * 24;

        ctx.save();
        ctx.globalAlpha = clamp01(0.5 + pop * 0.5);

        // Spotlight
        const spot = ctx.createRadialGradient(W / 2, 70, 10, W / 2, 220, 220);
        spot.addColorStop(0, "rgba(255,236,190,0.28)");
        spot.addColorStop(1, "rgba(255,200,120,0)");
        ctx.fillStyle = spot;
        ctx.beginPath();
        ctx.moveTo(W / 2 - 30, 60);
        ctx.lineTo(W / 2 + 30, 60);
        ctx.lineTo(cx + cw + 40, cy + ch);
        ctx.lineTo(cx - 40, cy + ch);
        ctx.closePath();
        ctx.fill();

        // Gold frame
        ctx.fillStyle = "#5c4030";
        roundRectPath(ctx, cx - 16, cy - 16, cw + 32, ch + 32, 8);
        ctx.fill();
        ctx.strokeStyle = "#e8c872";
        ctx.lineWidth = 4;
        roundRectPath(ctx, cx - 16, cy - 16, cw + 32, ch + 32, 8);
        ctx.stroke();

        const img = await loadArt(mod, opts.championImageUrl);
        if (img) drawContain(ctx, img, cx, cy, cw, ch);
        else {
          ctx.fillStyle = "#1a1510";
          ctx.fillRect(cx, cy, cw, ch);
        }

        // Pedestal plaque
        const ppY = cy + ch + 22;
        roundRectPath(ctx, cx - 10, ppY, cw + 20, 58, 8);
        ctx.fillStyle = "rgba(12,10,8,0.9)";
        ctx.fill();
        ctx.strokeStyle = "rgba(232,200,114,0.7)";
        ctx.lineWidth = 1.5;
        roundRectPath(ctx, cx - 10, ppY, cw + 20, 58, 8);
        ctx.stroke();

        ctx.fillStyle = "#ffe08a";
        ctx.font = `700 16px ${TITLE_FONT_FAMILY}, sans-serif`;
        ctx.textAlign = "center";
        const title = opts.championTitle.length > 40
          ? `${opts.championTitle.slice(0, 38)}…`
          : opts.championTitle;
        ctx.fillText(title, W / 2, ppY + 22);
        ctx.fillStyle = "#d4c4a8";
        ctx.font = "13px sans-serif";
        ctx.fillText(
          `${opts.championArtist}  ·  ▲ ${opts.votes}  ·  CENTER STAGE`,
          W / 2,
          ppY + 44,
        );
        ctx.restore();
      },
    });
    return result?.buffer ?? null;
  } catch (err) {
    logger.debug({ err }, "artshow museum render failed");
    return null;
  }
}

/** Static PNG fallback for museum. */
export async function renderMuseumPng(opts: MuseumRenderOpts): Promise<Buffer | null> {
  try {
    const mod = await getCanvas();
    if (!mod) return null;
    const gif = await renderMuseumGif(opts);
    return gif;
  } catch {
    return null;
  }
}
