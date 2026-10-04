import { describe, expect, it } from "vitest";
import {
  DEFAULT_STORE_ICONS,
  dedupeIncomeRoles,
  discordEmojiCdnUrl,
  formatGuildEmoji,
  isAnimatedStoreImage,
  isHttpImageUrl,
  normalizeStoreIconInput,
  presetById,
  resolveSelectEmoji,
} from "../store-icons.js";

describe("store-icons", () => {
  it("ships a handful of default Twemoji presets", () => {
    expect(DEFAULT_STORE_ICONS.length).toBeGreaterThanOrEqual(8);
    expect(presetById("sparkle")?.emoji).toBe("✨");
    expect(presetById("crown")?.imageUrl).toMatch(/twemoji/);
  });

  it("resolves unicode emoji for select menus", () => {
    expect(resolveSelectEmoji("👑")).toBe("👑");
    expect(resolveSelectEmoji("  🔥 ")).toBe("🔥");
  });

  it("resolves custom guild emoji (static + animated)", () => {
    expect(resolveSelectEmoji("<:bob:123456789012345678>")).toEqual({
      id: "123456789012345678",
      name: "bob",
    });
    expect(resolveSelectEmoji("<a:spin:987654321098765432>")).toEqual({
      id: "987654321098765432",
      name: "spin",
      animated: true,
    });
  });

  it("normalizes custom emoji into CDN image URLs", () => {
    const staticIcon = normalizeStoreIconInput("<:vip:111>");
    expect(staticIcon.emoji).toBe("<:vip:111>");
    expect(staticIcon.imageUrl).toBe(
      "https://cdn.discordapp.com/emojis/111.png?size=128&quality=lossless",
    );

    const animated = normalizeStoreIconInput("<a:glow:222>");
    expect(animated.imageUrl).toBe(
      "https://cdn.discordapp.com/emojis/222.gif?size=128&quality=lossless",
    );
  });

  it("defaults empty emoji input to sparkle", () => {
    expect(normalizeStoreIconInput("   ")).toEqual({ emoji: "✨" });
  });

  it("accepts http(s) image URLs including Discord CDN", () => {
    expect(isHttpImageUrl("https://cdn.example.com/icon.png")).toBe(true);
    expect(isHttpImageUrl("https://cdn.discordapp.com/emojis/1.png?size=64")).toBe(true);
    expect(isHttpImageUrl("ftp://nope.com/x.png")).toBe(false);
    expect(isHttpImageUrl("not-a-url")).toBe(false);
  });

  it("detects animated GIF store images", () => {
    expect(isAnimatedStoreImage(discordEmojiCdnUrl("222", true))).toBe(true);
    expect(isAnimatedStoreImage(discordEmojiCdnUrl("111", false))).toBe(false);
    expect(isAnimatedStoreImage("https://cdn.example.com/icon.png")).toBe(false);
  });

  it("formats guild emoji markup", () => {
    expect(formatGuildEmoji({ id: "1", name: "vip" })).toBe("<:vip:1>");
    expect(formatGuildEmoji({ id: "2", name: "spin", animated: true })).toBe("<a:spin:2>");
  });

  it("dedupes income roles by discord role id (keeps highest income)", () => {
    const rows = dedupeIncomeRoles([
      { discordRoleId: "a", incomeAmount: 10 },
      { discordRoleId: "a", incomeAmount: 50 },
      { discordRoleId: "b", incomeAmount: 20 },
      { discordRoleId: null, incomeAmount: 99 },
    ]);
    expect(rows).toEqual([
      { discordRoleId: "a", incomeAmount: 50 },
      { discordRoleId: "b", incomeAmount: 20 },
    ]);
  });
});
