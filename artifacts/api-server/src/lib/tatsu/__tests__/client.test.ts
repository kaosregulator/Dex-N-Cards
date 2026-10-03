import { describe, expect, it } from "vitest";
import { normalizeTatsuApiKey, toTatsuAction } from "../client.js";

describe("normalizeTatsuApiKey", () => {
  it("trims and strips quotes / Bearer prefix", () => {
    expect(normalizeTatsuApiKey("  abc123  ")).toBe("abc123");
    expect(normalizeTatsuApiKey('"abc123"')).toBe("abc123");
    expect(normalizeTatsuApiKey("'abc123'")).toBe("abc123");
    expect(normalizeTatsuApiKey("Bearer abc123")).toBe("abc123");
    expect(normalizeTatsuApiKey("bearer abc123")).toBe("abc123");
  });

  it("rejects empty values", () => {
    expect(normalizeTatsuApiKey(null)).toBeNull();
    expect(normalizeTatsuApiKey("")).toBeNull();
    expect(normalizeTatsuApiKey("   ")).toBeNull();
    expect(normalizeTatsuApiKey('""')).toBeNull();
  });
});

describe("toTatsuAction", () => {
  it("maps add/remove to 0/1 integers", () => {
    expect(toTatsuAction(0)).toBe(0);
    expect(toTatsuAction(1)).toBe(1);
    expect(toTatsuAction("1")).toBe(1);
    expect(toTatsuAction("remove")).toBe(1);
    expect(toTatsuAction("add")).toBe(0);
    expect(toTatsuAction(true)).toBe(0);
    expect(toTatsuAction(undefined)).toBe(0);
  });
});
