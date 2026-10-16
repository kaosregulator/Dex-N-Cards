// Public Roblox user search + full-body avatar (no API key).
// Same endpoints Artemis Prime uses: users.roblox.com + thumbnails.roblox.com.

import { logger } from "../../lib/logger.js";

const UA = "DNCards-Roblox/1.0";
const SEARCH_TTL_MS = 45_000;
const USER_TTL_MS = 5 * 60_000;
const THUMB_TTL_MS = 15 * 60_000;

export type RobloxUser = {
  id: number;
  name: string;
  displayName: string;
  description: string;
  hasVerifiedBadge: boolean;
};

export type RobloxSearchHit = {
  id: number;
  name: string;
  displayName: string;
  hasVerifiedBadge: boolean;
  previousUsernames: string[];
};

type CacheEntry<T> = { value: T; expiresAt: number };
const cache = new Map<string, CacheEntry<unknown>>();

function cacheGet<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return hit.value as T;
}

function cacheSet<T>(key: string, value: T, ttl: number): T {
  if (cache.size > 800) {
    let n = 0;
    for (const k of cache.keys()) {
      cache.delete(k);
      if (++n >= 80) break;
    }
  }
  cache.set(key, { value, expiresAt: Date.now() + ttl });
  return value;
}

async function rbxJson<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": UA,
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!resp.ok) {
    throw new Error(`Roblox HTTP ${resp.status}`);
  }
  return (await resp.json()) as T;
}

export function looksLikeCompleteUsername(q: string): boolean {
  return /^[A-Za-z0-9_]{3,20}$/.test(q);
}

export function rankSearchHits(hits: RobloxSearchHit[], q: string): RobloxSearchHit[] {
  const needle = q.toLowerCase();
  const scoreOf = (hit: RobloxSearchHit) => {
    const name = hit.name.toLowerCase();
    const display = hit.displayName.toLowerCase();
    if (name === needle) return 0;
    if (display === needle) return 1;
    if (hit.previousUsernames?.some((p) => p.toLowerCase() === needle)) return 1;
    if (name.startsWith(needle)) return 2;
    if (display.startsWith(needle)) return 3;
    if (name.includes(needle)) return 4;
    if (display.includes(needle)) return 5;
    return 6;
  };
  return [...hits].sort((a, b) => {
    const sa = scoreOf(a);
    const sb = scoreOf(b);
    if (sa !== sb) return sa - sb;
    if (sa === 2) return b.name.length - a.name.length;
    return a.name.localeCompare(b.name);
  });
}

export async function getUserById(userId: number): Promise<RobloxUser> {
  const key = `user:${userId}`;
  const cached = cacheGet<RobloxUser>(key);
  if (cached) return cached;
  const raw = await rbxJson<{
    id: number;
    name: string;
    displayName?: string;
    description?: string | null;
    hasVerifiedBadge?: boolean;
  }>(`https://users.roblox.com/v1/users/${userId}`);
  return cacheSet(key, {
    id: raw.id,
    name: raw.name,
    displayName: raw.displayName || raw.name,
    description: raw.description ?? "",
    hasVerifiedBadge: Boolean(raw.hasVerifiedBadge),
  }, USER_TTL_MS);
}

export async function resolveUsername(username: string): Promise<RobloxUser> {
  const cleaned = username.trim().replace(/^@/, "");
  if (!cleaned) throw new Error("empty username");
  if (/^\d+$/.test(cleaned)) return getUserById(Number(cleaned));

  const key = `username:${cleaned.toLowerCase()}`;
  const cachedId = cacheGet<number>(key);
  if (cachedId) return getUserById(cachedId);

  const result = await rbxJson<{ data?: Array<{ id: number; name: string }> }>(
    "https://users.roblox.com/v1/usernames/users",
    { method: "POST", body: JSON.stringify({ usernames: [cleaned], excludeBannedUsers: false }) },
  );
  const row = result.data?.[0];
  if (!row?.id) throw new Error(`username ${cleaned} not found`);
  cacheSet(key, row.id, USER_TTL_MS);
  return getUserById(row.id);
}

