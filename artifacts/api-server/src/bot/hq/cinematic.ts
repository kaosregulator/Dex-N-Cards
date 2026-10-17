// ─────────────────────────────────────────────────────────────────────────────
// HQ — siege cinematic.
//
// The short opening film that plays before a siege resolves. Before this, a
// siege cut straight to the result frame; now the camera actually arrives at the
// castle, the army musters, and the raider's cards fly in — so an attack reads
// as an event rather than a dice roll.
//
// LANDSCAPE (16:9) rather than the 1120×680 room format, because the shot is a
// wide establishing view of a battlefield, not a diorama of a room.
//
// Beats, on one normalised timeline so the whole thing is a pure function of t:
//   0.00–0.20  ARRIVAL     sky, banners, the castle on the ridge; camera pushes in
//   0.20–0.42  MUSTER      gates open, soldier ranks march out and form up
//   0.42–0.66  THE CARDS   the attacker's cards fly in and slam into formation
//   0.66–0.86  DEPLOY      siege line, braziers, dust, camera settles
//   0.86–1.00  ENGAGE      the title card lands and the horns sound
//
// A LEAF renderer: `encodeAnimation` takes the render queue for us, so nothing
// in here may call another queued renderer.
// ─────────────────────────────────────────────────────────────────────────────

import {
  encodeAnimation, getCanvas, hexToRgba, roundRectPath, clamp01, easeOutBack, easeInOutCubic,
  type Ctx, type CanvasMod,
} from "../animations/engine.js";
import { queueRender } from "../animations/render-queue.js";
import { drawCardArt, drawTextWithShadow, drawTitle, fitText, TITLE_FONT } from "../animations/effects.js";
import { loadSprite, spriteForPrefix } from "./assets.js";
import {
  ellipse, blit, imgSize, polyPath, seededRng, hashString, shiftColor,
} from "./paint.js";

const W = 1152, H = 648;                // 16:9 landscape
const HORIZON = H * 0.56;               // where the ground meets the sky

export interface CinematicCard {
  name: string;
  artUrl: string | null;
  rarityColor: number;
}

export interface SiegeCinematicView {
  /** What is being attacked — a player base or an AI territory. */
  targetName: string;
  /** Who owns it right now, shown under the target name. */
  holderName: string;
  /** Banner colour of the defender (faction crest or the holder's colours). */
  defenderColor: number;
  /** Banner colour of the attacking side. */
  attackerColor: number;
  attackerName: string;
  /** The raider's squad — these are the cards that "pull in". Up to 5 shown. */
  cards: CinematicCard[];
  /** How many defenders are stationed, drawn as the garrison on the walls. */
  garrison: number;
  /** Building role for the castle sprite lookup ("castle", "keep", "tower"…). */
  structure: string;
  /** Sets the palette: dusk over a fort, snowfall over a bastion, etc. */
  mood: "dawn" | "dusk" | "night" | "storm" | "snow" | "ash";
  /** A one-line subtitle under the final title card. */
  tagline?: string;
  // ── Boss-raid variant ──────────────────────────────────────────────────────
  // A raid reuses the exact same film — the ride in, the muster, the cards
  // arriving — but the thing on the ridge is a looming BOSS instead of a castle.
  /** "base" (default) draws a castle; "boss" draws the raid boss towering ahead. */
  kind?: "base" | "boss";
  /** The boss's card art, drawn huge on the ridge when `kind` is "boss". */
  bossArtUrl?: string | null;
  /**
   * Story lines revealed as timed, typewritten lower-third captions over the
   * film ("word for word"). Markdown is stripped. Used by raids to carry the
   * existing intro script onto the cinematic.
   */
  beats?: string[];
  /** Overrides the final title-card label (default "THE SIEGE BEGINS"). */
  titleText?: string;
}

export const SIEGE_CINEMATIC_FILE = "siege-intro.gif";
export const SIEGE_CINEMATIC_STILL = "siege-intro.png";

/**
 * A single frame as a PNG. Used as the fallback when GIF encoding is
 * unavailable or the animation blows the attachment budget, and by the preview
 * harness to eyeball individual beats.
 */
export async function renderCinematicStill(view: SiegeCinematicView, t = 0.92): Promise<Buffer | null> {
  return queueRender("hq-cine-still", async () => {
    const mod = await getCanvas();
    if (!mod) return null;
    try {
      const canvas = mod.createCanvas(W, H);
      const ctx = canvas.getContext("2d") as unknown as Ctx;
      await paintFrame(ctx, mod, view, t);
      return await canvas.encode("png");
    } catch { return null; }
  });
}

export async function renderSiegeCinematic(
  view: SiegeCinematicView,
  opts?: { durationMs?: number; maxFrames?: number },
): Promise<Buffer | null> {
  // A raid carries a longer caption track (the intro script), so give it a
  // little more runtime + frames so the words have room to land.
  const raid = view.kind === "boss";
  const res = await encodeAnimation({
    width: W, height: H,
    speed: "normal",
    durationMs: opts?.durationMs ?? (raid ? 5400 : 4200),
    maxFrames: opts?.maxFrames ?? (raid ? 36 : 30),
    quality: 24,
    // The scene is broad shapes and gradients, so it survives the downscale and
    // the GIF stays comfortably inside Discord's attachment limit.
    renderScale: 0.62,
    render: async ({ ctx, t, mod }) => {
      await paintFrame(ctx as unknown as Ctx, mod, view, t);
    },
  });
  return res?.buffer ?? null;
}

// ── Palettes ──────────────────────────────────────────────────────────────────

interface Mood {
  skyTop: string; skyBottom: string;
  sun: string | null; sunY: number;
  ground: string; groundFar: string;
  haze: string;
  particle: "none" | "snow" | "ash" | "rain";
  keyLight: string;
}

