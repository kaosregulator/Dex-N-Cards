// Live Powerball / lottery / mega weekly reveal + payout.

import {
  AttachmentBuilder,
  EmbedBuilder,
  type Client,
  type Guild,
  type TextChannel,
} from "discord.js";
import {
  GAME_DEFS,
  DRAW_GAMES,
  drawWinningNumbers,
  scoreTicket,
  formatNums,
  type DrawGameKey,
} from "./catalog.js";
import {
  getOrCreateLotterySettings,
  updateLotterySettings,
  getPool,
  setPoolAmount,
  setPoolStatus,
  listOpenTickets,
  createDraw,
  completeDraw,
  assignTicketsToDraw,
  markTicketPrize,
  listGuildsDueForWeeklyDraw,
} from "../../../lib/lottery/db.js";
import { earnCash, fmtCash, requireEconomy } from "../cash.js";
import { renderBallRevealGif, renderLotteryWinnersGif, type WinnerPortrait } from "./render.js";
import { getBotClient } from "../../client-holder.js";
import { logger } from "../../../lib/logger.js";

const SWEEP_MS = 45_000;
let started = false;

function utcDateKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function startLotteryMaintenance(): void {
  if (started) return;
  started = true;
  setTimeout(() => { void sweepOnce(); }, 40_000);
  setInterval(() => { void sweepOnce(); }, SWEEP_MS);
}

async function sweepOnce(): Promise<void> {
  const client = getBotClient();
  if (!client) return;
  try {
    const now = new Date();
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
    const dateKey = utcDateKey(now);
    const due = await listGuildsDueForWeeklyDraw(day, hour, dateKey);
    for (const settings of due) {
      if (!settings.announceChannelId) continue;
      try {
        const guild = await client.guilds.fetch(settings.guildId).catch(() => null);
        if (!guild) continue;
        // Weekly: run Powerball first, then classic + mega if they have tickets.
        for (const game of DRAW_GAMES) {
          await runLiveDraw(guild, game, settings.announceChannelId).catch(err => {
            logger.warn({ err, guildId: guild.id, game }, "lottery weekly draw failed");
          });
        }
        await updateLotterySettings(settings.guildId, { lastDrawDate: dateKey });
      } catch (err) {
        logger.warn({ err, guildId: settings.guildId }, "lottery weekly guild failed");
      }
    }
  } catch (err) {
    logger.debug({ err }, "lottery sweep failed");
  }
}

