// /ubadmin — Discord mini dashboard for UnbelievaBoat + pets economy.
// Ephemeral, Administrator-only. Website hub at /admin/unbelievaboat stays.

import type {
  ChatInputCommandInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction,
  UserSelectMenuInteraction,
  RoleSelectMenuInteraction,
  ChannelSelectMenuInteraction,
  ModalSubmitInteraction,
  Guild,
} from "discord.js";
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  UserSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  FileUploadBuilder,
  LabelBuilder,
} from "discord.js";
import { isUbConfigured, ubApi } from "../../lib/unbelievaboat/client.js";
import {
  UbAction,
  UbMatch,
  UbReq,
  normalizeUbItem,
  parseActions,
  parseRequirements,
  summarizeActions,
  summarizeRequirements,
} from "./ub-items.js";
import { syncUbStoreRoleLinks } from "./ub-sync.js";
import { roleCollectCooldownSec, suggestedCollectIncome } from "./collect-roles.js";
import {
  beginIconCapture,
  cancelIconCapture,
  type CapturedIcon,
} from "./icon-capture.js";
import {
  getOrCreateUbSettings,
  updateUbSettings,
  listCatalog,
  listRoleLinks,
  listUbAudit,
  writeUbAudit,
  createRoleLink,
  deleteRoleLink,
  deleteCatalogItem,
  updateRoleLink,
} from "../../lib/unbelievaboat/db.js";
import {
  getOrCreatePetSettings,
  updatePetSettings,
  petLeaderboard,
  adminDeletePet,
  adminCrackEgg,
} from "../pets/engine.js";
import {
  discordEmojiCdnUrl,
  formatGuildEmoji,
  isAnimatedStoreImage,
  isHttpImageUrl,
  normalizeStoreIconInput,
  resolveSelectEmoji,
  titleSafeStoreEmoji,
} from "./store-icons.js";
import { readCooldowns } from "./cooldowns.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;
const UB_ICON =
  "https://cdn.discordapp.com/avatars/292953664492929025/e81ffdbb910a3757b874a890b2a92740.webp?size=64";

export function buildUbAdminCommandJson() {
  return new SlashCommandBuilder()
    .setName("unbelievaboat")
    .setDescription("UnbelievaBoat Discord dashboard — cash, leaderboard, store, games")
    .setDMPermission(false)
    .setDefaultMemberPermissions(0x8)
    .toJSON();
}

function hubRows() {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ubadmin:overview").setLabel("Overview").setEmoji("📋").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("ubadmin:leaderboard").setLabel("Leaderboard").setEmoji("💰").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ubadmin:pets").setLabel("Pets").setEmoji("🐾").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ubadmin:store").setLabel("Store").setEmoji("🛒").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ubadmin:toggle_ub").setLabel("Toggle API link").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("ubadmin:toggle_pets_spend").setLabel("Toggle pet spend").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("ubadmin:toggle_games").setLabel("Toggle games").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("ubadmin:toggle_store").setLabel("Toggle store").setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ubadmin:adjust").setLabel("Adjust cash").setEmoji("✏️").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("ubadmin:set_cash").setLabel("Set cash").setEmoji("🔢").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("ubadmin:add_perk").setLabel("Add perk").setEmoji("✨").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("ubadmin:casino_station").setLabel("Casino station").setEmoji("🎰").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ubadmin:pet_tools").setLabel("Pet tools").setEmoji("🛠️").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ubadmin:logs").setLabel("Log channel").setEmoji("📜").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("ubadmin:immunity").setLabel("Rob immunity").setEmoji("🛡️").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ubadmin:roles_economy").setLabel("Roles & economy").setEmoji("🏛️").setStyle(ButtonStyle.Primary),
    ),
  ];
}

function fmt(n: number) {
  return new Intl.NumberFormat().format(n);
}

function numField(id: string, label: string, value: number) {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder()
      .setCustomId(id)
      .setLabel(label.slice(0, 45))
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(String(value)),
  );
}

function textField(id: string, label: string, value: string) {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder()
      .setCustomId(id)
      .setLabel(label.slice(0, 45))
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(value.slice(0, 100)),
  );
}

function parseNonNeg(raw: string, label: string): number {
  const n = Number(String(raw).trim().replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a non-negative number.`);
  return Math.floor(n);
}

async function buildCasinoStation(guildId: string, notice?: string): Promise<{
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];
}> {
  const { readCooldowns, DEFAULT_COOLDOWNS, cdText } = await import("./cooldowns.js");
  const { readPayouts, DEFAULT_PAYOUTS } = await import("./payouts.js");
  const s = await getOrCreateUbSettings(guildId);
  const cds = readCooldowns(s);
  const pay = readPayouts(s);
  const embed = new EmbedBuilder()
    .setColor(0xe91e8c)
    .setAuthor({ name: "UnbelievaBoat casino station", iconURL: UB_ICON })
    .setTitle("Cooldowns + payouts")
    .setDescription(
      [
        notice ? `${notice}\n` : "",
        "_Webhook floor commands (`*_ub` / `/casino` / games prefix). UB’s own Discord cooldowns are **not** on their API — these are ours._",
        "_Cooldown input: `30m`, `4h`, `daily`, `90s`, or a bare number of **minutes**._",
        "",
        `**Daily** · CD ${cdText(cds.dailySec * 1000)} · payout **${fmt(pay.dailyMin)}–${fmt(pay.dailyMax)}**`,
        `**Collect** · CD ${cdText(cds.collectSec * 1000)} · payout = perk incomes`,
        `**Work** · CD ${cdText(cds.workSec * 1000)} · **${fmt(pay.workMin)}–${fmt(pay.workMax)}**`,
        `**Crime** · CD ${cdText(cds.crimeSec * 1000)} · win **${fmt(pay.crimeWinMin)}–${fmt(pay.crimeWinMax)}** · fail ${pay.crimeFailChancePct}% · fine ≥${fmt(pay.crimeFineMin)} (${pay.crimeFineWalletPctMin}–${pay.crimeFineWalletPctMax}% wallet)`,
        `**Beg** · CD ${cdText(cds.begSec * 1000)} · pity ${pay.begChancePct}% · **${fmt(pay.begMin)}–${fmt(pay.begMax)}**`,
        `**Rob** · CD ${cdText(cds.robSec * 1000)} · success ${pay.robSuccessChancePct}% · steal **${fmt(pay.robStealMin)}–${fmt(pay.robStealCap)}** (${pay.robStealCashPct}% cash) · fail fine **${fmt(pay.robFailFineMin)}–${fmt(pay.robFailFineMax)}**`,
        `**Games** · **${cds.gameUses}** plays / ${cdText(cds.gameWindowSec * 1000)} · gap ${cds.gameGapSec}s`,
        "",
        `Defaults: daily ${DEFAULT_PAYOUTS.dailyMin}–${DEFAULT_PAYOUTS.dailyMax} · work/crime/beg ${cdText(DEFAULT_COOLDOWNS.workSec * 1000)} · rob/collect ${cdText(DEFAULT_COOLDOWNS.robSec * 1000)}`,
      ].filter(Boolean).join("\n"),
    );

  const pick = new StringSelectMenuBuilder()
    .setCustomId("ubadmin:station_pick")
    .setPlaceholder("Edit a command…")
    .addOptions(
      { label: "Daily (check-in)", value: "daily", description: "Cooldown + payout range", emoji: "📅" },
      { label: "Collect (role income)", value: "collect", description: "Cooldown only", emoji: "🏦" },
      { label: "Work", value: "work", description: "Cooldown + payout range", emoji: "🛠️" },
      { label: "Crime", value: "crime", description: "Cooldown + win/fail payouts", emoji: "🕵️" },
      { label: "Beg", value: "beg", description: "Cooldown + pity chance/payout", emoji: "🙏" },
      { label: "Rob", value: "rob", description: "Cooldown + steal/fine", emoji: "🔫" },
      { label: "Games (BJ/slots/…)", value: "games", description: "Plays per window + gap", emoji: "🎲" },
    );

  // Discord allows max 5 action rows. hubRows() is 4 rows — bundling it here
  // made Casino station exceed the limit so the edit failed and cooldowns
  // appeared to "not open". Keep station lean + a single Back button.
  const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ubadmin:station_reset").setLabel("Reset all defaults").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("ubadmin:overview").setLabel("← Back to hub").setStyle(ButtonStyle.Secondary),
  );

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(pick),
      actions,
    ],
  };
}

async function buildOverviewEmbed(guildId: string): Promise<EmbedBuilder> {
  const settings = await getOrCreateUbSettings(guildId);
  const petSettings = await getOrCreatePetSettings(guildId);
  let guildLine = "_API not queried_";
  let apiErr: string | null = null;
  if (isUbConfigured() && settings.enabled) {
    try {
      const g = await ubApi.getGuild(settings.ubGuildId || guildId);
      guildLine = `**${g.name}** · ${fmt(g.member_count)} members · symbol ${g.symbol || "—"}`;
    } catch (err) {
      apiErr = err instanceof Error ? err.message : "UnbelievaBoat API error";
    }
  }

  return new EmbedBuilder()
    .setColor(0xe91e8c)
    .setAuthor({ name: "UnbelievaBoat mini dashboard", iconURL: UB_ICON })
    .setTitle("Economy + Pets control")
    .setDescription(
      [
        `Token configured: **${isUbConfigured() ? "yes" : "no"}**`,
        `UnbelievaBoat API link: **${settings.enabled ? "on" : "off"}**`,
        `Pets spend cash: **${settings.petsSpendUb ? "on" : "off"}**`,
        `Mini-games: **${settings.gamesEnabled !== false ? "on" : "off"}** · Perk store: **${settings.storeEnabled !== false ? "on" : "off"}**`,
        `Cash Check-In range: **${settings.dailyMin ?? 100}–${settings.dailyMax ?? 250}** _(edit in Casino station)_`,
        `Leaderboard sort: **${settings.leaderboardSort}**`,
        `Log channel: **${settings.logChannelId ? `<#${settings.logChannelId}>` : "not set"}**`,
        `Rob immunity roles: **${(settings.robImmuneRoleIds ?? []).length}**`,
        `Linked guild id: \`${settings.ubGuildId || guildId}\``,
        "",
        guildLine,
        apiErr ? `⚠️ ${apiErr}` : null,
        "",
        `Pets enabled: **${petSettings.enabled ? "yes" : "no"}** · hatch **${petSettings.hatchCost}** · growth **${petSettings.growthHours}h** · neglect **${petSettings.maxNeglects}**`,
        "",
        "Player hub: **`/casino`** panel (wallet · mega slots · public blackjack · UNO · collect · top · store)",
        "_Optional website mirror still at `/admin/unbelievaboat`._",
      ].filter(Boolean).join("\n"),
    )
    .setFooter({ text: "Admin only · UnbelievaBoat cash powers pet shop & hatch" });
}

function storeNavRows() {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ubadmin:overview").setLabel("← Hub").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ubadmin:add_perk").setLabel("Add perk").setEmoji("✨").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("ubadmin:store_refresh").setLabel("Refresh").setEmoji("🔄").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

const GUILD_EMOJI_PAGE = 25;

function buildGifUploadModal(linkId: number) {
  return new ModalBuilder()
    .setCustomId(`ubadmin:perk_icon_upload:${linkId}`)
    .setTitle("Upload store GIF / image")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("GIF or image from Discord")
        .setDescription("Discord’s file picker — animated GIFs play on the store board")
        .setFileUploadComponent(
          new FileUploadBuilder()
            .setCustomId("image")
            .setRequired(true)
            .setMinValues(1)
            .setMaxValues(1),
        ),
    );
}

function guildEmojiPages(guild?: Guild | null) {
  const all = guild?.emojis?.cache
    ? [...guild.emojis.cache.values()]
      .filter(e => Boolean(e.id && e.name))
      .sort((a, b) => Number(b.animated) - Number(a.animated) || a.name!.localeCompare(b.name!))
    : [];
  const pages = Math.max(1, Math.ceil(all.length / GUILD_EMOJI_PAGE) || 1);
  return { all, pages };
}

