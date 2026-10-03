/** Game catalog — ticket prices, seeds, number rules, display. */

export type DrawGameKey = "classic" | "powerball" | "mega";
export type LotteryGameKey = DrawGameKey | "scratch";

export type GameDef = {
  key: LotteryGameKey;
  name: string;
  emoji: string;
  blurb: string;
  ticketPrice: number;
  seedJackpot: number;
  /** Main numbers to pick */
  pickCount: number;
  mainMax: number;
  /** Extra ball (powerball / mega) */
  bonusMax: number | null;
  bonusLabel: string | null;
  color: number;
};

export const GAME_DEFS: Record<LotteryGameKey, GameDef> = {
  classic: {
    key: "classic",
    name: "Classic Lottery",
    emoji: "🎟️",
    blurb: "Pick 5 numbers · weekly ball drop · pool jackpot",
    ticketPrice: 250,
    seedJackpot: 15_000,
    pickCount: 5,
    mainMax: 50,
    bonusMax: null,
    bonusLabel: null,
    color: 0x57f287,
  },
  powerball: {
    key: "powerball",
    name: "Powerball",
    emoji: "🔴",
    blurb: "5 whites + Powerball · live weekly reveal",
    ticketPrice: 500,
    seedJackpot: 75_000,
    pickCount: 5,
    mainMax: 69,
    bonusMax: 26,
    bonusLabel: "Powerball",
    color: 0xed4245,
  },
  mega: {
    key: "mega",
    name: "Mega Millionaire",
    emoji: "💎",
    blurb: "5 golds + Mega ball · biggest seed jackpot",
    ticketPrice: 750,
    seedJackpot: 150_000,
    pickCount: 5,
    mainMax: 70,
    bonusMax: 25,
    bonusLabel: "Mega",
    color: 0xfee75c,
  },
  scratch: {
    key: "scratch",
    name: "Scratch Ticket",
    emoji: "🎫",
    blurb: "Instant play · spam Scratch · redeem cash or bank",
    ticketPrice: 100,
    seedJackpot: 5_000,
    pickCount: 0,
    mainMax: 0,
    bonusMax: null,
    bonusLabel: null,
    color: 0xeb459e,
  },
};

export const DRAW_GAMES: DrawGameKey[] = ["classic", "powerball", "mega"];

export function isDrawGame(key: string): key is DrawGameKey {
  return DRAW_GAMES.includes(key as DrawGameKey);
}

export function formatNums(nums: number[], bonus?: number | null, bonusLabel?: string | null): string {
  const main = nums.map(n => `\`${String(n).padStart(2, "0")}\``).join(" · ");
  if (bonus != null && bonusLabel) return `${main}  +  **${bonusLabel}** \`${String(bonus).padStart(2, "0")}\``;
  return main;
}

/** Deterministic-ish prize for a scratcher from ticket cost. */
export function rollScratchPrize(cost: number, poolAvailable: number): number {
  const r = Math.random();
  let prize = 0;
  if (r < 0.55) prize = 0;
  else if (r < 0.80) prize = cost * 2;
  else if (r < 0.92) prize = cost * 5;
  else if (r < 0.98) prize = cost * 15;
  else prize = cost * 50;
  // Never pay more than ~40% of the scratch pool in one ticket.
  const cap = Math.max(0, Math.floor(poolAvailable * 0.4));
  if (cap > 0) prize = Math.min(prize, cap);
  else if (prize > cost * 5) prize = cost * 2; // thin pool: keep small
  return prize;
}

export function buildScratchCells(prize: number, cost: number): Array<{ label: string; value: number }> {
  const cells: Array<{ label: string; value: number }> = [];
  const winCell = Math.floor(Math.random() * 9);
  for (let i = 0; i < 9; i++) {
    if (prize > 0 && i === winCell) {
      cells.push({ label: "WIN", value: prize });
    } else if (prize > 0 && Math.random() < 0.15) {
      cells.push({ label: "WIN", value: prize });
    } else {
      const decoys = [0, 0, 0, Math.floor(cost / 2), cost, cost * 2];
      const v = decoys[Math.floor(Math.random() * decoys.length)]!;
      cells.push({ label: v > 0 ? "TRY" : "—", value: v });
    }
  }
  // Ensure at least one WIN cell shows the real prize when winning.
  if (prize > 0 && !cells.some(c => c.label === "WIN" && c.value === prize)) {
    cells[winCell] = { label: "WIN", value: prize };
  }
  return cells;
}

export type MatchResult = {
  tier: string;
  shareOfPool: number; // 0–1 of pool, or 0 if fixed
  fixedMultiplier: number; // × ticket cost when share is 0
};

/** Score a ticket against drawn numbers. */
export function scoreTicket(
  game: DrawGameKey,
  ticketNums: number[],
  ticketBonus: number | null | undefined,
  winNums: number[],
  winBonus: number | null | undefined,
): MatchResult | null {
  const set = new Set(winNums);
  const matches = ticketNums.filter(n => set.has(n)).length;
  const bonusHit = game !== "classic"
    && ticketBonus != null
    && winBonus != null
    && ticketBonus === winBonus;

  if (game === "classic") {
    if (matches === 5) return { tier: "Jackpot", shareOfPool: 1, fixedMultiplier: 0 };
    if (matches === 4) return { tier: "4 matches", shareOfPool: 0.12, fixedMultiplier: 0 };
    if (matches === 3) return { tier: "3 matches", shareOfPool: 0, fixedMultiplier: 5 };
    return null;
  }

  // Powerball / Mega
  if (matches === 5 && bonusHit) return { tier: "JACKPOT", shareOfPool: 1, fixedMultiplier: 0 };
  if (matches === 5) return { tier: "5 white", shareOfPool: 0.18, fixedMultiplier: 0 };
  if (matches === 4 && bonusHit) return { tier: "4 + bonus", shareOfPool: 0.08, fixedMultiplier: 0 };
  if (matches === 4) return { tier: "4 white", shareOfPool: 0, fixedMultiplier: 20 };
  if (matches === 3 && bonusHit) return { tier: "3 + bonus", shareOfPool: 0, fixedMultiplier: 15 };
  if (matches === 3) return { tier: "3 white", shareOfPool: 0, fixedMultiplier: 5 };
  if (bonusHit && matches >= 1) return { tier: "bonus + hits", shareOfPool: 0, fixedMultiplier: 3 };
  if (bonusHit) return { tier: "bonus only", shareOfPool: 0, fixedMultiplier: 2 };
  return null;
}

export function drawWinningNumbers(game: DrawGameKey): { numbers: number[]; bonus: number | null } {
  const def = GAME_DEFS[game];
  const nums: number[] = [];
  while (nums.length < def.pickCount) {
    const n = 1 + Math.floor(Math.random() * def.mainMax);
    if (!nums.includes(n)) nums.push(n);
  }
  nums.sort((a, b) => a - b);
  const bonus = def.bonusMax != null ? 1 + Math.floor(Math.random() * def.bonusMax) : null;
  return { numbers: nums, bonus };
}
