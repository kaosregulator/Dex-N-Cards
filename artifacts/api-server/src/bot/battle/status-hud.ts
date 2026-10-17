// Status themes for the health block under the battle log.
//
// classic is the original text columns and never reaches this file.
// drain   is the picture scoreboard: bars fall when HP changes, the GIF holds
//         the new value, then the message swaps to a PNG so Discord cannot
//         loop the hit.
// gauges  is the circle board: one health bar, then Energy, Ultimate, and
//         Shield rings with the word under each ring.
//
// Sieges and raids use the still of whichever picture the admin picked. The
// one-shot GIF is only for a card battle, which owns a single message and can
// swap the attachment after the hold.

import { GlobalFonts } from "@napi-rs/canvas";
import { encodeAnimation, getCanvas, type Ctx } from "../animations/engine.js";
import { registerCanvasSans, CANVAS_SANS_STACK } from "../canvas-fonts.js";
import { loadCurrencyImage, type CurrencyImg } from "../unbelievaboat/currency-canvas.js";

export const STATUS_THEMES = ["classic", "drain", "gauges"] as const;
export type StatusTheme = (typeof STATUS_THEMES)[number];

export function statusThemeOf(value: string | null | undefined): StatusTheme {
  return value === "drain" || value === "gauges" ? value : "classic";
}

export function statusThemeLabel(value: string | null | undefined): string {
  const theme = statusThemeOf(value);
  if (theme === "drain") return "Drain, then still";
  if (theme === "gauges") return "Circle gauges";
  return "Current columns";
}

/** Motion, then a hold on the new HP. The swap to a still happens during the hold. */
export const DRAIN_DURATION_MS = 1500;
export const DRAIN_MOTION_END = 0.62;
export const DRAIN_SETTLE_MS = 1100;

export const HUD_FILE_PNG = "status-hud.png";
export const HUD_FILE_GIF = "status-hud.gif";

export interface HudFighter {
  name: string;
  tag: string;
  tagTone: "you" | "ai" | "boss" | "foe";
  sub: string;
  hp: number;
  maxHp: number;
  fromHp: number;
  shield: number;
  energyPct: number;
  ultPct: number;
  special: string;
  active: boolean;
}

export interface HudBoard {
  style: "drain" | "gauges";
  headline: string;
  turnLabel: string;
  fighters: HudFighter[];
}

export interface CombatantHudSource {
  cardName: string;
  hp: number;
  shield: number;
  energy: number;
  ultimate: number;
  stats: { maxHealth: number; energyMax: number; ultimateMax: number };
  specialEffect?: string | null;
  specialCooldownRemaining?: number;
}

let fontsReady = false;
function ensureFonts(): void {
  if (fontsReady) return;
  fontsReady = true;
  registerCanvasSans({ GlobalFonts });
}

const FONT = CANVAS_SANS_STACK;

type GaugeIcons = { energy: CurrencyImg | null; ultimate: CurrencyImg | null; shield: CurrencyImg | null };
let gaugeIcons: GaugeIcons | null = null;

async function loadGaugeIcons(): Promise<GaugeIcons | null> {
  if (gaugeIcons) return gaugeIcons;
  const mod = await getCanvas();
  if (!mod) return null;
  gaugeIcons = {
    energy: await loadCurrencyImage(mod, "⚡").catch(() => null),
    ultimate: await loadCurrencyImage(mod, "💀").catch(() => null),
    shield: await loadCurrencyImage(mod, "🛡️").catch(() => null),
  };
  return gaugeIcons;
}

export function hudPct(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / max) * 100)));
}

export function hudSpecial(c: { specialEffect?: string | null; specialCooldownRemaining?: number }): string {
  if (!c.specialEffect) return "";
  return (c.specialCooldownRemaining ?? 0) > 0 ? `Special ${c.specialCooldownRemaining}` : "Special ready";
}

