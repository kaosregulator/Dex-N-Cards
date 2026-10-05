// /casino — true panel hub (ONE slash). Buttons + modals, no subcommand sprawl.

import type {
  ChatInputCommandInteraction,
  ButtonInteraction,
  UserSelectMenuInteraction,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
  GuildMember,
} from "discord.js";
import {
  SlashCommandBuilder,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  StringSelectMenuBuilder,
} from "discord.js";
import {
  getOrCreateUbSettings,
  listRoleLinks,
  writeUbAudit,
} from "../../lib/unbelievaboat/db.js";
import { isUbConfigured, ubApi } from "../../lib/unbelievaboat/client.js";
import { UNBELIEVABOAT_AUTHOR, UNBELIEVABOAT_COLOR, UNBELIEVABOAT_NAME } from "./branding.js";
import {
  CashError,
  depositCash,
  withdrawCash,
  earnCash,
  getCashBalance,
  fmtCash,
} from "./cash.js";
import {
  assertIncomeCooldown,
  markIncomeCooldown,
  getGuildCooldowns,
} from "./cooldowns.js";
import { replyThenPostAsUnbelievaBoat } from "./webhook.js";
import { renderCoinCollectGif, renderDepositGif, renderWithdrawGif } from "./render-collect.js";
import { renderUbLeaderboardGif } from "./render-leaderboard.js";
import { brandAsset, BRAND_LOGO_FILE, BRAND_NAME } from "../help-banners.js";
import { logEconomyEvent, logGameEvent } from "../logging/channel-log.js";
import {
  handleCashGamesHub,
  handleBlackjack,
  handleRoulette,
  handleHigherLower,
  handleRedBlack,
  handleSlots,
  handleCashWork,
  handleCashCrime,
  handleRussian,
  handleRob,
  handleSlut,
} from "./games.js";
import { handleCashStore } from "./store.js";
import { handleUno } from "./uno.js";
import { withOptionValues } from "../commands/option-proxy.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

export function buildCasinoCommandJson() {
  return new SlashCommandBuilder()
    .setName("casino")
    .setDescription("UnbelievaBoat casino — wallet, games, collect, leaderboard")
    .setDMPermission(false)
    .toJSON();
}

function brandEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(UNBELIEVABOAT_COLOR)
    .setAuthor(UNBELIEVABOAT_AUTHOR)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: `${BRAND_NAME} × ${UNBELIEVABOAT_NAME}` });
}

async function attachGif(
  result: { buffer: Buffer } | null,
  name: string,
): Promise<{ files: AttachmentBuilder[]; imageName: string | null }> {
  if (!result) return { files: [], imageName: null };
  return { files: [new AttachmentBuilder(result.buffer, { name })], imageName: name };
}

function hubEmbed(balLine: string): EmbedBuilder {
  return brandEmbed(
    "🎰 Casino Floor",
    [
      balLine,
      "",
      "One slash · pick a table below. Games post live so the floor can watch.",
      "",
      "**Wallet** — balance · deposit · withdraw · daily · collect",
      "**Tables** — slots · blackjack · roulette · UNO · more",
      "**Quick slash** — `/daily_ub` `/slots_ub` `/blackjack_ub` … (same games, ends with `_ub`)",
      "**Hustle** — work · crime · beg · rob · russian",
      "**Board** — leaderboard · store · **lottery** · games menu",
    ].join("\n"),
  );
}

