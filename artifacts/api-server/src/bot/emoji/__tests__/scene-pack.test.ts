/**
 * Scene packs — green/blue-screen clips composited on the user's image.
 */
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  loadScenes, sceneStyleEntries, sceneIdOf, isSceneAnimation, sceneLabelOf,
  renderScene, sceneRenderOptions, subjectDrawSize, SCENE_PREFIX,
} from "../providers/offline/scene-pack.js";
import { renderOffline } from "../providers/offline/renderer.js";

/** A solid-colour square so we can spot the target inside the composite. */
async function solid(hex: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width: 256, height: 256, channels: 4, background: { ...hex, alpha: 1 } } })
    .png().toBuffer();
}

describe("scene catalog", () => {
  it("loads the featured scenes with stable ids", () => {
    const scenes = loadScenes();
    expect(scenes).not.toBeNull();
    expect(scenes!.list.length).toBeGreaterThanOrEqual(20);
    // Featured order: Mission Passed leads.
    expect(sceneStyleEntries()[0]?.value).toBe(`${SCENE_PREFIX}mission-passed`);
  });

  it("recognises scene animation values", () => {
    expect(sceneIdOf("scene:mission-passed")).toBe("mission-passed");
    expect(isSceneAnimation("scene:cutting-board")).toBe(true);
    expect(isSceneAnimation("gen_btn_shake")).toBe(false);
    expect(sceneLabelOf("scene:theater")).toBe("Movie Theater");
    expect(sceneLabelOf("gen_btn_shake")).toBeNull();
  });
});

describe("scene size + speed mapping", () => {
  it("maps the Size control to a genuine output long edge", () => {
    expect(sceneRenderOptions({ size: "⬜ 512px" }).longEdge).toBe(512);
    expect(sceneRenderOptions({ size: "128" }).longEdge).toBe(128);
    // No size chosen leaves the full default in place.
    expect(sceneRenderOptions({}).longEdge).toBeUndefined();
  });

  it("turns the Speed control into a playback-delay multiplier", () => {
    // Normal keeps the clip's timing; 2x plays faster (shorter delays); 0.5x slower.
    expect(sceneRenderOptions({ speed: "Normal" }).speedFactor).toBe(1);
    expect(sceneRenderOptions({ speed: "2x" }).speedFactor).toBeCloseTo(0.5);
    expect(sceneRenderOptions({ speed: "0.5x" }).speedFactor).toBeCloseTo(2);
  });

  it("forces a small, few-frame render for board previews", () => {
    const p = sceneRenderOptions({ size: "512", speed: "2x", preview: true });
    expect(p.maxFrames).toBe(10);
    expect(p.longEdge).toBeLessThanOrEqual(150);
    // Preview ignores the user Size/Speed controls entirely.
    expect(p.longEdge).not.toBe(512);
  });
});

describe("subject fit", () => {
  it("keeps a whole portrait when the screen is a very different shape", () => {
    const drawn = subjectDrawSize(240, 80, 100, 180, "cover");
    expect(drawn.w / 100).toBeCloseTo(drawn.h / 180);
    expect(drawn.h).toBeLessThanOrEqual(80.5);
    expect(drawn.w).toBeLessThan(240);
  });

  it("still fills the screen when the crop would only be a sliver", () => {
    const drawn = subjectDrawSize(100, 100, 100, 108, "cover");
    expect(drawn.w).toBeCloseTo(100);
    expect(drawn.h).toBeGreaterThan(100);
  });
});

describe("scene compositor", () => {
  it("composites the target into the green screen and keeps the foreground", async () => {
    // Bright red target so we can find it; the source green must be gone.
    const buf = await renderScene(await solid({ r: 255, g: 0, b: 0 }), "mission-passed");
    expect(buf.subarray(0, 3).toString("ascii")).toBe("GIF");
    const meta = await sharp(buf, { animated: true }).metadata();
    expect((meta.pages ?? 1)).toBeGreaterThan(1);

    // Sample a mid frame: the target red should be present, and the pure MakeEmoji
    // green should be keyed out (no strong-green pixels left).
    const mid = Math.floor((meta.pages ?? 1) / 2);
    const { data } = await sharp(buf, { page: mid }).raw().toBuffer({ resolveWithObject: true });
    let red = 0, green = 0;
    for (let i = 0; i < data.length; i += 3) {
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
      if (r > 180 && g < 90 && b < 90) red++;
      if (g > 150 && g - r > 80 && g - b > 80) green++;
    }
    expect(red).toBeGreaterThan(0);
    expect(green).toBe(0);
  }, 60_000);

  it("renders a smaller, fewer-framed preview for the board size", async () => {
    const full = await renderScene(await solid({ r: 0, g: 0, b: 255 }), "mission-passed");
    const thumb = await renderScene(
      await solid({ r: 0, g: 0, b: 255 }), "mission-passed", { longEdge: 96, maxFrames: 12 },
    );
    const fm = await sharp(full, { animated: true }).metadata();
    const tm = await sharp(thumb, { animated: true }).metadata();
    expect((tm.width ?? 0)).toBeLessThan(fm.width ?? 0);
    expect(thumb.length).toBeLessThan(full.length);
  }, 60_000);

  it("keeps both ends of a tall photo inside Dexter Locker", async () => {
    const w = 80, h = 200;
    const raw = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const top = y < h / 2;
        raw[i] = top ? 220 : 20;
        raw[i + 1] = top ? 20 : 200;
        raw[i + 2] = top ? 180 : 220;
        raw[i + 3] = 255;
      }
    }
    const image = await sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
    const gif = await renderScene(image, "dexter-locker", { longEdge: 220, maxFrames: 8, quality: 12 });
    const meta = await sharp(gif, { animated: true }).metadata();
    const mid = Math.floor((meta.pages ?? 1) / 2);
    const { data, info } = await sharp(gif, { page: mid }).raw().toBuffer({ resolveWithObject: true });
    let magenta = 0, cyan = 0;
    const ch = info.channels;
    for (let i = 0; i < data.length; i += ch) {
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
      if (r > 150 && b > 100 && g < 100) magenta++;
      if (g > 120 && b > 140 && r < 80) cyan++;
    }
    expect(magenta, "hat/top of the photo").toBeGreaterThan(8);
    expect(cyan, "body/bottom of the photo").toBeGreaterThan(8);
  }, 60_000);

  it("routes scene ids through renderOffline as a GIF", async () => {
    const result = await renderOffline({
      image: await solid({ r: 0, g: 200, b: 0 }), animation: "scene:giant-portal", format: "gif",
    });
    expect(result.format).toBe("gif");
    expect(result.providerId).toBe("offline");
    expect(result.buffer.subarray(0, 3).toString("ascii")).toBe("GIF");
  }, 60_000);
});
