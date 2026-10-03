// Tatsu local DB helpers (settings, audit, watchlist, snapshots).

import {
  db,
  tatsuSettingsTable,
  tatsuAuditLogTable,
  tatsuWatchlistTable,
  tatsuSnapshotsTable,
  type TatsuSettings,
  type TatsuAuditLog,
  type TatsuWatchlist,
  type TatsuSnapshot,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";

export async function getOrCreateTatsuSettings(guildId: string): Promise<TatsuSettings> {
  const existing = await db.select().from(tatsuSettingsTable).where(eq(tatsuSettingsTable.guildId, guildId)).limit(1);
  if (existing[0]) return existing[0];
  // Always bind Tatsu guild id to the Discord guild running `/tatsu`.
  const [row] = await db.insert(tatsuSettingsTable).values({
    guildId,
    tatsuGuildId: guildId,
  }).returning();
  return row!;
}

export async function updateTatsuSettings(
  guildId: string,
  patch: Partial<Pick<TatsuSettings,
    "tatsuGuildId" | "enabled" | "rankingPeriod" | "logChannelId" | "spamScoreDelta"
  >>,
): Promise<TatsuSettings> {
  await getOrCreateTatsuSettings(guildId);
  const [row] = await db.update(tatsuSettingsTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(tatsuSettingsTable.guildId, guildId))
    .returning();
  return row!;
}

export async function writeTatsuAudit(input: {
  guildId: string;
  actorId: string;
  targetUserId?: string | null;
  action: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(tatsuAuditLogTable).values({
    guildId: input.guildId,
    actorId: input.actorId,
    targetUserId: input.targetUserId ?? null,
    action: input.action,
    detail: input.detail ?? {},
  });
}

export async function listTatsuAudit(guildId: string, limit = 15): Promise<TatsuAuditLog[]> {
  return db.select().from(tatsuAuditLogTable)
    .where(eq(tatsuAuditLogTable.guildId, guildId))
    .orderBy(desc(tatsuAuditLogTable.id))
    .limit(limit);
}

export async function listWatchlist(guildId: string): Promise<TatsuWatchlist[]> {
  return db.select().from(tatsuWatchlistTable)
    .where(eq(tatsuWatchlistTable.guildId, guildId))
    .orderBy(desc(tatsuWatchlistTable.updatedAt));
}

export async function upsertWatchlist(
  guildId: string,
  userId: string,
  flaggedBy: string,
  note?: string | null,
): Promise<TatsuWatchlist> {
  const existing = await db.select().from(tatsuWatchlistTable)
    .where(and(eq(tatsuWatchlistTable.guildId, guildId), eq(tatsuWatchlistTable.userId, userId)))
    .limit(1);
  if (existing[0]) {
    const [row] = await db.update(tatsuWatchlistTable)
      .set({ note: note ?? existing[0].note, flaggedBy, updatedAt: new Date() })
      .where(eq(tatsuWatchlistTable.id, existing[0].id))
      .returning();
    return row!;
  }
  const [row] = await db.insert(tatsuWatchlistTable).values({
    guildId,
    userId,
    flaggedBy,
    note: note ?? null,
  }).returning();
  return row!;
}

export async function removeWatchlist(guildId: string, userId: string): Promise<boolean> {
  const res = await db.delete(tatsuWatchlistTable)
    .where(and(eq(tatsuWatchlistTable.guildId, guildId), eq(tatsuWatchlistTable.userId, userId)))
    .returning({ id: tatsuWatchlistTable.id });
  return res.length > 0;
}

export async function saveSnapshot(input: {
  guildId: string;
  period: string;
  rankings: Array<{ user_id: string; rank: number; score: number }>;
  takenBy?: string | null;
}): Promise<TatsuSnapshot> {
  const [row] = await db.insert(tatsuSnapshotsTable).values({
    guildId: input.guildId,
    period: input.period,
    rankings: input.rankings,
    takenBy: input.takenBy ?? null,
  }).returning();
  return row!;
}

export async function latestSnapshot(guildId: string, period: string): Promise<TatsuSnapshot | null> {
  const rows = await db.select().from(tatsuSnapshotsTable)
    .where(and(eq(tatsuSnapshotsTable.guildId, guildId), eq(tatsuSnapshotsTable.period, period)))
    .orderBy(desc(tatsuSnapshotsTable.id))
    .limit(1);
  return rows[0] ?? null;
}

export async function previousSnapshot(guildId: string, period: string): Promise<TatsuSnapshot | null> {
  const rows = await db.select().from(tatsuSnapshotsTable)
    .where(and(eq(tatsuSnapshotsTable.guildId, guildId), eq(tatsuSnapshotsTable.period, period)))
    .orderBy(desc(tatsuSnapshotsTable.id))
    .limit(2);
  return rows[1] ?? null;
}
