import {
  pgTable, text, serial, integer, timestamp,
  boolean, real, pgEnum, uniqueIndex, jsonb, index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";

// ── Enums ─────────────────────────────────────────────────────────────────────
export const rarityEnum = pgEnum("rarity", [
  "common", "uncommon", "rare", "epic", "legendary", "mythic",
]);

export const cardTypeEnum = pgEnum("card_type", [
  "tank", "aircraft", "ship", "vehicle", "infantry",
  "boss", "community", "event", "achievement", "limited",
]);

export const tradeStatusEnum = pgEnum("trade_status", [
  "pending", "accepted", "declined", "cancelled", "expired",
]);

// ── Cards ─────────────────────────────────────────────────────────────────────
export const cardsTable = pgTable("cards", {
  id: serial("id").primaryKey(),
  // Per-guild ownership: cards created by the home guild are shared globally;
  // cards created by other guilds are only visible in that guild.
  // Default is the home guild ID so production schema migrations that add this
  // column to existing rows do not truncate the table. Application code always
  // supplies the real guild ID for new inserts.
  guildId: text("guild_id").notNull().default("1363917781355069761"),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  rarity: rarityEnum("rarity").notNull(),
  // cardType was a pgEnum("card_type") until May 2026; converted to plain text
  // so admins can type any label ("Car", "Ground Vehicle", "Mech", etc.).
  cardType: text("card_type").notNull().default("vehicle"),
  dropWeight: real("drop_weight").notNull().default(1.0),
  worthValue: integer("worth_value").notNull().default(10),
  burnValue: integer("burn_value").notNull().default(5),
  isLimitedEdition: boolean("is_limited_edition").notNull().default(false),
  isEventExclusive: boolean("is_event_exclusive").notNull().default(false),
  maxCopies: integer("max_copies"),
  totalMinted: integer("total_minted").notNull().default(0),
  imageUrl: text("image_url"),
  // True when imageUrl is an animated GIF. Detected (byte-sniffed) at card
  // create/edit time; render paths that composite art onto a canvas would
  // otherwise flatten a GIF to its first frame, so they use this flag to route
  // animated cards to the live GIF instead (spawns, /info play button).
  isAnimated: boolean("is_animated").notNull().default(false),
  flavor: text("flavor"),
  droppable: boolean("droppable").notNull().default(true),
  inPacks: boolean("in_packs").notNull().default(true),
  isArchived: boolean("is_archived").notNull().default(false),
  // A raid boss's own card — auto-created when an admin makes a boss (see
  // raid/admin.ts) so it can be handed out as the boss-card reward. Untradeable
  // by default (see guildSettings.allowBossCardTrades); usable in battle.
  isBossCard: boolean("is_boss_card").notNull().default(false),
  // Manual podium pick for the dashboard /events page: 1 = gold, 2 = silver,
  // 3 = bronze, null = appears in the grid below the podium. Only one card
  // per slot — enforced by a partial unique index. Cleared automatically
  // when isEventExclusive flips false (the cards-router PATCH handles it).
  podiumPlace: integer("podium_place"),
  // Per-card preview customization for the dashboard /events detail dialog.
  // previewAnimation: 'spin' | 'bounce' | 'flip' | 'pulse' | 'none' — null = default (spin).
  // previewBgColor: any CSS color string (hex preferred). null = rarity-tinted gradient.
  previewAnimation: text("preview_animation"),
  previewBgColor: text("preview_bg_color"),
  // 'portrait' (default — aspect 3/4, cropped via object-cover) or 'landscape'
  // (aspect 4/3, letterboxed via object-contain). Use landscape for source
  // artwork that is wider than it is tall (e.g. the Boss Sea Tank card) so the
  // image isn't awkwardly cropped on the dashboard /events detail dialog.
  displayOrientation: text("display_orientation"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  // Card names are unique within a guild. The home guild's cards are shared
  // across all servers; other guilds' cards stay private to that server.
  guildNameUniq: uniqueIndex("cards_guild_name_uniq").on(t.guildId, t.name),
  // At most one card per podium slot. Partial index so null values (most
  // cards) don't conflict.
  podiumPlaceUniq: uniqueIndex("cards_podium_place_uniq")
    .on(t.podiumPlace)
    .where(sql`${t.podiumPlace} IS NOT NULL`),
}));

export const insertCardSchema = createInsertSchema(cardsTable).omit({ id: true, createdAt: true, totalMinted: true });
export type InsertCard = z.infer<typeof insertCardSchema>;
export type Card = typeof cardsTable.$inferSelect;

// ── User Collections ──────────────────────────────────────────────────────────
export const collectionsTable = pgTable("collections", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  cardId: integer("card_id").notNull().references(() => cardsTable.id),
  count: integer("count").notNull().default(1),
  // Shiny copies are tracked separately so we can count them once at 2× value
  // for net-worth / leaderboard, and so /burn can target them explicitly.
  // Shinies are never moved by trades (v1).
  shinyCount: integer("shiny_count").notNull().default(0),
  firstCaughtAt: timestamp("first_caught_at").notNull().defaultNow(),
  lastCaughtAt: timestamp("last_caught_at").notNull().defaultNow(),
}, (t) => ({
  // One row per (guild, user, card). Enables atomic upsert via ON CONFLICT,
  // eliminating the select-then-insert race when a user catches the same
  // card from two concurrent spawns.
  uniqGuildUserCard: uniqueIndex("collections_guild_user_card_uniq")
    .on(t.guildId, t.userId, t.cardId),
}));

