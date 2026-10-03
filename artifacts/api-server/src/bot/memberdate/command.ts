// /memberdate — staff tenure lookups (join date + targeted role grant time).

import type {
  ChatInputCommandInteraction,
  ButtonInteraction,
  Guild,
  GuildMember,
  Role,
} from "discord.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from "discord.js";
import { resolveMemberDateAccess } from "./access.js";
import { type TenureFilterKey } from "./format.js";
import { buildLookupEmbed, buildBrowseEmbed } from "./embeds.js";
import {
  filterBrowseRows,
  sortBrowseRows,
  PAGE_SIZE,
  type BrowseRow,
} from "./browse.js";
import { getRoleGrantsForUsers } from "../../lib/memberdate/db.js";
import { resolveRoleGrant } from "./role-grants.js";

export { buildMemberDateCommandJson } from "./definition.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

/** Ephemeral browse sessions keyed by staff user id. */
const browseSessions = new Map<string, {
  guildId: string;
  rows: BrowseRow[];
  page: number;
  roleId: string | null;
  minJoined: TenureFilterKey;
  minRole: TenureFilterKey;
  sort: string;
  expires: number;
}>();

const SESSION_TTL_MS = 15 * 60_000;

function pruneSessions() {
  const now = Date.now();
  for (const [k, v] of browseSessions) {
    if (v.expires < now) browseSessions.delete(k);
  }
}

async function denyUnlessStaff(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
): Promise<boolean> {
  const access = await resolveMemberDateAccess({
    userId: interaction.user.id,
    guild: interaction.guild,
    memberPermissions: interaction.memberPermissions,
  });
  if (access.ok) return true;
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content: access.message, ...EPHEMERAL }).catch(() => {});
  } else {
    await interaction.reply({ content: access.message, ...EPHEMERAL }).catch(() => {});
  }
  return false;
}

export async function handleMemberDateCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!(await denyUnlessStaff(interaction))) return;
  const sub = interaction.options.getSubcommand(true);
  if (sub === "lookup") {
    await handleLookup(interaction);
  } else {
    await handleBrowse(interaction);
  }
}

async function handleLookup(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply(EPHEMERAL);
  const guild = interaction.guild!;
  const user = interaction.options.getUser("user", true);
  const role = interaction.options.getRole("role");

  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) {
    await interaction.editReply({
      content: `Couldn't find <@${user.id}> in this server (they may have left).`,
    });
    return;
  }

  const embed = await buildLookupEmbed({
    guild,
    member,
    role: role as Role | null,
  });
  await interaction.editReply({ embeds: [embed] });
}

async function handleBrowse(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply(EPHEMERAL);
  const guild = interaction.guild!;
  const role = interaction.options.getRole("role") as Role | null;
  const minJoined = (interaction.options.getString("min_joined") ?? "any") as TenureFilterKey;
  const minRole = (interaction.options.getString("min_role") ?? "any") as TenureFilterKey;
  const sort = interaction.options.getString("sort") ?? "joined_desc";

  if (minRole !== "any" && !role) {
    await interaction.editReply({
      content: "Pick a **role** when using **min_role** — otherwise there's nothing to measure.",
    });
    return;
  }

  const rows = await collectBrowseRows(guild, role);
  const filtered = filterBrowseRows(rows, {
    minJoined,
    minRole,
    requireRoleGrant: Boolean(role) && minRole !== "any",
  });
  const sorted = sortBrowseRows(filtered, sort);

  pruneSessions();
  browseSessions.set(interaction.user.id, {
    guildId: guild.id,
    rows: sorted,
    page: 0,
    roleId: role?.id ?? null,
    minJoined,
    minRole,
    sort,
    expires: Date.now() + SESSION_TTL_MS,
  });

  const embed = buildBrowseEmbed({
    guild,
    rows: sorted,
    page: 0,
    role,
    minJoined,
    minRole,
    sort,
  });
  await interaction.editReply({
    embeds: [embed],
    components: browseNavRows(0, sorted.length),
  });
}

async function collectBrowseRows(guild: Guild, role: Role | null): Promise<BrowseRow[]> {
  // Fetch full member list (GuildMembers intent is already enabled).
  const all = await guild.members.fetch();
  let members: GuildMember[];
  if (role) {
    members = [...all.values()].filter(m => !m.user.bot && m.roles.cache.has(role.id));
  } else {
    members = [...all.values()].filter(m => !m.user.bot);
  }

  const grantMap = role
    ? await getRoleGrantsForUsers(guild.id, role.id, members.map(m => m.id)).catch(() => new Map())
    : new Map();

  // For browse lists we use DB grants only (fast). Unknowns show as unknown;
  // staff can /memberdate lookup for audit-log backfill on one person.
  const rows: BrowseRow[] = members.map(m => ({
    member: m,
    joinedMs: m.joinedTimestamp,
    roleGrantedAt: role ? (grantMap.get(m.id)?.grantedAt ?? null) : null,
  }));

  // If a role filter is set and we have few members, try resolving a handful
  // of unknown grants via audit (best-effort, capped).
  if (role && members.length > 0 && members.length <= 40) {
    const unknowns = rows.filter(r => r.roleGrantedAt == null).slice(0, 15);
    for (const row of unknowns) {
      const resolved = await resolveRoleGrant(guild, row.member, role.id).catch(() => null);
      if (resolved?.grantedAt) row.roleGrantedAt = resolved.grantedAt;
    }
  }

  return rows;
}

function browseNavRows(page: number, total: number) {
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("memberdate:page:prev")
        .setLabel("Prev")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage <= 0),
      new ButtonBuilder()
        .setCustomId("memberdate:page:refresh")
        .setLabel(`${safePage + 1} / ${totalPages}`)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId("memberdate:page:next")
        .setLabel("Next")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage >= totalPages - 1),
    ),
  ];
}

export async function handleMemberDateComponent(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!(await denyUnlessStaff(interaction))) return;
  pruneSessions();
  const session = browseSessions.get(interaction.user.id);
  if (!session || session.guildId !== interaction.guildId) {
    await interaction.reply({
      content: "That browse list expired — run `/memberdate browse` again.",
      ...EPHEMERAL,
    });
    return;
  }

  const parts = interaction.customId.split(":"); // memberdate:page:next
  const action = parts[2];
  if (action === "prev") session.page = Math.max(0, session.page - 1);
  else if (action === "next") session.page += 1;
  session.expires = Date.now() + SESSION_TTL_MS;

  const role = session.roleId
    ? await interaction.guild!.roles.fetch(session.roleId).catch(() => null)
    : null;

  const embed = buildBrowseEmbed({
    guild: interaction.guild!,
    rows: session.rows,
    page: session.page,
    role,
    minJoined: session.minJoined,
    minRole: session.minRole,
    sort: session.sort,
  });

  await interaction.update({
    embeds: [embed],
    components: browseNavRows(session.page, session.rows.length),
  });
}
