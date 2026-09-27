// /cardadmin — true panel hub (ONE slash). Admin card create/edit/give/drop.
// Image upload create works without an attachment option: create the card first,
// then refine image via Edit Image / the edit panel.

import type {
  ChatInputCommandInteraction,
  ButtonInteraction,
  UserSelectMenuInteraction,
  ModalSubmitInteraction,
} from "discord.js";
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { withOptionValues } from "./option-proxy.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

export function buildCardAdminCommandJson() {
  return new SlashCommandBuilder()
    .setName("cardadmin")
    .setDescription("Admin card hub — create, edit, give, drop (Kitsu · Vault Values · upload)")
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON();
}

function hubEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xef4444)
    .setTitle("🃏 Card Admin Hub")
    .setDescription(
      [
        "Create and manage the roster from one panel — no slash subcommand sprawl.",
        "",
        "**Create** — blank / Discord image later · **Kitsu** (kitsu.io) · **Vault Values**",
        "**Edit / Delete / Library** — refine cards",
        "**Give / Take / Drop** — distribute copies",
        "**Shards / Edit user** — economy & profiles",
      ].join("\n"),
    )
    .setFooter({ text: "Administrator only · one slash command" });
}

function hubRows() {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("cahub:create").setLabel("Create").setEmoji("✨").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("cahub:create_kitsu").setLabel("From Kitsu").setEmoji("🎌").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("cahub:create_vault").setLabel("From Vault").setEmoji("📦").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("cahub:library").setLabel("Library").setEmoji("📚").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("cahub:edit").setLabel("Edit").setEmoji("✏️").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("cahub:edit_image").setLabel("Edit image").setEmoji("🖼️").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("cahub:delete").setLabel("Delete").setEmoji("🗑️").setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("cahub:give").setLabel("Give").setEmoji("🎁").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("cahub:take").setLabel("Take").setEmoji("↩️").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("cahub:drop").setLabel("Drop").setEmoji("🎴").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("cahub:mass_drop").setLabel("Mass drop").setEmoji("💥").setStyle(ButtonStyle.Success),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("cahub:give_shards").setLabel("Give shards").setEmoji("💠").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("cahub:take_shards").setLabel("Take shards").setEmoji("💸").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("cahub:edituser").setLabel("Edit user").setEmoji("👤").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("cahub:giveall").setLabel("Give all").setEmoji("📚").setStyle(ButtonStyle.Danger),
    ),
  ];
}

function gated(interaction: ButtonInteraction | UserSelectMenuInteraction | ModalSubmitInteraction): boolean {
  return !!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

export async function handleCardAdminCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "Server only.", ...EPHEMERAL });
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "Administrator only.", ...EPHEMERAL });
    return;
  }
  await interaction.deferReply(EPHEMERAL);
  await interaction.editReply({ embeds: [hubEmbed()], components: hubRows() });
}

async function runAdmin(
  interaction: ModalSubmitInteraction | ButtonInteraction | UserSelectMenuInteraction,
  internal: string,
  values: Parameters<typeof withOptionValues>[1],
) {
  // Admin handlers own deferReply — do not defer here.
  const proxied = withOptionValues(interaction, values);
  const { handleAdminCommand } = await import("./admin.js");
  await handleAdminCommand(proxied, internal);
}

