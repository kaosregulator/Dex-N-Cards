/**
 * UnbelievaBoat store item helpers — actions, requirements, emoji, pagination.
 * Docs: https://api-docs.unbelievaboat.com/reference/get-store-items
 */

import type { GuildMember } from "discord.js";
import {
  ubApi,
  type UbStoreItem,
  type UbUserBalance,
} from "../../lib/unbelievaboat/client.js";
import { discordEmojiCdnUrl, formatGuildEmoji, isAnimatedStoreImage } from "./store-icons.js";

/** UB action types */
export const UbAction = {
  RESPOND: 1,
  ADD_ROLES: 2,
  REMOVE_ROLES: 3,
  ADD_BALANCE: 4,
  REMOVE_BALANCE: 5,
  ADD_ITEMS: 6,
  REMOVE_ITEMS: 7,
} as const;

/** UB requirement types */
export const UbReq = {
  ROLE: 1,
  TOTAL_BALANCE: 2,
  ITEM: 3,
} as const;

/** UB requirement match modes */
export const UbMatch = {
  EVERY: 1,
  AT_LEAST_ONE: 2,
  NONE: 3,
} as const;

export type UbActionObj = {
  type: number;
  ids?: string[];
  balance?: number;
  message?: { content?: string; embeds?: unknown[] };
};

export type UbRequirementObj = {
  type: number;
  match_type?: number;
  ids?: string[];
  balance?: number;
};

export type NormalizedUbItem = {
  id: string;
  name: string;
  price: number;
  description: string;
  listed: boolean;
  emoji: string;
  imageUrl?: string;
  animated: boolean;
  actions: UbActionObj[];
  requirements: UbRequirementObj[];
  grantRoleIds: string[];
  raw: UbStoreItem;
};

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export function parseActions(raw: unknown): UbActionObj[] {
  return asArray<Record<string, unknown>>(raw)
    .map(a => ({
      type: Number(a.type) || 0,
      ids: asArray<string>(a.ids).map(String),
      balance: typeof a.balance === "number" ? a.balance : Number(a.balance) || undefined,
      message:
        a.message && typeof a.message === "object"
          ? (a.message as { content?: string; embeds?: unknown[] })
          : undefined,
    }))
    .filter(a => a.type >= 1 && a.type <= 7);
}

export function parseRequirements(raw: unknown): UbRequirementObj[] {
  return asArray<Record<string, unknown>>(raw)
    .map(r => ({
      type: Number(r.type) || 0,
      match_type: Number(r.match_type) || UbMatch.EVERY,
      ids: asArray<string>(r.ids).map(String),
      balance: typeof r.balance === "number" ? r.balance : Number(r.balance) || undefined,
    }))
    .filter(r => r.type >= 1 && r.type <= 3);
}

export function grantRoleIdsFromActions(actions: UbActionObj[]): string[] {
  const ids = new Set<string>();
  for (const a of actions) {
    if (a.type === UbAction.ADD_ROLES) {
      for (const id of a.ids ?? []) ids.add(id);
    }
  }
  return [...ids];
}

/** Resolve Discord emoji markup + CDN image from UB item fields (no guild cache). */
export function emojiFromUbItem(item: UbStoreItem): {
  emoji: string;
  imageUrl?: string;
  animated: boolean;
} {
  if (item.emoji_id) {
    return {
      emoji: `<:_:${item.emoji_id}>`,
      imageUrl: discordEmojiCdnUrl(item.emoji_id, false),
      animated: false,
    };
  }
  if (item.emoji_unicode) {
    return { emoji: item.emoji_unicode, animated: false };
  }
  return { emoji: "🛒", animated: false };
}

/** Better emoji resolve when we have a guild cache. */
export function resolveUbItemVisual(
  item: UbStoreItem,
  guildEmoji?: { id: string; name: string; animated: boolean | null } | null,
  overlayImageUrl?: string | null,
): { emoji: string; imageUrl?: string; animated: boolean } {
  if (overlayImageUrl) {
    const base = guildEmoji
      ? {
          emoji: formatGuildEmoji({
            id: guildEmoji.id,
            name: guildEmoji.name,
            animated: guildEmoji.animated,
          }),
          animated: Boolean(guildEmoji.animated),
        }
      : emojiFromUbItem(item);
    return {
      emoji: base.emoji,
      imageUrl: overlayImageUrl,
      animated: isAnimatedStoreImage(overlayImageUrl) || base.animated,
    };
  }
  if (guildEmoji) {
    const animated = Boolean(guildEmoji.animated);
    return {
      emoji: formatGuildEmoji({
        id: guildEmoji.id,
        name: guildEmoji.name,
        animated,
      }),
      imageUrl: discordEmojiCdnUrl(guildEmoji.id, animated),
      animated,
    };
  }
  if (item.emoji_id) {
    // Unknown animation — prefer png; Discord still shows custom emoji in text.
    return {
      emoji: `<:_:${item.emoji_id}>`,
      imageUrl: discordEmojiCdnUrl(item.emoji_id, false),
      animated: false,
    };
  }
  if (item.emoji_unicode) return { emoji: item.emoji_unicode, animated: false };
  return { emoji: "🛒", animated: false };
}

