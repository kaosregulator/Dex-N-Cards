// ─────────────────────────────────────────────────────────────────────────────
// Post finished quotes as a channel webhook using the quoted person's name +
// avatar (same pattern as AFK speak-as-user / UnbelievaBoat economy).
// Needs Manage Webhooks; falls back to a normal bot channel.send.
// ─────────────────────────────────────────────────────────────────────────────

import {
  ChannelType, PermissionFlagsBits,
  type Client, type Webhook, type TextChannel, type NewsChannel, type ThreadChannel,
  type GuildTextBasedChannel, type Message, type EmbedBuilder, type AttachmentBuilder,
} from "discord.js";
import { logger } from "../../lib/logger.js";
import { sanitizeWebhookName } from "../afk/speak-as-user.js";
import { quoteDisplayName } from "./display-name.js";

const WEBHOOK_NAME = "DN Quotes";
const webhookCache = new Map<string, Webhook | null>();

type WebhookCapableChannel = TextChannel | NewsChannel;

function webhookHost(channel: GuildTextBasedChannel | Message["channel"]): {
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
      logger.debug({ channelId: host.id }, "quote webhook: missing Manage Webhooks");
      webhookCache.set(host.id, null);
      return null;
    }
    const existing = await host.fetchWebhooks();
    hook = existing.find(w => w.name === WEBHOOK_NAME && w.owner?.id === client.user?.id) ?? null;
    if (!hook) {
      hook = await host.createWebhook({
        name: WEBHOOK_NAME,
        reason: "Post /quote cards as the quoted member",
      });
    }
  } catch (err) {
    logger.debug({ err, channelId: host.id }, "quote webhook unavailable");
    hook = null;
  }
  webhookCache.set(host.id, hook);
  return hook;
}

function forgetWebhook(channelId: string): void {
  webhookCache.delete(channelId);
}

export type PostQuoteAsPersonOpts = {
  /** Display name / nick of the person to appear as. */
  displayName: string;
  /** Plain @username fallback for Discord's webhook name rules + unstyling. */
  handle?: string | null;
  avatarURL?: string | null;
  content?: string;
  files?: AttachmentBuilder[];
  embeds?: EmbedBuilder[];
};

/**
 * Post as the quoted person via webhook. Returns the sent message, or null so
 * the caller can fall back to `channel.send` as the bot.
 */
export async function postQuoteAsPerson(
  channel: GuildTextBasedChannel,
  client: Client,
  opts: PostQuoteAsPersonOpts,
): Promise<Message | null> {
  const { host, threadId } = webhookHost(channel);
  if (!host) return null;

  const hook = await resolveWebhook(client, host);
  if (!hook) return null;

  const username = sanitizeWebhookName(quoteDisplayName(opts.displayName, opts.handle));
  const avatarURL = opts.avatarURL ?? undefined;

  try {
    const sent = await hook.send({
      username,
      avatarURL,
      content: opts.content,
      files: opts.files,
      embeds: opts.embeds,
      ...(threadId ? { threadId } : {}),
      allowedMentions: { parse: [] },
    });
    return sent;
  } catch (err) {
    forgetWebhook(host.id);
    logger.debug({ err, channelId: host.id }, "quote webhook send failed");
    return null;
  }
}