function buildPerkIconPicker(
  linkId: number,
  perkName: string,
  currentEmoji: string,
  guild?: Guild | null,
  page = 0,
) {
  // Never put raw custom-emoji markup into the title name — Discord renders it
  // as part of the title and it looks “stuck” after icon changes.
  const titleEmoji = titleSafeStoreEmoji(currentEmoji, "🖼️");
  const embed = new EmbedBuilder()
    .setColor(0xe91e8c)
    .setAuthor({ name: "Store icon", iconURL: UB_ICON })
    .setTitle(`${titleEmoji} ${perkName}`)
    .setDescription(
      [
        "**Use Discord’s emoji / GIF bar** (same bar at the bottom of chat):",
        "1. Tap **Pick in chat**",
        "2. Open Discord’s emoji or GIF picker in this channel",
        "3. Send it — I’ll apply it and delete your message",
        "",
        "Or page through **all server emoji** below. **Upload GIF** opens Discord’s file picker.",
      ].join("\n"),
    );

  const { all, pages } = guildEmojiPages(guild);
  const safePage = Math.min(Math.max(0, page), pages - 1);
  const slice = all.slice(safePage * GUILD_EMOJI_PAGE, (safePage + 1) * GUILD_EMOJI_PAGE);

  const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`ubadmin:perk_icon_chat:${linkId}`)
      .setLabel("Pick in chat")
      .setEmoji("💬")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`ubadmin:perk_icon_upload_btn:${linkId}`)
      .setLabel("Upload GIF")
      .setEmoji("🎞️")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`ubadmin:perk_icon_only_btn:${linkId}`)
      .setLabel("Clear image")
      .setStyle(ButtonStyle.Secondary),
  );

  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [actions];

  if (slice.length) {
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`ubadmin:perk_icon_guild:${linkId}`)
          .setPlaceholder(`Server emoji · page ${safePage + 1}/${pages}`)
          .addOptions(
            slice.map(e => ({
              label: `${e.animated ? "GIF · " : ""}${e.name}`.slice(0, 100),
              description: (e.animated ? "Animated custom emoji" : "Custom emoji").slice(0, 100),
              value: e.id,
              emoji: { id: e.id, name: e.name!, ...(e.animated ? { animated: true } : {}) },
            })),
          ),
      ),
    );
    if (pages > 1) {
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`ubadmin:perk_icon_gpage:${linkId}:${safePage - 1}`)
            .setLabel("◀ Emoji")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(safePage <= 0),
          new ButtonBuilder()
            .setCustomId(`ubadmin:perk_icon_gpage:${linkId}:${safePage + 1}`)
            .setLabel("Emoji ▶")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(safePage >= pages - 1),
        ),
      );
    }
  }

  return { embeds: [embed], components };
}

async function applyCapturedIconToLink(
  guildId: string,
  linkId: number,
  icon: CapturedIcon,
  userId: string,
): Promise<{ name: string; ubItemId: string | null } | null> {
  const roles = await listRoleLinks(guildId);
  const row = roles.find(r => r.id === linkId);
  if (!row) return null;
  const meta: Record<string, unknown> = { ...(row.meta as Record<string, unknown>) };
  if (icon.imageUrl) {
    meta.imageUrl = icon.imageUrl;
    delete meta.iconGif;
  } else {
    delete meta.imageUrl;
    delete meta.iconGif;
  }
  // Icon never mutates the role display name.
  await updateRoleLink(guildId, linkId, { emoji: icon.emoji.slice(0, 64), meta });
  await syncEmojiToUbItem(guildId, row.ubItemId, icon.emoji);
  await writeUbAudit(guildId, userId, "discord_perk_icon", {
    id: linkId,
    preset: icon.source,
    emoji: icon.emoji,
    imageUrl: icon.imageUrl,
    animated: icon.animated,
  });
  return { name: row.name, ubItemId: row.ubItemId };
}

function applyStoreImageToEmbed(embed: EmbedBuilder, imageUrl: string) {
  if (isAnimatedStoreImage(imageUrl)) embed.setImage(imageUrl);
  else embed.setThumbnail(imageUrl);
  return embed;
}

/** Push Discord emoji choice onto the linked UnbelievaBoat store item. */
async function syncEmojiToUbItem(
  guildId: string,
  ubItemId: string | null | undefined,
  emojiRaw: string,
): Promise<void> {
  if (!ubItemId || !isUbConfigured()) return;
  const settings = await getOrCreateUbSettings(guildId);
  const icon = normalizeStoreIconInput(emojiRaw);
  const custom = icon.imageUrl?.match(/emojis\/(\d+)\.(png|gif)/);
  try {
    if (custom) {
      await ubApi.editStoreItem(settings.ubGuildId, ubItemId, {
        emoji_id: custom[1],
        emoji_unicode: null,
      });
    } else if (icon.emoji && !icon.emoji.includes("<")) {
      await ubApi.editStoreItem(settings.ubGuildId, ubItemId, {
        emoji_unicode: icon.emoji,
        emoji_id: null,
      });
    }
  } catch {
    // Local icon still applies as overlay.
  }
}

const ROLES_PAGE_SIZE = 8;

function formatCdShort(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 60)}m`;
}

function sortRoleLinksForAdmin(roles: Awaited<ReturnType<typeof listRoleLinks>>) {
  return [...roles].sort((a, b) => {
    const ai = Math.abs(a.incomeAmount ?? 0);
    const bi = Math.abs(b.incomeAmount ?? 0);
    if ((ai === 0) !== (bi === 0)) return ai === 0 ? 1 : -1;
    if (bi !== ai) return bi - ai;
    return a.name.localeCompare(b.name);
  });
}

async function renderRolesEconomy(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  guildId: string,
  flash?: string,
  page = 0,
): Promise<void> {
  const settings = await getOrCreateUbSettings(guildId);
  let syncNote = "";
  let roles = await listRoleLinks(guildId);
  if (isUbConfigured() && settings.enabled) {
    try {
      const synced = await syncUbStoreRoleLinks(guildId, settings.ubGuildId, interaction.guild);
      roles = synced.links;
      const bits: string[] = [];
      if (synced.created || synced.updated) {
        bits.push(`**${synced.created}** new · **${synced.updated}** updated`);
      }
      if (synced.seededCollect) {
        bits.push(`**${synced.seededCollect}** collect-ready`);
      }
      if (bits.length) syncNote = `Synced UB store → ${bits.join(" · ")}.`;
    } catch (err) {
      syncNote = `UB sync warning: ${err instanceof Error ? err.message : "failed"}`;
    }
  }

  const cds = readCooldowns(settings);
  const sorted = sortRoleLinksForAdmin(roles);
  const shopCount = sorted.filter(r => r.ubItemId || r.enabled).length;
  const linkedCount = sorted.filter(r => !r.ubItemId).length;
  const collectOn = sorted.filter(r => (r.incomeAmount ?? 0) !== 0).length;
  const totalPages = Math.max(1, Math.ceil(sorted.length / ROLES_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const pageRoles = sorted.slice(safePage * ROLES_PAGE_SIZE, (safePage + 1) * ROLES_PAGE_SIZE);

  const roleLines = pageRoles.map(r => {
    const kind = r.ubItemId ? "UB shop" : "linked";
    const cdSec = roleCollectCooldownSec(r, cds.collectSec);
    const income = (r.incomeAmount ?? 0) !== 0
      ? `collect **+${fmt(r.incomeAmount ?? 0)}** / ${formatCdShort(cdSec)}`
      : "collect **off**";
    return `${r.enabled ? "✅" : "⏸"} ${r.emoji || "✨"} **${r.name}** · ${fmt(r.price)} · ${income}` +
      (r.discordRoleId ? ` · <@&${r.discordRoleId}>` : "") +
      ` · _${kind}_`;
  }).join("\n") || "_No roles yet — **Sync UB** pulls shop roles, or **Add collect role** / **Add perk**._";

  const embed = new EmbedBuilder()
    .setColor(0xe91e8c)
    .setAuthor({ name: "Roles & economy", iconURL: UB_ICON })
    .setTitle("Shop roles · linked perks · collect")
    .setDescription(
      [
        flash ? `${flash}\n` : null,
        syncNote || null,
        `Store **${settings.storeEnabled !== false ? "on" : "off"}** · **${shopCount}** shop · **${linkedCount}** linked · **${collectOn}/${sorted.length}** collect-on`,
        `Default collect CD **${formatCdShort(cds.collectSec || 86400)}** (fallback when a role has no custom timer)`,
        "",
        "Open a role to set **income + per-role cooldown** (UB Role Income style), icon, actions.",
        "Sync seeds collect income for new/unset UB shop roles. Tune amounts to match your UB dashboard.",
      ].filter(Boolean).join("\n"),
    )
    .addFields({
      name: `Roles · page ${safePage + 1}/${totalPages} (${sorted.length})`,
      value: roleLines.slice(0, 1024) || "_None_",
    })
    .setFooter({ text: "Per-role collect timers · Sync seeds income · Discord icons" });

  const editChoices = pageRoles.slice(0, 25).map(r => {
    const emoji = resolveSelectEmoji(r.emoji || "✨");
    const cdMin = Math.round(roleCollectCooldownSec(r, cds.collectSec) / 60);
    return {
      label: `${r.name}`.slice(0, 100),
      description: `+${r.incomeAmount ?? 0} / ${cdMin}m · ${r.ubItemId ? "UB shop" : "linked"}`.slice(0, 100),
      value: String(r.id),
      ...(emoji ? { emoji } : {}),
    };
  });

  const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`ubadmin:re_page:${safePage - 1}`)
      .setLabel("◀ Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage <= 0),
    new ButtonBuilder()
      .setCustomId(`ubadmin:re_page:${safePage + 1}`)
      .setLabel("Next ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage >= totalPages - 1),
    new ButtonBuilder().setCustomId("ubadmin:re_refresh").setLabel("Sync UB").setEmoji("🔄").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ubadmin:re_seed_collect").setLabel("Seed collect").setEmoji("🏦").setStyle(ButtonStyle.Success),
  );

  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ubadmin:overview").setLabel("← Hub").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ubadmin:re_add_collect").setLabel("Add collect").setEmoji("🏦").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("ubadmin:re_economy").setLabel("Daily / defaults").setEmoji("⚙️").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("ubadmin:add_perk").setLabel("Add perk").setEmoji("✨").setStyle(ButtonStyle.Primary),
    ),
    nav,
  ];
  if (editChoices.length) {
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("ubadmin:re_edit_pick")
          .setPlaceholder(`Open a role (page ${safePage + 1}/${totalPages})…`)
          .addOptions(editChoices),
      ),
    );
  }

  await interaction.editReply({ embeds: [embed], components });
}

async function renderRoleDetail(
  interaction: ButtonInteraction | StringSelectMenuInteraction | RoleSelectMenuInteraction,
  guildId: string,
  linkId: number,
  flash?: string,
): Promise<void> {
  const settings = await getOrCreateUbSettings(guildId);
  const roles = await listRoleLinks(guildId);
  const row = roles.find(r => r.id === linkId);
  if (!row) {
    await renderRolesEconomy(interaction as ButtonInteraction | StringSelectMenuInteraction, guildId, "That role is gone.");
    return;
  }

  let actionsText = "_No UnbelievaBoat item linked — local perk only._";
  let reqsText = "_None_";
  let imageUrl: string | undefined;
  const meta = (row.meta ?? {}) as Record<string, unknown>;
  if (typeof meta.imageUrl === "string") imageUrl = meta.imageUrl;

  if (row.ubItemId && isUbConfigured() && settings.enabled) {
    try {
      const raw = await ubApi.getStoreItem(settings.ubGuildId, row.ubItemId);
      const guildEmoji = raw.emoji_id
        ? interaction.guild?.emojis.cache.get(raw.emoji_id) ?? null
        : null;
      const norm = normalizeUbItem(raw, {
        guildEmoji: guildEmoji
          ? { id: guildEmoji.id, name: guildEmoji.name || "item", animated: guildEmoji.animated }
          : null,
        overlayImageUrl: imageUrl,
      });
      actionsText = summarizeActions(norm.actions);
      reqsText = summarizeRequirements(norm.requirements);
      if (norm.imageUrl) imageUrl = norm.imageUrl;
    } catch (err) {
      actionsText = `⚠️ Couldn't load UB item: ${err instanceof Error ? err.message : "error"}`;
    }
  }

  const embed = new EmbedBuilder()
    .setColor(0xe91e8c)
    .setAuthor({ name: "Edit role", iconURL: UB_ICON })
    .setTitle(`${titleSafeStoreEmoji(row.emoji)} ${row.name}`)
    .setDescription(
      [
        flash ? `${flash}\n` : null,
        row.discordRoleId ? `Discord role: <@&${row.discordRoleId}>` : "_No Discord role_",
        row.ubItemId ? `UB item: \`${row.ubItemId}\`` : "_Local-only (not in UB store)_",
        `Price **${fmt(row.price)}** · Collect **${fmt(row.incomeAmount ?? 0)}** / **${Math.round(roleCollectCooldownSec(row, readCooldowns(settings).collectSec) / 60)}m** · ${row.enabled ? "✅ listed" : "⏸ hidden"}`,
      ].filter(Boolean).join("\n"),
    )
    .addFields(
      { name: "UB actions (on buy)", value: actionsText.slice(0, 1024) },
      { name: "UB requirements (to buy)", value: reqsText.slice(0, 1024) },
    )
    .setFooter({ text: "Per-role collect cooldown · Discord emoji/GIF pickers · UB actions" });
  if (imageUrl) applyStoreImageToEmbed(embed, imageUrl);

  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder | RoleSelectMenuBuilder>[] = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ubadmin:roles_economy").setLabel("← Roles list").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`ubadmin:re_price:${linkId}`).setLabel("Price / income").setEmoji("💰").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`ubadmin:re_icon:${linkId}`).setLabel("Icon").setEmoji("🖼️").setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`ubadmin:re_toggle_one:${linkId}`)
        .setLabel(row.enabled ? "Disable" : "Enable")
        .setStyle(row.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    ),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`ubadmin:re_action:${linkId}`)
        .setPlaceholder("Set UB buy action…")
        .addOptions(
          { label: "Add roles on buy", value: "add_roles", emoji: "➕", description: "UB action: ADD_ROLES" },
          { label: "Remove roles on buy", value: "remove_roles", emoji: "➖", description: "UB action: REMOVE_ROLES" },
          { label: "Add cash on buy", value: "add_balance", emoji: "💵", description: "UB action: ADD_BALANCE" },
          { label: "Clear all actions", value: "clear_actions", emoji: "🧹", description: "Remove UB actions" },
        ),
    ),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`ubadmin:re_req:${linkId}`)
        .setPlaceholder("Set UB buy requirement…")
        .addOptions(
          { label: "Must have all roles", value: "role_every", emoji: "🛡️", description: "Requirement: ROLE · EVERY" },
          { label: "Must have any role", value: "role_any", emoji: "🛡️", description: "Requirement: ROLE · AT_LEAST_ONE" },
          { label: "Must have none of roles", value: "role_none", emoji: "🚫", description: "Requirement: ROLE · NONE" },
          { label: "Min total balance…", value: "balance", emoji: "💰", description: "Requirement: TOTAL_BALANCE" },
          { label: "Clear requirements", value: "clear_reqs", emoji: "🧹", description: "Remove UB requirements" },
        ),
    ),
  ];

  await interaction.editReply({ embeds: [embed], components });
}

