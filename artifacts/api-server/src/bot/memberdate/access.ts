import {
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type PermissionsBitField,
} from "discord.js";

export type PermLike = Pick<PermissionsBitField, "has"> | null | undefined;

/** Owner, Admin, Manage Server, or Manage Messages — staff tenure tool. */
export function memberIsMemberDateStaff(
  userId: string,
  ownerId: string | null | undefined,
  permissions: PermLike,
): boolean {
  if (ownerId && userId === ownerId) return true;
  if (!permissions) return false;
  return (
    permissions.has(PermissionFlagsBits.Administrator) ||
    permissions.has(PermissionFlagsBits.ManageGuild) ||
    permissions.has(PermissionFlagsBits.ManageMessages)
  );
}

/** Bot only needs to read members + send ephemeral embeds. */
export function botCanRunMemberDate(bot: GuildMember | null | undefined): boolean {
  if (!bot) return false;
  return (
    bot.permissions.has(PermissionFlagsBits.ViewChannel) ||
    bot.permissions.has(PermissionFlagsBits.Administrator)
  );
}

export async function resolveMemberDateAccess(input: {
  userId: string;
  guild: Guild | null;
  memberPermissions: PermLike;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const { userId, guild, memberPermissions } = input;
  if (!guild) return { ok: false, message: "Server only." };
  if (!memberIsMemberDateStaff(userId, guild.ownerId, memberPermissions)) {
    return {
      ok: false,
      message:
        "Staff only — need **Manage Server**, **Manage Messages**, or **Administrator**.",
    };
  }
  let me = guild.members.me;
  if (!me) {
    try { me = await guild.members.fetchMe(); } catch { me = null; }
  }
  if (!botCanRunMemberDate(me)) {
    return {
      ok: false,
      message: "Dex N Cards needs to be able to see this server to look up members.",
    };
  }
  return { ok: true };
}

export const MEMBERDATE_DEFAULT_MEMBER_PERMISSIONS =
  PermissionFlagsBits.ManageGuild |
  PermissionFlagsBits.ManageMessages |
  PermissionFlagsBits.Administrator;
