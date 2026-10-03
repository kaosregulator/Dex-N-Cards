import { describe, expect, it } from "vitest";
import { buildMemberDateCommandJson } from "../definition.js";
import { filterBrowseRows, sortBrowseRows, type BrowseRow } from "../browse.js";

describe("buildMemberDateCommandJson", () => {
  it("registers lookup and browse subcommands", () => {
    const json = buildMemberDateCommandJson() as {
      name: string;
      options?: Array<{ name: string; options?: Array<{ name: string }> }>;
    };
    expect(json.name).toBe("memberdate");
    const subs = (json.options ?? []).map(o => o.name);
    expect(subs).toContain("lookup");
    expect(subs).toContain("browse");
    const lookup = json.options?.find(o => o.name === "lookup");
    const optNames = (lookup?.options ?? []).map(o => o.name);
    expect(optNames).toContain("user");
    expect(optNames).toContain("role");
  });
});

describe("filterBrowseRows / sortBrowseRows", () => {
  const now = Date.UTC(2026, 0, 1);
  const mk = (id: string, joinedDaysAgo: number, roleDaysAgo: number | null): BrowseRow => ({
    member: { id, displayName: id, user: { id } } as BrowseRow["member"],
    joinedMs: now - joinedDaysAgo * 86_400_000,
    roleGrantedAt: roleDaysAgo == null ? null : new Date(now - roleDaysAgo * 86_400_000),
  });

  it("filters by min joined tenure", () => {
    const rows = [mk("a", 10, null), mk("b", 200, null), mk("c", 400, null)];
    const out = filterBrowseRows(rows, {
      minJoined: "6m",
      minRole: "any",
      requireRoleGrant: false,
      now,
    });
    expect(out.map(r => r.member.id)).toEqual(["b", "c"]);
  });

  it("filters by role tenure when required", () => {
    const rows = [mk("a", 400, 10), mk("b", 400, 200), mk("c", 400, null)];
    const out = filterBrowseRows(rows, {
      minJoined: "any",
      minRole: "3m",
      requireRoleGrant: true,
      now,
    });
    expect(out.map(r => r.member.id)).toEqual(["b"]);
  });

  it("sorts by joined ascending", () => {
    const rows = [mk("new", 10, null), mk("old", 500, null)];
    const out = sortBrowseRows(rows, "joined_asc");
    expect(out.map(r => r.member.id)).toEqual(["old", "new"]);
  });
});