export const insertCollectionSchema = createInsertSchema(collectionsTable).omit({
  id: true, firstCaughtAt: true, lastCaughtAt: true,
});
export type InsertCollection = z.infer<typeof insertCollectionSchema>;
export type Collection = typeof collectionsTable.$inferSelect;

// ── User Currency (DN Shards) ─────────────────────────────────────────────────
export const userCurrencyTable = pgTable("user_currency", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  shards: integer("shards").notNull().default(0),
  totalEarned: integer("total_earned").notNull().default(0),
  packsOpened: integer("packs_opened").notNull().default(0),
  cardsBurned: integer("cards_burned").notNull().default(0),
  // Scrap — second currency earned by recycling duplicate cards. Separate from
  // Shards; no spend path yet (future economy sink). Added 2026-07.
  scrap: integer("scrap").notNull().default(0),
  // ── Pack tier counters (rolling weekly bucket) ──────────────────────────────
  // packsWeekResetAt: when the weekly bucket flips. On `/pack`, if now > this,
  // all 3 packs*Week counters are zeroed and the date is rolled forward to the
  // next Monday 00:00 UTC.
  packsBasicWeek: integer("packs_basic_week").notNull().default(0),
  packsPremiumWeek: integer("packs_premium_week").notNull().default(0),
  packsLegendaryWeek: integer("packs_legendary_week").notNull().default(0),
  packsWeekResetAt: timestamp("packs_week_reset_at").notNull().defaultNow(),
  // Shared cooldown across all tiers.
  lastPackOpenedAt: timestamp("last_pack_opened_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type UserCurrency = typeof userCurrencyTable.$inferSelect;

// ── Daily Claims ──────────────────────────────────────────────────────────────
export const dailyClaimsTable = pgTable("daily_claims", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  lastClaimedAt: timestamp("last_claimed_at").notNull().defaultNow(),
  streak: integer("streak").notNull().default(0),
}, t => ({
  uniqGuildUser: uniqueIndex("daily_claims_guild_user_uniq").on(t.guildId, t.userId),
}));

export type DailyClaim = typeof dailyClaimsTable.$inferSelect;

// ── Achievements (unlocked) ───────────────────────────────────────────────────
export const achievementsTable = pgTable("achievements_unlocked", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  achievementKey: text("achievement_key").notNull(),
  unlockedAt: timestamp("unlocked_at").notNull().defaultNow(),
}, t => ({
  uniqUserAchievement: uniqueIndex("achievements_user_key_uniq").on(t.guildId, t.userId, t.achievementKey),
}));

export type AchievementUnlock = typeof achievementsTable.$inferSelect;

// ── Trades ────────────────────────────────────────────────────────────────────
// Card fields are nullable so a trade can be cards-only, shards-only, or mixed.
export const tradesTable = pgTable("trades", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  initiatorId: text("initiator_id").notNull(),
  targetId: text("target_id").notNull(),
  offeredCardId: integer("offered_card_id").references(() => cardsTable.id),
  requestedCardId: integer("requested_card_id").references(() => cardsTable.id),
  offeredShards: integer("offered_shards").notNull().default(0),
  requestedShards: integer("requested_shards").notNull().default(0),
  status: tradeStatusEnum("status").notNull().default("pending"),
  messageId: text("message_id"),
  channelId: text("channel_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at"),
});

export type Trade = typeof tradesTable.$inferSelect;