/** Admin or weekly: animated ball reveal + pay winners. */
export async function runLiveDraw(
  guild: Guild,
  gameKey: DrawGameKey,
  channelId: string,
): Promise<{ drawId: number; winners: number } | null> {
  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch || !ch.isTextBased()) return null;
  const text = ch as TextChannel;

  const pool = await getPool(guild.id, gameKey);
  const tickets = await listOpenTickets(guild.id, gameKey);
  if (tickets.length === 0 && pool.poolAmount <= pool.seedAmount) {
    // Still announce a fun tease? Skip empty draws with no tickets.
    return null;
  }

  await setPoolStatus(guild.id, gameKey, "drawing");
  const def = GAME_DEFS[gameKey];
  let symbol = "";
  try { ({ symbol } = await requireEconomy(guild.id)); } catch { /* */ }

  const { numbers, bonus } = drawWinningNumbers(gameKey);
  const draw = await createDraw({
    guildId: guild.id,
    gameKey,
    winningNumbers: numbers,
    powerball: bonus,
    poolAtDraw: pool.poolAmount,
    channelId,
    status: "live",
  });
  await assignTicketsToDraw(tickets.map(t => t.id), draw.id);

  const intro = await text.send({
    embeds: [
      new EmbedBuilder()
        .setColor(def.color)
        .setTitle(`${def.emoji} ${def.name} — LIVE DRAW`)
        .setDescription(
          [
            `Jackpot on the line: **${symbol}${fmtCash(pool.poolAmount)}**`,
            `Tickets in drum: **${tickets.length}**`,
            "",
            "Balls dropping… hang tight.",
          ].join("\n"),
        ),
    ],
  });

  const totalBalls = numbers.length + (bonus != null ? 1 : 0);
  let revealMsg = intro;
  for (let revealed = 1; revealed <= totalBalls; revealed++) {
    const gif = await renderBallRevealGif({
      title: `${def.name} LIVE`,
      numbers,
      bonus,
      bonusLabel: def.bonusLabel,
      revealedCount: revealed,
      jackpot: pool.poolAmount,
      symbol,
    });
    const files = gif ? [new AttachmentBuilder(gif, { name: `draw-${revealed}.gif` })] : [];
    const embed = new EmbedBuilder()
      .setColor(def.color)
      .setTitle(`${def.emoji} Drawing… ${revealed}/${totalBalls}`)
      .setDescription(
        revealed >= totalBalls
          ? `**Final:** ${formatNums(numbers, bonus, def.bonusLabel)}`
          : `Revealing ball **${revealed}**…`,
      );
    if (gif) embed.setImage(`attachment://draw-${revealed}.gif`);
    try {
      if (revealed === 1) {
        revealMsg = await text.send({ embeds: [embed], files });
      } else {
        await revealMsg.edit({ embeds: [embed], files });
      }
    } catch {
      revealMsg = await text.send({ embeds: [embed], files });
    }
    await sleep(2200);
  }

  // Score & pay
  type WinRow = {
    userId: string;
    ticketId: number;
    tier: string;
    amount: number;
    numbers: number[];
    powerball: number | null;
  };
  const wins: WinRow[] = [];
  let poolLeft = pool.poolAmount;

  for (const ticket of tickets) {
    const result = scoreTicket(
      gameKey,
      ticket.numbers,
      ticket.powerball,
      numbers,
      bonus,
    );
    if (!result) continue;
    if (result.shareOfPool >= 1) {
      wins.push({
        userId: ticket.userId,
        ticketId: ticket.id,
        tier: result.tier,
        amount: -1,
        numbers: ticket.numbers,
        powerball: ticket.powerball ?? null,
      });
    } else if (result.shareOfPool > 0) {
      let amount = Math.floor(pool.poolAmount * result.shareOfPool);
      amount = Math.min(amount, poolLeft);
      poolLeft -= amount;
      wins.push({
        userId: ticket.userId,
        ticketId: ticket.id,
        tier: result.tier,
        amount,
        numbers: ticket.numbers,
        powerball: ticket.powerball ?? null,
      });
    } else {
      let amount = ticket.cost * result.fixedMultiplier;
      amount = Math.min(amount, poolLeft);
      poolLeft -= amount;
      if (amount > 0) {
        wins.push({
          userId: ticket.userId,
          ticketId: ticket.id,
          tier: result.tier,
          amount,
          numbers: ticket.numbers,
          powerball: ticket.powerball ?? null,
        });
      }
    }
  }

  // Resolve jackpot splits across every jackpot ticket (ties).
  const jackpotWins = wins.filter(w => w.amount === -1);
  if (jackpotWins.length > 0) {
    const share = Math.floor(poolLeft / jackpotWins.length);
    for (const w of jackpotWins) {
      w.amount = share;
      poolLeft -= share;
    }
  }

  for (const w of wins) {
    if (w.amount <= 0) continue;
    try {
      await earnCash(guild.id, w.userId, w.amount, `${def.name} ${w.tier}`);
      await markTicketPrize(w.ticketId, w.amount);
    } catch (err) {
      logger.warn({ err, w }, "lottery payout failed");
    }
  }

  const seed = pool.seedAmount;
  const nextPool = Math.max(seed, poolLeft);
  const hadJackpot = wins.some(w => w.tier.toLowerCase().includes("jackpot"));
  await setPoolAmount(guild.id, gameKey, hadJackpot ? seed : nextPool);
  await setPoolStatus(guild.id, gameKey, "open");

  // Top tier for “exciting tie” celebration (same payout + same tier).
  const paid = wins.filter(w => w.amount > 0).sort((a, b) => b.amount - a.amount);
  const topAmount = paid[0]?.amount ?? 0;
  const topTier = paid[0]?.tier ?? "";
  const tiedTop = paid.filter(w => w.amount === topAmount && w.tier === topTier);
  const isTie = tiedTop.length >= 2;

  const portraits: WinnerPortrait[] = [];
  for (const w of (isTie ? tiedTop : paid.slice(0, 1))) {
    const member = await guild.members.fetch(w.userId).catch(() => null);
    portraits.push({
      displayName: member?.displayName ?? w.userId,
      avatarUrl: member?.displayAvatarURL({ extension: "png", size: 128 }) ?? null,
      amount: w.amount,
      numbersLine: formatNums(w.numbers, w.powerball, def.bonusLabel),
      ticketId: w.ticketId,
      tier: w.tier,
    });
  }

  let winnerFile: AttachmentBuilder[] = [];
  if (portraits.length > 0) {
    const title = isTie
      ? `🎉 ${tiedTop.length} WINNERS!`
      : hadJackpot
        ? "JACKPOT!"
        : "WINNER!";
    const gif = await renderLotteryWinnersGif({
      title,
      symbol,
      winners: portraits,
    });
    if (gif) winnerFile = [new AttachmentBuilder(gif, { name: "lottery-winner.gif" })];
  }

  const winnerLines = paid.length
    ? paid.map(w => {
      const ticketLine = formatNums(w.numbers, w.powerball, def.bonusLabel);
      return (
        `• <@${w.userId}> — **${w.tier}** · ${symbol}${fmtCash(w.amount)}\n` +
        `  Ticket #${w.ticketId}: ${ticketLine}`
      );
    }).join("\n")
    : "_No winning tickets this draw — jackpot rolls on._";

  if (isTie) {
    const tease = await text.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle(`🔥 IT'S A TIE — ${tiedTop.length} WINNERS!`)
          .setDescription(
            [
              `**${def.name}** just hit a split!`,
              `Winning numbers: ${formatNums(numbers, bonus, def.bonusLabel)}`,
              "",
              ...tiedTop.map((w, i) =>
                `**Winner ${i + 1}:** <@${w.userId}> · Ticket #${w.ticketId}\n` +
                `└ ${formatNums(w.numbers, w.powerball, def.bonusLabel)} · **${symbol}${fmtCash(w.amount)}**`,
              ),
              "",
              "Scroll for the celebration card ⬇️",
            ].join("\n"),
          ),
      ],
    });
    void tease;
  }

  const finalEmbed = new EmbedBuilder()
    .setColor(def.color)
    .setTitle(
      isTie
        ? `${def.emoji} ${def.name} — ${tiedTop.length}-WAY SPLIT!`
        : `${def.emoji} ${def.name} — Results`,
    )
    .setDescription(
      [
        `**Drawn numbers:** ${formatNums(numbers, bonus, def.bonusLabel)}`,
        `Pool at draw: **${symbol}${fmtCash(pool.poolAmount)}**`,
        `Next pool: **${symbol}${fmtCash(hadJackpot ? seed : nextPool)}**`,
        "",
        isTie ? `🏆 **${tiedTop.length} winners** share the top prize:\n` : "**Winners:**\n",
        winnerLines,
      ].join("\n"),
    );
  if (winnerFile.length) finalEmbed.setImage("attachment://lottery-winner.gif");

  const finalMsg = await text.send({ embeds: [finalEmbed], files: winnerFile });
  await completeDraw(
    draw.id,
    wins.map(w => ({
      userId: w.userId,
      ticketId: w.ticketId,
      tier: w.tier,
      amount: w.amount,
      numbers: w.numbers,
      powerball: w.powerball,
    })),
    finalMsg.id,
  );

  return { drawId: draw.id, winners: wins.length };
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

