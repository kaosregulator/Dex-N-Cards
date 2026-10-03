// ─────────────────────────────────────────────────────────────────────────────
// Unified /help hub — one interactive, animated command that documents the WHOLE
// DN Cards project: collecting, economy, trading & market, battles/raids/squads,
// giveaways, quests & reputation, Echo/AFK, and (for admins) the full admin tool
// set. A single ephemeral message with an animated banner and a topic dropdown;
// picking a topic live-edits the embed to that page (no new messages, no spam).
//
// Editable: the embed runs through applyEmbedOverride("help"), so admins can
// rebrand the banner/color/title/footer any time with `/embed set key:help …`.
//
// Every player + admin command is represented here — this is the single source
// of truth that replaces the older split help embeds.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  ChatInputCommandInteraction, StringSelectMenuInteraction, ButtonInteraction,
  GuildMember,
} from "discord.js";
import {
  EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder,
  ButtonStyle, MessageFlags, PermissionFlagsBits, AttachmentBuilder } from "discord.js";
import { applyEmbedOverride } from "../embed-overrides.js";
import { isAdmin as isDbAdmin, getOrCreateGuildSettings } from "../db.js";
import { getShinyName } from "../cards-data.js";
import {
  HELP_BANNER, SECTION_COLOR, siteUrl, type HelpSection, BRAND_NAME,
  brandAsset, BRAND_LOGO_FILE } from "../help-banners.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

interface SectionMeta { id: HelpSection; emoji: string; label: string; blurb: string; adminOnly?: boolean }

// Order = dropdown order. "home" is the landing page.
const SECTIONS: SectionMeta[] = [
  { id: "home",     emoji: "🏠", label: "Overview & Getting Started", blurb: "What Dex N Cards is + how to start" },
  { id: "collect",  emoji: "🃏", label: "Collecting & Cards",         blurb: "Catch, browse, rank, level, cosmetics" },
  { id: "economy",  emoji: "💠", label: "Economy & Packs",            blurb: "Daily, shards, packs, burn, trade-in" },
  { id: "trade",    emoji: "🔄", label: "Trading & Marketplace",      blurb: "Trades, gifts, wishlist, auctions" },
  { id: "battle",   emoji: "⚔️", label: "Battles, Raids & Squads",    blurb: "Duels, co-op bosses, teams" },
  { id: "giveaway", emoji: "🎉", label: "Giveaways",                  blurb: "Win prizes through activity" },
  { id: "quests",   emoji: "🎯", label: "Quests & Reputation",        blurb: "Daily/weekly goals, rep, thanks" },
  { id: "social",   emoji: "🔊", label: "Quotes, Echo, AFK & Quiet", blurb: "Quote cards, whispers, away status, Quiet Room" },
  { id: "admin",    emoji: "🛠️", label: "Admin Toolbox",              blurb: "Setup, config & management (admins)", adminOnly: true },
];

// The circle logo, attached to every help render (initial + each dropdown
// switch) so the thumbnail persists — Discord drops attachments on update, so
// it must be re-sent each time. 24 KB, so the re-send is cheap.
function logoFiles(): AttachmentBuilder[] {
  const buf = brandAsset(BRAND_LOGO_FILE);
  return buf ? [new AttachmentBuilder(buf, { name: BRAND_LOGO_FILE })] : [];
}

// ── Entry point ──────────────────────────────────────────────────────────────
export async function handleHelpHub(
  interaction: ChatInputCommandInteraction, opening: HelpSection = "home",
): Promise<void> {
  // Callers may or may not have deferred already (e.g. /help defers
  // ephemerally; !help / direct /help may not). Normalize.
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply(EPHEMERAL).catch(() => {});
  }
  const admin = await memberIsAdmin(interaction);
  const embed = await buildPage(interaction, opening);
  await interaction.editReply({ embeds: [embed], components: buildComponents(opening, admin), files: logoFiles() });
}

