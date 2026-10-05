/** Award / XP / level helpers for the evolving badge system. */

import type { BadgeRule, BadgeEarned, BadgeTrigger } from "@workspace/db";
import {
  addEarnedBadge,
  formatBadgeNames,
  triviaBadgeIdsForMode,
  configuredChannel,
  getBadgeRules,
} from "../../lib/badges/catalog.js";
import {
  getOrCreateBadgeSettings,
  getOrCreateMemberBadges,
  saveMemberBadges,
  rulesForGuild,
} from "../../lib/badges/db.js";
import {
  applyBadgeXp,
  normalizeEarnedList,
  shouldShowEmblem,
  XP_BY_TRIGGER,
  XP_SAFETY,
  todayKey,
  type LevelGainResult,
} from "../../lib/badges/levels.js";

export { formatBadgeNames, getBadgeRules, configuredChannel, shouldShowEmblem };
export type { LevelGainResult };

export type BadgeMutation = {
  results: LevelGainResult[];
  rules: BadgeRule[];
};

function findOrNull(earned: BadgeEarned[], id: string): BadgeEarned | null {
  return earned.find(e => e.id === id) ?? null;
}

function replaceEarned(earned: BadgeEarned[], next: BadgeEarned): void {
  const idx = earned.findIndex(e => e.id === next.id);
  if (idx >= 0) earned[idx] = next;
  else earned.push(next);
}

function clampGrant(xp: number): number {
  return Math.max(0, Math.min(XP_SAFETY.maxPerGrant, Math.floor(xp)));
}

/** Soft daily auto-XP budget stored in member progress JSON. */
function takeDailyAutoXp(
  progress: Record<string, number | string>,
  badgeId: string,
  want: number,
): { granted: number; progress: Record<string, number | string> } {
  const day = todayKey();
  const dayKey = `xp_day`;
  const amountKey = `xp_auto_${badgeId}`;
  if (progress[dayKey] !== day) {
    // New UTC day — clear auto counters (keep non-xp keys).
    for (const key of Object.keys(progress)) {
      if (key.startsWith("xp_auto_")) delete progress[key];
    }
    progress[dayKey] = day;
  }
  const used = Number(progress[amountKey] || 0);
  const room = Math.max(0, XP_SAFETY.dailyAutoCap - used);
  const granted = Math.min(want, room);
  if (granted > 0) progress[amountKey] = used + granted;
  return { granted, progress };
}

async function unlockOrLevel(
  guildId: string,
  userId: string,
  badgeId: string,
  trigger: BadgeTrigger,
  xpBonus = 0,
): Promise<LevelGainResult | null> {
  const settings = await getOrCreateBadgeSettings(guildId);
  if (!settings.enabled) return null;
  const rules = rulesForGuild(settings);
  if (!rules.some(r => r.id === badgeId)) return null;

  const member = await getOrCreateMemberBadges(guildId, userId);
  const earned = normalizeEarnedList(member.earned);
  const progress = { ...(member.progress ?? {}) } as Record<string, number | string>;
  const existing = findOrNull(earned, badgeId);

  if (!existing) {
    addEarnedBadge(earned, badgeId, rules);
    const unlocked = findOrNull(earned, badgeId)!;
    // Fresh unlock starts at 1; optional bonus XP can nudge immediately.
    let result = applyBadgeXp(unlocked, 0, { unlocked: true });
    if (xpBonus > 0) {
      result = applyBadgeXp(result.badge, clampGrant(xpBonus), { unlocked: true });
    }
    replaceEarned(earned, result.badge);
    // Collection badges may have been added by addEarnedBadge — normalize them.
    const normalized = normalizeEarnedList(earned);
    await saveMemberBadges(guildId, userId, { earned: normalized, progress });
    return { ...result, badge: normalized.find(e => e.id === badgeId) ?? result.badge };
  }

  const base = XP_BY_TRIGGER[trigger] ?? 0;
  let want = clampGrant(base + xpBonus);
  if (want <= 0) return null;

  // Auto triggers share a soft daily cap; manual/trivia are intentional and skip it.
  const isAuto = trigger === "messages" || trigger === "attachments"
    || trigger === "reactions" || trigger === "streak";
  if (isAuto) {
    const taken = takeDailyAutoXp(progress, badgeId, want);
    want = taken.granted;
    Object.assign(progress, taken.progress);
    if (want <= 0) return null;
  }

  const result = applyBadgeXp(existing, want, { unlocked: false });
  replaceEarned(earned, result.badge);
  await saveMemberBadges(guildId, userId, { earned, progress });
  return result;
}

