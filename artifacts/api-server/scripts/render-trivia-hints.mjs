#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] || "/opt/cursor/artifacts";

async function main() {
  const modUrl = pathToFileURL(join(here, "../src/bot/trivia/hint-canvas.ts")).href;
  const { renderTriviaHintCard } = await import(modUrl);
  await mkdir(outDir, { recursive: true });
  for (const n of [0, 2, 6, 12]) {
    const att = await renderTriviaHintCard({ answer: "Dark Night Titan", uniqueGuessCount: n });
    if (!att) {
      console.error("failed", n);
      continue;
    }
    const raw = att.attachment;
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const path = join(outDir, `trivia-hint-g${n}.png`);
    await writeFile(path, buf);
    console.log("wrote", path, buf.length);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
