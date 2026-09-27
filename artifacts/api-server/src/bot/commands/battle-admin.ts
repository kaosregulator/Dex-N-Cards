// /battle_admin — the graphical Admin Battle Hub + first-time Setup Wizard.
//
// One ephemeral, button-driven control panel where an admin configures the whole
// per-guild battle system: enable/disable, channels, combat rules & formulas,
// card eligibility + per-card edits, rewards, and management (leaderboard/season
// resets, global-leaderboard opt-in). Everything is saved to battle_settings
// (per guild). The Setup Wizard is a one-click "sensible defaults + mark ready"
// path so a fresh server can start battling immediately.

import {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType,
  ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
  type ChatInputCommandInteraction, type ButtonInteraction,
  type StringSelectMenuInteraction, type ChannelSelectMenuInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import {
  isAdmin, getAllCards, getCardByName, getCardById,
  getOrCreateGuildSettings, getRarityDisplayOverrides, getRarityContext,
  getBattleBackgrounds, setBattleBackground, clearBattleBackground, clearAllBattleBackgrounds,
} from "../db.js";
import { effectiveRarityKey, rarityLadderRank } from "../rarity-runtime.js";
import { persistBotImage } from "./edit-card.js";
import { getBattleSettings, updateBattleSettings, RARITY_ORDER } from "../battle/config-engine.js";
import { resetSeason } from "../battle/season-engine.js";
import { upsertBattleCardConfig, getBattleCardConfig, resetBattleCardConfig } from "../battle/db.js";
import { upsertBattleContent, deleteBattleContent, listBattleContent } from "../battle/db.js";
import {
  loadGuildBattleItems, invalidateGuildBattleItems, listAllBattleItems, getBattleItem,
  coerceBattleItem, listDefaultBattleItems,
  type BattleItem, type ItemEffectType, type ItemTarget,
} from "../battle/items.js";
import type { StatusKind } from "../battle/types.js";
import { getScaledStats } from "../battle/stat-engine.js";
import { db, battleProfilesTable, type Card } from "@workspace/db";
import { eq } from "drizzle-orm";
import { SPECIAL_EFFECT_KEYS, getEffectDef, inferSpecialEffect } from "../battle/special-cards.js";
import { getMoveset, inferMoveset, MOVESETS } from "../battle/movesets.js";
import {
  loadGuildMovesets, invalidateGuildMovesets, listAllMovesets,
  coerceMoveset, listDefaultMovesets,
  type Moveset, type MovesetKind,
} from "../battle/movesets.js";
import {
  loadGuildPassives, invalidateGuildPassives, listAllPassives, listPassives,
  getPassive, coercePassive, listDefaultPassives,
  type Passive, type PassiveTrigger, type PassiveEffect,
} from "../battle/passives.js";

// Options for the admin moveset picker (≤25 for a select menu).
const MOVESETS_FOR_PICKER = Object.values(MOVESETS);
import { rarityLabel, rarityEmoji } from "../cards-data.js";
import type { Rarity } from "../cards-data.js";

// Resolve rarity display (label/emoji) through /rarity — the source of truth —
// so renamed/re-emojied rarities show correctly across the battle admin hub.
async function rarityDisplay(guildId: string) {
  const [gs, dm] = await Promise.all([
    getOrCreateGuildSettings(guildId),
    getRarityDisplayOverrides(guildId),
  ]);
  return {
    label: (r: Rarity) => rarityLabel(r, gs, dm),
    emoji: (r: Rarity) => rarityEmoji(r, gs, dm),
  };
}
import { toAbsoluteImageUrl } from "../image-url.js";

// Battle speed presets (frame delay ms) for the admin speed controller.
const SPEED_PRESETS: Array<{ value: string; label: string; emoji: string; ms: number }> = [
  { value: "1500", label: "Cinematic (slowest)", emoji: "🎬", ms: 1500 },
  { value: "1100", label: "Slow", emoji: "🐢", ms: 1100 },
  { value: "900", label: "Normal", emoji: "⚖️", ms: 900 },
  { value: "600", label: "Fast", emoji: "⚡", ms: 600 },
  { value: "300", label: "Blitz (fastest)", emoji: "🚀", ms: 300 },
];

// ── Entry ────────────────────────────────────────────────────────────────────
export async function handleBattleAdminCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!(await ensureAdmin(interaction))) return;
  const guildId = interaction.guild.id;

  // Quick-upload: an attached image fills the next empty arena-background slot
  // (or replaces slot 1 when all three are full), then opens the manager.
  const image = interaction.options.getAttachment("image");
  if (image?.url) {
    const existing = await getBattleBackgrounds(guildId);
    const slot = (existing.length < 3 ? existing.length + 1 : 1) as 1 | 2 | 3;
    let url = image.url;
    if (image.url.includes("cdn.discordapp.com") || image.url.includes("media.discordapp.net")) {
      try { url = await persistBotImage(image.url, image.contentType ?? undefined); } catch { /* fall back to raw URL */ }
    }
    await setBattleBackground(guildId, slot, url, interaction.user.id);
    await interaction.editReply(await buildBackgroundsManager(guildId));
    return;
  }

  await interaction.editReply({ embeds: [await buildHubEmbed(guildId)], components: buildHubComponents(await getBattleSettings(guildId)) });
}

