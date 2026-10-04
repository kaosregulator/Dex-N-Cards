/** Message / reaction hooks that advance auto-earned badges + XP. */

import type { Message, MessageReaction, PartialMessageReaction, PartialUser, User } from "discord.js";
import {
  configuredChannel,
  processCountedActivity,
  processReactionProgress,
  processStreakActivity,
  shouldShowEmblem,
} from "./engine.js";
import {
  getOrCreateBadgeSettings,
  getOrCreateMemberBadges,
  rulesForGuild,
  saveMemberBadges,
} from "../../lib/badges/db.js";
import { buildMultiBadgePayload } from "./announce.js";
import { logger } from "../../lib/logger.js";

export async function handleBadgeMessage(msg: Message): Promise<void> {
  if (!msg.guild || msg.author.bot) return;
  const guildId = msg.guild.id;
  const settings = await getOrCreateBadgeSettings(guildId);
  if (!settings.enabled) return;
  const rules = rulesForGuild(settings);
  const mention = `<@${msg.author.id}>`;

  const messageRules = rules.filter(r =>
    r.trigger === "messages"
    && configuredChannel(r, settings.trackChannelId, settings.tradeChannelId) === msg.channelId,
  );
  if (messageRules.length) {
    const results = await processCountedActivity({
      guildId,
      userId: msg.author.id,
      rulesToCount: messageRules,
      increment: 1,
      trigger: "messages",
    });
    await maybeAnnounce(msg, results, rules, mention);
  }

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
        const results = await processCountedActivity({
          guildId,
          userId: msg.author.id,
          rulesToCount: attachRules,
          increment: counted,
          trigger: "attachments",
        });
        await maybeAnnounce(msg, results, rules, mention);
      }
    }
  }

  const streakResults = await processStreakActivity({
    guildId,
    userId: msg.author.id,
  });
  if (streakResults.some(r => shouldShowEmblem(r) || r.leveled || r.unlocked)) {
    const payload = await buildMultiBadgePayload({
      results: streakResults,
      rules,
      mention,
    });
    if (payload && msg.channel.isTextBased() && "send" in msg.channel) {
      const sent = await msg.channel.send(payload).catch(() => null);
      if (sent) setTimeout(() => { void sent.delete().catch(() => {}); }, 55_000);
    }
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

  const results = await processReactionProgress({
    guildId: msg.guild.id,
    authorId: msg.author.id,
    messageId: msg.id,
    channelId: msg.channelId,
  });
  if (!results.length) return;
  const settings = await getOrCreateBadgeSettings(msg.guild.id);
  const rules = rulesForGuild(settings);
  const payload = await buildMultiBadgePayload({
    results,
    rules,
    mention: `<@${msg.author.id}>`,
  });
  if (!payload) return;
  const channel = msg.channel;
  if (channel.isTextBased() && "send" in channel) {
    await channel.send(payload).catch(() => {});
  }
}

async function maybeAnnounce(
  msg: Message,
  results: Awaited<ReturnType<typeof processCountedActivity>>,
  rules: ReturnType<typeof rulesForGuild>,
  mention: string,
): Promise<void> {
  if (!results.some(r => shouldShowEmblem(r) || r.unlocked || r.leveled)) return;
  const payload = await buildMultiBadgePayload({ results, rules, mention });
  if (!payload || !msg.channel.isTextBased() || !("send" in msg.channel)) return;
  const sent = await msg.channel.send(payload).catch(() => null);
  if (sent) {
    setTimeout(() => { void sent.delete().catch(() => {}); }, 55_000);
  }
}
