import { describe, expect, it } from "vitest";
import { clipDiscordLabel, parsePackCost } from "../config-panel.js";

describe("custom pack prices", () => {
  it("keeps a typed shard amount", () => {
    expect(parsePackCost("325")).toBe(325);
    expect(parsePackCost("1,500")).toBe(1500);
    expect(parsePackCost(" 0 ")).toBe(0);
  });

  it("keeps pack rename labels inside Discord's 45 character limit", () => {
    expect(clipDiscordLabel("🥉 Basic display name").length).toBeLessThanOrEqual(45);
    const long = "🥇 " + "Legendary".repeat(8) + " display name";
    expect(clipDiscordLabel(long).length).toBeLessThanOrEqual(45);
    expect(clipDiscordLabel(long).length).toBeGreaterThan(0);
  });

  it("rejects blanks, decimals, and huge numbers", () => {
    expect(parsePackCost("")).toBeNull();
    expect(parsePackCost("12.5")).toBeNull();
    expect(parsePackCost("-10")).toBeNull();
    expect(parsePackCost("1000001")).toBeNull();
  });
});
