// UnbelievaBoat mini-games — interactive blackjack + casino table games.
// Bets pull from cash first, then bank. Results post as UnbelievaBoat.

import type {
  ChatInputCommandInteraction,
  ButtonInteraction,
  Message,
  User,
} from "discord.js";
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  MessageFlags,
} from "discord.js";
import {
  getOrCreateUbSettings,
  getOrCreateGameState,
  touchGameState,
  writeUbAudit,
} from "../../lib/unbelievaboat/db.js";
import { UNBELIEVABOAT_AUTHOR, UNBELIEVABOAT_COLOR } from "./branding.js";
import {
  CashError, earnCash, spendFunds, getCashBalance, fmtCash, formatSpendNote,
} from "./cash.js";
import {
  assertGameCooldown, assertIncomeCooldown, markGameCooldown, markIncomeCooldown,
  getGuildCooldowns, cdText, DEFAULT_COOLDOWNS,
} from "./cooldowns.js";
import {
  freshDeck, draw, cardLabel, handTotal, isNaturalBlackjack, formatHand,
  isRed, rankValue, type Card,
} from "./cards.js";
import { replyThenPostAsUnbelievaBoat, openTableAsUnbelievaBoat, editUnbelievaBoatMessage } from "./webhook.js";
import {
  renderBegGif, renderCoinSpinGif, renderCrimeGif,
  renderHigherLowerGif, renderRedBlackGif, renderRobGif, renderWorkGif,
} from "./render-games.js";
import {
  renderBlackjackShuffleGif,
  renderBlackjackTableGif,
  renderBlackjackTablePng,
  type BjTableOpts,
} from "./render-blackjack.js";
import type { AnimationResult } from "../animations/types.js";

export { handleSlots } from "./live-slots.js";
export { handleRoulette } from "./live-roulette.js";
export { handleRussian } from "./russian-duel.js";
export { RESPONSIBLE_PLAY } from "./live-slots.js";
import { RESPONSIBLE_PLAY as RESPONSIBLE_FOOTER } from "./live-slots.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

type BjSession = {
  guildId: string;
  userId: string;
  bet: number;
  fromCash: number;
  fromBank: number;
  deck: Card[];
  player: Card[];
  dealer: Card[];
  doubled: boolean;
  expires: number;
};

const bjSessions = new Map<string, BjSession>();
const higherSessions = new Map<string, {
  guildId: string; userId: string; bet: number; shown: Card; deck: Card[]; expires: number;
  fromCash: number; fromBank: number;
}>();

function bjKey(guildId: string, userId: string) { return `${guildId}:${userId}`; }

function brandEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(UNBELIEVABOAT_COLOR)
    .setAuthor(UNBELIEVABOAT_AUTHOR)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: RESPONSIBLE_FOOTER });
}

async function attachGif(result: Awaited<ReturnType<typeof renderCoinSpinGif>>, name: string) {
  if (!result) return { files: [] as AttachmentBuilder[], imageName: null as string | null };
  return { files: [new AttachmentBuilder(result.buffer, { name })], imageName: name };
}

function attachPng(buf: Buffer | null, name: string) {
  if (!buf) return { files: [] as AttachmentBuilder[], imageName: null as string | null };
  return { files: [new AttachmentBuilder(buf, { name })], imageName: name };
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Play a GIF beat on the floor message, wait for one full playthrough, then
 * freeze to a static PNG so Discord’s GIF loop never re-flips the cards.
 * Pre-renders the still during the wait so settle is instant (no gap where
 * Discord can restart the GIF loop).
 *
 * Edits go through editUnbelievaBoatMessage (webhook token + retries) — the
 * floor must advance; we do not throw/refund on a missed beat.
 */
async function playBjBeat(
  floor: Message,
  opts: {
    content?: string | null;
    embed: EmbedBuilder;
    gif: AnimationResult | null;
    gifName: string;
    stillOpts: BjTableOpts;
    stillName: string;
    /** Optional pre-rendered still — skips encode during settle */
    stillPng?: Buffer | null;
    components?: ActionRowBuilder<ButtonBuilder>[];
    /** Slightly under duration so settle lands before the loop restarts */
    waitScale?: number;
  },
) {
  const { files, imageName } = await attachGif(opts.gif, opts.gifName);
  const emb = EmbedBuilder.from(opts.embed);
  if (imageName) emb.setImage(`attachment://${imageName}`);

  // Prefer GIF; if encode failed, jump straight to the still so we never stall.
  if (files.length) {
    await editUnbelievaBoatMessage(floor, {
      content: opts.content ?? undefined,
      embeds: [emb],
      files,
      components: [], // hide buttons while the flip plays
    });
    const waitMs = Math.max(600, Math.floor((opts.gif?.durationMs ?? 1400) * (opts.waitScale ?? 0.88)));
    const pngPromise = opts.stillPng
      ? Promise.resolve(opts.stillPng)
      : renderBlackjackTablePng(opts.stillOpts);
    const [, png] = await Promise.all([sleep(waitMs), pngPromise]);
    const still = attachPng(png, opts.stillName);
    const settled = EmbedBuilder.from(opts.embed);
    if (still.imageName) settled.setImage(`attachment://${still.imageName}`);
    await editUnbelievaBoatMessage(floor, {
      content: opts.content ?? undefined,
      embeds: [settled],
      files: still.files,
      components: opts.components ?? [],
    });
    return;
  }

  const png = opts.stillPng ?? await renderBlackjackTablePng(opts.stillOpts);
  const still = attachPng(png, opts.stillName);
  const settled = EmbedBuilder.from(opts.embed);
  if (still.imageName) settled.setImage(`attachment://${still.imageName}`);
  await editUnbelievaBoatMessage(floor, {
    content: opts.content ?? undefined,
    embeds: [settled],
    files: still.files,
    components: opts.components ?? [],
  });
}

async function assertGamesOn(guildId: string) {
  const s = await getOrCreateUbSettings(guildId);
  if (!s.gamesEnabled) throw new CashError("UnbelievaBoat mini-games are disabled on this server.");
}

function bjButtons(userId: string, canDouble: boolean) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`unbgame:bj:hit:${userId}`).setLabel("Hit").setEmoji("🃏").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`unbgame:bj:stand:${userId}`).setLabel("Stand").setEmoji("🛑").setStyle(ButtonStyle.Secondary),
  );
  if (canDouble) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`unbgame:bj:double:${userId}`).setLabel("Double Down").setEmoji("💰").setStyle(ButtonStyle.Success),
    );
  }
  return [row];
}

