// Russian roulette duel — multi-scene cinematic GIFs with player avatars.
// Reuses battle particle / loadArt patterns (not a single static flash GIF).

import {
  encodeAnimation, getCanvas, clamp01, lerp, easeInOutCubic, easeOutBack,
  hexToRgba, roundRectPath, type Ctx, type CanvasMod,
} from "../animations/engine.js";
import type { AnimationResult } from "../animations/types.js";
import { loadArt } from "../animations/effects.js";
import { drawSparks, drawEmbers, shakeOffset } from "../animations/particles.js";
import { drawTextWithEmojis, preloadEmojiTexts } from "./canvas-emoji-text.js";
import type { CurrencyImg } from "./currency-canvas.js";

const W = 640;
const H = 360;

export type RussianScene =
  | "intro"      // two avatars face off, table + toy gun
  | "load"       // chambers loading
  | "spin"       // cylinder spin
  | "raise"      // gun raises toward one player
  | "click"      // safe click
  | "bang";      // bang / loser

export type RussianSceneOpts = {
  scene: RussianScene;
  challengerUrl: string | null;
  targetUrl: string | null;
  challengerName: string;
  targetName: string;
  /** Whose turn / who the gun points at for raise/click/bang */
  aimedAt?: "challenger" | "target";
  chamber?: number;
  /** Optional 3-2-1 countdown overlay on raise */
  countdown?: number;
};

async function loadAvatar(mod: CanvasMod, url: string | null) {
  if (!url) return null;
  try {
    return await loadArt(mod, url);
  } catch {
    return null;
  }
}

