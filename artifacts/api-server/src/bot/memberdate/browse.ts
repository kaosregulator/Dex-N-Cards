import type { GuildMember } from "discord.js";
import { tenureFilterMinMs, type TenureFilterKey } from "./format.js";

export const PAGE_SIZE = 8;

export type BrowseRow = {
  member: GuildMember;
  joinedMs: number | null;
  roleGrantedAt: Date | null;
};

export function filterBrowseRows(
  rows: BrowseRow[],
  opts: {
    minJoined: TenureFilterKey;
    minRole: TenureFilterKey;
    requireRoleGrant: boolean;
    now?: number;
  },
): BrowseRow[] {
  const now = opts.now ?? Date.now();
  const minJoinedMs = tenureFilterMinMs(opts.minJoined);
  const minRoleMs = tenureFilterMinMs(opts.minRole);

  return rows.filter(row => {
    if (minJoinedMs > 0) {
      if (row.joinedMs == null) return false;
      if (now - row.joinedMs < minJoinedMs) return false;
    }
    if (opts.requireRoleGrant && minRoleMs > 0) {
      if (!row.roleGrantedAt) return false;
      if (now - row.roleGrantedAt.getTime() < minRoleMs) return false;
    }
    return true;
  });
}

export function sortBrowseRows(
  rows: BrowseRow[],
  sort: string,
): BrowseRow[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    switch (sort) {
      case "joined_asc":
        return (a.joinedMs ?? Number.MAX_SAFE_INTEGER) - (b.joinedMs ?? Number.MAX_SAFE_INTEGER);
      case "role_asc":
        return (a.roleGrantedAt?.getTime() ?? Number.MAX_SAFE_INTEGER)
          - (b.roleGrantedAt?.getTime() ?? Number.MAX_SAFE_INTEGER);
      case "role_desc":
        return (b.roleGrantedAt?.getTime() ?? 0) - (a.roleGrantedAt?.getTime() ?? 0);
      case "name":
        return a.member.displayName.localeCompare(b.member.displayName, undefined, { sensitivity: "base" });
      case "joined_desc":
      default:
        return (b.joinedMs ?? 0) - (a.joinedMs ?? 0);
    }
  });
  return copy;
}