/** Update the floor table message (webhook or bot) after a button press. */
async function updateGameMessage(
  interaction: ButtonInteraction,
  payload: {
    content?: string | null;
    embeds?: EmbedBuilder[];
    files?: AttachmentBuilder[];
    components?: ActionRowBuilder<ButtonBuilder>[];
  },
) {
  // Webhook floors: always edit via the owning webhook token. Interaction
  // editReply/update can work for components, but Message#edit never can.
  if (interaction.message.webhookId) {
    await editUnbelievaBoatMessage(interaction.message, {
      content: payload.content ?? undefined,
      embeds: payload.embeds,
      files: payload.files,
      components: payload.components,
    });
    return;
  }
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
      return;
    }
    await interaction.update(payload);
  } catch {
    await editUnbelievaBoatMessage(interaction.message, {
      content: payload.content ?? undefined,
      embeds: payload.embeds,
      files: payload.files,
      components: payload.components,
    });
  }
}

// ── Command builders ──────────────────────────────────────────────────────────

export function buildCashCheckCommandJson() {
  return new SlashCommandBuilder()
    .setName("cashcheck")
    .setDescription("Cash Check-In — claim UnbelievaBoat cash (stacks with their rewards)")
    .setDMPermission(false).toJSON();
}

export function buildCashGamesCommandJson() {
  return new SlashCommandBuilder()
    .setName("cashgames")
    .setDescription("UnbelievaBoat casino hub — blackjack, slots, roulette, and more")
    .setDMPermission(false).toJSON();
}

export function buildRouletteCommandJson() {
  return new SlashCommandBuilder()
    .setName("roulette")
    .setDescription("Casino roulette — bet on red, black, or green (cash then bank)")
    .setDMPermission(false)
    .addIntegerOption(o => o.setName("bet").setDescription("Wager").setRequired(true).setMinValue(10).setMaxValue(100_000))
    .addStringOption(o => o.setName("color").setDescription("Color").setRequired(true)
      .addChoices(
        { name: "Red (2×)", value: "red" },
        { name: "Black (2×)", value: "black" },
        { name: "Green 0 (14×)", value: "green" },
      )).toJSON();
}

export function buildBlackjackCommandJson() {
  return new SlashCommandBuilder()
    .setName("blackjack")
    .setDescription("Interactive 21 — Hit / Stand / Double Down")
    .setDMPermission(false)
    .addIntegerOption(o => o.setName("bet").setDescription("Wager").setRequired(true).setMinValue(10).setMaxValue(100_000))
    .toJSON();
}

export function buildHigherLowerCommandJson() {
  return new SlashCommandBuilder()
    .setName("higherlower")
    .setDescription("Higher or Lower — guess the next card")
    .setDMPermission(false)
    .addIntegerOption(o => o.setName("bet").setDescription("Wager").setRequired(true).setMinValue(10).setMaxValue(50_000))
    .toJSON();
}

export function buildRedBlackCommandJson() {
  return new SlashCommandBuilder()
    .setName("redblack")
    .setDescription("Red or Black — flip a card for 2×")
    .setDMPermission(false)
    .addIntegerOption(o => o.setName("bet").setDescription("Wager").setRequired(true).setMinValue(10).setMaxValue(50_000))
    .addStringOption(o => o.setName("color").setDescription("Pick a color").setRequired(true)
      .addChoices({ name: "Red", value: "red" }, { name: "Black", value: "black" }))
    .toJSON();
}

export function buildSlotsCommandJson() {
  return new SlashCommandBuilder()
    .setName("slots")
    .setDescription("Vegas slots — buy credits, bet, spin until empty, cash out")
    .setDMPermission(false)
    .addIntegerOption(o => o.setName("bet").setDescription("Credits to load (max 5,000)").setRequired(true).setMinValue(10).setMaxValue(5_000))
    .toJSON();
}

export function buildWorkCommandJson() {
  return new SlashCommandBuilder()
    .setName("cashwork")
    .setDescription("Safe work shift — earn UnbelievaBoat cash (no risk)")
    .setDMPermission(false).toJSON();
}

export function buildCrimeCommandJson() {
  return new SlashCommandBuilder()
    .setName("cashcrime")
    .setDescription("Risky crime — bigger payout or a fine")
    .setDMPermission(false).toJSON();
}

export function buildRussianCommandJson() {
  return new SlashCommandBuilder()
    .setName("russian")
    .setDescription("Russian roulette — AI duel or live challenge")
    .setDMPermission(false)
    .addUserOption(o => o.setName("target").setDescription("Target").setRequired(true))
    .addIntegerOption(o => o.setName("bet").setDescription("Stake").setRequired(true).setMinValue(10).setMaxValue(50_000))
    .addStringOption(o => o.setName("mode").setDescription("Mode")
      .addChoices({ name: "AI vs their avatar", value: "ai" }, { name: "Challenge them live", value: "challenge" }))
    .toJSON();
}

