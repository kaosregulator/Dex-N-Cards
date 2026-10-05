import { describe, expect, it } from "vitest";
import { utcDayKey, utcWeekKey } from "../time.js";

describe("artshow week/day keys", () => {
  it("formats UTC day as YYYY-MM-DD", () => {
    expect(utcDayKey(new Date("2026-04-05T12:00:00Z"))).toBe("2026-04-05");
  });

  it("formats ISO-like week keys", () => {
    expect(utcWeekKey(new Date("2026-01-01T12:00:00Z"))).toMatch(/^2026-W\d{2}$/);
    // 2026-04-05 is a Sunday — ISO week 14
    expect(utcWeekKey(new Date("2026-04-05T12:00:00Z"))).toBe("2026-W14");
  });
});