// ── Guild Settings ────────────────────────────────────────────────────────────
export const guildSettingsTable = pgTable("guild_settings", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull().unique(),
  spawnChannelId: text("spawn_channel_id"),
  tradeChannelId: text("trade_channel_id"),
  // Opt-in "collector" ping role: when set, spawns @mention this role so
  // subscribed members get pinged on every spawn. Members self-toggle it with
  // /cards collector; admins set it with /admin collectorrole.
  collectorRoleId: text("collector_role_id"),
  spawnIntervalSeconds: integer("spawn_interval_seconds").notNull().default(3600),
  spawnIntervalMin: integer("spawn_interval_min"),
  spawnIntervalMax: integer("spawn_interval_max"),
  useRandomInterval: boolean("use_random_interval").notNull().default(false),
  spawnEnabled: boolean("spawn_enabled").notNull().default(true),
  catchWindowSeconds: integer("catch_window_seconds").notNull().default(120),
  tradeEnabled: boolean("trade_enabled").notNull().default(true),
  // Boss cards (isBossCard) are untradeable unless an admin flips this on —
  // they're meant to be earned by clearing the raid, not traded around.
  allowBossCardTrades: boolean("allow_boss_card_trades").notNull().default(false),
  // Cards per spawn: 1, 3, 5, or -1 (random 1–3)
  cardsPerSpawn: integer("cards_per_spawn").notNull().default(1),
  // Custom rarity drop weights per card of that tier (null = use card's default)
  rarityWeightCommon: integer("rarity_weight_common"),
  rarityWeightUncommon: integer("rarity_weight_uncommon"),
  rarityWeightRare: integer("rarity_weight_rare"),
  rarityWeightEpic: integer("rarity_weight_epic"),
  rarityWeightLegendary: integer("rarity_weight_legendary"),
  rarityWeightMythic: integer("rarity_weight_mythic"),
  // Per-guild customization of the Mythic tier display (name/emoji/color).
  // Null = use bot defaults ("Mythic" / "🔮" / #ff2d92). Admins set these via /rarityname.
  mythicLabel: text("mythic_label"),
  mythicEmoji: text("mythic_emoji"),
  mythicColor: integer("mythic_color"),
  // Per-guild display order for built-in rarities. Stored as text[] array of rarity enum keys.
  // Null = use canonical key order: common, uncommon, rare, epic, legendary, mythic.
  rarityOrder: text("rarity_order").array(),
  // Catch mode: "type" (type card name), "button" (click claim button), or "both"
  catchMode: text("catch_mode").notNull().default("type"),
  commandPrefix: text("command_prefix").notNull().default("!"),
  // Separate prefix for UnbelievaBoat casino games (default `.` → `.slots 100`).
  // Empty / null falls back to `.` at runtime; changeable per guild.
  gamesPrefix: text("games_prefix").notNull().default("."),
  // ── Pack store config ──────────────────────────────────────────────────────
  // Shared cooldown between any two pack opens (0 = no cooldown).
  packCooldownSeconds: integer("pack_cooldown_seconds").notNull().default(60),
  // Per-tier: cost in shards, cards per pack, and weekly cap (0 = unlimited).
  // Defaults are tuned to be roughly EV-fair vs. average card worth.
  packBasicCost: integer("pack_basic_cost").notNull().default(250),
  packBasicSize: integer("pack_basic_size").notNull().default(5),
  packBasicWeeklyLimit: integer("pack_basic_weekly_limit").notNull().default(50),
  packPremiumCost: integer("pack_premium_cost").notNull().default(750),
  packPremiumSize: integer("pack_premium_size").notNull().default(5),
  packPremiumWeeklyLimit: integer("pack_premium_weekly_limit").notNull().default(20),
  packLegendaryCost: integer("pack_legendary_cost").notNull().default(2000),
  packLegendarySize: integer("pack_legendary_size").notNull().default(5),
  packLegendaryWeeklyLimit: integer("pack_legendary_weekly_limit").notNull().default(5),
  // Per-guild display names for built-in pack tiers. Null/empty = use defaults.
  packBasicName: text("pack_basic_name"),
  packPremiumName: text("pack_premium_name"),
  packLegendaryName: text("pack_legendary_name"),
  // Per-guild descriptions for built-in pack tiers. Null/empty = no description.
  packBasicDesc: text("pack_basic_desc"),
  packPremiumDesc: text("pack_premium_desc"),
  packLegendaryDesc: text("pack_legendary_desc"),
  // ── Animation system toggles ───────────────────────────────────────────────
  // Master switches and pacing for the @napi-rs/canvas + gifencoder animation
  // system. Defaults keep the old instant embed behavior for low-powered setups.
  packAnimationEnabled: boolean("pack_animation_enabled").notNull().default(true),
  battleAnimationEnabled: boolean("battle_animation_enabled").notNull().default(true),
  packAnimationSpeed: text("pack_animation_speed").notNull().default("normal"),
  battleAnimationSpeed: text("battle_animation_speed").notNull().default("normal"),
  // ── Spawn reveal style ─────────────────────────────────────────────────────
  // How a spawned card's art is revealed in its animation. "auto" maps by rarity
  // (Blur → Puzzle → Silhouette as rarity climbs — the bot's own method), or an
  // admin can force one style for every spawn. "off" shows the plain card image.
  // Values: "auto" | "blur" | "puzzle" | "silhouette" | "off".
  spawnRevealMode: text("spawn_reveal_mode").notNull().default("auto"),
  // ── Card entrance animation (spawn pre-intro) ──────────────────────────────
  // A short "the card enters" motion played BEFORE the plain card image, only
  // when spawnRevealMode is "off" (image-only) — the reveal styles already have
  // their own presentation. Also plays on image-only spawns that lead into a
  // wild mini-game. Values: "off" | "random" | "flyin" | "teleport" |
  // "bounce" | "warp" | "flip".
  spawnEntranceAnimation: text("spawn_entrance_animation").notNull().default("off"),
  // The look drawn behind the entering card. "rarity" tints the backdrop by the
  // card's rarity colour (default); "tactical" = amber HUD w/ scanlines;
  // "holo" = cyan/magenta prism. Values: "rarity" | "tactical" | "holo".
  spawnEntranceSkin: text("spawn_entrance_skin").notNull().default("rarity"),
  // ── Shiny Hub ──────────────────────────────────────────────────────────────
  // Play a sparkle/shine animation when a shiny is caught or pulled, so a shiny
  // is instantly recognisable. Off falls back to the static ✨ badge + canvas.
  shinyAnimationEnabled: boolean("shiny_animation_enabled").notNull().default(true),
  // Which shiny reveal style plays. "classic" = the original gold shine; plus
  // "holofoil" | "rainbow" | "cosmic" | "prism" | "radiance" | "random".
  shinyAnimationStyle: text("shiny_animation_style").notNull().default("classic"),
  // How much more a shiny copy is worth / burns for vs. a normal copy. Stored as
  // a real multiplier (2 = double). Read via getShinyMultiplier (clamped 0.1–100).
  shinyValueMultiplier: real("shiny_value_multiplier").notNull().default(2),
  // Per-guild nickname for shinies (like custom rarity names). Null/empty =
  // "Shiny". Read via getShinyName (trimmed, capped at 32 chars).
  shinyName: text("shiny_name"),
  // ── Card Frames ────────────────────────────────────────────────────────────
  // Opt-in image frames drawn around card art everywhere it renders. Off by
  // default → the current thin drawn border is used unchanged. When on, each
  // rarity draws the assigned frame colour ("grey" | "blue" | "red" | "gold" |
  // "rainbow"); a null rarity column falls back to the drawn border for that
  // rarity. The frame image auto-scales to any card size/aspect.
  cardFramesEnabled: boolean("card_frames_enabled").notNull().default(false),
  cardFrameCommon: text("card_frame_common"),
  cardFrameUncommon: text("card_frame_uncommon"),
  cardFrameRare: text("card_frame_rare"),
  cardFrameEpic: text("card_frame_epic"),
  cardFrameLegendary: text("card_frame_legendary"),
  cardFrameMythic: text("card_frame_mythic"),
  // ── Scheduled spawn boost (temporary spawn-rate change) ─────────────────────
  // A temporary multiplier on the spawn RATE for busy/quiet periods, applied on
  // top of the base interval without changing it. 100 = normal, 200 = double the
  // spawns (half the interval), 50 = half the spawns. Active while
  // now < spawnBoostEndsAt AND (spawnBoostStartsAt is null OR already passed).
  // A null endsAt means no boost. Admins set/schedule this from /config → Drops.
  spawnBoostPct: integer("spawn_boost_pct").notNull().default(100),
  spawnBoostStartsAt: timestamp("spawn_boost_starts_at"),
  spawnBoostEndsAt: timestamp("spawn_boost_ends_at"),
  // ── Recycle / Card Progression Hub config ───────────────────────────────────
  // Master switch for the /recycle Card Progression Hub.
  recycleEnabled: boolean("recycle_enabled").notNull().default(true),
  // Global multipliers applied to scrap earned and XP gained from fusing duplicates.
  // Stored as hundredths (1.00 = 100). 100 = default, 50 = half, 200 = double.
  recycleScrapMultiplier: integer("recycle_scrap_multiplier").notNull().default(100),
  recycleXpMultiplier: integer("recycle_xp_multiplier").notNull().default(100),
  // Per-rarity base scrap value overrides. Null = use the bot-wide default formula.
  recycleScrapCommon: integer("recycle_scrap_common"),
  recycleScrapUncommon: integer("recycle_scrap_uncommon"),
  recycleScrapRare: integer("recycle_scrap_rare"),
  recycleScrapEpic: integer("recycle_scrap_epic"),
  recycleScrapLegendary: integer("recycle_scrap_legendary"),
  recycleScrapMythic: integer("recycle_scrap_mythic"),
  // ── Card Fusion cost config (duplicates + Scrap → +1 Star) ─────────────────
  // Global % multiplier applied to BOTH the duplicate and Scrap cost of fusing.
  // Stored as hundredths (100 = default, 50 = half price, 200 = double).
  fuseCostMultiplier: integer("fuse_cost_multiplier").notNull().default(100),
  // Per-rarity base DUPLICATE cost for the 0★→1★ step (scales ×(star+1) higher).
  // Null = use the bot-wide default table (see stars.ts DEFAULT_FUSE_DUPES).
  fuseDupesCommon: integer("fuse_dupes_common"),
  fuseDupesUncommon: integer("fuse_dupes_uncommon"),
  fuseDupesRare: integer("fuse_dupes_rare"),
  fuseDupesEpic: integer("fuse_dupes_epic"),
  fuseDupesLegendary: integer("fuse_dupes_legendary"),
  fuseDupesMythic: integer("fuse_dupes_mythic"),
  // Per-rarity base SCRAP cost for the 0★→1★ step (scales ×(star+1) higher).
  // Null = use the bot-wide default table (see stars.ts DEFAULT_FUSE_SCRAP).
  fuseScrapCommon: integer("fuse_scrap_common"),
  fuseScrapUncommon: integer("fuse_scrap_uncommon"),
  fuseScrapRare: integer("fuse_scrap_rare"),
  fuseScrapEpic: integer("fuse_scrap_epic"),
  fuseScrapLegendary: integer("fuse_scrap_legendary"),
  fuseScrapMythic: integer("fuse_scrap_mythic"),
  // ── Fusion Hub v2 (copies → Star, level reset; Scrap = leveling only) ───────
  // How many copies of a card are consumed to fuse it up ONE star. Flat per
  // star (default 5): 5 copies → +1★, and the card's level resets to 1.
  fuseCopiesPerStar: integer("fuse_copies_per_star").notNull().default(5),
  // When a Lv100 card gains more battle XP than it can use, the overflow becomes
  // Scrap at this % rate (100 = 1 XP → 1 scrap). Scrap is spent only to level
  // OTHER cards. 0 disables overflow→scrap.
  xpOverflowScrapRate: integer("xp_overflow_scrap_rate").notNull().default(100),
  // ── Active set (Sets-driven spawn pool) ────────────────────────────────────
  // The single set whose cards are eligible for random autodrops in this
  // guild. NULL = no set selected → **nothing spawns** (admins must pick a
  // set via `/setadmin active`). `/drop` (forced card) bypasses this check.
  activeSetId: integer("active_set_id").references(() => setsTable.id, { onDelete: "set null" }),
  // ── Secondary spawn stream ─────────────────────────────────────────────────
  // Optional second channel + set that runs simultaneously alongside the
  // primary stream. Each stream has its own timer, channel, and active set.
  // spawnEnabledSecondary=false (default) means the secondary stream is off.
  spawnChannelIdSecondary: text("spawn_channel_id_secondary"),
  activeSetIdSecondary: integer("active_set_id_secondary").references(() => setsTable.id, { onDelete: "set null" }),
  spawnEnabledSecondary: boolean("spawn_enabled_secondary").notNull().default(false),
  // ── Experience presentation (per-guild, per-experience) ─────────────────────
  // How each major experience is presented, chosen independently by the server
  // admin via `/config` → Experiences. Each has a PRIMARY mode and a FALLBACK
  // used when the primary can't run (e.g. the Activity fails to launch). Values:
  //   activity | discord_png | discord_embed | animated_image | disabled
  // Defaults intentionally preserve the CURRENT behaviour (server-rendered), so
  // migrating a live guild changes nothing until an admin opts into `activity`.
  hqPresentation: text("hq_presentation").notNull().default("discord_png"),
  hqFallback: text("hq_fallback").notNull().default("discord_png"),
  battlePresentation: text("battle_presentation").notNull().default("discord_embed"),
  battleFallback: text("battle_fallback").notNull().default("discord_embed"),
  raidPresentation: text("raid_presentation").notNull().default("discord_embed"),
  raidFallback: text("raid_fallback").notNull().default("discord_embed"),
  packPresentation: text("pack_presentation").notNull().default("animated_image"),
  packFallback: text("pack_fallback").notNull().default("animated_image"),
  // ── Wild Mini-Games ─────────────────────────────────────────────────────────
  // An admin-controlled layer of "wild" encounters: when a mini-game is armed on
  // a schedule, the NEXT successful catch does not immediately award the card —
  // instead a mini-game pops out (like a wild Pokémon). Win → the card is granted;
  // lose → it escapes. Then normal spawns resume until the next scheduled game.
  // Off by default so existing guilds keep the instant-award catch flow unchanged.
  miniGameEnabled: boolean("mini_game_enabled").notNull().default(false),
  // Cadence for arming the next game: "minutes" | "hourly" | "daily" | "weekly".
  miniGameCadence: text("mini_game_cadence").notNull().default("daily"),
  // Interval in minutes, used only when cadence = "minutes".
  miniGameIntervalMinutes: integer("mini_game_interval_minutes").notNull().default(1440),
  // Which game to spawn: "shuffle" (random each time) or a specific game key
  // (e.g. "reaction", "dice"). Unknown/removed keys fall back to shuffle.
  miniGameSelection: text("mini_game_selection").notNull().default("shuffle"),
  // When the next game arms (a game becomes "waiting for the next catch").
  // Persisted so the schedule survives a bot restart, like spawnBoostEndsAt.
  miniGameNextArmAt: timestamp("mini_game_next_arm_at"),
  // True while a game is armed and waiting for the next catch to trigger it.
  miniGameArmed: boolean("mini_game_armed").notNull().default(false),
  // Play the animated intro/menu canvas (best-effort). Off = static PNG intro.
  miniGameAnimationEnabled: boolean("mini_game_animation_enabled").notNull().default(true),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type GuildSettings = typeof guildSettingsTable.$inferSelect;

// ── Card Sets (first-class, replaces ad-hoc cards.set_name aggregation) ──────
// A "set" groups cards into a named bucket. Cards can belong to many sets via
// the junction table. One set per guild is "active" — only its members are
// eligible for random spawns. Loading a JSON pack or running `/setadmin
// create` both produce rows here. Legacy `cards.set_name` is still written
// during the transition (Phase 5 will drop it).
export const setsTable = pgTable("sets", {
  id: serial("id").primaryKey(),
  // Per-guild ownership: the home guild's sets are shared globally; other
  // guilds' sets are private to that guild. Set names are unique within a guild.
  // Default is the home guild ID so production schema migrations that add this
  // column to existing rows do not truncate the table. Application code always
  // supplies the real guild ID for new inserts.
  guildId: text("guild_id").notNull().default("1363917781355069761"),
  name: text("name").notNull(),
  description: text("description"),
  // Optional per-tier spawn-weight override applied ONLY when this set is the
  // guild's active set. Shape: `{ common: 60, uncommon: 25, ... }` — any keys
  // omitted fall through to the rarity profile / guild settings. Null means
  // the set has no opinion. Worth/burn/rarity of cards are NEVER touched.
  rarityWeights: jsonb("rarity_weights").$type<Record<string, number>>(),
  // When true, completing this set (owning every membership card) unlocks a
  // dedicated dynamic achievement `set_complete:<setId>`. Off by default so
  // existing/legacy sets don't suddenly create achievement noise — admins
  // opt-in via `/setadmin showcase`. Static set achievements (first/3/5)
  // count completions regardless of this flag.
  awardsCompletion: boolean("awards_completion").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  // Set names are unique within a guild; home guild sets are shared globally.
  guildNameUniq: uniqueIndex("sets_guild_name_uniq").on(t.guildId, t.name),
}));