function hubRows() {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("casinohub:balance").setLabel("Balance").setEmoji("💵").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("casinohub:deposit").setLabel("Deposit").setEmoji("🏦").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("casinohub:withdraw").setLabel("Withdraw").setEmoji("💸").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("casinohub:daily").setLabel("Daily").setEmoji("📅").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("casinohub:collect").setLabel("Collect").setEmoji("🪙").setStyle(ButtonStyle.Success),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("casinohub:slots").setLabel("Slots").setEmoji("🎰").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("casinohub:blackjack").setLabel("Blackjack").setEmoji("🃏").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("casinohub:roulette").setLabel("Roulette").setEmoji("🎡").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("casinohub:uno").setLabel("UNO").setEmoji("🎴").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("casinohub:more_games").setLabel("More games").setEmoji("🎲").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("casinohub:work").setLabel("Work").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("casinohub:crime").setLabel("Crime").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("casinohub:beg").setLabel("Beg").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("casinohub:rob").setLabel("Rob").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("casinohub:russian").setLabel("Russian").setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("casinohub:top").setLabel("Leaderboard").setEmoji("🏆").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("casinohub:store").setLabel("Store").setEmoji("🛒").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("casinohub:lottery").setLabel("Lottery").setEmoji("🎱").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("casinohub:games").setLabel("Games menu").setEmoji("📋").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function betModal(customId: string, title: string, maxHint: string) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("bet")
          .setLabel(`Wager (${maxHint})`)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(12)
          .setPlaceholder("e.g. 500"),
      ),
    );
}

function amountModal(customId: string, title: string) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("amount")
          .setLabel("Amount")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(12)
          .setPlaceholder("e.g. 1000"),
      ),
    );
}

export async function handleCasinoCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "Server only.", ...EPHEMERAL });
    return;
  }
  await interaction.deferReply(EPHEMERAL);
  let balLine = "_Balance unavailable — check UnbelievaBoat link._";
  try {
    const bal = await getCashBalance(interaction.guildId, interaction.user.id);
    balLine = `Your wallet: **${fmtCash(bal.cash)}** cash · **${fmtCash(bal.bank)}** bank ${bal.symbol}`;
  } catch { /* ignore */ }
  await interaction.editReply({ embeds: [hubEmbed(balLine)], components: hubRows() });
}

