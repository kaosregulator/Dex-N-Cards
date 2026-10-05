/**
 * Keep local role links in sync with UnbelievaBoat store items that grant roles.
 * Collect income still lives on our role links (UB Role Income API is not public),
 * so we seed a sensible default so synced shop roles are collect-ready immediately.
 */

import type { Guild } from "discord.js";
import type { UbRoleLink } from "@workspace/db";
import {
  createRoleLink,
  getOrCreateUbSettings,
  listRoleLinks,
  updateRoleLink,
} from "../../lib/unbelievaboat/db.js";
import { readCooldowns } from "./cooldowns.js";
import { suggestedCollectIncome } from "./collect-roles.js";
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
  seededCollect: number;
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

function metaOf(link: UbRoleLink): Record<string, unknown> {
  return { ...((link.meta ?? {}) as Record<string, unknown>) };
}

export { suggestedCollectIncome } from "./collect-roles.js";

function adminLockedCollect(meta: Record<string, unknown>): boolean {
  return meta.collectIncomeSet === true;
}

/**
 * Pull UB store items and ensure every ADD_ROLES item has a local role link.
 * New / unset links get collect income + default per-role CD seeded automatically.
 */
export async function syncUbStoreRoleLinks(
  guildId: string,
  ubGuildId: string,
  guild?: Guild | null,
): Promise<UbSyncResult> {
  const settings = await getOrCreateUbSettings(guildId);
  const guildCollectSec = readCooldowns(settings).collectSec;
  const rawItems = await fetchAllUbStoreItems(ubGuildId);
  const links = await listRoleLinks(guildId);
  const byUb = new Map(links.filter(l => l.ubItemId).map(l => [l.ubItemId!, l]));
  const byRole = new Map(links.filter(l => l.discordRoleId).map(l => [l.discordRoleId!, l]));

  let created = 0;
  let updated = 0;
  let seededCollect = 0;
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
      const income = suggestedCollectIncome(norm.price);
      link = await createRoleLink(guildId, {
        name: norm.name.slice(0, 100),
        description: norm.description.slice(0, 500),
        discordRoleId: primaryRole,
        ubItemId: norm.id,
        price: norm.price,
        emoji: norm.emoji.slice(0, 64),
        enabled: norm.listed,
        incomeAmount: income,
      });
      await updateRoleLink(guildId, link.id, {
        meta: {
          collectCooldownSec: guildCollectSec,
          collectIncomeSeeded: true,
          collectIncomeSet: false,
        },
      });
      created += 1;
      seededCollect += 1;
      const fresh = (await listRoleLinks(guildId)).find(l => l.id === link!.id) ?? link;
      byUb.set(norm.id, fresh);
      byRole.set(primaryRole, fresh);
      continue;
    }

    const patch: Parameters<typeof updateRoleLink>[2] = {};
    const meta = metaOf(link);
    if (link.ubItemId !== norm.id) patch.ubItemId = norm.id;
    if (link.discordRoleId !== primaryRole) patch.discordRoleId = primaryRole;
    if (link.name !== norm.name.slice(0, 100)) patch.name = norm.name.slice(0, 100);
    if (link.price !== norm.price) patch.price = norm.price;

    // Prefer guild-resolved emoji / unicode over placeholder `<:_:id>`.
    const nextEmoji = norm.emoji.slice(0, 64);
    const prev = link.emoji || "";
    const nextIsPlaceholder = nextEmoji.includes(":_:") || nextEmoji.startsWith("<:_:");
    const prevIsPlaceholder = prev.includes(":_:") || prev.startsWith("<:_:");
    if (nextEmoji && nextEmoji !== prev && (!nextIsPlaceholder || !prev || prevIsPlaceholder)) {
      patch.emoji = nextEmoji;
    }

    // Keep shop listing in sync with UB (listed → enabled in our store).
    if (link.enabled !== norm.listed) patch.enabled = norm.listed;

    // Seed collect income when still 0 and admin hasn't locked it off/on.
    let seeded = false;
    if ((link.incomeAmount ?? 0) === 0 && !adminLockedCollect(meta)) {
      patch.incomeAmount = suggestedCollectIncome(norm.price);
      seeded = true;
    }

    // Ensure per-role CD meta exists (UB Role Income style — per role, not global).
    if (typeof meta.collectCooldownSec !== "number") {
      meta.collectCooldownSec = guildCollectSec;
      if (seeded) meta.collectIncomeSeeded = true;
      patch.meta = meta;
    } else if (seeded) {
      meta.collectIncomeSeeded = true;
      patch.meta = meta;
    }

    if (Object.keys(patch).length) {
      const next = await updateRoleLink(guildId, link.id, patch);
      if (next) {
        updated += 1;
        if (seeded) seededCollect += 1;
        byUb.set(norm.id, next);
        byRole.set(primaryRole, next);
      }
    }
  }

  const freshLinks = await listRoleLinks(guildId);
  return { items, links: freshLinks, created, updated, seededCollect };
}
