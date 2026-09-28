// /tatsu — Discord dashboard for Tatsu score/points leaderboards + spam tools.
// Ephemeral, Administrator-only. No mini-games (unlike /unbelievaboat).
//
// What the Tatsu API can do: rankings (all/month/week), member points/score,
// add/remove points & score (≤100k/call, needs MANAGE_GUILD on the key owner),
// global user profile. What it cannot: persistence/spam rates, wipe economy,
// leveled roles — those stay on Tatsu's website / t@ menus.

import type {
  ChatInputCommandInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction,
  UserSelectMenuInteraction,
  ChannelSelectMenuInteraction,
  ModalSubmitInteraction,
  TextChannel,
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
  ChannelSelectMenuBuilder,
  ChannelType,
} from "discord.js";
import {
  isTatsuConfigured,
  tatsuApi,
  type TatsuPeriod,
  TATSU_MODIFY_MAX,
} from "../../lib/tatsu/client.js";
import {
  getOrCreateTatsuSettings,
  updateTatsuSettings,
  writeTatsuAudit,
  listTatsuAudit,
  listWatchlist,
  upsertWatchlist,
  removeWatchlist,
  saveSnapshot,
  latestSnapshot,
} from "../../lib/tatsu/db.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;
const TATSU_COLOR = 0x5865f2;
const TATSU_ICON = "https://tatsu.gg/images/tatsu.png";
/** Discord embed description max is 4096 — 100 rows overflow (~5k+) and Discord rejects the edit. */
const LB_PAGE = 20;
/** Max ranking pages to scan when pruning left members (each page = 1 API call). */
const PRUNE_SCAN_PAGES = 3;
/** Max ghosts to strip in one confirm (rate-limit friendly). */
const PRUNE_STRIP_MAX = 8;

export function buildTatsuAdminCommandJson() {
  return new SlashCommandBuilder()
    .setName("tatsu")
    .setDescription("Tatsu Discord dashboard — leaderboard, points, score, spam watch")
    .setDMPermission(false)
    .setDefaultMemberPermissions(0x8)
    .toJSON();
}


function pointsAmountModal(customId: string, title: string) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("amount").setLabel("Amount (1+)").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("1000"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("reason").setLabel("Reason (optional)").setStyle(TextInputStyle.Short).setRequired(false),
      ),
    );
}

function pointsIdModal(action: "add" | "remove") {
  return new ModalBuilder()
    .setCustomId(`tatsu:points_id_modal:${action}`)
    .setTitle(action === "add" ? "Add points by user ID" : "Remove points by user ID")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("user_id").setLabel("Discord user ID").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("123456789012345678"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("amount").setLabel("Amount (1+)").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("1000"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("reason").setLabel("Reason (optional)").setStyle(TextInputStyle.Short).setRequired(false),
      ),
    );
}

function scoreIdModal(action: "add" | "remove") {
  return new ModalBuilder()
    .setCustomId(`tatsu:score_id_modal:${action}`)
    .setTitle(action === "add" ? "Add score by user ID" : "Remove score by user ID")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("user_id").setLabel("Discord user ID").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("123456789012345678"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("amount").setLabel("Amount (1+)").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("5000"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("reason").setLabel("Reason (optional)").setStyle(TextInputStyle.Short).setRequired(false),
      ),
    );
}

function tatsuApiErr(err: unknown): string {
  const msg = err instanceof Error ? err.message : "Modify failed";
  if (/MANAGE_GUILD|Manage Server|manage guild/i.test(msg)) {
    return (
      "⚠️ Tatsu rejected this edit: the **Discord account that owns `TATSU_API_KEY`** needs **Manage Server** in this guild " +
      "(not just your Dex N Cards admin role). Recreate the key with `t!apikey create` while logged in as a Manage-Server account, " +
      "then update `TATSU_API_KEY` on Railway.\n\n_Raw: " + msg + "_"
    );
  }
  return `⚠️ ${msg}`;
}

function hubRows() {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("tatsu:overview").setLabel("Overview").setEmoji("📋").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("tatsu:leaderboard").setLabel("Leaderboard").setEmoji("🏆").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("tatsu:lookup").setLabel("Lookup user").setEmoji("🔍").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("tatsu:edit").setLabel("Edit user").setEmoji("✏️").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("tatsu:audit").setLabel("Audit log").setEmoji("📜").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("tatsu:points").setLabel("Adjust points").setEmoji("💠").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("tatsu:score").setLabel("Adjust score").setEmoji("⭐").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("tatsu:strip").setLabel("Strip spam").setEmoji("🪓").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("tatsu:watch").setLabel("Watchlist").setEmoji("👁️").setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("tatsu:snapshot").setLabel("Snapshot + climbers").setEmoji("📸").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("tatsu:toggle").setLabel("Toggle API link").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("tatsu:logs").setLabel("Log channel").setEmoji("📢").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("tatsu:period").setLabel("Ranking period").setEmoji("📅").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function fmt(n: number) {
  return new Intl.NumberFormat().format(n);
}

function periodLabel(p: string): string {
  if (p === "month") return "this month";
  if (p === "week") return "this week";
  return "all-time";
}

async function buildOverviewEmbed(guildId: string): Promise<EmbedBuilder> {
  const settings = await getOrCreateTatsuSettings(guildId);
  const watch = await listWatchlist(guildId);
  const snap = await latestSnapshot(guildId, settings.rankingPeriod);
  let probe = "_API not queried_";
  let apiErr: string | null = null;

  if (isTatsuConfigured() && settings.enabled) {
    try {
      const board = await tatsuApi.getGuildRankings(settings.tatsuGuildId || guildId, settings.rankingPeriod as TatsuPeriod, 0);
      const n = board.rankings?.length ?? 0;
      const top = board.rankings?.[0];
      probe = top
        ? `Top #1 <@${top.user_id}> · score **${fmt(top.score)}** · page has **${n}** (max 100/page)`
        : `Leaderboard empty for **${periodLabel(settings.rankingPeriod)}**.`;
    } catch (err) {
      apiErr = err instanceof Error ? err.message : "Tatsu API error";
    }
  }

  return new EmbedBuilder()
    .setColor(TATSU_COLOR)
    .setAuthor({ name: "Tatsu Discord dashboard", iconURL: TATSU_ICON })
    .setTitle("Score · points · spam control")
    .setDescription(
      [
        `API key configured: **${isTatsuConfigured() ? "yes" : "no"}** *(create with \`t!apikey create\`)*`,
        `Tatsu API link: **${settings.enabled ? "on" : "off"}**`,
        `Ranking period: **${periodLabel(settings.rankingPeriod)}**`,
        `Log channel: **${settings.logChannelId ? `<#${settings.logChannelId}>` : "not set"}**`,
        `Watchlist: **${watch.length}** · spam score delta flag: **${fmt(settings.spamScoreDelta)}**`,
        `Linked guild id: \`${settings.tatsuGuildId || guildId}\``,
        snap ? `Last snapshot: <t:${Math.floor(snap.createdAt.getTime() / 1000)}:R> (${snap.rankings.length} rows)` : "Last snapshot: _none yet_",
        "",
        probe,
        apiErr ? `⚠️ ${apiErr}` : null,
        "",
        "**API can:** read boards · lookup · add/remove **points & score** (≤100k/call, chunked).",
        "**API cannot:** change **reputation** · persistence / msg rate · wipe economy · leveled roles.",
        "Left the server but still on the board? **Leaderboard → Prune left** zeros their Tatsu score/points.",
        "Key owner must be **in this server** with **Manage Server** for edits.",
      ].filter(Boolean).join("\n"),
    )
    .setFooter({ text: "Admin only · rate limit 60 req/min · docs: https://dev.tatsu.gg/" });
}

export async function handleTatsuAdminCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "Server only.", ...EPHEMERAL });
    return;
  }
  await interaction.deferReply(EPHEMERAL);
  const embed = await buildOverviewEmbed(interaction.guildId);
  await interaction.editReply({ embeds: [embed], components: hubRows() });
}

function rankingPeriodOf(settingsPeriod: string): TatsuPeriod {
  if (settingsPeriod === "month" || settingsPeriod === "week") return settingsPeriod;
  return "all";
}