function moodPalette(m: SiegeCinematicView["mood"]): Mood {
  switch (m) {
    case "dawn": return {
      skyTop: "#2b3f6b", skyBottom: "#f0a878", sun: "#ffe0a8", sunY: HORIZON - 40,
      ground: "#4a6b3c", groundFar: "#6d7f52", haze: "rgba(255,200,150,0.20)",
      particle: "none", keyLight: "rgba(255,214,150,0.20)" };
    case "night": return {
      skyTop: "#070c1a", skyBottom: "#1b2745", sun: "#d8e4ff", sunY: 120,
      ground: "#1f2a24", groundFar: "#2b3a30", haze: "rgba(90,120,200,0.16)",
      particle: "none", keyLight: "rgba(140,170,255,0.14)" };
    case "storm": return {
      skyTop: "#1b2029", skyBottom: "#414b57", sun: null, sunY: 0,
      ground: "#33402f", groundFar: "#46523c", haze: "rgba(150,160,180,0.22)",
      particle: "rain", keyLight: "rgba(200,215,235,0.12)" };
    case "snow": return {
      skyTop: "#3a4a63", skyBottom: "#9fb3c9", sun: "#eef4fa", sunY: 130,
      ground: "#cbd8e2", groundFar: "#e3ecf3", haze: "rgba(220,235,250,0.28)",
      particle: "snow", keyLight: "rgba(230,245,255,0.20)" };
    case "ash": return {
      skyTop: "#2a1410", skyBottom: "#8c3a1c", sun: "#ffb066", sunY: HORIZON - 70,
      ground: "#3a2620", groundFar: "#5a3428", haze: "rgba(255,120,60,0.20)",
      particle: "ash", keyLight: "rgba(255,140,70,0.22)" };
    case "dusk":
    default: return {
      skyTop: "#20264a", skyBottom: "#c86a4e", sun: "#ffd08a", sunY: HORIZON - 52,
      ground: "#3f5c33", groundFar: "#5d7143", haze: "rgba(255,170,120,0.18)",
      particle: "none", keyLight: "rgba(255,190,130,0.20)" };
  }
}

// ── Frame ─────────────────────────────────────────────────────────────────────

// Map the global t onto a beat's own 0→1 progress.
function beat(t: number, from: number, to: number): number {
  return clamp01((t - from) / (to - from));
}

async function paintFrame(ctx: Ctx, mod: CanvasMod, view: SiegeCinematicView, t: number): Promise<void> {
  const pal = moodPalette(view.mood);
  const rnd = seededRng(hashString(`cine:${view.targetName}`));

  // Camera: a slow push-in during ARRIVAL that settles by MUSTER, so the shot
  // arrives at the castle instead of cutting to it.
  const push = easeInOutCubic(beat(t, 0, 0.30));
  const zoom = 1.16 - 0.16 * push;
  const panY = 26 * (1 - push);

  ctx.save();
  ctx.translate(W / 2, HORIZON);
  ctx.scale(zoom, zoom);
  ctx.translate(-W / 2, -HORIZON + panY);

  drawSky(ctx, pal, t);
  drawDistantRange(ctx, pal);
  drawGround(ctx, pal);
  if (view.kind === "boss") {
    // A raid: the thing on the ridge is the boss, not a keep. The attacker's
    // ranks still muster and the cards still fly in — same film, new foe.
    await drawBoss(ctx, mod, view, pal, t);
  } else {
    await drawCastle(ctx, mod, view, pal, t);
    drawGarrison(ctx, view, t);
  }
  drawSiegeLine(ctx, view, t);
  drawMarchingRanks(ctx, view, t);

  ctx.restore();

  // Cards fly in over the settled camera so they never wobble with the push.
  await drawIncomingCards(ctx, mod, view, t);

  drawWeather(ctx, pal, t, rnd);
  drawLighting(ctx, pal, t);
  drawLetterbox(ctx, t);
  drawCaptions(ctx, view, t);
}

function drawSky(ctx: Ctx, pal: Mood, t: number): void {
  const g = ctx.createLinearGradient(0, -60, 0, HORIZON + 40);
  g.addColorStop(0, pal.skyTop);
  g.addColorStop(1, pal.skyBottom);
  ctx.fillStyle = g;
  ctx.fillRect(-200, -200, W + 400, HORIZON + 240);

  if (pal.sun) {
    const sx = W * 0.72;
    ctx.save();
    const halo = ctx.createRadialGradient(sx, pal.sunY, 6, sx, pal.sunY, 190);
    halo.addColorStop(0, hexToRgba(0xffffff, 0.55));
    halo.addColorStop(0.25, "rgba(255,220,160,0.28)");
    halo.addColorStop(1, "rgba(255,200,140,0)");
    ctx.fillStyle = halo;
    ctx.beginPath(); ellipse(ctx, sx, pal.sunY, 190, 190); ctx.fill();
    ctx.fillStyle = pal.sun;
    ctx.beginPath(); ellipse(ctx, sx, pal.sunY, 34, 34); ctx.fill();
    ctx.restore();
  }

  // Cloud bands drifting with the timeline.
  const rnd = seededRng(0xC10D);
  ctx.save();
  for (let i = 0; i < 7; i++) {
    const baseX = rnd() * W;
    const y = 40 + rnd() * (HORIZON - 130);
    const w = 130 + rnd() * 220, h = 16 + rnd() * 20;
    const x = ((baseX + t * 46 * (0.4 + rnd() * 0.6)) % (W + 400)) - 200;
    ctx.fillStyle = `rgba(255,255,255,${0.05 + rnd() * 0.07})`;
    ctx.beginPath(); ellipse(ctx, x, y, w / 2, h / 2); ctx.fill();
    ctx.beginPath(); ellipse(ctx, x + w * 0.22, y - h * 0.3, w / 3, h / 2.4); ctx.fill();
  }
  ctx.restore();
}

