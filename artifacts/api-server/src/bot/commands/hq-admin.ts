// ─────────────────────────────────────────────────────────────────────────────
// /hqadmin — admin editor for a player's Headquarters & siege state.
//
// Part of the HQ addon: lets a server admin fix or reset a member's HQ without
// touching the base game. Everything here only reads/writes the HQ's own tables
// (via bot/hq/db.ts) — grant/revoke earned cosmetics, set the cached HQ level,
// reset a stuck base capture, and clear defenders/placements. Admin-gated the
// same way as /admin and /edit-user.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  ChatInputCommandInteraction, ButtonInteraction, ModalSubmitInteraction, StringSelectMenuInteraction,
} from "discord.js";
import {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
  ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder,
} from "discord.js";
import { isAdmin } from "../db.js";
import {
  getOrCreateHq, updateHq, getUnlockedItemIds, grantUnlock,
  clearUnlocks, clearAllDefenders, clearAllPlacements, resetBaseState, getBaseState,
} from "../hq/db.js";
import { reconcileUnlocks } from "../hq/engine.js";
import { HQ_DECORATIONS } from "../hq/defs/decorations.js";
import { HQ_ROOMS } from "../hq/defs/rooms.js";
import { HQ_THEMES } from "../hq/defs/themes.js";
import { HQ_WALLS } from "../hq/defs/walls.js";
import { HQ_FLOORS } from "../hq/defs/floors.js";
import { HQ_WALLPAPERS } from "../hq/defs/wallpapers.js";
import { HQ_SURFACES } from "../hq/defs/surfaces.js";
import { clearAllTerrain } from "../hq/terrain.js";
import {
  getSiegeConfig, updateSiegeConfig, resolveSiegeMode, siegeModeMeta,
  SIEGE_MODES, SIEGE_LIMITS,
} from "../hq/settings.js";
import { getBattleSettings } from "../battle/config-engine.js";
import { statusThemeLabel } from "../battle/status-hud.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

async function checkAdmin(
  interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
): Promise<boolean> {
  if (!interaction.guild) return false;
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (member?.permissions.has("Administrator")) return true;
  return isAdmin(interaction.guild.id, interaction.user.id);
}

// Grant every cosmetic (each registry item) to the target — a fast "unlock all".
async function grantEverything(guildId: string, userId: string): Promise<void> {
  for (const d of HQ_DECORATIONS) await grantUnlock(guildId, userId, d.id, "decoration", "admin").catch(() => {});
  for (const r of HQ_ROOMS) await grantUnlock(guildId, userId, r.id, "room", "admin").catch(() => {});
  for (const t of HQ_THEMES) await grantUnlock(guildId, userId, t.id, "theme", "admin").catch(() => {});
  for (const w of HQ_WALLS) await grantUnlock(guildId, userId, w.id, "wall", "admin").catch(() => {});
  for (const f of HQ_FLOORS) await grantUnlock(guildId, userId, f.id, "floor", "admin").catch(() => {});
  for (const p of HQ_WALLPAPERS) await grantUnlock(guildId, userId, p.id, "wallpaper", "admin").catch(() => {});
  for (const s of HQ_SURFACES) await grantUnlock(guildId, userId, s.id, "material", "admin").catch(() => {});
}

// ── Slash entry ───────────────────────────────────────────────────────────────
// `/hqadmin` with no user opens the SERVER panel (the siege ruleset every member
// plays under); with a user it opens that member's HQ editor.
export async function handleHqAdminCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "❌ Server only.", ...EPHEMERAL }).catch(() => {});
    return;
  }
  if (!(await checkAdmin(interaction))) {
    await interaction.reply({ content: "❌ Admins only.", ...EPHEMERAL }).catch(() => {});
    return;
  }
  const target = interaction.options.getUser("user");
  const panel = target
    ? await buildPanel(interaction.guildId, target.id, target.username)
    : await buildServerPanel(interaction.guildId);
  await interaction.reply({ ...panel, ...EPHEMERAL }).catch(() => {});
}

