/**
 * /menu — DN Cards Main Menu
 *
 * A component-driven hub that replaces the need to remember slash commands.
 * Built around Discord Buttons + StringSelectMenus for a mobile-friendly,
 * modern collectible-game feel. All navigation is ephemeral & user-locked.
 *
 * Entry point: /menu
 * Flow:
 *   Main Menu (4 action buttons)
 *     ├─ 🎴 Collection  → rarity filter → card list → card detail + actions
 *     ├─ 🎁 Packs       → tier select → open pack / packstats
 *     ├─ 🔥 Burn        → rarity select → card select → burn confirm
 *     └─ 🤝 Trade       → pending trades / initiate flow
 *
 * Each view renders as an EmbedBuilder + ActionRow components.
 * All interactions are deferred with deferUpdate to prevent "Interaction failed".
 */

import type { ChatInputCommandInteraction, MessageComponentInteraction, ButtonInteraction, StringSelectMenuInteraction } from "discord.js";
import { buttonEmoji } from "../discord-emoji.js";
import { BRAND_NAME } from "../help-banners.js";
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ComponentType,
  MessageFlags,
  type MessageActionRowComponentBuilder,
} from "discord.js";
import {
  getUserCollection,
  getOrCreateCurrency,
  burnCard,
  getCardByName,
  getUserOwnedCount,
  getOrCreateGuildSettings,
  getRarityContext,
  applyRarityContextAll,
  getAllCards,
  effectiveRarityKey,
  getDisplayRarities,
  getRarityDisplayOverrides,
  getCardDisplayRarity,
  getPendingTradesFor,
  getLeaderboard,
} from "../db.js";
import {
  SHINY_EMOJI,
  SHINY_MULTIPLIER,
  getCollectorRank,
  getNextRank,
  type Rarity,
} from "../cards-data.js";
import { PACK_TIER_META, PACK_TIERS, handlePack, handlePackStats, type PackTier, PACK_DEFAULTS, tierLabel } from "./pack.js";
import { checkAchievements, formatUnlockLine } from "../achievements.js";
import { toAbsoluteImageUrl } from "../image-url.js";

// ── Design tokens ─────────────────────────────────────────────────────────────
// Dark military palette. Consistent across all menu embeds.
const BRAND_COLOR   = 0x1a1f2e; // dark navy — main menu
const ACTION_COLOR  = 0x2c3e50; // charcoal — action screens
const SUCCESS_COLOR = 0x27ae60; // green — confirms
const WARN_COLOR    = 0xe67e22; // amber — warnings / burn
const DANGER_COLOR  = 0xc0392b; // red — destructive confirms
const PACK_COLOR    = 0x8e44ad; // purple — packs

// Idle timeout: 3 min. Matches Discord's own component TTL grace period.
const IDLE_MS = 3 * 60 * 1000;

// ── Types ─────────────────────────────────────────────────────────────────────
type MenuState =
  | { screen: "main" }
  | { screen: "collection"; rarityKey?: string; cardId?: number }
  | { screen: "card_detail"; cardId: number; from: "collection" | "burn" | "trade" }
  | { screen: "pack"; step: "choose_tier" | "opening" | "stats"; tier?: PackTier }
  | { screen: "burn"; step: "choose_rarity" | "choose_card" | "confirm"; rarityKey?: string; cardId?: number; cardName?: string }
  | { screen: "trade"; step: "overview" | "choose_partner" }
  | { screen: "profile" };

// ── Helpers ───────────────────────────────────────────────────────────────────
function row(...components: ButtonBuilder[]): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...components);
}

function selectRow(menu: StringSelectMenuBuilder): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu);
}

function btn(label: string, customId: string, style: ButtonStyle, emoji?: string, disabled = false): ButtonBuilder {
  const b = new ButtonBuilder().setLabel(label).setCustomId(customId).setStyle(style).setDisabled(disabled);
  const safe = emoji ? buttonEmoji(emoji) : null;
  if (safe) b.setEmoji(safe);
  return b;
}

function backBtn(to = "main"): ButtonBuilder {
  return btn("Back", `menu:nav:${to}`, ButtonStyle.Secondary, "◀️");
}

function footerText(screen: string): string {
  return `${BRAND_NAME} · ${screen} · Use buttons to navigate`;
}

// ── Main Menu ─────────────────────────────────────────────────────────────────
function buildMainMenu(username: string, shards: number, totalCards: number, pendingTrades: number): {
  embed: EmbedBuilder;
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
} {
  const embed = new EmbedBuilder()
    .setTitle(`🪖 ${BRAND_NAME} — Main Menu`)
    .setColor(BRAND_COLOR)
    .setDescription(
      `Welcome back, **${username}**!\n\n` +
      `💠 **${shards.toLocaleString()}** shards  ·  🃏 **${totalCards}** cards` +
      (pendingTrades > 0 ? `  ·  🔔 **${pendingTrades}** pending trade${pendingTrades !== 1 ? "s" : ""}` : "") +
      "\n\n*Choose an action below to get started.*",
    )
    .setFooter({ text: footerText("Main Menu") });

  const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [
    row(
      btn("Collection", "menu:nav:collection", ButtonStyle.Primary, "🎴"),
      btn("Packs", "menu:nav:pack", ButtonStyle.Primary, "🎁"),
      btn("Burn Cards", "menu:nav:burn", ButtonStyle.Danger, "🔥"),
      btn("Trades", "menu:nav:trade", ButtonStyle.Success, "🤝"),
    ),
    row(
      btn("Profile", "menu:nav:profile", ButtonStyle.Secondary, "👤"),
      btn("Leaderboard", "menu:nav:leaderboard", ButtonStyle.Secondary, "🏆"),
      btn("Daily Reward", "menu:action:daily", ButtonStyle.Secondary, "🎁"),
    ),
  ];

  return { embed, components };
}

