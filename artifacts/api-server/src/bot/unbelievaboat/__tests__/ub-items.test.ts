import { describe, expect, it } from "vitest";
import {
  UbAction,
  UbMatch,
  UbReq,
  collectableOwnedRoles,
  grantRoleIdsFromActions,
  normalizeUbItem,
  parseActions,
  parseRequirements,
  summarizeActions,
  summarizeRequirements,
} from "../ub-items.js";

describe("ub-items actions/requirements", () => {
  it("parses ADD_ROLES and extracts grant role ids", () => {
    const actions = parseActions([
      { type: UbAction.ADD_ROLES, ids: ["111", "222"] },
      { type: UbAction.RESPOND, message: { content: "hi" } },
    ]);
    expect(grantRoleIdsFromActions(actions)).toEqual(["111", "222"]);
    expect(summarizeActions(actions)).toContain("Add roles");
  });

  it("parses role + balance requirements", () => {
    const reqs = parseRequirements([
      { type: UbReq.ROLE, match_type: UbMatch.EVERY, ids: ["r1"] },
      { type: UbReq.TOTAL_BALANCE, balance: 5000 },
    ]);
    expect(reqs).toHaveLength(2);
    expect(summarizeRequirements(reqs)).toContain("Total balance ≥ 5000");
    expect(summarizeRequirements(reqs)).toContain("<@&r1>");
  });

  it("normalizes a listed UB store item with emoji_id", () => {
    const item = normalizeUbItem({
      id: "item1",
      name: "VIP",
      price: "750",
      description: "VIP role",
      is_listed: true,
      emoji_id: "999",
      actions: [{ type: 2, ids: ["roleA"] }],
      requirements: [],
    });
    expect(item.price).toBe(750);
    expect(item.grantRoleIds).toEqual(["roleA"]);
    expect(item.imageUrl).toContain("999.png");
    expect(item.listed).toBe(true);
  });
});

describe("collectableOwnedRoles", () => {
  it("includes synced UB-backed links the member owns with income", () => {
    const owned = collectableOwnedRoles(
      [
        { discordRoleId: "a", incomeAmount: 100, enabled: true },
        { discordRoleId: "b", incomeAmount: 0, enabled: true },
        { discordRoleId: "c", incomeAmount: 50, enabled: true },
      ],
      new Set(["a", "b"]),
    );
    expect(owned.map(r => r.discordRoleId)).toEqual(["a"]);
  });
});
