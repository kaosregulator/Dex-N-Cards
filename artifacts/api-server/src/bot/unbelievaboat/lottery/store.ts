// /lottery — player ticket store + step-by-step pick + scratchers.

import type {
  ChatInputCommandInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from "discord.js";
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
  MessageFlags,
} from "discord.js";
import {
  GAME_DEFS,
  formatNums,
  rollScratchPrize,
  buildScratchCells,
  isDrawGame,
  type DrawGameKey,
  type LotteryGameKey,
} from "./catalog.js";
import {
  ensurePools,
  getPool,
  addToPool,
  setPoolAmount,
  insertTicket,
  createScratcher,
  getScratcher,
  bumpScratchReveal,
  redeemScratcher,
  countOpenTickets,
  getOrCreateLotterySettings,
} from "../../../lib/lottery/db.js";
import {
  resolveGameConfig,
  checkBuyWindow,
  formatBuyWindow,
} from "../../../lib/lottery/config.js";
import { CashError, spendFunds, earnCash, depositCash, fmtCash, requireEconomy } from "../cash.js";
import { renderStoreCardGif, renderScratchGif } from "./render.js";

/** Private-only replies — number picks / scratch must never be public. */
const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;
const COLOR = 0xfee75c;

async function assertCanBuy(
  guildId: string,
  gameKey: LotteryGameKey,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const settings = await getOrCreateLotterySettings(guildId);
  if (!settings.enabled) {
    return { ok: false, message: "Lottery is disabled by staff right now." };
  }
  const cfg = resolveGameConfig(settings, gameKey);
  const window = checkBuyWindow(cfg);
  if (!window.ok) return { ok: false, message: window.reason };
  const pool = await getPool(guildId, gameKey);
  if (pool.status !== "open") {
    return {
      ok: false,
      message: `**${GAME_DEFS[gameKey].name}** is not open for tickets (\`${pool.status}\`).`,
    };
  }
  return { ok: true };
}

type PickDraft = {
  gameKey: DrawGameKey;
  numbers: number[];
  powerball?: number;
  step: number; // 0-based index into picks; after mains, bonus step
  expires: number;
};

const drafts = new Map<string, PickDraft>();
const DRAFT_TTL = 10 * 60_000;

function draftKey(guildId: string, userId: string) {
  return `${guildId}:${userId}`;
}

function pruneDrafts() {
  const now = Date.now();
  for (const [k, v] of drafts) if (v.expires < now) drafts.delete(k);
}

export async function handleLotteryCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply(EPHEMERAL);
  await showStore(interaction);
}

export async function handleLotteryComponent(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
): Promise<void> {
  const id = interaction.customId;
  if (id === "lottery:store" && interaction.isButton()) {
    await interaction.deferUpdate();
    await showStore(interaction);
    return;
  }
  if (id === "lottery:pick_game" && interaction.isStringSelectMenu()) {
    const game = interaction.values[0] as LotteryGameKey;
    const gate = await assertCanBuy(interaction.guildId!, game);
    if (!gate.ok) {
      await interaction.reply({ content: gate.message, ...EPHEMERAL });
      return;
    }
    if (game === "scratch") {
      await beginScratchPurchase(interaction);
      return;
    }
    if (isDrawGame(game)) {
      await beginPickFlow(interaction, game);
      return;
    }
  }
  if (id.startsWith("lottery:num:") && interaction.isButton()) {
    await interaction.showModal(numberModal(id.slice("lottery:num:".length)));
    return;
  }
  if (id.startsWith("lottery:modal:num:") && interaction.isModalSubmit()) {
    await onNumberModal(interaction);
    return;
  }
  if (id === "lottery:confirm" && interaction.isButton()) {
    await confirmPurchase(interaction);
    return;
  }
  if (id === "lottery:cancel" && interaction.isButton()) {
    drafts.delete(draftKey(interaction.guildId!, interaction.user.id));
    await interaction.update({
      content: "Ticket cancelled — nothing charged.",
      embeds: [],
      components: [],
      files: [],
    });
    return;
  }
  if (id.startsWith("lottery:scratch:") && interaction.isButton()) {
    await onScratchTap(interaction);
    return;
  }
  if (id.startsWith("lottery:redeem:") && interaction.isButton()) {
    await onRedeem(interaction);
    return;
  }
}