export function hudFighter(c: CombatantHudSource, opts: {
  tag: string;
  tagTone: HudFighter["tagTone"];
  sub?: string;
  active?: boolean;
  hp?: number;
  fromHp?: number;
}): HudFighter {
  const hp = opts.hp ?? c.hp;
  return {
    name: c.cardName,
    tag: opts.tag,
    tagTone: opts.tagTone,
    sub: opts.sub ?? "",
    hp,
    maxHp: c.stats.maxHealth,
    fromHp: opts.fromHp ?? hp,
    shield: c.shield,
    energyPct: hudPct(c.energy, c.stats.energyMax),
    ultPct: hudPct(c.ultimate, c.stats.ultimateMax),
    special: hudSpecial(c),
    active: !!opts.active,
  };
}

const W = 440;
const ROW_GAUGE = 118;
const ROW_DRAIN = 96;
const HEADER = 40;

function boardHeight(board: HudBoard): number {
  const row = board.style === "gauges" ? ROW_GAUGE : ROW_DRAIN;
  return 12 + HEADER + board.fighters.length * row + 8;
}

function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function hpAt(f: HudFighter, t: number): number {
  const p = t <= DRAIN_MOTION_END ? easeOut(t / DRAIN_MOTION_END) : 1;
  return f.fromHp + (f.hp - f.fromHp) * p;
}

function commas(n: number): string {
  return Math.max(0, Math.round(n)).toLocaleString("en-US");
}

function hpColor(pct: number): string {
  if (pct > 0.55) return "#3ba55d";
  if (pct > 0.28) return "#faa61a";
  return "#ed4245";
}

