/**
 * Clean numbered UnbelievaBoat boards for collect + shop.
 * Custom emoji markup is kept so Discord renders and animates it in the line.
 */

export type BoardRole = {
  emoji?: string | null;
  name: string;
  roleId?: string | null;
  /** Text after the role, e.g. `ready in **1m 40s**` or `💰8,000 (cash)`. */
  detail: string;
};

/** Unicode or `<:name:id>` / `<a:name:id>` — anything Discord can draw inline. */
export function inlineStoreEmoji(emoji: string | null | undefined): string {
  const t = (emoji ?? "").trim();
  if (!t) return "";
  if (t.includes("<")) return t;
  if (/\p{Extended_Pictographic}/u.test(t)) return t;
  return "";
}

/** Role pill when we have an id, otherwise the bold display name. Emoji stays in front. */
export function formatBoardRole(role: Pick<BoardRole, "emoji" | "name" | "roleId">): string {
  const icon = inlineStoreEmoji(role.emoji);
  const who = role.roleId ? `<@&${role.roleId}>` : `**${role.name}**`;
  return icon ? `${icon} ${who}` : who;
}

/** `1. emoji @Role — ready in **1m**` */
export function formatDottedRole(index: number, role: BoardRole): string {
  return `${index}. ${formatBoardRole(role)} — ${role.detail}`;
}

/** `1 - emoji @Role 💰8,000 (cash)` — UnbelievaBoat collect receipt. */
export function formatDashedRole(index: number, role: BoardRole): string {
  return `${index} - ${formatBoardRole(role)} ${role.detail}`;
}

export function formatCollectCooldownBoard(soonest: string, rows: BoardRole[]): string {
  const lines = [
    `All your income roles are on cooldown. Next in **${soonest}**.`,
    "",
    ...rows.map((r, i) => formatDottedRole(i + 1, r)),
  ];
  return clipBoard(lines);
}

export function formatCollectSuccessBoard(collected: BoardRole[], cooling: BoardRole[] = []): string {
  const lines = [
    "Role income successfully collected!",
    "",
    ...collected.map((r, i) => formatDashedRole(i + 1, r)),
  ];
  if (cooling.length) {
    lines.push("", "Still cooling", ...cooling.map((r, i) => formatDottedRole(i + 1, r)));
  }
  return clipBoard(lines);
}

export function formatShopBoard(rows: BoardRole[]): string {
  const lines = [
    "Prices in **cash**. Own one already? Use **Collect** for income.",
    "",
    ...rows.map((r, i) => formatDottedRole(i + 1, r)),
  ];
  return clipBoard(lines);
}

/** Stay under Discord's 4096-char embed description. */
export function clipBoard(lines: string[], limit = 3900): string {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const next = used + line.length + (out.length ? 1 : 0);
    if (out.length > 0 && next > limit) {
      const hidden = lines.length - out.length;
      if (hidden > 0) out.push(`…and ${hidden} more`);
      break;
    }
    out.push(line);
    used = next;
  }
  return out.join("\n");
}