async function showStore(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
): Promise<void> {
  const guildId = interaction.guildId!;
  let symbol = "¢";
  try {
    ({ symbol } = await requireEconomy(guildId));
  } catch {
    /* show store anyway */
  }
  const settings = await getOrCreateLotterySettings(guildId);
  const pools = await ensurePools(guildId);

  const lines = pools.map(p => {
    const key = p.gameKey as LotteryGameKey;
    const def = GAME_DEFS[key];
    if (!def) return null;
    const cfg = resolveGameConfig(settings, key);
    const win = checkBuyWindow(cfg);
    const openTag = win.ok ? "🟢 open" : "🔴 closed";
    return (
      `${def.emoji} **${def.name}** — jackpot **${symbol}${fmtCash(p.poolAmount)}**` +
      ` · ticket **${symbol}${fmtCash(p.ticketPrice)}** · ${openTag}\n` +
      `└ Buy: ${formatBuyWindow(cfg)}`
    );
  }).filter(Boolean);

  const featured = pools.find(p => p.gameKey === "powerball") ?? pools[0]!;
  const featDef = GAME_DEFS[featured.gameKey as LotteryGameKey];
  const gif = await renderStoreCardGif({
    gameKey: featured.gameKey as LotteryGameKey,
    jackpot: featured.poolAmount,
    ticketPrice: featured.ticketPrice,
    symbol,
  });
  const files = gif ? [new AttachmentBuilder(gif, { name: "lottery-store.gif" })] : [];

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("🎱 Lottery Ticket Store")
    .setDescription(
      [
        "🔒 **Private** — your number picks & scratch cards are only visible to you.",
        "Buy with **UnbelievaBoat** cash/bank. Ticket money feeds the prize pool.",
        settings.enabled ? "" : "⚠️ Lottery is **disabled** by staff.",
        "",
        ...lines,
        "",
        "Pick a game → enter numbers privately → preview → pay.",
      ].filter(Boolean).join("\n"),
    )
    .setFooter({ text: "UB Lottery · only you see this panel" });
  if (gif) embed.setImage("attachment://lottery-store.gif");
  else embed.setAuthor({ name: featDef.name });

  const menu = new StringSelectMenuBuilder()
    .setCustomId("lottery:pick_game")
    .setPlaceholder("Choose what to play…")
    .addOptions(
      { label: "Classic Lottery", value: "classic", emoji: "🎟️", description: `Pick 5 · ${symbol}${pools.find(p => p.gameKey === "classic")?.ticketPrice ?? GAME_DEFS.classic.ticketPrice}` },
      { label: "Powerball", value: "powerball", emoji: "🔴", description: `5 + PB · ${symbol}${pools.find(p => p.gameKey === "powerball")?.ticketPrice ?? GAME_DEFS.powerball.ticketPrice}` },
      { label: "Mega Millionaire", value: "mega", emoji: "💎", description: `5 + Mega · ${symbol}${pools.find(p => p.gameKey === "mega")?.ticketPrice ?? GAME_DEFS.mega.ticketPrice}` },
      { label: "Scratch Ticket", value: "scratch", emoji: "🎫", description: `Instant · ${symbol}${pools.find(p => p.gameKey === "scratch")?.ticketPrice ?? GAME_DEFS.scratch.ticketPrice}` },
    );

  const payload = {
    content: null as string | null,
    embeds: [embed],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    files,
  };

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload);
  } else {
    await interaction.reply({ ...payload, ...EPHEMERAL });
  }
}

