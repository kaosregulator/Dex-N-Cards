// ─────────────────────────────────────────────────────────────────────────────
// Quote card canvas renderer — Classic / Discord / 4K / Cinematic / fade.
// Uses @napi-rs/canvas + the shared render queue.
// ─────────────────────────────────────────────────────────────────────────────

import { getCanvas, type CanvasMod, type Ctx } from "../animations/engine.js";
import { queueRender } from "../animations/render-queue.js";
import { BRAND_NAME } from "../help-banners.js";
import { fitFontSize, wrapLines } from "./text.js";
import { quoteDisplayName, unstyleFancyText } from "./display-name.js";
import type { QuoteTheme } from "./styles.js";
import { logger } from "../../lib/logger.js";

export interface QuoteRenderInput {
  text: string;
  displayName: string;
  handle: string;
  avatarUrl: string | null;
  theme: QuoteTheme;
  watermark?: string;
  /** Optional timestamp for Discord / 4K overlays. */
  createdAt?: Date;
}

export const QUOTE_FILE = "quote.png";

type Img = { width: number; height: number };

async function loadAvatar(mod: CanvasMod, url: string | null): Promise<Img | null> {
  if (!url) return null;
  try {
    // data: URLs (preview harness) and http(s) Discord CDNs both work via fetch.
    const res = await fetch(url, { signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return await mod.loadImage(buf);
  } catch (err) {
    logger.debug({ err }, "quote: avatar load failed");
    return null;
  }
}

/** Twemoji PNGs — canvas can't reliably draw system emoji glyphs. */
const TWEMOJI_CACHE = new Map<string, Img | null>();
const TWEMOJI_CODES = {
  fire: "1f525",
  skull: "1f480",
  joy: "1f602",
} as const;

async function loadTwemoji(mod: CanvasMod, code: string): Promise<Img | null> {
  if (TWEMOJI_CACHE.has(code)) return TWEMOJI_CACHE.get(code) ?? null;
  try {
    const url = `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/${code}.png`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) {
      TWEMOJI_CACHE.set(code, null);
      return null;
    }
    const img = await mod.loadImage(Buffer.from(await res.arrayBuffer()));
    TWEMOJI_CACHE.set(code, img);
    return img;
  } catch (err) {
    logger.debug({ err, code }, "quote: twemoji load failed");
    TWEMOJI_CACHE.set(code, null);
    return null;
  }
}

async function loadReactionEmojis(mod: CanvasMod): Promise<Img[]> {
  const loaded = await Promise.all([
    loadTwemoji(mod, TWEMOJI_CODES.fire),
    loadTwemoji(mod, TWEMOJI_CODES.skull),
    loadTwemoji(mod, TWEMOJI_CODES.joy),
  ]);
  return loaded.filter((x): x is Img => !!x);
}

function toGray(ctx: Ctx, x: number, y: number, w: number, h: number): void {
  const data = ctx.getImageData(x, y, w, h);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const g = (px[i]! * 0.299 + px[i + 1]! * 0.587 + px[i + 2]! * 0.114) | 0;
    px[i] = g; px[i + 1] = g; px[i + 2] = g;
  }
  ctx.putImageData(data, x, y);
}

function drawCover(
  ctx: Ctx, img: Img,
  dx: number, dy: number, dw: number, dh: number,
): void {
  const ir = img.width / img.height;
  const dr = dw / dh;
  let sw: number, sh: number, sx: number, sy: number;
  if (ir > dr) {
    sh = img.height; sw = img.height * dr;
    sx = (img.width - sw) / 2; sy = 0;
  } else {
    sw = img.width; sh = img.width / dr;
    sx = 0; sy = (img.height - sh) / 2;
  }
  ctx.drawImage(img as any, sx, sy, sw, sh, dx, dy, dw, dh);
}

function drawImage(ctx: Ctx, img: unknown, x: number, y: number): void {
  (ctx as unknown as { drawImage(i: unknown, x: number, y: number): void }).drawImage(img, x, y);
}

function fontFamily(tone: QuoteTheme["fontTone"]): string {
  switch (tone) {
    case "display": return '"Orbitron", "Arial Black", Arial, sans-serif';
    case "impact": return '"Arial Black", Impact, Arial, sans-serif';
    case "serif": return 'Georgia, "Times New Roman", "Palatino Linotype", serif';
    case "mono": return '"Courier New", Courier, monospace';
    case "grunge": return '"Arial Black", Impact, Arial, sans-serif';
    default: return 'Arial, "Helvetica Neue", Helvetica, sans-serif';
  }
}

function handleOf(input: QuoteRenderInput): string {
  const h = unstyleFancyText(input.handle.replace(/^@/, "")) || "user";
  return `@${h}`;
}

/** Defense-in-depth: never paint a fancy-font nick as □□□ on canvas. */
function withReadableNames(input: QuoteRenderInput): QuoteRenderInput {
  return {
    ...input,
    displayName: quoteDisplayName(input.displayName, input.handle),
    handle: unstyleFancyText(input.handle.replace(/^@/, "")) || input.handle || "user",
  };
}

function quoteText(input: QuoteRenderInput, theme: QuoteTheme): string {
  const raw = (input.text || "…").trim();
  return theme.uppercaseQuote ? raw.toUpperCase() : raw;
}

function paintFlatBg(ctx: Ctx, theme: QuoteTheme, w: number, h: number): void {
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, w, h);
  if (theme.backgroundGradient) {
    const g = theme.backgroundGradient;
    const grad = ctx.createLinearGradient(g.x0 * w, g.y0 * h, g.x1 * w, g.y1 * h);
    for (const [color, stop] of g.stops) grad.addColorStop(stop, color);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }
}

