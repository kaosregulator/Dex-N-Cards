// DN Cards — DarkNight Military Card Roster
// Default roster is harvested from valuevaultx.com (images + descriptions + site rarities).
// Load via /setup → Load Defaults or !loaddefaults. Per-guild rarity nicknames / profiles always win.
//
// Drop weights (higher = more common) — aligned to Vault Values ladder:
//   Common: 60 · Uncommon: 25 · Rare: 10 · Epic: 4 · Legendary: 1 · Exotic: 0 (admin/event)

export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary" | "mythic";
export type CardType = string; // free-form label — any text the admin types

// Built-in rarity display order (DB enum key → Vault Values–aligned label):
//   Common → Uncommon → Rare → Epic → Legendary → Exotic (mythic key; Limited Edition uses isLimitedEdition)
// Extra/event exclusives still use the mythic key with weight 0 unless boosted.
export const RARITY_WEIGHTS: Record<Rarity, number> = {
  common: 60,
  uncommon: 25,
  rare: 10,
  epic: 4,
  legendary: 1,
  mythic: 0,
};

export const RARITY_WORTH: Record<Rarity, number> = {
  common: 10,
  uncommon: 50,
  rare: 200,
  epic: 750,
  legendary: 2500,
  mythic: 6000,
};

export const RARITY_BURN: Record<Rarity, number> = {
  common: 5,
  uncommon: 25,
  rare: 100,
  epic: 375,
  legendary: 1250,
  mythic: 3000,
};

export const RARITY_COLORS: Record<Rarity, number> = {
  common: 0x95a5a6,    // gray
  uncommon: 0x2ecc71,  // green
  rare: 0x3498db,      // blue
  epic: 0x9b59b6,      // purple
  legendary: 0xf39c12, // gold
  mythic: 0xff2d92,    // pink-magenta — admin can change via /rarity edit
};

export const RARITY_EMOJI: Record<Rarity, string> = {
  common: "⚪",
  uncommon: "🟢",
  rare: "🔵",
  epic: "🟣",
  legendary: "🌟",
  mythic: "🔮",
};

/**
 * Discord StringSelectMenu options only accept Unicode emojis or {id,name} custom emoji objects.
 * Custom emoji shortcodes (e.g. ":yellow_heart:") crash the option builder with COMPONENT_INVALID_EMOJI.
 * This helper falls back to a safe Unicode emoji when the resolved value is not usable.
 */
export function selectMenuEmoji(
  emoji: string | undefined | null,
  fallback: string,
): { name: string } {
  // Strip Unicode variation selectors (U+FE00–U+FE0F) — Discord rejects them
  // as invalid emoji names (COMPONENT_INVALID_EMOJI).
  const e = (emoji?.trim() ?? "").replace(/[\uFE00-\uFE0F]/g, "");
  // Shortcodes contain colons; plain text/IDs are not valid option emojis either.
  const isUnicode = e.length > 0 && !e.includes(":") && /^\p{Extended_Pictographic}/u.test(e);
  return { name: isUnicode ? e : fallback };
}

// ── Per-guild rarity display overrides ───────────────────────────────────────
// Admins can rename any of the 6 built-in rarity tiers for their server via
// `/rarity edit` — changing the display name, emoji, and/or embed color.
// This map is fetched once per interaction from the `rarity_display_overrides`
// table (5s per-guild cache) and passed as the 3rd argument to the three
// resolver helpers below. The gameplay economy (worth/burn/dropWeight) is
// completely unaffected.
export type RarityDisplayMap = Map<Rarity, {
  displayName?: string | null;
  emoji?: string | null;
  color?: number | null;
}>;

// ── Mythic per-guild display ─────────────────────────────────────────────────
// Legacy helper — kept for callers that only need the mythic override pulled
// from GuildSettings. New code should use rarityLabel/rarityEmoji/rarityColor
// with a RarityDisplayMap instead.
export function getMythicDisplay(
  settings?: { mythicLabel?: string | null; mythicEmoji?: string | null; mythicColor?: number | null } | null,
): { label: string; emoji: string; color: number } {
  return {
    label: settings?.mythicLabel?.trim() || RARITY_LABELS.mythic,
    emoji: settings?.mythicEmoji?.trim() || RARITY_EMOJI.mythic,
    color: settings?.mythicColor ?? RARITY_COLORS.mythic,
  };
}

/** Canonical built-in rarity key order. */
export const BUILTIN_RARITIES: Rarity[] = ["common", "uncommon", "rare", "epic", "legendary", "mythic"];

