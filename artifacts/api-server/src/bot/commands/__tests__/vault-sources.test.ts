import { describe, expect, it } from "vitest";
import {
  mapVaultRarityToDn,
  diffVaultFeedSnapshot,
  type VaultFeedSnapshot,
  type VaultSourceStatus,
} from "../vault-sources.js";
import { DEFAULT_CARDS, RARITY_LABELS, RARITY_WEIGHTS, rarityLabel } from "../../cards-data.js";

describe("mapVaultRarityToDn", () => {
  it("maps the Vault Values ladder onto DN keys", () => {
    expect(mapVaultRarityToDn("Common")).toEqual({ rarity: "common", isLimitedEdition: false });
    expect(mapVaultRarityToDn("Uncommon")).toEqual({ rarity: "uncommon", isLimitedEdition: false });
    expect(mapVaultRarityToDn("Rare")).toEqual({ rarity: "rare", isLimitedEdition: false });
    expect(mapVaultRarityToDn("Epic")).toEqual({ rarity: "epic", isLimitedEdition: false });
    expect(mapVaultRarityToDn("Legendary")).toEqual({ rarity: "legendary", isLimitedEdition: false });
    expect(mapVaultRarityToDn("Exotic")).toEqual({ rarity: "mythic", isLimitedEdition: false });
    expect(mapVaultRarityToDn("Limited Edition")).toEqual({ rarity: "mythic", isLimitedEdition: true });
  });
});

describe("RARITY_LABELS defaults", () => {
  it("uses Vault Values names and honors guild nicknames first", () => {
    expect(RARITY_LABELS.rare).toBe("Rare");
    expect(RARITY_LABELS.epic).toBe("Epic");
    expect(RARITY_LABELS.legendary).toBe("Legendary");
    expect(RARITY_LABELS.mythic).toBe("Exotic");
    const nick = new Map([["rare" as const, { displayName: "Server LE" }]]);
    expect(rarityLabel("rare", null, nick)).toBe("Server LE");
    expect(RARITY_WEIGHTS.rare).toBeGreaterThan(RARITY_WEIGHTS.epic);
  });
});

describe("DEFAULT_CARDS harvest", () => {
  it("has images, descriptions, and every built-in rarity", () => {
    expect(DEFAULT_CARDS.length).toBeGreaterThanOrEqual(50);
    const byRarity = new Map<string, number>();
    for (const c of DEFAULT_CARDS) {
      expect(c.imageUrl).toMatch(/^https?:\/\//);
      expect((c.description ?? "").length).toBeGreaterThan(5);
      byRarity.set(c.rarity, (byRarity.get(c.rarity) ?? 0) + 1);
    }
    for (const r of ["common", "uncommon", "rare", "epic", "legendary", "mythic"] as const) {
      expect(byRarity.get(r) ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("diffVaultFeedSnapshot", () => {
  it("reports count and rarity drift", () => {
    const prev: VaultFeedSnapshot = {
      source: "valuevaultx",
      savedAt: "2026-01-01T00:00:00.000Z",
      itemCount: 700,
      rarities: { Common: 90, Exotic: 120 },
      titlesSample: [],
    };
    const next: VaultSourceStatus = {
      id: "valuevaultx",
      label: "Value Vault X (JSON)",
      url: "https://valuevaultx.com/_functions/api/MTSValueList",
      kind: "json-feed",
      ok: true,
      httpStatus: 200,
      itemCount: 706,
      rarities: { Common: 92, Exotic: 125 },
      checkedAt: "2026-09-27T00:00:00.000Z",
    };
    const notes = diffVaultFeedSnapshot(prev, next);
    expect(notes.some((n) => n.includes("item count"))).toBe(true);
    expect(notes.some((n) => n.includes("Common"))).toBe(true);
  });
});
