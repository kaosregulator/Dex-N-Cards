/**
 * Community Art Show — simple loop:
 *
 *  1. Staff: `/artshow setup` → creates board + gallery, posts Submit station
 *  2. Members: tap Submit → popup (title, description, photo)
 *  3. Piece posts to gallery with original photo + ▲ / Remove / Bump
 *  4. Staff: `/artshow crown` → winner announced on the BOARD with emblem
 *  5. New week → more submits → repeat
 */

import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder,
  AttachmentBuilder, PermissionFlagsBits, MessageFlags,
  ModalBuilder, LabelBuilder, FileUploadBuilder,
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
  getOrCreateArtshowSettings, updateArtshowSettings,
  insertPiece, setPieceMessage, getPiece, topPieces, listUnpostedPieces,
  getOrRefreshWallet, grantSubmitBonus, spendVote, removeVote, spendBump, grantFreeBump,
  countAuthorSubmits, countVotesCast, countAuthorCrowns,
  listAuthorSubmitCounts, listVoterCastCounts, listAuthorPeakVotes, listAuthorCrownCounts,
  crownPiece, getFame, listFame, utcWeekKey, piecePhotos,
} from "../../lib/artshow/db.js";
import { mergeMissingDefaultBadgeRules } from "../../lib/badges/db.js";
import type { ArtshowPiece, ArtshowSettings } from "@workspace/db";
import { awardArtShowBadges } from "../badges/engine.js";
import { buildBadgeShowcase } from "../badges/announce.js";
import { detectOrientation } from "./render-hall.js";
import { renderMuseumGif } from "./render-museum.js";
import { renderPieceCardPng } from "./render-piece-card.js";
import { loadArtBuffer } from "../animations/effects.js";
import { ARTSHOW_STAFF_PERMS } from "./definition.js";

const EPHEMERAL = { ephemeral: true } as const;
const BRAND = 0xc4a574;
/** Discord file-upload + practical attach limit */
const MAX_PHOTOS = 10;
/** Badge board flashes from /artshow fix (and normal unlocks) auto-delete after this. */
const BADGE_ANNOUNCE_CLEANUP_MS = 40_000;

/**
 * Discord button/select emoji.name rejects geometric symbols (▲) and often
 * variation selectors (U+FE0F). Strip VS; callers should pass real pictographs.
 */
function buttonEmoji(raw: string): string {
  return raw.replace(/[\uFE00-\uFE0F]/g, "").trim();
}

function isStaff(interaction: { memberPermissions?: { has: (p: bigint) => boolean } | null }): boolean {
  return Boolean(interaction.memberPermissions?.has(ARTSHOW_STAFF_PERMS)
    || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

function channelIds(settings: ArtshowSettings): {
  boardId: string | null;
  galleryId: string | null;
} {
  return {
    boardId: settings.boardChannelId ?? settings.channelId ?? null,
    galleryId: settings.galleryChannelId ?? settings.channelId ?? null,
  };
}

/**
 * Button emojis must be Discord-valid unicode (or custom emoji ids).
 * Geometric symbols like ▲ throw COMPONENT_INVALID_EMOJI and block the whole send.
 */
function pieceButtons(pieceId: number, photoCount = 1) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`artshow:vote:${pieceId}`)
      .setLabel("Upvote")
      // Use a real pictograph — geometric ▲ / bare ⬆ throw COMPONENT_INVALID_EMOJI.
      .setEmoji(buttonEmoji("🔺"))
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`artshow:unvote:${pieceId}`)
      .setLabel("Remove vote")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`artshow:bump:${pieceId}`)
      .setLabel("Bump me")
      .setEmoji(buttonEmoji("📌"))
      .setStyle(ButtonStyle.Secondary),
  );
  if (photoCount > 1) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`artshow:photos:${pieceId}:0`)
        .setLabel("View photos")
        .setEmoji(buttonEmoji("📷"))
        .setStyle(ButtonStyle.Primary),
    );
  }
  return [row];
}

