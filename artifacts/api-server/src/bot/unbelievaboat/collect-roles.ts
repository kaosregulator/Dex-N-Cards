/**
 * Per-role collect income + cooldowns (UnbelievaBoat-style).
 * Global collect CD is a fallback; each role link can override via meta.collectCooldownSec.
 */

import type { Guild, GuildMember } from "discord.js";
import type { UbRoleLink } from "@workspace/db";
import { parseDiscordEmoji } from "./currency-canvas.js";
import { formatGuildEmoji } from "./store-icons.js";

// Lazy DB import — keeps pure planners testable without DATABASE_URL.
async function ubDb() {
  return import("../../lib/unbelievaboat/db.js");
}

export type CollectRoleRow = {
  link: UbRoleLink;
  income: number;
  cooldownSec: number;
  ready: boolean;
  readyInMs: number;
  emoji: string;
  imageUrl?: string;
};

function metaOf(link: UbRoleLink): Record<string, unknown> {
  return ((link.meta ?? {}) as Record<string, unknown>);
}

/**
 * Suggest collect income from shop price (~1%, clamped).
 * UB Role Income amounts aren't on the public API — used when syncing/seeding.
 */
export function suggestedCollectIncome(price: number): number {
  const p = Math.max(0, Math.floor(price));
  if (p <= 0) return 1_000;
  return Math.min(100_000, Math.max(500, Math.round(p * 0.01)));
}


/** Per-role collect cooldown in seconds (meta override → guild collect CD). */
export function roleCollectCooldownSec(link: UbRoleLink, guildCollectSec: number): number {
  const m = metaOf(link);
  const raw = m.collectCooldownSec;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Math.floor(Number(raw));
  return Math.max(60, guildCollectSec || 86_400);
}

export function roleCollectImageUrl(
  link: UbRoleLink,
  guild?: Guild | null,
): string | undefined {
  const m = metaOf(link);
  if (typeof m.imageUrl === "string" && m.imageUrl) return m.imageUrl;
  if (typeof m.iconGif === "string" && m.iconGif) return m.iconGif;
  const custom = parseDiscordEmoji(link.emoji || "");
  if (custom) {
    const ge = guild?.emojis.cache.get(custom.id);
    const animated = ge?.animated ?? custom.animated;
    const ext = animated ? "gif" : "png";
    return `https://cdn.discordapp.com/emojis/${custom.id}.${ext}?size=128&quality=lossless`;
  }
  // Discord role icon (boosted servers) when the link has no emoji overlay
  const rid = link.discordRoleId;
  if (rid && guild) {
    const role = guild.roles.cache.get(rid);
    const icon = role?.iconURL({ size: 128, extension: "png" });
    if (icon) return icon;
  }
  return undefined;
}

/** Prefer stored emoji; repair `<:_:id>` using guild cache; fall back to sparkle. */
export function resolveRoleDisplayEmoji(link: UbRoleLink, guild?: Guild | null): string {
  const raw = (link.emoji || "").trim();
  const custom = parseDiscordEmoji(raw);
  if (custom) {
    const ge = guild?.emojis.cache.get(custom.id);
    if (ge?.name) {
      return formatGuildEmoji({ id: ge.id, name: ge.name, animated: ge.animated });
    }
    if (custom.name && custom.name !== "_") return raw;
    return formatGuildEmoji({ id: custom.id, name: "role", animated: custom.animated });
  }
  if (raw && /\p{Extended_Pictographic}/u.test(raw)) return raw;
  return raw || "✨";
}

type RoleCollectMeta = {
  roleCollectAt?: Record<string, number>;
};

export async function loadRoleCollectState(
  guildId: string,
  userId: string,
): Promise<{ lastByLinkId: Record<string, number>; fallbackLastCollectAt: number }> {
  const { getOrCreateGameState } = await ubDb();
  const state = await getOrCreateGameState(guildId, userId);
  const meta = (state.meta ?? {}) as RoleCollectMeta;
  const at = state.lastCollectAt;
  return {
    lastByLinkId: { ...(meta.roleCollectAt ?? {}) },
    fallbackLastCollectAt: at instanceof Date ? at.getTime() : 0,
  };
}

/** @deprecated prefer loadRoleCollectState */
export async function loadRoleCollectTimes(
  guildId: string,
  userId: string,
): Promise<Record<string, number>> {
  const { lastByLinkId } = await loadRoleCollectState(guildId, userId);
  return lastByLinkId;
}

export async function markRolesCollected(
  guildId: string,
  userId: string,
  linkIds: number[],
): Promise<void> {
  const { getOrCreateGameState, touchGameState } = await ubDb();
  const state = await getOrCreateGameState(guildId, userId);
  const meta = { ...(state.meta ?? {}) } as RoleCollectMeta;
  const map = { ...(meta.roleCollectAt ?? {}) };
  const now = Date.now();
  for (const id of linkIds) map[String(id)] = now;
  meta.roleCollectAt = map;
  await touchGameState(guildId, userId, {
    lastCollectAt: new Date(now),
    meta: meta as Record<string, unknown>,
  });
}

/**
 * Owned income roles split into ready vs cooling down (per-role timers).
 * When a role has no per-link timer yet, falls back to the old global lastCollectAt
 * so existing UB-style cooldowns still apply after upgrade.
 */
export function planRoleCollect(opts: {
  links: UbRoleLink[];
  member: GuildMember;
  guildCollectSec: number;
  lastByLinkId: Record<string, number>;
  /** Legacy global collect timestamp (ms) used only when a link has never been marked. */
  fallbackLastCollectAt?: number;
  guild?: Guild | null;
}): { ready: CollectRoleRow[]; cooling: CollectRoleRow[]; zeroIncomeOwned: UbRoleLink[] } {
  const roleIds = new Set(opts.member.roles.cache.keys());
  const now = Date.now();
  const ready: CollectRoleRow[] = [];
  const cooling: CollectRoleRow[] = [];
  const zeroIncomeOwned: UbRoleLink[] = [];
  const fallback = opts.fallbackLastCollectAt ?? 0;

  const seenRole = new Set<string>();
  const candidates = opts.links
    .filter(l => l.enabled && l.discordRoleId && roleIds.has(l.discordRoleId))
    .sort((a, b) => Math.abs(b.incomeAmount ?? 0) - Math.abs(a.incomeAmount ?? 0));

  for (const link of candidates) {
    const rid = link.discordRoleId!;
    if (seenRole.has(rid)) continue;
    seenRole.add(rid);

    const income = link.incomeAmount ?? 0;
    if (income === 0) {
      zeroIncomeOwned.push(link);
      continue;
    }

    const cooldownSec = roleCollectCooldownSec(link, opts.guildCollectSec);
    const keyed = opts.lastByLinkId[String(link.id)];
    const last = typeof keyed === "number" ? keyed : fallback;
    const readyAt = last + cooldownSec * 1000;
    const readyInMs = Math.max(0, readyAt - now);
    const row: CollectRoleRow = {
      link,
      income,
      cooldownSec,
      ready: readyInMs <= 0,
      readyInMs,
      emoji: resolveRoleDisplayEmoji(link, opts.guild),
      imageUrl: roleCollectImageUrl(link, opts.guild),
    };
    if (row.ready) ready.push(row);
    else cooling.push(row);
  }

  return { ready, cooling, zeroIncomeOwned };
}

/** Compact remaining-time label (mirrors cooldowns.cdText, no DB import). */
export function formatCooldownLeft(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}