// ── Button router ────────────────────────────────────────────────────────────
export async function handleBattleAdminButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) return;
  const action = interaction.customId.split(":")[1];

  // Modal-opening actions must call showModal FIRST (can't defer).
  if (["rules", "formulas", "rewards", "editcard", "bcstats", "itemtext", "movetext", "passtext"].includes(action)) {
    if (!ensureAdminInline(interaction)) { await interaction.reply({ content: "❌ Admins only.", flags: MessageFlags.Ephemeral }); return; }
    const settings = await getBattleSettings(interaction.guild.id);
    if (action === "rules") await interaction.showModal(buildRulesModal(settings));
    if (action === "formulas") await interaction.showModal(buildFormulasModal(settings));
    if (action === "rewards") await interaction.showModal(buildRewardsModal(settings));
    if (action === "editcard") await interaction.showModal(buildCardSearchModal());
    if (action === "bcstats") await interaction.showModal(await buildStatsModal(interaction.guild.id, Number(interaction.customId.split(":")[2])));
    if (action === "itemtext") await interaction.showModal(await buildItemTextModal(interaction.guild.id, interaction.customId.split(":")[2]!));
    if (action === "movetext") await interaction.showModal(await buildMoveTextModal(interaction.guild.id, interaction.customId.split(":")[2]!));
    if (action === "passtext") await interaction.showModal(await buildPassiveTextModal(interaction.guild.id, interaction.customId.split(":")[2]!));
    return;
  }

  await interaction.deferUpdate().catch(() => {});
  if (!(await ensureAdmin(interaction, true))) return;
  const guildId = interaction.guild.id;

  // ── Battle-card editor panel actions ───────────────────────────────────────
  if (action === "bctoggle" || action === "bcreset") {
    const cardId = Number(interaction.customId.split(":")[2]);
    if (action === "bctoggle") {
      const cfg = await getBattleCardConfig(guildId, cardId);
      await upsertBattleCardConfig(guildId, cardId, { enabled: !(cfg?.enabled ?? true) }, interaction.user.id);
    } else {
      await resetBattleCardConfig(guildId, cardId);
    }
    const panel = await buildCardEditorPanel(guildId, cardId);
    if (panel) await interaction.editReply(panel);
    return;
  }

  switch (action) {
    case "wizard": {
      await updateBattleSettings(guildId, {
        enabled: true, setupComplete: true,
        battleChannelId: null,      // allow any channel by default (minimal setup)
        logChannelId: interaction.channelId,
      });
      await interaction.followUp({
        content: "✅ **Setup complete!** Battles are now live. Players can use `/battle fight`. "
          + "Battles are allowed in any channel (set a dedicated one under **Channels**), and results log here. "
          + "Fine-tune rules, rewards, and card eligibility with the buttons above.",
        flags: MessageFlags.Ephemeral,
      });
      break;
    }
    case "resetformulas": {
      // Schema defaults — rarity rank still scales via hpPerRarity / attackPerRarity / etc.
      // Per-card overrides stay until you use "Reset to Auto" on that card.
      await updateBattleSettings(guildId, {
        hpBase: 750,
        hpPerRarity: 220,
        hpWorthDivisor: 40,
        attackBase: 85,
        attackPerRarity: 28,
        defenseBase: 55,
        defensePerRarity: 18,
        speedBase: 50,
        levelMaxBonusPct: 150,
      });
      await interaction.followUp({
        content:
          "♻️ **Battle formulas reset** to defaults (HP/ATK/DEF/speed bases + per-rarity steps). " +
          "Rarity ladder still drives strength. Per-card battle overrides are unchanged — open a card → **Reset to Auto** to clear those.",
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      break;
    }
    case "toggle": {
      const s = await getBattleSettings(guildId);
      await updateBattleSettings(guildId, { enabled: !s.enabled });
      break;
    }
    case "globaltoggle": {
      const s = await getBattleSettings(guildId);
      await updateBattleSettings(guildId, { globalLeaderboardOptIn: !s.globalLeaderboardOptIn });
      break;
    }
    case "specialtoggle": {
      const s = await getBattleSettings(guildId);
      await updateBattleSettings(guildId, { specialCardsEnabled: !s.specialCardsEnabled });
      break;
    }
    case "staketoggle": {
      const s = await getBattleSettings(guildId);
      await updateBattleSettings(guildId, { stakingEnabled: !s.stakingEnabled });
      break;
    }
    case "aitoggle": {
      const s = await getBattleSettings(guildId);
      await updateBattleSettings(guildId, { aiEnabled: !s.aiEnabled });
      break;
    }
    case "animtoggle": {
      // Cycle battle visuals: Off → Classic (light single-frame) → Animated
      // (arena scene) → Off. Lets admins instantly dial back if the animated
      // scene is too heavy on their server.
      const s = await getBattleSettings(guildId);
      const patch = !s.battleAnimationEnabled
        ? { battleAnimationEnabled: true, battleSceneAnimated: false }   // Off → Classic
        : !s.battleSceneAnimated
          ? { battleSceneAnimated: true }                               // Classic → Animated
          : { battleAnimationEnabled: false };                          // Animated → Off
      await updateBattleSettings(guildId, patch);
      break;
    }
    case "cards": {
      await interaction.editReply({ embeds: [await buildCardsEmbed(guildId)], components: await buildCardsComponents(guildId) });
      return;
    }
    case "channels": {
      await interaction.editReply({ embeds: [await buildChannelsEmbed(guildId)], components: buildChannelsComponents() });
      return;
    }
    case "backgrounds": {
      await interaction.editReply(await buildBackgroundsManager(guildId));
      return;
    }
    case "bgclear": {
      const slot = Number(interaction.customId.split(":")[2]) as 1 | 2 | 3;
      if (slot >= 1 && slot <= 3) await clearBattleBackground(guildId, slot);
      await interaction.editReply(await buildBackgroundsManager(guildId));
      return;
    }
    case "bgclearall": {
      await clearAllBattleBackgrounds(guildId);
      await interaction.editReply(await buildBackgroundsManager(guildId));
      return;
    }
    case "itemmgr": {
      await interaction.editReply(await buildItemManager(guildId));
      return;
    }
    case "itemnew": {
      const id = `custom_${Date.now().toString(36)}`;
      const template = coerceBattleItem(id, {
        name: "New Item", emoji: "🎒", description: "Custom battle item.",
        effectType: "heal", target: "self", power: 20, duration: 0, cooldown: 1,
        charges: 2, category: "utility", rarity: "common", enabled: true,
      });
      await upsertBattleContent(guildId, "item", id, itemToData(template), true, interaction.user.id);
      invalidateGuildBattleItems(guildId);
      await interaction.editReply(await buildItemEditor(guildId, id));
      return;
    }
    case "itemtoggle": {
      const id = interaction.customId.split(":")[2]!;
      const cur = await effectiveItem(guildId, id);
      if (cur) {
        await upsertBattleContent(guildId, "item", id, itemToData({ ...cur, enabled: !cur.enabled }), !cur.enabled, interaction.user.id);
        invalidateGuildBattleItems(guildId);
      }
      await interaction.editReply(await buildItemEditor(guildId, id));
      return;
    }
    case "itemdelete": {
      const id = interaction.customId.split(":")[2]!;
      await deleteBattleContent(guildId, "item", id);
      invalidateGuildBattleItems(guildId);
      await interaction.editReply(await buildItemManager(guildId));
      return;
    }
    case "movemgr": {
      await interaction.editReply(await buildMoveManager(guildId));
      return;
    }
    case "movenew": {
      const id = `custom_${Date.now().toString(36)}`;
      const template = coerceMoveset(id, {
        name: "New Move", emoji: "⚔️", description: "Custom signature move.",
        allowedTypes: "all", energyCost: 40, kind: "strike", powerPct: 160,
      });
      await upsertBattleContent(guildId, "move", id, movesetToData(template), true, interaction.user.id);
      invalidateGuildMovesets(guildId);
      await interaction.editReply(await buildMoveEditor(guildId, id));
      return;
    }
    case "movetoggle": {
      const id = interaction.customId.split(":")[2]!;
      const rows = await listBattleContent(guildId, "move");
      const row = rows.find(r => r.contentId === id);
      const cur = await effectiveMove(guildId, id);
      // Enabled state lives on the battle_content row; default (no row) is enabled.
      const nextEnabled = !(row ? row.enabled : true);
      if (cur) {
        await upsertBattleContent(guildId, "move", id, movesetToData(cur), nextEnabled, interaction.user.id);
        invalidateGuildMovesets(guildId);
      }
      await interaction.editReply(await buildMoveEditor(guildId, id));
      return;
    }
    case "movedelete": {
      const id = interaction.customId.split(":")[2]!;
      await deleteBattleContent(guildId, "move", id);
      invalidateGuildMovesets(guildId);
      await interaction.editReply(await buildMoveManager(guildId));
      return;
    }
    case "passivemgr": {
      await interaction.editReply(await buildPassiveManager(guildId));
      return;
    }
    case "passnew": {
      const id = `custom_${Date.now().toString(36)}`;
      const template = coercePassive(id, {
        name: "New Passive", emoji: "✨", description: "Custom passive ability.",
        trigger: "battle_start", effect: "buff", magnitude: 15, enabled: true,
      });
      await upsertBattleContent(guildId, "passive", id, passiveToData(template), true, interaction.user.id);
      invalidateGuildPassives(guildId);
      await interaction.editReply(await buildPassiveEditor(guildId, id));
      return;
    }
    case "passtoggle": {
      const id = interaction.customId.split(":")[2]!;
      const cur = await effectivePassive(guildId, id);
      if (cur) {
        await upsertBattleContent(guildId, "passive", id, passiveToData({ ...cur, enabled: !cur.enabled }), !cur.enabled, interaction.user.id);
        invalidateGuildPassives(guildId);
      }
      await interaction.editReply(await buildPassiveEditor(guildId, id));
      return;
    }
    case "passdelete": {
      const id = interaction.customId.split(":")[2]!;
      await deleteBattleContent(guildId, "passive", id);
      invalidateGuildPassives(guildId);
      await interaction.editReply(await buildPassiveManager(guildId));
      return;
    }
    case "resetlb": {
      await interaction.followUp({
        content: "⚠️ Reset the leaderboard? This zeroes everyone's **rank points & current streak** (lifetime W/L and stats are kept).",
        components: [confirmRow("resetlb_confirm")],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    case "resetlb_confirm": {
      await db.update(battleProfilesTable).set({ rankPoints: 1000, currentStreak: 0, updatedAt: new Date() })
        .where(eq(battleProfilesTable.guildId, guildId));
      await interaction.followUp({ content: "🏆 Leaderboard reset — everyone starts fresh at 1000 RP.", flags: MessageFlags.Ephemeral });
      break;
    }
    case "season": {
      await interaction.followUp({
        content: "⚠️ Start a new season? The current season ends, ranks soft-reset to 1000, and lifetime stats are preserved.",
        components: [confirmRow("season_confirm")],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    case "season_confirm": {
      const res = await resetSeason(guildId);
      const podium = res.topThree.length
        ? res.topThree.map((p, i) => `${["🥇", "🥈", "🥉"][i]} <@${p.userId}> — ${p.rankPoints} RP`).join("\n")
        : "_No ranked players last season._";
      await interaction.followUp({
        content: `🔄 **${res.newSeason.name}** has begun!\n\n**Previous season podium:**\n${podium}`,
        allowedMentions: { parse: [] }, flags: MessageFlags.Ephemeral,
      });
      break;
    }
    case "hub":
    default:
      break;
  }
  await interaction.editReply({ embeds: [await buildHubEmbed(guildId)], components: buildHubComponents(await getBattleSettings(guildId)) }).catch(() => {});
}

// ── Select router (rarity min/max + allowed types) ───────────────────────────
export async function handleBattleAdminSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.guild) return;
  await interaction.deferUpdate().catch(() => {});
  if (!(await ensureAdmin(interaction, true))) return;
  const parts = interaction.customId.split(":");
  const action = parts[1];
  const guildId = interaction.guild.id;

  // Speed controller → re-render the hub.
  if (action === "speed") {
    const ms = Math.max(120, Math.min(4000, Number(interaction.values[0]) || 950));
    await updateBattleSettings(guildId, { frameDelayMs: ms });
    await interaction.editReply({ embeds: [await buildHubEmbed(guildId)], components: buildHubComponents(await getBattleSettings(guildId)) }).catch(() => {});
    return;
  }
  if (action === "animspeed") {
    const speed = interaction.values[0] as "slow" | "normal" | "fast";
    if (["slow", "normal", "fast"].includes(speed)) {
      await updateBattleSettings(guildId, { battleAnimationSpeed: speed });
    }
    await interaction.editReply({ embeds: [await buildHubEmbed(guildId)], components: buildHubComponents(await getBattleSettings(guildId)) }).catch(() => {});
    return;
  }

  // Battle Item Manager selects.
  if (action === "itempick") {
    await interaction.editReply(await buildItemEditor(guildId, interaction.values[0]!)).catch(() => {});
    return;
  }
  if (action === "itemfx" || action === "itemtarget" || action === "itemstatus") {
    const id = parts[2]!;
    const cur = await effectiveItem(guildId, id);
    if (cur) {
      const v = interaction.values[0]!;
      const patch: Partial<BattleItem> =
        action === "itemfx" ? { effectType: v as ItemEffectType }
        : action === "itemtarget" ? { target: v as ItemTarget }
        : { statusKind: v === "__none__" ? undefined : (v as StatusKind) };
      await upsertBattleContent(guildId, "item", id, itemToData({ ...cur, ...patch }), cur.enabled, interaction.user.id);
      invalidateGuildBattleItems(guildId);
    }
    await interaction.editReply(await buildItemEditor(guildId, id)).catch(() => {});
    return;
  }

  // Move Library selects.
  if (action === "movepick") {
    await interaction.editReply(await buildMoveEditor(guildId, interaction.values[0]!)).catch(() => {});
    return;
  }
  if (action === "movekind" || action === "moveeffect") {
    const key = parts[2]!;
    const cur = await effectiveMove(guildId, key);
    const rows = await listBattleContent(guildId, "move");
    const enabled = rows.find(r => r.contentId === key)?.enabled ?? true;
    if (cur) {
      const v = interaction.values[0]!;
      const patch: Partial<Moveset> = action === "movekind"
        ? { kind: v as MovesetKind }
        : { effect: v === "__none__" ? undefined : v };
      await upsertBattleContent(guildId, "move", key, movesetToData({ ...cur, ...patch }), enabled, interaction.user.id);
      invalidateGuildMovesets(guildId);
    }
    await interaction.editReply(await buildMoveEditor(guildId, key)).catch(() => {});
    return;
  }

  // Passive Library selects.
  if (action === "passivepick") {
    await interaction.editReply(await buildPassiveEditor(guildId, interaction.values[0]!)).catch(() => {});
    return;
  }
  if (action === "passtrigger" || action === "passeffect") {
    const id = parts[2]!;
    const cur = await effectivePassive(guildId, id);
    if (cur) {
      const v = interaction.values[0]!;
      const patch: Partial<Passive> = action === "passtrigger"
        ? { trigger: v as PassiveTrigger }
        : { effect: v as PassiveEffect };
      await upsertBattleContent(guildId, "passive", id, passiveToData({ ...cur, ...patch }), cur.enabled, interaction.user.id);
      invalidateGuildPassives(guildId);
    }
    await interaction.editReply(await buildPassiveEditor(guildId, id)).catch(() => {});
    return;
  }

  // Per-card editor selects → re-render the card editor panel.
  if (action === "bcrarity" || action === "bcspecial" || action === "bcmoveset" || action === "bcpassive") {
    const cardId = Number(parts[2]);
    const v = interaction.values[0];
    if (action === "bcrarity") {
      await upsertBattleCardConfig(guildId, cardId, { rarity: v === "__auto__" ? null : v }, interaction.user.id);
    } else if (action === "bcspecial") {
      await upsertBattleCardConfig(guildId, cardId, { specialEffect: v === "__auto__" || v === "__none__" ? null : v }, interaction.user.id);
    } else if (action === "bcpassive") {
      await upsertBattleCardConfig(guildId, cardId, { passive: v === "__none__" ? null : v }, interaction.user.id);
    } else {
      await upsertBattleCardConfig(guildId, cardId, { moveset: v === "__auto__" ? null : v }, interaction.user.id);
    }
    const panel = await buildCardEditorPanel(guildId, cardId);
    if (panel) await interaction.editReply(panel).catch(() => {});
    return;
  }

  // Fuzzy search result picker from the "Edit Card" modal.
  if (action === "bcsearchresult") {
    const cardId = Number(interaction.values[0]);
    const panel = await buildCardEditorPanel(guildId, cardId);
    if (panel) await interaction.editReply(panel).catch(() => {});
    else await interaction.editReply(`❌ Couldn't open the editor for that card.`).catch(() => {});
    return;
  }

  if (action === "minrarity") await updateBattleSettings(guildId, { minRarity: interaction.values[0] });
  else if (action === "maxrarity") await updateBattleSettings(guildId, { maxRarity: interaction.values[0] });
  else if (action === "types") {
    const values = interaction.values.includes("__all__") ? null : interaction.values;
    await updateBattleSettings(guildId, { allowedTypes: values });
  }
  await interaction.editReply({ embeds: [await buildCardsEmbed(guildId)], components: await buildCardsComponents(guildId) }).catch(() => {});
}

// ── Channel select router ────────────────────────────────────────────────────
export async function handleBattleAdminChannelSelect(interaction: ChannelSelectMenuInteraction): Promise<void> {
  if (!interaction.guild) return;
  await interaction.deferUpdate().catch(() => {});
  if (!(await ensureAdmin(interaction, true))) return;
  const action = interaction.customId.split(":")[1];
  const guildId = interaction.guild.id;
  const channelId = interaction.values[0] ?? null;
  if (action === "battlechan") await updateBattleSettings(guildId, { battleChannelId: channelId });
  else if (action === "logchan") await updateBattleSettings(guildId, { logChannelId: channelId });
  await interaction.editReply({ embeds: [await buildChannelsEmbed(guildId)], components: buildChannelsComponents() }).catch(() => {});
}

// ── Modal router ─────────────────────────────────────────────────────────────
export async function handleBattleAdminModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.guild) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!(await ensureAdmin(interaction))) return;
  const action = interaction.customId.split(":")[1];
  const guildId = interaction.guild.id;

  // Battle Item text/number editor modal.
  if (action === "itemtext") {
    const id = interaction.customId.split(":")[2]!;
    const cur = await effectiveItem(guildId, id);
    if (cur) {
      const get = (k: string) => interaction.fields.getTextInputValue(k).trim();
      const numOr = (s: string, f: number) => { const n = Number(s); return Number.isFinite(n) ? n : f; };
      const tuning = get("tuning").split(/[\s,/]+/).filter(Boolean);
      const patch: BattleItem = {
        ...cur,
        name: get("name") || cur.name,
        emoji: get("emoji") || cur.emoji,
        description: get("desc") || cur.description,
        power: numOr(get("power"), cur.power),
        duration: numOr(tuning[0] ?? "", cur.duration),
        cooldown: numOr(tuning[1] ?? "", cur.cooldown),
        charges: numOr(tuning[2] ?? "", cur.charges),
      };
      await upsertBattleContent(guildId, "item", id, itemToData(patch), cur.enabled, interaction.user.id);
      invalidateGuildBattleItems(guildId);
    }
    await interaction.editReply(await buildItemEditor(guildId, id)).catch(() => {});
    return;
  }

  // Move Library text/number editor modal.
  if (action === "movetext") {
    const key = interaction.customId.split(":")[2]!;
    const cur = await effectiveMove(guildId, key);
    const rows = await listBattleContent(guildId, "move");
    const enabled = rows.find(r => r.contentId === key)?.enabled ?? true;
    if (cur) {
      const get = (k: string) => interaction.fields.getTextInputValue(k).trim();
      const numOr = (s: string, f: number) => { const n = Number(s); return Number.isFinite(n) ? n : f; };
      const nums = get("nums").split(/[\s,/]+/).filter(Boolean);
      const typesRaw = get("types").trim();
      const allowedTypes: string[] | "all" = (!typesRaw || typesRaw.toLowerCase() === "all")
        ? "all" : typesRaw.split(/[\s,]+/).map(s => s.toLowerCase()).filter(Boolean);
      const patch: Moveset = {
        ...cur,
        name: get("name") || cur.name,
        emoji: get("emoji") || cur.emoji,
        description: get("desc") || cur.description,
        energyCost: numOr(nums[0] ?? "", cur.energyCost),
        powerPct: numOr(nums[1] ?? "", cur.powerPct ?? 0) || undefined,
        followUpPct: numOr(nums[2] ?? "", cur.followUpPct ?? 0) || undefined,
        allowedTypes,
      };
      await upsertBattleContent(guildId, "move", key, movesetToData(patch), enabled, interaction.user.id);
      invalidateGuildMovesets(guildId);
    }
    await interaction.editReply(await buildMoveEditor(guildId, key)).catch(() => {});
    return;
  }

  // Passive Library text/number editor modal.
  if (action === "passtext") {
    const id = interaction.customId.split(":")[2]!;
    const cur = await effectivePassive(guildId, id);
    if (cur) {
      const get = (k: string) => interaction.fields.getTextInputValue(k).trim();
      const numOr = (s: string, f: number) => { const n = Number(s); return Number.isFinite(n) ? n : f; };
      const patch: Passive = {
        ...cur,
        name: get("name") || cur.name,
        emoji: get("emoji") || cur.emoji,
        description: get("desc") || cur.description,
        magnitude: numOr(get("magnitude"), cur.magnitude),
      };
      await upsertBattleContent(guildId, "passive", id, passiveToData(patch), cur.enabled, interaction.user.id);
      invalidateGuildPassives(guildId);
    }
    await interaction.editReply(await buildPassiveEditor(guildId, id)).catch(() => {});
    return;
  }

  const num = (id: string, min: number, max: number, cur: number): number => {
    const raw = interaction.fields.getTextInputValue(id).trim();
    if (raw === "") return cur;
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return cur;
    return Math.max(min, Math.min(max, n));
  };
  const settings = await getBattleSettings(guildId);

  if (action === "rules") {
    await updateBattleSettings(guildId, {
      turnTimerSeconds: num("turn", 10, 300, settings.turnTimerSeconds),
      critChancePct: num("crit", 0, 100, settings.critChancePct),
      missChancePct: num("miss", 0, 90, settings.missChancePct),
      dodgeChancePct: num("dodge", 0, 90, settings.dodgeChancePct),
      shieldStrengthPct: num("shield", 0, 100, settings.shieldStrengthPct),
    });
    await interaction.editReply("✅ Combat rules updated.");
  } else if (action === "formulas") {
    await updateBattleSettings(guildId, {
      hpBase: num("hp", 100, 100000, settings.hpBase),
      attackBase: num("atk", 10, 100000, settings.attackBase),
      defenseBase: num("def", 0, 100000, settings.defenseBase),
      energyGainPerTurn: num("energy", 0, 100, settings.energyGainPerTurn),
      ultimateChargePerTurn: num("ult", 1, 100, settings.ultimateChargePerTurn),
    });
    await interaction.editReply("✅ Stat formulas updated. (New battles use the new numbers.)");
  } else if (action === "rewards") {
    await updateBattleSettings(guildId, {
      rewardWinShards: num("winshards", 0, 1000000, settings.rewardWinShards),
      rewardLossShards: num("lossshards", 0, 1000000, settings.rewardLossShards),
      rewardWinXp: num("winxp", 0, 100000, settings.rewardWinXp),
      dailyRewardLimit: num("dailylimit", 0, 10000, settings.dailyRewardLimit),
      freePackStreak: num("packstreak", 0, 1000, settings.freePackStreak),
    });
    await interaction.editReply("✅ Rewards updated.");
  } else if (action === "editcard") {
    // Fuzzy card search (same scoring as /dnvaluesearch), then open the battle-card editor.
    const name = interaction.fields.getTextInputValue("name").trim();
    const cards = await getAllCards(guildId);
    const exact = cards.find((c) => c.name.toLowerCase() === name.toLowerCase());
    let card: Card | undefined = exact;

    if (!card) {
      const scored = cards
        .map((c) => ({ c, score: matchCardScore(c, name) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score);

      if (scored.length === 0) {
        await interaction.editReply(`❌ No card found for **${name}**. Check the spelling and try again.`);
        return;
      }
      if (scored.length === 1) {
        card = scored[0].c;
      } else {
        // Multiple matches — show a picker so the admin can choose the right card.
        const top = scored.slice(0, 25);
        const rd = await rarityDisplay(guildId);
        const embed = new EmbedBuilder()
          .setTitle("🔍 Multiple card matches")
          .setDescription(`I found ${scored.length} cards matching "**${name}**". Pick one to edit.`)
          .setColor(0x5865f2);
        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`battleadmin:bcsearchresult`)
            .setPlaceholder("Select a card to edit")
            .addOptions(top.map(({ c }) => {
              const desc = `${rd.label(c.rarity as Rarity)} · ${c.cardType || "—"} · worth ${c.worthValue}`;
              return {
                label: c.name.slice(0, 100),
                description: desc.length > 100 ? desc.slice(0, 97) + "…" : desc,
                value: String(c.id),
              };
            })),
        );
        await interaction.editReply({ embeds: [embed], components: [row] });
        return;
      }
    }

    const panel = await buildCardEditorPanel(guildId, card.id);
    if (panel) await interaction.editReply(panel);
    else await interaction.editReply(`❌ Couldn't open the editor for **${card.name}**.`);
  } else if (action === "bcstats") {
    // Per-card stat overrides (blank = auto/derived).
    const cardId = Number(interaction.customId.split(":")[2]);
    const stat = (id: string): number | null => {
      const raw = interaction.fields.getTextInputValue(id).trim();
      if (raw === "") return null;
      const n = Math.round(Number(raw));
      return Number.isFinite(n) && n > 0 ? Math.min(1_000_000, n) : null;
    };
    await upsertBattleCardConfig(guildId, cardId, {
      health: stat("health"), attack: stat("attack"), defense: stat("defense"),
      speed: stat("speed"), critChance: stat("crit"),
    }, interaction.user.id);
    const panel = await buildCardEditorPanel(guildId, cardId);
    if (panel) await interaction.editReply(panel);
    else await interaction.editReply("✅ Stats updated.");
  }
}

// ── Embeds ───────────────────────────────────────────────────────────────────
async function buildHubEmbed(guildId: string): Promise<EmbedBuilder> {
  const s = await getBattleSettings(guildId);
  const rd = await rarityDisplay(guildId);
  const onoff = (b: boolean) => b ? "✅ On" : "⏸️ Off";
  return new EmbedBuilder()
    .setColor(s.setupComplete ? 0xed4245 : 0xfaa61a)
    .setTitle("🛡️ Battle Admin Hub")
    .setDescription(s.setupComplete
      ? "Battles are configured. Adjust anything below — every change saves for **this server only**."
      : "⚠️ **Battles aren't active yet.** Click **Setup Wizard** to enable them with sensible defaults.")
    .addFields(
      { name: "Status", value: `${onoff(s.enabled)} · Setup ${s.setupComplete ? "✅ complete" : "❌ pending"}`, inline: true },
      { name: "Battle Channel", value: s.battleChannelId ? `<#${s.battleChannelId}>` : "Any channel", inline: true },
      { name: "Log Channel", value: s.logChannelId ? `<#${s.logChannelId}>` : "None", inline: true },
      { name: "Rules", value: `⏱️ ${s.turnTimerSeconds}s · 💥 ${s.critChancePct}% crit · 💨 ${s.missChancePct}% miss · 🌀 ${s.dodgeChancePct}% dodge`, inline: false },
      { name: "Speed", value: `${speedLabel(s.frameDelayMs)} (${s.frameDelayMs}ms/frame) — set below`, inline: false },
      { name: "Cards", value: `${rd.label(s.minRarity as Rarity)} → ${rd.label(s.maxRarity as Rarity)} · Types: ${s.allowedTypes?.length ? s.allowedTypes.join(", ") : "All"} · Special ${onoff(s.specialCardsEnabled)} · Stake ${onoff(s.stakingEnabled)}`, inline: false },
      { name: "Rewards", value: `💠 Win ${s.rewardWinShards} / Loss ${s.rewardLossShards} · ✨ ${s.rewardWinXp} XP · Daily cap ${s.dailyRewardLimit} · 🎁 pack every ${s.freePackStreak || "—"} streak`, inline: false },
      { name: "Toggles", value: `AI ${onoff(s.aiEnabled)} · Global LB ${onoff(s.globalLeaderboardOptIn)} · Battle Visuals **${battleVisualMode(s)}**`, inline: false },
    );
}

// Battle visual mode label for the 3-state "Battle Visuals" cycle.
function battleVisualMode(s: { battleAnimationEnabled: boolean; battleSceneAnimated?: boolean }): string {
  if (!s.battleAnimationEnabled) return "⏸️ Off (static)";
  return s.battleSceneAnimated ? "🎬 Animated arenas" : "🖼️ Classic (light)";
}

function speedLabel(ms: number): string {
  // Nearest preset name for display.
  let best = SPEED_PRESETS[0]!;
  for (const p of SPEED_PRESETS) if (Math.abs(p.ms - ms) < Math.abs(best.ms - ms)) best = p;
  return `${best.emoji} ${best.label.replace(/ \(.*\)$/, "")}`;
}

function buildHubComponents(s?: { frameDelayMs: number; battleAnimationSpeed?: string }): ActionRowBuilder<any>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("battleadmin:wizard").setLabel("Setup Wizard").setEmoji("🚀").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("battleadmin:toggle").setLabel("Enable/Disable").setEmoji("🔀").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("battleadmin:channels").setLabel("Channels").setEmoji("📡").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("battleadmin:backgrounds").setLabel("Backgrounds").setEmoji("🖼️").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("battleadmin:movemgr").setLabel("Move Library").setEmoji("⚔️").setStyle(ButtonStyle.Primary),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("battleadmin:rules").setLabel("Rules").setEmoji("⚙️").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("battleadmin:formulas").setLabel("Formulas").setEmoji("🧮").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("battleadmin:resetformulas").setLabel("Reset Formulas").setEmoji("♻️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("battleadmin:rewards").setLabel("Rewards").setEmoji("🎁").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("battleadmin:cards").setLabel("Cards").setEmoji("🎴").setStyle(ButtonStyle.Primary),
  );
  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("battleadmin:itemmgr").setLabel("Battle Items").setEmoji("🎒").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("battleadmin:passivemgr").setLabel("Passives").setEmoji("✨").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("battleadmin:resetlb").setLabel("Reset Leaderboard").setEmoji("🏆").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("battleadmin:season").setLabel("New Season").setEmoji("🔄").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("battleadmin:animtoggle").setLabel("Battle Visuals").setEmoji("🎞️").setStyle(ButtonStyle.Secondary),
  );
  const cur = s?.frameDelayMs ?? 950;
  const speedRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId("battleadmin:speed").setPlaceholder("⚡ Battle speed / animation pace")
      .addOptions(SPEED_PRESETS.map(p => ({
        label: p.label, emoji: p.emoji, value: p.value,
        description: `${p.ms}ms between frames`,
        default: Math.abs(p.ms - cur) < 120,
      }))),
  );
  const animSpeedRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId("battleadmin:animspeed").setPlaceholder("🎞️ GIF battle speed")
      .addOptions([
        { label: "Slow (cinematic)", value: "slow", emoji: "🐢" },
        { label: "Normal", value: "normal", emoji: "⚖️" },
        { label: "Fast", value: "fast", emoji: "🚀" },
      ].map(o => ({ ...o, default: o.value === (s?.battleAnimationSpeed ?? "normal") }))),
  );
  return [row1, row2, row3, speedRow, animSpeedRow];
}

