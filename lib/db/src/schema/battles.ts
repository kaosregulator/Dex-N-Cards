import {
  pgTable, text, serial, integer, timestamp,
  boolean, jsonb, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { cardsTable } from "./cards";

// ─────────────────────────────────────────────────────────────────────────────
// DN Cards — Battle System schema
//
// This is a PURELY ADDITIVE expansion. It never touches the existing card,
// collection, currency, rarity, pack, or profile tables — it only reads from
// them (card art / rarity / ownership) and writes battle-specific rows into
// its own tables. Every table is per-guild (guild_id) so each server keeps its
// own settings, rewards, leaderboards, seasons, achievements, and logs.
//
// Existing users keep everything: their cards, inventory, shards, and progress
// are untouched. Turning the battle system on for a server only adds new rows
// here.
// ─────────────────────────────────────────────────────────────────────────────

// ── Battle Settings (per-guild config, written by the setup wizard / hub) ────
// One row per guild. `setupComplete` gates battles: the /battle command tells
// players "an admin must finish setup" until an admin runs the wizard. Every
// numeric field is a configurable formula/economy knob so servers can tune the
// game without a code change.
export const battleSettingsTable = pgTable("battle_settings", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull().unique(),
  // Gates
  enabled: boolean("enabled").notNull().default(true),
  setupComplete: boolean("setup_complete").notNull().default(false),
  // Channels — null battleChannel = battles allowed in any channel.
  battleChannelId: text("battle_channel_id"),
  logChannelId: text("log_channel_id"),
  // ── Rules / timers ─────────────────────────────────────────────────────────
  turnTimerSeconds: integer("turn_timer_seconds").notNull().default(45),
  aiOfferSeconds: integer("ai_offer_seconds").notNull().default(60),
  // Animation pacing: delay in ms between cinematic frames (higher = slower,
  // more dramatic battles). Admin-tunable "speed controller". 120–4000.
  frameDelayMs: integer("frame_delay_ms").notNull().default(950),
  // Canvas/GIF animation system master switches and speed presets.
  // Battles use cheap single-frame PNGs now, so attack animations are on by default.
  battleAnimationEnabled: boolean("battle_animation_enabled").notNull().default(true),
  packAnimationEnabled: boolean("pack_animation_enabled").notNull().default(true),
  battleAnimationSpeed: text("battle_animation_speed").notNull().default("normal"),
  // When battleAnimationEnabled is on, this picks the visual style:
  //   true  = animated arena scene (both cards dash over a looping backdrop),
  //   false = "Classic" cheap single-frame attack cards (the lighter, pre-arena
  //           style). Admins toggle Off → Classic → Animated via /battle_admin.
  battleSceneAnimated: boolean("battle_scene_animated").notNull().default(true),
  // How the live HP / energy / ultimate block is drawn. The battle log embed
  // stays the same in every mode.
  //   classic — the original two text columns (default)
  //   drain   — a picture scoreboard; the bar falls on a hit, holds, then locks
  //             to a still so Discord does not replay the GIF
  //   gauges  — health bar plus Energy, Ultimate, and Shield circles
  battleStatusTheme: text("battle_status_theme").notNull().default("classic"),
  // ── Combat formula coefficients (all tunable) ────────────────────────────────
  hpBase: integer("hp_base").notNull().default(750),
  hpPerRarity: integer("hp_per_rarity").notNull().default(220),
  hpWorthDivisor: integer("hp_worth_divisor").notNull().default(40),
  attackBase: integer("attack_base").notNull().default(85),
  attackPerRarity: integer("attack_per_rarity").notNull().default(28),
  defenseBase: integer("defense_base").notNull().default(55),
  defensePerRarity: integer("defense_per_rarity").notNull().default(18),
  speedBase: integer("speed_base").notNull().default(50),
  critChancePct: integer("crit_chance_pct").notNull().default(12),
  critMultiplierPct: integer("crit_multiplier_pct").notNull().default(180),
  missChancePct: integer("miss_chance_pct").notNull().default(8),
  dodgeChancePct: integer("dodge_chance_pct").notNull().default(10),
  counterChancePct: integer("counter_chance_pct").notNull().default(10),
  energyGainPerTurn: integer("energy_gain_per_turn").notNull().default(20),
  chargeEnergyGain: integer("charge_energy_gain").notNull().default(45),
  specialCost: integer("special_cost").notNull().default(40),
  shieldStrengthPct: integer("shield_strength_pct").notNull().default(40),
  ultimateChargePerTurn: integer("ultimate_charge_per_turn").notNull().default(14),
  ultimateThreshold: integer("ultimate_threshold").notNull().default(100),
  ultimateDamagePct: integer("ultimate_damage_pct").notNull().default(260),
  // ── Level scaling ────────────────────────────────────────────────────────────
  // Card level (1..MAX_LEVEL) scales combat stats. `levelMaxBonusPct` is the
  // TOTAL bonus applied at max level, spread linearly from level 1 (+0%). E.g.
  // 150 → a maxed card hits ~2.5× its base. Leveling is the grind that makes a
  // card stronger; 0 disables scaling (back to flat, level-agnostic stats).
  levelMaxBonusPct: integer("level_max_bonus_pct").notNull().default(150),
  // ── Card eligibility ─────────────────────────────────────────────────────────
  minRarity: text("min_rarity").notNull().default("common"),
  maxRarity: text("max_rarity").notNull().default("mythic"),
  // null = all types allowed; otherwise an array of allowed cardType labels.
  allowedTypes: jsonb("allowed_types").$type<string[] | null>(),
  specialCardsEnabled: boolean("special_cards_enabled").notNull().default(true),
  stakingEnabled: boolean("staking_enabled").notNull().default(true),
  aiEnabled: boolean("ai_enabled").notNull().default(true),
  // ── Rewards (per-guild, uses the existing DN Shards economy) ─────────────────
  rewardWinShards: integer("reward_win_shards").notNull().default(120),
  rewardLossShards: integer("reward_loss_shards").notNull().default(25),
  rewardDrawShards: integer("reward_draw_shards").notNull().default(50),
  rewardWinXp: integer("reward_win_xp").notNull().default(50),
  rewardLossXp: integer("reward_loss_xp").notNull().default(15),
  streakBonusShards: integer("streak_bonus_shards").notNull().default(20),
  streakBonusMax: integer("streak_bonus_max").notNull().default(200),
  dailyRewardLimit: integer("daily_reward_limit").notNull().default(25),
  // Free pack awarded when a win streak hits this multiple (0 = disabled).
  freePackStreak: integer("free_pack_streak").notNull().default(5),
  freePackTier: text("free_pack_tier").notNull().default("basic"),
  // AI battles pay a fraction of PvP rewards (percent). 0 disables AI rewards.
  aiRewardPct: integer("ai_reward_pct").notNull().default(50),
  // Global (cross-guild) leaderboard opt-in.
  globalLeaderboardOptIn: boolean("global_leaderboard_opt_in").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type BattleSettings = typeof battleSettingsTable.$inferSelect;

// ── Battle Card Config (per-guild, per-card admin overrides) ─────────────────
// Optional. When absent, battle stats are DERIVED from the card (rarity, worth,
// type) by the stat engine. Admins can override any stat, flag a card as a
// special-support card (giving it an effect), or disable a card from battle
// entirely — all WITHOUT touching the shared `cards` row. Any null stat column
// falls back to the derived value.
export const battleCardConfigTable = pgTable("battle_card_config", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  cardId: integer("card_id").notNull().references(() => cardsTable.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(true),
  // Per-guild BATTLE-ONLY rarity override. Null = use the card's real rarity.
  // Lets admins fix a card whose battle rarity looks wrong WITHOUT changing the
  // real card's rarity/worth/economy. Drives both stat derivation and display.
  rarity: text("rarity"),
  health: integer("health"),
  attack: integer("attack"),
  defense: integer("defense"),
  speed: integer("speed"),
  luck: integer("luck"),
  critChance: integer("crit_chance"),
  accuracy: integer("accuracy"),
  dodge: integer("dodge"),
  energyMax: integer("energy_max"),
  ultimateMax: integer("ultimate_max"),
  // Signature moveset key (see movesets engine) driving this card's "Special"
  // move. Null = auto-assign from the card type. Battle-only; never touches the
  // core card.
  moveset: text("moveset"),
  // Passive ability id (see passives engine) that auto-triggers in battle. Null =
  // no passive. Battle-only; never touches the core card.
  passive: text("passive"),
  // If set, this card can be selected as a SPECIAL support card and applies the
  // named effect (see special-cards engine): heal, damage_boost, shield, poison,
  // burn, freeze, reflect, double_attack, energy_boost, buff, nuke.
  specialEffect: text("special_effect"),
  specialCooldown: integer("special_cooldown").notNull().default(3),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  updatedBy: text("updated_by"),
}, (t) => ({
  guildCardUniq: uniqueIndex("battle_card_config_guild_card_uniq").on(t.guildId, t.cardId),
}));

export type BattleCardConfig = typeof battleCardConfigTable.$inferSelect;

// ── Battle Backgrounds (per-guild uploadable arena art) ──────────────────────
// Up to 3 slots. The battle VS renderer picks one at random each fight (auto
// shuffle); an empty table falls back to the built-in vibrant gradient. Mirrors
// showcase_backgrounds so admins get the same upload UX for the arena canvas.
export const battleBackgroundsTable = pgTable("battle_backgrounds", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  slot: integer("slot").notNull(), // 1, 2, or 3
  url: text("url").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedBy: text("updated_by"),
}, (t) => ({
  guildSlotUniq: uniqueIndex("battle_backgrounds_guild_slot_idx").on(t.guildId, t.slot),
}));

export type BattleBackground = typeof battleBackgroundsTable.$inferSelect;

// ── Battle Content (per-guild custom content overlay) ────────────────────────
// A single, data-driven overlay for admin-authored battle content: custom
// battle items today, and moves/passives in future. Each row is one content
// entry (kind + contentId) with its full definition in `data`. The engine's
// registries MERGE these over the code defaults at read time, so every server
// can add or override content without a code change while the built-in defaults
// always remain available (a disabled row hides that entry for the guild).
export const battleContentTable = pgTable("battle_content", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  kind: text("kind").notNull(),           // "item" | "move" | "passive"
  contentId: text("content_id").notNull(),// stable id within the kind
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  updatedBy: text("updated_by"),
}, (t) => ({
  guildKindIdUniq: uniqueIndex("battle_content_guild_kind_id_idx").on(t.guildId, t.kind, t.contentId),
  guildKindIdx: index("battle_content_guild_kind_idx").on(t.guildId, t.kind),
}));