async function renderLeaderboard(
  guildId: string,
  period: TatsuPeriod,
  offset: number,
): Promise<{ embed: EmbedBuilder; components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[]; rowCount: number }> {
  const settings = await getOrCreateTatsuSettings(guildId);
  let lines = "_Configure `TATSU_API_KEY` and enable the Tatsu API link._";
  let rowCount = 0;
  let apiNote: string | null = null;

  if (isTatsuConfigured() && settings.enabled) {
    try {
      // Tatsu pages are ≤100 starting at API offset multiples of 100.
      // We page 20 at a time inside that window so Discord embeds stay <4096 chars.
      const apiOffset = Math.floor(offset / 100) * 100;
      const local = offset - apiOffset;
      const board = await tatsuApi.getGuildRankings(settings.tatsuGuildId || guildId, period, apiOffset);
      const page = board.rankings ?? [];
      const rows = page.slice(local, local + LB_PAGE);
      rowCount = rows.length;
      const hasMoreInPage = local + LB_PAGE < page.length;
      const hasMoreApi = page.length >= 100;
      lines = rows.length
        ? rows.map(r =>
          `**#${r.rank}.** <@${r.user_id}> — **${fmt(r.score)}**`,
        ).join("\n")
        : "_No rankings on this page._";
      // Encode "more available" into rowCount sentinel for nav (full page = enable Next)
      if (rows.length > 0 && (hasMoreInPage || hasMoreApi)) {
        rowCount = LB_PAGE; // keep Next enabled
      }
    } catch (err) {
      lines = `⚠️ ${err instanceof Error ? err.message : "Leaderboard failed"}`;
    }
  }

  const desc = [lines, apiNote].filter(Boolean).join("\n\n");
  const embed = new EmbedBuilder()
    .setColor(TATSU_COLOR)
    .setAuthor({ name: "Tatsu leaderboard", iconURL: TATSU_ICON })
    .setTitle(`Top scores · ${periodLabel(period)} · #${offset + 1}–${offset + Math.max(rowCount, 1)}`)
    .setDescription(desc.slice(0, 4000))
    .setFooter({ text: `${LB_PAGE}/page · Go to rank # edits all-time · Prune uses board score` });

  const periodMenu = new StringSelectMenuBuilder()
    .setCustomId("tatsu:period_select")
    .setPlaceholder("Ranking period…")
    .addOptions(
      { label: "All-time", value: "all", default: period === "all" },
      { label: "This month", value: "month", default: period === "month" },
      { label: "This week", value: "week", default: period === "week" },
    );

  const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`tatsu:lb_prev:${period}:${Math.max(0, offset - LB_PAGE)}`)
      .setLabel(`Prev ${LB_PAGE}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(offset <= 0),
    new ButtonBuilder()
      .setCustomId(`tatsu:lb_next:${period}:${offset + LB_PAGE}`)
      .setLabel(`Next ${LB_PAGE}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(rowCount < LB_PAGE),
    new ButtonBuilder().setCustomId("tatsu:goto_rank").setLabel("Go to rank #").setEmoji("🎯").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("tatsu:prune").setLabel("Prune left").setEmoji("🧹").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("tatsu:overview").setLabel("Home").setStyle(ButtonStyle.Primary),
  );

  return {
    embed,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(periodMenu),
      nav,
    ],
    rowCount,
  };
}

type GhostRow = { userId: string; rank: number; score: number };

/** In-memory prune preview (guildId → ghosts), short-lived. */
const prunePreview = new Map<string, { period: TatsuPeriod; ghosts: GhostRow[]; expires: number }>();

/** Board scores for leavers — member APIs often return 0 while the all-time board still lists them. */
const editBoardCtx = new Map<string, { userId: string; boardRank: number; boardScore: number; expires: number }>();
function editCtxKey(guildId: string, userId: string) { return `${guildId}:${userId}`; }

async function memberStillHere(guild: NonNullable<ButtonInteraction["guild"]>, userId: string): Promise<boolean> {
  if (guild.members.cache.has(userId)) return true;
  try {
    await guild.members.fetch(userId);
    return true;
  } catch {
    return false;
  }
}

/** Pull one all-time rank row (1-based). */
async function fetchAllTimeRank(
  tatsuGuild: string,
  rank: number,
): Promise<{ userId: string; rank: number; score: number } | null> {
  if (!Number.isFinite(rank) || rank < 1) return null;
  const offset = Math.floor((rank - 1) / 100) * 100;
  const board = await tatsuApi.getGuildRankings(tatsuGuild, "all", offset);
  const rows = board.rankings ?? [];
  const hit = rows.find(r => r.rank === rank) ?? rows[rank - 1 - offset];
  if (!hit) return null;
  return { userId: hit.user_id, rank: hit.rank, score: hit.score };
}

/** Scan all-time board pages for a user id (rate-limit aware, capped). */
async function findUserOnAllTimeBoard(
  tatsuGuild: string,
  userId: string,
  maxPages = 8,
): Promise<{ userId: string; rank: number; score: number } | null> {
  for (let page = 0; page < maxPages; page++) {
    const board = await tatsuApi.getGuildRankings(tatsuGuild, "all", page * 100);
    const rows = board.rankings ?? [];
    const hit = rows.find(r => r.user_id === userId);
    if (hit) return { userId: hit.user_id, rank: hit.rank, score: hit.score };
    if (rows.length < 100) break;
  }
  return null;
}

/**
 * Zero points/score. Prefer board-known amounts — member GET often returns 0 for
 * leavers who still appear on the all-time leaderboard.
 */
async function zeroOutMember(
  tatsuGuild: string,
  userId: string,
  hints?: { score?: number; points?: number },
): Promise<{ pointsRemoved: number; scoreRemoved: number; note: string }> {
  let pointsTarget = Math.max(0, Math.floor(hints?.points ?? 0));
  let scoreTarget = Math.max(0, Math.floor(hints?.score ?? 0));
  const notes: string[] = [];

  try {
    const pts = await tatsuApi.getMemberPoints(tatsuGuild, userId);
    if (pts.points > pointsTarget) pointsTarget = pts.points;
  } catch {
    notes.push("points lookup skipped");
  }
  try {
    const rank = await tatsuApi.getMemberRanking(tatsuGuild, userId, "all");
    if (rank.score > scoreTarget) scoreTarget = rank.score;
  } catch {
    notes.push("score lookup skipped");
  }

  let pointsRemoved = 0;
  let scoreRemoved = 0;
  if (pointsTarget > 0) {
    await tatsuApi.modifyPointsChunked(tatsuGuild, userId, pointsTarget, 1);
    pointsRemoved = pointsTarget;
  }
  if (scoreTarget > 0) {
    await tatsuApi.modifyScoreChunked(tatsuGuild, userId, scoreTarget, 1);
    scoreRemoved = scoreTarget;
  }
  if (!pointsRemoved && !scoreRemoved) {
    notes.push("nothing to remove (0 points & 0 score from API + board hint)");
  }
  return { pointsRemoved, scoreRemoved, note: notes.join("; ") };
}

function editActionSelect(userId: string) {
  return new StringSelectMenuBuilder()
    .setCustomId(`tatsu:edit_action:${userId}`)
    .setPlaceholder("Choose what to edit…")
    .addOptions(
      { label: "Adjust points (add/remove)", value: "adjust_points", emoji: "💠" },
      { label: "Adjust score (add/remove)", value: "adjust_score", emoji: "⭐" },
      { label: "Zero SCORE only (clear board rank)", value: "zero_score", emoji: "🧹", description: "Uses board score if member API is 0" },
      { label: "Zero POINTS only", value: "zero_points", emoji: "💠" },
      { label: "Zero BOTH (points + score)", value: "zero_both", emoji: "🪓", description: "Best way to remove from leaderboard" },
    );
}