async function buildCardsEmbed(guildId: string): Promise<EmbedBuilder> {
  const s = await getBattleSettings(guildId);
  const rd = await rarityDisplay(guildId);
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🎴 Battle Card Settings")
    .setDescription("Choose which cards can battle by rarity + type, toggle special cards & staking, and fine-tune individual cards with **Edit Card**.")
    .addFields(
      { name: "Rarity Window", value: `${rd.emoji(s.minRarity as Rarity)} ${rd.label(s.minRarity as Rarity)} → ${rd.emoji(s.maxRarity as Rarity)} ${rd.label(s.maxRarity as Rarity)}`, inline: false },
      { name: "Allowed Types", value: s.allowedTypes?.length ? s.allowedTypes.join(", ") : "All types", inline: false },
      { name: "Special Cards", value: s.specialCardsEnabled ? "✅ Enabled" : "⏸️ Disabled", inline: true },
      { name: "Staking", value: s.stakingEnabled ? "✅ Enabled" : "⏸️ Disabled", inline: true },
    );
}

async function buildCardsComponents(guildId: string): Promise<ActionRowBuilder<any>[]> {
  const s = await getBattleSettings(guildId);
  const rd = await rarityDisplay(guildId);
  const rarityOptions = (selected: string) => RARITY_ORDER.map(r => ({
    label: rd.label(r), emoji: rd.emoji(r), value: r, default: selected === r,
  }));

  const minRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId("battleadmin:minrarity").setPlaceholder("Minimum rarity").addOptions(rarityOptions(s.minRarity)),
  );
  const maxRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId("battleadmin:maxrarity").setPlaceholder("Maximum rarity").addOptions(rarityOptions(s.maxRarity)),
  );

  // Distinct card types present in the roster.
  const cards = await getAllCards(guildId);
  const types = Array.from(new Set(cards.map(c => (c.cardType ?? "").toLowerCase()).filter(Boolean))).slice(0, 24);
  const selected = new Set((s.allowedTypes ?? []).map(t => t.toLowerCase()));
  const typeOptions = [
    { label: "All types", value: "__all__", default: !s.allowedTypes || s.allowedTypes.length === 0 },
    ...types.map(t => ({ label: t, value: t, default: selected.has(t) })),
  ];
  const typeRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId("battleadmin:types").setPlaceholder("Allowed card types")
      .setMinValues(1).setMaxValues(typeOptions.length).addOptions(typeOptions),
  );

  const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("battleadmin:editcard").setLabel("Edit Card").setEmoji("✏️").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("battleadmin:specialtoggle").setLabel("Toggle Special Cards").setEmoji("✨").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("battleadmin:staketoggle").setLabel("Toggle Staking").setEmoji("💰").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("battleadmin:hub").setLabel("Back").setStyle(ButtonStyle.Secondary),
  );
  return [minRow, maxRow, typeRow, btnRow];
}