function drawAvatarCircle(
  ctx: Ctx,
  img: Awaited<ReturnType<typeof loadArt>>,
  cx: number, cy: number, r: number,
  label: string,
  highlight: boolean,
  emojiImgs: Map<string, CurrencyImg | null>,
) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r + (highlight ? 4 : 0), 0, Math.PI * 2);
  ctx.fillStyle = highlight ? "#fbbf24" : "#334155";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  if (img) {
    ctx.drawImage(img as never, cx - r, cy - r, r * 2, r * 2);
  } else {
    ctx.fillStyle = "#475569";
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.fillStyle = "#e2e8f0";
    ctx.font = `bold ${Math.floor(r * 0.7)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label.slice(0, 1).toUpperCase(), cx, cy);
  }
  ctx.restore();
  drawTextWithEmojis(ctx, label, cx, cy + r + 20, emojiImgs, {
    font: "bold 14px sans-serif",
    fillStyle: "#f1f5f9",
    align: "center",
    maxWidth: 140,
    emojiSize: 14,
  });
}

/** Toy western revolver — silhouette, not realistic gore. */
function drawToyGun(
  ctx: Ctx,
  cx: number, cy: number,
  opts: { angle?: number; scale?: number; cylinderSpin?: number; raised?: number },
) {
  const angle = opts.angle ?? 0;
  const scale = opts.scale ?? 1;
  const spin = opts.cylinderSpin ?? 0;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.scale(scale, scale);

  // grip
  ctx.fillStyle = "#5c3a21";
  roundRectPath(ctx, -18, 8, 28, 42, 6);
  ctx.fill();
  // frame
  ctx.fillStyle = "#64748b";
  roundRectPath(ctx, -22, -18, 70, 28, 8);
  ctx.fill();
  // barrel
  ctx.fillStyle = "#475569";
  roundRectPath(ctx, 40, -10, 55, 14, 4);
  ctx.fill();
  // cylinder
  ctx.save();
  ctx.translate(10, -4);
  ctx.rotate(spin);
  ctx.fillStyle = "#94a3b8";
  ctx.beginPath(); ctx.arc(0, 0, 16, 0, Math.PI * 2); ctx.fill();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    ctx.fillStyle = i === 0 ? "#ef4444" : "#1e293b";
    ctx.beginPath();
    ctx.arc(Math.cos(a) * 9, Math.sin(a) * 9, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  // hammer
  ctx.fillStyle = "#334155";
  ctx.fillRect(-28, -22, 10, 12);
  ctx.restore();
}

function feltTable(ctx: Ctx) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#1a3d32");
  g.addColorStop(1, "#0c221c");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(0,0,0,0.2)";
  ctx.beginPath();
  ctx.ellipse(W / 2, H / 2 + 40, 260, 90, 0, 0, Math.PI * 2);
  ctx.fill();
  // wood rail
  ctx.strokeStyle = "#6b4423";
  ctx.lineWidth = 14;
  ctx.strokeRect(8, 8, W - 16, H - 16);
}

export async function renderRussianScene(opts: RussianSceneOpts): Promise<AnimationResult | null> {
  const mod = await getCanvas();
  if (!mod) return null;
  const [challengerImg, targetImg] = await Promise.all([
    loadAvatar(mod, opts.challengerUrl),
    loadAvatar(mod, opts.targetUrl),
  ]);
  const emojiImgs = await preloadEmojiTexts(mod, [opts.challengerName, opts.targetName]);

  const scene = opts.scene;
  const durationMs =
    scene === "spin" ? 2200
      : scene === "raise" ? (opts.countdown != null ? 900 : 1600)
        : scene === "bang" ? 2000
          : scene === "click" ? 1400
            : scene === "load" ? 1800
              : 1600;

  return encodeAnimation({
    width: W, height: H, durationMs, speed: "normal",
    maxFrames: scene === "bang" ? 22 : scene === "spin" ? 24 : 18,
    quality: 14, renderScale: 0.8,
    render: async ({ ctx, t }) => {
      feltTable(ctx);
      drawEmbers(ctx, 0, 0, W, H, { count: 18, color: 0xc4a574, seed: `rr-${scene}`, rise: -0.2 });

      const leftX = 130, rightX = W - 130, avY = 130;
      const aimLeft = opts.aimedAt === "challenger";
      const aimRight = opts.aimedAt === "target";

      drawAvatarCircle(
        ctx, challengerImg, leftX, avY, 52,
        opts.challengerName,
        aimLeft && (scene === "raise" || scene === "bang" || scene === "click" || scene === "intro"),
        emojiImgs,
      );
      drawAvatarCircle(
        ctx, targetImg, rightX, avY, 52,
        opts.targetName,
        aimRight && (scene === "raise" || scene === "bang" || scene === "click" || scene === "intro"),
        emojiImgs,
      );

      ctx.fillStyle = "#fbbf24";
      ctx.font = "bold 22px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("VS", W / 2, 60);

      // Hold the gun near the active player's hand — not floating mid-table.
      const holderLeft = aimLeft || (!opts.aimedAt && scene === "intro");
      let gunX = holderLeft ? leftX + 55 : rightX - 55;
      let gunY = avY + 55;
      let gunAngle = holderLeft ? -0.55 : Math.PI + 0.55;
      let spin = 0;
      let scale = 0.95;

      if (scene === "intro") {
        scale = 0.85 + easeOutBack(clamp01(t)) * 0.2;
        ctx.fillStyle = "#a7f3d0";
        ctx.font = "16px sans-serif";
        ctx.fillText("Press Pull Trigger when it’s your turn", W / 2, H - 28);
      } else if (scene === "load") {
        gunX = W / 2;
        gunY = H / 2 + 20;
        gunAngle = -0.2;
        const loadT = easeInOutCubic(t);
        spin = loadT * Math.PI * 2;
        scale = 1.15;
        for (let i = 0; i < 6; i++) {
          const lit = loadT > (i + 1) / 6;
          ctx.fillStyle = lit ? "#ef4444" : "#334155";
          ctx.beginPath();
          ctx.arc(W / 2 - 60 + i * 24, H - 48, 7, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = "#fde68a";
        ctx.font = "bold 16px sans-serif";
        ctx.fillText("Loading chambers…", W / 2, H - 24);
      } else if (scene === "spin") {
        gunX = W / 2;
        gunY = H / 2 + 20;
        spin = t * Math.PI * 8;
        gunAngle = Math.sin(t * Math.PI * 6) * 0.15;
        scale = 1.2;
        const sh = shakeOffset(`spin-${Math.floor(t * 20)}`, 2);
        ctx.translate(sh.dx, sh.dy);
        ctx.fillStyle = "#cbd5e1";
        ctx.font = "bold 16px sans-serif";
        ctx.fillText("Spinning the cylinder…", W / 2, H - 28);
      } else if (scene === "raise") {
        const raise = easeOutBack(clamp01(t));
        gunX = lerp(W / 2, aimLeft ? leftX + 40 : rightX - 40, raise);
        gunY = lerp(H / 2 + 30, avY + 10, raise);
        gunAngle = aimLeft ? -0.2 : Math.PI + 0.2;
        scale = lerp(1.0, 1.25, raise);
        if (opts.countdown != null) {
          ctx.fillStyle = `rgba(251,191,36,${0.9})`;
          ctx.font = "bold 72px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(String(opts.countdown), W / 2, H / 2 + 20);
        } else {
          ctx.fillStyle = "#fbbf24";
          ctx.font = "bold 16px sans-serif";
          ctx.fillText("Raising…", W / 2, H - 28);
        }
      } else if (scene === "click") {
        gunX = aimLeft ? leftX + 40 : rightX - 40;
        gunY = avY + 10;
        gunAngle = aimLeft ? -0.15 : Math.PI + 0.15;
        scale = 1.2;
        if (t > 0.25) {
          drawSparks(ctx, gunX + (aimLeft ? 30 : -30), gunY - 8, {
            count: 12, color: 0x4ade80, seed: `click-${Math.floor(t * 8)}`,
          });
        }
        ctx.fillStyle = "#4ade80";
        ctx.font = "bold 28px sans-serif";
        ctx.fillText("CLICK — safe", W / 2, H - 32);
      } else if (scene === "bang") {
        gunX = aimLeft ? leftX + 40 : rightX - 40;
        gunY = avY + 10;
        gunAngle = aimLeft ? -0.1 : Math.PI + 0.1;
        scale = 1.3;
        const sh = shakeOffset(`bang-${Math.floor(t * 30)}`, 10 * (1 - t));
        ctx.translate(sh.dx, sh.dy);
        // Muzzle flash + expanding blast
        const muzzleX = gunX + (aimLeft ? 48 : -48);
        const muzzleY = gunY - 6;
        if (t < 0.55) {
          const flash = 1 - t / 0.55;
          ctx.fillStyle = hexToRgba(0xfff1a8, 0.7 * flash);
          ctx.beginPath();
          ctx.arc(muzzleX, muzzleY, 30 + t * 120, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = hexToRgba(0xff6644, 0.55 * flash);
          ctx.beginPath();
          ctx.arc(muzzleX, muzzleY, 18 + t * 70, 0, Math.PI * 2);
          ctx.fill();
          drawSparks(ctx, muzzleX, muzzleY, {
            count: 28, color: 0xffaa44, maxLen: 100, seed: `bang-${Math.floor(t * 12)}`,
          });
        }
        // Red vignette
        ctx.fillStyle = `rgba(127,29,29,${0.35 * Math.min(1, t * 2)})`;
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = "#fecaca";
        ctx.font = "bold 48px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("BANG!", W / 2, H / 2 + 16);
        ctx.fillStyle = "#f87171";
        ctx.font = "bold 18px sans-serif";
        ctx.fillText("Out of the duel", W / 2, H - 32);
      }

      drawToyGun(ctx, gunX, gunY, {
        angle: gunAngle,
        scale,
        cylinderSpin: spin,
      });
    },
  });
}