export type CardSet = typeof setsTable.$inferSelect;

// Many-to-many: a card may live in 0, 1, or many sets. Both FKs cascade so
// deleting a card or a set automatically clears its memberships.
export const cardSetMembershipsTable = pgTable("card_set_memberships", {
  cardId: integer("card_id").notNull().references(() => cardsTable.id, { onDelete: "cascade" }),
  setId: integer("set_id").notNull().references(() => setsTable.id, { onDelete: "cascade" }),
  addedAt: timestamp("added_at").notNull().defaultNow(),
}, (t) => ({
  pk: uniqueIndex("card_set_memberships_pk").on(t.cardId, t.setId),
  bySet: uniqueIndex("card_set_memberships_set_card_idx").on(t.setId, t.cardId),
}));

export type CardSetMembership = typeof cardSetMembershipsTable.$inferSelect;

// ── Admin Users ───────────────────────────────────────────────────────────────
export const adminUsersTable = pgTable("admin_users", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  addedAt: timestamp("added_at").notNull().defaultNow(),
  addedBy: text("added_by").notNull(),
});

export type AdminUser = typeof adminUsersTable.$inferSelect;

// ── User Catch Timeouts ───────────────────────────────────────────────────────
// Admin-imposed time-out preventing a user from catching cards (typing or
// button) in a guild until `expiresAt`. One active row per (guild,user).
export const userTimeoutsTable = pgTable("user_timeouts", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  reason: text("reason"),
  issuedBy: text("issued_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type UserTimeout = typeof userTimeoutsTable.$inferSelect;

// ── Spawn Log ─────────────────────────────────────────────────────────────────
export const spawnLogTable = pgTable("spawn_log", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  cardId: integer("card_id").notNull().references(() => cardsTable.id),
  caughtBy: text("caught_by"),
  isForced: boolean("is_forced").notNull().default(false),
  spawnedAt: timestamp("spawned_at").notNull().defaultNow(),
  caughtAt: timestamp("caught_at"),
});

export type SpawnLog = typeof spawnLogTable.$inferSelect;

// ── Wishlists ─────────────────────────────────────────────────────────────────
export const wishlistsTable = pgTable("wishlists", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  cardId: integer("card_id").notNull().references(() => cardsTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  uniqUserCard: uniqueIndex("wishlists_guild_user_card_uniq").on(t.guildId, t.userId, t.cardId),
  byGuildCard: uniqueIndex("wishlists_guild_card_user_idx").on(t.guildId, t.cardId, t.userId),
}));

