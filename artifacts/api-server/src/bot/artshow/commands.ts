/**
 * Art Show slash + component handlers.
 *
 * Staff: `/artshow post` sets a submission board + a read-only gallery,
 * posts a slim station embed on the board.
 * Members: drop a photo on the board (or `/artshow submit` with attachment)
 * → piece hangs in the gallery with Upvote / Remove vote / Bump / Browse.
 */

import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder,
  AttachmentBuilder, PermissionFlagsBits,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction, type ButtonInteraction,
  type StringSelectMenuInteraction, type Message, type TextChannel, type NewsChannel,
  type Guild, type GuildChannel,
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
import { extractImageAttachment, titleFromDrop } from "./capture.js";
import { ARTSHOW_STAFF_PERMS } from "./definition.js";

const EPHEMERAL = { ephemeral: true } as const;
const BRAND = 0xc4a574;

function isStaff(interaction: { memberPermissions?: { has: (p: bigint) => boolean } | null }): boolean {
  return Boolean(interaction.memberPermissions?.has(ARTSHOW_STAFF_PERMS)
    || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

/** Resolve board + gallery ids (legacy channelId fills either if unset). */
function channelIds(settings: ArtshowSettings): {
  boardId: string | null;
  galleryId: string | null;
} {
  const boardId = settings.boardChannelId ?? settings.channelId ?? null;
  const galleryId = settings.galleryChannelId ?? settings.channelId ?? null;
  return { boardId, galleryId };
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
        .setLabel("How to submit")
        .setEmoji("🖼️")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("artshow:browse")
        .setLabel("Browse halls")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("artshow:museum")
        .setLabel("Hall of Fame")
        .setEmoji("🏛️")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("artshow:votes")
        .setLabel("My votes")
        .setEmoji("🎟️")
        .setStyle(ButtonStyle.Secondary),
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

function slugChannelName(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "").slice(0, 90) || "art-show";
}

const STAFF_GALLERY_ALLOW = {
  ViewChannel: true,
  ReadMessageHistory: true,
  SendMessages: true,
  EmbedLinks: true,
  AttachFiles: true,
  ManageMessages: true,
  AddReactions: true,
} as const;

/** Gallery: @everyone can view/read, cannot send. Bot + staff roles can post. */
async function applyGalleryReadonly(
  channel: GuildChannel,
  guild: Guild,
  staffRoleId?: string | null,
): Promise<void> {
  if (!("permissionOverwrites" in channel)) return;
  try {
    await channel.permissionOverwrites.edit(guild.roles.everyone, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
      SendMessagesInThreads: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      AddReactions: false,
      AttachFiles: false,
    });
    const me = guild.members.me;
    if (me) {
      await channel.permissionOverwrites.edit(me.id, STAFF_GALLERY_ALLOW);
    }
    // Roles with Manage Server / Administrator stay able to post (staff immune).
    for (const role of guild.roles.cache.values()) {
      if (role.id === guild.id) continue; // @everyone
      if (
        role.permissions.has(PermissionFlagsBits.ManageGuild)
        || role.permissions.has(PermissionFlagsBits.Administrator)
      ) {
        await channel.permissionOverwrites.edit(role.id, STAFF_GALLERY_ALLOW).catch(() => {});
      }
    }
    if (staffRoleId) {
      await channel.permissionOverwrites.edit(staffRoleId, STAFF_GALLERY_ALLOW);
    }
  } catch (err) {
    logger.warn({ err, channelId: channel.id }, "artshow gallery readonly overwrites failed");
  }
}

/** Board: members can drop photos; bot can manage the station. */
async function applyBoardSubmitPerms(
  channel: GuildChannel,
  guild: Guild,
): Promise<void> {
  if (!("permissionOverwrites" in channel)) return;
  try {
    await channel.permissionOverwrites.edit(guild.roles.everyone, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: true,
      AttachFiles: true,
      EmbedLinks: true,
      AddReactions: true,
    });
    const me = guild.members.me;
    if (me) {
      await channel.permissionOverwrites.edit(me.id, {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: true,
        EmbedLinks: true,
        AttachFiles: true,
        ManageMessages: true,
        AddReactions: true,
      });
    }
  } catch (err) {
    logger.warn({ err, channelId: channel.id }, "artshow board perms failed");
  }
}

