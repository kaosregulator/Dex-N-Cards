import { describe, expect, it } from "vitest";
import {
  getFullBodyAvatar,
  looksLikeCompleteUsername,
  rankSearchHits,
  readyRobloxHits,
  robloxSearchName,
  roleSearchEntries,
  searchUsers,
  type RobloxSearchHit,
} from "../roblox-users.js";

function hit(name: string, displayName = name, id = 1): RobloxSearchHit {
  return { id, name, displayName, hasVerifiedBadge: false, previousUsernames: [] };
}

describe("Roblox username ranking (Artemis-style)", () => {
  it("treats 3–20 letter/number/_ handles as complete", () => {
    expect(looksLikeCompleteUsername("kao")).toBe(true);
    expect(looksLikeCompleteUsername("arteum_kezuman")).toBe(true);
    expect(looksLikeCompleteUsername("ab")).toBe(false);
    expect(looksLikeCompleteUsername("not a name")).toBe(false);
  });

  it("prefers exact username, then prefix, over fuzzy contains", () => {
    const ranked = rankSearchHits([
      hit("ArtLover", "Art", 1),
      hit("arteum_kezuman", "Arteum", 2),
      hit("kao", "Kao", 3),
      hit("NotKao", "Someone", 4),
    ], "kao");
    expect(ranked[0]?.name).toBe("kao");
  });

  it("uses the Discord nickname as the ready Roblox search", () => {
    expect(robloxSearchName("Edjer", "Edjer", "discorduser")).toBe("Edjer");
    expect(robloxSearchName(null, "Super Edjer", "discorduser")).toBe("Super Edjer");
    expect(robloxSearchName("  @Kaos  ", "other", "discorduser")).toBe("Kaos");
  });

  it("prepares a role list from nicknames and does not invent Roblox ids", () => {
    const entries = roleSearchEntries([
      { id: "1", bot: true, nickname: "BotUser", username: "bot" },
      { id: "2", nickname: "Edjer", displayName: "Edjer", username: "discord_edjer" },
      { id: "3", nickname: "x", displayName: "x", username: "x" },
      { id: "4", nickname: null, displayName: "Super Edjer", username: "someone" },
    ]);
    expect(entries.map(e => e.query)).toEqual(["Edjer", "Super Edjer"]);
    expect(entries[0]).toMatchObject({ id: "2", discord: "discord_edjer" });
    expect(entries.every(e => !("robloxId" in e))).toBe(true);
  });

  it("auto-opens only a single exact username match", () => {
    const exact = readyRobloxHits([
      hit("Edjer", "Edjer", 9),
      hit("SuperEdjer", "Edjer Fan", 10),
    ], "Edjer");
    expect(exact.auto?.id).toBe(9);
    const fuzzy = readyRobloxHits([hit("SuperEdjer", "Collector", 10)], "edjer");
    expect(fuzzy.auto).toBeNull();
    expect(fuzzy.choices).toHaveLength(1);
  });

  it("prefers the longer prefix match when both start with the query", () => {
    const ranked = rankSearchHits([
      hit("Art", "Art", 1),
      hit("arteum_kezuman", "Arteum", 2),
    ], "arte");
    expect(ranked[0]?.name).toBe("arteum_kezuman");
  });
});

describe("Roblox public APIs (same as Artemis Prime)", () => {
  it("searches users and ranks an exact-looking handle first", async () => {
    const hits = await searchUsers("kao", 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some(h => h.name.toLowerCase().includes("kao"))).toBe(true);
  }, 15_000);

  it("returns a full-body avatar URL", async () => {
    const url = await getFullBodyAvatar(156);
    expect(url).toMatch(/^https:\/\//);
  }, 15_000);
});