export type Wishlist = typeof wishlistsTable.$inferSelect;

// ── Card Events (limited-time spawn boosts) ──────────────────────────────────
// An active event multiplies a specific card's effective drop weight while
// `startsAt <= now() < endsAt`. Created by admins via /event start; ended by
// /event stop (which sets endsAt to NOW). Filtered by endsAt > NOW() so
// expired rows survive as a record without affecting drops.
export const cardEventsTable = pgTable("card_events", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  cardId: integer("card_id").notNull().references(() => cardsTable.id, { onDelete: "cascade" }),
  weightMultiplier: real("weight_multiplier").notNull().default(2.0),
  startsAt: timestamp("starts_at").notNull().defaultNow(),
  endsAt: timestamp("ends_at").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type CardEvent = typeof cardEventsTable.$inferSelect;

// ── Dashboard Users (per-user web admin logins) ───────────────────────────────
// Separate from `admin_users` (which is Discord-side bot admin permission).
// Each row is a username/password the user types into the web dashboard.
// `isOwner` users can also manage other dashboard users.
export const dashboardUsersTable = pgTable("dashboard_users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  isOwner: boolean("is_owner").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at"),
});

export type DashboardUser = typeof dashboardUsersTable.$inferSelect;

// ── Setup Tokens (one-time bootstrap links) ──────────────────────────────────
// Generated when the bot joins a guild (DM'd to owner) or by /dashboard slash
// command. The user opens /setup/<token> to pick a username +
// password. Token is consumed (`usedAt`) on success. Expired or used tokens
// are rejected.
export const setupTokensTable = pgTable("setup_tokens", {
  id: serial("id").primaryKey(),
  token: text("token").notNull().unique(),
  issuedToDiscordId: text("issued_to_discord_id").notNull(),
  guildId: text("guild_id"),
  // If set, this token resets the password for an existing user instead of
  // creating a new one. (Owner-initiated reset flow.)
  resetForUserId: integer("reset_for_user_id").references(() => dashboardUsersTable.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type SetupToken = typeof setupTokensTable.$inferSelect;

// ── Embed Overrides (per-guild customization of bot messages) ────────────────
// One row per (guildId, embedKey). `config` is a permissive jsonb blob; the
// applyEmbedOverride helper in the bot owns the shape and ignores unknown
// fields, so we can evolve it without a migration. Keep this table small —
// 8 embed keys × guild count.
export type EmbedOverrideConfig = {
  enabled?: boolean;                              // false = use bot defaults
  title?: string;                                 // tokens: {user} {card} {rarity} {worth} {chance} {streak} {tier} {amount} {balance} {guild}
  footer?: string;                                // same tokens
  descriptionPrefix?: string;                     // prepended to default description
  color?: number;                                 // 0xRRGGBB
  rarityColors?: Partial<Record<"common" | "uncommon" | "rare" | "epic" | "legendary" | "mythic", number>>;
  imageMode?: "default" | "large" | "thumbnail" | "none";
  customImageUrl?: string;                        // overrides card / banner image
  showWorth?: boolean;                            // default true
  showDropChance?: boolean;                       // default true (info embed)
};

export const EMBED_KEYS = [
  "spawn", "claimed", "daily", "pack", "trade", "welcome", "rules", "commands", "help",
] as const;
export type EmbedKey = typeof EMBED_KEYS[number];

// ── Rarity Profiles (per-guild rarity-level overrides) ───────────────────────
// Lets admins set "all Common cards in this server are worth 25 shards, burn
// for 12, and have drop weight 70" without editing every Common card row.
// Stored as nullable columns so a partial override (e.g. only worth) is
// supported — the bot's resolver falls back to the card's own value when a
// field is null. One row per (guildId, rarity); delete the row to fully revert.
export const rarityProfilesTable = pgTable("rarity_profiles", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  rarity: rarityEnum("rarity").notNull(),
  worthValue: integer("worth_value"),
  burnValue: integer("burn_value"),
  dropWeight: real("drop_weight"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  updatedBy: text("updated_by"),
}, (t) => ({
  guildRarityUniq: uniqueIndex("rarity_profiles_guild_rarity_idx").on(t.guildId, t.rarity),
}));

export type RarityProfile = typeof rarityProfilesTable.$inferSelect;

// ── Custom Rarity Tiers (per-guild new tiers beyond the 6 built-ins) ────────
// Lets admins define NEW tiers (e.g. "Ultra", "Prismatic") that sit alongside
// the built-in rarity enum without modifying it. `position` is a real number
// where built-ins occupy 1..6 (common=1, uncommon=2, rare=3, epic=4,
// legendary=5, mythic=6); a custom tier with position 5.5 sits between
// legendary and mythic, 7+ above mythic. Used by /tradein to order the
// ladder and by /list to group display.
//
// Custom-tier values fully REPLACE the card's worth/burn/dropWeight when a
// card is overridden into the tier (see card_rarity_overrides). No layering
// with rarity_profiles for those cards — one source of truth per card per
// guild.
export const customRaritiesTable = pgTable("custom_rarities", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  slug: text("slug").notNull(),              // short id, e.g. "ultra"
  name: text("name").notNull(),              // display label
  emoji: text("emoji").notNull().default("✨"),
  color: integer("color").notNull().default(0x5865f2),
  position: real("position").notNull(),      // ladder position
  worthValue: integer("worth_value").notNull(),
  burnValue: integer("burn_value").notNull(),
  dropWeight: real("drop_weight").notNull().default(1.0),
  droppable: boolean("droppable").notNull().default(true),
  // Custom tiers are excluded from /pack pools by default — admin-drop /
  // random-spawn only. Reserved for future use; resolver treats false as
  // exclusion.
  inPacks: boolean("in_packs").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  updatedBy: text("updated_by"),
}, (t) => ({
  guildSlugUniq: uniqueIndex("custom_rarities_guild_slug_idx").on(t.guildId, t.slug),
}));

export type CustomRarity = typeof customRaritiesTable.$inferSelect;

// Per-(guild,card) assignment to a custom rarity tier. When present, the
// card's effective rarity in that guild becomes the custom tier — built-in
// rarity column is ignored for display, weighting, and economy. Server 1
// (no override rows) sees the card at its built-in rarity, untouched.
export const cardRarityOverridesTable = pgTable("card_rarity_overrides", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  cardId: integer("card_id").notNull().references(() => cardsTable.id, { onDelete: "cascade" }),
  customRaritySlug: text("custom_rarity_slug").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  guildCardUniq: uniqueIndex("card_rarity_overrides_guild_card_idx").on(t.guildId, t.cardId),
  byGuildSlug: uniqueIndex("card_rarity_overrides_guild_slug_card_idx").on(t.guildId, t.customRaritySlug, t.cardId),
}));