function drawDistantRange(ctx: Ctx, pal: Mood): void {
  const rnd = seededRng(0x0DDCA5);
  for (const [depth, alpha] of [[1, 0.55], [0.62, 0.75]] as const) {
    ctx.save();
    ctx.fillStyle = hexToRgba(0x2a3550, alpha * 0.6);
    ctx.beginPath();
    ctx.moveTo(-200, HORIZON + 4);
    let x = -200;
    while (x < W + 200) {
      const peak = (40 + rnd() * 90) * depth;
      const span = 90 + rnd() * 130;
      ctx.lineTo(x + span / 2, HORIZON + 4 - peak);
      ctx.lineTo(x + span, HORIZON + 4);
      x += span;
    }
    ctx.lineTo(W + 200, HORIZON + 40);
    ctx.lineTo(-200, HORIZON + 40);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  ctx.save();
  ctx.fillStyle = pal.haze;
  ctx.fillRect(-200, HORIZON - 70, W + 400, 90);
  ctx.restore();
}

function drawGround(ctx: Ctx, pal: Mood): void {
  const g = ctx.createLinearGradient(0, HORIZON, 0, H + 80);
  g.addColorStop(0, pal.groundFar);
  g.addColorStop(1, pal.ground);
  ctx.fillStyle = g;
  ctx.fillRect(-200, HORIZON, W + 400, H - HORIZON + 200);

  // Perspective furrows converging on the castle, which sells the depth.
  ctx.save();
  ctx.strokeStyle = "rgba(0,0,0,0.10)";
  ctx.lineWidth = 2;
  for (let i = -12; i <= 12; i++) {
    ctx.beginPath();
    ctx.moveTo(W / 2 + i * 22, HORIZON + 2);
    ctx.lineTo(W / 2 + i * 190, H + 80);
    ctx.stroke();
  }
  for (let j = 1; j < 9; j++) {
    const y = HORIZON + Math.pow(j / 9, 2) * (H - HORIZON + 80);
    ctx.strokeStyle = `rgba(0,0,0,${0.05 + j * 0.008})`;
    ctx.beginPath(); ctx.moveTo(-200, y); ctx.lineTo(W + 200, y); ctx.stroke();
  }
  ctx.restore();
}

// The target castle, standing on the ridge behind the horizon. Gates crack open
// during MUSTER so the garrison has somewhere to come from.
async function drawCastle(
  ctx: Ctx, mod: CanvasMod, view: SiegeCinematicView, pal: Mood, t: number,
): Promise<void> {
  const cx = W / 2, feetY = HORIZON + 24;
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.34)";
  ctx.beginPath(); ellipse(ctx, cx, feetY, 190, 22); ctx.fill();
  ctx.restore();

  // A broad rise for the castle to stand on. Two overlapping swells with soft
  // colour steps, so the keep reads as sitting ON the land rather than on a box.
  ctx.save();
  for (const [halfW, lift, tint] of [[420, 34, -8], [300, 58, 4]] as const) {
    ctx.fillStyle = shiftColor(pal.groundFar, tint);
    ctx.beginPath();
    ctx.moveTo(cx - halfW, feetY + 26);
    ctx.bezierCurveTo(cx - halfW * 0.5, feetY + 26 - lift, cx + halfW * 0.5, feetY + 26 - lift, cx + halfW, feetY + 26);
    ctx.closePath(); ctx.fill();
  }
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.beginPath();
  ctx.moveTo(cx - 300, feetY + 26);
  ctx.bezierCurveTo(cx - 150, feetY - 32, cx + 20, feetY - 32, cx + 40, feetY + 26);
  ctx.closePath(); ctx.fill();
  ctx.restore();

  const path = spriteForPrefix("building", view.structure)
    ?? spriteForPrefix("building", "castle")
    ?? spriteForPrefix("building", "keep");
  const img = path ? await loadSprite(mod, path).catch(() => null) : null;
  const gateOpen = easeInOutCubic(beat(t, 0.18, 0.40));

  if (img) {
    // A bundled castle already has its own gate and pennants, and it is not
    // reliably centred in its PNG — drawing ours over it would land a floating
    // portcullis beside the keep. Sell the gate opening with light spilling out
    // of the base instead, and flank the keep with ground-planted banners.
    const { w: iw, h: ih } = imgSize(img);
    const h = 250, w = h * (iw / ih);
    blit(ctx, img, cx - w / 2, feetY + 4 - h, w, h);
    if (gateOpen > 0.05) {
      const glow = ctx.createRadialGradient(cx, feetY - 6, 4, cx, feetY - 6, 110);
      glow.addColorStop(0, `rgba(255,190,110,${0.40 * gateOpen})`);
      glow.addColorStop(1, "rgba(255,150,70,0)");
      ctx.fillStyle = glow;
      ctx.beginPath(); ellipse(ctx, cx, feetY - 6, 110, 54); ctx.fill();
    }
    drawFlankingBanners(ctx, cx, feetY + 6, w * 0.46, view.defenderColor, t);
  } else {
    const top = drawProceduralCastle(ctx, cx, feetY - 30, view.defenderColor);
    drawGate(ctx, cx, feetY - 30, 54, 70, gateOpen);
    drawBanners(ctx, cx, top + 30, 250, view.defenderColor, t);
  }
}

// Two tall banner poles planted either side of the keep, so a sprite castle
// still flies the defender's colours.
function drawFlankingBanners(
  ctx: Ctx, cx: number, groundY: number, offset: number, color: number, t: number,
): void {
  for (const dir of [-1, 1]) {
    const x = cx + dir * offset;
    const top = groundY - 150;
    const wave = Math.sin(t * Math.PI * 4 + dir) * 3;
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.beginPath(); ellipse(ctx, x, groundY, 7, 3); ctx.fill();
    ctx.strokeStyle = "#c9c1a8"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x, groundY); ctx.lineTo(x, top); ctx.stroke();
    ctx.fillStyle = hexToRgba(color, 0.95);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x + 30 + wave, top + 8);
    ctx.lineTo(x + 27 + wave, top + 62);
    ctx.lineTo(x, top + 54);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.beginPath(); ellipse(ctx, x + 13, top + 31, 5, 5); ctx.fill();
    ctx.restore();
  }
}