export async function searchUsers(keyword: string, limit = 10): Promise<RobloxSearchHit[]> {
  const q = keyword.trim().replace(/^@/, "");
  if (q.length < 2) return [];

  const cacheable = q.length >= 4;
  const key = `search:${q.toLowerCase()}:${limit}`;
  if (cacheable) {
    const cached = cacheGet<RobloxSearchHit[]>(key);
    if (cached) return cached;
  }

  const byId = new Map<number, RobloxSearchHit>();

  if (looksLikeCompleteUsername(q)) {
    try {
      const exact = await resolveUsername(q);
      byId.set(exact.id, {
        id: exact.id,
        name: exact.name,
        displayName: exact.displayName,
        hasVerifiedBadge: exact.hasVerifiedBadge,
        previousUsernames: [],
      });
    } catch {
      /* keep searching */
    }
  }

  try {
    const result = await rbxJson<{
      data?: Array<{
        id: number;
        name: string;
        displayName: string;
        hasVerifiedBadge?: boolean;
        previousUsernames?: string[];
      }>;
    }>(`https://users.roblox.com/v1/users/search?keyword=${encodeURIComponent(q)}&limit=${Math.min(25, Math.max(limit, 10))}`);
    for (const u of result.data ?? []) {
      if (byId.has(u.id)) continue;
      byId.set(u.id, {
        id: u.id,
        name: u.name,
        displayName: u.displayName || u.name,
        hasVerifiedBadge: Boolean(u.hasVerifiedBadge),
        previousUsernames: u.previousUsernames ?? [],
      });
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message, q }, "Roblox user search failed");
  }

  const ranked = rankSearchHits([...byId.values()], q).slice(0, limit);
  if (cacheable && ranked.length) cacheSet(key, ranked, SEARCH_TTL_MS);
  return ranked;
}

export async function resolveRobloxUser(value: string): Promise<RobloxUser | null> {
  const v = value.trim().replace(/^@/, "");
  if (!v) return null;
  try {
    if (/^\d+$/.test(v)) return await getUserById(Number(v));
    return await resolveUsername(v);
  } catch (err) {
    logger.warn({ err: (err as Error).message, v }, "Roblox user resolve failed");
    const hits = await searchUsers(v, 10).catch(() => []);
    const exact = hits.find(h => h.name.toLowerCase() === v.toLowerCase()) ?? hits[0];
    if (!exact) return null;
    try {
      return await getUserById(exact.id);
    } catch {
      return null;
    }
  }
}

type ThumbRow = { targetId: number; state?: string; imageUrl?: string | null };

export async function getFullBodyAvatar(userId: number): Promise<string | null> {
  const key = `full:${userId}`;
  const cached = cacheGet<string | null>(key);
  if (cached !== undefined) return cached;

  const url =
    `https://thumbnails.roblox.com/v1/users/avatar?userIds=${userId}` +
    `&size=720x720&format=Png&isCircular=false`;
  try {
    const result = await rbxJson<{ data?: ThumbRow[] }>(url);
    const row = result.data?.find(r => r.targetId === userId);
    if (row?.state === "Pending" || row?.state === "TemporarilyUnavailable") {
      await new Promise(r => setTimeout(r, 350));
      const retry = await rbxJson<{ data?: ThumbRow[] }>(url);
      const again = retry.data?.find(r => r.targetId === userId);
      const img = again?.imageUrl && again.state !== "Error" ? again.imageUrl : null;
      return cacheSet(key, img, img ? THUMB_TTL_MS : 30_000);
    }
    const img = row?.imageUrl && row.state !== "Error" && row.state !== "Blocked" ? row.imageUrl : null;
    return cacheSet(key, img, img ? THUMB_TTL_MS : 30_000);
  } catch (err) {
    logger.warn({ err: (err as Error).message, userId }, "Roblox full-body thumbnail failed");
    return cacheSet(key, null, 30_000);
  }
}

export function profileUrl(userId: number): string {
  return `https://www.roblox.com/users/${userId}/profile`;
}
