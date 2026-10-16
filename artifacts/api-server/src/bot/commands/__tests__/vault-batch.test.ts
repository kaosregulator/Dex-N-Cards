import { beforeAll, describe, expect, it } from "vitest";
import type { MTTVItem } from "../mttvalues.js";

process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";

function item(partial: Partial<MTTVItem> & Pick<MTTVItem, "id" | "name">): MTTVItem {
  return {
    valueMin: 1,
    valueMax: 2,
    rarity: ["Legendary"],
    demand: null,
    functionality: null,
    tags: [],
    description: "",
    image: "https://example.com/art.png",
    ...partial,
  };
}

describe("vault rarity filter (website rarity, not DN)", () => {
  let vaultRarityKey: (raw: string | undefined) => string | null;
  let VAULT_RARITY_FILTERS: ReadonlyArray<{ id: string; label: string }>;
  let itemsForVaultRarity: (items: MTTVItem[], rarityId: string) => MTTVItem[];
  let pageItems: <T>(items: T[], page: number, size?: number) => T[];

  beforeAll(async () => {
    const mod = await import("../vault-batch.js");
    vaultRarityKey = mod.vaultRarityKey;
    VAULT_RARITY_FILTERS = mod.VAULT_RARITY_FILTERS;
    itemsForVaultRarity = mod.itemsForVaultRarity;
    pageItems = mod.pageItems;
  });

  it("maps Vault labels including exotic/limited onto filter ids", () => {
    expect(vaultRarityKey("Common")).toBe("common");
    expect(vaultRarityKey("Uncommon")).toBe("uncommon");
    expect(vaultRarityKey("Rare")).toBe("rare");
    expect(vaultRarityKey("Epic")).toBe("epic");
    expect(vaultRarityKey("Legendary")).toBe("legendary");
    expect(vaultRarityKey("Exotic")).toBe("exotic");
    expect(vaultRarityKey("Limited Edition")).toBe("limited");
    expect(vaultRarityKey("")).toBeNull();
    expect(vaultRarityKey("mythic")).toBeNull();
  });

  it("does not treat uncommon as common", () => {
    expect(vaultRarityKey("uncommon")).toBe("uncommon");
    expect(vaultRarityKey("Uncommon")).not.toBe("common");
  });

  it("lists every website rarity we browse", () => {
    expect(VAULT_RARITY_FILTERS.map(f => f.id)).toEqual([
      "common", "uncommon", "rare", "epic", "legendary", "exotic", "limited",
    ]);
  });

  it("keeps only the chosen website rarity and items with art", () => {
    const pool = [
      item({ id: "1", name: "Alpha", rarity: ["Legendary"] }),
      item({ id: "2", name: "Bravo", rarity: ["Common"], image: null }),
      item({ id: "3", name: "Charlie", rarity: ["Legendary"] }),
      item({ id: "4", name: "Delta", rarity: ["Exotic"] }),
      item({ id: "5", name: "Echo", rarity: ["Limited Edition"] }),
      item({ id: "6", name: "Foxtrot", rarity: ["Legendary"] }),
      item({ id: "7", name: "Golf", rarity: ["Legendary"] }),
      item({ id: "8", name: "Hotel", rarity: ["Legendary"] }),
      item({ id: "9", name: "India", rarity: ["Legendary"] }),
    ];
    const legendary = itemsForVaultRarity(pool, "legendary");
    expect(legendary.map(i => i.name)).toEqual([
      "Alpha", "Charlie", "Foxtrot", "Golf", "Hotel", "India",
    ]);
    expect(itemsForVaultRarity(pool, "common")).toEqual([]);
    expect(itemsForVaultRarity(pool, "exotic").map(i => i.name)).toEqual(["Delta"]);
    expect(itemsForVaultRarity(pool, "limited").map(i => i.name)).toEqual(["Echo"]);
  });

  it("pages five at a time", () => {
    const pool = [
      item({ id: "1", name: "Alpha", rarity: ["Legendary"] }),
      item({ id: "3", name: "Charlie", rarity: ["Legendary"] }),
      item({ id: "6", name: "Foxtrot", rarity: ["Legendary"] }),
      item({ id: "7", name: "Golf", rarity: ["Legendary"] }),
      item({ id: "8", name: "Hotel", rarity: ["Legendary"] }),
      item({ id: "9", name: "India", rarity: ["Legendary"] }),
    ];
    const legendary = itemsForVaultRarity(pool, "legendary");
    expect(pageItems(legendary, 0)).toHaveLength(5);
    expect(pageItems(legendary, 1).map(i => i.name)).toEqual(["India"]);
    expect(pageItems(legendary, 2)).toEqual([]);
  });
});