// The raid boss looming on the ridge, in place of a castle. It rises out of the
// ground during MUSTER, framed in its rarity colour with a menacing aura and two
// burning eyes, so a raid opens on the monster the party is about to face.
async function drawBoss(
  ctx: Ctx, mod: CanvasMod, view: SiegeCinematicView, pal: Mood, t: number,
): Promise<void> {
  const cx = W / 2, feetY = HORIZON + 24;
  const color = view.defenderColor;
  const colorHex = `#${(color >>> 0).toString(16).padStart(6, "0").slice(-6)}`;

  // A broad, dark rise for the boss to stand on — reads as a scorched mound.
  ctx.save();
  for (const [halfW, lift, tint] of [[440, 30, -18], [300, 54, -6]] as const) {
    ctx.fillStyle = shiftColor(pal.groundFar, tint);
    ctx.beginPath();
    ctx.moveTo(cx - halfW, feetY + 26);
    ctx.bezierCurveTo(cx - halfW * 0.5, feetY + 26 - lift, cx + halfW * 0.5, feetY + 26 - lift, cx + halfW, feetY + 26);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();

  // Long cast shadow.
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.42)";
  ctx.beginPath(); ellipse(ctx, cx, feetY + 8, 210, 26); ctx.fill();
  ctx.restore();

  // The boss rises during MUSTER (0.16 → 0.46) — camera arrives, boss stands up.
  const rise = easeInOutCubic(beat(t, 0.14, 0.48));
  const bh = 320, bw = bh * 0.74;
  const bx = cx - bw / 2;
  const sink = (1 - rise) * bh * 0.55;         // starts half-buried in the mound
  const by = feetY + 10 - bh + sink;

  // Menacing aura swelling as it stands.
  ctx.save();
  const aura = ctx.createRadialGradient(cx, by + bh * 0.42, 20, cx, by + bh * 0.42, bw * 1.15);
  aura.addColorStop(0, hexToRgba(color, 0.42 * rise + 0.08));
  aura.addColorStop(0.6, hexToRgba(color, 0.16 * rise));
  aura.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = aura;
  ctx.beginPath(); ellipse(ctx, cx, by + bh * 0.42, bw * 1.15, bh * 0.62); ctx.fill();
  ctx.restore();

  // Boss banners flanking, in its colour.
  drawFlankingBanners(ctx, cx, feetY + 6, bw * 0.62, color, t);

  const img = view.bossArtUrl ? await loadSprite(mod, view.bossArtUrl).catch(() => null) : null;

  // Clip to the mound so the buried portion is hidden as it rises.
  ctx.save();
  ctx.beginPath();
  ctx.rect(bx - 40, by - 40, bw + 80, (feetY + 12) - (by - 40));
  ctx.clip();

  // Backing plate + rim light in the rarity colour.
  ctx.save();
  ctx.shadowColor = hexToRgba(color, 0.9);
  ctx.shadowBlur = 34;
  roundRectPath(ctx, bx, by, bw, bh, 18);
  ctx.fillStyle = "#0b0d12"; ctx.fill();
  ctx.restore();

  ctx.save();
  roundRectPath(ctx, bx, by, bw, bh, 18);
  ctx.clip();
  if (img) {
    await drawCardArt(ctx, mod, bx, by, bw, bh, view.bossArtUrl!);
  } else {
    // No art — a dark monstrous silhouette so the shot still lands.
    const g = ctx.createLinearGradient(0, by, 0, by + bh);
    g.addColorStop(0, shiftColor(colorHex, -60));
    g.addColorStop(1, "#0a0a0d");
    ctx.fillStyle = g; ctx.fillRect(bx, by, bw, bh);
  }
  // Bottom scrim so it sits in the darkness of the mound.
  const scrim = ctx.createLinearGradient(0, by + bh - 90, 0, by + bh);
  scrim.addColorStop(0, "rgba(0,0,0,0)");
  scrim.addColorStop(1, "rgba(0,0,0,0.9)");
  ctx.fillStyle = scrim; ctx.fillRect(bx, by + bh - 90, bw, 90);
  ctx.restore();

  // Frame.
  ctx.save();
  roundRectPath(ctx, bx, by, bw, bh, 18);
  ctx.strokeStyle = hexToRgba(color, 0.95); ctx.lineWidth = 4; ctx.stroke();
  ctx.restore();

  // Two burning eyes that ignite as the boss finishes rising.
  const glow = clamp01((rise - 0.55) / 0.45) * (0.7 + 0.3 * Math.sin(t * Math.PI * 8));
  if (glow > 0.02) {
    ctx.save();
    ctx.shadowColor = "rgba(255,80,40,0.95)"; ctx.shadowBlur = 22 * glow;
    ctx.fillStyle = `rgba(255,${90 + Math.floor(60 * glow)},50,${0.85 * glow})`;
    for (const dir of [-1, 1]) {
      ctx.beginPath(); ellipse(ctx, cx + dir * bw * 0.14, by + bh * 0.30, 6.5, 4.5); ctx.fill();
    }
    ctx.restore();
  }
  ctx.restore(); // mound clip
}