export type BattleContent = typeof battleContentTable.$inferSelect;

// ── Battle Profiles (per-guild, per-user persistent stats) ───────────────────
export const battleProfilesTable = pgTable("battle_profiles", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  draws: integer("draws").notNull().default(0),
  totalBattles: integer("total_battles").notNull().default(0),
  damageDealt: integer("damage_dealt").notNull().default(0),
  damageTaken: integer("damage_taken").notNull().default(0),
  criticalHits: integer("critical_hits").notNull().default(0),
  cardsWon: integer("cards_won").notNull().default(0),
  cardsLost: integer("cards_lost").notNull().default(0),
  // ── Raid stats (co-op boss raids; feed the /top Raid leaderboard) ────────────
  raidsWon: integer("raids_won").notNull().default(0),
  raidsLost: integer("raids_lost").notNull().default(0),
  soloRaidsWon: integer("solo_raids_won").notNull().default(0),
  raidsSurvived: integer("raids_survived").notNull().default(0),
  raidDamageDealt: integer("raid_damage_dealt").notNull().default(0),
  raidDamageTaken: integer("raid_damage_taken").notNull().default(0),
  currentStreak: integer("current_streak").notNull().default(0),
  highestStreak: integer("highest_streak").notNull().default(0),
  xp: integer("xp").notNull().default(0),
  level: integer("level").notNull().default(1),
  rankPoints: integer("rank_points").notNull().default(1000),
  // Map of cardId → times used, for deriving the favorite card.
  cardUsage: jsonb("card_usage").$type<Record<string, number>>().notNull().default({}),
  // Unlocked cosmetic titles + the one currently equipped.
  titles: jsonb("titles").$type<string[]>().notNull().default([]),
  currentTitle: text("current_title"),
  // Per-day reward throttle (respects dailyRewardLimit).
  rewardBattlesToday: integer("reward_battles_today").notNull().default(0),
  rewardDayKey: text("reward_day_key"),
  lastBattleAt: timestamp("last_battle_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  guildUserUniq: uniqueIndex("battle_profiles_guild_user_uniq").on(t.guildId, t.userId),
  byGuildRank: index("battle_profiles_guild_rank_idx").on(t.guildId, t.rankPoints),
}));