async function beginPickFlow(
  interaction: StringSelectMenuInteraction,
  gameKey: DrawGameKey,
): Promise<void> {
  pruneDrafts();
  const pool = await getPool(interaction.guildId!, gameKey);
  drafts.set(draftKey(interaction.guildId!, interaction.user.id), {
    gameKey,
    numbers: [],
    step: 0,
    expires: Date.now() + DRAFT_TTL,
  });
  const def = GAME_DEFS[gameKey];
  const settings = await getOrCreateLotterySettings(interaction.guildId!);
  const cfg = resolveGameConfig(settings, gameKey);
  // Stay on the same ephemeral store message — never post picks publicly.
  await interaction.deferUpdate();
  await interaction.editReply({
    content: null,
    files: [],
    embeds: [
      new EmbedBuilder()
        .setColor(def.color)
        .setTitle(`${def.emoji} ${def.name} — pick your numbers`)
        .setDescription(
          [
            "🔒 **Only you can see this** — your numbers stay private until the public draw.",
            "",
            `Ticket price: **${fmtCash(pool.ticketPrice)}** (cash first, then bank)`,
            `Current jackpot: **${fmtCash(pool.poolAmount)}**`,
            `Buy window: ${formatBuyWindow(cfg)}`,
            "",
            `Enter **${def.pickCount}** numbers from **1–${def.mainMax}**` +
              (def.bonusMax ? `, then a **${def.bonusLabel}** (1–${def.bonusMax})` : "") +
              ".",
            "",
            "Press **Enter number 1**. Preview before anything is charged.",
          ].join("\n"),
        ),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("lottery:num:1")
          .setLabel("Enter number 1")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("lottery:cancel")
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

function numberModal(stepLabel: string) {
  return new ModalBuilder()
    .setCustomId(`lottery:modal:num:${stepLabel}`)
    .setTitle(`Lottery number ${stepLabel}`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("n")
          .setLabel(`Enter number ${stepLabel}`)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(3)
          .setPlaceholder("e.g. 14"),
      ),
    );
}

async function onNumberModal(interaction: ModalSubmitInteraction): Promise<void> {
  pruneDrafts();
  const key = draftKey(interaction.guildId!, interaction.user.id);
  const draft = drafts.get(key);
  if (!draft) {
    await interaction.reply({ content: "Session expired — open `/lottery` again.", ...EPHEMERAL });
    return;
  }
  // Re-check buy window mid-flow so sales can close cleanly.
  const gate = await assertCanBuy(interaction.guildId!, draft.gameKey);
  if (!gate.ok) {
    drafts.delete(key);
    await interaction.reply({ content: gate.message, ...EPHEMERAL });
    return;
  }
  const def = GAME_DEFS[draft.gameKey];
  const raw = interaction.fields.getTextInputValue("n").trim();
  const n = Number.parseInt(raw, 10);
  const needBonus = draft.numbers.length >= def.pickCount && def.bonusMax != null;
  const max = needBonus ? def.bonusMax! : def.mainMax;

  if (!Number.isFinite(n) || n < 1 || n > max) {
    await interaction.reply({
      content: `Enter a whole number from **1** to **${max}**.`,
      ...EPHEMERAL,
    });
    return;
  }
  if (!needBonus && draft.numbers.includes(n)) {
    await interaction.reply({
      content: `You already picked **${n}**. Choose a different number.`,
      ...EPHEMERAL,
    });
    return;
  }

  if (needBonus) {
    draft.powerball = n;
  } else {
    draft.numbers.push(n);
  }
  draft.expires = Date.now() + DRAFT_TTL;
  drafts.set(key, draft);

  const mainsDone = draft.numbers.length >= def.pickCount;
  const allDone = mainsDone && (def.bonusMax == null || draft.powerball != null);

  if (allDone) {
    const pool = await getPool(interaction.guildId!, draft.gameKey);
    let symbol = "";
    try { ({ symbol } = await requireEconomy(interaction.guildId!)); } catch { /* */ }
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(def.color)
          .setTitle("🎟️ Preview — confirm purchase")
          .setDescription(
            [
              "🔒 **Private preview** — nobody else can see your numbers.",
              "",
              `**${def.name}**`,
              `Numbers: ${formatNums(draft.numbers, draft.powerball, def.bonusLabel)}`,
              "",
              `Cost: **${symbol}${fmtCash(pool.ticketPrice)}**`,
              `Jackpot after your ticket: **${symbol}${fmtCash(pool.poolAmount + pool.ticketPrice)}**`,
              "",
              "Confirm to deduct UnbelievaBoat funds and enter the next draw.",
            ].join("\n"),
          ),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("lottery:confirm").setLabel("Buy ticket").setEmoji("✅").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("lottery:cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger),
        ),
      ],
      ...EPHEMERAL,
    });
    return;
  }

  const nextStep = mainsDone
    ? (def.bonusLabel ?? "bonus")
    : String(draft.numbers.length + 1);
  const progress = formatNums(draft.numbers, draft.powerball, def.bonusLabel);

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(def.color)
        .setTitle(`${def.emoji} Number locked`)
        .setDescription(
          [
            `So far: ${progress || "_none yet_"}`,
            "",
            mainsDone
              ? `Now enter your **${def.bonusLabel}** (1–${def.bonusMax}).`
              : `Next: enter number **${nextStep}** of **${def.pickCount}** (1–${def.mainMax}).`,
          ].join("\n"),
        ),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`lottery:num:${nextStep}`)
          .setLabel(mainsDone ? `Enter ${def.bonusLabel}` : `Enter number ${nextStep}`)
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("lottery:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
      ),
    ],
    ...EPHEMERAL,
  });
}