// ── Collection screen ─────────────────────────────────────────────────────────
async function buildCollectionScreen(guildId: string, userId: string, username: string): Promise<{
  embed: EmbedBuilder;
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}> {
  const [items, settings, displayMap, ctx] = await Promise.all([
    getUserCollection(guildId, userId),
    getOrCreateGuildSettings(guildId),
    getRarityDisplayOverrides(guildId),
    getRarityContext(guildId),
  ]);

  const ladder = getDisplayRarities(ctx, settings, { displayMap });
  const totalCards = items.reduce((s, i) => s + i.count + i.shinyCount, 0);
  const unique = items.length;
  const totalShinies = items.reduce((s, i) => s + i.shinyCount, 0);
  const netWorth = items.reduce((s, i) => s + i.worthValue * (i.count + i.shinyCount * SHINY_MULTIPLIER), 0);
  const rank = getCollectorRank(unique);
  const nextRank = getNextRank(unique);

  const embed = new EmbedBuilder()
    .setTitle(`🎴 ${username}'s Collection`)
    .setColor(ACTION_COLOR)
    .setDescription(
      `${rank.emoji} **${rank.name}**` +
      (nextRank ? ` → ${nextRank.emoji} ${nextRank.name}  ·  ${unique}/${nextRank.min} unique` : " · *MAX RANK*") +
      `\n\n🃏 **${unique}** unique  ·  **${totalCards}** total` +
      (totalShinies > 0 ? `  ·  ${SHINY_EMOJI} **${totalShinies}** shiny` : "") +
      `\n💠 Net worth: **${netWorth.toLocaleString()}** shards` +
      (items.length === 0 ? "\n\n*You haven't caught any cards yet! Watch the drop channel and type a card's name to catch it.*" : ""),
    )
    .setFooter({ text: footerText("Collection") });

  const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];

  if (items.length > 0) {
    // Group by rarity for the filter dropdown
    const byRarity = new Map<string, number>();
    for (const item of items) {
      const key = effectiveRarityKey(item, ctx);
      byRarity.set(key, (byRarity.get(key) ?? 0) + item.count + item.shinyCount);
    }

    const options = ladder
      .filter(t => byRarity.has(t.key) && (byRarity.get(t.key) ?? 0) > 0)
      .map(t => ({
        label: t.label,
        value: `rarity:${t.key}`,
        description: `${byRarity.get(t.key)} card${(byRarity.get(t.key) ?? 0) !== 1 ? "s" : ""}`,
        emoji: t.emoji,
      }));

    if (totalShinies > 0) {
      options.unshift({ label: "Shinies ✨", value: "rarity:shinies", description: `${totalShinies} shiny copies`, emoji: "✨" });
    }
    if (items.some(i => i.isLimitedEdition)) {
      options.push({ label: "Limited Edition", value: "rarity:limited", description: "Capped-supply exclusives", emoji: "💎" });
    }
    if (items.some(i => i.isEventExclusive)) {
      options.push({ label: "Event Exclusive", value: "rarity:event", description: "Time-limited events", emoji: "🎆" });
    }

    if (options.length > 0) {
      components.push(
        selectRow(
          new StringSelectMenuBuilder()
            .setCustomId("menu:collection:filter")
            .setPlaceholder("Filter by rarity or category…")
            .addOptions(options.slice(0, 25)),
        ),
      );
    }
  }

  components.push(row(backBtn(), btn("Card Fusion", "menu:nav:tradein", ButtonStyle.Secondary, "🔧")));

  return { embed, components };
}

// Build a card list for a given rarity/category within the user's collection
async function buildCardListScreen(
  guildId: string,
  userId: string,
  username: string,
  filterValue: string,
): Promise<{
  embed: EmbedBuilder;
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
  cards: Array<{ id: number; name: string; count: number; shinyCount: number; rarity: string }>;
} | null> {
  const [items, settings, displayMap, ctx] = await Promise.all([
    getUserCollection(guildId, userId),
    getOrCreateGuildSettings(guildId),
    getRarityDisplayOverrides(guildId),
    getRarityContext(guildId),
  ]);

  const ladder = getDisplayRarities(ctx, settings, { displayMap });

  let filtered: typeof items;
  let categoryLabel: string;
  let categoryEmoji: string;
  let categoryColor: number;

  if (filterValue === "rarity:shinies") {
    filtered = items.filter(i => i.shinyCount > 0);
    categoryLabel = "Shinies";
    categoryEmoji = "✨";
    categoryColor = 0xf5c518;
  } else if (filterValue === "rarity:limited") {
    filtered = items.filter(i => i.isLimitedEdition);
    categoryLabel = "Limited Edition";
    categoryEmoji = "💎";
    categoryColor = 0x00d4ff;
  } else if (filterValue === "rarity:event") {
    filtered = items.filter(i => i.isEventExclusive);
    categoryLabel = "Event Exclusive";
    categoryEmoji = "🎆";
    categoryColor = 0xe84393;
  } else {
    const key = filterValue.replace("rarity:", "");
    const tier = ladder.find(t => t.key === key);
    if (!tier) return null;
    filtered = items.filter(i => effectiveRarityKey(i, ctx) === key);
    categoryLabel = tier.label;
    categoryEmoji = tier.emoji;
    categoryColor = tier.color;
  }

  if (filtered.length === 0) return null;

  const sorted = filtered
    .slice()
    .sort((a, b) => b.worthValue - a.worthValue || a.name.localeCompare(b.name))
    .slice(0, 25); // Discord select max 25 options

  const embed = new EmbedBuilder()
    .setTitle(`${categoryEmoji} ${username}'s ${categoryLabel}`)
    .setColor(categoryColor)
    .setDescription(
      `**${filtered.length}** card${filtered.length !== 1 ? "s" : ""} in this category.\n` +
      `*Pick one from the dropdown for details & actions.*`,
    )
    .setFooter({ text: footerText("Collection") });

  const options = sorted.map(i => ({
    label: i.name.slice(0, 100),
    value: `card:${i.cardId}`,
    description: `×${i.count}${i.shinyCount > 0 ? ` · ✨×${i.shinyCount}` : ""} · 💠 ${i.worthValue.toLocaleString()}`,
    emoji: i.isLimitedEdition ? "💎" : i.isEventExclusive ? "🎆" : categoryEmoji,
  }));

  const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [
    selectRow(
      new StringSelectMenuBuilder()
        .setCustomId("menu:collection:card")
        .setPlaceholder("Select a card to view…")
        .addOptions(options),
    ),
    row(backBtn("collection")),
  ];

  return {
    embed, components,
    cards: sorted.map(i => ({
      id: i.cardId, name: i.name,
      count: i.count, shinyCount: i.shinyCount,
      rarity: String(effectiveRarityKey(i, ctx)),
    })),
  };
}