async function renderStoreAdmin(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  guildId: string,
  flash?: string,
): Promise<void> {
  const [catalog, roles, audit] = await Promise.all([
    listCatalog(guildId),
    listRoleLinks(guildId),
    listUbAudit(guildId, 5),
  ]);

  const roleLines = roles.slice(0, 15).map(r => {
    const m = (r.meta ?? {}) as Record<string, unknown>;
    const img = typeof m.imageUrl === "string" ? m.imageUrl : typeof m.iconGif === "string" ? m.iconGif : null;
    return `${r.enabled ? "✅" : "⏸"} ${r.emoji || "✨"} **${r.name}** — ${fmt(r.price)} cash` +
      (r.incomeAmount > 0 ? ` · income ${fmt(r.incomeAmount)}` : "") +
      (img ? " · 🖼️" : "") +
      (r.discordRoleId ? ` · <@&${r.discordRoleId}>` : "");
  }).join("\n") || "_No role perks yet — use **Add perk**._";

  const catLines = catalog.slice(0, 10).map(c =>
    `${c.listed ? "✅" : "⏸"} ${c.emoji || "🛒"} **${c.name}** — ${fmt(c.price)} cash` +
    (c.forPets ? " · pets" : "") +
    (c.grantRoleId ? ` · <@&${c.grantRoleId}>` : ""),
  ).join("\n") || "_No catalog drafts._";

  const auditLines = audit.map(a =>
    `• \`${a.action}\` · <@${a.actorId.replace(/^dash:/, "")}> · <t:${Math.floor(new Date(a.createdAt).getTime() / 1000)}:R>`,
  ).join("\n") || "_No audit yet._";

  const thumb = roles
    .map(r => {
      const m = (r.meta as Record<string, unknown> | null) ?? {};
      return typeof m.imageUrl === "string" ? m.imageUrl : typeof m.iconGif === "string" ? m.iconGif : null;
    })
    .find((u): u is string => typeof u === "string" && u.length > 8);

  const embed = new EmbedBuilder()
    .setColor(0xe91e8c)
    .setAuthor({ name: "UnbelievaBoat store", iconURL: UB_ICON })
    .setTitle("Current perk store")
    .setDescription(
      [
        flash ? `${flash}\n` : null,
        "Players browse with **`/casino` → Store**.",
        "🖼️ = image/GIF icon set · custom emoji (`<:name:id>`) render in menus and embeds.",
      ].filter(Boolean).join("\n"),
    )
    .addFields(
      { name: `Role perks (${roles.length})`, value: roleLines.slice(0, 1000) || "_None_" },
      { name: `Catalog (${catalog.length})`, value: catLines.slice(0, 1000) || "_None_" },
      { name: "Recent audit", value: auditLines.slice(0, 1000) || "_None_" },
    )
    .setFooter({ text: "Remove · change icon · add perk below" });
  if (thumb) applyStoreImageToEmbed(embed, thumb);

  const removeChoices = [
    ...roles.slice(0, 20).map(r => {
      const emoji = resolveSelectEmoji(r.emoji || "✨");
      return {
        label: `Remove · ${r.name}`.slice(0, 100),
        description: `${r.price} cash · role perk`.slice(0, 100),
        value: `role:${r.id}`,
        ...(emoji ? { emoji } : {}),
      };
    }),
    ...catalog.filter(c => !c.forPets).slice(0, 5).map(c => {
      const emoji = resolveSelectEmoji(c.emoji || "🛒");
      return {
        label: `Remove · ${c.name}`.slice(0, 100),
        description: `${c.price} cash · catalog`.slice(0, 100),
        value: `cat:${c.id}`,
        ...(emoji ? { emoji } : {}),
      };
    }),
  ].slice(0, 25);

  const iconChoices = roles.slice(0, 25).map(r => {
    const emoji = resolveSelectEmoji(r.emoji || "✨");
    const m = (r.meta ?? {}) as Record<string, unknown>;
    const hasImg = typeof m.imageUrl === "string" || typeof m.iconGif === "string";
    return {
      label: `Icon · ${r.name}`.slice(0, 100),
      description: (hasImg ? "Has icon · Discord emoji / GIF / defaults" : "No icon yet · Discord emoji / GIF / defaults").slice(0, 100),
      value: `role:${r.id}`,
      ...(emoji ? { emoji } : {}),
    };
  });

  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [...storeNavRows()];
  if (removeChoices.length) {
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("ubadmin:store_remove_pick")
          .setPlaceholder("Remove a store item…")
          .addOptions(removeChoices),
      ),
    );
  }
  if (iconChoices.length) {
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("ubadmin:store_icon_pick")
          .setPlaceholder("Change icon for a perk…")
          .addOptions(iconChoices),
      ),
    );
  }

  await interaction.editReply({ embeds: [embed], components });
}

export async function handleUbAdminCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "Server only.", ...EPHEMERAL });
    return;
  }
  await interaction.deferReply(EPHEMERAL);
  const embed = await buildOverviewEmbed(interaction.guildId);
  await interaction.editReply({ embeds: [embed], components: hubRows() });
}

