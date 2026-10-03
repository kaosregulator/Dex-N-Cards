// /lotteryadmin — staff controls for pools, channel, live draws.

import type {
  ChatInputCommandInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction,
  ChannelSelectMenuInteraction,
  ModalSubmitInteraction,
} from "discord.js";
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from "discord.js";
import { resolveLotteryAdminAccess } from "./access.js";
import { GAME_DEFS, DRAW_GAMES, type DrawGameKey } from "./catalog.js";
import {
  getOrCreateLotterySettings,
  updateLotterySettings,
  ensurePools,
  getPool,
  setPoolStatus,
} from "../../../lib/lottery/db.js";
import { fmtCash, requireEconomy } from "../cash.js";
import { postJackpotBoard, runLiveDraw } from "./draw.js";
import { buildLotteryAdminCommandJson, buildLotteryCommandJson } from "./definition.js";

export { buildLotteryAdminCommandJson, buildLotteryCommandJson };

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

async function denyUnlessAdmin(
  interaction:
    | ChatInputCommandInteraction
    | ButtonInteraction
    | StringSelectMenuInteraction
    | ChannelSelectMenuInteraction
    | ModalSubmitInteraction,
): Promise<boolean> {
  const access = await resolveLotteryAdminAccess({
    userId: interaction.user.id,
    guild: interaction.guild,
    memberPermissions: interaction.memberPermissions,
  });
  if (access.ok) return true;
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content: access.message, ...EPHEMERAL }).catch(() => {});
  } else {
    await interaction.reply({ content: access.message, ...EPHEMERAL }).catch(() => {});
  }
  return false;
}

export async function handleLotteryAdminCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!(await denyUnlessAdmin(interaction))) return;
  await interaction.deferReply(EPHEMERAL);
  await showAdminHub(interaction);
}

export async function handleLotteryAdminComponent(
  interaction:
    | ButtonInteraction
    | StringSelectMenuInteraction
    | ChannelSelectMenuInteraction
    | ModalSubmitInteraction,
): Promise<void> {
  if (!(await denyUnlessAdmin(interaction))) return;
  const id = interaction.customId;

  if (id === "lottoadmin:hub" && interaction.isButton()) {
    await interaction.deferUpdate();
    await showAdminHub(interaction);
    return;
  }
  if (id === "lottoadmin:channel" && interaction.isButton()) {
    await interaction.update({
      content: "Pick the **live reveal / jackpot board** channel:",
      embeds: [],
      components: [
        new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId("lottoadmin:channel_pick")
            .setPlaceholder("Announce channel…")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
        backRow(),
      ],
    });
    return;
  }
  if (id === "lottoadmin:channel_pick" && interaction.isChannelSelectMenu()) {
    const channelId = interaction.values[0]!;
    await updateLotterySettings(interaction.guildId!, { announceChannelId: channelId });
    await interaction.update({
      content: `Announce channel set to <#${channelId}>.`,
      components: [backRow()],
      embeds: [],
    });
    return;
  }
  if (id === "lottoadmin:start" && interaction.isButton()) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId("lottoadmin:start_game")
      .setPlaceholder("Which game to open / announce?")
      .addOptions(
        { label: "Powerball", value: "powerball", emoji: "🔴" },
        { label: "Mega Millionaire", value: "mega", emoji: "💎" },
        { label: "Classic Lottery", value: "classic", emoji: "🎟️" },
      );
    await interaction.update({
      content: "Start / announce a jackpot board in the lottery channel:",
      embeds: [],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
        backRow(),
      ],
    });
    return;
  }
  if (id === "lottoadmin:start_game" && interaction.isStringSelectMenu()) {
    await interaction.deferUpdate();
    const game = interaction.values[0] as DrawGameKey;
    const settings = await getOrCreateLotterySettings(interaction.guildId!);
    if (!settings.announceChannelId) {
      await interaction.editReply({
        content: "Set an announce channel first.",
        components: [backRow()],
      });
      return;
    }
    await setPoolStatus(interaction.guildId!, game, "open");
    await ensurePools(interaction.guildId!);
    try {
      await postJackpotBoard(interaction.guild!, settings.announceChannelId, game);
      await interaction.editReply({
        content: `Posted **${GAME_DEFS[game].name}** jackpot board in <#${settings.announceChannelId}>.`,
        components: [backRow()],
        embeds: [],
      });
    } catch (err) {
      await interaction.editReply({
        content: err instanceof Error ? err.message : "Failed to post board.",
        components: [backRow()],
      });
    }
    return;
  }
  if (id === "lottoadmin:draw" && interaction.isButton()) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId("lottoadmin:draw_game")
      .setPlaceholder("Run live reveal now…")
      .addOptions(
        { label: "Powerball LIVE draw", value: "powerball", emoji: "🔴" },
        { label: "Mega LIVE draw", value: "mega", emoji: "💎" },
        { label: "Classic LIVE draw", value: "classic", emoji: "🎟️" },
      );
    await interaction.update({
      content: "This posts the animated ball reveal and pays winners.",
      embeds: [],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
        backRow(),
      ],
    });
    return;
  }
  if (id === "lottoadmin:draw_game" && interaction.isStringSelectMenu()) {
    await interaction.deferUpdate();
    const game = interaction.values[0] as DrawGameKey;
    const settings = await getOrCreateLotterySettings(interaction.guildId!);
    if (!settings.announceChannelId) {
      await interaction.editReply({ content: "Set an announce channel first.", components: [backRow()] });
      return;
    }
    await interaction.editReply({ content: `Starting **${GAME_DEFS[game].name}** live draw…`, components: [] });
    const result = await runLiveDraw(interaction.guild!, game, settings.announceChannelId);
    await interaction.editReply({
      content: result
        ? `Draw #${result.drawId} complete — **${result.winners}** winning ticket(s).`
        : "No draw run (no tickets / channel issue).",
      components: [backRow()],
    });
    return;
  }
  if (id === "lottoadmin:schedule" && interaction.isButton()) {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId("lottoadmin:modal:schedule")
        .setTitle("Weekly draw schedule (UTC)")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("day")
              .setLabel("Day 0=Sun … 6=Sat")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setPlaceholder("6"),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("hour")
              .setLabel("Hour UTC (0–23)")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setPlaceholder("20"),
          ),
        ),
    );
    return;
  }
  if (id === "lottoadmin:modal:schedule" && interaction.isModalSubmit()) {
    const day = Number.parseInt(interaction.fields.getTextInputValue("day"), 10);
    const hour = Number.parseInt(interaction.fields.getTextInputValue("hour"), 10);
    if (!Number.isFinite(day) || day < 0 || day > 6 || !Number.isFinite(hour) || hour < 0 || hour > 23) {
      await interaction.reply({ content: "Day must be 0–6 and hour 0–23.", ...EPHEMERAL });
      return;
    }
    await updateLotterySettings(interaction.guildId!, {
      weeklyDrawDay: day,
      weeklyDrawHourUtc: hour,
    });
    await interaction.reply({
      content: `Weekly draw set to day **${day}** at **${hour}:00 UTC**.`,
      ...EPHEMERAL,
    });
    return;
  }
  if (id === "lottoadmin:toggle" && interaction.isButton()) {
    const s = await getOrCreateLotterySettings(interaction.guildId!);
    await updateLotterySettings(interaction.guildId!, { enabled: !s.enabled });
    await interaction.deferUpdate();
    await showAdminHub(interaction);
  }
}

function backRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("lottoadmin:hub").setLabel("Admin home").setStyle(ButtonStyle.Secondary),
  );
}

async function showAdminHub(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
): Promise<void> {
  const guildId = interaction.guildId!;
  const settings = await getOrCreateLotterySettings(guildId);
  const pools = await ensurePools(guildId);
  let symbol = "";
  try { ({ symbol } = await requireEconomy(guildId)); } catch { /* */ }

  const poolLines = pools.map(p => {
    const def = GAME_DEFS[p.gameKey as keyof typeof GAME_DEFS];
    return `${def?.emoji ?? "•"} **${def?.name ?? p.gameKey}** — ${symbol}${fmtCash(p.poolAmount)} (ticket ${symbol}${fmtCash(p.ticketPrice)}, seed ${symbol}${fmtCash(p.seedAmount)}) · \`${p.status}\``;
  });

  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("🎱 Lottery Admin")
    .setDescription(
      [
        `Enabled: **${settings.enabled ? "yes" : "no"}**`,
        `Announce channel: ${settings.announceChannelId ? `<#${settings.announceChannelId}>` : "_not set_"}`,
        `Weekly draw: **${days[settings.weeklyDrawDay]}** @ **${settings.weeklyDrawHourUtc}:00 UTC**` +
          (settings.lastDrawDate ? ` · last \`${settings.lastDrawDate}\`` : ""),
        "",
        ...poolLines,
        "",
        "Players use `/lottery`. Ticket spend feeds the pool. Live draws animate balls in the announce channel.",
      ].join("\n"),
    );

  const rows = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("lottoadmin:start").setLabel("Start / announce").setEmoji("🚀").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("lottoadmin:draw").setLabel("Live draw now").setEmoji("🔴").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("lottoadmin:channel").setLabel("Set channel").setEmoji("📢").setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("lottoadmin:schedule").setLabel("Weekly schedule").setEmoji("📅").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("lottoadmin:toggle").setLabel(settings.enabled ? "Disable" : "Enable").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("lottoadmin:hub").setLabel("Refresh").setStyle(ButtonStyle.Secondary),
    ),
  ];

  const payload = { content: null as string | null, embeds: [embed], components: rows };
  if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
  else await interaction.reply({ ...payload, ...EPHEMERAL });
}

// silence unused
void DRAW_GAMES;