// ── Server panel: the siege ruleset ───────────────────────────────────────────
// How a siege plays is a SERVER decision, exactly like `/battle`'s animation
// settings — so members are never asked to pick a presentation before they can
// attack, and every assault in the guild looks the same.
async function buildServerPanel(guildId: string, notice?: string) {
  const cfg = await getSiegeConfig(guildId);
  const battle = await getBattleSettings(guildId).catch(() => null);
  const mode = siegeModeMeta(cfg.mode);
  const visualStyle = !cfg.turnVisuals ? "off"
    : battle?.battleAnimationEnabled === false ? "off (battles have animation disabled)"
    : battle?.battleSceneAnimated ? "animated arena scenes"
    : "classic single frames";

  const embed = new EmbedBuilder()
    .setColor(0xb5382c)
    .setTitle("🏰 HQ Server Settings — Sieges")
    .setDescription(
      "How **every** siege in this server plays out. Members don't choose this — they just attack, " +
      `and the assault runs the way you set it here.${notice ? `\n\n✅ ${notice}` : ""}`,
    )
    .addFields(
      { name: `${mode.emoji} Siege style`, value: `**${mode.label}** — ${mode.blurb}`, inline: false },
      { name: "🎥 Opening film", value: cfg.intro ? "**On** — plays before the assault" : "**Off**", inline: true },
      { name: "⏱️ Turn clock", value: `**${cfg.turnSeconds}s**`, inline: true },
      { name: "🎒 Field items", value: `**${cfg.itemUses}** per assault`, inline: true },
      { name: "🖼️ Turn visuals", value: `**${visualStyle}**\n_Style follows your \`/battle_admin\` animation settings._\nStatus layout **${statusThemeLabel(battle?.battleStatusTheme)}**`, inline: true },
      { name: "🔁 Turn cap", value: `**${cfg.maxTurns}** turns`, inline: true },
    );
  if (cfg.mode === "turn" && battle && !battle.enabled) {
    embed.addFields({
      name: "⚠️ Battles are disabled",
      value: "Turn-for-turn sieges run on the battle engine, so they can't start while `/battle` is off. Enable battles or pick another siege style.",
    });
  }

  const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId("hqadmin:srv:mode").setPlaceholder("⚔️ Siege style for this server…")
        .addOptions(SIEGE_MODES.map(m => ({
          label: m.label, value: m.id, description: m.blurb.slice(0, 100),
          emoji: m.emoji, default: m.id === cfg.mode,
        }))),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("hqadmin:srv:intro").setLabel(cfg.intro ? "Opening film: On" : "Opening film: Off")
        .setEmoji("🎥").setStyle(cfg.intro ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("hqadmin:srv:visuals").setLabel(cfg.turnVisuals ? "Turn visuals: On" : "Turn visuals: Off")
        .setEmoji("🖼️").setStyle(cfg.turnVisuals ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("hqadmin:srv:timing").setLabel("Clock, items & cap")
        .setEmoji("⏱️").setStyle(ButtonStyle.Primary),
    ),
  ];
  return { embeds: [embed], components: rows };
}

