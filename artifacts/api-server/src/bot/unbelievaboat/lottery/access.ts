import {
  PermissionFlagsBits,
  type Guild,
  type PermissionsBitField,
} from "discord.js";

export type PermLike = Pick<PermissionsBitField, "has"> | null | undefined;

export function memberIsLotteryAdmin(
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

export async function resolveLotteryAdminAccess(input: {
  userId: string;
  guild: Guild | null;
  memberPermissions: PermLike;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const { userId, guild, memberPermissions } = input;
  if (!guild) return { ok: false, message: "Server only." };
  if (!memberIsLotteryAdmin(userId, guild.ownerId, memberPermissions)) {
    return {
      ok: false,
      message: "Admin only — need **Manage Server** or **Administrator**.",
    };
  }
  return { ok: true };
}

export const LOTTERY_ADMIN_DEFAULT_PERMISSIONS =
  PermissionFlagsBits.ManageGuild | PermissionFlagsBits.Administrator;