async function buildChannelsEmbed(guildId: string): Promise<EmbedBuilder> {
  const s = await getBattleSettings(guildId);
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("📡 Battle Channels")
    .setDescription("Pick where battles can start and where results are logged. Leave the battle channel empty to allow battles anywhere.")
    .addFields(
      { name: "Battle Channel", value: s.battleChannelId ? `<#${s.battleChannelId}>` : "Any channel", inline: true },
      { name: "Log Channel", value: s.logChannelId ? `<#${s.logChannelId}>` : "None", inline: true },
    );
}

function buildChannelsComponents(): ActionRowBuilder<any>[] {
  return [
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder().setCustomId("battleadmin:battlechan").setPlaceholder("⚔️ Battle channel (optional)")
        .addChannelTypes(ChannelType.GuildText),
    ),
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder().setCustomId("battleadmin:logchan").setPlaceholder("📜 Log channel")
        .addChannelTypes(ChannelType.GuildText),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("battleadmin:hub").setLabel("Back").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ── Battle Backgrounds manager ───────────────────────────────────────────────
// Up to 3 uploadable arena backgrounds; the VS renderer auto-shuffles between
// them each fight. Admins add images by re-running `/battle_admin image:<file>`
// (fills the next empty slot) and clear slots here.
async function buildBackgroundsManager(guildId: string): Promise<{ embeds: EmbedBuilder[]; components: ActionRowBuilder<any>[] }> {
  const urls = await getBattleBackgrounds(guildId);
  const slotLines = [1, 2, 3].map(i => {
    const u = urls[i - 1];
    return u ? `**Slot ${i}** · ✅ set` : `**Slot ${i}** · _empty_`;
  }).join("\n");

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle("🖼️ Battle Arena Backgrounds")
    .setDescription(
      "Upload up to **3** arena backgrounds. The battle image **auto-shuffles** between them each fight; "
      + "with none set, battles use the vibrant gradient drawn from the cards.\n\n"
      + "**To add one:** run `/battle_admin` with the **image** option (attach a PNG/JPG). "
      + "It fills the next empty slot (or replaces slot 1 when all are full).\n\n"
      + slotLines,
    );
  if (urls[0]) embed.setThumbnail(toAbsoluteImageUrl(urls[0]));

  const clearRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...[1, 2, 3].map(i =>
      new ButtonBuilder().setCustomId(`battleadmin:bgclear:${i}`).setLabel(`Clear ${i}`).setEmoji("🗑️")
        .setStyle(ButtonStyle.Secondary).setDisabled(!urls[i - 1])),
    new ButtonBuilder().setCustomId("battleadmin:bgclearall").setLabel("Clear All").setStyle(ButtonStyle.Danger).setDisabled(urls.length === 0),
  );
  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("battleadmin:hub").setLabel("Back").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [clearRow, backRow] };
}

