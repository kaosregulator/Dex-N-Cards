// Post public UnbelievaBoat economy messages as a channel webhook that looks
// like UnbelievaBoat (name + avatar). Ephemeral admin replies stay as DN bot.
// Pattern mirrors AFK speak-as-user — Manage Webhooks required; falls back.
//
// Interactive floors (BJ, lottery reveals, …) MUST edit through the same
// webhook token that posted the message. Message#edit uses the channel API and
// cannot update webhook-authored posts.

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

/** messageId → webhook that authored the floor post (keeps token for edits). */
type FloorBinding = { hook: Webhook; threadId?: string };
const floorBindings = new Map<string, FloorBinding>();

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

function bindFloor(message: Message, hook: Webhook, threadId?: string) {
  if (!hook.token) return;
  floorBindings.set(message.id, {
    hook,
    threadId: threadId ?? (message.channel.isThread() ? message.channel.id : undefined),
  });
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

/** Resolve the webhook (with token) that owns this floor message. */
async function resolveHookForMessage(message: Message): Promise<FloorBinding | null> {
  const bound = floorBindings.get(message.id);
  if (bound?.hook?.token) return bound;

  if (!message.webhookId) return null;

  const { host, threadId } = webhookHost(message.channel);
  if (!host) return null;

  // Prefer a fresh fetch so we always have a token for bot-owned webhooks.
  webhookCache.delete(host.id);
  const hook = await resolveWebhook(message.client, host);
  if (hook?.token && hook.id === message.webhookId) {
    const binding: FloorBinding = {
      hook,
      threadId: message.channel.isThread() ? message.channel.id : threadId,
    };
    floorBindings.set(message.id, binding);
    return binding;
  }

  // Last resort: scan channel webhooks for this id (token included when we own it).
  try {
    const all = await host.fetchWebhooks();
    const owned = all.get(message.webhookId) ?? all.find(w => w.id === message.webhookId);
    if (owned?.token) {
      webhookCache.set(host.id, owned);
      const binding: FloorBinding = {
        hook: owned,
        threadId: message.channel.isThread() ? message.channel.id : threadId,
      };
      floorBindings.set(message.id, binding);
      return binding;
    }
  } catch (err) {
    logger.debug({ err, messageId: message.id }, "UnbelievaBoat webhook re-fetch failed");
  }
  return null;
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

function discordErrCode(err: unknown): number | string | undefined {
  return (err as { code?: number | string })?.code;
}

function isRetryableDiscordErr(err: unknown): boolean {
  const code = discordErrCode(err);
  const status = (err as { status?: number })?.status;
  // 429 rate limit, 5xx, Discord gateway blips
  if (status === 429 || (typeof status === "number" && status >= 500)) return true;
  if (code === 429 || code === 500 || code === 502 || code === 503 || code === 504) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNRESET|ETIMEDOUT|socket hang up|rate limit/i.test(msg);
}

/** Stale cache / rotated webhook — drop binding and re-resolve on next attempt. */
function isStaleWebhookErr(err: unknown): boolean {
  const code = discordErrCode(err);
  // 10015 Unknown Webhook, 50027 Invalid Webhook Token
  return code === 10015 || code === 50027;
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
      bindFloor(sent, hook);
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
 * Webhook floors are always edited via the owning webhook token — never
 * Message#edit (channel API), which cannot update webhook-authored posts.
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
    // Drop prior GIF so the next beat / PNG is the only image.
    attachments: [] as [],
    allowedMentions: UB_NO_ROLE_PINGS,
    withComponents: true as const,
  };

  if (message.webhookId) {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      const binding = await resolveHookForMessage(message);
      if (!binding?.hook.token) {
        logger.warn(
          { messageId: message.id, webhookId: message.webhookId, attempt },
          "UnbelievaBoat floor edit: no webhook token — cannot update webhook message",
        );
        // One more resolve pass after a short wait (webhook create race).
        if (attempt < 3) {
          await sleep(150 * 2 ** attempt);
          continue;
        }
        return null;
      }

      try {
        const edited = await binding.hook.editMessage(message.id, {
          content: payload.content,
          embeds: payload.embeds,
          files: payload.files,
          components: payload.components,
          attachments: payload.attachments,
          allowedMentions: payload.allowedMentions,
          withComponents: true,
          threadId: binding.threadId,
        });
        // Keep binding alive across edits.
        bindFloor(edited, binding.hook, binding.threadId);
        return edited;
      } catch (err) {
        lastErr = err;
        if (isStaleWebhookErr(err)) {
          floorBindings.delete(message.id);
          const { host } = webhookHost(message.channel);
          if (host) webhookCache.delete(host.id);
          if (attempt < 3) {
            await sleep(100 * 2 ** attempt);
            continue;
          }
          break;
        }
        if (attempt < 3 && isRetryableDiscordErr(err)) {
          // Honour Retry-After when present.
          const retryAfter = Number((err as { retryAfter?: number })?.retryAfter);
          await sleep(
            Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.ceil(retryAfter * 1000) + 50
              : 200 * 2 ** attempt,
          );
          continue;
        }
        break;
      }
    }
    logger.warn(
      { err: lastErr, messageId: message.id, webhookId: message.webhookId },
      "UnbelievaBoat webhook editMessage failed after retries",
    );
    return null;
  }

  // Bot-authored fallback floor (no webhook).
  try {
    return await message.edit({
      content: payload.content,
      embeds: payload.embeds,
      files: payload.files,
      components: payload.components,
      attachments: [],
      allowedMentions: payload.allowedMentions,
    });
  } catch (err) {
    if (isRetryableDiscordErr(err)) {
      await sleep(300);
      try {
        return await message.edit({
          content: payload.content,
          embeds: payload.embeds,
          files: payload.files,
          components: payload.components,
          attachments: [],
          allowedMentions: payload.allowedMentions,
        });
      } catch (err2) {
        logger.debug({ err: err2, messageId: message.id }, "UnbelievaBoat bot message edit failed");
        return null;
      }
    }
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
    bindFloor(sent, hook, threadId);
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
