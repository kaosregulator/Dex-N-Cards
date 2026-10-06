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
  StringSelectMenuBuilder, ModalBuilder, LabelBuilder, FileUploadBuilder,
  TextInputBuilder, TextInputStyle,
  type ChatInputCommandInteraction, type ButtonInteraction,
  type StringSelectMenuInteraction, type ModalSubmitInteraction,
  type Message, type TextChannel, type NewsChannel,
  type Guild, type GuildChannel, type Attachment,
} from "discord.js";
import { logger } from "../../lib/logger.js";
import { persistBotImage } from "../commands/edit-card.js";
import { toAbsoluteImageUrl } from "../image-url.js";
import {
  getOrCreateArtshowSettings, updateArtshowSettings, resetArtshowSettings,
  insertPiece, setPieceMessage, getPiece, topPieces, listUnpostedPieces,
  getOrRefreshWallet, grantSubmitBonus, spendVote, removeVote, spendBump, grantFreeBump,
  countAuthorSubmits, countVotesCast, countAuthorCrowns,
  listAuthorSubmitCounts, listVoterCastCounts, listAuthorPeakVotes, listAuthorCrownCounts,
  crownPiece, getFame, listFame, utcWeekKey,
} from "../../lib/artshow/db.js";
import { mergeMissingDefaultBadgeRules } from "../../lib/badges/db.js";
import { ARTSHOW_DEFAULTS } from "../../lib/artshow/defaults.js";
import type { ArtshowPiece, ArtshowSettings } from "@workspace/db";
import { awardArtShowBadges } from "../badges/engine.js";
import { buildBadgeShowcase } from "../badges/announce.js";
import { detectOrientation, renderArtHallPng } from "./render-hall.js";
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
        .setLabel("Submit art")
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

/** Discord-native file picker modal (same pattern as /emoji + UB store). */
function buildSubmitModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("artshow:submit_modal")
    .setTitle("Submit your art")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Title")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("title")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(80)
            .setPlaceholder("Midnight clay fox"),
        ),
      new LabelBuilder()
        .setLabel("Your photo")
        .setDescription("Discord’s file picker — photo from your device")
        .setFileUploadComponent(
          new FileUploadBuilder()
            .setCustomId("image")
            .setRequired(true)
            .setMinValues(1)
            .setMaxValues(1),
        ),
    );
}

function isImageAttachment(att: Attachment): boolean {
  const type = att.contentType?.toLowerCase() ?? "";
  const name = att.name?.toLowerCase() ?? "";
  if (type.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
}

function attachmentSourceUrl(att: Attachment): string {
  return att.proxyURL || att.url;
}

/** Public URL Discord embeds can load (never raw /objects/…). */
function publicImageUrl(stored: string | null | undefined): string | null {
  if (!stored) return null;
  return toAbsoluteImageUrl(stored) ?? (/^https?:\/\//i.test(stored) ? stored : null);
}

async function fetchImageBytes(url: string): Promise<{ buf: Buffer; contentType: string; ext: string } | null> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(25_000) });
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length || buf.length > 12 * 1024 * 1024) return null;
    const ct = resp.headers.get("content-type") ?? "image/jpeg";
    let ext = "jpg";
    if (ct.includes("png") || url.includes(".png")) ext = "png";
    else if (ct.includes("gif") || url.includes(".gif")) ext = "gif";
    else if (ct.includes("webp") || url.includes(".webp")) ext = "webp";
    return { buf, contentType: ct, ext };
  } catch {
    return null;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(v => v).catch(() => null as T | null),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
    "**Submit** — tap **Submit art** → Discord’s photo uploader (or `/artshow submit`)",
    galleryId
      ? `**Gallery** — hung pieces & ▲ votes live in <#${galleryId}>`
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
  channel: { send: (o: object) => Promise<unknown> } | null | undefined,
  guildId: string,
  userId: string,
  badgeResult: Awaited<ReturnType<typeof awardArtShowBadges>>,
  alsoChannel?: { send: (o: object) => Promise<unknown> } | null,
): Promise<void> {
  const flashy = badgeResult.results.filter(r => r.unlocked || r.leveled || r.tierChanged);
  for (const result of flashy) {
    const rule = badgeResult.rules.find(r => r.id === result.badge.id);
    if (!rule) continue;
    try {
      const showcase = await buildBadgeShowcase({
        result,
        rule,
        mention: `<@${userId}>`,
        forceEmblem: result.unlocked || result.tierChanged,
      });
      const payload = {
        content: showcase.content,
        embeds: showcase.embeds,
        files: showcase.files,
      };
      const targets = [channel, alsoChannel].filter(Boolean) as Array<{ send: (o: object) => Promise<unknown> }>;
      for (const ch of targets) {
        try {
          const msg = await ch.send(payload) as Message;
          // Keep unlock notices longer so people actually see the emblem.
          const ttl = result.unlocked ? 120_000 : 55_000;
          setTimeout(() => { msg.delete().catch(() => {}); }, ttl);
        } catch (err) {
          logger.debug({ err }, "artshow badge announce channel send failed");
        }
      }
    } catch (err) {
      logger.debug({ err }, "artshow badge announce failed");
    }
  }
  if (badgeResult.results.some(r => r.badge.id === "art_rising" && r.unlocked)) {
    const settings = await getOrCreateArtshowSettings(guildId);
    await grantFreeBump(guildId, userId, settings).catch(() => {});
  }
}