/** Post a flashy “draw is live / buy tickets” board for admins. */
export async function postJackpotBoard(
  guild: Guild,
  channelId: string,
  gameKey: DrawGameKey,
): Promise<void> {
  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch || !ch.isTextBased()) throw new Error("Announce channel not found.");
  const pool = await getPool(guild.id, gameKey);
  const def = GAME_DEFS[gameKey];
  let symbol = "";
  try { ({ symbol } = await requireEconomy(guild.id)); } catch { /* */ }
  const open = await listOpenTickets(guild.id, gameKey);
  const gif = await renderBallRevealGif({
    title: `${def.name} OPEN`,
    numbers: [7, 14, 21, 28, 35].slice(0, def.pickCount),
    bonus: def.bonusMax ? 9 : null,
    bonusLabel: def.bonusLabel,
    revealedCount: 0,
    jackpot: pool.poolAmount,
    symbol,
  });
  const files = gif ? [new AttachmentBuilder(gif, { name: "jackpot-board.gif" })] : [];
  const embed = new EmbedBuilder()
    .setColor(def.color)
    .setTitle(`${def.emoji} ${def.name} is LIVE`)
    .setDescription(
      [
        `💰 **Jackpot:** ${symbol}${fmtCash(pool.poolAmount)}`,
        `🎟️ **Ticket:** ${symbol}${fmtCash(pool.ticketPrice)}`,
        `🧾 Open tickets: **${open.length}**`,
        "",
        "Buy in with `/lottery` — pick your numbers step by step.",
        "All ticket money feeds this pool. Winners take the pot.",
      ].join("\n"),
    );
  if (gif) embed.setImage("attachment://jackpot-board.gif");
  await (ch as TextChannel).send({ embeds: [embed], files });
}

export async function forceWeeklyMark(client: Client, guildId: string): Promise<void> {
  void client;
  await updateLotterySettings(guildId, { lastDrawDate: null });
}

export { getOrCreateLotterySettings };
