import { describe, expect, it } from "vitest";
import { describeBalanceEdit, planBalanceEdit, UB_BALANCE_FIELDS } from "../balance-edit.js";

describe("planBalanceEdit", () => {
  it("lists cash, bank, and reason as the editable Update Balance fields", () => {
    expect(UB_BALANCE_FIELDS.map(f => f.key)).toEqual(["cash", "bank", "reason"]);
  });

  it("patches only the fields that were provided", () => {
    const plan = planBalanceEdit({ mode: "patch", bank: -250, reason: "fix bank" });
    expect(plan).toMatchObject({
      ok: true,
      method: "PATCH",
      audit: "balance_patch",
      body: { bank: -250, reason: "fix bank" },
    });
    if (plan.ok) expect(plan.body.cash).toBeUndefined();
  });

  it("sets an exact bank balance without touching cash", () => {
    const plan = planBalanceEdit({ mode: "set", bank: 5000 });
    expect(plan).toMatchObject({
      ok: true,
      method: "PUT",
      audit: "balance_set",
      body: { bank: 5000, reason: "Balance set" },
    });
  });

  it("rejects a negative exact balance", () => {
    const plan = planBalanceEdit({ mode: "set", cash: -1 });
    expect(plan).toEqual({
      ok: false,
      error: "Exact balances cannot be negative. Use add / subtract to remove money.",
    });
  });

  it("resets cash, bank, or both to zero with PUT", () => {
    expect(planBalanceEdit({ mode: "reset", reset: "cash" })).toMatchObject({
      ok: true,
      method: "PUT",
      audit: "balance_reset",
      reset: "cash",
      body: { cash: 0, reason: "Reset cash to 0" },
    });
    const bank = planBalanceEdit({ mode: "reset", reset: "bank" });
    expect(bank.ok && bank.body).toEqual({ bank: 0, reason: "Reset bank to 0" });
    const all = planBalanceEdit({ mode: "reset", reset: "all" });
    expect(all.ok && all.body).toEqual({ cash: 0, bank: 0, reason: "Reset cash and bank to 0" });
    if (all.ok) expect(describeBalanceEdit(all)).toBe("Cleared cash and bank to 0.");
  });

  it("requires a reset target and at least one balance field", () => {
    expect(planBalanceEdit({ mode: "reset" }).ok).toBe(false);
    expect(planBalanceEdit({ mode: "patch" }).ok).toBe(false);
  });
});