export async function handleCasinoHubComponent(
  interaction: ButtonInteraction | UserSelectMenuInteraction | StringSelectMenuInteraction,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "Server only.", ...EPHEMERAL });
    return;
  }
  const id = interaction.customId;

  // ── Modals / selects first (cannot defer) ──────────────────────────────────
  if (id === "casinohub:deposit" && interaction.isButton()) {
    await interaction.showModal(amountModal("casinohub:modal:deposit", "Deposit to bank"));
    return;
  }
  if (id === "casinohub:withdraw" && interaction.isButton()) {
    await interaction.showModal(amountModal("casinohub:modal:withdraw", "Withdraw to cash"));
    return;
  }
  if (id === "casinohub:slots" && interaction.isButton()) {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId("casinohub:modal:slots")
        .setTitle("Vegas Slots — buy credits")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("bet")
              .setLabel("Credits to load (10–5,000)")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(12)
              .setPlaceholder("e.g. 1000 — cash first, then bank"),
          ),
        ),
    );
    return;
  }
  if (id === "casinohub:blackjack" && interaction.isButton()) {
    await interaction.showModal(betModal("casinohub:modal:blackjack", "Blackjack 21", "10–100,000"));
    return;
  }
  if (id === "casinohub:uno" && interaction.isButton()) {
    await interaction.showModal(betModal("casinohub:modal:uno", "Mini UNO", "10–50,000"));
    return;
  }
  if (id === "casinohub:higherlower" && interaction.isButton()) {
    await interaction.showModal(betModal("casinohub:modal:higherlower", "Higher or Lower", "10–50,000"));
    return;
  }
  if (id === "casinohub:roulette" && interaction.isButton()) {
    await interaction.showModal(betModal("casinohub:modal:roulette", "Roulette", "10–100,000"));
    return;
  }
  if (id === "casinohub:redblack" && interaction.isButton()) {
    const modal = new ModalBuilder()
      .setCustomId("casinohub:modal:redblack")
      .setTitle("Red or Black")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("bet").setLabel("Wager (10–50,000)")
            .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(12),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("color").setLabel("Color: red | black")
            .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("red"),
        ),
      );
    await interaction.showModal(modal);
    return;
  }
  if (id === "casinohub:rob" && interaction.isButton()) {
    const row = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new UserSelectMenuBuilder().setCustomId("casinohub:rob_user").setPlaceholder("Who to rob?").setMinValues(1).setMaxValues(1),
    );
    await interaction.reply({ content: "Pick a target:", components: [row], ...EPHEMERAL });
    return;
  }
  if (id === "casinohub:rob_user" && interaction.isUserSelectMenu()) {
    const target = interaction.users.first();
    if (!target || target.bot || target.id === interaction.user.id) {
      await interaction.reply({ content: "Pick a real member.", ...EPHEMERAL });
      return;
    }
    const proxied = withOptionValues(interaction, {
      users: { target },
    });
    await handleRob(proxied);
    return;
  }
  if (id === "casinohub:russian" && interaction.isButton()) {
    const row = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new UserSelectMenuBuilder().setCustomId("casinohub:russian_user").setPlaceholder("Challenge who?").setMinValues(1).setMaxValues(1),
    );
    await interaction.reply({ content: "Pick who to challenge:", components: [row], ...EPHEMERAL });
    return;
  }
  if (id === "casinohub:russian_user" && interaction.isUserSelectMenu()) {
    const target = interaction.users.first();
    if (!target || target.bot || target.id === interaction.user.id) {
      await interaction.reply({ content: "Pick a real member.", ...EPHEMERAL });
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId(`casinohub:modal:russian:${target.id}`)
      .setTitle("Russian Roulette")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("bet").setLabel("Stake (10–50,000)")
            .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(12),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("mode").setLabel("Mode: ai | challenge")
            .setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder("challenge"),
        ),
      );
    await interaction.showModal(modal);
    return;
  }
  if (id === "casinohub:more_games" && interaction.isButton()) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId("casinohub:more_pick")
      .setPlaceholder("Pick a table game…")
      .addOptions(
        { label: "Higher or Lower", value: "higherlower", emoji: "⬆️" },
        { label: "Red or Black", value: "redblack", emoji: "🔴" },
      );
    await interaction.reply({
      content: "More table games:",
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
      ...EPHEMERAL,
    });
    return;
  }
  if (id === "casinohub:more_pick" && interaction.isStringSelectMenu()) {
    const pick = interaction.values[0];
    if (pick === "higherlower") {
      await interaction.showModal(betModal("casinohub:modal:higherlower", "Higher or Lower", "10–50,000"));
      return;
    }
    if (pick === "redblack") {
      const modal = new ModalBuilder()
        .setCustomId("casinohub:modal:redblack")
        .setTitle("Red or Black")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId("bet").setLabel("Wager (10–50,000)")
              .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(12),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId("color").setLabel("Color: red | black")
              .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("red"),
          ),
        );
      await interaction.showModal(modal);
      return;
    }
  }

  // ── Direct actions ─────────────────────────────────────────────────────────
  if (id === "casinohub:balance" && interaction.isButton()) {
    const proxied = withOptionValues(interaction, {
      users: { user: interaction.user },
    });
    await handleBalance(proxied);
    return;
  }
  if (id === "casinohub:daily" && interaction.isButton()) {
    await handleAnimatedDaily(interaction as unknown as ChatInputCommandInteraction);
    return;
  }
  if (id === "casinohub:collect" && interaction.isButton()) {
    await handleCollect(interaction as unknown as ChatInputCommandInteraction);
    return;
  }
  if (id === "casinohub:work" && interaction.isButton()) {
    await handleCashWork(interaction as unknown as ChatInputCommandInteraction);
    return;
  }
  if (id === "casinohub:crime" && interaction.isButton()) {
    await handleCashCrime(interaction as unknown as ChatInputCommandInteraction);
    return;
  }
  if (id === "casinohub:beg" && interaction.isButton()) {
    await handleSlut(interaction as unknown as ChatInputCommandInteraction);
    return;
  }
  if (id === "casinohub:top" && interaction.isButton()) {
    await handleCasinoTop(interaction as unknown as ChatInputCommandInteraction);
    return;
  }
  if (id === "casinohub:lottery" && interaction.isButton()) {
    const { openLotteryFromCasino } = await import("./lottery/store.js");
    await openLotteryFromCasino(interaction);
    return;
  }
  if (id === "casinohub:store" && interaction.isButton()) {
    await handleCashStore(interaction as unknown as ChatInputCommandInteraction);
    return;
  }
  if (id === "casinohub:games" && interaction.isButton()) {
    await handleCashGamesHub(interaction as unknown as ChatInputCommandInteraction);
    return;
  }
}

