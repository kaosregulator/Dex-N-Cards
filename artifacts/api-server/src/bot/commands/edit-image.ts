// /edit_image — interactive admin command to update a card's image + description.
//
// Flow:
//   /edit_image name:<card>
//     → ephemeral panel with buttons: [Search Vault Values] [Upload own image]
//   Search Vault Values → modal asking for the Item name
//   Modal submit → fuzzy search results shown as buttons
//   Pick a result → image + description pulled from MTTV and saved
//   Upload own image → instructions (use the slash command's image option)
//
// You can also skip the panel by providing the image option directly:
//   /edit_image name:<card> image:<file>

import type {
  ChatInputCommandInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
} from "discord.js";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, MessageFlags,
} from "discord.js";
import { getCardByName, getCardById, updateCard } from "../db.js";
import { isOwnedBy } from "../home-guild.js";
import { logger } from "../../lib/logger.js";
import { renderPanel, persistBotImage } from "./edit-card.js";
import { fetchMTTVItems, matchScore, buildMTTVItemEmbed, rarityEmoji, formatMTTVValue, type MTTVItem } from "./mttvalues.js";

const CUSTOM_ID_PREFIX = "editimage";
const SEARCH_TTL_MS = 15 * 60 * 1000; // 15 min

const searchStates = new Map<string, { items: MTTVItem[]; cardId: number; userId: string }>();
const searchTimers = new Map<string, ReturnType<typeof setTimeout>>();

function resetSearchTimer(messageId: string): void {
  const existing = searchTimers.get(messageId);
  if (existing) clearTimeout(existing);
  searchTimers.set(
    messageId,
    setTimeout(() => {
      searchStates.delete(messageId);
      searchTimers.delete(messageId);
    }, SEARCH_TTL_MS),
  );
}

export async function handleEditImageCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const name = interaction.options.getString("name", true).trim();
  const image = interaction.options.getAttachment("image");
  const guildId = interaction.guildId;
  if (!guildId) return;

  const card = await getCardByName(name, guildId);
  if (!card) {
    await interaction.editReply(`❌ No card named **${name}**. Use autocomplete to pick one.`);
    return;
  }
  if (!isOwnedBy(card, guildId)) {
    await interaction.editReply(`❌ You can only edit cards owned by this server.`);
    return;
  }

  // If the user uploaded an image directly, just apply it.
  if (image) {
    const imageUrl = await persistBotImage(image.url, image.contentType ?? undefined);
    await updateCard(card.id, { imageUrl });
    await renderPanel(interaction, card.id, false, `✅ Updated image for **${card.name}**`);
    return;
  }

  // Show the choice panel.
  const embed = new EmbedBuilder()
    .setTitle(`🖼️ Edit image: ${card.name}`)
    .setDescription("Choose where to pull the new image from.")
    .setColor(0x3498db);

  const rows = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:search:${card.id}`)
        .setLabel("Search Vault Values")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:upload:${card.id}`)
        .setLabel("Upload own image")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];

  await interaction.editReply({ embeds: [embed], components: rows });
}

// ── Button: open the MTTV search modal or show upload instructions ───────────
export async function handleEditImageButton(interaction: ButtonInteraction): Promise<void> {
  const parts = interaction.customId.split(":");
  const action = parts[1];
  const cardId = Number(parts[2]);
  if (Number.isNaN(cardId)) return;

  if (action === "search") {
    const modal = new ModalBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:search_modal:${cardId}`)
      .setTitle("Search Vault Values")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("query")
            .setLabel("Item name")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(100)
            .setPlaceholder("e.g. Super Tiger Mech"),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  if (action === "upload") {
    const card = await getCardById(cardId);
    const label = card?.name ?? "Card Name";
    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle("📎 Upload your own image")
          .setDescription(
            `Run the slash command and attach the file:\n` +
            `\`/edit_image name:${label} image:<your file>\``,
          )
          .setColor(0x95a5a6),
      ],
      components: [],
    });
  }
}

