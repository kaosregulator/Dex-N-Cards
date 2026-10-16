import type { CustomRarity, GuildSettings, RarityProfile } from "@workspace/db";
import {
  RARITY_WEIGHTS, RARITY_WORTH, RARITY_BURN, BUILTIN_RARITIES, getRarityOrder, rarityRank,
  rarityLabel as builtinRarityLabel,
  rarityEmoji as builtinRarityEmoji,
  rarityColor as builtinRarityColor,
  type Rarity,
  type RarityDisplayMap,
} from "./cards-data.js";

export type RarityProfileMap = Map<Rarity, RarityProfile>;

export const BUILTIN_POSITIONS: Record<Rarity, number> = {
  common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5, mythic: 6,
};

export type RarityContext = {
  guildId: string;
  profile: RarityProfileMap;
  customByCard: Map<number, CustomRarity>;
  customBySlug: Map<string, CustomRarity>;
  customs: CustomRarity[];
  // The guild's built-in rarity order (weakest → strongest), from the /rarity
  // Order editor. Drives the strength ladder below.
  order: Rarity[];
  // THE strength ladder: rarity key ("common" | "custom:slug") → 0-based rank
  // (0 = weakest). Merges built-ins (in the guild's order) with custom tiers (by
  // their position), so a custom tier placed above mythic actually ranks above
  // mythic in battles, raids, and every stat calc. Baked here so any system that
  // already resolves the rarity context ranks consistently.
  rankByKey: Map<string, number>;
  maxRank: number;
};

// Build the strength ladder (weakest → strongest) merging built-ins (positioned
// by the guild's order) with custom tiers (by their stored position). Built-in
// positions are 1..6 in the guild order; a custom tier's `position` slots it
// relative to that same 1..6 baseline (e.g. 7 = above mythic, 5.5 = between the
// 5th and 6th tiers).
export function buildRarityLadder(
  order: Rarity[], customs: CustomRarity[],
): { key: string; position: number; isCustom: boolean }[] {
  const builtins = order.map((r, i) => ({ key: r as string, position: i + 1, isCustom: false }));
  const cust = customs.map(c => ({ key: `custom:${c.slug}`, position: c.position, isCustom: true }));
  return [...builtins, ...cust].sort((a, b) => a.position - b.position);
}

// Rarity key → 0-based strength rank on the guild ladder.
export function buildRarityRankMap(order: Rarity[], customs: CustomRarity[]): Map<string, number> {
  const ladder = buildRarityLadder(order, customs);
  const m = new Map<string, number>();
  ladder.forEach((e, i) => m.set(e.key, i));
  return m;
}

// The strength rank of a rarity key on the guild ladder. Falls back to the
// canonical built-in rank if the key is somehow unknown (never crashes).
export function rarityLadderRank(key: string, ctx?: RarityContext | null): number {
  const r = ctx?.rankByKey.get(key);
  return r ?? rarityRank(key);
}

type EconCard = { rarity: string; worthValue: number; burnValue: number; dropWeight: number };

export type RarityEconomy = { worthValue: number; burnValue: number; dropWeight: number };

/** Built-in rarity economy. A server override wins per field; everything else is the default. */
export function effectiveBuiltinEconomy(
  rarity: Rarity,
  profile?: { worthValue?: number | null; burnValue?: number | null; dropWeight?: number | null } | null,
): RarityEconomy {
  return {
    worthValue: profile?.worthValue ?? RARITY_WORTH[rarity],
    burnValue: profile?.burnValue ?? RARITY_BURN[rarity],
    dropWeight: profile?.dropWeight ?? RARITY_WEIGHTS[rarity],
  };
}

/** 1-based slot of a built-in rarity in the guild's /rarity order. */
export function builtinDisplayPosition(rarity: Rarity, order?: readonly Rarity[] | null): number {
  if (order && order.length) {
    const index = order.indexOf(rarity);
    if (index >= 0) return index + 1;
  }
  return BUILTIN_POSITIONS[rarity];
}