async function confirmPurchase(interaction: ButtonInteraction): Promise<void> {
  pruneDrafts();
  const key = draftKey(interaction.guildId!, interaction.user.id);
  const draft = drafts.get(key);
  if (!draft || draft.numbers.length < GAME_DEFS[draft.gameKey].pickCount) {
    await interaction.reply({ content: "No ticket in progress — start again from `/lottery`.", ...EPHEMERAL });
    return;
  }
  const gate = await assertCanBuy(interaction.guildId!, draft.gameKey);
  if (!gate.ok) {
    drafts.delete(key);
    await interaction.reply({ content: gate.message, ...EPHEMERAL });
    return;
  }
  await interaction.deferUpdate();
  const pool = await getPool(interaction.guildId!, draft.gameKey);
  const def = GAME_DEFS[draft.gameKey];
  try {
    const spent = await spendFunds(
      interaction.guildId!,
      interaction.user.id,
      pool.ticketPrice,
      `${def.name} ticket`,
    );
    await addToPool(interaction.guildId!, draft.gameKey, pool.ticketPrice);
    const ticket = await insertTicket({
      guildId: interaction.guildId!,
      gameKey: draft.gameKey,
      userId: interaction.user.id,
      numbers: [...draft.numbers].sort((a, b) => a - b),
      powerball: draft.powerball ?? null,
      cost: pool.ticketPrice,
    });
    drafts.delete(key);
    const open = await countOpenTickets(interaction.guildId!, draft.gameKey);
    const nextPool = await getPool(interaction.guildId!, draft.gameKey);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(def.color)
          .setTitle("✅ Ticket purchased")
          .setDescription(
            [
              `**${def.name}** #${ticket.id}`,
              formatNums(ticket.numbers, ticket.powerball, def.bonusLabel),
              "",
              `Paid **${fmtCash(pool.ticketPrice)}**` +
                (spent.fromBank > 0 ? ` (${fmtCash(spent.fromCash)} cash + ${fmtCash(spent.fromBank)} bank)` : ""),
              `Pool now **${fmtCash(nextPool.poolAmount)}** · **${open}** open ticket(s) for next draw`,
            ].join("\n"),
          ),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("lottery:store").setLabel("Back to store").setStyle(ButtonStyle.Secondary),
        ),
      ],
      files: [],
    });
  } catch (err) {
    const msg = err instanceof CashError ? err.message : "Purchase failed.";
    await interaction.editReply({ content: msg, embeds: [], components: [], files: [] });
  }
}