// ── Battle Item Manager ──────────────────────────────────────────────────────
// Data-driven CRUD over the item registry: every guild can add custom items or
// override/disable the built-in defaults. Rows live in battle_content (kind
// "item") and the engine merges them over the code defaults at battle start.
const EFFECT_TYPES: ItemEffectType[] = ["heal", "shield", "damage", "energy", "buff", "debuff", "status"];
const ITEM_TARGETS: ItemTarget[] = ["self", "foe"];
const ITEM_STATUS_KINDS: StatusKind[] = ["poison", "burn", "freeze", "shield", "reflect", "buff", "regen", "weaken", "stealth"];

function itemToData(item: BattleItem): Record<string, unknown> {
  return { ...item } as Record<string, unknown>;
}

// Resolve the effective definition of an item id for a guild (custom or default).
async function effectiveItem(guildId: string, id: string): Promise<BattleItem | null> {
  invalidateGuildBattleItems(guildId);
  await loadGuildBattleItems(guildId);
  return getBattleItem(id, guildId);
}

async function buildItemManager(guildId: string): Promise<{ embeds: EmbedBuilder[]; components: ActionRowBuilder<any>[] }> {
  invalidateGuildBattleItems(guildId);
  await loadGuildBattleItems(guildId);
  const items = listAllBattleItems(guildId).sort((a, b) => a.name.localeCompare(b.name));
  const overrides = new Set((await listBattleContent(guildId, "item")).map(r => r.contentId));
  const defaultIds = new Set(listDefaultBattleItems().map(i => i.id));

  const lines = items.slice(0, 40).map(i => {
    const tag = !defaultIds.has(i.id) ? "🆕" : overrides.has(i.id) ? "✏️" : "▫️";
    const off = i.enabled ? "" : " · _disabled_";
    return `${tag} ${i.emoji} **${i.name}** — ${i.effectType}/${i.target} · pw ${i.power} · cd ${i.cooldown} · ${i.charges}×${off}`;
  });
  const embed = new EmbedBuilder()
    .setColor(0xf5a623)
    .setTitle("🎒 Battle Item Manager")
    .setDescription(
      "Create custom items or override the built-in defaults. Combat, prep, and the AI all read this list.\n"
      + "🆕 custom · ✏️ default overridden · ▫️ built-in default\n\n"
      + (lines.join("\n") || "_No items._"),
    );

  const pickRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId("battleadmin:itempick").setPlaceholder("✏️ Edit an item…")
      .addOptions(items.slice(0, 25).map(i => ({
        label: i.name.slice(0, 100), emoji: i.emoji, value: i.id,
        description: `${i.effectType}/${i.target} · ${i.enabled ? "on" : "off"}`.slice(0, 100),
      }))),
  );
  const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("battleadmin:itemnew").setLabel("New Item").setEmoji("➕").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("battleadmin:hub").setLabel("Back").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [pickRow, btnRow] };
}