export function buildRobCommandJson() {
  return new SlashCommandBuilder()
    .setName("rob")
    .setDescription("Stick-figure stickup for UnbelievaBoat cash")
    .setDMPermission(false)
    .addUserOption(o => o.setName("target").setDescription("Target").setRequired(true))
    .toJSON();
}

export function buildSlutCommandJson() {
  return new SlashCommandBuilder()
    .setName("slut")
    .setDescription("PG dramatic cash beg (name blurred in embeds)")
    .setDMPermission(false).toJSON();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function finishBlackjack(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  session: BjSession,
  _playerStood: boolean,
) {
  const key = bjKey(session.guildId, session.userId);
  bjSessions.delete(key);

  const p = handTotal(session.player).total;
  // Bust — don't burn time drawing the dealer; hole card still reveals.
  const busted = p > 21;
  if (!busted) {
    while (handTotal(session.dealer).total < 17) {
      session.dealer.push(draw(session.deck));
    }
  }

  const d = handTotal(session.dealer).total;
  let outcome: "win" | "lose" | "push" = "lose";
  if (busted) outcome = "lose";
  else if (d > 21 || p > d) outcome = "win";
  else if (p === d) outcome = "push";

  const payout = outcome === "win" ? session.bet * 2 : outcome === "push" ? session.bet : 0;
  let bal = await getCashBalance(session.guildId, session.userId);
  if (payout > 0) bal = await earnCash(session.guildId, session.userId, payout, `Blackjack ${outcome}`);

  const tableOpts: BjTableOpts = {
    player: session.player,
    dealer: session.dealer,
    hideDealer: false,
    revealHole: true,
    animatePlayerFrom: session.player.length,
    animateDealerFrom: busted ? session.dealer.length : 2,
    banner: busted ? "BUST" : outcome.toUpperCase(),
  };
  const embed = brandEmbed(
    "Blackjack — 21",
    [
      `<@${session.userId}>`,
      `You ${formatHand(session.player)} (**${p}**)`,
      `Dealer ${formatHand(session.dealer)} (**${d}**)`,
      outcome === "win"
        ? `🎉 Win **${fmtCash(payout)}** ${bal.symbol}`
        : outcome === "push"
          ? `🤝 Push — stake returned`
          : `💀 Bust / lose stake **${fmtCash(session.bet)}**`,
      formatSpendNote(session.fromCash, session.fromBank, bal.symbol),
      `Cash **${fmtCash(bal.cash)}** · bank **${fmtCash(bal.bank)}**`,
    ].join("\n"),
  );

  if (interaction.isButton()) {
    const [gif, stillPng] = await Promise.all([
      renderBlackjackTableGif(tableOpts),
      renderBlackjackTablePng(tableOpts),
    ]);
    await playBjBeat(interaction.message, {
      content: null,
      embed,
      gif,
      gifName: "blackjack.gif",
      stillOpts: tableOpts,
      stillName: "blackjack.png",
      stillPng,
      components: [],
    });
    return;
  }

  // Non-button fallback (shouldn't happen in normal play)
  const gif = await renderBlackjackTableGif(tableOpts);
  const { files, imageName } = await attachGif(gif, "blackjack.gif");
  if (imageName) embed.setImage(`attachment://${imageName}`);
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ embeds: [embed], files, components: [] }).catch(() => {});
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────────

export async function handleCashCheck(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) { await interaction.reply({ content: "Server only.", ...EPHEMERAL }); return; }
  await interaction.deferReply({ ephemeral: true });
  try {
    await assertGamesOn(interaction.guildId);
    await assertIncomeCooldown(interaction.guildId, interaction.user.id, "daily");
    const state = await getOrCreateGameState(interaction.guildId, interaction.user.id);
    const now = Date.now();
    const prev = state.lastDailyAt?.getTime() ?? 0;
    const cds = await getGuildCooldowns(interaction.guildId);
    const streak = prev && now - prev < cds.dailySec * 1000 * 2 ? (state.dailyStreak || 0) + 1 : 1;
    const { getGuildPayouts, rollRange } = await import("./payouts.js");
    const pay = await getGuildPayouts(interaction.guildId);
    const amount = rollRange(pay.dailyMin, pay.dailyMax);
    const bal = await earnCash(interaction.guildId, interaction.user.id, amount, "Cash Check-In");
    await markIncomeCooldown(interaction.guildId, interaction.user.id, "daily");
    await touchGameState(interaction.guildId, interaction.user.id, { dailyStreak: streak });
    const gif = await renderCoinSpinGif({ amount, symbol: bal.symbol, streak });
    const { files, imageName } = await attachGif(gif, "cashcheck.gif");
    const embed = brandEmbed("Cash Check-In", [
      `${interaction.user} claimed **${fmtCash(amount)}** ${bal.symbol}`,
      `Streak **${streak}** · cash **${fmtCash(bal.cash)}** · bank **${fmtCash(bal.bank)}**`,
      "_Stacks with UnbelievaBoat’s own income/role rewards._",
    ].join("\n"));
    if (imageName) embed.setImage(`attachment://${imageName}`);
    await replyThenPostAsUnbelievaBoat(interaction, { embeds: [embed], files, slashHint: "/daily_ub" });
  } catch (err) {
    await interaction.editReply(err instanceof CashError ? err.message : `Failed: ${err instanceof Error ? err.message : err}`);
  }
}

