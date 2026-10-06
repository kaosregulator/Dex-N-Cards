import { and, eq } from "drizzle-orm";
import {
  db,
  badgeSettingsTable,
  memberBadgesTable,
  type BadgeSettings,
  type MemberBadges,
  type BadgeRule,
  type BadgeEarned,
} from "@workspace/db";
import { DEFAULT_BADGE_RULES, getBadgeRules } from "./catalog.js";

export async function getOrCreateBadgeSettings(guildId: string): Promise<BadgeSettings> {
  const existing = await db
    .select()
    .from(badgeSettingsTable)
    .where(eq(badgeSettingsTable.guildId, guildId))
    .limit(1);
  if (existing[0]) {
    // Seed defaults once if empty.
    if (!existing[0].badgeRules?.length) {
      const [row] = await db
        .update(badgeSettingsTable)
        .set({ badgeRules: DEFAULT_BADGE_RULES, updatedAt: new Date() })
        .where(eq(badgeSettingsTable.id, existing[0].id))
        .returning();
      return row!;
    }
    return existing[0];
  }
  const [row] = await db
    .insert(badgeSettingsTable)
    .values({ guildId, badgeRules: DEFAULT_BADGE_RULES })
    .returning();
  return row!;
}

export async function updateBadgeSettings(
  guildId: string,
  patch: Partial<{
    enabled: boolean;
    staffRoleId: string | null;
    trackChannelId: string | null;
    tradeChannelId: string | null;
    badgeRules: BadgeRule[];
    maxAttachmentsPerPost: number;
    uploadCooldownSeconds: number;
  }>,
): Promise<BadgeSettings> {
  await getOrCreateBadgeSettings(guildId);
  const [row] = await db
    .update(badgeSettingsTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(badgeSettingsTable.guildId, guildId))
    .returning();
  return row!;
}

export async function getOrCreateMemberBadges(
  guildId: string,
  userId: string,
): Promise<MemberBadges> {
  const existing = await db
    .select()
    .from(memberBadgesTable)
    .where(and(
      eq(memberBadgesTable.guildId, guildId),
      eq(memberBadgesTable.userId, userId),
    ))
    .limit(1);
  if (existing[0]) return existing[0];
  const [row] = await db
    .insert(memberBadgesTable)
    .values({ guildId, userId })
    .returning();
  return row!;
}

export async function saveMemberBadges(
  guildId: string,
  userId: string,
  patch: Partial<{
    earned: BadgeEarned[];
    progress: Record<string, number | string>;
    lastActiveDay: string | null;
    streak: number;
    tradeCooldownUntil: Date | null;
  }>,
): Promise<MemberBadges> {
  await getOrCreateMemberBadges(guildId, userId);
  const [row] = await db
    .update(memberBadgesTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(
      eq(memberBadgesTable.guildId, guildId),
      eq(memberBadgesTable.userId, userId),
    ))
    .returning();
  return row!;
}

export function rulesForGuild(settings: BadgeSettings): BadgeRule[] {
  return getBadgeRules(settings.badgeRules);
}

/**
 * Append any DEFAULT_BADGE_RULES ids the guild is missing.
 * Existing guilds that saved rules before Art Show (etc.) shipped never
 * picked up the new catalogue entries otherwise — awards silently no-op'd.
 */
export async function mergeMissingDefaultBadgeRules(guildId: string): Promise<{
  added: string[];
  settings: BadgeSettings;
}> {
  const settings = await getOrCreateBadgeSettings(guildId);
  const current = getBadgeRules(settings.badgeRules);
  const have = new Set(current.map(r => r.id));
  const missing = DEFAULT_BADGE_RULES.filter(r => !have.has(r.id));
  if (!missing.length) return { added: [], settings };
  const next = getBadgeRules([...current, ...missing]);
  const updated = await updateBadgeSettings(guildId, { badgeRules: next });
  return { added: missing.map(r => r.id), settings: updated };
}
