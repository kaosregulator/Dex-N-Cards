// Configuration Engine — per-guild battle settings.
//
// Owns reads/writes of `battle_settings`. Every server has its own row; a
// missing row is created lazily with sane defaults (battles stay locked until
// an admin runs the setup wizard, which flips `setupComplete`). A tiny 5s
// per-guild cache mirrors the pattern used elsewhere in the bot.

import { db, pool, battleSettingsTable } from "@workspace/db";
import type { BattleSettings } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { Rarity } from "./types.js";
// Rarity ordering/rank is owned by the shared cards-data service — the single
// source of truth. Battles must not keep a private copy, or a custom `/rarity`
// tier would rank differently in combat than everywhere else.
import { RARITY_ORDER, rarityRank } from "../cards-data.js";

export { RARITY_ORDER, rarityRank };

const _cache = new Map<string, { value: BattleSettings; expiresAt: number }>();
const TTL_MS = 5_000;

const BATTLE_SETTING_COLUMN_SQL = [
  `ALTER TABLE battle_settings ADD COLUMN IF NOT EXISTS battle_status_theme text NOT NULL DEFAULT 'classic'`,
  `ALTER TABLE battle_settings ADD COLUMN IF NOT EXISTS battle_frame_color_mode text NOT NULL DEFAULT 'image'`,
  `ALTER TABLE battle_settings ADD COLUMN IF NOT EXISTS battle_frame_color_a text`,
  `ALTER TABLE battle_settings ADD COLUMN IF NOT EXISTS battle_frame_color_b text`,
  `ALTER TABLE battle_settings ADD COLUMN IF NOT EXISTS user_miss_chance_pct integer`,
  `ALTER TABLE battle_settings ADD COLUMN IF NOT EXISTS user_dodge_chance_pct integer`,
  `ALTER TABLE battle_settings ADD COLUMN IF NOT EXISTS user_crit_chance_pct integer`,
  `ALTER TABLE battle_settings ADD COLUMN IF NOT EXISTS ai_miss_chance_pct integer`,
  `ALTER TABLE battle_settings ADD COLUMN IF NOT EXISTS ai_dodge_chance_pct integer`,
  `ALTER TABLE battle_settings ADD COLUMN IF NOT EXISTS ai_crit_chance_pct integer`,
  `ALTER TABLE battle_settings ADD COLUMN IF NOT EXISTS ai_allow_ultimate boolean NOT NULL DEFAULT true`,
  `ALTER TABLE battle_settings ADD COLUMN IF NOT EXISTS ai_allow_special boolean NOT NULL DEFAULT true`,
  `ALTER TABLE battle_settings ADD COLUMN IF NOT EXISTS ai_allow_item boolean NOT NULL DEFAULT true`,
  `ALTER TABLE battle_settings ADD COLUMN IF NOT EXISTS ai_allow_defend boolean NOT NULL DEFAULT true`,
  `ALTER TABLE battle_settings ADD COLUMN IF NOT EXISTS ai_allow_charge boolean NOT NULL DEFAULT true`,
];

let statusThemeColumnReady: Promise<void> | null = null;

/** Same statement as the boot migration, so a live process can recover if the column is still missing. */
export function ensureBattleStatusThemeColumn(): Promise<void> {
  if (!statusThemeColumnReady) {
    statusThemeColumnReady = (async () => {
      for (const sql of BATTLE_SETTING_COLUMN_SQL) await pool.query(sql);
    })().catch((err) => {
      statusThemeColumnReady = null;
      throw err;
    });
  }
  return statusThemeColumnReady;
}

function errorText(err: unknown): string {
  if (!err) return "";
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return `${err.message}\n${errorText(cause)}`;
  }
  return String(err);
}

function missingBattleStatusTheme(err: unknown): boolean {
  const text = errorText(err);
  if (!/does not exist|42703/i.test(text)) return false;
  return BATTLE_SETTING_COLUMN_SQL.some(sql => {
    const name = sql.match(/ADD COLUMN IF NOT EXISTS ([a-z0-9_]+)/)?.[1];
    return Boolean(name && text.includes(name));
  });
}

async function loadBattleSettings(guildId: string): Promise<BattleSettings> {
  const [row] = await db.select().from(battleSettingsTable)
    .where(eq(battleSettingsTable.guildId, guildId)).limit(1);
  const value = row ?? (await db.insert(battleSettingsTable).values({ guildId }).returning())[0]!;
  _cache.set(guildId, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

export async function getBattleSettings(guildId: string): Promise<BattleSettings> {
  const cached = _cache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    return await loadBattleSettings(guildId);
  } catch (err) {
    if (!missingBattleStatusTheme(err)) throw err;
    await ensureBattleStatusThemeColumn();
    return await loadBattleSettings(guildId);
  }
}

export async function updateBattleSettings(
  guildId: string, patch: Partial<BattleSettings>,
): Promise<BattleSettings> {
  await getBattleSettings(guildId); // ensure a row exists
  const [row] = await db.update(battleSettingsTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(battleSettingsTable.guildId, guildId))
    .returning();
  invalidateBattleSettings(guildId);
  return row!;
}

export function invalidateBattleSettings(guildId?: string): void {
  if (guildId) _cache.delete(guildId);
  else _cache.clear();
}

// Is a card's rarity inside the guild's allowed [min, max] window?
export function rarityAllowed(settings: BattleSettings, rarity: Rarity): boolean {
  const r = rarityRank(rarity);
  return r >= rarityRank(settings.minRarity as Rarity)
      && r <= rarityRank(settings.maxRarity as Rarity);
}

export function typeAllowed(settings: BattleSettings, cardType: string): boolean {
  const allow = settings.allowedTypes;
  if (!allow || allow.length === 0) return true;
  return allow.map(t => t.toLowerCase()).includes((cardType ?? "").toLowerCase());
}