export async function handleCashGamesHub(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) { await interaction.reply({ content: "Server only.", ...EPHEMERAL }); return; }
  await interaction.deferReply({ ephemeral: true });
  try {
    await assertGamesOn(interaction.guildId);
    const bal = await getCashBalance(interaction.guildId, interaction.user.id);
    const cds = await getGuildCooldowns(interaction.guildId);
    const embed = brandEmbed("Casino Hub", [
      `Wallet: **${fmtCash(bal.cash)}** cash · **${fmtCash(bal.bank)}** bank ${bal.symbol}`,
      `_Bets spend cash first, then bank. Open \`/casino\` for the floor panel._`,
      "",
      "**Floor panel:** `/casino` — wallet · slots · blackjack · roulette · UNO · hustle",
      "**Tables:** Slots (mega) · Blackjack 21 (public) · Roulette · Higher/Lower · Red/Black · UNO",
      "**Income:** Daily · Collect · Work · Crime · Beg",
      "**Chaos:** Rob · Russian",
      "",
      `Game limit: **${cds.gameUses}** / **${cdText(cds.gameWindowSec * 1000)}** (edit in \`/unbelievaboat\`)`,
    ].join("\n"));
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply(err instanceof CashError ? err.message : `Failed: ${err instanceof Error ? err.message : err}`);
  }
}

export async function handleBlackjack(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) { await interaction.reply({ content: "Server only.", ...EPHEMERAL }); return; }
  await interaction.deferReply({ ephemeral: true });
  let stakeToRefund: number | null = null;
  const key = bjKey(interaction.guildId, interaction.user.id);
  try {
    await assertGamesOn(interaction.guildId);
    await assertGameCooldown(interaction.guildId, interaction.user.id);
    const bet = interaction.options.getInteger("bet", true);
    if (bjSessions.has(key)) {
      await interaction.editReply("You already have a hand open — finish Hit/Stand first.");
      return;
    }

    const spent = await spendFunds(interaction.guildId, interaction.user.id, bet, "Blackjack bet");
    stakeToRefund = bet;
    await markGameCooldown(interaction.guildId, interaction.user.id);

    const deck = freshDeck();
    const player = [draw(deck), draw(deck)];
    const dealer = [draw(deck), draw(deck)];

    // 1) Shuffle intro on the floor (GIF), then settle to PNG before Discord loops.
    // While the shuffle plays, pre-render the next beat so we never sit idle on a looping GIF.
    const shuffleGif = await renderBlackjackShuffleGif();
    const shuffleAtt = await attachGif(shuffleGif, "bj-shuffle.gif");
    const shuffleEmbed = brandEmbed("Blackjack — shuffle", [
      `${interaction.user} · stake **${fmtCash(bet)}**`,
      formatSpendNote(spent.fromCash, spent.fromBank, spent.balance.symbol),
      "",
      "_Shuffling the deck…_",
    ].join("\n"));
    if (shuffleAtt.imageName) shuffleEmbed.setImage(`attachment://${shuffleAtt.imageName}`);

    const floor = await openTableAsUnbelievaBoat(interaction, {
      content: `${interaction.user} — **shuffling**…`,
      embeds: [shuffleEmbed],
      files: shuffleAtt.files,
      components: [],
      slashHint: `/blackjack_ub bet:${bet}`,
    }, "✅ Blackjack table opened as **UnbelievaBoat** — watch the shuffle.");

    if (!floor) {
      await interaction.editReply("Couldn't open the blackjack table — try again.");
      await earnCash(interaction.guildId, interaction.user.id, bet, "Blackjack refund (no table)").catch(() => null);
      stakeToRefund = null;
      return;
    }

    const natural = isNaturalBlackjack(dealer) || isNaturalBlackjack(player);
    const shuffleWaitMs = Math.max(900, Math.floor((shuffleGif?.durationMs ?? 2200) * 0.85));

    // Pre-build the next table opts + assets during the shuffle playthrough
    let nextOpts: BjTableOpts;
    let nextEmbed: EmbedBuilder;
    let nextContent: string;
    let nextGifName: string;
    let nextStillName: string;
    let nextComponents: ActionRowBuilder<ButtonBuilder>[] = [];

    // Natural payout is deferred until the floor settle succeeds (avoids stack on retry).
    let naturalOutcome: "win" | "lose" | "push" | null = null;
    let naturalPayout = 0;

    if (natural) {
      const p = handTotal(player).total;
      const d = handTotal(dealer).total;
      if (isNaturalBlackjack(player) && isNaturalBlackjack(dealer)) naturalOutcome = "push";
      else if (isNaturalBlackjack(player)) naturalOutcome = "win";
      else naturalOutcome = "lose";
      naturalPayout = naturalOutcome === "win" ? bet * 2 : naturalOutcome === "push" ? bet : 0;
      nextOpts = { player, dealer, hideDealer: false, revealHole: true, banner: "BLACKJACK" };
      nextEmbed = brandEmbed("Blackjack — 21", [
        `${interaction.user}`,
        `You ${formatHand(player)} (**${p}**)`,
        `Dealer ${formatHand(dealer)} (**${d}**)`,
        naturalOutcome === "win"
          ? `🎉 Blackjack! **+${fmtCash(naturalPayout)}** ${spent.balance.symbol}`
          : naturalOutcome === "push"
            ? `🤝 Double blackjack — push`
            : `💀 Dealer blackjack — lost **${fmtCash(bet)}**`,
        formatSpendNote(spent.fromCash, spent.fromBank, spent.balance.symbol),
      ].join("\n"));
      nextContent = `${interaction.user} — natural`;
      nextGifName = "bj-natural.gif";
      nextStillName = "bj-natural.png";
    } else {
      const p = handTotal(player);
      nextOpts = {
        player, dealer, hideDealer: true,
        animatePlayerFrom: 0,
        animateDealerFrom: 0,
      };
      nextEmbed = brandEmbed("Blackjack — your move", [
        `${interaction.user} · ${formatSpendNote(spent.fromCash, spent.fromBank, spent.balance.symbol)}`,
        `You: ${formatHand(player)} (**${p.total}**${p.soft ? " soft" : ""})`,
        `Dealer: ${formatHand(dealer, true)}`,
        "",
        "Choose **Hit**, **Stand**, or **Double Down**.",
      ].join("\n"));
      nextContent = `${interaction.user} — **your move**: press **Hit**, **Stand**, or **Double Down**`;
      nextGifName = "bj-deal.gif";
      nextStillName = "bj-deal.png";
      nextComponents = bjButtons(interaction.user.id, true);
    }

    // Pre-render the deal WHILE the shuffle GIF plays, then swap straight to
    // the deal beat. (An intermediate shuffle-PNG settle raced webhook edits
    // and left the table stuck on "DECK READY" forever.)
    const dealGifPromise = renderBlackjackTableGif(nextOpts);
    const dealPngPromise = renderBlackjackTablePng(nextOpts);
    await sleep(shuffleWaitMs);
    const [dealGif, dealPng] = await Promise.all([dealGifPromise, dealPngPromise]);

    // Register the interactive session only once deal assets are ready.
    if (!natural) {
      bjSessions.set(key, {
        guildId: interaction.guildId, userId: interaction.user.id, bet,
        fromCash: spent.fromCash, fromBank: spent.fromBank,
        deck, player, dealer, doubled: false, expires: Date.now() + 3 * 60_000,
      });
    }

    // 2) Deal / natural reveal — one poker flip, then freeze + buttons
    await playBjBeat(floor, {
      content: nextContent,
      embed: nextEmbed,
      gif: dealGif,
      gifName: nextGifName,
      stillOpts: nextOpts,
      stillName: nextStillName,
      stillPng: dealPng,
      components: nextComponents,
    });
    // Hand is live (or natural resolved) — stake is no longer refundable.
    stakeToRefund = null;
    if (natural && naturalPayout > 0 && naturalOutcome) {
      await earnCash(
        interaction.guildId, interaction.user.id, naturalPayout, `Blackjack ${naturalOutcome}`,
      );
    }
  } catch (err) {
    bjSessions.delete(key);
    if (stakeToRefund != null && interaction.guildId) {
      await earnCash(
        interaction.guildId, interaction.user.id, stakeToRefund, "Blackjack refund (failed hand)",
      ).catch(() => null);
    }
    await interaction.editReply(err instanceof CashError ? err.message : `Failed: ${err instanceof Error ? err.message : err}`);
  }
}


