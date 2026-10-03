import {
  AuditLogEvent,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type PartialGuildMember,
} from "discord.js";
import {
  deleteRoleGrant,
  getRoleGrant,
  upsertRoleGrant,
} from "../../lib/memberdate/db.js";

export type ResolvedRoleGrant = {
  grantedAt: Date | null;
  source: "live" | "audit" | "unknown";
  note: string | null;
};

/**
 * Live tracker: when roles are added/removed on a member, persist grant times.
 * Called from GuildMemberUpdate — fire-and-forget safe.
 */
export async function trackMemberRoleChanges(
  oldMember: GuildMember | PartialGuildMember | null,
  newMember: GuildMember,
): Promise<void> {
  if (!newMember.guild || newMember.user.bot) return;
  // Incomplete old snapshots would look like "every current role was just added"
  // and stamp false grant times — skip until we have a full before/after.
  if (!oldMember || oldMember.partial || !oldMember.roles?.cache) return;
  const guildId = newMember.guild.id;
  const userId = newMember.id;

  const oldIds = new Set(oldMember.roles.cache.keys());
  const newIds = new Set(newMember.roles.cache.keys());
  // @everyone is always present — skip.
  oldIds.delete(guildId);
  newIds.delete(guildId);

  const added: string[] = [];
  const removed: string[] = [];
  for (const id of newIds) if (!oldIds.has(id)) added.push(id);
  for (const id of oldIds) if (!newIds.has(id)) removed.push(id);

  const now = new Date();
  for (const roleId of added) {
    await upsertRoleGrant({
      guildId,
      userId,
      roleId,
      grantedAt: now,
      source: "live",
    }).catch(() => {});
  }
  for (const roleId of removed) {
    await deleteRoleGrant(guildId, userId, roleId).catch(() => {});
  }
}

/**
 * Resolve when `member` received `roleId`.
 * Order: DB track → audit log backfill → unknown.
 */
export async function resolveRoleGrant(
  guild: Guild,
  member: GuildMember,
  roleId: string,
): Promise<ResolvedRoleGrant> {
  if (!member.roles.cache.has(roleId)) {
    return {
      grantedAt: null,
      source: "unknown",
      note: "They do not currently have this role.",
    };
  }

  const existing = await getRoleGrant(guild.id, member.id, roleId).catch(() => null);
  if (existing) {
    return {
      grantedAt: existing.grantedAt,
      source: existing.source === "audit" ? "audit" : "live",
      note: existing.source === "audit" ? "From Discord audit log" : "Tracked live by Dex",
    };
  }

  const fromAudit = await findGrantInAuditLog(guild, member.id, roleId);
  if (fromAudit) {
    await upsertRoleGrant({
      guildId: guild.id,
      userId: member.id,
      roleId,
      grantedAt: fromAudit,
      source: "audit",
    }).catch(() => {});
    return {
      grantedAt: fromAudit,
      source: "audit",
      note: "From Discord audit log",
    };
  }

  return {
    grantedAt: null,
    source: "unknown",
    note:
      "Grant date unknown — not in recent audit log and not tracked yet. " +
      "Dex records new role grants going forward.",
  };
}

async function findGrantInAuditLog(
  guild: Guild,
  userId: string,
  roleId: string,
): Promise<Date | null> {
  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
    return null;
  }

  // Walk a few pages of MemberRoleUpdate entries looking for this target+role.
  let before: string | undefined;
  for (let page = 0; page < 5; page++) {
    const logs = await guild.fetchAuditLogs({
      type: AuditLogEvent.MemberRoleUpdate,
      limit: 100,
      ...(before ? { before } : {}),
    }).catch(() => null);
    if (!logs || logs.entries.size === 0) break;

    let oldestId: string | null = null;
    for (const [, entry] of logs.entries) {
      oldestId = entry.id;
      if (entry.targetId !== userId) continue;
      const changes = entry.changes ?? [];
      for (const change of changes) {
        // $add: roles added on this update
        if (change.key !== "$add" || !Array.isArray(change.new)) continue;
        const hit = (change.new as Array<{ id?: string }>).some(r => r?.id === roleId);
        if (hit && entry.createdAt) {
          return entry.createdAt;
        }
      }
    }
    if (!oldestId || logs.entries.size < 100) break;
    before = oldestId;
  }
  return null;
}
