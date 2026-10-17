// One body face for every canvas. napi-rs draws missing fonts as empty boxes,
// so we register a real file under DNSans before any fillText.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const CANVAS_SANS = "DNSans";

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

function bundledOrbitron(): string | null {
  const candidates = [
    fileURLToPath(new URL("../../assets/fonts/Orbitron-Bold.ttf", import.meta.url)),
    join(process.cwd(), "assets/fonts/Orbitron-Bold.ttf"),
    join(process.cwd(), "artifacts/api-server/assets/fonts/Orbitron-Bold.ttf"),
  ];
  return candidates.find(p => existsSync(p)) ?? null;
}

type FontMod = { GlobalFonts?: { registerFromPath(path: string, name?: string): boolean } };

let registered = false;

/** Register DNSans from the first font file that exists on this machine. */
export function registerCanvasSans(mod: FontMod): void {
  if (registered) return;
  registered = true;
  const reg = mod.GlobalFonts;
  if (!reg) return;
  const files = [...BODY_FILES];
  const orbitron = bundledOrbitron();
  if (orbitron) files.push(orbitron);
  for (const path of files) {
    if (!existsSync(path)) continue;
    try { reg.registerFromPath(path, CANVAS_SANS); } catch { /* try the next file */ }
  }
}

export const CANVAS_SANS_STACK = `"${CANVAS_SANS}", "DejaVu Sans", "Liberation Sans", sans-serif`;