export async function handleHigherLower(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) { await interaction.reply({ content: "Server only.", ...EPHEMERAL }); return; }
  await interaction.deferReply({ ephemeral: true });
  try {
    await assertGamesOn(interaction.guildId);
    await assertGameCooldown(interaction.guildId, interaction.user.id);
    const bet = interaction.options.getInteger("bet", true);
    const key = bjKey(interaction.guildId, interaction.user.id);
    if (higherSessions.has(key)) {
      await interaction.editReply("Finish your Higher/Lower round first.");
      return;
    }
    const spent = await spendFunds(interaction.guildId, interaction.user.id, bet, "Higher/Lower bet");
    await markGameCooldown(interaction.guildId, interaction.user.id);
    const deck = freshDeck();
    const shown = draw(deck);
    higherSessions.set(key, {
      guildId: interaction.guildId, userId: interaction.user.id, bet, shown, deck,
      fromCash: spent.fromCash, fromBank: spent.fromBank, expires: Date.now() + 90_000,
    });
    const gif = await renderHigherLowerGif({ shown: cardLabel(shown) });
    const { files, imageName } = await attachGif(gif, "hl.gif");
    const embed = brandEmbed("Higher or Lower", [
      `${formatSpendNote(spent.fromCash, spent.fromBank, spent.balance.symbol)}`,
      `Showing **${cardLabel(shown)}** — will the next card be higher or lower?`,
      "_(Aces high · ties lose)_",
    ].join("\n"));
    if (imageName) embed.setImage(`attachment://${imageName}`);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`unbgame:hl:higher:${interaction.user.id}`).setLabel("Higher").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`unbgame:hl:lower:${interaction.user.id}`).setLabel("Lower").setStyle(ButtonStyle.Danger),
    );
    await openTableAsUnbelievaBoat(interaction, {
      embeds: [embed],
      files,
      components: [row],
      slashHint: `/higherlower_ub bet:${bet}`,
    });
  } catch (err) {
    await interaction.editReply(err instanceof CashError ? err.message : `Failed: ${err instanceof Error ? err.message : err}`);
  }
}

export async function handleRedBlack(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) { await interaction.reply({ content: "Server only.", ...EPHEMERAL }); return; }
  await interaction.deferReply({ ephemeral: true });
  try {
    await assertGamesOn(interaction.guildId);
    await assertGameCooldown(interaction.guildId, interaction.user.id);
    const bet = interaction.options.getInteger("bet", true);
    const pick = interaction.options.getString("color", true) as "red" | "black";
    const spent = await spendFunds(interaction.guildId, interaction.user.id, bet, `Red/Black ${pick}`);
    const card = draw(freshDeck());
    const landed: "red" | "black" = isRed(card) ? "red" : "black";
    const win = pick === landed;
    let bal = spent.balance;
    if (win) bal = await earnCash(interaction.guildId, interaction.user.id, bet * 2, "Red/Black win");
    const [, gif] = await Promise.all([
      markGameCooldown(interaction.guildId, interaction.user.id),
      renderRedBlackGif({ pick, landed, win }),
    ]);
    const { files, imageName } = await attachGif(gif, "redblack.gif");
    const embed = brandEmbed("Red or Black", [
      `${interaction.user} picked **${pick}** · card **${cardLabel(card)}** (${landed})`,
      formatSpendNote(spent.fromCash, spent.fromBank, bal.symbol),
      win ? `🎉 Doubled → **${fmtCash(bet * 2)}**` : `💀 Lost **${fmtCash(bet)}**`,
      `Cash **${fmtCash(bal.cash)}** · bank **${fmtCash(bal.bank)}**`,
    ].join("\n"));
    if (imageName) embed.setImage(`attachment://${imageName}`);
    await replyThenPostAsUnbelievaBoat(interaction, { embeds: [embed], files, slashHint: `/redblack_ub bet:${bet} color:${pick}` });
  } catch (err) {
    await interaction.editReply(err instanceof CashError ? err.message : `Failed: ${err instanceof Error ? err.message : err}`);
  }
}


