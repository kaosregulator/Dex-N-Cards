/**
 * Art Show slash + component handlers.
 */

import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, AttachmentBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionFlagsBits,
  type ChatInputCommandInteraction, type ButtonInteraction, type ModalSubmitInteraction,
  type Message, type TextChannel, type NewsChannel,
} from "discord.js";
import { logger } from "../../lib/logger.js";
import { persistBotImage } from "../commands/edit-card.js";
import {
  getOrCreateArtshowSettings, updateArtshowSettings,
  insertPiece, setPieceMessage, getPiece, topPieces,
  getOrRefreshWallet, grantSubmitBonus, spendVote, spendBump, grantFreeBump,
  countAuthorSubmits, countVotesCast, countAuthorCrowns,
  crownPiece, getFame, listFame, utcWeekKey,
} from "../../lib/artshow/db.js";
import type { ArtshowPiece, ArtshowSettings } from "@workspace/db";
import { awardArtShowBadges } from "../badges/engine.js";
import { buildBadgeShowcase } from "../badges/announce.js";
import { detectOrientation, renderArtHallGif, renderArtHallPng } from "./render-hall.js";
import { renderMuseumGif } from "./render-museum.js";
import { renderArtBadgeGuideGif } from "./render-guide.js";
import { beginArtCapture, takeArtCapture, extractImageAttachment, peekArtCapture } from "./capture.js";
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
        .setCustomId(`artshow:bump:${pieceId}`)
        .setLabel("Bump")
        .setEmoji("📌")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("artshow:museum")
        .setLabel("Museum")
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
        .setCustomId("artshow:museum")
        .setLabel("Hall of Fame")
        .setEmoji("🏛️")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("artshow:badges")
        .setLabel("Emblem path")
        .setEmoji("✨")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("artshow:votes")
        .setLabel("My votes")
        .setEmoji("🎟️")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

async function buildStationEmbed(guildId: string): Promise<{
  embeds: EmbedBuilder[];
  files: AttachmentBuilder[];
}> {
  const settings = await getOrCreateArtshowSettings(guildId);
  const week = utcWeekKey();
  const leaders = await topPieces(guildId, { weekKey: week, limit: 1 });
  const lead = leaders[0];
  const fame = await getFame(guildId, week);

  const guide = await renderArtBadgeGuideGif();
  const files: AttachmentBuilder[] = [];
  const embed = new EmbedBuilder()
    .setColor(BRAND)
    .setTitle("🎨 Community Art Show")
    .setDescription([
      "Hang what you **made** — drawings, builds, clay, photos, crafts.",
      "",
      "**How it works**",
      "1. Press **Submit your art** → title + description",
      "2. Upload your photo in this channel (or use `/artshow submit`)",
      "3. Others press **Upvote** on the hall canvas (not emoji reactions)",
      "",
      `🎟️ **${settings.votesPerDay}** votes / day · +**${settings.bonusVotesOnSubmit}** when you submit · refresh every **${settings.voteRefreshHours}h**`,
      `📌 Bump your piece to the top for **${settings.bumpCostVotes}** votes (Rising Artist = 1 free / day)`,
      settings.crownThreshold > 0
        ? `🏆 First piece to **${settings.crownThreshold} ▲** this week enters the museum — or staff crowns the leader`
        : "🏆 Staff crowns the weekly leader into the Hall of Fame museum",
    ].join("\n"));

  if (lead) {
    embed.addFields({
      name: "🔥 This week's lead",
      value: `**${lead.title}** by <@${lead.authorId}> — **▲ ${lead.votes}**`,
      inline: false,
    });
  }
  if (fame) {
    embed.addFields({
      name: "🏛️ Crowned this week",
      value: `**${fame.title}** by <@${fame.authorId}> — **▲ ${fame.votesAtCrown}**`,
      inline: false,
    });
  }

  if (guide) {
    files.push(new AttachmentBuilder(guide, { name: "artshow-path.gif" }));
    embed.setImage("attachment://artshow-path.gif");
  }
  embed.setFooter({ text: `Week ${week} · Emblems evolve — open Emblem path anytime` });
  return { embeds: [embed], files };
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

  // Rising Artist perk: free bump once unlocked
  if (badgeResult.awarded.includes("art_rising") || badgeResult.results.some(r => r.badge.id === "art_rising" && r.unlocked)) {
    const settings = await getOrCreateArtshowSettings(guildId);
    await grantFreeBump(guildId, userId, settings).catch(() => {});
  }
}