export async function handleCardAdminHubComponent(
  interaction: ButtonInteraction | UserSelectMenuInteraction,
): Promise<void> {
  if (!gated(interaction)) {
    await interaction.reply({ content: "Administrator only.", ...EPHEMERAL });
    return;
  }
  const id = interaction.customId;

  const textModal = (
    customId: string,
    title: string,
    fields: { id: string; label: string; required?: boolean; placeholder?: string; paragraph?: boolean }[],
  ) => {
    const modal = new ModalBuilder().setCustomId(customId).setTitle(title.slice(0, 45));
    for (const f of fields.slice(0, 5)) {
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId(f.id)
            .setLabel(f.label.slice(0, 45))
            .setStyle(f.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
            .setRequired(f.required ?? false)
            .setMaxLength(f.paragraph ? 500 : 100)
            .setPlaceholder(f.placeholder ?? ""),
        ),
      );
    }
    return modal;
  };

  if (id === "cahub:create" && interaction.isButton()) {
    await interaction.showModal(textModal("cahub:modal:create", "Create card", [
      { id: "name", label: "Card name", required: true },
      { id: "rarity", label: "Rarity (common…mythic)", required: true, placeholder: "rare" },
      { id: "type", label: "Type / tag", required: true, placeholder: "tank" },
      { id: "description", label: "Description (optional)", paragraph: true },
      { id: "set", label: "Set name (optional)" },
    ]));
    return;
  }

  if (id === "cahub:create_kitsu" && interaction.isButton()) {
    await interaction.showModal(textModal("cahub:modal:create_kitsu", "Create from Kitsu", [
      { id: "category", label: "Category: anime | manga | character", required: true, placeholder: "anime" },
      { id: "item", label: "Title or character name", required: true },
      { id: "rarity", label: "DN rarity", required: true, placeholder: "epic" },
      { id: "type", label: "Card type/tag", required: true },
      { id: "set", label: "Set (optional)" },
    ]));
    return;
  }

  if (id === "cahub:create_vault" && interaction.isButton()) {
    await interaction.showModal(textModal("cahub:modal:create_vault", "Create from Vault Values", [
      { id: "item", label: "Vault Values item name", required: true, placeholder: "Sea Dragon / STM" },
      { id: "rarity", label: "DN rarity (or auto)", required: false, placeholder: "auto = site rarity" },
      { id: "type", label: "Card type/tag (blank = site category)", required: false, placeholder: "ground / air / naval" },
      { id: "set", label: "Set (optional)" },
      { id: "description", label: "Description override (optional)", paragraph: true },
    ]));
    return;
  }

  if (id === "cahub:library" && interaction.isButton()) {
    await interaction.showModal(textModal("cahub:modal:library", "Kitsu library preview", [
      { id: "category", label: "Category: anime | manga | character", required: true, placeholder: "character" },
      { id: "name", label: "Title or character", required: true },
    ]));
    return;
  }

  if (id === "cahub:edit" && interaction.isButton()) {
    await interaction.showModal(textModal("cahub:modal:edit", "Edit card", [
      { id: "name", label: "Card name", required: true },
      { id: "max_copies", label: "Max copies (blank = unchanged)", placeholder: "50" },
      { id: "total_minted", label: "Total minted override (optional)" },
      { id: "limited", label: "Limited? yes/no (optional)", placeholder: "yes" },
    ]));
    return;
  }

  if (id === "cahub:edit_image" && interaction.isButton()) {
    await interaction.showModal(textModal("cahub:modal:edit_image", "Edit image / description", [
      { id: "name", label: "Card name", required: true },
    ]));
    return;
  }

  if (id === "cahub:delete" && interaction.isButton()) {
    await interaction.showModal(textModal("cahub:modal:delete", "Delete card", [
      { id: "name", label: "Card name to permanently delete", required: true },
    ]));
    return;
  }

  if (id === "cahub:drop" && interaction.isButton()) {
    await interaction.showModal(textModal("cahub:modal:drop", "Force drop a card", [
      { id: "name", label: "Card name (blank = random)", required: false },
      { id: "set", label: "Set filter (optional)" },
      { id: "star", label: "Star rank 0-5 (optional)" },
      { id: "level", label: "Level 1-100 (optional)" },
    ]));
    return;
  }

  if (id === "cahub:mass_drop" && interaction.isButton()) {
    await interaction.showModal(textModal("cahub:modal:mass_drop", "Mass drop", [
      { id: "amount", label: "How many (10-25)", required: true, placeholder: "15" },
      { id: "set", label: "Set filter (optional)" },
    ]));
    return;
  }

  // User-targeted actions → user select first
  if (
    (id === "cahub:give" || id === "cahub:take" || id === "cahub:giveall"
      || id === "cahub:give_shards" || id === "cahub:take_shards" || id === "cahub:edituser")
    && interaction.isButton()
  ) {
    const action = id.slice("cahub:".length);
    const row = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId(`cahub:user:${action}`)
        .setPlaceholder("Pick a member")
        .setMinValues(1)
        .setMaxValues(1),
    );
    await interaction.reply({ content: "Pick the member:", components: [row], ...EPHEMERAL });
    return;
  }

  if (id.startsWith("cahub:user:") && interaction.isUserSelectMenu()) {
    const action = id.slice("cahub:user:".length);
    const target = interaction.users.first();
    if (!target || target.bot) {
      await interaction.reply({ content: "Pick a real member.", ...EPHEMERAL });
      return;
    }
    if (action === "edituser") {
      await runAdmin(interaction, "edituser", { users: { user: target } });
      return;
    }
    if (action === "give") {
      await interaction.showModal(textModal(`cahub:modal:give:${target.id}`, `Give to ${target.username}`, [
        { id: "name", label: "Card name", required: true },
        { id: "amount", label: "Copies (default 1)", placeholder: "1" },
        { id: "star", label: "Star 0-5 (optional)" },
        { id: "level", label: "Level 1-100 (optional)" },
      ]));
      return;
    }
    if (action === "take") {
      await interaction.showModal(textModal(`cahub:modal:take:${target.id}`, `Take from ${target.username}`, [
        { id: "name", label: "Card name", required: true },
        { id: "amount", label: "Copies (default 1)", placeholder: "1" },
      ]));
      return;
    }
    if (action === "giveall") {
      await interaction.showModal(textModal(`cahub:modal:giveall:${target.id}`, `Give all to ${target.username}`, [
        { id: "set", label: "Set filter (optional)" },
        { id: "rarity", label: "Rarity filter (optional)", placeholder: "epic" },
        { id: "shinyrate", label: "Shiny % 0-100 (default 0.5)", placeholder: "0.5" },
      ]));
      return;
    }
    if (action === "give_shards") {
      await interaction.showModal(textModal(`cahub:modal:give_shards:${target.id}`, `Give shards`, [
        { id: "amount", label: "Shard amount", required: true },
      ]));
      return;
    }
    if (action === "take_shards") {
      await interaction.showModal(textModal(`cahub:modal:take_shards:${target.id}`, `Take shards`, [
        { id: "amount", label: "Shard amount", required: true },
      ]));
      return;
    }
  }
}

