import { and, eq, inArray } from "drizzle-orm";
import { db, memberRoleGrantsTable, type MemberRoleGrant } from "@workspace/db";

export async function getRoleGrant(
  guildId: string,
  userId: string,
  roleId: string,
): Promise<MemberRoleGrant | null> {
  const rows = await db
    .select()
    .from(memberRoleGrantsTable)
    .where(
      and(
        eq(memberRoleGrantsTable.guildId, guildId),
        eq(memberRoleGrantsTable.userId, userId),
        eq(memberRoleGrantsTable.roleId, roleId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getRoleGrantsForUsers(
  guildId: string,
  roleId: string,
  userIds: string[],
): Promise<Map<string, MemberRoleGrant>> {
  const out = new Map<string, MemberRoleGrant>();
  if (userIds.length === 0) return out;
  // Chunk to keep IN lists reasonable.
  const chunk = 200;
  for (let i = 0; i < userIds.length; i += chunk) {
    const slice = userIds.slice(i, i + chunk);
    const rows = await db
      .select()
      .from(memberRoleGrantsTable)
      .where(
        and(
          eq(memberRoleGrantsTable.guildId, guildId),
          eq(memberRoleGrantsTable.roleId, roleId),
          inArray(memberRoleGrantsTable.userId, slice),
        ),
      );
    for (const row of rows) out.set(row.userId, row);
  }
  return out;
}

/** Record a grant. Prefer earlier known timestamps (do not overwrite older with newer). */
export async function upsertRoleGrant(input: {
  guildId: string;
  userId: string;
  roleId: string;
  grantedAt: Date;
  source: "live" | "audit";
}): Promise<MemberRoleGrant> {
  const existing = await getRoleGrant(input.guildId, input.userId, input.roleId);
  if (existing) {
    // Keep the earliest known grant time.
    if (existing.grantedAt.getTime() <= input.grantedAt.getTime()) {
      return existing;
    }
    const [row] = await db
      .update(memberRoleGrantsTable)
      .set({
        grantedAt: input.grantedAt,
        source: input.source,
        updatedAt: new Date(),
      })
      .where(eq(memberRoleGrantsTable.id, existing.id))
      .returning();
    return row!;
  }

  const [row] = await db
    .insert(memberRoleGrantsTable)
    .values({
      guildId: input.guildId,
      userId: input.userId,
      roleId: input.roleId,
      grantedAt: input.grantedAt,
      source: input.source,
    })
    .returning();
  return row!;
}

export async function deleteRoleGrant(
  guildId: string,
  userId: string,
  roleId: string,
): Promise<void> {
  await db
    .delete(memberRoleGrantsTable)
    .where(
      and(
        eq(memberRoleGrantsTable.guildId, guildId),
        eq(memberRoleGrantsTable.userId, userId),
        eq(memberRoleGrantsTable.roleId, roleId),
      ),
    );
}