function parseBet(raw: string, min: number, max: number): number | null {
  const n = Number.parseInt(raw.replace(/[,\s]/g, ""), 10);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

export async function handleCasinoHubModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "Server only.", ...EPHEMERAL });
    return;
  }
  const id = interaction.customId;
  const field = (name: string) => {
    try { return interaction.fields.getTextInputValue(name)?.trim() || ""; }
    catch { return ""; }
  };

  if (id === "casinohub:modal:deposit") {
    const amount = parseBet(field("amount"), 1, 1_000_000_000);
    if (!amount) {
      await interaction.reply({ content: "Enter a valid deposit amount.", ...EPHEMERAL });
      return;
    }
    const proxied = withOptionValues(interaction, {
      integers: { amount },
    });
    await handleDeposit(proxied);
    return;
  }
  if (id === "casinohub:modal:withdraw") {
    const amount = parseBet(field("amount"), 1, 1_000_000_000);
    if (!amount) {
      await interaction.reply({ content: "Enter a valid withdraw amount.", ...EPHEMERAL });
      return;
    }
    const proxied = withOptionValues(interaction, {
      integers: { amount },
    });
    await handleWithdraw(proxied);
    return;
  }
  if (id === "casinohub:modal:slots") {
    const bet = parseBet(field("bet"), 10, 5_000);
    if (!bet) { await interaction.reply({ content: "Credits must be 10–5,000.", ...EPHEMERAL }); return; }
    await handleSlots(withOptionValues(interaction, { integers: { bet } }));
    return;
  }
  if (id === "casinohub:modal:blackjack") {
    const bet = parseBet(field("bet"), 10, 100_000);
    if (!bet) { await interaction.reply({ content: "Bet must be 10–100,000.", ...EPHEMERAL }); return; }
    await handleBlackjack(withOptionValues(interaction, { integers: { bet } }));
    return;
  }
  if (id === "casinohub:modal:uno") {
    const bet = parseBet(field("bet"), 10, 50_000);
    if (!bet) { await interaction.reply({ content: "Bet must be 10–50,000.", ...EPHEMERAL }); return; }
    await handleUno(withOptionValues(interaction, { integers: { bet } }));
    return;
  }
  if (id === "casinohub:modal:higherlower") {
    const bet = parseBet(field("bet"), 10, 50_000);
    if (!bet) { await interaction.reply({ content: "Bet must be 10–50,000.", ...EPHEMERAL }); return; }
    await handleHigherLower(withOptionValues(interaction, { integers: { bet } }));
    return;
  }
  if (id === "casinohub:modal:roulette") {
    const bet = parseBet(field("bet"), 10, 100_000);
    if (!bet) { await interaction.reply({ content: "Bet must be 10–100,000.", ...EPHEMERAL }); return; }
    // Color is chosen on the live table with buttons.
    await handleRoulette(withOptionValues(interaction, {
      integers: { bet },
      strings: { color: null },
    }));
    return;
  }
  if (id === "casinohub:modal:redblack") {
    const bet = parseBet(field("bet"), 10, 50_000);
    const color = field("color").toLowerCase();
    if (!bet) { await interaction.reply({ content: "Bet must be 10–50,000.", ...EPHEMERAL }); return; }
    if (!["red", "black"].includes(color)) {
      await interaction.reply({ content: "Color must be red or black.", ...EPHEMERAL });
      return;
    }
    await handleRedBlack(withOptionValues(interaction, {
      integers: { bet },
      strings: { color },
    }));
    return;
  }
  if (id.startsWith("casinohub:modal:russian:")) {
    const targetId = id.slice("casinohub:modal:russian:".length);
    const target = await interaction.client.users.fetch(targetId).catch(() => null);
    if (!target) { await interaction.reply({ content: "User not found.", ...EPHEMERAL }); return; }
    const bet = parseBet(field("bet"), 10, 50_000);
    if (!bet) { await interaction.reply({ content: "Bet must be 10–50,000.", ...EPHEMERAL }); return; }
    const mode = (field("mode").toLowerCase() || "challenge") === "ai" ? "ai" : "challenge";
    await handleRussian(withOptionValues(interaction, {
      users: { target },
      integers: { bet },
      strings: { mode },
    }));
  }
}

