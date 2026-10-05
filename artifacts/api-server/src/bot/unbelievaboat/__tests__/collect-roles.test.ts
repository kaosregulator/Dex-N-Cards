import { describe, expect, it } from "vitest";
import {
  planRoleCollect,
  resolveRoleDisplayEmoji,
  roleCollectCooldownSec,
  roleCollectImageUrl,
} from "../collect-roles.js";
import type { UbRoleLink } from "@workspace/db";

function link(partial: Partial<UbRoleLink> & { id: number; discordRoleId: string }): UbRoleLink {
  return {
    guildId: "g1",
    name: partial.name ?? `Role ${partial.id}`,
    price: 0,
    incomeAmount: 0,
    grantCash: 0,
    category: "custom",
    emoji: "✨",
    description: null,
    enabled: true,
    ubItemId: null,
    meta: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  } as UbRoleLink;
}

function memberWithRoles(...roleIds: string[]) {
  return {
    roles: { cache: { keys: () => roleIds[Symbol.iterator]() } },
  } as never;
}

describe("roleCollectCooldownSec", () => {
  it("uses per-role meta override (UB-style minutes)", () => {
    const row = link({
      id: 1,
      discordRoleId: "r1",
      meta: { collectCooldownSec: 3_600 },
    });
    expect(roleCollectCooldownSec(row, 86_400)).toBe(3_600);
  });

  it("falls back to guild collect CD when unset", () => {
    const row = link({ id: 2, discordRoleId: "r2", meta: {} });
    expect(roleCollectCooldownSec(row, 86_400)).toBe(86_400);
  });
});

describe("resolveRoleDisplayEmoji", () => {
  it("repairs placeholder <:_:id> names", () => {
    expect(resolveRoleDisplayEmoji(link({
      id: 1,
      discordRoleId: "r1",
      emoji: "<:_:123456789012345678>",
    }))).toBe("<:role:123456789012345678>");
  });

  it("keeps unicode emoji", () => {
    expect(resolveRoleDisplayEmoji(link({
      id: 1,
      discordRoleId: "r1",
      emoji: "✨",
    }))).toBe("✨");
  });
});

describe("roleCollectImageUrl", () => {
  it("prefers meta imageUrl then Discord emoji CDN", () => {
    expect(roleCollectImageUrl(link({
      id: 1,
      discordRoleId: "r1",
      emoji: "<:vip:111>",
      meta: { imageUrl: "https://cdn.example/a.gif" },
    }))).toBe("https://cdn.example/a.gif");

    expect(roleCollectImageUrl(link({
      id: 2,
      discordRoleId: "r2",
      emoji: "<a:spin:222>",
    }))).toContain("/emojis/222.gif");
  });
});

describe("planRoleCollect", () => {
  it("pays every owned income role that is off cooldown", () => {
    const links = [
      link({ id: 1, discordRoleId: "a", name: "Black Card", incomeAmount: 30_000, emoji: "🖤" }),
      link({ id: 2, discordRoleId: "b", name: "Synced Shop", incomeAmount: 0, emoji: "🛒", ubItemId: "ub1" }),
      link({ id: 3, discordRoleId: "c", name: "LE", incomeAmount: 10_000, emoji: "<:le:99>" }),
    ];
    const planned = planRoleCollect({
      links,
      member: memberWithRoles("a", "b", "c"),
      guildCollectSec: 86_400,
      lastByLinkId: {},
    });
    expect(planned.ready.map(r => r.link.name)).toEqual(["Black Card", "LE"]);
    expect(planned.zeroIncomeOwned.map(l => l.name)).toEqual(["Synced Shop"]);
    expect(planned.cooling).toHaveLength(0);
  });

  it("honors per-role cooldown; new link after prior collect is ready", () => {
    const now = Date.now();
    const links = [
      link({
        id: 1,
        discordRoleId: "a",
        name: "Fast",
        incomeAmount: 100,
        meta: { collectCooldownSec: 60 },
      }),
      link({
        id: 2,
        discordRoleId: "b",
        name: "NewRole",
        incomeAmount: 500,
        meta: { collectCooldownSec: 86_400 },
      }),
    ];
    // Per-role map already exists — missing link id must NOT inherit lastCollectAt.
    const planned = planRoleCollect({
      links,
      member: memberWithRoles("a", "b"),
      guildCollectSec: 86_400,
      lastByLinkId: { "1": now - 30_000 }, // Fast still cooling (60s CD)
      fallbackLastCollectAt: now - 3_600_000,
    });
    expect(planned.cooling.map(r => r.link.name)).toEqual(["Fast"]);
    expect(planned.ready.map(r => r.link.name)).toEqual(["NewRole"]);
  });

  it("uses legacy global lastCollectAt only when roleCollectAt is empty", () => {
    const now = Date.now();
    const links = [
      link({
        id: 1,
        discordRoleId: "a",
        name: "Daily",
        incomeAmount: 500,
        meta: { collectCooldownSec: 86_400 },
      }),
    ];
    const planned = planRoleCollect({
      links,
      member: memberWithRoles("a"),
      guildCollectSec: 86_400,
      lastByLinkId: {},
      fallbackLastCollectAt: now - 3_600_000, // 1h ago — still cooling on 24h CD
    });
    expect(planned.ready).toHaveLength(0);
    expect(planned.cooling.map(r => r.link.name)).toEqual(["Daily"]);
    expect(planned.cooling[0]!.readyInMs).toBeGreaterThan(0);
  });

  it("dedupes the same Discord role id", () => {
    const links = [
      link({ id: 1, discordRoleId: "a", name: "A1", incomeAmount: 10 }),
      link({ id: 2, discordRoleId: "a", name: "A2", incomeAmount: 50 }),
    ];
    const planned = planRoleCollect({
      links,
      member: memberWithRoles("a"),
      guildCollectSec: 60,
      lastByLinkId: {},
    });
    expect(planned.ready).toHaveLength(1);
    expect(planned.ready[0]!.income).toBe(50);
  });
});
