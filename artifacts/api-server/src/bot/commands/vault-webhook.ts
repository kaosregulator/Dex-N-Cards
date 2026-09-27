// Public /vaultvalue posts as a channel webhook branded like each value site.
// Auto-deletes after ~45s (refreshed on each interaction). Falls back to bot
// messages when Manage Webhooks is missing.

import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type Webhook,
  type TextChannel,
  type NewsChannel,
  type ThreadChannel,
  type Interaction,
  type EmbedBuilder,
  type AttachmentBuilder,
  type ActionRowBuilder,
  type MessageActionRowComponentBuilder,
  type Message,
} from "discord.js";
import { logger } from "../../lib/logger.js";
import { getVaultBrand, type VaultBrandId } from "./vault-branding.js";

const WEBHOOK_NAME = "Vault Values";
/** Public floor messages linger this long after the last touch. */
export const VAULT_MSG_TTL_MS = 45_000;

const webhookCache = new Map<string, Webhook | null>();
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

type WebhookCapableChannel = TextChannel | NewsChannel;

function webhookHost(channel: Interaction["channel"] | Message["channel"] | null): {
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
    hook = existing.find((w) => w.name === WEBHOOK_NAME && w.owner?.id === client.user?.id) ?? null;
    if (!hook) {
      const brand = getVaultBrand("valuevaultx");
      hook = await host.createWebhook({
        name: WEBHOOK_NAME,
        avatar: brand.logoUrl,
        reason: "Post Vault Values lookups & browse as the live value sites",
      });
    }
  } catch (err) {
    logger.debug({ err, channelId: host.id }, "Vault webhook unavailable");
    hook = null;
  }
  webhookCache.set(host.id, hook);
  return hook;
}

function cleanupKey(channelId: string, messageId: string): string {
  return `${channelId}:${messageId}`;
}

/** Cancel a pending auto-delete (e.g. before editing / replacing the message). */
export function cancelVaultCleanup(channelId: string, messageId: string): void {
  const key = cleanupKey(channelId, messageId);
  const t = cleanupTimers.get(key);
  if (t) {
    clearTimeout(t);
    cleanupTimers.delete(key);
  }
}

/**
 * Delete a vault floor message after `ttlMs` (default 45s).
 * Prefer webhook.deleteMessage so we don't need Manage Messages.
 */
export function scheduleVaultCleanup(
  client: Client,
  channelId: string,
  messageId: string,
  ttlMs = VAULT_MSG_TTL_MS,
): void {
  cancelVaultCleanup(channelId, messageId);
  const key = cleanupKey(channelId, messageId);
  const timer = setTimeout(() => {
    cleanupTimers.delete(key);
    void (async () => {
      try {
        const ch = await client.channels.fetch(channelId).catch(() => null);
        if (!ch || !("messages" in ch)) return;
        const msg = await (ch as TextChannel).messages.fetch(messageId).catch(() => null);
        if (!msg) return;
        if (msg.webhookId) {
          const { host, threadId } = webhookHost(msg.channel);
          if (host) {
            const hook = await resolveWebhook(client, host);
            if (hook && hook.id === msg.webhookId) {
              await hook.deleteMessage(messageId, threadId);
              return;
            }
          }
        }
        await msg.delete().catch(() => {});
      } catch (err) {
        logger.debug({ err: (err as Error).message, messageId }, "Vault cleanup delete failed");
      }
    })();
  }, ttlMs);
  timer.unref?.();
  cleanupTimers.set(key, timer);
}

export type VaultWebhookPayload = {
  embeds?: EmbedBuilder[];
  content?: string;
  files?: AttachmentBuilder[];
  components?: ActionRowBuilder<MessageActionRowComponentBuilder>[];
};

export type VaultWebhookRef = {
  messageId: string;
  channelId: string;
  viaWebhook: boolean;
};

/** Brand an embed with site author (name+logo) and top-right thumbnail. */
export function applyVaultBrand(
  embed: EmbedBuilder,
  siteId: VaultBrandId | string,
  opts?: { useBanner?: boolean },
): EmbedBuilder {
  const brand = getVaultBrand(siteId);
  embed
    .setColor(brand.color)
    .setAuthor({ name: brand.name, iconURL: brand.logoUrl, url: brand.url })
    .setThumbnail(brand.logoUrl);
  if (opts?.useBanner && !embed.data.image?.url) {
    embed.setImage(brand.bannerUrl);
  }
  return embed;
}