async function showEditUserPanel(
  interaction: ButtonInteraction | UserSelectMenuInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
  guildId: string,
  tatsuGuild: string,
  userId: string,
  opts?: { boardRank?: number; boardScore?: number },
): Promise<void> {
  const lines: string[] = [`User: <@${userId}> (\`${userId}\`)`];
  let inServer = false;
  if (interaction.guild) {
    inServer = await memberStillHere(interaction.guild, userId);
    lines.push(`In this server: **${inServer ? "yes" : "no — left / never joined"}**`);
  }

  let boardRank = opts?.boardRank;
  let boardScore = opts?.boardScore;

  // If we don't already have board context, search the all-time board (why leavers still show up).
  if (isTatsuConfigured() && (boardRank == null || boardScore == null)) {
    try {
      const onBoard = await findUserOnAllTimeBoard(tatsuGuild, userId);
      if (onBoard) {
        boardRank = onBoard.rank;
        boardScore = onBoard.score;
      }
    } catch {
      lines.push("Board scan: _failed (rate limit?)_");
    }
  }

  if (boardRank != null && boardScore != null) {
    lines.push(`**All-time board:** rank **#${boardRank}** · score **${fmt(boardScore)}** ← this is what keeps them listed`);
    editBoardCtx.set(editCtxKey(guildId, userId), {
      userId,
      boardRank,
      boardScore,
      expires: Date.now() + 15 * 60_000,
    });
  } else {
    lines.push("**All-time board:** _not found in top scanned pages_ (may already be clear, or deeper than scan)");
    editBoardCtx.delete(editCtxKey(guildId, userId));
  }

  if (isTatsuConfigured()) {
    try {
      const pts = await tatsuApi.getMemberPoints(tatsuGuild, userId);
      lines.push(`Member points API: **${fmt(pts.points)}** · points-rank **#${pts.rank}**`);
    } catch (err) {
      lines.push(`Member points API: _${err instanceof Error ? err.message : "unavailable"}_`);
    }
    for (const p of ["all", "month", "week"] as TatsuPeriod[]) {
      try {
        const r = await tatsuApi.getMemberRanking(tatsuGuild, userId, p);
        lines.push(`Member score API (${periodLabel(p)}): **${fmt(r.score)}** · rank **#${r.rank}**`);
      } catch {
        lines.push(`Member score API (${periodLabel(p)}): _—_`);
      }
    }
    try {
      const prof = await tatsuApi.getUserProfile(userId);
      lines.push(
        "",
        `Global profile: **${prof.username ?? "?"}** · rep **${fmt(prof.reputation)}** _(read-only)_ · XP **${fmt(prof.xp)}**`,
      );
    } catch { /* optional */ }
  } else {
    lines.push("_Tatsu API key not configured._");
  }

  lines.push(
    "",
    "_If member APIs say 0 but the board still lists them, use the dropdown → **Zero SCORE** or **Zero BOTH** (uses board score)._",
  );

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(TATSU_COLOR)
        .setTitle(boardRank != null ? `✏️ Edit · all-time #${boardRank}` : "✏️ Edit Tatsu user")
        .setDescription(lines.join("\n").slice(0, 4000)),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(editActionSelect(userId)),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`tatsu:edit_panel:${userId}`).setLabel("Refresh").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("tatsu:goto_rank").setLabel("Go to rank #").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("tatsu:leaderboard").setLabel("Leaderboard").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("tatsu:overview").setLabel("Home").setStyle(ButtonStyle.Primary),
      ),
    ],
  });
}

