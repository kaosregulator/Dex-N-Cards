// Vault / price-list sources used by /vaultvalue and create-from-vault.
// No API keys — only public endpoints the community sites already expose.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../../lib/logger.js";
import type { Rarity } from "../cards-data.js";

export type VaultSourceId = "valuevaultx" | "vaultedvaluesx" | "mttvalues";

export type VaultSourceStatus = {
  id: VaultSourceId;
  label: string;
  url: string;
  kind: "json-feed" | "html-site" | "legacy";
  ok: boolean;
  httpStatus: number | null;
  itemCount: number | null;
  rarities: Record<string, number> | null;
  checkedAt: string;
  note?: string;
};

/** Live Military Tycoon gem-value JSON (Wix). Primary price + image feed. */
export const VALUEVAULTX_FEED_URL = "https://valuevaultx.com/_functions/api/MTSValueList";
export const VALUEVAULTX_SITE_URL = "https://valuevaultx.com";

/** Newer Vaulted Values X UI (images in Supabase). No public JSON feed yet — HTML/SSR. */
export const VAULTEDVALUESX_LIST_URL = "https://mts.vaultedvaluesx.com/value-list";
export const VAULTEDVALUESX_SITE_URL = "https://www.vaultedvaluesx.com";

/** Legacy MTT Values — Cloudflare / Firestore locked (403). Kept for health reporting only. */
export const MTTVALUES_SITE_URL = "https://mttvalues.com";

/**
 * Map Vault Values `suggestedRarity` → DN built-in rarity keys (+ optional custom slug).
 * DB enum keys stay fixed; display names come from RARITY_LABELS / guild nicknames (/rarity).
 *
 * Site ladder (low → high): Common → Uncommon → Rare → Epic → Legendary → Exotic → Limited Edition
 * Limited Edition → mythic (top). Exotic → custom slug "exotic" on legendary base.
 * Event/special cards use mythic + isEventExclusive (not from this mapper).
 */
export function mapVaultRarityToDn(suggested: string | null | undefined): {
  rarity: Rarity;
  isLimitedEdition: boolean;
  customRaritySlug?: string;
} {
  const s = (suggested ?? "").trim().toLowerCase();
  if (s === "common") return { rarity: "common", isLimitedEdition: false };
  if (s === "uncommon") return { rarity: "uncommon", isLimitedEdition: false };
  if (s === "rare") return { rarity: "rare", isLimitedEdition: false };
  if (s === "epic") return { rarity: "epic", isLimitedEdition: false };
  if (s === "legendary") return { rarity: "legendary", isLimitedEdition: false };
  if (s === "exotic") return { rarity: "legendary", isLimitedEdition: false, customRaritySlug: "exotic" };
  if (s.includes("limited")) return { rarity: "mythic", isLimitedEdition: true };
  return { rarity: "common", isLimitedEdition: false };
}

const SNAPSHOT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../data",
);
const SNAPSHOT_PATH = join(SNAPSHOT_DIR, "vault-feed-snapshot.json");

export type VaultFeedSnapshot = {
  source: VaultSourceId;
  savedAt: string;
  itemCount: number;
  rarities: Record<string, number>;
  titlesSample: string[];
};

function rarityHistogram(items: Array<{ suggestedRarity?: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const r = (it.suggestedRarity ?? "?").trim() || "?";
    out[r] = (out[r] ?? 0) + 1;
  }
  return out;
}

export async function probeValueVaultxFeed(): Promise<VaultSourceStatus> {
  const checkedAt = new Date().toISOString();
  try {
    const resp = await fetch(VALUEVAULTX_FEED_URL, { signal: AbortSignal.timeout(12_000) });
    if (!resp.ok) {
      return {
        id: "valuevaultx",
        label: "Value Vault X (JSON)",
        url: VALUEVAULTX_FEED_URL,
        kind: "json-feed",
        ok: false,
        httpStatus: resp.status,
        itemCount: null,
        rarities: null,
        checkedAt,
        note: resp.statusText,
      };
    }
    const data = (await resp.json()) as Array<{ suggestedRarity?: string; title?: string }>;
    if (!Array.isArray(data)) {
      return {
        id: "valuevaultx",
        label: "Value Vault X (JSON)",
        url: VALUEVAULTX_FEED_URL,
        kind: "json-feed",
        ok: false,
        httpStatus: resp.status,
        itemCount: null,
        rarities: null,
        checkedAt,
        note: "Unexpected response shape",
      };
    }
    return {
      id: "valuevaultx",
      label: "Value Vault X (JSON)",
      url: VALUEVAULTX_FEED_URL,
      kind: "json-feed",
      ok: data.length > 0,
      httpStatus: resp.status,
      itemCount: data.length,
      rarities: rarityHistogram(data),
      checkedAt,
    };
  } catch (err) {
    return {
      id: "valuevaultx",
      label: "Value Vault X (JSON)",
      url: VALUEVAULTX_FEED_URL,
      kind: "json-feed",
      ok: false,
      httpStatus: null,
      itemCount: null,
      rarities: null,
      checkedAt,
      note: (err as Error).message,
    };
  }
}

