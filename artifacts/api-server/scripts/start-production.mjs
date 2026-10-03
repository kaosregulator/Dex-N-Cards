#!/usr/bin/env node
/**
 * Production start wrapper for Railway (and similar hosts).
 *
 * 1. Applies the Drizzle schema when the DB is empty / AUTO_DB_PUSH=1
 * 2. Ensures additive addon tables (quiet_*, ub_*, tatsu_*) when drizzle push
 *    is skipped because guild_settings already exists
 * 3. Starts the bundled API + Discord bot (which re-registers guild slash cmds
 *    on ClientReady — including /casino and the *_ub shortcuts)
 *
 * Env:
 *   AUTO_DB_PUSH=1  — always run `drizzle-kit push` before start (first deploy)
 *   AUTO_DB_PUSH=0  — never push; only start (also skips addon CREATE IF NOT EXISTS)
 *   (unset)         — push only when `guild_settings` is missing
 *
 * This is the default `pnpm start` for @workspace/api-server so Railway
 * custom start commands that call package start still bootstrap schema.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const serverEntry = resolve(repoRoot, "artifacts/api-server/dist/index.mjs");
const localEntry = resolve(__dirname, "../dist/index.mjs");

function buildPoolConfig(connectionString) {
  const sslMode = (process.env.DATABASE_SSL ?? "").trim().toLowerCase();
  const forceOff = sslMode === "0" || sslMode === "false" || sslMode === "disable";
  const forceOn =
    sslMode === "1" ||
    sslMode === "true" ||
    sslMode === "require" ||
    sslMode === "prefer";
  const looksLocal = /@(localhost|127\.0\.0\.1)([:/]|$)/i.test(connectionString);
  const looksManaged =
    /railway\.(app|internal)|rlwy\.net|neon\.tech|supabase\.(co|com)|amazonaws\.com|azure\.com|render\.com/i.test(
      connectionString,
    ) || /[?&]sslmode=require\b/i.test(connectionString);
  const useSsl = forceOn || (!forceOff && !looksLocal && looksManaged);
  return {
    connectionString,
    ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  };
}

async function baseSchemaMissing() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const pool = new pg.Pool(buildPoolConfig(url));
  try {
    await pool.query("SELECT 1 FROM guild_settings LIMIT 1");
    return false;
  } catch (err) {
    if (err && typeof err === "object" && err.code === "42P01") return true;
    console.error("Database check failed:", err?.message ?? err);
    process.exit(1);
  } finally {
    await pool.end().catch(() => {});
  }
}

/** Quiet Mode tables — create when missing on an already-provisioned DB. */
async function ensureQuietTables(pool) {
  try {
    await pool.query("SELECT 1 FROM quiet_state LIMIT 1");
    return;
  } catch (err) {
    if (!(err && typeof err === "object" && err.code === "42P01")) {
      console.warn("Quiet schema check skipped:", err?.message ?? err);
      return;
    }
  }

  console.log("Quiet Mode tables missing — creating quiet_* schema…");
  try {
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
    console.log("Quiet Mode tables ready");
  } catch (err) {
    console.error("Failed to create Quiet Mode tables:", err?.message ?? err);
    // Non-fatal here — boot migrations in the app also try; start anyway.
  }
}

/**
 * UnbelievaBoat + Tatsu tables — CREATE IF NOT EXISTS on already-provisioned DBs.
 * Existing Railway DBs skip drizzle push (guild_settings present); this is how
 * ub_* / tatsu_* land on the next redeploy without AUTO_DB_PUSH=1.
 * Boot migrations in dist/index.mjs also run the same statements.
 */
