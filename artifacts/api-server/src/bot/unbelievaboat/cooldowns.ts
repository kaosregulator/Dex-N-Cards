// Guild-configurable cooldowns for UnbelievaBoat mini-games.
// UnbelievaBoat's Discord bot has set-cooldown / set-game-cooldown, but those
// settings are NOT exposed on the public REST API — so we mirror their defaults
// in our Discord dashboard (`/unbelievaboat` → Cooldowns).

import type { UbSettings } from "@workspace/db";
import { getOrCreateUbSettings, getOrCreateGameState, touchGameState } from "../../lib/unbelievaboat/db.js";
import { CashError } from "./cash.js";

/** Defaults aligned with UnbelievaBoat FAQ (income + game window). */
export const DEFAULT_COOLDOWNS = {
  dailySec: 20 * 60 * 60,       // Cash Check-In (our addon)
  // Fallback only — each role can override via meta.collectCooldownSec (UB Role Income style).
  collectSec: 24 * 60 * 60,
  workSec: 4 * 60 * 60,         // /work style
  crimeSec: 4 * 60 * 60,
  begSec: 4 * 60 * 60,          // /slut
  robSec: 24 * 60 * 60,
  // Gambling: N uses per window (UnbelievaBoat default 4 / 5 min)
  gameUses: 4,
  gameWindowSec: 5 * 60,
  // Soft gap between identical command spam
  gameGapSec: 3,
} as const;

export type CooldownConfig = {
  dailySec: number;
  collectSec: number;
  workSec: number;
  crimeSec: number;
  begSec: number;
  robSec: number;
  gameUses: number;
  gameWindowSec: number;
  gameGapSec: number;
};

export function readCooldowns(settings: UbSettings): CooldownConfig {
  const src = ((settings as UbSettings & { cooldowns?: Partial<CooldownConfig> | null }).cooldowns
    && typeof (settings as { cooldowns?: unknown }).cooldowns === "object"
    ? (settings as { cooldowns: Partial<CooldownConfig> }).cooldowns
    : {}) as Partial<CooldownConfig>;
  const n = (v: unknown, d: number) => {
    const x = Number(v);
    return Number.isFinite(x) && x >= 0 ? Math.floor(x) : d;
  };
  return {
    dailySec: n(src.dailySec, DEFAULT_COOLDOWNS.dailySec),
    collectSec: n(src.collectSec, DEFAULT_COOLDOWNS.collectSec),
    workSec: n(src.workSec, DEFAULT_COOLDOWNS.workSec),
    crimeSec: n(src.crimeSec, DEFAULT_COOLDOWNS.crimeSec),
    begSec: n(src.begSec, DEFAULT_COOLDOWNS.begSec),
    robSec: n(src.robSec, DEFAULT_COOLDOWNS.robSec),
    gameUses: Math.max(1, n(src.gameUses, DEFAULT_COOLDOWNS.gameUses)),
    gameWindowSec: Math.max(30, n(src.gameWindowSec, DEFAULT_COOLDOWNS.gameWindowSec)),
    gameGapSec: n(src.gameGapSec, DEFAULT_COOLDOWNS.gameGapSec),
  };
}

export async function getGuildCooldowns(guildId: string): Promise<CooldownConfig> {
  const s = await getOrCreateUbSettings(guildId);
  return readCooldowns(s);
}

export function cdText(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

/** Human-friendly value for cooldown modals (e.g. `4h`, `30m`, `daily`). */
export function formatCooldownInput(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s === 0) return "0s";
  if (s === 86400 || s % 86400 === 0) {
    const d = s / 86400;
    return d === 1 ? "daily" : `${d}d`;
  }
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

/**
 * Parse station cooldown input → seconds.
 * Accepts: `daily`, `4h`, `30m`, `90s`, `2d`, `4 hours`, `30 minutes`,
 * or a bare number (treated as **minutes** — not seconds).
 */
export function parseCooldownInput(raw: string, label = "Cooldown"): number {
  const t = String(raw ?? "").trim().toLowerCase().replace(/,/g, "");
  if (!t) throw new Error(`${label}: enter a time (e.g. 30m, 4h, daily).`);
  if (t === "daily" || t === "day" || t === "1 day") return 86400;

  const spaced = t.match(/^(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)$/i);
  if (spaced) {
    const n = Number(spaced[1]);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a non-negative number.`);
    const u = spaced[2]!.toLowerCase();
    if (u === "s" || u.startsWith("sec")) return Math.floor(n);
    if (u === "m" || u.startsWith("min")) return Math.floor(n * 60);
    if (u === "h" || u.startsWith("hr") || u.startsWith("hour")) return Math.floor(n * 3600);
    if (u === "d" || u.startsWith("day")) return Math.floor(n * 86400);
  }

  const compact = t.match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/i);
  if (compact) {
    const n = Number(compact[1]);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a non-negative number.`);
    const u = compact[2]!.toLowerCase();
    if (u === "s") return Math.floor(n);
    if (u === "m") return Math.floor(n * 60);
    if (u === "h") return Math.floor(n * 3600);
    if (u === "d") return Math.floor(n * 86400);
  }

  // Bare number → minutes (admins think in minutes, not seconds).
  if (/^\d+(?:\.\d+)?$/.test(t)) {
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a non-negative number.`);
    return Math.floor(n * 60);
  }

  throw new Error(
    `${label}: use \`30m\`, \`4h\`, \`daily\`, \`90s\`, or a bare number of **minutes**.`,
  );
}