export async function handleBalance(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  try {
    const target = interaction.options.getUser("user") ?? interaction.user;
    const bal = await getCashBalance(interaction.guildId!, target.id);
    const embed = brandEmbed("Casino Wallet", [
      `${target}`,
      `💵 Cash **${fmtCash(bal.cash)}** ${bal.symbol}`,
      `🏦 Bank **${fmtCash(bal.bank)}** ${bal.symbol}`,
      `Σ Total **${fmtCash(bal.cash + bal.bank)}**`,
      "",
      `_Deposit / withdraw: \`.deposit\` / \`.withdraw\` or \`/casino\`._`,
    ].join("\n"));
    embed.setThumbnail(target.displayAvatarURL({ size: 128 }));
    await replyThenPostAsUnbelievaBoat(interaction, { embeds: [embed], slashHint: "/bal_ub" });
  } catch (err) {
    await interaction.editReply(err instanceof CashError ? err.message : `Failed: ${err instanceof Error ? err.message : err}`);
  }
}

export async function handleDeposit(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  try {
    const amount = interaction.options.getInteger("amount", true);
    const bal = await depositCash(interaction.guildId!, interaction.user.id, amount);
    await writeUbAudit(interaction.guildId!, interaction.user.id, "casino_deposit", { amount });
    const gif = await renderDepositGif({
      amount, symbol: bal.symbol, newCash: bal.cash, newBank: bal.bank,
    });
    const { files, imageName } = await attachGif(gif, "deposit.gif");
    const embed = brandEmbed("Casino Deposit", [
      `${interaction.user} deposited **${fmtCash(amount)}** ${bal.symbol} into the bank.`,
      `💵 Cash **${fmtCash(bal.cash)}** · 🏦 Bank **${fmtCash(bal.bank)}**`,
    ].join("\n"));
    if (imageName) embed.setImage(`attachment://${imageName}`);
    await replyThenPostAsUnbelievaBoat(interaction, {
      embeds: [embed],
      files,
      slashHint: `/deposit_ub amount:${amount}`,
    });
    void logEconomyEvent(
      interaction.client, interaction.guildId!, interaction.user,
      "Deposit", `Deposited ${fmtCash(amount)} ${bal.symbol}`,
      [
        { name: "Cash", value: fmtCash(bal.cash), inline: true },
        { name: "Bank", value: fmtCash(bal.bank), inline: true },
      ],
    );
  } catch (err) {
    await interaction.editReply(err instanceof CashError ? err.message : `Failed: ${err instanceof Error ? err.message : err}`);
  }
}

export async function handleWithdraw(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  try {
    const amount = interaction.options.getInteger("amount", true);
    const bal = await withdrawCash(interaction.guildId!, interaction.user.id, amount);
    await writeUbAudit(interaction.guildId!, interaction.user.id, "casino_withdraw", { amount });
    const gif = await renderWithdrawGif({
      amount, symbol: bal.symbol, newCash: bal.cash, newBank: bal.bank,
    });
    const { files, imageName } = await attachGif(gif, "withdraw.gif");
    const embed = brandEmbed("Casino Withdraw", [
      `${interaction.user} withdrew **${fmtCash(amount)}** ${bal.symbol} to cash.`,
      `💵 Cash **${fmtCash(bal.cash)}** · 🏦 Bank **${fmtCash(bal.bank)}**`,
    ].join("\n"));
    if (imageName) embed.setImage(`attachment://${imageName}`);
    await replyThenPostAsUnbelievaBoat(interaction, {
      embeds: [embed],
      files,
      slashHint: `/withdraw_ub amount:${amount}`,
    });
    void logEconomyEvent(
      interaction.client, interaction.guildId!, interaction.user,
      "Withdraw", `Withdrew ${fmtCash(amount)} ${bal.symbol}`,
      [
        { name: "Cash", value: fmtCash(bal.cash), inline: true },
        { name: "Bank", value: fmtCash(bal.bank), inline: true },
      ],
    );
  } catch (err) {
    await interaction.editReply(err instanceof CashError ? err.message : `Failed: ${err instanceof Error ? err.message : err}`);
  }
}

