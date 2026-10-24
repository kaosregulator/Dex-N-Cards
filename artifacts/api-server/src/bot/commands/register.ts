import {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType,
  type SlashCommandOptionsOnlyBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import { buildAfkCommandJson, buildAfkSetupCommandJson } from "../afk/commands.js";
import {
  buildQuietCommandJson, buildQuietSetupCommandJson,
  buildVacationCommandJson, buildLoaCommandJson,
} from "../quiet/commands.js";
import { buildEmojiCommandJson, buildPostboardCommandJson } from "../emoji/commands/definition.js";
import { buildQuoteCommandJson, buildQuoteContextMenuJson } from "../quote/definition.js";
import { buildPetCommandJson, buildPetAdminCommandJson } from "../pets/command.js";
import { buildUbAdminCommandJson } from "../unbelievaboat/discord-admin.js";
import { buildCasinoCommandJson } from "../unbelievaboat/casino.js";
import { buildTatsuAdminCommandJson } from "../tatsu/discord-admin.js";
import { buildTriviaAdminCommandJson } from "../trivia/discord-admin.js";
import { buildMemberDateCommandJson } from "../memberdate/definition.js";
import { buildBadgesCommandJson } from "../badges/definition.js";
import { buildArtShowCommandJson } from "../artshow/definition.js";
import {
  buildLotteryCommandJson,
  buildLotteryAdminCommandJson,
} from "../unbelievaboat/lottery/definition.js";
import { buildVaultValueCommandJson } from "./vaultvalue-hub.js";
import { buildTradeHubCommandJson } from "./trade-hub.js";
import { buildSecretCommandJson } from "./secret-hub.js";
import { getRaidFrames } from "../cards/frames.js";

type AnySlashBuilder = SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;

// Exclusive raid-reward frames, as slash-command choices (value = frame id).
const RAID_FRAME_CHOICES = getRaidFrames().map(f => ({ name: `${f.emoji} ${f.name}`, value: f.id }));

function cmd(name: string, desc: string, build: (s: SlashCommandBuilder) => AnySlashBuilder) {
  return build(
    new SlashCommandBuilder().setName(name).setDescription(desc).setDMPermission(false),
  ).toJSON();
}

// Admin commands hide from non-admin members in the Discord slash menu.
// Server owners can re-grant access per-role in Server Settings → Integrations
// → DN Cards → Command Permissions. Bot still enforces server-side regardless.
function adminCmd(name: string, desc: string, build: (s: SlashCommandBuilder) => AnySlashBuilder) {
  return build(
    new SlashCommandBuilder()
      .setName(name).setDescription(desc).setDMPermission(false)
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ).toJSON();
}

function buildLegacyCommands() {
  return [
    // ── User Commands ─────────────────────────────────────────────────────────
    cmd("collection", "View your card collection", s => s
      .addUserOption(o => o.setName("user").setDescription("View another member's collection"))),

    cmd("rank", "Your rank and progression", s => s
      .addUserOption(o => o.setName("user").setDescription("View another member's rank"))),

    buildEmojiCommandJson(),
    buildPostboardCommandJson(),
    buildQuoteCommandJson(),
    buildQuoteContextMenuJson(),
    buildPetCommandJson(),
    buildPetAdminCommandJson(),
    buildUbAdminCommandJson(),
    buildCasinoCommandJson(),
    buildTatsuAdminCommandJson(),
    buildTriviaAdminCommandJson(),
    buildMemberDateCommandJson(),
    buildBadgesCommandJson(),
    buildArtShowCommandJson(),
    buildLotteryCommandJson(),
    buildLotteryAdminCommandJson(),

    cmd("info", "Details, worth, and drop chance", s => s
      .addStringOption(o => o.setName("name").setDescription("Name to look up").setRequired(true).setAutocomplete(true))),

    cmd("list", "Full roster grouped by rarity", s => s),

    cmd("catalog", "Browse by category — see what you own and what's missing", s => s
      .addStringOption(o => o.setName("category").setDescription("Optional: jump straight to a category (default: overview)")
        .addChoices(
          { name: "💎 Limited Edition", value: "mythic" },
          { name: "🟡 Legendary", value: "legendary" },
          { name: "🟣 Epic", value: "epic" },
          { name: "🔵 Rare", value: "rare" },
          { name: "🟢 Uncommon", value: "uncommon" },
          { name: "⚪ Common", value: "common" },
          { name: "🎆 Event Exclusive", value: "event" },
          { name: "💎 Limited Edition", value: "limited" },
          { name: "🃏 All", value: "all" },
        ))
      .addUserOption(o => o.setName("user").setDescription("Check another member's ownership (default: you)"))),

    cmd("top", "Server leaderboards — Collector, Battle & Raid (switch with the dropdown)", s => s
      .addStringOption(o => o.setName("board").setDescription("Which leaderboard to open first").setRequired(false)
        .addChoices(
          { name: "Collector — Net Worth", value: "collector" },
          { name: "Battle — Ranked", value: "battle" },
          { name: "Raid — Campaign", value: "raid" },
        ))),

    cmd("show_shiny", "Show off your shiny cards with the full shiny effect", s => s),

    cmd("hq", "Your Headquarters — trophies, displays & customization", s => s
      .addUserOption(o => o.setName("user").setDescription("Visit another member's Headquarters"))),

    cmd("hqadmin", "Admin: server siege settings, or edit one member's Headquarters", s => s
      .addUserOption(o => o.setName("user").setDescription("Edit this member's HQ (leave empty for server siege settings)"))),

    cmd("collection_hub", "Browse your collection — filter by rarity, shinies, name & more", s => s
      .addStringOption(o => o.setName("name").setDescription("Jump straight to cards matching this name"))
      .addStringOption(o => o.setName("rarity").setDescription("Filter by rarity key (e.g. legendary, or a custom tier)"))
      .addStringOption(o => o.setName("filter").setDescription("Only show a kind of card")
        .addChoices(
          { name: "✨ Shinies", value: "shiny" },
          { name: "💎 Limited", value: "limited" },
          { name: "🎆 Event", value: "event" },
          { name: "🔁 Duplicates", value: "dupes" },
          { name: "⭐ Leveled", value: "leveled" },
        ))),

    cmd("burn", "Burn duplicates for DN Shards", s => s
      .addStringOption(o => o.setName("name").setDescription("Name to burn").setRequired(true).setAutocomplete(true))
      .addIntegerOption(o => o.setName("amount").setDescription("How many copies to burn (default 1)").setMinValue(1))
      .addBooleanOption(o => o.setName("all").setDescription("Burn every copy you own of this card"))
      .addBooleanOption(o => o.setName("shiny").setDescription("Burn shiny copies (2× shards) instead of normal copies"))),

    cmd("shards", "Check your DN Shards balance", s => s
      .addUserOption(o => o.setName("user").setDescription("View another member's balance"))),

    buildTradeHubCommandJson(),

    // Admin-only: /welcome posts a public, server-wide welcome message, so it is
    // hidden from non-admins in the slash menu (the bot also enforces this server-side).
    adminCmd("welcome", "Post the welcome board in this channel (admin)", s => s),

    // ── /begin (interactive onboarding adventure — one-time, real rewards) ─────
    cmd("begin", "Start your Dex N Cards adventure — a guided intro with real starter rewards", s => s),

    adminCmd("setup", "Interactive server setup wizard — channels, spawns, rates, toggles", s => s),

    cmd("help", "Show player commands", s => s),

    cmd("user-hub", "Your profile, collection & stats", s => s),

    cmd("daily", "Claim your daily DN Shards reward", s => s),

    cmd("calendar", "View your monthly login-calendar rewards and streak", s => s),

    cmd("quests", "View daily & weekly quests — earn shards and packs", s => s),

    cmd("level", "View a card's battle level, XP, and unlocked frames", s => s
      .addStringOption(o => o.setName("name").setDescription("Card name (leave empty for your top leveled cards)").setAutocomplete(true))),

    cmd("frame", "Equip a cosmetic frame on a card you've leveled", s => s
      .addStringOption(o => o.setName("name").setDescription("Card name").setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName("style").setDescription("Frame to equip (leave empty to list options)"))),

    cmd("lock", "Lock/favorite a card so it can't be burned or traded in", s => s
      .addStringOption(o => o.setName("name").setDescription("Card to lock/unlock").setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName("state").setDescription("Lock or unlock (default: toggle)")
        .addChoices({ name: "lock", value: "on" }, { name: "unlock", value: "off" }))),

    cmd("collector", "Toggle spawn pings — join/leave the collector ping role", s => s),

    cmd("search", "Search the roster by name, rarity, or type — see what you own", s => s
      .addStringOption(o => o.setName("query").setDescription("Text to match in the card name"))
      .addStringOption(o => o.setName("rarity").setDescription("Filter by rarity")
        .addChoices(
          { name: "⚪ Common", value: "common" }, { name: "🟢 Uncommon", value: "uncommon" },
          { name: "🔵 Rare", value: "rare" }, { name: "🟣 Epic", value: "epic" },
          { name: "🟡 Legendary", value: "legendary" }, { name: "💎 Limited Edition", value: "mythic" }))
      .addStringOption(o => o.setName("type").setDescription("Filter by card type"))
      .addStringOption(o => o.setName("owned").setDescription("Only owned or only missing")
        .addChoices({ name: "Owned", value: "owned" }, { name: "Missing", value: "missing" }))),

    cmd("pack", "Open a card pack — pick a tier", s => s
      .addStringOption(o => o.setName("tier")
        .setDescription("Which pack to open — built-in or custom (type to search, default: Basic)")
        .setAutocomplete(true))),

    cmd("packstats", "View pack costs, weekly caps & cooldown", s => s),

    cmd("tradein", "🔧 Card Fusion — fuse duplicate copies + Scrap to raise a card's Star Rank", s => s
      .addStringOption(o => o.setName("name").setDescription("Card to fuse — leave blank to browse your duplicates").setRequired(false).setAutocomplete(true))),

    cmd("achievements", "View unlocked achievements", s => s
      .addUserOption(o => o.setName("user").setDescription("View another member's achievements"))),

    cmd("wishlist", "Manage your wishlist — get pinged when wished cards spawn", s => s
      .addSubcommand(sc => sc.setName("add").setDescription("Add to your wishlist")
        .addStringOption(o => o.setName("name").setDescription("Name to add").setRequired(true).setAutocomplete(true)))
      .addSubcommand(sc => sc.setName("remove").setDescription("Remove from your wishlist")
        .addStringOption(o => o.setName("name").setDescription("Name to remove").setRequired(true).setAutocomplete(true)))
      .addSubcommand(sc => sc.setName("list").setDescription("View a wishlist")
        .addUserOption(o => o.setName("user").setDescription("View another member's wishlist")))),

    // ── Quick Admin Slash Commands ────────────────────────────────────────────
    adminCmd("config", "Open the server config panel — visual toggles for catch mode, intervals, etc.", s => s),

    adminCmd("minigames", "Wild Mini-Games — schedule game encounters that gate the next catch", s => s),

    adminCmd("adminhub", "Quick hub — manage admins, timeouts, and see server state", s => s),

    adminCmd("sethub", "Clickable set manager — create sets, add cards, activate spawn pool, export with one click", s => s),

    adminCmd("set_admin", "Interactive set hub — full set management with buttons and dropdowns, no subcommands needed", s => s),

    adminCmd("deleteallcards", "Delete every card on this server, then any sets left. Asks you to confirm", s => s),

    // Restored from the card-admin hub. Buttons can't autocomplete a catalog
    // or attach a file, so these are slash commands. /cardadmin is retired.
    // Kitsu create (createcardfrom) stays unregistered.
    adminCmd("deletecard", "Permanently delete a card from the roster", s => s
      .addStringOption(o => o.setName("name").setDescription("Card to delete").setRequired(true).setAutocomplete(true))),

    adminCmd("give", "Give a card directly to a member", s => s
      .addUserOption(o => o.setName("user").setDescription("Member to receive the card").setRequired(true))
      .addStringOption(o => o.setName("name").setDescription("Card name").setRequired(true).setAutocomplete(true))
      .addIntegerOption(o => o.setName("amount").setDescription("How many copies to give (default 1, max 100)").setMinValue(1).setMaxValue(100))
      .addIntegerOption(o => o.setName("star").setDescription("Star Rank the card arrives at (0-5)").setMinValue(0).setMaxValue(5))
      .addIntegerOption(o => o.setName("level").setDescription("Level the card arrives at (1-100)").setMinValue(1).setMaxValue(100))),

    adminCmd("giveall", "Give one copy of every card to a member — filter by set or rarity", s => s
      .addUserOption(o => o.setName("user").setDescription("Member to receive the cards").setRequired(true))
      .addStringOption(o => o.setName("set").setDescription("Only cards from this set (leave blank for all cards)").setAutocomplete(true))
      .addStringOption(o => o.setName("rarity").setDescription("Only this rarity — includes custom names from /rarity").setAutocomplete(true))
      .addIntegerOption(o => o.setName("shinyrate").setDescription("Shiny chance 0-100% (default 0.5)").setMinValue(0).setMaxValue(100))),

    adminCmd("giveshards", "Give DN Shards to a member", s => s
      .addUserOption(o => o.setName("user").setDescription("Member to receive shards").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Amount of shards").setRequired(true).setMinValue(1))),

    adminCmd("takeback", "Remove a card from a member's collection", s => s
      .addUserOption(o => o.setName("user").setDescription("Member to take the card from").setRequired(true))
      .addStringOption(o => o.setName("name").setDescription("Card name").setRequired(true).setAutocomplete(true))
      .addIntegerOption(o => o.setName("amount").setDescription("How many copies to remove (default 1, max 100)").setMinValue(1).setMaxValue(100))),

    adminCmd("takeshards", "Deduct DN Shards from a member", s => s
      .addUserOption(o => o.setName("user").setDescription("Member to deduct shards from").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Amount to deduct").setRequired(true).setMinValue(1))),

    adminCmd("editcard", "Edit a card — optionally upload a replacement image/GIF", s => s
      .addStringOption(o => o.setName("name").setDescription("Card to edit").setRequired(true).setAutocomplete(true))
      .addAttachmentOption(o => o.setName("image").setDescription("Optional replacement image/GIF upload"))
      .addIntegerOption(o => o.setName("max_copies").setDescription("Max copies for a limited edition card (0 removes the limit)").setMinValue(0))
      .addIntegerOption(o => o.setName("total_minted").setDescription("Current number of copies that exist (careful: manual override)").setMinValue(0))
      .addBooleanOption(o => o.setName("limited").setDescription("Mark this card as limited edition (enforces max_copies cap)"))),

    adminCmd("edituser", "Edit a member: core profile, economy, and battle profile", s => s
      .addUserOption(o => o.setName("user").setDescription("Member to edit").setRequired(true))),

    adminCmd("library", "Search the Kitsu library by category and preview the bio + image", s => s
      .addStringOption(o => o.setName("category").setDescription("Kitsu library to search").setRequired(true)
        .addChoices(
          { name: "Anime", value: "anime" },
          { name: "Manga", value: "manga" },
          { name: "Character", value: "character" },
        ))
      .addStringOption(o => o.setName("name").setDescription("Title or character name — type to search").setRequired(true).setAutocomplete(true))),

    adminCmd("drop", "Force-drop a card — for events and giveaways", s => s
      .addStringOption(o => o.setName("name").setDescription("Card name — leave empty for a random drop from the active set").setAutocomplete(true))
      .addStringOption(o => o.setName("set").setDescription("Pick a specific set to drop from (ignores the active set)").setAutocomplete(true))
      .addIntegerOption(o => o.setName("star").setDescription("Star Rank the caught card arrives at (0-5)").setMinValue(0).setMaxValue(5))
      .addIntegerOption(o => o.setName("level").setDescription("Level the caught card arrives at (1-100)").setMinValue(1).setMaxValue(100))),

    adminCmd("massdrop", "Drop a big batch of cards — mostly low tier with a few bangers", s => s
      .addIntegerOption(o => o.setName("amount").setDescription("How many cards to drop (10-25, default 15)").setMinValue(10).setMaxValue(25))
      .addStringOption(o => o.setName("set").setDescription("Pick a specific set to drop from (ignores the active set)").setAutocomplete(true))),

    adminCmd("addcard", "Create a new card — upload an image/GIF from Discord", s => s
      .addStringOption(o => o.setName("name").setDescription("Card name").setRequired(true).setMaxLength(80))
      .addStringOption(o => o.setName("rarity").setDescription("Built-in rarity tier — type to search").setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName("type").setDescription("Card type/tag — type to search existing types or enter a new one").setRequired(true).setAutocomplete(true))
      .addAttachmentOption(o => o.setName("image").setDescription("Upload card image/GIF with Discord's file picker"))
      .addStringOption(o => o.setName("set").setDescription("Optional set to add this card to immediately").setAutocomplete(true))
      .addStringOption(o => o.setName("description").setDescription("Card description (up to 500 chars)").setMaxLength(500))
      .addBooleanOption(o => o.setName("limited").setDescription("Limited edition — capped copy count?"))
      .addIntegerOption(o => o.setName("max_copies").setDescription("Max copies if limited (default 50)").setMinValue(1))
      .addBooleanOption(o => o.setName("event_exclusive").setDescription("Event exclusive — never spawns randomly?"))),

    adminCmd("createcardfrommttv", "Create a card from a Vault Values item — its image, or your upload, plus a DN rarity", s => s
      .addStringOption(o => o.setName("item").setDescription("Vault Values item name — type to search").setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName("rarity").setDescription("DN rarity — type to search, or auto to use the Vault rarity").setRequired(true).setAutocomplete(true))
      .addAttachmentOption(o => o.setName("image").setDescription("Upload an image (overrides the Vault Values image)"))
      .addStringOption(o => o.setName("type").setDescription("Card type/tag — blank uses the Vault category").setAutocomplete(true))
      .addStringOption(o => o.setName("set").setDescription("Optional set to add this card to immediately").setAutocomplete(true))
      .addStringOption(o => o.setName("description").setDescription("Override the card description (up to 500 chars)").setMaxLength(500))
      .addBooleanOption(o => o.setName("limited").setDescription("Limited edition — capped copy count?"))
      .addIntegerOption(o => o.setName("max_copies").setDescription("Max copies if limited (default 50)").setMinValue(1))
      .addBooleanOption(o => o.setName("event_exclusive").setDescription("Event exclusive — never spawns randomly?"))),

    adminCmd("createcardsfrommttv", "Batch-create cards from Vault Values — pick a website rarity, tag 5, preview, create", s => s
      .addStringOption(o => o.setName("rarity").setDescription("DN rarity for new cards — default auto from each item's Vault rarity").setAutocomplete(true))
      .addStringOption(o => o.setName("set").setDescription("Optional set to add every created card to").setAutocomplete(true))),

    adminCmd("createcardfromroblox", "Create a card from a Roblox username or a Bloxlink role", s => s
      .addStringOption(o => o.setName("username").setDescription("Roblox username — type to search").setRequired(false).setAutocomplete(true))
      .addRoleOption(o => o.setName("role").setDescription("Discord role — nicknames stay ready as Roblox searches until you pick someone").setRequired(false))
      .addStringOption(o => o.setName("rarity").setDescription("DN rarity — type to search").setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName("type").setDescription("Card type/tag — blank uses roblox").setAutocomplete(true))
      .addAttachmentOption(o => o.setName("image").setDescription("Upload an image (overrides the Roblox full-body avatar)"))
      .addStringOption(o => o.setName("set").setDescription("Optional set to add this card to immediately").setAutocomplete(true))
      .addStringOption(o => o.setName("description").setDescription("Override the card description (up to 500 chars)").setMaxLength(500))
      .addBooleanOption(o => o.setName("limited").setDescription("Limited edition — capped copy count?"))
      .addIntegerOption(o => o.setName("max_copies").setDescription("Max copies if limited (default 50)").setMinValue(1))
      .addBooleanOption(o => o.setName("event_exclusive").setDescription("Event exclusive — never spawns randomly?"))),

    adminCmd("editimage", "Update a card's image from Vault Values or an uploaded file", s => s
      .addStringOption(o => o.setName("name").setDescription("Card to edit").setRequired(true).setAutocomplete(true))
      .addAttachmentOption(o => o.setName("image").setDescription("Upload image/GIF (overrides the Vault Values search)"))),

    adminCmd("progression", "Arrival Star/Level hub — see what spawn, pack, and drop grant, and override cards", s => s),

    adminCmd("battleforceend", "Force-cancel a member's stuck battle (e.g. the battle message got deleted)", s => s
      .addUserOption(o => o.setName("user").setDescription("Member whose battle should be cancelled").setRequired(true))),

    adminCmd("collectorrole", "Set the wishlist ping role — pinged when a wishlisted card spawns", s => s
      .addRoleOption(o => o.setName("role").setDescription("Role to ping (leave empty to clear)"))),

    // ── /mass_role (admin, bulk role assignment) ──────────────────────────────
    adminCmd("massrole", "Give or remove a role from everyone who has a specific role", s => s
      .addSubcommand(sc => sc
        .setName("give")
        .setDescription("Give a role to all members who have a specific role")
        .addRoleOption(o => o.setName("role").setDescription("The role to give").setRequired(true))
        .addRoleOption(o => o.setName("target_role").setDescription("Only affect members who have this role").setRequired(true)))
      .addSubcommand(sc => sc
        .setName("remove")
        .setDescription("Remove a role from all members who have a specific role")
        .addRoleOption(o => o.setName("role").setDescription("The role to remove").setRequired(true))
        .addRoleOption(o => o.setName("target_role").setDescription("Only affect members who have this role").setRequired(true)))),

    // ── Card Events (limited-time spawn boosts) ──────────────────────────────
    adminCmd("event", "Run limited-time card events — boost a card's spawn rate", s => s
      .addSubcommand(sc => sc.setName("start").setDescription("Start a limited-time card event")
        .addStringOption(o => o.setName("card").setDescription("Card to boost").setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName("duration").setDescription("How long (e.g. 30m, 2h, 1d — max 14d)").setRequired(true))
        .addNumberOption(o => o.setName("multiplier").setDescription("Weight multiplier (1.1–50, default 2)").setMinValue(1.1).setMaxValue(50)))
      .addSubcommand(sc => sc.setName("list").setDescription("Show active card events in this server"))
      .addSubcommand(sc => sc.setName("stop").setDescription("Stop an active event early")
        .addIntegerOption(o => o.setName("id").setDescription("Event ID from /event list").setRequired(true).setMinValue(1)))),

    // ── /rarity — hub command: display names, economy overrides, custom tiers, card assignments
    adminCmd("rarity", "Edit built-in rarity names, colors, spawn %, worth, and burn", s => s),

    // ── /embed — owns ALL writes to embed_overrides. Replaces the old
    //              /admin/embeds dashboard page.
    adminCmd("embed", "Customize bot embeds — title, footer, color, image, etc.", s => s
      .addSubcommand(sc => sc.setName("designer").setDescription("Visual embed designer with live preview and buttons")
        .addAttachmentOption(o => o.setName("image").setDescription("Quick-upload a canvas/trophy background image")))
      .addSubcommand(sc => sc.setName("show").setDescription("Show current overrides for one embed")
        .addStringOption(o => o.setName("key").setDescription("Which embed").setRequired(true)
          .addChoices(
            { name: "spawn",    value: "spawn"    },
            { name: "claimed",  value: "claimed"  },
            { name: "daily",    value: "daily"    },
            { name: "pack",     value: "pack"     },
            { name: "trade",    value: "trade"    },
            { name: "welcome",  value: "welcome"  },
            { name: "rules",    value: "rules"    },
            { name: "commands", value: "commands" },
            { name: "help",     value: "help"     },
          )))
      .addSubcommand(sc => sc.setName("set").setDescription("Set one field on an embed override")
        .addStringOption(o => o.setName("key").setDescription("Which embed").setRequired(true)
          .addChoices(
            { name: "spawn",    value: "spawn"    },
            { name: "claimed",  value: "claimed"  },
            { name: "daily",    value: "daily"    },
            { name: "pack",     value: "pack"     },
            { name: "trade",    value: "trade"    },
            { name: "welcome",  value: "welcome"  },
            { name: "rules",    value: "rules"    },
            { name: "commands", value: "commands" },
            { name: "help",     value: "help"     },
          ))
        .addStringOption(o => o.setName("field").setDescription("Which field to set").setRequired(true)
          .addChoices(
            { name: "enabled",                 value: "enabled" },
            { name: "title",                   value: "title" },
            { name: "footer",                  value: "footer" },
            { name: "descriptionPrefix",       value: "descriptionPrefix" },
            { name: "color (hex)",             value: "color" },
            { name: "customImageUrl",          value: "customImageUrl" },
            { name: "imageMode",               value: "imageMode" },
            { name: "showWorth",               value: "showWorth" },
            { name: "showDropChance",          value: "showDropChance" },
            { name: "rarityColor: common",     value: "rarityColor.common" },
            { name: "rarityColor: uncommon",   value: "rarityColor.uncommon" },
            { name: "rarityColor: rare",       value: "rarityColor.rare" },
            { name: "rarityColor: epic",       value: "rarityColor.epic" },
            { name: "rarityColor: legendary",  value: "rarityColor.legendary" },
            { name: "rarityColor: mythic",     value: "rarityColor.mythic" },
          ))
        .addStringOption(o => o.setName("value").setDescription("Value — hex for colors, true/false for toggles, text for title/footer (empty clears)").setRequired(true).setMaxLength(1000)))
      .addSubcommand(sc => sc.setName("reset").setDescription("Reset one field (or the whole embed if no field given)")
        .addStringOption(o => o.setName("key").setDescription("Which embed").setRequired(true)
          .addChoices(
            { name: "spawn",    value: "spawn"    },
            { name: "claimed",  value: "claimed"  },
            { name: "daily",    value: "daily"    },
            { name: "pack",     value: "pack"     },
            { name: "trade",    value: "trade"    },
            { name: "welcome",  value: "welcome"  },
            { name: "rules",    value: "rules"    },
            { name: "commands", value: "commands" },
            { name: "help",     value: "help"     },
          ))
        .addStringOption(o => o.setName("field").setDescription("Specific field to reset — omit to wipe the whole override")
          .addChoices(
            { name: "enabled",                 value: "enabled" },
            { name: "title",                   value: "title" },
            { name: "footer",                  value: "footer" },
            { name: "descriptionPrefix",       value: "descriptionPrefix" },
            { name: "color",                   value: "color" },
            { name: "customImageUrl",          value: "customImageUrl" },
            { name: "imageMode",               value: "imageMode" },
            { name: "showWorth",               value: "showWorth" },
            { name: "showDropChance",          value: "showDropChance" },
            { name: "rarityColor: common",     value: "rarityColor.common" },
            { name: "rarityColor: uncommon",   value: "rarityColor.uncommon" },
            { name: "rarityColor: rare",       value: "rarityColor.rare" },
            { name: "rarityColor: epic",       value: "rarityColor.epic" },
            { name: "rarityColor: legendary",  value: "rarityColor.legendary" },
            { name: "rarityColor: mythic",     value: "rarityColor.mythic" },
          )))),

    // ── Dashboard ──────��──────────────────────────────────────────────────[...]
    adminCmd("dashboard", "Get a one-time link to set up or reset your web dashboard login", s => s),

    adminCmd("editpack", "Edit a custom pack — rename, change cost/size, add/remove cards, set emoji", s => s
      .addStringOption(o => o.setName("pack").setDescription("Pack to edit — type to search").setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName("new_name").setDescription("Rename the pack").setMaxLength(50))
      .addIntegerOption(o => o.setName("cost").setDescription("Cost in 💠 shards").setMinValue(0))
      .addIntegerOption(o => o.setName("size").setDescription("Cards per open (1–10)").setMinValue(1).setMaxValue(10))
      .addIntegerOption(o => o.setName("weekly_limit").setDescription("Weekly limit (0 = unlimited)").setMinValue(0))
      .addStringOption(o => o.setName("description").setDescription("Pack description shown when opened").setMaxLength(100))
      .addStringOption(o => o.setName("emoji").setDescription("Pack emoji (single Unicode or <:name:id>)").setMaxLength(80))
      .addBooleanOption(o => o.setName("active").setDescription("Enable or disable the pack"))
      .addStringOption(o => o.setName("add_card").setDescription("Add one card to the pack").setAutocomplete(true))
      .addStringOption(o => o.setName("remove_card").setDescription("Remove one card from the pack").setAutocomplete(true))
      .addStringOption(o => o.setName("add_rarity").setDescription("Add ALL cards of this rarity to the pack")
        .addChoices({ name: "Common", value: "common" }, { name: "Uncommon", value: "uncommon" }, { name: "Rare", value: "rare" }, { name: "Epic", value: "epic" }, { name: "Legendary", value: "legendary" }, { name: "Limited Edition", value: "mythic" }))
      .addStringOption(o => o.setName("remove_rarity").setDescription("Remove ALL cards of this rarity from the pack")
        .addChoices({ name: "Common", value: "common" }, { name: "Uncommon", value: "uncommon" }, { name: "Rare", value: "rare" }, { name: "Epic", value: "epic" }, { name: "Legendary", value: "legendary" }, { name: "Limited Edition", value: "mythic" }))),

    // ── /rep (user, reputation system) ────────────────────────────────────────
    cmd("rep", "Reputation system — give rep, check rep, remove rep, and see the leaderboard", s => s
      .addSubcommand(sc => sc.setName("give").setDescription("Give +1 rep to another member (24h cooldown per person)")
        .addUserOption(o => o.setName("user").setDescription("Member to rep").setRequired(true)))
      .addSubcommand(sc => sc.setName("check").setDescription("Check a member's rep score")
        .addUserOption(o => o.setName("user").setDescription("Member to check (default: you)")))
      .addSubcommand(sc => sc.setName("top").setDescription("Top 10 most reputed members on this server"))
      .addSubcommand(sc => sc.setName("remove").setDescription("(Admin) Remove rep from a member")
        .addUserOption(o => o.setName("user").setDescription("Member to remove rep from").setRequired(true))
        .addIntegerOption(o => o.setName("amount").setDescription("Amount of rep to remove (default: 1)").setMinValue(1))
        .addStringOption(o => o.setName("reason").setDescription("Optional reason for removal")))),

    // ── /thanks (user, gratitude tracking) ────────���───────────────────────────
    cmd("thanks", "Thank members for being helpful — track appreciation", s => s
      .addSubcommand(sc => sc.setName("give").setDescription("Give thanks to a helpful member (24h cooldown per person)")
        .addUserOption(o => o.setName("user").setDescription("Member to thank").setRequired(true)))
      .addSubcommand(sc => sc.setName("top").setDescription("Top 10 most appreciated members on this server"))),
    buildVaultValueCommandJson(),


    // /postboard is registered via buildPostboardCommandJson() alongside /emoji.

    // ── /battle (user, Card Battle System) ────────────────────────────────────
    cmd("battle", "Card battles — fight, raids, sieges, stats & leaderboards", s => s
      .addSubcommand(sc => sc.setName("fight").setDescription("Start a battle — challenge a player, or leave empty to fight the AI")
        .addUserOption(o => o.setName("opponent").setDescription("Player to challenge (empty = battle the AI)")))
      .addSubcommand(sc => sc.setName("raid").setDescription("Start a co-op boss raid (same flow as /raid)")
        .addStringOption(o => o.setName("boss").setDescription("Boss to raid (omit to open the campaign map)").setAutocomplete(true)))
      .addSubcommand(sc => sc.setName("siege").setDescription("Lay siege to a player base or world territory — turn-for-turn castle battle")
        .addUserOption(o => o.setName("target").setDescription("Player whose base to siege (omit to pick from the map)")))
      .addSubcommand(sc => sc.setName("profile").setDescription("View a battle profile — record, rank, stats")
        .addUserOption(o => o.setName("user").setDescription("Whose profile to view (default: you)")))
      .addSubcommand(sc => sc.setName("leaderboard").setDescription("Battle rankings")
        .addStringOption(o => o.setName("scope").setDescription("Guild or global").addChoices(
          { name: "This server", value: "guild" }, { name: "Global (opt-in)", value: "global" }))
        .addStringOption(o => o.setName("sort").setDescription("Sort by").addChoices(
          { name: "Rank points", value: "rank" }, { name: "Wins", value: "wins" }, { name: "Best streak", value: "streak" })))
      .addSubcommand(sc => sc.setName("achievements").setDescription("View unlocked battle achievements")
        .addUserOption(o => o.setName("user").setDescription("Whose achievements to view (default: you)")))
      .addSubcommand(sc => sc.setName("daily").setDescription("View today's battle challenges and progress"))
      .addSubcommand(sc => sc.setName("phaser").setDescription("Battle Phaser — a live Yu-Gi-Oh style duel & open world (Discord Activity)"))),

    // ── /battle_admin (admin, Battle System configuration) ─────────────────────
    adminCmd("battleadmin", "Battle system hub — setup wizard, rules, rewards, cards, seasons", s => s
      .addAttachmentOption(o => o.setName("image").setDescription("Quick-upload a battle arena background (fills the next empty slot)"))),

    // ── /squad (user, Squads / guilds) ────────────────────────────────────────
    cmd("squad", "Team up — create or join a squad and climb the squad leaderboard", s => s
      .addSubcommand(sc => sc.setName("create").setDescription("Found a new squad (you become leader)")
        .addStringOption(o => o.setName("name").setDescription("Squad name").setRequired(true))
        .addStringOption(o => o.setName("tag").setDescription("Short tag shown by members, e.g. WLF (max 6)"))
        .addStringOption(o => o.setName("description").setDescription("Squad description")))
      .addSubcommand(sc => sc.setName("join").setDescription("Join a squad")
        .addStringOption(o => o.setName("name").setDescription("Squad to join").setRequired(true).setAutocomplete(true)))
      .addSubcommand(sc => sc.setName("leave").setDescription("Leave your squad"))
      .addSubcommand(sc => sc.setName("disband").setDescription("Disband your squad (leader only)"))
      .addSubcommand(sc => sc.setName("info").setDescription("View a squad's combined stats and roster")
        .addStringOption(o => o.setName("name").setDescription("Squad (default: yours)").setAutocomplete(true)))
      .addSubcommand(sc => sc.setName("list").setDescription("Squad leaderboard for this server"))),

    // ── /raid (user, Co-op Boss Raids) ────────────────────────────────────────
    cmd("raid", "Team up to take down a boss — co-op raid", s => s
      .addSubcommand(sc => sc.setName("start").setDescription("Start a raid lobby for a boss")
        .addStringOption(o => o.setName("boss").setDescription("Which boss to raid").setRequired(true).setAutocomplete(true)))
      .addSubcommand(sc => sc.setName("bosses").setDescription("List the raid bosses available on this server"))),

    // ── /raid_admin (admin, Boss management) ───────────────────────────────────
    adminCmd("raidadmin", "Create and tune co-op raid bosses", s => s
      .addSubcommand(sc => sc.setName("create").setDescription("Create a new raid boss")
        .addStringOption(o => o.setName("name").setDescription("Boss name").setRequired(true))
        .addStringOption(o => o.setName("description").setDescription("Flavor text"))
        .addAttachmentOption(o => o.setName("image").setDescription("Upload boss image/GIF with Discord's file picker"))
        .addAttachmentOption(o => o.setName("battlefield").setDescription("Optional arena/battlefield background for the raid canvas"))
        .addStringOption(o => o.setName("archetype").setDescription("Combat archetype (default boss)"))
        .addStringOption(o => o.setName("rarity").setDescription("Reference rarity (default mythic)"))
        .addIntegerOption(o => o.setName("health").setDescription("Base health (per-player oriented)").setMinValue(100))
        .addIntegerOption(o => o.setName("attack").setDescription("Base attack").setMinValue(1))
        .addIntegerOption(o => o.setName("defense").setDescription("Base defense").setMinValue(0))
        .addIntegerOption(o => o.setName("minstars").setDescription("Min card stars to join (1-5)").setMinValue(1).setMaxValue(5))
        .addIntegerOption(o => o.setName("minlevel").setDescription("Min battle level to join").setMinValue(1))
        .addIntegerOption(o => o.setName("minplayers").setDescription("Min players").setMinValue(1).setMaxValue(10))
        .addIntegerOption(o => o.setName("maxplayers").setDescription("Max players").setMinValue(1).setMaxValue(10))
        .addIntegerOption(o => o.setName("enrage").setDescription("Boss enrages after N rounds (0 = never)").setMinValue(0))
        .addIntegerOption(o => o.setName("healthscaling").setDescription("Health scaling percent per extra party power (default 100)").setMinValue(0))
        .addIntegerOption(o => o.setName("reward").setDescription("Shards per survivor on clear").setMinValue(0))
        .addIntegerOption(o => o.setName("cardxp").setDescription("Bonus card XP per survivor on clear").setMinValue(0))
        .addStringOption(o => o.setName("cardname").setDescription("The card this boss IS — granted to winners who pick the boss-card reward"))
        .addStringOption(o => o.setName("frame").setDescription("Exclusive frame winners unlock (account-wide)").addChoices(...RAID_FRAME_CHOICES))
        .addIntegerOption(o => o.setName("sequence").setDescription("Ladder order: 0 = first boss, higher = later/final").setMinValue(0)))
      .addSubcommand(sc => sc.setName("edit").setDescription("Edit an existing boss")
        .addStringOption(o => o.setName("name").setDescription("Boss to edit").setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName("description").setDescription("Flavor text"))
        .addAttachmentOption(o => o.setName("image").setDescription("Optional replacement image/GIF upload"))
        .addAttachmentOption(o => o.setName("battlefield").setDescription("Optional arena/battlefield background for the raid canvas"))
        .addStringOption(o => o.setName("archetype").setDescription("Combat archetype"))
        .addIntegerOption(o => o.setName("health").setDescription("Base health").setMinValue(100))
        .addIntegerOption(o => o.setName("attack").setDescription("Base attack").setMinValue(1))
        .addIntegerOption(o => o.setName("defense").setDescription("Base defense").setMinValue(0))
        .addIntegerOption(o => o.setName("minstars").setDescription("Min card stars (1-5)").setMinValue(1).setMaxValue(5))
        .addIntegerOption(o => o.setName("minlevel").setDescription("Min battle level").setMinValue(1))
        .addIntegerOption(o => o.setName("minplayers").setDescription("Min players").setMinValue(1).setMaxValue(10))
        .addIntegerOption(o => o.setName("maxplayers").setDescription("Max players").setMinValue(1).setMaxValue(10))
        .addIntegerOption(o => o.setName("enrage").setDescription("Enrage round (0 = never)").setMinValue(0))
        .addIntegerOption(o => o.setName("healthscaling").setDescription("Health scaling percent per extra party power").setMinValue(0))
        .addIntegerOption(o => o.setName("reward").setDescription("Shards per survivor").setMinValue(0))
        .addIntegerOption(o => o.setName("cardxp").setDescription("Bonus card XP per survivor").setMinValue(0))
        .addStringOption(o => o.setName("cardname").setDescription("The card this boss IS — the boss-card reward"))
        .addStringOption(o => o.setName("frame").setDescription("Exclusive frame winners unlock (account-wide)").addChoices(...RAID_FRAME_CHOICES))
        .addIntegerOption(o => o.setName("sequence").setDescription("Ladder order: 0 = first boss, higher = later/final").setMinValue(0)))
      .addSubcommand(sc => sc.setName("list").setDescription("List all raid bosses on this server"))
      .addSubcommand(sc => sc.setName("enable").setDescription("Enable or disable a boss")
        .addStringOption(o => o.setName("name").setDescription("Boss").setRequired(true).setAutocomplete(true))
        .addBooleanOption(o => o.setName("enabled").setDescription("Enabled?").setRequired(true)))
      .addSubcommand(sc => sc.setName("delete").setDescription("Delete a boss")
        .addStringOption(o => o.setName("name").setDescription("Boss to delete").setRequired(true).setAutocomplete(true)))
      .addSubcommand(sc => sc.setName("bosscardtrades").setDescription("Allow or block trading boss cards on this server")
        .addBooleanOption(o => o.setName("enabled").setDescription("Allow trading boss cards?").setRequired(true)))),

    // ── /giveaway (giveaway hub — browse, enter progress, and admin tools) ─────
    cmd("giveaway", "Open the Giveaway Hub — browse active giveaways and manage them (admins)", s => s),

    // ── /market (user, Marketplace) ───────────────────────────────────────────
    cmd("market", "Buy, sell, and auction cards for DN Shards", s => s
      .addSubcommand(sc => sc.setName("sell").setDescription("List a card for sale, or as a timed auction")
        .addStringOption(o => o.setName("name").setDescription("Card to sell").setRequired(true).setAutocomplete(true))
        .addIntegerOption(o => o.setName("price").setDescription("Sale price, or auction starting bid").setRequired(true).setMinValue(1))
        .addIntegerOption(o => o.setName("hours").setDescription("Auction length in hours (omit for a fixed-price sale)").setMinValue(1).setMaxValue(168))
        .addIntegerOption(o => o.setName("buyout").setDescription("Optional instant-buy price for an auction").setMinValue(1)))
      .addSubcommand(sc => sc.setName("browse").setDescription("Browse active market listings")
        .addUserOption(o => o.setName("seller").setDescription("Only show a specific seller's listings"))
        .addStringOption(o => o.setName("kind").setDescription("Filter by type")
          .addChoices({ name: "For sale", value: "sale" }, { name: "Auctions", value: "auction" })))
      .addSubcommand(sc => sc.setName("buy").setDescription("Buy a fixed-price listing (or auction buyout)")
        .addIntegerOption(o => o.setName("id").setDescription("Listing ID").setRequired(true).setMinValue(1)))
      .addSubcommand(sc => sc.setName("bid").setDescription("Bid on an auction")
        .addIntegerOption(o => o.setName("id").setDescription("Listing ID").setRequired(true).setMinValue(1))
        .addIntegerOption(o => o.setName("amount").setDescription("Your bid in shards").setRequired(true).setMinValue(1)))
      .addSubcommand(sc => sc.setName("cancel").setDescription("Cancel one of your listings")
        .addIntegerOption(o => o.setName("id").setDescription("Listing ID").setRequired(true).setMinValue(1)))
      .addSubcommand(sc => sc.setName("mine").setDescription("View your listings and active bids"))),

    // ── Echo-Whisper (encrypted messaging addon) ──────────────────────────────
    buildSecretCommandJson(),

    adminCmd("echo", "Echo-Whisper hub — viewer roles, admin override, stats, config", s => s
      .addSubcommand(sc => sc.setName("role").setDescription("Manage roles allowed to reveal /secret staff messages")
        .addStringOption(o => o.setName("action").setDescription("Add, remove, or list").setRequired(true)
          .addChoices({ name: "add", value: "add" }, { name: "remove", value: "remove" }, { name: "list", value: "list" }))
        .addRoleOption(o => o.setName("role").setDescription("Role to add or remove")))
      .addSubcommand(sc => sc.setName("override").setDescription("Toggle whether admins can decrypt any message")
        .addStringOption(o => o.setName("mode").setDescription("Enable or disable admin override").setRequired(true)
          .addChoices({ name: "enable", value: "enable" }, { name: "disable", value: "disable" })))
      .addSubcommand(sc => sc.setName("whisper").setDescription("View whisper configuration"))
      .addSubcommand(sc => sc.setName("adminsecret").setDescription("View staff-secret configuration"))
      .addSubcommand(sc => sc.setName("stats").setDescription("View Echo-Whisper usage stats"))
      .addSubcommand(sc => sc.setName("config").setDescription("View Echo-Whisper configuration"))),

  ];
}


type CommandJson = ReturnType<SlashCommandBuilder["toJSON"]> & { type?: number };

// ── Clean public command names ───────────────────────────────────────────────
// Maps a command's INTERNAL name (what handlers switch on) to the clean,
// underscore-separated name shown to users. Only the REGISTERED name changes;
// every handler, dispatch set, and button customId keeps its internal name.
// index.ts translates an incoming interaction name back to internal via
// internalCommandName() before routing. Rule: split concatenated words with `_`
// (e.g. packstats → pack_stats, battleadmin → battle_admin), which also keeps
// the distinguishing suffix that separates admin variants from user commands
// (e.g. /battle vs /battle_admin).
export const COMMAND_RENAMES: Record<string, string> = {
  packstats: "pack_stats",
  tradehistory: "trade_history",
  tradein: "card_recycle",
  adminsecret: "admin_secret",
  afksetup: "afk_setup",
  quietsetup: "quiet_setup",
  collectorrole: "wishlist_role",
  addcard: "add_card",
  createcardfrommttv: "create_card_from_mttv",
  createcardsfrommttv: "create_cards_from_mttv",
  createcardfromroblox: "create_card_from_roblox",
  createcardfrom: "create_card_from",
  editcard: "edit_card",
  editimage: "edit_image",
  deletecard: "delete_card",
  giveshards: "give_shards",
  takeshards: "take_shards",
  takeback: "take_back",
  battleforceend: "battle_force_end",
  massdrop: "mass_drop",
  deleteallcards: "delete_all_cards",
  giveall: "give_all",
  edituser: "edit_user",
  adminhub: "admin_hub",
  user_hub: "user-hub",
  show_shiny: "show-shiny",
  collection_hub: "collection-hub",
  adminhelp: "admin_help",
  welcomeadmin: "welcome_admin",
  battleadmin: "battle_admin",
  raidadmin: "raid_admin",
  giveawayadmin: "giveaway_admin",
  massrole: "mass_role",
  sethub: "set_hub",
  info_mttv: "vaultvalue_info",
  calc: "vaultvalue_calc",
  valuehelp: "vaultvalue_help",
  valuelist: "vaultvalue_list",
  postcalculator: "vaultvalue_postcalc",
};

const INTERNAL_BY_CLEAN: Record<string, string> =
  Object.fromEntries(Object.entries(COMMAND_RENAMES).map(([internal, clean]) => [clean, internal]));

// Public (registered) name for an internal command name.
export function publicCommandName(internal: string): string {
  return COMMAND_RENAMES[internal] ?? internal;
}

// Internal handler name for a registered/public command name (inverse).
export function internalCommandName(clean: string): string {
  return INTERNAL_BY_CLEAN[clean] ?? clean;
}

// ── Hub-consolidated commands (deregistered from Discord, handlers kept) ──────
// These player commands are fully covered by an existing, proven Hub surface, so
// they are no longer REGISTERED as standalone slash commands (this keeps us well
// under Discord's 100-command cap). Their handlers, dispatch cases, and button
// routes are all UNCHANGED — every feature is still reachable, just through the
// Hub instead of a duplicate slash command. Remove a name here to re-register it.
//
// Parity map (feature → where it now lives):
//   collection    → /user-hub · Collection
//   daily         → /user-hub · Daily (claim button)
//   calendar      → /user-hub · Calendar
//   frame         → /user-hub · Frames
//   rank          → /user-hub · Progression / Collector Profile
//   top           → /user-hub · Collector Profile (leaderboard)
//   achievements  → /user-hub · Collector Profile (achievements)
//   market        → /user-hub · 🏪 Market button (full market-hub)
//   squad         → /user-hub · 🤝 Squad button (full squad-hub)
export const HUB_REPLACED_COMMANDS = new Set<string>([
  // Player commands with full User-Hub parity.
  // NOTE: `/top` was restored as a standalone command by request — the collector
  // leaderboard is ALSO available in /user-hub → Collector Profile.
  "collection", "daily", "calendar", "frame", "rank", "achievements",
  "market", "squad",
  // Now added as interactive User-Hub sections (Quests / Wishlist / Reputation / Search).
  "quests", "wishlist", "rep", "search", "collector", "funfact",
  // Folded into /casino (Discord 100 slash-command ceiling — was 101 before this hub).
  "cashcheck", "cashgames", "cashstore",
  "roulette", "blackjack", "higherlower", "redblack", "slots",
  "cashwork", "cashcrime", "russian", "rob", "slut",
  // Folded into /trade hub (propose / pending / history / accept / decline / gift).
  "gift", "trades", "tradehistory", "accept", "decline",
  // Folded into /vaultvalue hub (info / calc / list / help / postcalc).
  "info_mttv", "calc", "valuehelp", "valuelist", "postcalculator",
  // Restored as their own slashes (autocomplete): give, take, shards, give-all,
  // edit, delete, library, edit-user. /cardadmin is no longer registered.
  // Kitsu create stays retired.
  "createcardfrom",
  // Folded into /secret hub (whisper / staff). /echo stays as config.
  "whisper", "adminsecret",
  // Sanctuary entry aliases — use /quiet mode:vacation|loa (handlers kept).
  "vacation", "loa",
  // Docs folded into /help sections (handlers kept for legacy/prefix).
  "adminhelp", "battles_welcome", "welcomeadmin",
]);

export function buildCommands() {
  // Every command is registered standalone — no /cards or /admin wrapper — and
  // renamed to its clean public form.
  const legacy = buildLegacyCommands() as CommandJson[];
  const all = [
    ...legacy,
    // ── AFK Secretary & Whitelist Access System (standalone top-level cmds) ──
    buildAfkCommandJson() as CommandJson,
    buildAfkSetupCommandJson() as CommandJson,
    // ── Quiet Mode / Quiet Room (addon) ──────────────────────────────────────
    buildQuietCommandJson() as CommandJson,
    buildVacationCommandJson() as CommandJson,
    buildLoaCommandJson() as CommandJson,
    buildQuietSetupCommandJson() as CommandJson,
  ]
    // Drop Hub-consolidated duplicates from the registered set (handlers stay).
    .filter((c) => !HUB_REPLACED_COMMANDS.has(c.name));
  for (const c of all) c.name = publicCommandName(c.name);
  return all;
}

// Commands are FLAT top-level slash commands — e.g. `/burn`, `/pack`, `/user-hub`
// — rather than being nested under `/cards …` / `/admin …` hubs. These two sets
// name the flattened commands so the interaction dispatcher (index.ts) knows
// whether each one is handled by handleUserCommand or handleAdminCommand. The
// category grouping players see instead lives in the interactive `/help` hub.
//
// NOTE: these sets use the INTERNAL handler names (the string each handler
// switches on). The name a user actually sees can differ — see COMMAND_RENAMES.
export const USER_HUB_COMMANDS = new Set([
  "collection", "rank", "info", "list", "catalog", "top", "burn", "shards",
  "trade", "gift", "trades", "tradehistory", "accept", "decline", "welcome",
  "battles_welcome",
  "help", "user_hub", "daily", "quests", "pack", "packstats", "tradein", "achievements",
  "level", "frame", "lock", "search", "collector", "calendar", "wishlist",
  "rep", "thanks", "calc", "valuehelp", "valuelist", "info_mttv",
]);

export const ADMIN_HUB_COMMANDS = new Set([
  "setup", "config", "minigames", "adminhub", "sethub", "set_admin", "deletecard", "deleteallcards",
  "welcomeadmin", "adminhelp", "drop", "massdrop", "give", "giveshards",
  "takeback", "takeshards", "addcard", "createcardfrommttv", "createcardsfrommttv", "createcardfromroblox", "createcardfrom", "library", "editcard", "editimage", "dashboard", "collectorrole",
  "battleforceend",
  "rarity", "embed", "event", "edituser", "giveall", "editpack",
  "postcalculator", "postboard", "massrole",
  "progression",
]);