function drawProceduralCastle(ctx: Ctx, cx: number, feetY: number, color: number): number {
  const stoneL = "#d8d2c0", stone = "#c3bca7", stoneD = "#9a927c", dark = "#22201b";
  const roof = shiftColor(`#${color.toString(16).padStart(6, "0")}`, -50);
  const crenel = (x: number, w: number, topY: number, teethW = 15) => {
    ctx.fillStyle = stone;
    const teeth = Math.max(3, Math.floor(w / teethW));
    const tw = w / (teeth * 2 - 1);
    for (let i = 0; i < teeth; i++) ctx.fillRect(x + i * tw * 2, topY, tw, 12);
  };
  const tower = (tx: number, tw: number, th: number, conical: boolean) => {
    const g = ctx.createLinearGradient(tx, 0, tx + tw, 0);
    g.addColorStop(0, stoneL); g.addColorStop(0.5, stone); g.addColorStop(1, stoneD);
    ctx.fillStyle = g; ctx.fillRect(tx, feetY - th, tw, th);
    if (conical) {
      ctx.fillStyle = roof;
      ctx.beginPath();
      ctx.moveTo(tx - 7, feetY - th);
      ctx.lineTo(tx + tw / 2, feetY - th - 44);
      ctx.lineTo(tx + tw + 7, feetY - th);
      ctx.closePath(); ctx.fill();
    } else crenel(tx - 3, tw + 6, feetY - th - 12);
    ctx.fillStyle = dark;
    for (const wy of [0.74, 0.52, 0.30]) ctx.fillRect(tx + tw * 0.4, feetY - th * wy, tw * 0.2, th * 0.1);
  };

  const wallW = 320, wallH = 118;
  const wg = ctx.createLinearGradient(cx - wallW / 2, 0, cx + wallW / 2, 0);
  wg.addColorStop(0, stoneL); wg.addColorStop(1, stoneD);
  ctx.fillStyle = wg; ctx.fillRect(cx - wallW / 2, feetY - wallH, wallW, wallH);
  crenel(cx - wallW / 2, wallW, feetY - wallH - 12);

  tower(cx - 34, 68, 208, true);                 // central keep
  tower(cx - wallW / 2 - 16, 54, 158, true);     // corner towers
  tower(cx + wallW / 2 - 38, 54, 158, true);
  return feetY - 208 - 44;
}

// A portcullis that lifts as `open` goes 0 → 1.
function drawGate(ctx: Ctx, cx: number, feetY: number, w: number, h: number, open: number): void {
  ctx.save();
  ctx.fillStyle = "#15120e";
  ctx.beginPath();
  ctx.moveTo(cx - w / 2, feetY);
  ctx.lineTo(cx - w / 2, feetY - h * 0.62);
  ctx.arc(cx, feetY - h * 0.62, w / 2, Math.PI, 0);
  ctx.lineTo(cx + w / 2, feetY);
  ctx.closePath(); ctx.fill();
  // Torchlight from inside once the gate is cracked.
  if (open > 0.05) {
    const g = ctx.createLinearGradient(0, feetY - h, 0, feetY);
    g.addColorStop(0, `rgba(255,180,90,${0.30 * open})`);
    g.addColorStop(1, `rgba(255,140,60,${0.08 * open})`);
    ctx.fillStyle = g; ctx.fill();
  }
  // Portcullis grid, riding up.
  const lift = h * 0.9 * open;
  ctx.save();
  ctx.beginPath();
  ctx.rect(cx - w / 2, feetY - h, w, h);
  ctx.clip();
  ctx.strokeStyle = "#6b5a3e"; ctx.lineWidth = 3;
  for (let i = 0; i <= 4; i++) {
    const x = cx - w / 2 + (w / 4) * i;
    ctx.beginPath(); ctx.moveTo(x, feetY - h - lift); ctx.lineTo(x, feetY - lift); ctx.stroke();
  }
  for (let j = 0; j <= 4; j++) {
    const y = feetY - lift - (h / 4) * j;
    ctx.beginPath(); ctx.moveTo(cx - w / 2, y); ctx.lineTo(cx + w / 2, y); ctx.stroke();
  }
  ctx.restore();
  ctx.restore();
}

// Defender banners rippling along the wall.
function drawBanners(ctx: Ctx, cx: number, y: number, span: number, color: number, t: number): void {
  ctx.save();
  for (let i = -2; i <= 2; i++) {
    const x = cx + i * (span / 5.2);
    const wave = Math.sin(t * Math.PI * 4 + i) * 3;
    ctx.strokeStyle = "#c9c1a8"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y - 12); ctx.lineTo(x, y + 6); ctx.stroke();
    ctx.fillStyle = hexToRgba(color, 0.95);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 22 + wave, y + 5);
    ctx.lineTo(x + 20 + wave, y + 32);
    ctx.lineTo(x, y + 28);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.beginPath(); ellipse(ctx, x + 10, y + 15, 3, 3); ctx.fill();
  }
  ctx.restore();
}

// ── Little people ─────────────────────────────────────────────────────────────

