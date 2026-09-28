// Adapt a Discord Message into a ChatInputCommandInteraction-shaped proxy so
// existing slash handlers (casino / UB games) can run from prefix commands.

import type {
  ChatInputCommandInteraction,
  InteractionReplyOptions,
  Message,
  MessageCreateOptions,
  MessageEditOptions,
  MessagePayload,
} from "discord.js";
import { withOptionValues, type OptBag } from "./option-proxy.js";

type ReplyPayload = string | MessagePayload | InteractionReplyOptions;

function toMessageCreate(payload: ReplyPayload): string | MessageCreateOptions {
  if (typeof payload === "string") return payload;
  const p = payload as InteractionReplyOptions;
  return {
    content: p.content ?? undefined,
    embeds: p.embeds as MessageCreateOptions["embeds"],
    components: p.components as MessageCreateOptions["components"],
    files: p.files as MessageCreateOptions["files"],
    allowedMentions: p.allowedMentions,
  };
}

function toMessageEdit(payload: ReplyPayload): string | MessageEditOptions {
  if (typeof payload === "string") return payload;
  const p = payload as InteractionReplyOptions;
  return {
    content: p.content ?? undefined,
    embeds: p.embeds as MessageEditOptions["embeds"],
    components: p.components as MessageEditOptions["components"],
    files: p.files as MessageEditOptions["files"],
    allowedMentions: p.allowedMentions,
  };
}

/** Marker so webhook helpers can treat prefix runs differently (no clutter ack). */
export type PrefixChatProxy = ChatInputCommandInteraction & {
  __dnPrefixMessage: Message;
};

export function isPrefixChatProxy(interaction: object): interaction is PrefixChatProxy {
  return Boolean((interaction as { __dnPrefixMessage?: Message }).__dnPrefixMessage);
}

/**
 * Build a ChatInputCommandInteraction proxy backed by a guild message.
 * Ephemeral flags are ignored (prefix replies are always public in-channel).
 * UnbelievaBoat handlers still post public results via webhook as UB.
 */
export function messageAsChatInput(
  msg: Message,
  values: OptBag = {},
): PrefixChatProxy {
  let replyMsg: Message | null = null;
  let deferred = false;
  let replied = false;

  const fake = {
    id: msg.id,
    guildId: msg.guildId,
    guild: msg.guild,
    channel: msg.channel,
    channelId: msg.channelId,
    user: msg.author,
    member: msg.member,
    client: msg.client,
    createdTimestamp: msg.createdTimestamp,
    /** Source message — used by UB webhook helpers. */
    __dnPrefixMessage: msg,
    get deferred() { return deferred; },
    get replied() { return replied; },
    isChatInputCommand: () => true,
    isRepliable: () => true,
    async deferReply() {
      deferred = true;
    },
    async deferUpdate() {
      deferred = true;
    },
    async reply(payload: ReplyPayload) {
      replied = true;
      replyMsg = await msg.reply(toMessageCreate(payload));
      return replyMsg;
    },
    async editReply(payload: ReplyPayload) {
      const body = toMessageEdit(payload);
      if (replyMsg) {
        replyMsg = await replyMsg.edit(body);
        return replyMsg;
      }
      replied = true;
      replyMsg = await msg.reply(toMessageCreate(payload));
      return replyMsg;
    },
    async followUp(payload: ReplyPayload) {
      if (msg.channel.isSendable()) {
        return msg.channel.send(toMessageCreate(payload));
      }
      return msg.reply(toMessageCreate(payload));
    },
    async fetchReply() {
      if (!replyMsg) throw new Error("No reply to fetch");
      return replyMsg;
    },
    async deleteReply() {
      if (replyMsg) {
        await replyMsg.delete().catch(() => {});
        replyMsg = null;
      }
    },
  };

  return withOptionValues(fake, values) as PrefixChatProxy;
}