export async function probeHtmlSite(
  id: VaultSourceId,
  label: string,
  url: string,
  kind: "html-site" | "legacy",
): Promise<VaultSourceStatus> {
  const checkedAt = new Date().toISOString();
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      headers: { "User-Agent": "DN-Cards-Bot/1.0 (+vaultvalue health check)" },
      redirect: "follow",
    });
    const ok = resp.ok;
    return {
      id,
      label,
      url,
      kind,
      ok,
      httpStatus: resp.status,
      itemCount: null,
      rarities: null,
      checkedAt,
      note: ok
        ? kind === "html-site"
          ? "Page reachable (no public JSON feed yet)"
          : undefined
        : resp.statusText,
    };
  } catch (err) {
    return {
      id,
      label,
      url,
      kind,
      ok: false,
      httpStatus: null,
      itemCount: null,
      rarities: null,
      checkedAt,
      note: (err as Error).message,
    };
  }
}

export async function checkAllVaultSources(): Promise<VaultSourceStatus[]> {
  const [feed, vvx, mtt] = await Promise.all([
    probeValueVaultxFeed(),
    probeHtmlSite("vaultedvaluesx", "Vaulted Values X (MTS list)", VAULTEDVALUESX_LIST_URL, "html-site"),
    probeHtmlSite("mttvalues", "MTT Values (legacy)", MTTVALUES_SITE_URL, "legacy"),
  ]);
  return [feed, vvx, mtt];
}

export function loadVaultFeedSnapshot(): VaultFeedSnapshot | null {
  try {
    if (!existsSync(SNAPSHOT_PATH)) return null;
    return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as VaultFeedSnapshot;
  } catch {
    return null;
  }
}

export function saveVaultFeedSnapshot(status: VaultSourceStatus, titlesSample: string[] = []): VaultFeedSnapshot | null {
  if (!status.ok || status.itemCount == null || !status.rarities) return null;
  const snap: VaultFeedSnapshot = {
    source: status.id,
    savedAt: status.checkedAt,
    itemCount: status.itemCount,
    rarities: status.rarities,
    titlesSample: titlesSample.slice(0, 40),
  };
  try {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(snap, null, 2));
    return snap;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Could not write vault feed snapshot");
    return null;
  }
}

export function diffVaultFeedSnapshot(
  prev: VaultFeedSnapshot | null,
  next: VaultSourceStatus,
): string[] {
  if (!prev || !next.ok || next.itemCount == null || !next.rarities) return [];
  const notes: string[] = [];
  if (prev.itemCount !== next.itemCount) {
    notes.push(`item count ${prev.itemCount} → ${next.itemCount}`);
  }
  const keys = new Set([...Object.keys(prev.rarities), ...Object.keys(next.rarities)]);
  for (const k of keys) {
    const a = prev.rarities[k] ?? 0;
    const b = next.rarities[k] ?? 0;
    if (a !== b) notes.push(`rarity "${k}" ${a} → ${b}`);
  }
  return notes;
}

/** Boot / weekly health: probe sources, persist snapshot, log diffs. */
export async function runVaultSourceHealthCheck(opts?: { persist?: boolean }): Promise<{
  statuses: VaultSourceStatus[];
  changes: string[];
}> {
  const statuses = await checkAllVaultSources();
  const feed = statuses.find((s) => s.id === "valuevaultx");
  const prev = loadVaultFeedSnapshot();
  const changes = feed ? diffVaultFeedSnapshot(prev, feed) : [];
  if (opts?.persist !== false && feed?.ok) {
    saveVaultFeedSnapshot(feed);
  }
  logger.info(
    {
      sources: statuses.map((s) => ({
        id: s.id,
        ok: s.ok,
        httpStatus: s.httpStatus,
        itemCount: s.itemCount,
      })),
      changes,
    },
    "[vault-sources] health check",
  );
  return { statuses, changes };
}