function drawCircleAvatar(
  ctx: Ctx, img: Img | null, cx: number, cy: number, r: number,
  opts: { grayscale?: boolean; ring?: string; ringWidth?: number } = {},
): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (img) {
    drawCover(ctx, img, cx - r, cy - r, r * 2, r * 2);
    if (opts.grayscale) toGray(ctx, cx - r, cy - r, r * 2, r * 2);
  } else {
    ctx.fillStyle = "#333";
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }
  ctx.restore();
  if (opts.ring) {
    ctx.save();
    ctx.strokeStyle = opts.ring;
    ctx.lineWidth = opts.ringWidth ?? 3;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 1, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

// ── Classic (circular fade + serif) ───────────────────────────────────────────
function paintClassic(ctx: Ctx, mod: CanvasMod, theme: QuoteTheme, input: QuoteRenderInput, img: Img | null): void {
  const { width: w, height: h } = theme;
  paintFlatBg(ctx, theme, w, h);

  // Oversized circular avatar on the left, soft-fading into black on its right edge.
  const r = Math.round(h * 0.42);
  const cx = Math.round(w * 0.22);
  const cy = Math.round(h * 0.48);

  if (img) {
    const tmp = mod.createCanvas(w, h);
    const tctx = tmp.getContext("2d") as unknown as Ctx;
    drawCircleAvatar(tctx, img, cx, cy, r, { grayscale: theme.grayscale });
    // Feather the right half of the circle into the bg.
    const mask = tctx.createRadialGradient(cx - r * 0.15, cy, r * 0.35, cx, cy, r * 1.05);
    mask.addColorStop(0, "rgba(0,0,0,1)");
    mask.addColorStop(0.55, "rgba(0,0,0,0.85)");
    mask.addColorStop(0.82, "rgba(0,0,0,0.25)");
    mask.addColorStop(1, "rgba(0,0,0,0)");
    tctx.globalCompositeOperation = "destination-in";
    tctx.fillStyle = mask;
    tctx.fillRect(0, 0, w, h);
    drawImage(ctx, tmp, 0, 0);
  }

  const family = fontFamily(theme.fontTone);
  const textX = Math.round(w * 0.48);
  const textW = Math.round(w * 0.46);
  const text = quoteText(input, theme);

  // Oversized quotation marks.
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = `700 ${Math.round(h * 0.14)}px ${family}`;
  ctx.textAlign = "left";
  ctx.fillText("“", textX - 8, Math.round(h * 0.28));

  const fit = fitFontSize(ctx, text, textW, Math.round(h * 0.34), Math.round(h * 0.09), 22, family, "600");
  let y = Math.round(h * 0.34);
  ctx.fillStyle = theme.textColor;
  ctx.textAlign = "center";
  const midX = textX + textW / 2;
  for (const line of fit.lines) {
    ctx.font = `600 ${fit.size}px ${family}`;
    ctx.fillText(line, midX, y);
    y += fit.lineHeight;
  }

  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.font = `700 ${Math.round(h * 0.1)}px ${family}`;
  ctx.textAlign = "right";
  ctx.fillText("”", textX + textW + 4, y + Math.round(h * 0.02));

  // Divider + attribution.
  y += Math.round(h * 0.06);
  const lineW = Math.round(textW * 0.55);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(midX - lineW / 2, y);
  ctx.lineTo(midX + lineW / 2, y);
  ctx.stroke();

  y += Math.round(h * 0.055);
  ctx.fillStyle = theme.attributionColor;
  ctx.font = `500 ${Math.max(18, Math.round(h * 0.032))}px Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(`— ${input.displayName}`, midX, y);
  y += Math.round(h * 0.04);
  ctx.fillStyle = theme.handleColor;
  ctx.font = `400 ${Math.max(14, Math.round(h * 0.026))}px Arial, sans-serif`;
  ctx.fillText(handleOf(input), midX, y);

  y += Math.round(h * 0.035);
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.beginPath();
  ctx.moveTo(midX - lineW / 2, y);
  ctx.lineTo(midX + lineW / 2, y);
  ctx.stroke();

  if (theme.tagline) {
    ctx.fillStyle = theme.watermarkColor;
    ctx.font = `400 ${Math.max(12, Math.round(h * 0.022))}px Arial, sans-serif`;
    ctx.textAlign = "left";
    ctx.fillText(theme.tagline, Math.round(w * 0.04), h - 28);
  }
}

// ── Discord Capture ───────────────────────────────────────────────────────────
async function paintDiscord(
  ctx: Ctx, mod: CanvasMod, theme: QuoteTheme, input: QuoteRenderInput, img: Img | null,
): Promise<void> {
  const { width: w, height: h } = theme;
  // Outer bg
  ctx.fillStyle = "#111214";
  ctx.fillRect(0, 0, w, h);

  // Floating message card
  const pad = 28;
  const cardX = pad, cardY = pad, cardW = w - pad * 2, cardH = h - pad * 2;
  roundRect(ctx, cardX, cardY, cardW, cardH, 16);
  ctx.fillStyle = "#2B2D31";
  ctx.fill();
  // Soft shadow
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 8;
  roundRect(ctx, cardX, cardY, cardW, cardH, 16);
  ctx.fillStyle = "#2B2D31";
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  const av = 56;
  const ax = cardX + 22;
  const ay = cardY + 22;
  drawCircleAvatar(ctx, img, ax + av / 2, ay + av / 2, av / 2, { grayscale: false });

  const nameX = ax + av + 14;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = theme.attributionColor;
  ctx.font = `700 20px Arial, sans-serif`;
  ctx.fillText(input.displayName || "User", nameX, ay + 22);
  ctx.fillStyle = theme.handleColor;
  ctx.font = `400 15px Arial, sans-serif`;
  ctx.fillText(handleOf(input), nameX, ay + 44);

  const when = formatDiscordTime(input.createdAt ?? new Date());
  ctx.fillStyle = "#949BA4";
  ctx.font = `400 13px Arial, sans-serif`;
  ctx.textAlign = "right";
  ctx.fillText(when, cardX + cardW - 22, ay + 22);

  // Message body
  const bodyX = nameX;
  const bodyW = cardX + cardW - bodyX - 22;
  const body = (input.text || "…").trim();
  ctx.textAlign = "left";
  ctx.fillStyle = theme.textColor;
  ctx.font = `400 18px Arial, sans-serif`;
  const lines = wrapLines(ctx, body, bodyW);
  let y = ay + av + 18;
  for (const line of lines.slice(0, 6)) {
    ctx.fillText(line, bodyX, y);
    y += 26;
  }

  // Real Twemoji reactions — “someone already reacted to this chaos”
  const emojis = await loadReactionEmojis(mod);
  y = Math.max(y + 18, cardY + cardH - 52);
  let rx = bodyX;
  const counts = ["12", "7", "3"];
  for (let i = 0; i < 3; i++) {
    roundRect(ctx, rx, y - 18, 62, 28, 10);
    ctx.fillStyle = "#1E1F22";
    ctx.fill();
    ctx.strokeStyle = "#3F4147";
    ctx.lineWidth = 1;
    ctx.stroke();
    const emoji = emojis[i];
    if (emoji) {
      ctx.drawImage(emoji as any, rx + 8, y - 12, 16, 16);
    }
    ctx.fillStyle = "#DBDEE1";
    ctx.font = `600 13px Arial, sans-serif`;
    ctx.textAlign = "left";
    ctx.fillText(counts[i]!, rx + 28, y + 2);
    rx += 70;
  }
  // + button
  roundRect(ctx, rx, y - 18, 28, 28, 10);
  ctx.fillStyle = "#1E1F22";
  ctx.fill();
  ctx.strokeStyle = "#3F4147";
  ctx.stroke();
  ctx.fillStyle = "#B5BAC1";
  ctx.font = `700 16px Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText("+", rx + 14, y + 2);
}

function formatDiscordTime(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const ap = h >= 12 ? "PM" : "AM";
  const hr = ((h + 11) % 12) + 1;
  return `Today at ${hr}:${m} ${ap}`;
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// ── Caught in 4K ──────────────────────────────────────────────────────────────
function paintCaught4k(ctx: Ctx, theme: QuoteTheme, input: QuoteRenderInput, img: Img | null): void {
  const { width: w, height: h } = theme;
  paintFlatBg(ctx, theme, w, h);

  // Sparse film grain (every 4th pixel) — keeps the CCTV look without a 1MB PNG.
  const grain = ctx.getImageData(0, 0, w, h);
  const px = grain.data;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      const n = (Math.random() * 55) | 0;
      px[i] = Math.min(255, (px[i]! || 8) + n);
      px[i + 1] = Math.min(255, (px[i + 1]! || 8) + n);
      px[i + 2] = Math.min(255, (px[i + 2]! || 8) + n);
    }
  }
  ctx.putImageData(grain, 0, 0);

  // Thin white border + corner brackets
  ctx.strokeStyle = "rgba(255,255,255,0.7)";
  ctx.lineWidth = 2;
  ctx.strokeRect(18, 18, w - 36, h - 36);
  drawBracket(ctx, 30, 30, 48, 1, 1);
  drawBracket(ctx, w - 30, 30, 48, -1, 1);
  drawBracket(ctx, 30, h - 30, 48, 1, -1);
  drawBracket(ctx, w - 30, h - 30, 48, -1, -1);

  // REC
  ctx.fillStyle = theme.accentColor ?? "#FF2A2A";
  ctx.beginPath();
  ctx.arc(56, 56, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#FFFFFF";
  ctx.font = `700 22px ${fontFamily("mono")}`;
  ctx.textAlign = "left";
  ctx.fillText("REC", 74, 62);

  // Battery
  ctx.strokeStyle = "#FFFFFF";
  ctx.lineWidth = 2;
  ctx.strokeRect(w - 90, 44, 42, 22);
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(w - 48, 50, 6, 10);
  ctx.fillRect(w - 86, 48, 30, 14);

  // Avatar + text stack
  const av = 72;
  const ax = 70;
  const ay = Math.round(h * 0.32);
  drawCircleAvatar(ctx, img, ax + av / 2, ay + av / 2, av / 2, {
    grayscale: true,
    ring: "rgba(255,255,255,0.5)",
    ringWidth: 2,
  });

  const mono = fontFamily("mono");
  const tx = ax + av + 28;
  ctx.textAlign = "left";
  ctx.fillStyle = theme.attributionColor;
  ctx.font = `700 28px ${mono}`;
  ctx.fillText((input.displayName || "USER").toUpperCase(), tx, ay + 28);
  ctx.fillStyle = theme.handleColor;
  ctx.font = `400 20px ${mono}`;
  ctx.fillText(handleOf(input), tx, ay + 56);

  ctx.fillStyle = theme.textColor;
  ctx.font = `400 26px ${mono}`;
  const bodyW = w - tx - 70;
  const lines = wrapLines(ctx, (input.text || "…").trim(), bodyW);
  let y = ay + av + 36;
  for (const line of lines.slice(0, 5)) {
    ctx.fillText(line, ax, y);
    y += 34;
  }

  // Bottom stamps
  const d = input.createdAt ?? new Date();
  const stamp = formatCamcorderStamp(d);
  ctx.fillStyle = "#FFFFFF";
  ctx.font = `400 18px ${mono}`;
  ctx.textAlign = "left";
  ctx.fillText(stamp, 48, h - 42);
  ctx.textAlign = "right";
  ctx.font = `700 20px ${mono}`;
  ctx.fillText("CAUGHT IN 4K", w - 48, h - 42);
}

function drawBracket(ctx: Ctx, x: number, y: number, len: number, sx: number, sy: number): void {
  ctx.strokeStyle = "#FFFFFF";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x, y + sy * len);
  ctx.lineTo(x, y);
  ctx.lineTo(x + sx * len, y);
  ctx.stroke();
}

