import { describe, expect, it } from "vitest";
import {
  checkBuyWindow,
  formatBuyWindow,
  parseBuyDays,
  resolveGameConfig,
} from "../../../../lib/lottery/config.js";

function settings(gameConfig: Record<string, Record<string, unknown>> = {}) {
  return {
    id: 1,
    guildId: "g",
    enabled: true,
    announceChannelId: null as string | null,
    weeklyDrawDay: 6,
    weeklyDrawHourUtc: 20,
    lastDrawDate: null as string | null,
    gameConfig,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Parameters<typeof resolveGameConfig>[0];
}

describe("resolveGameConfig", () => {
  it("uses defaults then overrides", () => {
    const cfg = resolveGameConfig(
      settings({ powerball: { ticketPrice: 999, seedJackpot: 1_000_000 } }),
      "powerball",
    );
    expect(cfg.ticketPrice).toBe(999);
    expect(cfg.seedJackpot).toBe(1_000_000);
  });
});

describe("checkBuyWindow", () => {
  it("allows always-open config", () => {
    const cfg = resolveGameConfig(settings(), "classic");
    expect(checkBuyWindow(cfg, new Date("2026-10-03T12:00:00Z")).ok).toBe(true);
  });

  it("blocks outside hour window", () => {
    const cfg = resolveGameConfig(
      settings({ classic: { buyStartHourUtc: 10, buyEndHourUtc: 12 } }),
      "classic",
    );
    expect(checkBuyWindow(cfg, new Date("2026-10-03T09:00:00Z")).ok).toBe(false);
    expect(checkBuyWindow(cfg, new Date("2026-10-03T11:00:00Z")).ok).toBe(true);
  });

  it("blocks wrong weekday", () => {
    // 2026-10-03 is Saturday (6)
    const cfg = resolveGameConfig(
      settings({ scratch: { buyDaysUtc: [1, 2, 3] } }),
      "scratch",
    );
    expect(checkBuyWindow(cfg, new Date("2026-10-03T12:00:00Z")).ok).toBe(false);
  });

  it("handles overnight wrap", () => {
    const cfg = resolveGameConfig(
      settings({ mega: { buyStartHourUtc: 22, buyEndHourUtc: 2 } }),
      "mega",
    );
    expect(checkBuyWindow(cfg, new Date("2026-10-03T23:00:00Z")).ok).toBe(true);
    expect(checkBuyWindow(cfg, new Date("2026-10-03T01:00:00Z")).ok).toBe(true);
    expect(checkBuyWindow(cfg, new Date("2026-10-03T12:00:00Z")).ok).toBe(false);
  });
});

describe("parseBuyDays / formatBuyWindow", () => {
  it("parses all and lists", () => {
    expect(parseBuyDays("all")).toEqual([]);
    expect(parseBuyDays("1,3,5")).toEqual([1, 3, 5]);
    expect(parseBuyDays("9")).toBeNull();
  });

  it("formats window label", () => {
    const cfg = resolveGameConfig(
      settings({ classic: { buyStartHourUtc: 9, buyEndHourUtc: 17, buyDaysUtc: [1, 2] } }),
      "classic",
    );
    expect(formatBuyWindow(cfg)).toContain("Mon/Tue");
    expect(formatBuyWindow(cfg)).toContain("09:00");
  });
});
