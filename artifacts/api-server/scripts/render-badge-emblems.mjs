#!/usr/bin/env node
/** Render sample evolving badge emblem GIFs for walkthrough artifacts. */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] || "/opt/cursor/artifacts/badge-emblems";

async function main() {
  // Import compiled-adjacent TS via tsx-style dynamic path used in vitest/dev.
  const modUrl = pathToFileURL(join(here, "../src/bot/badges/emblem-canvas.ts")).href;
  const { renderBadgeEmblemGif } = await import(modUrl);

  await mkdir(outDir, { recursive: true });
  const samples = [
    { level: 1, name: "Trivia Winner", emoji: "🧠", file: "emblem-lv01-kindling.gif" },
    { level: 12, name: "Trivia Winner", emoji: "🧠", file: "emblem-lv12-aurora.gif" },
    { level: 30, name: "Trivia Winner", emoji: "🧠", file: "emblem-lv30-radiant.gif" },
    { level: 55, name: "Flash Champ", emoji: "⚡", file: "emblem-lv55-eclipse.gif" },
    { level: 80, name: "QOTD Champion", emoji: "☀️", file: "emblem-lv80-celestial.gif" },
    { level: 100, name: "Brainiac", emoji: "🟣", file: "emblem-lv100-apex.gif" },
  ];

  for (const s of samples) {
    const buf = await renderBadgeEmblemGif({
      name: s.name,
      emoji: s.emoji,
      level: s.level,
      subtitle: `Preview · Lv. ${s.level}`,
      seed: `preview-${s.file}`,
    });
    if (!buf) {
      console.error("failed", s.file);
      continue;
    }
    const path = join(outDir, s.file);
    await writeFile(path, buf);
    console.log("wrote", path, buf.length, "bytes");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
