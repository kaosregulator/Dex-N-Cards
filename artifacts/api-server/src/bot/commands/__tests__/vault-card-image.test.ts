import { describe, expect, it } from "vitest";
import { dnRarityFromVault, vaultItemImageUrl } from "../vault-image.js";

const SEA_DRAGON_WIX =
  "wix:image://v1/6511c0_f0394e40ab3449f8aaf85bc391b12a7a~mv2.png/Screenshot%202026-08-24%20151044.png#originWidth=267&originHeight=143";
const SEA_DRAGON_THUMB =
  "https://static.wixstatic.com/media/6511c0_79a94e124844450389a25e9594ad9b7f~mv2.png/v1/fill/w_181,h_200,al_c,lg_1,q_85,enc_avif,quality_auto/6511c0_79a94e124844450389a25e9594ad9b7f~mv2.png";

describe("Vault Values card image", () => {
  it("uses the original Wix media file instead of the cropped thumbnail", () => {
    expect(vaultItemImageUrl(SEA_DRAGON_WIX, SEA_DRAGON_THUMB)).toBe(
      "https://static.wixstatic.com/media/6511c0_f0394e40ab3449f8aaf85bc391b12a7a~mv2.png",
    );
  });

  it("falls back to the media id inside imagelink when there is no wix image", () => {
    expect(vaultItemImageUrl(null, SEA_DRAGON_THUMB)).toBe(
      "https://static.wixstatic.com/media/6511c0_79a94e124844450389a25e9594ad9b7f~mv2.png",
    );
  });

  it("maps Vault rarities onto built-in DN rarities", () => {
    expect(dnRarityFromVault("Exotic")).toBe("mythic");
    expect(dnRarityFromVault("Limited Edition")).toBe("mythic");
    expect(dnRarityFromVault("Legendary")).toBe("legendary");
    expect(dnRarityFromVault("Epic")).toBe("epic");
    expect(dnRarityFromVault("Rare")).toBe("rare");
    expect(dnRarityFromVault("Uncommon")).toBe("uncommon");
    expect(dnRarityFromVault("Common")).toBe("common");
    expect(dnRarityFromVault("")).toBeNull();
  });
});

