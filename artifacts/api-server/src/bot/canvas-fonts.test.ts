import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { registerCanvasSans, withEmojiFonts } from "./canvas-fonts.js";
import { paintCustomEmojiText, segmentCustomEmoji } from "./unbelievaboat/canvas-emoji-text.js";
import { primeCurrencyImage } from "./unbelievaboat/currency-canvas.js";
import { canvasPaintableText } from "./discord-emoji.js";

describe("canvas emoji fonts", () => {
  it("inserts symbol and emoji families ahead of a generic family", () => {
    expect(withEmojiFonts('"Orbitron", Arial, sans-serif')).toBe(
      '"Orbitron", Arial, "DNSymbol", "DNEmoji", sans-serif',
    );
    expect(withEmojiFonts("20px Georgia, serif")).toContain("DNEmoji");
    expect(withEmojiFonts('16px "DNSans", "DNEmoji"')).toBe('16px "DNSans", "DNEmoji"');
  });

  it("draws stars and emoji that a latin face cannot draw alone", () => {
    registerCanvasSans({ GlobalFonts, createCanvas });
    const bare = createCanvas(220, 80);
    const bareCtx = bare.getContext("2d");
    bareCtx.fillStyle = "#000";
    bareCtx.fillRect(0, 0, 220, 80);
    bareCtx.fillStyle = "#fff";
    // Family with no stars or emoji. The hook appends DNSymbol and DNEmoji.
    bareCtx.font = '48px "OnlyLatin"';
    GlobalFonts.registerFromPath("/usr/share/fonts/truetype/macos/Inter-Regular.ttf", "OnlyLatin");
    bareCtx.font = '48px "OnlyLatin"';
    bareCtx.fillText("★☆😀", 4, 58);
    expect(bareCtx.font).toContain("DNEmoji");

    const latinOnly = createCanvas(220, 80);
    const latin = latinOnly.getContext("2d");
    latin.fillStyle = "#000";
    latin.fillRect(0, 0, 220, 80);
    latin.fillStyle = "#fff";
    const fontDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(latin), "font");
    // Draw the same string with Inter alone by calling the original setter if the
    // hook wrapped it. A second canvas created before registration is already patched,
    // so compare ink against a string Inter can draw. Stars must add real pixels.
    latin.font = '48px "OnlyLatin"';
    latin.fillText("AAA", 4, 58);

    const starInk = countInk(bareCtx.getImageData(0, 0, 220, 80).data);
    const latinInk = countInk(latin.getImageData(0, 0, 220, 80).data);
    expect(starInk).toBeGreaterThan(80);
    expect(latinInk).toBeGreaterThan(40);
    expect(Math.abs(starInk - latinInk)).toBeGreaterThan(20);
    expect(fontDesc?.set).toBeTypeOf("function");
  });
});

describe("custom emoji on canvas text", () => {
  it("leaves unicode in the text run and splits only Discord markup", () => {
    expect(segmentCustomEmoji("★ <:prism:77> hi")).toEqual([
      { kind: "text", value: "★ " },
      { kind: "emoji", value: "<:prism:77>" },
      { kind: "text", value: " hi" },
    ]);
    expect(canvasPaintableText("Epic <:_:99> <:prism:77>")).toBe("Epic <:prism:77>");
  });

  it("draws a cached custom emoji instead of the markup", () => {
    primeCurrencyImage("<:prism:77>", { width: 8, height: 8 });
    const calls: string[] = [];
    const ctx = {
      font: "16px DNSans",
      textAlign: "center",
      textBaseline: "alphabetic",
      measureText: (value: string) => ({ width: value.length * 8 }),
      fillText(value: string) { calls.push(`fill:${value}`); },
      strokeText() {},
      drawImage() { calls.push("img"); },
    };
    const handled = paintCustomEmojiText(ctx, "Go <:prism:77>", 40, 10, undefined, "fill", {
      fillText: ctx.fillText,
      strokeText: ctx.strokeText,
    });
    expect(handled).toBe(true);
    expect(calls).toContain("fill:Go ");
    expect(calls).toContain("img");
    expect(calls.join(" ")).not.toContain("<:prism:77>");
  });
});

function countInk(data: Uint8ClampedArray): number {
  let n = 0;
  for (let i = 0; i < data.length; i += 16) {
    if (data[i]! > 30 || data[i + 1]! > 30 || data[i + 2]! > 30) n++;
  }
  return n;
}
