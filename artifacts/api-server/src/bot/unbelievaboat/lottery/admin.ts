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
  setPoolAmount,
  setPoolStatus,
  patchGameConfig,
} from "../../../lib/lottery/db.js";
import {
  resolveGameConfig,
  formatBuyWindow,
  parseBuyDays,
} from "../../../lib/lottery/config.js";
import { fmtCash, requireEconomy } from "../cash.js";
import { postJackpotBoard, runLiveDraw } from "./draw.js";
import { buildLotteryAdminCommandJson, buildLotteryCommandJson } from "./definition.js";
import type { LotteryGameKey } from "./catalog.js";

export { buildLotteryAdminCommandJson, buildLotteryCommandJson };

const ALL_GAMES: LotteryGameKey[] = ["classic", "powerball", "mega", "scratch"];

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
  if (id === "lottoadmin:prices" && interaction.isButton()) {
    await interaction.update({
      content: "Pick a game to edit **ticket price** and **seed jackpot**:",
      embeds: [],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("lottoadmin:prices_game")
            .setPlaceholder("Game to price…")
            .addOptions(
              ...ALL_GAMES.map(k => ({
                label: GAME_DEFS[k].name,
                value: k,
                emoji: GAME_DEFS[k].emoji,
              })),
            ),
        ),
        backRow(),
      ],
    });
    return;
  }
  if (id === "lottoadmin:prices_game" && interaction.isStringSelectMenu()) {
    const game = interaction.values[0] as LotteryGameKey;
    const settings = await getOrCreateLotterySettings(interaction.guildId!);
    const cfg = resolveGameConfig(settings, game);
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(`lottoadmin:modal:prices:${game}`)
        .setTitle(`${GAME_DEFS[game].name} prices`.slice(0, 45))
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("ticket")
              .setLabel("Ticket price (UB)")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setValue(String(cfg.ticketPrice)),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("seed")
              .setLabel("Seed jackpot / pool floor (UB)")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setValue(String(cfg.seedJackpot)),
          ),
        ),
    );
    return;
  }
  if (id.startsWith("lottoadmin:modal:prices:") && interaction.isModalSubmit()) {
    const game = id.slice("lottoadmin:modal:prices:".length) as LotteryGameKey;
    const ticket = Number.parseInt(interaction.fields.getTextInputValue("ticket"), 10);
    const seed = Number.parseInt(interaction.fields.getTextInputValue("seed"), 10);
    if (!Number.isFinite(ticket) || ticket < 1 || ticket > 10_000_000) {
      await interaction.reply({ content: "Ticket price must be 1–10,000,000.", ...EPHEMERAL });
      return;
    }
    if (!Number.isFinite(seed) || seed < 0 || seed > 100_000_000) {
      await interaction.reply({ content: "Seed must be 0–100,000,000.", ...EPHEMERAL });
      return;
    }
    await patchGameConfig(interaction.guildId!, game, {
      ticketPrice: ticket,
      seedJackpot: seed,
    });
    await ensurePools(interaction.guildId!);
    // If pool is below new seed, top it up to the floor.
    const pool = await getPool(interaction.guildId!, game);
    if (pool.poolAmount < seed) {
      await setPoolAmount(interaction.guildId!, game, seed);
    }
    await interaction.reply({
      content:
        `Updated **${GAME_DEFS[game].name}**: ticket **${fmtCash(ticket)}**, seed **${fmtCash(seed)}**.`,
      ...EPHEMERAL,
    });
    return;
  }
  if (id === "lottoadmin:hours" && interaction.isButton()) {
    await interaction.update({
      content: "Pick a game to set **when players can buy** (UTC hours + days):",
      embeds: [],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("lottoadmin:hours_game")
            .setPlaceholder("Game buy window…")
            .addOptions(
              ...ALL_GAMES.map(k => ({
                label: GAME_DEFS[k].name,
                value: k,
                emoji: GAME_DEFS[k].emoji,
              })),
            ),
        ),
        backRow(),
      ],
    });
    return;
  }
  if (id === "lottoadmin:hours_game" && interaction.isStringSelectMenu()) {
    const game = interaction.values[0] as LotteryGameKey;
    const settings = await getOrCreateLotterySettings(interaction.guildId!);
    const cfg = resolveGameConfig(settings, game);
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(`lottoadmin:modal:hours:${game}`)
        .setTitle(`${GAME_DEFS[game].name} buy window`.slice(0, 45))
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("start")
              .setLabel("Start hour UTC (0–23) or blank=always")
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setValue(cfg.buyStartHourUtc == null ? "" : String(cfg.buyStartHourUtc)),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("end")
              .setLabel("End hour UTC (0–23) or blank=always")
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setValue(cfg.buyEndHourUtc == null ? "" : String(cfg.buyEndHourUtc)),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("days")
              .setLabel("Days 0=Sun…6=Sat (all or 1,2,3)")
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setValue(cfg.buyDaysUtc.length ? cfg.buyDaysUtc.join(",") : "all"),
          ),
        ),
    );
    return;
  }
  if (id.startsWith("lottoadmin:modal:hours:") && interaction.isModalSubmit()) {
    const game = id.slice("lottoadmin:modal:hours:".length) as LotteryGameKey;
    const startRaw = interaction.fields.getTextInputValue("start").trim();
    const endRaw = interaction.fields.getTextInputValue("end").trim();
    const daysRaw = interaction.fields.getTextInputValue("days").trim();
    const days = parseBuyDays(daysRaw || "all");
    if (days == null) {
      await interaction.reply({
        content: "Days must be `all` or numbers 0–6 separated by commas.",
        ...EPHEMERAL,
      });
      return;
    }
    let buyStartHourUtc: number | null = null;
    let buyEndHourUtc: number | null = null;
    if (startRaw || endRaw) {
      const start = Number.parseInt(startRaw, 10);
      const end = Number.parseInt(endRaw, 10);
      if (
        !Number.isInteger(start) || start < 0 || start > 23 ||
        !Number.isInteger(end) || end < 0 || end > 23
      ) {
        await interaction.reply({
          content: "Start and end hours must both be integers 0–23 (or both blank for always).",
          ...EPHEMERAL,
        });
        return;
      }
      buyStartHourUtc = start;
      buyEndHourUtc = end;
    }
    await patchGameConfig(interaction.guildId!, game, {
      buyStartHourUtc,
      buyEndHourUtc,
      buyDaysUtc: days,
    });
    const settings = await getOrCreateLotterySettings(interaction.guildId!);
    const cfg = resolveGameConfig(settings, game);
    await interaction.reply({
      content: `Buy window for **${GAME_DEFS[game].name}**: ${formatBuyWindow(cfg)}`,
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
    const key = p.gameKey as LotteryGameKey;
    const def = GAME_DEFS[key];
    const cfg = resolveGameConfig(settings, key);
    return (
      `${def?.emoji ?? "•"} **${def?.name ?? p.gameKey}** — pool ${symbol}${fmtCash(p.poolAmount)}` +
      ` · ticket ${symbol}${fmtCash(p.ticketPrice)} · seed ${symbol}${fmtCash(p.seedAmount)} · \`${p.status}\`\n` +
      `└ Buy: ${formatBuyWindow(cfg)}`
    );
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
        "Configure **prices** and **buy hours**, then Start / Live draw.",
        "Player picks stay **ephemeral**; draws & multi-winner ties are public.",
      ].join("\n"),
    );

  const rows = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("lottoadmin:start").setLabel("Start / announce").setEmoji("🚀").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("lottoadmin:draw").setLabel("Live draw now").setEmoji("🔴").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("lottoadmin:channel").setLabel("Set channel").setEmoji("📢").setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("lottoadmin:prices").setLabel("Prices").setEmoji("💵").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("lottoadmin:hours").setLabel("Buy hours").setEmoji("⏰").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("lottoadmin:schedule").setLabel("Weekly draw").setEmoji("📅").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
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
