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

/** Per-tier mini-game style. */
export type ScratchGameMode = "classic" | "numbers" | "connect" | "pick3";

export type ScratchCell = {
  label: string;
  value: number;
  /** Optional face (number string / symbol) for special modes. */
  face?: string;
  /** Semantic mark for rendering / scoring. */
  mark?: "win" | "try" | "miss" | "match" | "line" | "pick";
};

export type ScratchTicketBuild = {
  gameMode: ScratchGameMode;
  cells: ScratchCell[];
  prize: number;
  meta: Record<string, unknown>;
};

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
  gameMode: ScratchGameMode;
  gameLabel: string;
  howTo: string;
  canvas: {
    bg0: string;
    bg1: string;
    accent: string;
    foil0: number;
    foil1: number;
    title: string;
  };
};

/** Player-facing legend for classic / shared language. */
export const SCRATCH_LEGEND = [
  { mark: "WIN", meaning: "Cash prize on this ticket — redeem after reveal." },
  { mark: "TRY", meaning: "Tease amount only — looks hot, does not pay." },
  { mark: "MISS", meaning: "Blank cell — no value." },
  { mark: "MATCH", meaning: "Lucky Numbers — hits the target number." },
  { mark: "LINE", meaning: "Connect 3 — part of a 3-in-a-row win." },
  { mark: "PICK", meaning: "Pick 3 — choose three cells; their values bank." },
] as const;

export const SCRATCH_TIERS: Record<ScratchTierKey, ScratchTierDef> = {
  copper: {
    key: "copper",
    name: "Copper Classic",
    emoji: "🟤",
    price: 50,
    dailyStock: 80,
    maxMult: 20,
    color: 0xb87333,
    blurb: "Classic foil · WIN / TRY / MISS",
    gameMode: "classic",
    gameLabel: "Classic",
    howTo: "Peel all 9. **WIN** pays · **TRY** teases · **MISS** is blank.",
    canvas: {
      bg0: "#2a1810",
      bg1: "#1a120c",
      accent: "#cd7f32",
      foil0: 25,
      foil1: 40,
      title: "COPPER CLASSIC",
    },
  },
  silver: {
    key: "silver",
    name: "Lucky Numbers",
    emoji: "🔢",
    price: 250,
    dailyStock: 50,
    maxMult: 30,
    color: 0xc0c0c0,
    blurb: "Match the lucky number · vast number space",
    gameMode: "numbers",
    gameLabel: "Numbers",
    howTo: "Match the **lucky number** on any cell to cash the prize.",
    canvas: {
      bg0: "#1a1e28",
      bg1: "#0e1218",
      accent: "#c0c8d4",
      foil0: 210,
      foil1: 230,
      title: "LUCKY NUMBERS",
    },
  },
  gold: {
    key: "gold",
    name: "Connect Three",
    emoji: "🟡",
    price: 1_000,
    dailyStock: 25,
    maxMult: 40,
    color: 0xffc857,
    blurb: "3-in-a-row symbols · Connect style",
    gameMode: "connect",
    gameLabel: "Connect 3",
    howTo: "Get **3 matching symbols in a row** (row, column, or diagonal).",
    canvas: {
      bg0: "#2a2010",
      bg1: "#14100a",
      accent: "#ffc857",
      foil0: 45,
      foil1: 55,
      title: "CONNECT THREE",
    },
  },
  diamond: {
    key: "diamond",
    name: "Pick Three",
    emoji: "💎",
    price: 5_000,
    dailyStock: 10,
    maxMult: 50,
    color: 0x67e8f9,
    blurb: "Reveal all · pick any 3 cells to bank",
    gameMode: "pick3",
    gameLabel: "Pick 3",
    howTo: "Peel all 9, then **pick 3 cells** — their values add up (capped).",
    canvas: {
      bg0: "#0a1a28",
      bg1: "#061018",
      accent: "#67e8f9",
      foil0: 190,
      foil1: 210,
      title: "PICK THREE",
    },
  },
};

export const SCRATCH_TIER_KEYS: ScratchTierKey[] = ["copper", "silver", "gold", "diamond"];

export function isScratchTier(key: string): key is ScratchTierKey {
  return SCRATCH_TIER_KEYS.includes(key as ScratchTierKey);
}

/**
 * Vast random positive integer for number-scratch faces.
 * Not limited to a tiny face pool — ~1e12 unique possibilities.
 */
export function rollVastNumber(): number {
  const a = Math.floor(Math.random() * 1_000_000);
  const b = Math.floor(Math.random() * 1_000_000);
  return a * 1_000_000 + b + 1; // 1 … 1_000_000_000_000
}

const CONNECT_FACES = ["⭐", "💎", "🔔", "🍒", "7️⃣"] as const;

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

export function buildScratchCells(prize: number, cost: number): ScratchCell[] {
  const cells: ScratchCell[] = [];
  const winCell = Math.floor(Math.random() * 9);
  for (let i = 0; i < 9; i++) {
    if (prize > 0 && i === winCell) {
      cells.push({ label: "WIN", value: prize, mark: "win" });
    } else if (prize > 0 && Math.random() < 0.15) {
      cells.push({ label: "WIN", value: prize, mark: "win" });
    } else {
      const decoys = [0, 0, 0, Math.floor(cost / 2), cost, cost * 2];
      const v = decoys[Math.floor(Math.random() * decoys.length)]!;
      cells.push({
        label: v > 0 ? "TRY" : "MISS",
        value: v,
        mark: v > 0 ? "try" : "miss",
      });
    }
  }
  if (prize > 0 && !cells.some(c => c.mark === "win" && c.value === prize)) {
    cells[winCell] = { label: "WIN", value: prize, mark: "win" };
  }
  return cells;
}