/**
 * Canonical rarity ladder (low → high). THE single source of truth for rarity
 * ordering across the whole project — catch, packs, trade, battles, raids, and
 * stat scaling all rank rarity through {@link rarityRank}. Do not redefine this
 * ordering anywhere else; import from here.
 */
export const RARITY_ORDER: Rarity[] = [...BUILTIN_RARITIES];

/**
 * Numeric rank of a rarity on the canonical ladder (common = 0 … mythic = 5).
 * Unknown/custom keys fall back to 0 so callers never crash on an unexpected
 * tier — custom economy tiers should be resolved to a built-in base first via
 * the guild rarity context.
 */
export function rarityRank(r: Rarity | string): number {
  const i = RARITY_ORDER.indexOf(r as Rarity);
  return i < 0 ? 0 : i;
}

/**
 * Return the per-guild display order for built-in rarities, falling back to
 * the canonical key order. Invalid or partial arrays are sanitized so the
 * result always contains exactly one entry for every built-in rarity.
 */
export function getRarityOrder(
  settings?: { rarityOrder?: string[] | null } | null,
): Rarity[] {
  const order = settings?.rarityOrder;
  if (!order || order.length === 0) return [...BUILTIN_RARITIES];
  const seen = new Set<Rarity>();
  const valid: Rarity[] = [];
  for (const r of order) {
    if (BUILTIN_RARITIES.includes(r as Rarity) && !seen.has(r as Rarity)) {
      seen.add(r as Rarity);
      valid.push(r as Rarity);
    }
  }
  // Append any missing rarities in canonical order so the result is always complete.
  for (const r of BUILTIN_RARITIES) {
    if (!seen.has(r)) valid.push(r);
  }
  return valid;
}

/**
 * Resolves the display label for a rarity, with two layers of per-guild override:
 *   1. `displayMap` — per-rarity override from `rarity_display_overrides` (highest priority)
 *   2. `settings.mythicLabel` — legacy Mythic-only rename from `guild_settings`
 *   3. `RARITY_LABELS[r]` — static default
 */
export function rarityLabel(
  r: Rarity,
  settings?: { mythicLabel?: string | null } | null,
  displayMap?: RarityDisplayMap | null,
): string {
  const ov = displayMap?.get(r);
  if (ov?.displayName?.trim()) return ov.displayName.trim();
  if (r === "mythic" && settings?.mythicLabel?.trim()) return settings.mythicLabel.trim();
  return RARITY_LABELS[r];
}

/**
 * Resolves the display emoji for a rarity, with two layers of per-guild override:
 *   1. `displayMap` — per-rarity override from `rarity_display_overrides`
 *   2. `settings.mythicEmoji` — legacy Mythic-only emoji from `guild_settings`
 *   3. `RARITY_EMOJI[r]` — static default
 */
export function rarityEmoji(
  r: Rarity,
  settings?: { mythicEmoji?: string | null } | null,
  displayMap?: RarityDisplayMap | null,
): string {
  const ov = displayMap?.get(r);
  if (ov?.emoji?.trim()) return ov.emoji.trim();
  if (r === "mythic" && settings?.mythicEmoji?.trim()) return settings.mythicEmoji.trim();
  return RARITY_EMOJI[r];
}

/**
 * Resolves the embed color for a rarity, with two layers of per-guild override:
 *   1. `displayMap` — per-rarity override from `rarity_display_overrides`
 *   2. `settings.mythicColor` — legacy Mythic-only color from `guild_settings`
 *   3. `RARITY_COLORS[r]` — static default
 */
export function rarityColor(
  r: Rarity,
  settings?: { mythicColor?: number | null } | null,
  displayMap?: RarityDisplayMap | null,
): number {
  const ov = displayMap?.get(r);
  if (ov?.color != null) return ov.color;
  if (r === "mythic" && settings?.mythicColor != null) return settings.mythicColor;
  return RARITY_COLORS[r] ?? 0x5865f2;
}

// ── Shiny cards ──────────────────────────────────────────────────────────────
// Fixed across all servers (not configurable): every successful acquisition
// (catch, pack, tradein reward) has a flat 0.5% chance to be Shiny. Shiny
// copies are tracked separately and count at 2× normal worth/burn value.
// Admin-given cards (/give) and trades never mint shinies.
export const SHINY_RATE = 0.005;
export const SHINY_MULTIPLIER = 2;
export const SHINY_EMOJI = "✨";

import type { GuildSettings } from "@workspace/db";

type ShinySettings = { shinyValueMultiplier?: number | null; shinyName?: string | null };