async function beginScratchPurchase(interaction: StringSelectMenuInteraction): Promise<void> {
  // Keep scratch on the private ephemeral store message.
  await interaction.deferUpdate();
  const guildId = interaction.guildId!;
  const pool = await getPool(guildId, "scratch");
  try {
    await spendFunds(guildId, interaction.user.id, pool.ticketPrice, "Scratch ticket");
    await addToPool(guildId, "scratch", pool.ticketPrice);
    const refreshed = await getPool(guildId, "scratch");
    const prize = rollScratchPrize(pool.ticketPrice, refreshed.poolAmount);
    const cells = buildScratchCells(prize, pool.ticketPrice);
    const card = await createScratcher({
      guildId,
      userId: interaction.user.id,
      cost: pool.ticketPrice,
      prize,
      cells,
    });
    // Escrow prize from pool immediately so we don't oversell.
    if (prize > 0) {
      await setPoolAmount(guildId, "scratch", Math.max(refreshed.seedAmount, refreshed.poolAmount - prize));
    }
    let symbol = "";
    try { ({ symbol } = await requireEconomy(guildId)); } catch { /* */ }
    const gif = await renderScratchGif({
      cells: card.cells,
      revealedCount: 0,
      prize: card.prize,
      symbol,
    });
    const files = gif ? [new AttachmentBuilder(gif, { name: "scratch.gif" })] : [];
    const embed = new EmbedBuilder()
      .setColor(GAME_DEFS.scratch.color)
      .setTitle("🎫 Scratch ticket ready")
      .setDescription(
        "🔒 **Only you see this card.**\nMash **Scratch** to peel the foil — spam until all 9 cells are open.",
      )
      .setFooter({ text: `Paid ${symbol}${fmtCash(pool.ticketPrice)} · ticket #${card.id}` });
    if (gif) embed.setImage("attachment://scratch.gif");
    await interaction.editReply({
      content: null,
      embeds: [embed],
      files,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`lottery:scratch:${card.id}`)
            .setLabel("Scratch!")
            .setEmoji("✨")
            .setStyle(ButtonStyle.Success),
        ),
      ],
    });
  } catch (err) {
    const msg = err instanceof CashError ? err.message : "Could not buy scratcher.";
    await interaction.editReply({ content: msg, embeds: [], components: [], files: [] });
  }
}

async function onScratchTap(interaction: ButtonInteraction): Promise<void> {
  const id = Number(interaction.customId.split(":")[2]);
  const card = await getScratcher(id);
  if (!card || card.userId !== interaction.user.id || card.guildId !== interaction.guildId) {
    await interaction.reply({ content: "That's not your ticket.", ...EPHEMERAL });
    return;
  }
  if (card.fullyRevealed) {
    await interaction.deferUpdate();
    await showRedeem(interaction, card.id);
    return;
  }
  await interaction.deferUpdate();
  const next = await bumpScratchReveal(id);
  if (!next) return;
  let symbol = "";
  try { ({ symbol } = await requireEconomy(interaction.guildId!)); } catch { /* */ }
  const gif = await renderScratchGif({
    cells: next.cells,
    revealedCount: next.revealedCount,
    prize: next.prize,
    symbol,
  });
  const files = gif ? [new AttachmentBuilder(gif, { name: "scratch.gif" })] : [];
  if (next.fullyRevealed) {
    await showRedeem(interaction, next.id, files);
    return;
  }
  const embed = new EmbedBuilder()
    .setColor(GAME_DEFS.scratch.color)
    .setTitle("🎫 Keep scratching…")
    .setDescription(`**${next.revealedCount}/9** cells open — hit **Scratch!** again.`)
    .setImage("attachment://scratch.gif");
  await interaction.editReply({
    embeds: [embed],
    files,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`lottery:scratch:${next.id}`)
          .setLabel("Scratch!")
          .setEmoji("✨")
          .setStyle(ButtonStyle.Success),
      ),
    ],
  });
}

