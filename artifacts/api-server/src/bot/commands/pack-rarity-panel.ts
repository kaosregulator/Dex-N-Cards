// /config → Packs → Rarities.
// Each built-in or custom pack can be limited to rarity keys from /rarity.
// Blank (null) keeps today's rates, including spill into a nearby rarity.

import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import type { CustomPack, GuildSettings } from "@workspace/db";
import {
  getCustomPack, getOrCreateGuildSettings, getRarityContext, getRarityDisplayOverrides,
  listCustomPacks, updateCustomPack, updateGuildSettings,
} from "../db.js";
import { getDisplayRarities, type DisplayRarity } from "../rarity-runtime.js";
import { selectMenuEmoji } from "../cards-data.js";
import { PACK_TIER_META, PACK_TIERS, tierLabel, type PackTier } from "./pack.js";
import { normalizeAllowList } from "./pack-rarity.js";

export type PackRarityTarget =
  | { kind: "builtin"; tier: PackTier }
  | { kind: "custom"; id: number };

export function packRarityToken(target: PackRarityTarget): string {
  return target.kind === "builtin" ? target.tier : `c${target.id}`;
}

export function parsePackRarityToken(token: string | null | undefined): PackRarityTarget | null {
  if (!token) return null;
  if (token === "basic" || token === "premium" || token === "legendary") {
    return { kind: "builtin", tier: token };
  }
  const match = /^c(\d+)$/.exec(token);
  if (!match) return null;
  return { kind: "custom", id: Number(match[1]) };
}

function allowFor(settings: GuildSettings, pack: CustomPack | null, target: PackRarityTarget): string[] | null {
  if (target.kind === "custom") return normalizeAllowList(pack?.allowedRarities);
  if (target.tier === "basic") return normalizeAllowList(settings.packBasicRarities);
  if (target.tier === "premium") return normalizeAllowList(settings.packPremiumRarities);
  return normalizeAllowList(settings.packLegendaryRarities);
}

function labelFor(keys: string[] | null, ladder: DisplayRarity[]): string {
  if (!keys) return "default mix";
  const names = keys.map(key => ladder.find(r => r.key === key)?.label ?? key);
  return names.join(", ");
}

export async function savePackRarityAllow(
  guildId: string,
  token: string,
  keys: string[],
): Promise<string | null> {
  const target = parsePackRarityToken(token);
  if (!target) return "Unknown pack.";
  const saved = normalizeAllowList(keys);
  if (!saved) return "Pick at least one rarity.";
  const ladder = await ladderFor(guildId);
  const known = new Set(ladder.map(r => r.key));
  const filtered = saved.filter(key => known.has(key));
  if (filtered.length === 0) return "Those rarities are not on /rarity.";

  if (target.kind === "custom") {
    const pack = await getCustomPack(target.id);
    if (!pack || pack.guildId !== guildId) return "Pack not found.";
    await updateCustomPack(target.id, { allowedRarities: filtered });
    return null;
  }
  const patch: Partial<GuildSettings> = {};
  if (target.tier === "basic") patch.packBasicRarities = filtered;
  if (target.tier === "premium") patch.packPremiumRarities = filtered;
  if (target.tier === "legendary") patch.packLegendaryRarities = filtered;
  await updateGuildSettings(guildId, patch);
  return null;
}

export async function resetPackRarityAllow(guildId: string, token: string): Promise<string | null> {
  const target = parsePackRarityToken(token);
  if (!target) return "Unknown pack.";
  if (target.kind === "custom") {
    const pack = await getCustomPack(target.id);
    if (!pack || pack.guildId !== guildId) return "Pack not found.";
    await updateCustomPack(target.id, { allowedRarities: null });
    return null;
  }
  const patch: Partial<GuildSettings> = {};
  if (target.tier === "basic") patch.packBasicRarities = null;
  if (target.tier === "premium") patch.packPremiumRarities = null;
  if (target.tier === "legendary") patch.packLegendaryRarities = null;
  await updateGuildSettings(guildId, patch);
  return null;
}