async function buildItemEditor(guildId: string, id: string): Promise<{ embeds: EmbedBuilder[]; components: ActionRowBuilder<any>[] }> {
  const item = await effectiveItem(guildId, id);
  if (!item) return buildItemManager(guildId);
  const isDefault = listDefaultBattleItems().some(i => i.id === id);

  const embed = new EmbedBuilder()
    .setColor(item.enabled ? 0x2ecc71 : 0x95a5a6)
    .setTitle(`${item.emoji} ${item.name}`)
    .setDescription(item.description || "_No description._")
    .addFields(
      { name: "Effect", value: `${item.effectType} → ${item.target}`, inline: true },
      { name: "Power", value: String(item.power), inline: true },
      { name: "Status", value: item.statusKind ?? "—", inline: true },
      { name: "Duration", value: `${item.duration} turn(s)`, inline: true },
      { name: "Cooldown", value: `${item.cooldown} turn(s)`, inline: true },
      { name: "Charges", value: `${item.charges}×`, inline: true },
      { name: "Category", value: item.category, inline: true },
      { name: "Rarity", value: item.rarity, inline: true },
      { name: "Enabled", value: item.enabled ? "✅ yes" : "🚫 no", inline: true },
    )
    .setFooter({ text: isDefault ? "Built-in default (edits create a per-server override)" : "Custom item" });

  const fxRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(`battleadmin:itemfx:${id}`).setPlaceholder("Effect type")
      .addOptions(EFFECT_TYPES.map(t => ({ label: t, value: t, default: t === item.effectType }))),
  );
  const targetRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(`battleadmin:itemtarget:${id}`).setPlaceholder("Target")
      .addOptions(ITEM_TARGETS.map(t => ({ label: t, value: t, default: t === item.target }))),
  );
  const statusRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(`battleadmin:itemstatus:${id}`).setPlaceholder("Status effect (for buff/debuff/status)")
      .addOptions(
        { label: "none", value: "__none__", default: !item.statusKind },
        ...ITEM_STATUS_KINDS.map(k => ({ label: k, value: k, default: k === item.statusKind })),
      ),
  );
  const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`battleadmin:itemtext:${id}`).setLabel("Edit Text & Numbers").setEmoji("📝").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`battleadmin:itemtoggle:${id}`).setLabel(item.enabled ? "Disable" : "Enable").setStyle(item.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`battleadmin:itemdelete:${id}`).setLabel(isDefault ? "Reset to Default" : "Delete").setEmoji("🗑️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("battleadmin:itemmgr").setLabel("Back").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [fxRow, targetRow, statusRow, btnRow] };
}

async function buildItemTextModal(guildId: string, id: string): Promise<ModalBuilder> {
  const item = (await effectiveItem(guildId, id)) ?? coerceBattleItem(id, {});
  const input = (cid: string, label: string, value: string, style = TextInputStyle.Short, required = false) =>
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId(cid).setLabel(label).setStyle(style).setRequired(required).setValue(value.slice(0, 400)),
    );
  return new ModalBuilder()
    .setCustomId(`battleadmin:itemtext:${id}`)
    .setTitle(`Edit ${item.name}`.slice(0, 45))
    .addComponents(
      input("name", "Name", item.name, TextInputStyle.Short, true),
      input("emoji", "Emoji", item.emoji),
      input("desc", "Description", item.description, TextInputStyle.Paragraph),
      input("power", "Power (heal/shield/damage = % HP; energy = flat)", String(item.power)),
      input("tuning", "Duration / Cooldown / Charges (e.g. 2 3 1)", `${item.duration} ${item.cooldown} ${item.charges}`),
    );
}

// ── Move Library ─────────────────────────────────────────────────────────────
// Data-driven CRUD over the moveset registry (kind "move" in battle_content).
// A card's Special is driven by its moveset, so custom/overridden moves flow
// straight into combat, prep, the AI, and card previews.
const MOVE_KINDS: MovesetKind[] = ["strike", "effect"];
const MOVE_EFFECTS = [...SPECIAL_EFFECT_KEYS, "stealth", "weaken"];

function movesetToData(m: Moveset): Record<string, unknown> {
  return { ...m } as Record<string, unknown>;
}

async function effectiveMove(guildId: string, key: string): Promise<Moveset | null> {
  invalidateGuildMovesets(guildId);
  await loadGuildMovesets(guildId);
  return getMoveset(key, guildId);
}

async function buildMoveManager(guildId: string): Promise<{ embeds: EmbedBuilder[]; components: ActionRowBuilder<any>[] }> {
  invalidateGuildMovesets(guildId);
  await loadGuildMovesets(guildId);
  const moves = listAllMovesets(guildId).sort((a, b) => a.name.localeCompare(b.name));
  const overrides = new Set((await listBattleContent(guildId, "move")).map(r => r.contentId));
  const defaultKeys = new Set(listDefaultMovesets().map(m => m.key));

  const lines = moves.slice(0, 40).map(m => {
    const tag = !defaultKeys.has(m.key) ? "🆕" : overrides.has(m.key) ? "✏️" : "▫️";
    const kind = m.kind === "strike" ? `strike ${m.powerPct ?? 0}%${m.followUpPct ? `+${m.followUpPct}%` : ""}` : `effect: ${m.effect ?? "—"}`;
    return `${tag} ${m.emoji} **${m.name}** — ${kind} · ⚡${m.energyCost}`;
  });
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("⚔️ Move Library")
    .setDescription(
      "Create custom signature moves or override the built-in ones. A card's Special is driven by its move, so changes apply in combat, prep, the AI, and previews.\n"
      + "🆕 custom · ✏️ default overridden · ▫️ built-in default\n\n"
      + (lines.join("\n") || "_No moves._"),
    );
  const pickRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId("battleadmin:movepick").setPlaceholder("✏️ Edit a move…")
      .addOptions(moves.slice(0, 25).map(m => ({
        label: m.name.slice(0, 100), emoji: m.emoji, value: m.key,
        description: (m.kind === "strike" ? `strike ${m.powerPct ?? 0}%` : `effect ${m.effect ?? ""}`).slice(0, 100),
      }))),
  );
  const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("battleadmin:movenew").setLabel("New Move").setEmoji("➕").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("battleadmin:hub").setLabel("Back").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [pickRow, btnRow] };
}

async function buildMoveEditor(guildId: string, key: string): Promise<{ embeds: EmbedBuilder[]; components: ActionRowBuilder<any>[] }> {
  const move = await effectiveMove(guildId, key);
  if (!move) return buildMoveManager(guildId);
  const isDefault = listDefaultMovesets().some(m => m.key === key);
  const rows = await listBattleContent(guildId, "move");
  const enabled = rows.find(r => r.contentId === key)?.enabled ?? true;
  const types = move.allowedTypes === "all" ? "all" : move.allowedTypes.join(", ");

  const embed = new EmbedBuilder()
    .setColor(enabled ? 0x2ecc71 : 0x95a5a6)
    .setTitle(`${move.emoji} ${move.name}`)
    .setDescription(move.description || "_No description._")
    .addFields(
      { name: "Kind", value: move.kind, inline: true },
      { name: "Energy", value: `⚡${move.energyCost}`, inline: true },
      { name: "Effect", value: move.effect ?? "—", inline: true },
      { name: "Power %", value: String(move.powerPct ?? "—"), inline: true },
      { name: "Follow-up %", value: String(move.followUpPct ?? "—"), inline: true },
      { name: "Enabled", value: enabled ? "✅ yes" : "🚫 no", inline: true },
      { name: "Allowed types", value: types, inline: false },
    )
    .setFooter({ text: isDefault ? "Built-in default (edits create a per-server override)" : "Custom move" });

  const kindRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(`battleadmin:movekind:${key}`).setPlaceholder("Kind")
      .addOptions(MOVE_KINDS.map(k => ({ label: k, value: k, default: k === move.kind }))),
  );
  const effectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(`battleadmin:moveeffect:${key}`).setPlaceholder("Effect (for kind = effect)")
      .addOptions(
        { label: "none (pure strike)", value: "__none__", default: !move.effect },
        ...MOVE_EFFECTS.slice(0, 24).map(e => ({ label: e, value: e, default: e === move.effect })),
      ),
  );
  const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`battleadmin:movetext:${key}`).setLabel("Edit Text & Numbers").setEmoji("📝").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`battleadmin:movetoggle:${key}`).setLabel(enabled ? "Disable" : "Enable").setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`battleadmin:movedelete:${key}`).setLabel(isDefault ? "Reset to Default" : "Delete").setEmoji("🗑️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("battleadmin:movemgr").setLabel("Back").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [kindRow, effectRow, btnRow] };
}

async function buildMoveTextModal(guildId: string, key: string): Promise<ModalBuilder> {
  const move = (await effectiveMove(guildId, key)) ?? coerceMoveset(key, {});
  const input = (cid: string, label: string, value: string, style = TextInputStyle.Short, required = false) =>
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId(cid).setLabel(label).setStyle(style).setRequired(required).setValue(value.slice(0, 200)),
    );
  const types = move.allowedTypes === "all" ? "all" : move.allowedTypes.join(", ");
  return new ModalBuilder()
    .setCustomId(`battleadmin:movetext:${key}`)
    .setTitle(`Edit ${move.name}`.slice(0, 45))
    .addComponents(
      input("name", "Name", move.name, TextInputStyle.Short, true),
      input("emoji", "Emoji", move.emoji),
      input("desc", "Description", move.description, TextInputStyle.Paragraph),
      input("nums", "Energy / Power% / Follow-up% (e.g. 40 160 90)", `${move.energyCost} ${move.powerPct ?? 0} ${move.followUpPct ?? 0}`),
      input("types", "Allowed types (comma list or 'all')", types),
    );
}

