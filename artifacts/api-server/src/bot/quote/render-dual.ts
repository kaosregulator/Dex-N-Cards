// ─────────────────────────────────────────────────────────────────────────────
// Dual-quote renderer — Classic / Reaction / Thread / Evidence / Notepad.
// Matches the DUAL QUOTE STYLES design sheet (two Discord msgs, one card).
// ─────────────────────────────────────────────────────────────────────────────

import { getCanvas, type CanvasMod, type Ctx } from "../animations/engine.js";
import { queueRender } from "../animations/render-queue.js";
import { wrapLines } from "./text.js";
import { quoteDisplayName, unstyleFancyText } from "./display-name.js";
import type { DualQuoteTheme } from "./dual-styles.js";
import { paintDuoVibeLayout } from "./render-dual-vibes.js";
import { logger } from "../../lib/logger.js";
import { shrinkArtBuffer } from "../images/raster.js";

function readableLine(line: DualLine): DualLine {
  return {
    ...line,
    displayName: quoteDisplayName(line.displayName, line.handle),
    handle: unstyleFancyText(line.handle.replace(/^@/, "")) || line.handle || "user",
  };
}

export interface DualLine {
  text: string;
  displayName: string;
  handle: string;
  avatarUrl: string | null;
  createdAt?: Date;
}

export interface DualQuoteRenderInput {
  a: DualLine;
  b: DualLine;
  theme: DualQuoteTheme;
  watermark?: string;
}

export const DUAL_QUOTE_FILE = "duo-quote.png";

type Img = { width: number; height: number };

async function loadAvatar(mod: CanvasMod, url: string | null): Promise<Img | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return null;
    const png = await shrinkArtBuffer(Buffer.from(await res.arrayBuffer()), 384);
    if (!png) return null;
    return await mod.loadImage(png);
  } catch (err) {
    logger.debug({ err }, "duo-quote: avatar load failed");
    return null;
  }
}