export function normalizeUbItem(
  item: UbStoreItem,
  opts?: {
    guildEmoji?: { id: string; name: string; animated: boolean | null } | null;
    overlayImageUrl?: string | null;
  },
): NormalizedUbItem {
  const actions = parseActions(item.actions);
  const requirements = parseRequirements(item.requirements);
  const visual = resolveUbItemVisual(item, opts?.guildEmoji, opts?.overlayImageUrl);
  const price = typeof item.price === "number" ? item.price : Number(item.price) || 0;
  const listed = item.is_listed !== false && (item as { is_visible?: boolean }).is_visible !== false;
  return {
    id: item.id,
    name: item.name,
    price: Math.max(0, Math.floor(price)),
    description: item.description?.trim() || "UnbelievaBoat store role",
    listed,
    emoji: visual.emoji,
    imageUrl: visual.imageUrl,
    animated: visual.animated,
    actions,
    requirements,
    grantRoleIds: grantRoleIdsFromActions(actions),
    raw: item,
  };
}

/** Fetch all pages of UB store items. */
export async function fetchAllUbStoreItems(ubGuildId: string): Promise<UbStoreItem[]> {
  const out: UbStoreItem[] = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages && page <= 20) {
    const raw = await ubApi.listStoreItems(ubGuildId, { limit: 100, page, sort: "name" });
    if (Array.isArray(raw)) {
      out.push(...raw);
      break;
    }
    const items = Array.isArray(raw.items) ? raw.items : [];
    out.push(...items);
    totalPages = Math.max(1, Number(raw.total_pages) || 1);
    page += 1;
  }
  return out;
}

export function summarizeActions(actions: UbActionObj[]): string {
  if (!actions.length) return "_No actions_";
  return actions.map(a => {
    switch (a.type) {
      case UbAction.RESPOND:
        return `💬 Respond: ${(a.message?.content || "…").slice(0, 60)}`;
      case UbAction.ADD_ROLES:
        return `➕ Add roles: ${(a.ids ?? []).map(id => `<@&${id}>`).join(" ") || "—"}`;
      case UbAction.REMOVE_ROLES:
        return `➖ Remove roles: ${(a.ids ?? []).map(id => `<@&${id}>`).join(" ") || "—"}`;
      case UbAction.ADD_BALANCE:
        return `💵 Add balance: ${a.balance ?? 0}`;
      case UbAction.REMOVE_BALANCE:
        return `💸 Remove balance: ${a.balance ?? 0}`;
      case UbAction.ADD_ITEMS:
        return `📦 Add items: ${(a.ids ?? []).length}`;
      case UbAction.REMOVE_ITEMS:
        return `📤 Remove items: ${(a.ids ?? []).length}`;
      default:
        return `Action ${a.type}`;
    }
  }).join("\n");
}

export function summarizeRequirements(reqs: UbRequirementObj[]): string {
  if (!reqs.length) return "_No requirements_";
  return reqs.map(r => {
    const match =
      r.match_type === UbMatch.AT_LEAST_ONE ? "any of"
        : r.match_type === UbMatch.NONE ? "none of"
          : "all of";
    if (r.type === UbReq.ROLE) {
      return `🛡️ Role (${match}): ${(r.ids ?? []).map(id => `<@&${id}>`).join(" ") || "—"}`;
    }
    if (r.type === UbReq.TOTAL_BALANCE) {
      return `💰 Total balance ≥ ${r.balance ?? 0}`;
    }
    if (r.type === UbReq.ITEM) {
      return `🎒 Items (${match}): ${(r.ids ?? []).join(", ") || "—"}`;
    }
    return `Requirement ${r.type}`;
  }).join("\n");
}

export type ReqCheckResult = { ok: true } | { ok: false; reason: string };

/** Check if a member meets UB purchase requirements. */
export async function checkUbRequirements(
  reqs: UbRequirementObj[],
  member: GuildMember,
  balance: UbUserBalance,
  inventoryItemIds: Set<string>,
): Promise<ReqCheckResult> {
  for (const r of reqs) {
    if (r.type === UbReq.ROLE) {
      const ids = r.ids ?? [];
      const has = ids.filter(id => member.roles.cache.has(id));
      const match = r.match_type ?? UbMatch.EVERY;
      if (match === UbMatch.EVERY && has.length < ids.length) {
        return { ok: false, reason: `Need all required roles: ${ids.map(id => `<@&${id}>`).join(" ")}` };
      }
      if (match === UbMatch.AT_LEAST_ONE && has.length === 0) {
        return { ok: false, reason: `Need at least one of: ${ids.map(id => `<@&${id}>`).join(" ")}` };
      }
      if (match === UbMatch.NONE && has.length > 0) {
        return { ok: false, reason: `Cannot have: ${has.map(id => `<@&${id}>`).join(" ")}` };
      }
    } else if (r.type === UbReq.TOTAL_BALANCE) {
      const need = r.balance ?? 0;
      if ((balance.total ?? 0) < need) {
        return { ok: false, reason: `Need total balance ≥ **${need.toLocaleString()}** (you have ${balance.total.toLocaleString()}).` };
      }
    } else if (r.type === UbReq.ITEM) {
      const ids = r.ids ?? [];
      const has = ids.filter(id => inventoryItemIds.has(id));
      const match = r.match_type ?? UbMatch.EVERY;
      if (match === UbMatch.EVERY && has.length < ids.length) {
        return { ok: false, reason: "Missing required inventory items." };
      }
      if (match === UbMatch.AT_LEAST_ONE && has.length === 0) {
        return { ok: false, reason: "Need at least one of the required items." };
      }
      if (match === UbMatch.NONE && has.length > 0) {
        return { ok: false, reason: "You already hold a blocked item for this purchase." };
      }
    }
  }
  return { ok: true };
}