function formatCamcorderStamp(d: Date): string {
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const ap = h >= 12 ? "PM" : "AM";
  const hr = ((h + 11) % 12) + 1;
  return `${ap} ${hr}:${m}  /  ${months[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`;
}

// ── Cinematic ─────────────────────────────────────────────────────────────────
function paintCinematic(ctx: Ctx, theme: QuoteTheme, input: QuoteRenderInput, img: Img | null): void {
  const { width: w, height: h } = theme;
  paintSunsetLandscape(ctx, w, h);

  // Dark left vignette for user chip readability
  const vig = ctx.createLinearGradient(0, 0, w * 0.55, 0);
  vig.addColorStop(0, "rgba(0,0,0,0.72)");
  vig.addColorStop(0.55, "rgba(0,0,0,0.35)");
  vig.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);

  // Soft bottom wash for quote
  const wash = ctx.createLinearGradient(0, h * 0.35, 0, h);
  wash.addColorStop(0, "rgba(0,0,0,0)");
  wash.addColorStop(1, "rgba(0,0,0,0.45)");
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, w, h);

  // User chip top-left
  const av = 52;
  const ax = 48;
  const ay = 42;
  drawCircleAvatar(ctx, img, ax + av / 2, ay + av / 2, av / 2, {
    ring: "rgba(255,255,255,0.85)",
    ringWidth: 3,
  });
  ctx.textAlign = "left";
  ctx.fillStyle = "#FFFFFF";
  ctx.font = `700 20px Arial, sans-serif`;
  ctx.fillText((input.displayName || "USER").toUpperCase(), ax + av + 16, ay + 24);
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.font = `400 15px Arial, sans-serif`;
  ctx.fillText(handleOf(input), ax + av + 16, ay + 46);

  // Centered serif quote
  const family = fontFamily("serif");
  const text = quoteText(input, theme);
  const maxW = Math.round(w * 0.72);
  const fit = fitFontSize(ctx, text, maxW, Math.round(h * 0.28), Math.round(h * 0.08), 26, family, "600");
  let y = Math.round(h * 0.42);
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = `700 ${Math.round(h * 0.1)}px ${family}`;
  ctx.fillText("“", w / 2 - maxW / 2 - 10, y - 10);

  ctx.fillStyle = "#FFFFFF";
  for (const line of fit.lines) {
    ctx.font = `600 ${fit.size}px ${family}`;
    ctx.fillText(line, w / 2, y);
    y += fit.lineHeight;
  }
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.font = `700 ${Math.round(h * 0.08)}px ${family}`;
  ctx.fillText("”", w / 2 + maxW / 2 + 4, y);

  // Diamond divider + tagline
  y += Math.round(h * 0.06);
  const lw = Math.round(w * 0.28);
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(w / 2 - lw, y);
  ctx.lineTo(w / 2 - 10, y);
  ctx.moveTo(w / 2 + 10, y);
  ctx.lineTo(w / 2 + lw, y);
  ctx.stroke();
  // diamond
  ctx.beginPath();
  ctx.moveTo(w / 2, y - 5);
  ctx.lineTo(w / 2 + 5, y);
  ctx.lineTo(w / 2, y + 5);
  ctx.lineTo(w / 2 - 5, y);
  ctx.closePath();
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.fill();

  if (theme.tagline) {
    y += Math.round(h * 0.055);
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = `400 ${Math.max(14, Math.round(h * 0.028))}px ${fontFamily("mono")}`;
    ctx.fillText(theme.tagline, w / 2, y);
  }
}

