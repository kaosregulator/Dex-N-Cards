import { and, eq, isNull, desc, sql, inArray } from "drizzle-orm";
import {
  db,
  ubLotterySettingsTable,
  ubLotteryPoolsTable,
  ubLotteryTicketsTable,
  ubLotteryDrawsTable,
  ubLotteryScratchersTable,
  type UbLotterySettings,
  type UbLotteryPool,
  type UbLotteryTicket,
  type UbLotteryDraw,
  type UbLotteryScratcher,
} from "@workspace/db";
import {
  DRAW_GAMES,
  SCRATCH_TIERS,
  SCRATCH_TIER_KEYS,
  type DrawGameKey,
  type LotteryGameKey,
  type ScratchTierKey,
} from "./catalog.js";
import { resolveGameConfig } from "./config.js";

/** UTC calendar day key for daily scratch stock restock. */
export function utcDateKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export type ScratchStockState = {
  date: string;
  remaining: Record<ScratchTierKey, number>;
};

function defaultRemaining(): Record<ScratchTierKey, number> {
  return {
    copper: SCRATCH_TIERS.copper.dailyStock,
    silver: SCRATCH_TIERS.silver.dailyStock,
    gold: SCRATCH_TIERS.gold.dailyStock,
    diamond: SCRATCH_TIERS.diamond.dailyStock,
  };
}

/** Read stock, auto-restocking when the UTC day rolls. */
export async function getScratchStock(guildId: string): Promise<ScratchStockState> {
  const settings = await getOrCreateLotterySettings(guildId);
  const scratchCfg = ((settings.gameConfig ?? {}).scratch ?? {}) as Record<string, unknown>;
  const raw = (scratchCfg.scratchStock ?? null) as ScratchStockState | null;
  const today = utcDateKey();
  if (raw && raw.date === today && raw.remaining) {
    const remaining = { ...defaultRemaining(), ...raw.remaining };
    for (const k of SCRATCH_TIER_KEYS) {
      if (typeof remaining[k] !== "number" || remaining[k]! < 0) {
        remaining[k] = SCRATCH_TIERS[k].dailyStock;
      }
    }
    return { date: today, remaining };
  }
  const fresh: ScratchStockState = { date: today, remaining: defaultRemaining() };
  await writeScratchStock(guildId, fresh);
  return fresh;
}

export async function writeScratchStock(guildId: string, stock: ScratchStockState): Promise<void> {
  await patchGameConfig(guildId, "scratch", { scratchStock: stock });
}

/**
 * Atomically consume one unit of daily stock for a tier.
 * Returns remaining after purchase, or soldOut if empty.
 */
export async function consumeScratchStock(
  guildId: string,
  tier: ScratchTierKey,
): Promise<{ remaining: number } | { soldOut: true; remaining: number }> {
  const stock = await getScratchStock(guildId);
  const left = stock.remaining[tier] ?? 0;
  if (left <= 0) return { soldOut: true, remaining: 0 };
  stock.remaining[tier] = left - 1;
  await writeScratchStock(guildId, stock);
  return { remaining: stock.remaining[tier]! };
}

/** Put one unit back (e.g. charge failed after consume). */
export async function restoreScratchStock(
  guildId: string,
  tier: ScratchTierKey,
): Promise<void> {
  const stock = await getScratchStock(guildId);
  const cap = SCRATCH_TIERS[tier].dailyStock;
  stock.remaining[tier] = Math.min(cap, (stock.remaining[tier] ?? 0) + 1);
  await writeScratchStock(guildId, stock);
}

/**
 * Admin restock. Always capped at the tier's dailyStock default.
 * - `default`: set remaining = dailyStock
 * - `add`: remaining = min(dailyStock, remaining + amount)
 */
