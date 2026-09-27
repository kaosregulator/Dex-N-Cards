#!/usr/bin/env node
/**
 * Re-harvest DEFAULT_CARDS candidates from the public valuevaultx.com feed.
 * Writes JSON to stdout / optional --out path. Does not modify cards-data.ts
 * automatically — review the JSON, then paste or run the agent update step.
 *
 * Usage:
 *   node scripts/harvest-vault-defaults.mjs
 *   node scripts/harvest-vault-defaults.mjs --out /tmp/defaults.json
 */
import { writeFileSync } from "node:fs";

const FEED = "https://valuevaultx.com/_functions/api/MTSValueList";
const MAP = {
  Common: "common",
  Uncommon: "uncommon",
  Rare: "rare",
  Epic: "epic",
  Legendary: "legendary",
  Exotic: "mythic",
  "Limited Edition": "mythic",
};
const WORTH = { common: 10, uncommon: 50, rare: 200, epic: 750, legendary: 2500, mythic: 6000 };
const BURN = { common: 5, uncommon: 25, rare: 100, epic: 375, legendary: 1250, mythic: 3000 };
const WEIGHT = { common: 60, uncommon: 25, rare: 10, epic: 4, legendary: 1, mythic: 0 };
const TARGET = { common: 12, uncommon: 8, rare: 10, epic: 10, legendary: 12, mythic: 8 };
const hardSkip = /crate|\bskin\b|emote|spray|decal/i;

const outIdx = process.argv.indexOf("--out");
const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : null;

const resp = await fetch(FEED, { signal: AbortSignal.timeout(20_000) });
if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
const items = await resp.json();
if (!Array.isArray(items)) throw new Error("Unexpected feed shape");

const by = { common: [], uncommon: [], rare: [], epic: [], legendary: [], mythic: [] };
for (const it of items) {
  const sr = (it.suggestedRarity || "").trim();
  const key = MAP[sr];
  if (!key) continue;
  const imageUrl = it.imagelink;
  if (!imageUrl || !/static\.wixstatic\.com/i.test(imageUrl) || !it.title) continue;
  if (hardSkip.test(it.title)) continue;
  if (key !== "uncommon" && /banner|emblem|badge|camo|\btitle\b/i.test(it.title)) continue;
  const note = (it.note || "").trim() || `${sr} Military Tycoon item.`;
  const avg = ((it.gemValueLow ?? 0) + (it.gemValueHigh ?? 0)) / 2;
  by[key].push({ it, key, sr, imageUrl, avg, note });
}

const picked = [];
for (const [r, n] of Object.entries(TARGET)) {
  let pool = by[r].slice();
  if (r === "mythic") {
    pool.sort(
      (a, b) =>
        (b.sr === "Limited Edition") - (a.sr === "Limited Edition") || b.avg - a.avg,
    );
  } else {
    pool.sort((a, b) => b.avg - a.avg);
  }
  const step = Math.max(1, Math.floor(pool.length / Math.max(n, 1)));
  const chosen = [];
  for (let i = 0; i < pool.length && chosen.length < n; i += step) chosen.push(pool[i]);
  for (const x of pool) {
    if (chosen.length >= n) break;
    if (!chosen.includes(x)) chosen.push(x);
  }
  for (const x of chosen.slice(0, n)) {
    const type =
      (x.it.category || "vehicle")
        .toLowerCase()
        .replace(/[^a-z0-9 +/\-]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40) || "vehicle";
    picked.push({
      name: x.it.title,
      description: x.note.slice(0, 450),
      rarity: x.key,
      cardType: type,
      dropWeight: WEIGHT[x.key],
      worthValue: WORTH[x.key],
      burnValue: BURN[x.key],
      imageUrl: x.imageUrl,
      isLimitedEdition: x.sr === "Limited Edition",
      inPacks: x.key !== "mythic",
      droppable: x.key !== "mythic",
      vaultRarity: x.sr,
    });
  }
}

const json = JSON.stringify(picked, null, 2);
if (outPath) writeFileSync(outPath, json);
else process.stdout.write(json + "\n");
console.error(
  "harvested",
  picked.length,
  Object.fromEntries(Object.keys(TARGET).map((r) => [r, picked.filter((x) => x.rarity === r).length])),
);