export async function handleAnimatedDaily(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  try {
    const settings = await getOrCreateUbSettings(interaction.guildId!);
    if (!settings.gamesEnabled) throw new CashError("UnbelievaBoat mini-games are disabled on this server.");
    await assertIncomeCooldown(interaction.guildId!, interaction.user.id, "daily");
    const { getOrCreateGameState, touchGameState } = await import("../../lib/unbelievaboat/db.js");
    const state = await getOrCreateGameState(interaction.guildId!, interaction.user.id);
    const now = Date.now();
    const prev = state.lastDailyAt?.getTime() ?? 0;
    const cds = await getGuildCooldowns(interaction.guildId!);
    const streak = prev && now - prev < cds.dailySec * 1000 * 2 ? (state.dailyStreak || 0) + 1 : 1;
    const { getGuildPayouts, rollRange } = await import("./payouts.js");
    const pay = await getGuildPayouts(interaction.guildId!);
    const amount = rollRange(pay.dailyMin, pay.dailyMax);
    const bal = await earnCash(interaction.guildId!, interaction.user.id, amount, "Cash Check-In");
    await markIncomeCooldown(interaction.guildId!, interaction.user.id, "daily");
    await touchGameState(interaction.guildId!, interaction.user.id, { dailyStreak: streak });

    const gif = await renderCoinCollectGif({
      amount,
      symbol: bal.symbol,
      newCash: bal.cash,
      newBank: bal.bank,
      title: `DAILY · STREAK ${streak}`,
    });
    const { files, imageName } = await attachGif(gif, "daily-collect.gif");
    const embed = brandEmbed("Cash Check-In", [
      `${interaction.user} collected **${fmtCash(amount)}** ${bal.symbol}`,
      `Streak **${streak}** · cash **${fmtCash(bal.cash)}** · bank **${fmtCash(bal.bank)}**`,
      "_Stacks with UnbelievaBoat’s own income rewards._",
    ].join("\n"));
    if (imageName) embed.setImage(`attachment://${imageName}`);
    await replyThenPostAsUnbelievaBoat(interaction, { embeds: [embed], files, slashHint: "/daily_ub" });
    void logEconomyEvent(
      interaction.client, interaction.guildId!, interaction.user,
      "Daily Check-In", `Claimed ${fmtCash(amount)} (streak ${streak})`,
      [{ name: "Cash", value: fmtCash(bal.cash), inline: true }],
    );
  } catch (err) {
    await interaction.editReply(err instanceof CashError ? err.message : `Failed: ${err instanceof Error ? err.message : err}`);
  }
}

