// Post public UnbelievaBoat economy messages as a channel webhook that looks
// like UnbelievaBoat (name + avatar). Ephemeral admin replies stay as DN bot.
// Pattern mirrors AFK speak-as-user — Manage Webhooks required; falls back.

import {
  ChannelType, PermissionFlagsBits,
  type Client, type Webhook, type TextChannel, type NewsChannel, type ThreadChannel,
  type Interaction, type EmbedBuilder, type AttachmentBuilder,
  type ActionRowBuilder, type MessageActionRowComponentBuilder,
  type Message,
} from "discord.js";
import { logger } from "../../lib/logger.js";
import { isPrefixChatProxy } from "../commands/message-as-chat.js";
import {
  UNBELIEVABOAT_ICON,
  UNBELIEVABOAT_WEBHOOK_USERNAME,
} from "./branding.js";

const WEBHOOK_NAME = "UnbelievaBoat Economy";
const webhookCache = new Map<string, Webhook | null>();

/**
 * Show `<@&role>` pills in embeds/content, but never notify role holders.
 * Users still resolve (e.g. collect receipts mention the collector).
 */
export const UB_NO_ROLE_PINGS = {
  parse: ["users"] as ("users")[],
  roles: [] as string[],
};

type WebhookCapableChannel = TextChannel | NewsChannel;

function webhookHost(channel: Interaction["channel"] | Message["channel"]): {
  host: WebhookCapableChannel | null;
  threadId?: string;
} {
  if (!channel || channel.isDMBased()) return { host: null };
  if (
    channel.type === ChannelType.PublicThread ||
    channel.type === ChannelType.PrivateThread ||
    channel.type === ChannelType.AnnouncementThread
  ) {
    const thread = channel as ThreadChannel;
    const parent = thread.parent;
    if (parent && (parent.type === ChannelType.GuildText || parent.type === ChannelType.GuildAnnouncement)) {
      return { host: parent as WebhookCapableChannel, threadId: thread.id };
    }
    return { host: null };
  }
  if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) {
    return { host: channel as WebhookCapableChannel };
  }
  return { host: null };
}

async function resolveWebhook(client: Client, host: WebhookCapableChannel): Promise<Webhook | null> {
  const cached = webhookCache.get(host.id);
  if (cached !== undefined) return cached;

  let hook: Webhook | null = null;
  try {
    const me = host.guild.members.me ?? await host.guild.members.fetchMe().catch(() => null);
    if (!me || !host.permissionsFor(me)?.has(PermissionFlagsBits.ManageWebhooks)) {
      webhookCache.set(host.id, null);
      return null;
    }
    const existing = await host.fetchWebhooks();
    hook = existing.find(w => w.name === WEBHOOK_NAME && w.owner?.id === client.user?.id) ?? null;
    if (!hook) {
      hook = await host.createWebhook({
        name: WEBHOOK_NAME,
        avatar: UNBELIEVABOAT_ICON,
        reason: "Post UnbelievaBoat economy games & store as UnbelievaBoat",
      });
    }
  } catch (err) {
    logger.debug({ err, channelId: host.id }, "UnbelievaBoat webhook unavailable");
    hook = null;
  }
  webhookCache.set(host.id, hook);
  return hook;
}

export type PostAsUnbelievaBoatOpts = {
  embeds?: EmbedBuilder[];
  content?: string;
  files?: AttachmentBuilder[];
  components?: ActionRowBuilder<MessageActionRowComponentBuilder>[];
  /** Prefer follow-up when the interaction was already deferred/replied. */
  ephemeralFallback?: boolean;
  /**
   * Public tip so bystanders know the slash to run, e.g. "/blackjack_ub bet:100".
   * Appended to the first embed description.
   */
  slashHint?: string;
};

/**
 * Post to a channel as UnbelievaBoat (webhook), for admin draws / boards that
 * are not tied to an interaction reply. Falls back to a normal channel send.
 */
export async function sendChannelAsUnbelievaBoat(
  client: Client,
  channel: TextChannel | NewsChannel,
  opts: PostAsUnbelievaBoatOpts,
): Promise<Message | null> {
  const hook = await resolveWebhook(client, channel);
  if (hook) {
    try {
      const sent = await hook.send({
        username: UNBELIEVABOAT_WEBHOOK_USERNAME,
        avatarURL: UNBELIEVABOAT_ICON,
        content: opts.content,
        embeds: opts.embeds,
        files: opts.files,
        components: opts.components,
        allowedMentions: UB_NO_ROLE_PINGS,
      });
      return sent;
    } catch (err) {
      webhookCache.delete(channel.id);
      logger.debug({ err, channelId: channel.id }, "UnbelievaBoat channel webhook send failed");
    }
  }
  try {
    return await channel.send({
      content: opts.content,
      embeds: opts.embeds,
      files: opts.files,
      components: opts.components,
      allowedMentions: UB_NO_ROLE_PINGS,
    });
  } catch (err) {
    logger.debug({ err, channelId: channel.id }, "UnbelievaBoat channel fallback send failed");
    return null;
  }
}

/** Edit a prior webhook/bot message in-place (used for live ball reveals). */
export async function editUnbelievaBoatMessage(
  message: Message,
  opts: PostAsUnbelievaBoatOpts,
): Promise<Message | null> {
  try {
    return await message.edit({
      content: opts.content,
      embeds: opts.embeds,
      files: opts.files,
      components: opts.components,
    });
  } catch (err) {
    logger.debug({ err, messageId: message.id }, "UnbelievaBoat message edit failed");
    return null;
  }
}

