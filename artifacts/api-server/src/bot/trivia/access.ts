import {
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type PermissionsBitField,
} from "discord.js";

export type PermLike = Pick<PermissionsBitField, "has"> | null | undefined;

export function memberIsTriviaStaff(
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

export function botCanHostTrivia(bot: GuildMember | null | undefined): boolean {
  if (!bot) return false;
  return (
    bot.permissions.has(PermissionFlagsBits.SendMessages) &&
    bot.permissions.has(PermissionFlagsBits.EmbedLinks) &&
    (bot.permissions.has(PermissionFlagsBits.ManageRoles) ||
      bot.permissions.has(PermissionFlagsBits.Administrator))
  );
}

export async function resolveTriviaStaffAccess(input: {
  userId: string;
  guild: Guild | null;
  memberPermissions: PermLike;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const { userId, guild, memberPermissions } = input;
  if (!guild) return { ok: false, message: "Server only." };
  if (!memberIsTriviaStaff(userId, guild.ownerId, memberPermissions)) {
    return {
      ok: false,
      message: "Staff only — need **Manage Server**, **Manage Messages**, or **Administrator**.",
    };
  }
  let me = guild.members.me;
  if (!me) {
    try { me = await guild.members.fetchMe(); } catch { me = null; }
  }
  if (!botCanHostTrivia(me)) {
    return {
      ok: false,
      message:
        "Dex N Cards needs **Send Messages**, **Embed Links**, and **Manage Roles** to host trivia and award winner roles.",
    };
  }
  return { ok: true };
}

export const TRIVIA_DEFAULT_MEMBER_PERMISSIONS =
  PermissionFlagsBits.ManageGuild |
  PermissionFlagsBits.ManageMessages |
  PermissionFlagsBits.Administrator;
