import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from "discord.js";

export function buildArtShowCommandJson() {
  return new SlashCommandBuilder()
    .setName("artshow")
    .setDescription("Community Art Show — submit, vote, earn emblems, visit the museum")
    .setDMPermission(false)
    .addSubcommand(sc => sc
      .setName("post")
      .setDescription("Staff: set submission board + gallery channels, post the station")
      .addChannelOption(o => o
        .setName("board")
        .setDescription("Existing submission-board channel (station + photo drops)")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false))
      .addChannelOption(o => o
        .setName("gallery")
        .setDescription("Existing gallery channel where hung pieces appear")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false))
      .addStringOption(o => o
        .setName("create_board")
        .setDescription("Create a new submission-board channel with this name")
        .setRequired(false)
        .setMaxLength(90))
      .addStringOption(o => o
        .setName("create_gallery")
        .setDescription("Create a new read-only gallery channel with this name")
        .setRequired(false)
        .setMaxLength(90))
      .addRoleOption(o => o
        .setName("staff_role")
        .setDescription("Role that can still post in the read-only gallery (optional)")
        .setRequired(false))
      .addIntegerOption(o => o.setName("votes_per_day").setDescription("Daily vote allowance").setMinValue(1).setMaxValue(50))
      .addIntegerOption(o => o.setName("bonus_on_submit").setDescription("Bonus votes when you submit").setMinValue(0).setMaxValue(20))
      .addIntegerOption(o => o.setName("refresh_hours").setDescription("Hours between +1 vote refresh").setMinValue(1).setMaxValue(24))
      .addIntegerOption(o => o.setName("bump_cost").setDescription("Votes to bump your piece").setMinValue(1).setMaxValue(20))
      .addIntegerOption(o => o.setName("crown_at").setDescription("Auto-crown at this many votes (0=off)").setMinValue(0).setMaxValue(500)))
    .addSubcommand(sc => sc
      .setName("submit")
      .setDescription("Submit a piece with Discord's photo uploader")
      .addAttachmentOption(o => o
        .setName("image")
        .setDescription("Your artwork photo")
        .setRequired(true))
      .addStringOption(o => o
        .setName("title")
        .setDescription("Title for the piece")
        .setRequired(true)
        .setMaxLength(80))
      .addStringOption(o => o
        .setName("description")
        .setDescription("Optional description")
        .setRequired(false)
        .setMaxLength(400)))
    .addSubcommand(sc => sc
      .setName("repost")
      .setDescription("Staff: force-post a piece to the gallery so voting can start")
      .addIntegerOption(o => o
        .setName("piece_id")
        .setDescription("Piece id to repost (omit to repost all missing this week)")
        .setRequired(false))
      .addBooleanOption(o => o
        .setName("missing_only")
        .setDescription("Only pieces that never got a gallery message (default true)")
        .setRequired(false)))
    .addSubcommand(sc => sc
      .setName("sync_badges")
      .setDescription("Staff: merge Art Show emblems into the badge catalogue and backfill unlocks"))
    .addSubcommand(sc => sc
      .setName("museum")
      .setDescription("Open the Hall of Fame museum"))
    .addSubcommand(sc => sc
      .setName("badges")
      .setDescription("See how Art Show emblems evolve"))
    .addSubcommand(sc => sc
      .setName("browse")
      .setDescription("Browse other art halls this week"))
    .addSubcommand(sc => sc
      .setName("leaderboard")
      .setDescription("This week's top pieces")
      .addBooleanOption(o => o
        .setName("all_time")
        .setDescription("Show all-time instead of this week")
        .setRequired(false)))
    .addSubcommand(sc => sc
      .setName("votes")
      .setDescription("Check your vote wallet"))
    .addSubcommand(sc => sc
      .setName("crown")
      .setDescription("Staff: crown this week's leading piece into the museum")
      .addIntegerOption(o => o
        .setName("piece_id")
        .setDescription("Optional piece id (defaults to weekly leader)")
        .setRequired(false)))
    .addSubcommand(sc => sc
      .setName("setup")
      .setDescription("Staff: configure votes / bump / crown — or reset to defaults")
      .addBooleanOption(o => o
        .setName("reset_defaults")
        .setDescription("Reset all thresholds/cooldowns to defaults")
        .setRequired(false))
      .addRoleOption(o => o
        .setName("staff_role")
        .setDescription("Role allowed to post in the read-only gallery")
        .setRequired(false))
      .addIntegerOption(o => o.setName("votes_per_day").setDescription("Daily vote allowance").setMinValue(1).setMaxValue(50))
      .addIntegerOption(o => o.setName("bonus_on_submit").setDescription("Bonus votes when you submit").setMinValue(0).setMaxValue(20))
      .addIntegerOption(o => o.setName("refresh_hours").setDescription("Hours between +1 vote refresh").setMinValue(1).setMaxValue(24))
      .addIntegerOption(o => o.setName("bump_cost").setDescription("Votes to bump your piece").setMinValue(1).setMaxValue(20))
      .addIntegerOption(o => o.setName("crown_at").setDescription("Auto-crown at this many votes (0=off)").setMinValue(0).setMaxValue(500)))
    .toJSON();
}

export const ARTSHOW_STAFF_PERMS = PermissionFlagsBits.ManageGuild;