export async function awardManualBadge(opts: {
  guildId: string;
  userId: string;
  badgeId: string;
}): Promise<
  | { ok: true; result: LevelGainResult; rules: BadgeRule[]; mutation: BadgeMutation }
  | { ok: false; message: string }
> {
  const settings = await getOrCreateBadgeSettings(opts.guildId);
  if (!settings.enabled) return { ok: false, message: "Badge system is disabled." };
  const rules = rulesForGuild(settings);
  const rule = rules.find(r => r.id === opts.badgeId);
  if (!rule) return { ok: false, message: "That badge ID is not in the catalogue." };
  if (rule.trigger !== "manual") {
    return { ok: false, message: "That badge is not a manual award — it is earned automatically." };
  }

  const result = await unlockOrLevel(opts.guildId, opts.userId, opts.badgeId, "manual");
  if (!result) return { ok: false, message: "Could not award that badge." };
  return { ok: true, result, rules, mutation: { results: [result], rules } };
}

export async function takeBadge(opts: {
  guildId: string;
  userId: string;
  badgeId: string;
}): Promise<{ ok: true; rule: BadgeRule } | { ok: false; message: string }> {
  const settings = await getOrCreateBadgeSettings(opts.guildId);
  const rules = rulesForGuild(settings);
  const rule = rules.find(r => r.id === opts.badgeId);
  if (!rule) return { ok: false, message: "That badge ID is not in the catalogue." };
  const member = await getOrCreateMemberBadges(opts.guildId, opts.userId);
  const earned = normalizeEarnedList(member.earned);
  const collectionIds = new Set(rules.filter(r => r.trigger === "collection").map(r => r.id));
  const next = earned.filter(item => {
    if (item.id === opts.badgeId) return false;
    if (collectionIds.has(item.id) && opts.badgeId !== item.id) return false;
    return true;
  });
  if (next.length === earned.length) {
    return { ok: false, message: `They do not have ${rule.emoji} **${rule.name}**.` };
  }
  await saveMemberBadges(opts.guildId, opts.userId, { earned: next });
  return { ok: true, rule };
}

/**
 * Award / level Art Show badges from activity counters.
 * mode: submit | votes_cast | votes_received | crown
 * count: lifetime (or peak votes on one piece for votes_received)
 */
export async function awardArtShowBadges(opts: {
  guildId: string;
  userId: string;
  mode: "submit" | "votes_cast" | "votes_received" | "crown";
  count: number;
}): Promise<{ awarded: string[]; labels: string; results: LevelGainResult[]; rules: BadgeRule[] }> {
  const settings = await getOrCreateBadgeSettings(opts.guildId);
  if (!settings.enabled) return { awarded: [], labels: "", results: [], rules: [] };
  const rules = rulesForGuild(settings);
  const results: LevelGainResult[] = [];

  for (const rule of rules.filter(r => r.trigger === "artshow")) {
    const mode = rule.artshowMode ?? "any";
    if (mode !== "any" && mode !== opts.mode) continue;
    if (opts.count < Math.max(1, rule.threshold)) continue;
    const result = await unlockOrLevel(opts.guildId, opts.userId, rule.id, "artshow");
    if (result) results.push(result);
  }

  const flashy = results.filter(r => r.unlocked || r.leveled);
  return {
    awarded: flashy.map(r => r.badge.id),
    labels: formatBadgeNames(flashy.map(r => r.badge.id), rules),
    results,
    rules,
  };
}

