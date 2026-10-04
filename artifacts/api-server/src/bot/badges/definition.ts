import { SlashCommandBuilder } from "discord.js";

/** Public: view a member's badge collection. */
export function buildBadgesCommandJson() {
  return new SlashCommandBuilder()
    .setName("badges")
    .setDescription("View a member's badge collection")
    .setDMPermission(false)
    .addUserOption(o => o
      .setName("member")
      .setDescription("Who to view (leave empty for yourself)"))
    .toJSON();
}

/**
 * Award / remove / list configured badges.
 * Visibility is open; give/take enforce staff role (or Manage Server) server-side
 * so the configured staff role can use them without Administrator.
 */
export function buildBadgeCommandJson() {
  return new SlashCommandBuilder()
    .setName("badge")
    .setDescription("Award, remove, or browse configured badges")
    .setDMPermission(false)
    .addSubcommand(sc => sc
      .setName("give")
      .setDescription("Award a configured manual badge to a member")
      .addUserOption(o => o.setName("member").setDescription("Who to award").setRequired(true))
      .addStringOption(o => o
        .setName("badge_id")
        .setDescription("Stable badge ID from the catalogue")
        .setRequired(true)
        .setAutocomplete(true)))
    .addSubcommand(sc => sc
      .setName("take")
      .setDescription("Remove a configured badge from a member")
      .addUserOption(o => o.setName("member").setDescription("Who to remove it from").setRequired(true))
      .addStringOption(o => o
        .setName("badge_id")
        .setDescription("Stable badge ID from the catalogue")
        .setRequired(true)
        .setAutocomplete(true)))
    .addSubcommand(sc => sc
      .setName("catalogue")
      .setDescription("List configured badge rules for this server"))
    .addSubcommand(sc => sc
      .setName("show")
      .setDescription("Show the animated emblem for one badge")
      .addStringOption(o => o
        .setName("badge_id")
        .setDescription("Stable badge ID from the catalogue")
        .setRequired(true)
        .setAutocomplete(true))
      .addUserOption(o => o
        .setName("member")
        .setDescription("Whose emblem to show (default: you)")))
    .toJSON();
}