export async function handleCashWork(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) { await interaction.reply({ content: "Server only.", ...EPHEMERAL }); return; }
  await interaction.deferReply({ ephemeral: true });
  try {
    await assertGamesOn(interaction.guildId);
    await assertIncomeCooldown(interaction.guildId, interaction.user.id, "work");
    const { getGuildPayouts, rollRange } = await import("./payouts.js");
    const pay = await getGuildPayouts(interaction.guildId);
    const payout = rollRange(pay.workMin, pay.workMax);
    const bal = await earnCash(interaction.guildId, interaction.user.id, payout, "Cash work");
    // Mark CD + encode GIF in parallel — shaves the post-command lag.
    const [, gif] = await Promise.all([
      markIncomeCooldown(interaction.guildId, interaction.user.id, "work"),
      renderWorkGif({ payout }),
    ]);
    const { files, imageName } = await attachGif(gif, "work.gif");
    const embed = brandEmbed("Work Shift", [
      `${interaction.user} finished a shift · **+${fmtCash(payout)}** ${bal.symbol}`,
      `Cash **${fmtCash(bal.cash)}** · bank **${fmtCash(bal.bank)}**`,
    ].join("\n"));
    if (imageName) embed.setImage(`attachment://${imageName}`);
    await replyThenPostAsUnbelievaBoat(interaction, { embeds: [embed], files, slashHint: "/work_ub" });
  } catch (err) {
    await interaction.editReply(err instanceof CashError ? err.message : `Failed: ${err instanceof Error ? err.message : err}`);
  }
}

export async function handleCashCrime(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) { await interaction.reply({ content: "Server only.", ...EPHEMERAL }); return; }
  await interaction.deferReply({ ephemeral: true });
  try {
    await assertGamesOn(interaction.guildId);
    await assertIncomeCooldown(interaction.guildId, interaction.user.id, "crime");
    const { getGuildPayouts, rollChance, rollCrimeFine, rollRange } = await import("./payouts.js");
    const pay = await getGuildPayouts(interaction.guildId);
    const fail = rollChance(pay.crimeFailChancePct);
    const avatarUrl = interaction.user.displayAvatarURL({ size: 256, extension: "png" });
    const displayName = interaction.member && "displayName" in interaction.member
      ? String(interaction.member.displayName)
      : interaction.user.username;
    if (fail) {
      const bal0 = await getCashBalance(interaction.guildId, interaction.user.id);
      const fine = rollCrimeFine((bal0.cash ?? 0) + (bal0.bank ?? 0), pay);
      const spent = await spendFunds(interaction.guildId, interaction.user.id, Math.min(fine, bal0.cash + bal0.bank), "Crime fine");
      // Mark CD only after the money move succeeds.
      await markIncomeCooldown(interaction.guildId, interaction.user.id, "crime");
      const gif = await renderCrimeGif({ success: false, avatarUrl, displayName });
      const { files, imageName } = await attachGif(gif, "crime.gif");
      const embed = brandEmbed("Crime — Busted", [
        `${interaction.user} got pinched and dragged to jail.`,
        formatSpendNote(spent.fromCash, spent.fromBank, spent.balance.symbol),
        `Cash **${fmtCash(spent.balance.cash)}** · bank **${fmtCash(spent.balance.bank)}**`,
      ].join("\n"));
      if (imageName) embed.setImage(`attachment://${imageName}`);
      await replyThenPostAsUnbelievaBoat(interaction, { embeds: [embed], files, slashHint: "/crime_ub" });
      return;
    }
    const payout = rollRange(pay.crimeWinMin, pay.crimeWinMax);
    const bal = await earnCash(interaction.guildId, interaction.user.id, payout, "Crime payout");
    await markIncomeCooldown(interaction.guildId, interaction.user.id, "crime");
    const gif = await renderCrimeGif({ success: true, avatarUrl, displayName, payout });
    const { files, imageName } = await attachGif(gif, "crime.gif");
    const embed = brandEmbed("Crime — Clean Getaway", [
      `${interaction.user} pulled it off · **+${fmtCash(payout)}** ${bal.symbol}`,
      `Cash **${fmtCash(bal.cash)}** · bank **${fmtCash(bal.bank)}**`,
    ].join("\n"));
    if (imageName) embed.setImage(`attachment://${imageName}`);
    await replyThenPostAsUnbelievaBoat(interaction, { embeds: [embed], files, slashHint: "/crime_ub" });
  } catch (err) {
    await interaction.editReply(err instanceof CashError ? err.message : `Failed: ${err instanceof Error ? err.message : err}`);
  }
}


