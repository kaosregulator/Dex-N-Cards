// Wishlist ping role — members opt in from /user-hub → Wishlist. When a
// wishlisted card spawns, this role is pinged (instead of every wishlister).

import type { ChatInputCommandInteraction, Guild, GuildMember } from "discord.js";
import { PermissionFlagsBits, MessageFlags } from "discord.js";
import { getOrCreateGuildSettings, updateGuildSettings } from "../db.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

export async function toggleWishlistPingRole(guild: Guild, member: GuildMember): Promise<string> {
  const settings = await getOrCreateGuildSettings(guild.id);
  if (!settings.collectorRoleId) {
    return "🔕 This server hasn't set a wishlist ping role yet. An admin can set one with `/wishlist_role`.";
  }
  const role = guild.roles.cache.get(settings.collectorRoleId)
    ?? await guild.roles.fetch(settings.collectorRoleId).catch(() => null);
  if (!role) {
    return "⚠️ The wishlist role no longer exists. Ask an admin to set a new one with `/wishlist_role`.";
  }
  const has = member.roles.cache.has(role.id);
  try {
    if (has) {
      await member.roles.remove(role.id, "Opted out of wishlist spawn pings");
      return "🔕 Wishlist pings off. You won't be pinged when a wishlisted card spawns. Press **Ping me** again to opt back in.";
    }
    await member.roles.add(role.id, "Opted in to wishlist spawn pings");
    return "🔔 Wishlist pings on. You'll get the wishlist role ping when a card on someone's wishlist (including yours) spawns.";
  } catch {
    return "❌ I couldn't change your roles — I need **Manage Roles** and my role must sit **above** the wishlist role in Server Settings → Roles.";
  }
}

export async function memberHasWishlistPingRole(guild: Guild, member: GuildMember): Promise<boolean> {
  const settings = await getOrCreateGuildSettings(guild.id);
  if (!settings.collectorRoleId) return false;
  return member.roles.cache.has(settings.collectorRoleId);
}

// ── /collector (folded into /user-hub → Wishlist) ────────────────────────
export async function handleCollectorToggle(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) return;
  const member = interaction.member as GuildMember | null
    ?? await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) { await interaction.editReply("❌ Couldn't load your server membership. Try again."); return; }
  await interaction.editReply(await toggleWishlistPingRole(interaction.guild, member));
}

// ── /wishlist_role — admin sets/clears the ping role ─────────────────────
export async function handleSetCollectorRole(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) return;
  const guildId = interaction.guild.id;
  const role = interaction.options.getRole("role");

  if (!role) {
    await updateGuildSettings(guildId, { collectorRoleId: null });
    await interaction.editReply("✅ Wishlist ping role cleared — wishlisted spawns will no longer ping a role.");
    return;
  }

  await updateGuildSettings(guildId, { collectorRoleId: role.id });

  const me = interaction.guild.members.me;
  const canManage = me?.permissions.has(PermissionFlagsBits.ManageRoles)
    && me.roles.highest.comparePositionTo(role.id) > 0;
  await interaction.editReply(
    `✅ Wishlist ping role set to <@&${role.id}>. Members opt in from \`/user-hub\` → **Wishlist** → **Ping me**.` +
    (canManage ? "" : "\n\n⚠️ I currently **can't manage this role** for self-assignment. Give me **Manage Roles** and drag my role **above** it in Server Settings → Roles."),
  );
}
