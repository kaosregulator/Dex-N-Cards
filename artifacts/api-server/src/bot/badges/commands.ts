/** Discord handlers for the /badges hub (catalogue, collection, Give / Take). */

import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  GuildMember,
  StringSelectMenuInteraction,
  UserSelectMenuInteraction,
} from "discord.js";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags,
  PermissionFlagsBits, StringSelectMenuBuilder, UserSelectMenuBuilder,
} from "discord.js";
import {
  getOrCreateBadgeSettings,
  getOrCreateMemberBadges,
  rulesForGuild,
} from "../../lib/badges/db.js";
import {
  normalizeEarnedList,
  progressBar,
  tierForLevel,
  xpToNextLevel,
  BADGE_LEVEL_MAX,
} from "../../lib/badges/levels.js";
import { awardManualBadge, takeBadge } from "./engine.js";
import { buildBadgeShowcase } from "./announce.js";

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
  await interaction.deferReply(EPHEMERAL);
  const target = interaction.options.getUser("member") ?? interaction.user;
  const payload = await buildBadgeHub(interaction.guildId, interaction.guild, interaction.member as GuildMember | null, target.id, "collection");
  await interaction.editReply(payload);
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
          .setTitle("🏅 Emblem catalogue")
          .setDescription(
            settings.enabled
              ? (lines.length ? lines.join("\n\n") : "_No rules configured._")
              : "_Badge system is disabled in dashboard settings._",
          )
          .setFooter({ text: "Emblems level 1–100. Customize in the dashboard Badges hub." }),
      ],
    });
    return;
  }

  if (sub === "show") {
    await interaction.deferReply();
    const badgeId = interaction.options.getString("badge_id", true).toLowerCase().trim();
    const target = interaction.options.getUser("member") ?? interaction.user;
    const settings = await getOrCreateBadgeSettings(interaction.guildId);
    const rules = rulesForGuild(settings);
    const rule = rules.find(r => r.id === badgeId);
    if (!rule) {
      await interaction.editReply({ content: "That badge ID is not in the catalogue." });
      return;
    }
    const store = await getOrCreateMemberBadges(interaction.guildId, target.id);
    const earned = normalizeEarnedList(store.earned).find(e => e.id === badgeId);
    if (!earned) {
      await interaction.editReply({
        content: `<@${target.id}> has not awakened **${rule.name}** yet.`,
        allowedMentions: { users: [] },
      });
      return;
    }
    const showcase = await buildBadgeShowcase({
      result: {
        badge: earned,
        leveled: false,
        levelsGained: 0,
        previousLevel: earned.level,
        tierChanged: false,
        previousTier: tierForLevel(earned.level),
        tier: tierForLevel(earned.level),
        unlocked: false,
        xpGranted: 0,
        capped: false,
      },
      rule,
      forceEmblem: true,
    });
    await interaction.editReply({
      content: `<@${target.id}>'s **${rule.name}** emblem`,
      embeds: showcase.embeds,
      files: showcase.files,
      allowedMentions: { users: [] },
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
    const rule = result.rules.find(r => r.id === badgeId)!;
    const showcase = await buildBadgeShowcase({
      result: result.result,
      rule,
      mention: `<@${target.id}>`,
      forceEmblem: true,
    });
    await interaction.editReply({
      content: showcase.content,
      embeds: showcase.embeds,
      files: showcase.files,
      allowedMentions: { users: [target.id] },
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
      content: `Removed the ${result.rule.emoji} **${result.rule.name}** emblem from <@${target.id}>.`,
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

const NEED_ADMIN = "❌ You need to be an admin to use this.";

type BadgeHubView = "collection" | "catalogue";

async function buildBadgeHub(
  guildId: string,
  guild: { members: { fetch: (id: string) => Promise<GuildMember> } },
  actor: GuildMember | null,
  targetId: string,
  view: BadgeHubView,
  badgeId?: string,
  notice?: string,
) {
  const settings = await getOrCreateBadgeSettings(guildId);
  const rules = rulesForGuild(settings);
  const member = await guild.members.fetch(targetId).catch(() => null);
  const display = member?.displayName ?? "that member";
  const store = await getOrCreateMemberBadges(guildId, targetId);
  const earned = normalizeEarnedList(store.earned).sort((a, b) => b.level - a.level || a.timestamp - b.timestamp);
  const staff = await isBadgeStaff(guildId, actor);

  const embed = new EmbedBuilder().setColor(COLOR);
  if (view === "catalogue") {
    const lines = rules.map(r => {
      const extra = r.trigger === "trivia" && r.triviaMode
        ? ` · mode \`${r.triviaMode}\``
        : r.channel
          ? ` · <#${r.channel}>`
          : "";
      return `${r.emoji} \`${r.id}\` **${r.name}** — ${r.trigger}${r.threshold > 0 ? ` ≥${r.threshold}` : ""}${extra}`;
    });
    embed
      .setTitle("🏅 Emblem catalogue")
      .setDescription(
        (notice ? `${notice}\n\n` : "") +
        (settings.enabled
          ? (lines.length ? lines.join("\n").slice(0, 3500) : "_No rules configured._")
          : "_Badge system is disabled in dashboard settings._"),
      )
      .setFooter({ text: staff ? "Give / Take need a member and a badge." : "Give / Take are staff only — catalogue and show are open to everyone." });
  } else {
    const fields = earned.map(item => {
      const rule = rules.find(r => r.id === item.id);
      if (!rule) return null;
      const tier = tierForLevel(item.level);
      const need = item.level >= BADGE_LEVEL_MAX ? 0 : xpToNextLevel(item.level);
      const bar = progressBar(item.level, item.xp, 8);
      return {
        name: `${rule.emoji} ${rule.name}`,
        value: [
          `Lv. **${item.level}** · ${tier.label}`,
          item.level >= BADGE_LEVEL_MAX ? "`████████` Apex" : `\`${bar}\` ${item.xp}/${need}`,
          `_${rule.description}_`,
        ].join("\n"),
        inline: true,
      };
    }).filter((f): f is NonNullable<typeof f> => f !== null);
    embed
      .setTitle(`${display}'s Emblems`)
      .setDescription(
        (notice ? `${notice}\n\n` : "") +
        (fields.length
          ? `**${fields.length}** emblem${fields.length === 1 ? "" : "s"} · pick a member and a badge, then Show / Give / Take`
          : "No emblems yet — win trivia, get staff recognition, or hit activity goals."),
      )
      .addFields(fields.slice(0, 25));
  }

  const suffix = `${targetId}:${view}:${badgeId ?? "-"}`;
  const components: ActionRowBuilder<any>[] = [
    new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new UserSelectMenuBuilder().setCustomId(`badgeshub:user:${view}:${badgeId ?? "-"}`).setPlaceholder("Whose emblems…"),
    ),
  ];
  if (rules.length > 0) {
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`badgeshub:pick:${suffix}`)
        .setPlaceholder(badgeId ? `Badge: ${badgeId}` : "Pick a badge…")
        .addOptions(rules.slice(0, 25).map(r => ({
          label: r.name.slice(0, 100),
          value: r.id,
          description: r.id.slice(0, 100),
          emoji: r.emoji.match(/^\p{Extended_Pictographic}/u) ? r.emoji : undefined,
          default: r.id === badgeId,
        }))),
    ));
  }
  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`badgeshub:catalogue:${suffix}`).setLabel("Catalogue").setEmoji("📚").setStyle(view === "catalogue" ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`badgeshub:collection:${suffix}`).setLabel("Collection").setEmoji("🏅").setStyle(view === "collection" ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`badgeshub:show:${suffix}`).setLabel("Show").setEmoji("✨").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`badgeshub:give:${suffix}`).setLabel("Give").setEmoji("🎁").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`badgeshub:take:${suffix}`).setLabel("Take").setEmoji("🗑️").setStyle(ButtonStyle.Danger),
  ));
  return { embeds: [embed], components, files: [] as import("discord.js").AttachmentBuilder[] };
}

