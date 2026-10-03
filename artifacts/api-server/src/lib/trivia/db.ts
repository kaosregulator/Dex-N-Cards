import {
  db,
  triviaSettingsTable,
  triviaRoundsTable,
  triviaGuessesTable,
  triviaRoleHoldsTable,
  type TriviaSettings,
  type TriviaRound,
  type TriviaGuess,
  type TriviaRoleHold,
} from "@workspace/db";
import { and, asc, desc, eq, lte, sql } from "drizzle-orm";

export async function getOrCreateTriviaSettings(guildId: string): Promise<TriviaSettings> {
  const existing = await db.select().from(triviaSettingsTable).where(eq(triviaSettingsTable.guildId, guildId)).limit(1);
  if (existing[0]) return existing[0];
  const [row] = await db.insert(triviaSettingsTable).values({ guildId }).returning();
  return row!;
}

export async function updateTriviaSettings(
  guildId: string,
  patch: Partial<Pick<TriviaSettings,
    | "enabled" | "audience" | "defaultSource" | "defaultCategory" | "defaultGuessMode"
    | "qotdEnabled" | "qotdChannelId" | "qotdHourUtc" | "qotdSource" | "qotdCategory"
    | "nextCard" | "roleIds" | "lastQotdDate"
  >>,
): Promise<TriviaSettings> {
  await getOrCreateTriviaSettings(guildId);
  const [row] = await db.update(triviaSettingsTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(triviaSettingsTable.guildId, guildId))
    .returning();
  return row!;
}

export async function createTriviaRound(input: {
  guildId: string;
  channelId: string;
  mode: string;
  status?: string;
  source: string;
  guessMode: string;
  question: Record<string, unknown>;
  answerNorm: string;
  hostId: string;
  messageId?: string | null;
}): Promise<TriviaRound> {
  const [row] = await db.insert(triviaRoundsTable).values({
    guildId: input.guildId,
    channelId: input.channelId,
    mode: input.mode,
    status: input.status ?? "ready",
    source: input.source,
    guessMode: input.guessMode,
    question: input.question,
    answerNorm: input.answerNorm,
    hostId: input.hostId,
    messageId: input.messageId ?? null,
  }).returning();
  return row!;
}

export async function getTriviaRound(id: number): Promise<TriviaRound | null> {
  const rows = await db.select().from(triviaRoundsTable).where(eq(triviaRoundsTable.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function updateTriviaRound(
  id: number,
  patch: Partial<Pick<TriviaRound,
    "status" | "messageId" | "winners" | "winnerMessageId" | "cleanupAt" | "startedAt" | "endedAt" | "question" | "answerNorm"
  >>,
): Promise<TriviaRound> {
  const [row] = await db.update(triviaRoundsTable)
    .set(patch)
    .where(eq(triviaRoundsTable.id, id))
    .returning();
  return row!;
}

export async function listLiveRounds(guildId: string): Promise<TriviaRound[]> {
  return db.select().from(triviaRoundsTable)
    .where(and(eq(triviaRoundsTable.guildId, guildId), eq(triviaRoundsTable.status, "live")))
    .orderBy(desc(triviaRoundsTable.id));
}

export async function findLiveRoundInChannel(guildId: string, channelId: string): Promise<TriviaRound | null> {
  const rows = await db.select().from(triviaRoundsTable)
    .where(and(
      eq(triviaRoundsTable.guildId, guildId),
      eq(triviaRoundsTable.channelId, channelId),
      eq(triviaRoundsTable.status, "live"),
    ))
    .orderBy(desc(triviaRoundsTable.id))
    .limit(1);
  return rows[0] ?? null;
}

export async function recordTriviaGuess(input: {
  roundId: number;
  guildId: string;
  userId: string;
  guess: string;
  correct: boolean;
}): Promise<{ guess: TriviaGuess; firstForUser: boolean }> {
  const existing = await db.select().from(triviaGuessesTable)
    .where(and(
      eq(triviaGuessesTable.roundId, input.roundId),
      eq(triviaGuessesTable.userId, input.userId),
    ))
    .limit(1);
  if (existing[0]) {
    return { guess: existing[0], firstForUser: false };
  }
  const [row] = await db.insert(triviaGuessesTable).values({
    roundId: input.roundId,
    guildId: input.guildId,
    userId: input.userId,
    guess: input.guess,
    correct: input.correct,
  }).returning();
  return { guess: row!, firstForUser: true };
}

export async function listCorrectGuessers(roundId: number): Promise<TriviaGuess[]> {
  return db.select().from(triviaGuessesTable)
    .where(and(eq(triviaGuessesTable.roundId, roundId), eq(triviaGuessesTable.correct, true)))
    .orderBy(asc(triviaGuessesTable.id));
}

export async function listFirstGuesser(roundId: number): Promise<TriviaGuess | null> {
  const rows = await db.select().from(triviaGuessesTable)
    .where(eq(triviaGuessesTable.roundId, roundId))
    .orderBy(asc(triviaGuessesTable.id))
    .limit(1);
  return rows[0] ?? null;
}

export async function listDueCleanupRounds(now = new Date()): Promise<TriviaRound[]> {
  return db.select().from(triviaRoundsTable)
    .where(and(
      eq(triviaRoundsTable.status, "ended"),
      lte(triviaRoundsTable.cleanupAt, now),
    ))
    .limit(20);
}

export async function listExpiredRoleHolds(now = new Date()): Promise<TriviaRoleHold[]> {
  return db.select().from(triviaRoleHoldsTable)
    .where(lte(triviaRoleHoldsTable.expiresAt, now))
    .limit(50);
}

export async function addRoleHold(input: {
  guildId: string;
  userId: string;
  roleId: string;
  roleKey: string;
  roundId?: number | null;
  expiresAt: Date;
}): Promise<TriviaRoleHold> {
  const [row] = await db.insert(triviaRoleHoldsTable).values({
    guildId: input.guildId,
    userId: input.userId,
    roleId: input.roleId,
    roleKey: input.roleKey,
    roundId: input.roundId ?? null,
    expiresAt: input.expiresAt,
  }).returning();
  return row!;
}

export async function deleteRoleHold(id: number): Promise<void> {
  await db.delete(triviaRoleHoldsTable).where(eq(triviaRoleHoldsTable.id, id));
}

export async function clearRoleHoldsForKey(guildId: string, roleKey: string): Promise<TriviaRoleHold[]> {
  const rows = await db.select().from(triviaRoleHoldsTable)
    .where(and(eq(triviaRoleHoldsTable.guildId, guildId), eq(triviaRoleHoldsTable.roleKey, roleKey)));
  if (rows.length) {
    await db.delete(triviaRoleHoldsTable)
      .where(and(eq(triviaRoleHoldsTable.guildId, guildId), eq(triviaRoleHoldsTable.roleKey, roleKey)));
  }
  return rows;
}

export async function listGuildsNeedingQotd(hourUtc: number, dateKey: string): Promise<TriviaSettings[]> {
  return db.select().from(triviaSettingsTable)
    .where(and(
      eq(triviaSettingsTable.qotdEnabled, true),
      eq(triviaSettingsTable.enabled, true),
      eq(triviaSettingsTable.qotdHourUtc, hourUtc),
      sql`(${triviaSettingsTable.lastQotdDate} IS NULL OR ${triviaSettingsTable.lastQotdDate} <> ${dateKey})`,
    ));
}