async function buildPanel(guildId: string, targetId: string, targetName: string, notice?: string) {
  const hq = await getOrCreateHq(guildId, targetId);
  const owned = await getUnlockedItemIds(guildId, targetId);
  const state = await getBaseState(guildId, targetId);
  const held = state?.heldByUserId ? `🚩 held by ${state.heldByName ?? "a rival"}` : "not captured";
  const totalItems = HQ_DECORATIONS.length + HQ_ROOMS.length + HQ_THEMES.length + HQ_WALLS.length + HQ_FLOORS.length;

  const embed = new EmbedBuilder()
    .setColor(0xb5382c)
    .setTitle(`🛠️ HQ Admin — ${targetName}`)
    .setDescription(`Editing **${targetName}**'s Headquarters. Changes touch only HQ data.${notice ? `\n\n✅ ${notice}` : ""}`)
    .addFields(
      { name: "HQ Level", value: `**${hq.hqLevel}**`, inline: true },
      { name: "Unlocks", value: `**${owned.size}** / ${totalItems}`, inline: true },
      { name: "Theme / Wall / Floor", value: `${hq.themeId} · ${hq.wallId} · ${hq.floorId}`, inline: false },
      { name: "Base", value: held, inline: true },
    );

  const rows = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`hqadmin:level:${targetId}`).setLabel("Set HQ Level").setEmoji("🔢").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`hqadmin:grantall:${targetId}`).setLabel("Unlock everything").setEmoji("🔓").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`hqadmin:reconcile:${targetId}`).setLabel("Re-sync from progress").setEmoji("🔄").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`hqadmin:resetbase:${targetId}`).setLabel("Reset base capture").setEmoji("🏳️").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`hqadmin:cleardef:${targetId}`).setLabel("Clear defenders").setEmoji("🛡️").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`hqadmin:revokeall:${targetId}`).setLabel("Revoke all unlocks").setEmoji("🧹").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`hqadmin:wipe:${targetId}`).setLabel("Wipe layout").setEmoji("🗑️").setStyle(ButtonStyle.Danger),
    ),
  ];
  return { embeds: [embed], components: rows };
}

// ── Component router ────────────────────────────────────────────────────────────
export async function handleHqAdminComponent(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<void> {
  if (!interaction.guildId) return;
  if (!(await checkAdmin(interaction))) { await interaction.reply({ content: "❌ Admins only.", ...EPHEMERAL }).catch(() => {}); return; }
  const guildId = interaction.guildId;

  // Server-wide siege settings (hqadmin:srv:<field>).
  if (interaction.customId.startsWith("hqadmin:srv:")) {
    await handleServerSetting(interaction, guildId);
    return;
  }

  if (!interaction.isButton()) return;
  const [, action, targetId] = interaction.customId.split(":");
  const targetName = (await interaction.guild?.members.fetch(targetId!).catch(() => null))?.user.username ?? "player";

  if (action === "level") {
    const hq = await getOrCreateHq(guildId, targetId!);
    const modal = new ModalBuilder().setCustomId(`hqadmin:setlevel:${targetId}`).setTitle("Set HQ Level")
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("level").setLabel("HQ level (1–100)").setStyle(TextInputStyle.Short)
          .setRequired(true).setMaxLength(3).setValue(String(hq.hqLevel))));
    await interaction.showModal(modal).catch(() => {});
    return;
  }

  let notice = "";
  if (action === "grantall") { await grantEverything(guildId, targetId!); notice = "Unlocked every theme, room, wall, floor, wallpaper, build material & decoration."; }
  else if (action === "revokeall") { await clearUnlocks(guildId, targetId!); notice = "Revoked all earned unlocks (they re-earn on next /hq)."; }
  else if (action === "reconcile") { await reconcileUnlocks(guildId, targetId!).catch(() => {}); notice = "Re-synced unlocks & HQ level from real progress."; }
  else if (action === "resetbase") { await resetBaseState(guildId, targetId!); notice = "Cleared base capture & shield."; }
  else if (action === "cleardef") { await clearAllDefenders(guildId, targetId!); notice = "Removed all base defenders."; }
  else if (action === "wipe") {
    await clearAllPlacements(guildId, targetId!);
    await clearAllDefenders(guildId, targetId!);
    await clearAllTerrain(guildId, targetId!).catch(() => {});
    notice = "Wiped placements, built terrain & defenders (layout reset).";
  }
  else return;

  await interaction.update(await buildPanel(guildId, targetId!, targetName, notice)).catch(() => {});
}

