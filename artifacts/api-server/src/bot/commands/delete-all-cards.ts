// /delete_all_cards — wipe this server's roster.
// Asks first. On confirm, deletes every card this guild owns (in a set or not)
// and then any sets that are left.

import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags,
  type ButtonInteraction, type ChatInputCommandInteraction, type GuildMember,
} from "discord.js";
import { deleteAllGuildCards, isAdmin } from "../db.js";
import { GLOBAL_ONLY_MSG, isHomeGuild } from "../home-guild.js";
import { logger } from "../../lib/logger.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

async function memberIsAdmin(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<boolean> {
  if (!interaction.guild) return false;
  if (interaction.guild.ownerId === interaction.user.id) return true;
  const member = interaction.member as GuildMember | null;
  if (member?.permissions?.has("Administrator")) return true;
  return isAdmin(interaction.guild.id, interaction.user.id);
}

function confirmEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("Are you sure?")
    .setDescription(
      [
        "This **permanently deletes every card** on this server.",
        "That includes cards that are not in a set and cards that are in a set.",
        "Any sets that are left are deleted too.",
        "",
        "Collections, spawns, and set links for those cards go with them.",
        "This cannot be undone.",
      ].join("\n"),
    );
}

function confirmRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("delallcards:yes").setLabel("Yes, delete all cards").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("delallcards:no").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
  );
}

export async function handleDeleteAllCardsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) return;
  if (!(await memberIsAdmin(interaction))) {
    await interaction.reply({ content: "❌ Admins only.", ...EPHEMERAL });
    return;
  }
  if (!isHomeGuild(interaction.guild.id)) {
    await interaction.reply({ content: GLOBAL_ONLY_MSG, ...EPHEMERAL });
    return;
  }
  await interaction.reply({ embeds: [confirmEmbed()], components: [confirmRow()], ...EPHEMERAL });
}

export async function handleDeleteAllCardsButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) return;
  const choice = interaction.customId.split(":")[1];
  if (choice === "no") {
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(0x95a5a6).setTitle("Cancelled").setDescription("No cards were deleted.")],
      components: [],
    });
    return;
  }
  if (choice !== "yes") return;
  if (!(await memberIsAdmin(interaction))) {
    await interaction.update({ content: "❌ Admins only.", embeds: [], components: [] });
    return;
  }
  if (!isHomeGuild(interaction.guild.id)) {
    await interaction.update({ content: GLOBAL_ONLY_MSG, embeds: [], components: [] });
    return;
  }
  await interaction.deferUpdate();
  try {
    const { deletedCards, deletedSets } = await deleteAllGuildCards(interaction.guild.id);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle("Roster cleared")
          .setDescription(
            `Deleted **${deletedCards}** card${deletedCards === 1 ? "" : "s"} ` +
            `and **${deletedSets}** set${deletedSets === 1 ? "" : "s"}.`,
          ),
      ],
      components: [],
    });
  } catch (err) {
    logger.error({ err, guildId: interaction.guild.id }, "delete_all_cards failed");
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle("Could not delete the roster")
          .setDescription(
            "Nothing was committed. " +
            (err instanceof Error ? err.message : "The database refused the delete.").slice(0, 400),
          ),
      ],
      components: [],
    });
  }
}