export function getShinyMultiplier(settings?: ShinySettings | GuildSettings | null): number {
  const value = Number((settings as ShinySettings | null)?.shinyValueMultiplier);
  return Number.isFinite(value) && value >= 0.1 && value <= 100 ? value : SHINY_MULTIPLIER;
}

export function getShinyName(settings?: ShinySettings | GuildSettings | null): string {
  const name = (settings as ShinySettings | null)?.shinyName?.trim();
  return name ? name.slice(0, 32) : "Shiny";
}

// Trade fairness: warn when one side's total value is more than 3× the
// other side's. Pure shards count 1:1 with shard value; cards use worthValue.
// Shinies are not tradeable in v1 so they don't enter this calc.
export const FAIRNESS_RATIO_THRESHOLD = 3;

export const RARITY_LABELS: Record<Rarity, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  epic: "Epic",
  legendary: "Legendary",
  mythic: "Exotic", // Limited Edition cards also use this key + isLimitedEdition
};

export const TYPE_EMOJI: Record<string, string> = {
  tank: "🪖",
  aircraft: "✈️",
  ship: "🚢",
  vehicle: "🚗",
  infantry: "👤",
  boss: "💀",
  community: "👑",
  event: "🎆",
  achievement: "🏅",
  limited: "💎",
};

/** Safe emoji lookup — returns 🃏 for any unknown label so custom types don't crash. */
export function getTypeEmoji(cardType: string | undefined | null): string {
  if (!cardType) return "🃏";
  return TYPE_EMOJI[cardType.toLowerCase()] ?? "🃏";
}

// ── Collector Ranks (by unique cards owned) ───────────────────────────────────
export const COLLECTOR_RANKS = [
  { name: "Recruit",       emoji: "🪖",  min: 0   },
  { name: "Private",       emoji: "⭐",  min: 5   },
  { name: "Corporal",      emoji: "⭐⭐", min: 15  },
  { name: "Sergeant",      emoji: "🎖️",  min: 30  },
  { name: "Lieutenant",    emoji: "🔰",  min: 50  },
  { name: "Captain",       emoji: "🏅",  min: 75  },
  { name: "Colonel",       emoji: "🌟",  min: 100 },
  { name: "General",       emoji: "💎",  min: 150 },
  { name: "Dark Commander",emoji: "👑",  min: 200 },
];

export function getCollectorRank(uniqueCards: number) {
  let rank = COLLECTOR_RANKS[0];
  for (const r of COLLECTOR_RANKS) {
    if (uniqueCards >= r.min) rank = r;
    else break;
  }
  return rank;
}

export function getNextRank(uniqueCards: number) {
  for (const r of COLLECTOR_RANKS) {
    if (uniqueCards < r.min) return r;
  }
  return null;
}

// ── Default Card Roster ───────────────────────────────────────────────────────
// Harvested from valuevaultx.com MTS value list (images + notes + suggestedRarity).
// Loaded via /setup → Load Defaults / !loaddefaults. Guild rarity nicknames still win.
export interface DefaultCard {
  name: string;
  description?: string;
  flavor?: string;
  rarity: Rarity;
  cardType: CardType;
  dropWeight: number;
  worthValue: number;
  burnValue: number;
  droppable?: boolean;
  isLimitedEdition?: boolean;
  isEventExclusive?: boolean;
  maxCopies?: number;
  inPacks?: boolean;
  imageUrl?: string;
  previewAnimation?: string;
  previewBgColor?: string;
  displayOrientation?: string;
}

