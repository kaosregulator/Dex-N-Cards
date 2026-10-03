import { SlashCommandBuilder } from "discord.js";
import { MEMBERDATE_DEFAULT_MEMBER_PERMISSIONS } from "./access.js";
import { TENURE_FILTER_CHOICES } from "./format.js";

export function buildMemberDateCommandJson() {
  return new SlashCommandBuilder()
    .setName("memberdate")
    .setDescription("Staff: member join dates, role tenure, and tenure filters")
    .setDMPermission(false)
    .setDefaultMemberPermissions(MEMBERDATE_DEFAULT_MEMBER_PERMISSIONS)
    .addSubcommand(sc => sc
      .setName("lookup")
      .setDescription("Look up one member — join date, account age, optional role tenure")
      .addUserOption(o => o
        .setName("user")
        .setDescription("Member to look up (@mention or pick from the list)")
        .setRequired(true))
      .addRoleOption(o => o
        .setName("role")
        .setDescription("Optional: when did they get this role? (e.g. Staff, Admin)")))
    .addSubcommand(sc => sc
      .setName("browse")
      .setDescription("Filter members by join tenure and/or a role")
      .addRoleOption(o => o
        .setName("role")
        .setDescription("Only members who currently have this role"))
      .addStringOption(o => o
        .setName("min_joined")
        .setDescription("Minimum time in the server")
        .addChoices(...TENURE_FILTER_CHOICES))
      .addStringOption(o => o
        .setName("min_role")
        .setDescription("Minimum time holding the role (needs role)")
        .addChoices(...TENURE_FILTER_CHOICES))
      .addStringOption(o => o
        .setName("sort")
        .setDescription("Sort order")
        .addChoices(
          { name: "Newest joins first", value: "joined_desc" },
          { name: "Oldest joins first", value: "joined_asc" },
          { name: "Newest role grants first", value: "role_desc" },
          { name: "Oldest role grants first", value: "role_asc" },
          { name: "Name A–Z", value: "name" },
        )))
    .toJSON();
}
