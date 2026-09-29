// ─────────────────────────────────────────────────────────────────────────────
// /quote — Make it a Quote for Discord.
//
// Sources:
//   • Reply to a message → quote that instantly
//   • message_id option / right-click "Make it a Quote"
//   • user option → last 5 of theirs in-channel
//   • bare /quote → last 5 in-channel
//   • text (+ optional user) → custom quote with their avatar
//
// Then: pick a style (7+ presets + Make Your Own), tweak, Post or Save.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Message,
  MessageContextMenuCommandInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  UserSelectMenuInteraction,
  GuildTextBasedChannel,
} from "discord.js";
import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, MessageFlags, ModalBuilder, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle,
} from "discord.js";
import { BRAND_NAME } from "../help-banners.js";
import { logger } from "../../lib/logger.js";
import { renderQuoteCard, QUOTE_FILE } from "./render.js";
import {
  activeTheme, createQuoteSession, deleteQuoteSession, getQuoteSession,
  type QuotePayload, type QuoteSession,
} from "./session.js";
import {
  BG_SWATCHES, CUSTOM_STYLE_ID, QUOTE_STYLES, TEXT_SWATCHES, customFrom,
  type QuoteLayout,
} from "./styles.js";
import { clip, prepareQuoteText } from "./text.js";
import { quoteDisplayName } from "./display-name.js";
import { postQuoteAsPerson } from "./webhook.js";
import {
  buildDualBuilderReply, buildDualHubReply,
  dualPostFiles, dualPostPayload, dualSlotFromView, renderDualPreviews,
} from "./dual-ui.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;
const PREVIEW_NAME = "quote-preview.png";

type QuoteInteraction =
  | ChatInputCommandInteraction
  | MessageContextMenuCommandInteraction
  | ButtonInteraction
  | StringSelectMenuInteraction
  | UserSelectMenuInteraction
  | ModalSubmitInteraction;

function assertOwner(interaction: QuoteInteraction, session: QuoteSession): boolean {
  return interaction.user.id === session.ownerId;
}

function snowflakeOk(id: string): boolean {
  return /^\d{17,20}$/.test(id);
}

function avatarUrlFor(message: Message): string {
  const member = message.member;
  return (member?.displayAvatarURL({ extension: "png", size: 512 })
    ?? message.author.displayAvatarURL({ extension: "png", size: 512 }));
}

function payloadFromMessage(message: Message): QuotePayload | null {
  const raw = message.content?.trim() ?? "";
  if (!raw) return null;
  const text = prepareQuoteText(raw, {
    users: message.mentions.users.map(u => ({
      id: u.id,
      username: u.username,
      displayName: message.guild?.members.cache.get(u.id)?.displayName ?? u.displayName,
    })),
    roles: message.mentions.roles.map(r => ({ id: r.id, name: r.name })),
    channels: [...message.mentions.channels.values()]
      .flatMap(c => {
        const name = "name" in c ? (c as { name?: string }).name : undefined;
        return name ? [{ id: c.id, name }] : [];
      }),
  });
  if (!text) return null;
  const handle = message.author.username;
  const rawName = message.member?.displayName ?? message.author.displayName ?? handle;
  return {
    text,
    displayName: quoteDisplayName(rawName, handle),
    handle,
    avatarUrl: avatarUrlFor(message),
    messageId: message.id,
    channelId: message.channelId,
    authorId: message.author.id,
    createdAt: message.createdAt,
  };
}

async function fetchRecentCandidates(
  channel: GuildTextBasedChannel,
  authorId?: string | null,
  limit = 5,
): Promise<Message[]> {
  const fetched = await channel.messages.fetch({ limit: 40 }).catch(() => null);
  if (!fetched) return [];
  return [...fetched.values()]
    .filter(m => !m.author.bot && (m.content?.trim().length ?? 0) > 0)
    .filter(m => !authorId || m.author.id === authorId)
    .slice(0, limit);
}

async function resolveMessageById(
  interaction: ChatInputCommandInteraction,
  messageId: string,
): Promise<Message | null> {
  if (!snowflakeOk(messageId) || !interaction.channel || !interaction.channel.isTextBased()) {
    return null;
  }
  const ch = interaction.channel as GuildTextBasedChannel;
  // Try current channel first, then let Discord error.
  return await ch.messages.fetch(messageId).catch(() => null);
}

async function renderPreview(session: QuoteSession): Promise<Buffer | null> {
  if (!session.payload) return null;
  const buf = await renderQuoteCard({
    text: session.payload.text,
    displayName: session.payload.displayName,
    handle: session.payload.handle,
    avatarUrl: session.payload.avatarUrl,
    theme: activeTheme(session),
    watermark: BRAND_NAME,
    createdAt: session.payload.createdAt,
  });
  if (buf) session.lastPng = buf;
  return buf;
}

