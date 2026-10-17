import { describe, expect, it } from "vitest";
import { cardNamesCollide, findCollidingCard } from "../name-collision.js";

describe("card name collision", () => {
  it("blocks the same name and a typo of the whole name", () => {
    expect(cardNamesCollide("Super Edjer", "super edjer")).toBe(true);
    expect(cardNamesCollide("Super Edjer", "Super-Edjer")).toBe(true);
    expect(cardNamesCollide("Super Edjer", "Supr Edjer")).toBe(true);
  });

  it("allows a shorter name that only shares a word", () => {
    expect(cardNamesCollide("super edjer", "edjer")).toBe(false);
    expect(cardNamesCollide("super edjer", "super")).toBe(false);
    expect(cardNamesCollide("edjer", "super edjer rifle")).toBe(false);
    const hit = findCollidingCard(
      [{ name: "super edjer" }, { name: "pocket change" }],
      "edjer",
    );
    expect(hit).toBeUndefined();
  });
});
