import { describe, expect, it } from "vitest";
import {
  formatBoardRole,
  formatCollectCooldownBoard,
  formatCollectSuccessBoard,
  formatDashedRole,
  formatDottedRole,
  formatShopBoard,
  inlineStoreEmoji,
} from "../ub-board.js";
import { emojiKeptAfterUpload, pickStoreBoardImage, stampIconMeta } from "../store-icons.js";

describe("unbelievaboat boards", () => {
  it("keeps custom emoji markup in front of the role pill", () => {
    const emoji = "<a:bob:123>";
    expect(inlineStoreEmoji(emoji)).toBe(emoji);
    expect(formatBoardRole({ emoji, name: "Bob cult", roleId: "999" })).toBe("<a:bob:123> <@&999>");
    expect(formatDottedRole(2, { emoji: "🔫", name: "One/One", roleId: "1", detail: "ready in **1m 40s**" }))
      .toBe("2. 🔫 <@&1> — ready in **1m 40s**");
    expect(formatDashedRole(1, { emoji: "💰", name: "Pocket", roleId: "2", detail: "💰8,000 (cash)" }))
      .toBe("1 - 💰 <@&2> 💰8,000 (cash)");
  });

  it("numbers cooldown and collect receipts", () => {
    const cd = formatCollectCooldownBoard("1m 40s", [
      { emoji: "🔫", name: "One/One", roleId: "1", detail: "ready in **1m 40s**" },
      { emoji: "<a:simp:5>", name: "Certified Simp", roleId: "5", detail: "ready in **1m 40s**" },
    ]);
    expect(cd.startsWith("All your income roles are on cooldown. Next in **1m 40s**.")).toBe(true);
    expect(cd).toContain("1. 🔫 <@&1> — ready in **1m 40s**");
    expect(cd).toContain("2. <a:simp:5> <@&5> — ready in **1m 40s**");

    const ok = formatCollectSuccessBoard(
      [{ emoji: "💵", name: "Pocket Change", roleId: "9", detail: "💰8,000 (cash)" }],
      [{ emoji: "⭐", name: "Apex", roleId: "8", detail: "ready in **3m 40s**" }],
    );
    expect(ok).toContain("Role income successfully collected!");
    expect(ok).toContain("1 - 💵 <@&9> 💰8,000 (cash)");
    expect(ok).toContain("1. ⭐ <@&8> — ready in **3m 40s**");
  });

  it("numbers the shop without the repeated owned paragraph", () => {
    const shop = formatShopBoard([
      { emoji: "⚔️", name: "Bad bob slayer", roleId: "3", detail: "**150,000** cash · ✅ owned" },
      { emoji: "<a:ham:7>", name: "Hamster", roleId: "7", detail: "**500** cash" },
    ]);
    expect(shop).toContain("1. ⚔️ <@&3> — **150,000** cash · ✅ owned");
    expect(shop).toContain("2. <a:ham:7> <@&7> — **500** cash");
    expect(shop).not.toContain("Already owned — use Collect");
  });
});

describe("store board image", () => {
  it("follows the icon that was changed last, and still prefers a GIF", () => {
    const picked = pickStoreBoardImage([
      { imageUrl: "https://cdn.discordapp.com/emojis/1.gif", animated: true, iconUpdatedAt: 10 },
      { imageUrl: "https://cdn.discordapp.com/emojis/2.gif", animated: true, iconUpdatedAt: 50 },
      { imageUrl: "https://cdn.discordapp.com/emojis/3.png", animated: false, iconUpdatedAt: 99 },
    ]);
    expect(picked).toBe("https://cdn.discordapp.com/emojis/2.gif");
  });

  it("locks an admin icon and keeps a custom emoji when a GIF is uploaded", () => {
    const meta = stampIconMeta({ imageUrl: "old" }, {
      imageUrl: "https://cdn.discordapp.com/attachments/1/hamster.gif",
      animated: true,
    });
    expect(meta.iconLocked).toBe(true);
    expect(meta.imageUrl).toContain("hamster.gif");
    expect(emojiKeptAfterUpload("<a:bob:4>", true)).toBe("<a:bob:4>");
    expect(emojiKeptAfterUpload("✨", true)).toBe("✨");
    expect(emojiKeptAfterUpload("🎞️", true)).toBe("🎞️");
    expect(emojiKeptAfterUpload("", true)).toBe("🎞️");
  });
});