// ── Card detail screen ────────────────────────────────────────────────────────
async function buildCardDetailScreen(
  guildId: string,
  userId: string,
  cardId: number,
  fromScreen: string,
): Promise<{
  embed: EmbedBuilder;
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
} | null> {
  const [collection, rawCards, ctx, settings, displayMap] = await Promise.all([
    getUserCollection(guildId, userId),
    getAllCards(guildId),
    getRarityContext(guildId),
    getOrCreateGuildSettings(guildId),
    getRarityDisplayOverrides(guildId),
  ]);

  const cards = applyRarityContextAll(rawCards, ctx);
  const card = cards.find(c => c.id === cardId);
  const owned = collection.find(i => i.cardId === cardId);

  if (!card || !owned) return null;

  const tier = getCardDisplayRarity(card, ctx, settings, displayMap);
  const imgUrl = toAbsoluteImageUrl(card.imageUrl);
  const shinyBurn = owned.shinyCount * card.burnValue * SHINY_MULTIPLIER;

  // Battle-facing info (Level-1 stats + Star Rank bonus, signature move, special)
  // via the shared preview helper. Best-effort — null if battle isn't configured.
  const { getCardBattlePreview } = await import("../battle/card-preview.js");
  const { starRankString } = await import("../cards/stars.js");
  const preview = await getCardBattlePreview(guildId, userId, card).catch(() => null);

  const embed = new EmbedBuilder()
    .setTitle(`${tier.emoji} ${card.name}`)
    .setColor(tier.color)
    .setDescription(card.description || "*No description.*")
    .addFields(
      { name: "Rarity", value: `${tier.emoji} ${tier.label}`, inline: true },
      { name: "⭐ Star Rank", value: preview ? `${starRankString(preview.starRank)} (${preview.starRank}★)` : "—", inline: true },
      { name: "You own", value: `×**${owned.count}**${owned.shinyCount > 0 ? ` · ${SHINY_EMOJI}×${owned.shinyCount}` : ""}`, inline: true },
      { name: "💠 Worth", value: `${card.worthValue.toLocaleString()} shards`, inline: true },
      { name: "🔥 Burn value", value: `${card.burnValue.toLocaleString()} shards`, inline: true },
    )
    .setFooter({ text: footerText("Card Detail") });

  if (preview) {
    const st = preview.stats;
    embed.addFields(
      {
        name: "⚔️ Battle Stats (Lv 1)",
        value:
          `❤️ HP **${st.hp.toLocaleString()}** · ⚔️ ATK **${st.atk.toLocaleString()}** · 🛡️ DEF **${st.def.toLocaleString()}**\n` +
          `💨 SPD **${st.spd.toLocaleString()}** · 🎯 Crit **${st.crit}%** · 🏹 Acc **${st.acc}%**` +
          (preview.starRank > 0 ? `\n_Includes +${preview.starRank * 8}% Star Rank bonus._` : ""),
        inline: false,
      },
      {
        name: "🎯 Abilities",
        value:
          `${preview.move ? `${preview.move.emoji} **${preview.move.name}** — ${preview.move.description}` : "Primary attack"}\n` +
          `${preview.special ? `✨ **${preview.special.name}** — ${preview.special.description}` : "No special"}`,
        inline: false,
      },
    );
  }

  if (imgUrl) embed.setThumbnail(imgUrl);

  const canBurn = owned.count > 0;
  const canBurnShiny = owned.shinyCount > 0;

  const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [
    row(
      btn("Burn 1", `menu:burn:quick:${cardId}:1`, ButtonStyle.Danger, "🔥", !canBurn),
      ...(canBurnShiny
        ? [btn(`Burn ✨ (+${shinyBurn.toLocaleString()})`, `menu:burn:quick:${cardId}:shiny`, ButtonStyle.Danger, SHINY_EMOJI)]
        : []),
      btn("Add to Wishlist", `menu:wishlist:add:${cardId}`, ButtonStyle.Secondary, "⭐"),
    ),
    row(backBtn(fromScreen)),
  ];

  return { embed, components };
}

// ── Pack screen ───────────────────────────────────────────────────────────────
async function buildPackScreen(guildId: string, userId: string): Promise<{
  embed: EmbedBuilder;
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}> {
  const [settings, currency] = await Promise.all([
    getOrCreateGuildSettings(guildId),
    getOrCreateCurrency(guildId, userId),
  ]);

  const tierLines = PACK_TIERS.map(tier => {
    const meta = PACK_TIER_META[tier];
    const cost = tier === "basic" ? settings.packBasicCost :
                 tier === "premium" ? settings.packPremiumCost :
                 settings.packLegendaryCost;
    const canAfford = currency.shards >= cost;
    return `${meta.emoji} **${tierLabel(settings, tier)}** — 💠 ${cost.toLocaleString()}${canAfford ? "" : " *(need more shards)*"}`;
  });

  const embed = new EmbedBuilder()
    .setTitle("🎁 Pack Store")
    .setColor(PACK_COLOR)
    .setDescription(
      `💠 Your balance: **${currency.shards.toLocaleString()} shards**\n\n` +
      tierLines.join("\n") +
      "\n\n*Pick a tier below to open a pack.*",
    )
    .addFields(
      { name: `🥉 ${tierLabel(settings, "basic")}`, value: "Common–Rare cards. Best value per shard.", inline: true },
      { name: `🥈 ${tierLabel(settings, "premium")}`, value: "2× Rare+. No real dogs in here.", inline: true },
      { name: `🥇 ${tierLabel(settings, "legendary")}`, value: "No commons. Stacked with guaranteed hits.", inline: true },
    )
    .setFooter({ text: footerText("Packs") });

  const basicCost = settings.packBasicCost;
  const premiumCost = settings.packPremiumCost;
  const legendCost = settings.packLegendaryCost;

  const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [
    row(
      btn(`🥉 ${tierLabel(settings, "basic")} (${basicCost.toLocaleString()})`, "menu:pack:open:basic", ButtonStyle.Secondary, undefined, currency.shards < basicCost),
      btn(`🥈 ${tierLabel(settings, "premium")} (${premiumCost.toLocaleString()})`, "menu:pack:open:premium", ButtonStyle.Primary, undefined, currency.shards < premiumCost),
      btn(`🥇 ${tierLabel(settings, "legendary")} (${legendCost.toLocaleString()})`, "menu:pack:open:legendary", ButtonStyle.Success, undefined, currency.shards < legendCost),
    ),
    row(
      btn("My Pack Stats", "menu:pack:stats", ButtonStyle.Secondary, "📊"),
      backBtn(),
    ),
  ];

  return { embed, components };
}