function stationButtons() {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("artshow:submit")
        .setLabel("Submit")
        .setEmoji(buttonEmoji("📷"))
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("artshow:votes")
        .setLabel("My votes")
        .setEmoji(buttonEmoji("🎫"))
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("artshow:week")
        .setLabel("This week")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

/** Title + description + Discord file picker. */
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
        .setLabel("Description")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("description")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(400)
            .setPlaceholder("Optional — materials, story, anything…"),
        ),
      new LabelBuilder()
        .setLabel("Photos")
        .setDescription(`Pick 1–${MAX_PHOTOS} photos — still one post`)
        .setFileUploadComponent(
          new FileUploadBuilder()
            .setCustomId("image")
            .setRequired(true)
            .setMinValues(1)
            .setMaxValues(MAX_PHOTOS),
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

function publicImageUrl(stored: string | null | undefined): string | null {
  if (!stored) return null;
  return toAbsoluteImageUrl(stored) ?? (/^https?:\/\//i.test(stored) ? stored : null);
}

function guessImageExt(url: string, contentType?: string | null): string {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("png") || url.includes(".png")) return "png";
  if (ct.includes("gif") || url.includes(".gif")) return "gif";
  if (ct.includes("webp") || url.includes(".webp")) return "webp";
  return "jpg";
}

/** Load image bytes — prefers GCS `/objects/…` direct download, then HTTP. */
async function fetchImageBytes(url: string): Promise<{ buf: Buffer; contentType: string; ext: string } | null> {
  try {
    // loadArtBuffer handles /objects/… and /api/storage/objects/… without needing PUBLIC_BASE_URL.
    const fromStorage = await loadArtBuffer(url);
    if (fromStorage?.length && fromStorage.length <= 12 * 1024 * 1024) {
      const ext = guessImageExt(url);
      const contentType = ext === "png" ? "image/png"
        : ext === "gif" ? "image/gif"
        : ext === "webp" ? "image/webp"
        : "image/jpeg";
      return { buf: fromStorage, contentType, ext };
    }
  } catch {
    // fall through to HTTP
  }
  try {
    if (!/^https?:\/\//i.test(url)) return null;
    const resp = await fetch(url, { signal: AbortSignal.timeout(25_000) });
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length || buf.length > 12 * 1024 * 1024) return null;
    const ct = resp.headers.get("content-type") ?? "image/jpeg";
    return { buf, contentType: ct, ext: guessImageExt(url, ct) };
  } catch {
    return null;
  }
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
    if (me) await channel.permissionOverwrites.edit(me.id, STAFF_GALLERY_ALLOW);
    for (const role of guild.roles.cache.values()) {
      if (role.id === guild.id) continue;
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
    logger.warn({ err, channelId: channel.id }, "artshow gallery readonly failed");
  }
}

async function applyBoardPerms(channel: GuildChannel, guild: Guild): Promise<void> {
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

async function buildStationEmbed(guildId: string): Promise<EmbedBuilder> {
  const settings = await getOrCreateArtshowSettings(guildId);
  const week = utcWeekKey();
  const leaders = await topPieces(guildId, { weekKey: week, limit: 3 });
  const fame = await getFame(guildId, week);
  const { galleryId } = channelIds(settings);

  const lines = [
    "Tap **Submit** → add a title, optional description, and your photo.",
    galleryId
      ? `Your piece posts in <#${galleryId}> for ▲ votes.`
      : "Gallery channel is not set yet.",
    "",
    `You get **${settings.votesPerDay}** votes / day.`,
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
    lines.push("", `🏆 **This week's champion:** **${fame.title}** by <@${fame.authorId}>`);
  }

  return new EmbedBuilder()
    .setColor(BRAND)
    .setTitle("🎨 Community Art Show")
    .setDescription(lines.join("\n"))
    .setFooter({ text: `Week ${week} · winner announced here` });
}

async function maybeAnnounceBadges(
  channel: { send: (o: object) => Promise<unknown> } | null | undefined,
  guildId: string,
  userId: string,
  badgeResult: Awaited<ReturnType<typeof awardArtShowBadges>>,
  opts?: { cleanupMs?: number },
): Promise<void> {
  const flashy = badgeResult.results.filter(r => r.unlocked || r.leveled || r.tierChanged);
  const cleanupMs = opts?.cleanupMs ?? BADGE_ANNOUNCE_CLEANUP_MS;
  for (const result of flashy) {
    const rule = badgeResult.rules.find(r => r.id === result.badge.id);
    if (!rule || !channel) continue;
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
      // Crown emblems stay; everything else cleans up (default 40s — matches /artshow fix).
      const keep = result.badge.id === "art_champion" || result.badge.id === "art_legend";
      if (!keep && cleanupMs > 0) {
        setTimeout(() => { msg.delete().catch(() => {}); }, cleanupMs);
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
  return `\n✨ Emblem unlocked: ${labels.join(", ")}`;
}

async function followUpBadgeEmblem(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
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
  } catch {
    storedUrl = sourceHttpUrl;
  }
  const orientation = await detectOrientation(publicImageUrl(storedUrl) ?? sourceHttpUrl);
  return {
    storedUrl,
    sourceHttpUrl,
    bytes: bytes ? { buf: bytes.buf, ext: bytes.ext } : null,
    orientation,
  };
}

async function ingestUploads(atts: Attachment[]): Promise<{
  storedUrls: string[];
  sourceHttpUrls: string[];
  bytesList: Array<{ buf: Buffer; ext: string }>;
  orientation: "landscape" | "portrait" | "square";
}> {
  const storedUrls: string[] = [];
  const sourceHttpUrls: string[] = [];
  const bytesList: Array<{ buf: Buffer; ext: string }> = [];
  for (const att of atts.slice(0, MAX_PHOTOS)) {
    if (!isImageAttachment(att)) continue;
    const one = await ingestUpload(att);
    storedUrls.push(one.storedUrl);
    sourceHttpUrls.push(one.sourceHttpUrl);
    if (one.bytes) bytesList.push(one.bytes);
  }
  if (!storedUrls.length) throw new Error("No image files found in the upload.");
  const orientation = await detectOrientation(
    publicImageUrl(storedUrls[0]!) ?? sourceHttpUrls[0]!,
  );
  return { storedUrls, sourceHttpUrls, bytesList, orientation };
}

/**
 * One loadable URL per photo. Prefer `/objects/…` so GCS direct load works
 * without depending on PUBLIC_BASE_URL; otherwise use an absolute HTTP URL.
 */
function loadablePhotoUrls(piece: ArtshowPiece, extras?: string[]): string[] {
  const raw = extras?.length ? extras : piecePhotos(piece);
  const out: string[] = [];
  for (const u of raw) {
    if (!u) continue;
    if (u.startsWith("/objects/")) {
      out.push(u);
      continue;
    }
    const abs = publicImageUrl(u);
    if (abs) out.push(abs);
    else if (/^https?:\/\//i.test(u)) out.push(u);
  }
  return out;
}

function pieceEmbed(piece: ArtshowPiece, photoCount: number): EmbedBuilder {
  const photoNote = photoCount > 1
    ? ` · **${photoCount} photos** — tap **View photos**`
    : "";
  return new EmbedBuilder()
    .setColor(0xe8c87a)
    .setTitle(piece.title)
    .setDescription([
      `by <@${piece.authorId}>`,
      piece.description ? `*${piece.description}*` : null,
      "",
      `**🔺 ${piece.votes}** votes${photoNote}`,
    ].filter(Boolean).join("\n"))
    .setFooter({ text: `Piece #${piece.id} · ${piece.weekKey}` });
}

/** Clean gold-card canvas (letterboxed photos) + vote buttons. Hardened fallbacks. */
async function sendPieceMessage(opts: {
  piece: ArtshowPiece;
  channel: TextChannel | NewsChannel;
  artistName?: string;
  content: string;
  sourceHttpUrls?: string[];
  originalBytesList?: Array<{ buf: Buffer; ext: string }>;
}): Promise<Message> {
  const photos = piecePhotos(opts.piece);
  const loadUrls = loadablePhotoUrls(opts.piece, opts.sourceHttpUrls);
  const artistName = opts.artistName ?? opts.piece.authorId;
  const n = photos.length || 1;

  const files: AttachmentBuilder[] = [];
  let imageName: string | null = null;

  try {
    const card = await renderPieceCardPng({
      title: opts.piece.title,
      artistName,
      description: opts.piece.description,
      imageUrls: loadUrls.length ? loadUrls : photos,
      votes: opts.piece.votes,
    });
    if (card && card.length > 0 && card.length < 7_500_000) {
      imageName = "piece-card.png";
      files.push(new AttachmentBuilder(card, { name: imageName }));
    }
  } catch (err) {
    logger.warn({ err, pieceId: opts.piece.id }, "artshow piece card render threw");
  }

  if (!files.length && opts.originalBytesList?.[0]?.buf?.length) {
    const b = opts.originalBytesList[0];
    imageName = `art.${b.ext || "jpg"}`;
    files.push(new AttachmentBuilder(b.buf, { name: imageName }));
  }
  if (!files.length && loadUrls[0]) {
    const downloaded = await fetchImageBytes(loadUrls[0]);
    if (downloaded) {
      imageName = `art.${downloaded.ext}`;
      files.push(new AttachmentBuilder(downloaded.buf, { name: imageName }));
    }
  }

  const embed = pieceEmbed(opts.piece, n);
  if (imageName) embed.setImage(`attachment://${imageName}`);
  else {
    const abs = loadUrls[0] ?? publicImageUrl(opts.piece.imageUrl);
    if (abs) embed.setImage(abs);
  }

  const components = pieceButtons(opts.piece.id, n);
  try {
    const sent = await opts.channel.send({
      content: opts.content,
      embeds: [embed],
      files,
      components,
    });
    await setPieceMessage(opts.piece.id, sent.id);
    return sent;
  } catch (err) {
    logger.warn({ err, pieceId: opts.piece.id }, "artshow rich hang failed — retrying simpler");
  }

  // Retry 1: original photo only, no canvas, still with buttons
  try {
    const simpleFiles: AttachmentBuilder[] = [];
    let simpleName: string | null = null;
    if (opts.originalBytesList?.[0]?.buf?.length) {
      simpleName = `art.${opts.originalBytesList[0].ext || "jpg"}`;
      simpleFiles.push(new AttachmentBuilder(opts.originalBytesList[0].buf, { name: simpleName }));
    } else if (loadUrls[0]) {
      const dl = await fetchImageBytes(loadUrls[0]);
      if (dl) {
        simpleName = `art.${dl.ext}`;
        simpleFiles.push(new AttachmentBuilder(dl.buf, { name: simpleName }));
      }
    }
    const simple = pieceEmbed(opts.piece, n);
    if (simpleName) simple.setImage(`attachment://${simpleName}`);
    else {
      const abs = loadUrls[0] ?? publicImageUrl(opts.piece.imageUrl);
      if (abs) simple.setImage(abs);
    }
    const sent = await opts.channel.send({
      content: opts.content,
      embeds: [simple],
      files: simpleFiles,
      components,
    });
    await setPieceMessage(opts.piece.id, sent.id);
    return sent;
  } catch (err) {
    logger.warn({ err, pieceId: opts.piece.id }, "artshow simple hang failed — last resort");
  }

  // Retry 2: no emoji buttons (label-only) in case emoji still rejects
  const plainButtons = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`artshow:vote:${opts.piece.id}`)
        .setLabel("Upvote")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`artshow:unvote:${opts.piece.id}`)
        .setLabel("Remove vote")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`artshow:bump:${opts.piece.id}`)
        .setLabel("Bump me")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
  const bare = pieceEmbed(opts.piece, n);
  const abs = loadUrls[0] ?? publicImageUrl(opts.piece.imageUrl);
  if (abs) bare.setImage(abs);
  const sent = await opts.channel.send({
    content: opts.content,
    embeds: [bare],
    components: plainButtons,
  });
  await setPieceMessage(opts.piece.id, sent.id);
  return sent;
}

async function publishPiece(opts: {
  guildId: string;
  gallery: TextChannel | NewsChannel;
  board: TextChannel | NewsChannel | null;
  authorId: string;
  authorName: string;
  title: string;
  description: string;
  storedUrls: string[];
  sourceHttpUrls: string[];
  originalBytesList?: Array<{ buf: Buffer; ext: string }>;
  orientation?: "landscape" | "portrait" | "square";
}): Promise<{
  piece: ArtshowPiece;
  badgeResult: Awaited<ReturnType<typeof awardArtShowBadges>>;
}> {
  const urls = opts.storedUrls.slice(0, MAX_PHOTOS);
  const orientation = opts.orientation
    ?? await detectOrientation(opts.sourceHttpUrls[0] || urls[0]!);
  const piece = await insertPiece({
    guildId: opts.guildId,
    authorId: opts.authorId,
    title: opts.title,
    description: opts.description,
    imageUrl: urls[0]!,
    imageUrls: urls,
    orientation,
    channelId: opts.gallery.id,
  });

  await sendPieceMessage({
    piece,
    channel: opts.gallery,
    artistName: opts.authorName,
    content: `✨ <@${opts.authorId}> submitted **${piece.title}**`,
    sourceHttpUrls: opts.sourceHttpUrls,
    originalBytesList: opts.originalBytesList,
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
  await maybeAnnounceBadges(opts.board ?? opts.gallery, opts.guildId, opts.authorId, badgeResult);
  return { piece, badgeResult };
}

async function updatePieceEmbedVotes(message: Message, piece: ArtshowPiece): Promise<void> {
  try {
    const n = piecePhotos(piece).length;
    const photoNote = n > 1 ? ` · **${n} photos** — tap **View photos**` : "";
    const embed = EmbedBuilder.from(message.embeds[0] ?? new EmbedBuilder())
      .setDescription([
        `by <@${piece.authorId}>`,
        piece.description ? `*${piece.description}*` : null,
        "",
        `**🔺 ${piece.votes}** votes${photoNote}`,
      ].filter(Boolean).join("\n"));
    await message.edit({ embeds: [embed], components: pieceButtons(piece.id, n) });
  } catch { /* ignore */ }
}

async function replyPhotoViewer(
  interaction: ButtonInteraction,
  piece: ArtshowPiece,
  page: number,
): Promise<void> {
  const photos = loadablePhotoUrls(piece);
  if (!photos.length) {
    const msg = "No photos stored for this piece.";
    if (interaction.deferred || interaction.replied) await interaction.editReply(msg);
    else await interaction.reply({ content: msg, ...EPHEMERAL });
    return;
  }
  const safe = ((page % photos.length) + photos.length) % photos.length;
  const url = photos[safe]!;
  const downloaded = await fetchImageBytes(url);
  const files: AttachmentBuilder[] = [];
  let name = "photo.jpg";
  if (downloaded) {
    name = `photo-${safe + 1}.${downloaded.ext}`;
    files.push(new AttachmentBuilder(downloaded.buf, { name }));
  }

  const embed = new EmbedBuilder()
    .setColor(0xe8c87a)
    .setTitle(piece.title)
    .setDescription(`Photo **${safe + 1}** of **${photos.length}** · by <@${piece.authorId}>`)
    .setFooter({ text: "Only you can see this" });
  if (files.length) embed.setImage(`attachment://${name}`);
  else {
    const abs = publicImageUrl(url) ?? (/^https?:\/\//i.test(url) ? url : null);
    if (abs) embed.setImage(abs);
  }

  const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`artshow:photos:${piece.id}:${safe - 1}`)
      .setLabel("Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(photos.length <= 1),
    new ButtonBuilder()
      .setCustomId(`artshow:photos:${piece.id}:${safe + 1}`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(photos.length <= 1),
  );

  const payload = { embeds: [embed], files, components: [nav] };
  if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
  else await interaction.reply({ ...payload, ...EPHEMERAL });
}

/** Give the existing Discord champion role to the winner; strip it from others. */
async function assignChampionRole(
  guild: Guild | null | undefined,
  roleId: string | null | undefined,
  winnerId: string,
): Promise<void> {
  if (!guild || !roleId) return;
  const role = await guild.roles.fetch(roleId).catch(() => null);
  if (!role) {
    logger.warn({ roleId, guildId: guild.id }, "artshow champion role missing");
    return;
  }
  try {
    await guild.members.fetch();
  } catch { /* cache may be partial — still try */ }

  for (const member of role.members.values()) {
    if (member.id === winnerId) continue;
    await member.roles.remove(role, "Art Show champion transferred").catch(() => {});
  }

  const winner = await guild.members.fetch(winnerId).catch(() => null);
  if (!winner) return;
  if (!winner.roles.cache.has(role.id)) {
    await winner.roles.add(role, "Art Show weekly champion").catch(err => {
      logger.warn({ err, winnerId, roleId }, "artshow champion role add failed — check role hierarchy");
    });
  }
}

async function announceChampion(opts: {
  guildId: string;
  piece: ArtshowPiece;
  board: TextChannel | NewsChannel;
  gallery?: TextChannel | NewsChannel | null;
  guild?: Guild | null;
  championRoleId?: string | null;
  reason: string;
  /** Same person as last week (or no new challenger) — post “still undefeated”. */
  undefeated?: boolean;
  weekKey?: string;
}): Promise<void> {
  const weekKey = opts.weekKey ?? utcWeekKey();
  const fame = await crownPiece({
    guildId: opts.guildId,
    piece: opts.piece,
    weekKey,
  });
  const crowns = await countAuthorCrowns(opts.guildId, opts.piece.authorId);
  const badgeResult = await awardArtShowBadges({
    guildId: opts.guildId,
    userId: opts.piece.authorId,
    mode: "crown",
    count: crowns,
  });

  await assignChampionRole(opts.guild, opts.championRoleId, fame.authorId);

  const undefeated = Boolean(opts.undefeated);
  const files: AttachmentBuilder[] = [];
  const embed = new EmbedBuilder()
    .setColor(0xffe66d)
    .setTitle(undefeated ? "👑 Still Undefeated" : "🏆 Weekly Art Show Champion")
    .setDescription(
      undefeated
        ? [
          `**<@${fame.authorId}>** is **still undefeated**`,
          `Holding the crown with **${fame.title}**`,
          `**▲ ${fame.votesAtCrown}** · ${opts.reason}`,
          "",
          "Think you can take the title? Tap **Submit** and earn ▲ votes.",
        ].join("\n")
        : [
          `**<@${fame.authorId}>** wins the week with **${fame.title}**`,
          `**▲ ${fame.votesAtCrown}** votes · ${opts.reason}`,
          "",
          "Voting for this week is locked. New week — keep submitting!",
        ].join("\n"),
    );

  // Always prefer the original winner photo so the board stays alive and clear.
  const photo = await fetchImageBytes(publicImageUrl(fame.imageUrl) ?? fame.imageUrl);
  if (photo) {
    files.push(new AttachmentBuilder(photo.buf, { name: `champion.${photo.ext}` }));
    embed.setImage(`attachment://champion.${photo.ext}`);
  } else {
    const museum = await renderMuseumGif({
      championTitle: fame.title,
      championArtist: fame.authorId,
      championImageUrl: publicImageUrl(fame.imageUrl) ?? fame.imageUrl,
      votes: fame.votesAtCrown,
      weekLabel: `Week ${fame.weekKey}`,
    }).catch(() => null);
    if (museum) {
      files.push(new AttachmentBuilder(museum, { name: "museum.gif" }));
      embed.setImage("attachment://museum.gif");
    } else {
      const abs = publicImageUrl(fame.imageUrl);
      if (abs) embed.setImage(abs);
    }
  }

  await opts.board.send({
    content: undefeated
      ? `👑 <@${fame.authorId}> is **still undefeated** — who will challenge them?`
      : `🏆 <@${fame.authorId}> is this week's Art Show champion!`,
    embeds: [embed],
    files,
  });
  await maybeAnnounceBadges(opts.board, opts.guildId, opts.piece.authorId, badgeResult);

  if (opts.gallery && opts.gallery.id !== opts.board.id) {
    await opts.gallery.send({
      content: undefeated
        ? `👑 Still undefeated — **${fame.title}** by <@${fame.authorId}>`
        : `🏆 Champion crowned on the board — **${fame.title}** by <@${fame.authorId}> (**▲ ${fame.votesAtCrown}**)`,
    }).catch(() => {});
  }
}

async function tryAutoCrown(
  guildId: string,
  piece: ArtshowPiece,
  settings: ArtshowSettings,
  client: { channels: { fetch: (id: string) => Promise<unknown> } },
): Promise<void> {
  if (settings.crownThreshold <= 0) return;
  if (piece.votes < settings.crownThreshold) return;
  const existing = await getFame(guildId, piece.weekKey);
  if (existing) return;

  const { boardId, galleryId } = channelIds(settings);
  const board = await fetchTextChannel(client, boardId);
  if (!board) return;
  const gallery = await fetchTextChannel(client, galleryId);
  const lastFame = (await listFame(guildId, 1))[0] ?? null;
  const undefeated = Boolean(lastFame && lastFame.authorId === piece.authorId);
  const guild = board.guild as Guild;
  await announceChampion({
    guildId,
    piece,
    board,
    gallery,
    guild,
    championRoleId: settings.championRoleId,
    reason: `first to **${settings.crownThreshold} ▲**`,
    undefeated,
  });
}

async function resolveOrCreateChannel(
  interaction: ChatInputCommandInteraction,
  opts: {
    existing: { id: string } | null;
    createName: string;
    topic: string;
    kind: "board" | "gallery";
    staffRoleId?: string | null;
  },
): Promise<TextChannel | NewsChannel> {
  if (opts.existing && interaction.guild) {
    const ch = await fetchTextChannel(interaction.client, opts.existing.id);
    if (!ch) throw new Error(`Couldn't open the ${opts.kind} channel.`);
    if (opts.kind === "gallery") {
      await applyGalleryReadonly(ch as GuildChannel, interaction.guild, opts.staffRoleId);
    } else {
      await applyBoardPerms(ch as GuildChannel, interaction.guild);
    }
    return ch;
  }

  if (!interaction.guild) throw new Error("Server only.");
  const created = await interaction.guild.channels.create({
    name: slugChannelName(opts.createName),
    type: ChannelType.GuildText,
    topic: opts.topic,
    reason: `Art Show ${opts.kind} by ${interaction.user.tag}`,
  });
  if (opts.kind === "gallery") {
    await applyGalleryReadonly(created, interaction.guild, opts.staffRoleId);
  } else {
    await applyBoardPerms(created, interaction.guild);
  }
  return created as TextChannel;
}

async function runSetup(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isStaff(interaction)) {
    await interaction.reply({ content: "Staff only (`Manage Server`).", ...EPHEMERAL });
    return;
  }
  await interaction.deferReply({ ephemeral: true });

  const staffRole = interaction.options.getRole("staff_role");
  const championRole = interaction.options.getRole("champion_role");
  const prior = await getOrCreateArtshowSettings(interaction.guildId!);
  const staffRoleId = staffRole?.id ?? prior.staffRoleId ?? null;
  const championRoleId = championRole?.id ?? prior.championRoleId ?? null;

  const boardOpt = interaction.options.getChannel("board");
  const galleryOpt = interaction.options.getChannel("gallery");
  const boardName = interaction.options.getString("board_name")?.trim() || "art-show";
  const galleryName = interaction.options.getString("gallery_name")?.trim() || "art-gallery";

  const board = await resolveOrCreateChannel(interaction, {
    existing: boardOpt ? { id: boardOpt.id } : null,
    createName: boardName,
    topic: "Art Show — tap Submit to enter your photo",
    kind: "board",
    staffRoleId,
  });
  const gallery = await resolveOrCreateChannel(interaction, {
    existing: galleryOpt ? { id: galleryOpt.id } : null,
    createName: galleryName,
    topic: "Art Show gallery — vote with ▲ (read-only)",
    kind: "gallery",
    staffRoleId,
  });

  if (board.id === gallery.id) {
    await interaction.editReply("Board and gallery must be **two different** channels.");
    return;
  }

  await mergeMissingDefaultBadgeRules(interaction.guildId!);
  await updateArtshowSettings(interaction.guildId!, {
    boardChannelId: board.id,
    galleryChannelId: gallery.id,
    channelId: gallery.id,
    stickyMessageId: null,
    staffRoleId,
    championRoleId,
    enabled: true,
  });

  const embed = await buildStationEmbed(interaction.guildId!);
  const sent = await board.send({
    embeds: [embed],
    components: stationButtons(),
  });
  await updateArtshowSettings(interaction.guildId!, { stationMessageId: sent.id });
  await sent.pin().catch(() => {});

  await interaction.editReply([
    "✅ Art Show is ready.",
    `· **Board** <#${board.id}> — people tap **Submit** here`,
    `· **Gallery** <#${gallery.id}> — photos + ▲ votes (read-only)`,
    championRoleId
      ? `· **Champion role** <@&${championRoleId}> — given on \`/artshow crown\` (kept if still undefeated)`
      : "· **Champion role** — not set (pass `champion_role` on setup to use your existing winner role)",
    "",
    "Members just tap **Submit**. Staff: `/artshow crown` ends the week.",
  ].join("\n"));
}

async function runFix(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isStaff(interaction)) {
    await interaction.reply({ content: "Staff only.", ...EPHEMERAL });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const guildId = interaction.guildId!;
  const { added } = await mergeMissingDefaultBadgeRules(guildId);
  const settings = await getOrCreateArtshowSettings(guildId);
  const { galleryId, boardId } = channelIds(settings);
  const gallery = await fetchTextChannel(interaction.client, galleryId);
  const board = await fetchTextChannel(interaction.client, boardId);

  let unlocks = 0;
  const announceOpts = { cleanupMs: BADGE_ANNOUNCE_CLEANUP_MS };
  for (const row of await listAuthorSubmitCounts(guildId)) {
    const badgeResult = await awardArtShowBadges({
      guildId, userId: row.authorId, mode: "submit", count: row.count,
    });
    const fresh = badgeResult.results.filter(r => r.unlocked);
    if (fresh.length) {
      unlocks += fresh.length;
      await maybeAnnounceBadges(board, guildId, row.authorId, badgeResult, announceOpts);
    }
  }
  for (const row of await listVoterCastCounts(guildId)) {
    const badgeResult = await awardArtShowBadges({
      guildId, userId: row.voterId, mode: "votes_cast", count: row.count,
    });
    unlocks += badgeResult.results.filter(r => r.unlocked).length;
  }
  for (const row of await listAuthorPeakVotes(guildId)) {
    if (row.peak < 1) continue;
    const badgeResult = await awardArtShowBadges({
      guildId, userId: row.authorId, mode: "votes_received", count: row.peak,
    });
    const fresh = badgeResult.results.filter(r => r.unlocked);
    if (fresh.length) {
      unlocks += fresh.length;
      await maybeAnnounceBadges(board, guildId, row.authorId, badgeResult, announceOpts);
    }
  }
  for (const row of await listAuthorCrownCounts(guildId)) {
    const badgeResult = await awardArtShowBadges({
      guildId, userId: row.authorId, mode: "crown", count: row.count,
    });
    unlocks += badgeResult.results.filter(r => r.unlocked).length;
  }

  let reposted = 0;
  let repostFailed = 0;
  if (gallery) {
    // All weeks — failed hangs from earlier weeks still need to land in gallery.
    const missing = await listUnpostedPieces(guildId, { limit: 50 });
    for (const piece of missing) {
      try {
        await sendPieceMessage({
          piece,
          channel: gallery,
          content: `🔁 <@${piece.authorId}> · **${piece.title}**`,
          sourceHttpUrls: loadablePhotoUrls(piece),
        });
        reposted++;
      } catch (err) {
        repostFailed++;
        logger.warn({ err, pieceId: piece.id }, "artshow fix: failed to hang missing piece");
      }
    }
  } else {
    logger.warn({ guildId, galleryId }, "artshow fix: gallery channel missing");
  }

  await interaction.editReply([
    "**Art Show fix**",
    added.length ? `Catalogue added: \`${added.join("`, `")}\`` : "Catalogue ok.",
    `Emblem unlocks granted: **${unlocks}** (board notices clean up in ~40s)`,
    gallery
      ? `Missing gallery posts forced: **${reposted}**${repostFailed ? ` · failed: **${repostFailed}**` : ""}`
      : "Gallery channel missing — run `/artshow setup`.",
  ].join("\n"));
}

async function runCrown(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isStaff(interaction)) {
    await interaction.reply({ content: "Staff only.", ...EPHEMERAL });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const guildId = interaction.guildId!;
  const week = utcWeekKey();
  const existing = await getFame(guildId, week);
  if (existing) {
    await interaction.editReply(`Already crowned this week: **${existing.title}** by <@${existing.authorId}>.`);
    return;
  }

  const settings = await getOrCreateArtshowSettings(guildId);
  const { boardId, galleryId } = channelIds(settings);
  const board = await fetchTextChannel(interaction.client, boardId);
  if (!board) {
    await interaction.editReply("Board channel missing — run `/artshow setup` first.");
    return;
  }
  const gallery = await fetchTextChannel(interaction.client, galleryId);
  const lastFame = (await listFame(guildId, 1))[0] ?? null;

  const pieceId = interaction.options.getInteger("piece_id");
  let piece = pieceId != null ? await getPiece(pieceId) : null;
  if (!piece) {
    const top = await topPieces(guildId, { weekKey: week, limit: 1 });
    piece = top[0] ?? null;
  }

  let undefeated = false;
  let reason = "staff crown";

  if (!piece || piece.guildId !== guildId) {
    // No new winner this week — keep the last champion alive on the board.
    if (!lastFame) {
      await interaction.editReply("No piece to crown and no previous champion to keep undefeated.");
      return;
    }
    piece = await getPiece(lastFame.pieceId);
    if (!piece) {
      // Piece row gone — rebuild a minimal record from fame for the announce/crown.
      piece = {
        id: lastFame.pieceId,
        guildId,
        authorId: lastFame.authorId,
        title: lastFame.title,
        description: "",
        imageUrl: lastFame.imageUrl,
        imageUrls: [lastFame.imageUrl],
        orientation: "landscape",
        channelId: galleryId ?? boardId ?? "",
        messageId: null,
        votes: lastFame.votesAtCrown,
        weekKey: week,
        bumpedAt: null,
        featuredUntil: null,
        createdAt: lastFame.crownedAt,
        updatedAt: lastFame.crownedAt,
      };
    }
    undefeated = true;
    reason = "no new challenger this week";
  } else if (lastFame && lastFame.authorId === piece.authorId) {
    undefeated = true;
    reason = "defended the crown";
  }

  const crowned = piece!;
  await announceChampion({
    guildId,
    piece: crowned,
    board,
    gallery,
    guild: interaction.guild,
    championRoleId: settings.championRoleId,
    reason,
    undefeated,
    weekKey: week,
  });
  await interaction.editReply(
    undefeated
      ? `👑 **Still undefeated** — <@${crowned.authorId}> · **${crowned.title}** posted in <#${board.id}>.`
      : `🏆 Crowned **${crowned.title}** by <@${crowned.authorId}> — announced in <#${board.id}>.`,
  );
}

// ── Slash ────────────────────────────────────────────────────────────────────

export async function handleArtShowCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "Server only.", ...EPHEMERAL });
    return;
  }
  const sub = interaction.options.getSubcommand();
  if (sub === "setup" || sub === "post") {
    await runSetup(interaction);
    return;
  }
  if (sub === "crown") {
    await runCrown(interaction);
    return;
  }
  if (sub === "fix") {
    await runFix(interaction);
    return;
  }
  await interaction.reply({
    content: "Use `/artshow setup`, `/artshow crown`, or `/artshow fix`. Members just tap **Submit** on the board.",
    ...EPHEMERAL,
  });
}

