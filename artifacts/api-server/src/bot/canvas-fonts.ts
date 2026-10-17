// One body face for every canvas, plus symbol and color-emoji fallbacks.
// napi-rs draws a missing glyph as an empty box. System names like "DejaVu Sans"
// only resolve after we register the file, and a display font a server picks
// (Orbitron, a quote theme, BATTLE_FONT_DISPLAY) still has no emoji. Every
// ctx.font assignment therefore ends with DNSymbol + DNEmoji.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const CANVAS_SANS = "DNSans";
export const CANVAS_SYMBOL = "DNSymbol";
export const CANVAS_EMOJI = "DNEmoji";

const BODY_FILES = [
  "/usr/share/fonts/truetype/macos/Inter-Regular.ttf",
  "/usr/share/fonts/truetype/macos/Inter-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
  "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
];

const NAMED_FILES: Array<[string, string]> = [
  ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "DejaVu Sans"],
  ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "DejaVu Sans"],
  ["/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", "Liberation Sans"],
  ["/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf", "Liberation Sans"],
];

const SYMBOL_FILES = [
  "/usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf",
  "/usr/share/fonts/truetype/noto/NotoSansSymbols-Regular.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
];

const EMOJI_FILES = [
  "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
];

function bundledOrbitron(): string | null {
  const candidates = [
    fileURLToPath(new URL("../../assets/fonts/Orbitron-Bold.ttf", import.meta.url)),
    join(process.cwd(), "assets/fonts/Orbitron-Bold.ttf"),
    join(process.cwd(), "artifacts/api-server/assets/fonts/Orbitron-Bold.ttf"),
  ];
  return candidates.find(p => existsSync(p)) ?? null;
}

type FontReg = { registerFromPath(path: string, name?: string): boolean };
type FontMod = {
  GlobalFonts?: FontReg;
  createCanvas?: (width: number, height: number) => { getContext(kind: "2d"): object };
};

export type EmojiPaintMode = "fill" | "stroke";
export type EmojiPaintCtx = {
  font: string;
  textAlign: string;
  textBaseline: string;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  strokeText(text: string, x: number, y: number, maxWidth?: number): void;
  measureText(text: string): { width: number };
  drawImage(img: unknown, x: number, y: number, w: number, h: number): void;
};
export type EmojiPaintOriginals = {
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  strokeText(text: string, x: number, y: number, maxWidth?: number): void;
};
export type EmojiPainter = (
  ctx: EmojiPaintCtx,
  text: string,
  x: number,
  y: number,
  maxWidth: number | undefined,
  mode: EmojiPaintMode,
  originals: EmojiPaintOriginals,
) => boolean;

let emojiPainter: EmojiPainter | null = null;

/** Installed by the emoji text module. Looked up on each fill so load order cannot miss it. */
export function setCanvasEmojiPainter(painter: EmojiPainter): void {
  emojiPainter = painter;
}

let bodyRegistered = false;
let emojiRegistered = false;
let hookInstalled = false;

/** Append symbol + color-emoji families so a display font still draws ★ and emoji. */
export function withEmojiFonts(font: string): string {
  if (!font || font.includes(CANVAS_EMOJI)) return font;
  const generic = font.match(/,\s*(sans-serif|serif|monospace|cursive|fantasy)\s*$/);
  const extra = `"${CANVAS_SYMBOL}", "${CANVAS_EMOJI}"`;
  if (generic && generic.index != null) {
    return `${font.slice(0, generic.index)}, ${extra}, ${generic[1]}`;
  }
  return `${font}, ${extra}`;
}

/** Register DNSans, named fallbacks, and the emoji faces. Safe to call more than once. */
export function registerCanvasSans(mod: FontMod): void {
  const reg = mod.GlobalFonts;
  if (reg && !bodyRegistered) {
    bodyRegistered = true;
    const files = [...BODY_FILES];
    const orbitron = bundledOrbitron();
    if (orbitron) files.push(orbitron);
    for (const path of files) {
      if (!existsSync(path)) continue;
      try { reg.registerFromPath(path, CANVAS_SANS); } catch { /* try the next file */ }
    }
    for (const [path, family] of NAMED_FILES) {
      if (!existsSync(path)) continue;
      try { reg.registerFromPath(path, family); } catch { /* optional */ }
    }
  }
  if (reg && !emojiRegistered) {
    emojiRegistered = true;
    for (const path of SYMBOL_FILES) {
      if (!existsSync(path)) continue;
      try { reg.registerFromPath(path, CANVAS_SYMBOL); } catch { /* try the next file */ }
    }
    for (const path of EMOJI_FILES) {
      if (!existsSync(path)) continue;
      try { reg.registerFromPath(path, CANVAS_EMOJI); } catch { /* color emoji is optional */ }
    }
  }
  installFontHook(mod);
}

export const CANVAS_SANS_STACK = withEmojiFonts(
  `"${CANVAS_SANS}", "DejaVu Sans", "Liberation Sans", sans-serif`,
);

const HOOK = Symbol.for("dn.canvas.emojiFonts");

function installFontHook(mod: FontMod): void {
  if (hookInstalled || !mod.createCanvas) return;
  let ctx: object;
  try {
    ctx = mod.createCanvas(1, 1).getContext("2d");
  } catch {
    return;
  }
  const proto = Object.getPrototypeOf(ctx) as object & { [HOOK]?: boolean };
  if (!proto || proto[HOOK]) {
    hookInstalled = true;
    return;
  }

  const fontDesc = Object.getOwnPropertyDescriptor(proto, "font");
  if (fontDesc?.get && fontDesc?.set) {
    const get = fontDesc.get;
    const set = fontDesc.set;
    Object.defineProperty(proto, "font", {
      configurable: true,
      enumerable: fontDesc.enumerable ?? true,
      get() { return get.call(this); },
      set(value: string) {
        set.call(this, typeof value === "string" ? withEmojiFonts(value) : value);
      },
    });
  }

  const fillDesc = Object.getOwnPropertyDescriptor(proto, "fillText");
  const strokeDesc = Object.getOwnPropertyDescriptor(proto, "strokeText");
  const origFill = fillDesc?.value as EmojiPaintOriginals["fillText"] | undefined;
  const origStroke = strokeDesc?.value as EmojiPaintOriginals["strokeText"] | undefined;
  if (typeof origFill === "function" && typeof origStroke === "function") {
    const originals: EmojiPaintOriginals = {
      fillText: origFill,
      strokeText: origStroke,
    };
    const wrap = (mode: EmojiPaintMode, orig: EmojiPaintOriginals["fillText"]) =>
      function (this: EmojiPaintCtx, text: string, x: number, y: number, maxWidth?: number) {
        if (typeof text === "string" && emojiPainter) {
          try {
            if (emojiPainter(this, text, x, y, maxWidth, mode, originals)) return;
          } catch { /* fall through to the plain string */ }
        }
        return orig.call(this, text, x, y, maxWidth);
      };
    Object.defineProperty(proto, "fillText", {
      configurable: true,
      writable: true,
      value: wrap("fill", origFill),
    });
    Object.defineProperty(proto, "strokeText", {
      configurable: true,
      writable: true,
      value: wrap("stroke", origStroke),
    });
  }

  proto[HOOK] = true;
  hookInstalled = true;
}