export type BattleProfile = typeof battleProfilesTable.$inferSelect;

// ── Battle Records (completed-battle audit log) ──────────────────────────────
export const battleRecordsTable = pgTable("battle_records", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  seasonId: integer("season_id"),
  challengerId: text("challenger_id").notNull(),
  opponentId: text("opponent_id").notNull(),
  isAi: boolean("is_ai").notNull().default(false),
  aiDifficulty: text("ai_difficulty"),
  challengerCardId: integer("challenger_card_id"),
  opponentCardId: integer("opponent_card_id"),
  winnerId: text("winner_id"),
  staked: boolean("staked").notNull().default(false),
  turns: integer("turns").notNull().default(0),
  challengerDamage: integer("challenger_damage").notNull().default(0),
  opponentDamage: integer("opponent_damage").notNull().default(0),
  endedReason: text("ended_reason").notNull().default("ko"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  byGuild: index("battle_records_guild_idx").on(t.guildId, t.createdAt),
}));

export type BattleRecord = typeof battleRecordsTable.$inferSelect;

// ── Battle Achievements (unlocked) ───────────────────────────────────────────
export const battleAchievementsTable = pgTable("battle_achievements", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  achievementKey: text("achievement_key").notNull(),
  unlockedAt: timestamp("unlocked_at").notNull().defaultNow(),
}, (t) => ({
  uniq: uniqueIndex("battle_achievements_uniq").on(t.guildId, t.userId, t.achievementKey),
}));