// ── Buttons ──────────────────────────────────────────────────────────────────

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
        content: "Couldn't open the submit form — try again in a moment.",
        ...EPHEMERAL,
      }).catch(() => {});
    }
    return;
  }

  if (id === "artshow:votes") {
    await interaction.deferReply({ ephemeral: true });
    const settings = await getOrCreateArtshowSettings(interaction.guildId);
    const wallet = await getOrRefreshWallet(interaction.guildId, interaction.user.id, settings);
    await interaction.editReply(
      `🎟️ Votes left today: **${wallet.remaining}**\nRemove a vote before crowning to get it back.`,
    );
    return;
  }

  if (id === "artshow:week") {
    await interaction.deferReply({ ephemeral: true });
    const week = utcWeekKey();
    const rows = await topPieces(interaction.guildId, { weekKey: week, limit: 10 });
    const fame = await getFame(interaction.guildId, week);
    const embed = new EmbedBuilder()
      .setColor(BRAND)
      .setTitle(`This week · ${week}`)
      .setDescription(
        [
          fame ? `🏆 Champion: **${fame.title}** — <@${fame.authorId}>` : "_No champion yet._",
          "",
          rows.length
            ? rows.map((p, i) => `**${i + 1}.** ${p.title} — <@${p.authorId}> · **▲ ${p.votes}**`).join("\n")
            : "_No pieces yet — be the first to Submit._",
        ].join("\n"),
      );
    await interaction.editReply({ embeds: [embed] });
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
    const { boardId } = channelIds(settings);
    const board = await fetchTextChannel(interaction.client, boardId);
    await maybeAnnounceBadges(board, interaction.guildId, interaction.user.id, voterBadges);
    await maybeAnnounceBadges(board, interaction.guildId, result.piece.authorId, authorBadges);
    await tryAutoCrown(interaction.guildId, result.piece, settings, interaction.client);

    await interaction.editReply(
      `▲ Voted for **${result.piece.title}** — now **${result.piece.votes}**. Votes left: **${result.wallet.remaining}**.`,
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

  if (id.startsWith("artshow:photos:")) {
    const parts = id.split(":");
    const pieceId = Number(parts[2]);
    const page = Number(parts[3] ?? 0);
    const piece = await getPiece(pieceId);
    if (!piece || piece.guildId !== interaction.guildId) {
      await interaction.reply({ content: "Piece not found.", ...EPHEMERAL });
      return;
    }
    // Gallery button → new ephemeral; Prev/Next on that ephemeral → update in place.
    const onEphemeral = interaction.message.flags.has(MessageFlags.Ephemeral);
    if (onEphemeral) await interaction.deferUpdate();
    else await interaction.deferReply({ ephemeral: true });
    await replyPhotoViewer(interaction, piece, page);
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
    let artistName = result.piece.authorId;
    try {
      const u = await interaction.client.users.fetch(result.piece.authorId);
      artistName = u.username;
    } catch { /* keep */ }
    await sendPieceMessage({
      piece: result.piece,
      channel: channel as TextChannel,
      artistName,
      content: `📌 **Bumped** — <@${result.piece.authorId}>'s **${result.piece.title}**`,
      sourceHttpUrls: loadablePhotoUrls(result.piece),
    });
    await interaction.editReply(
      result.usedFree
        ? "📌 Bumped with your free Rising Artist bump!"
        : `📌 Bumped for **${settings.bumpCostVotes}** votes. Remaining: **${result.wallet.remaining}**.`,
    );
    return;
  }

  // Old station buttons (Browse / Museum / etc.)
  if (
    id === "artshow:browse"
    || id === "artshow:museum"
    || id === "artshow:badges"
    || id === "artshow:staff_reset"
    || id.startsWith("artshow:draft_")
  ) {
    await interaction.reply({
      content: "That control was removed. Tap **Submit** on the board, or ask staff to `/artshow setup` again.",
      ...EPHEMERAL,
    });
  }
}

export async function handleArtShowSelect(_interaction: StringSelectMenuInteraction): Promise<void> {
  // Browse select removed — keep stub so old menus don't crash the router.
}

export async function handleArtShowModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.guildId || interaction.customId !== "artshow:submit_modal") return;

  const title = (interaction.fields.getTextInputValue("title") ?? "").trim();
  const description = (interaction.fields.getTextInputValue("description") ?? "").trim();
  if (!title) {
    await interaction.reply({ content: "Title required.", ...EPHEMERAL });
    return;
  }

  const uploaded = interaction.fields.getUploadedFiles("image", false);
  const attachments = uploaded ? [...uploaded.values()].filter(isImageAttachment) : [];
  if (!attachments.length) {
    await interaction.reply({
      content: `No photos attached — tap **Submit** again and pick 1–${MAX_PHOTOS} images.`,
      ...EPHEMERAL,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const settings = await getOrCreateArtshowSettings(interaction.guildId);
    if (!settings.enabled) {
      await interaction.editReply("Art Show is disabled.");
      return;
    }
    const { galleryId, boardId } = channelIds(settings);
    const gallery = await fetchTextChannel(interaction.client, galleryId);
    if (!gallery) {
      await interaction.editReply("Gallery isn’t set — staff should `/artshow setup`.");
      return;
    }
    const board = await fetchTextChannel(interaction.client, boardId);
    const ingested = await ingestUploads(attachments);
    const { piece, badgeResult } = await publishPiece({
      guildId: interaction.guildId,
      gallery,
      board,
      authorId: interaction.user.id,
      authorName: interaction.user.username,
      title,
      description,
      storedUrls: ingested.storedUrls,
      sourceHttpUrls: ingested.sourceHttpUrls,
      originalBytesList: ingested.bytesList,
      orientation: ingested.orientation,
    });
    const n = ingested.storedUrls.length;
    await interaction.editReply(
      `✅ Posted **${piece.title}**${n > 1 ? ` (${n} photos)` : ""} in <#${gallery.id}> — people can ▲ vote there.`
      + badgeUnlockLine(badgeResult),
    );
    await followUpBadgeEmblem(interaction, badgeResult).catch(() => {});
  } catch (err) {
    logger.warn({ err }, "artshow modal submit failed");
    await interaction.editReply(
      `❌ Couldn't post that: ${err instanceof Error ? err.message : "unknown error"}`,
    ).catch(() => {});
  }
}

/** Board photo-drops disabled — Submit button is the only path. */
export async function handleArtShowMessage(_msg: Message): Promise<boolean> {
  return false;
}
