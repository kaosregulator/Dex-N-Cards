import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from "discord.js";

/**
 * Keep the slash surface tiny:
 *   /artshow setup  — create the 2 channels + station
 *   /artshow crown  — end the week, announce winner on the board
 *   /artshow fix    — staff repair (badges + missing gallery posts)
 *
 * Members never need a slash command — they tap Submit on the board.
 */
export function buildArtShowCommandJson() {
  return new SlashCommandBuilder()
    .setName("artshow")
    .setDescription("Community Art Show — setup, crown the week, or repair")
    .setDMPermission(false)
    .addSubcommand(sc => sc
      .setName("setup")
      .setDescription("Staff: create board + gallery channels and post the Submit station")
      .addStringOption(o => o
        .setName("board_name")
        .setDescription("Name for the submission board (default: art-show)")
        .setRequired(false)
        .setMaxLength(90))
      .addStringOption(o => o
        .setName("gallery_name")
        .setDescription("Name for the voting gallery (default: art-gallery)")
        .setRequired(false)
        .setMaxLength(90))
      .addChannelOption(o => o
        .setName("board")
        .setDescription("Use an existing board channel instead of creating one")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false))
      .addChannelOption(o => o
        .setName("gallery")
        .setDescription("Use an existing gallery channel instead of creating one")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false))
      .addRoleOption(o => o
        .setName("staff_role")
        .setDescription("Optional role that can still post in the read-only gallery")
        .setRequired(false)))
    .addSubcommand(sc => sc
      .setName("crown")
      .setDescription("Staff: crown this week's winner and announce it on the board")
      .addIntegerOption(o => o
        .setName("piece_id")
        .setDescription("Piece id (defaults to this week's leader)")
        .setRequired(false)))
    .addSubcommand(sc => sc
      .setName("fix")
      .setDescription("Staff: sync missing emblems + force-post any hung pieces that never appeared"))
    // Back-compat alias — same as setup
    .addSubcommand(sc => sc
      .setName("post")
      .setDescription("Staff: same as /artshow setup")
      .addStringOption(o => o.setName("board_name").setDescription("Board channel name").setRequired(false).setMaxLength(90))
      .addStringOption(o => o.setName("gallery_name").setDescription("Gallery channel name").setRequired(false).setMaxLength(90))
      .addChannelOption(o => o
        .setName("board")
        .setDescription("Existing board")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false))
      .addChannelOption(o => o
        .setName("gallery")
        .setDescription("Existing gallery")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false))
      .addRoleOption(o => o.setName("staff_role").setDescription("Staff role for gallery").setRequired(false)))
    .toJSON();
}

export const ARTSHOW_STAFF_PERMS = PermissionFlagsBits.ManageGuild;
