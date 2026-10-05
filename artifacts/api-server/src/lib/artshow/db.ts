/** Art Show persistence helpers. */

import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  artshowSettingsTable,
  artshowPiecesTable,
  artshowVotesTable,
  artshowWalletsTable,
  artshowFameTable,
  type ArtshowSettings,
  type ArtshowPiece,
  type ArtshowWallet,
  type ArtshowFame,
} from "@workspace/db";
import { utcDayKey, utcWeekKey } from "./time.js";

export { utcDayKey, utcWeekKey };

export async function getOrCreateArtshowSettings(guildId: string): Promise<ArtshowSettings> {
  const [existing] = await db
    .select()
    .from(artshowSettingsTable)
    .where(eq(artshowSettingsTable.guildId, guildId))
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(artshowSettingsTable)
    .values({ guildId })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [again] = await db
    .select()
    .from(artshowSettingsTable)
    .where(eq(artshowSettingsTable.guildId, guildId))
    .limit(1);
  return again!;
}

export async function updateArtshowSettings(
  guildId: string,
  patch: Partial<Omit<ArtshowSettings, "id" | "guildId" | "createdAt">>,
): Promise<ArtshowSettings> {
  await getOrCreateArtshowSettings(guildId);
  const [row] = await db
    .update(artshowSettingsTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(artshowSettingsTable.guildId, guildId))
    .returning();
  return row!;
}

export async function insertPiece(opts: {
  guildId: string;
  authorId: string;
  title: string;
  description: string;
  imageUrl: string;
  orientation: string;
  channelId: string;
  weekKey?: string;
}): Promise<ArtshowPiece> {
  const [row] = await db.insert(artshowPiecesTable).values({
    guildId: opts.guildId,
    authorId: opts.authorId,
    title: opts.title.slice(0, 80),
    description: opts.description.slice(0, 400),
    imageUrl: opts.imageUrl,
    orientation: opts.orientation,
    channelId: opts.channelId,
    weekKey: opts.weekKey ?? utcWeekKey(),
  }).returning();
  return row!;
}

export async function setPieceMessage(pieceId: number, messageId: string): Promise<void> {
  await db.update(artshowPiecesTable)
    .set({ messageId, updatedAt: new Date() })
    .where(eq(artshowPiecesTable.id, pieceId));
}

export async function getPiece(pieceId: number): Promise<ArtshowPiece | null> {
  const [row] = await db.select().from(artshowPiecesTable)
    .where(eq(artshowPiecesTable.id, pieceId)).limit(1);
  return row ?? null;
}

export async function listPiecesByAuthor(guildId: string, authorId: string, limit = 20): Promise<ArtshowPiece[]> {
  return db.select().from(artshowPiecesTable)
    .where(and(eq(artshowPiecesTable.guildId, guildId), eq(artshowPiecesTable.authorId, authorId)))
    .orderBy(desc(artshowPiecesTable.createdAt))
    .limit(limit);
}

export async function topPieces(guildId: string, opts?: {
  weekKey?: string;
  limit?: number;
}): Promise<ArtshowPiece[]> {
  const limit = opts?.limit ?? 10;
  if (opts?.weekKey) {
    return db.select().from(artshowPiecesTable)
      .where(and(eq(artshowPiecesTable.guildId, guildId), eq(artshowPiecesTable.weekKey, opts.weekKey)))
      .orderBy(desc(artshowPiecesTable.votes), desc(artshowPiecesTable.createdAt))
      .limit(limit);
  }
  return db.select().from(artshowPiecesTable)
    .where(eq(artshowPiecesTable.guildId, guildId))
    .orderBy(desc(artshowPiecesTable.votes), desc(artshowPiecesTable.createdAt))
    .limit(limit);
}

export async function countAuthorSubmits(guildId: string, authorId: string): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` })
    .from(artshowPiecesTable)
    .where(and(eq(artshowPiecesTable.guildId, guildId), eq(artshowPiecesTable.authorId, authorId)));
  return Number(row?.n ?? 0);
}

export async function countVotesCast(guildId: string, voterId: string): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` })
    .from(artshowVotesTable)
    .where(and(eq(artshowVotesTable.guildId, guildId), eq(artshowVotesTable.voterId, voterId)));
  return Number(row?.n ?? 0);
}