/** Procedural sunset + silhouetted hills — no external scenic asset needed. */
function paintSunsetLandscape(ctx: Ctx, w: number, h: number): void {
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, "#1A1040");
  sky.addColorStop(0.35, "#C45C26");
  sky.addColorStop(0.55, "#F0A040");
  sky.addColorStop(0.7, "#F5C878");
  sky.addColorStop(1, "#2A1810");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // Soft sun
  const sunX = w * 0.62, sunY = h * 0.42, sunR = h * 0.12;
  const sun = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, sunR);
  sun.addColorStop(0, "rgba(255,240,200,0.95)");
  sun.addColorStop(0.5, "rgba(255,180,80,0.55)");
  sun.addColorStop(1, "rgba(255,120,40,0)");
  ctx.fillStyle = sun;
  ctx.beginPath();
  ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2);
  ctx.fill();

  // Far hills
  ctx.fillStyle = "#3A2218";
  ctx.beginPath();
  ctx.moveTo(0, h * 0.62);
  ctx.quadraticCurveTo(w * 0.25, h * 0.48, w * 0.45, h * 0.58);
  ctx.quadraticCurveTo(w * 0.7, h * 0.7, w, h * 0.55);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();

  // Near ridge
  ctx.fillStyle = "#1A100C";
  ctx.beginPath();
  ctx.moveTo(0, h * 0.78);
  ctx.quadraticCurveTo(w * 0.3, h * 0.68, w * 0.55, h * 0.8);
  ctx.quadraticCurveTo(w * 0.8, h * 0.9, w, h * 0.74);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();

  // Water reflection strip
  const water = ctx.createLinearGradient(0, h * 0.7, 0, h);
  water.addColorStop(0, "rgba(80,40,20,0.35)");
  water.addColorStop(0.4, "rgba(240,160,60,0.25)");
  water.addColorStop(1, "rgba(20,10,8,0.8)");
  ctx.fillStyle = water;
  ctx.fillRect(0, h * 0.7, w, h * 0.3);
}