export type CardRarityOverride = typeof cardRarityOverridesTable.$inferSelect;

export const embedOverridesTable = pgTable("embed_overrides", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  embedKey: text("embed_key").notNull(),
  config: jsonb("config").$type<EmbedOverrideConfig>().notNull().default({}),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  updatedBy: text("updated_by"),
}, (t) => ({
  guildKeyUniq: uniqueIndex("embed_overrides_guild_key_idx").on(t.guildId, t.embedKey),
}));

export type EmbedOverride = typeof embedOverridesTable.$inferSelect;

// ── Showcase / Canvas Backgrounds ────────────────────────────────────────────
// Per-guild uploadable backgrounds for the /user-hub "Show Card" trophy canvas.
// Up to 3 slots; the renderer picks one at random each time a showcase is posted.
// Empty slots fall back to the built-in obsidian/purple trophy gradient.
export const showcaseBackgroundsTable = pgTable("showcase_backgrounds", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  slot: integer("slot").notNull(), // 1, 2, or 3
  url: text("url").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedBy: text("updated_by"),
}, (t) => ({
  guildSlotUniq: uniqueIndex("showcase_backgrounds_guild_slot_idx").on(t.guildId, t.slot),
}));

export type ShowcaseBackground = typeof showcaseBackgroundsTable.$inferSelect;

