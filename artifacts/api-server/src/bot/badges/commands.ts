/** Discord handlers for /badges and /badge give|take|catalogue. */

import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  GuildMember,
} from "discord.js";
import { EmbedBuilder, MessageFlags, PermissionFlagsBits } from "discord.js";
import {
  getOrCreateBadgeSettings,
  getOrCreateMemberBadges,
  rulesForGuild,
} from "../../lib/badges/db.js";
import { awardManualBadge, takeBadge, formatBadgeNames } from "./engine.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;
const COLOR = 0x5865f2;

async function isBadgeStaff(
  guildId: string,
  member: GuildMember | null,
): Promise<boolean> {
  if (!member) return false;
  if (
    member.permissions.has(PermissionFlagsBits.Administrator)
    || member.permissions.has(PermissionFlagsBits.ManageGuild)
  ) {
    return true;
  }
  const settings = await getOrCreateBadgeSettings(guildId);
  if (settings.staffRoleId && member.roles.cache.has(settings.staffRoleId)) {
    return true;
  }
  return false;
}

export async function handleBadgesCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: "Server only.", ...EPHEMERAL });
    return;
  }
  await interaction.deferReply();
  const target = interaction.options.getUser("member") ?? interaction.user;
  const member = await interaction.guild.members.fetch(target.id).catch(() => null);
  if (!member) {
    await interaction.editReply({ content: "Member not found." });
    return;
  }

  const settings = await getOrCreateBadgeSettings(interaction.guildId);
  const rules = rulesForGuild(settings);
  const store = await getOrCreateMemberBadges(interaction.guildId, target.id);
  const earned = [...(store.earned ?? [])].sort((a, b) => a.timestamp - b.timestamp);

  const fields = earned.map(item => {
    const rule = rules.find(r => r.id === item.id);
    if (!rule) return null;
    return {
      name: `${rule.emoji} ${rule.name}`,
      value: `${rule.description}\n*Earned: ${new Date(item.timestamp).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })}*`,
      inline: true,
    };
  }).filter((f): f is NonNullable<typeof f> => f !== null);

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(COLOR)
        .setTitle(`${member.displayName}'s Badges`)
        .setDescription(
          fields.length
            ? `**${fields.length}** badge${fields.length === 1 ? "" : "s"}`
            : "No badges yet!",
        )
        .addFields(fields.slice(0, 25)),
    ],
  });
}

export async function handleBadgeCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: "Server only.", ...EPHEMERAL });
    return;
  }
  const sub = interaction.options.getSubcommand(true);

  if (sub === "catalogue") {
    await interaction.deferReply(EPHEMERAL);
    const settings = await getOrCreateBadgeSettings(interaction.guildId);
    const rules = rulesForGuild(settings);
    const lines = rules.map(r => {
      const extra = r.trigger === "trivia" && r.triviaMode
        ? ` · mode \`${r.triviaMode}\``
        : r.channel
          ? ` · <#${r.channel}>`
          : "";
      return `${r.emoji} \`${r.id}\` **${r.name}** — ${r.trigger}${r.threshold > 0 ? ` ≥${r.threshold}` : ""}${extra}\n_${r.description}_`;
    });
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR)
          .setTitle("🏅 Badge catalogue")
          .setDescription(
            settings.enabled
              ? (lines.length ? lines.join("\n\n") : "_No rules configured._")
              : "_Badge system is disabled in dashboard settings._",
          )
          .setFooter({ text: "Customize rules in the dashboard Badges hub." }),
      ],
    });
    return;
  }

  const memberObj = interaction.member as GuildMember | null;
  if (!(await isBadgeStaff(interaction.guildId, memberObj))) {
    await interaction.reply({
      content: "Only staff can give or take badges.",
      ...EPHEMERAL,
    });
    return;
  }

  const target = interaction.options.getUser("member", true);
  const badgeId = interaction.options.getString("badge_id", true).toLowerCase().trim();

  if (sub === "give") {
    await interaction.deferReply();
    const result = await awardManualBadge({
      guildId: interaction.guildId,
      userId: target.id,
      badgeId,
    });
    if (!result.ok) {
      await interaction.editReply({ content: result.message });
      return;
    }
    await interaction.editReply({
      content: `🎉 <@${target.id}> earned ${formatBadgeNames(result.awarded, result.rules)}!`,
    });
    return;
  }

  if (sub === "take") {
    await interaction.deferReply(EPHEMERAL);
    const result = await takeBadge({
      guildId: interaction.guildId,
      userId: target.id,
      badgeId,
    });
    if (!result.ok) {
      await interaction.editReply({ content: result.message });
      return;
    }
    await interaction.editReply({
      content: `Removed the ${result.rule.emoji} **${result.rule.name}** badge from <@${target.id}>.`,
    });
  }
}

export async function handleBadgeAutocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.respond([]);
    return;
  }
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "badge_id") {
    await interaction.respond([]);
    return;
  }
  const settings = await getOrCreateBadgeSettings(interaction.guildId);
  const rules = rulesForGuild(settings);
  const sub = interaction.options.getSubcommand(false);
  const q = String(focused.value ?? "").toLowerCase();
  const filtered = rules
    .filter(r => (sub === "give" ? r.trigger === "manual" : true))
    .filter(r => !q || r.id.includes(q) || r.name.toLowerCase().includes(q))
    .slice(0, 25)
    .map(r => ({
      name: `${r.emoji} ${r.name} (${r.id})`.slice(0, 100),
      value: r.id,
    }));
  await interaction.respond(filtered);
}
