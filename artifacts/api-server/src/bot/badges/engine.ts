/** Award / progress helpers for the badge system. */

import type { BadgeRule, BadgeEarned } from "@workspace/db";
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

export { formatBadgeNames, getBadgeRules, configuredChannel };

export async function awardManualBadge(opts: {
  guildId: string;
  userId: string;
  badgeId: string;
}): Promise<{ ok: true; awarded: string[]; rules: BadgeRule[] } | { ok: false; message: string }> {
  const settings = await getOrCreateBadgeSettings(opts.guildId);
  if (!settings.enabled) return { ok: false, message: "Badge system is disabled." };
  const rules = rulesForGuild(settings);
  const rule = rules.find(r => r.id === opts.badgeId);
  if (!rule) return { ok: false, message: "That badge ID is not in the catalogue." };
  if (rule.trigger !== "manual") {
    return { ok: false, message: "That badge is not a manual award — it is earned automatically." };
  }
  const member = await getOrCreateMemberBadges(opts.guildId, opts.userId);
  const earned = [...(member.earned ?? [])] as BadgeEarned[];
  if (earned.some(e => e.id === opts.badgeId)) {
    return { ok: false, message: `They already have ${rule.emoji} **${rule.name}**.` };
  }
  const awarded = addEarnedBadge(earned, opts.badgeId, rules);
  await saveMemberBadges(opts.guildId, opts.userId, { earned });
  return { ok: true, awarded, rules };
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
  const earned = [...(member.earned ?? [])] as BadgeEarned[];
  const collectionIds = new Set(rules.filter(r => r.trigger === "collection").map(r => r.id));
  const next = earned.filter(item => {
    if (item.id === opts.badgeId) return false;
    // Drop collection badges if they depended on the removed one.
    if (collectionIds.has(item.id) && opts.badgeId !== item.id) return false;
    return true;
  });
  if (next.length === earned.length) {
    return { ok: false, message: `They do not have ${rule.emoji} **${rule.name}**.` };
  }
  await saveMemberBadges(opts.guildId, opts.userId, { earned: next });
  return { ok: true, rule };
}

/** Award trivia-mode badges (no Discord roles). */
export async function awardTriviaBadges(opts: {
  guildId: string;
  userId: string;
  mode: string;
  alsoBrainiac?: boolean;
}): Promise<{ awarded: string[]; labels: string }> {
  const settings = await getOrCreateBadgeSettings(opts.guildId);
  if (!settings.enabled) return { awarded: [], labels: "" };
  const rules = rulesForGuild(settings);
  const member = await getOrCreateMemberBadges(opts.guildId, opts.userId);
  const earned = [...(member.earned ?? [])] as BadgeEarned[];
  const want = triviaBadgeIdsForMode(opts.mode, Boolean(opts.alsoBrainiac));
  const newly: string[] = [];

  for (const badgeId of want) {
    const rule = rules.find(r => r.id === badgeId && r.trigger === "trivia");
    if (!rule) continue;
    // Mode match: brainiac is special; flash covers picture; others exact.
    if (rule.triviaMode && rule.triviaMode !== "any" && rule.triviaMode !== "brainiac") {
      const mode = opts.mode === "picture" ? "flash" : opts.mode;
      if (rule.triviaMode !== mode && !(rule.triviaMode === "flash" && mode === "flash")) {
        // Allow id-based award even if triviaMode mismatches slightly — id is source of truth.
      }
    }
    newly.push(...addEarnedBadge(earned, badgeId, rules));
  }

  // Also award any trivia rules that match mode via triviaMode field.
  for (const rule of rules.filter(r => r.trigger === "trivia")) {
    if (want.includes(rule.id)) continue;
    const mode = opts.mode === "picture" ? "flash" : opts.mode;
    if (rule.triviaMode === mode || rule.triviaMode === "any") {
      newly.push(...addEarnedBadge(earned, rule.id, rules));
    }
    if (opts.alsoBrainiac && rule.triviaMode === "brainiac") {
      newly.push(...addEarnedBadge(earned, rule.id, rules));
    }
  }

  if (newly.length) {
    await saveMemberBadges(opts.guildId, opts.userId, { earned });
  }
  return { awarded: newly, labels: formatBadgeNames(newly, rules) };
}

export async function processCountedActivity(opts: {
  guildId: string;
  userId: string;
  rulesToCount: BadgeRule[];
  increment: number;
}): Promise<string[]> {
  if (!opts.rulesToCount.length || opts.increment <= 0) return [];
  const settings = await getOrCreateBadgeSettings(opts.guildId);
  if (!settings.enabled) return [];
  const allRules = rulesForGuild(settings);
  const member = await getOrCreateMemberBadges(opts.guildId, opts.userId);
  const progress = { ...(member.progress ?? {}) };
  const earned = [...(member.earned ?? [])] as BadgeEarned[];
  const newly: string[] = [];

  for (const rule of opts.rulesToCount) {
    const previous = Number(progress[rule.id] || 0);
    const count = previous + opts.increment;
    progress[rule.id] = count;
    if (count >= rule.threshold) {
      newly.push(...addEarnedBadge(earned, rule.id, allRules));
    }
  }

  await saveMemberBadges(opts.guildId, opts.userId, { progress, earned });
  return newly;
}

export async function processStreakActivity(opts: {
  guildId: string;
  userId: string;
}): Promise<string[]> {
  const settings = await getOrCreateBadgeSettings(opts.guildId);
  if (!settings.enabled) return [];
  const rules = rulesForGuild(settings).filter(r => r.trigger === "streak");
  if (!rules.length) return [];

  const member = await getOrCreateMemberBadges(opts.guildId, opts.userId);
  const today = new Date().toDateString();
  if (member.lastActiveDay === today) return [];

  const yesterday = new Date(Date.now() - 86_400_000).toDateString();
  const streak = member.lastActiveDay === yesterday ? (member.streak || 0) + 1 : 1;
  const earned = [...(member.earned ?? [])] as BadgeEarned[];
  const newly: string[] = [];
  for (const rule of rules) {
    if (streak >= rule.threshold) newly.push(...addEarnedBadge(earned, rule.id, rulesForGuild(settings)));
  }
  await saveMemberBadges(opts.guildId, opts.userId, {
    lastActiveDay: today,
    streak,
    earned,
  });
  return newly;
}

export async function processReactionProgress(opts: {
  guildId: string;
  authorId: string;
  messageId: string;
  channelId: string;
}): Promise<string[]> {
  const settings = await getOrCreateBadgeSettings(opts.guildId);
  if (!settings.enabled) return [];
  const rules = rulesForGuild(settings).filter(r =>
    r.trigger === "reactions"
    && configuredChannel(r, settings.trackChannelId, settings.tradeChannelId) === opts.channelId,
  );
  if (!rules.length) return [];

  const member = await getOrCreateMemberBadges(opts.guildId, opts.authorId);
  const earned = [...(member.earned ?? [])] as BadgeEarned[];
  const progress = { ...(member.progress ?? {}) };
  const newly: string[] = [];
  const allRules = rulesForGuild(settings);

  for (const rule of rules) {
    if (earned.some(e => e.id === rule.id)) continue;
    const key = `react_${opts.messageId}_${rule.id}`;
    const count = (Number(progress[key] || 0) + 1);
    progress[key] = count;
    if (count >= rule.threshold) {
      newly.push(...addEarnedBadge(earned, rule.id, allRules));
    }
  }
  if (newly.length || Object.keys(progress).length) {
    await saveMemberBadges(opts.guildId, opts.authorId, { progress, earned });
  }
  return newly;
}
