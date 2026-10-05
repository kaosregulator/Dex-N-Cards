// Universal Discord channel logger — best-effort, never throws into gameplay.
// Categories: economy | games | trades | quiet | admin | bot
// Channel is set via /unbelievaboat → Logs.

import {
  EmbedBuilder, AttachmentBuilder,
  type Client, type TextChannel, type User, type ColorResolvable,
} from "discord.js";
import { logger } from "../../lib/logger.js";
import { getOrCreateUbSettings } from "../../lib/unbelievaboat/db.js";
import { BRAND_NAME, BRAND_COLOR } from "../help-banners.js";
import { UNBELIEVABOAT_AUTHOR, UNBELIEVABOAT_COLOR } from "../unbelievaboat/branding.js";

export type LogCategory = "economy" | "games" | "trades" | "quiet" | "admin" | "bot";

const CATEGORY_COLOR: Record<LogCategory, number> = {
  economy: 0xf1c40f,
  games: UNBELIEVABOAT_COLOR,
  trades: 0x2ecc71,
  quiet: 0x5865f2,
  admin: 0xeb459e,
  bot: BRAND_COLOR,
};

const CATEGORY_LABEL: Record<LogCategory, string> = {
  economy: "Economy",
  games: "Casino / Games",
  trades: "Trades",
  quiet: "Sanctuary",
  admin: "Admin",
  bot: BRAND_NAME,
};

export type ChannelLogOpts = {
  guildId: string;
  category: LogCategory;
  title: string;
  description: string;
  user?: User | null;
  fields?: { name: string; value: string; inline?: boolean }[];
  image?: { buffer: Buffer; name: string };
  color?: ColorResolvable;
};

async function resolveLogChannelId(guildId: string): Promise<string | null> {
  try {
    const ub = await getOrCreateUbSettings(guildId);
    if (ub.logChannelId) return ub.logChannelId;
  } catch { /* fall through */ }
  return null;
}

export async function postChannelLog(client: Client, opts: ChannelLogOpts): Promise<void> {
  try {
    const channelId = await resolveLogChannelId(opts.guildId);
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    const embed = new EmbedBuilder()
      .setColor((opts.color as number) ?? CATEGORY_COLOR[opts.category])
      .setAuthor(
        opts.category === "games" || opts.category === "economy"
          ? UNBELIEVABOAT_AUTHOR
          : { name: `${BRAND_NAME} · ${CATEGORY_LABEL[opts.category]}` },
      )
      .setTitle(opts.title)
      .setDescription(opts.description.slice(0, 4000))
      .setTimestamp(new Date())
      .setFooter({ text: `${CATEGORY_LABEL[opts.category]} log` });

    if (opts.user) {
      embed.setThumbnail(opts.user.displayAvatarURL({ size: 128 }));
      embed.addFields({ name: "User", value: `${opts.user} (\`${opts.user.id}\`)`, inline: true });
    }
    if (opts.fields?.length) {
      for (const f of opts.fields.slice(0, 20)) {
        embed.addFields({ name: f.name.slice(0, 256), value: f.value.slice(0, 1024), inline: f.inline });
      }
    }

    const files = opts.image
      ? [new AttachmentBuilder(opts.image.buffer, { name: opts.image.name })]
      : [];
    if (opts.image) embed.setImage(`attachment://${opts.image.name}`);

    // Never ping roles from log embeds (collect fields use <@&role> pills).
    await (channel as TextChannel).send({
      embeds: [embed],
      files,
      allowedMentions: { parse: [], users: opts.user ? [opts.user.id] : [] },
    }).catch(() => {});
  } catch (err) {
    logger.debug({ err, guildId: opts.guildId }, "channel log post failed (non-fatal)");
  }
}

/** Convenience: log a casino / economy event from an interaction. */
export async function logEconomyEvent(
  client: Client,
  guildId: string,
  user: User,
  title: string,
  description: string,
  fields?: ChannelLogOpts["fields"],
): Promise<void> {
  await postChannelLog(client, {
    guildId,
    category: "economy",
    title,
    description,
    user,
    fields,
  });
}

export async function logGameEvent(
  client: Client,
  guildId: string,
  user: User,
  title: string,
  description: string,
  fields?: ChannelLogOpts["fields"],
): Promise<void> {
  await postChannelLog(client, {
    guildId,
    category: "games",
    title,
    description,
    user,
    fields,
  });
}