// ── Component router (help:* select + buttons) ───────────────────────────────
export async function handleHelpHubComponent(
  interaction: StringSelectMenuInteraction | ButtonInteraction,
): Promise<void> {
  const parts = interaction.customId.split(":"); // help:select | help:home
  const admin = await memberIsAdmin(interaction);
  let section: HelpSection = "home";
  if (interaction.isStringSelectMenu()) section = (interaction.values[0] as HelpSection) ?? "home";
  else if (parts[1] === "home") section = "home";

  if (section === "admin" && !admin) {
    await interaction.reply({ content: "🛠️ The Admin section is only available to server administrators.", ...EPHEMERAL }).catch(() => {});
    return;
  }
  const embed = await buildPage(interaction, section);
  await interaction.update({ embeds: [embed], components: buildComponents(section, admin), files: logoFiles() }).catch(() => {});
}

// ── Components (topic dropdown + nav buttons) ─────────────────────────────────
function buildComponents(current: HelpSection, admin: boolean) {
  const options = SECTIONS
    .filter(s => !s.adminOnly || admin)
    .map(s => ({ label: s.label, value: s.id, description: s.blurb, emoji: s.emoji, default: s.id === current }));

  const select = new StringSelectMenuBuilder()
    .setCustomId("help:select")
    .setPlaceholder("📖 Jump to a topic…")
    .addOptions(options);

  const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("help:home").setLabel("Home").setEmoji("🏠").setStyle(ButtonStyle.Secondary).setDisabled(current === "home"),
    new ButtonBuilder().setLabel("Website").setEmoji("🌐").setStyle(ButtonStyle.Link).setURL(siteUrl()),
  );

  return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), nav];
}

// ── Page builder ─────────────────────────────────────────────────────────────
async function buildPage(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction | ButtonInteraction,
  section: HelpSection,
): Promise<EmbedBuilder> {
  const guildId = interaction.guildId;
  const settings = guildId ? await getOrCreateGuildSettings(guildId).catch(() => null) : null;
  const shiny = getShinyName(settings);
  const site = siteUrl();

  const embed = new EmbedBuilder().setColor(SECTION_COLOR[section]);
  PAGES[section](embed, { shiny, site });
  embed.setImage(HELP_BANNER); // animated banner stripe (overridable below)
  if (brandAsset(BRAND_LOGO_FILE)) embed.setThumbnail(`attachment://${BRAND_LOGO_FILE}`);

  // Let admins rebrand the help embed via `/embed set key:help …`.
  await applyEmbedOverride(embed, {
    guildId,
    key: "help",
    defaultImageUrl: HELP_BANNER,
    ctx: { guild: interaction.guild?.name ?? "this server" },
  });
  return embed;
}

interface PageCtx { shiny: string; site: string }
type PageFn = (e: EmbedBuilder, ctx: PageCtx) => void;

const NAV_HINT = "\n\n*Use the 📖 dropdown below to jump to any topic.*";