export type DisplayRarity = {
  key: string;
  label: string;
  emoji: string;
  color: number;
  position: number;
  isCustom: boolean;
  rarity?: Rarity;
  slug?: string;
};

export type DropWeightOptions = {
  ctx?: RarityContext;
  rarityWeights?: Record<string, number>;
  setRarityWeights?: Record<string, number> | null;
  eventBoosts?: Map<number, number>;
};

export type DropChanceSummary = {
  totalWeight: number;
  weightByCardId: Map<number, number>;
  weightByRarityKey: Map<string, number>;
  cardPercentById: Map<number, number>;
  rarityPercentByKey: Map<string, number>;
};

export function applyRarityProfile<T extends EconCard>(card: T, profile: RarityProfileMap): T {
  if (profile.size === 0) return card;
  const o = profile.get(card.rarity as Rarity);
  if (!o) return card;
  return {
    ...card,
    worthValue: o.worthValue ?? card.worthValue,
    burnValue: o.burnValue ?? card.burnValue,
    dropWeight: o.dropWeight ?? card.dropWeight,
  };
}

export function applyRarityProfileAll<T extends EconCard>(cards: T[], profile: RarityProfileMap): T[] {
  if (profile.size === 0) return cards;
  return cards.map(c => applyRarityProfile(c, profile));
}

export function applyRarityContext<T extends EconCard & { id: number }>(card: T, ctx: RarityContext): T {
  const tier = ctx.customByCard.get(card.id);
  if (tier) {
    return {
      ...card,
      worthValue: tier.worthValue,
      burnValue: tier.burnValue,
      dropWeight: tier.dropWeight,
    };
  }
  return applyRarityProfile(card, ctx.profile);
}

export function applyRarityContextAll<T extends EconCard & { id: number }>(cards: T[], ctx: RarityContext): T[] {
  if (ctx.customByCard.size === 0 && ctx.profile.size === 0) return cards;
  return cards.map(c => applyRarityContext(c, ctx));
}

export function effectiveRarityKey(card: { id: number; rarity: string }, ctx: RarityContext): string {
  const tier = ctx.customByCard.get(card.id);
  return tier ? `custom:${tier.slug}` : card.rarity;
}

export function getCardDisplayRarity(
  card: { id: number; rarity: string },
  ctx?: RarityContext | null,
  settings?: GuildSettings | null,
  displayMap?: RarityDisplayMap | null,
): DisplayRarity {
  const tier = ctx?.customByCard.get(card.id);
  if (tier) {
    return {
      key: `custom:${tier.slug}`,
      label: tier.name,
      emoji: tier.emoji,
      color: tier.color,
      position: tier.position,
      isCustom: true,
      slug: tier.slug,
    };
  }

  const rarity = card.rarity as Rarity;
  return {
    key: rarity,
    label: builtinRarityLabel(rarity, settings, displayMap),
    emoji: builtinRarityEmoji(rarity, settings, displayMap),
    color: builtinRarityColor(rarity, settings, displayMap),
    position: builtinDisplayPosition(rarity, ctx?.order),
    isCustom: false,
    rarity,
  };
}

export function getDisplayRarities(
  ctx: RarityContext,
  settings: GuildSettings | null,
  opts?: { rarestFirst?: boolean; displayMap?: RarityDisplayMap | null },
): DisplayRarity[] {
  const rarestFirst = opts?.rarestFirst ?? true;
  const displayMap = opts?.displayMap ?? null;
  const order = ctx.order?.length ? ctx.order : (Object.keys(BUILTIN_POSITIONS) as Rarity[]);
  const builtins: DisplayRarity[] = order.map(r => ({
    key: r,
    label: builtinRarityLabel(r, settings, displayMap),
    emoji: builtinRarityEmoji(r, settings, displayMap),
    color: builtinRarityColor(r, settings, displayMap),
    position: builtinDisplayPosition(r, order),
    isCustom: false,
    rarity: r,
  }));
  const customs: DisplayRarity[] = ctx.customs.map(c => ({
    key: `custom:${c.slug}`,
    label: c.name,
    emoji: c.emoji,
    color: c.color,
    position: c.position,
    isCustom: true,
    slug: c.slug,
  }));
  const all = [...builtins, ...customs];
  all.sort((a, b) => rarestFirst ? b.position - a.position : a.position - b.position);
  return all;
}