function styleSelect(token: string, current: string) {
  return new StringSelectMenuBuilder()
    .setCustomId(`quote:style:${token}`)
    .setPlaceholder("Pick a style…")
    .addOptions(
      ...QUOTE_STYLES.map(s => ({
        label: `${s.label}`.slice(0, 100),
        value: s.id,
        description: clip(s.description, 100),
        emoji: s.emoji,
        default: current === s.id,
      })),
      {
        label: "Make Your Own",
        value: CUSTOM_STYLE_ID,
        description: "Colors, layout, grayscale — build it",
        emoji: "✨",
        default: current === CUSTOM_STYLE_ID,
      },
    );
}

function builderRows(token: string, session: QuoteSession) {
  const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(styleSelect(token, session.styleId)),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`quote:custom:${token}`).setLabel("Make Your Own").setStyle(ButtonStyle.Secondary).setEmoji("✨"),
      new ButtonBuilder().setCustomId(`quote:edit:${token}`).setLabel("Edit Text").setStyle(ButtonStyle.Secondary).setEmoji("✏️"),
      new ButtonBuilder().setCustomId(`quote:dualstart:${token}`).setLabel("Target 2 Msgs").setStyle(ButtonStyle.Primary).setEmoji("💬"),
      new ButtonBuilder().setCustomId(`quote:reroll:${token}`).setLabel("Refresh").setStyle(ButtonStyle.Secondary).setEmoji("🔄"),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`quote:post:${token}`).setLabel("Post to Channel").setStyle(ButtonStyle.Success).setEmoji("📣"),
      new ButtonBuilder().setCustomId(`quote:save:${token}`).setLabel("Save / Download").setStyle(ButtonStyle.Primary).setEmoji("💾"),
      new ButtonBuilder().setCustomId(`quote:close:${token}`).setLabel("Close").setStyle(ButtonStyle.Danger),
    ),
  ];
  return rows;
}

function customRows(token: string, session: QuoteSession) {
  const theme = session.customTheme;
  const layout = theme.layout;
  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`quote:layout:${token}`)
        .setPlaceholder("Card layout")
        .addOptions(
          { label: "Classic (circle fade)", value: "classic", default: layout === "classic", emoji: "🖤" },
          { label: "MakeItAQuote fade", value: "fade-left", default: layout === "fade-left", emoji: "📷" },
          { label: "Discord Capture", value: "discord", default: layout === "discord", emoji: "💬" },
          { label: "Caught in 4K", value: "caught4k", default: layout === "caught4k", emoji: "📼" },
          { label: "Cinematic sunset", value: "cinematic", default: layout === "cinematic", emoji: "🎥" },
          { label: "Absolute Cinema", value: "absolute", default: layout === "absolute", emoji: "🎞️" },
          { label: "Did He Really…?", value: "glitch", default: layout === "glitch", emoji: "😵" },
          { label: "Bruhh Reflection", value: "bruhh", default: layout === "bruhh", emoji: "💧" },
          { label: "Moonlight", value: "ethereal", default: layout === "ethereal", emoji: "🌕" },
          { label: "Impact meme", value: "impact", default: layout === "impact", emoji: "💥" },
        ),
    ),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`quote:bg:${token}`)
        .setPlaceholder("Background color")
        .addOptions(BG_SWATCHES.map(s => ({
          label: s.label,
          value: s.id,
          description: s.color,
          default: theme.background.toLowerCase() === s.color.toLowerCase(),
        }))),
    ),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`quote:fg:${token}`)
        .setPlaceholder("Text color")
        .addOptions(TEXT_SWATCHES.map(s => ({
          label: s.label,
          value: s.id,
          description: s.color,
          default: theme.textColor.toLowerCase() === s.color.toLowerCase(),
        }))),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`quote:gray:${token}`)
        .setLabel(theme.grayscale ? "Color Avatar" : "B&W Avatar")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(theme.grayscale ? "🎨" : "⬛"),
      new ButtonBuilder().setCustomId(`quote:edit:${token}`).setLabel("Edit Text").setStyle(ButtonStyle.Secondary).setEmoji("✏️"),
      new ButtonBuilder().setCustomId(`quote:back:${token}`).setLabel("Back to Styles").setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`quote:post:${token}`).setLabel("Post to Channel").setStyle(ButtonStyle.Success).setEmoji("📣"),
      new ButtonBuilder().setCustomId(`quote:save:${token}`).setLabel("Save / Download").setStyle(ButtonStyle.Primary).setEmoji("💾"),
      new ButtonBuilder().setCustomId(`quote:close:${token}`).setLabel("Close").setStyle(ButtonStyle.Danger),
    ),
  ];
}

function pickRows(token: string, messages: Message[]) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`quote:pick:${token}`)
    .setPlaceholder("Pick a message to quote…")
    .addOptions(messages.map(m => {
      const name = m.member?.displayName ?? m.author.displayName ?? m.author.username;
      return {
        label: clip(`${name}: ${m.content}`, 100),
        value: m.id,
        description: clip(`@${m.author.username} · ${m.content}`, 100),
      };
    }));
  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`quote:dualstart:${token}`).setLabel("Target 2 Msgs").setStyle(ButtonStyle.Primary).setEmoji("💬"),
      new ButtonBuilder().setCustomId(`quote:customtext:${token}`).setLabel("Type Your Own").setStyle(ButtonStyle.Secondary).setEmoji("✏️"),
      new ButtonBuilder().setCustomId(`quote:close:${token}`).setLabel("Cancel").setStyle(ButtonStyle.Danger),
    ),
  ];
}