export const DEFAULT_CARDS: DefaultCard[] = [
  {
    name: "Anti-Air Turret",
    description: "The Anti-Air Turret is a tool that can be placed down to attack enemy aircraft. The Turret only shoots enemy aircraft and boss aircraft. It doesn't seem to attack players or troops. The Anti-Air Turret has a cooldown of 5 minutes after being placed. The damage dealt by the Anti-Air Turret is average and on par with a machine gun from other common rarity aircraft.",
    rarity: "common", cardType: "tool",
    dropWeight: 60, worthValue: 10, burnValue: 5,
    imageUrl: "https://static.wixstatic.com/media/6511c0_d6b5bd5824a744109d7341ee9135c10b~mv2.png/v1/fill/w_111,h_123,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_d6b5bd5824a744109d7341ee9135c10b~mv2.png",
  },
  {
    name: "Sand Hyena",
    description: "A Buildable vehicle that is good for moving around the map due to its speed and grappler.(Spec-ops)",
    rarity: "common", cardType: "ground",
    dropWeight: 60, worthValue: 10, burnValue: 5,
    imageUrl: "https://static.wixstatic.com/media/6511c0_c0efa77dde334e4aa3bc6abfe0a9334a~mv2.png/v1/fill/w_183,h_203,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_c0efa77dde334e4aa3bc6abfe0a9334a~mv2.png",
  },
  {
    name: "F-22",
    description: "One of the worst planes currently with 4 missiles and one of the weakest machine guns.",
    rarity: "common", cardType: "air",
    dropWeight: 60, worthValue: 10, burnValue: 5,
    imageUrl: "https://static.wixstatic.com/media/6511c0_89b9b47d4f4c49639bdc6ee1cc8314ef~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-04-06%20233740.png",
  },
  {
    name: "Fighter Biplane",
    description: "Good for arsenal levels. One of the few Transport class vehicles that has weapons.(Tycoon)",
    rarity: "common", cardType: "air",
    dropWeight: 60, worthValue: 10, burnValue: 5,
    imageUrl: "https://static.wixstatic.com/media/6511c0_04e431aa76614c149dcf5fb0dbe45c68~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-04-06%20233626.png",
  },
  {
    name: "Boat",
    description: "A cheap tycoon vehicle that makes travelling in water faster.",
    rarity: "common", cardType: "naval",
    dropWeight: 60, worthValue: 10, burnValue: 5,
    imageUrl: "https://static.wixstatic.com/media/1abc74_8de44ba6d9ae4542a4e551620fc3ecee~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/kuva_2025-04-08_152209112.png",
  },
  {
    name: "Gun Boat",
    description: "A small but agile boat with a passenger controlled explosive mahcine gun.",
    rarity: "common", cardType: "naval",
    dropWeight: 60, worthValue: 10, burnValue: 5,
    imageUrl: "https://static.wixstatic.com/media/1abc74_22fdbde9a01244a39502c09d13ffddaf~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/kuva_2025-04-08_152112958.png",
  },
  {
    name: "Jetski",
    description: "Good for arsenal levels.",
    rarity: "common", cardType: "naval",
    dropWeight: 60, worthValue: 10, burnValue: 5,
    imageUrl: "https://static.wixstatic.com/media/1abc74_1b26f5003e3e4583b5edbacae1fec09b~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/kuva_2025-04-08_151956283.png",
  },
  {
    name: "B-17",
    description: "A decent plane for beginners with its high DPS but it is easy to kill with most AA vehicles.(Buildable)",
    rarity: "common", cardType: "air",
    dropWeight: 60, worthValue: 10, burnValue: 5,
    imageUrl: "https://static.wixstatic.com/media/1abc74_0ca3ecdded494ceebb46e58b64428d92~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/kuva_2025-04-08_154519909.png",
  },
  {
    name: "Blackhawk Helicopter",
    description: "Good for arsenal levels. (Buildable)",
    rarity: "common", cardType: "air",
    dropWeight: 60, worthValue: 10, burnValue: 5,
    imageUrl: "https://static.wixstatic.com/media/595de3_459948168d0840e682328f0fd6c7abcd~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/unnamed%20(9).png",
  },
  {
    name: "Dive Bomber",
    description: "High Damage with the gun upgrades; can kill a Zeplin, however it has low health and the guns must be aimed. It is also slow. (Buildable)",
    rarity: "common", cardType: "air",
    dropWeight: 60, worthValue: 10, burnValue: 5,
    imageUrl: "https://static.wixstatic.com/media/595de3_3496a030f4cd45988117651b87434ec7~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Bomber.png",
  },
  {
    name: "Submarine (C)",
    description: "The Submarine is for transport use; it's quite slow and lacking maneuverability, making it not very useful at all.",
    rarity: "common", cardType: "naval",
    dropWeight: 60, worthValue: 10, burnValue: 5,
    imageUrl: "https://static.wixstatic.com/media/6511c0_2bbd216742574a6499dc9046bf590634~mv2.png/v1/fill/w_182,h_202,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_2bbd216742574a6499dc9046bf590634~mv2.png",
  },
  {
    name: "Attack Helicopter",
    description: "A decent helicopter with missiles and machine guns.",
    rarity: "common", cardType: "air",
    dropWeight: 60, worthValue: 10, burnValue: 5,
    imageUrl: "https://static.wixstatic.com/media/6511c0_e1af2b37c7194b3e827995d8bf90970d~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-04-06%20234323.png",
  },
  {
    name: "Woodland (Banner)",
    description: "Available through crates.",
    rarity: "uncommon", cardType: "banner",
    dropWeight: 25, worthValue: 50, burnValue: 25,
    imageUrl: "https://static.wixstatic.com/media/f89faf_3137bfcba1154ae0b811a26a76495321~mv2.png/v1/fill/w_373,h_413,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_3137bfcba1154ae0b811a26a76495321~mv2.png",
  },
  {
    name: "Onyx (Banner)",
    description: "Available through crates.",
    rarity: "uncommon", cardType: "banner",
    dropWeight: 25, worthValue: 50, burnValue: 25,
    imageUrl: "https://static.wixstatic.com/media/f89faf_efe7e9c5ea6c4a45a87fbf6d04d321b8~mv2.png/v1/fill/w_373,h_413,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_efe7e9c5ea6c4a45a87fbf6d04d321b8~mv2.png",
  },
  {
    name: "Naval (Banner)",
    description: "Available through crates.",
    rarity: "uncommon", cardType: "banner",
    dropWeight: 25, worthValue: 50, burnValue: 25,
    imageUrl: "https://static.wixstatic.com/media/f89faf_d0d1e359a8a94521b32431371f08389f~mv2.png/v1/fill/w_373,h_413,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_d0d1e359a8a94521b32431371f08389f~mv2.png",
  },
  {
    name: "Flora (Banner)",
    description: "Available through crates.",
    rarity: "uncommon", cardType: "banner",
    dropWeight: 25, worthValue: 50, burnValue: 25,
    imageUrl: "https://static.wixstatic.com/media/f89faf_1031298f260e43459a2f253b9df98477~mv2.png/v1/fill/w_373,h_413,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_1031298f260e43459a2f253b9df98477~mv2.png",
  },
  {
    name: "Desert (Banner)",
    description: "Available through crates.",
    rarity: "uncommon", cardType: "banner",
    dropWeight: 25, worthValue: 50, burnValue: 25,
    imageUrl: "https://static.wixstatic.com/media/f89faf_7e6cc73aec894ed2a370159335692437~mv2.png/v1/fill/w_373,h_413,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_7e6cc73aec894ed2a370159335692437~mv2.png",
  },
  {
    name: "Crimson (Banner)",
    description: "Available through crates.",
    rarity: "uncommon", cardType: "banner",
    dropWeight: 25, worthValue: 50, burnValue: 25,
    imageUrl: "https://static.wixstatic.com/media/f89faf_044a135869874aceae87d5a7bea88dd1~mv2.png/v1/fill/w_373,h_413,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_044a135869874aceae87d5a7bea88dd1~mv2.png",
  },
  {
    name: "Arid (Banner)",
    description: "Available through crates.",
    rarity: "uncommon", cardType: "banner",
    dropWeight: 25, worthValue: 50, burnValue: 25,
    imageUrl: "https://static.wixstatic.com/media/f89faf_b0220a522f6945718d8859471083e449~mv2.png/v1/fill/w_373,h_413,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_b0220a522f6945718d8859471083e449~mv2.png",
  },
  {
    name: "Tank (Emblem)",
    description: "This emblem is obtained in the kill tag crates!",
    rarity: "uncommon", cardType: "emblem",
    dropWeight: 25, worthValue: 50, burnValue: 25,
    imageUrl: "https://static.wixstatic.com/media/341c64_a250478a851f4476baf69b372b699644~mv2.jpeg/v1/fill/w_227,h_252,al_c,lg_1,q_80,enc_avif,quality_auto/341c64_a250478a851f4476baf69b372b699644~mv2.jpeg",
  },
  {
    name: "F35",
    description: "VTOL; very weak compared to its Gold counterpart",
    rarity: "rare", cardType: "air",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/6511c0_bb93a6aa81144a5e9b5aceac088b72e8~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-04-06%20233703.png",
  },
  {
    name: "Abram Tank",
    description: "This was the 2nd scavenger hunt vehicle added to the game and was introduced shortly after the Green Abrams Tank.Mostly Mistaken as the real green abram",
    rarity: "rare", cardType: "ground",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/1abc74_35446876e8d645ff83d6a276fa0b0b87~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/kuva_2025-04-08_145856411.png",
  },
  {
    name: "Halftrack",
    description: "Basic troop carrier with a aimable explosive round machine gun that does good air damage",
    rarity: "rare", cardType: "ground",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/1abc74_ea1f25cedaf54f079b29b18c92db4695~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/halfiebalfie.png",
  },
  {
    name: "AC-130",
    description: "A decent air to ground combat plane having an explosive minigun and cannon for the pilot and an autocannon for the co-pilot. It is not good for any form of air to air combat.(Spec Ops)",
    rarity: "rare", cardType: "air",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/6511c0_a9584285b80e4a60bbc476a31d3a95cf~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-04-06%20234235.png",
  },
  {
    name: "B29 Bomber",
    description: "A decent plane for beginners with its high DPS but it is easily to kill with most AA vehicles.(Buildable)",
    rarity: "rare", cardType: "air",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/595de3_30be586483674702ba795a400cdd7b3d~mv2.jpg/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/unnamed.jpg",
  },
  {
    name: "Missile Boat",
    description: "A fast missile boat that has 12 missiles and a main cannon for the driver to control. (Buildable)",
    rarity: "rare", cardType: "naval",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/1abc74_7729900a4b1e44afa2367b99d6563975~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/kuva_2025-04-08_151758599.png",
  },
  {
    name: "Rocket Tank",
    description: "Fires a lot of missiles which cna be good for flare baiting(Spec Ops)",
    rarity: "rare", cardType: "ground",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/6511c0_90d7f6b32cb742418dab9dd65da9508f~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202026-02-27%20170046.png",
  },
  {
    name: "Terrorbyte",
    description: "One of the first vehicles with the orignial radar system. This vehicle requires multiple people to operate at its best as the missiles are not driver operated.(Buildable)",
    rarity: "rare", cardType: "ground",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/1abc74_e664555260574375bc3eda20dae2b4b4~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/kuva_2025-04-08_152442209.png",
  },
  {
    name: "Alvis Stormer",
    description: "Currently does not work.  (Buildable)",
    rarity: "rare", cardType: "ground",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/1abc74_50e447e5d7cf4e34954d844aca4f4a93~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/kuva_2025-04-08_145649586.png",
  },
  {
    name: "AATank",
    description: "A strong anti-air tank that is unlocked from rebirthing the military base.",
    rarity: "rare", cardType: "ground",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/6511c0_1e8b40eed0b342e9aeecb006b554d938~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-11-20%20022106.png",
  },
  {
    name: "Assassin Sniper",
    description: "Reskin of the Barrett, but has an improved fire rate to one similar to that of the Desert Eagle.",
    rarity: "epic", cardType: "weapon",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/6511c0_28d43b79c66e4715ab39fa65e04474e8~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-12-14%20191853.png",
  },
  {
    name: "Rg-1 Railgun Car",
    description: "An agile armored vehicle that has a railgun on the top that has great AOE. It is a good subsitute for the Railgun tank.",
    rarity: "epic", cardType: "ground",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/1abc74_b6466f85853f48d089e6ba1ac030ba4e~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/kuva_2025-04-08_152638663.png",
  },
  {
    name: "Fireworks RPG",
    description: "RPG variant with fireworks animations and audio. It also has a custom trail effect that looks like rainbow sparkling fireworks. The damage is the same as a normal RPG and also only has a single round that is quickly reloaded, as most RPG variants do.",
    rarity: "epic", cardType: "weapon",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/6511c0_c3e7db3452c34873a67670740d68b8b7~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202026-01-28%20192532.png",
  },
  {
    name: "Pyro Tank",
    description: "decent range flame thrower simular to a weaker 3 star effect, currently does no damage to buildings so is unable to clear fortresses due to accessability issues",
    rarity: "epic", cardType: "ground",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/1abc74_21fe6949376b4e6dbf4c695113c0b780~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/kuva_2025-04-08_152715826.png",
  },
  {
    name: "Striker",
    description: "A vehicle that revolves around its singular huge missile. This missile can lock-on to planes however it does not do enough damage to land vehicles to be good for combat.",
    rarity: "epic", cardType: "ground",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/1abc74_4673e7b0820f41bd9a43ac5dd8f58d41~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/kuva_2025-04-08_150312657.png",
  },
  {
    name: "M10 Booker",
    description: "A tank with a fast reload time, but hardly any damage.",
    rarity: "epic", cardType: "ground",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/6511c0_71a038200d384371b6c6e84343b5f307~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-08-19%20145359.png",
  },
  {
    name: "AHRLAC",
    description: "has powerful front facing cannon and 6 normal missiles along with 2 anti dodge missiles",
    rarity: "epic", cardType: "air",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/595de3_e3c2f8e39dee48bdac65808dde08065c~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/unnamed.png",
  },
  {
    name: "TKS-20",
    description: "Fast-moving light tank with a limited angling front firing explosive round machine gun.",
    rarity: "epic", cardType: "ground",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/6511c0_77300053a6244bdbbf0a00006d81edf5~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-08-13%20235255.png",
  },
  {
    name: "Su-47",
    description: "A plane with missiles and an explosive machine guns. The first plane to be added that is able to do flips.",
    rarity: "epic", cardType: "air",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/6511c0_790fe8fec88948d9880ed70fb5fb6a28~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-04-06%20231909.png",
  },
  {
    name: "War Bunny",
    description: "The War Bunny features a G36 Submachine gun that has a decent fire rate, damage, and range. The War Bunny has average health but lacks movement speed.",
    rarity: "epic", cardType: "soldiers",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/f89faf_28696889f8674d1495de5d339dd6df49~mv2.png/v1/fill/w_254,h_281,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_28696889f8674d1495de5d339dd6df49~mv2.png",
  },
  {
    name: "Gold Typhoon",
    description: "The rarest vehicle in the game.Golden Version of Typhoon Submarine. Is able to submerge in the ground due to a glitch.Has missiles that accelerate, allowing it to catch players off guard combined with the former glitch.A majority of dupes no longer exist,  marking the return of its old value.",
    rarity: "legendary", cardType: "naval",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/f89faf_b902441dfbe94d6394d8753d0d5549ad~mv2.png/v1/fill/w_373,h_413,al_c,q_85,usm_0.66_1.00_0.01,enc_avif,quality_auto/f89faf_b902441dfbe94d6394d8753d0d5549ad~mv2.png",
  },
  {
    name: "Ghostwind",
    description: "Fast helicopter with a fast-firing firing aimable, and explosive machine gun. The Ghostwind also features hypersonic boost like on jets and other aircraft, which usually isn't found on helicopters.",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_ecd55546e5394191a760cb9b224787b8~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-11-19%20233212.png",
  },
  {
    name: "War Shrike",
    description: "A decent aircraft that hovers and has a primary plasma cannon that is aimable. Has notoriously low health and firepower, which leads to low demand and usage.",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_a05f9d48c04d449bbe89807cc31f96b0~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-11-20%20001035.png",
  },
  {
    name: "S.A.M. Truck",
    description: "Decently fast truck with lock-on missile barrages, along with a powerful and aimable explosive round machine gun.",
    rarity: "legendary", cardType: "ground",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_19fc48a760e14c53a0eeb21ed823ed83~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-11-20%20013257.png",
  },
  {
    name: "Police Heli",
    description: "Attack helicopter with a barrage of lock-on missiles and 2 decent machine guns",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_28483b22656b4f978311abdcc245197c~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-08-19%20145649.png",
  },
  {
    name: "PL-01 Liberty",
    description: "Gold PL-01 reskin with the same armaments and little to no difference",
    rarity: "legendary", cardType: "ground",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_c274a71f45be4fbc8c4a2c18cfc788f0~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-11-20%20020519.png",
  },
  {
    name: "Silver Howl",
    description: "Reskinned Zhi 19E with a passenger seat that has 2 missile barrages that are not able to lock on.",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_1a81fa353bd54a25a661b361a964e333~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-10-25%20231646.png",
  },
  {
    name: "Patriot Boat\t",
    description: "Slow turning and low speed boat with 10 armour piercing rounds and main aimable explosive cannon, also has Ai air defense for missiles and attacks",
    rarity: "legendary", cardType: "naval",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_61cc043705c440129238d96ce9233d8c~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-03-29%20135847.png",
  },
  {
    name: "Haunted Jet",
    description: "Reskinned F-16 with 4 missiles and a machine gun with normal rounds. The missiles do have life steal, which makes the jet somewhat decently useful. Though the reload of the missiles is a bit slow.",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_ee292637bd1040c3b3f0fd42135a16ff~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-10-25%20231622.png",
  },
  {
    name: "Douglas A-20",
    description: "Has a powerfull frontal cannon, along with a powerful, slow firing ai cannon. AI back gunner can be replaced with another player, increasing firerate.",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/595de3_36c7e6af746f4beea0b4881b5c16fa63~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Douglas.png",
  },
  {
    name: "Boss F-117",
    description: "A slightly upgraded version of the F-117 with its additional HP and bombs.",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/595de3_0acfcb98bb0541a5a95e7a808661cc21~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/unnamed%20(3).png",
  },
  {
    name: "Katyusha",
    description: "Acts like the artillery that you can buy for in-game cash; nothing Limited Edition.",
    rarity: "legendary", cardType: "ground",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_f9d5d086ccf14b4c8b39b415d09e7a1e~mv2.png/v1/fill/w_186,h_206,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_f9d5d086ccf14b4c8b39b415d09e7a1e~mv2.png",
  },
  {
    name: "LE BISMARCK (G)",
    description: "It can solo destroyer-x at 5 stars, but suffers outside of bosses due to low speed. While valuable, it is still widely available for trade and has since been overshadowed by newer vehicles, capable of doing what it does, but better",
    rarity: "mythic", cardType: "naval",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/f89faf_371f3221b2f64b4d83b992389649d005~mv2.png/v1/fill/w_156,h_172,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_371f3221b2f64b4d83b992389649d005~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Super Hoverbike",
    description: "The Super Hoverbike functions pretty much like a ground-based exotic rarity CFA44. The Super Hoverbike features an air-vehicle-focused 150-round plasma machine gun that has a good reload speed. The plasma machine gun only deals great damage against air vehicles and seems to deal average to low damage against ground and naval vehicles. The second weapon that the Super Hoverbike has is 4 missile bursts that have a long reload time. The Super Hoverb",
    rarity: "mythic", cardType: "ground",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_2e0aee66d9b7421e8476ac4bfcab0386~mv2.png/v1/fill/w_180,h_199,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_2e0aee66d9b7421e8476ac4bfcab0386~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Super F24",
    description: "VTOL aircraft that has 6 Magnetic missiles that slow down your targeted aircraft. It also has 2 large-sized anti-flare missiles. Overall, the missiles have long reloads and deal low damage. The Magnetic missiles no longer function as they used to, and no longer gravitate aerial and naval targets towards you.",
    rarity: "mythic", cardType: "air",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_073a71d03d50432893b802f912bb2aa3~mv2.png/v1/fill/w_183,h_203,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_073a71d03d50432893b802f912bb2aa3~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "LE_HealingDrone",
    description: "The Healing Drone heals both players and soldiers, similar to the Repair Drone.",
    rarity: "mythic", cardType: "drones",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_de0f6566f7e846f58b07b261cdc62447~mv2.png/v1/fill/w_298,h_330,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_de0f6566f7e846f58b07b261cdc62447~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Beam Tank",
    description: "The Beam Tank features 13 individual lasers that are quite powerful and deal 2.4k damage against a boss. It's able to 1 shot the 4-star general. The Beam Tank also features an aimable explosive round machine gun that deals average damage. The reload speed of both of these weapons is average. But the laser can not be reloaded within its salvo, so you have to finish its entire salvo before being able to reload. The Beam tank has amazing maneuverabi",
    rarity: "mythic", cardType: "ground",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_04430c9dbbce4492addc4e23107d1f2c~mv2.png/v1/fill/w_178,h_197,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_04430c9dbbce4492addc4e23107d1f2c~mv2.png",
    inPacks: false,
    droppable: false,
  },
  {
    name: "Tiger Mech",
    description: "The Tiger mech features the same jumping and boost features as all other mechs. The Tiger mech features the same aimable explosive round machine gun as the Strike Mech variants, but also an aimable single-shot main cannon that deals serious damage. The Special feature of the Tiger Mech is its toggleable shield that protects against incoming projectiles that hit and contact the shield. When toggled, the Shield seems to slow down the movement speed",
    rarity: "mythic", cardType: "ground",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_68d63ba2e30c4149b879f8cb0bcd531e~mv2.png/v1/fill/w_183,h_203,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_68d63ba2e30c4149b879f8cb0bcd531e~mv2.png",
    inPacks: false,
    droppable: false,
  },
  {
    name: "Master Rain",
    description: "The Master Rain features the first 50 blueprint obtainment process. The Master Rain features an AI-controlled medium-damage main cannon that seems to have infinite shots but a limited range. Along with an aimable explosive round machine gun that deals good anti-air damage. The Master Rain also features 8 lock-on missiles that deal medium damage. The AI-controlled cannon produces the same audio as the Ratte, Sturmtank, and K7 model's cannons.",
    rarity: "mythic", cardType: "naval",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_7de6cd7966014882958ce707fc02f5b4~mv2.png/v1/fill/w_187,h_207,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_7de6cd7966014882958ce707fc02f5b4~mv2.png",
    inPacks: false,
    droppable: false,
  },
  {
    name: "Super U2",
    description: "Same arsenal as normal U2 but deals more damage",
    rarity: "mythic", cardType: "air",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/4db42e_253465f0638941a5a5cecf586fd8f8e6~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-04-06%20125551.png",
    inPacks: false,
    droppable: false,
  },
];
