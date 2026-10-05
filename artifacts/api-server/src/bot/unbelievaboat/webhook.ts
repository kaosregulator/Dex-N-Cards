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
        withComponents: true,
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

/**
 * Edit a prior webhook/bot message in-place (live reveals, BJ beats).
 * Prefer the owning webhook’s editMessage — Message#edit often fails on
 * webhook-authored floor posts, which left blackjack stuck on shuffle.
 */
export async function editUnbelievaBoatMessage(
  message: Message,
  opts: PostAsUnbelievaBoatOpts,
): Promise<Message | null> {
  const payload = {
    content: opts.content,
    embeds: opts.embeds,
    files: opts.files,
    components: opts.components,
    // Drop prior GIF attachment so the settle PNG (or next beat) is the only image.
    attachments: [],
    allowedMentions: UB_NO_ROLE_PINGS,
  };

  // Webhook-authored messages: edit via the webhook token.
  // Message#edit uses the channel endpoint and 403s on webhook posts — that left
  // blackjack stuck on the shuffle GIF forever after #191.
  if (message.webhookId) {
    try {
      const { host } = webhookHost(message.channel);
      const hook = host ? await resolveWebhook(message.client, host) : null;
      if (hook?.token && hook.id === message.webhookId) {
        return await hook.editMessage(message.id, {
          ...payload,
          // Required for interactive components on application webhooks.
          withComponents: true,
          threadId: message.channel.isThread() ? message.channel.id : undefined,
        });
      }
    } catch (err) {
      logger.debug({ err, messageId: message.id }, "UnbelievaBoat webhook editMessage failed");
    }
  }

  try {
    return await message.edit(payload);
  } catch (err) {
    logger.debug({ err, messageId: message.id }, "UnbelievaBoat message edit failed");
    return null;
  }
}

/**
 * Post as UnbelievaBoat via webhook. Returns the Message (for edit/settle),
 * or null when the caller should fall back to a normal bot reply.
 */
export async function postAsUnbelievaBoat(
  interaction: Interaction & { channel: Interaction["channel"] },
  opts: PostAsUnbelievaBoatOpts,
): Promise<Message | null> {
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
      // Keep Hit/Stand/etc on application-owned webhooks.
      withComponents: true,
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
    return sent;
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

  const posted = await postAsUnbelievaBoat(interaction, publicPayload);
  if (posted) {
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
 * Returns the floor Message (for animate→settle edits), or null on failure.
 */
export async function openTableAsUnbelievaBoat(
  interaction: Interaction & {
    deferred: boolean;
    replied: boolean;
    deferReply: (o?: object) => Promise<unknown>;
    editReply: (o: object) => Promise<unknown>;
    followUp: (o: object) => Promise<unknown>;
    fetchReply?: () => Promise<Message>;
    channel: Interaction["channel"];
  },
  publicPayload: PostAsUnbelievaBoatOpts,
  privateAck = "✅ Opened as **UnbelievaBoat** — play on the floor message.",
): Promise<Message | null> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true });
  }

  const posted = await postAsUnbelievaBoat(interaction, publicPayload);
  if (posted) {
    if (isPrefixChatProxy(interaction)) {
      await interaction.deleteReply().catch(() => {});
      await interaction.__dnPrefixMessage.react("✅").catch(() => {});
      return posted;
    }
    await interaction.editReply({ content: privateAck, embeds: [], components: [], files: [] });
    return posted;
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
    try {
      return await interaction.fetchReply?.() ?? null;
    } catch {
      return null;
    }
  }

  const follow = await interaction.followUp({
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
  return follow as Message;
}