async function buildBuilderReply(token: string, session: QuoteSession) {
  const theme = activeTheme(session);
  const png = await renderPreview(session);
  const embed = new EmbedBuilder()
    .setColor(0x111111)
    .setTitle(`${theme.emoji} Make it a Quote`)
    .setDescription(
      session.view === "custom"
        ? `**Make Your Own** — tweak layout, colors, and avatar treatment.\nQuote by **${session.payload?.displayName ?? "?"}**`
        : `Style: **${theme.label}** — switch styles, edit text, then **Post** or **Save**.\nQuote by **${session.payload?.displayName ?? "?"}**`,
    )
    .setFooter({ text: `${BRAND_NAME} · snappy quote cards` });

  const files: AttachmentBuilder[] = [];
  if (png) {
    files.push(new AttachmentBuilder(png, { name: PREVIEW_NAME }));
    embed.setImage(`attachment://${PREVIEW_NAME}`);
  } else {
    embed.setDescription((embed.data.description ?? "") + "\n\n⚠️ Couldn't render preview — try Refresh.");
  }

  const components = session.view === "custom" ? customRows(token, session) : builderRows(token, session);
  return { embeds: [embed], components, files };
}

async function openBuilder(
  interaction: QuoteInteraction,
  payload: QuotePayload,
  styleId?: string,
  alreadyDeferred = false,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) return;
  const { token, session } = createQuoteSession({
    ownerId: interaction.user.id,
    guildId,
    payload,
    styleId: styleId ?? "classic",
    view: "builder",
  });
  const reply = await buildBuilderReply(token, session);
  if (alreadyDeferred || ("deferred" in interaction && interaction.deferred)) {
    await interaction.editReply(reply).catch(() => {});
  } else if ("replied" in interaction && interaction.replied) {
    await interaction.editReply(reply).catch(() => {});
  } else {
    await interaction.reply({ ...reply, ...EPHEMERAL }).catch(() => {});
  }
}

async function openPicker(
  interaction: ChatInputCommandInteraction,
  messages: Message[],
  styleId?: string,
): Promise<void> {
  const guildId = interaction.guildId!;
  const { token } = createQuoteSession({
    ownerId: interaction.user.id,
    guildId,
    styleId: styleId ?? "classic",
    view: "pick",
  });
  const embed = new EmbedBuilder()
    .setColor(0x111111)
    .setTitle("🖤 Make it a Quote")
    .setDescription(
      messages.length
        ? `Pick one of the **last ${messages.length}** messages, or type your own.`
        : "No recent text messages found — type your own quote instead.",
    )
    .setFooter({ text: `${BRAND_NAME} · tip: reply to a message with /quote for instant sauce` });

  if (!messages.length) {
    await interaction.reply({
      embeds: [embed],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`quote:dualstart:${token}`).setLabel("Target 2 Msgs").setStyle(ButtonStyle.Primary).setEmoji("💬"),
          new ButtonBuilder().setCustomId(`quote:customtext:${token}`).setLabel("Type Your Own").setStyle(ButtonStyle.Primary).setEmoji("✏️"),
          new ButtonBuilder().setCustomId(`quote:close:${token}`).setLabel("Cancel").setStyle(ButtonStyle.Danger),
        ),
      ],
      ...EPHEMERAL,
    }).catch(() => {});
    return;
  }

  await interaction.reply({
    embeds: [embed],
    components: pickRows(token, messages),
    ...EPHEMERAL,
  }).catch(() => {});
}

// ── Slash entry ───────────────────────────────────────────────────────────────
export async function handleQuoteCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId || !interaction.channel || !interaction.channel.isTextBased()) {
    await interaction.reply({ content: "❌ Quotes only work in a server text channel.", ...EPHEMERAL }).catch(() => {});
    return;
  }

  const styleOpt = interaction.options.getString("style") ?? undefined;
  const messageId = interaction.options.getString("message_id");
  const textOpt = interaction.options.getString("text");
  const userOpt = interaction.options.getUser("user");

  if (messageId) {
    await interaction.deferReply(EPHEMERAL).catch(() => {});
    const msg = await resolveMessageById(interaction, messageId);
    if (!msg) {
      await interaction.editReply({ content: "❌ Couldn't find that message in this channel. Enable Developer Mode → Copy Message ID." }).catch(() => {});
      return;
    }
    const payload = payloadFromMessage(msg);
    if (!payload) {
      await interaction.editReply({ content: "❌ That message has no text to quote (embeds/stickers alone don't count)." }).catch(() => {});
      return;
    }
    await openBuilder(interaction, payload, styleOpt, true);
    return;
  }

  if (textOpt?.trim()) {
    await interaction.deferReply(EPHEMERAL).catch(() => {});
    const target = userOpt ?? interaction.user;
    const member = await interaction.guild?.members.fetch(target.id).catch(() => null);
    const handle = target.username;
    const payload: QuotePayload = {
      text: prepareQuoteText(textOpt),
      displayName: quoteDisplayName(member?.displayName ?? target.displayName ?? handle, handle),
      handle,
      avatarUrl: member?.displayAvatarURL({ extension: "png", size: 512 })
        ?? target.displayAvatarURL({ extension: "png", size: 512 }),
      authorId: target.id,
      channelId: interaction.channelId,
    };
    await openBuilder(interaction, payload, styleOpt, true);
    return;
  }

  // Last 5 messages (optionally filtered to a user).
  const channel = interaction.channel as GuildTextBasedChannel;
  const recent = await fetchRecentCandidates(channel, userOpt?.id ?? null, 5);
  await openPicker(interaction, recent, styleOpt);
}

