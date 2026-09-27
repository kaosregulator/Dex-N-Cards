import {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  MessageFlags,
  type Message, type ChatInputCommandInteraction,
  type ButtonInteraction, type StringSelectMenuInteraction,
  type ModalSubmitInteraction, type GuildMember,
} from "discord.js";
import { BRAND_NAME } from "../help-banners.js";
import type { GuildSettings } from "@workspace/db";
import {
  isAdmin, getOrCreateGuildSettings, updateGuildSettings, addCard,
  loadDefaultCards, unloadDefaultCards, listSets, DEFAULTS_SET_NAME,
  getRarityDisplayOverrides,
} from "../db.js";
import { spawnCard, scheduleNextSpawn, clearSpawnTimer } from "../spawn-manager.js";
import { DEFAULT_CARDS, RARITY_WEIGHTS, type Rarity } from "../cards-data.js";
import { buildRatesEmbed, buildRatesComponents } from "./config-panel.js";

// ── Entry: !setup ────────────────────────────────────────────────────────────────────────────────────────
export async function startSetupWizard(msg: Message): Promise<void> {
  if (!msg.guild) return;
  const settings = await getOrCreateGuildSettings(msg.guild.id);
  const hasDefaults = await defaultsLoaded(msg.guild.id);
  await msg.reply({
    embeds: [buildSetupEmbed(settings, hasDefaults)],
    components: buildSetupComponents(settings, hasDefaults),
  });
}

// ── Entry: /setup (slash) ────────────────────────────────────────────────────────────────────────────────────
export async function handleSetupCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) return;
  // ACK immediately — isAdmin() is a DB call, easily past 3s without defer.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const ok = await ensureAdminSlash(interaction);
  if (!ok) return;
  const settings = await getOrCreateGuildSettings(interaction.guild.id);
  const hasDefaults = await defaultsLoaded(interaction.guild.id);
  await interaction.editReply({
    embeds: [buildSetupEmbed(settings, hasDefaults)],
    components: buildSetupComponents(settings, hasDefaults),
  });
}