// One 12px-tall soldier: helmet, cloak, spear. Deliberately simple so a hundred
// of them stay cheap to draw and still read as a crowd.
function drawSoldier(
  ctx: Ctx, x: number, y: number, s: number, body: string, trim: string, spear: boolean, phase: number,
): void {
  const bob = Math.sin(phase) * 1.2 * s;
  const yy = y + bob;
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.26)";
  ctx.beginPath(); ellipse(ctx, x, y + 1 * s, 5 * s, 2 * s); ctx.fill();
  // Legs, mid-stride.
  ctx.strokeStyle = shiftColor(body, -40); ctx.lineWidth = 1.6 * s;
  const stride = Math.sin(phase) * 2.4 * s;
  ctx.beginPath(); ctx.moveTo(x, yy - 5 * s); ctx.lineTo(x - stride, yy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x, yy - 5 * s); ctx.lineTo(x + stride, yy); ctx.stroke();
  // Cloak / torso.
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(x - 3.4 * s, yy - 5 * s);
  ctx.lineTo(x + 3.4 * s, yy - 5 * s);
  ctx.lineTo(x + 2.4 * s, yy - 12 * s);
  ctx.lineTo(x - 2.4 * s, yy - 12 * s);
  ctx.closePath(); ctx.fill();
  // Helmet.
  ctx.fillStyle = trim;
  ctx.beginPath(); ellipse(ctx, x, yy - 14 * s, 2.6 * s, 2.6 * s); ctx.fill();
  if (spear) {
    ctx.strokeStyle = "#8a6a3f"; ctx.lineWidth = 1.2 * s;
    ctx.beginPath(); ctx.moveTo(x + 4 * s, yy + 1 * s); ctx.lineTo(x + 2.4 * s, yy - 24 * s); ctx.stroke();
    ctx.fillStyle = "#d7dbe0";
    ctx.beginPath();
    ctx.moveTo(x + 2.4 * s, yy - 28 * s);
    ctx.lineTo(x + 4.4 * s, yy - 23 * s);
    ctx.lineTo(x + 0.6 * s, yy - 23 * s);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

// The defenders forming a line outside the gate as it opens. Kept at GROUND
// level rather than on the battlements: a bundled castle sprite has unknown
// wall geometry, so the only place a figure reliably reads as "on the castle"
// is standing in front of it.
function drawGarrison(ctx: Ctx, view: SiegeCinematicView, t: number): void {
  const show = beat(t, 0.16, 0.34);
  if (show <= 0) return;
  const n = Math.max(3, Math.min(9, view.garrison + 3));
  const body = `#${view.defenderColor.toString(16).padStart(6, "0")}`;
  const lineY = HORIZON + 46;
  ctx.save();
  ctx.globalAlpha = show;
  for (let i = 0; i < n; i++) {
    const spread = n === 1 ? 0.5 : i / (n - 1);
    const x = W / 2 - 190 + spread * 380;
    // They hold the line, so only a shallow sway rather than a marching stride.
    drawSoldier(ctx, x, lineY, 0.78, body, shiftColor(body, 60), true, Math.sin(t * 3 + i) * 0.4);
  }
  ctx.restore();
}

// The attacker's army marching out of the foreground into formation. Ranks
// stream in during MUSTER and settle by the time the cards arrive.
function drawMarchingRanks(ctx: Ctx, view: SiegeCinematicView, t: number): void {
  const march = easeInOutCubic(beat(t, 0.20, 0.58));
  if (march <= 0) return;
  const body = `#${view.attackerColor.toString(16).padStart(6, "0")}`;
  const trim = shiftColor(body, 70);
  const rows = 3;
  ctx.save();
  for (let r = 0; r < rows; r++) {
    const rowT = clamp01((march - r * 0.12) / 0.7);
    if (rowT <= 0) continue;
    const baseY = H - 74 - r * 40;
    const scale = 1.45 - r * 0.2;
    const count = 9 + r * 2;
    for (let i = 0; i < count; i++) {
      const spread = (i / (count - 1) - 0.5);
      const targetX = W / 2 + spread * (620 - r * 70);
      // March in from just off-frame on the side they'll end up on.
      const fromX = targetX + Math.sign(spread || 1) * 420;
      const x = fromX + (targetX - fromX) * rowT;
      drawSoldier(ctx, x, baseY, scale, body, trim, true, t * 9 + i * 0.7 + r);
    }
  }
  ctx.restore();
}

// The siege line the army sets up: pavise shields, stakes and braziers planted
// across the field during DEPLOY.
function drawSiegeLine(ctx: Ctx, view: SiegeCinematicView, t: number): void {
  const set = easeOutBack(beat(t, 0.60, 0.86));
  if (set <= 0) return;
  const body = `#${view.attackerColor.toString(16).padStart(6, "0")}`;
  const y = H - 118;
  ctx.save();
  ctx.globalAlpha = clamp01(set);
  for (let i = -4; i <= 4; i++) {
    const x = W / 2 + i * 118;
    const rise = (1 - clamp01(set)) * 40;
    // Stakes.
    ctx.strokeStyle = "#7a5b34"; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(x - 16, y + 18 + rise); ctx.lineTo(x + 2, y - 14 + rise); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + 16, y + 18 + rise); ctx.lineTo(x - 2, y - 14 + rise); ctx.stroke();
    // Pavise shield: flat top, tapered point, with a central boss.
    if (i % 2 === 0) {
      const sy = y - 14 + rise;
      ctx.fillStyle = shiftColor(body, -30);
      polyPath(ctx, [
        { x: x - 15, y: sy }, { x: x + 15, y: sy },
        { x: x + 13, y: sy + 26 }, { x: x, y: sy + 40 }, { x: x - 13, y: sy + 26 },
      ]);
      ctx.fill();
      ctx.strokeStyle = shiftColor(body, 70); ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = shiftColor(body, 40);
      ctx.beginPath(); ellipse(ctx, x, sy + 16, 5, 5); ctx.fill();
    } else {
      // Brazier with a flickering flame.
      ctx.fillStyle = "#4a4038";
      roundRectPath(ctx, x - 9, y + 6 + rise, 18, 12, 3); ctx.fill();
      const flick = 0.7 + 0.3 * Math.sin(t * Math.PI * 12 + i);
      ctx.save();
      ctx.shadowColor = "rgba(255,150,60,0.9)"; ctx.shadowBlur = 18 * flick;
      ctx.fillStyle = "#ff9a3c";
      ctx.beginPath();
      ctx.moveTo(x, y - 8 * flick + rise);
      ctx.quadraticCurveTo(x + 8, y + 4 + rise, x, y + 8 + rise);
      ctx.quadraticCurveTo(x - 8, y + 4 + rise, x, y - 8 * flick + rise);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }
  ctx.restore();
}

// ── The cards pulling in ──────────────────────────────────────────────────────
// The raider's squad flies in from off-frame and slams into a fan formation
// above the siege line, each with a landing shockwave.
async function drawIncomingCards(
  ctx: Ctx, mod: CanvasMod, view: SiegeCinematicView, t: number,
): Promise<void> {
  const cards = view.cards.slice(0, 5);
  if (cards.length === 0) return;
  const cw = 98, ch = 132;
  const spread = Math.min(780, cards.length * 178);

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i]!;
    // Stagger each card's entrance across THE CARDS beat.
    const from = 0.42 + i * 0.045;
    const p = beat(t, from, from + 0.16);
    if (p <= 0) continue;
    const e = easeOutBack(p);

    const frac = cards.length === 1 ? 0.5 : i / (cards.length - 1);
    const targetX = W / 2 + (frac - 0.5) * spread;
    const targetY = H - 214 + Math.abs(frac - 0.5) * 34; // a shallow fan
    // Alternate the side each card streaks in from.
    const fromX = i % 2 === 0 ? -cw * 2 : W + cw * 2;
    const x = fromX + (targetX - fromX) * e;
    const y = targetY - 70 * (1 - e);
    const tilt = (1 - e) * (i % 2 === 0 ? -0.5 : 0.5);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(tilt);

    // Motion streak while still travelling.
    if (p < 0.85) {
      ctx.save();
      ctx.globalAlpha = (1 - p) * 0.5;
      ctx.fillStyle = hexToRgba(card.rarityColor, 0.6);
      const dir = i % 2 === 0 ? -1 : 1;
      roundRectPath(ctx, dir * 60 - cw / 2, -ch / 2 + 12, cw + 120, ch - 24, 20);
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    ctx.shadowColor = hexToRgba(card.rarityColor, 0.85);
    ctx.shadowBlur = 26;
    roundRectPath(ctx, -cw / 2, -ch / 2, cw, ch, 12);
    ctx.fillStyle = "#0d0f14"; ctx.fill();
    ctx.restore();

    ctx.save();
    roundRectPath(ctx, -cw / 2, -ch / 2, cw, ch, 12);
    ctx.clip();
    await drawCardArt(ctx, mod, -cw / 2, -ch / 2, cw, ch, card.artUrl);
    const g = ctx.createLinearGradient(0, ch / 2 - 34, 0, ch / 2);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.85)");
    ctx.fillStyle = g; ctx.fillRect(-cw / 2, ch / 2 - 34, cw, 34);
    ctx.restore();

    ctx.save();
    roundRectPath(ctx, -cw / 2, -ch / 2, cw, ch, 12);
    ctx.strokeStyle = hexToRgba(card.rarityColor, 0.95); ctx.lineWidth = 3.5; ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    drawTitle(ctx, card.name, 0, ch / 2 - 16, "#ffffff", fitText(ctx, card.name, cw - 12, 15, 10, TITLE_FONT));
    ctx.restore();
    ctx.restore();

    // Landing shockwave the instant the card sets down.
    if (p > 0.72 && p < 1) {
      const s = (p - 0.72) / 0.28;
      ctx.save();
      ctx.strokeStyle = hexToRgba(card.rarityColor, (1 - s) * 0.8);
      ctx.lineWidth = 4 * (1 - s) + 1;
      ctx.beginPath(); ellipse(ctx, targetX, targetY + ch / 2, 34 + s * 90, 10 + s * 26); ctx.stroke();
      ctx.restore();
    }
  }
}