// ── Context menu ──────────────────────────────────────────────────────────────
export async function handleQuoteContextMenu(
  interaction: MessageContextMenuCommandInteraction,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "❌ Quotes only work in a server.", ...EPHEMERAL }).catch(() => {});
    return;
  }
  const msg = interaction.targetMessage;
  const payload = payloadFromMessage(msg);
  if (!payload) {
    await interaction.reply({ content: "❌ That message has no text to quote.", ...EPHEMERAL }).catch(() => {});
    return;
  }
  await interaction.deferReply(EPHEMERAL).catch(() => {});
  await openBuilder(interaction, payload, "classic", true);
}

/** Lock in payload for dual slot A or B, then advance to next hub / builder. */
async function advanceDualWithPayload(
  token: string,
  session: QuoteSession,
  interaction: ButtonInteraction | StringSelectMenuInteraction | UserSelectMenuInteraction | ModalSubmitInteraction,
  payload: QuotePayload,
  channel: GuildTextBasedChannel,
): Promise<void> {
  session.mode = "dual";
  session.dualFilterUserId = null;
  session.dualFilterUserName = null;
  session.lastPng = undefined;
  session.lastDiscordShot = undefined;

  const slot = dualSlotFromView(session);
  if (slot === "a") {
    session.payload = payload;
    session.payloadB = null;
    session.view = "dual-pick-b";
    const recent = await fetchRecentCandidates(channel, null, 5);
    await interaction.editReply(buildDualHubReply(token, session, recent)).catch(() => {});
    return;
  }

  if (!session.payload) {
    // Safety: treat as A if somehow B without A
    session.payload = payload;
    session.payloadB = null;
    session.view = "dual-pick-b";
    const recent = await fetchRecentCandidates(channel, null, 5);
    await interaction.editReply(buildDualHubReply(token, session, recent)).catch(() => {});
    return;
  }

  session.payloadB = payload;
  session.view = "dual-builder";
  await interaction.editReply(await buildDualBuilderReply(token, session)).catch(() => {});
}

