import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";

/**
 * One slash. Members see the week on the hub and still Submit from the board.
 * Staff buttons (Setup / Crown / Fix) are visible; pressing them without
 * Manage Server tells them they need to be admin.
 */
export function buildArtShowCommandJson() {
  return new SlashCommandBuilder()
    .setName("artshow")
    .setDescription("Community Art Show — board, gallery, and staff tools")
    .setDMPermission(false)
    .toJSON();
}

export const ARTSHOW_STAFF_PERMS = PermissionFlagsBits.ManageGuild;