export type BattleAchievement = typeof battleAchievementsTable.$inferSelect;

// ── Battle Seasons (per-guild, resettable) ───────────────────────────────────
export const battleSeasonsTable = pgTable("battle_seasons", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  seasonNumber: integer("season_number").notNull().default(1),
  name: text("name"),
  isActive: boolean("is_active").notNull().default(true),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  endedAt: timestamp("ended_at"),
}, (t) => ({
  byGuild: index("battle_seasons_guild_idx").on(t.guildId, t.isActive),
}));

export type BattleSeason = typeof battleSeasonsTable.$inferSelect;

// ── Daily Challenges (per-guild, per-user, per-day) ──────────────────────────
export type DailyChallenge = {
  key: string;          // stable objective id (win3, dmg1000, …)
  label: string;        // human text
  goal: number;
  progress: number;
  rewardShards: number;
  rewardXp: number;
  claimed: boolean;
};

export const battleDailyChallengesTable = pgTable("battle_daily_challenges", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  dayKey: text("day_key").notNull(),   // YYYY-MM-DD (UTC)
  challenges: jsonb("challenges").$type<DailyChallenge[]>().notNull().default([]),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  uniq: uniqueIndex("battle_daily_guild_user_day_uniq").on(t.guildId, t.userId, t.dayKey),
}));

export type BattleDailyChallenges = typeof battleDailyChallengesTable.$inferSelect;

// ── Battle Locks (race-condition + multiple-battle protection) ───────────────
// One active row per (guild, user): the unique index makes it impossible for a
// player to be in two battles at once, and records the card they staked so it
// can't be used or transferred elsewhere until the battle resolves. Rows are
// inserted when a battle is confirmed and deleted when it ends (win/loss/
// timeout/error). A staleness sweep clears rows older than the max battle TTL.
export const battleLocksTable = pgTable("battle_locks", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  battleId: text("battle_id").notNull(),
  cardId: integer("card_id"),
  staked: boolean("staked").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  guildUserUniq: uniqueIndex("battle_locks_guild_user_uniq").on(t.guildId, t.userId),
}));

export type BattleLock = typeof battleLocksTable.$inferSelect;