function parseHubId(customId: string): { action: string; targetId: string; view: BadgeHubView; badgeId?: string } {
  const parts = customId.split(":");
  const action = parts[1] ?? "collection";
  // user select: badgeshub:user:view:badge
  if (action === "user") {
    return { action, targetId: "", view: (parts[2] as BadgeHubView) || "collection", badgeId: parts[3] === "-" ? undefined : parts[3] };
  }
  return {
    action,
    targetId: parts[2] ?? "",
    view: (parts[3] as BadgeHubView) || "collection",
    badgeId: parts[4] === "-" || !parts[4] ? undefined : parts[4],
  };
}

export async function handleBadgeHubComponent(
  interaction: ButtonInteraction | StringSelectMenuInteraction | UserSelectMenuInteraction,
): Promise<void> {
  if (!interaction.guildId || !interaction.guild) return;
  const parsed = parseHubId(interaction.customId);
  const actor = interaction.member as GuildMember | null;

  if (interaction.isUserSelectMenu()) {
    const targetId = interaction.values[0]!;
    await interaction.update(await buildBadgeHub(
      interaction.guildId, interaction.guild, actor, targetId, parsed.view, parsed.badgeId,
    ));
    return;
  }

  if (interaction.isStringSelectMenu() && parsed.action === "pick") {
    const badgeId = interaction.values[0]!;
    await interaction.update(await buildBadgeHub(
      interaction.guildId, interaction.guild, actor, parsed.targetId || interaction.user.id, parsed.view, badgeId,
    ));
    return;
  }

  if (!interaction.isButton()) return;
  const targetId = parsed.targetId || interaction.user.id;
  const { action, view, badgeId } = parsed;

  if (action === "catalogue" || action === "collection") {
    await interaction.update(await buildBadgeHub(
      interaction.guildId, interaction.guild, actor, targetId, action, badgeId,
    ));
    return;
  }

  if (action === "show") {
    if (!badgeId) {
      await interaction.reply({ content: "Pick a badge from the dropdown first.", ...EPHEMERAL });
      return;
    }
    await interaction.deferReply();
    const settings = await getOrCreateBadgeSettings(interaction.guildId);
    const rules = rulesForGuild(settings);
    const rule = rules.find(r => r.id === badgeId);
    if (!rule) {
      await interaction.editReply({ content: "That badge is not in the catalogue." });
      return;
    }
    const store = await getOrCreateMemberBadges(interaction.guildId, targetId);
    const earned = normalizeEarnedList(store.earned).find(e => e.id === badgeId);
    if (!earned) {
      await interaction.editReply({
        content: `<@${targetId}> has not awakened **${rule.name}** yet.`,
        allowedMentions: { users: [] },
      });
      return;
    }
    const showcase = await buildBadgeShowcase({
      result: {
        badge: earned,
        leveled: false,
        levelsGained: 0,
        previousLevel: earned.level,
        tierChanged: false,
        previousTier: tierForLevel(earned.level),
        tier: tierForLevel(earned.level),
        unlocked: false,
        xpGranted: 0,
        capped: false,
      },
      rule,
      forceEmblem: true,
    });
    await interaction.editReply({
      content: `<@${targetId}>'s **${rule.name}** emblem`,
      embeds: showcase.embeds,
      files: showcase.files,
      allowedMentions: { users: [] },
    });
    return;
  }

  if (action === "give" || action === "take") {
    if (!(await isBadgeStaff(interaction.guildId, actor))) {
      await interaction.reply({ content: NEED_ADMIN, ...EPHEMERAL });
      return;
    }
    if (!badgeId) {
      await interaction.reply({ content: "Pick a member and a badge first.", ...EPHEMERAL });
      return;
    }
    if (action === "give") {
      await interaction.deferReply();
      const result = await awardManualBadge({
        guildId: interaction.guildId,
        userId: targetId,
        badgeId,
      });
      if (!result.ok) {
        await interaction.editReply({ content: result.message });
        return;
      }
      const rule = result.rules.find(r => r.id === badgeId)!;
      const showcase = await buildBadgeShowcase({
        result: result.result,
        rule,
        mention: `<@${targetId}>`,
        forceEmblem: true,
      });
      await interaction.editReply({
        content: showcase.content,
        embeds: showcase.embeds,
        files: showcase.files,
        allowedMentions: { users: [targetId] },
      });
      return;
    }
    await interaction.deferReply(EPHEMERAL);
    const result = await takeBadge({
      guildId: interaction.guildId,
      userId: targetId,
      badgeId,
    });
    if (!result.ok) {
      await interaction.editReply({ content: result.message });
      return;
    }
    await interaction.editReply({
      content: `Removed the ${result.rule.emoji} **${result.rule.name}** emblem from <@${targetId}>.`,
    });
  }
}