function badgeUnlockLine(badgeResult: Awaited<ReturnType<typeof awardArtShowBadges>>): string {
  const unlocked = badgeResult.results.filter(r => r.unlocked);
  if (!unlocked.length) return "";
  const labels = unlocked.map(r => {
    const rule = badgeResult.rules.find(x => x.id === r.badge.id);
    return rule ? `${rule.emoji} **${rule.name}**` : r.badge.id;
  });
  return `\n✨ Emblem unlocked: ${labels.join(", ")} — check \`/badges\``;
}

async function followUpBadgeEmblem(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction | ButtonInteraction,
  badgeResult: Awaited<ReturnType<typeof awardArtShowBadges>>,
): Promise<void> {
  const unlocked = badgeResult.results.filter(r => r.unlocked);
  if (!unlocked.length) return;
  const primary = unlocked[0]!;
  const rule = badgeResult.rules.find(r => r.id === primary.badge.id);
  if (!rule) return;
  const showcase = await buildBadgeShowcase({
    result: primary,
    rule,
    mention: `<@${interaction.user.id}>`,
    forceEmblem: true,
  });
  await interaction.followUp({
    content: showcase.content,
    embeds: showcase.embeds,
    files: showcase.files,
    ...EPHEMERAL,
  });
}

/**
 * Build gallery message files. Prefer a quick hall PNG; always fall back to the
 * original photo bytes so Discord hosts the image (never rely on /objects paths).
 */
