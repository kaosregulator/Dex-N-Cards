import { describe, expect, it } from "vitest";
import {
  applyBadgeXp,
  normalizeEarned,
  tierForLevel,
  xpToNextLevel,
  shouldShowEmblem,
  BADGE_LEVEL_MAX,
} from "../levels.js";

describe("xpToNextLevel", () => {
  it("grows with level", () => {
    expect(xpToNextLevel(1)).toBeLessThan(xpToNextLevel(20));
    expect(xpToNextLevel(20)).toBeLessThan(xpToNextLevel(80));
  });
});

describe("tierForLevel", () => {
  it("maps tiers", () => {
    expect(tierForLevel(1).key).toBe("kindling");
    expect(tierForLevel(10).key).toBe("aurora");
    expect(tierForLevel(25).key).toBe("radiant");
    expect(tierForLevel(50).key).toBe("eclipse");
    expect(tierForLevel(75).key).toBe("celestial");
    expect(tierForLevel(100).key).toBe("apex");
  });
});

describe("applyBadgeXp", () => {
  it("levels up and carries overflow", () => {
    const badge = normalizeEarned({ id: "trivia_winner", level: 1, xp: 0, timestamp: 1 });
    const need = xpToNextLevel(1);
    const result = applyBadgeXp(badge, need + 5);
    expect(result.leveled).toBe(true);
    expect(result.badge.level).toBe(2);
    expect(result.badge.xp).toBe(5);
  });

  it("caps at 100", () => {
    const need = xpToNextLevel(99);
    const badge = normalizeEarned({ id: "x", level: 99, xp: need - 10, timestamp: 1 });
    const result = applyBadgeXp(badge, 120);
    expect(result.badge.level).toBe(BADGE_LEVEL_MAX);
    expect(result.badge.xp).toBe(0);
    // Further XP does nothing at apex.
    const again = applyBadgeXp(result.badge, 50);
    expect(again.xpGranted).toBe(0);
    expect(again.badge.level).toBe(BADGE_LEVEL_MAX);
  });

  it("detects tier changes", () => {
    const badge = normalizeEarned({ id: "x", level: 9, xp: 0, timestamp: 1 });
    const need = xpToNextLevel(9);
    const result = applyBadgeXp(badge, need);
    expect(result.tierChanged).toBe(true);
    expect(result.tier.key).toBe("aurora");
    expect(shouldShowEmblem(result)).toBe(true);
  });

  it("clamps single grant", () => {
    const badge = normalizeEarned({ id: "x", level: 1, xp: 0, timestamp: 1 });
    const result = applyBadgeXp(badge, 9999);
    expect(result.capped).toBe(true);
    expect(result.xpGranted).toBeLessThanOrEqual(120);
  });
});
