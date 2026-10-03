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
    name: "Scratch Shop",
    emoji: "🎫",
    blurb: "Pick a tier · daily stock · public or private scratch",
    ticketPrice: 250,
    seedJackpot: 5_000,
    pickCount: 0,
    mainMax: 0,
    bonusMax: null,
    bonusLabel: null,
    color: 0xeb459e,
  },
};

/** Scratcher tiers — prices + daily stock (UTC restock). */
export type ScratchTierKey = "copper" | "silver" | "gold" | "diamond";

export type ScratchTierDef = {
  key: ScratchTierKey;
  name: string;
  emoji: string;
  price: number;
  dailyStock: number;
  /** Soft max multiplier vs ticket cost for top prize. */
  maxMult: number;
  color: number;
  blurb: string;
  canvas: {
    bg0: string;
    bg1: string;
    accent: string;
    foil0: number;
    foil1: number;
    title: string;
  };
};

export const SCRATCH_TIERS: Record<ScratchTierKey, ScratchTierDef> = {
  copper: {
    key: "copper",
    name: "Copper Scratch",
    emoji: "🟤",
    price: 50,
    dailyStock: 80,
    maxMult: 20,
    color: 0xb87333,
    blurb: "Cheap thrills · frequent small hits",
    canvas: {
      bg0: "#2a1810",
      bg1: "#1a120c",
      accent: "#cd7f32",
      foil0: 25,
      foil1: 40,
      title: "COPPER SCRATCH",
    },
  },
  silver: {
    key: "silver",
    name: "Silver Scratch",
    emoji: "⚪",
    price: 250,
    dailyStock: 50,
    maxMult: 30,
    color: 0xc0c0c0,
    blurb: "Mid-tier foil · solid odds",
    canvas: {
      bg0: "#1a1e28",
      bg1: "#0e1218",
      accent: "#c0c8d4",
      foil0: 210,
      foil1: 230,
      title: "SILVER SCRATCH",
    },
  },
  gold: {
    key: "gold",
    name: "Gold Scratch",
    emoji: "🟡",
    price: 1_000,
    dailyStock: 25,
    maxMult: 40,
    color: 0xffc857,
    blurb: "Premium ticket · bigger wins",
    canvas: {
      bg0: "#2a2010",
      bg1: "#14100a",
      accent: "#ffc857",
      foil0: 45,
      foil1: 55,
      title: "GOLD SCRATCH",
    },
  },
  diamond: {
    key: "diamond",
    name: "Diamond Scratch",
    emoji: "💎",
    price: 5_000,
    dailyStock: 10,
    maxMult: 50,
    color: 0x67e8f9,
    blurb: "High roller · rare stock · huge caps",
    canvas: {
      bg0: "#0a1a28",
      bg1: "#061018",
      accent: "#67e8f9",
      foil0: 190,
      foil1: 210,
      title: "DIAMOND SCRATCH",
    },
  },
};

export const SCRATCH_TIER_KEYS: ScratchTierKey[] = ["copper", "silver", "gold", "diamond"];

export function isScratchTier(key: string): key is ScratchTierKey {
  return SCRATCH_TIER_KEYS.includes(key as ScratchTierKey);
}

export const DRAW_GAMES: DrawGameKey[] = ["classic", "powerball", "mega"];

export function isDrawGame(key: string): key is DrawGameKey {
  return DRAW_GAMES.includes(key as DrawGameKey);
}

export function formatNums(nums: number[], bonus?: number | null, bonusLabel?: string | null): string {
  const main = nums.map(n => `\`${String(n).padStart(2, "0")}\``).join(" · ");
  if (bonus != null && bonusLabel) return `${main}  +  **${bonusLabel}** \`${String(bonus).padStart(2, "0")}\``;
  return main;
}

/** Instant prize from ticket cost (+ optional tier max multiplier). */
export function rollScratchPrize(
  cost: number,
  poolAvailable: number,
  maxMult = 50,
): number {
  const r = Math.random();
  let prize = 0;
  if (r < 0.52) prize = 0;
  else if (r < 0.78) prize = cost * 2;
  else if (r < 0.90) prize = cost * 5;
  else if (r < 0.97) prize = cost * Math.min(15, maxMult);
  else prize = cost * Math.min(maxMult, 50);
  // Never pay more than ~40% of the scratch pool in one ticket.
  const cap = Math.max(0, Math.floor(poolAvailable * 0.4));
  if (cap > 0) prize = Math.min(prize, cap);
  else if (prize > cost * 5) prize = cost * 2; // thin pool: keep small
  return prize;
}

export function rollScratchPrizeForTier(
  tier: ScratchTierKey,
  poolAvailable: number,
): number {
  const def = SCRATCH_TIERS[tier];
  return rollScratchPrize(def.price, poolAvailable, def.maxMult);
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
