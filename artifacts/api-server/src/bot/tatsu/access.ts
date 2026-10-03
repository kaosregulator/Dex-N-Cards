// Discord-side access gate for `/tatsu`.
// Tatsu's REST API separately checks the Discord account that owns TATSU_API_KEY;
// this module only validates the invoker + our bot in the guild.

import {
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type PermissionResolvable,
  type PermissionsBitField,
} from "discord.js";

export type PermLike = Pick<PermissionsBitField, "has"> | null | undefined;

export type TatsuAccessOk = { ok: true };
export type TatsuAccessDenied = {
  ok: false;
  reason: "no_guild" | "user" | "bot";
  message: string;
};
export type TatsuAccessResult = TatsuAccessOk | TatsuAccessDenied;

/** Owner, Administrator, or Manage Server — enough to run `/tatsu` edits. */
export function memberHasTatsuStaffPerms(
  userId: string,
  ownerId: string | null | undefined,
  permissions: PermLike,
): boolean {
  if (ownerId && userId === ownerId) return true;
  if (!permissions) return false;
  return (
    permissions.has(PermissionFlagsBits.Administrator) ||
    permissions.has(PermissionFlagsBits.ManageGuild)
  );
}

/** Bot must also hold Administrator or Manage Server in this guild. */
export function botHasTatsuStaffPerms(bot: GuildMember | null | undefined): boolean {
  if (!bot) return false;
  return (
    bot.permissions.has(PermissionFlagsBits.Administrator) ||
    bot.permissions.has(PermissionFlagsBits.ManageGuild)
  );
}

export async function resolveTatsuAccess(input: {
  userId: string;
  guild: Guild | null;
  memberPermissions: PermLike;
}): Promise<TatsuAccessResult> {
  const { userId, guild, memberPermissions } = input;
  if (!guild) {
    return { ok: false, reason: "no_guild", message: "Server only." };
  }

  if (!memberHasTatsuStaffPerms(userId, guild.ownerId, memberPermissions)) {
    return {
      ok: false,
      reason: "user",
      message: "You need **Manage Server** or **Administrator** (or be the server owner) to use `/tatsu`.",
    };
  }

  let me = guild.members.me;
  if (!me) {
    try {
      me = await guild.members.fetchMe();
    } catch {
      me = null;
    }
  }

  if (!botHasTatsuStaffPerms(me)) {
    return {
      ok: false,
      reason: "bot",
      message:
        "Dex N Cards needs **Manage Server** (or Administrator) in this server to run Tatsu edits. " +
        "Re-invite the bot with that permission, or grant it on the bot's role.",
    };
  }

  return { ok: true };
}

/** Slash default: Manage Server or Administrator (owners always pass Discord's check). */
export const TATSU_DEFAULT_MEMBER_PERMISSIONS =
  PermissionFlagsBits.ManageGuild | PermissionFlagsBits.Administrator;

export function tatsuStaffPermissionList(): PermissionResolvable[] {
  return [PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild];
}
