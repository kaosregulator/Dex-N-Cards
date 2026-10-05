/**
 * Art Show slash + component handlers.
 *
 * Staff: `/artshow post` creates or picks a gallery channel, sets thresholds,
 * posts the station embed + a glued top-3 sticky at the channel bottom.
 * Members: Submit → modal → upload photo → Create/Cancel preview → hang piece
 * with live Upvote / Remove vote / Bump / Browse buttons.
 */

import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder,
  AttachmentBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionFlagsBits, StringSelectMenuBuilder,
  type ChatInputCommandInteraction, type ButtonInteraction, type ModalSubmitInteraction,
  type StringSelectMenuInteraction, type Message, type TextChannel, type NewsChannel,
  type Guild,
} from "discord.js";
import { logger } from "../../lib/logger.js";
import { persistBotImage } from "../commands/edit-card.js";
import {
  getOrCreateArtshowSettings, updateArtshowSettings, resetArtshowSettings,
  insertPiece, setPieceMessage, getPiece, topPieces,
  getOrRefreshWallet, grantSubmitBonus, spendVote, removeVote, spendBump, grantFreeBump,
  countAuthorSubmits, countVotesCast, countAuthorCrowns,
  crownPiece, getFame, listFame, utcWeekKey,
} from "../../lib/artshow/db.js";
import { ARTSHOW_DEFAULTS } from "../../lib/artshow/defaults.js";
import type { ArtshowPiece, ArtshowSettings } from "@workspace/db";
import { awardArtShowBadges } from "../badges/engine.js";
import { buildBadgeShowcase } from "../badges/announce.js";
import { detectOrientation, renderArtHallGif, renderArtHallPng } from "./render-hall.js";
import { renderMuseumGif } from "./render-museum.js";
import { renderArtBadgeGuideGif } from "./render-guide.js";
import {
  beginArtCapture, takeArtCapture, peekArtCapture, cancelArtCapture,
  putArtDraft, takeArtDraft, peekArtDraft, setDraftPreviewMessage,
  extractImageAttachment,
} from "./capture.js";
import { ARTSHOW_STAFF_PERMS } from "./definition.js";

const EPHEMERAL = { ephemeral: true } as const;
const BRAND = 0xc4a574;

function isStaff(interaction: { memberPermissions?: { has: (p: bigint) => boolean } | null }): boolean {
  return Boolean(interaction.memberPermissions?.has(ARTSHOW_STAFF_PERMS)
    || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

function pieceButtons(pieceId: number) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`artshow:vote:${pieceId}`)
        .setLabel("Upvote")
        .setEmoji("▲")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`artshow:unvote:${pieceId}`)
        .setLabel("Remove vote")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`artshow:bump:${pieceId}`)
        .setLabel("Bump")
        .setEmoji("📌")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("artshow:browse")
        .setLabel("Browse halls")
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

