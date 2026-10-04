/** Badge level / XP curve, visual tiers, and safety caps (no economy). */

import type { BadgeEarned, BadgeTrigger } from "@workspace/db";

export const BADGE_LEVEL_MIN = 1;
export const BADGE_LEVEL_MAX = 100;

/** Soft early curve, long climb to 100 — no cash/shard economy. */
export function xpToNextLevel(level: number): number {
  const L = Math.max(BADGE_LEVEL_MIN, Math.min(BADGE_LEVEL_MAX - 1, Math.floor(level)));
  // ~20 at L1, ~200 mid, ~900 near 99
  return Math.floor(18 + L * 6.5 + Math.pow(L, 1.42));
}

export type BadgeTierKey =
  | "kindling"
  | "aurora"
  | "radiant"
  | "eclipse"
  | "celestial"
  | "apex";

export type BadgeTier = {
  key: BadgeTierKey;
  label: string;
  minLevel: number;
  maxLevel: number;
  /** Accent hex for embeds / canvas rim */
  accent: number;
  /** Secondary glow */
  glow: number;
};

/** Visual evolution stages — mesmerizing light, not diamonds/cash. */
export const BADGE_TIERS: BadgeTier[] = [
  { key: "kindling", label: "Kindling", minLevel: 1, maxLevel: 9, accent: 0xc4a574, glow: 0xffb347 },
  { key: "aurora", label: "Aurora", minLevel: 10, maxLevel: 24, accent: 0x5ec8ff, glow: 0xa78bfa },
  { key: "radiant", label: "Radiant", minLevel: 25, maxLevel: 49, accent: 0xffd166, glow: 0xff8c42 },
  { key: "eclipse", label: "Eclipse", minLevel: 50, maxLevel: 74, accent: 0xb388ff, glow: 0x7c4dff },
  { key: "celestial", label: "Celestial", minLevel: 75, maxLevel: 99, accent: 0x80ffdb, glow: 0xff6bcb },
  { key: "apex", label: "Apex", minLevel: 100, maxLevel: 100, accent: 0xffe66d, glow: 0xff6b6b },
];

export function tierForLevel(level: number): BadgeTier {
  const L = Math.max(BADGE_LEVEL_MIN, Math.min(BADGE_LEVEL_MAX, Math.floor(level)));
  for (let i = BADGE_TIERS.length - 1; i >= 0; i--) {
    const tier = BADGE_TIERS[i]!;
    if (L >= tier.minLevel) return tier;
  }
  return BADGE_TIERS[0]!;
}

export function normalizeEarned(raw: Partial<BadgeEarned> & { id: string }): BadgeEarned {
  const level = Number.isFinite(Number(raw.level))
    ? Math.max(BADGE_LEVEL_MIN, Math.min(BADGE_LEVEL_MAX, Math.floor(Number(raw.level))))
    : BADGE_LEVEL_MIN;
  const xp = Number.isFinite(Number(raw.xp))
    ? Math.max(0, Math.floor(Number(raw.xp)))
    : 0;
  const timestamp = Number.isFinite(Number(raw.timestamp))
    ? Math.floor(Number(raw.timestamp))
    : Date.now();
  return { id: raw.id, timestamp, level, xp };
}

export function normalizeEarnedList(list: unknown): BadgeEarned[] {
  if (!Array.isArray(list)) return [];
  const out: BadgeEarned[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const id = String((item as { id?: unknown }).id ?? "");
    if (!/^[a-z0-9_]{1,24}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(normalizeEarned({ ...(item as BadgeEarned), id }));
  }
  return out;
}

/** Base XP granted when a trigger fires for an already-owned badge. */
export const XP_BY_TRIGGER: Record<BadgeTrigger, number> = {
  manual: 40,
  trivia: 55,
  messages: 4,
  attachments: 8,
  reactions: 12,
  streak: 25,
  collection: 0,
};

export const XP_SAFETY = {
  /** Hard ceiling on a single grant after multipliers */
  maxPerGrant: 120,
  /** Soft daily XP into one badge from auto triggers */
  dailyAutoCap: 180,
  /** Manual / trivia grants ignore the soft daily auto cap but still clamp */
  triviaBonusBrainiac: 20,
  /** Message XP only once per this many ms per member (guild-wide) */
  messageXpCooldownMs: 45_000,
} as const;

export type LevelGainResult = {
  badge: BadgeEarned;
  leveled: boolean;
  levelsGained: number;
  previousLevel: number;
  tierChanged: boolean;
  previousTier: BadgeTier;
  tier: BadgeTier;
  unlocked: boolean;
  xpGranted: number;
  capped: boolean;
};

/**
 * Apply XP to an earned badge. Caps at level 100.
 * Overflow XP carries across multi-level jumps in one grant.
 */
export function applyBadgeXp(
  badge: BadgeEarned,
  rawXp: number,
  opts?: { unlocked?: boolean },
): LevelGainResult {
  const previousLevel = badge.level;
  const previousTier = tierForLevel(previousLevel);
  let xpGranted = Math.max(0, Math.floor(rawXp));
  let capped = false;
  if (xpGranted > XP_SAFETY.maxPerGrant) {
    xpGranted = XP_SAFETY.maxPerGrant;
    capped = true;
  }

  let level = badge.level;
  let xp = badge.xp;
  let levelsGained = 0;

  if (level >= BADGE_LEVEL_MAX) {
    return {
      badge: { ...badge, level: BADGE_LEVEL_MAX, xp: 0 },
      leveled: false,
      levelsGained: 0,
      previousLevel,
      tierChanged: false,
      previousTier,
      tier: tierForLevel(BADGE_LEVEL_MAX),
      unlocked: Boolean(opts?.unlocked),
      xpGranted: 0,
      capped,
    };
  }

  let remaining = xpGranted;
  while (remaining > 0 && level < BADGE_LEVEL_MAX) {
    const need = xpToNextLevel(level);
    const space = need - xp;
    if (remaining < space) {
      xp += remaining;
      remaining = 0;
      break;
    }
    remaining -= space;
    level += 1;
    levelsGained += 1;
    xp = 0;
    if (level >= BADGE_LEVEL_MAX) {
      xp = 0;
      break;
    }
  }

  const next: BadgeEarned = {
    ...badge,
    level,
    xp,
    timestamp: badge.timestamp,
  };
  const tier = tierForLevel(level);
  return {
    badge: next,
    leveled: levelsGained > 0,
    levelsGained,
    previousLevel,
    tierChanged: previousTier.key !== tier.key,
    previousTier,
    tier,
    unlocked: Boolean(opts?.unlocked),
    xpGranted,
    capped,
  };
}

/** Announce flashy emblem on unlock, tier change, or every 5 levels. */
export function shouldShowEmblem(result: LevelGainResult): boolean {
  if (result.unlocked) return true;
  if (result.tierChanged) return true;
  if (result.leveled && (result.badge.level % 5 === 0 || result.badge.level === BADGE_LEVEL_MAX)) {
    return true;
  }
  return false;
}

export function progressBar(level: number, xp: number, width = 10): string {
  if (level >= BADGE_LEVEL_MAX) return "█".repeat(width);
  const need = xpToNextLevel(level);
  const filled = Math.max(0, Math.min(width, Math.round((xp / need) * width)));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

export function todayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}
