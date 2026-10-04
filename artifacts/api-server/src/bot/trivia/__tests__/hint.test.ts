import { describe, expect, it } from "vitest";
import { maskAnswerHint, GUESSES_PER_EXTRA_LETTER } from "../hint.js";

describe("maskAnswerHint", () => {
  it("shows first letter of each word at zero guesses", () => {
    const r = maskAnswerHint("Dark Night", 0);
    expect(r.masked.replace(/\s+/g, " ").trim()).toMatch(/^D●●●\s+N●●●●$/);
  });

  it("reveals more letters as guesses accumulate", () => {
    const early = maskAnswerHint("Banana", 0);
    const later = maskAnswerHint("Banana", GUESSES_PER_EXTRA_LETTER * 3);
    const earlyHidden = (early.masked.match(/●/g) || []).length;
    const laterHidden = (later.masked.match(/●/g) || []).length;
    expect(laterHidden).toBeLessThan(earlyHidden);
  });

  it("never fully reveals while live", () => {
    const r = maskAnswerHint("Encyclopaedia", 10_000);
    expect(r.masked.includes("●")).toBe(true);
    expect(r.hiddenCount).toBeGreaterThan(0);
  });

  it("keeps spaces and punctuation structure", () => {
    const r = maskAnswerHint("A-Team", 0);
    expect(r.masked).toContain("-");
  });
});