function stationButtons() {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("artshow:submit")
        .setLabel("Submit your art")
        .setEmoji("🖼️")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("artshow:browse")
        .setLabel("Browse halls")
        .setEmoji("🖼️")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("artshow:museum")
        .setLabel("Hall of Fame")
        .setEmoji("🏛️")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("artshow:badges")
        .setLabel("Emblem path")
        .setEmoji("✨")
        .setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("artshow:votes")
        .setLabel("My votes")
        .setEmoji("🎟️")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("artshow:staff_reset")
        .setLabel("Reset defaults")
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

function draftButtons(userId: string) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`artshow:draft_create:${userId}`)
        .setLabel("Create")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`artshow:draft_cancel:${userId}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

function applyThresholdPatch(
  interaction: ChatInputCommandInteraction,
): Partial<ArtshowSettings> {
  const patch: Partial<ArtshowSettings> = {};
  const vpd = interaction.options.getInteger("votes_per_day");
  const bos = interaction.options.getInteger("bonus_on_submit");
  const rh = interaction.options.getInteger("refresh_hours");
  const bc = interaction.options.getInteger("bump_cost");
  const ca = interaction.options.getInteger("crown_at");
  if (vpd != null) patch.votesPerDay = vpd;
  if (bos != null) patch.bonusVotesOnSubmit = bos;
  if (rh != null) patch.voteRefreshHours = rh;
  if (bc != null) patch.bumpCostVotes = bc;
  if (ca != null) patch.crownThreshold = ca;
  return patch;
}

function formatSettings(s: ArtshowSettings): string {
  return [
    `Votes / day: **${s.votesPerDay}**`,
    `Bonus on submit: **${s.bonusVotesOnSubmit}**`,
    `Refresh: every **${s.voteRefreshHours}h** (+1)`,
    `Bump cost: **${s.bumpCostVotes}** votes`,
    `Auto-crown at: **${s.crownThreshold || "off"}**`,
  ].join("\n");
}

async function buildStationEmbed(guildId: string): Promise<{
  embeds: EmbedBuilder[];
  files: AttachmentBuilder[];
}> {
  const settings = await getOrCreateArtshowSettings(guildId);
  const week = utcWeekKey();
  const leaders = await topPieces(guildId, { weekKey: week, limit: 3 });
  const fame = await getFame(guildId, week);
  const guide = await renderArtBadgeGuideGif();
  const files: AttachmentBuilder[] = [];

  const embed = new EmbedBuilder()
    .setColor(BRAND)
    .setTitle("🎨 Community Art Show")
    .setDescription([
      "Hang what you **made** — drawings, builds, clay, photos, crafts.",
      "",
      "**How to submit**",
      "1. Press **Submit your art** → fill title + description",
      "2. Upload your photo in this channel",
      "3. Press **Create** (or **Cancel**) on your preview",
      "4. Others **▲ Upvote** on live hall buttons — remove your vote anytime until the week is crowned",
      "",
      formatSettings(settings),
      "",
      "🏆 There is **one** Hall of Fame champion each week — the sticky board below tracks the top 3 live.",
    ].join("\n"));

  if (leaders.length) {
    embed.addFields({
      name: "🔥 This week's race",
      value: leaders.map((p, i) =>
        `${["🥇", "🥈", "🥉"][i] ?? "•"} **${p.title}** — <@${p.authorId}> · **▲ ${p.votes}**`).join("\n"),
    });
  }
  if (fame) {
    embed.addFields({
      name: "🏛️ Crowned this week",
      value: `**${fame.title}** by <@${fame.authorId}> — **▲ ${fame.votesAtCrown}**`,
    });
  }
  if (guide) {
    files.push(new AttachmentBuilder(guide, { name: "artshow-path.gif" }));
    embed.setImage("attachment://artshow-path.gif");
  }
  embed.setFooter({ text: `Week ${week} · Sticky board stays at the bottom with live top 3` });
  return { embeds: [embed], files };
}

/** Delete+repost sticky so it stays glued to the bottom of the gallery. */
async function refreshStickyBoard(
  guildId: string,
  channel: TextChannel | NewsChannel,
): Promise<void> {
  const settings = await getOrCreateArtshowSettings(guildId);
  const week = utcWeekKey();
  const top = await topPieces(guildId, { weekKey: week, limit: 3 });
  const fame = await getFame(guildId, week);

  if (settings.stickyMessageId) {
    await channel.messages.delete(settings.stickyMessageId).catch(() => {});
  }

  const medals = ["🥇", "🥈", "🥉"];
  const lines = top.length
    ? top.map((p, i) =>
      `${medals[i] ?? "•"} **${p.title}** — <@${p.authorId}> · **▲ ${p.votes}** · \`#${p.id}\``)
    : ["_No pieces yet — be the first to **Submit your art**._"];

  const embed = new EmbedBuilder()
    .setColor(fame ? 0xffe66d : BRAND)
    .setTitle(fame ? "📌 Sticky · Hall of Fame + Top 3" : "📌 Sticky · Live Top 3")
    .setDescription([
      fame
        ? `🏆 **Champion:** **${fame.title}** by <@${fame.authorId}> · **▲ ${fame.votesAtCrown}**`
        : "_No crown yet — race is open. Remove votes until crowning._",
      "",
      "**Current standings**",
      ...lines,
      "",
      `_Week ${week} · this message stays at the bottom_`,
    ].join("\n"));

  const rows = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("artshow:browse")
        .setLabel("Browse halls")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("artshow:museum")
        .setLabel("Museum")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("artshow:submit")
        .setLabel("Submit art")
        .setStyle(ButtonStyle.Success),
    ),
  ];

  const sent = await channel.send({ embeds: [embed], components: rows });
  await updateArtshowSettings(guildId, { stickyMessageId: sent.id });
  // Pin for visibility (Discord pin ≠ bottom glue; delete+repost is the glue).
  await sent.pin().catch(() => {});
}

async function maybeAnnounceBadges(
  channel: { send: (o: object) => Promise<unknown> },
  guildId: string,
  userId: string,
  badgeResult: Awaited<ReturnType<typeof awardArtShowBadges>>,
): Promise<void> {
  for (const result of badgeResult.results.filter(r => r.unlocked || r.leveled || r.tierChanged)) {
    const rule = badgeResult.rules.find(r => r.id === result.badge.id);
    if (!rule) continue;
    try {
      const showcase = await buildBadgeShowcase({
        result,
        rule,
        mention: `<@${userId}>`,
        forceEmblem: result.unlocked || result.tierChanged,
      });
      const msg = await channel.send({
        content: showcase.content,
        embeds: showcase.embeds,
        files: showcase.files,
      }) as Message;
      setTimeout(() => { msg.delete().catch(() => {}); }, 55_000);
    } catch (err) {
      logger.debug({ err }, "artshow badge announce failed");
    }
  }
  if (badgeResult.results.some(r => r.badge.id === "art_rising" && r.unlocked)) {
    const settings = await getOrCreateArtshowSettings(guildId);
    await grantFreeBump(guildId, userId, settings).catch(() => {});
  }
}

async function buildHallFiles(opts: {
  title: string;
  artistName: string;
  description: string;
  imageUrl: string;
  orientation: "landscape" | "portrait" | "square";
  votes: number;
  weekLabel: string;
}): Promise<{ files: AttachmentBuilder[]; imageName: string | null }> {
  const hallGif = await renderArtHallGif(opts);
  const files: AttachmentBuilder[] = [];
  if (hallGif && hallGif.length < 7_500_000) {
    files.push(new AttachmentBuilder(hallGif, { name: "art-hall.gif" }));
    return { files, imageName: "art-hall.gif" };
  }
  const hallPng = await renderArtHallPng(opts);
  if (hallPng) {
    files.push(new AttachmentBuilder(hallPng, { name: "art-hall.png" }));
    return { files, imageName: "art-hall.png" };
  }
  return { files, imageName: null };
}

