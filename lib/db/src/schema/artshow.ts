import {
  pgTable, text, serial, integer, boolean, timestamp, index, uniqueIndex,
} from "drizzle-orm/pg-core";

// ─────────────────────────────────────────────────────────────────────────────
// Art Show — submission board + read-only gallery, button votes, emblems,
// vote wallets, bump perks, and a Hall of Fame / museum crown.
// ─────────────────────────────────────────────────────────────────────────────

export type ArtOrientation = "landscape" | "portrait" | "square";

export const artshowSettingsTable = pgTable("artshow_settings", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull().unique(),
  enabled: boolean("enabled").notNull().default(true),
  /**
   * Legacy single-channel id (pre two-channel split).
   * Kept for migration; prefer boardChannelId + galleryChannelId.
   */
  channelId: text("channel_id"),
  /** Channel with the submission station — members drop photos here */
  boardChannelId: text("board_channel_id"),
  /** Channel where hung pieces live — read-only for non-staff */
  galleryChannelId: text("gallery_channel_id"),
  stationMessageId: text("station_message_id"),
  /** @deprecated Sticky board removed — column retained for existing DBs */
  stickyMessageId: text("sticky_message_id"),
  staffRoleId: text("staff_role_id"),
  /** Base votes granted each UTC day */
  votesPerDay: integer("votes_per_day").notNull().default(5),
  /** Extra votes earned when a member submits a piece */
  bonusVotesOnSubmit: integer("bonus_votes_on_submit").notNull().default(2),
  /** Hours between partial wallet refreshes (+1 vote, capped) */
  voteRefreshHours: integer("vote_refresh_hours").notNull().default(6),
  /** Votes spent to bump a piece back to the top of the gallery */
  bumpCostVotes: integer("bump_cost_votes").notNull().default(3),
  /** First piece to hit this many votes in a week is auto-crowned (0 = off) */
  crownThreshold: integer("crown_threshold").notNull().default(25),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ArtshowSettings = typeof artshowSettingsTable.$inferSelect;

export const artshowPiecesTable = pgTable("artshow_pieces", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  authorId: text("user_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  imageUrl: text("image_url").notNull(),
  orientation: text("orientation").notNull().default("landscape"),
  channelId: text("channel_id").notNull(),
  messageId: text("message_id"),
  votes: integer("votes").notNull().default(0),
  weekKey: text("week_key").notNull(),
  bumpedAt: timestamp("bumped_at"),
  featuredUntil: timestamp("featured_until"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("artshow_pieces_guild_idx").on(t.guildId),
  index("artshow_pieces_guild_week_idx").on(t.guildId, t.weekKey),
  index("artshow_pieces_author_idx").on(t.guildId, t.authorId),
  index("artshow_pieces_votes_idx").on(t.guildId, t.votes),
]);

export type ArtshowPiece = typeof artshowPiecesTable.$inferSelect;

export const artshowVotesTable = pgTable("artshow_votes", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  pieceId: integer("piece_id").notNull(),
  voterId: text("voter_id").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("artshow_votes_piece_voter_uidx").on(t.pieceId, t.voterId),
  index("artshow_votes_guild_voter_idx").on(t.guildId, t.voterId),
  index("artshow_votes_piece_idx").on(t.pieceId),
]);

export type ArtshowVote = typeof artshowVotesTable.$inferSelect;

/** Per-member daily vote wallet (refreshes + earned bonuses). */
export const artshowWalletsTable = pgTable("artshow_wallets", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  dayKey: text("day_key").notNull(),
  remaining: integer("remaining").notNull().default(5),
  earnedBonus: integer("earned_bonus").notNull().default(0),
  freeBumps: integer("free_bumps").notNull().default(0),
  lastRefreshAt: timestamp("last_refresh_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("artshow_wallets_guild_user_uidx").on(t.guildId, t.userId),
  index("artshow_wallets_guild_idx").on(t.guildId),
]);

export type ArtshowWallet = typeof artshowWalletsTable.$inferSelect;

/** Hall of Fame crowns — weekly (or threshold) winners. */
export const artshowFameTable = pgTable("artshow_fame", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  pieceId: integer("piece_id").notNull(),
  authorId: text("author_id").notNull(),
  weekKey: text("week_key").notNull(),
  votesAtCrown: integer("votes_at_crown").notNull().default(0),
  title: text("title").notNull(),
  imageUrl: text("image_url").notNull(),
  crownedAt: timestamp("crowned_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("artshow_fame_guild_week_uidx").on(t.guildId, t.weekKey),
  index("artshow_fame_guild_idx").on(t.guildId),
]);

export type ArtshowFame = typeof artshowFameTable.$inferSelect;