export function getGuildRarityWeights(settings: GuildSettings): Record<string, number> | undefined {
  const hasCustom = [
    settings.rarityWeightCommon,
    settings.rarityWeightUncommon,
    settings.rarityWeightRare,
    settings.rarityWeightEpic,
    settings.rarityWeightLegendary,
    settings.rarityWeightMythic,
  ].some(v => v !== null);
  if (!hasCustom) return undefined;
  return {
    common: settings.rarityWeightCommon ?? RARITY_WEIGHTS.common,
    uncommon: settings.rarityWeightUncommon ?? RARITY_WEIGHTS.uncommon,
    rare: settings.rarityWeightRare ?? RARITY_WEIGHTS.rare,
    epic: settings.rarityWeightEpic ?? RARITY_WEIGHTS.epic,
    legendary: settings.rarityWeightLegendary ?? RARITY_WEIGHTS.legendary,
    mythic: settings.rarityWeightMythic ?? RARITY_WEIGHTS.mythic,
  };
}

export function isRandomDroppable(card: { id: number; droppable: boolean; isArchived?: boolean | null }, ctx?: RarityContext): boolean {
  if (!card.droppable || card.isArchived) return false;
  const customTier = ctx?.customByCard.get(card.id);
  return customTier ? customTier.droppable : true;
}

export function getEffectiveDropWeight<T extends EconCard & { id: number }>(
  card: T,
  opts: DropWeightOptions = {},
): number {
  const customTier = opts.ctx?.customByCard.get(card.id);
  let base: number;
  if (customTier) {
    base = customTier.dropWeight;
  } else {
    const setWeight = opts.setRarityWeights?.[card.rarity];
    if (setWeight != null) {
      base = setWeight;
    } else {
      const profileWeight = opts.ctx?.profile.get(card.rarity as Rarity)?.dropWeight;
      if (profileWeight != null) base = profileWeight;
      else if (opts.rarityWeights) base = opts.rarityWeights[card.rarity] ?? card.dropWeight;
      else base = card.dropWeight;
    }
  }
  const boost = opts.eventBoosts?.get(card.id) ?? 1;
  return Math.max(0, base) * boost;
}

export function buildDropChanceSummary<T extends EconCard & { id: number; droppable: boolean; isArchived?: boolean | null }>(
  cards: T[],
  opts: DropWeightOptions = {},
): DropChanceSummary {
  const weightByCardId = new Map<number, number>();
  const weightByRarityKey = new Map<string, number>();
  const cardPercentById = new Map<number, number>();
  const rarityPercentByKey = new Map<string, number>();

  for (const card of cards) {
    if (!isRandomDroppable(card, opts.ctx)) continue;
    const weight = getEffectiveDropWeight(card, opts);
    if (weight <= 0) continue;
    weightByCardId.set(card.id, weight);
    const key = opts.ctx ? effectiveRarityKey(card, opts.ctx) : card.rarity;
    weightByRarityKey.set(key, (weightByRarityKey.get(key) ?? 0) + weight);
  }

  const totalWeight = [...weightByCardId.values()].reduce((sum, weight) => sum + weight, 0);
  if (totalWeight > 0) {
    for (const [cardId, weight] of weightByCardId) cardPercentById.set(cardId, (weight / totalWeight) * 100);
    for (const [key, weight] of weightByRarityKey) rarityPercentByKey.set(key, (weight / totalWeight) * 100);
  }

  return { totalWeight, weightByCardId, weightByRarityKey, cardPercentById, rarityPercentByKey };
}