type IncomeKey = "daily" | "work" | "crime" | "beg" | "rob" | "collect";

const INCOME_FIELD: Record<IncomeKey, "lastDailyAt" | "lastRobAt" | "lastBegAt" | "lastWorkAt" | "lastCrimeAt" | "lastCollectAt"> = {
  daily: "lastDailyAt",
  work: "lastWorkAt",
  crime: "lastCrimeAt",
  beg: "lastBegAt",
  rob: "lastRobAt",
  collect: "lastCollectAt",
};

const INCOME_SEC: Record<IncomeKey, keyof CooldownConfig> = {
  daily: "dailySec",
  work: "workSec",
  crime: "crimeSec",
  beg: "begSec",
  rob: "robSec",
  collect: "collectSec",
};

export async function assertIncomeCooldown(guildId: string, userId: string, kind: IncomeKey): Promise<void> {
  const cds = await getGuildCooldowns(guildId);
  const state = await getOrCreateGameState(guildId, userId);
  const field = INCOME_FIELD[kind];
  const at = (state as Record<string, unknown>)[field] as Date | null | undefined;
  const sec = cds[INCOME_SEC[kind]] as number;
  if (at) {
    const left = at.getTime() + sec * 1000 - Date.now();
    if (left > 0) throw new CashError(`Cooldown: try again in **${cdText(left)}**.`);
  }
}

export async function markIncomeCooldown(guildId: string, userId: string, kind: IncomeKey): Promise<void> {
  const field = INCOME_FIELD[kind];
  await touchGameState(guildId, userId, { [field]: new Date() } as never);
}

/**
 * Gambling rate limit: at most `gameUses` starts inside `gameWindowSec`.
 * Also enforces a tiny per-command gap.
 */
export async function assertGameCooldown(guildId: string, userId: string): Promise<void> {
  const cds = await getGuildCooldowns(guildId);
  const state = await getOrCreateGameState(guildId, userId);
  const meta = { ...(state.meta ?? {}) } as { gameStarts?: number[]; lastGameAt?: number };
  const now = Date.now();
  if (meta.lastGameAt && cds.gameGapSec > 0) {
    const left = meta.lastGameAt + cds.gameGapSec * 1000 - now;
    if (left > 0) throw new CashError(`Slow down — **${cdText(left)}** before the next game.`);
  }
  const windowMs = cds.gameWindowSec * 1000;
  const recent = (meta.gameStarts ?? []).filter(t => now - t < windowMs);
  if (recent.length >= cds.gameUses) {
    const oldest = Math.min(...recent);
    const left = oldest + windowMs - now;
    throw new CashError(
      `Game limit: **${cds.gameUses}** plays / **${cdText(windowMs)}**. Try again in **${cdText(left)}**.`,
    );
  }
}

export async function markGameCooldown(guildId: string, userId: string): Promise<void> {
  const cds = await getGuildCooldowns(guildId);
  const state = await getOrCreateGameState(guildId, userId);
  const meta = { ...(state.meta ?? {}) } as { gameStarts?: number[]; lastGameAt?: number };
  const now = Date.now();
  const windowMs = cds.gameWindowSec * 1000;
  const recent = (meta.gameStarts ?? []).filter(t => now - t < windowMs);
  recent.push(now);
  meta.gameStarts = recent;
  meta.lastGameAt = now;
  await touchGameState(guildId, userId, { meta });
}
