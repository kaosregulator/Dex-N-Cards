import { describe, expect, it } from "vitest";
import { PermissionFlagsBits } from "discord.js";
import {
  botHasTatsuStaffPerms,
  memberHasTatsuStaffPerms,
  TATSU_DEFAULT_MEMBER_PERMISSIONS,
} from "../access.js";

function perms(...flags: bigint[]) {
  let bit = 0n;
  for (const f of flags) bit |= f;
  return {
    has(perm: bigint | string) {
      if (typeof perm === "string") {
        if (perm === "Administrator") return (bit & PermissionFlagsBits.Administrator) !== 0n;
        if (perm === "ManageGuild") return (bit & PermissionFlagsBits.ManageGuild) !== 0n;
        return false;
      }
      return (bit & perm) !== 0n;
    },
  };
}

describe("memberHasTatsuStaffPerms", () => {
  it("allows the guild owner even without explicit bits", () => {
    expect(memberHasTatsuStaffPerms("owner", "owner", null)).toBe(true);
  });

  it("allows Administrator", () => {
    expect(memberHasTatsuStaffPerms("u1", "other", perms(PermissionFlagsBits.Administrator))).toBe(true);
  });

  it("allows Manage Server", () => {
    expect(memberHasTatsuStaffPerms("u1", "other", perms(PermissionFlagsBits.ManageGuild))).toBe(true);
  });

  it("denies members without staff perms", () => {
    expect(memberHasTatsuStaffPerms("u1", "other", perms(PermissionFlagsBits.SendMessages))).toBe(false);
    expect(memberHasTatsuStaffPerms("u1", "other", null)).toBe(false);
  });
});

describe("botHasTatsuStaffPerms", () => {
  it("requires a present bot member with staff perms", () => {
    expect(botHasTatsuStaffPerms(null)).toBe(false);
    expect(botHasTatsuStaffPerms({ permissions: perms(PermissionFlagsBits.SendMessages) } as never)).toBe(false);
    expect(botHasTatsuStaffPerms({ permissions: perms(PermissionFlagsBits.ManageGuild) } as never)).toBe(true);
    expect(botHasTatsuStaffPerms({ permissions: perms(PermissionFlagsBits.Administrator) } as never)).toBe(true);
  });
});

describe("TATSU_DEFAULT_MEMBER_PERMISSIONS", () => {
  it("includes Manage Server and Administrator", () => {
    expect((TATSU_DEFAULT_MEMBER_PERMISSIONS & PermissionFlagsBits.ManageGuild) !== 0n).toBe(true);
    expect((TATSU_DEFAULT_MEMBER_PERMISSIONS & PermissionFlagsBits.Administrator) !== 0n).toBe(true);
  });
});