async function publishPiece(opts: {
  guildId: string;
  channel: TextChannel | NewsChannel;
  authorId: string;
  authorName: string;
  title: string;
  description: string;
  imageUrl: string;
}): Promise<ArtshowPiece> {
  const orientation = await detectOrientation(opts.imageUrl);
  const piece = await insertPiece({
    guildId: opts.guildId,
    authorId: opts.authorId,
    title: opts.title,
    description: opts.description,
    imageUrl: opts.imageUrl,
    orientation,
    channelId: opts.channel.id,
  });

  const hallGif = await renderArtHallGif({
    title: piece.title,
    artistName: opts.authorName,
    description: piece.description,
    imageUrl: piece.imageUrl,
    orientation: orientation as "landscape" | "portrait" | "square",
    votes: 0,
    weekLabel: piece.weekKey,
  });
  // Settle still for embed (GIF may be large) — prefer animated hall if small enough
  const hallPng = await renderArtHallPng({
    title: piece.title,
    artistName: opts.authorName,
    description: piece.description,
    imageUrl: piece.imageUrl,
    orientation: orientation as "landscape" | "portrait" | "square",
    votes: 0,
    weekLabel: piece.weekKey,
  });

  const files: AttachmentBuilder[] = [];
  let imageName = "art-hall.png";
  if (hallGif && hallGif.length < 7_500_000) {
    imageName = "art-hall.gif";
    files.push(new AttachmentBuilder(hallGif, { name: imageName }));
  } else if (hallPng) {
    files.push(new AttachmentBuilder(hallPng, { name: imageName }));
  }

  const embed = new EmbedBuilder()
    .setColor(BRAND)
    .setTitle(`🖼️ ${piece.title}`)
    .setDescription([
      `by <@${opts.authorId}>`,
      piece.description ? `*${piece.description}*` : null,
      "",
      "**▲ Upvote** this piece — votes go to the artist’s show score.",
      `_Piece #${piece.id} · ${piece.weekKey}_`,
    ].filter(Boolean).join("\n"));
  if (files.length) embed.setImage(`attachment://${imageName}`);
  else embed.setImage(piece.imageUrl);

  const sent = await opts.channel.send({
    content: `✨ **New hanging** — <@${opts.authorId}> entered the Art Show`,
    embeds: [embed],
    files,
    components: pieceButtons(piece.id),
  });
  await setPieceMessage(piece.id, sent.id);

  // Submit badges + vote bonus
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
  const hall = await renderArtHallGif({
    title: piece.title,
    artistName,
    description: piece.description,
    imageUrl: piece.imageUrl,
    orientation,
    votes: piece.votes,
    weekLabel: piece.weekKey,
  });
  const files: AttachmentBuilder[] = [];
  const name = hall && hall.length < 7_500_000 ? "art-hall.gif" : "art-hall.png";
  if (hall && hall.length < 7_500_000) {
    files.push(new AttachmentBuilder(hall, { name }));
  } else {
    const png = await renderArtHallPng({
      title: piece.title,
      artistName,
      description: piece.description,
      imageUrl: piece.imageUrl,
      orientation,
      votes: piece.votes,
      weekLabel: piece.weekKey,
    });
    if (png) files.push(new AttachmentBuilder(png, { name: "art-hall.png" }));
  }

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
  if (files.length) embed.setImage(`attachment://${files[0]!.name}`);
  else embed.setImage(piece.imageUrl);

  const sent = await channel.send({
    content: piece.bumpedAt
      ? `📌 **Bumped** — <@${piece.authorId}>'s piece returns to the floor`
      : `▲ Vote update — **${piece.title}**`,
    embeds: [embed],
    files,
    components: pieceButtons(piece.id),
  });
  await setPieceMessage(piece.id, sent.id);
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
      `**${fame.title}** takes center stage in the museum.`,
      "World wings frame the hall — your piece is the one under the lights.",
    ].join("\n"));
  if (files.length) embed.setImage("attachment://museum.gif");
  await channel.send({ embeds: [embed], files });
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
    const ch = (interaction.options.getChannel("channel") ?? interaction.channel) as TextChannel | NewsChannel | null;
    if (!ch || !("send" in ch)) {
      await interaction.editReply("Pick a text channel.");
      return;
    }
    const payload = await buildStationEmbed(interaction.guildId);
    const sent = await ch.send({
      ...payload,
      components: stationButtons(),
    });
    await updateArtshowSettings(interaction.guildId, {
      channelId: ch.id,
      stationMessageId: sent.id,
      enabled: true,
    });
    await interaction.editReply(`Art Show station posted in <#${ch.id}>.`);
    return;
  }

  if (sub === "setup") {
    if (!isStaff(interaction)) {
      await interaction.reply({ content: "Staff only.", ...EPHEMERAL });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
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
    const s = await updateArtshowSettings(interaction.guildId, patch);
    await interaction.editReply([
      "**Art Show setup**",
      `Votes / day: **${s.votesPerDay}**`,
      `Bonus on submit: **${s.bonusVotesOnSubmit}**`,
      `Refresh: every **${s.voteRefreshHours}h** (+1)`,
      `Bump cost: **${s.bumpCostVotes}** votes`,
      `Auto-crown at: **${s.crownThreshold || "off"}**`,
    ].join("\n"));
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
    const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
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
    await publishPiece({
      guildId: interaction.guildId,
      channel: channel as TextChannel,
      authorId: interaction.user.id,
      authorName: interaction.user.username,
      title,
      description,
      imageUrl: url,
    });
    await interaction.editReply("✅ Your piece is hanging in the Art Show!");
    return;
  }

  if (sub === "museum") {
    await interaction.deferReply();
    await replyMuseum(interaction);
    return;
  }

  if (sub === "badges") {
    await interaction.deferReply({ ephemeral: true });
    const gif = await renderArtBadgeGuideGif();
    const embed = new EmbedBuilder()
      .setColor(BRAND)
      .setTitle("✨ Art Show emblem path")
      .setDescription([
        "Emblems level up as you **submit**, **vote**, and **earn ▲**.",
        "First unlock shows a full emblem GIF — then it evolves through tiers (Kindling → Apex).",
        "",
        "Use `/badges` anytime to open your full showcase.",
      ].join("\n"));
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
      `Base **${settings.votesPerDay}**/day · +**${settings.bonusVotesOnSubmit}** per submit · +1 every **${settings.voteRefreshHours}h**`,
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
    if (interaction.channel && interaction.channel.isTextBased() && !interaction.channel.isDMBased()) {
      await maybeAnnounceBadges(interaction.channel as TextChannel, interaction.guildId, piece.authorId, badgeResult);
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
      .setDescription(`**${fame.title}** by <@${fame.authorId}> · **▲ ${fame.votesAtCrown}**`);
    if (museum) {
      files.push(new AttachmentBuilder(museum, { name: "museum.gif" }));
      embed.setImage("attachment://museum.gif");
    }
    await interaction.editReply({ embeds: [embed], files });
    return;
  }

  await interaction.reply({ content: "Unknown subcommand.", ...EPHEMERAL });
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
        ? `**Center stage:** ${champ.title} — <@${champ.authorId}>`
        : `**Interim lead** (staff can \`/artshow crown\`): ${champ.title} — <@${champ.authorId}>`,
      "",
      "World wings (Russia · UK · USA · Spain · China · Japan · France · Brazil) frame the hall.",
      "Stylized cultural abstracts — your community piece is the real masterwork under the lights.",
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
    await interaction.reply({ embeds: [embed], files });
  }
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

  if (id === "artshow:badges") {
    await interaction.deferReply({ ephemeral: true });
    const gif = await renderArtBadgeGuideGif();
    const embed = new EmbedBuilder()
      .setColor(BRAND)
      .setTitle("✨ How Art Show emblems evolve")
      .setDescription("Submit → vote → earn ▲ → crown. Emblems show on unlock and as they tier up. `/badges` for your collection.");
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
      `🎟️ Votes left: **${wallet.remaining}** · Free bumps: **${wallet.freeBumps}** · +${settings.bonusVotesOnSubmit} when you submit · +1 / ${settings.voteRefreshHours}h`,
    );
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

    // Update original message vote count (best-effort)
    try {
      const embed = EmbedBuilder.from(interaction.message.embeds[0] ?? new EmbedBuilder())
        .setDescription([
          `by <@${result.piece.authorId}>`,
          result.piece.description ? `*${result.piece.description}*` : null,
          "",
          `**▲ ${result.piece.votes}** upvotes`,
          `_Piece #${result.piece.id} · ${result.piece.weekKey}_`,
        ].filter(Boolean).join("\n"));
      await interaction.message.edit({ embeds: [embed], components: pieceButtons(result.piece.id) });
    } catch { /* webhook/age — ignore */ }

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
    }

    await interaction.editReply(
      `▲ Voted for **${result.piece.title}** — now **${result.piece.votes}**. Votes left: **${result.wallet.remaining}**.`,
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
    // Soft "to the top": delete old floor message and repost
    if (result.piece.messageId) {
      await channel.messages.delete(result.piece.messageId).catch(() => {});
    }
    await refreshPieceMessage(
      result.piece,
      channel as TextChannel,
      interaction.user.username,
    );
    await interaction.editReply(
      result.usedFree
        ? "📌 Bumped with your **free Rising Artist** bump!"
        : `📌 Bumped for **${settings.bumpCostVotes}** votes. Remaining: **${result.wallet.remaining}**.`,
    );
    return;
  }
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
      `✅ **${title}** is ready for the wall.`,
      "",
      `Now **upload your photo** in <#${channelId}> within **2 minutes**`,
      "(Discord attachment — phone or laptop). Or run `/artshow submit` with the image.",
    ].join("\n"),
    ...EPHEMERAL,
  });
}

/** MessageCreate hook — finish modal submit when artist attaches an image. */
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
    const channel = msg.channel;
    if (!channel.isTextBased() || channel.isDMBased()) return true;
    await publishPiece({
      guildId: msg.guildId,
      channel: channel as TextChannel,
      authorId: msg.author.id,
      authorName: msg.author.username,
      title: taken.title,
      description: taken.description,
      imageUrl: url,
    });
    await msg.react("🖼️").catch(() => {});
  } catch (err) {
    logger.warn({ err }, "artshow capture publish failed");
    await msg.reply({ content: "Couldn't hang that piece — try `/artshow submit`." }).catch(() => {});
  }
  return true;
}