function fit(ctx: Ctx, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s}…`;
}

function round(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawBolt(ctx: Ctx, cx: number, cy: number, s: number): void {
  ctx.beginPath();
  ctx.moveTo(cx + s * 0.08, cy - s * 0.5);
  ctx.lineTo(cx - s * 0.28, cy + s * 0.02);
  ctx.lineTo(cx - s * 0.02, cy + s * 0.02);
  ctx.lineTo(cx - s * 0.1, cy + s * 0.5);
  ctx.lineTo(cx + s * 0.3, cy - s * 0.06);
  ctx.lineTo(cx + s * 0.02, cy - s * 0.06);
  ctx.closePath();
  ctx.fill();
}

function drawDiamond(ctx: Ctx, cx: number, cy: number, s: number): void {
  ctx.beginPath();
  ctx.moveTo(cx, cy - s * 0.5);
  ctx.lineTo(cx + s * 0.38, cy);
  ctx.lineTo(cx, cy + s * 0.5);
  ctx.lineTo(cx - s * 0.38, cy);
  ctx.closePath();
  ctx.fill();
}

function drawShield(ctx: Ctx, cx: number, cy: number, s: number): void {
  ctx.beginPath();
  ctx.moveTo(cx, cy - s * 0.48);
  ctx.lineTo(cx + s * 0.42, cy - s * 0.22);
  ctx.lineTo(cx + s * 0.32, cy + s * 0.12);
  ctx.lineTo(cx, cy + s * 0.5);
  ctx.lineTo(cx - s * 0.32, cy + s * 0.12);
  ctx.lineTo(cx - s * 0.42, cy - s * 0.22);
  ctx.closePath();
  ctx.fill();
}

function ring(ctx: Ctx, cx: number, cy: number, r: number, pct: number, color: string): void {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = "#3a3d44";
  ctx.lineWidth = 5;
  ctx.stroke();
  const shown = Math.max(0, Math.min(1, pct));
  if (shown <= 0) return;
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * shown);
  ctx.strokeStyle = color;
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.lineCap = "butt";
}

function tagColor(tone: HudFighter["tagTone"]): string {
  if (tone === "you") return "#3ba55d";
  if (tone === "boss") return "#ed4245";
  if (tone === "foe") return "#ed4245";
  return "#faa61a";
}

function drawHeader(ctx: Ctx, board: HudBoard): void {
  ctx.font = `700 13px ${FONT}`;
  const label = board.headline;
  const tw = ctx.measureText(label).width;
  round(ctx, 14, 12, tw + 22, 24, 12);
  ctx.fillStyle = board.headline.toLowerCase().includes("your") ? "#3ba55d" : "#faa61a";
  ctx.fill();
  ctx.fillStyle = "#1e1f22";
  ctx.textBaseline = "middle";
  ctx.fillText(label, 25, 24);
  ctx.font = `700 11px ${FONT}`;
  ctx.fillStyle = "#b5bac1";
  ctx.textAlign = "right";
  ctx.fillText(board.turnLabel, W - 14, 24);
  ctx.textAlign = "left";
}

function drawHpBar(ctx: Ctx, x: number, y: number, w: number, hp: number, max: number): void {
  const pct = max <= 0 ? 0 : Math.max(0, Math.min(1, hp / max));
  round(ctx, x, y, w, 14, 4);
  ctx.fillStyle = "#1e1f22";
  ctx.fill();
  if (pct > 0) {
    round(ctx, x, y, Math.max(8, w * pct), 14, 4);
    ctx.fillStyle = hpColor(pct);
    ctx.fill();
  }
  ctx.font = `700 10px ${FONT}`;
  ctx.fillStyle = "#f2f3f5";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(`${commas(hp)} / ${commas(max)}`, x + w - 6, y + 7);
  ctx.textAlign = "left";
}

function drawGauges(ctx: Ctx, board: HudBoard, icons: GaugeIcons | null): void {
  ctx.fillStyle = "#2b2d31";
  ctx.fillRect(0, 0, W, boardHeight(board));
  drawHeader(ctx, board);
  board.fighters.forEach((f, i) => {
    const y = 12 + HEADER + i * ROW_GAUGE;
    if (f.active) {
      ctx.fillStyle = "#faa61a";
      ctx.fillRect(0, y + 8, 3, ROW_GAUGE - 16);
    }
    const left = 16;
    const circlesW = 168;
    const textW = W - 16 - circlesW - left;
    ctx.textBaseline = "top";
    ctx.font = `700 15px ${FONT}`;
    ctx.fillStyle = "#f2f3f5";
    const name = fit(ctx, f.name, textW - 54);
    ctx.fillText(name, left, y + 6);
    const nameW = ctx.measureText(name).width;
    ctx.font = `700 11px ${FONT}`;
    ctx.fillStyle = tagColor(f.tagTone);
    ctx.fillText(f.tag, left + nameW + 8, y + 9);
    ctx.font = `500 12px ${FONT}`;
    ctx.fillStyle = "#b5bac1";
    if (f.sub) ctx.fillText(fit(ctx, f.sub, textW), left, y + 28);
    drawHpBar(ctx, left, y + 50, textW, f.hp, f.maxHp);
    if (f.special) {
      ctx.font = `600 11px ${FONT}`;
      ctx.fillStyle = f.special === "Special ready" ? "#3ba55d" : "#949ba4";
      ctx.fillText(f.special, left, y + 70);
    }
    const specs = [
      { label: "Energy", pct: f.energyPct / 100, color: "#f0b429", value: `${f.energyPct}%`, icon: "bolt" as const },
      { label: "Ultimate", pct: f.ultPct / 100, color: "#b47aff", value: `${f.ultPct}%`, icon: "diamond" as const },
      { label: "Shield", pct: f.shield > 0 ? 1 : 0, color: "#5dade2", value: commas(f.shield), icon: "shield" as const },
    ];
    specs.forEach((spec, n) => {
      const cx = W - 16 - circlesW + 26 + n * 58;
      const cy = y + 40;
      ring(ctx, cx, cy, 22, spec.pct, spec.color);
      const glyph = spec.icon === "bolt" ? icons?.energy : spec.icon === "diamond" ? icons?.ultimate : icons?.shield;
      if (glyph) {
        ctx.drawImage(glyph as never, cx - 8, cy - 18, 16, 16);
      } else {
        ctx.fillStyle = spec.color;
        if (spec.icon === "bolt") drawBolt(ctx, cx, cy - 8, 12);
        else if (spec.icon === "diamond") drawDiamond(ctx, cx, cy - 8, 11);
        else drawShield(ctx, cx, cy - 8, 12);
      }
      ctx.font = `700 10px ${FONT}`;
      ctx.fillStyle = "#f2f3f5";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(spec.value, cx, cy + 8);
      ctx.font = `700 9px ${FONT}`;
      ctx.fillStyle = "#b5bac1";
      ctx.textBaseline = "top";
      ctx.fillText(spec.label, cx, cy + 28);
      ctx.textAlign = "left";
    });
  });
}

function drawDrain(ctx: Ctx, board: HudBoard, t: number): void {
  ctx.fillStyle = "#2b2d31";
  ctx.fillRect(0, 0, W, boardHeight(board));
  drawHeader(ctx, board);
  const popping = t > 0.12 && t < 0.88;
  board.fighters.forEach((f, i) => {
    const y = 12 + HEADER + i * ROW_DRAIN;
    if (f.active) {
      ctx.fillStyle = "#faa61a";
      ctx.fillRect(0, y + 6, 3, ROW_DRAIN - 14);
    }
    ctx.textBaseline = "top";
    ctx.font = `700 15px ${FONT}`;
    ctx.fillStyle = "#f2f3f5";
    const name = fit(ctx, f.name, 250);
    ctx.fillText(name, 16, y + 4);
    const nameW = ctx.measureText(name).width;
    ctx.font = `700 11px ${FONT}`;
    ctx.fillStyle = tagColor(f.tagTone);
    ctx.fillText(f.tag, 16 + nameW + 8, y + 7);
    if (f.sub) {
      ctx.font = `500 12px ${FONT}`;
      ctx.fillStyle = "#b5bac1";
      ctx.fillText(fit(ctx, f.sub, W - 40), 16, y + 24);
    }
    const hp = hpAt(f, t);
    drawHpBar(ctx, 16, y + 44, W - 32, hp, f.maxHp);
    const delta = Math.round(f.hp - f.fromHp);
    if (popping && delta !== 0 && Math.abs(delta) === largestDrop(board)) {
      ctx.font = `700 14px ${FONT}`;
      ctx.fillStyle = delta < 0 ? "#ff5d5d" : "#3ba55d";
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      const lift = Math.min(1, (t - 0.12) / 0.45) * 10;
      const body = Math.abs(delta).toLocaleString("en-US");
      ctx.fillText(`${delta > 0 ? "+" : "-"}${body}`, W - 22, y + 42 - lift);
      ctx.textAlign = "left";
    }
    ctx.font = `600 11px ${FONT}`;
    ctx.fillStyle = "#dbdee1";
    ctx.textBaseline = "top";
    const bits = [`Energy ${f.energyPct}%`, `Ultimate ${f.ultPct}%`];
    if (f.shield > 0) bits.push(`Shield ${commas(f.shield)}`);
    if (f.special) bits.push(f.special);
    ctx.fillText(bits.join("   "), 16, y + 64);
  });
}

function largestDrop(board: HudBoard): number {
  return board.fighters.reduce((max, f) => Math.max(max, Math.abs(Math.round(f.hp - f.fromHp))), 0);
}

function paint(ctx: Ctx, board: HudBoard, t: number, icons: GaugeIcons | null): void {
  ensureFonts();
  if (board.style === "gauges") drawGauges(ctx, board, icons);
  else drawDrain(ctx, board, t);
}

export async function renderStatusStill(board: HudBoard): Promise<Buffer | null> {
  const mod = await getCanvas();
  if (!mod) return null;
  const icons = board.style === "gauges" ? await loadGaugeIcons() : null;
  const height = boardHeight(board);
  const canvas = mod.createCanvas(W, height);
  const ctx = canvas.getContext("2d") as unknown as Ctx;
  paint(ctx, board, 1, icons);
  return (canvas as unknown as { toBuffer(mime: "image/png"): Buffer }).toBuffer("image/png");
}

export async function renderStatusDrain(board: HudBoard): Promise<{ gif: Buffer | null; still: Buffer } | null> {
  const still = await renderStatusStill(board);
  if (!still) return null;
  const height = boardHeight(board);
  const icons = board.style === "gauges" ? await loadGaugeIcons() : null;
  const gif = await encodeAnimation({
    width: W,
    height,
    speed: "fast",
    durationMs: DRAIN_DURATION_MS,
    maxFrames: 12,
    quality: 18,
    render: ({ ctx, t }) => paint(ctx, board, t, icons),
  });
  if (!gif) return { gif: null, still };
  return { gif: gif.buffer, still };
}
