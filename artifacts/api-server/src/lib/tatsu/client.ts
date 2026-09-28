// ─────────────────────────────────────────────────────────────────────────────
// Tatsu REST client — https://api.tatsu.gg/v1
// Docs: https://dev.tatsu.gg/ (markdown under /docs/api/)
// Auth: Authorization header = raw API key from `t!apikey create`
// Rate limit: 60 req/min (X-RateLimit-* headers). Guild endpoints require the
// key owner to be in that guild; modify points/score need MANAGE_GUILD.
// ─────────────────────────────────────────────────────────────────────────────

import { resolvedEnv } from "../runtime-env.js";
import { logger } from "../logger.js";

const BASE = "https://api.tatsu.gg/v1";

export class TatsuApiError extends Error {
  status: number;
  code?: number;
  body: unknown;
  retryAfterMs?: number;
  constructor(status: number, message: string, body?: unknown, retryAfterMs?: number, code?: number) {
    super(message);
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
    this.code = code;
  }
}

export type TatsuPeriod = "all" | "month" | "week";
export type TatsuAction = 0 | 1; // 0 = add, 1 = remove

export type TatsuRanking = {
  rank: number;
  score: number;
  user_id: string;
  guild_id?: string;
};

export type TatsuGuildRankings = {
  guild_id: string;
  rankings: TatsuRanking[];
};

export type TatsuMemberPoints = {
  guild_id: string;
  points: number;
  rank: number;
  user_id: string;
};

export type TatsuMemberScore = {
  guild_id: string;
  score: number;
  user_id: string;
};

export type TatsuUserProfile = {
  avatar_hash: string | null;
  avatar_url: string | null;
  credits: number;
  discriminator: string | null;
  id: string;
  info_box: string | null;
  reputation: number;
  subscription_type: number;
  subscription_renewal?: string | null;
  title: string | null;
  tokens: number;
  username: string | null;
  xp: number;
};

export type TatsuStoreListing = {
  id: string;
  name: string;
  summary?: string;
  description?: string;
  new?: boolean;
  preview?: string;
  prices?: Array<{ currency: number; amount: number }>;
  categories?: string[];
  tags?: string[];
};

function token(): string | null {
  return resolvedEnv("TATSU_API_KEY") ?? resolvedEnv("TATSU_TOKEN");
}

export function isTatsuConfigured(): boolean {
  return Boolean(token());
}

async function tatsuFetch<T>(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string | number | undefined | null>,
): Promise<T> {
  const tok = token();
  if (!tok) {
    throw new TatsuApiError(503, "Tatsu API key not configured (set TATSU_API_KEY). Get one with `t!apikey create`.");
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
    const reset = Number(res.headers.get("X-RateLimit-Reset") ?? 0);
    const retryAfterMs = reset > 0
      ? Math.max(0, reset * 1000 - Date.now())
      : 60_000;
    throw new TatsuApiError(429, "Tatsu rate limit (60 req/min).", parsed, retryAfterMs);
  }

  if (!res.ok) {
    const msg =
      typeof parsed === "object" && parsed && "message" in parsed
        ? String((parsed as { message?: string }).message)
        : `Tatsu API ${res.status}`;
    const code =
      typeof parsed === "object" && parsed && "code" in parsed
        ? Number((parsed as { code?: number }).code)
        : undefined;
    logger.debug({ status: res.status, path, body: parsed }, "Tatsu API error");
    throw new TatsuApiError(res.status, msg, parsed, undefined, code);
  }

  return parsed as T;
}

/** Max amount per modify call (Tatsu API hard limit). */
export const TATSU_MODIFY_MAX = 100_000;

export const tatsuApi = {
  getGuildRankings(guildId: string, period: TatsuPeriod = "all", offset = 0) {
    return tatsuFetch<TatsuGuildRankings>("GET", `/guilds/${guildId}/rankings/${period}`, undefined, { offset });
  },

  getMemberRanking(guildId: string, userId: string, period: TatsuPeriod = "all") {
    return tatsuFetch<TatsuRanking>("GET", `/guilds/${guildId}/rankings/members/${userId}/${period}`);
  },

  getMemberPoints(guildId: string, userId: string) {
    return tatsuFetch<TatsuMemberPoints>("GET", `/guilds/${guildId}/members/${userId}/points`);
  },

  modifyMemberPoints(guildId: string, userId: string, amount: number, action: TatsuAction) {
    const amt = Math.min(TATSU_MODIFY_MAX, Math.max(1, Math.floor(amount)));
    // Tatsu expects integer 0=add / 1=remove (not strings / booleans).
    const act = action === 1 ? 1 : 0;
    return tatsuFetch<TatsuMemberPoints>("PATCH", `/guilds/${guildId}/members/${userId}/points`, {
      amount: amt,
      action: act,
    });
  },

  modifyMemberScore(guildId: string, userId: string, amount: number, action: TatsuAction) {
    const amt = Math.min(TATSU_MODIFY_MAX, Math.max(1, Math.floor(amount)));
    const act = action === 1 ? 1 : 0;
    return tatsuFetch<TatsuMemberScore>("PATCH", `/guilds/${guildId}/members/${userId}/score`, {
      amount: amt,
      action: act,
    });
  },

  getUserProfile(userId: string) {
    return tatsuFetch<TatsuUserProfile>("GET", `/users/${userId}/profile`);
  },

  getStoreListing(listingId: string) {
    return tatsuFetch<TatsuStoreListing>("GET", `/store/listings/${listingId}`);
  },

  /**
   * Apply a large add/remove by chunking into ≤100k calls (Tatsu per-request cap).
   * Returns the last successful response.
   */
  async modifyPointsChunked(
    guildId: string,
    userId: string,
    totalAmount: number,
    action: TatsuAction,
  ): Promise<TatsuMemberPoints | null> {
    let left = Math.max(0, Math.floor(totalAmount));
    let last: TatsuMemberPoints | null = null;
    while (left > 0) {
      const chunk = Math.min(TATSU_MODIFY_MAX, left);
      last = await this.modifyMemberPoints(guildId, userId, chunk, action);
      left -= chunk;
    }
    return last;
  },

  async modifyScoreChunked(
    guildId: string,
    userId: string,
    totalAmount: number,
    action: TatsuAction,
  ): Promise<TatsuMemberScore | null> {
    let left = Math.max(0, Math.floor(totalAmount));
    let last: TatsuMemberScore | null = null;
    while (left > 0) {
      const chunk = Math.min(TATSU_MODIFY_MAX, left);
      last = await this.modifyMemberScore(guildId, userId, chunk, action);
      left -= chunk;
    }
    return last;
  },

  /** Paginate rankings until exhausted or maxPages (each page ≤100). */
  async collectRankings(
    guildId: string,
    period: TatsuPeriod = "all",
    maxPages = 5,
  ): Promise<TatsuRanking[]> {
    const out: TatsuRanking[] = [];
    for (let page = 0; page < maxPages; page++) {
      const offset = page * 100;
      const batch = await this.getGuildRankings(guildId, period, offset);
      const rows = batch.rankings ?? [];
      out.push(...rows);
      if (rows.length < 100) break;
    }
    return out;
  },
};