export async function handleTatsuAdminComponent(
  interaction: ButtonInteraction | StringSelectMenuInteraction | UserSelectMenuInteraction | ChannelSelectMenuInteraction,
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
  const settings = await getOrCreateTatsuSettings(guildId);
  const tatsuGuild = settings.tatsuGuildId || guildId;

  if (id === "tatsu:overview" && interaction.isButton()) {
    await interaction.deferUpdate();
    const embed = await buildOverviewEmbed(guildId);
    await interaction.editReply({ embeds: [embed], components: hubRows() });
    return;
  }

  if ((id === "tatsu:leaderboard" || id.startsWith("tatsu:lb_")) && interaction.isButton()) {
    await interaction.deferUpdate();
    try {
      let period = rankingPeriodOf(settings.rankingPeriod);
      let offset = 0;
      if (id.startsWith("tatsu:lb_")) {
        const parts = id.split(":"); // tatsu:lb_next:all:20
        period = (parts[2] as TatsuPeriod) || period;
        offset = Math.max(0, Number(parts[3] ?? 0) || 0);
      }
      const view = await renderLeaderboard(guildId, period, offset);
      await interaction.editReply({ embeds: [view.embed], components: view.components });
    } catch (err) {
      await interaction.editReply({
        content: `⚠️ Leaderboard failed: ${err instanceof Error ? err.message : err}`,
        embeds: [],
        components: hubRows(),
      }).catch(() => {});
    }
    return;
  }

  if (id === "tatsu:period_select" && interaction.isStringSelectMenu()) {
    await interaction.deferUpdate();
    const period = (interaction.values[0] ?? "all") as TatsuPeriod;
    await updateTatsuSettings(guildId, { rankingPeriod: period });
    const view = await renderLeaderboard(guildId, period, 0);
    await interaction.editReply({ embeds: [view.embed], components: view.components });
    return;
  }

  if (id === "tatsu:period" && interaction.isButton()) {
    await interaction.deferUpdate();
    const menu = new StringSelectMenuBuilder()
      .setCustomId("tatsu:period_home")
      .setPlaceholder("Default ranking period for this dashboard…")
      .addOptions(
        { label: "All-time", value: "all", default: settings.rankingPeriod === "all" },
        { label: "This month", value: "month", default: settings.rankingPeriod === "month" },
        { label: "This week", value: "week", default: settings.rankingPeriod === "week" },
      );
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(TATSU_COLOR)
          .setTitle("📅 Ranking period")
          .setDescription(`Current default: **${periodLabel(settings.rankingPeriod)}**`),
      ],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("tatsu:overview").setLabel("Home").setStyle(ButtonStyle.Primary),
        ),
      ],
    });
    return;
  }

  if (id === "tatsu:period_home" && interaction.isStringSelectMenu()) {
    await interaction.deferUpdate();
    const period = interaction.values[0] ?? "all";
    await updateTatsuSettings(guildId, { rankingPeriod: period });
    const embed = await buildOverviewEmbed(guildId);
    await interaction.editReply({ embeds: [embed], components: hubRows() });
    return;
  }

  if (id === "tatsu:toggle" && interaction.isButton()) {
    await interaction.deferUpdate();
    await updateTatsuSettings(guildId, { enabled: !settings.enabled });
    const embed = await buildOverviewEmbed(guildId);
    await interaction.editReply({ embeds: [embed], components: hubRows() });
    return;
  }

  if (id === "tatsu:logs" && interaction.isButton()) {
    await interaction.deferUpdate();
    const pick = new ChannelSelectMenuBuilder()
      .setCustomId("tatsu:log_channel")
      .setPlaceholder("Pick a log channel…")
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setMinValues(1)
      .setMaxValues(1);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(TATSU_COLOR)
          .setTitle("📢 Log channel")
          .setDescription(`Current: **${settings.logChannelId ? `<#${settings.logChannelId}>` : "not set"}**`),
      ],
      components: [
        new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(pick),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("tatsu:log_clear").setLabel("Clear").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("tatsu:overview").setLabel("Home").setStyle(ButtonStyle.Primary),
        ),
      ],
    });
    return;
  }

  if (id === "tatsu:log_channel" && interaction.isChannelSelectMenu()) {
    await interaction.deferUpdate();
    const ch = interaction.values[0];
    await updateTatsuSettings(guildId, { logChannelId: ch });
    const embed = await buildOverviewEmbed(guildId);
    await interaction.editReply({ embeds: [embed], components: hubRows() });
    return;
  }

  if (id === "tatsu:log_clear" && interaction.isButton()) {
    await interaction.deferUpdate();
    await updateTatsuSettings(guildId, { logChannelId: null });
    const embed = await buildOverviewEmbed(guildId);
    await interaction.editReply({ embeds: [embed], components: hubRows() });
    return;
  }

  if (id === "tatsu:lookup" && interaction.isButton()) {
    await interaction.deferUpdate();
    const pick = new UserSelectMenuBuilder()
      .setCustomId("tatsu:lookup_user")
      .setPlaceholder("Pick a member to inspect…")
      .setMinValues(1)
      .setMaxValues(1);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(TATSU_COLOR)
          .setTitle("🔍 Lookup user")
          .setDescription("Pulls **guild points**, **score ranks** (all/month/week), and **global Tatsu profile**."),
      ],
      components: [
        new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(pick),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("tatsu:overview").setLabel("Home").setStyle(ButtonStyle.Primary),
        ),
      ],
    });
    return;
  }

  if (id === "tatsu:lookup_user" && interaction.isUserSelectMenu()) {
    await interaction.deferUpdate();
    const userId = interaction.values[0]!;
    const lines: string[] = [];
    if (!isTatsuConfigured() || !settings.enabled) {
      lines.push("_API off or key missing._");
    } else {
      try {
        const [points, all, month, week, profile] = await Promise.all([
          tatsuApi.getMemberPoints(tatsuGuild, userId).catch(e => e as Error),
          tatsuApi.getMemberRanking(tatsuGuild, userId, "all").catch(e => e as Error),
          tatsuApi.getMemberRanking(tatsuGuild, userId, "month").catch(e => e as Error),
          tatsuApi.getMemberRanking(tatsuGuild, userId, "week").catch(e => e as Error),
          tatsuApi.getUserProfile(userId).catch(e => e as Error),
        ]);
        if (points instanceof Error) lines.push(`Points: ⚠️ ${points.message}`);
        else lines.push(`**Points:** ${fmt(points.points)} · points-rank **#${points.rank}**`);
        if (all instanceof Error) lines.push(`All-time score: ⚠️ ${all.message}`);
        else lines.push(`**All-time score:** ${fmt(all.score)} · rank **#${all.rank}**`);
        if (month instanceof Error) lines.push(`Month score: ⚠️ ${month.message}`);
        else lines.push(`**Month score:** ${fmt(month.score)} · rank **#${month.rank}**`);
        if (week instanceof Error) lines.push(`Week score: ⚠️ ${week.message}`);
        else lines.push(`**Week score:** ${fmt(week.score)} · rank **#${week.rank}**`);
        if (profile instanceof Error) lines.push(`Global profile: ⚠️ ${profile.message}`);
        else {
          lines.push("");
          lines.push(`**Global profile** — ${profile.username ?? "?"} · XP ${fmt(profile.xp)} · rep ${fmt(profile.reputation)}`);
          lines.push(`Credits ${fmt(profile.credits)} · tokens ${fmt(profile.tokens)} · sub type ${profile.subscription_type}`);
          if (profile.title) lines.push(`Title: ${profile.title}`);
        }
      } catch (err) {
        lines.push(`⚠️ ${err instanceof Error ? err.message : "Lookup failed"}`);
      }
    }
    const watch = await listWatchlist(guildId);
    const onWatch = watch.some(w => w.userId === userId);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(TATSU_COLOR)
          .setTitle(`🔍 <@${userId}>`)
          .setDescription(lines.join("\n") + (onWatch ? "\n\n👁️ **On watchlist**" : "")),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`tatsu:watch_add_quick:${userId}`).setLabel(onWatch ? "Update watch note" : "Add to watchlist").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("tatsu:lookup").setLabel("Lookup another").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("tatsu:overview").setLabel("Home").setStyle(ButtonStyle.Primary),
        ),
      ],
    });
    return;
  }

  if (id === "tatsu:points" && interaction.isButton()) {
    await interaction.deferUpdate();
    const pick = new UserSelectMenuBuilder().setCustomId("tatsu:points_user").setPlaceholder("Member for points adjust…").setMinValues(1).setMaxValues(1);
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(TATSU_COLOR).setTitle("💠 Adjust points").setDescription(
        `Add or remove server points (API max **${fmt(TATSU_MODIFY_MAX)}**/call; larger amounts are chunked).\n` +
        `Left the server? Use **Enter user ID** below.`,
      )],
      components: [
        new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(pick),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("tatsu:points_by_id").setLabel("Enter user ID").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("tatsu:overview").setLabel("Home").setStyle(ButtonStyle.Primary),
        ),
      ],
    });
    return;
  }

  if (id === "tatsu:points_by_id" && interaction.isButton()) {
    await interaction.deferUpdate();
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(TATSU_COLOR).setTitle("💠 Points by user ID").setDescription(
        "Choose **Add** or **Remove**, then enter the Discord snowflake + amount.",
      )],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("tatsu:points_id_do:add").setLabel("➕ Add by ID").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("tatsu:points_id_do:remove").setLabel("➖ Remove by ID").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("tatsu:overview").setLabel("Home").setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    return;
  }

  if (id.startsWith("tatsu:points_id_do:") && interaction.isButton()) {
    const action = id.split(":")[2] as "add" | "remove";
    if (action !== "add" && action !== "remove") return;
    await interaction.showModal(pointsIdModal(action));
    return;
  }

  if (id === "tatsu:points_user" && interaction.isUserSelectMenu()) {
    const userId = interaction.values[0]!;
    await interaction.deferUpdate();
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(TATSU_COLOR).setTitle("💠 Adjust points").setDescription(
        `Member: <@${userId}>\nPick **Add** or **Remove** — no typing \`add\`/\`remove\`.`,
      )],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`tatsu:points_do:add:${userId}`).setLabel("➕ Add points").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`tatsu:points_do:remove:${userId}`).setLabel("➖ Remove points").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("tatsu:overview").setLabel("Home").setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    return;
  }

  if (id.startsWith("tatsu:points_do:") && interaction.isButton()) {
    const parts = id.split(":");
    const action = parts[2] as "add" | "remove";
    const userId = parts[3]!;
    if (action !== "add" && action !== "remove") return;
    await interaction.showModal(pointsAmountModal(
      `tatsu:points_modal:${action}:${userId}`,
      action === "add" ? "Add Tatsu points" : "Remove Tatsu points",
    ));
    return;
  }

  if (id.startsWith("tatsu:points_for:") && interaction.isButton()) {
    const userId = id.slice("tatsu:points_for:".length);
    await interaction.deferUpdate();
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(TATSU_COLOR).setTitle("💠 Adjust points").setDescription(
        `Member: <@${userId}>\nPick **Add** or **Remove**.`,
      )],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`tatsu:points_do:add:${userId}`).setLabel("➕ Add points").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`tatsu:points_do:remove:${userId}`).setLabel("➖ Remove points").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("tatsu:overview").setLabel("Home").setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    return;
  }

  if (id === "tatsu:score" && interaction.isButton()) {
    await interaction.deferUpdate();
    const pick = new UserSelectMenuBuilder().setCustomId("tatsu:score_user").setPlaceholder("Member for score adjust…").setMinValues(1).setMaxValues(1);
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(TATSU_COLOR).setTitle("⭐ Adjust score").setDescription(
        `Add or remove XP/score (API max **${fmt(TATSU_MODIFY_MAX)}**/call; larger amounts are chunked).\n` +
        `Left the server? Use **Enter user ID** below.`,
      )],
      components: [
        new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(pick),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("tatsu:score_by_id").setLabel("Enter user ID").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("tatsu:overview").setLabel("Home").setStyle(ButtonStyle.Primary),
        ),
      ],
    });
    return;
  }

  if (id === "tatsu:score_by_id" && interaction.isButton()) {
    await interaction.deferUpdate();
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(TATSU_COLOR).setTitle("⭐ Score by user ID").setDescription(
        "Choose **Add** or **Remove**, then enter the Discord snowflake + amount.",
      )],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("tatsu:score_id_do:add").setLabel("➕ Add by ID").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("tatsu:score_id_do:remove").setLabel("➖ Remove by ID").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("tatsu:overview").setLabel("Home").setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    return;
  }

  if (id.startsWith("tatsu:score_id_do:") && interaction.isButton()) {
    const action = id.split(":")[2] as "add" | "remove";
    if (action !== "add" && action !== "remove") return;
    await interaction.showModal(scoreIdModal(action));
    return;
  }

  if (id === "tatsu:edit" && interaction.isButton()) {
    await interaction.deferUpdate();
    const pick = new UserSelectMenuBuilder().setCustomId("tatsu:edit_user").setPlaceholder("Pick a member to edit…").setMinValues(1).setMaxValues(1);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(TATSU_COLOR)
          .setTitle("✏️ Edit Tatsu user")
          .setDescription(
            [
              "Pick a member, **Enter user ID**, or use **Go to rank #** on the leaderboard.",
              "",
              "For ghosts still on the all-time board: type their rank number → dropdown → **Zero SCORE** or **Zero BOTH**.",
              "Member APIs often show **0** for leavers even while the board still lists their score — we use the **board score** when zeroing.",
              "",
              "**Can edit via API:** server points · server score.",
              "**Cannot:** reputation · true wipe without remove amounts.",
            ].join("\n"),
          ),
      ],
      components: [
        new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(pick),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("tatsu:edit_by_id").setLabel("Enter user ID").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("tatsu:goto_rank").setLabel("Go to rank #").setEmoji("🎯").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("tatsu:overview").setLabel("Home").setStyle(ButtonStyle.Primary),
        ),
      ],
    });
    return;
  }

  if (id === "tatsu:edit_by_id" && interaction.isButton()) {
    const modal = new ModalBuilder()
      .setCustomId("tatsu:edit_id_modal")
      .setTitle("Edit user by Discord ID")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("user_id").setLabel("Discord user ID").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  if (id === "tatsu:edit_user" && interaction.isUserSelectMenu()) {
    await interaction.deferUpdate();
    const userId = interaction.values[0]!;
    await showEditUserPanel(interaction, guildId, tatsuGuild, userId);
    return;
  }

  if (id.startsWith("tatsu:edit_panel:") && interaction.isButton()) {
    await interaction.deferUpdate();
    const userId = id.slice("tatsu:edit_panel:".length);
    const ctx = editBoardCtx.get(editCtxKey(guildId, userId));
    const board = ctx && ctx.expires > Date.now()
      ? { boardRank: ctx.boardRank, boardScore: ctx.boardScore }
      : undefined;
    await showEditUserPanel(interaction, guildId, tatsuGuild, userId, board);
    return;
  }

  if (id === "tatsu:goto_rank" && interaction.isButton()) {
    const modal = new ModalBuilder()
      .setCustomId("tatsu:goto_rank_modal")
      .setTitle("All-time leaderboard rank")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("rank")
            .setLabel("Rank number (all-time only)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder("e.g. 1  ·  47  ·  120"),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  if (id.startsWith("tatsu:edit_action:") && interaction.isStringSelectMenu()) {
    const userId = id.slice("tatsu:edit_action:".length);
    const choice = interaction.values[0]!;
    const ctx = editBoardCtx.get(editCtxKey(guildId, userId));
    const boardScore = ctx && ctx.expires > Date.now() ? ctx.boardScore : undefined;

    if (choice === "adjust_points") {
      await interaction.deferUpdate();
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(TATSU_COLOR).setTitle("💠 Adjust points").setDescription(
          `Member: <@${userId}>\nPick **Add** or **Remove**.`,
        )],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`tatsu:points_do:add:${userId}`).setLabel("➕ Add points").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`tatsu:points_do:remove:${userId}`).setLabel("➖ Remove points").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("tatsu:overview").setLabel("Home").setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
      return;
    }
    if (choice === "adjust_score") {
      await interaction.deferUpdate();
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(TATSU_COLOR).setTitle("⭐ Adjust score").setDescription(
          `Member: <@${userId}>\nPick **Add** or **Remove**.` +
          (boardScore != null ? `\n_Board score hint: **${fmt(boardScore)}**_` : ""),
        )],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`tatsu:score_do:add:${userId}`).setLabel("➕ Add score").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`tatsu:score_do:remove:${userId}`).setLabel("➖ Remove score").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("tatsu:overview").setLabel("Home").setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
      return;
    }

    await interaction.deferUpdate();
    if (!isTatsuConfigured() || !settings.enabled) {
      await interaction.editReply({ content: "Tatsu API key missing or link disabled.", embeds: [], components: hubRows() });
      return;
    }
    try {
      let result: { pointsRemoved: number; scoreRemoved: number; note: string };

      if (choice === "zero_score") {
        let scoreTarget = boardScore ?? 0;
        try {
          const r = await tatsuApi.getMemberRanking(tatsuGuild, userId, "all");
          if (r.score > scoreTarget) scoreTarget = r.score;
        } catch { /* use board */ }
        if (scoreTarget > 0) {
          await tatsuApi.modifyScoreChunked(tatsuGuild, userId, scoreTarget, 1);
          result = {
            pointsRemoved: 0,
            scoreRemoved: scoreTarget,
            note: boardScore != null ? "removed using all-time board score" : "removed using member API score",
          };
        } else {
          result = { pointsRemoved: 0, scoreRemoved: 0, note: "no score to remove (board + API both 0)" };
        }
      } else if (choice === "zero_points") {
        let pointsTarget = 0;
        try {
          const p = await tatsuApi.getMemberPoints(tatsuGuild, userId);
          pointsTarget = p.points;
        } catch { /* */ }
        if (pointsTarget > 0) {
          await tatsuApi.modifyPointsChunked(tatsuGuild, userId, pointsTarget, 1);
          result = { pointsRemoved: pointsTarget, scoreRemoved: 0, note: "" };
        } else {
          result = { pointsRemoved: 0, scoreRemoved: 0, note: "no points to remove" };
        }
      } else if (choice === "zero_both") {
        result = await zeroOutMember(tatsuGuild, userId, { score: boardScore });
      } else {
        result = { pointsRemoved: 0, scoreRemoved: 0, note: "unknown action" };
      }

      await writeTatsuAudit({
        guildId,
        actorId: interaction.user.id,
        targetUserId: userId,
        action: choice,
        detail: { ...result, boardScore },
      });
      editBoardCtx.delete(editCtxKey(guildId, userId));
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(TATSU_COLOR)
            .setTitle("🧹 Edit applied")
            .setDescription(
              [
                `<@${userId}> (\`${userId}\`)`,
                `−**${fmt(result.pointsRemoved)}** points · −**${fmt(result.scoreRemoved)}** score`,
                result.note ? `_${result.note}_` : null,
                "",
                "Re-open **Go to rank #** or **Leaderboard** to verify (Tatsu may lag a few seconds).",
              ].filter(Boolean).join("\n"),
            ),
        ],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("tatsu:goto_rank").setLabel("Go to rank #").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("tatsu:leaderboard").setLabel("Leaderboard").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`tatsu:edit_panel:${userId}`).setLabel("Re-check user").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("tatsu:overview").setLabel("Home").setStyle(ButtonStyle.Primary),
          ),
        ],
      });
    } catch (err) {
      await interaction.editReply({
        content: `⚠️ ${err instanceof Error ? err.message : "Edit failed"}`,
        embeds: [],
        components: hubRows(),
      }).catch(() => {});
    }
    return;
  }

  if (id.startsWith("tatsu:zero:") && interaction.isButton()) {
    await interaction.deferUpdate();
    const userId = id.slice("tatsu:zero:".length);
    if (!isTatsuConfigured() || !settings.enabled) {
      await interaction.editReply({ content: "Tatsu API key missing or link disabled.", embeds: [], components: hubRows() });
      return;
    }
    try {
      const ctx = editBoardCtx.get(editCtxKey(guildId, userId));
      const result = await zeroOutMember(
        tatsuGuild,
        userId,
        ctx && ctx.expires > Date.now() ? { score: ctx.boardScore } : undefined,
      );
      await writeTatsuAudit({
        guildId,
        actorId: interaction.user.id,
        targetUserId: userId,
        action: "zero_out",
        detail: result,
      });
      editBoardCtx.delete(editCtxKey(guildId, userId));
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(TATSU_COLOR)
            .setTitle("🧹 Cleared from board")
            .setDescription(
              `Removed **${fmt(result.pointsRemoved)}** points and **${fmt(result.scoreRemoved)}** score from <@${userId}>.\n` +
              (result.note ? `_${result.note}_\n` : "") +
              `_Tatsu has no wipe endpoint — we remove score/points until the board drops them._`,
            ),
        ],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("tatsu:goto_rank").setLabel("Go to rank #").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("tatsu:leaderboard").setLabel("Leaderboard").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("tatsu:edit").setLabel("Edit another").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("tatsu:overview").setLabel("Home").setStyle(ButtonStyle.Primary),
          ),
        ],
      });
    } catch (err) {
      await interaction.editReply({
        content: `⚠️ ${err instanceof Error ? err.message : "Zero-out failed"}`,
        embeds: [],
        components: hubRows(),
      }).catch(() => {});
    }
    return;
  }

  if (id === "tatsu:score_user" && interaction.isUserSelectMenu()) {
    const userId = interaction.values[0]!;
    await interaction.deferUpdate();
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(TATSU_COLOR).setTitle("⭐ Adjust score").setDescription(
        `Member: <@${userId}>\nPick **Add** or **Remove**.`,
      )],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`tatsu:score_do:add:${userId}`).setLabel("➕ Add score").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`tatsu:score_do:remove:${userId}`).setLabel("➖ Remove score").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("tatsu:overview").setLabel("Home").setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    return;
  }

  if (id.startsWith("tatsu:score_do:") && interaction.isButton()) {
    const parts = id.split(":");
    const action = parts[2] as "add" | "remove";
    const userId = parts[3]!;
    if (action !== "add" && action !== "remove") return;
    await interaction.showModal(pointsAmountModal(
      `tatsu:score_modal:${action}:${userId}`,
      action === "add" ? "Add Tatsu score" : "Remove Tatsu score",
    ));
    return;
  }

  if (id.startsWith("tatsu:score_for:") && interaction.isButton()) {
    const userId = id.slice("tatsu:score_for:".length);
    await interaction.deferUpdate();
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(TATSU_COLOR).setTitle("⭐ Adjust score").setDescription(
        `Member: <@${userId}>\nPick **Add** or **Remove**.`,
      )],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`tatsu:score_do:add:${userId}`).setLabel("➕ Add score").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`tatsu:score_do:remove:${userId}`).setLabel("➖ Remove score").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("tatsu:overview").setLabel("Home").setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    return;
  }

  if (id === "tatsu:prune" && interaction.isButton()) {
    await interaction.deferUpdate();
    if (!interaction.guild) {
      await interaction.editReply({ content: "Server only.", embeds: [], components: hubRows() });
      return;
    }
    if (!isTatsuConfigured() || !settings.enabled) {
      await interaction.editReply({ content: "Tatsu API key missing or link disabled.", embeds: [], components: hubRows() });
      return;
    }
    try {
      const period = rankingPeriodOf(settings.rankingPeriod);
      const rankings = await tatsuApi.collectRankings(tatsuGuild, period, PRUNE_SCAN_PAGES);
      const ghosts: GhostRow[] = [];
      for (const row of rankings) {
        if (!(await memberStillHere(interaction.guild, row.user_id))) {
          ghosts.push({ userId: row.user_id, rank: row.rank, score: row.score });
        }
      }
      prunePreview.set(guildId, { period, ghosts, expires: Date.now() + 10 * 60_000 });
      const show = ghosts.slice(0, 25);
      const lines = show.length
        ? show.map(g => `**#${g.rank}.** <@${g.userId}> (\`${g.userId}\`) — score **${fmt(g.score)}**`).join("\n")
        : "_No left-server accounts found in the scanned top ranks._";
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xed4245)
            .setTitle("🧹 Prune left members")
            .setDescription(
              [
                `Scanned top **${rankings.length}** on **${periodLabel(period)}** (≤${PRUNE_SCAN_PAGES} API pages).`,
                `Found **${ghosts.length}** not in this Discord server.`,
                "",
                lines,
                "",
                ghosts.length
                  ? `**Confirm strip** zeros points + score for up to **${Math.min(PRUNE_STRIP_MAX, ghosts.length)}** (API has no wipe — we remove balances).`
                  : "Nothing to strip.",
              ].join("\n").slice(0, 4000),
            ),
        ],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId("tatsu:prune_confirm")
              .setLabel(ghosts.length ? `Strip ${Math.min(PRUNE_STRIP_MAX, ghosts.length)} ghosts` : "Nothing to strip")
              .setStyle(ButtonStyle.Danger)
              .setDisabled(ghosts.length === 0),
            new ButtonBuilder().setCustomId("tatsu:leaderboard").setLabel("Back").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("tatsu:overview").setLabel("Home").setStyle(ButtonStyle.Primary),
          ),
        ],
      });
    } catch (err) {
      await interaction.editReply({
        content: `⚠️ Prune scan failed: ${err instanceof Error ? err.message : err}`,
        embeds: [],
        components: hubRows(),
      }).catch(() => {});
    }
    return;
  }

  if (id === "tatsu:prune_confirm" && interaction.isButton()) {
    await interaction.deferUpdate();
    const preview = prunePreview.get(guildId);
    if (!preview || preview.expires < Date.now() || !preview.ghosts.length) {
      await interaction.editReply({
        content: "Prune preview expired — open **Leaderboard → Prune left** again.",
        embeds: [],
        components: hubRows(),
      });
      return;
    }
    if (!isTatsuConfigured() || !settings.enabled) {
      await interaction.editReply({ content: "Tatsu API key missing or link disabled.", embeds: [], components: hubRows() });
      return;
    }
    const batch = preview.ghosts.slice(0, PRUNE_STRIP_MAX);
    const results: string[] = [];
    for (const g of batch) {
      try {
        const z = await zeroOutMember(tatsuGuild, g.userId, { score: g.score });
        results.push(
          `• <@${g.userId}> −${fmt(z.pointsRemoved)} pts · −${fmt(z.scoreRemoved)} score` +
          (z.note ? ` (_${z.note}_)` : ""),
        );
        await writeTatsuAudit({
          guildId,
          actorId: interaction.user.id,
          targetUserId: g.userId,
          action: "prune_left",
          detail: z,
        });
      } catch (err) {
        results.push(`• <@${g.userId}> ⚠️ ${err instanceof Error ? err.message : "failed"}`);
      }
    }
    prunePreview.delete(guildId);
    const remaining = preview.ghosts.length - batch.length;
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(TATSU_COLOR)
          .setTitle("🧹 Prune complete")
          .setDescription(
            (results.join("\n") + (remaining > 0 ? `\n\n_${remaining} more ghosts left — run Prune again._` : ""))
              .slice(0, 4000),
          ),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("tatsu:prune").setLabel(remaining > 0 ? "Prune again" : "Scan again").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("tatsu:leaderboard").setLabel("Leaderboard").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("tatsu:overview").setLabel("Home").setStyle(ButtonStyle.Primary),
        ),
      ],
    });
    return;
  }

  if (id === "tatsu:strip" && interaction.isButton()) {
    await interaction.deferUpdate();
    const pick = new UserSelectMenuBuilder().setCustomId("tatsu:strip_user").setPlaceholder("Suspected spam account…").setMinValues(1).setMaxValues(1);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle("🪓 Strip spam gains")
          .setDescription(
            "Removes **points and/or score** from a member in one go (chunked).\n" +
            "Use after spotting a climber. For message-rate / persistence, still use Tatsu's `t@persistence`.",
          ),
      ],
      components: [
        new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(pick),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("tatsu:overview").setLabel("Home").setStyle(ButtonStyle.Primary),
        ),
      ],
    });
    return;
  }

  if (id === "tatsu:strip_user" && interaction.isUserSelectMenu()) {
    const userId = interaction.values[0]!;
    const modal = new ModalBuilder()
      .setCustomId(`tatsu:strip_modal:${userId}`)
      .setTitle("Strip Tatsu spam")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("points").setLabel("Points to REMOVE (0 = skip)").setStyle(TextInputStyle.Short).setRequired(true).setValue("0"),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("score").setLabel("Score to REMOVE (0 = skip)").setStyle(TextInputStyle.Short).setRequired(true).setValue("0"),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("reason").setLabel("Reason").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("spam / farming"),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  if (id === "tatsu:watch" && interaction.isButton()) {
    await interaction.deferUpdate();
    const watch = await listWatchlist(guildId);
    const lines = watch.length
      ? watch.slice(0, 20).map(w =>
        `• <@${w.userId}> — ${w.note ? w.note.slice(0, 80) : "_no note_"} · by <@${w.flaggedBy}>`,
      ).join("\n")
      : "_Watchlist empty._";
    const pick = new UserSelectMenuBuilder().setCustomId("tatsu:watch_add").setPlaceholder("Add / update watch…").setMinValues(1).setMaxValues(1);
    const rem = new UserSelectMenuBuilder().setCustomId("tatsu:watch_remove").setPlaceholder("Remove from watch…").setMinValues(1).setMaxValues(1);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(TATSU_COLOR)
          .setTitle("👁️ Spam watchlist")
          .setDescription(lines)
          .setFooter({ text: `${watch.length} watched · local to DN Cards (not synced to Tatsu)` }),
      ],
      components: [
        new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(pick),
        new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(rem),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("tatsu:overview").setLabel("Home").setStyle(ButtonStyle.Primary),
        ),
      ],
    });
    return;
  }

  if (id === "tatsu:watch_add" && interaction.isUserSelectMenu()) {
    const userId = interaction.values[0]!;
    const modal = new ModalBuilder()
      .setCustomId(`tatsu:watch_modal:${userId}`)
      .setTitle("Watchlist note")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("note").setLabel("Why are they watched?").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(400),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  if (id.startsWith("tatsu:watch_add_quick:") && interaction.isButton()) {
    const userId = id.slice("tatsu:watch_add_quick:".length);
    const modal = new ModalBuilder()
      .setCustomId(`tatsu:watch_modal:${userId}`)
      .setTitle("Watchlist note")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("note").setLabel("Why are they watched?").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(400),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  if (id === "tatsu:watch_remove" && interaction.isUserSelectMenu()) {
    await interaction.deferUpdate();
    const userId = interaction.values[0]!;
    const removed = await removeWatchlist(guildId, userId);
    await writeTatsuAudit({
      guildId,
      actorId: interaction.user.id,
      targetUserId: userId,
      action: "watch_remove",
      detail: { removed },
    });
    const watch = await listWatchlist(guildId);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(TATSU_COLOR)
          .setTitle("👁️ Watchlist")
          .setDescription(removed ? `Removed <@${userId}>.\n\n${watch.length} remaining.` : `<@${userId}> was not on the list.`),
      ],
      components: hubRows(),
    });
    return;
  }

  if (id === "tatsu:snapshot" && interaction.isButton()) {
    await interaction.deferUpdate();
    if (!isTatsuConfigured() || !settings.enabled) {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0xed4245).setTitle("📸 Snapshot").setDescription("Enable the API link and set `TATSU_API_KEY` first.")],
        components: hubRows(),
      });
      return;
    }
    const period = rankingPeriodOf(settings.rankingPeriod);
    try {
      const rows = await tatsuApi.collectRankings(tatsuGuild, period, 3);
      const compact = rows.map(r => ({ user_id: r.user_id, rank: r.rank, score: r.score }));
      const prev = await latestSnapshot(guildId, period);
      await saveSnapshot({
        guildId,
        period,
        rankings: compact,
        takenBy: interaction.user.id,
      });
      await writeTatsuAudit({
        guildId,
        actorId: interaction.user.id,
        action: "snapshot",
        detail: { period, count: compact.length },
      });

      const climbers: string[] = [];
      if (prev) {
        const prevRows = (prev.rankings ?? []) as Array<{ user_id: string; rank: number; score: number }>;
        const before = new Map(prevRows.map(r => [r.user_id, Number(r.score)]));
        for (const r of compact) {
          const old = before.get(r.user_id);
          if (old == null) {
            if (r.score >= settings.spamScoreDelta) {
              climbers.push(`🆕 <@${r.user_id}> entered at **${fmt(r.score)}** (rank #${r.rank})`);
            }
            continue;
          }
          const delta = r.score - old;
          if (delta >= settings.spamScoreDelta) {
            climbers.push(`📈 <@${r.user_id}> **+${fmt(delta)}** → ${fmt(r.score)} (#${r.rank})`);
          }
        }
      }

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(TATSU_COLOR)
            .setTitle(`📸 Snapshot · ${periodLabel(period)}`)
            .setDescription(
              [
                `Saved **${compact.length}** rankings.`,
                prev ? `Compared against snapshot from <t:${Math.floor(prev.createdAt.getTime() / 1000)}:R>.` : "_First snapshot — take another later to detect climbers._",
                "",
                climbers.length ? `**Rapid climbers** (Δ ≥ ${fmt(settings.spamScoreDelta)}):\n${climbers.slice(0, 15).join("\n")}` : "_No rapid climbers vs previous snapshot._",
              ].join("\n"),
            ),
        ],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("tatsu:spam_delta").setLabel("Edit delta threshold").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("tatsu:overview").setLabel("Home").setStyle(ButtonStyle.Primary),
          ),
        ],
      });
    } catch (err) {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0xed4245).setTitle("📸 Snapshot failed").setDescription(err instanceof Error ? err.message : "error")],
        components: hubRows(),
      });
    }
    return;
  }

  if (id === "tatsu:spam_delta" && interaction.isButton()) {
    const modal = new ModalBuilder()
      .setCustomId("tatsu:delta_modal")
      .setTitle("Spam score delta")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("delta")
            .setLabel("Flag when score rises by ≥ this much")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(String(settings.spamScoreDelta)),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  if (id === "tatsu:audit" && interaction.isButton()) {
    await interaction.deferUpdate();
    const rows = await listTatsuAudit(guildId, 12);
    const lines = rows.length
      ? rows.map(r => {
        const when = `<t:${Math.floor(r.createdAt.getTime() / 1000)}:R>`;
        const target = r.targetUserId ? ` → <@${r.targetUserId}>` : "";
        return `• ${when} <@${r.actorId}> **${r.action}**${target}`;
      }).join("\n")
      : "_No audit entries yet._";
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(TATSU_COLOR)
          .setTitle("📜 Tatsu audit log")
          .setDescription(lines),
      ],
      components: hubRows(),
    });
    return;
  }
}

