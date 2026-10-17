import { describe, expect, it } from "vitest";
import { aiMoveAllowed, sideCombatRules } from "./side-rules.js";
import { buttonEmoji, canvasSafeText, repairDiscordEmojiMarkup } from "../discord-emoji.js";
import { COLOR_FAMILIES, hexOf, stepColor } from "./frame-color.js";

const shared = { missChancePct: 8, dodgeChancePct: 10, critChancePct: 12 };

describe("player and AI combat rules", () => {
  it("keeps both sides on the shared numbers until an admin sets one", () => {
    expect(sideCombatRules(shared, false)).toEqual({ missChancePct: 8, dodgeChancePct: 10, critChancePct: 12 });
    expect(sideCombatRules(shared, true)).toEqual({ missChancePct: 8, dodgeChancePct: 10, critChancePct: 12 });
  });

  it("lets each side keep its own miss, dodge, and crit", () => {
    const settings = {
      ...shared,
      userMissChancePct: 4,
      aiDodgeChancePct: 30,
      aiCritChancePct: 40,
    };
    expect(sideCombatRules(settings, false).missChancePct).toBe(4);
    expect(sideCombatRules(settings, false).dodgeChancePct).toBe(10);
    expect(sideCombatRules(settings, true).dodgeChancePct).toBe(30);
    expect(sideCombatRules(settings, true).critChancePct).toBe(40);
    expect(sideCombatRules(settings, true).missChancePct).toBe(8);
  });

  it("turns off only the AI moves an admin disabled", () => {
    const settings = { ...shared, aiAllowUltimate: false, aiAllowItem: false };
    expect(aiMoveAllowed(settings, "ultimate")).toBe(false);
    expect(aiMoveAllowed(settings, "item")).toBe(false);
    expect(aiMoveAllowed(settings, "attack")).toBe(true);
    expect(aiMoveAllowed(settings, "special")).toBe(true);
  });
});

describe("custom emoji markup", () => {
  it("replaces the one-character placeholder name Discord draws as a blank square", () => {
    expect(repairDiscordEmojiMarkup("<:_:123456789012345678>")).toBe("<:emoji:123456789012345678>");
    expect(buttonEmoji("<:bolt:42>")).toEqual({ id: "42", name: "bolt", animated: false });
    expect(canvasSafeText("Epic <:_:99> card")).toBe("Epic card");
    expect(canvasSafeText("Legendary <:prism:77>")).toBe("Legendary prism");
  });
});

describe("frame colour picker", () => {
  it("scrolls through the palette and stays on a real swatch", () => {
    const start = COLOR_FAMILIES[0]!.shades[0]!.n;
    const next = stepColor(start, 1);
    expect(next).not.toBe(start);
    const all = COLOR_FAMILIES.flatMap(f => f.shades.map(s => s.n));
    expect(all).toContain(next);
    expect(COLOR_FAMILIES.length).toBeLessThanOrEqual(25);
    for (const fam of COLOR_FAMILIES) expect(fam.shades.length).toBeLessThanOrEqual(25);
    expect(hexOf(0xf1c40f)).toBe("#f1c40f");
  });
});
