// UnbelievaBoat Update Balance — the only user fields their public API accepts.
// PATCH https://api-docs.unbelievaboat.com/reference/patch-user-balance
// PUT sets the same fields to an exact amount. There is no wipe-user endpoint;
// clearing cash, bank, or both is a PUT of 0.

export const UB_BALANCE_DOCS =
  "https://api-docs.unbelievaboat.com/reference/patch-user-balance";

export const UB_BALANCE_FIELDS = [
  {
    key: "cash" as const,
    label: "Cash",
    type: "int32",
    summary: "Wallet. PATCH adds or subtracts. PUT sets the exact amount.",
  },
  {
    key: "bank" as const,
    label: "Bank",
    type: "int32",
    summary: "Vault. Same as cash — a relative change, or an exact amount.",
  },
  {
    key: "reason" as const,
    label: "Reason",
    type: "string",
    summary: "Optional note stored on the UnbelievaBoat audit log.",
  },
] as const;

export const UB_BALANCE_READONLY = [
  { key: "total" as const, label: "Total", summary: "Cash + bank. UnbelievaBoat calculates this." },
  { key: "rank" as const, label: "Rank", summary: "Leaderboard place. It moves when cash or bank changes." },
  { key: "user_id" as const, label: "User", summary: "Discord snowflake. It identifies the member and is not editable." },
] as const;

export const UB_RESET_TARGETS = [
  { key: "cash" as const, label: "Clear cash", detail: "Sets cash to 0. Bank stays." },
  { key: "bank" as const, label: "Clear bank", detail: "Sets bank to 0. Cash stays." },
  { key: "all" as const, label: "Clear all", detail: "Sets cash and bank to 0." },
] as const;

export type BalanceResetTarget = (typeof UB_RESET_TARGETS)[number]["key"];

export type BalanceEditInput = {
  mode: "patch" | "set" | "reset";
  cash?: number;
  bank?: number;
  reason?: string;
  reset?: BalanceResetTarget;
};

export type BalanceEditBody = {
  cash?: number;
  bank?: number;
  reason: string;
};

export type BalanceEditPlan = {
  ok: true;
  method: "PATCH" | "PUT";
  body: BalanceEditBody;
  audit: "balance_patch" | "balance_set" | "balance_reset";
  reset?: BalanceResetTarget;
};

export type BalanceEditResult = BalanceEditPlan | { ok: false; error: string };

function cleanReason(reason: string | undefined, fallback: string): string {
  const text = reason?.trim();
  return text ? text.slice(0, 200) : fallback;
}

function isWhole(n: number): boolean {
  return Number.isSafeInteger(n);
}

export function planBalanceEdit(input: BalanceEditInput): BalanceEditResult {
  if (input.mode === "reset") {
    const target = input.reset;
    if (target !== "cash" && target !== "bank" && target !== "all") {
      return { ok: false, error: "Choose cash, bank, or all to reset." };
    }
    const body: BalanceEditBody = {
      reason: cleanReason(input.reason, target === "all"
        ? "Reset cash and bank to 0"
        : `Reset ${target} to 0`),
    };
    if (target === "cash" || target === "all") body.cash = 0;
    if (target === "bank" || target === "all") body.bank = 0;
    return { ok: true, method: "PUT", body, audit: "balance_reset", reset: target };
  }

  if (input.cash !== undefined && !isWhole(input.cash)) {
    return { ok: false, error: "Cash must be a whole number." };
  }
  if (input.bank !== undefined && !isWhole(input.bank)) {
    return { ok: false, error: "Bank must be a whole number." };
  }
  if (input.cash === undefined && input.bank === undefined) {
    return { ok: false, error: "Provide cash and/or bank." };
  }

  if (input.mode === "set") {
    if ((input.cash !== undefined && input.cash < 0) || (input.bank !== undefined && input.bank < 0)) {
      return { ok: false, error: "Exact balances cannot be negative. Use add / subtract to remove money." };
    }
    return {
      ok: true,
      method: "PUT",
      audit: "balance_set",
      body: {
        ...(input.cash !== undefined ? { cash: input.cash } : {}),
        ...(input.bank !== undefined ? { bank: input.bank } : {}),
        reason: cleanReason(input.reason, "Balance set"),
      },
    };
  }

  return {
    ok: true,
    method: "PATCH",
    audit: "balance_patch",
    body: {
      ...(input.cash !== undefined ? { cash: input.cash } : {}),
      ...(input.bank !== undefined ? { bank: input.bank } : {}),
      reason: cleanReason(input.reason, "Balance adjust"),
    },
  };
}

export function describeBalanceEdit(plan: BalanceEditPlan): string {
  if (plan.audit === "balance_reset") {
    if (plan.reset === "all") return "Cleared cash and bank to 0.";
    if (plan.reset === "bank") return "Cleared bank to 0.";
    return "Cleared cash to 0.";
  }
  const fmt = (n: number) => new Intl.NumberFormat().format(n);
  if (plan.audit === "balance_set") {
    const bits: string[] = [];
    if (plan.body.cash !== undefined) bits.push(`cash to ${fmt(plan.body.cash)}`);
    if (plan.body.bank !== undefined) bits.push(`bank to ${fmt(plan.body.bank)}`);
    return `Set ${bits.join(" and ")}.`;
  }
  const bits: string[] = [];
  if (plan.body.cash !== undefined && plan.body.cash !== 0) {
    bits.push(`${plan.body.cash > 0 ? "+" : ""}${fmt(plan.body.cash)} cash`);
  }
  if (plan.body.bank !== undefined && plan.body.bank !== 0) {
    bits.push(`${plan.body.bank > 0 ? "+" : ""}${fmt(plan.body.bank)} bank`);
  }
  if (!bits.length) return "No balance change.";
  return `Adjusted by ${bits.join(" and ")}.`;
}
