import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { defaultFrameForRarity } from "../cards/frames.js";
import { readFramePng } from "../animations/card-frames.js";
import {
  builtinRarityFrame,
  putRarityFrame,
  resolveRarityFrame,
} from "./rarity-frame.js";
import { defaultFrameStyle, styleArtWindow } from "./frame-styles.js";
import { hexOf, resolveFrameAccent, sampleFrameImage, samplePaintedFrame } from "./frame-color.js";

const shared = {
  battleFrameColorMode: "image",
  battleFrameColorA: null,
  battleFrameColorB: null,
  battleFrameByRarity: null,
};

async function solidPng(r: number, g: number, b: number): Promise<Buffer> {
  return sharp({
    create: { width: 24, height: 24, channels: 3, background: { r, g, b, alpha: 1 } },
  }).png().toBuffer();
}

describe("per-rarity frame colours", () => {
  it("uses the built-in frame when the guild has not set one", () => {
    const rare = resolveRarityFrame(shared, "rare");
    const builtin = builtinRarityFrame("rare");
    expect(rare.origin).toBe("shared");
    expect(rare.mode).toBe("custom");
    expect(hexOf(rare.colorA!)).toBe(builtin.a);
    expect(rare.style).toBe(builtin.style);
    expect(resolveRarityFrame(shared, "mythic").style).toBe("relic");
  });

  it("keeps a guild-wide frame on rarities that have no row of their own", () => {
    const rare = resolveRarityFrame({ ...shared, battleFrameColorMode: "rainbow" }, "rare");
    expect(rare.origin).toBe("shared");
    expect(rare.mode).toBe("rainbow");
    expect(rare.style).toBe(defaultFrameStyle("rare"));
  });

  it("saves a colour on one rarity and leaves the others on their built-in frame", () => {
    const map = putRarityFrame(null, "rare", { mode: "custom", a: "#e23b3b", b: "#7a1420" });
    const rare = resolveRarityFrame({ ...shared, battleFrameByRarity: map }, "rare");
    const common = resolveRarityFrame({ ...shared, battleFrameByRarity: map }, "common");
    expect(rare.origin).toBe("rarity");
    expect(rare.mode).toBe("custom");
    expect(hexOf(rare.colorA!)).toBe("#e23b3b");
    expect(common.origin).toBe("shared");
    expect(hexOf(common.colorA!)).toBe(builtinRarityFrame("common").a);
    expect(common.style).toBe("crest");
  });

  it("uses the rarity's existing default frame as its default colours", () => {
    const frame = defaultFrameForRarity("rare");
    const recipe = builtinRarityFrame("rare");
    expect(recipe.mode).toBe("custom");
    expect(recipe.a).toBe(hexOf(frame.color));
    expect(recipe.b).not.toBe(recipe.a);
    expect(recipe.style).toBe(defaultFrameStyle("rare"));
  });

  it("keeps each rarity on its built-in style until one is saved", () => {
    expect(resolveRarityFrame(shared, "common").style).toBe("crest");
    expect(resolveRarityFrame(shared, "uncommon").style).toBe("laurel");
    expect(builtinRarityFrame("epic").style).toBe("relic");
    expect(builtinRarityFrame("legendary").style).toBe("aegis");
  });

  it("keeps the style when a later edit only changes the color", () => {
    const first = putRarityFrame(null, "rare", { mode: "custom", a: "#e23b3b", b: "#7a1420", style: "relic" });
    const next = putRarityFrame(first, "rare", { mode: "rainbow", a: "#e23b3b", b: "#7a1420" });
    const rare = resolveRarityFrame({ ...shared, battleFrameByRarity: next }, "rare");
    expect(rare.style).toBe("relic");
    expect(rare.mode).toBe("rainbow");
  });

  it("fills a saved row that has no style with that rarity's default", () => {
    const raw = { rare: { mode: "custom", a: "#3498db", b: "#5dade2" } };
    expect(resolveRarityFrame({ ...shared, battleFrameByRarity: raw }, "rare").style).toBe("aegis");
  });

  it("keeps the art window in the same shape as the card", () => {
    const tall = styleArtWindow(0, 0, 200, 280);
    const wide = styleArtWindow(10, 20, 420, 210);
    expect(tall.w / tall.h).toBeCloseTo(200 / 280, 5);
    expect(wide.w / wide.h).toBeCloseTo(420 / 210, 5);
    expect(tall.x).toBeGreaterThan(0);
    expect(wide.y).toBeGreaterThan(20);
  });
});