// ── Shared Discord chip (bottom-right “proof” footer on meme styles) ──────────
function drawDiscordChip(
  ctx: Ctx, input: QuoteRenderInput, img: Img | null,
  w: number, h: number,
): void {
  const chipW = 280;
  const chipH = 44;
  const x = w - chipW - 36;
  const y = h - chipH - 28;

  ctx.fillStyle = themeAttr(input);
  ctx.font = `400 14px Arial, sans-serif`;
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.fillText(`— ${input.displayName || "someone"}`, x, y - 10);

  // Mini discord row
  const av = 28;
  drawCircleAvatar(ctx, img, x + av / 2, y + chipH / 2, av / 2, { grayscale: false });

  // Discord blurple badge
  ctx.fillStyle = "#5865F2";
  ctx.beginPath();
  ctx.arc(x + av + 6, y + 10, 5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#FFFFFF";
  ctx.font = `700 14px Arial, sans-serif`;
  ctx.textAlign = "left";
  ctx.fillText(clipName(input.displayName || "user", 18), x + av + 16, y + 18);
  ctx.fillStyle = "#949BA4";
  ctx.font = `400 11px Arial, sans-serif`;
  ctx.fillText(formatDiscordTime(input.createdAt ?? new Date()), x + av + 16, y + 34);
}

function clipName(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function themeAttr(_input: QuoteRenderInput): string {
  return "rgba(255,255,255,0.7)";
}

// ── Absolute Cinema ───────────────────────────────────────────────────────────
function paintAbsolute(ctx: Ctx, mod: CanvasMod, theme: QuoteTheme, input: QuoteRenderInput, img: Img | null): void {
  const { width: w, height: h } = theme;
  paintFlatBg(ctx, theme, w, h);

  const r = Math.round(h * 0.46);
  const cx = Math.round(w * 0.22);
  const cy = Math.round(h * 0.46);

  // Soft white glow behind circle
  if (img) {
    ctx.save();
    ctx.shadowColor = "rgba(255,255,255,0.55)";
    ctx.shadowBlur = 48;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.92, 0, Math.PI * 2);
    ctx.fillStyle = "#111";
    ctx.fill();
    ctx.restore();

    const tmp = mod.createCanvas(w, h);
    const tctx = tmp.getContext("2d") as unknown as Ctx;
    drawCircleAvatar(tctx, img, cx, cy, r, { grayscale: true });
    const mask = tctx.createRadialGradient(cx - r * 0.1, cy, r * 0.4, cx, cy, r * 1.05);
    mask.addColorStop(0, "rgba(0,0,0,1)");
    mask.addColorStop(0.7, "rgba(0,0,0,0.75)");
    mask.addColorStop(1, "rgba(0,0,0,0)");
    tctx.globalCompositeOperation = "destination-in";
    tctx.fillStyle = mask;
    tctx.fillRect(0, 0, w, h);
    drawImage(ctx, tmp, 0, 0);
  }

  const family = fontFamily("serif");
  const text = quoteText(input, theme);
  const textX = Math.round(w * 0.48);
  const textW = Math.round(w * 0.46);
  const fit = fitFontSize(ctx, text, textW, Math.round(h * 0.28), Math.round(h * 0.1), 26, family, "600");
  let y = Math.round(h * 0.36);
  const midX = textX + textW / 2;

  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = `700 ${Math.round(h * 0.12)}px ${family}`;
  ctx.textAlign = "left";
  ctx.fillText("“", textX - 6, y - 8);

  ctx.fillStyle = "#FFFFFF";
  ctx.textAlign = "center";
  for (const line of fit.lines) {
    ctx.font = `600 ${fit.size}px ${family}`;
    ctx.fillText(line, midX, y);
    y += fit.lineHeight;
  }
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.font = `700 ${Math.round(h * 0.1)}px ${family}`;
  ctx.textAlign = "right";
  ctx.fillText("”", textX + textW, y + 4);

  y += Math.round(h * 0.05);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(midX - textW * 0.28, y);
  ctx.lineTo(midX + textW * 0.28, y);
  ctx.stroke();

  drawDiscordChip(ctx, input, img, w, h);
}

// ── Glitch / Did he really say that ───────────────────────────────────────────
function paintGlitch(ctx: Ctx, mod: CanvasMod, theme: QuoteTheme, input: QuoteRenderInput, img: Img | null): void {
  const { width: w, height: h } = theme;
  paintFlatBg(ctx, theme, w, h);

  // Speckle grain on right
  const grain = ctx.getImageData(Math.round(w * 0.45), 0, Math.round(w * 0.55), h);
  const px = grain.data;
  for (let i = 0; i < px.length; i += 16) {
    const n = (Math.random() * 60) | 0;
    px[i] = Math.min(255, n);
    px[i + 1] = Math.min(255, n);
    px[i + 2] = Math.min(255, n);
    px[i + 3] = 40 + (Math.random() * 80) | 0;
  }
  ctx.putImageData(grain, Math.round(w * 0.45), 0);

  const r = Math.round(h * 0.4);
  const cx = Math.round(w * 0.24);
  const cy = Math.round(h * 0.45);

  if (img) {
    // Draw clean circle then slice-shift for glitch
    const tmp = mod.createCanvas(r * 2 + 40, r * 2 + 40);
    const tctx = tmp.getContext("2d") as unknown as Ctx;
    const mid = r + 20;
    drawCircleAvatar(tctx, img, mid, mid, r, { grayscale: true });
    // Horizontal slice offsets
    const sliceH = 10;
    for (let sy = 0; sy < r * 2; sy += sliceH) {
      const shift = ((Math.random() * 28) | 0) - 14;
      const row = tctx.getImageData(0, sy + 20, r * 2 + 40, sliceH);
      tctx.putImageData(row, shift, sy + 20);
    }
    // RGB split ghost
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.globalCompositeOperation = "screen";
    drawImage(ctx, tmp, cx - mid - 6, cy - mid);
    ctx.globalAlpha = 0.35;
    drawImage(ctx, tmp, cx - mid + 6, cy - mid);
    ctx.restore();
    ctx.globalAlpha = 1;
    drawImage(ctx, tmp, cx - mid, cy - mid);

    // Scan lines over avatar
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    for (let ly = cy - r; ly < cy + r; ly += 3) {
      ctx.beginPath();
      ctx.moveTo(cx - r, ly);
      ctx.lineTo(cx + r, ly);
      ctx.stroke();
    }
  }

  // Grunge tilted type
  const text = quoteText(input, theme);
  const family = fontFamily("grunge");
  const maxW = Math.round(w * 0.5);
  const fit = fitFontSize(ctx, text, maxW, Math.round(h * 0.32), Math.round(h * 0.085), 24, family, "900");
  const midX = Math.round(w * 0.68);
  let y = Math.round(h * 0.38);

  ctx.save();
  ctx.translate(midX, y);
  ctx.rotate(-0.06);
  // Distressed multi-pass
  for (const [ox, oy, a] of [[-2, 1, 0.35], [2, -1, 0.3], [0, 0, 1]] as const) {
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    let ly = 0;
    for (const line of fit.lines) {
      ctx.font = `900 ${fit.size}px ${family}`;
      ctx.textAlign = "center";
      // jitter per character for grunge
      const chars = line.split("");
      let tw = 0;
      for (const ch of chars) tw += ctx.measureText(ch).width;
      let cx2 = -tw / 2 + ox;
      for (const ch of chars) {
        const jx = ((Math.random() * 3) | 0) - 1;
        const jy = ((Math.random() * 3) | 0) - 1;
        ctx.fillText(ch, cx2 + jx, ly + oy + jy);
        cx2 += ctx.measureText(ch).width;
      }
      ly += fit.lineHeight;
    }
  }
  ctx.restore();

  drawDiscordChip(ctx, input, img, w, h);
}

// ── Bruhh water reflection ────────────────────────────────────────────────────
function paintBruhh(ctx: Ctx, mod: CanvasMod, theme: QuoteTheme, input: QuoteRenderInput, img: Img | null): void {
  const { width: w, height: h } = theme;
  paintFlatBg(ctx, theme, w, h);

  const waterY = Math.round(h * 0.62);

  // Water surface
  const water = ctx.createLinearGradient(0, waterY, 0, h);
  water.addColorStop(0, "#0A1520");
  water.addColorStop(0.4, "#061018");
  water.addColorStop(1, "#020508");
  ctx.fillStyle = water;
  ctx.fillRect(0, waterY, w, h - waterY);

  // Ripple lines
  ctx.strokeStyle = "rgba(180,200,220,0.12)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 12; i++) {
    const yy = waterY + 8 + i * ((h - waterY) / 12);
    ctx.beginPath();
    ctx.moveTo(0, yy);
    for (let x = 0; x < w; x += 40) {
      ctx.quadraticCurveTo(x + 20, yy + ((i % 2) ? 3 : -3), x + 40, yy);
    }
    ctx.stroke();
  }

  const r = Math.round(h * 0.28);
  const cx = Math.round(w * 0.22);
  const cy = waterY - r * 0.15;

  // Avatar above water
  if (img) {
    drawCircleAvatar(ctx, img, cx, cy, r, { grayscale: true, ring: "rgba(255,255,255,0.25)" });

    // Reflection of avatar (flipped, faded)
    const tmp = mod.createCanvas(r * 2, r * 2);
    const tctx = tmp.getContext("2d") as unknown as Ctx;
    drawCircleAvatar(tctx, img, r, r, r, { grayscale: true });
    ctx.save();
    ctx.translate(cx - r, waterY + 4);
    ctx.scale(1, -0.55);
    ctx.globalAlpha = 0.35;
    drawImage(ctx, tmp, 0, -r * 2);
    ctx.restore();
    ctx.globalAlpha = 1;

    // Soft fade of reflection into water
    const fade = ctx.createLinearGradient(0, waterY, 0, waterY + r);
    fade.addColorStop(0, "rgba(6,16,24,0)");
    fade.addColorStop(1, "rgba(6,16,24,0.85)");
    ctx.fillStyle = fade;
    ctx.fillRect(cx - r - 4, waterY, r * 2 + 8, r);
  }

  // Huge impact text + reflection
  const text = quoteText(input, theme);
  const family = fontFamily("impact");
  const maxW = Math.round(w * 0.55);
  const fit = fitFontSize(ctx, text, maxW, Math.round(h * 0.28), Math.round(h * 0.14), 36, family, "900");
  const midX = Math.round(w * 0.62);
  let y = Math.round(h * 0.38);

  ctx.textAlign = "center";
  ctx.fillStyle = "#FFFFFF";
  for (const line of fit.lines) {
    ctx.font = `900 ${fit.size}px ${family}`;
    // Distressed edge: draw with slight shadow smear
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.fillText(line, midX + 2, y + 2);
    ctx.fillStyle = "#FFFFFF";
    ctx.fillText(line, midX, y);
    y += fit.lineHeight;
  }

  // Text reflection in water
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, waterY, w, h - waterY);
  ctx.clip();
  ctx.translate(0, waterY * 2 + 8);
  ctx.scale(1, -1);
  ctx.globalAlpha = 0.4;
  let ry = Math.round(h * 0.38);
  for (const line of fit.lines) {
    ctx.font = `900 ${fit.size}px ${family}`;
    ctx.fillStyle = "#FFFFFF";
    ctx.textAlign = "center";
    ctx.fillText(line, midX, ry);
    ry += fit.lineHeight;
  }
  ctx.restore();
  ctx.globalAlpha = 1;

  drawDiscordChip(ctx, input, img, w, h);
}

