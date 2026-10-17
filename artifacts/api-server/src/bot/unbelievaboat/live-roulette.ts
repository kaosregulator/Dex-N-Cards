// Interactive roulette — pick color, then hit SPIN (engagement, not one-shot).

import type {
  ChatInputCommandInteraction,
  ButtonInteraction,
} from "discord.js";
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  MessageFlags,
} from "discord.js";
import { UNBELIEVABOAT_AUTHOR, UNBELIEVABOAT_COLOR } from "./branding.js";
import {
  CashError, earnCash, spendFunds, getCashBalance, fmtCash, formatSpendNote,
} from "./cash.js";
import { assertGameCooldown, markGameCooldown } from "./cooldowns.js";
import { getOrCreateUbSettings } from "../../lib/unbelievaboat/db.js";
import { openTableAsUnbelievaBoat } from "./webhook.js";
import { renderRouletteGif } from "./render-games.js";
import { RESPONSIBLE_PLAY } from "./live-slots.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

type RouletteSession = {
  guildId: string;
  userId: string;
  bet: number;
  /** `.roul all` locks the stake to cash and never touches bank. */
  cashOnly: boolean;
  color: "red" | "black" | "green" | null;
  expires: number;
};

const sessions = new Map<string, RouletteSession>();
function key(g: string, u: string) { return `${g}:${u}`; }

function brandEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(UNBELIEVABOAT_COLOR)
    .setAuthor(UNBELIEVABOAT_AUTHOR)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: RESPONSIBLE_PLAY });
}

async function attachGif(result: { buffer: Buffer } | null, name: string) {
  if (!result) return { files: [] as AttachmentBuilder[], imageName: null as string | null };
  return { files: [new AttachmentBuilder(result.buffer, { name })], imageName: name };
}

async function assertGamesOn(guildId: string) {
  const s = await getOrCreateUbSettings(guildId);
  if (!s.gamesEnabled) throw new CashError("UnbelievaBoat mini-games are disabled on this server.");
}

function colorButtons(userId: string, selected: string | null) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`unbgame:roulette:color:red:${userId}`)
        .setLabel(selected === "red" ? "● Red (2×)" : "Red (2×)")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`unbgame:roulette:color:black:${userId}`)
        .setLabel(selected === "black" ? "● Black (2×)" : "Black (2×)")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`unbgame:roulette:color:green:${userId}`)
        .setLabel(selected === "green" ? "● Green (14×)" : "Green 0 (14×)")
        .setStyle(ButtonStyle.Success),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`unbgame:roulette:spin:${userId}`)
        .setLabel("SPIN THE WHEEL")
        .setEmoji("🎡")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!selected),
      new ButtonBuilder()
        .setCustomId(`unbgame:roulette:leave:${userId}`)
        .setLabel("Leave table")
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

function againButtons(userId: string) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`unbgame:roulette:again:${userId}`).setLabel("Play again").setEmoji("🎡").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`unbgame:roulette:leave:${userId}`).setLabel("Leave table").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

