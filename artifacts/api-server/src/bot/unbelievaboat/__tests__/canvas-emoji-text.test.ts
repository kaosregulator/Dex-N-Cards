import { describe, expect, it } from "vitest";
import { segmentEmojiText } from "../canvas-emoji-text.js";

describe("canvas-emoji-text", () => {
  it("keeps plain text as a single segment", () => {
    expect(segmentEmojiText("KaosRegulator")).toEqual([
      { kind: "text", value: "KaosRegulator" },
    ]);
  });

  it("splits unicode emoji out of display names", () => {
    const segs = segmentEmojiText("🎃 Kaos");
    expect(segs.some(s => s.kind === "emoji" && s.value.includes("🎃"))).toBe(true);
    expect(segs.some(s => s.kind === "text" && s.value.includes("Kaos"))).toBe(true);
  });

  it("treats Discord custom emoji markup as an emoji segment", () => {
    const segs = segmentEmojiText("VIP <:bob:123> club");
    expect(segs).toEqual([
      { kind: "text", value: "VIP " },
      { kind: "emoji", value: "<:bob:123>" },
      { kind: "text", value: " club" },
    ]);
  });
});