// ── Custom Packs (per-guild configurable pack tiers) ──────────────────────────
// Admins define named packs that can pull from specific card types/tags
// (e.g. "Nuke Pack" → cardTypes = ["nuke","aircraft"]) and/or an explicit
// card whitelist (custom_pack_cards). Rarity distribution, cost, size, weekly
// limit, and emoji are all configurable. Created via /config → Packs or /editpack.
export const customPacksTable = pgTable("custom_packs", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  cost: integer("cost").notNull().default(500),
  size: integer("size").notNull().default(5),
  weeklyLimit: integer("weekly_limit").notNull().default(10),
  // Rarity draw rates — shape mirrors TIER_RATES in pack.ts.
  rarityRates: jsonb("rarity_rates").$type<Record<string, number>>().notNull(),
  // Card types this pack draws from. Empty array = all types.
  cardTypes: text("card_types").array().notNull().default([]),
  // Optional admin-set description shown when this pack is opened.
  description: text("description").notNull().default(""),
  // Optional emoji prefix shown in pack autocomplete and open embeds.
  emoji: text("emoji"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  guildSlugUniq: uniqueIndex("custom_packs_guild_slug_idx").on(t.guildId, t.slug),
}));

export type CustomPack = typeof customPacksTable.$inferSelect;

// Explicit card whitelist for custom packs. If a pack has any rows here, it
// draws from this exact card set (still respecting droppable/inPacks/active).
// Empty = fall back to the cardTypes filter.
export const customPackCardsTable = pgTable("custom_pack_cards", {
  id: serial("id").primaryKey(),
  packId: integer("pack_id").notNull().references(() => customPacksTable.id, { onDelete: "cascade" }),
  cardId: integer("card_id").notNull().references(() => cardsTable.id, { onDelete: "cascade" }),
  addedAt: timestamp("added_at").notNull().defaultNow(),
}, (t) => ({
  uniqPackCard: uniqueIndex("custom_pack_cards_pack_card_idx").on(t.packId, t.cardId),
}));