async function handleServerSetting(
  interaction: ButtonInteraction | StringSelectMenuInteraction, guildId: string,
): Promise<void> {
  const field = interaction.customId.split(":")[2];

  if (field === "mode" && interaction.isStringSelectMenu()) {
    const cfg = await updateSiegeConfig(guildId, { mode: resolveSiegeMode(interaction.values[0]) });
    await interaction.update(await buildServerPanel(guildId, `Sieges now run as **${siegeModeMeta(cfg.mode).label}**.`)).catch(() => {});
    return;
  }
  if (!interaction.isButton()) return;

  if (field === "timing") {
    const cfg = await getSiegeConfig(guildId);
    const modal = new ModalBuilder().setCustomId("hqadmin:srvtiming").setTitle("Siege clock, items & cap")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("turnSeconds")
            .setLabel(`Seconds per move (${SIEGE_LIMITS.turnSeconds.min}–${SIEGE_LIMITS.turnSeconds.max})`)
            .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3).setValue(String(cfg.turnSeconds)),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("itemUses")
            .setLabel(`Field items per assault (${SIEGE_LIMITS.itemUses.min}–${SIEGE_LIMITS.itemUses.max})`)
            .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(2).setValue(String(cfg.itemUses)),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("maxTurns")
            .setLabel(`Turn cap (${SIEGE_LIMITS.maxTurns.min}–${SIEGE_LIMITS.maxTurns.max})`)
            .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3).setValue(String(cfg.maxTurns)),
        ),
      );
    await interaction.showModal(modal).catch(() => {});
    return;
  }

  const cfg = await getSiegeConfig(guildId);
  let notice = "";
  if (field === "intro") {
    await updateSiegeConfig(guildId, { intro: !cfg.intro });
    notice = `Opening film ${cfg.intro ? "disabled" : "enabled"}.`;
  } else if (field === "visuals") {
    await updateSiegeConfig(guildId, { turnVisuals: !cfg.turnVisuals });
    notice = `Per-turn attack frames ${cfg.turnVisuals ? "disabled" : "enabled"}.`;
  } else return;

  await interaction.update(await buildServerPanel(guildId, notice)).catch(() => {});
}

// ── Modals ──────────────────────────────────────────────────────────────────────
export async function handleHqAdminModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.guildId) return;
  if (!(await checkAdmin(interaction))) return;

  if (interaction.customId === "hqadmin:srvtiming") {
    const read = (id: string, fallback: number) => {
      const n = Number(interaction.fields.getTextInputValue(id));
      return Number.isFinite(n) ? Math.round(n) : fallback;
    };
    const cur = await getSiegeConfig(interaction.guildId);
    await updateSiegeConfig(interaction.guildId, {
      turnSeconds: read("turnSeconds", cur.turnSeconds),
      itemUses: read("itemUses", cur.itemUses),
      maxTurns: read("maxTurns", cur.maxTurns),
    });
    const panel = await buildServerPanel(interaction.guildId, "Updated the siege clock, item budget and turn cap.");
    if (interaction.isFromMessage()) await interaction.update(panel).catch(() => {});
    else await interaction.reply({ ...panel, ...EPHEMERAL }).catch(() => {});
    return;
  }

  const [, , targetId] = interaction.customId.split(":"); // hqadmin:setlevel:<id>
  const raw = Number(interaction.fields.getTextInputValue("level"));
  const level = Math.max(1, Math.min(100, Number.isFinite(raw) ? Math.round(raw) : 1));
  await updateHq(interaction.guildId, targetId!, { hqLevel: level }).catch(() => {});
  const targetName = (await interaction.guild?.members.fetch(targetId!).catch(() => null))?.user.username ?? "player";
  const panel = await buildPanel(interaction.guildId, targetId!, targetName, `Set HQ level to ${level}.`);
  if (interaction.isFromMessage()) await interaction.update(panel).catch(() => {});
  else await interaction.reply({ ...panel, ...EPHEMERAL }).catch(() => {});
}

// Test seam for scripts/src/hq-smoke.ts: build the server siege panel without an
// interaction, so its payload can be checked against Discord's limits. The panel
// is button-driven and was silently unroutable before, which is exactly the kind
// of breakage a payload check catches.
export async function __buildServerPanelForTest(guildId: string) {
  return buildServerPanel(guildId);
}
