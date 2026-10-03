import { describe, expect, it } from "vitest";
import {
  scoreTicket,
  drawWinningNumbers,
  formatNums,
  rollScratchPrize,
  rollScratchPrizeForTier,
  buildScratchCells,
  GAME_DEFS,
  SCRATCH_TIERS,
  SCRATCH_TIER_KEYS,
  isScratchTier,
} from "../catalog.js";
import { buildLotteryCommandJson, buildLotteryAdminCommandJson } from "../definition.js";
import { plainCashLabel, parseDiscordEmoji, symbolDisplayName } from "../../currency-canvas.js";

describe("GAME_DEFS seeds", () => {
  it("starts with non-empty jackpots", () => {
    expect(GAME_DEFS.powerball.seedJackpot).toBeGreaterThan(10_000);
    expect(GAME_DEFS.mega.seedJackpot).toBeGreaterThan(GAME_DEFS.powerball.seedJackpot);
    expect(GAME_DEFS.classic.ticketPrice).toBeGreaterThan(0);
    expect(GAME_DEFS.scratch.ticketPrice).toBeGreaterThan(0);
  });
});

describe("scratch tiers", () => {
  it("defines four priced tiers with daily stock", () => {
    expect(SCRATCH_TIER_KEYS).toEqual(["copper", "silver", "gold", "diamond"]);
    expect(SCRATCH_TIERS.copper.price).toBeLessThan(SCRATCH_TIERS.silver.price);
    expect(SCRATCH_TIERS.diamond.dailyStock).toBeGreaterThan(0);
    expect(isScratchTier("gold")).toBe(true);
    expect(isScratchTier("platinum")).toBe(false);
  });

  it("rolls tier prizes without exceeding pool cap", () => {
    for (let i = 0; i < 30; i++) {
      expect(rollScratchPrizeForTier("copper", 50)).toBeLessThanOrEqual(20);
    }
  });
});

describe("currency canvas labels", () => {
  it("parses custom emoji and never uses raw markup as display name", () => {
    const raw = "<:bob:1375188100229107862>";
    expect(parseDiscordEmoji(raw)?.name).toBe("bob");
    expect(symbolDisplayName(raw)).toBe("bob");
    expect(plainCashLabel(500)).toBe("500 cash");
  });
});

describe("scoreTicket", () => {
  it("awards classic jackpot on 5 matches", () => {
    const r = scoreTicket("classic", [1, 2, 3, 4, 5], null, [1, 2, 3, 4, 5], null);
    expect(r?.tier).toMatch(/Jackpot/i);
    expect(r?.shareOfPool).toBe(1);
  });

  it("awards powerball jackpot on 5 + bonus", () => {
    const r = scoreTicket("powerball", [1, 2, 3, 4, 5], 9, [1, 2, 3, 4, 5], 9);
    expect(r?.tier).toMatch(/JACKPOT/i);
  });

  it("returns null on no match", () => {
    expect(scoreTicket("classic", [1, 2, 3, 4, 5], null, [10, 11, 12, 13, 14], null)).toBeNull();
  });
});

describe("drawWinningNumbers", () => {
  it("respects ranges and uniqueness", () => {
    const { numbers, bonus } = drawWinningNumbers("powerball");
    expect(numbers).toHaveLength(5);
    expect(new Set(numbers).size).toBe(5);
    expect(numbers.every(n => n >= 1 && n <= 69)).toBe(true);
    expect(bonus).toBeGreaterThanOrEqual(1);
    expect(bonus!).toBeLessThanOrEqual(26);
  });
});

describe("scratch helpers", () => {
  it("builds 9 cells", () => {
    const cells = buildScratchCells(500, 100);
    expect(cells).toHaveLength(9);
    expect(cells.some(c => c.label === "WIN" && c.value === 500)).toBe(true);
  });

  it("caps prize to pool", () => {
    for (let i = 0; i < 40; i++) {
      expect(rollScratchPrize(100, 50)).toBeLessThanOrEqual(20); // 40% of 50
    }
  });
});

describe("formatNums", () => {
  it("includes bonus label", () => {
    expect(formatNums([1, 2], 7, "Powerball")).toContain("Powerball");
  });
});

describe("slash defs", () => {
  it("registers lottery + lotteryadmin", () => {
    expect((buildLotteryCommandJson() as { name: string }).name).toBe("lottery");
    expect((buildLotteryAdminCommandJson() as { name: string }).name).toBe("lotteryadmin");
  });
});