// ── Atmosphere & chrome ───────────────────────────────────────────────────────

function drawWeather(ctx: Ctx, pal: Mood, t: number, rnd: () => number): void {
  if (pal.particle === "none") return;
  ctx.save();
  const n = pal.particle === "rain" ? 130 : 90;
  for (let i = 0; i < n; i++) {
    const seedX = rnd(), seedY = rnd(), speed = 0.5 + rnd();
    const x = ((seedX * W) + (pal.particle === "rain" ? t * 260 : t * 90) * speed) % (W + 60) - 30;
    const y = ((seedY * H) + t * (pal.particle === "rain" ? 900 : 240) * speed) % (H + 60) - 30;
    if (pal.particle === "rain") {
      ctx.strokeStyle = "rgba(200,220,245,0.35)"; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 5, y + 16); ctx.stroke();
    } else if (pal.particle === "snow") {
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.beginPath(); ellipse(ctx, x, y, 1.8 + rnd() * 1.6, 1.8 + rnd() * 1.6); ctx.fill();
    } else {
      ctx.fillStyle = `rgba(255,${120 + Math.floor(rnd() * 80)},60,0.55)`;
      ctx.beginPath(); ellipse(ctx, x, y, 1.4 + rnd() * 1.6, 1.4 + rnd() * 1.6); ctx.fill();
    }
  }
  ctx.restore();
}

function drawLighting(ctx: Ctx, pal: Mood, t: number): void {
  const key = ctx.createRadialGradient(W / 2, HORIZON - 60, 40, W / 2, HORIZON + 60, 700);
  key.addColorStop(0, pal.keyLight);
  key.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = key; ctx.fillRect(0, 0, W, H);

  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.30, W / 2, H / 2, W * 0.76);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.58)");
  ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);

  // Horn-blast flash on ENGAGE.
  const flash = beat(t, 0.86, 0.93) * (1 - beat(t, 0.93, 1));
  if (flash > 0.02) {
    ctx.fillStyle = `rgba(255,240,210,${flash * 0.35})`;
    ctx.fillRect(0, 0, W, H);
  }

  // Fade from black on the very first frames so the film "starts".
  const fadeIn = 1 - clamp01(t / 0.07);
  if (fadeIn > 0) {
    ctx.fillStyle = `rgba(0,0,0,${fadeIn})`;
    ctx.fillRect(0, 0, W, H);
  }
}

function drawLetterbox(ctx: Ctx, t: number): void {
  // Bars slide in over the first beat and stay — it's a cutscene.
  const h = 44 * clamp01(t / 0.12);
  ctx.save();
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, W, h);
  ctx.fillRect(0, H - h, W, h);
  ctx.restore();
}

