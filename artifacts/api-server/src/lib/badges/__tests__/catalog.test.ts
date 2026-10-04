import { describe, expect, it } from "vitest";
import {
  DEFAULT_BADGE_RULES,
  getBadgeRules,
  addEarnedBadge,
  formatBadgeNames,
  triviaBadgeIdsForMode,
  configuredChannel,
} from "../catalog.js";

describe("getBadgeRules", () => {
  it("falls back to defaults when empty", () => {
    expect(getBadgeRules([])).toEqual(getBadgeRules(DEFAULT_BADGE_RULES));
    expect(getBadgeRules(null)).toHaveLength(DEFAULT_BADGE_RULES.length);
  });

  it("filters invalid rows", () => {
    const rules = getBadgeRules([
      { id: "OK?", name: "Bad", emoji: "x", description: "d", trigger: "manual", threshold: 0 },
      { id: "helper", name: "Helper", emoji: "🤝", description: "Helped", trigger: "manual", threshold: 0 },
      { id: "chatter", name: "Chatter", emoji: "💬", description: "Talk", trigger: "messages", threshold: 0 },
    ] as any);
    expect(rules.map(r => r.id)).toEqual(["helper"]);
  });
});

describe("addEarnedBadge", () => {
  it("awards once and unlocks collection", () => {
    const rules = getBadgeRules([
      { id: "a", name: "A", emoji: "1", description: "a", trigger: "manual", threshold: 0 },
      { id: "b", name: "B", emoji: "2", description: "b", trigger: "manual", threshold: 0 },
      { id: "all", name: "All", emoji: "3", description: "all", trigger: "collection", threshold: 0 },
    ]);
    const earned: import("@workspace/db").BadgeEarned[] = [];
    expect(addEarnedBadge(earned, "a", rules)).toEqual(["a"]);
    expect(earned[0]?.level).toBe(1);
    expect(addEarnedBadge(earned, "a", rules)).toEqual([]);
    const second = addEarnedBadge(earned, "b", rules);
    expect(second).toEqual(["b", "all"]);
    expect(earned.map(e => e.id)).toEqual(["a", "b", "all"]);
  });
});

describe("triviaBadgeIdsForMode", () => {
  it("maps modes and brainiac", () => {
    expect(triviaBadgeIdsForMode("qotd", false)).toEqual(["qotd_champion"]);
    expect(triviaBadgeIdsForMode("flash", true)).toEqual(["flash_champ", "brainiac"]);
    expect(triviaBadgeIdsForMode("picture", false)).toEqual(["flash_champ"]);
    expect(triviaBadgeIdsForMode("prompt", false)).toEqual(["smart_cookie"]);
    expect(triviaBadgeIdsForMode("trivia", true)).toEqual(["trivia_winner", "brainiac"]);
  });
});

describe("formatBadgeNames + configuredChannel", () => {
  it("formats names", () => {
    const rules = getBadgeRules(DEFAULT_BADGE_RULES);
    expect(formatBadgeNames(["helper"], rules)).toContain("Helper");
  });

  it("uses per-rule channel then legacy fallbacks", () => {
    const rule = { id: "t", name: "T", emoji: "x", description: "d", trigger: "attachments" as const, threshold: 10, channel: "c1" };
    expect(configuredChannel(rule, "track", "trade")).toBe("c1");
    expect(configuredChannel({ ...rule, channel: null }, "track", "trade")).toBe("trade");
    expect(configuredChannel({ ...rule, trigger: "messages", channel: null }, "track", "trade")).toBe("track");
  });
});
