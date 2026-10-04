/** Configurable badge catalogue — defaults + validation (MEE6-style rules). */

import type { BadgeRule, BadgeTrigger, BadgeEarned } from "@workspace/db";
import { BADGE_LEVEL_MIN, normalizeEarned } from "./levels.js";

export type { BadgeRule, BadgeTrigger, BadgeEarned };

export const ALLOWED_TRIGGERS: BadgeTrigger[] = [
  "manual", "messages", "attachments", "reactions", "streak", "collection", "trivia",
];

export const CHANNEL_TRIGGERS: BadgeTrigger[] = ["messages", "attachments", "reactions"];

export const DEFAULT_BADGE_RULES: BadgeRule[] = [
  // Trivia (replaces Discord winner roles)
  {
    id: "trivia_winner",
    name: "Trivia Winner",
    emoji: "🧠",
    description: "Won a hosted trivia round",
    trigger: "trivia",
    threshold: 1,
    triviaMode: "trivia",
  },
  {
    id: "qotd_champion",
    name: "QOTD Champion",
    emoji: "☀️",
    description: "Won Question of the Day",
    trigger: "trivia",
    threshold: 1,
    triviaMode: "qotd",
  },
  {
    id: "flash_champ",
    name: "Flash Champ",
    emoji: "⚡",
    description: "Won a flash or picture quiz",
    trigger: "trivia",
    threshold: 1,
    triviaMode: "flash",
  },
  {
    id: "smart_cookie",
    name: "Smart Cookie",
    emoji: "🍪",
    description: "Won a community prompt round",
    trigger: "trivia",
    threshold: 1,
    triviaMode: "prompt",
  },
  {
    id: "brainiac",
    name: "Brainiac",
    emoji: "🟣",
    description: "Sole correct guesser in a round",
    trigger: "trivia",
    threshold: 1,
    triviaMode: "brainiac",
  },
  // Manual staff awards
  { id: "helper", name: "Helper", emoji: "🤝", description: "Helped another member", trigger: "manual", threshold: 0 },
  { id: "creative", name: "Creative", emoji: "🎨", description: "Made something cool", trigger: "manual", threshold: 0 },
  { id: "funny", name: "Funny", emoji: "😂", description: "Made everyone laugh", trigger: "manual", threshold: 0 },
  { id: "leader", name: "Leader", emoji: "👑", description: "Led an event or project", trigger: "manual", threshold: 0 },
  { id: "wise", name: "Wise", emoji: "🦉", description: "Gave great advice", trigger: "manual", threshold: 0 },
  { id: "friend", name: "Friend", emoji: "💙", description: "An amazing friend to the community", trigger: "manual", threshold: 0 },
  { id: "star", name: "Star", emoji: "⭐", description: "Staff recognition for excellence", trigger: "manual", threshold: 0 },
  // Auto
  {
    id: "chatter",
    name: "Chatterbox",
    emoji: "💬",
    description: "Posted enough messages in the selected channel",
    trigger: "messages",
    threshold: 100,
  },
  {
    id: "streak",
    name: "Consistent",
    emoji: "🔥",
    description: "Active for consecutive days",
    trigger: "streak",
    threshold: 7,
  },
  {
    id: "popular",
    name: "Popular",
    emoji: "🌟",
    description: "Received enough reactions on one message",
    trigger: "reactions",
    threshold: 5,
  },
  {
    id: "trader",
    name: "Trader",
    emoji: "📦",
    description: "Uploaded enough attachments in the trade channel",
    trigger: "attachments",
    threshold: 10,
  },
  {
    id: "active_trader",
    name: "Active Trader",
    emoji: "📬",
    description: "Uploaded more attachments in the trade channel",
    trigger: "attachments",
    threshold: 25,
  },
  {
    id: "veteran_trader",
    name: "Veteran Trader",
    emoji: "🏅",
    description: "Uploaded many attachments in the trade channel",
    trigger: "attachments",
    threshold: 50,
  },
  {
    id: "top_trader",
    name: "Top Trader",
    emoji: "🏆",
    description: "Uploaded 100 attachments in the trade channel",
    trigger: "attachments",
    threshold: 100,
  },
  {
    id: "collector",
    name: "Badge Collector",
    emoji: "🎖️",
    description: "Earned every other configured badge",
    trigger: "collection",
    threshold: 0,
  },
];

export function getBadgeRules(rules: BadgeRule[] | null | undefined): BadgeRule[] {
  const rows = Array.isArray(rules) && rules.length > 0 ? rules : DEFAULT_BADGE_RULES;
  return rows.filter((rule) =>
    rule
    && typeof rule.id === "string"
    && /^[a-z0-9_]{1,24}$/.test(rule.id)
    && typeof rule.name === "string"
    && rule.name.trim().length > 0
    && typeof rule.emoji === "string"
    && typeof rule.description === "string"
    && ALLOWED_TRIGGERS.includes(rule.trigger)
    && Number.isFinite(Number(rule.threshold))
    && Number(rule.threshold) >= (["manual", "collection"].includes(rule.trigger) ? 0 : 1),
  ).map((rule) => ({
    ...rule,
    name: rule.name.trim().slice(0, 64),
    description: rule.description.trim().slice(0, 200),
    emoji: rule.emoji.trim().slice(0, 64),
    threshold: Math.floor(Number(rule.threshold)),
    channel: rule.channel ?? null,
    triviaMode: rule.triviaMode ?? null,
  }));
}

export function addEarnedBadge(
  earned: BadgeEarned[],
  badgeId: string,
  rules: BadgeRule[],
): string[] {
  if (earned.some((item) => item.id === badgeId)) return [];
  if (!rules.some((rule) => rule.id === badgeId)) return [];
  const awarded = [badgeId];
  earned.push(normalizeEarned({
    id: badgeId,
    timestamp: Date.now(),
    level: BADGE_LEVEL_MIN,
    xp: 0,
  }));

  const collections = rules.filter((rule) => rule.trigger === "collection");
  const required = rules.filter((rule) => rule.trigger !== "collection");
  if (required.length > 0 && required.every((rule) => earned.some((item) => item.id === rule.id))) {
    for (const collection of collections) {
      if (!earned.some((item) => item.id === collection.id)) {
        earned.push(normalizeEarned({
          id: collection.id,
          timestamp: Date.now(),
          level: BADGE_LEVEL_MIN,
          xp: 0,
        }));
        awarded.push(collection.id);
      }
    }
  }
  return awarded;
}

export function formatBadgeNames(ids: string[], rules: BadgeRule[]): string {
  return ids.map((id) => {
    const rule = rules.find((item) => item.id === id);
    return rule ? `${rule.emoji} **${rule.name}**` : id;
  }).join(" and ");
}

/** Map trivia round mode → badge id(s) to try awarding. */
export function triviaBadgeIdsForMode(mode: string, alsoBrainiac: boolean): string[] {
  const ids: string[] = [];
  if (mode === "qotd") ids.push("qotd_champion");
  else if (mode === "flash" || mode === "picture") ids.push("flash_champ");
  else if (mode === "prompt") ids.push("smart_cookie");
  else ids.push("trivia_winner");
  if (alsoBrainiac) ids.push("brainiac");
  return ids;
}

export function configuredChannel(
  rule: BadgeRule,
  trackChannelId: string | null | undefined,
  tradeChannelId: string | null | undefined,
): string | null {
  if (rule.channel) return rule.channel;
  if (rule.trigger === "attachments") return tradeChannelId ?? null;
  if (rule.trigger === "messages" || rule.trigger === "reactions") return trackChannelId ?? null;
  return null;
}