/**
 * Post as UnbelievaBoat via webhook. Returns the message id, or null when the
 * caller should fall back to a normal bot reply on the interaction.
 */
export async function postAsUnbelievaBoat(
  interaction: Interaction & { channel: Interaction["channel"] },
  opts: PostAsUnbelievaBoatOpts,
): Promise<string | null> {
  const { host, threadId } = webhookHost(interaction.channel);
  if (!host || !interaction.client) return null;

  const hook = await resolveWebhook(interaction.client, host);
  if (!hook) return null;

  // Stamp slash tip on the first embed so bystanders know the slash shortcut too.
  if (opts.slashHint && opts.embeds?.[0]) {
    const tip = `_▶️ Or use \`${opts.slashHint}\` · all tables: \`/casino\`_`;
    const emb = opts.embeds[0];
    const desc = emb.data.description ?? "";
    if (!desc.includes(opts.slashHint)) {
      emb.setDescription(desc ? `${desc}\n\n${tip}` : tip);
    }
  }

  try {
    const sent = await hook.send({
      username: UNBELIEVABOAT_WEBHOOK_USERNAME,
      avatarURL: UNBELIEVABOAT_ICON,
      content: opts.content,
      embeds: opts.embeds,
      files: opts.files,
      components: opts.components,
      ...(threadId ? { threadId } : {}),
      allowedMentions: UB_NO_ROLE_PINGS,
    });
    // Interactive tables need buttons. If Discord dropped components (rare with
    // large file uploads), treat as failure so the caller can fall back to a
    // bot-owned message where Hit/Stand/Pull Trigger always stick.
    const wantedRows = opts.components?.length ?? 0;
    if (wantedRows > 0 && (sent.components?.length ?? 0) === 0) {
      await sent.delete().catch(() => {});
      logger.debug({ channelId: host.id }, "UnbelievaBoat webhook dropped components — falling back");
      return null;
    }
    return sent.id;
  } catch (err) {
    webhookCache.delete(host.id);
    logger.debug({ err, channelId: host.id }, "UnbelievaBoat webhook send failed");
    return null;
  }
}

/** Acknowledge privately, then post the public UnbelievaBoat webhook message. */
export async function replyThenPostAsUnbelievaBoat(
  interaction: Interaction & {
    deferred: boolean;
    replied: boolean;
    deferReply: (o?: object) => Promise<unknown>;
    editReply: (o: object) => Promise<unknown>;
    followUp: (o: object) => Promise<unknown>;
    channel: Interaction["channel"];
  },
  publicPayload: PostAsUnbelievaBoatOpts,
  privateAck = "✅ Posted as **UnbelievaBoat**.",
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true });
  }

  const id = await postAsUnbelievaBoat(interaction, publicPayload);
  if (id) {
    // Prefix (`.daily`): react on the command — no clutter "Posted as UB" reply.
    if (isPrefixChatProxy(interaction)) {
      await interaction.deleteReply().catch(() => {});
      await interaction.__dnPrefixMessage.react("✅").catch(() => {});
      return;
    }
    await interaction.editReply({ content: privateAck, embeds: [], components: [], files: [] });
    return;
  }

  // Fallback: bot message (still branded via embed author).
  // Must set allowedMentions — Discord defaults can ping roles otherwise.
  await interaction.editReply({
    content: undefined,
    embeds: publicPayload.embeds ?? [],
    files: publicPayload.files ?? [],
    components: publicPayload.components ?? [],
    allowedMentions: UB_NO_ROLE_PINGS,
  });
}

/**
 * Open an interactive floor table as UnbelievaBoat (webhook + buttons).
 * Private ephemeral ack; buttons live on the webhook message so later
 * deferUpdate/editReply keeps the UnbelievaBoat author.
 * Returns the webhook message id, or null when falling back to a public bot follow-up.
 */
export async function openTableAsUnbelievaBoat(
  interaction: Interaction & {
    deferred: boolean;
    replied: boolean;
    deferReply: (o?: object) => Promise<unknown>;
    editReply: (o: object) => Promise<unknown>;
    followUp: (o: object) => Promise<unknown>;
    channel: Interaction["channel"];
  },
  publicPayload: PostAsUnbelievaBoatOpts,
  privateAck = "✅ Opened as **UnbelievaBoat** — play on the floor message.",
): Promise<string | null> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true });
  }

  const id = await postAsUnbelievaBoat(interaction, publicPayload);
  if (id) {
    if (isPrefixChatProxy(interaction)) {
      await interaction.deleteReply().catch(() => {});
      await interaction.__dnPrefixMessage.react("✅").catch(() => {});
      return id;
    }
    await interaction.editReply({ content: privateAck, embeds: [], components: [], files: [] });
    return id;
  }

  // Webhook unavailable — public follow-up so the floor can still play.
  if (isPrefixChatProxy(interaction)) {
    await interaction.editReply({
      content: undefined,
      embeds: publicPayload.embeds ?? [],
      files: publicPayload.files ?? [],
      components: publicPayload.components ?? [],
      allowedMentions: UB_NO_ROLE_PINGS,
    });
    return null;
  }

  await interaction.followUp({
    embeds: publicPayload.embeds ?? [],
    files: publicPayload.files ?? [],
    components: publicPayload.components ?? [],
    allowedMentions: UB_NO_ROLE_PINGS,
  });
  await interaction.editReply({
    content: "_Webhook unavailable — table posted as bot fallback._",
    embeds: [],
    components: [],
    files: [],
  }).catch(() => {});
  return null;
}
