import { describe, expect, it } from "vitest";
import { suggestedCollectIncome } from "../collect-roles.js";

describe("suggestedCollectIncome", () => {
  it("seeds ~1% of shop price with clamps", () => {
    expect(suggestedCollectIncome(0)).toBe(1_000);
    expect(suggestedCollectIncome(5_000)).toBe(500); // floor
    expect(suggestedCollectIncome(50_000)).toBe(500);
    expect(suggestedCollectIncome(500_000)).toBe(5_000);
    expect(suggestedCollectIncome(990_000)).toBe(9_900);
    expect(suggestedCollectIncome(1_250_000)).toBe(12_500);
    expect(suggestedCollectIncome(9_999_999)).toBe(100_000); // cap
  });
});
