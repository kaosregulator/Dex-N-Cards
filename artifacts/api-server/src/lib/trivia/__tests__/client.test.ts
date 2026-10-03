import { describe, expect, it } from "vitest";
import { answersMatch, normalizeAnswer, OPENTDB_CATEGORIES } from "../client.js";

describe("normalizeAnswer / answersMatch", () => {
  it("normalizes case punctuation and accents", () => {
    expect(normalizeAnswer("  King K. Rool! ")).toBe("king k rool");
    expect(answersMatch("king k rool", "King K. Rool")).toBe(true);
    expect(answersMatch("True", "true")).toBe(true);
  });

  it("rejects unrelated guesses", () => {
    expect(answersMatch("banana", "King K. Rool")).toBe(false);
    expect(answersMatch("", "x")).toBe(false);
  });

  it("matches breed token order variants", () => {
    expect(answersMatch("afghan hound", "Hound Afghan")).toBe(true);
    expect(answersMatch("scottish terrier", "Terrier Scottish")).toBe(true);
  });
});

describe("OPENTDB_CATEGORIES", () => {
  it("includes gaming and animals", () => {
    const names = OPENTDB_CATEGORIES.map(c => c.name.toLowerCase());
    expect(names.some(n => n.includes("video games"))).toBe(true);
    expect(names.some(n => n.includes("animals"))).toBe(true);
  });
});
