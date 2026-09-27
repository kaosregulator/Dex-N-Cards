import { describe, expect, it } from "vitest";
import {
  mapVaultRarityToDn,
  diffVaultFeedSnapshot,
  type VaultFeedSnapshot,
  type VaultSourceStatus,
} from "../vault-sources.js";
import { DEFAULT_CARDS, RARITY_LABELS, RARITY_WEIGHTS, rarityLabel } from "../../cards-data.js";

describe("mapVaultRarityToDn", () => {
  it("maps the Vault Values ladder onto DN keys (LE top, Exotic custom)", () => {
    expect(mapVaultRarityToDn("Common")).toEqual({ rarity: "common", isLimitedEdition: false });
    expect(mapVaultRarityToDn("Uncommon")).toEqual({ rarity: "uncommon", isLimitedEdition: false });
    expect(mapVaultRarityToDn("Rare")).toEqual({ rarity: "rare", isLimitedEdition: false });
    expect(mapVaultRarityToDn("Epic")).toEqual({ rarity: "epic", isLimitedEdition: false });
    expect(mapVaultRarityToDn("Legendary")).toEqual({ rarity: "legendary", isLimitedEdition: false });
    expect(mapVaultRarityToDn("Exotic")).toEqual({
      rarity: "legendary",
      isLimitedEdition: false,
      customRaritySlug: "exotic",
    });
    expect(mapVaultRarityToDn("Limited Edition")).toEqual({ rarity: "mythic", isLimitedEdition: true });
  });
});

describe("RARITY_LABELS defaults", () => {
  it("uses site names with Limited Edition on top and honors guild nicknames", () => {
    expect(RARITY_LABELS.rare).toBe("Rare");
    expect(RARITY_LABELS.epic).toBe("Epic");
    expect(RARITY_LABELS.legendary).toBe("Legendary");
    expect(RARITY_LABELS.mythic).toBe("Limited Edition");
    const nick = new Map([["mythic" as const, { displayName: "Server Extra" }]]);
    expect(rarityLabel("mythic", null, nick)).toBe("Server Extra");
    expect(RARITY_WEIGHTS.legendary).toBeGreaterThan(RARITY_WEIGHTS.mythic);
  });
});

describe("DEFAULT_CARDS harvest", () => {
  it("is a large vehicle-first set with every built-in rarity", () => {
    expect(DEFAULT_CARDS.length).toBeGreaterThanOrEqual(120);
    const byRarity = new Map<string, number>();
    let bannerish = 0;
    let exotic = 0;
    for (const c of DEFAULT_CARDS) {
      expect(c.imageUrl).toMatch(/^https?:\/\//);
      expect((c.description ?? "").length).toBeGreaterThan(5);
      byRarity.set(c.rarity, (byRarity.get(c.rarity) ?? 0) + 1);
      if (/banner|emblem/i.test(c.cardType) || /banner|emblem/i.test(c.name)) bannerish++;
      if (c.customRaritySlug === "exotic") exotic++;
    }
    for (const r of ["common", "uncommon", "rare", "epic", "legendary", "mythic"] as const) {
      expect(byRarity.get(r) ?? 0).toBeGreaterThan(0);
    }
    expect(exotic).toBeGreaterThan(10);
    // Prefer vehicles/soldiers — banners are fillers only (uncommon is mostly nameplates).
    expect(bannerish).toBeLessThan(DEFAULT_CARDS.length * 0.35);
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

describe("searchVaultPrices safety net", () => {
  it("ranks Abram Tank ahead of weaker Abram hits and formats gem ranges", async () => {
    const { matchScore, formatVaultPriceLine, formatMTTVValue } = await import("../mttvalues.js");
    // Local ranking only (no network) — proves search stays usable if MTTV dies.
    const items = [
      {
        id: "1",
        name: "Abram Tank",
        valueMin: 1000,
        valueMax: 2000,
        rarity: ["Rare"],
        demand: 3,
        functionality: null,
        tags: [] as string[],
        description: "tank",
        image: null,
      },
      {
        id: "2",
        name: "AA Abram",
        valueMin: 200,
        valueMax: 1000,
        rarity: ["Common"],
        demand: 2,
        functionality: null,
        tags: [] as string[],
        description: "",
        image: null,
      },
      {
        id: "3",
        name: "Sea Dragon",
        valueMin: 0,
        valueMax: 0,
        rarity: ["Exotic"],
        demand: 5,
        functionality: null,
        tags: [] as string[],
        description: "",
        image: null,
      },
    ];
    const ranked = items
      .map((i) => ({ i, score: matchScore(i, "Abram") }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    expect(ranked[0]!.i.name).toBe("Abram Tank");
    expect(formatMTTVValue(ranked[0]!.i)).toMatch(/1,000/);
    expect(formatVaultPriceLine(ranked[0]!.i)).toContain("Abram Tank");
    expect(matchScore(items[2]!, "Abram")).toBe(0);
  });
});
