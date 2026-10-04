/** Message / reaction hooks that advance auto-earned badges. */

import type { Message, MessageReaction, PartialMessageReaction, PartialUser, User } from "discord.js";
import {
  configuredChannel,
  formatBadgeNames,
  processCountedActivity,
  processReactionProgress,
  processStreakActivity,
} from "./engine.js";
import {
  getOrCreateBadgeSettings,
  getOrCreateMemberBadges,
  rulesForGuild,
  saveMemberBadges,
} from "../../lib/badges/db.js";
import { logger } from "../../lib/logger.js";

export async function handleBadgeMessage(msg: Message): Promise<void> {
  if (!msg.guild || msg.author.bot) return;
  const guildId = msg.guild.id;
  const settings = await getOrCreateBadgeSettings(guildId);
  if (!settings.enabled) return;
  const rules = rulesForGuild(settings);

  // Message-count badges (channel-scoped).
  const messageRules = rules.filter(r =>
    r.trigger === "messages"
    && configuredChannel(r, settings.trackChannelId, settings.tradeChannelId) === msg.channelId,
  );
  if (messageRules.length) {
    const newly = await processCountedActivity({
      guildId,
      userId: msg.author.id,
      rulesToCount: messageRules,
      increment: 1,
    });
    if (newly.length) {
      await announce(msg, newly, rules);
    }
  }

  // Attachment badges (channel-scoped, with cooldown + per-post cap).
  if (msg.attachments.size > 0) {
    const attachRules = rules.filter(r =>
      r.trigger === "attachments"
      && configuredChannel(r, settings.trackChannelId, settings.tradeChannelId) === msg.channelId,
    );
    if (attachRules.length) {
      const member = await getOrCreateMemberBadges(guildId, msg.author.id);
      const now = Date.now();
      if (!member.tradeCooldownUntil || member.tradeCooldownUntil.getTime() <= now) {
        const maxPerPost = Math.max(1, Math.min(10, settings.maxAttachmentsPerPost || 3));
        const counted = Math.min(msg.attachments.size, maxPerPost);
        const cooldownSeconds = Math.max(0, Math.min(300, settings.uploadCooldownSeconds || 0));
        if (cooldownSeconds > 0) {
          await saveMemberBadges(guildId, msg.author.id, {
            tradeCooldownUntil: new Date(now + cooldownSeconds * 1000),
          });
        }
        const newly = await processCountedActivity({
          guildId,
          userId: msg.author.id,
          rulesToCount: attachRules,
          increment: counted,
        });
        if (newly.length) {
          await announce(msg, newly, rules, counted);
        }
      }
    }
  }

  // Streak badges (any channel in the guild).
  const streakAwarded = await processStreakActivity({
    guildId,
    userId: msg.author.id,
  });
  if (streakAwarded.length) {
    const member = await getOrCreateMemberBadges(guildId, msg.author.id);
    await msg.reply({
      content: `🎉 You earned ${formatBadgeNames(streakAwarded, rules)}! (${member.streak} active days in a row)`,
      allowedMentions: { users: [msg.author.id] },
    }).catch(() => {});
  }
}

export async function handleBadgeReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): Promise<void> {
  if (user.bot) return;
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
  } catch (err) {
    logger.debug({ err }, "badge reaction fetch failed");
    return;
  }
  const msg = reaction.message;
  if (!msg.guild || !msg.author || msg.author.bot) return;
  if (user.id === msg.author.id) return;

  const newly = await processReactionProgress({
    guildId: msg.guild.id,
    authorId: msg.author.id,
    messageId: msg.id,
    channelId: msg.channelId,
  });
  if (!newly.length) return;
  const settings = await getOrCreateBadgeSettings(msg.guild.id);
  const rules = rulesForGuild(settings);
  const channel = msg.channel;
  if (channel.isTextBased() && "send" in channel) {
    await channel.send({
      content: `🎉 <@${msg.author.id}> earned ${formatBadgeNames(newly, rules)}!`,
    }).catch(() => {});
  }
}

async function announce(
  msg: Message,
  newly: string[],
  rules: ReturnType<typeof rulesForGuild>,
  increment?: number,
): Promise<void> {
  const suffix = increment != null ? ` (${increment} qualifying activity counted)` : "";
  if (!msg.channel.isTextBased() || !("send" in msg.channel)) return;
  const sent = await msg.channel.send({
    content: `🎉 <@${msg.author.id}> earned ${formatBadgeNames(newly, rules)}!${suffix}`,
  }).catch(() => null);
  if (sent) {
    setTimeout(() => {
      void sent.delete().catch(() => {});
    }, 40_000);
  }
}
