import {
  pgTable, text, serial, timestamp, index, uniqueIndex,
} from "drizzle-orm/pg-core";

// ─────────────────────────────────────────────────────────────────────────────
// /memberdate — staff tenure lookups. Discord exposes joinedAt / account age,
// but not "when this role was granted". We track live GuildMemberUpdate adds
// and backfill from audit logs when View Audit Log is available.
// ─────────────────────────────────────────────────────────────────────────────

export type MemberRoleGrantSource = "live" | "audit";

export const memberRoleGrantsTable = pgTable("member_role_grants", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  roleId: text("role_id").notNull(),
  grantedAt: timestamp("granted_at").notNull(),
  source: text("source").notNull().default("live"), // live | audit
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("member_role_grants_guild_user_role_uidx").on(t.guildId, t.userId, t.roleId),
  index("member_role_grants_guild_role_idx").on(t.guildId, t.roleId),
  index("member_role_grants_guild_user_idx").on(t.guildId, t.userId),
]);

export type MemberRoleGrant = typeof memberRoleGrantsTable.$inferSelect;