function parseIntOpt(raw: string | undefined): number | null {
  if (!raw?.trim()) return null;
  const n = Number.parseInt(raw.replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function parseBoolOpt(raw: string | undefined): boolean | null {
  if (!raw?.trim()) return null;
  const v = raw.trim().toLowerCase();
  if (["yes", "y", "true", "1"].includes(v)) return true;
  if (["no", "n", "false", "0"].includes(v)) return false;
  return null;
}

export async function handleCardAdminHubModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!gated(interaction)) {
    await interaction.reply({ content: "Administrator only.", ...EPHEMERAL });
    return;
  }
  const id = interaction.customId;
  const field = (name: string) => {
    try { return interaction.fields.getTextInputValue(name)?.trim() || ""; }
    catch { return ""; }
  };

  if (id === "cahub:modal:create") {
    await runAdmin(interaction, "addcard", {
      strings: {
        name: field("name"),
        rarity: field("rarity").toLowerCase(),
        type: field("type"),
        description: field("description") || null,
        set: field("set") || null,
      },
      booleans: { limited: false, event_exclusive: false },
      integers: { max_copies: null },
      attachments: { image: null },
    });
    return;
  }

  if (id === "cahub:modal:create_kitsu") {
    const cat = field("category").toLowerCase();
    if (!["anime", "manga", "character"].includes(cat)) {
      await interaction.reply({ content: "Category must be anime, manga, or character.", ...EPHEMERAL });
      return;
    }
    await runAdmin(interaction, "createcardfrom", {
      strings: {
        category: cat,
        item: field("item"),
        rarity: field("rarity").toLowerCase(),
        type: field("type"),
        set: field("set") || null,
        description: null,
      },
      booleans: { limited: false, event_exclusive: false },
      integers: { max_copies: null },
    });
    return;
  }

  if (id === "cahub:modal:create_vault") {
    await runAdmin(interaction, "createcardfrommttv", {
      strings: {
        item: field("item"),
        rarity: field("rarity").toLowerCase() || "auto",
        type: field("type") || null,
        set: field("set") || null,
        description: field("description") || null,
      },
      booleans: { limited: null, event_exclusive: false },
      integers: { max_copies: null },
    });
    return;
  }

  if (id === "cahub:modal:library") {
    const cat = field("category").toLowerCase();
    if (!["anime", "manga", "character"].includes(cat)) {
      await interaction.reply({ content: "Category must be anime, manga, or character.", ...EPHEMERAL });
      return;
    }
    await runAdmin(interaction, "library", {
      strings: { category: cat, name: field("name") },
    });
    return;
  }

  if (id === "cahub:modal:edit") {
    await runAdmin(interaction, "editcard", {
      strings: { name: field("name") },
      integers: {
        max_copies: parseIntOpt(field("max_copies")),
        total_minted: parseIntOpt(field("total_minted")),
      },
      booleans: { limited: parseBoolOpt(field("limited")) },
      attachments: { image: null },
    });
    return;
  }

  if (id === "cahub:modal:edit_image") {
    await runAdmin(interaction, "editimage", {
      strings: { name: field("name") },
      attachments: { image: null },
    });
    return;
  }

  if (id === "cahub:modal:delete") {
    await runAdmin(interaction, "deletecard", { strings: { name: field("name") } });
    return;
  }

  if (id === "cahub:modal:drop") {
    await runAdmin(interaction, "drop", {
      strings: { name: field("name") || null, set: field("set") || null },
      integers: { star: parseIntOpt(field("star")), level: parseIntOpt(field("level")) },
    });
    return;
  }

  if (id === "cahub:modal:mass_drop") {
    const amount = parseIntOpt(field("amount")) ?? 15;
    await runAdmin(interaction, "massdrop", {
      integers: { amount },
      strings: { set: field("set") || null },
    });
    return;
  }

  if (id.startsWith("cahub:modal:give:")) {
    const userId = id.slice("cahub:modal:give:".length);
    const user = await interaction.client.users.fetch(userId).catch(() => null);
    if (!user) { await interaction.reply({ content: "User not found.", ...EPHEMERAL }); return; }
    await runAdmin(interaction, "give", {
      users: { user },
      strings: { name: field("name") },
      integers: {
        amount: parseIntOpt(field("amount")),
        star: parseIntOpt(field("star")),
        level: parseIntOpt(field("level")),
      },
    });
    return;
  }

  if (id.startsWith("cahub:modal:take:")) {
    const userId = id.slice("cahub:modal:take:".length);
    const user = await interaction.client.users.fetch(userId).catch(() => null);
    if (!user) { await interaction.reply({ content: "User not found.", ...EPHEMERAL }); return; }
    await runAdmin(interaction, "takeback", {
      users: { user },
      strings: { name: field("name") },
      integers: { amount: parseIntOpt(field("amount")) },
    });
    return;
  }

  if (id.startsWith("cahub:modal:giveall:")) {
    const userId = id.slice("cahub:modal:giveall:".length);
    const user = await interaction.client.users.fetch(userId).catch(() => null);
    if (!user) { await interaction.reply({ content: "User not found.", ...EPHEMERAL }); return; }
    const rarity = field("rarity").toLowerCase() || null;
    await runAdmin(interaction, "giveall", {
      users: { user },
      strings: { set: field("set") || null, rarity },
      integers: { shinyrate: parseIntOpt(field("shinyrate")) },
    });
    return;
  }

  if (id.startsWith("cahub:modal:give_shards:")) {
    const userId = id.slice("cahub:modal:give_shards:".length);
    const user = await interaction.client.users.fetch(userId).catch(() => null);
    if (!user) { await interaction.reply({ content: "User not found.", ...EPHEMERAL }); return; }
    const amount = parseIntOpt(field("amount"));
    if (!amount || amount < 1) {
      await interaction.reply({ content: "Enter a positive amount.", ...EPHEMERAL });
      return;
    }
    await runAdmin(interaction, "giveshards", { users: { user }, integers: { amount } });
    return;
  }

  if (id.startsWith("cahub:modal:take_shards:")) {
    const userId = id.slice("cahub:modal:take_shards:".length);
    const user = await interaction.client.users.fetch(userId).catch(() => null);
    if (!user) { await interaction.reply({ content: "User not found.", ...EPHEMERAL }); return; }
    const amount = parseIntOpt(field("amount"));
    if (!amount || amount < 1) {
      await interaction.reply({ content: "Enter a positive amount.", ...EPHEMERAL });
      return;
    }
    await runAdmin(interaction, "takeshards", { users: { user }, integers: { amount } });
  }
}