describe("frame colour sampling", () => {
  it("samples a red swatch and a rainbow frame through the same sampler", async () => {
    const red = await samplePaintedFrame("swatch", 0xe23b3b, 0x7a1420);
    const rainbow = await samplePaintedFrame("rainbow", 0, 0);
    expect(red).not.toBeNull();
    expect(rainbow).not.toBeNull();
    expect(red).not.toBe(rainbow);
    const r = (red! >> 16) & 255;
    const g = (red! >> 8) & 255;
    const b = red! & 255;
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
  });

  it("samples the frame that is assigned now, then the frame it is changed to", async () => {
    const rainbowBuf = await sampleStripe();
    const redBuf = await solidPng(210, 32, 36);
    const rainbow = await resolveFrameAccent({
      mode: "image",
      frameImage: "rainbow",
      frameBuffer: rainbowBuf,
    });
    const red = await resolveFrameAccent({
      mode: "image",
      frameImage: "red",
      frameBuffer: redBuf,
    });
    expect(rainbow.ownsColor).toBe(true);
    expect(rainbow.paint).toBe("rainbow");
    expect(red.ownsColor).toBe(true);
    expect(red.paint).toBe("solid");
    expect(red.color).not.toBe(rainbow.color);
    const again = await resolveFrameAccent({ mode: "image", frameImage: "red", frameBuffer: redBuf });
    expect(again.color).toBe(red.color);
    expect(again.paint).toBe("solid");
    const channel = (again.color! >> 16) & 255;
    expect(channel).toBeGreaterThan((again.color! >> 8) & 255);
    expect(channel).toBeGreaterThan(again.color! & 255);
  });

  it("samples the red frame file and the rainbow frame file as different colours", async () => {
    const redFile = readFramePng("red");
    const blueFile = readFramePng("blue");
    const rainbowFile = readFramePng("rainbow");
    expect(redFile && blueFile && rainbowFile).toBeTruthy();
    const red = await sampleFrameImage("file:red", redFile!);
    const blue = await sampleFrameImage("file:blue", blueFile!);
    const rainbow = await sampleFrameImage("file:rainbow", rainbowFile!);
    expect(red?.rainbow).toBe(false);
    expect(blue?.rainbow).toBe(false);
    expect(rainbow?.rainbow).toBe(true);
    expect(red!.color).not.toBe(rainbow!.color);
    expect(red!.color).not.toBe(blue!.color);
    expect((red!.color >> 16) & 255).toBeGreaterThan(red!.color & 255);
    expect(blue!.color & 255).toBeGreaterThan((blue!.color >> 16) & 255);
    const again = await sampleFrameImage("file:red", redFile!);
    expect(again).toEqual(red);
    const gold = await sampleFrameImage("file:gold", readFramePng("gold")!);
    const grey = await sampleFrameImage("file:grey", readFramePng("grey")!);
    expect(gold?.rainbow).toBe(false);
    expect(grey?.rainbow).toBe(false);
    expect(gold!.color).not.toBe(red!.color);
  });
});

async function sampleStripe(): Promise<Buffer> {
  const width = 24;
  const height = 24;
  const stops = [0xff4d4d, 0xff9f1a, 0xffe14d, 0x3ddc6a, 0x3dc6ff, 0x7a5cff, 0xff4fd8];
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = stops[Math.min(stops.length - 1, Math.floor((x / width) * stops.length))]!;
      const i = (y * width + x) * 3;
      data[i] = (color >> 16) & 255;
      data[i + 1] = (color >> 8) & 255;
      data[i + 2] = color & 255;
    }
  }
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
}