// ── Components / modals ───────────────────────────────────────────────────────
export async function handleQuoteInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction | UserSelectMenuInteraction | ModalSubmitInteraction,
): Promise<void> {
  const parts = interaction.customId.split(":");
  // quote:<action>:<token>
  const action = parts[1];
  const token = parts[2];
  if (!action || !token) return;

  const session = getQuoteSession(token);
  if (!session) {
    const msg = "⌛ This quote session expired — run `/quote` again.";
    if (interaction.isModalSubmit()) {
      await interaction.reply({ content: msg, ...EPHEMERAL }).catch(() => {});
    } else {
      await interaction.update({ content: msg, embeds: [], components: [], files: [] }).catch(() => {
        interaction.reply({ content: msg, ...EPHEMERAL }).catch(() => {});
      });
    }
    return;
  }
  if (!assertOwner(interaction, session)) {
    await interaction.reply({ content: "❌ Only the person who started this quote can edit it.", ...EPHEMERAL }).catch(() => {});
    return;
  }

  try {
    if (action === "close") {
      deleteQuoteSession(token);
      if (interaction.isButton()) {
        await interaction.update({ content: "Closed.", embeds: [], components: [], files: [] }).catch(() => {});
      }
      return;
    }

    if (action === "pick" && interaction.isStringSelectMenu()) {
      const messageId = interaction.values[0]!;
      if (!interaction.channel || !interaction.channel.isTextBased()) return;
      await interaction.deferUpdate().catch(() => {});
      const msg = await (interaction.channel as GuildTextBasedChannel).messages.fetch(messageId).catch(() => null);
      if (!msg) {
        await interaction.editReply({ content: "❌ Message disappeared.", embeds: [], components: [], files: [] }).catch(() => {});
        return;
      }
      const payload = payloadFromMessage(msg);
      if (!payload) {
        await interaction.editReply({ content: "❌ That message has no text.", embeds: [], components: [], files: [] }).catch(() => {});
        return;
      }
      session.payload = payload;
      session.mode = "single";
      session.payloadB = null;
      session.view = "builder";
      session.lastPng = undefined;
      await interaction.editReply(await buildBuilderReply(token, session)).catch(() => {});
      return;
    }

    // ── Dual: Target 2 Msgs ─────────────────────────────────────────────────
    if (action === "dualstart" && interaction.isButton()) {
      if (!interaction.channel || !interaction.channel.isTextBased()) return;
      await interaction.deferUpdate().catch(() => {});
      session.mode = "dual";
      session.payload = null;
      session.payloadB = null;
      session.view = "dual-pick-a";
      session.dualFilterUserId = null;
      session.dualFilterUserName = null;
      session.lastPng = undefined;
      session.lastDiscordShot = undefined;
      const recent = await fetchRecentCandidates(interaction.channel as GuildTextBasedChannel, null, 5);
      await interaction.editReply(buildDualHubReply(token, session, recent)).catch(() => {});
      return;
    }

    if (action === "dualcancel" && interaction.isButton()) {
      await interaction.deferUpdate().catch(() => {});
      session.mode = "single";
      session.payloadB = null;
      session.dualFilterUserId = null;
      session.dualFilterUserName = null;
      session.lastDiscordShot = undefined;
      if (session.payload) {
        session.view = "builder";
        await interaction.editReply(await buildBuilderReply(token, session)).catch(() => {});
      } else if (interaction.channel?.isTextBased()) {
        const recent = await fetchRecentCandidates(interaction.channel as GuildTextBasedChannel, null, 5);
        session.view = "pick";
        const embed = new EmbedBuilder()
          .setColor(0x111111)
          .setTitle("🖤 Make it a Quote")
          .setDescription(recent.length
            ? `Pick one of the **last ${recent.length}** messages, or type your own.`
            : "No recent text messages — type your own or Target 2 Msgs.")
          .setFooter({ text: `${BRAND_NAME} · snappy quote cards` });
        await interaction.editReply({
          embeds: [embed],
          components: recent.length ? pickRows(token, recent) : [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder().setCustomId(`quote:dualstart:${token}`).setLabel("Target 2 Msgs").setStyle(ButtonStyle.Primary).setEmoji("💬"),
              new ButtonBuilder().setCustomId(`quote:customtext:${token}`).setLabel("Type Your Own").setStyle(ButtonStyle.Secondary).setEmoji("✏️"),
              new ButtonBuilder().setCustomId(`quote:close:${token}`).setLabel("Cancel").setStyle(ButtonStyle.Danger),
            ),
          ],
          files: [],
        }).catch(() => {});
      }
      return;
    }

    if ((action === "dualpicka" || action === "dualpickb") && interaction.isStringSelectMenu()) {
      if (!interaction.channel || !interaction.channel.isTextBased()) return;
      await interaction.deferUpdate().catch(() => {});
      const msg = await (interaction.channel as GuildTextBasedChannel).messages.fetch(interaction.values[0]!).catch(() => null);
      const payload = msg ? payloadFromMessage(msg) : null;
      if (!payload) {
        await interaction.editReply({ content: "❌ Couldn't use that message.", embeds: [], components: [], files: [] }).catch(() => {});
        return;
      }
      await advanceDualWithPayload(token, session, interaction, payload, interaction.channel as GuildTextBasedChannel);
      return;
    }

    if (action === "dualpicka-back" && interaction.isButton()) {
      if (!interaction.channel || !interaction.channel.isTextBased()) return;
      await interaction.deferUpdate().catch(() => {});
      session.payload = null;
      session.payloadB = null;
      session.view = "dual-pick-a";
      session.dualFilterUserId = null;
      session.dualFilterUserName = null;
      const recent = await fetchRecentCandidates(interaction.channel as GuildTextBasedChannel, null, 5);
      await interaction.editReply(buildDualHubReply(token, session, recent)).catch(() => {});
      return;
    }

    if (action === "dualuser" && interaction.isUserSelectMenu()) {
      if (!interaction.channel || !interaction.channel.isTextBased()) return;
      await interaction.deferUpdate().catch(() => {});
      const user = interaction.users.first();
      if (!user) return;
      const member = await interaction.guild?.members.fetch(user.id).catch(() => null);
      session.dualFilterUserId = user.id;
      session.dualFilterUserName = member?.displayName ?? user.displayName ?? user.username;
      const recent = await fetchRecentCandidates(
        interaction.channel as GuildTextBasedChannel,
        user.id,
        5,
      );
      await interaction.editReply(buildDualHubReply(token, session, recent)).catch(() => {});
      return;
    }

    if (action === "dualclearuser" && interaction.isButton()) {
      if (!interaction.channel || !interaction.channel.isTextBased()) return;
      await interaction.deferUpdate().catch(() => {});
      session.dualFilterUserId = null;
      session.dualFilterUserName = null;
      const recent = await fetchRecentCandidates(interaction.channel as GuildTextBasedChannel, null, 5);
      await interaction.editReply(buildDualHubReply(token, session, recent)).catch(() => {});
      return;
    }

    if (action === "dualmsgid" && interaction.isButton()) {
      const slot = dualSlotFromView(session);
      const modal = new ModalBuilder()
        .setCustomId(`quote:dualmsgidmodal:${token}`)
        .setTitle(slot === "a" ? "Message ID · Setup" : "Message ID · Reply")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("message_id")
              .setLabel("Discord message ID")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMinLength(17)
              .setMaxLength(22)
              .setPlaceholder("Right-click message → Copy Message ID"),
          ),
        );
      await interaction.showModal(modal).catch(() => {});
      return;
    }

    if (action === "dualmsgidmodal" && interaction.isModalSubmit()) {
      if (!interaction.channel || !interaction.channel.isTextBased()) return;
      await interaction.deferUpdate().catch(() => {});
      const messageId = interaction.fields.getTextInputValue("message_id").trim();
      if (!snowflakeOk(messageId)) {
        await interaction.followUp({ content: "❌ That doesn't look like a message ID.", ...EPHEMERAL }).catch(() => {});
        return;
      }
      const msg = await (interaction.channel as GuildTextBasedChannel).messages.fetch(messageId).catch(() => null);
      const payload = msg ? payloadFromMessage(msg) : null;
      if (!payload) {
        await interaction.followUp({
          content: "❌ Couldn't find that message here, or it has no text.",
          ...EPHEMERAL,
        }).catch(() => {});
        return;
      }
      await advanceDualWithPayload(token, session, interaction, payload, interaction.channel as GuildTextBasedChannel);
      return;
    }

    if (action === "dualcustom" && interaction.isButton()) {
      const slot = dualSlotFromView(session);
      const modal = new ModalBuilder()
        .setCustomId(`quote:dualcustommodal:${token}`)
        .setTitle(slot === "a" ? "Custom · Setup" : "Custom · Reply")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("text")
              .setLabel("Quote text")
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
              .setMaxLength(500)
              .setPlaceholder("What they said…"),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("name")
              .setLabel("Author display name")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(80)
              .setValue(clip(interaction.user.displayName, 80)),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("handle")
              .setLabel("Handle (without @)")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(32)
              .setValue(clip(interaction.user.username, 32)),
          ),
        );
      await interaction.showModal(modal).catch(() => {});
      return;
    }

    if (action === "dualcustommodal" && interaction.isModalSubmit()) {
      if (!interaction.channel || !interaction.channel.isTextBased()) return;
      await interaction.deferUpdate().catch(() => {});
      const text = prepareQuoteText(interaction.fields.getTextInputValue("text"));
      const handle = interaction.fields.getTextInputValue("handle").trim().replace(/^@/, "") || interaction.user.username;
      const displayName = quoteDisplayName(
        interaction.fields.getTextInputValue("name").trim() || interaction.user.displayName,
        handle,
      );
      const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
      const payload: QuotePayload = {
        text,
        displayName,
        handle,
        avatarUrl: member?.displayAvatarURL({ extension: "png", size: 512 })
          ?? interaction.user.displayAvatarURL({ extension: "png", size: 512 }),
        authorId: interaction.user.id,
        channelId: interaction.channelId ?? undefined,
      };
      await advanceDualWithPayload(token, session, interaction, payload, interaction.channel as GuildTextBasedChannel);
      return;
    }

    if (action === "dualstyle" && interaction.isStringSelectMenu()) {
      await interaction.deferUpdate().catch(() => {});
      session.dualStyleId = interaction.values[0]!;
      session.view = "dual-builder";
      session.lastPng = undefined;
      session.lastDiscordShot = undefined;
      await interaction.editReply(await buildDualBuilderReply(token, session)).catch(() => {});
      return;
    }

    if (action === "dualswap" && interaction.isButton()) {
      await interaction.deferUpdate().catch(() => {});
      if (session.payload && session.payloadB) {
        const tmp = session.payload;
        session.payload = session.payloadB;
        session.payloadB = tmp;
        session.lastPng = undefined;
        session.lastDiscordShot = undefined;
      }
      await interaction.editReply(await buildDualBuilderReply(token, session)).catch(() => {});
      return;
    }

    if (action === "dualreroll" && interaction.isButton()) {
      await interaction.deferUpdate().catch(() => {});
      session.lastPng = undefined;
      session.lastDiscordShot = undefined;
      await interaction.editReply(await buildDualBuilderReply(token, session)).catch(() => {});
      return;
    }

    if (action === "dualsave" && interaction.isButton()) {
      await interaction.deferReply(EPHEMERAL).catch(() => {});
      if (!session.lastPng) await renderDualPreviews(session);
      const files = dualPostFiles(session);
      if (!files.length) {
        await interaction.editReply({ content: "❌ Render failed — try another dual style." }).catch(() => {});
        return;
      }
      await interaction.editReply({
        content: "💾 **Saved dual quote** — download below" +
          (session.lastDiscordShot ? " (styled card + Discord screenshot)." : "."),
        files,
      }).catch(() => {});
      return;
    }

    if (action === "dualpost" && interaction.isButton()) {
      await interaction.deferReply(EPHEMERAL).catch(() => {});
      if (!session.lastPng) await renderDualPreviews(session);
      const payload = dualPostPayload(session);
      if (!payload.files.length || !interaction.channel || !interaction.channel.isTextBased()) {
        await interaction.editReply({ content: "❌ Couldn't post — render or channel failed." }).catch(() => {});
        return;
      }
      const channel = interaction.channel;
      if (channel.isDMBased() || !("send" in channel)) {
        await interaction.editReply({ content: "❌ Can't post here — download instead:", files: payload.files }).catch(() => {});
        return;
      }
      const guildChannel = channel as GuildTextBasedChannel;
      // Appear as quote #1; card/embeds still show both people.
      const asPerson = session.payload;
      const posted =
        (await postQuoteAsPerson(guildChannel, interaction.client, {
          displayName: asPerson?.displayName ?? "someone",
          handle: asPerson?.handle,
          avatarURL: asPerson?.avatarUrl,
          content: payload.content,
          embeds: payload.embeds,
          files: payload.files,
        })) ??
        await guildChannel.send(payload).catch((err: unknown) => {
          logger.warn({ err }, "duo-quote: channel post failed");
          return null;
        });
      if (!posted) {
        await interaction.editReply({
          content: "❌ Couldn't post (missing **Manage Webhooks** / send perms?). Download instead:",
          files: payload.files,
        }).catch(() => {});
        return;
      }
      await interaction.editReply({ content: `✅ Posted → ${posted.url}` }).catch(() => {});
      return;
    }

    if (action === "style" && interaction.isStringSelectMenu()) {
      await interaction.deferUpdate().catch(() => {});
      const next = interaction.values[0]!;
      session.styleId = next;
      if (next === CUSTOM_STYLE_ID) {
        session.view = "custom";
        // Seed custom from previous preset if still on default custom.
        if (session.customTheme.id === CUSTOM_STYLE_ID && session.customTheme.label === "Make Your Own") {
          // keep existing custom edits
        }
      } else {
        session.view = "builder";
        // Refresh custom seed from the chosen preset so Make Your Own starts close.
        session.customTheme = customFrom(next);
      }
      session.lastPng = undefined;
      await interaction.editReply(await buildBuilderReply(token, session)).catch(() => {});
      return;
    }

    if (action === "custom" && interaction.isButton()) {
      await interaction.deferUpdate().catch(() => {});
      session.styleId = CUSTOM_STYLE_ID;
      session.view = "custom";
      session.lastPng = undefined;
      await interaction.editReply(await buildBuilderReply(token, session)).catch(() => {});
      return;
    }

    if (action === "back" && interaction.isButton()) {
      await interaction.deferUpdate().catch(() => {});
      session.view = "builder";
      if (session.styleId === CUSTOM_STYLE_ID) {
        // stay on custom id so the select shows Make Your Own selected
      }
      session.lastPng = undefined;
      await interaction.editReply(await buildBuilderReply(token, session)).catch(() => {});
      return;
    }

    if (action === "layout" && interaction.isStringSelectMenu()) {
      await interaction.deferUpdate().catch(() => {});
      session.styleId = CUSTOM_STYLE_ID;
      session.view = "custom";
      const next = interaction.values[0] as QuoteLayout;
      // Seed dimensions / avatar treatment from the matching preset when possible.
      const seed = QUOTE_STYLES.find(s => s.layout === next) ?? customFrom("classic");
      session.customTheme = {
        ...session.customTheme,
        layout: next,
        width: seed.width,
        height: seed.height,
        avatarLayout: seed.avatarLayout,
        avatarShare: seed.avatarShare,
        fadeShare: seed.fadeShare,
        quoteMarks: seed.quoteMarks,
        fontTone: seed.fontTone,
        tagline: seed.tagline,
        uppercaseQuote: seed.uppercaseQuote,
        grayscale: next === "discord" || next === "cinematic" ? false : session.customTheme.grayscale,
      };
      session.lastPng = undefined;
      await interaction.editReply(await buildBuilderReply(token, session)).catch(() => {});
      return;
    }

    if (action === "bg" && interaction.isStringSelectMenu()) {
      await interaction.deferUpdate().catch(() => {});
      const sw = BG_SWATCHES.find(s => s.id === interaction.values[0]);
      if (sw) {
        session.styleId = CUSTOM_STYLE_ID;
        session.view = "custom";
        const light = isLight(sw.color);
        session.customTheme = {
          ...session.customTheme,
          background: sw.color,
          backgroundGradient: undefined,
          textColor: light ? "#141414" : session.customTheme.textColor === "#141414" ? "#FFFFFF" : session.customTheme.textColor,
          attributionColor: light ? "#2A2A2A" : "#E8E8E8",
          handleColor: light ? "#6B6B6B" : "#9A9A9A",
          watermarkColor: light ? "#B0B0B0" : "#3A3A3A",
        };
        session.lastPng = undefined;
      }
      await interaction.editReply(await buildBuilderReply(token, session)).catch(() => {});
      return;
    }

    if (action === "fg" && interaction.isStringSelectMenu()) {
      await interaction.deferUpdate().catch(() => {});
      const sw = TEXT_SWATCHES.find(s => s.id === interaction.values[0]);
      if (sw) {
        session.styleId = CUSTOM_STYLE_ID;
        session.view = "custom";
        session.customTheme = {
          ...session.customTheme,
          textColor: sw.color,
          attributionColor: sw.color,
        };
        session.lastPng = undefined;
      }
      await interaction.editReply(await buildBuilderReply(token, session)).catch(() => {});
      return;
    }

    if (action === "gray" && interaction.isButton()) {
      await interaction.deferUpdate().catch(() => {});
      session.styleId = CUSTOM_STYLE_ID;
      session.view = "custom";
      session.customTheme = { ...session.customTheme, grayscale: !session.customTheme.grayscale };
      session.lastPng = undefined;
      await interaction.editReply(await buildBuilderReply(token, session)).catch(() => {});
      return;
    }

    if ((action === "edit" || action === "customtext") && interaction.isButton()) {
      const modal = new ModalBuilder()
        .setCustomId(`quote:modal:${token}`)
        .setTitle("Edit Quote")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("text")
              .setLabel("Quote text")
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
              .setMaxLength(500)
              .setValue(clip(session.payload?.text ?? "", 500)),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("name")
              .setLabel("Author display name")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(80)
              .setValue(clip(session.payload?.displayName ?? interaction.user.displayName, 80)),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("handle")
              .setLabel("Handle (without @)")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(32)
              .setValue(clip(session.payload?.handle ?? interaction.user.username, 32)),
          ),
        );
      await interaction.showModal(modal).catch(() => {});
      return;
    }

    if (action === "modal" && interaction.isModalSubmit()) {
      await interaction.deferUpdate().catch(() => {});
      const text = prepareQuoteText(interaction.fields.getTextInputValue("text"));
      const handle = interaction.fields.getTextInputValue("handle").trim().replace(/^@/, "") || interaction.user.username;
      const displayName = quoteDisplayName(
        interaction.fields.getTextInputValue("name").trim() || interaction.user.displayName,
        handle,
      );
      if (!session.payload) {
        const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
        session.payload = {
          text,
          displayName,
          handle,
          avatarUrl: member?.displayAvatarURL({ extension: "png", size: 512 })
            ?? interaction.user.displayAvatarURL({ extension: "png", size: 512 }),
          authorId: interaction.user.id,
          channelId: interaction.channelId ?? undefined,
        };
      } else {
        session.payload = { ...session.payload, text, displayName, handle };
      }
      session.view = "builder";
      session.lastPng = undefined;
      await interaction.editReply(await buildBuilderReply(token, session)).catch(() => {});
      return;
    }

    if (action === "reroll" && interaction.isButton()) {
      await interaction.deferUpdate().catch(() => {});
      session.lastPng = undefined;
      await interaction.editReply(await buildBuilderReply(token, session)).catch(() => {});
      return;
    }

    if (action === "save" && interaction.isButton()) {
      await interaction.deferReply(EPHEMERAL).catch(() => {});
      const png = session.lastPng ?? await renderPreview(session);
      if (!png) {
        await interaction.editReply({ content: "❌ Render failed — try another style." }).catch(() => {});
        return;
      }
      await interaction.editReply({
        content: "💾 **Saved** — download the image below (tap → … → Save Image / Download).",
        files: [new AttachmentBuilder(png, { name: QUOTE_FILE })],
      }).catch(() => {});
      return;
    }

    if (action === "post" && interaction.isButton()) {
      await interaction.deferReply(EPHEMERAL).catch(() => {});
      const png = session.lastPng ?? await renderPreview(session);
      if (!png || !interaction.channel || !interaction.channel.isTextBased()) {
        await interaction.editReply({ content: "❌ Couldn't post — render or channel failed." }).catch(() => {});
        return;
      }
      const file = new AttachmentBuilder(png, { name: QUOTE_FILE });
      const channel = interaction.channel;
      if (!channel || !channel.isTextBased() || channel.isDMBased() || !("send" in channel)) {
        await interaction.editReply({
          content: "❌ I couldn't post here. Here's your download instead:",
          files: [file],
        }).catch(() => {});
        return;
      }
      const guildChannel = channel as GuildTextBasedChannel;
      const posted =
        (await postQuoteAsPerson(guildChannel, interaction.client, {
          displayName: session.payload?.displayName ?? "someone",
          handle: session.payload?.handle,
          avatarURL: session.payload?.avatarUrl,
          files: [file],
        })) ??
        await guildChannel.send({ files: [file] }).catch((err: unknown) => {
          logger.warn({ err }, "quote: channel post failed");
          return null;
        });
      if (!posted) {
        await interaction.editReply({
          content: "❌ I couldn't post in this channel (missing **Attach Files** / **Manage Webhooks** / **Send Messages**?). Here's your download instead:",
          files: [file],
        }).catch(() => {});
        return;
      }
      await interaction.editReply({ content: `✅ Posted → ${posted.url}` }).catch(() => {});
      return;
    }
  } catch (err) {
    logger.error({ err, action }, "quote: interaction failed");
    try {
      const msg = "❌ Something went wrong building that quote.";
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: msg }).catch(() => {});
      } else {
        await interaction.reply({ content: msg, ...EPHEMERAL }).catch(() => {});
      }
    } catch { /* ignore */ }
  }
}

function isLight(hex: string): boolean {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  const n = parseInt(full.slice(0, 6), 16);
  if (Number.isNaN(n)) return false;
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 > 160;
}
