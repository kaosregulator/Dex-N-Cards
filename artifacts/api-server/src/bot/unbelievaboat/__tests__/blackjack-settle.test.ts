import { describe, expect, it } from "vitest";
import {
  renderBlackjackShuffleGif,
  renderBlackjackShufflePng,
  renderBlackjackTableGif,
  renderBlackjackTablePng,
} from "../render-blackjack.js";

describe("blackjack settle frames", () => {
  it("produces a short shuffle GIF plus a squared-deck PNG still", async () => {
    const gif = await renderBlackjackShuffleGif();
    const png = await renderBlackjackShufflePng();
    expect(gif).not.toBeNull();
    expect(png).not.toBeNull();
    expect(gif!.durationMs).toBeLessThanOrEqual(2500);
    expect(gif!.buffer.length).toBeGreaterThan(1_000);
    expect(png!.length).toBeGreaterThan(500);
    // Still must be smaller than the animated shuffle (sanity for PNG settle).
    expect(png!.length).toBeLessThan(gif!.buffer.length);
  }, 15_000);

  it("deal GIF is snappy and has a PNG settle twin", async () => {
    const opts = {
      player: [
        { rank: "A" as const, suit: "♠" as const },
        { rank: "K" as const, suit: "♥" as const },
      ],
      dealer: [
        { rank: "10" as const, suit: "♦" as const },
        { rank: "9" as const, suit: "♣" as const },
      ],
      hideDealer: true,
      animatePlayerFrom: 0,
      animateDealerFrom: 0,
    };
    const gif = await renderBlackjackTableGif(opts);
    const png = await renderBlackjackTablePng(opts);
    expect(gif).not.toBeNull();
    expect(png).not.toBeNull();
    expect(gif!.durationMs).toBeLessThanOrEqual(1800);
    expect(png!.length).toBeGreaterThan(500);
  }, 15_000);
});
