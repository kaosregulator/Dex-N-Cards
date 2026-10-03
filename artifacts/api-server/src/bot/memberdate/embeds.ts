import {
  EmbedBuilder,
  type Guild,
  type GuildMember,
  type Role,
} from "discord.js";
import {
  discordTimestamp,
  formatTenure,
  tenureFilterLabel,
  type TenureFilterKey,
} from "./format.js";
import { resolveRoleGrant } from "./role-grants.js";
import { PAGE_SIZE, type BrowseRow } from "./browse.js";

export const MEMBERDATE_COLOR = 0x57f287;
export { PAGE_SIZE, type BrowseRow, filterBrowseRows, sortBrowseRows } from "./browse.js";

export async function buildLookupEmbed(opts: {
  guild: Guild;
  member: GuildMember;
  role?: Role | null;
}): Promise<EmbedBuilder> {
  const { guild, member, role } = opts;
  const joinedMs = member.joinedTimestamp;
  const createdMs = member.user.createdTimestamp;
  const joinedTenure = joinedMs != null ? formatTenure(joinedMs) : null;

  const display = member.displayName;
  const tag = member.user.username;

  const lines: string[] = [
    `**${display}**${display !== tag ? ` · \`@${tag}\`` : ""}`,
    "",
    `📅 **Joined server** — ${discordTimestamp(joinedMs, "D")} (${discordTimestamp(joinedMs, "R")})`,
    joinedTenure
      ? `└ Been in **${guild.name}** for **${joinedTenure.label}**`
      : "└ Join date unknown",
    "",
    `🪪 **Discord account** — ${discordTimestamp(createdMs, "D")} (${discordTimestamp(createdMs, "R")})`,
    `└ Account age **${formatTenure(createdMs).label}**`,
  ];

  if (role) {
    const grant = await resolveRoleGrant(guild, member, role.id);
    lines.push("");
    if (!member.roles.cache.has(role.id)) {
      lines.push(`🎖️ **${role.name}** — they do **not** have this role right now.`);
    } else if (grant.grantedAt) {
      const roleTenure = formatTenure(grant.grantedAt);
      lines.push(
        `🎖️ **${role.name}** since ${discordTimestamp(grant.grantedAt, "D")} (${discordTimestamp(grant.grantedAt, "R")})`,
        `└ Been **${role.name}** for **${roleTenure.label}**`,
      );
      if (grant.note) lines.push(`└ _${grant.note}_`);
    } else {
      lines.push(
        `🎖️ **${role.name}** — they have it now`,
        `└ ${grant.note ?? "Grant date unknown"}`,
      );
    }
  }

  const topRoles = member.roles.cache
    .filter(r => r.id !== guild.id)
    .sort((a, b) => b.position - a.position)
    .map(r => r.toString())
    .slice(0, 12);
  if (topRoles.length) {
    lines.push("", `Roles · ${topRoles.join(" ")}`);
  }

  return new EmbedBuilder()
    .setColor(member.displayColor || MEMBERDATE_COLOR)
    .setAuthor({
      name: `${display} · member tenure`,
      iconURL: member.displayAvatarURL({ size: 64 }),
    })
    .setThumbnail(member.displayAvatarURL({ size: 256 }))
    .setDescription(lines.join("\n"))
    .setFooter({ text: "Staff only · /memberdate" })
    .setTimestamp();
}

export function buildBrowseEmbed(opts: {
  guild: Guild;
  rows: BrowseRow[];
  page: number;
  role?: Role | null;
  minJoined: TenureFilterKey;
  minRole: TenureFilterKey;
  sort: string;
}): EmbedBuilder {
  const { guild, rows, page, role, minJoined, minRole, sort } = opts;
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const slice = rows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const filterBits = [
    `Joined: **${tenureFilterLabel(minJoined)}**`,
  ];
  if (role) {
    filterBits.push(`Role: ${role.toString()}`);
    filterBits.push(`In role: **${tenureFilterLabel(minRole)}**`);
  }
  filterBits.push(`Sort: \`${sort}\``);

  const lines: string[] = [];
  if (slice.length === 0) {
    lines.push("_No members match these filters._");
  } else {
    for (const row of slice) {
      const m = row.member;
      const joinedBit = row.joinedMs != null
        ? `${discordTimestamp(row.joinedMs, "D")} · **${formatTenure(row.joinedMs).label}** in server`
        : "join unknown";
      let roleBit = "";
      if (role) {
        if (row.roleGrantedAt) {
          roleBit = `\n└ ${role.name} since ${discordTimestamp(row.roleGrantedAt, "D")} · **${formatTenure(row.roleGrantedAt).label}**`;
        } else {
          roleBit = `\n└ ${role.name} · grant date unknown`;
        }
      }
      lines.push(`• **${m.displayName}** (<@${m.id}>)\n└ ${joinedBit}${roleBit}`);
    }
  }

  return new EmbedBuilder()
    .setColor(MEMBERDATE_COLOR)
    .setTitle(`👥 Member tenure · ${guild.name}`)
    .setDescription(
      `${filterBits.join(" · ")}\n` +
      `**${rows.length}** match${rows.length === 1 ? "" : "es"} · page **${safePage + 1}/${totalPages}**\n\n` +
      lines.join("\n\n"),
    )
    .setFooter({ text: "Staff only · /memberdate browse" })
    .setTimestamp();
}