export async function restockScratchTier(
  guildId: string,
  tier: ScratchTierKey,
  mode: "default" | "add",
  amount = 0,
): Promise<ScratchStockState> {
  const stock = await getScratchStock(guildId);
  const cap = SCRATCH_TIERS[tier].dailyStock;
  if (mode === "default") {
    stock.remaining[tier] = cap;
  } else {
    const add = Math.max(0, Math.floor(amount));
    stock.remaining[tier] = Math.min(cap, (stock.remaining[tier] ?? 0) + add);
  }
  await writeScratchStock(guildId, stock);
  return stock;
}

export type OpenTicketSummary = {
  gameKey: DrawGameKey;
  tickets: number;
  players: number;
  poolAmount: number;
  ticketPrice: number;
};

/** Small pre-draw snapshot: tickets + unique players per draw game. */
export async function summarizeOpenTickets(guildId: string): Promise<OpenTicketSummary[]> {
  await ensurePools(guildId);
  const out: OpenTicketSummary[] = [];
  for (const gameKey of DRAW_GAMES) {
    const tickets = await listOpenTickets(guildId, gameKey);
    const pool = await getPool(guildId, gameKey);
    const players = new Set(tickets.map(t => t.userId)).size;
    out.push({
      gameKey,
      tickets: tickets.length,
      players,
      poolAmount: pool.poolAmount,
      ticketPrice: pool.ticketPrice,
    });
  }
  return out;
}

export async function getOrCreateLotterySettings(guildId: string): Promise<UbLotterySettings> {
  const existing = await db
    .select()
    .from(ubLotterySettingsTable)
    .where(eq(ubLotterySettingsTable.guildId, guildId))
    .limit(1);
  if (existing[0]) return existing[0];
  const [row] = await db
    .insert(ubLotterySettingsTable)
    .values({ guildId })
    .returning();
  return row!;
}

export async function updateLotterySettings(
  guildId: string,
  patch: Partial<{
    enabled: boolean;
    announceChannelId: string | null;
    weeklyDrawDay: number;
    weeklyDrawHourUtc: number;
    lastDrawDate: string | null;
    gameConfig: Record<string, Record<string, unknown>>;
  }>,
): Promise<UbLotterySettings> {
  await getOrCreateLotterySettings(guildId);
  const [row] = await db
    .update(ubLotterySettingsTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(ubLotterySettingsTable.guildId, guildId))
    .returning();
  return row!;
}

export async function ensurePools(guildId: string): Promise<UbLotteryPool[]> {
  const settings = await getOrCreateLotterySettings(guildId);
  const out: UbLotteryPool[] = [];
  for (const key of [...DRAW_GAMES, "scratch"] as LotteryGameKey[]) {
    const cfg = resolveGameConfig(settings, key);
    const seed = cfg.seedJackpot;
    const price = cfg.ticketPrice;

    const existing = await db
      .select()
      .from(ubLotteryPoolsTable)
      .where(and(eq(ubLotteryPoolsTable.guildId, guildId), eq(ubLotteryPoolsTable.gameKey, key)))
      .limit(1);

    if (existing[0]) {
      const [row] = await db
        .update(ubLotteryPoolsTable)
        .set({
          seedAmount: seed,
          ticketPrice: price,
          updatedAt: new Date(),
        })
        .where(eq(ubLotteryPoolsTable.id, existing[0].id))
        .returning();
      out.push(row!);
    } else {
      const [row] = await db
        .insert(ubLotteryPoolsTable)
        .values({
          guildId,
          gameKey: key,
          poolAmount: seed,
          seedAmount: seed,
          ticketPrice: price,
          status: "open",
        })
        .returning();
      out.push(row!);
    }
  }
  return out;
}

/** Merge fields into settings.gameConfig[gameKey]. */
export async function patchGameConfig(
  guildId: string,
  gameKey: LotteryGameKey,
  patch: Record<string, unknown>,
): Promise<UbLotterySettings> {
  const settings = await getOrCreateLotterySettings(guildId);
  const prev = { ...(settings.gameConfig ?? {}) };
  const gamePrev = { ...(prev[gameKey] ?? {}) };
  prev[gameKey] = { ...gamePrev, ...patch };
  return updateLotterySettings(guildId, { gameConfig: prev });
}

