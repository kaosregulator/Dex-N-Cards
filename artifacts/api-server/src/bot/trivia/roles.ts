import type { Guild, GuildMember, Role } from "discord.js";
import {
  addRoleHold,
  clearRoleHoldsForKey,
  deleteRoleHold,
  getOrCreateTriviaSettings,
  listExpiredRoleHolds,
  updateTriviaSettings,
} from "../../lib/trivia/db.js";
import { logger } from "../../lib/logger.js";
import { TRIVIA_ROLE_DEFS, roleKeyForMode } from "./role-defs.js";

export { TRIVIA_ROLE_DEFS, roleKeyForMode };

async function ensureRole(guild: Guild, key: string, existingId?: string | null): Promise<Role | null> {
  const def = TRIVIA_ROLE_DEFS.find(r => r.key === key);
  if (!def) return null;
  if (existingId) {
    const cached = guild.roles.cache.get(existingId) ?? await guild.roles.fetch(existingId).catch(() => null);
    if (cached) return cached;
  }
  const byName = guild.roles.cache.find(r => r.name === def.name);
  if (byName) return byName;
  try {
    return await guild.roles.create({
      name: def.name,
      color: def.color,
      reason: `DN Cards trivia — ${def.reason}`,
      mentionable: true,
    });
  } catch (err) {
    logger.warn({ err, guildId: guild.id, key }, "trivia role create failed");
    return null;
  }
}

/** Ensure all showcase roles exist; persist ids on settings. */
export async function ensureTriviaRoles(guild: Guild): Promise<Record<string, string>> {
  const settings = await getOrCreateTriviaSettings(guild.id);
  const roleIds = { ...(settings.roleIds ?? {}) };
  let changed = false;
  for (const def of TRIVIA_ROLE_DEFS) {
    const role = await ensureRole(guild, def.key, roleIds[def.key]);
    if (role && roleIds[def.key] !== role.id) {
      roleIds[def.key] = role.id;
      changed = true;
    }
  }
  if (changed) await updateTriviaSettings(guild.id, { roleIds });
  return roleIds;
}

/**
 * Award a temporary winner role. Previous holders of the same key lose it
 * (until-next-winner). Also expires after 24h via sweeper.
 */
export async function awardTriviaWinnerRole(opts: {
  guild: Guild;
  userId: string;
  mode: string;
  roundId?: number | null;
  alsoBrainiac?: boolean;
}): Promise<string[]> {
  const awarded: string[] = [];
  const roleIds = await ensureTriviaRoles(opts.guild);
  const keys = [roleKeyForMode(opts.mode)];
  if (opts.alsoBrainiac) keys.push("brainiac");

  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000);

  for (const key of keys) {
    const roleId = roleIds[key];
    if (!roleId) continue;
    const prev = await clearRoleHoldsForKey(opts.guild.id, key);
    for (const hold of prev) {
      try {
        const member = await opts.guild.members.fetch(hold.userId).catch(() => null);
        await member?.roles.remove(hold.roleId, "Trivia role transferred to new winner").catch(() => {});
      } catch { /* ignore */ }
    }
    try {
      const member = await opts.guild.members.fetch(opts.userId);
      await member.roles.add(roleId, `Trivia ${key}`);
      await addRoleHold({
        guildId: opts.guild.id,
        userId: opts.userId,
        roleId,
        roleKey: key,
        roundId: opts.roundId,
        expiresAt,
      });
      awarded.push(key);
    } catch (err) {
      logger.warn({ err, userId: opts.userId, key }, "trivia role award failed");
    }
  }
  return awarded;
}

export async function sweepExpiredTriviaRoles(guildResolver: (guildId: string) => Promise<Guild | null>): Promise<number> {
  const holds = await listExpiredRoleHolds();
  let n = 0;
  for (const hold of holds) {
    try {
      const guild = await guildResolver(hold.guildId);
      if (guild) {
        const member: GuildMember | null = await guild.members.fetch(hold.userId).catch(() => null);
        await member?.roles.remove(hold.roleId, "Trivia winner role expired").catch(() => {});
      }
      await deleteRoleHold(hold.id);
      n++;
    } catch (err) {
      logger.debug({ err, holdId: hold.id }, "trivia role expire failed");
    }
  }
  return n;
}