export async function countAuthorCrowns(guildId: string, authorId: string): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` })
    .from(artshowFameTable)
    .where(and(eq(artshowFameTable.guildId, guildId), eq(artshowFameTable.authorId, authorId)));
  return Number(row?.n ?? 0);
}

/** Ensure wallet is for today; apply timed +1 refreshes. */
export async function getOrRefreshWallet(
  guildId: string,
  userId: string,
  settings: ArtshowSettings,
): Promise<ArtshowWallet> {
  const day = utcDayKey();
  const [existing] = await db.select().from(artshowWalletsTable)
    .where(and(eq(artshowWalletsTable.guildId, guildId), eq(artshowWalletsTable.userId, userId)))
    .limit(1);

  const refreshMs = Math.max(1, settings.voteRefreshHours) * 3600_000;
  const now = new Date();

  if (!existing) {
    const [created] = await db.insert(artshowWalletsTable).values({
      guildId,
      userId,
      dayKey: day,
      remaining: settings.votesPerDay,
      earnedBonus: 0,
      freeBumps: 0,
      lastRefreshAt: now,
    }).onConflictDoNothing().returning();
    if (created) return created;
    const [again] = await db.select().from(artshowWalletsTable)
      .where(and(eq(artshowWalletsTable.guildId, guildId), eq(artshowWalletsTable.userId, userId)))
      .limit(1);
    return again!;
  }

  let remaining = existing.remaining;
  let earnedBonus = existing.earnedBonus;
  let freeBumps = existing.freeBumps;
  let lastRefreshAt = existing.lastRefreshAt;
  let dayKey = existing.dayKey;

  if (dayKey !== day) {
    // New UTC day — reset base allowance; keep unused earned bonus capped.
    remaining = settings.votesPerDay + Math.min(earnedBonus, settings.votesPerDay);
    earnedBonus = 0;
    freeBumps = 0;
    dayKey = day;
    lastRefreshAt = now;
  } else {
    // Timed refresh: +1 every voteRefreshHours, up to votesPerDay + earnedBonus
    const elapsed = now.getTime() - new Date(lastRefreshAt).getTime();
    if (elapsed >= refreshMs) {
      const ticks = Math.floor(elapsed / refreshMs);
      const cap = settings.votesPerDay + earnedBonus;
      remaining = Math.min(cap, remaining + ticks);
      lastRefreshAt = new Date(new Date(lastRefreshAt).getTime() + ticks * refreshMs);
    }
  }

  const [updated] = await db.update(artshowWalletsTable)
    .set({ dayKey, remaining, earnedBonus, freeBumps, lastRefreshAt, updatedAt: now })
    .where(eq(artshowWalletsTable.id, existing.id))
    .returning();
  return updated!;
}

export async function grantSubmitBonus(
  guildId: string,
  userId: string,
  settings: ArtshowSettings,
): Promise<ArtshowWallet> {
  const wallet = await getOrRefreshWallet(guildId, userId, settings);
  const bonus = Math.max(0, settings.bonusVotesOnSubmit);
  const [updated] = await db.update(artshowWalletsTable)
    .set({
      remaining: wallet.remaining + bonus,
      earnedBonus: wallet.earnedBonus + bonus,
      updatedAt: new Date(),
    })
    .where(eq(artshowWalletsTable.id, wallet.id))
    .returning();
  return updated!;
}

export async function spendVote(
  guildId: string,
  voterId: string,
  pieceId: number,
  settings: ArtshowSettings,
): Promise<{ ok: true; wallet: ArtshowWallet; piece: ArtshowPiece } | { ok: false; reason: string }> {
  const piece = await getPiece(pieceId);
  if (!piece || piece.guildId !== guildId) return { ok: false, reason: "Piece not found." };
  if (piece.authorId === voterId) return { ok: false, reason: "You can't vote on your own piece." };

  const wallet = await getOrRefreshWallet(guildId, voterId, settings);
  if (wallet.remaining <= 0) {
    return {
      ok: false,
      reason: `Out of votes today. Submit art (+${settings.bonusVotesOnSubmit}) or wait ~${settings.voteRefreshHours}h for a refresh.`,
    };
  }

  try {
    await db.insert(artshowVotesTable).values({
      guildId,
      pieceId,
      voterId,
    });
  } catch {
    return { ok: false, reason: "You already voted for this piece." };
  }

  const [updatedPiece] = await db.update(artshowPiecesTable)
    .set({ votes: sql`${artshowPiecesTable.votes} + 1`, updatedAt: new Date() })
    .where(eq(artshowPiecesTable.id, pieceId))
    .returning();

  const [updatedWallet] = await db.update(artshowWalletsTable)
    .set({ remaining: wallet.remaining - 1, updatedAt: new Date() })
    .where(eq(artshowWalletsTable.id, wallet.id))
    .returning();

  return { ok: true, wallet: updatedWallet!, piece: updatedPiece! };
}

export async function spendBump(
  guildId: string,
  userId: string,
  pieceId: number,
  settings: ArtshowSettings,
): Promise<{ ok: true; wallet: ArtshowWallet; piece: ArtshowPiece; usedFree: boolean } | { ok: false; reason: string }> {
  const piece = await getPiece(pieceId);
  if (!piece || piece.guildId !== guildId) return { ok: false, reason: "Piece not found." };
  if (piece.authorId !== userId) return { ok: false, reason: "Only the artist can bump their piece." };

  const wallet = await getOrRefreshWallet(guildId, userId, settings);
  let usedFree = false;
  if (wallet.freeBumps > 0) {
    usedFree = true;
    const [updatedWallet] = await db.update(artshowWalletsTable)
      .set({ freeBumps: wallet.freeBumps - 1, updatedAt: new Date() })
      .where(eq(artshowWalletsTable.id, wallet.id))
      .returning();
    const [updatedPiece] = await db.update(artshowPiecesTable)
      .set({ bumpedAt: new Date(), updatedAt: new Date() })
      .where(eq(artshowPiecesTable.id, pieceId))
      .returning();
    return { ok: true, wallet: updatedWallet!, piece: updatedPiece!, usedFree };
  }

  const cost = Math.max(1, settings.bumpCostVotes);
  if (wallet.remaining < cost) {
    return {
      ok: false,
      reason: `Bump costs **${cost}** votes (you have **${wallet.remaining}**). Earn Rising Artist for a free daily bump.`,
    };
  }

  const [updatedWallet] = await db.update(artshowWalletsTable)
    .set({ remaining: wallet.remaining - cost, updatedAt: new Date() })
    .where(eq(artshowWalletsTable.id, wallet.id))
    .returning();
  const [updatedPiece] = await db.update(artshowPiecesTable)
    .set({ bumpedAt: new Date(), updatedAt: new Date() })
    .where(eq(artshowPiecesTable.id, pieceId))
    .returning();
  return { ok: true, wallet: updatedWallet!, piece: updatedPiece!, usedFree: false };
}

export async function grantFreeBump(guildId: string, userId: string, settings: ArtshowSettings): Promise<void> {
  const wallet = await getOrRefreshWallet(guildId, userId, settings);
  if (wallet.freeBumps > 0) return;
  await db.update(artshowWalletsTable)
    .set({ freeBumps: 1, updatedAt: new Date() })
    .where(eq(artshowWalletsTable.id, wallet.id));
}

export async function getFame(guildId: string, weekKey: string): Promise<ArtshowFame | null> {
  const [row] = await db.select().from(artshowFameTable)
    .where(and(eq(artshowFameTable.guildId, guildId), eq(artshowFameTable.weekKey, weekKey)))
    .limit(1);
  return row ?? null;
}

export async function listFame(guildId: string, limit = 12): Promise<ArtshowFame[]> {
  return db.select().from(artshowFameTable)
    .where(eq(artshowFameTable.guildId, guildId))
    .orderBy(desc(artshowFameTable.crownedAt))
    .limit(limit);
}

export async function crownPiece(opts: {
  guildId: string;
  piece: ArtshowPiece;
  weekKey?: string;
}): Promise<ArtshowFame> {
  const weekKey = opts.weekKey ?? opts.piece.weekKey;
  const existing = await getFame(opts.guildId, weekKey);
  if (existing) return existing;

  const [row] = await db.insert(artshowFameTable).values({
    guildId: opts.guildId,
    pieceId: opts.piece.id,
    authorId: opts.piece.authorId,
    weekKey,
    votesAtCrown: opts.piece.votes,
    title: opts.piece.title,
    imageUrl: opts.piece.imageUrl,
  }).onConflictDoNothing().returning();

  if (row) return row;
  return (await getFame(opts.guildId, weekKey))!;
}