// ── Ethereal moonlight clouds ─────────────────────────────────────────────────
function paintEthereal(ctx: Ctx, mod: CanvasMod, theme: QuoteTheme, input: QuoteRenderInput, img: Img | null): void {
  const { width: w, height: h } = theme;

  // Night sky
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, "#0A0C18");
  sky.addColorStop(0.45, "#12162A");
  sky.addColorStop(1, "#080A10");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // Moon
  const mx = w * 0.18, my = h * 0.22, mr = h * 0.1;
  const moon = ctx.createRadialGradient(mx, my, 0, mx, my, mr * 1.8);
  moon.addColorStop(0, "rgba(255,255,240,0.95)");
  moon.addColorStop(0.35, "rgba(230,230,240,0.7)");
  moon.addColorStop(1, "rgba(180,190,220,0)");
  ctx.fillStyle = moon;
  ctx.beginPath();
  ctx.arc(mx, my, mr * 1.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#F2F2E8";
  ctx.beginPath();
  ctx.arc(mx, my, mr * 0.55, 0, Math.PI * 2);
  ctx.fill();

  // Soft cloud blobs
  paintClouds(ctx, w, h);

  // Avatar nestled in clouds (soft, slightly translucent)
  const r = Math.round(h * 0.3);
  const cx = Math.round(w * 0.26);
  const cy = Math.round(h * 0.5);
  if (img) {
    ctx.save();
    ctx.globalAlpha = 0.92;
    drawCircleAvatar(ctx, img, cx, cy, r, { grayscale: true });
    ctx.restore();
    // Soft edge blend into clouds
    const tmp = mod.createCanvas(w, h);
    const tctx = tmp.getContext("2d") as unknown as Ctx;
    drawCircleAvatar(tctx, img, cx, cy, r, { grayscale: true });
    const mask = tctx.createRadialGradient(cx, cy, r * 0.55, cx, cy, r * 1.15);
    mask.addColorStop(0, "rgba(0,0,0,1)");
    mask.addColorStop(0.65, "rgba(0,0,0,0.55)");
    mask.addColorStop(1, "rgba(0,0,0,0)");
    tctx.globalCompositeOperation = "destination-in";
    tctx.fillStyle = mask;
    tctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 0.85;
    drawImage(ctx, tmp, 0, 0);
    ctx.globalAlpha = 1;
    // More clouds over lower avatar
    paintClouds(ctx, w, h, 0.35, cy + r * 0.2);
  }

  // Poetic italic / mixed case quote
  const family = fontFamily("serif");
  const raw = (input.text || "…").trim();
  const text = raw;
  const maxW = Math.round(w * 0.48);
  const fit = fitFontSize(ctx, text, maxW, Math.round(h * 0.28), Math.round(h * 0.07), 22, family, "500");
  const midX = Math.round(w * 0.68);
  let y = Math.round(h * 0.4);

  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.font = `italic 500 ${Math.round(h * 0.1)}px ${family}`;
  ctx.textAlign = "left";
  ctx.fillText("“", midX - maxW / 2 - 8, y - 6);

  ctx.fillStyle = "#FFFFFF";
  ctx.textAlign = "center";
  for (const line of fit.lines) {
    ctx.font = `italic 500 ${fit.size}px ${family}`;
    ctx.fillText(line, midX, y);
    y += fit.lineHeight;
  }
  ctx.fillStyle = "rgba(255,255,255,0.4)";
  ctx.font = `italic 500 ${Math.round(h * 0.08)}px ${family}`;
  ctx.textAlign = "right";
  ctx.fillText("”", midX + maxW / 2 + 4, y);

  drawDiscordChip(ctx, input, img, w, h);
}