function buildNumbersTicket(prize: number, cost: number): ScratchTicketBuild {
  const lucky = rollVastNumber();
  const cells: ScratchCell[] = [];
  let matchIdx = prize > 0 ? Math.floor(Math.random() * 9) : -1;
  for (let i = 0; i < 9; i++) {
    if (i === matchIdx) {
      cells.push({
        label: "MATCH",
        value: prize,
        face: String(lucky),
        mark: "match",
      });
    } else {
      let n = rollVastNumber();
      // Astronomically unlikely collision; still force uniqueness vs lucky.
      while (n === lucky) n = rollVastNumber();
      const tease = Math.random() < 0.25 ? Math.floor(cost * (1 + Math.random() * 2)) : 0;
      cells.push({
        label: tease > 0 ? "TRY" : "MISS",
        value: tease,
        face: String(n),
        mark: tease > 0 ? "try" : "miss",
      });
    }
  }
  return {
    gameMode: "numbers",
    cells,
    prize,
    meta: { luckyNumber: lucky },
  };
}

function lineIndices(): number[][] {
  return [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ];
}

function buildConnectTicket(prize: number, cost: number): ScratchTicketBuild {
  const faces = [...CONNECT_FACES];
  const grid: string[] = Array.from({ length: 9 }, () =>
    faces[Math.floor(Math.random() * faces.length)]!,
  );
  let winLine: number[] | null = null;
  if (prize > 0) {
    winLine = lineIndices()[Math.floor(Math.random() * 8)]!;
    const face = faces[Math.floor(Math.random() * faces.length)]!;
    for (const i of winLine) grid[i] = face;
    // Break other accidental lines lightly
    for (const line of lineIndices()) {
      if (line === winLine) continue;
      if (line.every(i => grid[i] === face)) {
        const j = line.find(i => !winLine!.includes(i));
        if (j != null) {
          grid[j] = faces.find(f => f !== face) ?? "🍒";
        }
      }
    }
  } else {
    // Ensure no complete line on a losing ticket.
    for (const line of lineIndices()) {
      const f0 = grid[line[0]!]!;
      if (line.every(i => grid[i] === f0)) {
        grid[line[2]!] = faces.find(f => f !== f0) ?? "🍒";
      }
    }
  }
  const cells: ScratchCell[] = grid.map((face, i) => {
    const onLine = winLine?.includes(i) ?? false;
    return {
      label: onLine ? "LINE" : (Math.random() < 0.2 ? "TRY" : "MISS"),
      value: onLine ? prize : (Math.random() < 0.2 ? Math.floor(cost / 2) : 0),
      face,
      mark: onLine ? "line" : "miss",
    };
  });
  return {
    gameMode: "connect",
    cells,
    prize,
    meta: { winLine },
  };
}

function buildPick3Ticket(prize: number, cost: number): ScratchTicketBuild {
  // Distribute value across cells; top-3 sum ≈ prize when winning.
  const cells: ScratchCell[] = [];
  const weights = Array.from({ length: 9 }, () => Math.random());
  const sumW = weights.reduce((a, b) => a + b, 0) || 1;
  let allocated = 0;
  for (let i = 0; i < 9; i++) {
    let v = prize > 0
      ? Math.floor((prize * weights[i]!) / sumW)
      : (Math.random() < 0.4 ? Math.floor(cost * Math.random() * 2) : 0);
    if (i === 8 && prize > 0) v = Math.max(0, prize - allocated);
    allocated += v;
    cells.push({
      label: "PICK",
      value: v,
      face: String(v),
      mark: "pick",
    });
  }
  // Shuffle so jackpot cells aren't always last.
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cells[i], cells[j]] = [cells[j]!, cells[i]!];
  }
  return {
    gameMode: "pick3",
    cells,
    prize,
    meta: { picks: [] as number[], pickLimit: 3, locked: false },
  };
}

/** Build a full scratch ticket for a tier (mode + cells + meta). */
export function buildScratchTicket(
  tier: ScratchTierKey,
  poolAvailable: number,
): ScratchTicketBuild {
  const def = SCRATCH_TIERS[tier];
  const prize = rollScratchPrize(def.price, poolAvailable, def.maxMult);
  switch (def.gameMode) {
    case "numbers":
      return buildNumbersTicket(prize, def.price);
    case "connect":
      return buildConnectTicket(prize, def.price);
    case "pick3":
      return buildPick3Ticket(prize, def.price);
    case "classic":
    default:
      return {
        gameMode: "classic",
        cells: buildScratchCells(prize, def.price),
        prize,
        meta: {},
      };
  }
}

/** Finalize pick3 after the player chooses cells — returns paid amount. */
export function scorePick3(
  cells: ScratchCell[],
  picks: number[],
  escrowPrize: number,
): number {
  const uniq = [...new Set(picks)].filter(i => i >= 0 && i < cells.length).slice(0, 3);
  const sum = uniq.reduce((acc, i) => acc + (cells[i]?.value ?? 0), 0);
  return Math.max(0, Math.min(escrowPrize, sum));
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