// Strip Discord markdown. Unicode emoji and custom emoji markup stay so the
// canvas font and the emoji painter can draw them.
function stripCaption(s: string): string {
  const marks: string[] = [];
  const held = s.replace(/<(a)?:[\w~]+:\d+>/g, (m) => {
    marks.push(m);
    return `\u0000${marks.length - 1}\u0000`;
  });
  return held
    .replace(/\*\*|\*|__|_|`|~~/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\u0000(\d+)\u0000/g, (_all, i: string) => marks[Number(i)] ?? "");
}

// Greedy word-wrap to a pixel width. Caller sets ctx.font first.
function wrapCaption(ctx: Ctx, text: string, maxWidth: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width <= maxWidth || !cur) cur = next;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

// The raid caption track: reveal each story beat in turn as a typewritten
// lower-third caption, so the party reads the intro "word for word" over the
// film. One beat on screen at a time; each types in, holds, then fades.
function drawBeatTrack(ctx: Ctx, beats: string[], t: number): void {
  const lines = beats.map(stripCaption).filter(Boolean);
  if (!lines.length) return;
  const START = 0.09, END = 0.82;
  const span = (END - START) / lines.length;
  if (t < START || t > END) return;
  const idx = Math.min(lines.length - 1, Math.floor((t - START) / span));
  const local = clamp01((t - (START + idx * span)) / span); // 0→1 within this beat

  const full = lines[idx]!;
  const reveal = clamp01(local / 0.5);                       // type over first half
  const shown = full.slice(0, Math.max(1, Math.ceil(full.length * reveal)));
  const appear = clamp01(local / 0.08);
  const fade = 1 - clamp01((local - 0.88) / 0.12);
  const alpha = Math.min(appear, fade);
  if (alpha <= 0.02) return;

  const fontSize = 23;
  ctx.save();
  ctx.font = `bold ${fontSize}px "${TITLE_FONT}", "DejaVu Sans", Arial, sans-serif`;
  const wrapped = wrapCaption(ctx, shown, W - 240).slice(-2);
  const lineH = fontSize + 9;
  const widest = Math.max(...wrapped.map(l => ctx.measureText(l).width));
  const blockH = wrapped.length * lineH;
  const cyBottom = H - 64;
  const topY = cyBottom - blockH;

  // Translucent caption plate.
  ctx.globalAlpha = alpha * 0.9;
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  roundRectPath(ctx, W / 2 - widest / 2 - 22, topY - 14, widest + 44, blockH + 20, 12);
  ctx.fill();

  ctx.globalAlpha = alpha;
  wrapped.forEach((line, i) => {
    const y = topY + i * lineH + lineH / 2;
    drawTextWithShadow(ctx, line, W / 2, y, "#ffffff", fontSize, "center", TITLE_FONT);
  });
  ctx.restore();
}

function drawCaptions(ctx: Ctx, view: SiegeCinematicView, t: number): void {
  // Raid caption track (word-by-word intro script), drawn first so the final
  // title card lands over it.
  if (view.beats?.length) drawBeatTrack(ctx, view.beats, t);

  // Beat 1: where we are.
  const locIn = clamp01((t - 0.06) / 0.10) * (1 - clamp01((t - 0.34) / 0.08));
  if (locIn > 0.02) {
    ctx.save();
    ctx.globalAlpha = locIn;
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    drawTitle(ctx, view.targetName.toUpperCase(), 56, 96, "#ffffff",
      fitText(ctx, view.targetName.toUpperCase(), W - 140, 34, 18, TITLE_FONT), "left");
    drawTextWithShadow(ctx, `held by ${view.holderName}`, 58, 126, "rgba(226,226,232,0.9)", 16, "left");
    ctx.fillStyle = hexToRgba(view.defenderColor, 0.95);
    ctx.fillRect(48, 78, 4, 60);
    ctx.restore();
  }

  // Beat 3: who is attacking.
  const armyIn = clamp01((t - 0.44) / 0.08) * (1 - clamp01((t - 0.80) / 0.06));
  if (armyIn > 0.02) {
    ctx.save();
    ctx.globalAlpha = armyIn;
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    drawTitle(ctx, view.attackerName.toUpperCase(), W - 56, 96, "#ffffff",
      fitText(ctx, view.attackerName.toUpperCase(), W - 140, 30, 16, TITLE_FONT), "right");
    drawTextWithShadow(ctx, `${view.cards.length} card${view.cards.length === 1 ? "" : "s"} committed`,
      W - 58, 124, "rgba(226,226,232,0.9)", 15, "right");
    ctx.fillStyle = hexToRgba(view.attackerColor, 0.95);
    ctx.fillRect(W - 52, 78, 4, 60);
    ctx.restore();
  }

  // Beat 5: the title card.
  const titleP = beat(t, 0.86, 1);
  if (titleP > 0) {
    const e = easeOutBack(clamp01(titleP / 0.6));
    ctx.save();
    ctx.translate(W / 2, H / 2 - 58);
    ctx.scale(0.86 + 0.14 * e, 0.86 + 0.14 * e);
    ctx.globalAlpha = clamp01(titleP * 3);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const label = view.titleText ?? "THE SIEGE BEGINS";
    ctx.font = `bold 44px "${TITLE_FONT}", "DejaVu Sans", Arial, sans-serif`;
    const bw = ctx.measureText(label).width + 80;
    ctx.fillStyle = "rgba(0,0,0,0.68)";
    roundRectPath(ctx, -bw / 2, -40, bw, 80, 16); ctx.fill();
    ctx.strokeStyle = hexToRgba(view.attackerColor, 0.9); ctx.lineWidth = 3;
    roundRectPath(ctx, -bw / 2, -40, bw, 80, 16); ctx.stroke();
    ctx.shadowColor = hexToRgba(view.attackerColor, 0.9); ctx.shadowBlur = 24;
    drawTitle(ctx, label, 0, -10, "#ffffff", 40);
    ctx.shadowBlur = 0;
    if (view.tagline) {
      drawTextWithShadow(ctx, view.tagline, 0, 22, "rgba(232,232,238,0.92)",
        fitText(ctx, view.tagline, bw - 40, 17, 11));
    }
    ctx.restore();

    // Crossed-swords wipe streaking across the title.
    const wipe = clamp01((titleP - 0.25) / 0.5);
    if (wipe > 0 && wipe < 1) {
      ctx.save();
      ctx.globalAlpha = Math.sin(wipe * Math.PI) * 0.55;
      const wx = -120 + wipe * (W + 240);
      const grad = ctx.createLinearGradient(wx - 90, 0, wx + 90, 0);
      grad.addColorStop(0, "rgba(255,255,255,0)");
      grad.addColorStop(0.5, "rgba(255,255,255,0.55)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = grad;
      polyPath(ctx, [
        { x: wx - 90, y: 0 }, { x: wx + 90, y: 0 },
        { x: wx + 40, y: H }, { x: wx - 140, y: H },
      ]);
      ctx.fill();
      ctx.restore();
    }
  }
}