// ── Burn screen ───────────────────────────────────────────────────────────────
async function buildBurnRarityScreen(guildId: string, userId: string, username: string): Promise<{
  embed: EmbedBuilder;
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}> {
  const [items, settings, displayMap, ctx] = await Promise.all([
    getUserCollection(guildId, userId),
    getOrCreateGuildSettings(guildId),
    getRarityDisplayOverrides(guildId),
    getRarityContext(guildId),
  ]);

  const ladder = getDisplayRarities(ctx, settings, { displayMap });

  // Only show rarities where the user has duplicates (count > 1) or any cards
  const burnableByRarity = new Map<string, { total: number; dupes: number; shards: number }>();
  for (const item of items) {
    const key = effectiveRarityKey(item, ctx);
    const prev = burnableByRarity.get(key) ?? { total: 0, dupes: 0, shards: 0 };
    burnableByRarity.set(key, {
      total: prev.total + item.count,
      dupes: prev.dupes + Math.max(0, item.count - 1),
      shards: prev.shards + item.count * item.burnValue,
    });
  }

  const options = ladder
    .filter(t => (burnableByRarity.get(t.key)?.total ?? 0) > 0)
    .map(t => {
      const data = burnableByRarity.get(t.key)!;
      return {
        label: t.label,
        value: t.key,
        description: `${data.total} cards · ~${data.shards.toLocaleString()} shards if all burned`,
        emoji: t.emoji,
      };
    });

  const totalPotential = [...burnableByRarity.values()].reduce((s, v) => s + v.shards, 0);

  const embed = new EmbedBuilder()
    .setTitle("🔥 Burn Cards")
    .setColor(WARN_COLOR)
    .setDescription(
      `Burn duplicates into 💠 shards. Shinies burn at **${SHINY_MULTIPLIER}×** value.\n\n` +
      (options.length > 0
        ? `Potential from burning all: **~${totalPotential.toLocaleString()} shards**\n\n*Select a rarity to see your cards.*`
        : `*${username} has no cards to burn yet.*`),
    )
    .setFooter({ text: footerText("Burn") });

  const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];

  if (options.length > 0) {
    components.push(
      selectRow(
        new StringSelectMenuBuilder()
          .setCustomId("menu:burn:rarity")
          .setPlaceholder("Choose a rarity…")
          .addOptions(options.slice(0, 25)),
      ),
    );
  }
  components.push(row(backBtn()));

  return { embed, components };
}

async function buildBurnCardScreen(
  guildId: string,
  userId: string,
  username: string,
  rarityKey: string,
): Promise<{
  embed: EmbedBuilder;
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
} | null> {
  const [items, settings, displayMap, ctx] = await Promise.all([
    getUserCollection(guildId, userId),
    getOrCreateGuildSettings(guildId),
    getRarityDisplayOverrides(guildId),
    getRarityContext(guildId),
  ]);

  const ladder = getDisplayRarities(ctx, settings, { displayMap });
  const tier = ladder.find(t => t.key === rarityKey);
  if (!tier) return null;

  const inRarity = items
    .filter(i => effectiveRarityKey(i, ctx) === rarityKey && i.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 25);

  if (inRarity.length === 0) return null;

  const embed = new EmbedBuilder()
    .setTitle(`🔥 Burn — ${tier.emoji} ${tier.label}`)
    .setColor(WARN_COLOR)
    .setDescription(`Select a card to burn for 💠 shards.\n*Tip: ×1 = exact copy, burn value shown per card.*`)
    .setFooter({ text: footerText("Burn") });

  const options = inRarity.map(i => ({
    label: i.name.slice(0, 100),
    value: `${i.cardId}`,
    description: `×${i.count} owned · 🔥 ${i.burnValue.toLocaleString()} shards each${i.shinyCount > 0 ? ` · ✨×${i.shinyCount}` : ""}`,
    emoji: tier.emoji,
  }));

  const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [
    selectRow(
      new StringSelectMenuBuilder()
        .setCustomId("menu:burn:card")
        .setPlaceholder("Select a card to burn…")
        .addOptions(options),
    ),
    row(backBtn("burn")),
  ];

  return { embed, components };
}

async function buildBurnConfirmScreen(
  guildId: string,
  userId: string,
  cardId: number,
): Promise<{
  embed: EmbedBuilder;
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
} | null> {
  const [rawCards, ctx, settings, displayMap] = await Promise.all([
    getAllCards(guildId),
    getRarityContext(guildId),
    getOrCreateGuildSettings(guildId),
    getRarityDisplayOverrides(guildId),
  ]);

  const cards = applyRarityContextAll(rawCards, ctx);
  const card = cards.find(c => c.id === cardId);
  if (!card) return null;

  const { count, shinyCount } = await getUserOwnedCount(guildId, userId, card.id);
  const tier = getCardDisplayRarity(card, ctx, settings, displayMap);

  if (count < 1 && shinyCount < 1) return null;

  const embed = new EmbedBuilder()
    .setTitle(`🔥 Confirm Burn`)
    .setColor(DANGER_COLOR)
    .setDescription(
      `**${tier.emoji} ${card.name}**\n` +
      `You own: ×**${count}** normal${shinyCount > 0 ? ` · ${SHINY_EMOJI}×${shinyCount} shiny` : ""}\n\n` +
      `Burn 1 normal copy → 💠 **${card.burnValue.toLocaleString()} shards**` +
      (shinyCount > 0 ? `\nBurn 1 shiny copy → 💠 **${(card.burnValue * SHINY_MULTIPLIER).toLocaleString()} shards** (${SHINY_MULTIPLIER}×)` : "") +
      "\n\n⚠️ *This cannot be undone.*",
    )
    .setFooter({ text: footerText("Burn Confirm") });

  const imgUrl = toAbsoluteImageUrl(card.imageUrl);
  if (imgUrl) embed.setThumbnail(imgUrl);

  const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [
    row(
      ...(count > 0 ? [btn("🔥 Burn 1 Normal", `menu:burn:exec:${cardId}:normal`, ButtonStyle.Danger)] : []),
      ...(shinyCount > 0 ? [btn(`🔥 Burn 1 Shiny (${SHINY_MULTIPLIER}×)`, `menu:burn:exec:${cardId}:shiny`, ButtonStyle.Danger)] : []),
    ),
    row(backBtn("burn")),
  ];

  return { embed, components };
}