/** Award / level trivia-mode badges (no Discord roles). */
export async function awardTriviaBadges(opts: {
  guildId: string;
  userId: string;
  mode: string;
  alsoBrainiac?: boolean;
}): Promise<{ awarded: string[]; labels: string; results: LevelGainResult[]; rules: BadgeRule[] }> {
  const settings = await getOrCreateBadgeSettings(opts.guildId);
  if (!settings.enabled) return { awarded: [], labels: "", results: [], rules: [] };
  const rules = rulesForGuild(settings);
  const want = triviaBadgeIdsForMode(opts.mode, Boolean(opts.alsoBrainiac));
  const ids = new Set<string>(want);

  for (const rule of rules.filter(r => r.trigger === "trivia")) {
    const mode = opts.mode === "picture" ? "flash" : opts.mode;
    if (rule.triviaMode === mode || rule.triviaMode === "any") ids.add(rule.id);
    if (opts.alsoBrainiac && rule.triviaMode === "brainiac") ids.add(rule.id);
  }

  const results: LevelGainResult[] = [];
  for (const badgeId of ids) {
    const rule = rules.find(r => r.id === badgeId && r.trigger === "trivia");
    if (!rule) continue;
    const bonus = opts.alsoBrainiac && (badgeId === "brainiac" || rule.triviaMode === "brainiac")
      ? XP_SAFETY.triviaBonusBrainiac
      : 0;
    const result = await unlockOrLevel(opts.guildId, opts.userId, badgeId, "trivia", bonus);
    if (result) results.push(result);
  }

  const flashy = results.filter(r => r.unlocked || r.leveled);
  const labels = formatBadgeNames(
    flashy.map(r => r.badge.id),
    rules,
  );
  return {
    awarded: flashy.map(r => r.badge.id),
    labels,
    results,
    rules,
  };
}

export async function processCountedActivity(opts: {
  guildId: string;
  userId: string;
  rulesToCount: BadgeRule[];
  increment: number;
  trigger: "messages" | "attachments";
}): Promise<LevelGainResult[]> {
  if (!opts.rulesToCount.length || opts.increment <= 0) return [];
  const settings = await getOrCreateBadgeSettings(opts.guildId);
  if (!settings.enabled) return [];
  const allRules = rulesForGuild(settings);
  const member = await getOrCreateMemberBadges(opts.guildId, opts.userId);
  const progress = { ...(member.progress ?? {}) } as Record<string, number | string>;
  let earned = normalizeEarnedList(member.earned);
  const results: LevelGainResult[] = [];

  // Message XP cooldown (anti-spam): count always, XP only when cooled down.
  let allowMessageXp = true;
  if (opts.trigger === "messages") {
    const now = Date.now();
    const until = Number(progress.message_xp_until || 0);
    if (now < until) {
      allowMessageXp = false;
    } else {
      progress.message_xp_until = now + XP_SAFETY.messageXpCooldownMs;
    }
  }

  for (const rule of opts.rulesToCount) {
    const previous = Number(progress[rule.id] || 0);
    const count = previous + opts.increment;
    progress[rule.id] = count;

    const owned = findOrNull(earned, rule.id);
    if (!owned && count >= rule.threshold) {
      addEarnedBadge(earned, rule.id, allRules);
      earned = normalizeEarnedList(earned);
      const unlocked = findOrNull(earned, rule.id);
      if (unlocked) {
        const result = applyBadgeXp(unlocked, 0, { unlocked: true });
        replaceEarned(earned, result.badge);
        results.push(result);
      }
      continue;
    }

    if (owned) {
      if (opts.trigger === "messages" && !allowMessageXp) continue;
      const want = clampGrant(XP_BY_TRIGGER[opts.trigger] * Math.min(3, opts.increment));
      const taken = takeDailyAutoXp(progress, rule.id, want);
      if (taken.granted <= 0) continue;
      Object.assign(progress, taken.progress);
      const result = applyBadgeXp(owned, taken.granted);
      replaceEarned(earned, result.badge);
      if (result.xpGranted > 0 || result.leveled) results.push(result);
    }
  }

  await saveMemberBadges(opts.guildId, opts.userId, { progress, earned });
  return results;
}