async function buildStationEmbed(guildId: string): Promise<{
  embeds: EmbedBuilder[];
  files: AttachmentBuilder[];
}> {
  const settings = await getOrCreateArtshowSettings(guildId);
  const week = utcWeekKey();
  const leaders = await topPieces(guildId, { weekKey: week, limit: 3 });
  const fame = await getFame(guildId, week);
  const { galleryId } = channelIds(settings);

  const lines = [
    "Hang what you **made** — drawings, builds, clay, photos, crafts.",
    "",
    "**Submit** — drop a photo in this channel (put a title in your message), or `/artshow submit`",
    galleryId
      ? `**Gallery** — hung pieces & votes live in <#${galleryId}>`
      : "**Gallery** — staff still needs to set a gallery channel",
  ];

  if (leaders.length) {
    lines.push(
      "",
      "**This week**",
      ...leaders.map((p, i) =>
        `${["🥇", "🥈", "🥉"][i] ?? "•"} **${p.title}** — <@${p.authorId}> · **▲ ${p.votes}**`),
    );
  }
  if (fame) {
    lines.push("", `🏆 **Champion:** **${fame.title}** by <@${fame.authorId}>`);
  }

  const embed = new EmbedBuilder()
    .setColor(BRAND)
    .setTitle("🎨 Community Art Show")
    .setDescription(lines.join("\n"))
    .setFooter({ text: `Week ${week}` });

  return { embeds: [embed], files: [] };
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

async function fetchTextChannel(
  client: { channels: { fetch: (id: string) => Promise<unknown> } },
  channelId: string | null | undefined,
): Promise<TextChannel | NewsChannel | null> {
  if (!channelId) return null;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || typeof channel !== "object" || !("isTextBased" in channel)) return null;
  const ch = channel as TextChannel | NewsChannel;
  if (!ch.isTextBased() || ch.isDMBased()) return null;
  return ch;
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
}