async function publishPiece(opts: {
  guildId: string;
  channel: TextChannel | NewsChannel;
  authorId: string;
  authorName: string;
  title: string;
  description: string;
  imageUrl: string;
  orientation?: "landscape" | "portrait" | "square";
}): Promise<ArtshowPiece> {
  const orientation = opts.orientation ?? await detectOrientation(opts.imageUrl);
  const piece = await insertPiece({
    guildId: opts.guildId,
    authorId: opts.authorId,
    title: opts.title,
    description: opts.description,
    imageUrl: opts.imageUrl,
    orientation,
    channelId: opts.channel.id,
  });

  const { files, imageName } = await buildHallFiles({
    title: piece.title,
    artistName: opts.authorName,
    description: piece.description,
    imageUrl: piece.imageUrl,
    orientation: orientation as "landscape" | "portrait" | "square",
    votes: 0,
    weekLabel: piece.weekKey,
  });

  const embed = new EmbedBuilder()
    .setColor(BRAND)
    .setTitle(`🖼️ ${piece.title}`)
    .setDescription([
      `by <@${opts.authorId}>`,
      piece.description ? `*${piece.description}*` : null,
      "",
      "**▲ Upvote** · **Remove vote** until the week is crowned · **Bump** · **Browse halls**",
      `_Piece #${piece.id} · ${piece.weekKey}_`,
    ].filter(Boolean).join("\n"));
  if (imageName) embed.setImage(`attachment://${imageName}`);
  else embed.setImage(piece.imageUrl);

  const sent = await opts.channel.send({
    content: `✨ **New hanging** — <@${opts.authorId}> entered the Art Show`,
    embeds: [embed],
    files,
    components: pieceButtons(piece.id),
  });
  await setPieceMessage(piece.id, sent.id);

  const settings = await getOrCreateArtshowSettings(opts.guildId);
  await grantSubmitBonus(opts.guildId, opts.authorId, settings);
  const submits = await countAuthorSubmits(opts.guildId, opts.authorId);
  const badgeResult = await awardArtShowBadges({
    guildId: opts.guildId,
    userId: opts.authorId,
    mode: "submit",
    count: submits,
  });
  await maybeAnnounceBadges(opts.channel, opts.guildId, opts.authorId, badgeResult);
  await refreshStickyBoard(opts.guildId, opts.channel);
  return piece;
}

async function refreshPieceMessage(
  piece: ArtshowPiece,
  channel: TextChannel | NewsChannel,
  artistName: string,
): Promise<Message | null> {
  const orientation = (piece.orientation === "portrait" || piece.orientation === "square")
    ? piece.orientation
    : "landscape";
  const { files, imageName } = await buildHallFiles({
    title: piece.title,
    artistName,
    description: piece.description,
    imageUrl: piece.imageUrl,
    orientation,
    votes: piece.votes,
    weekLabel: piece.weekKey,
  });

  const embed = new EmbedBuilder()
    .setColor(BRAND)
    .setTitle(`🖼️ ${piece.title}`)
    .setDescription([
      `by <@${piece.authorId}>`,
      piece.description ? `*${piece.description}*` : null,
      "",
      `**▲ ${piece.votes}** upvotes`,
      `_Piece #${piece.id} · ${piece.weekKey}_`,
    ].filter(Boolean).join("\n"));
  if (imageName) embed.setImage(`attachment://${imageName}`);
  else embed.setImage(piece.imageUrl);

  const sent = await channel.send({
    content: piece.bumpedAt
      ? `📌 **Bumped** — <@${piece.authorId}>'s piece returns to the floor`
      : `▲ **${piece.title}**`,
    embeds: [embed],
    files,
    components: pieceButtons(piece.id),
  });
  await setPieceMessage(piece.id, sent.id);
  await refreshStickyBoard(piece.guildId, channel);
  return sent;
}

async function tryAutoCrown(
  guildId: string,
  piece: ArtshowPiece,
  channel: TextChannel | NewsChannel,
  settings: ArtshowSettings,
): Promise<void> {
  if (settings.crownThreshold <= 0) return;
  if (piece.votes < settings.crownThreshold) return;
  const existing = await getFame(guildId, piece.weekKey);
  if (existing) return;

  const fame = await crownPiece({ guildId, piece });
  const crowns = await countAuthorCrowns(guildId, piece.authorId);
  const badgeResult = await awardArtShowBadges({
    guildId,
    userId: piece.authorId,
    mode: "crown",
    count: crowns,
  });
  await maybeAnnounceBadges(channel, guildId, piece.authorId, badgeResult);

  const museum = await renderMuseumGif({
    championTitle: fame.title,
    championArtist: `<@${fame.authorId}>`,
    championImageUrl: fame.imageUrl,
    votes: fame.votesAtCrown,
    weekLabel: `Week ${fame.weekKey} · Auto crown at ${settings.crownThreshold} ▲`,
  });
  const files: AttachmentBuilder[] = [];
  if (museum) files.push(new AttachmentBuilder(museum, { name: "museum.gif" }));
  const embed = new EmbedBuilder()
    .setColor(0xffe66d)
    .setTitle("🏆 Hall of Fame — new champion")
    .setDescription([
      `**<@${fame.authorId}>** reached **${fame.votesAtCrown} ▲** first this week.`,
      `**${fame.title}** takes center stage. Voting for this week is now locked.`,
    ].join("\n"));
  if (files.length) embed.setImage("attachment://museum.gif");
  await channel.send({ embeds: [embed], files });
  await refreshStickyBoard(guildId, channel);
}

