import { describe, expect, it } from "vitest";
import {
  parseAmountToken,
  parseBet,
  resolveUbPrefixCmd,
} from "../ub-prefix-router.js";

describe("resolveUbPrefixCmd", () => {
  it("maps short aliases people commonly type", () => {
    expect(resolveUbPrefixCmd("dep")).toBe("deposit");
    expect(resolveUbPrefixCmd("with")).toBe("withdraw");
    expect(resolveUbPrefixCmd("wd")).toBe("withdraw");
    expect(resolveUbPrefixCmd("col")).toBe("collect");
    expect(resolveUbPrefixCmd("bj")).toBe("blackjack");
    expect(resolveUbPrefixCmd("21")).toBe("blackjack");
    expect(resolveUbPrefixCmd("bal")).toBe("balance");
    expect(resolveUbPrefixCmd("money")).toBe("balance");
    expect(resolveUbPrefixCmd("rr")).toBe("russian");
    expect(resolveUbPrefixCmd("roul")).toBe("roulette");
    expect(resolveUbPrefixCmd("paycheck")).toBe("daily");
  });

  it("keeps full command names", () => {
    expect(resolveUbPrefixCmd("deposit")).toBe("deposit");
    expect(resolveUbPrefixCmd("blackjack")).toBe("blackjack");
    expect(resolveUbPrefixCmd("collect")).toBe("collect");
  });
});

describe("parseAmountToken", () => {
  it("treats empty / all / max as deposit-all", () => {
    expect(parseAmountToken(undefined)).toBe("all");
    expect(parseAmountToken("")).toBe("all");
    expect(parseAmountToken("all")).toBe("all");
    expect(parseAmountToken("ALL")).toBe("all");
    expect(parseAmountToken("max")).toBe("all");
    expect(parseAmountToken("*")).toBe("all");
  });

  it("parses positive amounts", () => {
    expect(parseAmountToken("500")).toBe(500);
    expect(parseAmountToken("1,250")).toBe(1250);
    expect(parseBet("50")).toBe(50);
    expect(parseAmountToken("0")).toBeNull();
    expect(parseAmountToken("nope")).toBeNull();
  });
});
