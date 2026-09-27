#!/usr/bin/env node
/**
 * Re-harvest DEFAULT_CARDS from valuevaultx.com (vehicles/soldiers preferred).
 * Usage:
 *   node scripts/harvest-vault-defaults.mjs --out /tmp/defaults.json
 */
import { writeFileSync } from "node:fs";

const FEED = "https://valuevaultx.com/_functions/api/MTSValueList";
const MAP = {
  Common: { rarity: "common", limited: false, custom: null },
  Uncommon: { rarity: "uncommon", limited: false, custom: null },
  Rare: { rarity: "rare", limited: false, custom: null },
  Epic: { rarity: "epic", limited: false, custom: null },
  Legendary: { rarity: "legendary", limited: false, custom: null },
  Exotic: { rarity: "legendary", limited: false, custom: "exotic" },
  "Limited Edition": { rarity: "mythic", limited: true, custom: null },
};
const WORTH = { common: 10, uncommon: 50, rare: 200, epic: 750, legendary: 2500, mythic: 6000 };
const BURN = { common: 5, uncommon: 25, rare: 100, epic: 375, legendary: 1250, mythic: 3000 };
const WEIGHT = { common: 60, uncommon: 25, rare: 10, epic: 4, legendary: 1, mythic: 0 };
const TARGET = { common: 20, uncommon: 17, rare: 20, epic: 20, legendary: 40, exotic: 25, mythic: 30 };
const preferCat = /^(Air|Ground|Naval|Soldiers|Weapon|Drones|Tool|Armor)$/i;
const bannerish = /banner|emblem|emote|name.?plate|\btitle\b|camo|\bskin\b|spray|decal|badge/i;
const hardSkip = /emote|spray|decal/i;

const outIdx = process.argv.indexOf("--out");
const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : null;

const resp = await fetch(FEED, { signal: AbortSignal.timeout(20_000) });
if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
const items = await resp.json();
if (!Array.isArray(items)) throw new Error("Unexpected feed shape");

function scoreItem(it) {
  const cat = (it.category || "").trim();
  const title = it.title || "";
  let s = 0;
  if (preferCat.test(cat)) s += 100;
  if (/soldier|troop|infantry/i.test(cat) || /soldier|trooper|infantry/i.test(title)) s += 40;
  if (/weapon|gun|rpg|rail/i.test(cat) || /weapon|gun|rpg|sniper/i.test(title)) s += 30;
  if (bannerish.test(cat) || bannerish.test(title)) s -= 80;
  if (hardSkip.test(cat) || hardSkip.test(title)) s -= 200;
  s += Math.min(20, (it.note || "").trim().length / 20);
  const avg = ((it.gemValueLow ?? 0) + (it.gemValueHigh ?? 0)) / 2;
  s += Math.min(15, Math.log10(avg + 1) * 3);
  return s;
}

const by = { common: [], uncommon: [], rare: [], epic: [], legendary: [], mythic: [], exotic: [] };
for (const it of items) {
  const sr = (it.suggestedRarity || "").trim();
  const m = MAP[sr];
  if (!m || !it.imagelink || !/static\.wixstatic\.com/i.test(it.imagelink) || !it.title) continue;
  if (hardSkip.test(it.title) || hardSkip.test(it.category || "")) continue;
  const note = (it.note || "").trim() || `${sr} Military Tycoon item.`;
  const avg = ((it.gemValueLow ?? 0) + (it.gemValueHigh ?? 0)) / 2;
  const row = { it, sr, ...m, imageUrl: it.imagelink, avg, note, score: scoreItem(it) };
  if (m.custom === "exotic") by.exotic.push(row);
  else by[m.rarity].push(row);
}

function pick(pool, n) {
  const sorted = pool.slice().sort((a, b) => b.score - a.score || b.avg - a.avg);
  const prefer = [], rest = [];
  for (const x of sorted) (x.score >= 50 ? prefer : rest).push(x);
  const out = [];
  for (const x of prefer) { if (out.length >= n) break; out.push(x); }
  for (const x of rest) { if (out.length >= n) break; out.push(x); }
  return out;
}

const picked = [];
for (const [key, n] of Object.entries(TARGET)) {
  for (const x of pick(by[key], n)) {
    const type = (x.it.category || "vehicle").toLowerCase().replace(/[^a-z0-9 +/\-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || "vehicle";
    const rarity = x.custom === "exotic" ? "legendary" : x.rarity;
    picked.push({
      name: x.it.title,
      description: x.note.slice(0, 450),
      rarity,
      cardType: type,
      dropWeight: WEIGHT[rarity],
      worthValue: x.custom === "exotic" ? 4000 : WORTH[rarity],
      burnValue: x.custom === "exotic" ? 2000 : BURN[rarity],
      imageUrl: x.imageUrl,
      isLimitedEdition: !!x.limited,
      inPacks: rarity !== "mythic",
      droppable: rarity !== "mythic",
      customRaritySlug: x.custom || undefined,
      vaultRarity: x.sr,
    });
  }
}

const json = JSON.stringify(picked, null, 2);
if (outPath) writeFileSync(outPath, json);
else process.stdout.write(json + "\n");
const counts = {};
for (const c of picked) {
  const k = c.customRaritySlug || c.rarity;
  counts[k] = (counts[k] || 0) + 1;
}
console.error("harvested", picked.length, counts);