async function resolveOrCreateChannel(
  interaction: ChatInputCommandInteraction,
  opts: {
    existing: { id: string; send?: unknown } | null;
    createName: string | null;
    topic: string;
    kind: "board" | "gallery";
    staffRoleId?: string | null;
  },
): Promise<TextChannel | NewsChannel | null> {
  if (opts.existing && "send" in opts.existing) {
    const ch = opts.existing as TextChannel | NewsChannel;
    if (interaction.guild) {
      if (opts.kind === "gallery") {
        await applyGalleryReadonly(ch as GuildChannel, interaction.guild, opts.staffRoleId);
      } else {
        await applyBoardSubmitPerms(ch as GuildChannel, interaction.guild);
      }
    }
    return ch;
  }

  if (opts.createName && interaction.guild) {
    const guild = interaction.guild as Guild;
    const created = await guild.channels.create({
      name: slugChannelName(opts.createName),
      type: ChannelType.GuildText,
      topic: opts.topic,
      reason: `Art Show ${opts.kind} created by ${interaction.user.tag}`,
    });
    if (opts.kind === "gallery") {
      await applyGalleryReadonly(created, guild, opts.staffRoleId);
    } else {
      await applyBoardSubmitPerms(created, guild);
    }
    return created as TextChannel;
  }

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
      "Pick a hall to view. **One** weekly champion takes the museum.",
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
      "World wings shuffle famous **public-domain** masterpieces; marble statues flank the floor.",
      "Only **one** community piece owns center stage each week.",
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
    const staffRole = interaction.options.getRole("staff_role");
    const staffRoleId = staffRole?.id
      ?? (await getOrCreateArtshowSettings(interaction.guildId)).staffRoleId
      ?? null;

    const boardOpt = interaction.options.getChannel("board");
    const galleryOpt = interaction.options.getChannel("gallery");
    const createBoard = interaction.options.getString("create_board")?.trim() ?? null;
    const createGallery = interaction.options.getString("create_gallery")?.trim() ?? null;

    const board = await resolveOrCreateChannel(interaction, {
      existing: boardOpt && "send" in boardOpt ? boardOpt as TextChannel : null,
      createName: createBoard,
      topic: "Art Show submission board — drop a photo here to hang it in the gallery",
      kind: "board",
      staffRoleId,
    });
    const gallery = await resolveOrCreateChannel(interaction, {
      existing: galleryOpt && "send" in galleryOpt ? galleryOpt as TextChannel : null,
      createName: createGallery,
      topic: "Art Show gallery — hung pieces & votes (read-only for members)",
      kind: "gallery",
      staffRoleId,
    });

    if (!board || !gallery) {
      await interaction.editReply([
        "Need **both** a submission board and a gallery.",
        "Set `board` / `gallery`, or `create_board` / `create_gallery`.",
        "Example: `/artshow post create_board:art-show create_gallery:art-hall`",
      ].join("\n"));
      return;
    }

    if (board.id === gallery.id) {
      await interaction.editReply(
        "Board and gallery must be **different** channels — one for drops, one for hung pieces.",
      );
      return;
    }

    const prior = await getOrCreateArtshowSettings(interaction.guildId);
    const legacySticky = prior.stickyMessageId;
    if (legacySticky) {
      await board.messages.delete(legacySticky).catch(() => {});
      await gallery.messages.delete(legacySticky).catch(() => {});
    }

    const s = await updateArtshowSettings(interaction.guildId, {
      ...thresholdPatch,
      boardChannelId: board.id,
      galleryChannelId: gallery.id,
      channelId: gallery.id,
      stickyMessageId: null,
      staffRoleId,
      enabled: true,
    });

    const payload = await buildStationEmbed(interaction.guildId);
    const sent = await board.send({
      ...payload,
      components: stationButtons(),
    });
    await updateArtshowSettings(interaction.guildId, { stationMessageId: sent.id });
    await sent.pin().catch(() => {});

    await interaction.editReply([
      `✅ Art Show live`,
      `· **Board** <#${board.id}> — drop photos / station`,
      `· **Gallery** <#${gallery.id}> — hung pieces (read-only for members${staffRoleId ? `; <@&${staffRoleId}> can post` : "; Manage Server staff use Discord perms / set staff_role"})`,
      "",
      "**Thresholds**",
      formatSettings(s),
      "",
      "Reset anytime: `/artshow setup reset_defaults:True`.",
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
    const staffRole = interaction.options.getRole("staff_role");
    if (staffRole) patch.staffRoleId = staffRole.id;
    if (!Object.keys(patch).length) {
      const s = await getOrCreateArtshowSettings(interaction.guildId);
      const { boardId, galleryId } = channelIds(s);
      await interaction.editReply([
        "**Current Art Show setup**",
        formatSettings(s),
        boardId ? `Board: <#${boardId}>` : "Board: _unset_",
        galleryId ? `Gallery: <#${galleryId}>` : "Gallery: _unset_",
        s.staffRoleId ? `Staff role: <@&${s.staffRoleId}>` : "Staff role: _unset_",
        "",
        "_Pass options to change, or `reset_defaults:True`._",
      ].join("\n"));
      return;
    }
    const s = await updateArtshowSettings(interaction.guildId, patch);
    if (patch.staffRoleId && s.galleryChannelId && interaction.guild) {
      const gCh = await fetchTextChannel(interaction.client, s.galleryChannelId);
      if (gCh) await applyGalleryReadonly(gCh as GuildChannel, interaction.guild, patch.staffRoleId);
    }
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
    const { galleryId } = channelIds(settings);
    const channel = await fetchTextChannel(interaction.client, galleryId);
    if (!channel) {
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
    const piece = await publishPiece({
      guildId: interaction.guildId,
      channel,
      authorId: interaction.user.id,
      authorName: interaction.user.username,
      title,
      description,
      imageUrl: url,
      orientation,
    });
    await interaction.editReply(
      `✅ Hung **${piece.title}** in <#${channel.id}> — piece \`#${piece.id}\`.`,
    );
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
    const { galleryId } = channelIds(settings);
    const ch = await fetchTextChannel(interaction.client, galleryId);
    if (ch) {
      await maybeAnnounceBadges(ch, interaction.guildId, piece.authorId, badgeResult);
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
    const settings = await getOrCreateArtshowSettings(interaction.guildId);
    const { boardId, galleryId } = channelIds(settings);
    await interaction.reply({
      content: [
        "**Submit your art**",
        "",
        boardId
          ? `1. Drop a **photo** in <#${boardId}> (put a short **title** in the message)`
          : "1. Drop a **photo** in the submission board (put a short **title** in the message)",
        "2. Or use `/artshow submit` and attach the image",
        galleryId
          ? `3. Your piece hangs in <#${galleryId}> for ▲ votes`
          : "3. Your piece hangs in the gallery for ▲ votes",
      ].join("\n"),
      ...EPHEMERAL,
    });
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

  if (id === "artshow:votes") {
    await interaction.deferReply({ ephemeral: true });
    const settings = await getOrCreateArtshowSettings(interaction.guildId);
    const wallet = await getOrRefreshWallet(interaction.guildId, interaction.user.id, settings);
    await interaction.editReply(
      `🎟️ Votes left: **${wallet.remaining}** · Free bumps: **${wallet.freeBumps}**\nRemove a vote anytime before crowning to get it back.`,
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

  // Ignore legacy draft / staff_reset / badges buttons on old station messages.
  if (
    id.startsWith("artshow:draft_")
    || id === "artshow:staff_reset"
    || id === "artshow:badges"
  ) {
    await interaction.reply({
      content: "That control was removed. Drop a photo on the board or use `/artshow submit`.",
      ...EPHEMERAL,
    });
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

/** Modal submit kept as no-op for old station messages still showing the modal flow. */
export async function handleArtShowModal(interaction: { customId: string; reply: (o: object) => Promise<unknown> }): Promise<void> {
  if (!interaction.customId.startsWith("artshow:")) return;
  await interaction.reply({
    content: "That submit flow was removed. Drop a photo on the board channel, or use `/artshow submit`.",
    ...EPHEMERAL,
  });
}

/**
 * MessageCreate — photo dropped on the submission board → hang in gallery.
 * No timer, no Create/Cancel preview.
 */
export async function handleArtShowMessage(msg: Message): Promise<boolean> {
  if (!msg.guildId || msg.author.bot) return false;

  const att = extractImageAttachment(msg);
  if (!att) return false;

  const settings = await getOrCreateArtshowSettings(msg.guildId);
  if (!settings.enabled) return false;
  const { boardId, galleryId } = channelIds(settings);
  if (!boardId || msg.channelId !== boardId) return false;
  if (!galleryId) {
    await msg.reply("Gallery channel isn't set — staff should `/artshow post`.").catch(() => {});
    return true;
  }

  const gallery = await fetchTextChannel(msg.client, galleryId);
  if (!gallery) {
    await msg.reply("Gallery channel is missing — staff should `/artshow post`.").catch(() => {});
    return true;
  }

  try {
    const url = await persistBotImage(att.url, att.contentType ?? undefined);
    const orientation = await detectOrientation(url);
    const title = titleFromDrop(msg.content, att.name);
    const description = msg.content.trim().includes("\n")
      ? msg.content.trim().split("\n").slice(1).join("\n").trim().slice(0, 400)
      : "";

    const piece = await publishPiece({
      guildId: msg.guildId,
      channel: gallery,
      authorId: msg.author.id,
      authorName: msg.author.username,
      title,
      description,
      imageUrl: url,
      orientation,
    });

    await msg.delete().catch(() => {});
    const ack = await gallery.send({
      content: `📥 <@${msg.author.id}> submitted **${piece.title}** from the board.`,
    }).catch(() => null);
    if (ack) setTimeout(() => { ack.delete().catch(() => {}); }, 12_000);
  } catch (err) {
    logger.warn({ err }, "artshow board drop failed");
    await msg.reply({ content: "Couldn't hang that photo — try `/artshow submit`." }).catch(() => {});
  }
  return true;
}