async function ensureUbAndTatsuTables(pool) {
  console.log("Ensuring UnbelievaBoat (ub_*) + Tatsu (tatsu_*) + Trivia (trivia_*) tables…");
  try {
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
      CREATE TABLE IF NOT EXISTS trivia_settings (
        id                  SERIAL PRIMARY KEY,
        guild_id            TEXT NOT NULL UNIQUE,
        enabled             BOOLEAN NOT NULL DEFAULT TRUE,
        audience            TEXT NOT NULL DEFAULT 'general',
        default_source      TEXT NOT NULL DEFAULT 'opentdb',
        default_category    TEXT,
        default_guess_mode  TEXT NOT NULL DEFAULT 'buttons',
        qotd_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
        qotd_channel_id     TEXT,
        qotd_hour_utc       INTEGER NOT NULL DEFAULT 16,
        qotd_source         TEXT NOT NULL DEFAULT 'opentdb',
        qotd_category       TEXT,
        next_card           JSONB DEFAULT NULL,
        role_ids            JSONB NOT NULL DEFAULT '{}'::jsonb,
        last_qotd_date      TEXT,
        created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trivia_rounds (
        id                  SERIAL PRIMARY KEY,
        guild_id            TEXT NOT NULL,
        channel_id          TEXT NOT NULL,
        message_id          TEXT,
        mode                TEXT NOT NULL DEFAULT 'flash',
        status              TEXT NOT NULL DEFAULT 'ready',
        source              TEXT NOT NULL DEFAULT 'opentdb',
        guess_mode          TEXT NOT NULL DEFAULT 'buttons',
        question            JSONB NOT NULL DEFAULT '{}'::jsonb,
        answer_norm         TEXT NOT NULL DEFAULT '',
        host_id             TEXT NOT NULL,
        winners             JSONB NOT NULL DEFAULT '[]'::jsonb,
        winner_message_id   TEXT,
        cleanup_at          TIMESTAMP,
        started_at          TIMESTAMP,
        ended_at            TIMESTAMP,
        created_at          TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS trivia_rounds_guild_idx ON trivia_rounds (guild_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS trivia_rounds_status_idx ON trivia_rounds (status)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trivia_guesses (
        id                  SERIAL PRIMARY KEY,
        round_id            INTEGER NOT NULL,
        guild_id            TEXT NOT NULL,
        user_id             TEXT NOT NULL,
        guess               TEXT NOT NULL,
        correct             BOOLEAN NOT NULL DEFAULT FALSE,
        created_at          TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS trivia_guesses_round_user_uidx ON trivia_guesses (round_id, user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS trivia_guesses_round_idx ON trivia_guesses (round_id)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trivia_role_holds (
        id                  SERIAL PRIMARY KEY,
        guild_id            TEXT NOT NULL,
        user_id             TEXT NOT NULL,
        role_id             TEXT NOT NULL,
        role_key            TEXT NOT NULL,
        round_id            INTEGER,
        expires_at          TIMESTAMP NOT NULL,
        created_at          TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS trivia_role_holds_guild_idx ON trivia_role_holds (guild_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS trivia_role_holds_expires_idx ON trivia_role_holds (expires_at)`);

    console.log("UnbelievaBoat + Tatsu + Trivia tables ready");
  } catch (err) {
    console.error("Failed to ensure ub_*/tatsu_*/trivia_* tables:", err?.message ?? err);
    // Non-fatal — boot migrations in the app also try; start anyway.
  }
}

/** Additive addon tables for already-provisioned DBs (drizzle push skipped). */
async function ensureAddonTables() {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const pool = new pg.Pool(buildPoolConfig(url));
  try {
    await ensureQuietTables(pool);
    await ensureUbAndTatsuTables(pool);
  } finally {
    await pool.end().catch(() => {});
  }
}

function runDbPush() {
  console.log("Applying database schema (drizzle-kit push-force)…");
  const result = spawnSync(
    "pnpm",
    ["--filter", "@workspace/db", "run", "push-force"],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        CI: "true",
        // Match runtime Pool: never hard-fail on managed Postgres certs.
        NODE_TLS_REJECT_UNAUTHORIZED:
          process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? "0",
      },
    },
  );
  if (result.status !== 0) {
    console.error(
      "Schema push failed — aborting start.\n" +
        "This usually means DATABASE_URL cannot be reached with TLS. " +
        "Confirm the Postgres plugin is linked, then redeploy. " +
        "You can also set DATABASE_SSL=disable for railway.internal URLs.",
    );
    process.exit(result.status ?? 1);
  }
}

async function main() {
  const entry = existsSync(serverEntry)
    ? serverEntry
    : existsSync(localEntry)
      ? localEntry
      : null;
  if (!entry) {
    console.error(
      `Built server not found at ${serverEntry} (or ${localEntry}). Run the Railway build first.`,
    );
    process.exit(1);
  }

  const mode = (process.env.AUTO_DB_PUSH ?? "").trim();
  if (mode === "1") {
    runDbPush();
  } else if (mode !== "0") {
    if (await baseSchemaMissing()) {
      console.log("Base tables missing — running one-time schema push…");
      runDbPush();
    }
  }

  // Existing Railway DBs skip drizzle push (guild_settings already present).
  // Quiet / UB / Tatsu were added later — ensure those tables exist before boot.
  // Slash commands (incl. *_ub) are registered by the bot on ClientReady — no
  // separate register step is required on redeploy.
  if (mode !== "0") {
    await ensureAddonTables();
  }

  const child = spawnSync(process.execPath, ["--enable-source-maps", entry], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  process.exit(child.status ?? 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
