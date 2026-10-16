import { describe, expect, it } from "vitest";
import { RARITY_BURN, RARITY_WEIGHTS, RARITY_WORTH } from "../../cards-data.js";
import {
  builtinDisplayPosition,
  effectiveBuiltinEconomy,
  getDisplayRarities,
  type RarityContext,
} from "../../rarity-runtime.js";

describe("rarity economy source of truth", () => {
  it("uses built-in worth, burn, and spawn when the server has no override", () => {
    expect(effectiveBuiltinEconomy("rare", null)).toEqual({
      worthValue: RARITY_WORTH.rare,
      burnValue: RARITY_BURN.rare,
      dropWeight: RARITY_WEIGHTS.rare,
    });
  });

  it("lets a server override replace one field and keeps the defaults for the rest", () => {
    expect(effectiveBuiltinEconomy("rare", { worthValue: 900, burnValue: null, dropWeight: null })).toEqual({
      worthValue: 900,
      burnValue: RARITY_BURN.rare,
      dropWeight: RARITY_WEIGHTS.rare,
    });
  });

  it("orders built-in rarities the way the server arranged them", () => {
    const order = ["mythic", "legendary", "epic", "rare", "uncommon", "common"] as const;
    expect(builtinDisplayPosition("mythic", order)).toBe(1);
    expect(builtinDisplayPosition("common", order)).toBe(6);

    const ctx = {
      order: [...order],
      customs: [],
    } as unknown as RarityContext;
    const labels = getDisplayRarities(ctx, null, { rarestFirst: false }).map(r => r.key);
    expect(labels).toEqual([...order]);
  });
});