export async function processStreakActivity(opts: {
  guildId: string;
  userId: string;
}): Promise<LevelGainResult[]> {
  const settings = await getOrCreateBadgeSettings(opts.guildId);
  if (!settings.enabled) return [];
  const rules = rulesForGuild(settings).filter(r => r.trigger === "streak");
  if (!rules.length) return [];

  const member = await getOrCreateMemberBadges(opts.guildId, opts.userId);
  const today = new Date().toDateString();
  if (member.lastActiveDay === today) return [];

  const yesterday = new Date(Date.now() - 86_400_000).toDateString();
  const streak = member.lastActiveDay === yesterday ? (member.streak || 0) + 1 : 1;
  let earned = normalizeEarnedList(member.earned);
  const progress = { ...(member.progress ?? {}) } as Record<string, number | string>;
  const results: LevelGainResult[] = [];
  const allRules = rulesForGuild(settings);

  for (const rule of rules) {
    const owned = findOrNull(earned, rule.id);
    if (!owned && streak >= rule.threshold) {
      addEarnedBadge(earned, rule.id, allRules);
      earned = normalizeEarnedList(earned);
      const unlocked = findOrNull(earned, rule.id);
      if (unlocked) {
        const result = applyBadgeXp(unlocked, 0, { unlocked: true });
        replaceEarned(earned, result.badge);
        results.push(result);
      }
      continue;
    }
    if (owned && streak >= rule.threshold) {
      const taken = takeDailyAutoXp(progress, rule.id, XP_BY_TRIGGER.streak);
      if (taken.granted <= 0) continue;
      Object.assign(progress, taken.progress);
      const result = applyBadgeXp(owned, taken.granted);
      replaceEarned(earned, result.badge);
      if (result.xpGranted > 0 || result.leveled) results.push(result);
    }
  }

  await saveMemberBadges(opts.guildId, opts.userId, {
    lastActiveDay: today,
    streak,
    earned,
    progress,
  });
  return results;
}

export async function processReactionProgress(opts: {
  guildId: string;
  authorId: string;
  messageId: string;
  channelId: string;
}): Promise<LevelGainResult[]> {
  const settings = await getOrCreateBadgeSettings(opts.guildId);
  if (!settings.enabled) return [];
  const rules = rulesForGuild(settings).filter(r =>
    r.trigger === "reactions"
    && configuredChannel(r, settings.trackChannelId, settings.tradeChannelId) === opts.channelId,
  );
  if (!rules.length) return [];

  const member = await getOrCreateMemberBadges(opts.guildId, opts.authorId);
  let earned = normalizeEarnedList(member.earned);
  const progress = { ...(member.progress ?? {}) } as Record<string, number | string>;
  const results: LevelGainResult[] = [];
  const allRules = rulesForGuild(settings);

  for (const rule of rules) {
    const key = `react_${opts.messageId}_${rule.id}`;
    const count = Number(progress[key] || 0) + 1;
    progress[key] = count;

    const owned = findOrNull(earned, rule.id);
    if (!owned) {
      if (count >= rule.threshold) {
        addEarnedBadge(earned, rule.id, allRules);
        earned = normalizeEarnedList(earned);
        const unlocked = findOrNull(earned, rule.id);
        if (unlocked) {
          const result = applyBadgeXp(unlocked, 0, { unlocked: true });
          replaceEarned(earned, result.badge);
          results.push(result);
        }
      }
      continue;
    }

    const taken = takeDailyAutoXp(progress, rule.id, XP_BY_TRIGGER.reactions);
    if (taken.granted <= 0) continue;
    Object.assign(progress, taken.progress);
    const result = applyBadgeXp(owned, taken.granted);
    replaceEarned(earned, result.badge);
    if (result.xpGranted > 0 || result.leveled) results.push(result);
  }

  await saveMemberBadges(opts.guildId, opts.authorId, { progress, earned });
  return results;
}