// ── Trade overview screen ─────────────────────────────────────────────────────
async function buildTradeScreen(guildId: string, userId: string): Promise<{
  embed: EmbedBuilder;
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}> {
  const pending = await getPendingTradesFor(guildId, userId);

  const inbound = pending.filter(t => t.targetId === userId);
  const outbound = pending.filter(t => t.initiatorId === userId);

  const embed = new EmbedBuilder()
    .setTitle("🤝 Trade Hub")
    .setColor(SUCCESS_COLOR)
    .setDescription(
      `**Pending inbound:** ${inbound.length}  ·  **Pending outbound:** ${outbound.length}\n\n` +
      (inbound.length > 0
        ? inbound.slice(0, 5).map(t =>
            `📥 **Trade #${t.id}** — use \`/trade accept id:${t.id}\` or \`/trade decline id:${t.id}\``
          ).join("\n") + "\n\n"
        : "*No inbound trade offers.*\n\n") +
      `*To propose a trade, use:*\n\`/trade propose user:@Member offer:<card> want:<card>\`\n\n` +
      `*Tip: Trades work best in the trade channel — ask an admin to set one up.*`,
    )
    .setFooter({ text: footerText("Trades") });

  const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [
    row(
      btn("View All Pending", "menu:action:trades", ButtonStyle.Primary, "📋"),
      btn("Trade History", "menu:action:tradehistory", ButtonStyle.Secondary, "📜"),
    ),
    row(backBtn()),
  ];

  return { embed, components };
}

// ── Profile screen ────────────────────────────────────────────────────────────
async function buildProfileScreen(guildId: string, userId: string, username: string, avatarUrl: string): Promise<{
  embed: EmbedBuilder;
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}> {
  const [collection, currency, leaderboard] = await Promise.all([
    getUserCollection(guildId, userId),
    getOrCreateCurrency(guildId, userId),
    getLeaderboard(guildId, "worth", 100),
  ]);

  const unique = collection.length;
  const total = collection.reduce((s, i) => s + i.count + i.shinyCount, 0);
  const shinies = collection.reduce((s, i) => s + i.shinyCount, 0);
  const netWorth = collection.reduce((s, i) => s + i.worthValue * (i.count + i.shinyCount * SHINY_MULTIPLIER), 0);
  const rank = getCollectorRank(unique);
  const nextRank = getNextRank(unique);
  const lbPos = leaderboard.findIndex(r => r.userId === userId);

  const embed = new EmbedBuilder()
    .setTitle(`👤 ${username}'s Profile`)
    .setColor(ACTION_COLOR)
    .setThumbnail(avatarUrl)
    .addFields(
      { name: "🎖️ Rank", value: `${rank.emoji} **${rank.name}**`, inline: true },
      { name: "🃏 Cards", value: `${unique} unique · ${total} total`, inline: true },
      { name: "💠 Net Worth", value: `${netWorth.toLocaleString()} shards`, inline: true },
      { name: "💰 Shards", value: currency.shards.toLocaleString(), inline: true },
      { name: "✨ Shinies", value: shinies.toString(), inline: true },
      { name: "🏅 Leaderboard", value: lbPos >= 0 ? `#${lbPos + 1} of ${leaderboard.length}` : "Unranked", inline: true },
    )
    .setDescription(
      nextRank
        ? `Progress to ${nextRank.emoji} **${nextRank.name}**: ${unique}/${nextRank.min} unique (${nextRank.min - unique} to go)`
        : `${rank.emoji} **MAX RANK** — you've reached the top!`,
    )
    .setFooter({ text: footerText("Profile") });

  const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [
    row(
      btn("Achievements", "menu:action:achievements", ButtonStyle.Secondary, "🏆"),
      btn("Wishlist", "menu:action:wishlist", ButtonStyle.Secondary, "⭐"),
      btn("Catalog", "menu:action:catalog", ButtonStyle.Secondary, "📖"),
    ),
    row(backBtn()),
  ];

  return { embed, components };
}

// ── Leaderboard screen ────────────────────────────────────────────────────────
async function buildLeaderboardScreen(guildId: string): Promise<{
  embed: EmbedBuilder;
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}> {
  const top = await getLeaderboard(guildId, "worth", 10);
  const medals = ["🥇", "🥈", "🥉"];
  const lines = top.map((r, i) => {
    const rank = getCollectorRank(r.uniqueCards);
    return `${medals[i] ?? `**${i + 1}.**`} ${rank.emoji} <@${r.userId}> — 💠 **${r.netWorth.toLocaleString()}** · ${r.uniqueCards} unique`;
  });

  const embed = new EmbedBuilder()
    .setTitle("🏆 Top Collectors")
    .setColor(0xf39c12)
    .setDescription(lines.length > 0 ? lines.join("\n") : "*No collectors yet — start catching cards!*")
    .setFooter({ text: footerText("Leaderboard") });

  return {
    embed,
    components: [row(backBtn())],
  };
}

