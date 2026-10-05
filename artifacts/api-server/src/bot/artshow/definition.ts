import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from "discord.js";

export function buildArtShowCommandJson() {
  return new SlashCommandBuilder()
    .setName("artshow")
    .setDescription("Community Art Show — submit, vote, earn emblems, visit the museum")
    .setDMPermission(false)
    .addSubcommand(sc => sc
      .setName("post")
      .setDescription("Staff: post the Art Show station in a channel")
      .addChannelOption(o => o
        .setName("channel")
        .setDescription("Gallery channel (defaults to current)")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false)))
    .addSubcommand(sc => sc
      .setName("submit")
      .setDescription("Submit a piece (or use the station button)")
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
      .setName("museum")
      .setDescription("Open the Hall of Fame museum"))
    .addSubcommand(sc => sc
      .setName("badges")
      .setDescription("See how Art Show emblems evolve"))
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
      .setDescription("Staff: configure votes / bump / crown threshold")
      .addIntegerOption(o => o.setName("votes_per_day").setDescription("Daily vote allowance").setMinValue(1).setMaxValue(50))
      .addIntegerOption(o => o.setName("bonus_on_submit").setDescription("Bonus votes when you submit").setMinValue(0).setMaxValue(20))
      .addIntegerOption(o => o.setName("refresh_hours").setDescription("Hours between +1 vote refresh").setMinValue(1).setMaxValue(24))
      .addIntegerOption(o => o.setName("bump_cost").setDescription("Votes to bump your piece").setMinValue(1).setMaxValue(20))
      .addIntegerOption(o => o.setName("crown_at").setDescription("Auto-crown at this many votes (0=off)").setMinValue(0).setMaxValue(500)))
    .toJSON();
}

export const ARTSHOW_STAFF_PERMS = PermissionFlagsBits.ManageGuild;