export async function handleCollect(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  try {
    const settings = await getOrCreateUbSettings(interaction.guildId!);
    if (!settings.gamesEnabled) throw new CashError("UnbelievaBoat mini-games are disabled on this server.");

    const member = interaction.member as GuildMember | null;
    if (!member?.roles) {
      await interaction.editReply("Could not read your roles.");
      return;
    }

    const { syncUbStoreRoleLinks } = await import("./ub-sync.js");
    const { isUbConfigured } = await import("../../lib/unbelievaboat/client.js");
    const { readCooldowns } = await import("./cooldowns.js");
    const {
      formatCooldownLeft,
      loadRoleCollectState,
      markRolesCollected,
      planRoleCollect,
    } = await import("./collect-roles.js");

    // Sync UB store role items, then collect every owned role with income that is off CD.
    let links = await listRoleLinks(interaction.guildId!);
    if (isUbConfigured() && settings.enabled) {
      try {
        const synced = await syncUbStoreRoleLinks(
          interaction.guildId!,
          settings.ubGuildId,
          interaction.guild,
        );
        links = synced.links;
      } catch {
        // Collect still works from whatever links we already have.
      }
    }

    const cds = readCooldowns(settings);
    const { lastByLinkId, fallbackLastCollectAt } = await loadRoleCollectState(
      interaction.guildId!,
      interaction.user.id,
    );
    const planned = planRoleCollect({
      links,
      member,
      guildCollectSec: cds.collectSec,
      lastByLinkId,
      fallbackLastCollectAt,
      guild: interaction.guild,
    });

    if (!planned.ready.length && !planned.cooling.length) {
      await interaction.editReply(
        "You don’t own any collectable income roles yet.\n" +
        "Buy a role in `/casino` → Store (synced UB + linked perks), then collect again.\n" +
        "_Admins: `/unbelievaboat` → Roles & economy → **Sync UB** / **Seed collect**._",
      );
      return;
    }

    if (!planned.ready.length) {
      const soonest = Math.min(...planned.cooling.map(r => r.readyInMs));
      const lines = planned.cooling.slice(0, 10).map(r =>
        `• ${r.emoji} **${r.link.name}** — ready in **${formatCooldownLeft(r.readyInMs)}**`,
      );
      await interaction.editReply(
        [
          `All your income roles are on cooldown. Next in **${formatCooldownLeft(soonest)}**.`,
          "",
          ...lines,
        ].join("\n"),
      );
      return;
    }

    const total = planned.ready.reduce((s, r) => s + r.income, 0);
    const bal = await earnCash(interaction.guildId!, interaction.user.id, total, "Role income collect");
    await markRolesCollected(
      interaction.guildId!,
      interaction.user.id,
      planned.ready.map(r => r.link.id),
    );
    await writeUbAudit(interaction.guildId!, interaction.user.id, "role_collect", {
      total,
      roles: planned.ready.map(r => ({
        id: r.link.discordRoleId,
        linkId: r.link.id,
        name: r.link.name,
        income: r.income,
        cooldownSec: r.cooldownSec,
      })),
      cooling: planned.cooling.map(r => ({
        linkId: r.link.id, name: r.link.name, readyInMs: r.readyInMs,
      })),
    });

    const roleLinesEmbed = planned.ready.map(r =>
      `• ${r.emoji} **${r.link.name}** — **${r.income >= 0 ? "+" : ""}${fmtCash(r.income)}**` +
      (r.link.discordRoleId ? ` · <@&${r.link.discordRoleId}>` : ""),
    );
    const coolingLines = planned.cooling.slice(0, 5).map(r =>
      `• ${r.emoji} **${r.link.name}** — ready in ${formatCooldownLeft(r.readyInMs)}`,
    );

    const gif = await renderCoinCollectGif({
      amount: total,
      symbol: bal.symbol,
      newCash: bal.cash,
      newBank: bal.bank,
      title: planned.ready.length > 1 ? `${planned.ready.length} ROLES` : "ROLE INCOME",
      roles: planned.ready.map(r => ({
        name: r.link.name,
        income: r.income,
        emoji: r.emoji,
        imageUrl: r.imageUrl,
      })),
    });
    const { files, imageName } = await attachGif(gif, "collect.gif");
    const embed = brandEmbed("Role Income Collected", [
      `${interaction.user} swept **${fmtCash(total)}** ${bal.symbol}` +
        (planned.ready.length > 1 ? ` from **${planned.ready.length}** owned roles:` : " from owned role:"),
      ...roleLinesEmbed,
      coolingLines.length ? `\n_Still cooling:_\n${coolingLines.join("\n")}` : null,
      "",
      `💵 Cash **${fmtCash(bal.cash)}** · 🏦 Bank **${fmtCash(bal.bank)}**`,
    ].filter(Boolean).join("\n"));
    if (imageName) embed.setImage(`attachment://${imageName}`);
    // Prefer an animated role icon as thumbnail when present
    const animThumb = planned.ready.find(r => r.imageUrl?.includes(".gif"))?.imageUrl;
    if (animThumb) embed.setThumbnail(animThumb);

    await replyThenPostAsUnbelievaBoat(interaction, { embeds: [embed], files, slashHint: "/collect_ub" });
    void logEconomyEvent(
      interaction.client, interaction.guildId!, interaction.user,
      "Role Collect", `Collected ${fmtCash(total)} from ${planned.ready.length} role(s)`,
      roleLinesEmbed.slice(0, 5).map(l => ({ name: "Role", value: l.slice(0, 100), inline: true })),
    );
  } catch (err) {
    await interaction.editReply(err instanceof CashError ? err.message : `Failed: ${err instanceof Error ? err.message : err}`);
  }
}

