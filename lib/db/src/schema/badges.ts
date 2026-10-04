import {
  pgTable, text, serial, integer, boolean, timestamp, jsonb, index, uniqueIndex,
} from "drizzle-orm/pg-core";

// ─────────────────────────────────────────────────────────────────────────────
// Configurable community badges (replaces trivia Discord role awards).
// Rules + progress live per guild; earned badges live per member.
// Each earned badge has a permanent level (1–100) that evolves with XP.
// ─────────────────────────────────────────────────────────────────────────────

export type BadgeTrigger =
  | "manual"
  | "messages"
  | "attachments"
  | "reactions"
  | "streak"
  | "collection"
  | "trivia";

export type BadgeRule = {
  id: string;
  name: string;
  emoji: string;
  description: string;
  trigger: BadgeTrigger;
  threshold: number;
  /** Channel to watch for messages / attachments / reactions */
  channel?: string | null;
  /** For trivia trigger: flash | trivia | qotd | prompt | any */
  triviaMode?: string | null;
};

export type BadgeEarned = {
  id: string;
  timestamp: number;
  /** Permanent badge level, 1–100 */
  level: number;
  /** XP progress within the current level (toward level+1) */
  xp: number;
};

export const badgeSettingsTable = pgTable("badge_settings", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull().unique(),
  enabled: boolean("enabled").notNull().default(true),
  /** Discord role id allowed to give/take manual badges */
  staffRoleId: text("staff_role_id"),
  /** Legacy fallbacks (per-rule channel takes precedence) */
  trackChannelId: text("track_channel_id"),
  tradeChannelId: text("trade_channel_id"),
  badgeRules: jsonb("badge_rules").$type<BadgeRule[]>().notNull().default([]),
  maxAttachmentsPerPost: integer("max_attachments_per_post").notNull().default(3),
  uploadCooldownSeconds: integer("upload_cooldown_seconds").notNull().default(5),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type BadgeSettings = typeof badgeSettingsTable.$inferSelect;

export const memberBadgesTable = pgTable("member_badges", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  earned: jsonb("earned").$type<BadgeEarned[]>().notNull().default([]),
  progress: jsonb("progress").$type<Record<string, number | string>>().notNull().default({}),
  lastActiveDay: text("last_active_day"),
  streak: integer("streak").notNull().default(0),
  tradeCooldownUntil: timestamp("trade_cooldown_until"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("member_badges_guild_user_uidx").on(t.guildId, t.userId),
  index("member_badges_guild_idx").on(t.guildId),
]);

export type MemberBadges = typeof memberBadgesTable.$inferSelect;
