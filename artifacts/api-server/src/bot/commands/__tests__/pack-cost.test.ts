import { describe, expect, it } from "vitest";
import { parsePackCost } from "../config-panel.js";

describe("custom pack prices", () => {
  it("keeps a typed shard amount", () => {
    expect(parsePackCost("325")).toBe(325);
    expect(parsePackCost("1,500")).toBe(1500);
    expect(parsePackCost(" 0 ")).toBe(0);
  });

  it("rejects blanks, decimals, and huge numbers", () => {
    expect(parsePackCost("")).toBeNull();
    expect(parsePackCost("12.5")).toBeNull();
    expect(parsePackCost("-10")).toBeNull();
    expect(parsePackCost("1000001")).toBeNull();
  });
});