export async function getPool(guildId: string, gameKey: string): Promise<UbLotteryPool> {
  await ensurePools(guildId);
  const rows = await db
    .select()
    .from(ubLotteryPoolsTable)
    .where(and(eq(ubLotteryPoolsTable.guildId, guildId), eq(ubLotteryPoolsTable.gameKey, gameKey)))
    .limit(1);
  return rows[0]!;
}

export async function addToPool(guildId: string, gameKey: string, amount: number): Promise<UbLotteryPool> {
  const pool = await getPool(guildId, gameKey);
  const [row] = await db
    .update(ubLotteryPoolsTable)
    .set({
      poolAmount: pool.poolAmount + amount,
      updatedAt: new Date(),
    })
    .where(eq(ubLotteryPoolsTable.id, pool.id))
    .returning();
  return row!;
}

export async function setPoolAmount(guildId: string, gameKey: string, amount: number): Promise<UbLotteryPool> {
  const pool = await getPool(guildId, gameKey);
  const [row] = await db
    .update(ubLotteryPoolsTable)
    .set({ poolAmount: Math.max(0, amount), updatedAt: new Date() })
    .where(eq(ubLotteryPoolsTable.id, pool.id))
    .returning();
  return row!;
}

export async function setPoolStatus(guildId: string, gameKey: string, status: string): Promise<void> {
  await db
    .update(ubLotteryPoolsTable)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(ubLotteryPoolsTable.guildId, guildId), eq(ubLotteryPoolsTable.gameKey, gameKey)));
}

export async function insertTicket(input: {
  guildId: string;
  gameKey: string;
  userId: string;
  numbers: number[];
  powerball?: number | null;
  cost: number;
}): Promise<UbLotteryTicket> {
  const [row] = await db
    .insert(ubLotteryTicketsTable)
    .values({
      guildId: input.guildId,
      gameKey: input.gameKey,
      userId: input.userId,
      numbers: input.numbers,
      powerball: input.powerball ?? null,
      cost: input.cost,
    })
    .returning();
  return row!;
}

export async function listOpenTickets(guildId: string, gameKey: string): Promise<UbLotteryTicket[]> {
  return db
    .select()
    .from(ubLotteryTicketsTable)
    .where(
      and(
        eq(ubLotteryTicketsTable.guildId, guildId),
        eq(ubLotteryTicketsTable.gameKey, gameKey),
        isNull(ubLotteryTicketsTable.drawId),
      ),
    );
}

export async function assignTicketsToDraw(ticketIds: number[], drawId: number): Promise<void> {
  if (ticketIds.length === 0) return;
  await db
    .update(ubLotteryTicketsTable)
    .set({ drawId })
    .where(inArray(ubLotteryTicketsTable.id, ticketIds));
}

export async function markTicketPrize(ticketId: number, prizePaid: number): Promise<void> {
  await db
    .update(ubLotteryTicketsTable)
    .set({ prizePaid })
    .where(eq(ubLotteryTicketsTable.id, ticketId));
}

export async function createDraw(input: {
  guildId: string;
  gameKey: string;
  winningNumbers: number[];
  powerball: number | null;
  poolAtDraw: number;
  channelId?: string | null;
  status?: string;
}): Promise<UbLotteryDraw> {
  const [row] = await db
    .insert(ubLotteryDrawsTable)
    .values({
      guildId: input.guildId,
      gameKey: input.gameKey,
      winningNumbers: input.winningNumbers,
      powerball: input.powerball,
      poolAtDraw: input.poolAtDraw,
      channelId: input.channelId ?? null,
      status: input.status ?? "live",
      drawnAt: new Date(),
    })
    .returning();
  return row!;
}