// ── Button handler ──────────────────────────────────────────────────────────────────────────────────────────
export async function handleSetupButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) return;
  const [, action, arg] = interaction.customId.split(":");
  const guildId = interaction.guild.id;

  // ── Modal path: showModal() must be the first response — cannot defer first.
  // Fast inline check only; DB-admin check happens on modal submit.
  if (action === "testdrop") {
    const isOwner = interaction.guild.ownerId === interaction.user.id;
    const isDiscordAdmin = !!(interaction.memberPermissions?.has("Administrator"));
    if (!isOwner && !isDiscordAdmin && !(await isAdmin(guildId, interaction.user.id))) {
      await interaction.reply({ content: "❌ Admins only.", flags: MessageFlags.Ephemeral });
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId("setup_testcard")
      .setTitle("🧪 Test Drop")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("card_name")
            .setLabel("Test card name (will be droppable=false)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("e.g. Setup Test")
            .setRequired(true)
            .setMaxLength(64),
        ),
      );
    await interaction.showModal(modal).catch(() => {});
    return;
  }

  // ── All other buttons: defer first, then admin-check ─────────────────────
  await interaction.deferUpdate();
  if (!(await ensureAdmin(interaction))) return;

  if (action === "toggle" && arg === "spawn") {
    const s = await getOrCreateGuildSettings(guildId);
    const next = !s.spawnEnabled;
    await updateGuildSettings(guildId, { spawnEnabled: next });
    if (next) scheduleNextSpawn(guildId); else clearSpawnTimer(guildId);
  } else if (action === "toggle" && arg === "trade") {
    const s = await getOrCreateGuildSettings(guildId);
    await updateGuildSettings(guildId, { tradeEnabled: !s.tradeEnabled });
  } else if (action === "channel" && arg === "spawn") {
    await updateGuildSettings(guildId, { spawnChannelId: interaction.channelId });
    scheduleNextSpawn(guildId);
  } else if (action === "channel" && arg === "trade") {
    await updateGuildSettings(guildId, { tradeChannelId: interaction.channelId });
  } else if (action === "loaddefaults" || action === "copytemplate") {
    // "Use Default Set" — Vault Values roster (replaces the old Copy Home Set flow).
    const { added, skipped } = await loadDefaultCards(guildId);
    await refreshPanel(interaction, guildId);
    const settings = await getOrCreateGuildSettings(guildId);
    await interaction.followUp({
      content: `📦 **Default set** loaded — added **${added}** cards` +
        (skipped > 0 ? ` (skipped **${skipped}** already in your roster).` : ".") +
        `\nVehicles/soldiers preferred · site rarities (LE at top) · Exotic custom tier seeded.` +
        `\n\`/rarity\` nicknames & values still win. Remove with **🗑️ Remove Defaults** or \`${settings.commandPrefix}unloaddefaults\`.`,
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
    return;
  } else if (action === "cleardefaults") {
    // unloadDefaultCards deletes from the current server's cards table only.
    const { removed } = await unloadDefaultCards(guildId);
    await refreshPanel(interaction, guildId);
    await interaction.followUp({
      content: `🗑️ Removed **${removed}** default-set cards. Your custom cards are untouched.`,
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
    return;
  } else if (action === "rates") {
    // followUp = new ephemeral message after deferUpdate (can't editReply — that would replace the panel)
    const [settings, displayMap] = await Promise.all([
      getOrCreateGuildSettings(guildId),
      getRarityDisplayOverrides(guildId),
    ]);
    await interaction.followUp({
      embeds: [buildRatesEmbed(settings, displayMap)],
      components: buildRatesComponents(settings, displayMap),
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
    return;
  } else if (action === "done") {
    const settings = await getOrCreateGuildSettings(guildId);
    if (!settings.spawnChannelId) {
      await interaction.followUp({
        content: "❌ Pick a spawn channel first — go to your drops channel and click **📢 Spawn here**.",
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }
    await updateGuildSettings(guildId, { spawnEnabled: true });
    scheduleNextSpawn(guildId);
    // editReply replaces the setup panel with the "done" message.
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`✅ ${BRAND_NAME} is ready!`)
          .setColor(0x57f287)
          .setDescription(
            `Drops are live in <#${settings.spawnChannelId}>.\n\n` +
            `**👈 What to do next**\n` +
            `• **Post the welcome guide:** Go to your info channel and run \`/welcome\`\n` +
            `• **Add your own cards:** \`/cardadmin create\` with an image attachment\n` +
            `• **Test drops:** \`/cardadmin drop\` (force one) · \`/cardadmin mass_drop\` (batch)\n` +
            `• **Players need help?** \`/help\` (admins: open the **Admin** topic)\n\n` +
            `Re-open anytime: \`${settings.commandPrefix}setup\` or \`/setup\``,
          ),
      ],
      components: [],
    }).catch(() => {});
    return;
  }

  await refreshPanel(interaction, guildId);
}

// ── Select handler ────────────────────────────────────────────────────────────────────────────────────────
export async function handleSetupSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.guild) return;
  await interaction.deferUpdate();
  if (!(await ensureAdmin(interaction))) return;

  const guildId = interaction.guild.id;
  const action = interaction.customId;
  const value = interaction.values[0]!;

  const patch: Partial<GuildSettings> = {};
  if (action === "setup_mode") patch.catchMode = value;
  else if (action === "setup_drops") patch.cardsPerSpawn = parseInt(value, 10);
  else if (action === "setup_interval") {
    patch.useRandomInterval = false;
    patch.spawnIntervalSeconds = parseInt(value, 10);
  } else if (action === "setup_window") patch.catchWindowSeconds = parseInt(value, 10);

  await updateGuildSettings(guildId, patch);
  if (action === "setup_interval") scheduleNextSpawn(guildId);
  await refreshPanel(interaction, guildId);
}

// ── Modal handler (test card creation) ─────────────────────────────────────────────────────────────
export async function handleSetupModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.guild) return;
  if (interaction.customId !== "setup_testcard") return;
  // ACK immediately — DB reads happen before we can reply.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!(await ensureAdminModal(interaction))) return;

  const guildId = interaction.guild.id;
  const settings = await getOrCreateGuildSettings(guildId);
  if (!settings.spawnChannelId) {
    await interaction.editReply("❌ Pick a spawn channel first — click **📢 Spawn here** in your drops channel.");
    return;
  }

  const name = interaction.fields.getTextInputValue("card_name").slice(0, 64).trim();
  if (!name) {
    await interaction.editReply("❌ Card name was empty.");
    return;
  }

  try {
    const card = await addCard({
      name,
      description: `A test card created during setup. Safe to remove with \`${settings.commandPrefix}removecard ${name}\`.`,
      rarity: "common",
      cardType: "infantry",
      dropWeight: 60,
      worthValue: 10,
      burnValue: 5,
      droppable: false,
    }, guildId);
    await spawnCard(guildId, card.id, true);
    await interaction.editReply(
      `🧪 Test card **${name}** dropped in <#${settings.spawnChannelId}>. Go catch it!\nClean up later with \`${settings.commandPrefix}removecard ${name}\`.`,
    );
  } catch {
    await interaction.editReply("⚠️ Couldn't create the test card — a card with that name probably exists already. Try a different name.");
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function defaultsLoaded(guildId: string): Promise<boolean> {
  const sets = await listSets(guildId);
  return sets.some(s => s.setName === DEFAULTS_SET_NAME && s.cardCount > 0);
}

// Uses editReply — all callers must defer before calling this.
async function refreshPanel(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  guildId: string,
): Promise<void> {
  const settings = await getOrCreateGuildSettings(guildId);
  const hasDefaults = await defaultsLoaded(guildId);
  await interaction.editReply({
    embeds: [buildSetupEmbed(settings, hasDefaults)],
    components: buildSetupComponents(settings, hasDefaults),
  }).catch(() => {});
}

// Callers must deferUpdate first so editReply works correctly.
async function ensureAdmin(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): Promise<boolean> {
  if (!interaction.guild) return false;
  const perms = interaction.memberPermissions;
  const allowed =
    interaction.guild.ownerId === interaction.user.id ||
    perms?.has("Administrator") ||
    (await isAdmin(interaction.guild.id, interaction.user.id));
  if (!allowed) {
    await interaction.editReply({ content: "❌ Only admins can use the setup panel." }).catch(() => {});
  }
  return !!allowed;
}

// Callers must deferReply first so editReply works correctly.
async function ensureAdminModal(interaction: ModalSubmitInteraction): Promise<boolean> {
  if (!interaction.guild) return false;
  const member = (interaction.member as GuildMember | null);
  const allowed =
    interaction.guild.ownerId === interaction.user.id ||
    member?.permissions.has("Administrator") ||
    (await isAdmin(interaction.guild.id, interaction.user.id));
  if (!allowed) {
    await interaction.editReply("❌ Admins only.").catch(() => {});
  }
  return !!allowed;
}

// Callers must deferReply first so editReply works correctly.
async function ensureAdminSlash(interaction: ChatInputCommandInteraction): Promise<boolean> {
  if (!interaction.guild) return false;
  const member = interaction.member as GuildMember | null;
  const allowed =
    interaction.guild.ownerId === interaction.user.id ||
    member?.permissions.has("Administrator") ||
    (await isAdmin(interaction.guild.id, interaction.user.id));
  if (!allowed) {
    await interaction.editReply("❌ Only admins can use the setup panel.").catch(() => {});
  }
  return !!allowed;
}

function formatSec(sec: number): string {
  if (sec >= 3600) return `${Math.round(sec / 3600)}h`;
  if (sec >= 60) return `${Math.round(sec / 60)}m`;
  return `${sec}s`;
}

// ── Embed + components ────────────────────────────────────────────────────────────────────────────────────────
function buildSetupEmbed(s: GuildSettings, hasDefaults: boolean): EmbedBuilder {
  const catchMode = (s as unknown as { catchMode?: string }).catchMode ?? "type";
  const modeLabel = ({
    type: "Typing",
    button: "Button",
    both: "Both",
  } as Record<string, string>)[catchMode];

  const dropsLabel = s.cardsPerSpawn === -1 ? "Random 1–3" : `${s.cardsPerSpawn}`;
  const intervalLabel = s.useRandomInterval
    ? `${formatSec(s.spawnIntervalMin ?? 0)}–${formatSec(s.spawnIntervalMax ?? 0)}`
    : formatSec(s.spawnIntervalSeconds);

  const spawnOn = s.spawnEnabled && s.spawnChannelId;
  const tradeOn = s.tradeEnabled;

  const defaultsLine = hasDefaults
    ? `Default set loaded`
    : `No default set — click **Use Default Set** or add your own cards`;

  return new EmbedBuilder()
    .setTitle(`🃏 ${BRAND_NAME} — Setup`)
    .setColor(0x5865f2)
    .setDescription("Guided setup — choose channels, drop timing, rarity percentages, and starting cards. Changes save instantly.")
    .addFields(
      {
        name: "📢 Spawn Channel",
        value: s.spawnChannelId ? `<#${s.spawnChannelId}>` : "Not set — click **📢 Spawn here** in your drops channel",
        inline: false,
      },
      {
        name: "⏱️ Spawn Interval",
        value: intervalLabel,
        inline: true,
      },
      {
        name: "🎯 Catch Mode",
        value: modeLabel ?? "Typing",
        inline: true,
      },
      {
        name: "🛑 Catch Window",
        value: formatSec(s.catchWindowSeconds),
        inline: true,
      },
      {
        name: "🃏 Cards per Drop",
        value: dropsLabel,
        inline: true,
      },
      {
        name: "👛 Trading",
        value: tradeOn ? "🟢 ON" : "🔴 OFF",
        inline: true,
      },
      {
        name: "📢 Spawning",
        value: spawnOn ? "🟢 ON" : "🔴 OFF",
        inline: true,
      },
      { name: "📖 Cards", value: defaultsLine, inline: false },
      {
        name: "✅ Guided Next Steps",
        value:
          `• \`/welcome\` — post player guide (run in info channel)\n` +
          `• \`/cardadmin drop\` — force a drop instantly\n` +
          `• \`/cardadmin create\` — create a card with built-in rarity + upload`,
        inline: false,
      },
    )
    .setFooter({ text: "Ephemeral — only you see this." });
}

function buildSetupComponents(s: GuildSettings, hasDefaults: boolean) {
  const catchMode = (s as unknown as { catchMode?: string }).catchMode ?? "type";

  const modeSelect = new StringSelectMenuBuilder()
    .setCustomId("setup_mode")
    .setPlaceholder("🎯 Catch Mode")
    .addOptions(
      { label: "Typing", value: "type", emoji: "✍️", default: catchMode === "type" },
      { label: "Button", value: "button", emoji: "🎯", default: catchMode === "button" },
      { label: "Both", value: "both", emoji: "🔀", default: catchMode === "both" },
    );

  const dropsSelect = new StringSelectMenuBuilder()
    .setCustomId("setup_drops")
    .setPlaceholder("📤‍📤 Cards per drop")
    .addOptions(
      { label: "1 card", value: "1", default: s.cardsPerSpawn === 1 },
      { label: "3 cards", value: "3", default: s.cardsPerSpawn === 3 },
      { label: "5 cards", value: "5", default: s.cardsPerSpawn === 5 },
      { label: "Random 1–3", value: "-1", default: s.cardsPerSpawn === -1 },
    );

  const intervalOpts = [
    { label: "1 minute", sec: 1 * 60 },
    { label: "5 minutes", sec: 5 * 60 },
    { label: "10 minutes", sec: 10 * 60 },
    { label: "15 minutes", sec: 15 * 60 },
    { label: "30 minutes", sec: 30 * 60 },
    { label: "1 hour", sec: 60 * 60 },
    { label: "2 hours", sec: 2 * 60 * 60 },
    { label: "6 hours", sec: 6 * 60 * 60 },
  ];
  const intervalSelect = new StringSelectMenuBuilder()
    .setCustomId("setup_interval")
    .setPlaceholder("⏱️ Spawn interval")
    .addOptions(intervalOpts.map(o => ({
      label: o.label, value: String(o.sec),
      default: !s.useRandomInterval && s.spawnIntervalSeconds === o.sec,
    })));

  const windowOpts = [
    { label: "30 seconds", sec: 30 },
    { label: "1 minute", sec: 60 },
    { label: "2 minutes", sec: 120 },
    { label: "5 minutes", sec: 300 },
    { label: "10 minutes", sec: 600 },
  ];
  const windowSelect = new StringSelectMenuBuilder()
    .setCustomId("setup_window")
    .setPlaceholder("🛑 Catch window")
    .addOptions(windowOpts.map(o => ({
      label: o.label, value: String(o.sec),
      default: s.catchWindowSeconds === o.sec,
    })));

  // Row 4: channel + toggles + rates
  const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("setup:channel:spawn")
      .setLabel("📢 Spawn here")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("setup:toggle:spawn")
      .setLabel(s.spawnEnabled ? "🟢 Spawning ON" : "🔴 Spawning OFF")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("setup:toggle:trade")
      .setLabel(s.tradeEnabled ? "🟢 Trading ON" : "🔴 Trading OFF")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("setup:rates")
      .setLabel("🎛️ Rarity Setup")
      .setStyle(ButtonStyle.Secondary),
  );

  // Row 5: defaults + copy home template + test + finish
  const finishRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    hasDefaults
      ? new ButtonBuilder()
          .setCustomId("setup:cleardefaults")
          .setLabel("🗑️ Remove Default Set")
          .setStyle(ButtonStyle.Danger)
      : new ButtonBuilder()
          .setCustomId("setup:loaddefaults")
          .setLabel("📦 Use Default Set")
          .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("setup:testdrop")
      .setLabel("🧪 Test Drop")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("setup:done")
      .setLabel("✅ Finish")
      .setStyle(ButtonStyle.Success),
  );

  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(modeSelect),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(dropsSelect),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(intervalSelect),
    actionRow,
    finishRow,
  ];
}
