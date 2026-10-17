import { describe, expect, it } from "vitest";
import { encodeAnimation } from "./engine.js";
import { entranceTimeline, CARD_EXIT_MS } from "./card-entrance.js";

describe("entrance timing", () => {
  it("holds the spawned card for a second before the loop replays", () => {
    for (const speed of ["slow", "normal", "fast"] as const) {
      const t = entranceTimeline(speed);
      expect(t.holdMs).toBe(1000);
      expect(t.durationMs - Math.round(t.motionEnd * t.durationMs)).toBeGreaterThanOrEqual(900);
    }
    expect(entranceTimeline("slow").durationMs).toBeGreaterThan(entranceTimeline("fast").durationMs);
    expect(CARD_EXIT_MS).toBeGreaterThan(1000);
  });
});

describe("encodeAnimation", () => {
  it("coalesces identical frames and still writes a GIF", async () => {
    const result = await encodeAnimation({
      width: 48,
      height: 32,
      speed: "fast",
      durationMs: 500,
      maxFrames: 6,
      quality: 24,
      render: ({ ctx, t }) => {
        ctx.fillStyle = t < 0.5 ? "#102030" : "#a0b0c0";
        ctx.fillRect(0, 0, 48, 32);
      },
    });
    expect(result).not.toBeNull();
    expect(result!.buffer.subarray(0, 6).toString("ascii")).toBe("GIF89a");
    // Six planned frames, two solid colours. Coalescing must keep both
    // colours and must not emit one frame per tick.
    expect(result!.frameCount).toBe(2);
    expect(result!.buffer.length).toBeLessThan(50_000);
  });
});
