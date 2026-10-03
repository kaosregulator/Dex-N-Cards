import { describe, expect, it } from "vitest";
import {
  formatTenure,
  tenureFilterMinMs,
  discordTimestamp,
} from "../format.js";

describe("formatTenure", () => {
  it("formats multi-year tenure", () => {
    const from = Date.UTC(2023, 0, 15); // Jan 15 2023
    const now = Date.UTC(2025, 6, 20); // Jul 20 2025
    const t = formatTenure(from, now);
    expect(t.years).toBe(2);
    expect(t.months).toBe(6);
    expect(t.label).toContain("2 years");
    expect(t.label).toContain("6 months");
  });

  it("formats short tenure in days", () => {
    const from = Date.now() - 3 * 86_400_000;
    const t = formatTenure(from);
    expect(t.label).toMatch(/3 days?/);
  });

  it("handles less than a day", () => {
    const t = formatTenure(Date.now() - 3_600_000);
    expect(t.label).toBe("less than a day");
  });
});

describe("tenureFilterMinMs", () => {
  it("maps filter keys", () => {
    expect(tenureFilterMinMs("any")).toBe(0);
    expect(tenureFilterMinMs("6m")).toBeGreaterThan(tenureFilterMinMs("3m"));
    expect(tenureFilterMinMs("1y")).toBeGreaterThan(tenureFilterMinMs("6m"));
  });
});

describe("discordTimestamp", () => {
  it("renders unix tags", () => {
    expect(discordTimestamp(1_700_000_000_000, "D")).toBe("<t:1700000000:D>");
    expect(discordTimestamp(null)).toBe("Unknown");
  });
});
