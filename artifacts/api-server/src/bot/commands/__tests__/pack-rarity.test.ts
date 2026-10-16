import { describe, expect, it } from "vitest";
import { allowListWeights, normalizeAllowList, rollWeightedKey } from "../pack-rarity.js";

describe("pack rarity allow-lists", () => {
  it("treats null and empty as the default mix", () => {
    expect(normalizeAllowList(null)).toBeNull();
    expect(normalizeAllowList([])).toBeNull();
    expect(normalizeAllowList(["", "  "])).toBeNull();
  });

  it("keeps custom rarity keys and drops blanks", () => {
    expect(normalizeAllowList([" common ", "custom:gold", "common"])).toEqual(["common", "custom:gold"]);
  });

  it("gives a zero-rate rarity a floor so an explicit lock can still drop it", () => {
    const weights = allowListWeights(
      { common: 0.6, uncommon: 0.25, rare: 0.11, epic: 0.035, legendary: 0.005, mythic: 0 },
      ["common", "mythic"],
    );
    const mythic = weights.find(w => w.key === "mythic");
    const common = weights.find(w => w.key === "common");
    expect(common?.weight).toBeCloseTo(0.6);
    expect(mythic?.weight).toBeGreaterThan(0);
    expect(mythic?.weight).toBeCloseTo(0.005);
  });

  it("splits evenly when every selected rate is zero", () => {
    const weights = allowListWeights({ mythic: 0, legendary: 0 }, ["mythic", "custom:gold"]);
    expect(weights.map(w => w.weight)).toEqual([1, 1]);
  });

  it("never rolls a key outside the allow-list", () => {
    const weights = allowListWeights({ common: 0.9, rare: 0.1, mythic: 0 }, ["rare"]);
    for (let i = 0; i < 20; i++) {
      expect(rollWeightedKey(weights, () => i / 20)).toBe("rare");
    }
  });
});
