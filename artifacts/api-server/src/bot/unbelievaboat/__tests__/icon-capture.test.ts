import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  beginIconCapture,
  cancelIconCapture,
  extractIconFromMessage,
  hasIconCapture,
  resolveEmojiShortcode,
  tryConsumeIconCaptureMessage,
} from "../icon-capture.js";
import { discordEmojiCdnUrl, titleSafeStoreEmoji } from "../store-icons.js";

function fakeMsg(partial: Record<string, unknown>) {
  return {
    author: { bot: false, id: "user1" },
    guild: { id: "guild1", emojis: { cache: new Map() } },
    channelId: "chan1",
    content: "",
    attachments: { find: () => undefined },
    embeds: [],
    delete: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue({ delete: vi.fn().mockResolvedValue(undefined) }),
    ...partial,
  } as any;
}

describe("icon-capture", () => {
  beforeEach(() => {
    cancelIconCapture("guild1", "user1");
  });

  it("extracts custom static + animated emoji from chat", () => {
    const staticIcon = extractIconFromMessage(fakeMsg({ content: "<:Angel:111>" }));
    expect(staticIcon).toMatchObject({
      emoji: "<:Angel:111>",
      imageUrl: discordEmojiCdnUrl("111", false),
      animated: false,
      source: "custom_emoji",
    });

    const anim = extractIconFromMessage(fakeMsg({ content: "<a:spin:222>" }));
    expect(anim).toMatchObject({
      emoji: "<a:spin:222>",
      imageUrl: discordEmojiCdnUrl("222", true),
      animated: true,
      source: "custom_emoji",
    });
  });

  it("resolves :shortcode: against guild emoji cache", () => {
    const cache = new Map([
      ["333", { id: "333", name: "Angel", animated: false }],
    ]);
    const icon = extractIconFromMessage(fakeMsg({
      content: ":Angel:",
      guild: { id: "guild1", emojis: { cache } },
    }));
    expect(icon?.emoji).toBe("<:Angel:333>");
    expect(icon?.imageUrl).toContain("333.png");
  });

  it("extracts unicode emoji from Discord’s emoji bar", () => {
    const icon = extractIconFromMessage(fakeMsg({ content: "🔥" }));
    expect(icon).toMatchObject({ emoji: "🔥", source: "unicode", animated: false });
  });

  it("extracts GIF attachments via proxyURL", () => {
    const icon = extractIconFromMessage(fakeMsg({
      attachments: {
        find: (fn: (a: any) => boolean) => {
          const att = {
            contentType: "image/gif",
            name: "cool.gif",
            url: "https://cdn.discordapp.com/attachments/1/2/cool.gif",
            proxyURL: "https://media.discordapp.net/attachments/1/2/cool.gif",
          };
          return fn(att) ? att : undefined;
        },
      },
    }));
    expect(icon?.source).toBe("attachment");
    expect(icon?.animated).toBe(true);
    expect(icon?.imageUrl).toContain("media.discordapp.net");
  });

  it("extracts GIF picker embeds (Tenor)", () => {
    const icon = extractIconFromMessage(fakeMsg({
      embeds: [{
        image: { url: "https://media.tenor.com/abc/cool.gif" },
        title: "cool",
      }],
    }));
    expect(icon?.animated).toBe(true);
    expect(icon?.imageUrl).toContain("tenor.com");
  });

  it("resolves shortcodes via resolveEmojiShortcode", () => {
    const icon = resolveEmojiShortcode(":vip:", [
      { id: "9", name: "vip", animated: true },
    ]);
    expect(icon.emoji).toBe("<a:vip:9>");
    expect(icon.imageUrl).toContain("9.gif");
  });

  it("consumes pick-in-chat messages and deletes them", async () => {
    const confirm = vi.fn().mockResolvedValue(undefined);
    const abort = vi.fn().mockResolvedValue(undefined);
    beginIconCapture({
      guildId: "guild1",
      userId: "user1",
      linkId: 7,
      channelId: "chan1",
      confirm,
      abort,
    });
    expect(hasIconCapture("guild1", "user1")).toBe(true);

    const msg = fakeMsg({ content: "✨" });
    const consumed = await tryConsumeIconCaptureMessage(msg);
    expect(consumed).toBe(true);
    expect(msg.delete).toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ emoji: "✨" }));
    expect(hasIconCapture("guild1", "user1")).toBe(false);
  });

  it("cancels on cancel text", async () => {
    const confirm = vi.fn();
    const abort = vi.fn().mockResolvedValue(undefined);
    beginIconCapture({
      guildId: "guild1",
      userId: "user1",
      linkId: 7,
      channelId: "chan1",
      confirm,
      abort,
    });
    const msg = fakeMsg({ content: "cancel" });
    expect(await tryConsumeIconCaptureMessage(msg)).toBe(true);
    expect(abort).toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("keeps custom emoji markup out of titles", () => {
    expect(titleSafeStoreEmoji("<:Angel:1>", "🖼️")).toBe("🖼️");
    expect(titleSafeStoreEmoji("🔥")).toBe("🔥");
  });
});