async function showRedeem(
  interaction: ButtonInteraction,
  scratchId: number,
  files?: AttachmentBuilder[],
): Promise<void> {
  const card = await getScratcher(scratchId);
  if (!card) return;
  let symbol = "";
  try { ({ symbol } = await requireEconomy(interaction.guildId!)); } catch { /* */ }
  const gifFiles = files ?? (
    await renderScratchGif({
      cells: card.cells,
      revealedCount: 9,
      prize: card.prize,
      symbol,
    }).then(b => (b ? [new AttachmentBuilder(b, { name: "scratch.gif" })] : []))
  );
  const won = card.prize > 0;
  const embed = new EmbedBuilder()
    .setColor(won ? 0x57f287 : 0x4e5058)
    .setTitle(won ? "🎉 Scratch complete — you won!" : "Scratch complete")
    .setDescription(
      won
        ? `Prize **${symbol}${fmtCash(card.prize)}** — redeem to **cash** or send straight to **bank**.`
        : "No prize on this ticket. Try another from the store!",
    )
    .setImage(gifFiles.length ? "attachment://scratch.gif" : null);
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (won && !card.redeemed) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`lottery:redeem:${card.id}:cash`).setLabel("Redeem to cash").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`lottery:redeem:${card.id}:bank`).setLabel("Send to bank").setStyle(ButtonStyle.Primary),
    );
  }
  row.addComponents(
    new ButtonBuilder().setCustomId("lottery:store").setLabel("Store").setStyle(ButtonStyle.Secondary),
  );
  await interaction.editReply({ embeds: [embed], files: gifFiles, components: [row] });
}

async function onRedeem(interaction: ButtonInteraction): Promise<void> {
  const parts = interaction.customId.split(":"); // lottery:redeem:id:cash|bank
  const id = Number(parts[2]);
  const to = parts[3] === "bank" ? "bank" : "cash";
  const owned = await getScratcher(id);
  if (!owned || owned.userId !== interaction.user.id || owned.guildId !== interaction.guildId) {
    await interaction.reply({ content: "That's not your ticket.", ...EPHEMERAL });
    return;
  }
  await interaction.deferUpdate();
  const claimed = await redeemScratcher(id, to);
  if (!claimed) {
    await interaction.editReply({
      content: "Already redeemed or not ready.",
      embeds: [],
      components: [],
      files: [],
    });
    return;
  }
  if (claimed.prize <= 0) {
    await interaction.editReply({ content: "No prize to redeem.", embeds: [], components: [], files: [] });
    return;
  }
  try {
    if (to === "bank") {
      // Credit cash then deposit to bank so UB sees a clean trail.
      await earnCash(interaction.guildId!, interaction.user.id, claimed.prize, "Scratch prize");
      await depositCash(interaction.guildId!, interaction.user.id, claimed.prize);
    } else {
      await earnCash(interaction.guildId!, interaction.user.id, claimed.prize, "Scratch prize");
    }
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle("💰 Prize redeemed")
          .setDescription(`**${fmtCash(claimed.prize)}** sent to your **${to}**.`),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("lottery:store").setLabel("Store").setStyle(ButtonStyle.Secondary),
        ),
      ],
      files: [],
    });
  } catch (err) {
    // Roll back redeem flag? leave as redeemed to avoid double-pay; log message.
    const msg = err instanceof CashError ? err.message : "Payout failed — contact staff.";
    await interaction.editReply({ content: msg, embeds: [], components: [], files: [] });
  }
}

/** Entry from /casino hub button. */
export async function openLotteryFromCasino(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferReply(EPHEMERAL);
  await showStore(interaction);
}