export async function handleRob(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) { await interaction.reply({ content: "Server only.", ...EPHEMERAL }); return; }
  await interaction.deferReply({ ephemeral: true });
  try {
    await assertGamesOn(interaction.guildId);
    await assertIncomeCooldown(interaction.guildId, interaction.user.id, "rob");
    const target = interaction.options.getUser("target", true);
    if (target.bot || target.id === interaction.user.id) {
      await interaction.editReply("Pick someone else.");
      return;
    }

    // Rob immunity — Discord roles configured in /unbelievaboat → Immunity
    const settings = await getOrCreateUbSettings(interaction.guildId);
    const immuneIds = (settings.robImmuneRoleIds ?? []) as string[];
    if (immuneIds.length && interaction.guild) {
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      if (member && immuneIds.some(id => member.roles.cache.has(id))) {
        await interaction.editReply(
          `${target} has a **rob immunity** role and can’t be robbed.`,
        );
        return;
      }
    }

    const their = await getCashBalance(interaction.guildId, target.id);
    if ((their.cash ?? 0) + (their.bank ?? 0) < 50) {
      await interaction.editReply(`${target} is too broke to rob.`);
      return;
    }
    const { getGuildPayouts, rollChance, rollRobSteal, rollRange } = await import("./payouts.js");
    const pay = await getGuildPayouts(interaction.guildId);
    const success = rollChance(pay.robSuccessChancePct);
    const { logGameEvent } = await import("../logging/channel-log.js");
    const thiefUrl = interaction.user.displayAvatarURL({ size: 256, extension: "png" });
    const victimUrl = target.displayAvatarURL({ size: 256, extension: "png" });
    if (success) {
      const amount = rollRobSteal(their.cash ?? 0, pay);
      await spendFunds(interaction.guildId, target.id, amount, `Robbed by ${interaction.user.id}`);
      const bal = await earnCash(interaction.guildId, interaction.user.id, amount, `Robbed ${target.id}`);
      await markIncomeCooldown(interaction.guildId, interaction.user.id, "rob");
      const gif = await renderRobGif({
        success: true,
        thiefAvatarUrl: thiefUrl,
        victimAvatarUrl: victimUrl,
        thiefName: interaction.user.username,
        victimName: target.username,
      });
      const { files, imageName } = await attachGif(gif, "rob.gif");
      const embed = brandEmbed("Stick-up", [
        `${interaction.user} robbed ${target} for **${fmtCash(amount)}** ${bal.symbol}`,
        `Your cash **${fmtCash(bal.cash)}**`,
      ].join("\n"));
      if (imageName) embed.setImage(`attachment://${imageName}`);
      await replyThenPostAsUnbelievaBoat(interaction, { embeds: [embed], files, slashHint: "/rob_ub" });
      void logGameEvent(interaction.client, interaction.guildId, interaction.user, "Rob success",
        `Stole ${fmtCash(amount)} from ${target.tag}`,
        [{ name: "Target", value: `${target}`, inline: true }]);
    } else {
      const fine = rollRange(pay.robFailFineMin, pay.robFailFineMax);
      const spent = await spendFunds(interaction.guildId, interaction.user.id, fine, `Failed rob`);
      await markIncomeCooldown(interaction.guildId, interaction.user.id, "rob");
      const gif = await renderRobGif({
        success: false,
        thiefAvatarUrl: thiefUrl,
        victimAvatarUrl: victimUrl,
        thiefName: interaction.user.username,
        victimName: target.username,
      });
      const { files, imageName } = await attachGif(gif, "rob.gif");
      const embed = brandEmbed("Stick-up failed", [
        `${interaction.user} got fined trying to rob ${target}.`,
        formatSpendNote(spent.fromCash, spent.fromBank, spent.balance.symbol),
      ].join("\n"));
      if (imageName) embed.setImage(`attachment://${imageName}`);
      await replyThenPostAsUnbelievaBoat(interaction, { embeds: [embed], files, slashHint: "/rob_ub" });
      void logGameEvent(interaction.client, interaction.guildId, interaction.user, "Rob failed",
        `Fined trying to rob ${target.tag}`);
    }
  } catch (err) {
    await interaction.editReply(err instanceof CashError ? err.message : `Failed: ${err instanceof Error ? err.message : err}`);
  }
}

export async function handleSlut(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) { await interaction.reply({ content: "Server only.", ...EPHEMERAL }); return; }
  await interaction.deferReply({ ephemeral: true });
  try {
    await assertGamesOn(interaction.guildId);
    await assertIncomeCooldown(interaction.guildId, interaction.user.id, "beg");
    const { getGuildPayouts, rollChance, rollRange } = await import("./payouts.js");
    const pay = await getGuildPayouts(interaction.guildId);
    const pity = rollChance(pay.begChancePct);
    const amount = pity ? rollRange(pay.begMin, pay.begMax) : 0;
    let bal = await getCashBalance(interaction.guildId, interaction.user.id);
    if (amount > 0) bal = await earnCash(interaction.guildId, interaction.user.id, amount, "PG cash beg");
    await markIncomeCooldown(interaction.guildId, interaction.user.id, "beg");
    const gif = await renderBegGif();
    const { files, imageName } = await attachGif(gif, "beg.gif");
    const embed = brandEmbed("s░░t · dramatic beg", [
      `${interaction.user} puts on a PG drama show…`,
      amount > 0 ? `Pity payout **+${fmtCash(amount)}** ${bal.symbol}` : `Street is cold — **0**`,
      `Cash **${fmtCash(bal.cash)}** · bank **${fmtCash(bal.bank)}**`,
      "_Wholesome meme beg only — no NSFW._",
    ].join("\n"));
    if (imageName) embed.setImage(`attachment://${imageName}`);
    await replyThenPostAsUnbelievaBoat(interaction, { embeds: [embed], files, slashHint: "/beg_ub" });
  } catch (err) {
    await interaction.editReply(err instanceof CashError ? err.message : `Failed: ${err instanceof Error ? err.message : err}`);
  }
}

// ── Component router ──────────────────────────────────────────────────────────