export type CustomPackCard = typeof customPackCardsTable.$inferSelect;

// Per-(guild, user, pack) weekly usage counter for custom packs.
// Separate from user_currency's built-in pack counters so custom packs
// don't interfere with the basic/premium/legendary weekly limits.
export const userCustomPackWeekTable = pgTable("user_custom_pack_week", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  packId: integer("pack_id").notNull().references(() => customPacksTable.id, { onDelete: "cascade" }),
  weekOpens: integer("week_opens").notNull().default(0),
  weekResetAt: timestamp("week_reset_at").notNull().defaultNow(),
}, (t) => ({
  guildUserPackUniq: uniqueIndex("user_custom_pack_week_idx").on(t.guildId, t.userId, t.packId),
}));

export type UserCustomPackWeek = typeof userCustomPackWeekTable.$inferSelect;

// ── Card Display Overrides (website presentation only) ───────────────────────
// One row per card. The website (and ONLY the website) reads these to override
// the card's roster/news/events display — without touching the `cards` row
// that Discord uses as its source of truth. Any null column means "fall back
// to the card's own value". `hidden_from_site` removes the card from public
// website lists; `featured` + `sort_weight` control website ordering.
//
// Discord never reads this table. Admins editing here are guaranteed to NOT
// change any gameplay value (rarity, worth, burn, dropWeight, etc.) — those
// are not present here on purpose.
//
// Single global table (no guild_id): the website is one public showcase of
// the shared card pool, not per-server.
export const cardDisplayOverridesTable = pgTable("card_display_overrides", {
  cardId: integer("card_id")
    .primaryKey()
    .references(() => cardsTable.id, { onDelete: "cascade" }),
  displayName: text("display_name"),
  displayImageUrl: text("display_image_url"),
  displayDescription: text("display_description"),
  // Website-only grouping/category label. Does not affect Discord gameplay rarity.
  displayCategory: text("display_category"),
  flavorText: text("flavor_text"),
  hiddenFromSite: boolean("hidden_from_site").notNull().default(false),
  featured: boolean("featured").notNull().default(false),
  sortWeight: integer("sort_weight").notNull().default(0),
  updatedBy: integer("updated_by"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const upsertCardDisplayOverrideSchema = createInsertSchema(cardDisplayOverridesTable).omit({
  cardId: true,
  updatedAt: true,
  updatedBy: true,
}).partial();
export type UpsertCardDisplayOverride = z.infer<typeof upsertCardDisplayOverrideSchema>;
export type CardDisplayOverride = typeof cardDisplayOverridesTable.$inferSelect;

// ── Rarity Display Overrides (per-guild cosmetic renaming of built-in tiers) ──
// Lets admins rename any built-in rarity tier for their server — changing the
// display name, emoji, and/or embed color without touching the underlying
// gameplay enum or economy values. One row per (guildId, rarity).
// The bot reads this table to resolve display strings for spawns, collection
// pages, pack openings, etc. The game economy (worth/burn/dropWeight) is
// completely unaffected. Discord only; the website never reads this table.
export const rarityDisplayOverridesTable = pgTable("rarity_display_overrides", {
  guildId: text("guild_id").notNull(),
  rarity: rarityEnum("rarity").notNull(),
  displayName: text("display_name"),
  emoji: text("emoji"),
  color: integer("color"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  updatedBy: text("updated_by"),
}, (t) => ({
  pk: uniqueIndex("rarity_display_overrides_pk").on(t.guildId, t.rarity),
}));

export type RarityDisplayOverride = typeof rarityDisplayOverridesTable.$inferSelect;

// ── User Reputation ──────────────────────────────────────────────────────────
// A 24-hour cooldown per (giver→receiver) pair prevents spam. Negative rep
// is not supported — only positive rep gifts.
export const userReputationTable = pgTable("user_reputation", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  rep: integer("rep").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  uniqGuildUser: uniqueIndex("user_reputation_guild_user_uniq").on(t.guildId, t.userId),
}));

export type UserReputation = typeof userReputationTable.$inferSelect;

// ── Rep Log (cooldown tracking + audit trail) ────────────────────────────────
// One row per rep gift. The (guildId, giverId, receiverId) triple plus
// `givenAt` is used to enforce the 24-hour cooldown between the same pair.
export const repLogTable = pgTable("rep_log", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  giverId: text("giver_id").notNull(),
  receiverId: text("receiver_id").notNull(),
  givenAt: timestamp("given_at").notNull().defaultNow(),
}, (t) => ({
  cooldownIdx: index("rep_log_cooldown_idx").on(t.guildId, t.giverId, t.receiverId, t.givenAt),
}));

export type RepLog = typeof repLogTable.$inferSelect;

// ── Persistent DN Trade Calculator messages ───────────────────────────────────
// Admins post a permanent calculator hub in a channel with /postcalculator.
// The hub survives bot restarts; button interactions are routed by message ID.
export const calculatorMessagesTable = pgTable("calculator_messages", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  messageId: text("message_id").notNull(),
  resultChannelId: text("result_channel_id"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  uniqMsg: uniqueIndex("calculator_messages_msg_idx").on(t.guildId, t.channelId, t.messageId),
}));

export type CalculatorMessage = typeof calculatorMessagesTable.$inferSelect;