describe("restored card-admin slash commands", () => {
  async function registered() {
    process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
    const { HUB_REPLACED_COMMANDS, buildCommands, internalCommandName, ADMIN_HUB_COMMANDS } = await import("../register.js");
    const chat = buildCommands().filter((c) => (c.type ?? 1) === 1);
    return { chat, HUB_REPLACED_COMMANDS, internalCommandName, ADMIN_HUB_COMMANDS };
  }

  it("registers drop, mass drop, vault create, upload create, and edit image", async () => {
    const { chat, HUB_REPLACED_COMMANDS, internalCommandName } = await registered();
    const names = new Set(chat.map((c) => c.name));
    for (const name of ["drop", "mass_drop", "create_card_from_mttv", "create_cards_from_mttv", "create_card_from_roblox", "add_card", "edit_image"]) {
      expect(names.has(name), name).toBe(true);
      expect(HUB_REPLACED_COMMANDS.has(internalCommandName(name)), name).toBe(false);
    }
    expect(names.has("delete_all_cards"), "delete_all_cards").toBe(true);
    expect(HUB_REPLACED_COMMANDS.has("deleteallcards")).toBe(false);
    const wipe = chat.find((c) => c.name === "delete_all_cards") as { description?: string } | undefined;
    expect(wipe?.description?.length ?? 999).toBeLessThanOrEqual(100);
    expect(chat.length).toBeLessThanOrEqual(100);
  });

  it("registers give, take, edit, delete, and library as autocomplete slashes", async () => {
    const { chat, HUB_REPLACED_COMMANDS } = await registered();
    const names = new Set(chat.map((c) => c.name));
    expect(names.has("cardadmin")).toBe(false);
    expect(HUB_REPLACED_COMMANDS.has("createcardfrom")).toBe(true);
    expect(names.has("create_card_from")).toBe(false);
    const restored = ["give", "take_back", "give_shards", "take_shards", "give_all", "edit_card", "delete_card", "edit_user", "library"];
    for (const name of restored) {
      expect(names.has(name), name).toBe(true);
      expect(HUB_REPLACED_COMMANDS.has(name), name).toBe(false);
    }
    const autocompleteName = (publicName: string) => {
      const cmd = chat.find((c) => c.name === publicName) as {
        description?: string;
        options?: Array<{ name: string; autocomplete?: boolean; required?: boolean }>;
      };
      expect((cmd.description?.length ?? 999), publicName).toBeLessThanOrEqual(100);
      return cmd.options?.find((o) => o.name === "name" || o.name === "rarity");
    };
    expect(autocompleteName("give")?.autocomplete).toBe(true);
    expect(autocompleteName("take_back")?.autocomplete).toBe(true);
    expect(autocompleteName("edit_card")?.autocomplete).toBe(true);
    expect(autocompleteName("delete_card")?.autocomplete).toBe(true);
    expect(autocompleteName("give_all")?.autocomplete).toBe(true);
    expect(chat.length).toBeLessThanOrEqual(100);
  });

  it("gives vault create an item, a rarity, and an image attachment", async () => {
    const { chat } = await registered();
    const cmd = chat.find((c) => c.name === "create_card_from_mttv") as {
      options?: Array<{ name: string; type: number; required?: boolean }>;
    };
    const names = (cmd.options ?? []).map((o) => o.name);
    expect(names).toEqual(expect.arrayContaining(["item", "rarity", "image"]));
    const image = cmd.options?.find((o) => o.name === "image");
    // Discord application command option type 11 = attachment.
    expect(image?.type).toBe(11);
    expect(image?.required).toBeFalsy();
  });

  it("drops unused slashes and registers the new hubs", async () => {
    const { chat, HUB_REPLACED_COMMANDS } = await registered();
    const names = new Set(chat.map((c) => c.name));
    for (const gone of [
      "funfact", "hqbuild", "badge", "daily_ub", "slots_ub", "blackjack_ub",
      "progression_default", "progression_card", "collector_role", "collector",
    ]) {
      expect(names.has(gone), gone).toBe(false);
    }
    expect(HUB_REPLACED_COMMANDS.has("funfact")).toBe(true);
    for (const keep of [
      "progression", "wishlist_role", "artshow", "badges", "casino", "hq", "delete_all_cards",
    ]) {
      expect(names.has(keep), keep).toBe(true);
    }
    expect(chat.length).toBeLessThanOrEqual(100);
  });

  it("registers bulk vault create with optional DN rarity and set", async () => {
    const { chat, internalCommandName, ADMIN_HUB_COMMANDS } = await registered();
    const cmd = chat.find((c) => c.name === "create_cards_from_mttv") as {
      description?: string;
      options?: Array<{ name: string; required?: boolean }>;
    };
    expect(cmd).toBeTruthy();
    expect(cmd.description?.length ?? 999).toBeLessThanOrEqual(100);
    expect(internalCommandName("create_cards_from_mttv")).toBe("createcardsfrommttv");
    expect(ADMIN_HUB_COMMANDS.has("createcardsfrommttv")).toBe(true);
    const names = (cmd.options ?? []).map((o) => o.name);
    expect(names).toEqual(expect.arrayContaining(["rarity", "set"]));
    expect(names).not.toEqual(expect.arrayContaining(["item"]));
    expect(cmd.options?.find((o) => o.name === "rarity")?.required).toBeFalsy();
    expect(cmd.options?.find((o) => o.name === "set")?.required).toBeFalsy();
  });

  it("does not keep a cardadmin hub button row", async () => {
    process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
    const { CARD_ADMIN_HUB_BUTTON_IDS } = await import("../cardadmin-hub.js");
    expect([...CARD_ADMIN_HUB_BUTTON_IDS]).toEqual([]);
  });

  it("registers Roblox create with username autocomplete and optional image", async () => {
    const { chat, internalCommandName, ADMIN_HUB_COMMANDS } = await registered();
    const cmd = chat.find((c) => c.name === "create_card_from_roblox") as {
      description?: string;
      options?: Array<{ name: string; type: number; required?: boolean; autocomplete?: boolean }>;
    };
    expect(cmd).toBeTruthy();
    expect(cmd.description?.length ?? 999).toBeLessThanOrEqual(100);
    expect(internalCommandName("create_card_from_roblox")).toBe("createcardfromroblox");
    expect(ADMIN_HUB_COMMANDS.has("createcardfromroblox")).toBe(true);
    const names = (cmd.options ?? []).map((o) => o.name);
    expect(names).toEqual(expect.arrayContaining(["username", "rarity"]));
    const username = cmd.options?.find((o) => o.name === "username");
    expect(username?.required).toBe(true);
    expect(username?.autocomplete).toBe(true);
    const image = cmd.options?.find((o) => o.name === "image");
    expect(image?.type).toBe(11);
    expect(image?.required).toBeFalsy();
  });
});