async function resolveGalleryChannel(
  interaction: ChatInputCommandInteraction,
): Promise<TextChannel | NewsChannel | null> {
  const existing = interaction.options.getChannel("channel");
  if (existing && "send" in existing) return existing as TextChannel | NewsChannel;

  const createName = interaction.options.getString("create_channel")?.trim();
  if (createName && interaction.guild) {
    const guild = interaction.guild as Guild;
    const created = await guild.channels.create({
      name: createName.toLowerCase().replace(/\s+/g, "-").slice(0, 90),
      type: ChannelType.GuildText,
      topic: "Community Art Show — submit, upvote, earn emblems, crown a champion",
      reason: `Art Show gallery created by ${interaction.user.tag}`,
    });
    return created as TextChannel;
  }

  const fallback = interaction.channel;
  if (fallback && "send" in fallback) return fallback as TextChannel | NewsChannel;
  return null;
}

async function replyBrowse(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
): Promise<void> {
  const guildId = interaction.guildId!;
  const week = utcWeekKey();
  const rows = await topPieces(guildId, { weekKey: week, limit: 10 });
  if (!rows.length) {
    const msg = "No halls yet this week — be the first to submit!";
    if (interaction.deferred || interaction.replied) await interaction.editReply(msg);
    else await interaction.reply({ content: msg, ...EPHEMERAL });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(BRAND)
    .setTitle(`🖼️ Browse art halls · ${week}`)
    .setDescription(
      "There are many halls on the floor — pick one to view. **One** weekly champion takes the museum.",
    )
    .addFields(
      rows.slice(0, 10).map((p, i) => ({
        name: `${i + 1}. ${p.title} · ▲ ${p.votes}`,
        value: `by <@${p.authorId}> · \`#${p.id}\``,
        inline: false,
      })),
    );

  const select = new StringSelectMenuBuilder()
    .setCustomId("artshow:browse_select")
    .setPlaceholder("View an art hall…")
    .addOptions(
      rows.slice(0, 25).map(p => ({
        label: p.title.slice(0, 90),
        description: `▲ ${p.votes} · #${p.id}`.slice(0, 100),
        value: String(p.id),
      })),
    );

  const payload = {
    embeds: [embed],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
  };
  if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
  else await interaction.reply({ ...payload, ...EPHEMERAL });
}

async function replyMuseum(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
): Promise<void> {
  const guildId = interaction.guildId!;
  const week = utcWeekKey();
  const fame = await getFame(guildId, week);
  const leaders = await topPieces(guildId, { weekKey: week, limit: 1 });
  const lead = leaders[0];
  const past = await listFame(guildId, 8);

  const champ = fame ?? (lead
    ? {
      title: lead.title,
      authorId: lead.authorId,
      imageUrl: lead.imageUrl,
      votesAtCrown: lead.votes,
      weekKey: lead.weekKey,
    }
    : null);

  if (!champ) {
    const content = "The museum is empty — submit art and earn ▲ to claim center stage.";
    if (interaction.deferred || interaction.replied) await interaction.editReply(content);
    else await interaction.reply({ content, ...EPHEMERAL });
    return;
  }

  const museum = await renderMuseumGif({
    championTitle: champ.title,
    championArtist: champ.authorId,
    championImageUrl: champ.imageUrl,
    votes: champ.votesAtCrown,
    weekLabel: fame
      ? `Week ${champ.weekKey} · CROWNED`
      : `Week ${champ.weekKey} · CURRENT LEAD (not yet crowned)`,
    pastUrls: past.map(p => p.imageUrl),
  });

  const embed = new EmbedBuilder()
    .setColor(0xffe66d)
    .setTitle("🏛️ Hall of Fame Museum")
    .setDescription([
      fame
        ? `**Center stage (the one winner):** ${champ.title} — <@${champ.authorId}>`
        : `**Interim lead** (staff can \`/artshow crown\`): ${champ.title} — <@${champ.authorId}>`,
      "",
      "Browse other halls on the floor — only **one** piece owns the museum lights each week.",
      past.length
        ? `\n**Past crowns:** ${past.slice(0, 5).map(p => `${p.title} (${p.weekKey})`).join(" · ")}`
        : "",
    ].join("\n"));
  const files: AttachmentBuilder[] = [];
  if (museum) {
    files.push(new AttachmentBuilder(museum, { name: "museum.gif" }));
    embed.setImage("attachment://museum.gif");
  }
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ embeds: [embed], files });
  } else {
    await interaction.reply({ embeds: [embed], files, ...EPHEMERAL });
  }
}

async function updatePieceEmbedVotes(message: Message, piece: ArtshowPiece): Promise<void> {
  try {
    const embed = EmbedBuilder.from(message.embeds[0] ?? new EmbedBuilder())
      .setDescription([
        `by <@${piece.authorId}>`,
        piece.description ? `*${piece.description}*` : null,
        "",
        `**▲ ${piece.votes}** upvotes`,
        `_Piece #${piece.id} · ${piece.weekKey}_`,
      ].filter(Boolean).join("\n"));
    await message.edit({ embeds: [embed], components: pieceButtons(piece.id) });
  } catch { /* ignore */ }
}

// ── Slash command ────────────────────────────────────────────────────────────