async function ladderFor(guildId: string): Promise<DisplayRarity[]> {
  const [ctx, settings, displayMap] = await Promise.all([
    getRarityContext(guildId),
    getOrCreateGuildSettings(guildId),
    getRarityDisplayOverrides(guildId),
  ]);
  return getDisplayRarities(ctx, settings, { displayMap, rarestFirst: false });
}

export async function packRarityPanelPayload(guildId: string, focusToken: string | null) {
  const [settings, packs, ladder] = await Promise.all([
    getOrCreateGuildSettings(guildId),
    listCustomPacks(guildId, true),
    ladderFor(guildId),
  ]);
  const focus = parsePackRarityToken(focusToken);
  const focusPack = focus?.kind === "custom" ? packs.find(p => p.id === focus.id) ?? null : null;
  const current = focus ? allowFor(settings, focusPack, focus) : null;

  const lines = [
    ...PACK_TIERS.map(tier => {
      const target: PackRarityTarget = { kind: "builtin", tier };
      return `${PACK_TIER_META[tier].emoji} **${tierLabel(settings, tier)}** — ${labelFor(allowFor(settings, null, target), ladder)}`;
    }),
    ...packs.slice(0, 8).map(p => `📦 **${p.name}** — ${labelFor(normalizeAllowList(p.allowedRarities), ladder)}`),
  ];

  const embed = new EmbedBuilder()
    .setTitle("✨ Pack rarities")
    .setColor(0xfee75c)
    .setDescription(
      [
        "Pick a pack, then toggle which rarities it may pull. Names come from `/rarity`.",
        "Leave a pack on **default mix** to keep today's odds, including a nearby rarity when a bucket is empty.",
        "A saved lock never spills outside the rarities you checked. Cards still have to be in packs.",
        "",
        lines.join("\n"),
      ].join("\n").slice(0, 4000),
    );
  if (focus) {
    const name = focus.kind === "builtin"
      ? tierLabel(settings, focus.tier)
      : (focusPack?.name ?? "Custom pack");
    embed.addFields({
      name: `Editing ${name}`,
      value: current
        ? `Only: **${labelFor(current, ladder)}**`
        : "Default mix — nothing is locked yet.",
    });
  }

  const targetOptions = [
    ...PACK_TIERS.map(tier => ({
      label: tierLabel(settings, tier).slice(0, 100),
      value: tier,
      emoji: selectMenuEmoji(PACK_TIER_META[tier].emoji, "📦"),
      default: focus?.kind === "builtin" && focus.tier === tier,
    })),
    ...packs.slice(0, 22).map(p => ({
      label: `${p.emoji ? `${p.emoji} ` : ""}${p.name}`.slice(0, 100),
      value: `c${p.id}`,
      default: focus?.kind === "custom" && focus.id === p.id,
    })),
  ];

  const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [
    new ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("packs_rarity_target")
        .setPlaceholder("Which pack to edit")
        .addOptions(targetOptions.slice(0, 25)),
    ),
  ];

  if (focus && (focus.kind === "builtin" || focusPack)) {
    const selected = new Set(current ?? []);
    const options = ladder.slice(0, 25).map(r => ({
      label: `${r.label}`.slice(0, 100),
      value: r.key.slice(0, 100),
      emoji: selectMenuEmoji(r.emoji, "✨"),
      description: r.isCustom ? "Custom rarity" : "Built-in rarity",
      default: selected.has(r.key),
    }));
    const max = Math.max(1, Math.min(options.length, 25));
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`packs_rarity_allow:${packRarityToken(focus)}`)
          .setPlaceholder(current ? "Toggle rarities this pack may pull" : "Check rarities to lock this pack")
          .setMinValues(1)
          .setMaxValues(max)
          .addOptions(options),
      ),
    );
  }

  const buttons = new ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("config:packs:back")
      .setLabel("← Back to Packs")
      .setStyle(ButtonStyle.Secondary),
  );
  if (focus && current) {
    buttons.addComponents(
      new ButtonBuilder()
        .setCustomId(`config:packs:rarities:reset:${packRarityToken(focus)}`)
        .setLabel("Use default mix")
        .setStyle(ButtonStyle.Primary),
    );
  }
  rows.push(buttons);

  return { embeds: [embed], components: rows, content: null };
}