export async function completeDraw(
  drawId: number,
  winners: Array<Record<string, unknown>>,
  messageId?: string | null,
): Promise<void> {
  await db
    .update(ubLotteryDrawsTable)
    .set({
      status: "complete",
      winners,
      messageId: messageId ?? null,
    })
    .where(eq(ubLotteryDrawsTable.id, drawId));
}

export async function listGuildsDueForWeeklyDraw(
  dayUtc: number,
  hourUtc: number,
  dateKey: string,
): Promise<UbLotterySettings[]> {
  return db
    .select()
    .from(ubLotterySettingsTable)
    .where(
      and(
        eq(ubLotterySettingsTable.enabled, true),
        eq(ubLotterySettingsTable.weeklyDrawDay, dayUtc),
        eq(ubLotterySettingsTable.weeklyDrawHourUtc, hourUtc),
        sql`(${ubLotterySettingsTable.lastDrawDate} IS NULL OR ${ubLotterySettingsTable.lastDrawDate} <> ${dateKey})`,
      ),
    );
}

export async function createScratcher(input: {
  guildId: string;
  userId: string;
  tierKey: ScratchTierKey;
  gameMode: string;
  cost: number;
  prize: number;
  cells: Array<{ label: string; value: number; face?: string; mark?: string }>;
  meta?: Record<string, unknown>;
  publicReveal?: boolean;
}): Promise<UbLotteryScratcher> {
  const [row] = await db
    .insert(ubLotteryScratchersTable)
    .values({
      guildId: input.guildId,
      userId: input.userId,
      tierKey: input.tierKey,
      gameMode: input.gameMode,
      cost: input.cost,
      prize: input.prize,
      cells: input.cells,
      meta: input.meta ?? {},
      publicReveal: input.publicReveal ?? false,
    })
    .returning();
  return row!;
}

export async function updateScratcherMeta(
  id: number,
  meta: Record<string, unknown>,
  prize?: number,
): Promise<UbLotteryScratcher | null> {
  const patch: { meta: Record<string, unknown>; prize?: number } = { meta };
  if (prize != null) patch.prize = prize;
  const [row] = await db
    .update(ubLotteryScratchersTable)
    .set(patch)
    .where(eq(ubLotteryScratchersTable.id, id))
    .returning();
  return row ?? null;
}

export async function getScratcher(id: number): Promise<UbLotteryScratcher | null> {
  const rows = await db
    .select()
    .from(ubLotteryScratchersTable)
    .where(eq(ubLotteryScratchersTable.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function bumpScratchReveal(id: number): Promise<UbLotteryScratcher | null> {
  const s = await getScratcher(id);
  if (!s || s.fullyRevealed) return s;
  const next = Math.min(9, s.revealedCount + 1);
  const [row] = await db
    .update(ubLotteryScratchersTable)
    .set({
      revealedCount: next,
      fullyRevealed: next >= 9,
    })
    .where(eq(ubLotteryScratchersTable.id, id))
    .returning();
  return row ?? null;
}

export async function redeemScratcher(
  id: number,
  redeemTo: "cash" | "bank",
): Promise<UbLotteryScratcher | null> {
  const [row] = await db
    .update(ubLotteryScratchersTable)
    .set({ redeemed: true, redeemTo })
    .where(
      and(
        eq(ubLotteryScratchersTable.id, id),
        eq(ubLotteryScratchersTable.redeemed, false),
        eq(ubLotteryScratchersTable.fullyRevealed, true),
      ),
    )
    .returning();
  return row ?? null;
}

export async function countOpenTickets(guildId: string, gameKey: string): Promise<number> {
  const rows = await listOpenTickets(guildId, gameKey);
  return rows.length;
}

export async function recentDraws(guildId: string, limit = 5): Promise<UbLotteryDraw[]> {
  return db
    .select()
    .from(ubLotteryDrawsTable)
    .where(eq(ubLotteryDrawsTable.guildId, guildId))
    .orderBy(desc(ubLotteryDrawsTable.createdAt))
    .limit(limit);
}

export type { DrawGameKey };
