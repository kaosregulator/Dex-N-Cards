import { describe, expect, it } from "vitest";
import { PermissionFlagsBits } from "discord.js";
import {
  memberIsMemberDateStaff,
  MEMBERDATE_DEFAULT_MEMBER_PERMISSIONS,
} from "../access.js";

function perms(...flags: bigint[]) {
  let bit = 0n;
  for (const f of flags) bit |= f;
  return {
    has(perm: bigint) {
      return (bit & perm) !== 0n;
    },
  };
}

describe("memberIsMemberDateStaff", () => {
  it("allows owner, admin, manage guild, manage messages", () => {
    expect(memberIsMemberDateStaff("o", "o", null)).toBe(true);
    expect(memberIsMemberDateStaff("u", "x", perms(PermissionFlagsBits.Administrator))).toBe(true);
    expect(memberIsMemberDateStaff("u", "x", perms(PermissionFlagsBits.ManageGuild))).toBe(true);
    expect(memberIsMemberDateStaff("u", "x", perms(PermissionFlagsBits.ManageMessages))).toBe(true);
    expect(memberIsMemberDateStaff("u", "x", perms(PermissionFlagsBits.SendMessages))).toBe(false);
  });
});

describe("MEMBERDATE_DEFAULT_MEMBER_PERMISSIONS", () => {
  it("includes staff bits", () => {
    expect((MEMBERDATE_DEFAULT_MEMBER_PERMISSIONS & PermissionFlagsBits.ManageGuild) !== 0n).toBe(true);
    expect((MEMBERDATE_DEFAULT_MEMBER_PERMISSIONS & PermissionFlagsBits.ManageMessages) !== 0n).toBe(true);
  });
});
