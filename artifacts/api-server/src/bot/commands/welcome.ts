import type { ChatInputCommandInteraction } from "discord.js";
import { EmbedBuilder, MessageFlags, AttachmentBuilder } from "discord.js";
import { applyEmbedOverride } from "../embed-overrides.js";
import { getOrCreateGuildSettings, isAdmin } from "../db.js";
import { getShinyName } from "../cards-data.js";
import { BRAND_NAME, brandAsset, BRAND_BANNER_FILE, BRAND_LOGO_FILE } from "../help-banners.js";
import { publicBaseUrl } from "../../lib/runtime-env.js";

// Thin animated divider GIF used as the separator image at the bottom of each
// embed. The rainbow-glow line (4 KB, GitHub user-images CDN) renders as a
// full-width animated stripe between embeds in Discord.
const DIVIDER_GIF =
  "https://user-images.githubusercontent.com/73097560/115834477-dbab4500-a447-11eb-908a-139a6edaec5c.gif";

const BRAND_COLOR  = 0xe63946;   // DarkNight red
const ADMIN_COLOR  = 0xeb459e;   // pink for admin embeds

const SITE_URL  = "https://dncards.com";
const SITE_ADMIN = `${SITE_URL}/admin`;

// ── Helper — is this member a guild admin? ───────────────────────────────────
// Server owner, anyone with Discord's Administrator permission, or a bot-DB
// admin. Used to gate BOTH /welcome (it posts a public, server-wide message, so
// only staff should trigger it) and the /welcome_admin guide.
export async function isGuildAdmin(interaction: ChatInputCommandInteraction): Promise<boolean> {
  if (!interaction.guild) return false;
  if (interaction.guild.ownerId === interaction.user.id) return true;
  const member = interaction.member;
  const hasAdminPerm =
    !!member &&
    "permissions" in member &&
    typeof (member as { permissions?: unknown }).permissions === "object" &&
    (member as { permissions: { has: (p: string) => boolean } }).permissions.has("Administrator");
  if (hasAdminPerm) return true;
  return isAdmin(interaction.guild.id, interaction.user.id);
}

// ── Helper — build the hosted admin-dashboard URL ────────────────────────────
function dashboardAdminUrl(): string {
  // Dashboard is served at /dashboard (Activity owns the root for Discord).
  return `${publicBaseUrl(SITE_URL)}/dashboard/admin`;
}