function drawCover(ctx: Ctx, img: Img, dx: number, dy: number, dw: number, dh: number): void {
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

function drawCircleAvatar(
  ctx: Ctx, img: Img | null, cx: number, cy: number, r: number,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (img) {
    drawCover(ctx, img, cx - r, cy - r, r * 2, r * 2);
  } else {
    ctx.fillStyle = "#5865F2";
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.fillStyle = "#FFF";
    ctx.font = `700 ${Math.max(12, r * 0.7)}px Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("D", cx, cy + 1);
  }
  ctx.restore();
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

function formatDiscordTime(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const ap = h >= 12 ? "PM" : "AM";
  const hr = ((h + 11) % 12) + 1;
  return `Today at ${hr}:${m} ${ap}`;
}

function formatEvidenceStamp(d: Date): string {
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const mon = months[d.getMonth()]!;
  const day = d.getDate().toString().padStart(2, "0");
  const yr = d.getFullYear();
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  return `${mon} ${day} ${yr} ${hh}:${mm}:${ss}`;
}

/** Outer page backdrop used by every dual style. */
function paintPageBg(ctx: Ctx, w: number, h: number, tint = "#0A0B10"): void {
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, w, h);
}

/**
 * Discord-style message row. Returns the Y of the bottom of the content
 * (so callers can stack message B).
 */
function drawDiscordMessage(
  ctx: Ctx,
  theme: DualQuoteTheme,
  line: DualLine,
  img: Img | null,
  x: number,
  y: number,
  maxW: number,
  opts: { avatarR?: number; darkText?: boolean } = {},
): { bottom: number; avatarCx: number; avatarCy: number; avatarR: number } {
  const avR = opts.avatarR ?? 22;
  const avatarCx = x + avR;
  const avatarCy = y + avR;
  drawCircleAvatar(ctx, img, avatarCx, avatarCy, avR);

  const tx = x + avR * 2 + 14;
  const name = line.displayName || "User";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = theme.nameColor;
  ctx.font = `700 16px Arial, "Helvetica Neue", sans-serif`;
  ctx.fillText(name, tx, y + 16);
  const nameW = ctx.measureText(name).width;

  ctx.fillStyle = theme.mutedColor;
  ctx.font = `400 12px Arial, sans-serif`;
  ctx.fillText(formatDiscordTime(line.createdAt ?? new Date()), tx + nameW + 10, y + 16);

  ctx.fillStyle = opts.darkText ? theme.textColor : theme.textColor;
  ctx.font = `400 15.5px Arial, "Helvetica Neue", sans-serif`;
  const lines = wrapLines(ctx, line.text || "…", maxW - (avR * 2 + 20));
  let ly = y + 40;
  for (const l of lines.slice(0, 4)) {
    ctx.fillText(l, tx, ly);
    ly += 22;
  }
  return { bottom: Math.max(ly, y + avR * 2 + 8), avatarCx, avatarCy, avatarR: avR };
}

function strokeGlowRect(
  ctx: Ctx, x: number, y: number, w: number, h: number, r: number,
  color: string, blur: number, lineWidth = 2,
): void {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  roundRect(ctx, x, y, w, h, r);
  ctx.stroke();
  // second pass for richer glow
  ctx.shadowBlur = blur * 0.45;
  ctx.stroke();
  ctx.restore();
}

function drawImpactMarks(ctx: Ctx, x: number, y: number, color: string, angleDeg = -35): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((angleDeg * Math.PI) / 180);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  for (let i = 0; i < 3; i++) {
    const oy = i * 10;
    ctx.beginPath();
    ctx.moveTo(0, oy);
    ctx.lineTo(22, oy - 4);
    ctx.stroke();
  }
  ctx.restore();
}

// ── Classic ───────────────────────────────────────────────────────────────────
function paintDuoClassic(
  ctx: Ctx, theme: DualQuoteTheme, a: DualLine, b: DualLine,
  imgA: Img | null, imgB: Img | null,
): void {
  const { width: w, height: h } = theme;
  paintPageBg(ctx, w, h);

  const pad = 28;
  const cardX = pad, cardY = pad, cardW = w - pad * 2, cardH = h - pad * 2;
  const radius = 18;

  roundRect(ctx, cardX, cardY, cardW, cardH, radius);
  ctx.fillStyle = theme.background;
  ctx.fill();
  strokeGlowRect(ctx, cardX, cardY, cardW, cardH, radius, theme.accentColor ?? "#7EB8FF", 18, 2.5);

  const msgX = cardX + 40;
  const msgW = cardW - 80;
  const midGap = 44;
  // Rough content block height so the pair sits centered like the sheet
  const blockH = 220;
  const topY = cardY + (cardH - blockH) / 2;
  const aInfo = drawDiscordMessage(ctx, theme, a, imgA, msgX, topY, msgW);
  drawDiscordMessage(ctx, theme, b, imgB, msgX, aInfo.bottom + midGap, msgW);
}

// ── Reaction ──────────────────────────────────────────────────────────────────
function paintDuoReaction(
  ctx: Ctx, theme: DualQuoteTheme, a: DualLine, b: DualLine,
  imgA: Img | null, imgB: Img | null,
): void {
  const { width: w, height: h } = theme;
  paintPageBg(ctx, w, h);

  const pad = 28;
  const cardX = pad, cardY = pad, cardW = w - pad * 2, cardH = h - pad * 2;
  const radius = 18;

  roundRect(ctx, cardX, cardY, cardW, cardH, radius);
  ctx.fillStyle = theme.background;
  ctx.fill();

  // Blue→magenta neon border via gradient stroke on a temp path
  const grad = ctx.createLinearGradient(cardX, cardY, cardX, cardY + cardH);
  grad.addColorStop(0, "#4F8CFF");
  grad.addColorStop(0.45, "#7B5CFF");
  grad.addColorStop(1, "#E040A0");
  ctx.save();
  ctx.shadowColor = "#6A7BFF";
  ctx.shadowBlur = 22;
  ctx.strokeStyle = grad;
  ctx.lineWidth = 3;
  roundRect(ctx, cardX, cardY, cardW, cardH, radius);
  ctx.stroke();
  ctx.restore();
  // Magenta glow pass on lower half
  ctx.save();
  ctx.beginPath();
  ctx.rect(cardX - 10, cardY + cardH * 0.45, cardW + 20, cardH * 0.6);
  ctx.clip();
  ctx.shadowColor = "#E040A0";
  ctx.shadowBlur = 26;
  ctx.strokeStyle = "#E040A0";
  ctx.lineWidth = 3;
  roundRect(ctx, cardX, cardY, cardW, cardH, radius);
  ctx.stroke();
  ctx.restore();

  const msgX = cardX + 40;
  const msgW = cardW - 110;
  const midGap = 28;
  const blockH = 240;
  const topY = cardY + (cardH - blockH) / 2;
  const aInfo = drawDiscordMessage(ctx, theme, a, imgA, msgX, topY, msgW);

  // Blue impact marks — top-right of message A (per sheet)
  drawImpactMarks(ctx, cardX + cardW - 78, topY + 4, "#5B8CFF", -38);

  const divY = aInfo.bottom + 16;
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cardX + 78, divY);
  ctx.lineTo(cardX + cardW - 40, divY);
  ctx.stroke();

  const bY = divY + 20;
  const bInfo = drawDiscordMessage(ctx, theme, b, imgB, msgX, bY, msgW);

  // Red impact marks — lower-right of message B
  drawImpactMarks(ctx, cardX + cardW - 78, bInfo.bottom - 18, "#FF4D6D", -38);
}

// ── Thread ────────────────────────────────────────────────────────────────────
function paintDuoThread(
  ctx: Ctx, theme: DualQuoteTheme, a: DualLine, b: DualLine,
  imgA: Img | null, imgB: Img | null,
): void {
  const { width: w, height: h } = theme;
  paintPageBg(ctx, w, h, "#0A100C");

  const pad = 28;
  const cardX = pad, cardY = pad, cardW = w - pad * 2, cardH = h - pad * 2;
  const radius = 18;
  const green = theme.accentColor ?? "#3DDC84";

  // Soft green wash in bottom-right
  const wash = ctx.createRadialGradient(
    cardX + cardW * 0.85, cardY + cardH * 0.85, 10,
    cardX + cardW * 0.85, cardY + cardH * 0.85, cardW * 0.55,
  );
  wash.addColorStop(0, "rgba(61,220,132,0.18)");
  wash.addColorStop(1, "rgba(61,220,132,0)");
  roundRect(ctx, cardX, cardY, cardW, cardH, radius);
  ctx.fillStyle = theme.background;
  ctx.fill();
  ctx.fillStyle = wash;
  ctx.fill();

  strokeGlowRect(ctx, cardX, cardY, cardW, cardH, radius, green, 16, 2.5);

  const msgX = cardX + 40;
  const msgW = cardW - 80;
  const midGap = 52;
  const blockH = 250;
  const topY = cardY + (cardH - blockH) / 2;
  const aInfo = drawDiscordMessage(ctx, theme, a, imgA, msgX, topY, msgW);
  const bInfo = drawDiscordMessage(ctx, theme, b, imgB, msgX, aInfo.bottom + midGap, msgW);

  // Thread line between avatars
  const x = aInfo.avatarCx;
  const y1 = aInfo.avatarCy + aInfo.avatarR + 4;
  const y2 = bInfo.avatarCy - bInfo.avatarR - 4;
  ctx.save();
  ctx.strokeStyle = green;
  ctx.lineWidth = 3;
  ctx.shadowColor = green;
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.moveTo(x, y1);
  ctx.lineTo(x, y2);
  ctx.stroke();
  // Center node
  const ny = (y1 + y2) / 2;
  ctx.fillStyle = green;
  ctx.beginPath();
  ctx.arc(x, ny, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ── Evidence ──────────────────────────────────────────────────────────────────
function paintDuoEvidence(
  ctx: Ctx, theme: DualQuoteTheme, a: DualLine, b: DualLine,
  imgA: Img | null, imgB: Img | null,
): void {
  const { width: w, height: h } = theme;
  paintPageBg(ctx, w, h, "#050506");

  const pad = 28;
  const cardX = pad, cardY = pad, cardW = w - pad * 2, cardH = h - pad * 2;
  const red = theme.accentColor ?? "#FF3B3B";

  roundRect(ctx, cardX, cardY, cardW, cardH, 10);
  ctx.fillStyle = theme.background;
  ctx.fill();

  // Viewfinder corner brackets
  const br = 28;
  const bw = 3;
  ctx.strokeStyle = red;
  ctx.lineWidth = bw;
  ctx.lineCap = "square";
  // Top-left
  ctx.beginPath();
  ctx.moveTo(cardX + 18, cardY + 18 + br);
  ctx.lineTo(cardX + 18, cardY + 18);
  ctx.lineTo(cardX + 18 + br, cardY + 18);
  ctx.stroke();
  // Bottom-right
  ctx.beginPath();
  ctx.moveTo(cardX + cardW - 18 - br, cardY + cardH - 18);
  ctx.lineTo(cardX + cardW - 18, cardY + cardH - 18);
  ctx.lineTo(cardX + cardW - 18, cardY + cardH - 18 - br);
  ctx.stroke();

  // REC
  ctx.fillStyle = red;
  ctx.beginPath();
  ctx.arc(cardX + 52, cardY + 42, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = red;
  ctx.font = `700 14px "Courier New", monospace`;
  ctx.textAlign = "left";
  ctx.fillText("REC", cardX + 66, cardY + 47);

  // Timestamp
  const stamp = formatEvidenceStamp(b.createdAt ?? a.createdAt ?? new Date());
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = `500 13px "Courier New", monospace`;
  ctx.textAlign = "right";
  ctx.fillText(stamp, cardX + cardW - 28, cardY + 47);

  // Message pods
  const podPad = 22;
  const podX = cardX + 36;
  const podW = cardW - 72;
  const podH = 140;
  const pod1Y = cardY + 78;
  const pod2Y = pod1Y + podH + 24;

  for (const [py, line, img] of [
    [pod1Y, a, imgA] as const,
    [pod2Y, b, imgB] as const,
  ]) {
    roundRect(ctx, podX, py, podW, podH, 12);
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fill();
    drawDiscordMessage(ctx, theme, line, img, podX + podPad, py + 28, podW - podPad * 2);
  }
}

// ── Notepad ───────────────────────────────────────────────────────────────────
function paintDuoNotepad(
  ctx: Ctx, theme: DualQuoteTheme, a: DualLine, b: DualLine,
  imgA: Img | null, imgB: Img | null,
): void {
  const { width: w, height: h } = theme;
  paintPageBg(ctx, w, h, "#0A0B10");

  const paperX = 70;
  const paperY = 48;
  const paperW = w - 140;
  const paperH = h - 96;

  // Soft drop shadow
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 10;
  drawTornPaperPath(ctx, paperX, paperY, paperW, paperH);
  ctx.fillStyle = "#F3EFE6";
  ctx.fill();
  ctx.restore();

  // Paper body again (sharp)
  drawTornPaperPath(ctx, paperX, paperY, paperW, paperH);
  ctx.fillStyle = "#F3EFE6";
  ctx.fill();
  // Subtle paper grain
  ctx.save();
  ctx.clip();
  const grain = ctx.getImageData(paperX, paperY, paperW, paperH);
  const px = grain.data;
  for (let i = 0; i < px.length; i += 16) {
    const n = ((Math.random() * 18) | 0) - 6;
    px[i] = Math.max(0, Math.min(255, (px[i] ?? 240) + n));
    px[i + 1] = Math.max(0, Math.min(255, (px[i + 1] ?? 236) + n));
    px[i + 2] = Math.max(0, Math.min(255, (px[i + 2] ?? 230) + n));
  }
  ctx.putImageData(grain, paperX, paperY);
  ctx.restore();

  // Blue tape top-left
  drawTape(ctx, paperX + 18, paperY - 8, 70, 28, -18, "#3B82F6");
  // Red tape bottom-right
  drawTape(ctx, paperX + paperW - 78, paperY + paperH - 18, 70, 28, 16, "#E11D48");

  // Crown doodle top-right
  drawCrownDoodle(ctx, paperX + paperW - 48, paperY + 36);

  // Dark text theme for paper
  const paperTheme: DualQuoteTheme = {
    ...theme,
    textColor: "#2B2D31",
    mutedColor: "#6B6E74",
    nameColor: "#1E6BB8",
  };
  const msgX = paperX + 36;
  const msgW = paperW - 72;
  const aInfo = drawDiscordMessage(ctx, paperTheme, a, imgA, msgX, paperY + 56, msgW, { darkText: true });
  drawDiscordMessage(ctx, paperTheme, b, imgB, msgX, aInfo.bottom + 40, msgW, { darkText: true });
}

function drawTornPaperPath(ctx: Ctx, x: number, y: number, w: number, h: number): void {
  const jag = 10;
  ctx.beginPath();
  ctx.moveTo(x + 8, y);
  // top edge
  for (let i = 0; i < 14; i++) {
    const px = x + 8 + (w - 16) * ((i + 1) / 14);
    const py = y + ((i % 2 === 0) ? -jag * 0.35 : jag * 0.25);
    ctx.lineTo(px, py);
  }
  // right edge
  for (let i = 0; i < 10; i++) {
    const py = y + (h) * ((i + 1) / 10);
    const px = x + w + ((i % 2 === 0) ? jag * 0.3 : -jag * 0.15);
    ctx.lineTo(px, py);
  }
  // bottom edge
  for (let i = 0; i < 14; i++) {
    const px = x + w - 8 - (w - 16) * ((i + 1) / 14);
    const py = y + h + ((i % 2 === 0) ? jag * 0.35 : -jag * 0.2);
    ctx.lineTo(px, py);
  }
  // left edge
  for (let i = 0; i < 10; i++) {
    const py = y + h - h * ((i + 1) / 10);
    const px = x + ((i % 2 === 0) ? -jag * 0.25 : jag * 0.15);
    ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function drawTape(
  ctx: Ctx, x: number, y: number, w: number, h: number, angleDeg: number, color: string,
): void {
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate((angleDeg * Math.PI) / 180);
  ctx.globalAlpha = 0.72;
  ctx.fillStyle = color;
  roundRect(ctx, -w / 2, -h / 2, w, h, 3);
  ctx.fill();
  // tape sheen stripes
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = "#FFF";
  ctx.fillRect(-w / 2 + 6, -h / 2 + 4, w - 12, 4);
  ctx.restore();
}

function drawCrownDoodle(ctx: Ctx, cx: number, cy: number): void {
  ctx.save();
  ctx.strokeStyle = "#1A1A1A";
  ctx.fillStyle = "#1A1A1A";
  ctx.lineWidth = 2.2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx - 16, cy + 10);
  ctx.lineTo(cx - 16, cy - 2);
  ctx.lineTo(cx - 6, cy + 6);
  ctx.lineTo(cx, cy - 10);
  ctx.lineTo(cx + 6, cy + 6);
  ctx.lineTo(cx + 16, cy - 2);
  ctx.lineTo(cx + 16, cy + 10);
  ctx.closePath();
  ctx.stroke();
  // little jewels
  for (const [jx, jy] of [[-8, 2], [0, -2], [8, 2]] as const) {
    ctx.beginPath();
    ctx.arc(cx + jx, cy + jy, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export async function renderDualQuoteCard(raw: DualQuoteRenderInput): Promise<Buffer | null> {
  const input: DualQuoteRenderInput = {
    ...raw,
    a: readableLine(raw.a),
    b: readableLine(raw.b),
  };
  return queueRender("duo-quote", async () => {
    const mod = await getCanvas();
    if (!mod) return null;
    const theme = input.theme;
    const { width: w, height: h } = theme;
    try {
      const canvas = mod.createCanvas(w, h);
      const ctx = canvas.getContext("2d") as unknown as Ctx;
      const [imgA, imgB] = await Promise.all([
        loadAvatar(mod, input.a.avatarUrl),
        loadAvatar(mod, input.b.avatarUrl),
      ]);

      switch (theme.layout) {
        case "duo-classic":
          paintDuoClassic(ctx, theme, input.a, input.b, imgA, imgB);
          break;
        case "duo-reaction":
          paintDuoReaction(ctx, theme, input.a, input.b, imgA, imgB);
          break;
        case "duo-thread":
          paintDuoThread(ctx, theme, input.a, input.b, imgA, imgB);
          break;
        case "duo-evidence":
          paintDuoEvidence(ctx, theme, input.a, input.b, imgA, imgB);
          break;
        case "duo-notepad":
          paintDuoNotepad(ctx, theme, input.a, input.b, imgA, imgB);
          break;
        default:
          if (!paintDuoVibeLayout(theme.layout, ctx, theme, input.a, input.b, imgA, imgB)) {
            paintDuoClassic(ctx, theme, input.a, input.b, imgA, imgB);
          }
          break;
      }

      return await canvas.encode("png");
    } catch (err) {
      logger.warn({ err }, "duo-quote: render failed");
      return null;
    }
  }, 1);
}
