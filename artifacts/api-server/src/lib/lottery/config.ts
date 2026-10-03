/** Resolve per-game lottery config (prices + buy windows) from settings.gameConfig. */

import { GAME_DEFS, type LotteryGameKey } from "./catalog.js";
import type { UbLotterySettings } from "@workspace/db";

export type GameRuntimeConfig = {
  ticketPrice: number;
  seedJackpot: number;
  /** Inclusive UTC hour start; null = always open (with end). */
  buyStartHourUtc: number | null;
  /** Inclusive UTC hour end. */
  buyEndHourUtc: number | null;
  /** UTC weekdays 0–6; empty = every day. */
  buyDaysUtc: number[];
  enabled: boolean;
};

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function resolveGameConfig(
  settings: UbLotterySettings | null | undefined,
  gameKey: LotteryGameKey,
): GameRuntimeConfig {
  const def = GAME_DEFS[gameKey];
  const raw = (settings?.gameConfig?.[gameKey] ?? {}) as Record<string, unknown>;
  const daysRaw = raw.buyDaysUtc;
  let buyDaysUtc: number[] = [];
  if (Array.isArray(daysRaw)) {
    buyDaysUtc = daysRaw
      .map(d => Number(d))
      .filter(d => Number.isInteger(d) && d >= 0 && d <= 6);
  }
  return {
    ticketPrice: Math.max(1, Math.floor(numOr(raw.ticketPrice, def.ticketPrice))),
    seedJackpot: Math.max(0, Math.floor(numOr(raw.seedJackpot, def.seedJackpot))),
    buyStartHourUtc: clampHour(numOrNull(raw.buyStartHourUtc)),
    buyEndHourUtc: clampHour(numOrNull(raw.buyEndHourUtc)),
    buyDaysUtc,
    enabled: raw.enabled === false ? false : true,
  };
}

function clampHour(h: number | null): number | null {
  if (h == null) return null;
  if (!Number.isInteger(h) || h < 0 || h > 23) return null;
  return h;
}

export type BuyWindowResult =
  | { ok: true }
  | { ok: false; reason: string };

/** Whether players may buy this game right now (UTC). */
export function checkBuyWindow(
  cfg: GameRuntimeConfig,
  now: Date = new Date(),
): BuyWindowResult {
  if (!cfg.enabled) {
    return { ok: false, reason: "This game is disabled by staff." };
  }
  const day = now.getUTCDay();
  const hour = now.getUTCHours();

  if (cfg.buyDaysUtc.length > 0 && !cfg.buyDaysUtc.includes(day)) {
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const allowed = cfg.buyDaysUtc.map(d => names[d]).join(", ");
    return {
      ok: false,
      reason: `Ticket sales are closed today (UTC). Open days: **${allowed}**.`,
    };
  }

  const start = cfg.buyStartHourUtc;
  const end = cfg.buyEndHourUtc;
  if (start == null && end == null) return { ok: true };
  if (start == null || end == null) {
    // Only one bound set — treat as always open to avoid foot-guns.
    return { ok: true };
  }

  const inWindow = start <= end
    ? hour >= start && hour <= end
    : hour >= start || hour <= end; // overnight wrap

  if (!inWindow) {
    return {
      ok: false,
      reason:
        `Ticket sales are closed right now (UTC hour **${hour}**). ` +
        `Buy window: **${pad(start)}:00–${pad(end)}:59 UTC**.`,
    };
  }
  return { ok: true };
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

export function formatBuyWindow(cfg: GameRuntimeConfig): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dayPart = cfg.buyDaysUtc.length === 0
    ? "every day"
    : cfg.buyDaysUtc.map(d => days[d]).join("/");
  if (cfg.buyStartHourUtc == null || cfg.buyEndHourUtc == null) {
    return `${dayPart} · any hour UTC`;
  }
  return `${dayPart} · ${pad(cfg.buyStartHourUtc)}:00–${pad(cfg.buyEndHourUtc)}:59 UTC`;
}

export function parseBuyDays(input: string): number[] | null {
  const t = input.trim().toLowerCase();
  if (!t || t === "all" || t === "*" || t === "everyday") return [];
  const parts = t.split(/[,\s]+/).filter(Boolean);
  const days: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 6) return null;
    if (!days.includes(n)) days.push(n);
  }
  return days.sort((a, b) => a - b);
}