// ─────────────────────────────────────────────────────────────────────────────
// /welcome — public, member-facing. Drops in #welcome or #info channels.
// Small, spaced-out sections — Welcome · Rules · Good to Know · Dive In — each
// separated by the animated GIF banner. Kept short on purpose: the full command
// reference lives in the interactive `/help` hub. Each section stays editable
// via `/embed` (keys: welcome · rules · commands).
// NOT in EPHEMERAL_COMMANDS — visible to everyone.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleWelcome(interaction: ChatInputCommandInteraction): Promise<void> {
  const shinySettings = interaction.guildId ? await getOrCreateGuildSettings(interaction.guildId) : null;
  const shinyName = getShinyName(shinySettings);
  const guildId   = interaction.guildId;
  const guildName = interaction.guild?.name ?? "this server";

  // Brand art: the Dex N Cards banner as the hero image, the circle logo as the
  // thumbnail. Attached once to this message; both fall back gracefully.
  const files: AttachmentBuilder[] = [];
  const bannerBuf = brandAsset(BRAND_BANNER_FILE);
  const logoBuf = brandAsset(BRAND_LOGO_FILE);
  if (bannerBuf) files.push(new AttachmentBuilder(bannerBuf, { name: BRAND_BANNER_FILE }));
  if (logoBuf) files.push(new AttachmentBuilder(logoBuf, { name: BRAND_LOGO_FILE }));
  const heroImage = bannerBuf ? `attachment://${BRAND_BANNER_FILE}` : DIVIDER_GIF;

  // ── 1 · Welcome ─────────────────────────────────────────────────────────────
  const welcome = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle(`🃏 Welcome to ${BRAND_NAME}`)
    .setDescription(
      `Welcome to **${guildName}** — DarkNight's military collectible card game. Tanks, jets, warships, bosses, and the odd cursed community card drop right here in chat.\n\n` +
      "**When a card spawns, just type its name to catch it.** That's the core loop — then hoard, battle, trade, and climb the leaderboard.",
    )
    .setImage(heroImage);
  if (logoBuf) welcome.setThumbnail(`attachment://${BRAND_LOGO_FILE}`);

  await applyEmbedOverride(welcome, {
    guildId, key: "welcome", defaultImageUrl: heroImage,
    ctx: { guild: guildName, username: interaction.user.username, userId: interaction.user.id },
  });

  // ── 2 · Rules & Fair Play ───────────────────────────────────────────────────
  const rules = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle("📜 Rules & Fair Play")
    .setDescription(
      "• **Be cool** — follow the server rules and keep chat friendly.\n" +
      "• **No cheating** — macros, self-bots, or auto-typers to snipe catches are bannable.\n" +
      "• **Fair catches** — ties break by Discord's own message timestamp, not bot speed. Got the 🎯 but lost? Someone genuinely typed it first — no bugs, no favouritism.\n" +
      "• **Trade honestly** — deals over 3:1 in value show a ⚠️ warning; it's a heads-up, not a block.",
    )
    .setImage(DIVIDER_GIF);

  await applyEmbedOverride(rules, {
    guildId, key: "rules", defaultImageUrl: DIVIDER_GIF, ctx: { guild: guildName },
  });

  // ── 3 · Things You Should Know ───────────────────────────────────────────────
  const info = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle("💡 Things You Should Know")
    .addFields(
      { name: "🎯 Catching", value: "Type the card's name in chat to catch it — spelling matters, caps don't. A 🎯 means you're in the pool; cards stay up 60–120s, so there's no need to race milliseconds." },
      { name: "💠 Shards, Packs & Shiny", value: `Earn 💠 shards from \`/daily\`, burning duplicates, quests & achievements, then open \`/pack tier:<basic|premium|legendary>\`. Every catch and pull has a **0.5%** chance to mint a rare **${shinyName}** — worth more and tracked separately.` },
      { name: "⭐ Star Rank", value: "Duplicates aren't waste — `/card_recycle name:<card>` turns spare copies into a permanent ⭐ Star Rank boost for that card. One copy is always kept and the rarity never changes." },
      { name: "🏠 Your Hubs", value: "`/user-hub` is home base — profile, collection, daily, rank, frames & the market in one panel. `/help` is the full interactive guide to every command." },
    )
    .setImage(DIVIDER_GIF);

  await applyEmbedOverride(info, {
    guildId, key: "commands", defaultImageUrl: DIVIDER_GIF, ctx: { guild: guildName },
  });

  // ── 4 · Collecting ───────────────────────────────────────────────────────────
  const collecting = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle("🃏 Collecting")
    .setDescription(
      "The heart of it — catch cards, complete the set, top the boards.\n\n" +
      "🗃️ **`/collection`** — everything you own\n" +
      "📖 **`/list`** — the full server roster, grouped by rarity\n" +
      "🔍 **`/catalog`** — browse by category: what you own vs. what's still missing\n" +
      "✨ **`/show-shiny`** — flaunt your rare mints\n" +
      "🗂️ **`/set_hub`** — browse sets & track completion\n" +
      "🏆 **`/top`** — server leaderboards (Collector, Battle & Raid)\n" +
      "💠 **`/daily`** · **`/pack`** · **`/burn`** duplicates for shards",
    )
    .setImage(DIVIDER_GIF);

  // ── 5 · Trades ───────────────────────────────────────────────────────────────
  const trades = new EmbedBuilder()
    .setColor(0x1abc9c)
    .setTitle("🔄 Trades & Market")
    .setDescription(
      "Move cards between players — safely and fairly.\n\n" +
      "🤝 **`/trade propose user:@player`** — direct card-for-card deals. Lopsided offers (over 3:1 in value) flash a ⚠️ so nobody gets fleeced.\n" +
      "🎁 **`/trade gift user:@player`** — send 💠 shards to a friend.\n" +
      "📌 **/user-hub → Wishlist** — mark the cards you're hunting so trade partners can find you.\n" +
      "🏪 **/user-hub → Market** — the player marketplace: list what you're selling, browse & buy what you need.",
    )
    .setImage(DIVIDER_GIF);

  // ── 6 · Battling ─────────────────────────────────────────────────────────────
  const battling = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle("⚔️ Battling")
    .setDescription(
      "Your cards fight — real stats, specials, ultimates and items.\n\n" +
      "⚔️ **`/battle user:@player`** — duel a player, or leave it empty to fight the AI. Your card's rarity & power drive its stats.\n" +
      "🎮 **`/battle phaser`** — a live **Yu-Gi-Oh-style duel** using your own cards, **plus an open world to explore** and challenge duelists. Runs on desktop & mobile.\n" +
      "🐉 **`/raid`** — team up against a co-op boss card.\n" +
      "🤝 **`/squad`** — form a squad and climb together.\n" +
      "📊 **`/battle profile`** — your record, rank & battle stats.",
    )
    .setImage(DIVIDER_GIF);

  // ── 7 · Sieges ───────────────────────────────────────────────────────────────
  const sieges = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle("🏰 Sieges")
    .setDescription(
      "The big one — a tactical **4-card formation** battle for a base.\n\n" +
      "🏰 **`/battle siege`** — lay siege to a player's base or a world territory.\n" +
      "🛡️ Four cards hold the **front line**; fight through it and, when it breaks, **reserves deploy** — punch all the way through to drain the commander's **life points**.\n" +
      "🃏 Each turn: **Draw Phase** → **Main Phase** — pick a fighter, choose a target, and play **Siege Battle Cards** (combos, finishers & formation orders).\n" +
      "🎴 Close-up **Card Clash** cinematics play automatically when a blow lands — not a separate mode.\n" +
      "⭐ Take a base without losing a card for the full **★★★**.\n" +
      "🔧 Set up your own defenses in **`/hq`** (admins tune the rules in `/hqadmin`).",
    )
    .setFooter({ text: `🌐 ${SITE_URL}  ·  Run /help for the complete guide` })
    .setImage(DIVIDER_GIF);

  await interaction.editReply({ embeds: [welcome, rules, info, collecting, trades, battling, sieges], files });

}