/**
 * Collectable rows: local income links the member owns (including synced UB shop roles).
 * Income 0 is skipped; negative incomes (taxes) are kept.
 */
export function collectableOwnedRoles<T extends {
  enabled: boolean;
  discordRoleId: string | null;
  incomeAmount: number | null;
}>(links: T[], memberRoleIds: Set<string>): T[] {
  const owned = links.filter(l =>
    l.enabled
    && l.discordRoleId
    && memberRoleIds.has(l.discordRoleId)
    && (l.incomeAmount ?? 0) !== 0,
  );
  const byRole = new Map<string, T>();
  for (const row of owned) {
    const id = row.discordRoleId!;
    const prev = byRole.get(id);
    if (!prev || Math.abs(row.incomeAmount ?? 0) > Math.abs(prev.incomeAmount ?? 0)) {
      byRole.set(id, row);
    }
  }
  return [...byRole.values()].sort(
    (a, b) => (b.incomeAmount ?? 0) - (a.incomeAmount ?? 0),
  );
}

/** Apply UB buy-time actions we can perform (roles, balance, inventory). */
export async function applyUbBuyActions(opts: {
  ubGuildId: string;
  member: GuildMember;
  actions: UbActionObj[];
  spendAlreadyDone?: boolean;
}): Promise<string[]> {
  const notes: string[] = [];
  for (const a of opts.actions) {
    if (a.type === UbAction.ADD_ROLES) {
      for (const roleId of a.ids ?? []) {
        const role = opts.member.guild.roles.cache.get(roleId)
          ?? await opts.member.guild.roles.fetch(roleId).catch(() => null);
        if (!role) continue;
        if (opts.member.roles.cache.has(role.id)) {
          notes.push(`Already had ${role}`);
          continue;
        }
        try {
          await opts.member.roles.add(role, "UnbelievaBoat store purchase");
          notes.push(`Granted ${role}`);
        } catch {
          notes.push(`Couldn't grant ${role} (bot role position?)`);
        }
      }
    } else if (a.type === UbAction.REMOVE_ROLES) {
      for (const roleId of a.ids ?? []) {
        if (!opts.member.roles.cache.has(roleId)) continue;
        try {
          await opts.member.roles.remove(roleId, "UnbelievaBoat store purchase");
          notes.push(`Removed <@&${roleId}>`);
        } catch {
          notes.push(`Couldn't remove <@&${roleId}>`);
        }
      }
    } else if (a.type === UbAction.ADD_BALANCE && (a.balance ?? 0) > 0) {
      await ubApi.patchUserBalance(opts.ubGuildId, opts.member.id, {
        cash: a.balance,
        reason: "Store item action: add balance",
      });
      notes.push(`+${a.balance} cash`);
    } else if (a.type === UbAction.REMOVE_BALANCE && (a.balance ?? 0) > 0 && !opts.spendAlreadyDone) {
      await ubApi.patchUserBalance(opts.ubGuildId, opts.member.id, {
        cash: -(a.balance ?? 0),
        reason: "Store item action: remove balance",
      });
      notes.push(`-${a.balance} cash`);
    } else if (a.type === UbAction.ADD_ITEMS) {
      for (const itemId of a.ids ?? []) {
        try {
          await ubApi.addInventoryItem(opts.ubGuildId, opts.member.id, { item_id: itemId, quantity: 1 });
          notes.push(`Inventory +1 (\`${itemId}\`)`);
        } catch {
          notes.push(`Couldn't add item \`${itemId}\``);
        }
      }
    } else if (a.type === UbAction.REMOVE_ITEMS) {
      for (const itemId of a.ids ?? []) {
        try {
          await ubApi.removeInventoryItem(opts.ubGuildId, opts.member.id, itemId, 1);
          notes.push(`Inventory -1 (\`${itemId}\`)`);
        } catch {
          notes.push(`Couldn't remove item \`${itemId}\``);
        }
      }
    } else if (a.type === UbAction.RESPOND && a.message?.content) {
      notes.push(a.message.content.slice(0, 200));
    }
  }
  return notes;
}