// ── Main handler ─────────────────────────────────────────────────────────────
export async function handleMenuCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const username = interaction.user.username;
  const avatarUrl = interaction.user.displayAvatarURL();

  const [currency, collection, pendingTrades] = await Promise.all([
    getOrCreateCurrency(guildId, userId),
    getUserCollection(guildId, userId),
    getPendingTradesFor(guildId, userId),
  ]);

  const totalCards = collection.reduce((s, i) => s + i.count + i.shinyCount, 0);
  const { embed, components } = buildMainMenu(username, currency.shards, totalCards, pendingTrades.length);

  const reply = await interaction.editReply({ embeds: [embed], components });

  // ── Component collector ───────────────────────────────────────────────────
  // All navigation goes through a single collector that intercepts all
  // button/select interactions on this ephemeral message.
  const collector = reply.createMessageComponentCollector({
    idle: IDLE_MS,
    filter: (i: MessageComponentInteraction) => i.user.id === userId,
  });

  // State tracker: current rarity key for burn/collection drill-downs
  let currentBurnRarityKey = "";
  let currentCollectionFilter = "";

  const refresh = async (i: MessageComponentInteraction, newEmbed: EmbedBuilder, newComponents: ActionRowBuilder<MessageActionRowComponentBuilder>[]) => {
    await i.update({ embeds: [newEmbed], components: newComponents });
  };

  const showMain = async (i: MessageComponentInteraction) => {
    const [cur, col, pending] = await Promise.all([
      getOrCreateCurrency(guildId, userId),
      getUserCollection(guildId, userId),
      getPendingTradesFor(guildId, userId),
    ]);
    const tc = col.reduce((s, c) => s + c.count + c.shinyCount, 0);
    const { embed: e, components: c } = buildMainMenu(username, cur.shards, tc, pending.length);
    await refresh(i, e, c);
  };

  collector.on("collect", async (i: MessageComponentInteraction) => {
    try {
      // ── Button interactions ────────────────────────────────────────────
      if (i.isButton()) {
        const [, ns, action, ...rest] = i.customId.split(":");

        // Navigation
        if (ns === "nav") {
          if (action === "main" || !action) {
            await showMain(i);
          } else if (action === "collection") {
            const { embed: e, components: c } = await buildCollectionScreen(guildId, userId, username);
            await refresh(i, e, c);
          } else if (action === "pack") {
            const { embed: e, components: c } = await buildPackScreen(guildId, userId);
            await refresh(i, e, c);
          } else if (action === "burn") {
            const { embed: e, components: c } = await buildBurnRarityScreen(guildId, userId, username);
            await refresh(i, e, c);
          } else if (action === "trade") {
            const { embed: e, components: c } = await buildTradeScreen(guildId, userId);
            await refresh(i, e, c);
          } else if (action === "profile") {
            const { embed: e, components: c } = await buildProfileScreen(guildId, userId, username, avatarUrl);
            await refresh(i, e, c);
          } else if (action === "leaderboard") {
            const { embed: e, components: c } = await buildLeaderboardScreen(guildId);
            await refresh(i, e, c);
          } else if (action === "tradein") {
            // Deep-link: tell user to use /tradein (can't replicate fully without deferring a new interaction)
            await i.update({
              embeds: [
                new EmbedBuilder()
                  .setTitle("🔧 Card Fusion")
                  .setColor(ACTION_COLOR)
                  .setDescription("**Fuse** duplicate copies + **Scrap** to raise a card's **Star Rank** (★) and boost its battle stats. **Recycle** spare duplicates into Scrap to fund fusions.\n\nUse `/card_recycle` to open the Fusion hub — leave the name blank to browse your duplicates, or pass a card name to jump straight to it.")
                  .setFooter({ text: footerText("Card Fusion") }),
              ],
              components: [row(backBtn("collection"))],
            });
          }
          return;
        }

        // Actions that invoke existing handlers
        if (ns === "action") {
          await i.deferUpdate();
          if (action === "daily") {
            // Import daily handler and call it — but we need a ChatInputCommandInteraction.
            // Instead, show a tip message.
            await i.editReply({
              embeds: [
                new EmbedBuilder()
                  .setTitle("🎁 Daily Reward")
                  .setColor(0xf1c40f)
                  .setDescription("Use `/daily` to claim your daily 💠 shards!\n\nYour streak grows every day you claim, up to **+200 bonus shards/day**.")
                  .setFooter({ text: footerText("Daily") }),
              ],
              components: [row(backBtn())],
            });
          } else if (action === "trades") {
            // Show pending trades detail
            const pending2 = await getPendingTradesFor(guildId, userId);
            const lines = pending2.map(t =>
              `**#${t.id}** — ${t.initiatorId === userId ? "📤 Outbound" : "📥 Inbound"} · Use \`/${t.initiatorId === userId ? "decline" : "accept"} id:${t.id}\``
            );
            await i.editReply({
              embeds: [
                new EmbedBuilder()
                  .setTitle("📋 All Pending Trades")
                  .setColor(SUCCESS_COLOR)
                  .setDescription(lines.length > 0 ? lines.join("\n") : "*No pending trades.*")
                  .setFooter({ text: footerText("Trades") }),
              ],
              components: [row(backBtn("trade"))],
            });
          } else if (action === "tradehistory") {
            await i.editReply({
              embeds: [new EmbedBuilder().setTitle("📜 Trade History").setColor(ACTION_COLOR).setDescription("Use `/trade history` to see your recent completed trades with full details.").setFooter({ text: footerText("Trade History") })],
              components: [row(backBtn("trade"))],
            });
          } else if (action === "achievements") {
            await i.editReply({
              embeds: [new EmbedBuilder().setTitle("🏆 Achievements").setColor(0xe67e22).setDescription("Use `/achievements` to see your full achievement panel with progress details.").setFooter({ text: footerText("Achievements") })],
              components: [row(backBtn("profile"))],
            });
          } else if (action === "wishlist") {
            await i.editReply({
              embeds: [new EmbedBuilder().setTitle("⭐ Wishlist").setColor(0xf5c518).setDescription("Use `/wishlist list` to see your wishlist, or `/wishlist add name:<card>` to add a card.\n\nYou'll get pinged in the drop channel when a wishlisted card spawns!").setFooter({ text: footerText("Wishlist") })],
              components: [row(backBtn("profile"))],
            });
          } else if (action === "catalog") {
            await i.editReply({
              embeds: [new EmbedBuilder().setTitle("📖 Card Catalog").setColor(ACTION_COLOR).setDescription("Use `/catalog` to browse the full roster and see which cards you own vs. which you're missing.\n\nAdd `category:<rarity>` to jump straight to a tier.").setFooter({ text: footerText("Catalog") })],
              components: [row(backBtn("profile"))],
            });
          }
          return;
        }

        // Pack opens
        if (ns === "pack") {
          if (action === "open") {
            const tier = rest[0] as PackTier;
            await i.deferUpdate();
            const settings2 = await getOrCreateGuildSettings(guildId);
            const cost = tier === "basic" ? settings2.packBasicCost : tier === "premium" ? settings2.packPremiumCost : settings2.packLegendaryCost;
            const cur2 = await getOrCreateCurrency(guildId, userId);
            if (cur2.shards < cost) {
              await i.editReply({
                embeds: [
                  new EmbedBuilder()
                    .setTitle("❌ Not enough shards")
                    .setColor(DANGER_COLOR)
                    .setDescription(`You need 💠 **${cost.toLocaleString()}** shards but only have **${cur2.shards.toLocaleString()}**.\n\nEarn more by:\n• Burning duplicate cards with 🔥 Burn\n• Claiming your \`/daily\` reward\n• Opening a cheaper tier`)
                    .setFooter({ text: footerText("Packs") }),
                ],
                components: [row(backBtn("pack"))],
              });
              return;
            }
            // Tell user to use /pack since we can't call handlePack from a button
            // (handlePack requires ChatInputCommandInteraction with specific option structure)
            // Instead, show an informational confirm
            await i.editReply({
              embeds: [
                new EmbedBuilder()
                  .setTitle(`🎁 Open ${PACK_TIER_META[tier].emoji} ${tierLabel(settings2, tier)} Pack?`)
                  .setColor(PACK_COLOR)
                  .setDescription(
                    `Cost: 💠 **${cost.toLocaleString()}** shards\nBalance after: 💠 **${(cur2.shards - cost).toLocaleString()}**\n\n` +
                    `*Use \`/pack tier:${tier}\` to open this pack and see your cards!*\n\n` +
                    `*(Pack opening is being moved fully into this menu — for now, the slash command gives you the full reveal animation.)*`,
                  )
                  .setFooter({ text: footerText("Packs") }),
              ],
              components: [
                row(
                  btn(`✅ Open with /pack tier:${tier}`, "menu:nav:main", ButtonStyle.Success),
                  backBtn("pack"),
                ),
              ],
            });
          } else if (action === "stats") {
            await i.deferUpdate();
            // Show pack stats inline
            const settings3 = await getOrCreateGuildSettings(guildId);
            const cur3 = await getOrCreateCurrency(guildId, userId);
            const tierLine = (tier: PackTier) => {
              const meta = PACK_TIER_META[tier];
              const cost = tier === "basic" ? settings3.packBasicCost : tier === "premium" ? settings3.packPremiumCost : settings3.packLegendaryCost;
              const used = tier === "basic" ? cur3.packsBasicWeek : tier === "premium" ? cur3.packsPremiumWeek : cur3.packsLegendaryWeek;
              const cap = tier === "basic" ? settings3.packBasicWeeklyLimit : tier === "premium" ? settings3.packPremiumWeeklyLimit : settings3.packLegendaryWeeklyLimit;
              const capLabel = cap === 0 ? "∞" : cap.toString();
              return `${meta.emoji} **${tierLabel(settings3, tier)}** — 💠 ${cost.toLocaleString()} · **${used}/${capLabel}** this week`;
            };
            const coolMs = settings3.packCooldownSeconds * 1000;
            const sinceMs = cur3.lastPackOpenedAt ? Date.now() - cur3.lastPackOpenedAt.getTime() : Infinity;
            const cdRemain = coolMs > 0 ? Math.max(0, coolMs - sinceMs) : 0;
            const cdLabel = coolMs === 0 ? "No cooldown"
              : cdRemain > 0 ? `Ready in ${Math.ceil(cdRemain / 60000)}m`
              : "Ready!";
            await i.editReply({
              embeds: [
                new EmbedBuilder()
                  .setTitle("📊 Your Pack Stats")
                  .setColor(PACK_COLOR)
                  .setDescription(
                    `💠 Balance: **${cur3.shards.toLocaleString()}**\n` +
                    `🎴 Lifetime packs: **${cur3.packsOpened.toLocaleString()}**\n\n` +
                    PACK_TIERS.map(tierLine).join("\n") +
                    `\n\n⏱️ Cooldown: **${cdLabel}**`,
                  )
                  .setFooter({ text: footerText("Pack Stats") }),
              ],
              components: [row(backBtn("pack"))],
            });
          }
          return;
        }

        // Burn: quick burn from card detail
        if (ns === "burn" && action === "quick") {
          const cardId = parseInt(rest[0] ?? "0");
          const type = rest[1]; // "1" | "shiny"
          await i.deferUpdate();

          const rawCards = await getAllCards(guildId);
          const ctx2 = await getRarityContext(guildId);
          const cards2 = applyRarityContextAll(rawCards, ctx2);
          const card2 = cards2.find(c => c.id === cardId);
          if (!card2) { await i.followUp({ content: "❌ Card not found.", flags: MessageFlags.Ephemeral }); return; }

          const isShiny = type === "shiny";
          const result = await burnCard(guildId, userId, cardId, 1, { shiny: isShiny });
          if (!result.success) {
            await i.editReply({
              embeds: [new EmbedBuilder().setTitle("❌ Burn failed").setColor(DANGER_COLOR).setDescription("Your collection may have changed. Try again.")],
              components: [row(backBtn("collection"))],
            });
            return;
          }

          const shardVal = card2.burnValue * (isShiny ? SHINY_MULTIPLIER : 1);
          const cur4 = await getOrCreateCurrency(guildId, userId);
          await i.editReply({
            embeds: [
              new EmbedBuilder()
                .setTitle("🔥 Burned!")
                .setColor(SUCCESS_COLOR)
                .setDescription(
                  `Burned **${isShiny ? `${SHINY_EMOJI} ` : ""}${card2.name}** for 💠 **+${shardVal.toLocaleString()} shards**\n` +
                  `New balance: 💠 **${cur4.shards.toLocaleString()}**`,
                )
                .setFooter({ text: footerText("Burn") }),
            ],
            components: [row(backBtn("collection"), btn("Burn More", "menu:nav:burn", ButtonStyle.Danger, "🔥"))],
          });

          const newly = await checkAchievements(guildId, userId);
          if (newly.length > 0) {
            await i.followUp({ content: "🏆 **Achievement unlocked!**\n" + newly.map(formatUnlockLine).join("\n"), flags: MessageFlags.Ephemeral }).catch(() => {});
          }
          return;
        }

        // Burn: execute from confirm screen
        if (ns === "burn" && action === "exec") {
          const cardId = parseInt(rest[0] ?? "0");
          const type = rest[1]; // "normal" | "shiny"
          await i.deferUpdate();

          const isShiny = type === "shiny";
          const rawCards2 = await getAllCards(guildId);
          const ctx3 = await getRarityContext(guildId);
          const cards3 = applyRarityContextAll(rawCards2, ctx3);
          const card3 = cards3.find(c => c.id === cardId);
          if (!card3) { return; }

          const result2 = await burnCard(guildId, userId, cardId, 1, { shiny: isShiny });
          if (!result2.success) {
            await i.editReply({
              embeds: [new EmbedBuilder().setTitle("❌ Burn failed").setColor(DANGER_COLOR).setDescription("Your collection changed mid-burn. No shards were lost.")],
              components: [row(backBtn("burn"))],
            });
            return;
          }

          const shardVal2 = card3.burnValue * (isShiny ? SHINY_MULTIPLIER : 1);
          const cur5 = await getOrCreateCurrency(guildId, userId);
          await i.editReply({
            embeds: [
              new EmbedBuilder()
                .setTitle("🔥 Burned!")
                .setColor(SUCCESS_COLOR)
                .setDescription(
                  `Burned **${isShiny ? `${SHINY_EMOJI} ` : ""}${card3.name}** → 💠 **+${shardVal2.toLocaleString()} shards**\n` +
                  `New balance: 💠 **${cur5.shards.toLocaleString()}**`,
                )
                .setFooter({ text: footerText("Burn") }),
            ],
            components: [row(btn("Burn More", "menu:nav:burn", ButtonStyle.Danger, "🔥"), backBtn())],
          });

          const newly2 = await checkAchievements(guildId, userId);
          if (newly2.length > 0) {
            await i.followUp({ content: "🏆 **Achievement unlocked!**\n" + newly2.map(formatUnlockLine).join("\n"), flags: MessageFlags.Ephemeral }).catch(() => {});
          }
          return;
        }

        // Wishlist add from card detail
        if (ns === "wishlist" && action === "add") {
          const cardId = parseInt(rest[0] ?? "0");
          await i.deferUpdate();
          const { addWishlist } = await import("../db.js");
          const added = await addWishlist(guildId, userId, cardId);
          const rawCards3 = await getAllCards(guildId);
          const ctx4 = await getRarityContext(guildId);
          const cards4 = applyRarityContextAll(rawCards3, ctx4);
          const card4 = cards4.find(c => c.id === cardId);
          await i.editReply({
            embeds: [
              new EmbedBuilder()
                .setTitle(added ? "⭐ Added to Wishlist" : "Already Wishlisted")
                .setColor(0xf5c518)
                .setDescription(
                  added
                    ? `**${card4?.name ?? "Card"}** added! You'll be pinged when it spawns.`
                    : `**${card4?.name ?? "Card"}** is already on your wishlist.`,
                )
                .setFooter({ text: footerText("Wishlist") }),
            ],
            components: [row(backBtn("collection"))],
          });
          return;
        }
      }

      // ── Select menu interactions ────────────────────────────────────────
      if (i.isStringSelectMenu()) {
        const [, ns2, action2] = i.customId.split(":");
        const value = i.values[0]!;

        if (ns2 === "collection") {
          if (action2 === "filter") {
            currentCollectionFilter = value;
            const result = await buildCardListScreen(guildId, userId, username, value);
            if (!result) {
              await i.update({
                embeds: [new EmbedBuilder().setTitle("No cards").setColor(ACTION_COLOR).setDescription("No cards in that category.")],
                components: [row(backBtn("collection"))],
              });
              return;
            }
            await i.update({ embeds: [result.embed], components: result.components });
          } else if (action2 === "card") {
            const cardId = parseInt(value.replace("card:", ""));
            const result = await buildCardDetailScreen(guildId, userId, cardId, "collection");
            if (!result) {
              await i.update({
                embeds: [new EmbedBuilder().setTitle("Not found").setColor(DANGER_COLOR).setDescription("Card not found in your collection.")],
                components: [row(backBtn("collection"))],
              });
              return;
            }
            await i.update({ embeds: [result.embed], components: result.components });
          }
        }

        if (ns2 === "burn") {
          if (action2 === "rarity") {
            currentBurnRarityKey = value;
            const result = await buildBurnCardScreen(guildId, userId, username, value);
            if (!result) {
              await i.update({
                embeds: [new EmbedBuilder().setTitle("No cards").setColor(WARN_COLOR).setDescription("No cards in that rarity to burn.")],
                components: [row(backBtn("burn"))],
              });
              return;
            }
            await i.update({ embeds: [result.embed], components: result.components });
          } else if (action2 === "card") {
            const cardId = parseInt(value);
            const result = await buildBurnConfirmScreen(guildId, userId, cardId);
            if (!result) {
              await i.update({
                embeds: [new EmbedBuilder().setTitle("Not found").setColor(DANGER_COLOR).setDescription("Card not found.")],
                components: [row(backBtn("burn"))],
              });
              return;
            }
            await i.update({ embeds: [result.embed], components: result.components });
          }
        }
      }
    } catch (err) {
      console.error("[menu] interaction error", err);
      try {
        if (!i.replied && !i.deferred) {
          await i.reply({ content: "❌ Something went wrong. Try again.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }
      } catch { /* ignore */ }
    }
  });

  collector.on("end", async () => {
    try {
      const timeoutEmbed = new EmbedBuilder()
        .setTitle(`🪖 ${BRAND_NAME} Menu`)
        .setColor(0x36393f)
        .setDescription("*Menu closed — run `/menu` again to reopen.*")
        .setFooter({ text: `Session ended · ${BRAND_NAME}` });
      await interaction.editReply({ embeds: [timeoutEmbed], components: [] });
    } catch { /* ignore */ }
  });
}