// ─────────────────────────────────────────────────────────────────────────────
// /welcome_admin — ephemeral, admin-only onboarding guide.
// Three embeds: Quick-Start checklist · Card Editing guide · Command cheat-sheet.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleWelcomeAdmin(interaction: ChatInputCommandInteraction): Promise<void> {
  // NOTE: admin.ts dispatcher has already called deferReply(ephemeral) — do NOT defer again here.
  if (!interaction.guild) { await interaction.editReply("❌ Must be used inside a server."); return; }
  if (!(await isGuildAdmin(interaction))) {
    await interaction.editReply("❌ Admins only.");
    return;
  }

  const adminUrl = dashboardAdminUrl();

  // ── Embed 1: Setup Checklist ──────────────────────────────────────────────
  const quickstart = new EmbedBuilder()
    .setColor(ADMIN_COLOR)
    .setTitle(`🛠️ Admin Quick-Start — ${BRAND_NAME}`)
    .setDescription(
      "Do these **in order** the first time:\n\n" +

      "**✅ Step 1 — `/setup`**\n" +
      "Interactive wizard — spawn channel, drop interval, catch mode (type/button/both), " +
      "rarity weights, and the default starter card roster. One flow, everything configured.\n\n" +

      "**✅ Step 2 — Activate a Card Set**\n" +
      "Random spawns only fire from the **active set**. Run `/set_hub` (clickable panel) " +
      "to pick one. No active set = no random spawns (admin `/drop` always works).\n\n" +

      "**✅ Step 3 — Add & Edit Cards**\n" +
      `• **Website** → [${SITE_ADMIN}](${SITE_ADMIN}) — display name, image, description, featured/hidden, sort order.\n` +
      "• **Discord** → `/add_card` (upload) · `/create_card_from_mttv` (Vault Values image + rarity) · `/cardadmin` From Kitsu — or prefix `!addcard` / `!editcard`.\n\n" +

      "**✅ Step 4 — Dashboard Login**\n" +
      "Run `/dashboard` — bot DMs you a one-time login link. Do this for every admin who needs site access.\n\n" +

      "**✅ Step 5 — Test It**\n" +
      "Run `/drop` (no name = random from active set). If nothing spawns, check the set has droppable cards and the spawn channel is configured.",
    )
    .setImage(DIVIDER_GIF);

  // ── Embed 2: Card Editing — Website vs Discord ────────────────────────────
  const cardEditing = new EmbedBuilder()
    .setColor(ADMIN_COLOR)
    .setTitle("🃏 Card Editing — Website vs Discord")
    .setDescription(
      "The website and bot share **one database** but own different columns. " +
      "Gameplay values are **read-only on the website** on purpose — change them in Discord.\n\n" +

      "**🌐 Website (display overrides only)**\n" +
      `Go to **[Card Manager](${adminUrl})** → pick a card → edit in the side panel.\n` +
      "You can change: Display Name · Image URL · Description · Flavor Text · Hidden from Site · Featured · Sort Weight.\n" +
      "Everything else (rarity, worth, burn, spawn chance, packs) is shown read-only for reference.\n" +
      `Public card roster: **[${SITE_URL}](${SITE_URL})**\n\n` +

      "**🎮 Discord (gameplay values — prefix commands)**\n" +
      "```\n" +
      "!addcard          — guided wizard: name, rarity, worth, image, etc.\n" +
      "!addlimited       — limited edition (copy cap)\n" +
      "!addevent         — event-exclusive (never random-drops)\n" +
      "!editcard <Name>  — edit any field on an existing card\n" +
      "!removecard <Name>— archive (stops spawning, keeps collections intact)\n" +
      "!import           — bulk import from JSON file attachment\n" +
      "```\n" +
      "Images must be **URLs** (Imgur, Discord CDN). No file uploads in prefix commands.\n\n" +

      "**🗂️ Sets (spawn rotation)**\n" +
      "`/set_hub` — clickable panel (create, activate, export, toggle showcase).\n" +
      "`/set_admin` — advanced set hub (weights, bulk operations, import/export).\n" +
      "Export any set to JSON → re-import with `!import` + file attachment, or load it from the `/set_hub` panel. Full roundtrip.",
    )
    .setImage(DIVIDER_GIF);

  // ── Embed 3: Admin Cheat-Sheet ────────────────────────────────────────────
  const cheatsheet = new EmbedBuilder()
    .setColor(ADMIN_COLOR)
    .setTitle("⚡ Admin Command Cheat-Sheet")
    .addFields(
      {
        name: "🎁 Drops & Giveaways",
        value:
          "`/drop [name]` — single drop (bypasses active-set check)\n" +
          "`/mass_drop [amount]` — 10–25 cards in a batch (event use)\n" +
          "`/create_card_from_mttv` — Vault Values image + rarity · `/add_card` · `/edit_image`\n" +
          "`/cardadmin` — give · take · give shards · take shards",
        inline: false,
      },
      {
        name: "🎯 Limited-Time Events",
        value:
          "`/event start card:<Name> duration:<30m|2h|1d> [multiplier:<n>]` — boost a card's spawn weight\n" +
          "`/event list` · `/event stop id:<n>`",
        inline: false,
      },
      {
        name: "⚙️ Config & Channels",
        value:
          "`/setup` — first-time wizard · `/config` — visual config panel\n" +
          "`/admin_hub` — manage admins, timeouts, channels & server state\n" +
          "`/help` → **Admin** — full admin reference",
        inline: false,
      },
      {
        name: "🗂️ Sets",
        value:
          "`/set_hub` — **clickable panel** (recommended) — browse, create, activate, export\n" +
          "`/set_admin` — advanced hub — rarity weights, bulk add/remove, import/export",
        inline: false,
      },
      {
        name: "🎨 Appearance",
        value:
          "`/embed set key:<embed> field:<field> value:<v>` — override spawn/claimed/daily/pack/trade embeds\n" +
          "`/rarity` — tier hub: rename tiers, set colors/emoji, and worth/burn/spawn per rarity\n" +
          "`/embed designer` — live visual editor for spawn/claimed/daily/pack/trade embeds",
        inline: false,
      },
      {
        name: "🌐 Website",
        value:
          `Public: **[${SITE_URL}](${SITE_URL})** — card roster, news, player suggestions\n` +
          `Admin: **[${adminUrl}](${adminUrl})** — card display overrides, news posts, suggestion queue\n` +
          "Run `/dashboard` to get your login link (one-time DM).",
        inline: false,
      },
    )
    .setFooter({ text: "Player commands → /help  ·  Full admin reference → /help → Admin" });

  await interaction.editReply({ embeds: [quickstart, cardEditing, cheatsheet] });
}
