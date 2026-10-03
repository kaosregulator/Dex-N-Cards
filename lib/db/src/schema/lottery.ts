import {
  pgTable, text, serial, integer, boolean, timestamp, jsonb, index, uniqueIndex,
} from "drizzle-orm/pg-core";

// ─────────────────────────────────────────────────────────────────────────────
// UB Lottery Suite — classic lottery, Powerball, Mega Millionaire, scratchers.
// Ticket spend → prize pool (UB cash via UnbelievaBoat API). See docs/lottery.md.
// ─────────────────────────────────────────────────────────────────────────────

export type LotteryGameKey = "classic" | "powerball" | "mega" | "scratch";

export const ubLotterySettingsTable = pgTable("ub_lottery_settings", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull().unique(),
  enabled: boolean("enabled").notNull().default(true),
  announceChannelId: text("announce_channel_id"),
  /** 0=Sun … 6=Sat UTC */
  weeklyDrawDay: integer("weekly_draw_day").notNull().default(6),
  weeklyDrawHourUtc: integer("weekly_draw_hour_utc").notNull().default(20),
  lastDrawDate: text("last_draw_date"),
  /** Per-game overrides: ticketPrice, seedJackpot, enabled */
  gameConfig: jsonb("game_config").$type<Record<string, Record<string, unknown>>>().notNull().default({}),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type UbLotterySettings = typeof ubLotterySettingsTable.$inferSelect;

export const ubLotteryPoolsTable = pgTable("ub_lottery_pools", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  gameKey: text("game_key").notNull(),
  poolAmount: integer("pool_amount").notNull().default(0),
  seedAmount: integer("seed_amount").notNull().default(0),
  ticketPrice: integer("ticket_price").notNull().default(250),
  status: text("status").notNull().default("open"), // open | drawing | paused
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("ub_lottery_pools_guild_game_uidx").on(t.guildId, t.gameKey),
  index("ub_lottery_pools_guild_idx").on(t.guildId),
]);

export type UbLotteryPool = typeof ubLotteryPoolsTable.$inferSelect;

export const ubLotteryDrawsTable = pgTable("ub_lottery_draws", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  gameKey: text("game_key").notNull(),
  status: text("status").notNull().default("scheduled"), // scheduled | live | complete
  winningNumbers: jsonb("winning_numbers").$type<number[]>().notNull().default([]),
  powerball: integer("powerball"),
  poolAtDraw: integer("pool_at_draw").notNull().default(0),
  channelId: text("channel_id"),
  messageId: text("message_id"),
  winners: jsonb("winners").$type<Array<Record<string, unknown>>>().notNull().default([]),
  scheduledAt: timestamp("scheduled_at"),
  drawnAt: timestamp("drawn_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("ub_lottery_draws_guild_idx").on(t.guildId),
  index("ub_lottery_draws_status_idx").on(t.status),
]);

export type UbLotteryDraw = typeof ubLotteryDrawsTable.$inferSelect;

export const ubLotteryTicketsTable = pgTable("ub_lottery_tickets", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  gameKey: text("game_key").notNull(),
  userId: text("user_id").notNull(),
  numbers: jsonb("numbers").$type<number[]>().notNull().default([]),
  powerball: integer("powerball"),
  cost: integer("cost").notNull().default(0),
  drawId: integer("draw_id"),
  prizePaid: integer("prize_paid").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("ub_lottery_tickets_guild_game_idx").on(t.guildId, t.gameKey),
  index("ub_lottery_tickets_user_idx").on(t.guildId, t.userId),
  index("ub_lottery_tickets_draw_idx").on(t.drawId),
]);

export type UbLotteryTicket = typeof ubLotteryTicketsTable.$inferSelect;

export const ubLotteryScratchersTable = pgTable("ub_lottery_scratchers", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  /** copper | silver | gold | diamond */
  tierKey: text("tier_key").notNull().default("silver"),
  cost: integer("cost").notNull().default(0),
  prize: integer("prize").notNull().default(0),
  /** 9 cells: label + value; reveal mask tracked separately */
  cells: jsonb("cells").$type<Array<{ label: string; value: number }>>().notNull().default([]),
  revealedCount: integer("revealed_count").notNull().default(0),
  fullyRevealed: boolean("fully_revealed").notNull().default(false),
  redeemed: boolean("redeemed").notNull().default(false),
  redeemTo: text("redeem_to"), // cash | bank
  /** Whether this reveal was posted publicly in-channel */
  publicReveal: boolean("public_reveal").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("ub_lottery_scratchers_guild_user_idx").on(t.guildId, t.userId),
]);

export type UbLotteryScratcher = typeof ubLotteryScratchersTable.$inferSelect;