export async function handleArtShowCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "Server only.", ...EPHEMERAL });
    return;
  }
  const sub = interaction.options.getSubcommand();

  if (sub === "post") {
    if (!isStaff(interaction)) {
      await interaction.reply({ content: "Staff only (`Manage Server`).", ...EPHEMERAL });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const thresholdPatch = applyThresholdPatch(interaction);
    const ch = await resolveGalleryChannel(interaction);
    if (!ch) {
      await interaction.editReply("Pick an existing **channel**, or set **create_channel** to make one.");
      return;
    }
    const s = await updateArtshowSettings(interaction.guildId, {
      ...thresholdPatch,
      channelId: ch.id,
      enabled: true,
    });
    const payload = await buildStationEmbed(interaction.guildId);
    const sent = await ch.send({
      ...payload,
      components: stationButtons(),
    });
    await updateArtshowSettings(interaction.guildId, { stationMessageId: sent.id });
    await refreshStickyBoard(interaction.guildId, ch);
    await interaction.editReply([
      `✅ Art Show live in <#${ch.id}>`,
      "· Station embed posted (Submit / Browse / Museum / Emblem path)",
      "· Sticky top-3 board glued to the bottom (pinned + re-posted on updates)",
      "",
      "**Thresholds**",
      formatSettings(s),
      "",
      `_Defaults: ${ARTSHOW_DEFAULTS.votesPerDay}/day, +${ARTSHOW_DEFAULTS.bonusVotesOnSubmit} submit, ${ARTSHOW_DEFAULTS.voteRefreshHours}h refresh, bump ${ARTSHOW_DEFAULTS.bumpCostVotes}, crown ${ARTSHOW_DEFAULTS.crownThreshold}_`,
      "Reset anytime: `/artshow setup reset_defaults:True` or station **Reset defaults**.",
    ].join("\n"));
    return;
  }

  if (sub === "setup") {
    if (!isStaff(interaction)) {
      await interaction.reply({ content: "Staff only.", ...EPHEMERAL });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    if (interaction.options.getBoolean("reset_defaults")) {
      const s = await resetArtshowSettings(interaction.guildId);
      await interaction.editReply(`✅ Reset to defaults.\n\n${formatSettings(s)}`);
      return;
    }
    const patch = applyThresholdPatch(interaction);
    if (!Object.keys(patch).length) {
      const s = await getOrCreateArtshowSettings(interaction.guildId);
      await interaction.editReply(`**Current Art Show setup**\n${formatSettings(s)}\n\n_Pass options to change, or \`reset_defaults:True\`._`);
      return;
    }
    const s = await updateArtshowSettings(interaction.guildId, patch);
    await interaction.editReply(`**Art Show setup updated**\n${formatSettings(s)}`);
    return;
  }

  if (sub === "submit") {
    await interaction.deferReply({ ephemeral: true });
    const settings = await getOrCreateArtshowSettings(interaction.guildId);
    if (!settings.enabled) {
      await interaction.editReply("Art Show is disabled.");
      return;
    }
    const channelId = settings.channelId ?? interaction.channelId;
    const channel = await interaction.client.channels.fetch(channelId!).catch(() => null);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      await interaction.editReply("Gallery channel not set — staff should `/artshow post` first.");
      return;
    }
    const image = interaction.options.getAttachment("image", true);
    const title = interaction.options.getString("title", true);
    const description = interaction.options.getString("description") ?? "";
    if (!image.contentType?.startsWith("image/") && !/\.(png|jpe?g|gif|webp)$/i.test(image.name)) {
      await interaction.editReply("Please upload an image file.");
      return;
    }
    const url = await persistBotImage(image.url, image.contentType ?? undefined);
    const orientation = await detectOrientation(url);
    putArtDraft({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      channelId: channel.id,
      title,
      description,
      imageUrl: url,
      orientation,
    });
    const { files, imageName } = await buildHallFiles({
      title,
      artistName: interaction.user.username,
      description,
      imageUrl: url,
      orientation,
      votes: 0,
      weekLabel: "preview",
    });
    const embed = new EmbedBuilder()
      .setColor(BRAND)
      .setTitle(`Preview · ${title}`)
      .setDescription("Press **Create** to hang this in the Art Show, or **Cancel**.");
    if (imageName) embed.setImage(`attachment://${imageName}`);
    await interaction.editReply({
      embeds: [embed],
      files,
      components: draftButtons(interaction.user.id),
    });
    return;
  }

  if (sub === "museum") {
    await interaction.deferReply({ ephemeral: true });
    await replyMuseum(interaction);
    return;
  }

  if (sub === "browse") {
    await interaction.deferReply({ ephemeral: true });
    await replyBrowse(interaction);
    return;
  }

  if (sub === "badges") {
    await interaction.deferReply({ ephemeral: true });
    const gif = await renderArtBadgeGuideGif();
    const embed = new EmbedBuilder()
      .setColor(BRAND)
      .setTitle("✨ Art Show emblem path")
      .setDescription("Submit → vote → earn ▲ → crown. Use `/badges` for your full showcase.");
    const files: AttachmentBuilder[] = [];
    if (gif) {
      files.push(new AttachmentBuilder(gif, { name: "art-path.gif" }));
      embed.setImage("attachment://art-path.gif");
    }
    await interaction.editReply({ embeds: [embed], files });
    return;
  }

  if (sub === "leaderboard") {
    await interaction.deferReply();
    const allTime = interaction.options.getBoolean("all_time") ?? false;
    const week = utcWeekKey();
    const rows = await topPieces(interaction.guildId, {
      weekKey: allTime ? undefined : week,
      limit: 10,
    });
    const embed = new EmbedBuilder()
      .setColor(BRAND)
      .setTitle(allTime ? "🏆 Art Show — all time" : `🏆 Art Show — ${week}`)
      .setDescription(
        rows.length
          ? rows.map((p, i) =>
            `**${i + 1}.** ${p.title} — <@${p.authorId}> · **▲ ${p.votes}** · \`#${p.id}\``).join("\n")
          : "_No pieces yet — be the first to submit._",
      );
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (sub === "votes") {
    await interaction.deferReply({ ephemeral: true });
    const settings = await getOrCreateArtshowSettings(interaction.guildId);
    const wallet = await getOrRefreshWallet(interaction.guildId, interaction.user.id, settings);
    await interaction.editReply([
      "**Your Art Show votes**",
      `Remaining today: **${wallet.remaining}**`,
      `Earned bonus (this day): **${wallet.earnedBonus}**`,
      `Free bumps: **${wallet.freeBumps}**`,
      "",
      "Remove a vote on any piece (until the week is crowned) to get that vote back.",
      formatSettings(settings),
    ].join("\n"));
    return;
  }

  if (sub === "crown") {
    if (!isStaff(interaction)) {
      await interaction.reply({ content: "Staff only.", ...EPHEMERAL });
      return;
    }
    await interaction.deferReply();
    const week = utcWeekKey();
    const existing = await getFame(interaction.guildId, week);
    if (existing) {
      await interaction.editReply(`Already crowned this week: **${existing.title}** by <@${existing.authorId}>.`);
      return;
    }
    const pieceId = interaction.options.getInteger("piece_id");
    let piece = pieceId != null ? await getPiece(pieceId) : null;
    if (!piece) {
      const top = await topPieces(interaction.guildId, { weekKey: week, limit: 1 });
      piece = top[0] ?? null;
    }
    if (!piece || piece.guildId !== interaction.guildId) {
      await interaction.editReply("No piece to crown this week.");
      return;
    }
    const fame = await crownPiece({ guildId: interaction.guildId, piece });
    const crowns = await countAuthorCrowns(interaction.guildId, piece.authorId);
    const badgeResult = await awardArtShowBadges({
      guildId: interaction.guildId,
      userId: piece.authorId,
      mode: "crown",
      count: crowns,
    });
    const settings = await getOrCreateArtshowSettings(interaction.guildId);
    if (settings.channelId) {
      const ch = await interaction.client.channels.fetch(settings.channelId).catch(() => null);
      if (ch && ch.isTextBased() && !ch.isDMBased()) {
        await maybeAnnounceBadges(ch as TextChannel, interaction.guildId, piece.authorId, badgeResult);
        await refreshStickyBoard(interaction.guildId, ch as TextChannel);
      }
    }
    const museum = await renderMuseumGif({
      championTitle: fame.title,
      championArtist: piece.authorId,
      championImageUrl: fame.imageUrl,
      votes: fame.votesAtCrown,
      weekLabel: `Week ${fame.weekKey}`,
    });
    const files: AttachmentBuilder[] = [];
    const embed = new EmbedBuilder()
      .setColor(0xffe66d)
      .setTitle("🏆 Crowned — Hall of Fame")
      .setDescription(`**${fame.title}** by <@${fame.authorId}> · **▲ ${fame.votesAtCrown}**\nVoting for this week is now locked.`);
    if (museum) {
      files.push(new AttachmentBuilder(museum, { name: "museum.gif" }));
      embed.setImage("attachment://museum.gif");
    }
    await interaction.editReply({ embeds: [embed], files });
    return;
  }

  await interaction.reply({ content: "Unknown subcommand.", ...EPHEMERAL });
}

// ── Components ───────────────────────────────────────────────────────────────

export async function handleArtShowButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "Server only.", ...EPHEMERAL });
    return;
  }
  const id = interaction.customId;

  if (id === "artshow:submit") {
    const modal = new ModalBuilder()
      .setCustomId("artshow:submit_modal")
      .setTitle("Submit your art");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("title")
          .setLabel("Title")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(80)
          .setPlaceholder("Midnight clay fox"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("description")
          .setLabel("Description")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(400)
          .setPlaceholder("What you made, materials, story…"),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (id === "artshow:museum") {
    await interaction.deferReply({ ephemeral: true });
    await replyMuseum(interaction);
    return;
  }

  if (id === "artshow:browse") {
    await interaction.deferReply({ ephemeral: true });
    await replyBrowse(interaction);
    return;
  }

  if (id === "artshow:badges") {
    await interaction.deferReply({ ephemeral: true });
    const gif = await renderArtBadgeGuideGif();
    const embed = new EmbedBuilder()
      .setColor(BRAND)
      .setTitle("✨ How Art Show emblems evolve")
      .setDescription("Submit → vote → earn ▲ → crown. Emblems show on unlock and as they tier up.");
    const files: AttachmentBuilder[] = [];
    if (gif) {
      files.push(new AttachmentBuilder(gif, { name: "art-path.gif" }));
      embed.setImage("attachment://art-path.gif");
    }
    await interaction.editReply({ embeds: [embed], files });
    return;
  }

  if (id === "artshow:votes") {
    await interaction.deferReply({ ephemeral: true });
    const settings = await getOrCreateArtshowSettings(interaction.guildId);
    const wallet = await getOrRefreshWallet(interaction.guildId, interaction.user.id, settings);
    await interaction.editReply(
      `🎟️ Votes left: **${wallet.remaining}** · Free bumps: **${wallet.freeBumps}**\nRemove a vote anytime before crowning to get it back.`,
    );
    return;
  }

  if (id === "artshow:staff_reset") {
    if (!isStaff(interaction)) {
      await interaction.reply({ content: "Staff only.", ...EPHEMERAL });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const s = await resetArtshowSettings(interaction.guildId);
    await interaction.editReply(`✅ Thresholds reset to defaults.\n\n${formatSettings(s)}`);
    return;
  }

  if (id.startsWith("artshow:draft_create:")) {
    const ownerId = id.split(":")[2]!;
    if (interaction.user.id !== ownerId) {
      await interaction.reply({ content: "Not your draft.", ...EPHEMERAL });
      return;
    }
    await interaction.deferUpdate();
    const draft = takeArtDraft(interaction.guildId, ownerId);
    if (!draft) {
      await interaction.followUp({ content: "Draft expired — submit again.", ...EPHEMERAL });
      return;
    }
    const channel = await interaction.client.channels.fetch(draft.channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      await interaction.followUp({ content: "Gallery channel missing.", ...EPHEMERAL });
      return;
    }
    await publishPiece({
      guildId: interaction.guildId,
      channel: channel as TextChannel,
      authorId: ownerId,
      authorName: interaction.user.username,
      title: draft.title,
      description: draft.description,
      imageUrl: draft.imageUrl,
      orientation: draft.orientation,
    });
    if (draft.previewMessageId && interaction.channel?.isTextBased()) {
      await interaction.channel.messages.delete(draft.previewMessageId).catch(() => {});
    }
    await interaction.followUp({ content: "✅ Hung in the Art Show!", ...EPHEMERAL });
    return;
  }

  if (id.startsWith("artshow:draft_cancel:")) {
    const ownerId = id.split(":")[2]!;
    if (interaction.user.id !== ownerId) {
      await interaction.reply({ content: "Not your draft.", ...EPHEMERAL });
      return;
    }
    await interaction.deferUpdate();
    const draft = takeArtDraft(interaction.guildId, ownerId);
    cancelArtCapture(interaction.guildId, ownerId);
    if (draft?.previewMessageId && interaction.channel?.isTextBased()) {
      await interaction.channel.messages.delete(draft.previewMessageId).catch(() => {});
    }
    await interaction.message.delete().catch(() => {});
    await interaction.followUp({ content: "Draft cancelled.", ...EPHEMERAL });
    return;
  }

  if (id.startsWith("artshow:vote:")) {
    const pieceId = Number(id.split(":")[2]);
    await interaction.deferReply({ ephemeral: true });
    const settings = await getOrCreateArtshowSettings(interaction.guildId);
    const result = await spendVote(interaction.guildId, interaction.user.id, pieceId, settings);
    if (!result.ok) {
      await interaction.editReply(result.reason);
      return;
    }
    await updatePieceEmbedVotes(interaction.message, result.piece);

    const cast = await countVotesCast(interaction.guildId, interaction.user.id);
    const voterBadges = await awardArtShowBadges({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      mode: "votes_cast",
      count: cast,
    });
    const authorBadges = await awardArtShowBadges({
      guildId: interaction.guildId,
      userId: result.piece.authorId,
      mode: "votes_received",
      count: result.piece.votes,
    });

    if (interaction.channel?.isTextBased() && !interaction.channel.isDMBased()) {
      const ch = interaction.channel as TextChannel;
      await maybeAnnounceBadges(ch, interaction.guildId, interaction.user.id, voterBadges);
      await maybeAnnounceBadges(ch, interaction.guildId, result.piece.authorId, authorBadges);
      await tryAutoCrown(interaction.guildId, result.piece, ch, settings);
      await refreshStickyBoard(interaction.guildId, ch);
    }

    await interaction.editReply(
      `▲ Voted for **${result.piece.title}** — now **${result.piece.votes}**. Votes left: **${result.wallet.remaining}**. You can **Remove vote** until crowning.`,
    );
    return;
  }

  if (id.startsWith("artshow:unvote:")) {
    const pieceId = Number(id.split(":")[2]);
    await interaction.deferReply({ ephemeral: true });
    const settings = await getOrCreateArtshowSettings(interaction.guildId);
    const result = await removeVote(interaction.guildId, interaction.user.id, pieceId, settings);
    if (!result.ok) {
      await interaction.editReply(result.reason);
      return;
    }
    await updatePieceEmbedVotes(interaction.message, result.piece);
    if (interaction.channel?.isTextBased() && !interaction.channel.isDMBased()) {
      await refreshStickyBoard(interaction.guildId, interaction.channel as TextChannel);
    }
    await interaction.editReply(
      `Removed your vote from **${result.piece.title}** (now **▲ ${result.piece.votes}**). Votes left: **${result.wallet.remaining}**.`,
    );
    return;
  }

  if (id.startsWith("artshow:bump:")) {
    const pieceId = Number(id.split(":")[2]);
    await interaction.deferReply({ ephemeral: true });
    const settings = await getOrCreateArtshowSettings(interaction.guildId);
    const result = await spendBump(interaction.guildId, interaction.user.id, pieceId, settings);
    if (!result.ok) {
      await interaction.editReply(result.reason);
      return;
    }
    const channel = interaction.channel;
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      await interaction.editReply("Can't bump here.");
      return;
    }
    if (result.piece.messageId) {
      await channel.messages.delete(result.piece.messageId).catch(() => {});
    }
    await refreshPieceMessage(result.piece, channel as TextChannel, interaction.user.username);
    await interaction.editReply(
      result.usedFree
        ? "📌 Bumped with your **free Rising Artist** bump!"
        : `📌 Bumped for **${settings.bumpCostVotes}** votes. Remaining: **${result.wallet.remaining}**.`,
    );
    return;
  }
}

export async function handleArtShowSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.guildId || interaction.customId !== "artshow:browse_select") return;
  await interaction.deferReply({ ephemeral: true });
  const pieceId = Number(interaction.values[0]);
  const piece = await getPiece(pieceId);
  if (!piece || piece.guildId !== interaction.guildId) {
    await interaction.editReply("Piece not found.");
    return;
  }
  const orientation = (piece.orientation === "portrait" || piece.orientation === "square")
    ? piece.orientation
    : "landscape";
  let artistName = piece.authorId;
  try {
    const u = await interaction.client.users.fetch(piece.authorId);
    artistName = u.username;
  } catch { /* keep id */ }
  const { files, imageName } = await buildHallFiles({
    title: piece.title,
    artistName,
    description: piece.description,
    imageUrl: piece.imageUrl,
    orientation,
    votes: piece.votes,
    weekLabel: piece.weekKey,
  });
  const embed = new EmbedBuilder()
    .setColor(BRAND)
    .setTitle(`🖼️ ${piece.title}`)
    .setDescription([
      `by <@${piece.authorId}> · **▲ ${piece.votes}**`,
      piece.description ? `*${piece.description}*` : null,
      "",
      "_One of many halls — only the weekly champion owns the museum._",
    ].filter(Boolean).join("\n"));
  if (imageName) embed.setImage(`attachment://${imageName}`);
  else embed.setImage(piece.imageUrl);
  await interaction.editReply({ embeds: [embed], files });
}