function paintClouds(ctx: Ctx, w: number, h: number, alpha = 0.55, biasY?: number): void {
  const blobs = [
    [0.05, 0.55, 0.22], [0.2, 0.62, 0.28], [0.4, 0.58, 0.2],
    [0.12, 0.72, 0.3], [0.35, 0.75, 0.25], [0.55, 0.68, 0.22],
    [0.7, 0.55, 0.18], [0.85, 0.65, 0.24],
  ];
  ctx.fillStyle = `rgba(40,48,70,${alpha})`;
  for (const [nx, ny, nr] of blobs) {
    const x = nx! * w;
    const y = (biasY ?? ny! * h);
    const r = nr! * h;
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.6, r * 0.7, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Lighter highlights
  ctx.fillStyle = `rgba(90,100,130,${alpha * 0.45})`;
  ctx.beginPath();
  ctx.ellipse(w * 0.25, (biasY ?? h * 0.6) - 20, w * 0.18, h * 0.06, 0, 0, Math.PI * 2);
  ctx.fill();
}

// ── MakeItAQuote half-fade + impact (shared helpers) ──────────────────────────
function paintFadeAvatar(
  mod: CanvasMod, ctx: Ctx, img: Img | null, theme: QuoteTheme, w: number, h: number,
): void {
  if (!img || theme.avatarLayout === "none") return;

  if (theme.avatarLayout === "corner") {
    const size = Math.round(Math.min(w, h) * theme.avatarShare);
    const pad = Math.round(size * 0.28);
    const x = pad;
    const y = h - size - pad;
    drawCircleAvatar(ctx, img, x + size / 2, y + size / 2, size / 2, {
      grayscale: theme.grayscale,
      ring: theme.accentColor ?? "rgba(255,255,255,0.35)",
    });
    return;
  }

  if (theme.avatarLayout === "portrait") {
    const tmp = mod.createCanvas(w, h);
    const tctx = tmp.getContext("2d") as unknown as Ctx;
    drawCover(tctx, img, 0, 0, w, h);
    if (theme.grayscale) toGray(tctx, 0, 0, w, h);
    const fadeStart = 1 - theme.fadeShare;
    const mask = tctx.createLinearGradient(0, h * fadeStart, 0, h);
    mask.addColorStop(0, "rgba(0,0,0,1)");
    mask.addColorStop(0.45, "rgba(0,0,0,0.55)");
    mask.addColorStop(1, "rgba(0,0,0,0)");
    tctx.globalCompositeOperation = "destination-in";
    tctx.fillStyle = mask;
    tctx.fillRect(0, 0, w, h);
    drawImage(ctx, tmp, 0, 0);
    const wash = ctx.createLinearGradient(0, h * 0.35, 0, h);
    wash.addColorStop(0, "rgba(0,0,0,0)");
    wash.addColorStop(0.55, "rgba(0,0,0,0.55)");
    wash.addColorStop(1, "rgba(0,0,0,0.88)");
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, w, h);
    return;
  }

  const avatarW = Math.round(w * theme.avatarShare);
  const onRight = theme.avatarLayout === "right";
  const dx = onRight ? w - avatarW : 0;
  const tmp = mod.createCanvas(avatarW, h);
  const tctx = tmp.getContext("2d") as unknown as Ctx;
  drawCover(tctx, img, 0, 0, avatarW, h);
  if (theme.grayscale) toGray(tctx, 0, 0, avatarW, h);
  const fadePx = Math.max(48, Math.round(avatarW * theme.fadeShare));
  const mask = onRight
    ? tctx.createLinearGradient(0, 0, fadePx, 0)
    : tctx.createLinearGradient(avatarW - fadePx, 0, avatarW, 0);
  if (onRight) {
    mask.addColorStop(0, "rgba(0,0,0,0)");
    mask.addColorStop(0.25, "rgba(0,0,0,0.35)");
    mask.addColorStop(0.7, "rgba(0,0,0,0.85)");
    mask.addColorStop(1, "rgba(0,0,0,1)");
  } else {
    mask.addColorStop(0, "rgba(0,0,0,1)");
    mask.addColorStop(0.3, "rgba(0,0,0,0.9)");
    mask.addColorStop(0.75, "rgba(0,0,0,0.35)");
    mask.addColorStop(1, "rgba(0,0,0,0)");
  }
  tctx.globalCompositeOperation = "destination-in";
  tctx.fillStyle = mask;
  tctx.fillRect(0, 0, avatarW, h);
  drawImage(ctx, tmp, dx, 0);
}

