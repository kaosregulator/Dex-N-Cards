// DN Cards — Vault Values default roster (vehicles/soldiers preferred; banners as nameplates when needed).
// Load via /setup → Use Default Set. Per-guild /rarity nicknames + profiles always win.
//
// Drop weights (higher = more common) — Vault Values ladder:
//   Common: 60 · Uncommon: 25 · Rare: 10 · Epic: 4 · Legendary: 1 · Limited Edition: 0

export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary" | "mythic";
export type CardType = string; // free-form label — any text the admin types

// Built-in rarity display order (DB enum key → Vault Values site names, low → high):
//   Common → Uncommon → Rare → Epic → Legendary → Limited Edition (mythic key, top)
// Exotic is a custom tier seeded between Legendary and LE. Event/special = mythic + isEventExclusive.
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
  mythic: "💎", // Limited Edition (top) · Event/special cards also use this key
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
  // Top of the Vault Values ladder. Event/special cards also use this key with isEventExclusive.
  mythic: "Limited Edition",
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
  /** Optional custom rarity slug (e.g. "exotic") assigned after insert. */
  customRaritySlug?: string;
}

export const DEFAULT_CARDS: DefaultCard[] = [
  {
    name: "UZI",
    description: "This weapon is very basic and does not serve much purpose. It has been untradable since May 27th, 2026. Thanks to EpicS for the image!",
    rarity: "common", cardType: "soldiers",
    dropWeight: 60, worthValue: 10, burnValue: 5,
    imageUrl: "https://static.wixstatic.com/media/f89faf_0d060f16777f4a9d8efea52a69dcca9c~mv2.png/v1/fill/w_373,h_413,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_0d060f16777f4a9d8efea52a69dcca9c~mv2.png",
  },
  {
    name: "Gun Boat",
    description: "A small but agile boat with a passenger controlled explosive mahcine gun.",
    rarity: "common", cardType: "naval",
    dropWeight: 60, worthValue: 10, burnValue: 5,
    imageUrl: "https://static.wixstatic.com/media/1abc74_22fdbde9a01244a39502c09d13ffddaf~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/kuva_2025-04-08_152112958.png",
  },
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
    name: "Dive Bomber",
    description: "High Damage with the gun upgrades; can kill a Zeplin, however it has low health and the guns must be aimed. It is also slow. (Buildable)",
    rarity: "common", cardType: "air",
    dropWeight: 60, worthValue: 10, burnValue: 5,
    imageUrl: "https://static.wixstatic.com/media/595de3_3496a030f4cd45988117651b87434ec7~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Bomber.png",
  },
  {
    name: "F-22",
    description: "One of the worst planes currently with 4 missiles and one of the weakest machine guns.",
    rarity: "common", cardType: "air",
    dropWeight: 60, worthValue: 10, burnValue: 5,
    imageUrl: "https://static.wixstatic.com/media/6511c0_89b9b47d4f4c49639bdc6ee1cc8314ef~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-04-06%20233740.png",
  },
  {
    name: "Submarine (C)",
    description: "The Submarine is for transport use; it's quite slow and lacking maneuverability, making it not very useful at all.",
    rarity: "common", cardType: "naval",
    dropWeight: 60, worthValue: 10, burnValue: 5,
    imageUrl: "https://static.wixstatic.com/media/6511c0_2bbd216742574a6499dc9046bf590634~mv2.png/v1/fill/w_182,h_202,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_2bbd216742574a6499dc9046bf590634~mv2.png",
  },
  {
    name: "B-17",
    description: "A decent plane for beginners with its high DPS but it is easy to kill with most AA vehicles.(Buildable)",
    rarity: "common", cardType: "air",
    dropWeight: 60, worthValue: 10, burnValue: 5,
    imageUrl: "https://static.wixstatic.com/media/1abc74_0ca3ecdded494ceebb46e58b64428d92~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/kuva_2025-04-08_154519909.png",
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
    name: "Attack Helicopter",
    description: "A decent helicopter with missiles and machine guns.",
    rarity: "common", cardType: "air",
    dropWeight: 60, worthValue: 10, burnValue: 5,
    imageUrl: "https://static.wixstatic.com/media/6511c0_e1af2b37c7194b3e827995d8bf90970d~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-04-06%20234323.png",
  },
  {
    name: "Blackhawk Helicopter",
    description: "Good for arsenal levels. (Buildable)",
    rarity: "common", cardType: "air",
    dropWeight: 60, worthValue: 10, burnValue: 5,
    imageUrl: "https://static.wixstatic.com/media/595de3_459948168d0840e682328f0fd6c7abcd~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/unnamed%20(9).png",
  },
  {
    name: "Jetski",
    description: "Good for arsenal levels.",
    rarity: "common", cardType: "naval",
    dropWeight: 60, worthValue: 10, burnValue: 5,
    imageUrl: "https://static.wixstatic.com/media/1abc74_1b26f5003e3e4583b5edbacae1fec09b~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/kuva_2025-04-08_151956283.png",
  },
  {
    name: "Biplane",
    description: "Good for arsenal levels.(Tycoon)",
    rarity: "common", cardType: "air",
    dropWeight: 60, worthValue: 10, burnValue: 5,
    imageUrl: "https://static.wixstatic.com/media/595de3_357049d1f12a46d4b0b7bbdd264c820d~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/unnamed.png",
  },
  {
    name: "Handgun (Emblem)",
    description: "This emblem is obtained by the kill tag crates!",
    rarity: "common", cardType: "emblem",
    dropWeight: 60, worthValue: 10, burnValue: 5,
    imageUrl: "https://static.wixstatic.com/media/341c64_9021eb3b1af94581b403b2a533eacbcd~mv2.jpeg/v1/fill/w_204,h_227,al_c,lg_1,q_80,enc_avif,quality_auto/341c64_9021eb3b1af94581b403b2a533eacbcd~mv2.jpeg",
  },
  {
    name: "Radar (Emblem)",
    description: "This emblem can be obtained in the kill tag crates!",
    rarity: "common", cardType: "emblem",
    dropWeight: 60, worthValue: 10, burnValue: 5,
    imageUrl: "https://static.wixstatic.com/media/341c64_a2023418ad30470a9705fc9588c0af20~mv2.png/v1/fill/w_116,h_129,al_c,lg_1,q_85,enc_avif,quality_auto/341c64_a2023418ad30470a9705fc9588c0af20~mv2.png",
  },
  {
    name: "Missile (Emblem)",
    description: "This emblem can be obtained in the kill tag crates!",
    rarity: "common", cardType: "emblem",
    dropWeight: 60, worthValue: 10, burnValue: 5,
    imageUrl: "https://static.wixstatic.com/media/341c64_81fead90b81f46ad87f9d4166c5b36e9~mv2.png/v1/fill/w_121,h_134,al_c,lg_1,q_85,enc_avif,quality_auto/341c64_81fead90b81f46ad87f9d4166c5b36e9~mv2.png",
  },
  {
    name: "Medic (Emblem)",
    description: "This emblem can be obtained by the kill tag crates!",
    rarity: "common", cardType: "emblem",
    dropWeight: 60, worthValue: 10, burnValue: 5,
    imageUrl: "https://static.wixstatic.com/media/341c64_24633de6e0ad4b1392a4a735cadd0066~mv2.jpeg/v1/fill/w_227,h_252,al_c,lg_1,q_80,enc_avif,quality_auto/341c64_24633de6e0ad4b1392a4a735cadd0066~mv2.jpeg",
  },
  {
    name: "Gloves (Emblem)",
    description: "This emblem is obtainable by the kill tag crates!",
    rarity: "common", cardType: "emblem",
    dropWeight: 60, worthValue: 10, burnValue: 5,
    imageUrl: "https://static.wixstatic.com/media/341c64_15655399a14b44ddb4a7fac5d3213b65~mv2.jpeg/v1/fill/w_178,h_197,al_c,lg_1,q_80,enc_avif,quality_auto/341c64_15655399a14b44ddb4a7fac5d3213b65~mv2.jpeg",
  },
  {
    name: "Flag (Emblem)",
    description: "This emblem is obtainable by the kill tag crates!",
    rarity: "common", cardType: "emblem",
    dropWeight: 60, worthValue: 10, burnValue: 5,
    imageUrl: "https://static.wixstatic.com/media/341c64_33f379ded4ae4ac19b62df607e8b5822~mv2.jpeg/v1/fill/w_184,h_204,al_c,lg_1,q_80,enc_avif,quality_auto/341c64_33f379ded4ae4ac19b62df607e8b5822~mv2.jpeg",
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
    name: "Submarine (Emblem)",
    description: "This emblem is obtained from the kill tag crates!",
    rarity: "uncommon", cardType: "emblem",
    dropWeight: 25, worthValue: 50, burnValue: 25,
    imageUrl: "https://static.wixstatic.com/media/341c64_8f6fd7527e5a4ae1b2718835cbd37b09~mv2.jpeg/v1/fill/w_227,h_252,al_c,lg_1,q_80,enc_avif,quality_auto/341c64_8f6fd7527e5a4ae1b2718835cbd37b09~mv2.jpeg",
  },
  {
    name: "Skull (Emblem)",
    description: "This emblem is obtained from the kill tag crates!",
    rarity: "uncommon", cardType: "emblem",
    dropWeight: 25, worthValue: 50, burnValue: 25,
    imageUrl: "https://static.wixstatic.com/media/341c64_a749eb400cd84cf2973f59b95f8c1135~mv2.jpeg/v1/fill/w_209,h_232,al_c,lg_1,q_80,enc_avif,quality_auto/341c64_a749eb400cd84cf2973f59b95f8c1135~mv2.jpeg",
  },
  {
    name: "Parachute (Emblem)",
    description: "This emblem is obtained from the kill tag crates!",
    rarity: "uncommon", cardType: "emblem",
    dropWeight: 25, worthValue: 50, burnValue: 25,
    imageUrl: "https://static.wixstatic.com/media/341c64_45678306bae04a34b6c8e77027942a37~mv2.jpeg/v1/fill/w_188,h_209,al_c,lg_1,q_80,enc_avif,quality_auto/341c64_45678306bae04a34b6c8e77027942a37~mv2.jpeg",
  },
  {
    name: "Tank (Emblem)",
    description: "This emblem is obtained in the kill tag crates!",
    rarity: "uncommon", cardType: "emblem",
    dropWeight: 25, worthValue: 50, burnValue: 25,
    imageUrl: "https://static.wixstatic.com/media/341c64_a250478a851f4476baf69b372b699644~mv2.jpeg/v1/fill/w_227,h_252,al_c,lg_1,q_80,enc_avif,quality_auto/341c64_a250478a851f4476baf69b372b699644~mv2.jpeg",
  },
  {
    name: "Mask (Emblem)",
    description: "This emblem is obtained by the kill tag crates!",
    rarity: "uncommon", cardType: "emblem",
    dropWeight: 25, worthValue: 50, burnValue: 25,
    imageUrl: "https://static.wixstatic.com/media/341c64_bd737aa499664f90bb1f14d669751a5d~mv2.jpeg/v1/fill/w_220,h_244,al_c,lg_1,q_80,enc_avif,quality_auto/341c64_bd737aa499664f90bb1f14d669751a5d~mv2.jpeg",
  },
  {
    name: "Crosshair (Emblem)",
    description: "This emblem is obtained by the kill tag crates.",
    rarity: "uncommon", cardType: "emblem",
    dropWeight: 25, worthValue: 50, burnValue: 25,
    imageUrl: "https://static.wixstatic.com/media/341c64_9619e946aa6a41adb9093fa8d0f4a65f~mv2.jpeg/v1/fill/w_187,h_207,al_c,lg_1,q_80,enc_avif,quality_auto/341c64_9619e946aa6a41adb9093fa8d0f4a65f~mv2.jpeg",
  },
  {
    name: "Silver (Banner)",
    description: "Only available through ranks.",
    rarity: "uncommon", cardType: "banner",
    dropWeight: 25, worthValue: 50, burnValue: 25,
    imageUrl: "https://static.wixstatic.com/media/f89faf_4b47760b90b14e7895a233ecbfbb1db0~mv2.png/v1/fill/w_373,h_413,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_4b47760b90b14e7895a233ecbfbb1db0~mv2.png",
  },
  {
    name: "Ace Pilot",
    description: "The Ace Pilot is a buff-applying soldier that increases air vehicle damage by 1% at any level with a zero-star Ace Pilot. The Ace Pilot also buffs air vehicle damage by 6% at any level when 3-starred. The Ace Pilot troops can be stacked to obtain a maximum air vehicle buff of 24% when equipped with 4 Ace Pilot troops at 3 stars. The Ace Pilot features a  weak M16 Assault Rifle that deals poor damage but has good range. The Ace Pilot also suffers ",
    rarity: "rare", cardType: "soldiers",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/6511c0_90f9a4898e424126b5ac32cb3e4e6960~mv2.png/v1/fill/w_279,h_309,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_90f9a4898e424126b5ac32cb3e4e6960~mv2.png",
  },
  {
    name: "AC-130",
    description: "A decent air to ground combat plane having an explosive minigun and cannon for the pilot and an autocannon for the co-pilot. It is not good for any form of air to air combat.(Spec Ops)",
    rarity: "rare", cardType: "air",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/6511c0_a9584285b80e4a60bbc476a31d3a95cf~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-04-06%20234235.png",
  },
  {
    name: "Abram Tank",
    description: "This was the 2nd scavenger hunt vehicle added to the game and was introduced shortly after the Green Abrams Tank.Mostly Mistaken as the real green abram",
    rarity: "rare", cardType: "ground",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/1abc74_35446876e8d645ff83d6a276fa0b0b87~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/kuva_2025-04-08_145856411.png",
  },
  {
    name: "Terrorbyte",
    description: "One of the first vehicles with the orignial radar system. This vehicle requires multiple people to operate at its best as the missiles are not driver operated.(Buildable)",
    rarity: "rare", cardType: "ground",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/1abc74_e664555260574375bc3eda20dae2b4b4~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/kuva_2025-04-08_152442209.png",
  },
  {
    name: "B29 Bomber",
    description: "A decent plane for beginners with its high DPS but it is easily to kill with most AA vehicles.(Buildable)",
    rarity: "rare", cardType: "air",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/595de3_30be586483674702ba795a400cdd7b3d~mv2.jpg/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/unnamed.jpg",
  },
  {
    name: "Halftrack",
    description: "Basic troop carrier with a aimable explosive round machine gun that does good air damage",
    rarity: "rare", cardType: "ground",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/1abc74_ea1f25cedaf54f079b29b18c92db4695~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/halfiebalfie.png",
  },
  {
    name: "Missile Boat",
    description: "A fast missile boat that has 12 missiles and a main cannon for the driver to control. (Buildable)",
    rarity: "rare", cardType: "naval",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/1abc74_7729900a4b1e44afa2367b99d6563975~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/kuva_2025-04-08_151758599.png",
  },
  {
    name: "F35",
    description: "VTOL; very weak compared to its Gold counterpart",
    rarity: "rare", cardType: "air",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/6511c0_bb93a6aa81144a5e9b5aceac088b72e8~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-04-06%20233703.png",
  },
  {
    name: "Rocket Tank",
    description: "Fires a lot of missiles which cna be good for flare baiting(Spec Ops)",
    rarity: "rare", cardType: "ground",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/6511c0_90d7f6b32cb742418dab9dd65da9508f~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202026-02-27%20170046.png",
  },
  {
    name: "AATank",
    description: "A strong anti-air tank that is unlocked from rebirthing the military base.",
    rarity: "rare", cardType: "ground",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/6511c0_1e8b40eed0b342e9aeecb006b554d938~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-11-20%20022106.png",
  },
  {
    name: "Alvis Stormer",
    description: "Currently does not work.  (Buildable)",
    rarity: "rare", cardType: "ground",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/1abc74_50e447e5d7cf4e34954d844aca4f4a93~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/kuva_2025-04-08_145649586.png",
  },
  {
    name: "Urban (Banner)",
    description: "Available through crates.",
    rarity: "rare", cardType: "banner",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/f89faf_73c55109ae844c02bed156ab3ff8940d~mv2.png/v1/fill/w_373,h_413,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_73c55109ae844c02bed156ab3ff8940d~mv2.png",
  },
  {
    name: "Stealth (Banner)",
    description: "Available through crates.",
    rarity: "rare", cardType: "banner",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/f89faf_0efe9751e2e842a2ba1924ff6d83f326~mv2.png/v1/fill/w_373,h_413,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_0efe9751e2e842a2ba1924ff6d83f326~mv2.png",
  },
  {
    name: "Snakeskin (Banner)",
    description: "Available through crates.",
    rarity: "rare", cardType: "banner",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/f89faf_796e8ffd220141068b0a4a84d5a1d067~mv2.png/v1/fill/w_373,h_413,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_796e8ffd220141068b0a4a84d5a1d067~mv2.png",
  },
  {
    name: "Flecktarn (Banner)",
    description: "Available through crates.",
    rarity: "rare", cardType: "banner",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/f89faf_f5d3788b07aa4e5f814b285886d8aab8~mv2.png/v1/fill/w_373,h_413,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_f5d3788b07aa4e5f814b285886d8aab8~mv2.png",
  },
  {
    name: "Dune (Banner)",
    description: "Available through crates.",
    rarity: "rare", cardType: "banner",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/f89faf_a21828a141fe41cbab2cb6b51e0c242e~mv2.png/v1/fill/w_373,h_413,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_a21828a141fe41cbab2cb6b51e0c242e~mv2.png",
  },
  {
    name: "Dark Digital (Banner)",
    description: "Available through crates.",
    rarity: "rare", cardType: "banner",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/f89faf_bb10d581980849d1af7be21d705a8450~mv2.png/v1/fill/w_373,h_413,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_bb10d581980849d1af7be21d705a8450~mv2.png",
  },
  {
    name: "Brush Camo (Banner)",
    description: "Available through crates.",
    rarity: "rare", cardType: "banner",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/f89faf_01849b8f67a4472c9205a8aa1d6a3f1d~mv2.png/v1/fill/w_373,h_413,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_01849b8f67a4472c9205a8aa1d6a3f1d~mv2.png",
  },
  {
    name: "Combat Tank (Emblem)",
    description: "This emblem is obtained in the kill tag crates.",
    rarity: "rare", cardType: "emblem",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/341c64_f6d9dbbcb2764f09bbfc915eb965a96a~mv2.jpeg/v1/fill/w_221,h_245,al_c,lg_1,q_80,enc_avif,quality_auto/341c64_f6d9dbbcb2764f09bbfc915eb965a96a~mv2.jpeg",
  },
  {
    name: "Strong Shield (Emblem)",
    description: "This emblem is obtained in the kill tag crates!",
    rarity: "rare", cardType: "emblem",
    dropWeight: 10, worthValue: 200, burnValue: 100,
    imageUrl: "https://static.wixstatic.com/media/341c64_5b8d308bf91344cf8f8b86a85a3b79c6~mv2.jpeg/v1/fill/w_204,h_227,al_c,lg_1,q_80,enc_avif,quality_auto/341c64_5b8d308bf91344cf8f8b86a85a3b79c6~mv2.jpeg",
  },
  {
    name: "War Bunny",
    description: "The War Bunny features a G36 Submachine gun that has a decent fire rate, damage, and range. The War Bunny has average health but lacks movement speed.",
    rarity: "epic", cardType: "soldiers",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/f89faf_28696889f8674d1495de5d339dd6df49~mv2.png/v1/fill/w_254,h_281,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_28696889f8674d1495de5d339dd6df49~mv2.png",
  },
  {
    name: "Fireworks RPG",
    description: "RPG variant with fireworks animations and audio. It also has a custom trail effect that looks like rainbow sparkling fireworks. The damage is the same as a normal RPG and also only has a single round that is quickly reloaded, as most RPG variants do.",
    rarity: "epic", cardType: "weapon",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/6511c0_c3e7db3452c34873a67670740d68b8b7~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202026-01-28%20192532.png",
  },
  {
    name: "Snowball SMG",
    description: "The Snowball SMG is a reskin of the MP5 Submachine Gun within the game. But it features special bullets that stay in the ground longer. The bullets are transitioned into snowballs and can be stuck into walls to be used for writing.",
    rarity: "epic", cardType: "weapon",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/6511c0_10fa0aa16eb74588b308b069c17cc76d~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-12-14%20191850.png",
  },
  {
    name: "Scythe",
    description: "Heat Knife replacement that feels more damaged than the heat knife. It is also used alongside the RIOT Shield, just like the heat knife in an attack defense combination.",
    rarity: "epic", cardType: "weapon",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/6511c0_2c117d4aa2af4538be201e192b7badcf~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-12-14%20191857.png",
  },
  {
    name: "Rg-1 Railgun Car",
    description: "An agile armored vehicle that has a railgun on the top that has great AOE. It is a good subsitute for the Railgun tank.",
    rarity: "epic", cardType: "ground",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/1abc74_b6466f85853f48d089e6ba1ac030ba4e~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/kuva_2025-04-08_152638663.png",
  },
  {
    name: "Assassin Sniper",
    description: "Reskin of the Barrett, but has an improved fire rate to one similar to that of the Desert Eagle.",
    rarity: "epic", cardType: "weapon",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/6511c0_28d43b79c66e4715ab39fa65e04474e8~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-12-14%20191853.png",
  },
  {
    name: "Motorbike",
    description: "A fast and agile vehicle that has an explosive minigun attached to it. Soon after its release it got bugged due to an error with the code and now spazzes out every time it runs into a wall.",
    rarity: "epic", cardType: "ground",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/1abc74_7ee13dfa4a7d42e386b5c667629ab22c~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/kuva_2025-04-08_153001984.png",
  },
  {
    name: "Striker",
    description: "A vehicle that revolves around its singular huge missile. This missile can lock-on to planes however it does not do enough damage to land vehicles to be good for combat.",
    rarity: "epic", cardType: "ground",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/1abc74_4673e7b0820f41bd9a43ac5dd8f58d41~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/kuva_2025-04-08_150312657.png",
  },
  {
    name: "Pyro Tank",
    description: "decent range flame thrower simular to a weaker 3 star effect, currently does no damage to buildings so is unable to clear fortresses due to accessability issues",
    rarity: "epic", cardType: "ground",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/1abc74_21fe6949376b4e6dbf4c695113c0b780~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/kuva_2025-04-08_152715826.png",
  },
  {
    name: "Seacraft DPC",
    description: "The Seacraft DPC is a tool that boosts aquatic movement when equipped as your item within your inventory. It can't be used passively, unfortunately.",
    rarity: "epic", cardType: "tool",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/6511c0_542246698b144f04815717d3b284061a~mv2.png/v1/fill/w_115,h_127,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_542246698b144f04815717d3b284061a~mv2.png",
  },
  {
    name: "DarkStar",
    description: "A weak non-explosive machine gun and it has 1 normal missile. With the +2 missile upgrade it becomes a decent fighter for how readily obtainable it is.",
    rarity: "epic", cardType: "air",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/595de3_a21ac92c9a2545fe98dfc51037d74e48~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/DarkStar.png",
  },
  {
    name: "Flak Halftrack",
    description: "has a long reloading single shot cannon that 2 taps not pro server ai carrier, may be good for farming building destruction",
    rarity: "epic", cardType: "ground",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/1abc74_d7456e5ac70f4194a9d1d679000a9ba6~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/kuva_2025-04-13_131953104.png",
  },
  {
    name: "Stealth F35",
    description: "Can be won in the super spinner, making it a lot easier to get than the Gold F-35; it also far weaker. However, it takes longer to lock on.",
    rarity: "epic", cardType: "air",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/6511c0_a8913f9428ad47be9500b3a795507e1d~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-04-06%20232117.png",
  },
  {
    name: "Su-47",
    description: "A plane with missiles and an explosive machine guns. The first plane to be added that is able to do flips.",
    rarity: "epic", cardType: "air",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/6511c0_790fe8fec88948d9880ed70fb5fb6a28~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-04-06%20231909.png",
  },
  {
    name: "AHRLAC",
    description: "has powerful front facing cannon and 6 normal missiles along with 2 anti dodge missiles",
    rarity: "epic", cardType: "air",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/595de3_e3c2f8e39dee48bdac65808dde08065c~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/unnamed.png",
  },
  {
    name: "Boss Mi-28",
    description: "A weaker version of the Apache Attack Helicopter. Its missiles do not lock-on.",
    rarity: "epic", cardType: "air",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/595de3_3f80e7ea09804af5b5148b52801b50d3~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/unnamed%20(5).png",
  },
  {
    name: "Blackbird",
    description: "Can outrun all missiles at level 70.",
    rarity: "epic", cardType: "air",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/6511c0_1917f13ad42643a0af20a57dd94ada3d~mv2.png/v1/fill/w_183,h_203,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_1917f13ad42643a0af20a57dd94ada3d~mv2.png",
  },
  {
    name: "TKS-20",
    description: "Fast-moving light tank with a limited angling front firing explosive round machine gun.",
    rarity: "epic", cardType: "ground",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/6511c0_77300053a6244bdbbf0a00006d81edf5~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-08-13%20235255.png",
  },
  {
    name: "F-117",
    description: "Can turn invisible, but the bombs don't do much damage nor is the F117 accurate.(Buildable)",
    rarity: "epic", cardType: "air",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/595de3_9ab47d2ed80d4a2cb0376089d7f049ba~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/F-117.png",
  },
  {
    name: "Defiant",
    description: "A downgraded version of the Defiant-X. It was also on the paid warpass at teir 1. It has a recon radar.",
    rarity: "epic", cardType: "air",
    dropWeight: 4, worthValue: 750, burnValue: 375,
    imageUrl: "https://static.wixstatic.com/media/595de3_a403b57b47394443a5aba3b664930f96~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Defiant.png",
  },
  {
    name: "Alien",
    description: "The Alien is a decently performing troop that features a ray gun with a fast fire rate. The range of the Alien is quite good, but its accuracy at longer ranges isn't great. The ray gun works best at close quarters, like the bank cellar. The raygun also reloads quite fast, and it deals high damage, about half the health of a level 10 troop in 1 landed shot.",
    rarity: "legendary", cardType: "soldiers",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_186b1a8788144f48ab503b42f3e2c27b~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-10-05%20122713.png",
  },
  {
    name: "Vampire",
    description: "The first troop to be able to heal itself from shooting others. It can die if facing more than 1 troop or dealing with splash damage like rocket launchers. A single vampire, if paired with the railgun weapon buf can deal 450 damage per shot and solo up to the 3-star general.",
    rarity: "legendary", cardType: "soldiers",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_f54151eeff3945ceb9c53f21a90d7faf~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-10-25%20231709.png",
  },
  {
    name: "Werewolf",
    description: "A troop that deals medium damage against enemies in the form of a lunge and slash. The lunge currently makes it harder for normal NPCs to lock onto the werewolf. The health of the werewolf is quite low, and it has no healing capabilities.",
    rarity: "legendary", cardType: "soldiers",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_86a6cce19a034fc488143314fef3361a~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-10-25%20231658.png",
  },
  {
    name: "Pumpkin Soldier",
    description: "Decent troop that fires a special purple effect grenade launcher that deals low damage against troops. The grenade launcher has decent splash damage, just like its super variant.",
    rarity: "legendary", cardType: "soldiers",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_f00b50fd1e1b446a8ef42b7e860fb3a3~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-10-19%20011348.png",
  },
  {
    name: "Slash Bunny",
    description: "The Slash Bunny is currently bugged, dealing no damage and is an Easter reskin of the Halloween Werewolf. It can be used for bullet and AI baiting with it's dashing movements.",
    rarity: "legendary", cardType: "soldiers",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/f89faf_8b8e84d1bd52437d99cd3f10bb780bf0~mv2.png/v1/fill/w_265,h_294,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_8b8e84d1bd52437d99cd3f10bb780bf0~mv2.png",
  },
  {
    name: "Egg Launcher",
    description: "The Egg Launcher is a Easter reskin of the normal tycoon unlockable Grenade Launcher.",
    rarity: "legendary", cardType: "soldiers",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/f89faf_5dcb4fa708c54a6e9fb265d2ad37ad8a~mv2.png/v1/fill/w_373,h_413,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_5dcb4fa708c54a6e9fb265d2ad37ad8a~mv2.png",
  },
  {
    name: "TV Juggernaut",
    description: "Juggernat that fires TV soldier railgun blast every few seconds",
    rarity: "legendary", cardType: "soldiers",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_2c89cf85a7a044bdbf9b6b12fcadcac2~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-04-01%20192515.png",
  },
  {
    name: "Grenade Bunny",
    description: "The Grenade Bunny is an Easter reskin of the Halloween event Pumpkin Soldier.",
    rarity: "legendary", cardType: "soldiers",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/f89faf_dd9ee7ce2ab8426cbbb4cf5277d4db41~mv2.png/v1/fill/w_293,h_325,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_dd9ee7ce2ab8426cbbb4cf5277d4db41~mv2.png",
  },
  {
    name: "Drill Worker",
    description: "Werewolf reskin that can attack vehicles along with players within a vehicle, and doesn't have the self-healing ability.",
    rarity: "legendary", cardType: "soldiers",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_2bcb580eaaa24a02936cc4bbf912383f~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202026-02-14%20150912.png",
  },
  {
    name: "Grumpy RPG",
    description: "This Halloween reskin of the RPG features a single rocket shot that explodes into a gas bomb. It can be spammed to cause lag and serious damage to a certain location.",
    rarity: "legendary", cardType: "weapon",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_3ad7eb1e3cc8438e9dd91f4eba0a0d64~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-12-14%20191841.png",
  },
  {
    name: "PresentLauncher",
    description: "Reskined RPG with no other main benefits.",
    rarity: "legendary", cardType: "weapon",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_9f95ec36208249ddb574dc04009b594b~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-12-14%20191846.png",
  },
  {
    name: "Armed Hoverbike",
    description: "The Armed Hoverbike is now an alternative-looking, camouflaged version of the Super Speeder after the F35 Billion Update. The Armed Hoverbike still retains the exact axis rotation speed as the Super Hoverbike. The Armed Hoverbike features a frontally aimed, explosive 100-round machine gun that deals average damage. Along with having an average to good reload speed. The Armed Hoverbike also has 18 average lock-on missiles.",
    rarity: "legendary", cardType: "ground",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_59daa470ecd440cb99b3ca75f66cb1fd~mv2.png/v1/fill/w_178,h_197,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_59daa470ecd440cb99b3ca75f66cb1fd~mv2.png",
  },
  {
    name: "Sky Reaper",
    description: "The Sky Reaper is a VTOL Aircraft with air cannons that shoot large explosive tank rounds. It also has a laser with a limited range of motion and an amiable explosive round cannon. It's notoriously low in value due to it not only being a vtol vehicle. On February 18th, 2026, at around 2:30 PM Eastern Standard Time within the United States, the sky reaper's health increased from 12.5k to 25k.",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_a9d929ad88be4df9b917ffd041462e2b~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot_2025-05-23_at_5.01.51_PM.png",
  },
  {
    name: "MQ4C Jet",
    description: "fast jet with anti-dodge capabilities. The jet features 6 missiles that are just average in terms of speed and damage. The plane also has a 360 aiming laser. The laser has the downsides of not being able to aim during the aircraft's turn, as well as having a short magazine capacity and a long reload time. The main highlight of this jet is the speed, maneuverability, and anti-dodge capabilities, and not really within its armaments.",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_0de1f7728c6a4bd6b18b7a4df178cdbf~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-07-19%20220737.png",
  },
  {
    name: "Comanche",
    description: "Fast-moving Helicopter with Anti-Stealth, Anti-flare, and Anti-dodge Missiles that move within the Supersonic range on par with the GhostWind. The Comanche also features a stealth coating, which takes about 25% longer to be locked onto. The one downside of the Comanche is the long reload time of its missiles. The passenger seat of the Comanche features an aimable explosive round machine gun that deals high damage. The Comanche is the first vehicl",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/595de3_f4ca0914f3814468a36c5c9195130a1c~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Comanche.png",
  },
  {
    name: "Greyhound",
    description: "A decent gunship that features the same auto-circling weapons aiming system as the AC-130, C-17, and other similar gunship variants. The Gunship features 2 primary aimable explosive round machine guns—the machine guns currently deal low damage to buildings and vehicles. The AI tail gunner turret that is also featured for the first time on a gunship is quite nice in terms of damage, reload speed, and other stats.",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_8e0c60c4637e4eef9ef607922e716e84~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202026-02-02%20203248.png",
  },
  {
    name: "A37",
    description: "The A37 bomber features the new Napalm drop bombs, which work just like the old Napalm system on the older F-16 models, except it has a larger rectangular radius instead of a small square damage radius. The new Napalm Drop Bombs also damage through different elevations, which the older Napalm drop bombs could never achieve. The A37 has, in total, 8 Napalm drop bombs and a frontally aimed explosive round machine gun that has a magazine capacity of",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_7d84884b078a4b55a68b2d91ebc74f9d~mv2.png/v1/fill/w_180,h_199,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_7d84884b078a4b55a68b2d91ebc74f9d~mv2.png",
  },
  {
    name: "Keiler",
    description: "The Keiler features 6 mines that explode upon vertical contact by a troop or vehicle. The front of the Keiler features mine sweepers that will disarm and kind of eat the mine, ensuring no explosions occur. The Keiler also features an aimable explosive round machine gun that deals decent damage and has good velocity, range, and accuracy. The mines have a long reload time making them a bit obsolete.",
    rarity: "legendary", cardType: "ground",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_99f400eb37b7437aa2932fcbf4392689~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202026-02-14%20205934.png",
  },
  {
    name: "Stealth Boat",
    description: "The Stealth Boat is the first vehicle to feature hydrofoil technology, which enables it to operate like a hybrid of a submarine and a speedboat. It takes around 4 seconds for the Stealth Boat to rotate upon its axis a full 360 degrees. The Stealth Boat features 4 front-facing, non-lock-on torpedoes that deal heavy damage against all vehicle types. Along with a 100-round explosive bullet machine gun that deals good damage overall, but sadly featur",
    rarity: "legendary", cardType: "naval",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_efa3f4f6d536487ba30bb6a381321615~mv2.png/v1/fill/w_177,h_196,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_efa3f4f6d536487ba30bb6a381321615~mv2.png",
  },
  {
    name: "Love Buggy",
    description: "Valentine's reskin of the Boss and Dune Buggy.  The base vehicle features 2 lock-on missiles within the main passenger seat that have a slow reload time. The passenger seat features a slow-firing and low-damage explosive round aimable turret. The third passenger also has the same turret. When the first upgrade is bought names the Minigun for 10k gems, it swaps out the passenger seat turret for a minigun that is equivalent to the player's minigun.",
    rarity: "legendary", cardType: "ground",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_25b574c42d014bee8f3b010b6705b6ee~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202026-02-14%20204300.png",
  },
  {
    name: "Korkut",
    description: "The Korkut features a fast reloading smokescreen along with a primary aimable explosive round machine gun with 15 total rounds per salvo. The damage of the Anti-Air focused machine gun is decent and takes about 6 shots to down an AI F-35 within a non-public public server. As for Naval and Ground targets, the machine gun lacks damage compared to when fired upon air targets. The Korkut is able to drive within water as a ground vehicle, just like th",
    rarity: "legendary", cardType: "ground",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_4afd7161074044d4b6f742a1edfd9529~mv2.png/v1/fill/w_164,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202026-03-29%20000210.png",
  },
  {
    name: "Red F14",
    description: "The Red F14 is another variant of the F14 and features a passenger seat with no weapons or abilities. The Red F14 is just as fast and maneuverable as any of the F14 variants. It features 8 lock-on low low-damage missiles that have a decent reload speed. The front-facing explosive round machine gun is quite powerful but has a long reloading period. It's overall just a reskin of the Super F14.",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_2b2365fba93b419eb6ba4d8ff19d5d50~mv2.png/v1/fill/w_181,h_200,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_2b2365fba93b419eb6ba4d8ff19d5d50~mv2.png",
  },
  {
    name: "Gold Typhoon",
    description: "The rarest vehicle in the game.Golden Version of Typhoon Submarine. Is able to submerge in the ground due to a glitch.Has missiles that accelerate, allowing it to catch players off guard combined with the former glitch.A majority of dupes no longer exist,  marking the return of its old value.",
    rarity: "legendary", cardType: "naval",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/f89faf_b902441dfbe94d6394d8753d0d5549ad~mv2.png/v1/fill/w_373,h_413,al_c,q_85,usm_0.66_1.00_0.01,enc_avif,quality_auto/f89faf_b902441dfbe94d6394d8753d0d5549ad~mv2.png",
  },
  {
    name: "TU95",
    description: "The TU95 variants are the first air vehicle to feature a tail gunner-type weapon. The TU95 has the same weapons arsenal and damage as that of ht eSuper TU95; the only difference between the 2 vehicles is the nuclear effect that is applied to the Super TU95 models drop bombs. The damage of both drop bombs are suprisingly the same.",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_9c7df674283b4d0eabf357172cf4c968~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202026-03-17%20151751.png",
  },
  {
    name: "J20",
    description: "The J20 features 4 low-damage-dealing, lock-on missiles. The J20 also has a 2-front-firing explosive round and machine guns that deal average damage. The J20 features 2 gem upgrades: the Gun Upgrade and the Super Missile Upgrade. The Super missile upgrade seems to drastically increase the damage of the J20's missiles, which is locked behind level 50. The Gun upgrade currently seems to have already been applied to all vehicles regardless of level ",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_e39c0dca2b32487cb54310ddff5663fd~mv2.png/v1/fill/w_173,h_192,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_e39c0dca2b32487cb54310ddff5663fd~mv2.png",
  },
  {
    name: "Foch 155",
    description: "Average tank with a limited range frontal cannon, it can aim up and down vertically. But the cannon lacks horizontal or side-to-side movement capabilities. The Foch 155 also features an aimable explosive round machine gun. The machine gun has a large ammo capacity but lacks fire rate. The reload is very quick for both the frontal cannon and machine gun.",
    rarity: "legendary", cardType: "ground",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_830f0f237b134414a2c111c31ad9528f~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-11-20%20020050.png",
  },
  {
    name: "Lovebird",
    description: "Valentine's reskin of the standard blackbird and Boss Blackbird, featuring the same slow-firing explosive round machine gun and low-damage missiles. The Lovebird's missiles have a unique flame trail and are adorned with pink skin. The exhaust is also a slightly different shade to match the festive vehicle.",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_2a83ae078d784b30a60cfe6b922a5fec~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202026-02-14%20210207.png",
  },
  {
    name: "Antonov A40",
    description: "The Antonov A40 is a april fools event vehicle that is essentially a tank with some wings. The Antonov A40 features an aimable, highly damaging, explosive main cannon. Along with an aimable, explosive, round machine gun. The reload speed of both weapons is average for a tank. The Antonov A40 is quite maneuverable but lacks speed.",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_6b74570a974640e7aab295c6c9fac085~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202026-04-01%20012439.png",
  },
  {
    name: "Defiant-X",
    description: "The Defiant-X is a Fast and Agile Helicopter that features the Recon Radar ability. Along with having dual aimable 100 explosive-round machine guns that deal good damage and have good range. Also, it features 8 average lock-on missiles.",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_20b249b892c04d0c8aa2a51120119011~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-11-20%20002414.png",
  },
  {
    name: "Rocket HE177",
    description: "The Rocket HE177 features the same weaponry as the Super He177, but the 100-round machine gun is limited to 65 rounds, and the number of guided missiles is reduced by one, down to a total capacity of 2 guided missiles. The 2 AI machine guns are the same on both aircraft.",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_f0885feead384a33bce55e725658f5fd~mv2.png/v1/fill/w_186,h_206,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_f0885feead384a33bce55e725658f5fd~mv2.png",
  },
  {
    name: "Overlord",
    description: "The normal Overlord features the same weapons set, damage, weapon reload speed, vehicle speed, and other stats. The major difference between the Master variant and the normal Overlord is the hitbox size, with the Master Overlord having a larger one than the normal variant.",
    rarity: "legendary", cardType: "ground",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_6182859408b9452e8b3425669e17f1fc~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202026-02-23%20211531.png",
  },
  {
    name: "Ironhawk",
    description: "Average helicopter with 4 armor-penetrating missiles and 2 rockets bursts. The missiles reload at an average pace, while the rocket bursts take quite a bit longer to reload. The Ironhawk also contains a weaponless and featureless passenger seat.",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_fdd35f507b394d168db0fae4767bc204~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-11-20%20013218.png",
  },
  {
    name: "SeaHawk",
    description: "The first aircraft that is able to land on water. It features a single frontal firing explosive round machine gun. Along with a few drop bombs that deal average damage. The maneuverability of the aircraft is not great so it's only ideal for bomb runs and no other tasks.",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_c9430515764e441cbc88734092aad3ed~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-11-29%20173821.png",
  },
  {
    name: "AT Akrep",
    description: "Anti-tank variant of the Anti-Air Akrep features the same aimable explosive round cannon and 2 anti-tank missiles. This is the first time anti-tank missiles have been added to Military Tycoon. The missile also features a new texture and audio effects.",
    rarity: "legendary", cardType: "ground",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_f7a7f4b3d1914397a1d9af81b63ad301~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-11-22%20223554.png",
  },
  {
    name: "Tank Boat",
    description: "Fast attack boat with a tank cannon that deals high damage, along with having a decently fast reload speed. The cannon has 5 shots before requiring a reload. The Tank boat also features a passenger seat that unfortunately has no weapons or special abilities.",
    rarity: "legendary", cardType: "naval",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_339801ab9d354cbf9e43ca259c999930~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-09-28%20194839.png",
  },
  {
    name: "Skyfox",
    description: "The Skyfox is a decently fast and maneuverable aircraft with a front-firing explosive round machine gun, along with 2 splitting missiles like the X-59 variants. It also features a passenger seat that, unfortunately, has no weapons.",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_f57f4358891147fdbf5656b469691de9~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-11-20%20012344.png",
  },
  {
    name: "Hammerhead",
    description: "The hammerhead functions exactly like the Seacraft DPC except for having improved aquatic movement speed, along with decreasing player movement speed on land. These tools are also the first of their kind, adding a new gameplay aspect for the seas.",
    rarity: "legendary", cardType: "tool",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_0ddf048ef7e6440aa34860b844774d4c~mv2.png/v1/fill/w_120,h_133,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_0ddf048ef7e6440aa34860b844774d4c~mv2.png",
  },
  {
    name: "Sukhoi SU25",
    description: "Compared to the normal SU25, the Sukhoi SU25 has three more machine guns, with a total of four front-firing, explosive-round machine guns. The Sukhoi SU25 also features 2 fewer missiles than the normal SU25, but each missile deals more damage.",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_83b895324d964fba99fe16525b768a4b~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-11-20%20013612.png",
  },
  {
    name: "Infinity Car",
    description: "Can infinitly accelerate making it one of the fastest ground vehicles, along with having decent ai cannons, strong frontal aimable cannon, and average lock on missiles",
    rarity: "legendary", cardType: "ground",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_ca8a99ed53754d448fe0c4d798fd827e~mv2.png/v1/fill/w_180,h_199,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_ca8a99ed53754d448fe0c4d798fd827e~mv2.png",
  },
  {
    name: "Apocalypse",
    description: "The second rarest vehicle in-game. Has an outdated anti air weapon, but is collected as a token of high value, due to its scarcity.Tends to swing in value quickly.",
    rarity: "legendary", cardType: "ground",
    dropWeight: 1, worthValue: 2500, burnValue: 1250,
    imageUrl: "https://static.wixstatic.com/media/6511c0_8b08de35c8ca41de948747b4a5280e79~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/apoc.png",
  },
  {
    name: "Enrageed Vampire",
    description: "Has a better range, fire rate, damage, movement speed, health, and other improved stats compared to the normal vampire. It is currently one of the most powerful troops in the game, with its strong healing factor and damage capabilities.",
    rarity: "legendary", cardType: "soldiers",
    dropWeight: 1, worthValue: 4000, burnValue: 2000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_6c064058a89740aeb118900c5556163d~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-10-26%20001456.png",
    customRaritySlug: "exotic",
  },
  {
    name: "Enraged Werewolf",
    description: "The enraged werewolf is a slightly more powerful version of the werewolf, with its primary differences being its damage range and damage statistics. The healing factor is what it gains compared to the normal werewolf.",
    rarity: "legendary", cardType: "soldiers",
    dropWeight: 1, worthValue: 4000, burnValue: 2000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_188c329d2c514cbf9df6785d4b99cf18~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-10-26%20001500.png",
    customRaritySlug: "exotic",
  },
  {
    name: "Railgun",
    description: "The railgun features 3 railgun shots that can be fired in quick succession; each deals explosive splash damage. The main highlight of the railgun is that it increases troops/soldiers' damage during boss fights when equipped in your hand. It sets all troop damage to 450 to 550 damage, depending on the boss stage. The Railgun can be best combined with toxic troops, grenadiers, or any other projectile or high fire rate troop to deal the most damage ",
    rarity: "legendary", cardType: "weapon",
    dropWeight: 1, worthValue: 4000, burnValue: 2000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_d3dfe633a3bb437aa11a68c9a5fc3034~mv2.png/v1/fill/w_113,h_125,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_d3dfe633a3bb437aa11a68c9a5fc3034~mv2.png",
    customRaritySlug: "exotic",
  },
  {
    name: "Noscope Bunny",
    description: "The Noscope Bunny features a semi-automatic sniper rifle that fires a few shots at a time that deal damage and are effective only at close range. The Noscope Bunny seems to be an Easter Bunny reskin of the Assassin troop.",
    rarity: "legendary", cardType: "soldiers",
    dropWeight: 1, worthValue: 4000, burnValue: 2000,
    imageUrl: "https://static.wixstatic.com/media/f89faf_6ce755150d4d405e9f54a5ecb3423c74~mv2.png/v1/fill/w_258,h_286,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_6ce755150d4d405e9f54a5ecb3423c74~mv2.png",
    customRaritySlug: "exotic",
  },
  {
    name: "Super Pumpkin",
    description: "Daily XP crate exclusive troop that deals significantly more damage than the normal Pumpkin soldier. It has a pumpkin launcher with a decent fire rate and a splash damage radius.",
    rarity: "legendary", cardType: "soldiers",
    dropWeight: 1, worthValue: 4000, burnValue: 2000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_38d0e886974145dd810bb3c268c92b4e~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-11-20%20011502.png",
    customRaritySlug: "exotic",
  },
  {
    name: "Warlord Bunny",
    description: "The Warlord Bunny features 2 golden P-90 Submachine guns that have incredible range, fire rate, and damage. The Warlord Bunny has average health and speed.",
    rarity: "legendary", cardType: "soldiers",
    dropWeight: 1, worthValue: 4000, burnValue: 2000,
    imageUrl: "https://static.wixstatic.com/media/f89faf_b47a4c7e247c42ff9130729fc43c090c~mv2.png/v1/fill/w_252,h_279,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_b47a4c7e247c42ff9130729fc43c090c~mv2.png",
    customRaritySlug: "exotic",
  },
  {
    name: "Santa Killer",
    description: "Reskinned Boss Killer, it is now notably rare with the lack of dupes",
    rarity: "legendary", cardType: "soldiers",
    dropWeight: 1, worthValue: 4000, burnValue: 2000,
    imageUrl: "https://static.wixstatic.com/media/f89faf_f857b3ea3ece4a54a95764b545fd040c~mv2.png/v1/fill/w_373,h_413,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_f857b3ea3ece4a54a95764b545fd040c~mv2.png",
    customRaritySlug: "exotic",
  },
  {
    name: "Elite Hacker",
    description: "Buffed hacker troop, but otherwise lacks incentives to collect",
    rarity: "legendary", cardType: "soldiers",
    dropWeight: 1, worthValue: 4000, burnValue: 2000,
    imageUrl: "https://static.wixstatic.com/media/4db42e_cad8b4bc4c68415db3ef7c9615bbc391~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-04-06%20125530.png",
    customRaritySlug: "exotic",
  },
  {
    name: "Santa Minigun",
    description: "Reskinned Minigun that fires plasma rounds and deals average damage. It tends to jam a lot and has to be reequipped constantly when it jams mid-fire or during its rev-up.",
    rarity: "legendary", cardType: "weapon",
    dropWeight: 1, worthValue: 4000, burnValue: 2000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_d03b9114715d44659ec5cdd1d2ec64fc~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-12-14%20220514.png",
    customRaritySlug: "exotic",
  },
  {
    name: "Boss Killer",
    description: "Strong against bosses.",
    rarity: "legendary", cardType: "soldiers",
    dropWeight: 1, worthValue: 4000, burnValue: 2000,
    imageUrl: "https://static.wixstatic.com/media/ce3283_256063c2450b49b2a19b0512f7e65018~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/bossKiller.png",
    customRaritySlug: "exotic",
  },
  {
    name: "S-tank Railgun",
    description: "A tank with 2 large cannons that can deal with ground threats well. This version comes with a railgun on top that can take out 75% of an AI carriers health",
    rarity: "legendary", cardType: "ground",
    dropWeight: 1, worthValue: 4000, burnValue: 2000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_aa87a3fe8cc44554b5b64d806fe57e5e~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-11-20%20002402.png",
    customRaritySlug: "exotic",
  },
  {
    name: "B21 Raider",
    description: "The B21 Raider is a fast and maneuverable stealth bomber. The B21 Raider features the Hunter Mode ability that prevents enemies from locking on to your aircraft. Along with providing a short burst of acceleration and top speed. Hunter Mode lasts for 10 seconds before entering a brief cooldown. The B21 Raider also has 3 rapid-fire bunker buster bombs, which have a special delayed second explosion upon impact. These bunker buster bombs also have in",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 4000, burnValue: 2000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_ab9037aba3254410b0312283ed7a3aad~mv2.png/v1/fill/w_177,h_196,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_ab9037aba3254410b0312283ed7a3aad~mv2.png",
    customRaritySlug: "exotic",
  },
  {
    name: "Beam Tank",
    description: "The Beam Tank features 13 individual lasers that are quite powerful and deal 2.4k damage against a boss. It's able to 1 shot the 4-star general. The Beam Tank also features an aimable explosive round machine gun that deals average damage. The reload speed of both of these weapons is average. But the laser can not be reloaded within its salvo, so you have to finish its entire salvo before being able to reload. The Beam tank has amazing maneuverabi",
    rarity: "legendary", cardType: "ground",
    dropWeight: 1, worthValue: 4000, burnValue: 2000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_04430c9dbbce4492addc4e23107d1f2c~mv2.png/v1/fill/w_178,h_197,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_04430c9dbbce4492addc4e23107d1f2c~mv2.png",
    customRaritySlug: "exotic",
  },
  {
    name: "XF12",
    description: "The XF12 features the Super Sonic Dodge feature, along with 2 drop bomb weapons. The first is a 16-round individual nuclear drop bombs that deal good damage against buildings and troops, along with having good penetration like the Super B21 and B21 Raider drop bombs. The XF12 also has a singular round of 5 drop bomb bursts that have an almost instant reload. The XF12 is the first bomber to feature the Super Sonic Dodge feature. The bombs' damage ",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 4000, burnValue: 2000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_9b28e6e880bf449caebbe1a5da32bb6f~mv2.png/v1/fill/w_181,h_200,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_9b28e6e880bf449caebbe1a5da32bb6f~mv2.png",
    customRaritySlug: "exotic",
  },
  {
    name: "Leonardo",
    description: "The Leonardo variants are the first vehicles to feature the hunter mode in the form of a helicopter. They also feature split weapons controls like the F-16 Falcon. The two weapon modes are Anti-Ground and Anti-Air. Within Anti-Ground, the default when first spawned i,n you get a aimable explosive round machine gun that features a large ammo capacity with an average reload speed. The ground weapon mode also has 2 missile bursts that deal average d",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 4000, burnValue: 2000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_46ec6c7243694307ad28a6fd57f47290~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202026-02-21%20123441.png",
    customRaritySlug: "exotic",
  },
  {
    name: "Super TU95",
    description: "Decent bomber that features 9 nuclear drop bombs that cause good damage. The Super Tu95 also has a tail gunner who has an aiming angle range of 180 degrees. The tail gunner is manually operated and doesn't feature AI control. The reload speed of both the drop bombs and tial gunner is quite fast compared to other vehicles that feature these weapons. The damage of the Tail Gunner is quite low at the moment, making it not great for its main purpose ",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 4000, burnValue: 2000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_3da48335721d435d8d7ffeaf1b4e19c4~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202026-03-17%20151743.png",
    customRaritySlug: "exotic",
  },
  {
    name: "Medic Helicopter",
    description: "The Medic Helicopter features similar weapons and features to its Limited Edition rarity Super varient. The main difference is that the Medic's colored machine gun has been reduced from 75 rounds to 50 rounds, along with the healing drone count being reduced from 2 drones down to 1 drone. Another major change seems to be that the weapon loadouts are named on the exotic rarity Medic Helicopter and not its super varient. The name of the first loado",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 4000, burnValue: 2000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_6e91555b1afb43309b716838dbceddb5~mv2.png/v1/fill/w_186,h_206,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_6e91555b1afb43309b716838dbceddb5~mv2.png",
    customRaritySlug: "exotic",
  },
  {
    name: "Tiger Mech",
    description: "The Tiger mech features the same jumping and boost features as all other mechs. The Tiger mech features the same aimable explosive round machine gun as the Strike Mech variants, but also an aimable single-shot main cannon that deals serious damage. The Special feature of the Tiger Mech is its toggleable shield that protects against incoming projectiles that hit and contact the shield. When toggled, the Shield seems to slow down the movement speed",
    rarity: "legendary", cardType: "ground",
    dropWeight: 1, worthValue: 4000, burnValue: 2000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_68d63ba2e30c4149b879f8cb0bcd531e~mv2.png/v1/fill/w_183,h_203,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_68d63ba2e30c4149b879f8cb0bcd531e~mv2.png",
    customRaritySlug: "exotic",
  },
  {
    name: "Battle Yacht",
    description: "The Battle Yacht features the same weapons set as the Super Battle Yacht, except it doesn't have the AI-controlled missiles. Along with the insane, damaging explosive round machine gun ammo capacity being reduced from 75 rounds down to 50 rounds. The Railgun on the exotic rarity Battle Yacht is also weaker than its super varient as it takes around 3 railgun shots to kill an AI Naval Destroyer.",
    rarity: "legendary", cardType: "naval",
    dropWeight: 1, worthValue: 4000, burnValue: 2000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_0a982daca0c3429eabcb176413dfa688~mv2.png/v1/fill/w_181,h_200,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_0a982daca0c3429eabcb176413dfa688~mv2.png",
    customRaritySlug: "exotic",
  },
  {
    name: "Super He177",
    description: "The Super He177 features 2 average damage and fire rate AI machine guns. Along with a strong, damaging explosive 100-round, an aimable machine gun.  The Super He177 also features 3 guided missiles, which is the first time they've been on an aircraft. The guided missiles are quite average and overall not worth using as the AI and player-controlled machine guns seem to outweigh their use.",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 4000, burnValue: 2000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_5159d3d8bae347f1b0815356ee32132b~mv2.png/v1/fill/w_181,h_200,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_5159d3d8bae347f1b0815356ee32132b~mv2.png",
    customRaritySlug: "exotic",
  },
  {
    name: "Air Carrier",
    description: "The Sky Carrier is a helicopter reskinned as a VTOL aircraft, so no infinite hovering bug, which is quite special. The Sky Carrier sadly lacks a hypersonic boost, even though it has thrusters at the rear of the aircraft. The Sky Carrier currently, sadly, suffers from a bug when it hovers in place, but the propeller blades don't spin. There are no ground access points, which means you can't navigate to the pilot's seat. Drones also seem not to rel",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 4000, burnValue: 2000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_f3bee81afad24dbda374a5ca3b4777a9~mv2.png/v1/fill/w_180,h_199,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_f3bee81afad24dbda374a5ca3b4777a9~mv2.png",
    customRaritySlug: "exotic",
  },
  {
    name: "Heavy T28",
    description: "The Heavy T28 features the same horizontally 30-degree limited main cannon and machine gun turret as its Limited T28 counterpart. The main cannon fires a new non-lock-on Fast cannon round that deals the same damage as the Limited T28 base cannon shot (no cluster damage). The Heavy T28 also features an explosive 35-round machine gun that deals the same damage as the Limited T28. The Heavy T28 model machine gun also features the new machine gun aud",
    rarity: "legendary", cardType: "ground",
    dropWeight: 1, worthValue: 4000, burnValue: 2000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_68fb648c3b644d33856e7a6e115312c0~mv2.png/v1/fill/w_177,h_196,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_68fb648c3b644d33856e7a6e115312c0~mv2.png",
    customRaritySlug: "exotic",
  },
  {
    name: "K7",
    description: "The Exotic rarity K7 features a similar wepaon set as to the Nuke K7, the main differnce is the damage being drasticly worse than the Nuke K7, along with the Exotic rairty K7 not featuring the second weapon mode of Nuke Bombs but instead has a weapon mode named Bombs, the 4 - 360 degree aimable explosive round machine guns with slow reload are still present within the Bombs weapon mode but the drop bomb burst of 5 nuclear bombs got swapped for co",
    rarity: "legendary", cardType: "air",
    dropWeight: 1, worthValue: 4000, burnValue: 2000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_591395d4c995461584c9e33758f96212~mv2.png/v1/fill/w_183,h_203,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_591395d4c995461584c9e33758f96212~mv2.png",
    customRaritySlug: "exotic",
  },
  {
    name: "M1E3",
    description: "The M1E3 features a brand new aimable guided missile. The missile deals good damage, but may be hard to aim at longer ranges. The missile can be fired twice after its short reload time is finished, and 2 missiles can be guided at targets. The M1E3 has its weapons split into 2 different weapon modes. The Guided missile weapon is within the Guided Missile weapon mode. The second weapon mode is named Artillery and features an aimable explosive-round",
    rarity: "legendary", cardType: "ground",
    dropWeight: 1, worthValue: 4000, burnValue: 2000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_49dea5f04a4f401f8021654882f3f06c~mv2.png/v1/fill/w_178,h_197,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_49dea5f04a4f401f8021654882f3f06c~mv2.png",
    customRaritySlug: "exotic",
  },
  {
    name: "Super Recon Destroyer",
    description: "The Super Recon Destroyer features 3 aimable lasers that deal decent damage against all vehicle types, along with dealing good boss damage. The Super Recon Destroyer also features a very limited aiming angle, limited rotation speed, and a long reloading primary cannon that deals medium damage. The Super Recon Destroyer also has a frontally located AI rocket system that fires in 2 missile burst salvos of 4 missiles per salvo. The Super Recon Destr",
    rarity: "legendary", cardType: "naval",
    dropWeight: 1, worthValue: 4000, burnValue: 2000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_9deb5b9062e24e1d94465dff4ab0ce9e~mv2.png/v1/fill/w_185,h_204,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_9deb5b9062e24e1d94465dff4ab0ce9e~mv2.png",
    customRaritySlug: "exotic",
  },
  {
    name: "Nuke Sniper Soldier",
    description: "Features a 6-round magazine capacity sniper that detects enemies within and outside vehicles at medium range. The rounds do significant damage, along with having a decent reload.",
    rarity: "mythic", cardType: "soldiers",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/f89faf_e523a8ff76284515a9b17e91974c1940~mv2.png/v1/fill/w_202,h_224,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_e523a8ff76284515a9b17e91974c1940~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Air Commander",
    description: "The Air Commander features a brand-new AI drone buff mechanic. The Air Commander is a Limited Edition Werewolf and Drill Worker reskin in terms of its weapons, health, damage, and functions as a troop. The Air Commander Boosts Health Points and Damage of AI drones spawned from any vehicle category, with a base boost percentage of 25% for a singular no-star soldier and an 185% boost for a singular 3-star soldier. The boosts can be stacked per addi",
    rarity: "mythic", cardType: "soldiers",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_9fbdd1051c734db29a96e1e415e2abdd~mv2.png/v1/fill/w_281,h_311,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_9fbdd1051c734db29a96e1e415e2abdd~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Super Alien",
    description: "The Super Alien is just a red reskin of the Legendary rarity Alien. The UFO, Mothership, and Alien Troop damage buffs currently don't work. They don't increase building, Boss fight troops, or Boss fight vehicle damage in any capacity when equipped at the moment. The Super Alien features the same weaponry as the Alien: a raygun that deals serious damage and has a decent reload speed.",
    rarity: "mythic", cardType: "soldiers",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_86e7076a2b814bfda333aa192eb5690a~mv2.png/v1/fill/w_281,h_311,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_86e7076a2b814bfda333aa192eb5690a~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "TheIceZombieSlayer",
    description: "Somewhat weak troop that fires eye lasers that deal low damage. The troop also has very low health, and overall isn't really great in terms of functionality. But it is rare, as it's the first free-to-play considered a limited edition troop. It is also somewhat rare due to the obtianment process that requires you to participate in an admin abuse event and defeat the boss to obtain a chance of obtaining the troop.",
    rarity: "mythic", cardType: "soldiers",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/f89faf_56168ab8e2034ce3af117723b7636e51~mv2.png/v1/fill/w_206,h_228,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_56168ab8e2034ce3af117723b7636e51~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Jetpack Fighter",
    description: "A soldier who acts like a drone and currently only targets aerial vehicles. It fires a single nuclear RPG round with a quick reload time as well. Is kind of op with multiple stacked together against aerial targets.",
    rarity: "mythic", cardType: "soldiers",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/f89faf_c2a4d4d1e22b4532bd58cb02a5f95d94~mv2.png/v1/fill/w_252,h_279,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_c2a4d4d1e22b4532bd58cb02a5f95d94~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Puckmonster",
    description: "Decent troop that can only be obtained with 100k+ damage against the admin abuse boss. It features a rocket launcher that does decent damage and has decent reload, but not the best compared to other troops. It's essentially a reskinned rocket trooper.",
    rarity: "mythic", cardType: "soldiers",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/f89faf_331db2468a1f41c2ab32323fe596de12~mv2.png/v1/fill/w_196,h_217,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_331db2468a1f41c2ab32323fe596de12~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Railgun-X Destroyer",
    description: "The Railgun-X Destroyer features 6 CIWIS air defenses and a plasma machine gun that deals average damage. The Railgun-X Destroyer is the first vehicle to feature a Railgun that fires in multiple directions like a shotgun. The damage increases at closer range, but the accuracy decreases significantly. The Railgun-X Destroyer has a magnetic feature that ensures its railgun can lock onto multiple targets.",
    rarity: "mythic", cardType: "naval",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/f89faf_c28f0b1920a04f6a9705ab1687c347eb~mv2.png/v1/fill/w_154,h_171,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_c28f0b1920a04f6a9705ab1687c347eb~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Phoenix Shotgun",
    description: "The Phoenix Shotgun features 25 Dragon's Breath shells per magazine that deal burn damage capable of 1-shotting an enemy through any armor. This is as long as a single bullet from a shell round hits the enemy. The Phoenix Shotgun doesn't seem to apply the Dragon's Breath burn damage to vehicles, the electrical panel in bases, or buildings. The range of the Phoenix Shotgun seems to be infinite as long as you're able to aim and hit a shot, and not ",
    rarity: "mythic", cardType: "weapon",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_26dafba03def46589c8f2020e6e75dc8~mv2.png/v1/fill/w_111,h_123,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_26dafba03def46589c8f2020e6e75dc8~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Jet Engineer",
    description: "Primarily a repair drone, but it can be used within the troop section. Stars scale the healing ability of the Jet Engineer, costing 125 Jet Engineers for a maximum of 3 stars.",
    rarity: "mythic", cardType: "soldiers",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/f89faf_20db1824a38247d9b7d01fed57730a8a~mv2.png/v1/fill/w_209,h_231,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_20db1824a38247d9b7d01fed57730a8a~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Super Ace Pilot",
    description: "The Super Ace Pilot is a vehicle buff-applying troop that buffs air vehicle damage by 6% with 0 stars at any level of Super Ace Pilot. The Super Ace Pilot can also buff air vehicle damage by 30% with 3 stars at any level of Super Ace Pilot. The Super Ace Pilot troops can be stacked together to obtain a max air vehicle buff of 120% if 4 Super Ace Pilot troops with 3 stars are equipped. The Super Ace Pilot features a strong pistol that deals good d",
    rarity: "mythic", cardType: "soldiers",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_39d57ffed61741228874ecca8a259132~mv2.png/v1/fill/w_279,h_309,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_39d57ffed61741228874ecca8a259132~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Anti-Vehicle Rifle",
    description: "Explosive sniper reskin with 5 shots",
    rarity: "mythic", cardType: "weapon",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_d412566b91ed41439fd13449331c55ec~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-12-14%20190934.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Platinum SB-12",
    description: "The Platinum SB-12 is a large bomber-type aircraft that, due to its size, spawns in front of your base instead of the traditional airstrip. The Platinum SB-12 also features a passenger that unfortunately doesn't have any other use or weapons. The Platinum SB-12 has AI defense machine guns that have poor accuracy, poor range, and poor damage, which makes it obsolete as an offensive or defensive option. The Platinum SB-12 also has 8 defensive YF1 d",
    rarity: "mythic", cardType: "air",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_cf0229e0d990490091602a5e076026a5~mv2.png/v1/fill/w_183,h_203,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_cf0229e0d990490091602a5e076026a5~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Super B21",
    description: "The Super B21 is a fast, maneuverable, and stealthy bomber. The Super B21 features the Hunter Mode ability, which prevents enemies from locking onto your aircraft. Along with providing a short burst of acceleration and top speed. Hunter Mode lasts for 10 seconds before entering a brief cooldown. The Super B21 also has 4 rapid-fire bunker buster bombs, which have a special delayed second explosion upon impact. These bunker buster bombs also have i",
    rarity: "mythic", cardType: "air",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_6e05cc8cf13449279a65c592df36ae64~mv2.png/v1/fill/w_181,h_200,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_6e05cc8cf13449279a65c592df36ae64~mv2.png",
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
    name: "Super S.W.A.R.M",
    description: "Decent aircraft with the supersonic dodge ability, 5 speedy and maneuverable drones that shoot explosive rounds at a slow rate. The Super S.W.A.R.M. also has five medium-damage anti-flare and supersonic missiles and one high AOE high damage supersonic missile. The main highlight is that the fast and maneuverable drones are extremely hard to hit; they can target enemy vehicles and troops, but unfortunately, not missiles. The Super S.W.A.R.M also h",
    rarity: "mythic", cardType: "air",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/f89faf_9ab24ec36f7d48e087a934b7bf377dce~mv2.png/v1/fill/w_154,h_171,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_9ab24ec36f7d48e087a934b7bf377dce~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Super Medic Helicopter",
    description: "The Super Medic Helicopter features the first healing drone spawner in the game. Along with unfortunately has no passenger seats and 2 weapon loadouts. The first loadout is named Loadout 1 and features a 75 round medicinal colored machine gun that can't heal in-game teams or faction members. Along with a double healing drone spawner that currently only heals to about two-thirds of the Medic Helicopter's health, then afterwards only functions as l",
    rarity: "mythic", cardType: "air",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_5afc60e54fe04649bee3ea3924151dab~mv2.png/v1/fill/w_180,h_199,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_5afc60e54fe04649bee3ea3924151dab~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Raptor X",
    description: "The Raptor X is a matte black-painted version of the Raptor that features the Super Sonic Dodge ability and 2 weapon loadouts. The first loadout is named Air-Air Combat and features a 200-round, right-positioned, frontal-aimed explosive round machine gun that deals good damage. Along with 8 average lock-on missiles. The second weapon loadout is named Super Sonic Missiles and features  4 anti-flare supersonic missiles that deal low damage but have",
    rarity: "mythic", cardType: "air",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_5638c5d0139641a8884b2158c5d5b01c~mv2.png/v1/fill/w_181,h_200,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_5638c5d0139641a8884b2158c5d5b01c~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Super Warspite",
    description: "The Super Warspite features 2 attack modes, the first is named Fire Power and features 8 centrally located rapid-fire cannons that deal medium to serious damage. Along with 3 non-reloading large caliber cannons that produce the same damage and audio as the P1000 Ratte and Sturm Tank main cannons. The 3 non-reloading cannons can fire 8 shots per salvo. The Fire Power weapons all reload quite fast. The Super Warspite also features 7 AI machine guns",
    rarity: "mythic", cardType: "naval",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_1129c17f17cb4355bd755c4c100bd553~mv2.png/v1/fill/w_193,h_214,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_1129c17f17cb4355bd755c4c100bd553~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Werewolf Tank",
    description: "A decent maneuvering tank that features 2 weapons. The first is a flamethrower that has a purple effect. The second weapon is a gas implosion that activates a few seconds after the in-game weapon button is pressed. The gas radius is quite large, but the damage is low. The secondary weapon reloads quite fast for its capabilities. The flamethrower has quite a large ammo capacity but a long reload time.",
    rarity: "mythic", cardType: "ground",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/f89faf_cc873c3ab1214dd699f5c7b1344c45e2~mv2.png/v1/fill/w_154,h_171,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_cc873c3ab1214dd699f5c7b1344c45e2~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Haunted Tank",
    description: "Slow-moving tank that has decent mid-range acceleration. It features a cannon with a fast reload time that fires only a single shot. The cannon round has a life-stealing feature, which is quite powerful and can heal a significant chunk of the vehicle's health. The HauntedTank also features 2 missile bursts of 6 missiles that deal a decent amount of damage, but unfortunately don't have the life steal function like the main cannon. The missiles' bu",
    rarity: "mythic", cardType: "ground",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_3cc8d8c183644311930614360d7eeb2e~mv2.png/v1/fill/w_162,h_86,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/Screenshot%202025-11-20%20000900.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Limited T28",
    description: "The Limited T28 features a horizontally 30-degree limited main cannon and a machine gun. The Main cannon is a non-lock-on-capable single-cluster round that deals low damage and has a slow reload speed. The 50-round machine gun is an explosive-round machine gun that deals good damage against vehicles. The Limited T28 features the first new machine gun audio in a long time. The Limited T28 is also surrounded by protective armor like the Sturmtank m",
    rarity: "mythic", cardType: "ground",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_6fd4cbe3b11542e8a9d37ef47a3e0c6b~mv2.png/v1/fill/w_186,h_206,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_6fd4cbe3b11542e8a9d37ef47a3e0c6b~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Limited Patriot",
    description: "The Limited Patriot features a golden and black reskin, along with 4 new horizontal cluster hypersonic missiles that deal medium to serious damage. The Limited Patriot also has a singular AI-controlled horizontal cluster hypersonic missile. The reload speed and range of all of these missiles are slower than those of the Legendary Rarity Patriot truck. The Limited Patriot features a faster aircraft lock-on speed, but isn't instant like on the USS ",
    rarity: "mythic", cardType: "ground",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_ab4f412cf4c5429fbf50d0d2a963a0f0~mv2.png/v1/fill/w_180,h_199,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_ab4f412cf4c5429fbf50d0d2a963a0f0~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Super Zhi 19E",
    description: "Helicopter with hypersonic missiles. It also features a rocket barrage, inflicting medium to low damage to the passenger seat. The Super Zhi 19E also features a machine gun that deals high damage but with a low ammo capacity, like the Cobra. The multi-lock feature is another characteristic of this aircraft, also found on the Cobra variants.  The helicopter overall is like a cobra but with a barrage passenger weapon and slightly better stats.",
    rarity: "mythic", cardType: "air",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/f89faf_c7028af52c664981bbb399c596bc7c29~mv2.png/v1/fill/w_154,h_171,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_c7028af52c664981bbb399c596bc7c29~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Stalker Drone",
    description: "Limited Edition drone that can only be found in the starting millitary base and not any of the other bases. The Stalker Drone features a long reloading railgun that does medium to low damage. The Stalker Drone only seems to target all AI NPC troops, as well as AI ground and air targets. But doesn't seem to target players, player vehicles, or AI naval boats. The downside of the stalker drone is that it can damage the user's vehicle.",
    rarity: "mythic", cardType: "drones",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/f89faf_7788514119274e8f97b15f668e69d489~mv2.png/v1/fill/w_206,h_228,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_7788514119274e8f97b15f668e69d489~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Super Repair Drone",
    description: "The Super Repair Drone heals both vehicles and other drones. The healing rate for a no-star Super Repair Drone is about 70 HP (Health Points) per second, with a single star providing 105 HP per second, a double-star providing 140 HP per second, and 3 star providing 175 HP per second. The range of the Super Repair Drone is increased to 175 meters compared to that of the normal Repair drone at a measly 100 meters total. Healing vehicles only work f",
    rarity: "mythic", cardType: "drones",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_23b21d132eea4099b68c3decc3a84e4b~mv2.png/v1/fill/w_292,h_323,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_23b21d132eea4099b68c3decc3a84e4b~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Zumwalt X",
    description: "The Zumwalt X features a high-fire-rate dual-explosive-round cannon. It has improved damage and a significantly increased fire rate compared to the normal Zumwalt. The Zumwalt X also features 2 AI Drones that shoot out missiles and are very powerful with a lot of health. The drone respawn cooldown is fast enough to be able to not be destroyed in your Zumwalt unless splash damage or stars are used.  The Zumwalt X also features missiles with a fast",
    rarity: "mythic", cardType: "naval",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/f89faf_5efbcbe3793846989a0dc7f2619d043a~mv2.png/v1/fill/w_154,h_171,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_5efbcbe3793846989a0dc7f2619d043a~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Limited SONAR",
    description: "The Limited SONAR is a naval vehicle that features the same Recon Rader in vehicles like the Terrorbyte and Recon Heli. The Limited SONAR also has the same rocket deflection system as the Corsair variants. The Limited SONAR has an average-damage, aimable, explosive 75-round machine gun, along with 3 new rear-located, high-damage barrel-drop bombs. The reload speed of both of the Limited SONAR's weapons is quite fast compared to similar weapons on",
    rarity: "mythic", cardType: "naval",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_1e981963ebca45cd8136e3c794158dfe~mv2.png/v1/fill/w_183,h_203,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_1e981963ebca45cd8136e3c794158dfe~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Super M1E3",
    description: "The Super M1E3 features the same weapons set as the M1E3 exotic varient except for the cannon. The main differences between the 2 tanks are the slight damage increase the Super M1E3 has. The maneuverability, speed, and reload times seem to be about the same. The cannon round features the cluster damage effect.  The cluster cannon round, unfortunately, can't lock on to targets.",
    rarity: "mythic", cardType: "ground",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/f89faf_e7b67f4928774f319f970371972fb5f9~mv2.png/v1/fill/w_358,h_396,al_c,lg_1,q_85,enc_avif,quality_auto/f89faf_e7b67f4928774f319f970371972fb5f9~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Super Battle Yacht",
    description: "The Super Battle Yacht features an insane, damaging 75-round explosive round machine gun along with a 5-round semi-automatic railgun. The Super Battle Yacht also has AI-controlled missiles that deal low to medium damage. It takes about 2 full railgun charges to kill 1 AI Naval Destroyer. The railgun can be spam-fired, which is better than fully charging the railgun.",
    rarity: "mythic", cardType: "naval",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/6511c0_aeb06409a72f489f96faa61dbe431e3c~mv2.png/v1/fill/w_190,h_210,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_aeb06409a72f489f96faa61dbe431e3c~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
  {
    name: "Plat Skyhammer",
    description: "The Platinum Skyhammer features 2 plasma machineguns with 400 ammo in total along with a never before seen EMP orbital strike on the driver seat. The Platinum Skyhammer also features 3 gunner seats equipped with a 100 ammo plasma machinegun each. The Platinum Skyhammer is also a VTOL vehicle which means it can hover over a specific spot.",
    rarity: "mythic", cardType: "air",
    dropWeight: 0, worthValue: 6000, burnValue: 3000,
    imageUrl: "https://static.wixstatic.com/media/f89faf_0c3c8709f0254733885abbd4921d461e~mv2.png/v1/fill/w_373,h_413,al_c,q_85,usm_0.66_1.00_0.01,enc_avif,quality_auto/f89faf_0c3c8709f0254733885abbd4921d461e~mv2.png",
    isLimitedEdition: true,
    inPacks: false,
    droppable: false,
  },
];
