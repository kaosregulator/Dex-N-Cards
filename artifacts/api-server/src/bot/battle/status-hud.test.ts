import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  DRAIN_DURATION_MS, DRAIN_MOTION_END, DRAIN_SETTLE_MS,
  hudFighter, hudPct, renderStatusDrain, renderStatusStill, statusThemeOf,
  type HudBoard,
} from "./status-hud.js";

const sample = (over: Partial<HudBoard> = {}): HudBoard => ({
  style: "gauges",
  headline: "AI IS DECIDING",
  turnLabel: "TURN 19",
  fighters: [
    hudFighter({
      cardName: "Platinum SB12", hp: 109, shield: 1190, energy: 100, ultimate: 28,
      stats: { maxHealth: 2975, energyMax: 100, ultimateMax: 100 },
      specialEffect: "medkit", specialCooldownRemaining: 0,
    }, { tag: "YOU", tagTone: "you", sub: "Ahappy_hi · Limited", active: false, fromHp: 109 }),
    hudFighter({
      cardName: "Platinum SB12", hp: 1375, shield: 0, energy: 80, ultimate: 28,
      stats: { maxHealth: 3810, energyMax: 100, ultimateMax: 100 },
      specialEffect: "strike", specialCooldownRemaining: 0,
    }, { tag: "AI", tagTone: "ai", sub: "AI · Limited", active: true, fromHp: 2349 }),
  ],
  ...over,
});

describe("status themes", () => {
  it("keeps the current columns unless an admin picked a picture layout", () => {
    expect(statusThemeOf(undefined)).toBe("classic");
    expect(statusThemeOf("nope")).toBe("classic");
    expect(statusThemeOf("drain")).toBe("drain");
    expect(statusThemeOf("gauges")).toBe("gauges");
    expect(hudPct(28, 100)).toBe(28);
    expect(hudPct(5, 0)).toBe(0);
  });

  it("swaps the drain GIF to a still during the hold, before it can loop", () => {
    expect(DRAIN_SETTLE_MS).toBeGreaterThan(DRAIN_DURATION_MS * DRAIN_MOTION_END);
    expect(DRAIN_SETTLE_MS).toBeLessThan(DRAIN_DURATION_MS);
  });

  it("draws circle gauges and a drain that settles on the new HP", async () => {
    const gauges = await renderStatusStill(sample());
    expect(gauges).not.toBeNull();
    expect(gauges!.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");

    const drain = await renderStatusDrain(sample({ style: "drain" }));
    expect(drain).not.toBeNull();
    expect(drain!.gif).not.toBeNull();
    expect(drain!.gif!.subarray(0, 6).toString("ascii")).toBe("GIF89a");
    expect(drain!.still.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");

    const full = await renderStatusStill(sample({
      style: "drain",
      fighters: sample().fighters.map((f, i) => i === 1 ? { ...f, hp: f.maxHp, fromHp: f.maxHp } : f),
    }));
    const low = await renderStatusStill(sample({ style: "drain" }));
    const green = async (buf: Buffer) => {
      const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
      let n = 0;
      for (let i = 0; i < data.length; i += info.channels) {
        if (data[i + 1]! > 140 && data[i]! < 120 && data[i + 2]! < 140) n++;
      }
      return n;
    };
    expect(await green(full!)).toBeGreaterThan(await green(low!));
  });
});