// ── Passive Library ──────────────────────────────────────────────────────────
// Data-driven CRUD over auto-triggering passive abilities (kind "passive"). A
// passive is assigned to a card in the card editor and fires automatically in
// combat (battle_start or turn_start).
const PASSIVE_TRIGGERS: PassiveTrigger[] = ["battle_start", "turn_start"];
const PASSIVE_EFFECTS: PassiveEffect[] = ["regen", "shield", "buff", "energy", "reflect", "stealth"];

function passiveToData(p: Passive): Record<string, unknown> {
  return { ...p } as Record<string, unknown>;
}

async function effectivePassive(guildId: string, id: string): Promise<Passive | null> {
  invalidateGuildPassives(guildId);
  await loadGuildPassives(guildId);
  return getPassive(id, guildId);
}

async function buildPassiveManager(guildId: string): Promise<{ embeds: EmbedBuilder[]; components: ActionRowBuilder<any>[] }> {
  invalidateGuildPassives(guildId);
  await loadGuildPassives(guildId);
  const passives = listAllPassives(guildId).sort((a, b) => a.name.localeCompare(b.name));
  const overrides = new Set((await listBattleContent(guildId, "passive")).map(r => r.contentId));
  const defaultIds = new Set(listDefaultPassives().map(p => p.id));

  const lines = passives.slice(0, 40).map(p => {
    const tag = !defaultIds.has(p.id) ? "🆕" : overrides.has(p.id) ? "✏️" : "▫️";
    const off = p.enabled ? "" : " · _disabled_";
    return `${tag} ${p.emoji} **${p.name}** — ${p.trigger} · ${p.effect} ${p.magnitude}${off}`;
  });
  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle("✨ Passive Library")
    .setDescription(
      "Auto-triggering abilities a card carries into battle. Assign one to a card in **Cards → Edit Card**; it fires on its own (battle start or each turn).\n"
      + "🆕 custom · ✏️ default overridden · ▫️ built-in default\n\n"
      + (lines.join("\n") || "_No passives._"),
    );
  const pickRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId("battleadmin:passivepick").setPlaceholder("✏️ Edit a passive…")
      .addOptions(passives.slice(0, 25).map(p => ({
        label: p.name.slice(0, 100), emoji: p.emoji, value: p.id,
        description: `${p.trigger} · ${p.effect} ${p.magnitude}`.slice(0, 100),
      }))),
  );
  const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("battleadmin:passnew").setLabel("New Passive").setEmoji("➕").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("battleadmin:hub").setLabel("Back").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [pickRow, btnRow] };
}

async function buildPassiveEditor(guildId: string, id: string): Promise<{ embeds: EmbedBuilder[]; components: ActionRowBuilder<any>[] }> {
  const p = await effectivePassive(guildId, id);
  if (!p) return buildPassiveManager(guildId);
  const isDefault = listDefaultPassives().some(x => x.id === id);

  const embed = new EmbedBuilder()
    .setColor(p.enabled ? 0x2ecc71 : 0x95a5a6)
    .setTitle(`${p.emoji} ${p.name}`)
    .setDescription(p.description || "_No description._")
    .addFields(
      { name: "Trigger", value: p.trigger, inline: true },
      { name: "Effect", value: p.effect, inline: true },
      { name: "Magnitude", value: String(p.magnitude), inline: true },
      { name: "Enabled", value: p.enabled ? "✅ yes" : "🚫 no", inline: true },
    )
    .setFooter({ text: isDefault ? "Built-in default (edits create a per-server override)" : "Custom passive" });

  const triggerRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(`battleadmin:passtrigger:${id}`).setPlaceholder("Trigger")
      .addOptions(PASSIVE_TRIGGERS.map(t => ({ label: t, value: t, default: t === p.trigger }))),
  );
  const effectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(`battleadmin:passeffect:${id}`).setPlaceholder("Effect")
      .addOptions(PASSIVE_EFFECTS.map(e => ({ label: e, value: e, default: e === p.effect }))),
  );
  const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`battleadmin:passtext:${id}`).setLabel("Edit Text & Magnitude").setEmoji("📝").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`battleadmin:passtoggle:${id}`).setLabel(p.enabled ? "Disable" : "Enable").setStyle(p.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`battleadmin:passdelete:${id}`).setLabel(isDefault ? "Reset to Default" : "Delete").setEmoji("🗑️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("battleadmin:passivemgr").setLabel("Back").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [triggerRow, effectRow, btnRow] };
}

async function buildPassiveTextModal(guildId: string, id: string): Promise<ModalBuilder> {
  const p = (await effectivePassive(guildId, id)) ?? coercePassive(id, {});
  const input = (cid: string, label: string, value: string, style = TextInputStyle.Short, required = false) =>
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId(cid).setLabel(label).setStyle(style).setRequired(required).setValue(value.slice(0, 200)),
    );
  return new ModalBuilder()
    .setCustomId(`battleadmin:passtext:${id}`)
    .setTitle(`Edit ${p.name}`.slice(0, 45))
    .addComponents(
      input("name", "Name", p.name, TextInputStyle.Short, true),
      input("emoji", "Emoji", p.emoji),
      input("desc", "Description", p.description, TextInputStyle.Paragraph),
      input("magnitude", "Magnitude (% HP / % attack / flat energy)", String(p.magnitude)),
    );
}

function confirmRow(confirmAction: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`battleadmin:${confirmAction}`).setLabel("Confirm").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("battleadmin:noop").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
  );
}

// ── Modals ───────────────────────────────────────────────────────────────────
function shortInput(id: string, label: string, value: string | number, ph?: string): ActionRowBuilder<TextInputBuilder> {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short)
      .setRequired(false).setValue(String(value)).setPlaceholder(ph ?? String(value)),
  );
}

function buildRulesModal(s: Awaited<ReturnType<typeof getBattleSettings>>): ModalBuilder {
  return new ModalBuilder().setCustomId("battleadmin:rules").setTitle("Combat Rules").addComponents(
    shortInput("turn", "Turn timer (seconds, 10-300)", s.turnTimerSeconds),
    shortInput("crit", "Critical chance % (0-100)", s.critChancePct),
    shortInput("miss", "Miss chance % (0-90)", s.missChancePct),
    shortInput("dodge", "Dodge chance % (0-90)", s.dodgeChancePct),
    shortInput("shield", "Shield strength % of max HP (0-100)", s.shieldStrengthPct),
  );
}

function buildFormulasModal(s: Awaited<ReturnType<typeof getBattleSettings>>): ModalBuilder {
  return new ModalBuilder().setCustomId("battleadmin:formulas").setTitle("Stat Formulas").addComponents(
    shortInput("hp", "Base HP", s.hpBase),
    shortInput("atk", "Base Attack", s.attackBase),
    shortInput("def", "Base Defense", s.defenseBase),
    shortInput("energy", "Energy gain / turn", s.energyGainPerTurn),
    shortInput("ult", "Ultimate charge / turn", s.ultimateChargePerTurn),
  );
}

function buildRewardsModal(s: Awaited<ReturnType<typeof getBattleSettings>>): ModalBuilder {
  return new ModalBuilder().setCustomId("battleadmin:rewards").setTitle("Rewards").addComponents(
    shortInput("winshards", "Shards on win", s.rewardWinShards),
    shortInput("lossshards", "Shards on loss", s.rewardLossShards),
    shortInput("winxp", "XP on win", s.rewardWinXp),
    shortInput("dailylimit", "Daily rewarded-battles cap", s.dailyRewardLimit),
    shortInput("packstreak", "Free pack every N win streak (0=off)", s.freePackStreak),
  );
}

// Step 1 of the card editor: search by name.
function buildCardSearchModal(): ModalBuilder {
  return new ModalBuilder().setCustomId("battleadmin:editcard").setTitle("Edit a Battle Card").addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("name").setLabel("Card name (search)").setStyle(TextInputStyle.Short)
        .setRequired(true).setPlaceholder("Type any card name — exact match, partial match, or acronym…")),
  );
}

// Stats modal (opened from the editor panel), prefilled with current overrides.
async function buildStatsModal(guildId: string, cardId: number): Promise<ModalBuilder> {
  const cfg = await getBattleCardConfig(guildId, cardId);
  const val = (n: number | null | undefined) => (n == null ? "" : String(n));
  return new ModalBuilder().setCustomId(`battleadmin:bcstats:${cardId}`).setTitle("Battle Stat Overrides").addComponents(
    statInput("health", "Health (blank = auto)", val(cfg?.health)),
    statInput("attack", "Attack (blank = auto)", val(cfg?.attack)),
    statInput("defense", "Defense (blank = auto)", val(cfg?.defense)),
    statInput("speed", "Speed (blank = auto)", val(cfg?.speed)),
    statInput("crit", "Critical chance % (blank = auto)", val(cfg?.critChance)),
  );
}

function statInput(id: string, label: string, value: string): ActionRowBuilder<TextInputBuilder> {
  const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder("auto");
  if (value) t.setValue(value);
  return new ActionRowBuilder<TextInputBuilder>().addComponents(t);
}