// ── Modal: run the MTTV search and show results as buttons ──────────────────
export async function handleEditImageModal(interaction: ModalSubmitInteraction): Promise<void> {
  const parts = interaction.customId.split(":");
  const cardId = Number(parts[2]);
  if (Number.isNaN(cardId)) return;

  const query = interaction.fields.getTextInputValue("query").trim();
  if (!query) {
    await interaction.reply({ content: "❌ Search term cannot be empty.", flags: MessageFlags.Ephemeral });
    return;
  }

  let items: MTTVItem[];
  try {
    items = await fetchMTTVItems();
  } catch (err) {
    logger.error({ err }, "Failed to fetch Vault Values items for edit_image modal");
    await interaction.reply({ content: "❌ Could not reach the values service. Try again later.", flags: MessageFlags.Ephemeral });
    return;
  }

  const exact = items.find((i) => i.name.toLowerCase() === query.toLowerCase());
  if (exact && exact.image) {
    await applyMTTVItem(interaction, cardId, exact, interaction.guildId);
    return;
  }

  const MAX_RESULTS = 10;
  const results = items
    .map((i) => ({ i, score: matchScore(i, query) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS)
    .map(({ i }) => i);

  if (results.length === 0) {
    await interaction.reply({
      content: `❌ No items found for "${query}". Try a different name or upload your own image.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const lines = results.map(
    (item, i) => `${i + 1}. ${item.rarity.map(rarityEmoji).join("") || "—"} **${item.name}** · 💰 ${formatMTTVValue(item)}`,
  ).join("\n");

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  let current = new ActionRowBuilder<ButtonBuilder>();
  results.forEach((item, idx) => {
    const rarity = item.rarity.map(rarityEmoji).join("") || "—";
    const label = `${rarity} ${item.name.slice(0, 80)}`.slice(0, 80);
    // Two buttons per row so we can fit a Cancel button in the last row
    // while staying within Discord's 5-action-row limit.
    if (current.components.length >= 2) {
      rows.push(current);
      current = new ActionRowBuilder<ButtonBuilder>();
    }
    current.addComponents(
      new ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:pick:${cardId}:${idx}`)
        .setLabel(label)
        .setStyle(ButtonStyle.Primary),
    );
  });
  if (current.components.length > 0) rows.push(current);

  const cancelButton = new ButtonBuilder()
    .setCustomId(`${CUSTOM_ID_PREFIX}:cancel:${cardId}`)
    .setLabel("↩️ Cancel")
    .setStyle(ButtonStyle.Secondary);
  const lastRow = rows[rows.length - 1];
  if (lastRow && lastRow.components.length < 5) {
    lastRow.addComponents(cancelButton);
  } else {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(cancelButton));
  }

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("🔍 Select an item")
        .setColor(0x9b59b6)
        .setDescription(`Search results for "${query}":\n${lines}`)
        .setFooter({ text: "Prices from Vault Values" }),
    ],
    components: rows,
    flags: MessageFlags.Ephemeral,
  });

  const message = await interaction.fetchReply();
  searchStates.set(message.id, { items: results, cardId, userId: interaction.user.id });
  resetSearchTimer(message.id);
}

// ── Button: pick a result from the search results message ───────────────────
export async function handleEditImagePick(interaction: ButtonInteraction): Promise<void> {
  const parts = interaction.customId.split(":");
  const action = parts[1];
  const cardId = Number(parts[2]);

  if (action === "cancel" || Number.isNaN(cardId)) {
    await interaction.update({ content: "Cancelled.", embeds: [], components: [] }).catch(() => {});
    searchStates.delete(interaction.message.id);
    return;
  }

  if (action !== "pick") return;

  const idx = Number(parts[3]);
  const state = searchStates.get(interaction.message.id);
  if (!state || state.userId !== interaction.user.id || state.cardId !== cardId) {
    await interaction.reply({ content: "❌ This search belongs to someone else or has expired.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  const item = state.items[idx];
  if (!item) {
    await interaction.reply({ content: "❌ That result is no longer available.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  await applyMTTVItem(interaction, cardId, item, interaction.guildId);
}

// ── Apply the chosen MTTV item to the card ────────────────────────────────────
async function applyMTTVItem(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  cardId: number,
  item: MTTVItem,
  viewerGuildId: string | null,
): Promise<void> {
  if (!item.image) {
    const content = `❌ **${item.name}** has no image available. Pick another item or upload your own.`;
    if (interaction.isButton()) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  // Defer before doing network/storage work so we don't hit the 3-second
  // interaction timeout. /make_card works because it defers the slash reply.
  if (interaction.isButton()) {
    await interaction.deferUpdate().catch(() => {});
  } else {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  const card = await getCardById(cardId, viewerGuildId);
  if (!card) {
    await interaction.editReply({ content: "❌ Card not found." }).catch(() => {});
    return;
  }

  const imageUrl = await persistBotImage(item.image);
  await updateCard(card.id, { imageUrl, description: item.description || "" });

  const embed = buildMTTVItemEmbed(item).setTitle(`✅ Updated ${card.name} from Vault Values`);
  await interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});
}
