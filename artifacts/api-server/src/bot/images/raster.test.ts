import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { dominantColorFromBuffer, shrinkArtBuffer } from "./raster.js";

async function solidPng(width: number, height: number, r: number, g: number, b: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r, g, b, alpha: 1 },
    },
  }).png().toBuffer();
}

describe("shrinkArtBuffer", () => {
  it("fits a large upload inside the card edge without enlarging a small one", async () => {
    const big = await solidPng(2400, 1600, 180, 40, 50);
    const shrunk = await shrinkArtBuffer(big, 768);
    expect(shrunk).not.toBeNull();
    const meta = await sharp(shrunk!).metadata();
    expect(meta.width).toBeLessThanOrEqual(768);
    expect(meta.height).toBeLessThanOrEqual(768);
    expect((meta.width ?? 1) * (meta.height ?? 1)).toBeLessThan((2400 * 1600) / 4);

    const small = await solidPng(40, 60, 10, 20, 30);
    const same = await shrinkArtBuffer(small, 768);
    const smallMeta = await sharp(same!).metadata();
    expect(smallMeta.width).toBe(40);
    expect(smallMeta.height).toBe(60);
  });

  it("reads a saturated accent from the same bytes a canvas would draw", async () => {
    const png = await solidPng(900, 600, 210, 40, 36);
    const color = await dominantColorFromBuffer(png);
    expect(color).not.toBeNull();
    const r = (color! >> 16) & 0xff;
    const g = (color! >> 8) & 0xff;
    const b = color! & 0xff;
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
  });
});