// ── Battle Card Editor panel ─────────────────────────────────────────────────
// Search-then-edit: shows one card's battle profile with live-derived stats and
// dropdowns/buttons to override its battle rarity, special effect, individual
// stats, enable/disable, or reset — all WITHOUT touching the real card.
async function buildCardEditorPanel(
  guildId: string, cardId: number,
): Promise<{ embeds: EmbedBuilder[]; components: ActionRowBuilder<any>[] } | null> {
  const [card, cfg, settings, rd, statCtx] = await Promise.all([
    getCardById(cardId, guildId), getBattleCardConfig(guildId, cardId), getBattleSettings(guildId),
    rarityDisplay(guildId), getRarityContext(guildId).catch(() => null),
  ]);
  if (!card) return null;

  const battleRarity = (cfg?.rarity as Rarity) || (card.rarity as Rarity);
  const cardBase = { id: card.id, name: card.name, rarity: card.rarity as Rarity, worthValue: card.worthValue, cardType: card.cardType };
  // Rank on the guild strength ladder so the admin preview matches real combat.
  const rank = rarityLadderRank(cfg?.rarity ? String(cfg.rarity) : (statCtx ? effectiveRarityKey(cardBase, statCtx) : card.rarity), statCtx);
  // Preview at Lv 1 (base) and Lv 100 (max) — stats scale up with the owner's card level in play.
  const derivedLv1 = getScaledStats(cardBase, cfg ?? null, settings, 1, battleRarity, 0, rank);
  const derivedLv100 = getScaledStats(cardBase, cfg ?? null, settings, 100, battleRarity, 0, rank);
  const ov = (label: string, val: number, overridden: boolean) => `${label}: **${val}**${overridden ? " ✏️" : ""}`;
  const effectKey = cfg?.specialEffect ?? inferSpecialEffect(card.cardType, battleRarity);
  const effectDef = getEffectDef(effectKey);
  const moveset = getMoveset(cfg?.moveset ?? inferMoveset(card.cardType, battleRarity));

  const movesetDisplay = moveset
    ? `${moveset.emoji} **${moveset.name}** · ${moveset.energyCost}⚡${cfg?.moveset ? " ✏️" : " (auto)"}\n_${moveset.description}_`
    : "—";
  const specialDisplay = effectDef
    ? `${effectDef.emoji} **${effectDef.label}**${cfg?.specialEffect ? " ✏️" : " (auto)"}\n_${effectDef.description}_`
    : "—";
  const maxLevelBonus = settings.levelMaxBonusPct ?? 150;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🎴 Battle Editor — ${card.name}`)
    .setDescription(
      `Real card rarity: **${rd.label(card.rarity as Rarity)}** (unchanged). ` +
      `Everything here is battle-only. ✏️ = overridden.`,
    )
    .addFields(
      { name: "Battle Rarity", value: `${rd.emoji(battleRarity)} ${rd.label(battleRarity)}${cfg?.rarity ? " ✏️" : " (auto)"}`, inline: true },
      { name: "Usable", value: (cfg?.enabled ?? true) ? "✅ Yes" : "🚫 Disabled", inline: true },
      { name: "As Special Card", value: specialDisplay, inline: false },
      { name: "Signature Move", value: movesetDisplay, inline: false },
      { name: "Stats", value:
        `Lv 1: ${ov("HP", derivedLv1.maxHealth, cfg?.health != null)} · ${ov("Atk", derivedLv1.attack, cfg?.attack != null)} · ${ov("Def", derivedLv1.defense, cfg?.defense != null)} · ${ov("Spd", derivedLv1.speed, cfg?.speed != null)} · ${ov("Crit%", derivedLv1.critChance, cfg?.critChance != null)} · Luck ${derivedLv1.luck}\n` +
        `Lv 100: ${ov("HP", derivedLv100.maxHealth, cfg?.health != null)} · ${ov("Atk", derivedLv100.attack, cfg?.attack != null)} · ${ov("Def", derivedLv100.defense, cfg?.defense != null)} · ${ov("Spd", derivedLv100.speed, cfg?.speed != null)} · ${ov("Crit%", derivedLv100.critChance, cfg?.critChance != null)} · Luck ${derivedLv100.luck}`,
        inline: false },
      { name: "Level Scaling", value: `Stats scale from **Lv 1** → **Lv 100** (max +${maxLevelBonus}% total bonus). A player's actual card level is used in real battles.`, inline: false },
    )
    .setFooter({ text: "Changes save instantly, for this server only." });
  const thumb = toAbsoluteImageUrl(card.imageUrl);
  if (thumb) embed.setThumbnail(thumb);

  const rarityRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(`battleadmin:bcrarity:${cardId}`).setPlaceholder("🎖️ Battle rarity")
      .addOptions(
        { label: "Auto (use real rarity)", value: "__auto__", default: !cfg?.rarity },
        ...RARITY_ORDER.map(r => ({ label: rd.label(r), emoji: rd.emoji(r), value: r, default: cfg?.rarity === r })),
      ),
  );
  const specialRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(`battleadmin:bcspecial:${cardId}`).setPlaceholder("✨ Special effect (when used as support card)")
      .addOptions(
        { label: "Auto (infer from type)", value: "__auto__", default: !cfg?.specialEffect },
        ...SPECIAL_EFFECT_KEYS.map(k => {
          const d = getEffectDef(k)!;
          return { label: d.label, emoji: d.emoji, value: k, description: d.description.slice(0, 90), default: cfg?.specialEffect === k };
        }),
      ),
  );
  const movesetRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(`battleadmin:bcmoveset:${cardId}`).setPlaceholder("⚔️ Signature move (the card's Special)")
      .addOptions(
        { label: "Auto (infer from type)", value: "__auto__", default: !cfg?.moveset },
        ...MOVESETS_FOR_PICKER.map(m => ({
          label: m.name, emoji: m.emoji, value: m.key,
          description: m.description.slice(0, 90), default: cfg?.moveset === m.key,
        })),
      ),
  );
  // Passive ability picker (auto-triggering). Pulls the guild's effective passives.
  await loadGuildPassives(guildId);
  const passiveOpts = listPassives(guildId).slice(0, 24);
  const passiveRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(`battleadmin:bcpassive:${cardId}`).setPlaceholder("✨ Passive ability (auto-triggers)")
      .addOptions(
        { label: "None", value: "__none__", default: !cfg?.passive },
        ...passiveOpts.map(p => ({
          label: p.name, emoji: p.emoji, value: p.id,
          description: `${p.trigger} · ${p.effect} ${p.magnitude}`.slice(0, 90), default: cfg?.passive === p.id,
        })),
      ),
  );
  const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`battleadmin:bcstats:${cardId}`).setLabel("Edit Stats").setEmoji("✏️").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`battleadmin:bctoggle:${cardId}`).setLabel((cfg?.enabled ?? true) ? "Disable" : "Enable").setEmoji("🔀").setStyle((cfg?.enabled ?? true) ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`battleadmin:bcreset:${cardId}`).setLabel("Reset to Auto").setEmoji("♻️").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [rarityRow, movesetRow, passiveRow, specialRow, btnRow] };
}

// ── Card search scoring (mirrors /dnvaluesearch) ─────────────────────────────
function cardNameAcronym(card: Card): string {
  return card.name
    .split(/[^a-zA-Z0-9]+/)
    .map((w) => w[0])
    .join("")
    .toLowerCase();
}

function matchCardScore(card: Card, query: string): number {
  const q = query.toLowerCase().trim().replace(/\s+/g, " ");
  if (!q) return 0;
  const tokens = q.split(/\s+/).filter(Boolean);
  const name = card.name.toLowerCase();
  const desc = (card.description ?? "").toLowerCase();
  const type = (card.cardType ?? "").toLowerCase();
  const rarity = (card.rarity ?? "").toLowerCase();
  const compactName = name.replace(/[^a-zA-Z0-9]/g, "");
  const acronym = cardNameAcronym(card);

  let score = 0;
  for (const token of tokens) {
    if (!token) continue;
    let tokenScore = 0;
    if (name === token) tokenScore = 100;
    else if (name.startsWith(token + " ")) tokenScore = 80;
    else if (name.includes(token)) tokenScore = 60;
    else if (compactName.includes(token)) tokenScore = 50;
    else if (acronym.includes(token)) tokenScore = 45;
    else if (desc.includes(token)) tokenScore = 30;
    else if (type.includes(token)) tokenScore = 20;
    else if (rarity.includes(token)) tokenScore = 20;
    score += tokenScore;
  }
  // Tiny tie-breaker for higher-value cards, like DN values.
  score += (card.worthValue ?? 0) / 1_000_000;
  return score;
}

// ── Admin gating ─────────────────────────────────────────────────────────────
function ensureAdminInline(interaction: ButtonInteraction): boolean {
  if (!interaction.guild) return false;
  if (interaction.guild.ownerId === interaction.user.id) return true;
  return !!interaction.memberPermissions?.has("Administrator");
}

async function ensureAdmin(
  interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction | ChannelSelectMenuInteraction | ModalSubmitInteraction,
  useFollowUp = false,
): Promise<boolean> {
  if (!interaction.guild) return false;
  const allowed =
    interaction.guild.ownerId === interaction.user.id ||
    interaction.memberPermissions?.has("Administrator") ||
    (await isAdmin(interaction.guild.id, interaction.user.id));
  if (!allowed) {
    const msg = "❌ Only admins can use the Battle Admin Hub.";
    if (useFollowUp) await interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    else if ("editReply" in interaction) await interaction.editReply(msg).catch(() => {});
  }
  return !!allowed;
}
