import { describe, expect, it } from "vitest";
import { PermissionFlagsBits } from "discord.js";
import { memberIsTriviaStaff, TRIVIA_DEFAULT_MEMBER_PERMISSIONS } from "../access.js";
import { roleKeyForMode } from "../role-defs.js";

function perms(...flags: bigint[]) {
  let bit = 0n;
  for (const f of flags) bit |= f;
  return {
    has(perm: bigint) {
      return (bit & perm) !== 0n;
    },
  };
}

describe("memberIsTriviaStaff", () => {
  it("allows owner and Manage Messages", () => {
    expect(memberIsTriviaStaff("o", "o", null)).toBe(true);
    expect(memberIsTriviaStaff("u", "x", perms(PermissionFlagsBits.ManageMessages))).toBe(true);
    expect(memberIsTriviaStaff("u", "x", perms(PermissionFlagsBits.SendMessages))).toBe(false);
  });
});

describe("roleKeyForMode", () => {
  it("maps modes to role keys", () => {
    expect(roleKeyForMode("qotd")).toBe("qotd_champion");
    expect(roleKeyForMode("flash")).toBe("flash_champ");
    expect(roleKeyForMode("prompt")).toBe("smart_cookie");
    expect(roleKeyForMode("trivia")).toBe("trivia_winner");
  });
});

describe("TRIVIA_DEFAULT_MEMBER_PERMISSIONS", () => {
  it("includes manage guild and manage messages", () => {
    expect((TRIVIA_DEFAULT_MEMBER_PERMISSIONS & PermissionFlagsBits.ManageGuild) !== 0n).toBe(true);
    expect((TRIVIA_DEFAULT_MEMBER_PERMISSIONS & PermissionFlagsBits.ManageMessages) !== 0n).toBe(true);
  });
});
