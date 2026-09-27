import app from "./app";
import { logger } from "./lib/logger";
import { attachDuelSocket } from "./lib/duel-net";
import { startBot } from "./bot/index";
import { pool } from "@workspace/db";
import { SEED_SQL } from "./lib/seedData.js";

// Idempotent runtime migrations. Drizzle `db push` only runs against dev;
// production gets schema changes applied here on boot. Each statement uses
// `IF NOT EXISTS` so reruns are safe.
async function runBootMigrations() {
  const homeGuildId = process.env["HOME_GUILD_ID"];
  if (!homeGuildId) {
    throw new Error("HOME_GUILD_ID is required to run boot migrations. Set it to the home Discord server ID.");
  }

  // Per-guild rarity display order. Stored as text[] so any array of rarity keys can be persisted.
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS rarity_order text[]`);

  // Per-guild display names for built-in pack tiers. Null/empty = defaults.
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS pack_basic_name text`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS pack_premium_name text`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS pack_legendary_name text`);


  // Per-guild ownership of cards and sets. Backfill existing rows to the home
  // guild so the live main-server roster remains shared. Names are unique per
  // guild, not globally, so separate servers can each have their own "M1 Abrams".
  await pool.query(`ALTER TABLE cards ADD COLUMN IF NOT EXISTS guild_id text`);
  await pool.query(`UPDATE cards SET guild_id = $1 WHERE guild_id IS NULL`, [homeGuildId]);
  await pool.query(`ALTER TABLE cards ALTER COLUMN guild_id SET NOT NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS cards_guild_name_uniq ON cards (guild_id, name)`);
  await pool.query(`ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_name_unique`);

  await pool.query(`ALTER TABLE sets ADD COLUMN IF NOT EXISTS guild_id text`);
  await pool.query(`UPDATE sets SET guild_id = $1 WHERE guild_id IS NULL`, [homeGuildId]);
  await pool.query(`ALTER TABLE sets ALTER COLUMN guild_id SET NOT NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS sets_guild_name_uniq ON sets (guild_id, name)`);
  await pool.query(`ALTER TABLE sets DROP CONSTRAINT IF EXISTS sets_name_unique`);

  await pool.query(`ALTER TABLE cards ADD COLUMN IF NOT EXISTS podium_place integer`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS cards_podium_place_uniq ON cards (podium_place) WHERE podium_place IS NOT NULL`);
  await pool.query(`ALTER TABLE cards ADD COLUMN IF NOT EXISTS preview_animation text`);
  await pool.query(`ALTER TABLE cards ADD COLUMN IF NOT EXISTS preview_bg_color text`);
  await pool.query(`ALTER TABLE cards ADD COLUMN IF NOT EXISTS display_orientation text`);
  // Animated-GIF card flag (see cards.isAnimated). Backfill existing rows whose
  // image URL clearly ends in .gif so current GIF cards animate without a re-save.
  await pool.query(`ALTER TABLE cards ADD COLUMN IF NOT EXISTS is_animated boolean NOT NULL DEFAULT false`);
  await pool.query(`UPDATE cards SET is_animated = true WHERE is_animated = false AND image_url ~* '\\.gif(\\?|#|$)'`);
  // Card entrance animation + Shiny Hub settings (see guildSettings schema).
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS spawn_entrance_animation text NOT NULL DEFAULT 'off'`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS spawn_entrance_skin text NOT NULL DEFAULT 'rarity'`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS shiny_animation_style text NOT NULL DEFAULT 'classic'`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS shiny_value_multiplier real NOT NULL DEFAULT 2`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS shiny_name text`);
  // Card Frames (see guildSettings schema). Off by default; per-rarity frame colour.
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS card_frames_enabled boolean NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS card_frame_common text`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS card_frame_uncommon text`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS card_frame_rare text`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS card_frame_epic text`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS card_frame_legendary text`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS card_frame_mythic text`);
  await pool.query(`ALTER TABLE card_display_overrides ADD COLUMN IF NOT EXISTS display_category text`);

  // Uploadable trophy/showcase backgrounds for /user-hub "Show Card".
  // Up to 3 slots per guild; the renderer picks one at random.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS showcase_backgrounds (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      slot INTEGER NOT NULL,
      url TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_by TEXT,
      UNIQUE (guild_id, slot)
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS showcase_backgrounds_guild_slot_idx ON showcase_backgrounds (guild_id, slot)`);

  // Battle arena backgrounds — up to 3 slots per guild; the VS renderer shuffles.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS battle_backgrounds (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      slot INTEGER NOT NULL,
      url TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_by TEXT,
      UNIQUE (guild_id, slot)
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS battle_backgrounds_guild_slot_idx ON battle_backgrounds (guild_id, slot)`);

  // Battle Content — per-guild custom items/moves/passives overlaid on defaults.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS battle_content (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      content_id TEXT NOT NULL,
      data JSONB NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_by TEXT,
      UNIQUE (guild_id, kind, content_id)
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS battle_content_guild_kind_id_idx ON battle_content (guild_id, kind, content_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS battle_content_guild_kind_idx ON battle_content (guild_id, kind)`);

  // Per-card passive ability assignment (auto-triggering in battle).
  await pool.query(`ALTER TABLE battle_card_config ADD COLUMN IF NOT EXISTS passive text`);

  // Raid overhaul: optional per-boss battlefield/arena image for the raid canvas.
  await pool.query(`ALTER TABLE raid_bosses ADD COLUMN IF NOT EXISTS battlefield_url text`);

  // Raid endgame: boss→card link (boss-card reward + art), exclusive reward
  // frame, and a progression sequence. Plus the account-wide raid frame unlocks
  // table. All additive/backwards-compatible.
  await pool.query(`ALTER TABLE raid_bosses ADD COLUMN IF NOT EXISTS card_id integer`);
  await pool.query(`ALTER TABLE raid_bosses ADD COLUMN IF NOT EXISTS reward_frame_id text`);
  await pool.query(`ALTER TABLE raid_bosses ADD COLUMN IF NOT EXISTS sequence integer NOT NULL DEFAULT 0`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS raid_frame_unlocks (
      id serial PRIMARY KEY,
      guild_id text NOT NULL,
      user_id text NOT NULL,
      frame_id text NOT NULL,
      boss_id integer,
      unlocked_at timestamp NOT NULL DEFAULT now()
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS raid_frame_unlocks_guild_user_frame_uniq ON raid_frame_unlocks (guild_id, user_id, frame_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS raid_frame_unlocks_user_idx ON raid_frame_unlocks (guild_id, user_id)`);

  // Boss cards: a raid boss now auto-creates its own card so it can be handed
  // out as a reward. Untradeable unless an admin opts the server in.
  await pool.query(`ALTER TABLE cards ADD COLUMN IF NOT EXISTS is_boss_card boolean NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS allow_boss_card_trades boolean NOT NULL DEFAULT false`);

  // Unified account-level progression (Player XP). Purely additive — existing
  // ── Recycle / Card Progression Hub config ───────────────────────────────────
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS recycle_enabled boolean NOT NULL DEFAULT true`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS recycle_scrap_multiplier integer NOT NULL DEFAULT 100`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS recycle_xp_multiplier integer NOT NULL DEFAULT 100`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS recycle_scrap_common integer`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS recycle_scrap_uncommon integer`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS recycle_scrap_rare integer`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS recycle_scrap_epic integer`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS recycle_scrap_legendary integer`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS recycle_scrap_mythic integer`);
  // ── Card Fusion cost config (duplicates + Scrap → +1 Star) ──────────────────
  // Self-healing so guild_settings SELECT * (getOrCreateGuildSettings) never hits
  // a missing column even if a migration tool proposes dropping them.
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS fuse_cost_multiplier integer NOT NULL DEFAULT 100`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS fuse_dupes_common integer`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS fuse_dupes_uncommon integer`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS fuse_dupes_rare integer`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS fuse_dupes_epic integer`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS fuse_dupes_legendary integer`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS fuse_dupes_mythic integer`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS fuse_scrap_common integer`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS fuse_scrap_uncommon integer`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS fuse_scrap_rare integer`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS fuse_scrap_epic integer`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS fuse_scrap_legendary integer`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS fuse_scrap_mythic integer`);
  // Fusion Hub v2 knobs (copies→star, xp-overflow→scrap). Self-healing.
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS fuse_copies_per_star integer NOT NULL DEFAULT 5`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS xp_overflow_scrap_rate integer NOT NULL DEFAULT 100`);

  // progression tables (card_progress, battle_profiles, user_currency, quests,
  // reputation, …) are untouched; this only stores the new account-wide level
  // that every activity feeds via the PlayerProfile service.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_progression (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      xp INTEGER NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 1,
      xp_by_source JSONB NOT NULL DEFAULT '{}'::jsonb,
      collection_milestone INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (guild_id, user_id)
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS player_progression_guild_user_uniq ON player_progression (guild_id, user_id)`);

  // One-time interactive onboarding adventure — permanent per-player record so
  // the exclusive rewards/achievement can never be claimed twice. Additive.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS onboarding_progress (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_progress',
      chapter INTEGER NOT NULL DEFAULT 0,
      rewards_claimed BOOLEAN NOT NULL DEFAULT false,
      started_at TIMESTAMP NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMP,
      UNIQUE (guild_id, user_id)
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS onboarding_guild_user_uniq ON onboarding_progress (guild_id, user_id)`);

  // Star Rank (Card Recycle) — additive single property on the owned-card row.
  // Recycle consumes duplicate copies from the existing collection to raise it;
  // collections counting is unchanged. Existing cards default to 0.
  await pool.query(`ALTER TABLE card_progress ADD COLUMN IF NOT EXISTS star_rank integer NOT NULL DEFAULT 0`);
  // Scrap — second currency earned by the new ♻️ Recycle action (2026-07).
  // Separate from Shards; no spend path yet. Fully additive / backwards-compatible.
  await pool.query(`ALTER TABLE user_currency ADD COLUMN IF NOT EXISTS scrap INTEGER NOT NULL DEFAULT 0`);
  // Animation system configuration toggles (default ON, normal speed).
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS pack_animation_enabled boolean NOT NULL DEFAULT true`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS battle_animation_enabled boolean NOT NULL DEFAULT true`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS pack_animation_speed text NOT NULL DEFAULT 'normal'`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS battle_animation_speed text NOT NULL DEFAULT 'normal'`);

  // Battle animation toggles live in battle_settings (per-guild battle config).
  await pool.query(`ALTER TABLE battle_settings ADD COLUMN IF NOT EXISTS battle_animation_enabled boolean NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE battle_settings ADD COLUMN IF NOT EXISTS pack_animation_enabled boolean NOT NULL DEFAULT true`);
  await pool.query(`ALTER TABLE battle_settings ADD COLUMN IF NOT EXISTS battle_animation_speed text NOT NULL DEFAULT 'normal'`);
  await pool.query(`ALTER TABLE battle_settings ADD COLUMN IF NOT EXISTS battle_scene_animated boolean NOT NULL DEFAULT true`);
  // Raid stats on battle_profiles (feed the /top Raid leaderboard). Self-healing.
  await pool.query(`ALTER TABLE battle_profiles ADD COLUMN IF NOT EXISTS raids_won integer NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE battle_profiles ADD COLUMN IF NOT EXISTS raids_lost integer NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE battle_profiles ADD COLUMN IF NOT EXISTS solo_raids_won integer NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE battle_profiles ADD COLUMN IF NOT EXISTS raids_survived integer NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE battle_profiles ADD COLUMN IF NOT EXISTS raid_damage_dealt integer NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE battle_profiles ADD COLUMN IF NOT EXISTS raid_damage_taken integer NOT NULL DEFAULT 0`);

  // Convert card_type from enum → text so admins can use any free-form label.
  // Idempotent: only runs while the column still has the enum type.
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'cards' AND column_name = 'card_type'
          AND data_type = 'USER-DEFINED'
      ) THEN
        ALTER TABLE cards ALTER COLUMN card_type TYPE text USING card_type::text;
        ALTER TABLE cards ALTER COLUMN card_type SET DEFAULT 'vehicle';
      END IF;
    END $$;
  `);

  // One-time data fix: when the dashboard moved from /dashboard/ to / (May 2026),
  // seed event card images stored as "https://<host>/dashboard/<file>" stopped
  // resolving. Convert any such absolute URL to a relative "/<file>" so they
  // load from whichever domain the user is on. Idempotent — only matches rows
  // that still have the old prefix.
  await pool.query(`
    UPDATE cards
       SET image_url = regexp_replace(image_url, '^https?://[^/]+/dashboard/', '/')
     WHERE image_url ~ '^https?://[^/]+/dashboard/'
  `);

  // Legacy rarity assignment cleanup: early Setup Hub builds could persist a
  // built-in rarity name in card_rarity_overrides.custom_rarity_slug. That row
  // does not join to custom_rarities, so resolvers fell back to cards.rarity
  // (often "common"). Promote those orphan built-in assignments into cards.rarity
  // and remove only the orphan rows. Real custom tiers with the same slug are
  // preserved by the NOT EXISTS guard.
  await pool.query(`
    WITH legacy_builtin AS (
      SELECT o.guild_id, o.card_id, o.custom_rarity_slug
      FROM card_rarity_overrides o
      WHERE o.custom_rarity_slug IN ('common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic')
        AND NOT EXISTS (
          SELECT 1
          FROM custom_rarities c
          WHERE c.guild_id = o.guild_id
            AND c.slug = o.custom_rarity_slug
        )
    )
    UPDATE cards
       SET rarity = legacy_builtin.custom_rarity_slug::rarity
      FROM legacy_builtin
     WHERE cards.id = legacy_builtin.card_id
       AND cards.rarity::text <> legacy_builtin.custom_rarity_slug
  `);
  await pool.query(`
    DELETE FROM card_rarity_overrides o
    WHERE o.custom_rarity_slug IN ('common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic')
      AND NOT EXISTS (
        SELECT 1
        FROM custom_rarities c
        WHERE c.guild_id = o.guild_id
          AND c.slug = o.custom_rarity_slug
      )
  `);

  // One-time backfill: if no card currently holds a podium slot, seed it from
  // the old name-based heuristic (1st/2nd/3rd in the name of an event card).
  // Idempotent — once any card has podium_place set, the inner NOT EXISTS
  // guard makes this a no-op so admin picks are never overwritten. DISTINCT ON
  // picks a single winner per slot deterministically (lowest id).
  const { rows: existing } = await pool.query(`SELECT 1 FROM cards WHERE podium_place IS NOT NULL LIMIT 1`);
  if (existing.length === 0) {
    await pool.query(`
      UPDATE cards
      SET podium_place = sub.place
      FROM (
        SELECT DISTINCT ON (place) id, place FROM (
          SELECT id,
            CASE
              WHEN name ~* '\\m1st\\M' THEN 1
              WHEN name ~* '\\m2nd\\M' THEN 2
              WHEN name ~* '\\m3rd\\M' THEN 3
            END AS place
          FROM cards
          WHERE is_event_exclusive = true AND is_archived = false
        ) ranked
        WHERE place IS NOT NULL
        ORDER BY place, id
      ) sub
      WHERE cards.id = sub.id
    `);
    logger.info("Podium backfill applied from card-name heuristic");
  }

  // `user_currency` has no unique index on (guild_id, user_id) in the Drizzle
  // schema, but both the production seed below and the corrective data
  // migration further down upsert into it with `ON CONFLICT(guild_id,user_id)`.
  // Postgres rejects that without a matching index, so on a FRESH database the
  // seed threw and aborted the whole boot-migration run — meaning every table
  // created after it (including hq_settings) never appeared. Create the index
  // before anything relies on it.
  await pool.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS user_currency_guild_user_uniq ON user_currency(guild_id, user_id)",
  );

  // One-time production data seed — runs only when cards table is empty.
  // Executed inside a single transaction: the cards_name_unique constraint is
  // dropped then re-added atomically, so a mid-run failure rolls back completely.
  const { rows: cardCheck } = await pool.query(`SELECT 1 FROM cards LIMIT 1`);
  if (cardCheck.length === 0) {
    logger.info("Cards table empty — running production data seed");
    const seedClient = await pool.connect();
    try {
      await seedClient.query("BEGIN");
      for (const stmt of SEED_SQL) {
        await seedClient.query(stmt);
      }
      await seedClient.query("COMMIT");
      logger.info({ count: SEED_SQL.length }, "Production seed complete");
    } catch (err) {
      await seedClient.query("ROLLBACK");
      throw err;
    } finally {
      seedClient.release();
    }
  }






  // Corrective data migration: fix card names (315-329), add card 329, gold_legendary rarity,
  // rarity overrides, user_currency, achievements, daily_claims.
  // Wrapped in a single transaction so a mid-run failure rolls back completely.
  await (async () => {
    // Ensure user_currency has a unique index on (guild_id, user_id) so ON CONFLICT works.
    await pool.query(
      "CREATE UNIQUE INDEX IF NOT EXISTS user_currency_guild_user_uniq ON user_currency(guild_id, user_id);"
    );
    const client = await (await import("@workspace/db")).pool.connect();
    try {
      await client.query("BEGIN");
      // NOTE: Hardcoded rarity display overrides were removed from the boot migration.
      // Rarity labels are now fully controlled by admins via `/rarity edit` in Discord.
      // Forcing them here on every restart overwrote any server-specific custom labels.
      await client.query("ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_name_unique;");
      // NOTE: Hardcoded card INSERT statements were removed from this boot migration.
      // Cards are managed through Discord commands (addcard, editcard, deletecard).
      // Re-inserting them on every startup made deleted cards (especially event cards)
      // reappear after every deployment. Admins can recreate cards manually if needed.
      const _dataMigrations: string[] = [
        "INSERT INTO user_currency(guild_id,user_id,shards,total_earned,packs_opened,cards_burned,updated_at) VALUES('1363917781355069761','1037737554641961030',1675,8825,5,4,'2026-07-03 06:22:01.233928') ON CONFLICT(guild_id,user_id) DO UPDATE SET shards=GREATEST(user_currency.shards,EXCLUDED.shards),total_earned=GREATEST(user_currency.total_earned,EXCLUDED.total_earned);",

        "INSERT INTO user_currency(guild_id,user_id,shards,total_earned,packs_opened,cards_burned,updated_at) VALUES('1363917781355069761','1043524302584168522',100,100,0,0,'2026-07-03 06:22:01.233928') ON CONFLICT(guild_id,user_id) DO UPDATE SET shards=GREATEST(user_currency.shards,EXCLUDED.shards),total_earned=GREATEST(user_currency.total_earned,EXCLUDED.total_earned);",
        "INSERT INTO user_currency(guild_id,user_id,shards,total_earned,packs_opened,cards_burned,updated_at) VALUES('1363917781355069761','1126547994049777736',120,2120,1,17,'2026-07-03 06:22:01.233928') ON CONFLICT(guild_id,user_id) DO UPDATE SET shards=GREATEST(user_currency.shards,EXCLUDED.shards),total_earned=GREATEST(user_currency.total_earned,EXCLUDED.total_earned);",
        "INSERT INTO user_currency(guild_id,user_id,shards,total_earned,packs_opened,cards_burned,updated_at) VALUES('1363917781355069761','1134860240630853713',150,150,0,0,'2026-07-03 06:22:01.233928') ON CONFLICT(guild_id,user_id) DO UPDATE SET shards=GREATEST(user_currency.shards,EXCLUDED.shards),total_earned=GREATEST(user_currency.total_earned,EXCLUDED.total_earned);",
        "INSERT INTO user_currency(guild_id,user_id,shards,total_earned,packs_opened,cards_burned,updated_at) VALUES('1363917781355069761','1148615683698085959',60,60,0,1,'2026-07-03 06:22:01.233928') ON CONFLICT(guild_id,user_id) DO UPDATE SET shards=GREATEST(user_currency.shards,EXCLUDED.shards),total_earned=GREATEST(user_currency.total_earned,EXCLUDED.total_earned);",
        "INSERT INTO user_currency(guild_id,user_id,shards,total_earned,packs_opened,cards_burned,updated_at) VALUES('1363917781355069761','1211353501909786749',2690,2940,1,10,'2026-07-03 06:22:01.233928') ON CONFLICT(guild_id,user_id) DO UPDATE SET shards=GREATEST(user_currency.shards,EXCLUDED.shards),total_earned=GREATEST(user_currency.total_earned,EXCLUDED.total_earned);",
        "INSERT INTO user_currency(guild_id,user_id,shards,total_earned,packs_opened,cards_burned,updated_at) VALUES('1363917781355069761','1300126290917068912',100,100,0,0,'2026-07-03 06:22:01.233928') ON CONFLICT(guild_id,user_id) DO UPDATE SET shards=GREATEST(user_currency.shards,EXCLUDED.shards),total_earned=GREATEST(user_currency.total_earned,EXCLUDED.total_earned);",
        "INSERT INTO user_currency(guild_id,user_id,shards,total_earned,packs_opened,cards_burned,updated_at) VALUES('1363917781355069761','1307321587783172148',50,50,0,0,'2026-07-03 06:22:01.233928') ON CONFLICT(guild_id,user_id) DO UPDATE SET shards=GREATEST(user_currency.shards,EXCLUDED.shards),total_earned=GREATEST(user_currency.total_earned,EXCLUDED.total_earned);",
        "INSERT INTO user_currency(guild_id,user_id,shards,total_earned,packs_opened,cards_burned,updated_at) VALUES('1363917781355069761','1373692782153175202',800,800,0,0,'2026-07-03 06:22:01.233928') ON CONFLICT(guild_id,user_id) DO UPDATE SET shards=GREATEST(user_currency.shards,EXCLUDED.shards),total_earned=GREATEST(user_currency.total_earned,EXCLUDED.total_earned);",
        "INSERT INTO user_currency(guild_id,user_id,shards,total_earned,packs_opened,cards_burned,updated_at) VALUES('1363917781355069761','1391671057168990238',50,50,0,0,'2026-07-03 06:22:01.233928') ON CONFLICT(guild_id,user_id) DO UPDATE SET shards=GREATEST(user_currency.shards,EXCLUDED.shards),total_earned=GREATEST(user_currency.total_earned,EXCLUDED.total_earned);",
        "INSERT INTO user_currency(guild_id,user_id,shards,total_earned,packs_opened,cards_burned,updated_at) VALUES('1363917781355069761','1414997389160349706',50,50,0,0,'2026-07-03 06:22:01.233928') ON CONFLICT(guild_id,user_id) DO UPDATE SET shards=GREATEST(user_currency.shards,EXCLUDED.shards),total_earned=GREATEST(user_currency.total_earned,EXCLUDED.total_earned);",
        "INSERT INTO user_currency(guild_id,user_id,shards,total_earned,packs_opened,cards_burned,updated_at) VALUES('1363917781355069761','1438760510832250903',850,850,0,0,'2026-07-03 06:22:01.233928') ON CONFLICT(guild_id,user_id) DO UPDATE SET shards=GREATEST(user_currency.shards,EXCLUDED.shards),total_earned=GREATEST(user_currency.total_earned,EXCLUDED.total_earned);",
        "INSERT INTO user_currency(guild_id,user_id,shards,total_earned,packs_opened,cards_burned,updated_at) VALUES('1363917781355069761','557897922667085836',850,850,0,0,'2026-07-03 06:22:01.233928') ON CONFLICT(guild_id,user_id) DO UPDATE SET shards=GREATEST(user_currency.shards,EXCLUDED.shards),total_earned=GREATEST(user_currency.total_earned,EXCLUDED.total_earned);",
        "INSERT INTO user_currency(guild_id,user_id,shards,total_earned,packs_opened,cards_burned,updated_at) VALUES('1363917781355069761','689063086044348508',200,200,0,0,'2026-07-03 06:22:01.233928') ON CONFLICT(guild_id,user_id) DO UPDATE SET shards=GREATEST(user_currency.shards,EXCLUDED.shards),total_earned=GREATEST(user_currency.total_earned,EXCLUDED.total_earned);",
        "INSERT INTO user_currency(guild_id,user_id,shards,total_earned,packs_opened,cards_burned,updated_at) VALUES('1363917781355069761','718255146278322206',1490,12740,8,42,'2026-07-03 06:22:01.233928') ON CONFLICT(guild_id,user_id) DO UPDATE SET shards=GREATEST(user_currency.shards,EXCLUDED.shards),total_earned=GREATEST(user_currency.total_earned,EXCLUDED.total_earned);",
        "INSERT INTO user_currency(guild_id,user_id,shards,total_earned,packs_opened,cards_burned,updated_at) VALUES('1363917781355069761','767249025438318642',210,2460,2,2,'2026-07-03 06:22:01.233928') ON CONFLICT(guild_id,user_id) DO UPDATE SET shards=GREATEST(user_currency.shards,EXCLUDED.shards),total_earned=GREATEST(user_currency.total_earned,EXCLUDED.total_earned);",
        "INSERT INTO user_currency(guild_id,user_id,shards,total_earned,packs_opened,cards_burned,updated_at) VALUES('1480402385821110292','1211353501909786749',80,3330,6,10,'2026-05-25 03:11:38.686') ON CONFLICT(guild_id,user_id) DO UPDATE SET shards=GREATEST(user_currency.shards,EXCLUDED.shards),total_earned=GREATEST(user_currency.total_earned,EXCLUDED.total_earned);",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','1037737554641961030','first_catch','2026-05-26 10:14:32.182112') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','1037737554641961030','legendary_hunter','2026-05-26 10:24:38.695472') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','1037737554641961030','rookie','2026-05-26 10:30:27.548509') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','1043524302584168522','first_catch','2026-05-26 09:46:08.420259') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','1126547994049777736','first_catch','2026-05-26 01:13:35.206908') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','1126547994049777736','legendary_hunter','2026-05-26 01:13:35.21386') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','1126547994049777736','rookie','2026-05-26 01:14:23.730888') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','1134860240630853713','first_catch','2026-05-26 01:54:27.227163') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','1134860240630853713','rookie','2026-05-26 01:58:37.664986') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','1148615683698085959','first_catch','2026-05-26 02:52:14.856605') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','1211353501909786749','first_catch','2026-05-25 22:40:01.538006') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','1211353501909786749','legendary_hunter','2026-05-26 09:18:05.997649') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','1211353501909786749','rookie','2026-05-26 09:17:56.813753') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','1300126290917068912','first_catch','2026-05-26 05:19:11.367367') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','1307321587783172148','first_catch','2026-05-26 04:51:34.098685') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','1373692782153175202','first_catch','2026-05-26 06:30:49.245958') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','1373692782153175202','legendary_hunter','2026-05-26 06:30:49.25782') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','1391671057168990238','first_catch','2026-05-26 05:47:00.686802') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','1414997389160349706','first_catch','2026-05-26 12:09:11.735609') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','1438760510832250903','first_catch','2026-05-26 04:51:01.958078') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','1438760510832250903','legendary_hunter','2026-05-26 04:51:01.969963') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','557897922667085836','first_catch','2026-05-26 01:16:19.857573') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','557897922667085836','legendary_hunter','2026-05-26 01:16:40.865239') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','689063086044348508','first_catch','2026-05-26 02:28:28.549884') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','689063086044348508','rookie','2026-05-26 02:39:30.247406') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','718255146278322206','first_catch','2026-05-26 01:15:47.202822') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','718255146278322206','legendary_hunter','2026-05-26 01:23:39.620133') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','718255146278322206','rookie','2026-05-26 01:34:12.417364') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','767249025438318642','first_catch','2026-05-26 05:09:19.181053') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','767249025438318642','legendary_hunter','2026-05-26 05:14:30.932196') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1363917781355069761','767249025438318642','rookie','2026-05-26 05:15:12.390521') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1480402385821110292','1211353501909786749','first_catch','2026-05-24 03:34:38.840587') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO achievements_unlocked(guild_id,user_id,achievement_key,unlocked_at) VALUES('1480402385821110292','1211353501909786749','rookie','2026-05-24 06:23:31.124502') ON CONFLICT(guild_id,user_id,achievement_key) DO NOTHING;",
        "INSERT INTO daily_claims(guild_id,user_id,last_claimed_at,streak) VALUES('1363917781355069761','1043524302584168522','2026-05-26 09:55:04.279',1) ON CONFLICT(guild_id,user_id) DO NOTHING;",
        "INSERT INTO daily_claims(guild_id,user_id,last_claimed_at,streak) VALUES('1363917781355069761','1300126290917068912','2026-05-26 06:31:56.949',1) ON CONFLICT(guild_id,user_id) DO NOTHING;",
        "INSERT INTO daily_claims(guild_id,user_id,last_claimed_at,streak) VALUES('1363917781355069761','1438760510832250903','2026-05-26 04:59:45.8',1) ON CONFLICT(guild_id,user_id) DO NOTHING;",
        "INSERT INTO daily_claims(guild_id,user_id,last_claimed_at,streak) VALUES('1363917781355069761','557897922667085836','2026-05-26 01:08:09.521',1) ON CONFLICT(guild_id,user_id) DO NOTHING;",
        "INSERT INTO daily_claims(guild_id,user_id,last_claimed_at,streak) VALUES('1363917781355069761','689063086044348508','2026-05-26 02:39:23.83',1) ON CONFLICT(guild_id,user_id) DO NOTHING;",
        "INSERT INTO daily_claims(guild_id,user_id,last_claimed_at,streak) VALUES('1363917781355069761','718255146278322206','2026-05-26 01:06:52.097',1) ON CONFLICT(guild_id,user_id) DO NOTHING;",
        "INSERT INTO daily_claims(guild_id,user_id,last_claimed_at,streak) VALUES('1363917781355069761','767249025438318642','2026-05-26 05:07:40.283',1) ON CONFLICT(guild_id,user_id) DO NOTHING;",
        "INSERT INTO daily_claims(guild_id,user_id,last_claimed_at,streak) VALUES('1480402385821110292','1211353501909786749','2026-05-24 03:36:06.426',1) ON CONFLICT(guild_id,user_id) DO NOTHING;",
      ];
      for (const _stmt of _dataMigrations) { await client.query(_stmt); }
      // Per-guild uniqueness is enforced by cards_guild_name_uniq above; the old
      // global cards_name_unique constraint is no longer compatible with multi-tenant
      // cards and must stay dropped.
      await client.query("COMMIT");
      logger.info("Data correction migration applied");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;  // propagate so boot migration failure is logged
    } finally {
      client.release();
    }
  })();

  // One-time: retire the gold_legendary custom tier on production.
  // Cards that had that custom override revert to their base legendary rarity
  // (display label is now "Legendary"; guild nicknames still override).
  // All other legendary cards — event/achievement cards — move to epic.
  // Guarded on the custom tier still existing so reruns are no-ops.
  {
    const { rows: goldTierRows } = await pool.query(
      `SELECT 1 FROM custom_rarities WHERE slug = 'gold_legendary' LIMIT 1`
    );
    if (goldTierRows.length > 0) {
      // Promote non-overridden legendary cards → epic (Exotic display)
      await pool.query(`
        UPDATE cards SET rarity = 'epic'
        WHERE rarity = 'legendary'
          AND id NOT IN (
            SELECT card_id FROM card_rarity_overrides WHERE custom_rarity_slug = 'gold_legendary'
          )
      `);
      // Remove overrides so the 6 Gold Legendary cards revert to built-in legendary
      await pool.query(`DELETE FROM card_rarity_overrides WHERE custom_rarity_slug = 'gold_legendary'`);
      // Remove the custom tier itself
      await pool.query(`DELETE FROM custom_rarities WHERE slug = 'gold_legendary'`);
      logger.info("gold_legendary custom tier retired");
    }
  }

  // Custom packs (type-filtered per-guild pack tiers created via /config).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS custom_packs (
      id           SERIAL PRIMARY KEY,
      guild_id     TEXT NOT NULL,
      slug         TEXT NOT NULL,
      name         TEXT NOT NULL,
      cost         INTEGER NOT NULL DEFAULT 500,
      size         INTEGER NOT NULL DEFAULT 5,
      weekly_limit INTEGER NOT NULL DEFAULT 10,
      rarity_rates JSONB NOT NULL DEFAULT '{"common":0.6,"uncommon":0.25,"rare":0.11,"epic":0.035,"legendary":0.005,"mythic":0}',
      card_types   TEXT[] NOT NULL DEFAULT '{}',
      is_active    BOOLEAN NOT NULL DEFAULT TRUE,
      created_at   TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS custom_packs_guild_slug_idx ON custom_packs(guild_id, slug)`
  );
  await pool.query(`ALTER TABLE custom_packs ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE custom_packs ADD COLUMN IF NOT EXISTS emoji text`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS pack_basic_desc TEXT`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS pack_premium_desc TEXT`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS pack_legendary_desc TEXT`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS custom_pack_cards (
      id serial PRIMARY KEY,
      pack_id integer NOT NULL REFERENCES custom_packs(id) ON DELETE CASCADE,
      card_id integer NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      added_at timestamp NOT NULL DEFAULT NOW(),
      CONSTRAINT custom_pack_cards_pack_card_uniq UNIQUE (pack_id, card_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS custom_pack_cards_pack_idx ON custom_pack_cards(pack_id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_custom_pack_week (
      id            SERIAL PRIMARY KEY,
      guild_id      TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      pack_id       INTEGER NOT NULL REFERENCES custom_packs(id) ON DELETE CASCADE,
      week_opens    INTEGER NOT NULL DEFAULT 0,
      week_reset_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS user_custom_pack_week_idx ON user_custom_pack_week(guild_id, user_id, pack_id)`
  );

  // Persistent DN Trade Calculator hub messages (posted by /postcalculator).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calculator_messages (
      id                SERIAL PRIMARY KEY,
      guild_id          TEXT NOT NULL,
      channel_id        TEXT NOT NULL,
      message_id        TEXT NOT NULL,
      result_channel_id TEXT,
      created_by        TEXT NOT NULL,
      created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT calculator_messages_msg_uniq UNIQUE (guild_id, channel_id, message_id)
    )
  `);
  // Backfill existing calculator_messages rows that predate the result channel column.
  await pool.query(`
    ALTER TABLE calculator_messages
    ADD COLUMN IF NOT EXISTS result_channel_id TEXT
  `);

  // ── Bob v2 tables + columns ───────────────────────────────────────────────────
  // Bob is self-contained; these tables are separate from DN Cards. Create the
  // tables and backfill any missing columns so the published deployment stays in
  // sync with the Drizzle schema without requiring a manual drizzle-kit push.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bob_settings (
      id                  SERIAL PRIMARY KEY,
      guild_id            TEXT NOT NULL UNIQUE,
      enabled             BOOLEAN NOT NULL DEFAULT TRUE,
      games_enabled       JSONB NOT NULL DEFAULT '{}',
      blue_bob_pct        INTEGER NOT NULL DEFAULT 12,
      upside_bob_pct      INTEGER NOT NULL DEFAULT 2,
      reward_multiplier_pct INTEGER NOT NULL DEFAULT 100,
      cooldown_seconds    INTEGER NOT NULL DEFAULT 4,
      ai_talking          BOOLEAN NOT NULL DEFAULT FALSE,
      events_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
      channels            JSONB NOT NULL DEFAULT '[]',
      dex_integration     BOOLEAN NOT NULL DEFAULT FALSE,
      avatar_normal       TEXT,
      avatar_blue         TEXT,
      avatar_upside       TEXT,
      images              JSONB NOT NULL DEFAULT '{}',
      mention_chat        BOOLEAN NOT NULL DEFAULT TRUE,
      created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE bob_settings ADD COLUMN IF NOT EXISTS avatar_normal TEXT`);
  await pool.query(`ALTER TABLE bob_settings ADD COLUMN IF NOT EXISTS avatar_blue TEXT`);
  await pool.query(`ALTER TABLE bob_settings ADD COLUMN IF NOT EXISTS avatar_upside TEXT`);
  await pool.query(`ALTER TABLE bob_settings ADD COLUMN IF NOT EXISTS images JSONB NOT NULL DEFAULT '{}'`);
  await pool.query(`ALTER TABLE bob_settings ADD COLUMN IF NOT EXISTS mention_chat BOOLEAN NOT NULL DEFAULT TRUE`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bob_profiles (
      id                  SERIAL PRIMARY KEY,
      guild_id            TEXT NOT NULL,
      user_id             TEXT NOT NULL,
      coins               INTEGER NOT NULL DEFAULT 0,
      xp                  INTEGER NOT NULL DEFAULT 0,
      level               INTEGER NOT NULL DEFAULT 1,
      games_played        INTEGER NOT NULL DEFAULT 0,
      wins                INTEGER NOT NULL DEFAULT 0,
      losses              INTEGER NOT NULL DEFAULT 0,
      biggest_win         INTEGER NOT NULL DEFAULT 0,
      jackpots            INTEGER NOT NULL DEFAULT 0,
      roasts_given        INTEGER NOT NULL DEFAULT 0,
      interactions        INTEGER NOT NULL DEFAULT 0,
      coins_gambled       INTEGER NOT NULL DEFAULT 0,
      tasks_completed     INTEGER NOT NULL DEFAULT 0,
      quests_completed    INTEGER NOT NULL DEFAULT 0,
      roulette_streak     INTEGER NOT NULL DEFAULT 0,
      best_roulette_streak INTEGER NOT NULL DEFAULT 0,
      titles              JSONB NOT NULL DEFAULT '[]',
      current_title       TEXT,
      curse_label         TEXT,
      curse_until         TIMESTAMP,
      memory              JSONB NOT NULL DEFAULT '[]',
      last_action_at      TIMESTAMP,
      created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT bob_profiles_guild_user_uniq UNIQUE (guild_id, user_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS bob_profiles_guild_coins_idx ON bob_profiles(guild_id, coins)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bob_progress (
      id          SERIAL PRIMARY KEY,
      guild_id    TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      kind        TEXT NOT NULL,
      period_key  TEXT NOT NULL,
      items       JSONB NOT NULL DEFAULT '[]',
      created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT bob_progress_guild_user_kind_period_uniq UNIQUE (guild_id, user_id, kind, period_key)
    )
  `);

  // ── Operations Center tables ────────────────────────────────────────────────
  // The Operations Center PR introduced the schema but not the runtime migration.
  // Create all tables, indexes, and constraints idempotently on boot so the
  // deployed instance stays in sync with the Drizzle schema.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_guild_config (
      id            SERIAL PRIMARY KEY,
      guild_id      TEXT NOT NULL UNIQUE,
      enabled       BOOLEAN NOT NULL DEFAULT FALSE,
      ops_channel_id TEXT,
      staff_role_id TEXT,
      category_id   TEXT,
      created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_type_config (
      id                  SERIAL PRIMARY KEY,
      guild_id            TEXT NOT NULL,
      op_key              TEXT NOT NULL,
      enabled             BOOLEAN NOT NULL DEFAULT TRUE,
      display_name        TEXT,
      description         TEXT,
      color               TEXT,
      thumbnail_url       TEXT,
      banner_url          TEXT,
      footer_text         TEXT,
      timeout_minutes     INTEGER NOT NULL DEFAULT 60,
      auto_complete       BOOLEAN NOT NULL DEFAULT TRUE,
      required_responders INTEGER NOT NULL DEFAULT 1,
      max_queue_size      INTEGER NOT NULL DEFAULT 5,
      channel_buttons     JSONB NOT NULL DEFAULT '[]',
      updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ops_type_config_guild_key_uniq ON ops_type_config (guild_id, op_key)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ops_type_config_guild_idx ON ops_type_config (guild_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_boards (
      id          SERIAL PRIMARY KEY,
      guild_id    TEXT NOT NULL,
      op_key      TEXT NOT NULL,
      channel_id  TEXT NOT NULL,
      message_id  TEXT NOT NULL,
      created_at  TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ops_boards_guild_key_uniq ON ops_boards (guild_id, op_key)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ops_boards_guild_idx ON ops_boards (guild_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_active (
      id                SERIAL PRIMARY KEY,
      guild_id          TEXT NOT NULL,
      op_key            TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'inactive',
      commander_id      TEXT,
      objective         TEXT,
      roblox_link       TEXT,
      responders_needed INTEGER NOT NULL DEFAULT 1,
      notes             TEXT,
      started_at        TIMESTAMP,
      completed_at      TIMESTAMP,
      auto_complete_at  TIMESTAMP
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ops_active_guild_key_uniq ON ops_active (guild_id, op_key)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ops_active_guild_idx ON ops_active (guild_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ops_active_status_idx ON ops_active (status, auto_complete_at)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_queue (
      id                SERIAL PRIMARY KEY,
      guild_id          TEXT NOT NULL,
      op_key            TEXT NOT NULL,
      requester_id      TEXT NOT NULL,
      objective         TEXT,
      roblox_link       TEXT,
      responders_needed INTEGER NOT NULL DEFAULT 1,
      queued_at         TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ops_queue_guild_key_idx ON ops_queue (guild_id, op_key)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_responders (
      id           SERIAL PRIMARY KEY,
      active_op_id INTEGER NOT NULL,
      guild_id     TEXT NOT NULL,
      op_key       TEXT NOT NULL,
      user_id      TEXT NOT NULL,
      joined_at    TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ops_responders_op_user_uniq ON ops_responders (active_op_id, user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ops_responders_active_idx ON ops_responders (active_op_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_history (
      id                  SERIAL PRIMARY KEY,
      guild_id            TEXT NOT NULL,
      op_key              TEXT NOT NULL,
      commander_id        TEXT,
      objective           TEXT,
      responder_count     INTEGER NOT NULL DEFAULT 0,
      responders_needed   INTEGER NOT NULL DEFAULT 1,
      started_at          TIMESTAMP,
      completed_at        TIMESTAMP NOT NULL DEFAULT NOW(),
      response_time_seconds INTEGER,
      outcome             TEXT NOT NULL DEFAULT 'completed'
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ops_history_guild_idx ON ops_history (guild_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ops_history_guild_key_idx ON ops_history (guild_id, op_key)`);

  // After any restore or bulk import that inserted rows with explicit IDs,
  // serial sequences can fall behind the real table data and cause duplicate-
  // key failures on new inserts. Resync every sequence owned by a serial
  // column to the current max id + 1. This is idempotent and safe.
  await pool.query(`
    DO $$
    DECLARE
      r RECORD;
    BEGIN
      FOR r IN
        SELECT n.nspname AS schema_name, c.relname AS table_name, a.attname AS column_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE c.relkind = 'r'
          AND pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) IS NOT NULL
      LOOP
        EXECUTE format(
          'SELECT setval(pg_get_serial_sequence(%L, %L), COALESCE((SELECT MAX(%I) FROM %I.%I), 1), true)',
          r.schema_name || '.' || r.table_name, r.column_name, r.column_name, r.schema_name, r.table_name
        );
      END LOOP;
    END $$;
  `);

  // Battle attack frames switched from heavy GIFs to cheap PNGs, so they should
  // be on by default for all servers. Flip existing rows and update the column
  // default so new servers get the same behaviour.
  await pool.query(`ALTER TABLE battle_settings ALTER COLUMN battle_animation_enabled SET DEFAULT true`);
  await pool.query(`UPDATE battle_settings SET battle_animation_enabled = true, updated_at = NOW() WHERE battle_animation_enabled = false`);

  // AFK Secretary "speak as the away member" (webhook-impersonated intercept).
  // Off by default so existing servers keep the current bot-voiced behaviour.
  await pool.query(`ALTER TABLE afk_guild_settings ADD COLUMN IF NOT EXISTS speak_as_user BOOLEAN NOT NULL DEFAULT FALSE`);

  // ── Player Headquarters (HQ) ─────────────────────────────────────────────────
  // Purely additive: HQ's own state only. Progression and earned cosmetics are
  // DERIVED from the existing collection/battle/raid/achievement systems by
  // bot/hq/engine.ts — these tables never duplicate that data. Created here so a
  // Replit republish provisions them without a manual drizzle push.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_hq (
      id             SERIAL PRIMARY KEY,
      guild_id       TEXT NOT NULL,
      user_id        TEXT NOT NULL,
      theme_id       TEXT NOT NULL DEFAULT 'command',
      active_room_id TEXT NOT NULL DEFAULT 'trophy-hall',
      hq_level       INTEGER NOT NULL DEFAULT 1,
      stats          JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (guild_id, user_id)
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS player_hq_guild_user_uniq ON player_hq (guild_id, user_id)`);
  // Additive: isometric-room wall & floor styles (Phase 3). Older rows backfill
  // to the defaults, so an existing HQ keeps working after a republish.
  await pool.query(`ALTER TABLE player_hq ADD COLUMN IF NOT EXISTS wall_id TEXT NOT NULL DEFAULT 'plaster'`);
  await pool.query(`ALTER TABLE player_hq ADD COLUMN IF NOT EXISTS floor_id TEXT NOT NULL DEFAULT 'wood'`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS hq_unlocks (
      id          SERIAL PRIMARY KEY,
      guild_id    TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      item_id     TEXT NOT NULL,
      item_type   TEXT NOT NULL DEFAULT 'decoration',
      source      TEXT,
      unlocked_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (guild_id, user_id, item_id)
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS hq_unlocks_guild_user_item_uniq ON hq_unlocks (guild_id, user_id, item_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS hq_unlocks_guild_user_idx ON hq_unlocks (guild_id, user_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS hq_displays (
      id         SERIAL PRIMARY KEY,
      guild_id   TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      slot       INTEGER NOT NULL,
      card_id    INTEGER NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (guild_id, user_id, slot)
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS hq_displays_guild_user_slot_uniq ON hq_displays (guild_id, user_id, slot)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS hq_placements (
      id         SERIAL PRIMARY KEY,
      guild_id   TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      room_id    TEXT NOT NULL,
      slot       INTEGER NOT NULL,
      item_id    TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (guild_id, user_id, room_id, slot)
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS hq_placements_guild_user_room_slot_uniq ON hq_placements (guild_id, user_id, room_id, slot)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS hq_placements_guild_user_room_idx ON hq_placements (guild_id, user_id, room_id)`);

  // Base defenders (cards set to guard the base — setup half of base-defense).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hq_defenders (
      id         SERIAL PRIMARY KEY,
      guild_id   TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      slot       INTEGER NOT NULL,
      card_id    INTEGER NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (guild_id, user_id, slot)
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS hq_defenders_guild_user_slot_uniq ON hq_defenders (guild_id, user_id, slot)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS hq_defenders_guild_user_idx ON hq_defenders (guild_id, user_id)`);

  // Base-siege state + attack log (capture/defend mini-game).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hq_base_state (
      id               SERIAL PRIMARY KEY,
      guild_id         TEXT NOT NULL,
      user_id          TEXT NOT NULL,
      held_by_user_id  TEXT,
      held_by_name     TEXT,
      shield_until     TIMESTAMP,
      last_attacked_at TIMESTAMP,
      updated_at       TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (guild_id, user_id)
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS hq_base_state_guild_user_uniq ON hq_base_state (guild_id, user_id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hq_base_attacks (
      id             SERIAL PRIMARY KEY,
      guild_id       TEXT NOT NULL,
      attacker_id    TEXT NOT NULL,
      defender_id    TEXT NOT NULL,
      won            TEXT NOT NULL,
      attacker_power INTEGER NOT NULL DEFAULT 0,
      defender_power INTEGER NOT NULL DEFAULT 0,
      mode           TEXT NOT NULL DEFAULT 'static',
      created_at     TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS hq_base_attacks_pair_idx ON hq_base_attacks (guild_id, attacker_id, defender_id, created_at)`);

  // Hold-tribute + reign tracking (shards-while-you-hold, longest-hold board).
  await pool.query(`ALTER TABLE hq_base_state ADD COLUMN IF NOT EXISTS held_since TIMESTAMP`);
  await pool.query(`ALTER TABLE hq_base_state ADD COLUMN IF NOT EXISTS last_tribute_at TIMESTAMP`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hq_base_reigns (
      id            SERIAL PRIMARY KEY,
      guild_id      TEXT NOT NULL,
      holder_id     TEXT NOT NULL,
      holder_name   TEXT,
      base_owner_id TEXT NOT NULL,
      started_at    TIMESTAMP NOT NULL,
      ended_at      TIMESTAMP NOT NULL DEFAULT NOW(),
      duration_sec  INTEGER NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS hq_base_reigns_holder_idx ON hq_base_reigns (guild_id, holder_id)`);

  // World territories — the AI-held castles seeded onto the shared world map.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hq_world_nodes (
      id               SERIAL PRIMARY KEY,
      guild_id         TEXT NOT NULL,
      node_id          TEXT NOT NULL,
      held_by_user_id  TEXT,
      held_by_name     TEXT,
      held_since       TIMESTAMP,
      last_tribute_at  TIMESTAMP,
      shield_until     TIMESTAMP,
      last_attacked_at TIMESTAMP,
      captures         INTEGER NOT NULL DEFAULT 0,
      stats            JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (guild_id, node_id)
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS hq_world_nodes_guild_node_uniq ON hq_world_nodes (guild_id, node_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS hq_world_nodes_holder_idx ON hq_world_nodes (guild_id, held_by_user_id)`);

  // Built terrain — rectangles stamped by the in-Discord world editor.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hq_terrain (
      id          SERIAL PRIMARY KEY,
      guild_id    TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      room_id     TEXT NOT NULL,
      material_id TEXT NOT NULL,
      x           INTEGER NOT NULL,
      y           INTEGER NOT NULL,
      w           INTEGER NOT NULL DEFAULT 1,
      h           INTEGER NOT NULL DEFAULT 1,
      elevation   INTEGER NOT NULL DEFAULT 0,
      z           INTEGER NOT NULL DEFAULT 0,
      meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at  TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS hq_terrain_guild_user_room_idx ON hq_terrain (guild_id, user_id, room_id)`);

  // Per-guild HQ configuration — the siege ruleset the server owner sets.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hq_settings (
      id                  SERIAL PRIMARY KEY,
      guild_id            TEXT NOT NULL,
      siege_mode          TEXT NOT NULL DEFAULT 'turn',
      siege_intro         BOOLEAN NOT NULL DEFAULT TRUE,
      siege_turn_seconds  INTEGER NOT NULL DEFAULT 45,
      siege_turn_visuals  BOOLEAN NOT NULL DEFAULT TRUE,
      siege_item_uses     INTEGER NOT NULL DEFAULT 3,
      siege_max_turns     INTEGER NOT NULL DEFAULT 40,
      extra               JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at          TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (guild_id)
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS hq_settings_guild_uniq ON hq_settings (guild_id)`);

  // ── HQ Activity live-world layout (additive; Phaser Activity floorplan) ──────
  // One authoritative floorplan blob per (guild,user). Purely additive — the
  // existing HQ tables are untouched. Server validates every save against
  // hq_unlocks before writing, so this never becomes a source of unearned items.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hq_activity_layout (
      id          SERIAL PRIMARY KEY,
      guild_id    TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      layout      JSONB NOT NULL DEFAULT '{}'::jsonb,
      revision    INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS hq_activity_layout_guild_user_uniq ON hq_activity_layout (guild_id, user_id)`);

  // ── Per-guild experience presentation modes (additive; defaults preserve the
  // current server-rendered behaviour so live guilds are unaffected) ───────────
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS hq_presentation text NOT NULL DEFAULT 'discord_png'`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS hq_fallback text NOT NULL DEFAULT 'discord_png'`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS battle_presentation text NOT NULL DEFAULT 'discord_embed'`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS battle_fallback text NOT NULL DEFAULT 'discord_embed'`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS raid_presentation text NOT NULL DEFAULT 'discord_embed'`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS raid_fallback text NOT NULL DEFAULT 'discord_embed'`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS pack_presentation text NOT NULL DEFAULT 'animated_image'`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS pack_fallback text NOT NULL DEFAULT 'animated_image'`);

  // ── UnbelievaBoat addon + Tamagotchi pets (additive; IF NOT EXISTS only) ───
  // Production DBs already have guild_settings, so ensureBaseSchema skips
  // drizzle-kit push. These CREATE TABLE IF NOT EXISTS statements are the
  // path that adds pet_* / ub_* on the next Railway deploy without touching
  // existing DN Cards tables. See docs/unbelievaboat.md.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ub_settings (
      id                SERIAL PRIMARY KEY,
      guild_id          TEXT NOT NULL UNIQUE,
      ub_guild_id       TEXT NOT NULL,
      enabled           BOOLEAN NOT NULL DEFAULT TRUE,
      leaderboard_sort  TEXT NOT NULL DEFAULT 'total',
      pets_spend_ub     BOOLEAN NOT NULL DEFAULT TRUE,
      currency_label    TEXT,
      games_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
      store_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
      daily_min         INTEGER NOT NULL DEFAULT 100,
      daily_max         INTEGER NOT NULL DEFAULT 250,
      created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE ub_settings ADD COLUMN IF NOT EXISTS games_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
  await pool.query(`ALTER TABLE ub_settings ADD COLUMN IF NOT EXISTS store_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
  await pool.query(`ALTER TABLE ub_settings ADD COLUMN IF NOT EXISTS daily_min INTEGER NOT NULL DEFAULT 100`);
  await pool.query(`ALTER TABLE ub_settings ADD COLUMN IF NOT EXISTS daily_max INTEGER NOT NULL DEFAULT 250`);
  await pool.query(`ALTER TABLE ub_settings ADD COLUMN IF NOT EXISTS cooldowns JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await pool.query(`ALTER TABLE ub_settings ADD COLUMN IF NOT EXISTS payouts JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await pool.query(`ALTER TABLE ub_settings ADD COLUMN IF NOT EXISTS log_channel_id TEXT`);
  await pool.query(`ALTER TABLE ub_settings ADD COLUMN IF NOT EXISTS rob_immune_role_ids JSONB NOT NULL DEFAULT '[]'::jsonb`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ub_game_state (
      id                  SERIAL PRIMARY KEY,
      guild_id            TEXT NOT NULL,
      user_id             TEXT NOT NULL,
      last_daily_at       TIMESTAMP,
      last_rob_at         TIMESTAMP,
      last_beg_at         TIMESTAMP,
      last_work_at        TIMESTAMP,
      last_crime_at       TIMESTAMP,
      last_roulette_at    TIMESTAMP,
      last_blackjack_at   TIMESTAMP,
      last_russian_at     TIMESTAMP,
      last_collect_at     TIMESTAMP,
      daily_streak        INTEGER NOT NULL DEFAULT 0,
      meta                JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE ub_game_state ADD COLUMN IF NOT EXISTS last_work_at TIMESTAMP`);
  await pool.query(`ALTER TABLE ub_game_state ADD COLUMN IF NOT EXISTS last_crime_at TIMESTAMP`);
  await pool.query(`ALTER TABLE ub_game_state ADD COLUMN IF NOT EXISTS last_collect_at TIMESTAMP`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ub_game_state_guild_user_uidx ON ub_game_state (guild_id, user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ub_game_state_guild_idx ON ub_game_state (guild_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ub_role_links (
      id                SERIAL PRIMARY KEY,
      guild_id          TEXT NOT NULL,
      discord_role_id   TEXT,
      name              TEXT NOT NULL,
      description       TEXT,
      ub_item_id        TEXT,
      price             INTEGER NOT NULL DEFAULT 0,
      grant_cash        INTEGER NOT NULL DEFAULT 0,
      income_amount     INTEGER NOT NULL DEFAULT 0,
      category          TEXT NOT NULL DEFAULT 'custom',
      emoji             TEXT,
      enabled           BOOLEAN NOT NULL DEFAULT TRUE,
      meta              JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE ub_role_links ADD COLUMN IF NOT EXISTS income_amount INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ub_role_links_guild_idx ON ub_role_links (guild_id)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ub_role_links_guild_role_uidx ON ub_role_links (guild_id, discord_role_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ub_store_catalog (
      id                SERIAL PRIMARY KEY,
      guild_id          TEXT NOT NULL,
      name              TEXT NOT NULL,
      description       TEXT,
      price             INTEGER NOT NULL DEFAULT 0,
      emoji             TEXT,
      category          TEXT NOT NULL DEFAULT 'general',
      ub_item_id        TEXT,
      grant_role_id     TEXT,
      is_inventory      BOOLEAN NOT NULL DEFAULT TRUE,
      is_usable         BOOLEAN NOT NULL DEFAULT TRUE,
      is_sellable       BOOLEAN NOT NULL DEFAULT TRUE,
      unlimited_stock   BOOLEAN NOT NULL DEFAULT TRUE,
      stock_remaining   INTEGER,
      listed            BOOLEAN NOT NULL DEFAULT TRUE,
      for_pets          BOOLEAN NOT NULL DEFAULT FALSE,
      pet_effect        TEXT,
      pet_effect_value  INTEGER NOT NULL DEFAULT 0,
      meta              JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ub_store_catalog_guild_idx ON ub_store_catalog (guild_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ub_store_catalog_ub_item_idx ON ub_store_catalog (ub_item_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ub_audit_log (
      id                SERIAL PRIMARY KEY,
      guild_id          TEXT NOT NULL,
      actor_id          TEXT NOT NULL,
      target_user_id    TEXT,
      action            TEXT NOT NULL,
      detail            JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at        TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ub_audit_log_guild_idx ON ub_audit_log (guild_id)`);

  // ── Tatsu addon (score/points dashboard) — additive IF NOT EXISTS ──────────
  // See docs/tatsu.md. API key is env TATSU_API_KEY (from `t!apikey create`).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tatsu_settings (
      id                SERIAL PRIMARY KEY,
      guild_id          TEXT NOT NULL UNIQUE,
      tatsu_guild_id    TEXT NOT NULL,
      enabled           BOOLEAN NOT NULL DEFAULT TRUE,
      ranking_period    TEXT NOT NULL DEFAULT 'all',
      log_channel_id    TEXT,
      spam_score_delta  INTEGER NOT NULL DEFAULT 5000,
      created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tatsu_audit_log (
      id                SERIAL PRIMARY KEY,
      guild_id          TEXT NOT NULL,
      actor_id          TEXT NOT NULL,
      target_user_id    TEXT,
      action            TEXT NOT NULL,
      detail            JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at        TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS tatsu_audit_log_guild_idx ON tatsu_audit_log (guild_id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tatsu_watchlist (
      id                SERIAL PRIMARY KEY,
      guild_id          TEXT NOT NULL,
      user_id           TEXT NOT NULL,
      note              TEXT,
      flagged_by        TEXT NOT NULL,
      created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS tatsu_watchlist_guild_user_uidx ON tatsu_watchlist (guild_id, user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS tatsu_watchlist_guild_idx ON tatsu_watchlist (guild_id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tatsu_snapshots (
      id                SERIAL PRIMARY KEY,
      guild_id          TEXT NOT NULL,
      period            TEXT NOT NULL DEFAULT 'all',
      rankings          JSONB NOT NULL DEFAULT '[]'::jsonb,
      taken_by          TEXT,
      created_at        TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS tatsu_snapshots_guild_idx ON tatsu_snapshots (guild_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pet_settings (
      id                          SERIAL PRIMARY KEY,
      guild_id                    TEXT NOT NULL UNIQUE,
      enabled                     BOOLEAN NOT NULL DEFAULT TRUE,
      growth_hours                INTEGER NOT NULL DEFAULT 24,
      max_neglects                INTEGER NOT NULL DEFAULT 5,
      hunger_decay_per_hour       INTEGER NOT NULL DEFAULT 4,
      cleanliness_decay_per_hour  INTEGER NOT NULL DEFAULT 3,
      happiness_decay_per_hour    INTEGER NOT NULL DEFAULT 3,
      hatch_cost                  INTEGER NOT NULL DEFAULT 250,
      challenge_wager             INTEGER NOT NULL DEFAULT 50,
      created_at                  TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at                  TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pets (
      id                  SERIAL PRIMARY KEY,
      guild_id            TEXT NOT NULL,
      user_id             TEXT NOT NULL,
      name                TEXT NOT NULL,
      species             TEXT NOT NULL,
      stage               TEXT NOT NULL DEFAULT 'egg',
      variant             INTEGER NOT NULL DEFAULT 0,
      hunger              INTEGER NOT NULL DEFAULT 80,
      cleanliness         INTEGER NOT NULL DEFAULT 80,
      happiness           INTEGER NOT NULL DEFAULT 80,
      health              INTEGER NOT NULL DEFAULT 100,
      level               INTEGER NOT NULL DEFAULT 1,
      xp                  INTEGER NOT NULL DEFAULT 0,
      power               INTEGER NOT NULL DEFAULT 10,
      wins                INTEGER NOT NULL DEFAULT 0,
      losses              INTEGER NOT NULL DEFAULT 0,
      neglect_count       INTEGER NOT NULL DEFAULT 0,
      is_dead             BOOLEAN NOT NULL DEFAULT FALSE,
      died_at             TIMESTAMP,
      cosmetics           JSONB NOT NULL DEFAULT '[]'::jsonb,
      active_cosmetic     TEXT,
      inventory           JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_fed_at         TIMESTAMP,
      last_cleaned_at     TIMESTAMP,
      last_played_at      TIMESTAMP,
      last_tick_at        TIMESTAMP NOT NULL DEFAULT NOW(),
      stage_started_at    TIMESTAMP NOT NULL DEFAULT NOW(),
      hatched_at          TIMESTAMP,
      created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS pets_guild_user_idx ON pets (guild_id, user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS pets_guild_power_idx ON pets (guild_id, power)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS pets_guild_alive_idx ON pets (guild_id, is_dead)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pet_challenges (
      id                SERIAL PRIMARY KEY,
      guild_id          TEXT NOT NULL,
      challenger_id     TEXT NOT NULL,
      opponent_id       TEXT NOT NULL,
      wager             INTEGER NOT NULL DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'pending',
      winner_id         TEXT,
      result            JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
      resolved_at       TIMESTAMP
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS pet_challenges_guild_idx ON pet_challenges (guild_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS pet_challenges_status_idx ON pet_challenges (guild_id, status)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pet_care_log (
      id                SERIAL PRIMARY KEY,
      guild_id          TEXT NOT NULL,
      pet_id            INTEGER NOT NULL,
      user_id           TEXT NOT NULL,
      action            TEXT NOT NULL,
      detail            JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at        TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS pet_care_log_pet_idx ON pet_care_log (pet_id)`);

  // Endless hatch: many pets per member, one active. Egg contents roll at hatch time.
  await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS discovery_variant TEXT NOT NULL DEFAULT 'normal'`);
  await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS egg_key TEXT`);
  await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS hatch_replay JSONB`);
  await pool.query(`
    UPDATE pets p SET is_active = TRUE
    WHERE NOT EXISTS (
      SELECT 1 FROM pets o
      WHERE o.guild_id = p.guild_id AND o.user_id = p.user_id AND o.is_active
    )
    AND p.id = (
      SELECT p2.id FROM pets p2
      WHERE p2.guild_id = p.guild_id AND p2.user_id = p.user_id
      ORDER BY p2.is_dead ASC, p2.id ASC
      LIMIT 1
    )
  `);
  await pool.query(`DROP INDEX IF EXISTS pets_guild_user_uidx`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS pets_one_active_uidx ON pets (guild_id, user_id) WHERE is_active`);
  await pool.query(`CREATE INDEX IF NOT EXISTS pets_active_idx ON pets (guild_id, user_id, is_active)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS pets_guild_user_idx ON pets (guild_id, user_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pet_owned_eggs (
      id                   SERIAL PRIMARY KEY,
      guild_id             TEXT NOT NULL,
      owner_id             TEXT NOT NULL,
      egg_key              TEXT NOT NULL,
      status               TEXT NOT NULL DEFAULT 'held',
      pending_name         TEXT,
      obtained_at          TIMESTAMP NOT NULL DEFAULT NOW(),
      incubate_started_at  TIMESTAMP,
      ready_at             TIMESTAMP,
      hatched_pet_id       INTEGER,
      limited_date         TEXT,
      sell_value           INTEGER NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS pet_owned_eggs_owner_idx ON pet_owned_eggs (guild_id, owner_id, status)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pet_dex (
      id                  SERIAL PRIMARY KEY,
      guild_id            TEXT NOT NULL,
      user_id             TEXT NOT NULL,
      species             TEXT NOT NULL,
      discovery_variant   TEXT NOT NULL,
      owned_count         INTEGER NOT NULL DEFAULT 0,
      first_hatched_at    TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS pet_dex_uidx ON pet_dex (guild_id, user_id, species, discovery_variant)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pet_user_items (
      id          SERIAL PRIMARY KEY,
      guild_id    TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      item_key    TEXT NOT NULL,
      qty         INTEGER NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS pet_user_items_uidx ON pet_user_items (guild_id, user_id, item_key)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pet_limited_drops (
      id             SERIAL PRIMARY KEY,
      guild_id       TEXT NOT NULL,
      release_date   TEXT NOT NULL,
      egg_key        TEXT NOT NULL,
      total_supply   INTEGER NOT NULL,
      claimed        INTEGER NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS pet_limited_drops_uidx ON pet_limited_drops (guild_id, release_date)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pet_egg_offers (
      id          SERIAL PRIMARY KEY,
      guild_id    TEXT NOT NULL,
      egg_id      INTEGER NOT NULL,
      from_id     TEXT NOT NULL,
      to_id       TEXT NOT NULL,
      tax         INTEGER NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'pending',
      created_at  TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS pet_egg_offers_to_idx ON pet_egg_offers (guild_id, to_id, status)`);

  // ── Quiet Mode / Quiet Room ────────────────────────────────────────────────
  // Additive addon tables. Existing Railway DBs already have guild_settings, so
  // start-production skips drizzle-kit push — these CREATE IF NOT EXISTS lines
  // provision Quiet Mode on the next deploy without AUTO_DB_PUSH=1.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quiet_guild_settings (
      id                 SERIAL PRIMARY KEY,
      guild_id           TEXT NOT NULL UNIQUE,
      enabled            BOOLEAN NOT NULL DEFAULT TRUE,
      quiet_channel_id   TEXT,
      quiet_category_id  TEXT,
      quiet_role_id      TEXT,
      whitelist_role_id  TEXT,
      blacklist_role_id  TEXT,
      audio_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE quiet_guild_settings
      ADD COLUMN IF NOT EXISTS quiet_role_id TEXT
  `);
  await pool.query(`
    ALTER TABLE quiet_guild_settings
      ADD COLUMN IF NOT EXISTS sanctuary_modes JSONB NOT NULL DEFAULT '[]'::jsonb
  `);
  await pool.query(`
    ALTER TABLE quiet_state
      ADD COLUMN IF NOT EXISTS mode_key TEXT NOT NULL DEFAULT 'quiet'
  `);
  await pool.query(`
    ALTER TABLE quiet_state
      ADD COLUMN IF NOT EXISTS quarantine_role_id TEXT
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS quiet_state (
      id                 SERIAL PRIMARY KEY,
      guild_id           TEXT NOT NULL,
      user_id            TEXT NOT NULL,
      entered_at         TIMESTAMP NOT NULL DEFAULT NOW(),
      entered_by         TEXT NOT NULL,
      theme              TEXT,
      quote_id           TEXT,
      quote_text         TEXT,
      audio_id           TEXT,
      last_channel_id    TEXT,
      room_message_ids   JSONB NOT NULL DEFAULT '[]'::jsonb,
      overwrite_targets  JSONB NOT NULL DEFAULT '[]'::jsonb,
      needs_recovery     BOOLEAN NOT NULL DEFAULT FALSE,
      admin_bypass       BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS quiet_state_guild_user_uniq ON quiet_state (guild_id, user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS quiet_state_guild_idx ON quiet_state (guild_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS quiet_state_recovery_idx ON quiet_state (needs_recovery)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS quiet_user_prefs (
      id                 SERIAL PRIMARY KEY,
      guild_id           TEXT NOT NULL,
      user_id            TEXT NOT NULL,
      recent_audio_ids   JSONB NOT NULL DEFAULT '[]'::jsonb,
      recent_quote_ids   JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS quiet_user_prefs_guild_user_uniq ON quiet_user_prefs (guild_id, user_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS quiet_audio_config (
      id          SERIAL PRIMARY KEY,
      audio_id    TEXT NOT NULL UNIQUE,
      enabled     BOOLEAN NOT NULL DEFAULT TRUE,
      weight      INTEGER NOT NULL DEFAULT 1,
      updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  logger.info("Boot migrations applied");
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function main() {
  // Listen FIRST so the Autoscale startup probe (GET /api/healthz) can respond
  // immediately. Migrations and bot startup happen after the server is ready.
  // Autoscale creates the new instance while the old one is still running;
  // awaiting DDL migrations before listen caused ALTER TABLE to block on
  // the old instance's connections, making the probe time out.
  const server = await new Promise<import("node:http").Server>((resolve, reject) => {
    const s = app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        reject(err);
        return;
      }
      logger.info({ port }, "Server listening");
      resolve(s);
    });
  });

  // Online PvP relay for the Discord Activity. Attaching to the same HTTP
  // server means it rides the existing host/port (and Discord's proxy).
  try {
    attachDuelSocket(server);
  } catch (err) {
    logger.error({ err }, "Failed to attach duel PvP socket — server continues");
  }

  // Fresh Railway Postgres has no tables — push the Drizzle schema before
  // boot migrations / Discord guild init query guild_settings.
  try {
    const { ensureBaseSchema } = await import("./lib/ensure-base-schema.js");
    await ensureBaseSchema();
  } catch (err) {
    logger.error(
      { err },
      "Failed to ensure base schema — Discord bot will not start until tables exist. " +
        "Set AUTO_DB_PUSH=1 or run: pnpm --filter @workspace/db run push-force",
    );
    return;
  }

  // Run idempotent boot migrations after the server is accepting traffic.
  // Failures are logged but non-fatal: every statement uses IF NOT EXISTS /
  // conditional guards, so a lock-timeout on a contested table just means the
  // column was already added by a prior deployment.
  try {
    await runBootMigrations();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code ?? "")
        : "";
    const missingRelation = code === "42P01" || /relation .* does not exist/i.test(message);
    if (missingRelation) {
      logger.error(
        { err },
        "Boot migrations failed — base tables are still missing after schema ensure. Server continues without Discord.",
      );
      return;
    } else if (/HOME_GUILD_ID/i.test(message)) {
      logger.error(
        { err },
        "Boot migrations failed — set HOME_GUILD_ID to your Discord server ID. Server continues.",
      );
    } else {
      logger.error({ err }, "Boot migrations failed — server continues");
    }
  }

  // Start Discord bot alongside the API server
  startBot().catch((err) => {
    logger.error({ err }, "Bot startup failed");
  });
}

main();