const PAGES: Record<HelpSection, PageFn> = {
  // ── Overview ───────────────────────────────────────────────────────────────
  home: (e, { site }) => {
    e.setTitle(`🃏 ${BRAND_NAME} — Full Guide`)
      .setDescription(
        "**DarkNight's military collectible card game.** Tanks, jets, warships, bosses, and the odd cursed community card drop right into your server. Catch them, hoard them, battle with them, trade them, and flex your collection.\n\n" +
        "**How catching works**\n" +
        "When a card spawns in the drop channel, just **type its name** to catch it — no command needed *(unless the server uses button mode, then you click)*. First valid catch wins; Discord's own message timestamp breaks ties fairly.\n\n" +
        "**Your Hub is home base**\n" +
        "`/user-hub` is your personal dashboard — **Progression, Collection, Profile, Battle record, Daily, Calendar, Frames**, plus buttons to the **Market**, your **Squad**, and **Show Card**. Most personal screens live here now instead of separate commands.\n\n" +
        "**Your first five minutes**\n" +
        "① `/user-hub` → **Daily** — grab free 💠 shards\n" +
        "② Watch the spawn channel and **type card names** to catch\n" +
        "③ `/pack tier:basic` — spend shards on a 5-card pack\n" +
        "④ `/user-hub` → **Collection** — see what you own\n" +
        "⑤ `/burn` duplicates → more shards → repeat\n\n" +
        "**What else is here** — battles & co-op raids, squads, a player marketplace, giveaways, daily/weekly quests, reputation, encrypted Echo whispers, and more. Pick a topic below.\n\n" +
        "💡 New to the server? Run `/welcome` for the public intro & rules." +
        `\n\n🌐 Full roster & stats: **[${site}](${site})**`,
      )
      .setFooter({ text: `${BRAND_NAME} · pick a topic below to see every command` });
  },

  // ── Collecting ───────────────────────────────────────────────────────────────
  collect: (e, { shiny }) => {
    e.setTitle("🃏 Collecting & Cards")
      .setDescription("Everything about catching, browsing, and showing off cards." + NAV_HINT)
      .addFields(
        { name: "🎯 Catch & Browse", value:
          "**Type a card's name** in the spawn channel to catch it.\n" +
          "`/collection-hub` — **browse your own cards**: filter by rarity (custom tiers included), ✨ shinies, 💎 limited, 🎆 event, duplicates or leveled, search by name, then open any card for its stats & level\n" +
          "**/user-hub → Collection** — your owned cards by rarity (**🔎 Browse Cards** opens the hub above)\n" +
          "`/info name:<card>` — details, worth, drop chance\n" +
          "`/list` — full roster grouped by rarity\n" +
          "`/catalog category:<rarity|event|limited|all>` — browse by type\n" +
          "**/user-hub → Search** — free-text card search (shows ⭐ on cards you own)" },
        { name: "🏠 Headquarters", value:
          "`/hq` — your personal **Headquarters**: an isometric room you customize. Feature your proudest cards on **Trophy Hall** pedestals, place **decorations** you earn by playing or find as **catch drops**, **buy furniture** from the daily-rotating **🛒 Shop** (shards), and restyle with **themes, real wallpaper & floors** as you unlock new rooms.\n" +
          "**/hq → 🗺️ World Map** — a whole continent already held by six **AI factions**. March on a castle, take it, and it pays you 💠 every hour you hold it. Pick **Cinematic** to watch the full opening scene before the battle.\n" +
          "**/hq → 🛠️ Build** — the world editor: move a cursor around the isometric grid and paint **paving, ponds, hills and raised platforms** in rectangles, indoors or on your grounds.\n" +
          "`/hqbuild place|remove|list|clear|wallpaper|materials` — the same editor by typing exact coordinates\n" +
          "`/hq user:@member` — visit someone else's HQ and see what they've accomplished" },
        { name: "🏅 Progress & Rank", value:
          "**/user-hub → Progression** — account level & XP across every activity\n" +
          "**/user-hub → Collector Profile** — rank, net worth, achievements & the leaderboard\n" +
          "**/user-hub → Calendar** — your login streak\n" +
          "`/collector` — opt in/out of the spawn-ping collector role" },
        { name: "⭐ Star Rank & Card Recycle", value:
          "Cards gain a **Star Rank (0–5★)** that boosts their battle stats.\n" +
          "`/card_recycle name:<card>` — recycle **duplicate copies** you already own to raise that card's ⭐ Star Rank (one copy is always kept; rarity never changes)." },
        { name: "🖼️ Cosmetics & Safety", value:
          "**/user-hub → Frames** — equip a cosmetic frame on a card\n" +
          "`/level card:<card>` — a card's battle level, XP & unlocked frames\n" +
          "`/lock name:<card>` — lock/favorite a card so it's safe from bulk burns" },
        { name: "🗂️ Card Sets", value:
          "`/set_hub` — browse every set, see which one is active, and check your completion\n" +
          "Click any set in the panel for full details and progress." },
        { name: `✨ ${shiny} Cards`, value:
          `Every catch, pack pull, and trade-in has a **0.5%** chance to mint a ${shiny} card — tracked separately and worth more on burn. ${shiny} catches & pulls play a **sparkle/shine animation** so you'll know instantly.` },
        { name: "🎬 Spawn Reveals & Battle-Ready Pulls", value:
          "Wild cards now **reveal with an animation** (blur, puzzle, or silhouette by rarity — your admins can change the style). Some servers let cards arrive **already levelled/fused** — those show a **⚡ BATTLE-READY** tag, ready to fight straight away." },
      );
  },

  // ── Economy ──────────────────────────────────────────────────────────────────
  economy: (e) => {
    e.setTitle("💠 Economy & Packs")
      .setDescription("Earn and spend **DN Shards** — the currency behind everything." + NAV_HINT)
      .addFields(
        { name: "💰 Earn Shards", value:
          "**/user-hub → Daily** — free shards daily (streak bonus grows the payout)\n" +
          "`/burn name:<card> [amount] [all] [shiny:true]` — destroy duplicates for 💠\n" +
          "`/shards [user]` — check a balance\n" +
          "Also earned from achievements, quests, battles, and the market." },
        { name: "📦 Packs", value:
          "`/pack tier:<basic|premium|legendary>` — open a 5-card pack\n" +
          "🥉 Basic 250 💠 · 🥈 Premium 750 💠 · 🥇 Legendary 2,000 💠 (no commons)\n" +
          "`/pack_stats` — your costs, weekly caps & cooldown\n" +
          "Tiers share one cooldown but each has its **own weekly cap** (resets Mon 00:00 UTC)." },
        { name: "♻️ Card Recycle", value:
          "`/card_recycle name:<card>` — recycle **duplicate copies** of a card to raise its ⭐ **Star Rank** (a permanent battle-stat boost). One copy is always kept and the rarity never changes." },
        { name: "🎁 Gifting", value:
          "`/trade` → **Gift shards** — send shards to a friend." },
        { name: "💵 Casino (UnbelievaBoat)", value:
          "`/casino` — floor panel: wallet, mega slots, public blackjack, UNO, collect, store, leaderboard\n" +
          "`/vaultvalue` — Vault Values panel (info · calc · list · help)\n" +
          "`/unbelievaboat` — (admin) economy dashboard, log channel, rob immunity\n" +
          "`/tatsu` — (staff) Tatsu score/points leaderboard, lookup, spam strip" },
      );
  },

  // ── Trading & Market ─────────────────────────────────────────────────────────
  trade: (e) => {
    e.setTitle("🔄 Trading & Marketplace")
      .setDescription("Move cards between players — directly, or on the open market." + NAV_HINT)
      .addFields(
        { name: "🤝 Direct Trades (`/trade` panel)", value:
          "`/trade` opens a hub — **Propose**, **Pending**, **History**, **Accept**, **Decline**, **Gift**\n" +
          "Propose mixes cards and/or 💠 shards. Accept/Decline by trade ID or use buttons on the offer.\n" +
          "Deals over **3:1** in value show an orange ⚠️ fairness warning (informational)." },
        { name: "📌 Wishlist", value:
          "**/user-hub → Wishlist** — add cards you want (get pinged when they spawn), see your list, and remove entries." },
        { name: "🏪 Marketplace", value:
          "Open the **🏪 Market** from `/user-hub` — one panel to **sell** (fixed price or timed auction), **browse** active listings, **buy** or **buy out**, **bid** on auctions, and **manage** your own listings & bids." },
      );
  },

  // ── Battles / Raids / Squads ─────────────────────────────────────────────────
  battle: (e) => {
    e.setTitle("⚔️ Battles, Raids & Squads")
      .setDescription("Put your cards to work — 1v1 duels, co-op boss raids, and team play." + NAV_HINT)
      .addFields(
        { name: "⚔️ Card Battles", value:
          "`/battle fight [opponent]` — challenge a player, or leave empty to fight the AI\n" +
          "In **Battle Prep** you pick your card, your coin call, and (optionally) stake a card, then **Ready** up.\n" +
          "Your **Battle Profile**, **Battle Achievements**, and battle **Daily** challenges all live in `/user-hub`.\n" +
          "`/battle leaderboard [scope] [sort]` — rankings (guild or global)\n" +
          "New to battles? Open **Battles** in this help dropdown — everything lives under `/battle`." },
        { name: "💪 How Card Power Works", value:
          "A card's stats = its **Rarity** (the base) × its **Level** (1–100) × its **Star Rank** (0–5★).\n" +
          "Rarity sets where you start, then leveling (from battles/raids) and fusing to more stars multiply it — so a **maxed low-rarity card can out-punch a fresh high-rarity one**. At the *same* Level & Star, higher rarity always wins.\n" +
          "Admins can override any card's exact stats and tune how much level matters, so the ceiling is up to your server." },
        { name: "🐉 Co-op Boss Raids", value:
          "`/raid bosses` — list the raid bosses on this server\n" +
          "`/raid start boss:<name>` — open a raid lobby; teammates **Join**, pick a card, and fight a shared-HP boss together\n" +
          "Clear it for shards + card XP. Bosses are admin-created." },
        { name: "🤝 Squads", value:
          "Open the **🤝 Squad** panel from `/user-hub` — **create** or **join** a squad, view **info** & roster, **leave** or **disband**, and climb the **squad leaderboard**." },
      );
  },

  // ── Giveaways ────────────────────────────────────────────────────────────────
  giveaway: (e) => {
    e.setTitle("🎉 Giveaways")
      .setDescription("Win prizes by playing. Admins post giveaways; you earn chances through real activity." + NAV_HINT)
      .addFields(
        { name: "👀 See & Track", value:
          "`/giveaway` — open the Giveaway Hub: active giveaways, prizes, timers, requirements & your standing" },
        { name: "🎟️ How Entering Works", value:
          "Most giveaways track **activity** — catching cards, winning battles, opening packs, joining raids, chatting, and more count automatically toward the requirements.\n" +
          "**Entry mode:** more activity = more entries = better odds.\n" +
          "**Completion mode:** finish every requirement to qualify.\n" +
          "Open giveaways have an **Enter** button instead." },
        { name: "🎁 Claiming", value:
          "When a giveaway ends, its message updates with the winners and a **Claim Prize** button. Winners click to receive card prizes automatically (cards/packs/shards); community prizes are handed off by an admin. Claim before the timer runs out or it rerolls!" },
      );
  },

  // ── Quests & Reputation ──────────────────────────────────────────────────────
  quests: (e) => {
    e.setTitle("🎯 Quests & Reputation")
      .setDescription("Extra goals and community standing layered on top of everyday play." + NAV_HINT)
      .addFields(
        { name: "🎯 Quests", value:
          "**/user-hub → Quests** — your **daily** and **weekly** objectives (catch, open packs, trade, battle, burn, claim daily).\n" +
          "Progress tracks automatically as you play; complete them for 💠 shards and the occasional free pack." },
        { name: "⭐ Reputation", value:
          "**/user-hub → Reputation** — give a member +1 rep (once per person per day) and see the rep leaderboard." },
        { name: "🙏 Thanks", value:
          "`/thanks give @user` — thank a helpful member\n" +
          "`/thanks top` — most-appreciated leaderboard" },
      );
  },

  // ── Echo & AFK ────────────────────────────────────────────────────────────────
  social: (e) => {
    e.setTitle("🔊 Quotes, Echo, AFK & Quiet Room")
      .setDescription("Quote cards, encrypted whispers, away-status, and a peaceful Quiet Room." + NAV_HINT)
      .addFields(
        { name: "🖤 Make it a Quote", value:
          "`/quote` — pick from the last 5 messages, or pass `message_id` / `user` / `text`\n" +
          "**Right-click a message → Apps → Make it a Quote** — instant quote that message\n" +
          "**Target 2 Msgs** — fuse setup + reply (full picker each: recent / user / ID / custom → 14 styles)\n" +
          "Then **Post to Channel** or **Save / Download** the PNG" },
        { name: "🔐 Echo-Whisper (`/secret` + `/echo`)", value:
          "`/secret` panel — **Whisper** (one member) or **Staff secret**\n" +
          "`/echo` — (admin) viewer roles, override, stats, config\n" +
          "Recipients click **🔐 View** to decrypt — nobody else can read it." },
        { name: "💤 AFK Secretary", value:
          "`/afk set` — go away; the Secretary answers anyone who pings you and clears when you're back\n" +
          "`/afk clear` — come back now, whatever return trigger you picked\n" +
          "`/afk messages` — read notes left while you were away\n" +
          "`/afk_setup` — (admin) configure the Secretary — incl. **Reply As Member** (answer with your name + avatar)" },
        { name: "🌙 Sanctuary (`/quiet` hub)", value:
          "`/quiet` `[mode:quiet|vacation|loa|stepaway]` — silent one-channel room\n" +
          "`/quiet` again — emergency exit · staff: `/quiet user:@Member` **force out**\n" +
          "`/quiet_setup ensure_room` — sync rooms + quarantine roles + hides\n" +
          "`/quiet_setup rename` — custom labels for Quiet / Vacation / LOA / Step Away\n" +
          "Includes **Stones in the Water** — a short click-through release exercise. Outsiders can't see the room." },
        { name: "🎮 Community Trivia (`/trivia`)", value:
          "`/trivia` — (staff) host **Flash**, **Trivia**, **Picture**, or schedule **QOTD**\n" +
          "Players guess with big buttons, a Guess popup, or typing until staff hits **End**\n" +
          "Winners get a confetti card + temporary roles (Trivia Winner, QOTD Champion, …)" },
      );
  },

  // ── Admin ─────────────────────────────────────────────────────────────────────
  admin: (e, { site }) => {
    e.setTitle("🛠️ Admin Toolbox")
      .setDescription("Setup, configuration, and management. Most live under `/admin` (and prefix `!` commands for setup)." + NAV_HINT)
      .addFields(
        { name: "🚀 First-Time Setup", value:
          "`/setup` — interactive setup wizard (spawn channel, interval, catch mode, roster)\n" +
          "`/config` — visual config panel · `/admin_hub` — admins, timeouts, channels, state\n" +
          "`/dashboard` — DM yourself a website login link · this **Admin** help page is the reference" },
        { name: "🎁 Drops, Gives & Events (`/cardadmin`)", value:
          "`/cardadmin` panel — Drop · Mass drop · Give · Take · Shards · Give all\n" +
          "*star/level make the card arrive pre-fused/levelled (battle-ready).*\n" +
          "`/event start|list|stop` — limited-time spawn boosts" },
        { name: "✨ Reveals & Card Progression", value:
          "`/config → 🎞️ Reveals` — spawn reveal style (**Auto**/Blur/Puzzle/Silhouette/Off) + **shiny catch animation** toggle\n" +
          "`/progression_default` · `/progression_card` — default / per-card Star/Level on spawn/pull/drop" },
        { name: "🗂️ Cards & Sets (`/cardadmin`)", value:
          "`/cardadmin` panel — Create · Kitsu · Vault Values · Library · Edit · Delete\n" +
          "`/set_hub` · `/set_admin` — set manager\n" +
          "`/rarity` — names, colors, worth, burn, weights, order" },
        { name: "🎨 Appearance & Embeds", value:
          "`/embed set key:<embed> field:<field> value:<v>` — customize any embed (incl. **key:help** to rebrand this guide)\n" +
          "`/rarity edit` — rename/recolor any built-in tier (including Mythic)" },
        { name: "⚔️ Feature Admin", value:
          "`/battle_admin` — battle system hub (setup, rules, rewards, seasons)\n" +
          "`/raid_admin create|edit|list|enable|delete` — co-op raid bosses\n" +
          "`/giveaway` → **⚙️ Admin** — quick-create, manage, end, cancel & reroll giveaways\n" +
          "`/echo` — Echo-Whisper config · `/secret` panel — whisper / staff secret\n" +
          "`/quiet_setup` · `/quiet` — sanctuary place **or force out**\n" +
          "`/unbelievaboat` · `/casino` — UnbelievaBoat economy & casino\n" +
          "`/tatsu` — Tatsu score/points dashboard & spam tools\n" +
          "`/trivia` — community flash trivia, QOTD, picture rounds" },
        { name: "🌐 Website", value: `Public: **[${site}](${site})** · Admin dashboard: run \`/dashboard\` for your login link.` },
      );
  },
};

// ── Admin check ──────────────────────────────────────────────────────────────
async function memberIsAdmin(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction | ButtonInteraction,
): Promise<boolean> {
  const member = interaction.member as GuildMember | null;
  if (member && "permissions" in member && typeof member.permissions !== "string" &&
      member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (interaction.guild && interaction.guild.ownerId === interaction.user.id) return true;
  if (interaction.guildId) return isDbAdmin(interaction.guildId, interaction.user.id).catch(() => false);
  return false;
}
