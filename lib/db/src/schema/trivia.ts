import {
  pgTable, text, serial, integer, boolean, timestamp, jsonb, index, uniqueIndex,
} from "drizzle-orm/pg-core";

// ─────────────────────────────────────────────────────────────────────────────
// Community Trivia / QOTD / Flash Host — Discord game-host addon.
// Sources: OpenTDB (no key), QuizAPI.io (QUIZAPI_KEY), boneitis.org (prompts),
// dog.ceo picture flashes. See docs/trivia.md.
// ─────────────────────────────────────────────────────────────────────────────

export type TriviaAudience = "younger" | "general";
export type TriviaSource = "opentdb" | "quizapi" | "boneitis" | "picture";
export type TriviaMode = "flash" | "trivia" | "qotd" | "prompt";
export type TriviaRoundStatus = "preview" | "ready" | "live" | "ended";

export const triviaSettingsTable = pgTable("trivia_settings", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull().unique(),
  enabled: boolean("enabled").notNull().default(true),
  audience: text("audience").notNull().default("general"), // younger | general
  defaultSource: text("default_source").notNull().default("opentdb"),
  defaultCategory: text("default_category"),
  defaultGuessMode: text("default_guess_mode").notNull().default("buttons"), // buttons | modal | type
  qotdEnabled: boolean("qotd_enabled").notNull().default(false),
  qotdChannelId: text("qotd_channel_id"),
  qotdHourUtc: integer("qotd_hour_utc").notNull().default(16),
  qotdSource: text("qotd_source").notNull().default("opentdb"),
  qotdCategory: text("qotd_category"),
  /** Cached next question JSON for admin preview/skip. */
  nextCard: jsonb("next_card").$type<Record<string, unknown> | null>().default(null),
  /** roleKey → Discord role id */
  roleIds: jsonb("role_ids").$type<Record<string, string>>().notNull().default({}),
  lastQotdDate: text("last_qotd_date"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type TriviaSettings = typeof triviaSettingsTable.$inferSelect;

export const triviaRoundsTable = pgTable("trivia_rounds", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  messageId: text("message_id"),
  mode: text("mode").notNull().default("flash"),
  status: text("status").notNull().default("ready"),
  source: text("source").notNull().default("opentdb"),
  guessMode: text("guess_mode").notNull().default("buttons"),
  question: jsonb("question").$type<Record<string, unknown>>().notNull().default({}),
  answerNorm: text("answer_norm").notNull().default(""),
  hostId: text("host_id").notNull(),
  winners: jsonb("winners").$type<string[]>().notNull().default([]),
  winnerMessageId: text("winner_message_id"),
  cleanupAt: timestamp("cleanup_at"),
  startedAt: timestamp("started_at"),
  endedAt: timestamp("ended_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("trivia_rounds_guild_idx").on(t.guildId),
  index("trivia_rounds_status_idx").on(t.status),
]);

export type TriviaRound = typeof triviaRoundsTable.$inferSelect;

export const triviaGuessesTable = pgTable("trivia_guesses", {
  id: serial("id").primaryKey(),
  roundId: integer("round_id").notNull(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  guess: text("guess").notNull(),
  correct: boolean("correct").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("trivia_guesses_round_user_uidx").on(t.roundId, t.userId),
  index("trivia_guesses_round_idx").on(t.roundId),
]);

export type TriviaGuess = typeof triviaGuessesTable.$inferSelect;

export const triviaRoleHoldsTable = pgTable("trivia_role_holds", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  roleId: text("role_id").notNull(),
  roleKey: text("role_key").notNull(),
  roundId: integer("round_id"),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("trivia_role_holds_guild_idx").on(t.guildId),
  index("trivia_role_holds_expires_idx").on(t.expiresAt),
]);

export type TriviaRoleHold = typeof triviaRoleHoldsTable.$inferSelect;
