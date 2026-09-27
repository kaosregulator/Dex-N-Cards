// /vaultvalue — panel hub + optional autocomplete item lookup.
// Baseline: PR #170. No mini-browser / webhook site branding.

import type {
  ChatInputCommandInteraction,
  ButtonInteraction,
  ChannelSelectMenuInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from "discord.js";
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import { withOptionValues } from "./option-proxy.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

export function buildVaultValueCommandJson() {
  return new SlashCommandBuilder()
    .setName("vaultvalue")
    .setDescription("Vault Values — MT prices, calculator, top list (valuevaultx.com)")
    .setDMPermission(false)
    .addStringOption((o) =>
      o
        .setName("item")
        .setDescription("Look up an item (type to autocomplete)")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .toJSON();
}

function hubEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xf59e0b)
    .setTitle("📦 Vault Values Hub")
    .setDescription(
      [
        "Military Tycoon prices from [valuevaultx.com](https://valuevaultx.com).",
        "",
        "**Quick lookup:** `/vaultvalue item:Sea Dragon` (autocomplete)",
        "",
        "**Info** — search / fuzzy lookup",
        "**Calc** — two-sided trade calculator (one private panel)",
        "**List** — top items by value",
        "**Help** — how pricing works",
        "**Post Calc** — (admin) pin a calculator in a channel",
      ].join("\n"),
    )
    .setFooter({ text: "One slash · panel actions · valuevaultx.com" });
}

function hubRows(isAdmin: boolean) {
  const rows = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("vvhub:info").setLabel("Info").setEmoji("🔎").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("vvhub:calc").setLabel("Calculator").setEmoji("🧮").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("vvhub:list").setLabel("Top list").setEmoji("📊").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("vvhub:help").setLabel("Help").setEmoji("❓").setStyle(ButtonStyle.Secondary),
    ),
  ];
  if (isAdmin) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("vvhub:postcalc").setLabel("Post calculator").setEmoji("📌").setStyle(ButtonStyle.Danger),
      ),
    );
  }
  return rows;
}

export async function handleVaultValueCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "Server only.", ...EPHEMERAL });
    return;
  }

  const item = interaction.options.getString("item")?.trim();
  if (item) {
    const { handleInfoMTTV } = await import("./mttvalues.js");
    await handleInfoMTTV(interaction);
    return;
  }

  await interaction.deferReply(EPHEMERAL);
  const isAdmin = !!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  await interaction.editReply({ embeds: [hubEmbed()], components: hubRows(isAdmin) });
}

export async function handleVaultValueHubComponent(
  interaction: ButtonInteraction | ChannelSelectMenuInteraction | StringSelectMenuInteraction,
): Promise<void> {
  const id = interaction.customId;

  if (id === "vvhub:info" && interaction.isButton()) {
    const modal = new ModalBuilder()
      .setCustomId("vvhub:modal:info")
      .setTitle("Vault Values lookup")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("item")
            .setLabel("Item name (fuzzy / acronym OK)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(100)
            .setPlaceholder("e.g. STM, Sea Dragon, Abrams"),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  if (id.startsWith("vvhub:pick:") && interaction.isStringSelectMenu()) {
    const name = interaction.values[0];
    if (!name) {
      await interaction.reply({ content: "No item selected.", ...EPHEMERAL });
      return;
    }
    const proxied = withOptionValues(interaction, { strings: { item: name } });
    const { handleInfoMTTV } = await import("./mttvalues.js");
    await handleInfoMTTV(proxied);
    return;
  }

  if (id === "vvhub:calc" && interaction.isButton()) {
    const { handleCalc } = await import("./mttvalues.js");
    await handleCalc(interaction as unknown as ChatInputCommandInteraction);
    return;
  }

  if (id === "vvhub:list" && interaction.isButton()) {
    const { handleValueList } = await import("./mttvalues.js");
    await handleValueList(interaction as unknown as ChatInputCommandInteraction);
    return;
  }

  if (id === "vvhub:help" && interaction.isButton()) {
    const { handleValueHelp } = await import("./mttvalues.js");
    await handleValueHelp(interaction as unknown as ChatInputCommandInteraction);
    return;
  }

  if (id === "vvhub:postcalc" && interaction.isButton()) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: "Administrator only.", ...EPHEMERAL });
      return;
    }
    const row = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId("vvhub:postcalc_channel")
        .setPlaceholder("Channel to post the calculator in")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMinValues(1)
        .setMaxValues(1),
    );
    await interaction.reply({
      content: "Pick the channel for the persistent calculator hub:",
      components: [row],
      ...EPHEMERAL,
    });
    return;
  }

  if (id === "vvhub:postcalc_channel" && interaction.isChannelSelectMenu()) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: "Administrator only.", ...EPHEMERAL });
      return;
    }
    const channel = interaction.channels.first();
    if (!channel) {
      await interaction.reply({ content: "No channel selected.", ...EPHEMERAL });
      return;
    }
    await interaction.deferReply(EPHEMERAL);
    const proxied = withOptionValues(interaction, {
      channels: { channel: channel as never, result_channel: null },
    });
    const { handlePostCalculator } = await import("./mttcalc-hub.js");
    await handlePostCalculator(proxied);
  }
}

export async function handleVaultValueHubModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (interaction.customId !== "vvhub:modal:info") return;
  const item = interaction.fields.getTextInputValue("item").trim();
  if (!item) {
    await interaction.reply({ content: "Enter an item name.", ...EPHEMERAL });
    return;
  }
  const proxied = withOptionValues(interaction, {
    strings: { item },
  });
  const { handleInfoMTTV } = await import("./mttvalues.js");
  await handleInfoMTTV(proxied);
}

/** Build a pick-from-matches menu (used by Info when search is ambiguous). */
export function buildInfoPickMenu(query: string, names: Array<{ name: string; desc: string }>) {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`vvhub:pick:${Date.now().toString(36)}`)
      .setPlaceholder(`Pick a match for "${query.slice(0, 40)}"`)
      .addOptions(
        names.slice(0, 25).map((n) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(n.name.slice(0, 100))
            .setValue(n.name.slice(0, 100))
            .setDescription(n.desc.slice(0, 100)),
        ),
      ),
  );
}