export async function handleArtShowModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.guildId || interaction.customId !== "artshow:submit_modal") return;
  const title = interaction.fields.getTextInputValue("title").trim();
  const description = (interaction.fields.getTextInputValue("description") ?? "").trim();
  if (!title) {
    await interaction.reply({ content: "Title required.", ...EPHEMERAL });
    return;
  }
  const settings = await getOrCreateArtshowSettings(interaction.guildId);
  const channelId = settings.channelId ?? interaction.channelId;
  if (!channelId) {
    await interaction.reply({ content: "No gallery channel — staff should `/artshow post` first.", ...EPHEMERAL });
    return;
  }
  beginArtCapture({
    guildId: interaction.guildId,
    userId: interaction.user.id,
    channelId,
    title,
    description,
  });
  await interaction.reply({
    content: [
      `📝 **${title}** drafted.`,
      "",
      `**Upload your photo** in <#${channelId}> within **2 minutes**.`,
      "You'll get a hall preview with **Create** / **Cancel** before it posts.",
    ].join("\n"),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`artshow:draft_cancel:${interaction.user.id}`)
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Danger),
      ),
    ],
    ...EPHEMERAL,
  });
}

/** MessageCreate — image upload builds a Create/Cancel preview (does not auto-post). */
export async function handleArtShowMessage(msg: Message): Promise<boolean> {
  if (!msg.guildId || msg.author.bot) return false;
  const pending = peekArtCapture(msg.guildId, msg.author.id);
  if (!pending) return false;
  if (msg.channelId !== pending.channelId) return false;

  const att = extractImageAttachment(msg);
  if (!att) return false;

  const taken = takeArtCapture(msg.guildId, msg.author.id);
  if (!taken) return false;

  try {
    const url = await persistBotImage(att.url, att.contentType ?? undefined);
    const orientation = await detectOrientation(url);
    putArtDraft({
      guildId: msg.guildId,
      userId: msg.author.id,
      channelId: taken.channelId,
      title: taken.title,
      description: taken.description,
      imageUrl: url,
      orientation,
    });

    const channel = msg.channel;
    if (!channel.isTextBased() || channel.isDMBased()) return true;

    const { files, imageName } = await buildHallFiles({
      title: taken.title,
      artistName: msg.author.username,
      description: taken.description,
      imageUrl: url,
      orientation,
      votes: 0,
      weekLabel: "preview",
    });
    const embed = new EmbedBuilder()
      .setColor(BRAND)
      .setTitle(`Preview · ${taken.title}`)
      .setDescription([
        `${msg.author} — press **Create** to hang this in the Art Show, or **Cancel**.`,
        taken.description ? `*${taken.description}*` : null,
      ].filter(Boolean).join("\n"));
    if (imageName) embed.setImage(`attachment://${imageName}`);

    const preview = await channel.send({
      content: `🖼️ Draft ready for ${msg.author}`,
      embeds: [embed],
      files,
      components: draftButtons(msg.author.id),
    });
    setDraftPreviewMessage(msg.guildId, msg.author.id, preview.id);
    await msg.react("✅").catch(() => {});
  } catch (err) {
    logger.warn({ err }, "artshow capture draft failed");
    await msg.reply({ content: "Couldn't build that preview — try `/artshow submit`." }).catch(() => {});
  }
  return true;
}