/** Open roulette table — color pick then SPIN. Bet from options (or session). */
export async function handleRoulette(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "Server only.", ...EPHEMERAL });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    await assertGamesOn(interaction.guildId);
    await assertGameCooldown(interaction.guildId, interaction.user.id);
    const bet = interaction.options.getInteger("bet", true);
    const preColor = interaction.options.getString("color") as "red" | "black" | "green" | null;
    let cashOnly = false;
    try { cashOnly = interaction.options.getBoolean("cash_only") === true; } catch { cashOnly = false; }
    const bal = await getCashBalance(interaction.guildId, interaction.user.id);
    const purse = cashOnly ? (bal.cash ?? 0) : (bal.cash ?? 0) + (bal.bank ?? 0);
    if (purse < bet) {
      await interaction.editReply(
        cashOnly
          ? `Need **${fmtCash(bet)}** cash ${bal.symbol}. Bank is not used for \`all\`.`
          : `Need **${fmtCash(bet)}** ${bal.symbol}.`,
      );
      return;
    }
    await markGameCooldown(interaction.guildId, interaction.user.id);
    const k = key(interaction.guildId, interaction.user.id);
    sessions.set(k, {
      guildId: interaction.guildId,
      userId: interaction.user.id,
      bet,
      cashOnly,
      color: preColor && ["red", "black", "green"].includes(preColor) ? preColor : null,
      expires: Date.now() + 15 * 60_000,
    });
    const session = sessions.get(k)!;
    const embed = brandEmbed("🎡 Roulette Table", [
      `${interaction.user} · stake **${fmtCash(bet)}** ${bal.symbol}` +
        (cashOnly ? " · **all cash**" : ""),
      session.color ? `Color locked: **${session.color}**` : "Pick a color, then **SPIN THE WHEEL**.",
      `Cash **${fmtCash(bal.cash)}** · bank **${fmtCash(bal.bank)}**`,
    ].join("\n"));
    await openTableAsUnbelievaBoat(interaction, {
      embeds: [embed],
      components: colorButtons(interaction.user.id, session.color),
      slashHint: `/roulette_ub bet:${bet}`,
    }, "✅ Roulette opened as **UnbelievaBoat** — play on the floor.");
  } catch (err) {
    await interaction.editReply(err instanceof CashError ? err.message : `Failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function doSpin(interaction: ButtonInteraction, session: RouletteSession) {
  if (!session.color) throw new CashError("Pick a color first.");
  const spent = await spendFunds(
    session.guildId,
    session.userId,
    session.bet,
    `Roulette ${session.color}`,
    session.cashOnly ? { cashOnly: true } : undefined,
  );
  const landing = Math.floor(Math.random() * 37);
  const landed: "red" | "black" | "green" =
    landing === 0 ? "green" : landing % 2 === 0 ? "black" : "red";
  const mult = session.color === "green" ? 14 : 2;
  const win = session.color === landed;
  const payout = win ? session.bet * mult : 0;
  let bal = spent.balance;
  if (payout > 0) bal = await earnCash(session.guildId, session.userId, payout, "Roulette win");

  const gif = await renderRouletteGif({ landing, color: landed });
  const { files, imageName } = await attachGif(gif, "roulette.gif");
  const embed = brandEmbed("🎡 Roulette — Result", [
    `${interaction.user} bet **${fmtCash(session.bet)}** on **${session.color}**`,
    formatSpendNote(spent.fromCash, spent.fromBank, bal.symbol),
    `Ball → **${landing}** (${landed})`,
    win ? `🎉 Won **${fmtCash(payout)}** ${bal.symbol}` : `💀 Lost stake`,
    `Cash **${fmtCash(bal.cash)}** · bank **${fmtCash(bal.bank)}**`,
  ].join("\n"));
  if (imageName) embed.setImage(`attachment://${imageName}`);
  await interaction.editReply({ embeds: [embed], files, components: againButtons(session.userId) });
  // Keep session for play-again (same bet, re-pick color)
  session.color = null;
  session.expires = Date.now() + 15 * 60_000;
}

export async function handleRouletteComponent(interaction: ButtonInteraction): Promise<boolean> {
  const id = interaction.customId;
  if (!id.startsWith("unbgame:roulette:") || !interaction.guildId) return false;
  const parts = id.split(":");
  // unbgame:roulette:color:red:userId | spin:userId | leave | again
  const action = parts[2]!;

  if (action === "color") {
    const color = parts[3] as "red" | "black" | "green";
    const ownerId = parts[4]!;
    if (interaction.user.id !== ownerId) {
      await interaction.reply({ content: "Not your table.", ...EPHEMERAL });
      return true;
    }
    const k = key(interaction.guildId, ownerId);
    const session = sessions.get(k);
    if (!session || session.expires < Date.now()) {
      await interaction.reply({ content: "Session expired — `/casino` → Roulette.", ...EPHEMERAL });
      return true;
    }
    session.color = color;
    await interaction.update({
      embeds: [
        brandEmbed("🎡 Roulette Table", [
          `${interaction.user} · stake **${fmtCash(session.bet)}**` +
            (session.cashOnly ? " · **all cash** (bank stays put)" : ""),
          `Color locked: **${color}** — hit **SPIN THE WHEEL**.`,
        ].join("\n")),
      ],
      components: colorButtons(ownerId, color),
    });
    return true;
  }

  const ownerId = parts[3]!;
  if (interaction.user.id !== ownerId) {
    await interaction.reply({ content: "Not your table.", ...EPHEMERAL });
    return true;
  }
  const k = key(interaction.guildId, ownerId);
  const session = sessions.get(k);

  if (action === "leave") {
    sessions.delete(k);
    await interaction.update({ content: "Left the roulette table.", embeds: [], components: [], files: [] });
    return true;
  }

  if (action === "again") {
    if (!session) {
      await interaction.reply({ content: "Open `/casino` → Roulette to start.", ...EPHEMERAL });
      return true;
    }
    session.color = null;
    session.expires = Date.now() + 15 * 60_000;
    const bal = await getCashBalance(session.guildId, session.userId);
    await interaction.update({
      embeds: [
        brandEmbed("🎡 Roulette Table", [
          `${interaction.user} · stake **${fmtCash(session.bet)}** ${bal.symbol}` +
            (session.cashOnly ? " · **all cash** (bank stays put)" : ""),
          "Pick a color, then **SPIN THE WHEEL**.",
          `Cash **${fmtCash(bal.cash)}** · bank **${fmtCash(bal.bank)}**`,
        ].join("\n")),
      ],
      files: [],
      components: colorButtons(ownerId, null),
    });
    return true;
  }

  if (action === "spin") {
    if (!session || session.expires < Date.now()) {
      sessions.delete(k);
      await interaction.reply({ content: "Session expired.", ...EPHEMERAL });
      return true;
    }
    await interaction.deferUpdate();
    try {
      await assertGamesOn(session.guildId);
      await doSpin(interaction, session);
    } catch (err) {
      await interaction.followUp({
        content: err instanceof CashError ? err.message : `Failed: ${err instanceof Error ? err.message : err}`,
        ...EPHEMERAL,
      }).catch(() => {});
    }
    return true;
  }

  return false;
}