export async function handleTatsuAdminModal(interaction: ModalSubmitInteraction): Promise<void> {
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
  const settings = await getOrCreateTatsuSettings(guildId);
  const tatsuGuild = settings.tatsuGuildId || guildId;

  if (id === "tatsu:delta_modal") {
    await interaction.deferReply(EPHEMERAL);
    const delta = Math.max(1, Number(interaction.fields.getTextInputValue("delta").replace(/,/g, "")) || 5000);
    await updateTatsuSettings(guildId, { spamScoreDelta: delta });
    await interaction.editReply(`✅ Spam score delta set to **${fmt(delta)}**.`);
    return;
  }

  if (id === "tatsu:edit_id_modal") {
    await interaction.deferReply(EPHEMERAL);
    const userId = interaction.fields.getTextInputValue("user_id").replace(/\D/g, "");
    if (!/^\d{17,20}$/.test(userId)) {
      await interaction.editReply("Enter a valid Discord snowflake user ID.");
      return;
    }
    // showEditUserPanel scans the all-time board so leavers still show rank/score
    await showEditUserPanel(interaction, guildId, tatsuGuild, userId);
    return;
  }

  if (id === "tatsu:goto_rank_modal") {
    await interaction.deferReply(EPHEMERAL);
    if (!isTatsuConfigured() || !settings.enabled) {
      await interaction.editReply("Tatsu API key missing or link disabled.");
      return;
    }
    const rank = Math.floor(Number(interaction.fields.getTextInputValue("rank").replace(/[,\s#]/g, "")));
    if (!Number.isFinite(rank) || rank < 1 || rank > 100_000) {
      await interaction.editReply("Enter a valid all-time rank number (1+).");
      return;
    }
    try {
      const row = await fetchAllTimeRank(tatsuGuild, rank);
      if (!row) {
        await interaction.editReply(`No one at all-time rank **#${rank}** (empty slot or past the end of the board).`);
        return;
      }
      await showEditUserPanel(interaction, guildId, tatsuGuild, row.userId, {
        boardRank: row.rank,
        boardScore: row.score,
      });
    } catch (err) {
      await interaction.editReply(`⚠️ ${err instanceof Error ? err.message : "Rank lookup failed"}`);
    }
    return;
  }

  const parseAction = (raw: string): 0 | 1 | null => {
    const a = raw.trim().toLowerCase();
    if (a === "add" || a === "0" || a === "+") return 0;
    if (a === "remove" || a === "rem" || a === "1" || a === "-" || a === "subtract" || a === "sub") return 1;
    return null;
  };

  // New: tatsu:points_id_modal:add|remove — legacy: tatsu:points_id_modal (action field)
  if (id === "tatsu:points_id_modal" || id.startsWith("tatsu:points_id_modal:")
    || id === "tatsu:score_id_modal" || id.startsWith("tatsu:score_id_modal:")) {
    await interaction.deferReply(EPHEMERAL);
    const isPoints = id.startsWith("tatsu:points_id_modal");
    const parts = id.split(":");
    const actionFromId = parts[2] === "add" ? 0 as const : parts[2] === "remove" ? 1 as const : null;
    const userId = interaction.fields.getTextInputValue("user_id").replace(/\D/g, "");
    let action = actionFromId;
    if (action == null) {
      try { action = parseAction(interaction.fields.getTextInputValue("action")); } catch { action = null; }
    }
    const amount = Math.floor(Number(interaction.fields.getTextInputValue("amount").replace(/,/g, "")));
    const reason = (() => { try { return interaction.fields.getTextInputValue("reason") || undefined; } catch { return undefined; } })();
    if (!/^\d{17,20}$/.test(userId)) {
      await interaction.editReply("Enter a valid Discord snowflake user ID.");
      return;
    }
    if (action == null || !Number.isFinite(amount) || amount < 1) {
      await interaction.editReply("Need amount ≥ 1 (use the Add / Remove buttons).");
      return;
    }
    if (!isTatsuConfigured() || !settings.enabled) {
      await interaction.editReply("Tatsu API key missing or link disabled — flip it on in `/tatsu`.");
      return;
    }
    try {
      if (isPoints) {
        const result = await tatsuApi.modifyPointsChunked(tatsuGuild, userId, amount, action);
        await writeTatsuAudit({
          guildId,
          actorId: interaction.user.id,
          targetUserId: userId,
          action: action === 0 ? "points_add" : "points_remove",
          detail: { amount, reason, result, byId: true },
        });
        await tryChannelLog(interaction, settings.logChannelId,
          `💠 <@${interaction.user.id}> ${action === 0 ? "added" : "removed"} **${fmt(amount)}** points ${action === 0 ? "to" : "from"} <@${userId}>${reason ? ` — ${reason}` : ""}${result ? ` · now **${fmt(result.points)}** (#${result.rank})` : ""}`);
        await interaction.editReply(
          `✅ Points ${action === 0 ? "added" : "removed"}: **${fmt(amount)}** for <@${userId}> (\`${userId}\`)` +
          (result ? `\nNow **${fmt(result.points)}** points · rank **#${result.rank}**` : ""),
        );
      } else {
        const result = await tatsuApi.modifyScoreChunked(tatsuGuild, userId, amount, action);
        await writeTatsuAudit({
          guildId,
          actorId: interaction.user.id,
          targetUserId: userId,
          action: action === 0 ? "score_add" : "score_remove",
          detail: { amount, reason, result, byId: true },
        });
        await tryChannelLog(interaction, settings.logChannelId,
          `⭐ <@${interaction.user.id}> ${action === 0 ? "added" : "removed"} **${fmt(amount)}** score ${action === 0 ? "to" : "from"} <@${userId}>${reason ? ` — ${reason}` : ""}${result ? ` · now **${fmt(result.score)}**` : ""}`);
        await interaction.editReply(
          `✅ Score ${action === 0 ? "added" : "removed"}: **${fmt(amount)}** for <@${userId}> (\`${userId}\`)` +
          (result ? `\nNow **${fmt(result.score)}** score` : ""),
        );
      }
    } catch (err) {
      await interaction.editReply(tatsuApiErr(err));
    }
    return;
  }

  if (id.startsWith("tatsu:watch_modal:")) {
    await interaction.deferReply(EPHEMERAL);
    const userId = id.slice("tatsu:watch_modal:".length);
    const note = interaction.fields.getTextInputValue("note") || null;
    await upsertWatchlist(guildId, userId, interaction.user.id, note);
    await writeTatsuAudit({
      guildId,
      actorId: interaction.user.id,
      targetUserId: userId,
      action: "watch_add",
      detail: { note },
    });
    await interaction.editReply(`👁️ <@${userId}> is on the watchlist.${note ? `\nNote: ${note}` : ""}`);
    return;
  }

  // New: tatsu:points_modal:add|remove:userId — legacy: tatsu:points_modal:userId + action field
  if (id.startsWith("tatsu:points_modal:") || id.startsWith("tatsu:score_modal:")) {
    await interaction.deferReply(EPHEMERAL);
    const isPoints = id.startsWith("tatsu:points_modal:");
    const parts = id.split(":");
    // points_modal:add:uid | points_modal:uid
    let action: 0 | 1 | null = null;
    let userId: string;
    if (parts[2] === "add" || parts[2] === "remove") {
      action = parts[2] === "add" ? 0 : 1;
      userId = parts[3]!;
    } else {
      userId = parts[2]!;
      try { action = parseAction(interaction.fields.getTextInputValue("action")); } catch { action = null; }
    }
    const amount = Math.floor(Number(interaction.fields.getTextInputValue("amount").replace(/,/g, "")));
    const reason = (() => { try { return interaction.fields.getTextInputValue("reason") || undefined; } catch { return undefined; } })();

    if (action == null || !Number.isFinite(amount) || amount < 1) {
      await interaction.editReply("Need amount ≥ 1 (use the Add / Remove buttons).");
      return;
    }
    if (!isTatsuConfigured() || !settings.enabled) {
      await interaction.editReply("Tatsu API key missing or link disabled — flip it on in `/tatsu`.");
      return;
    }

    try {
      if (isPoints) {
        const result = await tatsuApi.modifyPointsChunked(tatsuGuild, userId, amount, action);
        await writeTatsuAudit({
          guildId,
          actorId: interaction.user.id,
          targetUserId: userId,
          action: action === 0 ? "points_add" : "points_remove",
          detail: { amount, reason, result },
        });
        await tryChannelLog(interaction, settings.logChannelId,
          `💠 <@${interaction.user.id}> ${action === 0 ? "added" : "removed"} **${fmt(amount)}** points ${action === 0 ? "to" : "from"} <@${userId}>${reason ? ` — ${reason}` : ""}${result ? ` · now **${fmt(result.points)}** (#${result.rank})` : ""}`);
        await interaction.editReply(
          `✅ Points ${action === 0 ? "added" : "removed"}: **${fmt(amount)}** for <@${userId}>` +
          (result ? `\nNow **${fmt(result.points)}** points · rank **#${result.rank}**` : ""),
        );
      } else {
        const result = await tatsuApi.modifyScoreChunked(tatsuGuild, userId, amount, action);
        await writeTatsuAudit({
          guildId,
          actorId: interaction.user.id,
          targetUserId: userId,
          action: action === 0 ? "score_add" : "score_remove",
          detail: { amount, reason, result },
        });
        await tryChannelLog(interaction, settings.logChannelId,
          `⭐ <@${interaction.user.id}> ${action === 0 ? "added" : "removed"} **${fmt(amount)}** score ${action === 0 ? "to" : "from"} <@${userId}>${reason ? ` — ${reason}` : ""}${result ? ` · now **${fmt(result.score)}**` : ""}`);
        await interaction.editReply(
          `✅ Score ${action === 0 ? "added" : "removed"}: **${fmt(amount)}** for <@${userId}>` +
          (result ? `\nNow **${fmt(result.score)}** score` : ""),
        );
      }
    } catch (err) {
      await interaction.editReply(tatsuApiErr(err));
    }
    return;
  }

  if (id.startsWith("tatsu:strip_modal:")) {
    await interaction.deferReply(EPHEMERAL);
    const userId = id.slice("tatsu:strip_modal:".length);
    const points = Math.max(0, Math.floor(Number(interaction.fields.getTextInputValue("points").replace(/,/g, "")) || 0));
    const score = Math.max(0, Math.floor(Number(interaction.fields.getTextInputValue("score").replace(/,/g, "")) || 0));
    const reason = interaction.fields.getTextInputValue("reason") || "spam";

    if (!points && !score) {
      await interaction.editReply("Enter points and/or score to remove.");
      return;
    }
    if (!isTatsuConfigured() || !settings.enabled) {
      await interaction.editReply("Tatsu API key missing or link disabled.");
      return;
    }

    const results: string[] = [];
    try {
      if (points > 0) {
        const r = await tatsuApi.modifyPointsChunked(tatsuGuild, userId, points, 1);
        results.push(`−${fmt(points)} points` + (r ? ` → **${fmt(r.points)}** (#${r.rank})` : ""));
      }
      if (score > 0) {
        const r = await tatsuApi.modifyScoreChunked(tatsuGuild, userId, score, 1);
        results.push(`−${fmt(score)} score` + (r ? ` → **${fmt(r.score)}**` : ""));
      }
      await upsertWatchlist(guildId, userId, interaction.user.id, `stripped: ${reason}`);
      await writeTatsuAudit({
        guildId,
        actorId: interaction.user.id,
        targetUserId: userId,
        action: "strip_spam",
        detail: { points, score, reason },
      });
      await tryChannelLog(interaction, settings.logChannelId,
        `🪓 <@${interaction.user.id}> stripped <@${userId}>: ${results.join(" · ")} — ${reason}`);
      await interaction.editReply(`✅ Stripped <@${userId}>:\n${results.map(l => `• ${l}`).join("\n")}\nAlso added to watchlist.`);
    } catch (err) {
      await interaction.editReply(`⚠️ ${err instanceof Error ? err.message : "Strip failed"}`);
    }
  }
}

async function tryChannelLog(
  interaction: ModalSubmitInteraction,
  channelId: string | null | undefined,
  content: string,
): Promise<void> {
  if (!channelId || !interaction.guild) return;
  try {
    const ch = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (ch && ch.isTextBased() && "send" in ch) {
      await (ch as TextChannel).send({
        embeds: [
          new EmbedBuilder()
            .setColor(TATSU_COLOR)
            .setAuthor({ name: "Tatsu admin log", iconURL: TATSU_ICON })
            .setDescription(content)
            .setTimestamp(new Date()),
        ],
      });
    }
  } catch { /* ignore */ }
}