export async function handleUnbGameComponent(interaction: ButtonInteraction): Promise<void> {
  const id = interaction.customId;
  if (!interaction.guildId) {
    await interaction.reply({ content: "Server only.", ...EPHEMERAL });
    return;
  }

  // Mini UNO
  if (id.startsWith("unbgame:uno:")) {
    const { handleUnoComponent } = await import("./uno.js");
    await handleUnoComponent(interaction);
    return;
  }

  // Blackjack moves
  if (id.startsWith("unbgame:bj:")) {
    const parts = id.split(":");
    const action = parts[2]!;
    const ownerId = parts[3]!;
    if (interaction.user.id !== ownerId) {
      await interaction.reply({ content: "Not your hand.", ...EPHEMERAL });
      return;
    }
    const key = bjKey(interaction.guildId, ownerId);
    const session = bjSessions.get(key);
    if (!session || session.expires < Date.now()) {
      bjSessions.delete(key);
      await interaction.reply({ content: "Hand expired — start `/casino` → Blackjack again.", ...EPHEMERAL });
      return;
    }
    await interaction.deferUpdate();

    if (action === "hit") {
      session.player.push(draw(session.deck));
      const p = handTotal(session.player);
      if (p.total > 21) {
        await finishBlackjack(interaction, session, true);
        return;
      }
      const newIdx = session.player.length - 1;
      const hitOpts: BjTableOpts = {
        player: session.player,
        dealer: session.dealer,
        hideDealer: true,
        animatePlayerFrom: newIdx,
        animateDealerFrom: session.dealer.length,
      };
      const embed = brandEmbed("Blackjack — your move", [
        `You: ${formatHand(session.player)} (**${p.total}**${p.soft ? " soft" : ""})`,
        `Dealer: ${formatHand(session.dealer, true)}`,
      ].join("\n"));
      // Clear buttons + encode flip/still in parallel, then play one beat
      const [, gif, stillPng] = await Promise.all([
        updateGameMessage(interaction, {
          content: `<@${ownerId}> — dealing…`,
          embeds: [embed],
          components: [],
        }),
        renderBlackjackTableGif(hitOpts),
        renderBlackjackTablePng(hitOpts),
      ]);
      await playBjBeat(interaction.message, {
        content: `<@${ownerId}> — **your move**: press **Hit** or **Stand**`,
        embed,
        gif,
        gifName: "bj-hit.gif",
        stillOpts: hitOpts,
        stillName: "bj-hit.png",
        stillPng,
        components: bjButtons(ownerId, false),
      });
      return;
    }

    if (action === "double") {
      try {
        const extra = await spendFunds(session.guildId, session.userId, session.bet, "Blackjack double");
        session.bet *= 2;
        session.fromCash += extra.fromCash;
        session.fromBank += extra.fromBank;
        session.doubled = true;
        session.player.push(draw(session.deck));
        await finishBlackjack(interaction, session, true);
      } catch (err) {
        await interaction.followUp({
          content: err instanceof CashError ? err.message : "Can't double.",
          ...EPHEMERAL,
        });
      }
      return;
    }

    if (action === "stand") {
      await finishBlackjack(interaction, session, true);
      return;
    }
  }

  // Higher / lower
  if (id.startsWith("unbgame:hl:")) {
    const parts = id.split(":");
    const pick = parts[2] as "higher" | "lower";
    const ownerId = parts[3]!;
    if (interaction.user.id !== ownerId) {
      await interaction.reply({ content: "Not your round.", ...EPHEMERAL });
      return;
    }
    const key = bjKey(interaction.guildId, ownerId);
    const session = higherSessions.get(key);
    if (!session || session.expires < Date.now()) {
      higherSessions.delete(key);
      await interaction.reply({ content: "Round expired.", ...EPHEMERAL });
      return;
    }
    higherSessions.delete(key);
    await interaction.deferUpdate();
    const next = draw(session.deck);
    const shownV = rankValue(session.shown);
    const nextV = rankValue(next);
    const win = pick === "higher" ? nextV > shownV : nextV < shownV;
    let bal = await getCashBalance(session.guildId, session.userId);
    if (win) bal = await earnCash(session.guildId, session.userId, session.bet * 2, "Higher/Lower win");
    const gif = await renderHigherLowerGif({
      shown: cardLabel(session.shown), next: cardLabel(next), result: win ? "win" : "lose",
    });
    const { files, imageName } = await attachGif(gif, "hl-result.gif");
    const embed = brandEmbed("Higher or Lower", [
      `<@${ownerId}> guessed **${pick}**`,
      `${cardLabel(session.shown)} → ${cardLabel(next)}`,
      win ? `🎉 Won **${fmtCash(session.bet * 2)}**` : `💀 Lost **${fmtCash(session.bet)}**`,
      formatSpendNote(session.fromCash, session.fromBank, bal.symbol),
      `Cash **${fmtCash(bal.cash)}** · bank **${fmtCash(bal.bank)}**`,
    ].join("\n"));
    if (imageName) embed.setImage(`attachment://${imageName}`);
    await updateGameMessage(interaction, { content: null, embeds: [embed], files, components: [] });
    return;
  }

  // Live slots / roulette / russian duel
  if (id.startsWith("unbgame:slots:")) {
    const { handleSlotsComponent } = await import("./live-slots.js");
    if (await handleSlotsComponent(interaction)) return;
  }
  if (id.startsWith("unbgame:roulette:")) {
    const { handleRouletteComponent } = await import("./live-roulette.js");
    if (await handleRouletteComponent(interaction)) return;
  }
  if (id.startsWith("unbgame:russian:")) {
    const { handleRussianComponent } = await import("./russian-duel.js");
    if (await handleRussianComponent(interaction)) return;
  }
}

/** Expose defaults for the admin cooldown panel. */
export { DEFAULT_COOLDOWNS, getGuildCooldowns, cdText } from "./cooldowns.js";
export { readCooldowns } from "./cooldowns.js";
