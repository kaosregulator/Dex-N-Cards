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
} from "discord.js";
import { isUbConfigured, ubApi } from "../../lib/unbelievaboat/client.js";
import {
  getOrCreateUbSettings,
  updateUbSettings,
  listCatalog,
  listRoleLinks,
  listUbAudit,
  writeUbAudit,
  createRoleLink,
} from "../../lib/unbelievaboat/db.js";
import {
  getOrCreatePetSettings,
  updatePetSettings,
  petLeaderboard,
  adminDeletePet,
  adminCrackEgg,
} from "../pets/engine.js";

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
        "_Webhook floor commands (`*_ub` / `/casino`). UB’s own Discord cooldowns are **not** on their API — these are ours._",
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
    const [catalog, roles, audit] = await Promise.all([
      listCatalog(guildId),
      listRoleLinks(guildId),
      listUbAudit(guildId, 5),
    ]);
    const catLines = catalog.slice(0, 8).map(c =>
      `${c.listed ? "✅" : "⏸"} **${c.name}** — ${c.price} cash${c.forPets ? " · pets" : ""}`,
    ).join("\n") || "_No catalog items._";
    const roleLines = roles.slice(0, 5).map(r =>
      `${r.enabled ? "✅" : "⏸"} **${r.name}** — ${r.price} cash`,
    ).join("\n") || "_No role links._";
    const auditLines = audit.map(a =>
      `• \`${a.action}\` · <@${a.actorId.replace(/^dash:/, "")}> · <t:${Math.floor(new Date(a.createdAt).getTime() / 1000)}:R>`,
    ).join("\n") || "_No audit yet._";
    const embed = new EmbedBuilder()
      .setColor(0xe91e8c)
      .setAuthor({ name: "UnbelievaBoat catalog", iconURL: UB_ICON })
      .setTitle("Store / roles / recent audit")
      .addFields(
        { name: "Catalog", value: catLines.slice(0, 1000) },
        { name: "Role links", value: roleLines.slice(0, 1000) },
        { name: "Recent audit", value: auditLines.slice(0, 1000) },
      )
      .setFooter({ text: "Use Add perk to create role goods · players buy with /casino store" });
    await interaction.editReply({ embeds: [embed], components: hubRows() });
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
    const { readCooldowns } = await import("./cooldowns.js");
    const { readPayouts } = await import("./payouts.js");
    const s = await getOrCreateUbSettings(guildId);
    const cds = readCooldowns(s);
    const pay = readPayouts(s);

    if (kind === "daily") {
      const modal = new ModalBuilder().setCustomId("ubadmin:station_modal:daily").setTitle("Daily — CD + payout");
      modal.addComponents(
        numField("cd_sec", "Cooldown (seconds)", cds.dailySec),
        numField("min", "Payout min", pay.dailyMin),
        numField("max", "Payout max", pay.dailyMax),
      );
      await interaction.showModal(modal);
      return;
    }
    if (kind === "collect") {
      const modal = new ModalBuilder().setCustomId("ubadmin:station_modal:collect").setTitle("Collect — cooldown");
      modal.addComponents(
        numField("cd_sec", "Cooldown (seconds)", cds.collectSec),
      );
      await interaction.showModal(modal);
      return;
    }
    if (kind === "work") {
      const modal = new ModalBuilder().setCustomId("ubadmin:station_modal:work").setTitle("Work — CD + payout");
      modal.addComponents(
        numField("cd_sec", "Cooldown (seconds)", cds.workSec),
        numField("min", "Payout min", pay.workMin),
        numField("max", "Payout max", pay.workMax),
      );
      await interaction.showModal(modal);
      return;
    }
    if (kind === "crime") {
      const modal = new ModalBuilder().setCustomId("ubadmin:station_modal:crime").setTitle("Crime — CD + payout");
      modal.addComponents(
        numField("cd_sec", "Cooldown (seconds)", cds.crimeSec),
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
        numField("cd_sec", "Cooldown (seconds)", cds.begSec),
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
        numField("cd_sec", "Cooldown (seconds)", cds.robSec),
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
        numField("window_sec", "Window (seconds)", cds.gameWindowSec),
        numField("gap_sec", "Gap between games (seconds)", cds.gameGapSec),
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
          .setCustomId("image")
          .setLabel("Store icon image/GIF URL (optional)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(300),
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
      const { readCooldowns } = await import("./cooldowns.js");
      const { readPayouts } = await import("./payouts.js");
      const s = await getOrCreateUbSettings(guildId);
      const cds = { ...readCooldowns(s) };
      const pay = { ...readPayouts(s) };
      const field = (id: string) => interaction.fields.getTextInputValue(id);

      if (kind === "daily") {
        cds.dailySec = parseNonNeg(field("cd_sec"), "Cooldown");
        pay.dailyMin = parseNonNeg(field("min"), "Min");
        pay.dailyMax = Math.max(pay.dailyMin, parseNonNeg(field("max"), "Max"));
      } else if (kind === "collect") {
        cds.collectSec = parseNonNeg(field("cd_sec"), "Cooldown");
      } else if (kind === "work") {
        cds.workSec = parseNonNeg(field("cd_sec"), "Cooldown");
        pay.workMin = parseNonNeg(field("min"), "Min");
        pay.workMax = Math.max(pay.workMin, parseNonNeg(field("max"), "Max"));
      } else if (kind === "crime") {
        cds.crimeSec = parseNonNeg(field("cd_sec"), "Cooldown");
        pay.crimeWinMin = parseNonNeg(field("win_min"), "Win min");
        pay.crimeWinMax = Math.max(pay.crimeWinMin, parseNonNeg(field("win_max"), "Win max"));
        pay.crimeFailChancePct = Math.min(100, parseNonNeg(field("fail_pct"), "Fail %"));
        pay.crimeFineMin = parseNonNeg(field("fine_min"), "Fine floor");
      } else if (kind === "beg") {
        cds.begSec = parseNonNeg(field("cd_sec"), "Cooldown");
        pay.begChancePct = Math.min(100, parseNonNeg(field("chance"), "Pity %"));
        pay.begMin = parseNonNeg(field("min"), "Min");
        pay.begMax = Math.max(pay.begMin, parseNonNeg(field("max"), "Max"));
      } else if (kind === "rob") {
        cds.robSec = parseNonNeg(field("cd_sec"), "Cooldown");
        pay.robSuccessChancePct = Math.min(100, parseNonNeg(field("success_pct"), "Success %"));
        pay.robStealMin = parseNonNeg(field("steal_min"), "Steal min");
        pay.robStealCap = Math.max(pay.robStealMin, parseNonNeg(field("steal_cap"), "Steal cap"));
        pay.robFailFineMax = Math.max(pay.robFailFineMin, parseNonNeg(field("fail_fine_max"), "Fail fine max"));
      } else if (kind === "games") {
        cds.gameUses = Math.max(1, parseNonNeg(field("uses"), "Plays"));
        cds.gameWindowSec = Math.max(30, parseNonNeg(field("window_sec"), "Window"));
        cds.gameGapSec = parseNonNeg(field("gap_sec"), "Gap");
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
    const image = interaction.fields.getTextInputValue("image")?.trim() || "";
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
    const meta: Record<string, unknown> = {};
    if (image) meta.imageUrl = image;
    const row = await createRoleLink(guildId, {
      name,
      description,
      discordRoleId: roleId,
      price: Math.floor(price),
      incomeAmount: Math.floor(incomeAmount),
      enabled: true,
      emoji: "✨",
    });
    // Attach meta via update
    const { updateRoleLink } = await import("../../lib/unbelievaboat/db.js");
    await updateRoleLink(guildId, row.id, { meta });
    await writeUbAudit(guildId, interaction.user.id, "discord_perk_create", { roleId, name, price, incomeAmount, meta });
    await interaction.editReply(
      `Created perk **${name}** → <@&${roleId}> for **${fmt(price)}** cash` +
      (incomeAmount > 0 ? ` · collect income **${fmt(incomeAmount)}**/claim` : "") +
      `.\nPlayers buy it with \`/casino store\` and claim with \`/casino collect\`.`,
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