function paintFadeText(ctx: Ctx, theme: QuoteTheme, input: QuoteRenderInput): void {
  const { width: w, height: h } = theme;
  const margin = Math.round(Math.min(w, h) * 0.06);
  let box: { x: number; y: number; w: number; h: number };
  if (theme.avatarLayout === "corner" || theme.avatarLayout === "none") {
    const bottomPad = theme.avatarLayout === "corner" ? Math.round(h * 0.22) : margin;
    box = { x: margin * 1.4, y: margin, w: w - margin * 2.8, h: h - margin * 2 - bottomPad };
  } else if (theme.avatarLayout === "right") {
    const avatarW = Math.round(w * theme.avatarShare);
    const fade = Math.round(avatarW * theme.fadeShare * 0.35);
    box = { x: margin, y: margin, w: w - avatarW + fade - margin * 1.2, h: h - margin * 2 };
  } else if (theme.avatarLayout === "portrait") {
    box = { x: margin, y: Math.round(h * 0.52), w: w - margin * 2, h: Math.round(h * 0.42) - margin };
  } else {
    const avatarW = Math.round(w * theme.avatarShare);
    const fade = Math.round(avatarW * theme.fadeShare * 0.35);
    box = { x: avatarW - fade + margin * 0.4, y: margin, w: w - (avatarW - fade) - margin * 1.4, h: h - margin * 2 };
  }

  const family = fontFamily(theme.fontTone);
  const text = (input.text || "…").trim();
  const maxSize = theme.fontTone === "impact" ? Math.round(h * 0.14) : Math.round(h * 0.075);
  const minSize = theme.fontTone === "impact" ? 28 : 22;
  const weight = theme.fontTone === "impact" ? "900" : "600";
  const attrBlock = Math.round(h * 0.14);
  const fit = fitFontSize(ctx, text, box.w - 16, box.h - attrBlock, maxSize, minSize, family, weight);
  const blockH = fit.lines.length * fit.lineHeight;
  let y = box.y + Math.max(0, (box.h - attrBlock - blockH) / 2) + fit.size;
  const cx = box.x + box.w / 2;
  ctx.textAlign = "center";
  ctx.fillStyle = theme.textColor;
  for (const line of fit.lines) {
    ctx.font = `${weight} ${fit.size}px ${family}`;
    ctx.fillText(line, cx, y);
    y += fit.lineHeight;
  }
  y += Math.round(fit.size * 0.55);
  ctx.font = `italic 500 ${Math.max(18, Math.round(fit.size * 0.42))}px ${family}`;
  ctx.fillStyle = theme.attributionColor;
  ctx.fillText(`— ${input.displayName || "someone"}`, cx, y);
  y += Math.round(fit.size * 0.42);
  ctx.font = `400 ${Math.max(14, Math.round(fit.size * 0.32))}px ${family}`;
  ctx.fillStyle = theme.handleColor;
  ctx.fillText(handleOf(input), cx, y);
}

function drawWatermark(ctx: Ctx, theme: QuoteTheme, w: number, h: number, label: string): void {
  // Classic / cinematic use their own taglines; Discord/4K have built-in chrome.
  if (
    theme.layout === "classic" || theme.layout === "cinematic" || theme.layout === "discord"
    || theme.layout === "caught4k" || theme.layout === "absolute" || theme.layout === "glitch"
    || theme.layout === "bruhh" || theme.layout === "ethereal"
  ) {
    return;
  }
  ctx.save();
  ctx.font = `400 16px Arial, sans-serif`;
  ctx.fillStyle = theme.watermarkColor;
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillText(label, w - 22, h - 16);
  ctx.restore();
}

export async function renderQuoteCard(raw: QuoteRenderInput): Promise<Buffer | null> {
  const input = withReadableNames(raw);
  return queueRender("quote-card", async () => {
    const mod = await getCanvas();
    if (!mod) return null;
    const theme = input.theme;
    const { width: w, height: h } = theme;
    try {
      const canvas = mod.createCanvas(w, h);
      const ctx = canvas.getContext("2d") as unknown as Ctx;
      const avatar = await loadAvatar(mod, input.avatarUrl);

      switch (theme.layout) {
        case "classic":
          paintClassic(ctx, mod, theme, input, avatar);
          break;
        case "discord":
          await paintDiscord(ctx, mod, theme, input, avatar);
          break;
        case "caught4k":
          paintCaught4k(ctx, theme, input, avatar);
          break;
        case "cinematic":
          paintCinematic(ctx, theme, input, avatar);
          break;
        case "absolute":
          paintAbsolute(ctx, mod, theme, input, avatar);
          break;
        case "glitch":
          paintGlitch(ctx, mod, theme, input, avatar);
          break;
        case "bruhh":
          paintBruhh(ctx, mod, theme, input, avatar);
          break;
        case "ethereal":
          paintEthereal(ctx, mod, theme, input, avatar);
          break;
        default: {
          // fade-left / fade-right / portrait / impact / custom
          paintFlatBg(ctx, theme, w, h);
          paintFadeAvatar(mod, ctx, avatar, theme, w, h);
          if (theme.letterbox) {
            const bar = Math.round(h * 0.08);
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, w, bar);
            ctx.fillRect(0, h - bar, w, bar);
          }
          paintFadeText(ctx, theme, input);
          break;
        }
      }

      drawWatermark(ctx, theme, w, h, input.watermark ?? BRAND_NAME);
      return await canvas.encode("png");
    } catch (err) {
      logger.warn({ err }, "quote: render failed");
      return null;
    }
  }, 1);
}