export async function postVaultWebhook(
  interaction: Interaction & { channel: Interaction["channel"]; client: Client },
  siteId: VaultBrandId | string,
  payload: VaultWebhookPayload,
  opts?: { ttlMs?: number },
): Promise<VaultWebhookRef | null> {
  const brand = getVaultBrand(siteId);
  const { host, threadId } = webhookHost(interaction.channel);
  if (!host) return null;

  const hook = await resolveWebhook(interaction.client, host);
  if (!hook) return null;

  try {
    const sent = await hook.send({
      username: brand.name.slice(0, 80),
      avatarURL: brand.logoUrl,
      content: payload.content,
      embeds: payload.embeds,
      files: payload.files,
      components: payload.components,
      ...(threadId ? { threadId } : {}),
      allowedMentions: { parse: [] },
    });
    const channelId = interaction.channelId!;
    scheduleVaultCleanup(interaction.client, channelId, sent.id, opts?.ttlMs ?? VAULT_MSG_TTL_MS);
    return { messageId: sent.id, channelId, viaWebhook: true };
  } catch (err) {
    webhookCache.delete(host.id);
    logger.debug({ err, channelId: host.id }, "Vault webhook send failed");
    return null;
  }
}

/** Edit an existing vault floor message (keeps site webhook author) and refresh TTL. */
export async function editVaultWebhookMessage(
  client: Client,
  channelId: string,
  messageId: string,
  siteId: VaultBrandId | string,
  payload: VaultWebhookPayload,
  opts?: { ttlMs?: number },
): Promise<boolean> {
  const brand = getVaultBrand(siteId);
  try {
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (!ch || !("messages" in ch)) return false;
    const msg = await (ch as TextChannel).messages.fetch(messageId).catch(() => null);
    if (!msg) return false;

    if (msg.webhookId) {
      const { host, threadId } = webhookHost(msg.channel);
      if (host) {
        const hook = await resolveWebhook(client, host);
        if (hook && hook.id === msg.webhookId) {
          await hook.editMessage(messageId, {
            content: payload.content ?? null,
            embeds: payload.embeds ?? [],
            files: payload.files ?? [],
            components: payload.components ?? [],
            ...(threadId ? { threadId } : {}),
          });
          // Username/avatar stick from original send; re-brand via embeds.
          void brand;
          scheduleVaultCleanup(client, channelId, messageId, opts?.ttlMs ?? VAULT_MSG_TTL_MS);
          return true;
        }
      }
    }

    await msg.edit({
      content: payload.content,
      embeds: payload.embeds,
      files: payload.files,
      components: payload.components,
    });
    scheduleVaultCleanup(client, channelId, messageId, opts?.ttlMs ?? VAULT_MSG_TTL_MS);
    return true;
  } catch (err) {
    logger.debug({ err: (err as Error).message, messageId }, "Vault webhook edit failed");
    return false;
  }
}

/**
 * Ephemeral ack on the interaction, then post a public site-branded webhook.
 * If webhook fails, falls back to a public bot follow-up (still branded embeds).
 */
export async function ackThenPostVault(
  interaction: Interaction & {
    deferred: boolean;
    replied: boolean;
    deferReply: (o?: object) => Promise<unknown>;
    editReply: (o: object) => Promise<unknown>;
    followUp: (o: object) => Promise<unknown>;
    channel: Interaction["channel"];
    client: Client;
    channelId: string | null;
  },
  siteId: VaultBrandId | string,
  payload: VaultWebhookPayload,
  privateAck?: string,
): Promise<VaultWebhookRef | null> {
  const brand = getVaultBrand(siteId);
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true });
  }

  const ref = await postVaultWebhook(interaction, siteId, payload);
  if (ref) {
    await interaction.editReply({
      content: privateAck ?? `✅ Posted as **${brand.name}** · cleans up in ~45s`,
      embeds: [],
      components: [],
      files: [],
    }).catch(() => {});
    return ref;
  }

  // Fallback: public bot message
  const sent = await interaction.followUp({
    content: payload.content,
    embeds: payload.embeds ?? [],
    files: payload.files ?? [],
    components: payload.components ?? [],
  }) as Message;
  if (interaction.channelId) {
    scheduleVaultCleanup(interaction.client, interaction.channelId, sent.id);
  }
  await interaction.editReply({
    content: `_Webhook unavailable — posted as bot. Ask an admin for **Manage Webhooks**._`,
    embeds: [],
    components: [],
    files: [],
  }).catch(() => {});
  return { messageId: sent.id, channelId: interaction.channelId!, viaWebhook: false };
}

/** Touch TTL when the user clicks buttons on an existing floor message. */
export function refreshVaultCleanup(
  client: Client,
  channelId: string,
  messageId: string,
  ttlMs = VAULT_MSG_TTL_MS,
): void {
  scheduleVaultCleanup(client, channelId, messageId, ttlMs);
}