async function buildGalleryFiles(opts: {
  title: string;
  artistName: string;
  description: string;
  imageUrl: string;
  sourceHttpUrl?: string | null;
  orientation: "landscape" | "portrait" | "square";
  votes: number;
  weekLabel: string;
  originalBytes?: { buf: Buffer; ext: string } | null;
}): Promise<{ files: AttachmentBuilder[]; imageName: string | null }> {
  const renderUrl = publicImageUrl(opts.imageUrl) ?? opts.sourceHttpUrl ?? opts.imageUrl;
  const hallPng = await withTimeout(
    renderArtHallPng({
      title: opts.title,
      artistName: opts.artistName,
      description: opts.description,
      imageUrl: renderUrl,
      orientation: opts.orientation,
      votes: opts.votes,
      weekLabel: opts.weekLabel,
    }),
    8_000,
  );
  if (hallPng && hallPng.length > 0 && hallPng.length < 7_500_000) {
    return {
      files: [new AttachmentBuilder(hallPng, { name: "art-hall.png" })],
      imageName: "art-hall.png",
    };
  }

  if (opts.originalBytes?.buf?.length) {
    const name = `art.${opts.originalBytes.ext || "jpg"}`;
    return {
      files: [new AttachmentBuilder(opts.originalBytes.buf, { name })],
      imageName: name,
    };
  }

  const http = publicImageUrl(opts.imageUrl) ?? opts.sourceHttpUrl;
  if (http) {
    const downloaded = await fetchImageBytes(http);
    if (downloaded) {
      const name = `art.${downloaded.ext}`;
      return {
        files: [new AttachmentBuilder(downloaded.buf, { name })],
        imageName: name,
      };
    }
  }

  return { files: [], imageName: null };
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

/**
 * Persist Discord upload → store path, but keep the CDN URL for rendering.
 * Never put `/objects/...` into Discord setImage — attach bytes instead.
 */
async function ingestUpload(att: Attachment): Promise<{
  storedUrl: string;
  sourceHttpUrl: string;
  bytes: { buf: Buffer; ext: string } | null;
  orientation: "landscape" | "portrait" | "square";
}> {
  const sourceHttpUrl = attachmentSourceUrl(att);
  const bytes = await fetchImageBytes(sourceHttpUrl);
  let storedUrl = sourceHttpUrl;
  try {
    storedUrl = await persistBotImage(sourceHttpUrl, att.contentType ?? bytes?.contentType);
  } catch (err) {
    logger.warn({ err }, "artshow persist skipped — using Discord CDN URL");
    storedUrl = sourceHttpUrl;
  }
  // Discord rejects relative /objects paths; if persist returned one, keep CDN for display fallback.
  const orientation = await detectOrientation(publicImageUrl(storedUrl) ?? sourceHttpUrl);
  return {
    storedUrl,
    sourceHttpUrl,
    bytes: bytes ? { buf: bytes.buf, ext: bytes.ext } : null,
    orientation,
  };
}

async function sendPieceMessage(opts: {
  piece: ArtshowPiece;
  channel: TextChannel | NewsChannel;
  artistName: string;
  content: string;
  sourceHttpUrl?: string | null;
  originalBytes?: { buf: Buffer; ext: string } | null;
}): Promise<Message> {
  const orientation = (opts.piece.orientation === "portrait" || opts.piece.orientation === "square")
    ? opts.piece.orientation
    : "landscape";

  const { files, imageName } = await buildGalleryFiles({
    title: opts.piece.title,
    artistName: opts.artistName,
    description: opts.piece.description,
    imageUrl: opts.piece.imageUrl,
    sourceHttpUrl: opts.sourceHttpUrl,
    orientation,
    votes: opts.piece.votes,
    weekLabel: opts.piece.weekKey,
    originalBytes: opts.originalBytes,
  });

  const embed = new EmbedBuilder()
    .setColor(BRAND)
    .setTitle(`🖼️ ${opts.piece.title}`)
    .setDescription([
      `by <@${opts.piece.authorId}>`,
      opts.piece.description ? `*${opts.piece.description}*` : null,
      "",
      opts.piece.votes > 0
        ? `**▲ ${opts.piece.votes}** upvotes`
        : "**▲ Upvote** · **Remove vote** until crowned · **Bump** · **Browse**",
      `_Piece #${opts.piece.id} · ${opts.piece.weekKey}_`,
    ].filter(Boolean).join("\n"));

  if (imageName) {
    embed.setImage(`attachment://${imageName}`);
  } else {
    const abs = publicImageUrl(opts.piece.imageUrl) ?? opts.sourceHttpUrl ?? null;
    if (abs) embed.setImage(abs);
  }

  try {
    const sent = await opts.channel.send({
      content: opts.content,
      embeds: [embed],
      files,
      components: pieceButtons(opts.piece.id),
    });
    await setPieceMessage(opts.piece.id, sent.id);
    return sent;
  } catch (err) {
    // Last-resort: no hall, no fancy embed image — just the raw photo + vote buttons.
    logger.warn({ err, pieceId: opts.piece.id }, "artshow rich hang failed — trying simple attach");
    const fallbackName = `art.${opts.originalBytes?.ext || "jpg"}`;
    const fallbackFiles: AttachmentBuilder[] = [];
    if (opts.originalBytes?.buf?.length) {
      fallbackFiles.push(new AttachmentBuilder(opts.originalBytes.buf, { name: fallbackName }));
    }
    const simple = new EmbedBuilder()
      .setColor(BRAND)
      .setTitle(`🖼️ ${opts.piece.title}`)
      .setDescription(`by <@${opts.piece.authorId}>\n\n**▲ Upvote** to vote\n_Piece #${opts.piece.id}_`);
    if (fallbackFiles.length) {
      simple.setImage(`attachment://${fallbackName}`);
    } else {
      const abs = publicImageUrl(opts.piece.imageUrl) ?? opts.sourceHttpUrl;
      if (abs) simple.setImage(abs);
    }
    const sent = await opts.channel.send({
      content: opts.content,
      embeds: [simple],
      files: fallbackFiles,
      components: pieceButtons(opts.piece.id),
    });
    await setPieceMessage(opts.piece.id, sent.id);
    return sent;
  }
}

async function publishPiece(opts: {
  guildId: string;
  channel: TextChannel | NewsChannel;
  authorId: string;
  authorName: string;
  title: string;
  description: string;
  storedUrl: string;
  sourceHttpUrl: string;
  originalBytes?: { buf: Buffer; ext: string } | null;
  orientation?: "landscape" | "portrait" | "square";
  client?: { channels: { fetch: (id: string) => Promise<unknown> } };
}): Promise<{
  piece: ArtshowPiece;
  badgeResult: Awaited<ReturnType<typeof awardArtShowBadges>>;
}> {
  const orientation = opts.orientation
    ?? await detectOrientation(opts.sourceHttpUrl || opts.storedUrl);
  const piece = await insertPiece({
    guildId: opts.guildId,
    authorId: opts.authorId,
    title: opts.title,
    description: opts.description,
    imageUrl: opts.storedUrl,
    orientation,
    channelId: opts.channel.id,
  });

  await sendPieceMessage({
    piece,
    channel: opts.channel,
    artistName: opts.authorName,
    content: `✨ **New hanging** — <@${opts.authorId}> entered the Art Show`,
    sourceHttpUrl: opts.sourceHttpUrl,
    originalBytes: opts.originalBytes,
  });

  const settings = await getOrCreateArtshowSettings(opts.guildId);
  await grantSubmitBonus(opts.guildId, opts.authorId, settings);
  const submits = await countAuthorSubmits(opts.guildId, opts.authorId);
  const badgeResult = await awardArtShowBadges({
    guildId: opts.guildId,
    userId: opts.authorId,
    mode: "submit",
    count: submits,
  });
  let board: TextChannel | NewsChannel | null = null;
  if (opts.client) {
    const { boardId } = channelIds(settings);
    board = await fetchTextChannel(opts.client, boardId);
  }
  await maybeAnnounceBadges(opts.channel, opts.guildId, opts.authorId, badgeResult, board);
  return { piece, badgeResult };
}

async function refreshPieceMessage(
  piece: ArtshowPiece,
  channel: TextChannel | NewsChannel,
  artistName: string,
): Promise<Message | null> {
  return sendPieceMessage({
    piece,
    channel,
    artistName,
    content: piece.bumpedAt
      ? `📌 **Bumped** — <@${piece.authorId}>'s piece returns to the floor`
      : `▲ **${piece.title}**`,
    sourceHttpUrl: publicImageUrl(piece.imageUrl),
  });
}

async function resolveGalleryOrThrow(
  client: ChatInputCommandInteraction["client"] | ButtonInteraction["client"] | ModalSubmitInteraction["client"],
  guildId: string,
): Promise<TextChannel | NewsChannel> {
  const settings = await getOrCreateArtshowSettings(guildId);
  if (!settings.enabled) throw new Error("Art Show is disabled.");
  const { galleryId } = channelIds(settings);
  const channel = await fetchTextChannel(client, galleryId);
  if (!channel) {
    throw new Error("Gallery channel not set — staff should `/artshow post` first.");
  }
  return channel;
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
    try {
      const image = interaction.options.getAttachment("image", true);
      const title = interaction.options.getString("title", true);
      const description = interaction.options.getString("description") ?? "";
      if (!isImageAttachment(image)) {
        await interaction.editReply("Please upload an image file (PNG, JPG, GIF, or WebP).");
        return;
      }
      const channel = await resolveGalleryOrThrow(interaction.client, interaction.guildId);
      const ingested = await ingestUpload(image);
      const { piece, badgeResult } = await publishPiece({
        guildId: interaction.guildId,
        channel,
        authorId: interaction.user.id,
        authorName: interaction.user.username,
        title,
        description,
        storedUrl: ingested.storedUrl,
        sourceHttpUrl: ingested.sourceHttpUrl,
        originalBytes: ingested.bytes,
        orientation: ingested.orientation,
        client: interaction.client,
      });
      await interaction.editReply(
        `✅ Hung **${piece.title}** in <#${channel.id}> — piece \`#${piece.id}\`. Tap **▲ Upvote** there.`
        + badgeUnlockLine(badgeResult),
      );
      await followUpBadgeEmblem(interaction, badgeResult).catch(() => {});
    } catch (err) {
      logger.warn({ err }, "artshow slash submit failed");
      await interaction.editReply(
        `❌ Couldn't hang that photo: ${err instanceof Error ? err.message : "unknown error"}. Try the **Submit art** button (Discord file picker).`,
      ).catch(() => {});
    }
    return;
  }

  if (sub === "sync_badges") {
    if (!isStaff(interaction)) {
      await interaction.reply({ content: "Staff only.", ...EPHEMERAL });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      const { added } = await mergeMissingDefaultBadgeRules(interaction.guildId);
      const settings = await getOrCreateArtshowSettings(interaction.guildId);
      const { galleryId, boardId } = channelIds(settings);
      const gallery = await fetchTextChannel(interaction.client, galleryId);
      const board = await fetchTextChannel(interaction.client, boardId);

      let unlocks = 0;
      const lines: string[] = [];

      for (const row of await listAuthorSubmitCounts(interaction.guildId)) {
        const badgeResult = await awardArtShowBadges({
          guildId: interaction.guildId,
          userId: row.authorId,
          mode: "submit",
          count: row.count,
        });
        const fresh = badgeResult.results.filter(r => r.unlocked);
        if (fresh.length) {
          unlocks += fresh.length;
          await maybeAnnounceBadges(gallery, interaction.guildId, row.authorId, badgeResult, board);
          lines.push(
            `<@${row.authorId}> submit×${row.count} → ${fresh.map(r => r.badge.id).join(", ")}`,
          );
        }
      }

      for (const row of await listVoterCastCounts(interaction.guildId)) {
        const badgeResult = await awardArtShowBadges({
          guildId: interaction.guildId,
          userId: row.voterId,
          mode: "votes_cast",
          count: row.count,
        });
        const fresh = badgeResult.results.filter(r => r.unlocked);
        if (fresh.length) {
          unlocks += fresh.length;
          await maybeAnnounceBadges(gallery, interaction.guildId, row.voterId, badgeResult, board);
          lines.push(
            `<@${row.voterId}> votes×${row.count} → ${fresh.map(r => r.badge.id).join(", ")}`,
          );
        }
      }

      for (const row of await listAuthorPeakVotes(interaction.guildId)) {
        if (row.peak < 1) continue;
        const badgeResult = await awardArtShowBadges({
          guildId: interaction.guildId,
          userId: row.authorId,
          mode: "votes_received",
          count: row.peak,
        });
        const fresh = badgeResult.results.filter(r => r.unlocked);
        if (fresh.length) {
          unlocks += fresh.length;
          await maybeAnnounceBadges(gallery, interaction.guildId, row.authorId, badgeResult, board);
          lines.push(
            `<@${row.authorId}> peak▲${row.peak} → ${fresh.map(r => r.badge.id).join(", ")}`,
          );
        }
      }

      for (const row of await listAuthorCrownCounts(interaction.guildId)) {
        const badgeResult = await awardArtShowBadges({
          guildId: interaction.guildId,
          userId: row.authorId,
          mode: "crown",
          count: row.count,
        });
        const fresh = badgeResult.results.filter(r => r.unlocked);
        if (fresh.length) {
          unlocks += fresh.length;
          await maybeAnnounceBadges(gallery, interaction.guildId, row.authorId, badgeResult, board);
          lines.push(
            `<@${row.authorId}> crowns×${row.count} → ${fresh.map(r => r.badge.id).join(", ")}`,
          );
        }
      }

      await interaction.editReply([
        "**Art Show badge sync**",
        added.length
          ? `Catalogue merged: added \`${added.join("`, `")}\``
          : "Catalogue already had Art Show emblems.",
        `New unlocks: **${unlocks}**`,
        lines.length ? lines.slice(0, 20).join("\n") : "_No new unlocks — everyone already had what they earned._",
        "",
        "Members can confirm with `/badges`.",
      ].join("\n"));
    } catch (err) {
      logger.warn({ err }, "artshow sync_badges failed");
      await interaction.editReply(
        `❌ Sync failed: ${err instanceof Error ? err.message : "unknown error"}`,
      ).catch(() => {});
    }
    return;
  }

  if (sub === "repost") {
    if (!isStaff(interaction)) {
      await interaction.reply({ content: "Staff only.", ...EPHEMERAL });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      const channel = await resolveGalleryOrThrow(interaction.client, interaction.guildId);
      const pieceId = interaction.options.getInteger("piece_id");
      const missingOnly = interaction.options.getBoolean("missing_only") ?? true;
      const week = utcWeekKey();

      let targets: ArtshowPiece[] = [];
      if (pieceId != null) {
        const one = await getPiece(pieceId);
        if (!one || one.guildId !== interaction.guildId) {
          await interaction.editReply(`Piece \`#${pieceId}\` not found.`);
          return;
        }
        targets = [one];
      } else if (missingOnly) {
        targets = await listUnpostedPieces(interaction.guildId, { weekKey: week, limit: 25 });
      } else {
        targets = await topPieces(interaction.guildId, { weekKey: week, limit: 25 });
      }

      if (!targets.length) {
        await interaction.editReply(
          missingOnly
            ? "No unposted pieces this week — nothing to force-repost."
            : "No pieces this week to repost.",
        );
        return;
      }

      const lines: string[] = [];
      for (const piece of targets) {
        if (piece.messageId && missingOnly && pieceId == null) continue;
        if (piece.messageId) {
          await channel.messages.delete(piece.messageId).catch(() => {});
        }
        let artistName = piece.authorId;
        try {
          const u = await interaction.client.users.fetch(piece.authorId);
          artistName = u.username;
        } catch { /* keep */ }
        await sendPieceMessage({
          piece,
          channel,
          artistName,
          content: `🔁 **Force posted** — <@${piece.authorId}> · **${piece.title}**`,
          sourceHttpUrl: publicImageUrl(piece.imageUrl),
        });
        lines.push(`✅ \`#${piece.id}\` **${piece.title}**`);
      }
      await interaction.editReply(
        [`**Reposted to** <#${channel.id}>`, ...lines].join("\n"),
      );
    } catch (err) {
      logger.warn({ err }, "artshow repost failed");
      await interaction.editReply(
        `❌ Repost failed: ${err instanceof Error ? err.message : "unknown error"}`,
      ).catch(() => {});
    }
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
    try {
      await interaction.showModal(buildSubmitModal());
    } catch (err) {
      logger.warn({ err }, "artshow submit modal failed");
      await interaction.reply({
        content: "Couldn't open the uploader — try `/artshow submit` and attach your photo.",
        ...EPHEMERAL,
      }).catch(() => {});
    }
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
  const { files, imageName } = await buildGalleryFiles({
    title: piece.title,
    artistName,
    description: piece.description,
    imageUrl: piece.imageUrl,
    sourceHttpUrl: publicImageUrl(piece.imageUrl),
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
  else {
    const abs = publicImageUrl(piece.imageUrl);
    if (abs) embed.setImage(abs);
  }
  await interaction.editReply({ embeds: [embed], files });
}

/** Station **Submit art** → Discord file-picker modal. */
export async function handleArtShowModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.guildId || interaction.customId !== "artshow:submit_modal") return;

  const title = (interaction.fields.getTextInputValue("title") ?? "").trim();
  if (!title) {
    await interaction.reply({ content: "Title required.", ...EPHEMERAL });
    return;
  }

  const files = interaction.fields.getUploadedFiles("image", false);
  const attachment = files?.first();
  if (!attachment) {
    await interaction.reply({
      content: "No photo attached — tap **Submit art** again and pick a file from Discord’s uploader.",
      ...EPHEMERAL,
    });
    return;
  }
  if (!isImageAttachment(attachment)) {
    await interaction.reply({
      content: "That file isn’t an image. Upload a PNG, JPG, GIF, or WebP.",
      ...EPHEMERAL,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const channel = await resolveGalleryOrThrow(interaction.client, interaction.guildId);
    const ingested = await ingestUpload(attachment);
    const { piece, badgeResult } = await publishPiece({
      guildId: interaction.guildId,
      channel,
      authorId: interaction.user.id,
      authorName: interaction.user.username,
      title,
      description: "",
      storedUrl: ingested.storedUrl,
      sourceHttpUrl: ingested.sourceHttpUrl,
      originalBytes: ingested.bytes,
      orientation: ingested.orientation,
      client: interaction.client,
    });
    await interaction.editReply(
      `✅ Hung **${piece.title}** in <#${channel.id}> — piece \`#${piece.id}\`. Tap **▲ Upvote** there.`
      + badgeUnlockLine(badgeResult),
    );
    await followUpBadgeEmblem(interaction, badgeResult).catch(() => {});
  } catch (err) {
    logger.warn({ err }, "artshow modal submit failed");
    await interaction.editReply(
      `❌ Couldn't hang that photo: ${err instanceof Error ? err.message : "unknown error"}`,
    ).catch(() => {});
  }
}

/**
 * MessageCreate backup — photo dropped on the submission board → hang in gallery.
 * Primary path is the **Submit art** Discord file-picker modal.
 */
export async function handleArtShowMessage(msg: Message): Promise<boolean> {
  if (!msg.guildId || msg.author.bot) return false;

  const attMeta = extractImageAttachment(msg);
  if (!attMeta) return false;

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

  const discordAtt = msg.attachments.find(a => a.url === attMeta.url) ?? msg.attachments.first();
  if (!discordAtt) return false;

  try {
    await msg.react("⏳").catch(() => {});
    const ingested = await ingestUpload(discordAtt);
    const title = titleFromDrop(msg.content, attMeta.name);
    const description = msg.content.trim().includes("\n")
      ? msg.content.trim().split("\n").slice(1).join("\n").trim().slice(0, 400)
      : "";

    const { piece, badgeResult } = await publishPiece({
      guildId: msg.guildId,
      channel: gallery,
      authorId: msg.author.id,
      authorName: msg.author.username,
      title,
      description,
      storedUrl: ingested.storedUrl,
      sourceHttpUrl: ingested.sourceHttpUrl,
      originalBytes: ingested.bytes,
      orientation: ingested.orientation,
      client: msg.client,
    });

    await msg.delete().catch(() => {});
    const badgeBit = badgeUnlockLine(badgeResult).replace(/^\n/, " · ");
    const ack = await msg.channel.isTextBased() && !msg.channel.isDMBased()
      ? await (msg.channel as TextChannel).send({
        content: `✅ <@${msg.author.id}> hung **${piece.title}** in <#${gallery.id}>${badgeBit}`,
      }).catch(() => null)
      : null;
    if (ack) setTimeout(() => { ack.delete().catch(() => {}); }, 12_000);
  } catch (err) {
    logger.warn({ err }, "artshow board drop failed");
    await msg.react("❌").catch(() => {});
    await msg.reply({
      content: `Couldn't hang that photo (${err instanceof Error ? err.message : "error"}). Tap **Submit art** on the station instead.`,
    }).catch(() => {});
  }
  return true;
}
