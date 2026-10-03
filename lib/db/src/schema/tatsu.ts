import {
  pgTable, text, serial, integer, boolean, timestamp, jsonb, index, uniqueIndex,
} from "drizzle-orm/pg-core";

// ─────────────────────────────────────────────────────────────────────────────
// Tatsu addon — local control plane for the Tatsu REST API (api.tatsu.gg/v1).
//
// Focus: guild score/points leaderboards, member lookup, add/remove points &
// score, and local spam/watch tools. Persistence / per-message rates stay on
// Tatsu's own dashboard (t@persistence) — not exposed by their API.
//
// API key stays in env (`TATSU_API_KEY`) — never in DB. Create one with
// `t!apikey create` in Discord (key owner must be in the server). Discord-side
// `/tatsu` also requires Manage Server/Admin on both the invoker and our bot.
// ─────────────────────────────────────────────────────────────────────────────

export type TatsuRankingPeriod = "all" | "month" | "week";

export const tatsuSettingsTable = pgTable("tatsu_settings", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull().unique(),
  // Discord guild whose Tatsu economy we control (usually same as guildId).
  tatsuGuildId: text("tatsu_guild_id").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  // Default leaderboard timeframe for the Discord dashboard.
  rankingPeriod: text("ranking_period").notNull().default("all"),
  // Discord channel for Tatsu admin action logs.
  logChannelId: text("log_channel_id"),
  // Score delta threshold that flags a "rapid climber" after a snapshot compare.
  spamScoreDelta: integer("spam_score_delta").notNull().default(5000),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type TatsuSettings = typeof tatsuSettingsTable.$inferSelect;

export const tatsuAuditLogTable = pgTable("tatsu_audit_log", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  actorId: text("actor_id").notNull(),
  targetUserId: text("target_user_id"),
  action: text("action").notNull(), // points_add | points_remove | score_add | score_remove | watch_add | snapshot | …
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("tatsu_audit_log_guild_idx").on(t.guildId),
]);

export type TatsuAuditLog = typeof tatsuAuditLogTable.$inferSelect;

/** Local watchlist for suspected spam / abuse — Tatsu API has no spam endpoints. */
export const tatsuWatchlistTable = pgTable("tatsu_watchlist", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  note: text("note"),
  flaggedBy: text("flagged_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("tatsu_watchlist_guild_user_uidx").on(t.guildId, t.userId),
  index("tatsu_watchlist_guild_idx").on(t.guildId),
]);

export type TatsuWatchlist = typeof tatsuWatchlistTable.$inferSelect;

/**
 * Leaderboard snapshots for spam / climb detection.
 * Stores a compact ranking slice so we can compare score deltas over time.
 */
export const tatsuSnapshotsTable = pgTable("tatsu_snapshots", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  period: text("period").notNull().default("all"),
  // Array of { user_id, rank, score }
  rankings: jsonb("rankings").$type<Array<{ user_id: string; rank: number; score: number }>>().notNull().default([]),
  takenBy: text("taken_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("tatsu_snapshots_guild_idx").on(t.guildId),
]);

export type TatsuSnapshot = typeof tatsuSnapshotsTable.$inferSelect;
