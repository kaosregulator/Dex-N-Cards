/**
 * Keep local role links in sync with UnbelievaBoat store items that grant roles.
 * Collect income still lives on our role links (UB role-income API is not public).
 */

import type { Guild } from "discord.js";
import type { UbRoleLink } from "@workspace/db";
import {
  createRoleLink,
  listRoleLinks,
  updateRoleLink,
} from "../../lib/unbelievaboat/db.js";
import {
  fetchAllUbStoreItems,
  normalizeUbItem,
  type NormalizedUbItem,
} from "./ub-items.js";

export type UbSyncResult = {
  items: NormalizedUbItem[];
  links: UbRoleLink[];
  created: number;
  updated: number;
};

function guildEmojiOf(guild: Guild | null | undefined, emojiId: string | null | undefined) {
  if (!guild || !emojiId) return null;
  const e = guild.emojis.cache.get(emojiId);
  if (!e?.name) return null;
  return { id: e.id, name: e.name, animated: e.animated };
}

/** Overlay custom board image stored on a local role link meta. */
function overlayFromLink(link: UbRoleLink | undefined): string | null {
  const m = (link?.meta ?? {}) as Record<string, unknown>;
  if (typeof m.imageUrl === "string" && m.imageUrl) return m.imageUrl;
  if (typeof m.iconGif === "string" && m.iconGif) return m.iconGif;
  return null;
}

/**
 * Pull UB store items and ensure every ADD_ROLES item has a local role link
 * (price/emoji/name synced; incomeAmount left for admins to set for Collect).
 */
export async function syncUbStoreRoleLinks(
  guildId: string,
  ubGuildId: string,
  guild?: Guild | null,
): Promise<UbSyncResult> {
  const rawItems = await fetchAllUbStoreItems(ubGuildId);
  const links = await listRoleLinks(guildId);
  const byUb = new Map(links.filter(l => l.ubItemId).map(l => [l.ubItemId!, l]));
  const byRole = new Map(links.filter(l => l.discordRoleId).map(l => [l.discordRoleId!, l]));

  let created = 0;
  let updated = 0;
  const items: NormalizedUbItem[] = [];

  for (const raw of rawItems) {
    const existing = byUb.get(raw.id);
    const visualGuild = guildEmojiOf(guild, raw.emoji_id);
    const norm = normalizeUbItem(raw, {
      guildEmoji: visualGuild,
      overlayImageUrl: overlayFromLink(existing),
    });
    items.push(norm);

    const primaryRole = norm.grantRoleIds[0];
    if (!primaryRole) continue; // not a role-granting store item

    let link = byUb.get(norm.id) ?? byRole.get(primaryRole);
    if (!link) {
      link = await createRoleLink(guildId, {
        name: norm.name.slice(0, 100),
        description: norm.description.slice(0, 500),
        discordRoleId: primaryRole,
        ubItemId: norm.id,
        price: norm.price,
        emoji: norm.emoji.slice(0, 64),
        enabled: norm.listed,
        incomeAmount: 0,
      });
      created += 1;
      byUb.set(norm.id, link);
      byRole.set(primaryRole, link);
      continue;
    }

    const patch: Parameters<typeof updateRoleLink>[2] = {};
    if (link.ubItemId !== norm.id) patch.ubItemId = norm.id;
    if (link.discordRoleId !== primaryRole) patch.discordRoleId = primaryRole;
    if (link.name !== norm.name.slice(0, 100)) patch.name = norm.name.slice(0, 100);
    if (link.price !== norm.price) patch.price = norm.price;
    if ((link.emoji || "") !== norm.emoji.slice(0, 64)) patch.emoji = norm.emoji.slice(0, 64);
    // Don't force-enable; but if never set, keep listed state from UB
    if (link.enabled !== norm.listed && !link.ubItemId) patch.enabled = norm.listed;

    if (Object.keys(patch).length) {
      const next = await updateRoleLink(guildId, link.id, patch);
      if (next) {
        updated += 1;
        byUb.set(norm.id, next);
        byRole.set(primaryRole, next);
      }
    }
  }

  const freshLinks = await listRoleLinks(guildId);
  return { items, links: freshLinks, created, updated };
}