export async function handleCasinoTop(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  try {
    const settings = await getOrCreateUbSettings(interaction.guildId!);
    if (!isUbConfigured() || !settings.enabled) {
      await interaction.editReply("UnbelievaBoat API link is not configured or disabled.");
      return;
    }
    const raw = await ubApi.getLeaderboard(settings.ubGuildId || interaction.guildId!, {
      sort: (settings.leaderboardSort as "cash" | "bank" | "total") || "total",
      limit: 10,
      page: 1,
    });
    const users = Array.isArray(raw) ? raw : raw.users ?? [];
    const guild = interaction.guild;
    const rows = [];
    for (let i = 0; i < users.length; i++) {
      const u = users[i]!;
      let name = u.user_id;
      let avatarUrl: string | null = null;
      try {
        const member = await guild?.members.fetch(u.user_id).catch(() => null);
        if (member) {
          name = member.displayName;
          avatarUrl = member.user.displayAvatarURL({ size: 128, extension: "png" });
        } else {
          const user = await interaction.client.users.fetch(u.user_id).catch(() => null);
          if (user) {
            name = user.username;
            avatarUrl = user.displayAvatarURL({ size: 128, extension: "png" });
          }
        }
      } catch { /* keep id */ }
      rows.push({
        rank: i + 1,
        userId: u.user_id,
        name,
        avatarUrl,
        cash: u.cash ?? 0,
        bank: u.bank ?? 0,
        total: u.total ?? ((u.cash ?? 0) + (u.bank ?? 0)),
      });
    }

    let symbol = settings.currencyLabel ?? "💵";
    try {
      const g = await ubApi.getGuild(settings.ubGuildId || interaction.guildId!);
      if (g.symbol) symbol = g.symbol;
    } catch { /* keep */ }

    const gif = await renderUbLeaderboardGif({
      rows,
      sort: settings.leaderboardSort,
      symbol,
    });
    const files: AttachmentBuilder[] = [];
    const embed = brandEmbed(
      `${BRAND_NAME} × ${UNBELIEVABOAT_NAME} Leaderboard`,
      rows.length
        ? rows.map(r =>
          `**${r.rank}.** <@${r.userId}> — cash ${fmtCash(r.cash)} · bank ${fmtCash(r.bank)} · **${fmtCash(r.total)}**`,
        ).join("\n")
        : "_No balances yet._",
    );
    const logo = brandAsset(BRAND_LOGO_FILE);
    if (logo) {
      files.push(new AttachmentBuilder(logo, { name: BRAND_LOGO_FILE }));
      embed.setThumbnail(`attachment://${BRAND_LOGO_FILE}`);
    }
    if (gif) {
      files.push(new AttachmentBuilder(gif.buffer, { name: "ub-leaderboard.gif" }));
      embed.setImage("attachment://ub-leaderboard.gif");
    }
    await replyThenPostAsUnbelievaBoat(interaction, { embeds: [embed], files, slashHint: "/top_ub" });
    void logGameEvent(
      interaction.client, interaction.guildId!, interaction.user,
      "Leaderboard viewed", `${interaction.user.username} opened the cash board`,
    );
  } catch (err) {
    await interaction.editReply(err instanceof CashError ? err.message : `Failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** Legacy flat `/cashcheck` still routes here if re-enabled. */
export { handleCashCheck } from "./games.js";