export async function handleUbAdminComponent(
  interaction: ButtonInteraction | StringSelectMenuInteraction | UserSelectMenuInteraction | RoleSelectMenuInteraction | ChannelSelectMenuInteraction,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "Server only.", ...EPHEMERAL });
    return;
  }
  if (!interaction.memberPermissions?.has("Administrator")) {
    await interaction.reply({ content: "Administrator only.", ...EPHEMERAL });
    return;
  }

  const id = interaction.customId;

  if (id === "ubadmin:overview" && interaction.isButton()) {
    await interaction.deferUpdate();
    const embed = await buildOverviewEmbed(guildId);
    await interaction.editReply({ embeds: [embed], components: hubRows() });
    return;
  }

  if (id === "ubadmin:leaderboard" && interaction.isButton()) {
    await interaction.deferUpdate();
    const settings = await getOrCreateUbSettings(guildId);
    let lines = "_Configure `UNBELIEVABOAT_TOKEN` and enable the UnbelievaBoat API link._";
    if (isUbConfigured() && settings.enabled) {
      try {
        const raw = await ubApi.getLeaderboard(settings.ubGuildId, {
          sort: settings.leaderboardSort as "cash" | "bank" | "total",
          limit: 10,
          page: 1,
        });
        const users = Array.isArray(raw) ? raw : raw.users ?? [];
        lines = users.length
          ? users.map((u, i) =>
            `**${i + 1}.** <@${u.user_id}> — cash ${fmt(u.cash)} · bank ${fmt(u.bank)} · total **${fmt(u.total)}**`,
          ).join("\n")
          : "_No balances yet._";
      } catch (err) {
        lines = `⚠️ ${err instanceof Error ? err.message : "Leaderboard failed"}`;
      }
    }
    const embed = new EmbedBuilder()
      .setColor(0xe91e8c)
      .setAuthor({ name: "UnbelievaBoat cash board", iconURL: UB_ICON })
      .setTitle(`Top balances (${settings.leaderboardSort})`)
      .setDescription(lines);
    const sortMenu = new StringSelectMenuBuilder()
      .setCustomId("ubadmin:sort")
      .setPlaceholder("Sort leaderboard by…")
      .addOptions(
        { label: "Total", value: "total" },
        { label: "Cash", value: "cash" },
        { label: "Bank", value: "bank" },
      );
    await interaction.editReply({
      embeds: [embed],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sortMenu),
        ...hubRows(),
      ],
    });
    return;
  }

  if (id === "ubadmin:sort" && interaction.isStringSelectMenu()) {
    await interaction.deferUpdate();
    const sort = interaction.values[0] as "cash" | "bank" | "total";
    await updateUbSettings(guildId, { leaderboardSort: sort });
    await writeUbAudit(guildId, interaction.user.id, "discord_sort", { sort });
    const settings = await getOrCreateUbSettings(guildId);
    let lines = "_Configure `UNBELIEVABOAT_TOKEN` and enable the UnbelievaBoat API link._";
    if (isUbConfigured() && settings.enabled) {
      try {
        const raw = await ubApi.getLeaderboard(settings.ubGuildId, { sort, limit: 10, page: 1 });
        const users = Array.isArray(raw) ? raw : raw.users ?? [];
        lines = users.length
          ? users.map((u, i) =>
            `**${i + 1}.** <@${u.user_id}> — cash ${fmt(u.cash)} · bank ${fmt(u.bank)} · total **${fmt(u.total)}**`,
          ).join("\n")
          : "_No balances yet._";
      } catch (err) {
        lines = `⚠️ ${err instanceof Error ? err.message : "Leaderboard failed"}`;
      }
    }
    const embed = new EmbedBuilder()
      .setColor(0xe91e8c)
      .setAuthor({ name: "UnbelievaBoat cash board", iconURL: UB_ICON })
      .setTitle(`Top balances (${sort})`)
      .setDescription(lines);
    const sortMenu = new StringSelectMenuBuilder()
      .setCustomId("ubadmin:sort")
      .setPlaceholder("Sort leaderboard by…")
      .addOptions(
        { label: "Total", value: "total" },
        { label: "Cash", value: "cash" },
        { label: "Bank", value: "bank" },
      );
    await interaction.editReply({
      embeds: [embed],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sortMenu),
        ...hubRows(),
      ],
    });
    return;
  }

  if (id === "ubadmin:pets" && interaction.isButton()) {
    await interaction.deferUpdate();
    const petSettings = await getOrCreatePetSettings(guildId);
    const top = await petLeaderboard(guildId, 8);
    const lines = top.length
      ? top.map((p, i) => `**${i + 1}.** **${p.name}** <@${p.userId}> · ${p.stage} · PWR ${p.power}`).join("\n")
      : "_No living pets._";
    const embed = new EmbedBuilder()
      .setColor(0xf5c84c)
      .setAuthor({ name: "UnbelievaBoat · Pets", iconURL: UB_ICON })
      .setTitle("Pet addon")
      .setDescription(
        [
          `Enabled **${petSettings.enabled ? "yes" : "no"}** · hatch **${petSettings.hatchCost}** cash · growth **${petSettings.growthHours}h** · max neglects **${petSettings.maxNeglects}** · wager **${petSettings.challengeWager}**`,
          "",
          lines,
          "",
          "Deep resets: `/petadmin reset` · `/petadmin crack`",
        ].join("\n"),
      );
    await interaction.editReply({ embeds: [embed], components: hubRows() });
    return;
  }

  if (id === "ubadmin:store" && interaction.isButton()) {
    await interaction.deferUpdate();
    await renderStoreAdmin(interaction, guildId);
    return;
  }

  if (id === "ubadmin:store_refresh" && interaction.isButton()) {
    await interaction.deferUpdate();
    await renderStoreAdmin(interaction, guildId);
    return;
  }

  if (id === "ubadmin:store_remove_pick" && interaction.isStringSelectMenu()) {
    await interaction.deferUpdate();
    const value = interaction.values[0]!;
    let removedName = value;
    if (value.startsWith("role:")) {
      const linkId = Number(value.slice(5));
      const roles = await listRoleLinks(guildId);
      const hit = roles.find(r => r.id === linkId);
      removedName = hit?.name ?? value;
      await deleteRoleLink(guildId, linkId);
      await writeUbAudit(guildId, interaction.user.id, "discord_perk_remove", { kind: "role", id: linkId, name: removedName });
    } else if (value.startsWith("cat:")) {
      const catId = Number(value.slice(4));
      const catalog = await listCatalog(guildId);
      const hit = catalog.find(c => c.id === catId);
      removedName = hit?.name ?? value;
      await deleteCatalogItem(guildId, catId);
      await writeUbAudit(guildId, interaction.user.id, "discord_perk_remove", { kind: "catalog", id: catId, name: removedName });
    }
    await renderStoreAdmin(interaction, guildId, `🗑️ Removed **${removedName}** from the store.`);
    return;
  }

  if (id === "ubadmin:store_icon_pick" && interaction.isStringSelectMenu()) {
    await interaction.deferUpdate();
    const value = interaction.values[0]!;
    if (!value.startsWith("role:")) {
      await interaction.followUp({ content: "Only role perks support icons here.", ...EPHEMERAL });
      return;
    }
    const linkId = Number(value.slice(5));
    const roles = await listRoleLinks(guildId);
    const row = roles.find(r => r.id === linkId);
    if (!row) {
      await renderStoreAdmin(interaction, guildId, "That perk is gone.");
      return;
    }
    const picker = buildPerkIconPicker(linkId, row.name, row.emoji || "✨", interaction.guild);
    await interaction.followUp({ ...picker, ...EPHEMERAL });
    return;
  }

  if (id === "ubadmin:roles_economy" && interaction.isButton()) {
    await interaction.deferUpdate();
    await renderRolesEconomy(interaction, guildId);
    return;
  }

  if (id === "ubadmin:re_refresh" && interaction.isButton()) {
    await interaction.deferUpdate();
    await renderRolesEconomy(interaction, guildId);
    return;
  }

  if (id.startsWith("ubadmin:re_page:") && interaction.isButton()) {
    await interaction.deferUpdate();
    const page = Number(id.split(":")[2]) || 0;
    await renderRolesEconomy(interaction, guildId, undefined, page);
    return;
  }

  if (id === "ubadmin:re_seed_collect" && interaction.isButton()) {
    await interaction.deferUpdate();
    const settings = await getOrCreateUbSettings(guildId);
    const cds = readCooldowns(settings);
    const roles = await listRoleLinks(guildId);
    let seeded = 0;
    for (const row of roles) {
      const meta = { ...(row.meta as Record<string, unknown>) };
      if (meta.collectIncomeSet === true) continue;
      if ((row.incomeAmount ?? 0) !== 0) continue;
      const income = suggestedCollectIncome(row.price);
      if (typeof meta.collectCooldownSec !== "number") {
        meta.collectCooldownSec = cds.collectSec;
      }
      meta.collectIncomeSeeded = true;
      await updateRoleLink(guildId, row.id, {
        incomeAmount: income,
        meta,
      });
      seeded += 1;
    }
    await writeUbAudit(guildId, interaction.user.id, "discord_collect_seed", { seeded });
    await renderRolesEconomy(
      interaction,
      guildId,
      seeded
        ? `Seeded collect on **${seeded}** role(s) (~1% of shop price, default CD). Tune each role to match UB Role Income.`
        : "Every unset role already has collect income (or was locked by an admin).",
    );
    return;
  }

  if (id === "ubadmin:re_add_collect" && interaction.isButton()) {
    const roleMenu = new RoleSelectMenuBuilder()
      .setCustomId("ubadmin:re_add_collect_role")
      .setPlaceholder("Which Discord role should pay on Collect?")
      .setMaxValues(1);
    await interaction.reply({
      content:
        "Pick any server role to add as a **collect income** role (works like UnbelievaBoat Role Income).\n" +
        "After adding, set **income** + **cooldown minutes** (match UB’s timer).",
      components: [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleMenu)],
      ...EPHEMERAL,
    });
    return;
  }

  if (id === "ubadmin:re_add_collect_role" && interaction.isRoleSelectMenu()) {
    const roleId = interaction.values[0]!;
    const role = interaction.guild?.roles.cache.get(roleId);
    const existing = (await listRoleLinks(guildId)).find(r => r.discordRoleId === roleId);
    if (existing) {
      await interaction.reply({
        content: `<@&${roleId}> is already linked as **${existing.name}**. Open it in Roles & economy to set income/cooldown.`,
        ...EPHEMERAL,
      });
      return;
    }
    const settings = await getOrCreateUbSettings(guildId);
    const cdSec = readCooldowns(settings).collectSec;
    const modal = new ModalBuilder()
      .setCustomId(`ubadmin:re_add_collect_modal:${roleId}`)
      .setTitle("New collect role");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("name")
          .setLabel("Display name")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(80)
          .setValue((role?.name || "Collect role").slice(0, 80)),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("income")
          .setLabel("Collect income per claim")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue("1000"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("cooldown_min")
          .setLabel("Collect cooldown (minutes)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(Math.round(cdSec / 60))),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("emoji")
          .setLabel("Emoji (Discord picker paste)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(80)
          .setValue("✨"),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (id === "ubadmin:re_edit_pick" && interaction.isStringSelectMenu()) {
    await interaction.deferUpdate();
    const linkId = Number(interaction.values[0]);
    await renderRoleDetail(interaction, guildId, linkId);
    return;
  }

  if (id.startsWith("ubadmin:re_price:") && interaction.isButton()) {
    const linkId = Number(id.split(":")[2]);
    const roles = await listRoleLinks(guildId);
    const row = roles.find(r => r.id === linkId);
    if (!row) {
      await interaction.reply({ content: "That role is gone.", ...EPHEMERAL });
      return;
    }
    const settings = await getOrCreateUbSettings(guildId);
    const defaultCdMin = Math.round(readCooldowns(settings).collectSec / 60);
    const meta = (row.meta ?? {}) as Record<string, unknown>;
    const cdSec = roleCollectCooldownSec(row, readCooldowns(settings).collectSec);
    const modal = new ModalBuilder()
      .setCustomId(`ubadmin:re_edit_modal:${linkId}`)
      .setTitle("Price · income · cooldown");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("price")
          .setLabel("Store price (cash)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(12)
          .setValue(String(row.price)),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("income")
          .setLabel("Collect income per claim (0 = off)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(12)
          .setValue(String(row.incomeAmount ?? 0)),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("cooldown_min")
          .setLabel(`This role collect CD minutes (UB-style)`)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(8)
          .setValue(String(Math.round(cdSec / 60)))
          .setPlaceholder(`Per-role timer; guild default ${defaultCdMin}m`),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("description")
          .setLabel("Short description")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(100)
          .setValue((row.description || "").slice(0, 100)),
      ),
    );
    void meta;
    await interaction.showModal(modal);
    return;
  }

  if (id.startsWith("ubadmin:re_icon:") && interaction.isButton()) {
    await interaction.deferUpdate();
    const linkId = Number(id.split(":")[2]);
    const roles = await listRoleLinks(guildId);
    const row = roles.find(r => r.id === linkId);
    if (!row) {
      await renderRolesEconomy(interaction, guildId, "That role is gone.");
      return;
    }
    const picker = buildPerkIconPicker(linkId, row.name, row.emoji || "✨", interaction.guild);
    await interaction.editReply({
      content: "Tap **Pick in chat** and use Discord’s emoji/GIF bar — or browse server emoji / Upload GIF.",
      ...picker,
    });
    return;
  }

  if (id.startsWith("ubadmin:re_toggle_one:") && interaction.isButton()) {
    await interaction.deferUpdate();
    const linkId = Number(id.split(":")[2]);
    const roles = await listRoleLinks(guildId);
    const row = roles.find(r => r.id === linkId);
    if (!row) {
      await renderRolesEconomy(interaction, guildId, "That role is gone.");
      return;
    }
    await updateRoleLink(guildId, linkId, { enabled: !row.enabled });
    if (row.ubItemId && isUbConfigured()) {
      const settings = await getOrCreateUbSettings(guildId);
      try {
        await ubApi.editStoreItem(settings.ubGuildId, row.ubItemId, { is_listed: !row.enabled });
      } catch { /* local toggle still applies */ }
    }
    await renderRoleDetail(interaction, guildId, linkId, `${!row.enabled ? "✅ Enabled" : "⏸ Disabled"} **${row.name}**.`);
    return;
  }

  if (id.startsWith("ubadmin:re_action:") && interaction.isStringSelectMenu()) {
    const linkId = Number(id.split(":")[2]);
    const choice = interaction.values[0]!;
    const roles = await listRoleLinks(guildId);
    const row = roles.find(r => r.id === linkId);
    if (!row?.ubItemId) {
      await interaction.reply({
        content: "Link this perk to an UnbelievaBoat store item first (Add perk with sync, or refresh sync from UB store).",
        ...EPHEMERAL,
      });
      return;
    }
    if (choice === "clear_actions") {
      await interaction.deferUpdate();
      const settings = await getOrCreateUbSettings(guildId);
      await ubApi.editStoreItem(settings.ubGuildId, row.ubItemId, { actions: [] });
      await writeUbAudit(guildId, interaction.user.id, "ub_actions_clear", { id: linkId, ubItemId: row.ubItemId });
      await renderRoleDetail(interaction, guildId, linkId, "Cleared UnbelievaBoat actions.");
      return;
    }
    if (choice === "add_balance") {
      const modal = new ModalBuilder()
        .setCustomId(`ubadmin:re_balance_action:${linkId}`)
        .setTitle("Add cash on buy");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("balance")
            .setLabel("Cash to add when bought")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue("100"),
        ),
      );
      await interaction.showModal(modal);
      return;
    }
    // Role-based actions — ask for roles via RoleSelect
    const roleMenu = new RoleSelectMenuBuilder()
      .setCustomId(`ubadmin:re_action_roles:${linkId}:${choice}`)
      .setPlaceholder(choice === "add_roles" ? "Roles to grant on buy…" : "Roles to remove on buy…")
      .setMinValues(1)
      .setMaxValues(10);
    await interaction.reply({
      content: choice === "add_roles"
        ? "Pick roles UnbelievaBoat should **grant** when this item is bought:"
        : "Pick roles UnbelievaBoat should **remove** when this item is bought:",
      components: [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleMenu)],
      ...EPHEMERAL,
    });
    return;
  }

  if (id.startsWith("ubadmin:re_action_roles:") && interaction.isRoleSelectMenu()) {
    await interaction.deferUpdate();
    const partsId = id.split(":");
    const linkId = Number(partsId[2]);
    const kind = partsId[3]!;
    const roles = await listRoleLinks(guildId);
    const row = roles.find(r => r.id === linkId);
    if (!row?.ubItemId) {
      await interaction.editReply({ content: "That UB item is gone.", components: [] });
      return;
    }
    const settings = await getOrCreateUbSettings(guildId);
    const roleIds = interaction.values;
    const actionType = kind === "remove_roles" ? UbAction.REMOVE_ROLES : UbAction.ADD_ROLES;
    // Keep non-role actions; replace role edit actions of same type.
    let existing: ReturnType<typeof parseActions> = [];
    try {
      const raw = await ubApi.getStoreItem(settings.ubGuildId, row.ubItemId);
      existing = parseActions(raw.actions).filter(a => a.type !== UbAction.ADD_ROLES && a.type !== UbAction.REMOVE_ROLES);
    } catch { /* start fresh */ }
    const actions = [...existing, { type: actionType, ids: roleIds }];
    await ubApi.editStoreItem(settings.ubGuildId, row.ubItemId, { actions });
    if (kind === "add_roles" && roleIds[0] && row.discordRoleId !== roleIds[0]) {
      await updateRoleLink(guildId, linkId, { discordRoleId: roleIds[0] });
    }
    await writeUbAudit(guildId, interaction.user.id, "ub_actions_set", { id: linkId, actionType, roleIds });
    await interaction.editReply({
      content: `Updated UB buy action: **${kind === "remove_roles" ? "remove" : "add"}** ${roleIds.map(r => `<@&${r}>`).join(" ")}. Re-open the role from **Roles & economy** to refresh.`,
      components: [],
    });
    return;
  }

  if (id.startsWith("ubadmin:re_req:") && interaction.isStringSelectMenu()) {
    const linkId = Number(id.split(":")[2]);
    const choice = interaction.values[0]!;
    const roles = await listRoleLinks(guildId);
    const row = roles.find(r => r.id === linkId);
    if (!row?.ubItemId) {
      await interaction.reply({
        content: "This perk needs an UnbelievaBoat store item to set requirements.",
        ...EPHEMERAL,
      });
      return;
    }
    if (choice === "clear_reqs") {
      await interaction.deferUpdate();
      const settings = await getOrCreateUbSettings(guildId);
      await ubApi.editStoreItem(settings.ubGuildId, row.ubItemId, { requirements: [] });
      await writeUbAudit(guildId, interaction.user.id, "ub_reqs_clear", { id: linkId });
      await renderRoleDetail(interaction, guildId, linkId, "Cleared UnbelievaBoat requirements.");
      return;
    }
    if (choice === "balance") {
      const modal = new ModalBuilder()
        .setCustomId(`ubadmin:re_req_balance:${linkId}`)
        .setTitle("Min total balance to buy");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("balance")
            .setLabel("Minimum total balance")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue("1000"),
        ),
      );
      await interaction.showModal(modal);
      return;
    }
    const match =
      choice === "role_any" ? "any"
        : choice === "role_none" ? "none"
          : "every";
    const roleMenu = new RoleSelectMenuBuilder()
      .setCustomId(`ubadmin:re_req_roles:${linkId}:${match}`)
      .setPlaceholder("Roles for this requirement…")
      .setMinValues(1)
      .setMaxValues(10);
    await interaction.reply({
      content:
        match === "every" ? "Buyer must have **all** of these roles:"
          : match === "any" ? "Buyer must have **at least one** of these roles:"
            : "Buyer must have **none** of these roles:",
      components: [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleMenu)],
      ...EPHEMERAL,
    });
    return;
  }

  if (id.startsWith("ubadmin:re_req_roles:") && interaction.isRoleSelectMenu()) {
    await interaction.deferUpdate();
    const partsId = id.split(":");
    const linkId = Number(partsId[2]);
    const match = partsId[3]!;
    const roles = await listRoleLinks(guildId);
    const row = roles.find(r => r.id === linkId);
    if (!row?.ubItemId) {
      await interaction.editReply({ content: "That UB item is gone.", components: [] });
      return;
    }
    const settings = await getOrCreateUbSettings(guildId);
    const matchType =
      match === "any" ? UbMatch.AT_LEAST_ONE
        : match === "none" ? UbMatch.NONE
          : UbMatch.EVERY;
    let existing = parseRequirements([]);
    try {
      const raw = await ubApi.getStoreItem(settings.ubGuildId, row.ubItemId);
      existing = parseRequirements(raw.requirements).filter(r => r.type !== UbReq.ROLE);
    } catch { /* empty */ }
    const requirements = [
      ...existing,
      { type: UbReq.ROLE, match_type: matchType, ids: interaction.values },
    ];
    await ubApi.editStoreItem(settings.ubGuildId, row.ubItemId, { requirements });
    await writeUbAudit(guildId, interaction.user.id, "ub_reqs_set", { id: linkId, match, ids: interaction.values });
    await interaction.editReply({
      content: `Updated UB role requirement. Re-open the role from **Roles & economy** to refresh.`,
      components: [],
    });
    return;
  }

  if (id === "ubadmin:re_economy" && interaction.isButton()) {
    const s = await getOrCreateUbSettings(guildId);
    const cds = readCooldowns(s);
    const modal = new ModalBuilder()
      .setCustomId("ubadmin:re_economy_modal")
      .setTitle("Daily & default collect CD");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("daily_min")
          .setLabel("Daily check-in min cash")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(s.dailyMin ?? 100)),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("daily_max")
          .setLabel("Daily check-in max cash")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(s.dailyMax ?? 250)),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("collect_cd")
          .setLabel("Default role-collect CD (minutes)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(Math.max(1, Math.round((cds.collectSec || 86400) / 60))))
          .setPlaceholder("Fallback only — each role can override (UB style)"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("sort")
          .setLabel("Leaderboard sort (cash|bank|total)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(s.leaderboardSort || "total"),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (id === "ubadmin:logs" && interaction.isButton()) {
    await interaction.deferUpdate();
    const s = await getOrCreateUbSettings(guildId);
    const embed = new EmbedBuilder()
      .setColor(0xe91e8c)
      .setAuthor({ name: "UnbelievaBoat logs", iconURL: UB_ICON })
      .setTitle("Economy / casino log channel")
      .setDescription(
        [
          `Current: **${s.logChannelId ? `<#${s.logChannelId}>` : "not set"}**`,
          "",
          "Posts clean logs with user avatar, time, and action for deposits, collects, games, rob, admin cash edits.",
          "Pick a text channel below (or clear).",
        ].join("\n"),
      );
    const pick = new ChannelSelectMenuBuilder()
      .setCustomId("ubadmin:log_channel")
      .setPlaceholder("Select log channel…")
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setMaxValues(1);
    const clear = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ubadmin:log_clear").setLabel("Clear log channel").setStyle(ButtonStyle.Danger),
    );
    await interaction.editReply({
      embeds: [embed],
      components: [
        new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(pick),
        clear,
        ...hubRows(),
      ],
    });
    return;
  }

  if (id === "ubadmin:log_channel" && interaction.isChannelSelectMenu()) {
    await interaction.deferUpdate();
    const channelId = interaction.values[0]!;
    await updateUbSettings(guildId, { logChannelId: channelId });
    await writeUbAudit(guildId, interaction.user.id, "discord_log_channel", { channelId });
    const embed = new EmbedBuilder()
      .setColor(0xe91e8c)
      .setAuthor({ name: "UnbelievaBoat logs", iconURL: UB_ICON })
      .setTitle("Log channel set")
      .setDescription(`Casino / economy logs → <#${channelId}>`);
    await interaction.editReply({ embeds: [embed], components: hubRows() });
    return;
  }

  if (id === "ubadmin:log_clear" && interaction.isButton()) {
    await interaction.deferUpdate();
    await updateUbSettings(guildId, { logChannelId: null });
    await writeUbAudit(guildId, interaction.user.id, "discord_log_clear", {});
    const embed = await buildOverviewEmbed(guildId);
    embed.setDescription(`${embed.data.description ?? ""}\n\n✅ Log channel cleared.`);
    await interaction.editReply({ embeds: [embed], components: hubRows() });
    return;
  }

  if (id === "ubadmin:immunity" && interaction.isButton()) {
    await interaction.deferUpdate();
    const s = await getOrCreateUbSettings(guildId);
    const ids = s.robImmuneRoleIds ?? [];
    const embed = new EmbedBuilder()
      .setColor(0xe91e8c)
      .setAuthor({ name: "Rob immunity", iconURL: UB_ICON })
      .setTitle("Roles that cannot be robbed")
      .setDescription(
        [
          ids.length ? ids.map(r => `• <@&${r}>`).join("\n") : "_None yet._",
          "",
          "`/casino rob` checks these before a stick-up. Pick roles to **replace** the list.",
        ].join("\n"),
      );
    const pick = new RoleSelectMenuBuilder()
      .setCustomId("ubadmin:immune_roles")
      .setPlaceholder("Select immunity roles…")
      .setMinValues(1)
      .setMaxValues(10);
    const clear = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ubadmin:immune_clear").setLabel("Clear immunity").setStyle(ButtonStyle.Danger),
    );
    await interaction.editReply({
      embeds: [embed],
      components: [
        new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(pick),
        clear,
        ...hubRows(),
      ],
    });
    return;
  }

  if (id === "ubadmin:immune_roles" && interaction.isRoleSelectMenu()) {
    await interaction.deferUpdate();
    const ids = interaction.values;
    await updateUbSettings(guildId, { robImmuneRoleIds: ids });
    await writeUbAudit(guildId, interaction.user.id, "discord_rob_immunity", { ids });
    const embed = new EmbedBuilder()
      .setColor(0xe91e8c)
      .setAuthor({ name: "Rob immunity", iconURL: UB_ICON })
      .setTitle("Immunity updated")
      .setDescription(ids.length ? ids.map(r => `• <@&${r}>`).join("\n") : "_Cleared._");
    await interaction.editReply({ embeds: [embed], components: hubRows() });
    return;
  }

  if (id === "ubadmin:immune_clear" && interaction.isButton()) {
    await interaction.deferUpdate();
    await updateUbSettings(guildId, { robImmuneRoleIds: [] });
    await writeUbAudit(guildId, interaction.user.id, "discord_rob_immunity_clear", {});
    const embed = await buildOverviewEmbed(guildId);
    embed.setDescription(`${embed.data.description ?? ""}\n\n✅ Rob immunity roles cleared.`);
    await interaction.editReply({ embeds: [embed], components: hubRows() });
    return;
  }

  if (id === "ubadmin:toggle_ub" && interaction.isButton()) {
    await interaction.deferUpdate();
    const s = await getOrCreateUbSettings(guildId);
    const next = !s.enabled;
    await updateUbSettings(guildId, { enabled: next });
    await writeUbAudit(guildId, interaction.user.id, "discord_toggle_ub", { enabled: next });
    const embed = await buildOverviewEmbed(guildId);
    embed.setDescription(`${embed.data.description ?? ""}\n\n✅ UnbelievaBoat API link is now **${next ? "on" : "off"}**.`);
    await interaction.editReply({ embeds: [embed], components: hubRows() });
    return;
  }

  if (id === "ubadmin:toggle_pets_spend" && interaction.isButton()) {
    await interaction.deferUpdate();
    const s = await getOrCreateUbSettings(guildId);
    const next = !s.petsSpendUb;
    await updateUbSettings(guildId, { petsSpendUb: next });
    await writeUbAudit(guildId, interaction.user.id, "discord_toggle_pets_spend", { petsSpendUb: next });
    const embed = await buildOverviewEmbed(guildId);
    embed.setDescription(`${embed.data.description ?? ""}\n\n✅ Pet shop/hatch cash spend is now **${next ? "on" : "off"}**.`);
    await interaction.editReply({ embeds: [embed], components: hubRows() });
    return;
  }

  if (id === "ubadmin:toggle_games" && interaction.isButton()) {
    await interaction.deferUpdate();
    const s = await getOrCreateUbSettings(guildId);
    const next = !(s.gamesEnabled !== false);
    await updateUbSettings(guildId, { gamesEnabled: next });
    await writeUbAudit(guildId, interaction.user.id, "discord_toggle_games", { gamesEnabled: next });
    const embed = await buildOverviewEmbed(guildId);
    embed.setDescription(`${embed.data.description ?? ""}\n\n✅ Mini-games are now **${next ? "on" : "off"}**.`);
    await interaction.editReply({ embeds: [embed], components: hubRows() });
    return;
  }

  if (id === "ubadmin:toggle_store" && interaction.isButton()) {
    await interaction.deferUpdate();
    const s = await getOrCreateUbSettings(guildId);
    const next = !(s.storeEnabled !== false);
    await updateUbSettings(guildId, { storeEnabled: next });
    await writeUbAudit(guildId, interaction.user.id, "discord_toggle_store", { storeEnabled: next });
    const embed = await buildOverviewEmbed(guildId);
    embed.setDescription(`${embed.data.description ?? ""}\n\n✅ Perk store is now **${next ? "on" : "off"}**.`);
    await interaction.editReply({ embeds: [embed], components: hubRows() });
    return;
  }

  if (id === "ubadmin:casino_station" || id === "ubadmin:cooldowns") {
    await interaction.deferUpdate();
    const { embeds, components } = await buildCasinoStation(guildId);
    await interaction.editReply({ embeds, components });
    return;
  }

  if (id === "ubadmin:station_reset" && interaction.isButton()) {
    await interaction.deferUpdate();
    const { DEFAULT_COOLDOWNS } = await import("./cooldowns.js");
    const { DEFAULT_PAYOUTS } = await import("./payouts.js");
    await updateUbSettings(guildId, {
      cooldowns: { ...DEFAULT_COOLDOWNS },
      payouts: { ...DEFAULT_PAYOUTS },
      dailyMin: DEFAULT_PAYOUTS.dailyMin,
      dailyMax: DEFAULT_PAYOUTS.dailyMax,
    });
    await writeUbAudit(guildId, interaction.user.id, "discord_station_reset", {});
    const { embeds, components } = await buildCasinoStation(guildId, "✅ Reset all cooldowns + payouts to factory defaults.");
    await interaction.editReply({ embeds, components });
    return;
  }

  if (id === "ubadmin:station_pick" && interaction.isStringSelectMenu()) {
    const kind = interaction.values[0]!;
    const { readCooldowns, formatCooldownInput } = await import("./cooldowns.js");
    const { readPayouts } = await import("./payouts.js");
    const s = await getOrCreateUbSettings(guildId);
    const cds = readCooldowns(s);
    const pay = readPayouts(s);
    const cdField = (sec: number) =>
      textField("cd", "Cooldown (30m / 4h / daily / or minutes)", formatCooldownInput(sec));

    if (kind === "daily") {
      const modal = new ModalBuilder().setCustomId("ubadmin:station_modal:daily").setTitle("Daily — CD + payout");
      modal.addComponents(
        cdField(cds.dailySec),
        numField("min", "Payout min", pay.dailyMin),
        numField("max", "Payout max", pay.dailyMax),
      );
      await interaction.showModal(modal);
      return;
    }
    if (kind === "collect") {
      const modal = new ModalBuilder().setCustomId("ubadmin:station_modal:collect").setTitle("Collect — cooldown");
      modal.addComponents(cdField(cds.collectSec));
      await interaction.showModal(modal);
      return;
    }
    if (kind === "work") {
      const modal = new ModalBuilder().setCustomId("ubadmin:station_modal:work").setTitle("Work — CD + payout");
      modal.addComponents(
        cdField(cds.workSec),
        numField("min", "Payout min", pay.workMin),
        numField("max", "Payout max", pay.workMax),
      );
      await interaction.showModal(modal);
      return;
    }
    if (kind === "crime") {
      const modal = new ModalBuilder().setCustomId("ubadmin:station_modal:crime").setTitle("Crime — CD + payout");
      modal.addComponents(
        cdField(cds.crimeSec),
        numField("win_min", "Win payout min", pay.crimeWinMin),
        numField("win_max", "Win payout max", pay.crimeWinMax),
        numField("fail_pct", "Fail chance % (0–100)", pay.crimeFailChancePct),
        numField("fine_min", "Fine floor (cash)", pay.crimeFineMin),
      );
      await interaction.showModal(modal);
      return;
    }
    if (kind === "beg") {
      const modal = new ModalBuilder().setCustomId("ubadmin:station_modal:beg").setTitle("Beg — CD + payout");
      modal.addComponents(
        cdField(cds.begSec),
        numField("chance", "Pity chance % (0–100)", pay.begChancePct),
        numField("min", "Pity payout min", pay.begMin),
        numField("max", "Pity payout max", pay.begMax),
      );
      await interaction.showModal(modal);
      return;
    }
    if (kind === "rob") {
      const modal = new ModalBuilder().setCustomId("ubadmin:station_modal:rob").setTitle("Rob — CD + steal/fine");
      modal.addComponents(
        cdField(cds.robSec),
        numField("success_pct", "Success chance % (0–100)", pay.robSuccessChancePct),
        numField("steal_min", "Steal min", pay.robStealMin),
        numField("steal_cap", "Steal cap", pay.robStealCap),
        numField("fail_fine_max", `Fail fine max (min ${pay.robFailFineMin})`, pay.robFailFineMax),
      );
      await interaction.showModal(modal);
      return;
    }
    if (kind === "games") {
      const modal = new ModalBuilder().setCustomId("ubadmin:station_modal:games").setTitle("Games — rate limit");
      modal.addComponents(
        numField("uses", "Plays per window", cds.gameUses),
        textField("window", "Window (5m / 1h / or minutes)", formatCooldownInput(cds.gameWindowSec)),
        textField("gap", "Gap (3s / 30s / or minutes)", formatCooldownInput(cds.gameGapSec)),
      );
      await interaction.showModal(modal);
      return;
    }
    await interaction.reply({ content: "Unknown station command.", ...EPHEMERAL });
    return;
  }

  // Legacy aliases — keep old button IDs working if cached messages exist
  if (id === "ubadmin:cd_reset" && interaction.isButton()) {
    await interaction.deferUpdate();
    const { DEFAULT_COOLDOWNS } = await import("./cooldowns.js");
    const { DEFAULT_PAYOUTS } = await import("./payouts.js");
    await updateUbSettings(guildId, {
      cooldowns: { ...DEFAULT_COOLDOWNS },
      payouts: { ...DEFAULT_PAYOUTS },
      dailyMin: DEFAULT_PAYOUTS.dailyMin,
      dailyMax: DEFAULT_PAYOUTS.dailyMax,
    });
    await writeUbAudit(guildId, interaction.user.id, "discord_cd_reset", {});
    const { embeds, components } = await buildCasinoStation(guildId, "✅ Reset to factory defaults.");
    await interaction.editReply({ embeds, components });
    return;
  }

  if (id === "ubadmin:cd_edit" && interaction.isButton()) {
    // Redirect: open station picker description as ephemeral tip
    await interaction.reply({
      content: "Use **Casino station** → pick a command from the dropdown to edit cooldown + payout.",
      ...EPHEMERAL,
    });
    return;
  }

  if (id === "ubadmin:set_cash" && interaction.isButton()) {
    const menu = new UserSelectMenuBuilder()
      .setCustomId("ubadmin:set_user")
      .setPlaceholder("Whose cash to SET (absolute)?")
      .setMaxValues(1);
    await interaction.reply({
      content: "Pick a member, then enter the absolute cash balance.",
      components: [new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(menu)],
      ...EPHEMERAL,
    });
    return;
  }

  if (id === "ubadmin:set_user" && interaction.isUserSelectMenu()) {
    const userId = interaction.values[0]!;
    const modal = new ModalBuilder()
      .setCustomId(`ubadmin:set_modal:${userId}`)
      .setTitle("Set UnbelievaBoat cash");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("cash")
          .setLabel("Absolute cash amount")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(12),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("reason")
          .setLabel("Reason")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(80)
          .setPlaceholder("Discord /unbelievaboat set"),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (id === "ubadmin:add_perk" && interaction.isButton()) {
    const roleMenu = new RoleSelectMenuBuilder()
      .setCustomId("ubadmin:perk_role")
      .setPlaceholder("Which Discord role should this perk grant?")
      .setMaxValues(1);
    await interaction.reply({
      content: "Pick the role for the perk store item:",
      components: [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleMenu)],
      ...EPHEMERAL,
    });
    return;
  }

  if (id === "ubadmin:perk_role" && interaction.isRoleSelectMenu()) {
    const roleId = interaction.values[0]!;
    const role = interaction.guild?.roles.cache.get(roleId);
    const modal = new ModalBuilder()
      .setCustomId(`ubadmin:perk_modal:${roleId}`)
      .setTitle("New perk store item");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("name")
          .setLabel("Display name")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(80)
          .setValue(role?.name?.slice(0, 80) ?? ""),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("price")
          .setLabel("Price in UnbelievaBoat cash")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(10)
          .setValue("500"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("description")
          .setLabel("Short description")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(200),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("emoji")
          .setLabel("Emoji (unicode or <:name:id> custom)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(80)
          .setPlaceholder("✨ or paste a custom server emoji")
          .setValue("✨"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("income")
          .setLabel("Collect income per claim (0 = none)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(10)
          .setValue("0"),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  // Native Discord emoji / GIF bar — send in chat, we delete the message.
  if (id.startsWith("ubadmin:perk_icon_chat:") && interaction.isButton()) {
    const linkId = Number(id.split(":")[2]);
    await interaction.deferUpdate();
    const roles = await listRoleLinks(guildId);
    const row = roles.find(r => r.id === linkId);
    if (!row) {
      await interaction.editReply({ content: "That perk is gone.", components: [], embeds: [] });
      return;
    }
    beginIconCapture({
      guildId,
      userId: interaction.user.id,
      linkId,
      channelId: interaction.channelId,
      confirm: async (icon) => {
        const applied = await applyCapturedIconToLink(guildId, linkId, icon, interaction.user.id);
        if (!applied) {
          await interaction.editReply({ content: "That perk is gone.", components: [], embeds: [] });
          return;
        }
        const preview = new EmbedBuilder()
          .setColor(0xe91e8c)
          .setTitle(`${titleSafeStoreEmoji(icon.emoji, "🖼️")} ${applied.name}`)
          .setDescription(
            icon.animated
              ? "Animated icon set — Discord plays it on the store board."
              : "Icon set from Discord’s picker.",
          );
        if (icon.imageUrl) applyStoreImageToEmbed(preview, icon.imageUrl);
        await interaction.editReply({
          content: `Set icon for **${applied.name}**.` +
            (applied.ubItemId ? " _(synced emoji to UnbelievaBoat item)_" : ""),
          embeds: [preview],
          components: [],
        });
      },
      abort: async () => {
        await interaction.editReply({
          content: "Icon pick cancelled.",
          embeds: [],
          components: [],
        });
      },
    });
    const cancelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`ubadmin:perk_icon_chat_cancel:${linkId}`)
        .setLabel("Cancel pick")
        .setStyle(ButtonStyle.Danger),
    );
    await interaction.editReply({
      content:
        `**Send an emoji or GIF in this channel** for **${row.name}** (90s).\n` +
        `Use Discord’s emoji / GIF / file bar at the bottom — I’ll apply it and delete your message.\n` +
        `_Type \`cancel\` or tap Cancel pick to abort._`,
      embeds: [],
      components: [cancelRow],
    });
    return;
  }

  if (id.startsWith("ubadmin:perk_icon_chat_cancel:") && interaction.isButton()) {
    await interaction.deferUpdate();
    cancelIconCapture(guildId, interaction.user.id);
    await interaction.editReply({
      content: "Icon pick cancelled.",
      embeds: [],
      components: [],
    });
    return;
  }

  if (id.startsWith("ubadmin:perk_icon_gpage:") && interaction.isButton()) {
    await interaction.deferUpdate();
    const partsId = id.split(":");
    const linkId = Number(partsId[2]);
    const page = Number(partsId[3]) || 0;
    const roles = await listRoleLinks(guildId);
    const row = roles.find(r => r.id === linkId);
    if (!row) {
      await interaction.editReply({ content: "That perk is gone.", components: [], embeds: [] });
      return;
    }
    const picker = buildPerkIconPicker(linkId, row.name, row.emoji || "✨", interaction.guild, page);
    await interaction.editReply({
      content: "Pick a **server emoji**, or **Pick in chat** to use Discord’s emoji/GIF bar.",
      ...picker,
    });
    return;
  }

  // Discord native file / GIF picker modal.
  if (id.startsWith("ubadmin:perk_icon_upload_btn:") && interaction.isButton()) {
    const linkId = Number(id.split(":")[2]);
    await interaction.showModal(buildGifUploadModal(linkId));
    return;
  }

  if (id.startsWith("ubadmin:perk_icon_only_btn:") && interaction.isButton()) {
    const linkId = Number(id.split(":")[2]);
    await interaction.deferUpdate();
    const roles = await listRoleLinks(guildId);
    const row = roles.find(r => r.id === linkId);
    if (row) {
      const meta = { ...(row.meta as Record<string, unknown>) };
      delete meta.imageUrl;
      delete meta.iconGif;
      // Keep a simple unicode emoji so custom markup doesn’t stick in titles.
      const keep = titleSafeStoreEmoji(row.emoji, "✨");
      await updateRoleLink(guildId, linkId, { emoji: keep, meta });
      await writeUbAudit(guildId, interaction.user.id, "discord_perk_icon", {
        id: linkId, preset: "emoji_only", emoji: keep,
      });
    }
    await interaction.editReply({
      content: "Cleared uploaded image — emoji-only icon for the store.",
      components: [],
      embeds: [],
    });
    return;
  }

  if (id.startsWith("ubadmin:perk_icon_guild:") && interaction.isStringSelectMenu()) {
    const linkId = Number(id.split(":")[2]);
    const emojiId = interaction.values[0]!;
    await interaction.deferUpdate();
    const guildEmoji = interaction.guild?.emojis.cache.get(emojiId)
      ?? await interaction.guild?.emojis.fetch(emojiId).catch(() => null);
    if (!guildEmoji) {
      await interaction.editReply({ content: "That server emoji is gone.", components: [], embeds: [] });
      return;
    }
    const emoji = formatGuildEmoji({
      id: guildEmoji.id,
      name: guildEmoji.name || "emoji",
      animated: guildEmoji.animated,
    });
    const imageUrl = discordEmojiCdnUrl(guildEmoji.id, Boolean(guildEmoji.animated));
    const roles = await listRoleLinks(guildId);
    const row = roles.find(r => r.id === linkId);
    if (!row) {
      await interaction.editReply({ content: "That perk is gone.", components: [], embeds: [] });
      return;
    }
    const meta: Record<string, unknown> = {
      ...(row.meta as Record<string, unknown>),
      imageUrl,
    };
    delete meta.iconGif;
    await updateRoleLink(guildId, linkId, { emoji, meta });
    await syncEmojiToUbItem(guildId, row.ubItemId, emoji);
    await writeUbAudit(guildId, interaction.user.id, "discord_perk_icon", {
      id: linkId, preset: "guild_emoji", emoji, imageUrl, animated: Boolean(guildEmoji.animated),
    });
    const preview = new EmbedBuilder()
      .setColor(0xe91e8c)
      .setTitle(`${titleSafeStoreEmoji(emoji, "🖼️")} ${row.name}`)
      .setDescription(
        guildEmoji.animated
          ? "Animated server emoji — Discord plays the GIF on the store board."
          : "Server emoji set as store icon.",
      );
    applyStoreImageToEmbed(preview, imageUrl);
    await interaction.editReply({
      content: `Set store icon for **${row.name}**.` +
        (row.ubItemId ? " _(synced emoji to UnbelievaBoat item)_" : ""),
      embeds: [preview],
      components: [],
    });
    return;
  }

  if (id === "ubadmin:adjust" && interaction.isButton()) {
    const menu = new UserSelectMenuBuilder()
      .setCustomId("ubadmin:adjust_user")
      .setPlaceholder("Whose UnbelievaBoat balance?")
      .setMaxValues(1);
    await interaction.reply({
      content: "Pick a member, then enter a cash delta.",
      components: [new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(menu)],
      ...EPHEMERAL,
    });
    return;
  }

  if (id === "ubadmin:adjust_user" && interaction.isUserSelectMenu()) {
    const userId = interaction.values[0]!;
    const modal = new ModalBuilder()
      .setCustomId(`ubadmin:adjust_modal:${userId}`)
      .setTitle("Adjust UnbelievaBoat cash");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("cash")
          .setLabel("Cash delta (e.g. 100 or -50)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(12),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("reason")
          .setLabel("Reason")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(80)
          .setPlaceholder("Discord /unbelievaboat adjust"),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (id === "ubadmin:pet_tools" && interaction.isButton()) {
    const menu = new UserSelectMenuBuilder()
      .setCustomId("ubadmin:pet_tool_user")
      .setPlaceholder("Pick a member for pet tools…")
      .setMaxValues(1);
    const actionMenu = new StringSelectMenuBuilder()
      .setCustomId("ubadmin:pet_tool_action")
      .setPlaceholder("What to do? (pick user first via button flow)")
      .setDisabled(true)
      .addOptions(
        { label: "Reset pet (delete)", value: "reset", description: "They can /pet hatch again" },
        { label: "Crack stuck egg", value: "crack", description: "Egg → hatchling" },
      );
    await interaction.reply({
      content: "Pet tools — select a member:",
      components: [
        new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(menu),
      ],
      ...EPHEMERAL,
    });
    void actionMenu;
    return;
  }

  if (id === "ubadmin:pet_tool_user" && interaction.isUserSelectMenu()) {
    const userId = interaction.values[0]!;
    const actionMenu = new StringSelectMenuBuilder()
      .setCustomId(`ubadmin:pet_do:${userId}`)
      .setPlaceholder("Choose action…")
      .addOptions(
        { label: "Reset pet (delete)", value: "reset", description: "Wipe so they can hatch again" },
        { label: "Crack stuck egg", value: "crack", description: "Force egg → hatchling" },
        { label: "Disable pets server-wide", value: "pets_off" },
        { label: "Enable pets server-wide", value: "pets_on" },
      );
    await interaction.update({
      content: `Pet tools for <@${userId}>:`,
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(actionMenu)],
    });
    return;
  }

  if (id.startsWith("ubadmin:pet_do:") && interaction.isStringSelectMenu()) {
    await interaction.deferUpdate();
    const userId = id.slice("ubadmin:pet_do:".length);
    const choice = interaction.values[0]!;
    try {
      if (choice === "reset") {
        const { deleted } = await adminDeletePet(guildId, userId);
        await writeUbAudit(guildId, interaction.user.id, "discord_pet_reset", { userId, name: deleted.name });
        await interaction.editReply({
          content: `Reset <@${userId}>'s pet **${deleted.name}**. They can \`/pet hatch\` again.`,
          components: [],
        });
      } else if (choice === "crack") {
        const pet = await adminCrackEgg(guildId, userId);
        await writeUbAudit(guildId, interaction.user.id, "discord_pet_crack", { userId, name: pet.name });
        await interaction.editReply({
          content: `Cracked <@${userId}>'s egg — **${pet.name}** is a hatchling.`,
          components: [],
        });
      } else if (choice === "pets_off" || choice === "pets_on") {
        await updatePetSettings(guildId, { enabled: choice === "pets_on" });
        await writeUbAudit(guildId, interaction.user.id, "discord_pets_toggle", { enabled: choice === "pets_on" });
        await interaction.editReply({
          content: `Pets are now **${choice === "pets_on" ? "enabled" : "disabled"}** server-wide.`,
          components: [],
        });
      }
    } catch (err) {
      await interaction.editReply({
        content: `❌ ${err instanceof Error ? err.message : "Failed."}`,
        components: [],
      });
    }
  }
}

export async function handleUbAdminModal(interaction: ModalSubmitInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "Server only.", ...EPHEMERAL });
    return;
  }
  if (!interaction.memberPermissions?.has("Administrator")) {
    await interaction.reply({ content: "Administrator only.", ...EPHEMERAL });
    return;
  }
  const parts = interaction.customId.split(":");

  if (parts[1] === "station_modal" && parts[2]) {
    const kind = parts[2];
    try {
      await interaction.deferReply(EPHEMERAL);
      const { readCooldowns, parseCooldownInput } = await import("./cooldowns.js");
      const { readPayouts } = await import("./payouts.js");
      const s = await getOrCreateUbSettings(guildId);
      const cds = { ...readCooldowns(s) };
      const pay = { ...readPayouts(s) };
      const field = (id: string) => interaction.fields.getTextInputValue(id);

      if (kind === "daily") {
        cds.dailySec = parseCooldownInput(field("cd"), "Cooldown");
        pay.dailyMin = parseNonNeg(field("min"), "Min");
        pay.dailyMax = Math.max(pay.dailyMin, parseNonNeg(field("max"), "Max"));
      } else if (kind === "collect") {
        cds.collectSec = parseCooldownInput(field("cd"), "Cooldown");
      } else if (kind === "work") {
        cds.workSec = parseCooldownInput(field("cd"), "Cooldown");
        pay.workMin = parseNonNeg(field("min"), "Min");
        pay.workMax = Math.max(pay.workMin, parseNonNeg(field("max"), "Max"));
      } else if (kind === "crime") {
        cds.crimeSec = parseCooldownInput(field("cd"), "Cooldown");
        pay.crimeWinMin = parseNonNeg(field("win_min"), "Win min");
        pay.crimeWinMax = Math.max(pay.crimeWinMin, parseNonNeg(field("win_max"), "Win max"));
        pay.crimeFailChancePct = Math.min(100, parseNonNeg(field("fail_pct"), "Fail %"));
        pay.crimeFineMin = parseNonNeg(field("fine_min"), "Fine floor");
      } else if (kind === "beg") {
        cds.begSec = parseCooldownInput(field("cd"), "Cooldown");
        pay.begChancePct = Math.min(100, parseNonNeg(field("chance"), "Pity %"));
        pay.begMin = parseNonNeg(field("min"), "Min");
        pay.begMax = Math.max(pay.begMin, parseNonNeg(field("max"), "Max"));
      } else if (kind === "rob") {
        cds.robSec = parseCooldownInput(field("cd"), "Cooldown");
        pay.robSuccessChancePct = Math.min(100, parseNonNeg(field("success_pct"), "Success %"));
        pay.robStealMin = parseNonNeg(field("steal_min"), "Steal min");
        pay.robStealCap = Math.max(pay.robStealMin, parseNonNeg(field("steal_cap"), "Steal cap"));
        pay.robFailFineMax = Math.max(pay.robFailFineMin, parseNonNeg(field("fail_fine_max"), "Fail fine max"));
      } else if (kind === "games") {
        cds.gameUses = Math.max(1, parseNonNeg(field("uses"), "Plays"));
        cds.gameWindowSec = Math.max(30, parseCooldownInput(field("window"), "Window"));
        cds.gameGapSec = parseCooldownInput(field("gap"), "Gap");
      } else {
        await interaction.editReply("Unknown station command.");
        return;
      }

      await updateUbSettings(guildId, {
        cooldowns: cds,
        payouts: pay,
        dailyMin: pay.dailyMin,
        dailyMax: pay.dailyMax,
      });
      await writeUbAudit(guildId, interaction.user.id, `discord_station_${kind}`, { cds, pay });
      await interaction.editReply(`✅ Updated **${kind}**. Open **Casino station** again to review all values.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed.";
      if (interaction.deferred || interaction.replied) await interaction.editReply(`❌ ${msg}`);
      else await interaction.reply({ content: `❌ ${msg}`, ...EPHEMERAL });
    }
    return;
  }

  // Legacy single-modal cooldown edit (cached messages)
  if (parts[1] === "cd_modal") {
    const work = Number(interaction.fields.getTextInputValue("work"));
    const crime = Number(interaction.fields.getTextInputValue("crime"));
    const rob = Number(interaction.fields.getTextInputValue("rob"));
    const gameUses = Number(interaction.fields.getTextInputValue("game_uses"));
    const gameWindow = Number(interaction.fields.getTextInputValue("game_window"));
    if (![work, crime, rob, gameUses, gameWindow].every(n => Number.isFinite(n) && n >= 0)) {
      await interaction.reply({ content: "All values must be non-negative numbers.", ...EPHEMERAL });
      return;
    }
    await interaction.deferReply(EPHEMERAL);
    const { readCooldowns, DEFAULT_COOLDOWNS } = await import("./cooldowns.js");
    const s = await getOrCreateUbSettings(guildId);
    const prev = readCooldowns(s);
    const next = {
      ...prev,
      workSec: Math.floor(work),
      crimeSec: Math.floor(crime),
      robSec: Math.floor(rob),
      gameUses: Math.max(1, Math.floor(gameUses)),
      gameWindowSec: Math.max(30, Math.floor(gameWindow)),
      dailySec: prev.dailySec || DEFAULT_COOLDOWNS.dailySec,
      collectSec: prev.collectSec || DEFAULT_COOLDOWNS.collectSec,
      begSec: prev.begSec || DEFAULT_COOLDOWNS.begSec,
      gameGapSec: prev.gameGapSec ?? DEFAULT_COOLDOWNS.gameGapSec,
    };
    await updateUbSettings(guildId, { cooldowns: next });
    await writeUbAudit(guildId, interaction.user.id, "discord_cd_edit", next);
    await interaction.editReply(
      `Updated cooldowns.\nWork **${next.workSec}s** · crime **${next.crimeSec}s** · rob **${next.robSec}s**\nGames **${next.gameUses}** / **${next.gameWindowSec}s**\n_(Prefer **Casino station** for full per-command edit.)_`,
    );
    return;
  }

  if (parts[1] === "perk_modal" && parts[2]) {
    const roleId = parts[2];
    const name = interaction.fields.getTextInputValue("name").trim();
    const price = Number(interaction.fields.getTextInputValue("price").trim());
    const description = interaction.fields.getTextInputValue("description")?.trim() || null;
    let emojiRaw = "✨";
    try {
      emojiRaw = interaction.fields.getTextInputValue("emoji")?.trim() || "✨";
    } catch {
      emojiRaw = "✨";
    }
    const incomeRaw = interaction.fields.getTextInputValue("income")?.trim() || "0";
    const incomeAmount = Number(incomeRaw);
    if (!name || !Number.isFinite(price) || price < 0) {
      await interaction.reply({ content: "Need a name and a non-negative price.", ...EPHEMERAL });
      return;
    }
    if (!Number.isFinite(incomeAmount) || incomeAmount < 0) {
      await interaction.reply({ content: "Income must be a non-negative number.", ...EPHEMERAL });
      return;
    }
    await interaction.deferReply(EPHEMERAL);
    const icon = normalizeStoreIconInput(emojiRaw);
    const meta: Record<string, unknown> = {};
    if (icon.imageUrl) meta.imageUrl = icon.imageUrl;
    const row = await createRoleLink(guildId, {
      name,
      description,
      discordRoleId: roleId,
      price: Math.floor(price),
      incomeAmount: Math.floor(incomeAmount),
      enabled: true,
      emoji: icon.emoji,
    });
    if (Object.keys(meta).length) {
      await updateRoleLink(guildId, row.id, { meta });
    }
    await writeUbAudit(guildId, interaction.user.id, "discord_perk_create", {
      roleId, name, price, incomeAmount, emoji: icon.emoji, meta,
    });
    const picker = buildPerkIconPicker(row.id, name, icon.emoji, interaction.guild);
    await interaction.editReply({
      content:
        `Created perk **${name}** ${icon.emoji} → <@&${roleId}> for **${fmt(price)}** cash` +
        (incomeAmount > 0 ? ` · collect income **${fmt(incomeAmount)}**/claim` : "") +
        `.\nPlayers buy with \`/casino store\` · claim with \`/casino collect\`.` +
        `\n\n**Next:** tap **Pick in chat** (Discord emoji/GIF bar), browse server emoji, or **Upload GIF**.`,
      ...picker,
    });
    return;
  }

  // Legacy paste-modal submit — redirect to Pick in chat (no more shortcode paste).
  if (parts[1] === "perk_icon_emoji" && parts[2]) {
    await interaction.reply({
      content: "That paste form is gone — open **Pick in chat** and use Discord’s emoji / GIF bar.",
      ...EPHEMERAL,
    });
    return;
  }

  if (parts[1] === "perk_icon_upload" && parts[2]) {
    const linkId = Number(parts[2]);
    const files = interaction.fields.getUploadedFiles("image", false);
    const attachment = files?.first();
    if (!attachment) {
      await interaction.reply({
        content: "No file attached — open **Upload GIF** again and pick from Discord’s file picker.",
        ...EPHEMERAL,
      });
      return;
    }
    const type = attachment.contentType?.toLowerCase() ?? "";
    const fileName = attachment.name?.toLowerCase() ?? "";
    const looksImage = !type || type.startsWith("image/") || /\.(gif|png|jpe?g|webp)$/i.test(fileName);
    if (!looksImage) {
      await interaction.reply({
        content: "Need an image or GIF from Discord’s picker (PNG/JPG/GIF/WebP).",
        ...EPHEMERAL,
      });
      return;
    }
    const imageUrl = attachment.proxyURL || attachment.url;
    if (!imageUrl || (!isHttpImageUrl(imageUrl) && !imageUrl.includes("discord"))) {
      await interaction.reply({ content: "Couldn’t read that upload URL.", ...EPHEMERAL });
      return;
    }
    await interaction.deferReply(EPHEMERAL);
    const roles = await listRoleLinks(guildId);
    const row = roles.find(r => r.id === linkId);
    if (!row) {
      await interaction.editReply("That perk is gone.");
      return;
    }
    const animated = type.includes("gif") || fileName.endsWith(".gif") || isAnimatedStoreImage(imageUrl);
    const meta: Record<string, unknown> = {
      ...(row.meta as Record<string, unknown>),
      imageUrl,
    };
    delete meta.iconGif;
    // Replace stuck custom-emoji markup so the name/title isn’t glued to the old emoji.
    const nextEmoji = animated ? "🎞️" : "🖼️";
    await updateRoleLink(guildId, linkId, { emoji: nextEmoji, meta });
    await writeUbAudit(guildId, interaction.user.id, "discord_perk_icon", {
      id: linkId, preset: "discord_upload", imageUrl, animated, name: attachment.name,
    });
    const preview = new EmbedBuilder()
      .setColor(0xe91e8c)
      .setTitle(`${nextEmoji} ${row.name}`)
      .setDescription(
        animated
          ? "Uploaded GIF — Discord plays the animation on the store board."
          : "Uploaded image set as store icon.",
      );
    applyStoreImageToEmbed(preview, imageUrl);
    await interaction.editReply({
      content: `Set uploaded ${animated ? "GIF" : "image"} for **${row.name}**.`,
      embeds: [preview],
      components: [],
    });
    return;
  }

  if (parts[1] === "re_add_collect_modal" && parts[2]) {
    const roleId = parts[2]!;
    const name = interaction.fields.getTextInputValue("name").trim();
    const income = Number(interaction.fields.getTextInputValue("income").trim());
    const cooldownMin = Number(interaction.fields.getTextInputValue("cooldown_min").trim());
    let emojiRaw = "✨";
    try {
      emojiRaw = interaction.fields.getTextInputValue("emoji")?.trim() || "✨";
    } catch {
      emojiRaw = "✨";
    }
    if (!name || !Number.isFinite(income) || income === 0) {
      await interaction.reply({ content: "Need a name and a non-zero collect income.", ...EPHEMERAL });
      return;
    }
    if (!Number.isFinite(cooldownMin) || cooldownMin < 0) {
      await interaction.reply({ content: "Cooldown minutes must be non-negative.", ...EPHEMERAL });
      return;
    }
    await interaction.deferReply(EPHEMERAL);
    const icon = normalizeStoreIconInput(emojiRaw);
    const meta: Record<string, unknown> = {
      collectCooldownSec: Math.max(0, Math.floor(cooldownMin * 60)),
      collectIncomeSet: true,
    };
    if (icon.imageUrl) meta.imageUrl = icon.imageUrl;
    const row = await createRoleLink(guildId, {
      name,
      discordRoleId: roleId,
      price: 0,
      incomeAmount: Math.floor(income),
      emoji: icon.emoji,
      enabled: true,
    });
    await updateRoleLink(guildId, row.id, { meta });
    await writeUbAudit(guildId, interaction.user.id, "discord_collect_role_add", {
      id: row.id, roleId, income, cooldownMin, emoji: icon.emoji,
    });
    const picker = buildPerkIconPicker(row.id, name, icon.emoji, interaction.guild);
    await interaction.editReply({
      content:
        `Added collect role **${name}** → <@&${roleId}> · **${fmt(income)}** every **${Math.floor(cooldownMin)}m**.\n` +
        `Optional: set a Discord emoji / GIF icon below.`,
      ...picker,
    });
    return;
  }

  if (parts[1] === "re_edit_modal" && parts[2]) {
    const linkId = Number(parts[2]);
    const price = Number(interaction.fields.getTextInputValue("price").trim());
    const income = Number(interaction.fields.getTextInputValue("income").trim());
    let cooldownMin = NaN;
    try {
      cooldownMin = Number(interaction.fields.getTextInputValue("cooldown_min").trim());
    } catch {
      cooldownMin = NaN;
    }
    let description = "";
    try {
      description = interaction.fields.getTextInputValue("description")?.trim() || "";
    } catch {
      description = "";
    }
    if (![price, income].every(n => Number.isFinite(n) && n >= 0)) {
      await interaction.reply({ content: "Price and income must be non-negative numbers.", ...EPHEMERAL });
      return;
    }
    if (!Number.isFinite(cooldownMin) || cooldownMin < 0) {
      await interaction.reply({ content: "Cooldown minutes must be a non-negative number.", ...EPHEMERAL });
      return;
    }
    await interaction.deferReply(EPHEMERAL);
    const roles = await listRoleLinks(guildId);
    const row = roles.find(r => r.id === linkId);
    if (!row) {
      await interaction.editReply("That perk is gone.");
      return;
    }
    const meta: Record<string, unknown> = {
      ...(row.meta as Record<string, unknown>),
      collectCooldownSec: Math.max(0, Math.floor(cooldownMin * 60)),
      collectIncomeSet: true,
    };
    await updateRoleLink(guildId, linkId, {
      price: Math.floor(price),
      incomeAmount: Math.floor(income),
      description: description || row.description,
      meta,
    });
    if (row.ubItemId && isUbConfigured()) {
      const settings = await getOrCreateUbSettings(guildId);
      try {
        await ubApi.editStoreItem(settings.ubGuildId, row.ubItemId, {
          price: Math.floor(price),
          description: description || row.description || undefined,
        });
      } catch { /* local still saved */ }
    }
    await writeUbAudit(guildId, interaction.user.id, "discord_perk_edit", {
      id: linkId, price, income, cooldownMin, description,
    });
    await interaction.editReply(
      `Updated **${row.name}**: price **${fmt(price)}** · collect **${fmt(income)}** every **${Math.floor(cooldownMin)}m**` +
      (row.ubItemId ? " _(UB item price patched)_" : "") +
      `\n_Re-open the role in **Roles & economy** for icon / actions / requirements._`,
    );
    return;
  }

  if (parts[1] === "re_balance_action" && parts[2]) {
    const linkId = Number(parts[2]);
    const balance = Number(interaction.fields.getTextInputValue("balance").trim());
    if (!Number.isFinite(balance) || balance <= 0) {
      await interaction.reply({ content: "Balance must be a positive number.", ...EPHEMERAL });
      return;
    }
    await interaction.deferReply(EPHEMERAL);
    const roles = await listRoleLinks(guildId);
    const row = roles.find(r => r.id === linkId);
    if (!row?.ubItemId) {
      await interaction.editReply("Need a linked UnbelievaBoat store item.");
      return;
    }
    const settings = await getOrCreateUbSettings(guildId);
    let existing = parseActions([]);
    try {
      const raw = await ubApi.getStoreItem(settings.ubGuildId, row.ubItemId);
      existing = parseActions(raw.actions).filter(a => a.type !== UbAction.ADD_BALANCE);
    } catch { /* empty */ }
    const actions = [...existing, { type: UbAction.ADD_BALANCE, balance: Math.floor(balance) }];
    await ubApi.editStoreItem(settings.ubGuildId, row.ubItemId, { actions });
    await writeUbAudit(guildId, interaction.user.id, "ub_actions_set", { id: linkId, type: "add_balance", balance });
    await interaction.editReply(`UB buy action: add **${fmt(balance)}** cash on purchase.`);
    return;
  }

  if (parts[1] === "re_req_balance" && parts[2]) {
    const linkId = Number(parts[2]);
    const balance = Number(interaction.fields.getTextInputValue("balance").trim());
    if (!Number.isFinite(balance) || balance < 0) {
      await interaction.reply({ content: "Balance must be a non-negative number.", ...EPHEMERAL });
      return;
    }
    await interaction.deferReply(EPHEMERAL);
    const roles = await listRoleLinks(guildId);
    const row = roles.find(r => r.id === linkId);
    if (!row?.ubItemId) {
      await interaction.editReply("Need a linked UnbelievaBoat store item.");
      return;
    }
    const settings = await getOrCreateUbSettings(guildId);
    let existing = parseRequirements([]);
    try {
      const raw = await ubApi.getStoreItem(settings.ubGuildId, row.ubItemId);
      existing = parseRequirements(raw.requirements).filter(r => r.type !== UbReq.TOTAL_BALANCE);
    } catch { /* empty */ }
    const requirements = [
      ...existing,
      { type: UbReq.TOTAL_BALANCE, balance: Math.floor(balance) },
    ];
    await ubApi.editStoreItem(settings.ubGuildId, row.ubItemId, { requirements });
    await writeUbAudit(guildId, interaction.user.id, "ub_reqs_set", { id: linkId, balance });
    await interaction.editReply(`UB requirement: total balance ≥ **${fmt(balance)}**.`);
    return;
  }

  if (parts[1] === "re_economy_modal") {
    const dailyMin = Number(interaction.fields.getTextInputValue("daily_min").trim());
    const dailyMax = Number(interaction.fields.getTextInputValue("daily_max").trim());
    const collectMin = Number(interaction.fields.getTextInputValue("collect_cd").trim());
    const sort = interaction.fields.getTextInputValue("sort").trim().toLowerCase();
    if (![dailyMin, dailyMax, collectMin].every(n => Number.isFinite(n) && n >= 0)) {
      await interaction.reply({ content: "All numbers must be non-negative.", ...EPHEMERAL });
      return;
    }
    if (dailyMax < dailyMin) {
      await interaction.reply({ content: "Daily max must be ≥ min.", ...EPHEMERAL });
      return;
    }
    if (!["cash", "bank", "total"].includes(sort)) {
      await interaction.reply({ content: "Sort must be `cash`, `bank`, or `total`.", ...EPHEMERAL });
      return;
    }
    await interaction.deferReply(EPHEMERAL);
    const s = await getOrCreateUbSettings(guildId);
    const cds = readCooldowns(s);
    const nextCds = {
      ...cds,
      collectSec: Math.max(60, Math.floor(collectMin * 60)),
    };
    await updateUbSettings(guildId, {
      dailyMin: Math.floor(dailyMin),
      dailyMax: Math.floor(dailyMax),
      leaderboardSort: sort,
      cooldowns: nextCds,
    });
    await writeUbAudit(guildId, interaction.user.id, "discord_economy_quick", {
      dailyMin, dailyMax, collectSec: nextCds.collectSec, sort,
    });
    await interaction.editReply(
      [
        `Updated daily **${fmt(dailyMin)}–${fmt(dailyMax)}** · leaderboard **${sort}**.`,
        `Default role-collect CD **${Math.round(nextCds.collectSec / 60)}m** — used only when a role has no custom timer.`,
        `_Per-role collect times: open each role → Price / income (UB Role Income style)._`,
      ].join("\n"),
    );
    return;
  }

  if ((parts[1] === "adjust_modal" || parts[1] === "set_modal") && parts[2]) {
    const userId = parts[2];
    const cashRaw = interaction.fields.getTextInputValue("cash").trim();
    const reason = interaction.fields.getTextInputValue("reason")?.trim()
      || (parts[1] === "set_modal" ? "Discord /unbelievaboat set" : "Discord /unbelievaboat adjust");
    const cash = Number(cashRaw);
    if (!Number.isFinite(cash) || (parts[1] === "adjust_modal" && cash === 0)) {
      await interaction.reply({ content: "Enter a valid cash number.", ...EPHEMERAL });
      return;
    }
    if (parts[1] === "set_modal" && cash < 0) {
      await interaction.reply({ content: "Absolute cash cannot be negative.", ...EPHEMERAL });
      return;
    }

    await interaction.deferReply(EPHEMERAL);
    const settings = await getOrCreateUbSettings(guildId);
    if (!isUbConfigured() || !settings.enabled) {
      await interaction.editReply("UnbelievaBoat token missing or API link disabled — flip it on in `/unbelievaboat`.");
      return;
    }
    try {
      const bal = parts[1] === "set_modal"
        ? await ubApi.setUserBalance(settings.ubGuildId, userId, { cash, reason })
        : await ubApi.patchUserBalance(settings.ubGuildId, userId, { cash, reason });
      await writeUbAudit(guildId, interaction.user.id,
        parts[1] === "set_modal" ? "discord_cash_set" : "discord_cash_adjust",
        { userId, cash, reason, bal });
      await interaction.editReply(
        parts[1] === "set_modal"
          ? `Set <@${userId}> cash to **${fmt(bal.cash)}**.\nBank **${fmt(bal.bank)}** · total **${fmt(bal.total)}**.`
          : `Adjusted <@${userId}> by **${cash > 0 ? "+" : ""}${fmt(cash)}** cash.\nNow: cash **${fmt(bal.cash)}** · bank **${fmt(bal.bank)}** · total **${fmt(bal.total)}.`,
      );
    } catch (err) {
      await interaction.editReply(`❌ ${err instanceof Error ? err.message : "Balance edit failed."}`);
    }
    return;
  }

  await interaction.reply({ content: "Unknown form.", ...EPHEMERAL });
}
