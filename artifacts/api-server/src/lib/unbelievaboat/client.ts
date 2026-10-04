// ─────────────────────────────────────────────────────────────────────────────
// UnbelievaBoat REST client — thin wrapper around https://unbelievaboat.com/api/v1
// Docs: https://api-docs.unbelievaboat.com/reference/reference
// Auth: Authorization header = raw token (no Bearer / Bot prefix).
// ─────────────────────────────────────────────────────────────────────────────

import { resolvedEnv } from "../runtime-env.js";
import { logger } from "../logger.js";

const BASE = "https://unbelievaboat.com/api/v1";

export class UbApiError extends Error {
  status: number;
  body: unknown;
  retryAfterMs?: number;
  constructor(status: number, message: string, body?: unknown, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

export type UbUserBalance = {
  user_id: string;
  cash: number;
  bank: number;
  total: number;
  rank?: string;
};

export type UbLeaderboardEntry = UbUserBalance & { rank: string };

export type UbGuild = {
  id: string;
  name: string;
  icon: string | null;
  owner_id: string;
  member_count: number;
  symbol: string;
};

export type UbStoreItem = {
  id: string;
  name: string;
  price: string | number;
  description?: string;
  is_inventory?: boolean;
  is_usable?: boolean;
  is_sellable?: boolean;
  is_visible?: boolean;
  stock_remaining?: number | null;
  unlimited_stock?: boolean;
  requirements?: unknown[];
  actions?: unknown[];
  emoji_unicode?: string | null;
  emoji_id?: string | null;
  expires_at?: string | null;
  is_listed?: boolean;
  category_id?: string | null;
};

export type UbStoreItemsPage = {
  page: number;
  total_pages: number;
  items: UbStoreItem[];
};

export type UbItemCategory = {
  id: string;
  name: string;
};

export type UbInventoryItem = {
  item_id: string;
  user_id?: string;
  quantity?: number;
  name?: string;
};

function token(): string | null {
  return resolvedEnv("UNBELIEVABOAT_TOKEN") ?? resolvedEnv("UNB_TOKEN");
}

export function isUbConfigured(): boolean {
  return Boolean(token());
}

async function ubFetch<T>(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string | number | undefined | null>,
): Promise<T> {
  const tok = token();
  if (!tok) {
    throw new UbApiError(503, "UnbelievaBoat API token not configured (set UNBELIEVABOAT_TOKEN).");
  }

  const url = new URL(`${BASE}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    Authorization: tok,
    Accept: "application/json",
  };
  let payload: string | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }

  if (res.status === 429) {
    const retry =
      typeof parsed === "object" && parsed && "retry_after" in parsed
        ? Number((parsed as { retry_after?: number }).retry_after)
        : undefined;
    throw new UbApiError(429, "UnbelievaBoat rate limit", parsed, retry);
  }

  if (!res.ok) {
    const msg =
      typeof parsed === "object" && parsed && "message" in parsed
        ? String((parsed as { message?: unknown }).message)
        : `UnbelievaBoat API ${res.status}`;
    logger.warn({ status: res.status, path, msg }, "UB API error");
    throw new UbApiError(res.status, msg, parsed);
  }

  return parsed as T;
}

export const ubApi = {
  getGuild(guildId: string) {
    return ubFetch<UbGuild>("GET", `/guilds/${guildId}`);
  },

  getPermissions(guildId: string) {
    return ubFetch<unknown>("GET", `/applications/@me/guilds/${guildId}`);
  },

  getLeaderboard(
    guildId: string,
    opts: { sort?: "cash" | "bank" | "total"; limit?: number; page?: number; offset?: number } = {},
  ) {
    return ubFetch<UbLeaderboardEntry[] | { users: UbLeaderboardEntry[]; total_pages: number }>(
      "GET",
      `/guilds/${guildId}/users`,
      undefined,
      {
        sort: opts.sort ?? "total",
        limit: opts.limit,
        page: opts.page,
        offset: opts.offset,
      },
    );
  },

  getUserBalance(guildId: string, userId: string) {
    return ubFetch<UbUserBalance>("GET", `/guilds/${guildId}/users/${userId}`);
  },

  /** Relative adjust — pass deltas (can be negative). */
  patchUserBalance(
    guildId: string,
    userId: string,
    body: { cash?: number; bank?: number; reason?: string },
  ) {
    return ubFetch<UbUserBalance>("PATCH", `/guilds/${guildId}/users/${userId}`, body);
  },

  /** Absolute set. */
  setUserBalance(
    guildId: string,
    userId: string,
    body: { cash?: number; bank?: number; reason?: string },
  ) {
    return ubFetch<UbUserBalance>("PUT", `/guilds/${guildId}/users/${userId}`, body);
  },

  listStoreItems(
    guildId: string,
    opts: { sort?: string; limit?: number; page?: number; query?: string } = {},
  ) {
    return ubFetch<UbStoreItemsPage | UbStoreItem[]>(
      "GET",
      `/guilds/${guildId}/items`,
      undefined,
      {
        sort: opts.sort ?? "name",
        limit: opts.limit ?? 100,
        page: opts.page ?? 1,
        query: opts.query,
      },
    );
  },

  getStoreItem(guildId: string, itemId: string) {
    return ubFetch<UbStoreItem>("GET", `/guilds/${guildId}/items/${itemId}`);
  },

  createStoreItem(guildId: string, body: Record<string, unknown>) {
    return ubFetch<UbStoreItem>("POST", `/guilds/${guildId}/items`, body);
  },

  editStoreItem(guildId: string, itemId: string, body: Record<string, unknown>) {
    return ubFetch<UbStoreItem>("PATCH", `/guilds/${guildId}/items/${itemId}`, body);
  },

  deleteStoreItem(guildId: string, itemId: string) {
    return ubFetch<unknown>("DELETE", `/guilds/${guildId}/items/${itemId}`);
  },

  listCategories(guildId: string) {
    return ubFetch<UbItemCategory[]>("GET", `/guilds/${guildId}/item-categories`);
  },

  createCategory(guildId: string, body: { name: string }) {
    return ubFetch<UbItemCategory>("POST", `/guilds/${guildId}/item-categories`, body);
  },

  updateCategory(guildId: string, categoryId: string, body: { name: string }) {
    return ubFetch<UbItemCategory>("PATCH", `/guilds/${guildId}/item-categories/${categoryId}`, body);
  },

  deleteCategory(guildId: string, categoryId: string) {
    return ubFetch<unknown>("DELETE", `/guilds/${guildId}/item-categories/${categoryId}`);
  },

  getInventory(guildId: string, userId: string) {
    return ubFetch<UbInventoryItem[]>("GET", `/guilds/${guildId}/users/${userId}/inventory`);
  },

  addInventoryItem(guildId: string, userId: string, body: { item_id: string; quantity?: number }) {
    return ubFetch<UbInventoryItem>("POST", `/guilds/${guildId}/users/${userId}/inventory`, body);
  },

  removeInventoryItem(guildId: string, userId: string, itemId: string, quantity?: number) {
    return ubFetch<unknown>(
      "DELETE",
      `/guilds/${guildId}/users/${userId}/inventory/${itemId}`,
      quantity != null ? { quantity } : undefined,
    );
  },
};
