// /lottery — player ticket store + step-by-step pick + scratch shop.

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
  SCRATCH_TIERS,
  SCRATCH_TIER_KEYS,
  formatNums,
  rollScratchPrizeForTier,
  buildScratchCells,
  isDrawGame,
  isScratchTier,
  type DrawGameKey,
  type LotteryGameKey,
  type ScratchTierKey,
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
  getScratchStock,
  consumeScratchStock,
  restoreScratchStock,
} from "../../../lib/lottery/db.js";
import {
  resolveGameConfig,
  checkBuyWindow,
  formatBuyWindow,
} from "../../../lib/lottery/config.js";
import { CashError, spendFunds, earnCash, depositCash, fmtCash, requireEconomy } from "../cash.js";
import { plainCashLabel } from "../currency-canvas.js";
import {
  renderLotteryStoreGif,
  renderScratchGif,
  renderScratchShopGif,
} from "./render.js";

/** Private-only replies — number picks / private scratch must never be public. */
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
  step: number;
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
    // Public scratch messages must not turn into a public store — open ephemeral instead.
    const flags = interaction.message.flags;
    const isEph = typeof flags?.has === "function"
      ? flags.has(MessageFlags.Ephemeral)
      : Boolean(Number(flags) & MessageFlags.Ephemeral);
    if (isEph) await interaction.deferUpdate();
    else await interaction.deferReply(EPHEMERAL);
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
      await showScratchShop(interaction);
      return;
    }
    if (isDrawGame(game)) {
      await beginPickFlow(interaction, game);
      return;
    }
  }
  if (id === "lottery:scratch_tier" && interaction.isStringSelectMenu()) {
    const tier = interaction.values[0]!;
    if (!isScratchTier(tier)) {
      await interaction.reply({ content: "Unknown scratcher tier.", ...EPHEMERAL });
      return;
    }
    await showScratchVisibilityPrompt(interaction, tier);
    return;
  }
  if (id.startsWith("lottery:scratch_vis:") && interaction.isButton()) {
    // lottery:scratch_vis:<pub|priv>:<tier>
    const parts = id.split(":");
    const vis = parts[2] === "pub" ? "pub" : "priv";
    const tier = parts[3]!;
    if (!isScratchTier(tier)) {
      await interaction.reply({ content: "Unknown scratcher tier.", ...EPHEMERAL });
      return;
    }
    await beginScratchPurchase(interaction, tier, vis);
    return;
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
  let symbol = "💵";
  try {
    ({ symbol } = await requireEconomy(guildId));
  } catch {
    /* show store anyway */
  }
  const settings = await getOrCreateLotterySettings(guildId);
  const pools = await ensurePools(guildId);
  const stock = await getScratchStock(guildId);

  const rows = pools.map(p => {
    const key = p.gameKey as LotteryGameKey;
    const def = GAME_DEFS[key];
    if (!def) return null;
    const cfg = resolveGameConfig(settings, key);
    const win = checkBuyWindow(cfg);
    return {
      gameKey: key,
      jackpot: key === "scratch"
        ? Math.min(...SCRATCH_TIER_KEYS.map(t => SCRATCH_TIERS[t].price))
        : p.poolAmount,
      ticketPrice: p.ticketPrice,
      open: win.ok && p.status === "open" && settings.enabled,
    };
  }).filter((r): r is NonNullable<typeof r> => Boolean(r));

  // For scratch tile, show pool as "jackpot" context (seed pot) on board.
  const scratchPool = pools.find(p => p.gameKey === "scratch");
  const scratchRow = rows.find(r => r.gameKey === "scratch");
  if (scratchRow && scratchPool) {
    scratchRow.jackpot = scratchPool.poolAmount;
  }

  const gif = await renderLotteryStoreGif({ rows, symbol });
  const files = gif ? [new AttachmentBuilder(gif, { name: "lottery-store.gif" })] : [];

  const stockLine = SCRATCH_TIER_KEYS
    .map(k => {
      const t = SCRATCH_TIERS[k];
      const left = stock.remaining[k] ?? 0;
      return `${t.emoji} ${left}/${t.dailyStock}`;
    })
    .join(" · ");

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("🎱 Lottery Ticket Store")
    .setDescription(
      [
        "🔒 **Private store** — number picks stay between you and the bot.",
        "Buy with **UnbelievaBoat** cash/bank. Ticket money feeds the prize pool.",
        settings.enabled ? "" : "⚠️ Lottery is **disabled** by staff.",
        "",
        `🎫 **Scratch stock today:** ${stockLine}`,
        "_Restocks automatically at 00:00 UTC._",
        "",
        "Pick a game below → private numbers **or** open the Scratch Shop.",
      ].filter(Boolean).join("\n"),
    )
    .setFooter({ text: "UnbelievaBoat Lottery · only you see this panel" });
  if (gif) embed.setImage("attachment://lottery-store.gif");

  // Select descriptions must NOT include custom emoji markup (Discord shows the raw code).
  const menu = new StringSelectMenuBuilder()
    .setCustomId("lottery:pick_game")
    .setPlaceholder("Choose what to play…")
    .addOptions(
      {
        label: "Classic Lottery",
        value: "classic",
        emoji: "🎟️",
        description: `Pick 5 · ${plainCashLabel(pools.find(p => p.gameKey === "classic")?.ticketPrice ?? GAME_DEFS.classic.ticketPrice)}`.slice(0, 100),
      },
      {
        label: "Powerball",
        value: "powerball",
        emoji: "🔴",
        description: `5 + PB · ${plainCashLabel(pools.find(p => p.gameKey === "powerball")?.ticketPrice ?? GAME_DEFS.powerball.ticketPrice)}`.slice(0, 100),
      },
      {
        label: "Mega Millionaire",
        value: "mega",
        emoji: "💎",
        description: `5 + Mega · ${plainCashLabel(pools.find(p => p.gameKey === "mega")?.ticketPrice ?? GAME_DEFS.mega.ticketPrice)}`.slice(0, 100),
      },
      {
        label: "Scratch Shop",
        value: "scratch",
        emoji: "🎫",
        description: "Copper · Silver · Gold · Diamond · daily stock".slice(0, 100),
      },
    );

  const payload = {
    content: undefined as string | undefined,
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

async function showScratchShop(interaction: StringSelectMenuInteraction): Promise<void> {
  await interaction.deferUpdate();
  const guildId = interaction.guildId!;
  let symbol = "💵";
  try { ({ symbol } = await requireEconomy(guildId)); } catch { /* */ }
  const stock = await getScratchStock(guildId);
  const gif = await renderScratchShopGif({
    symbol,
    stock: stock.remaining,
  });
  const files = gif ? [new AttachmentBuilder(gif, { name: "scratch-shop.gif" })] : [];

  const lines = SCRATCH_TIER_KEYS.map(k => {
    const t = SCRATCH_TIERS[k];
    const left = stock.remaining[k] ?? 0;
    const tag = left > 0 ? `🟢 ${left} left` : "🔴 sold out";
    return (
      `${t.emoji} **${t.name}** — **${symbol}${fmtCash(t.price)}** · ${tag}\n` +
      `└ ${t.blurb}`
    );
  });

  const embed = new EmbedBuilder()
    .setColor(GAME_DEFS.scratch.color)
    .setTitle("🎫 Scratch Shop")
    .setDescription(
      [
        "Choose a tier, then scratch **in public** or **privately** (like pack opens).",
        "Stock restocks every day at **00:00 UTC**.",
        "",
        ...lines,
      ].join("\n"),
    )
    .setFooter({ text: "UnbelievaBoat Scratch · daily stock" });
  if (gif) embed.setImage("attachment://scratch-shop.gif");

  const menu = new StringSelectMenuBuilder()
    .setCustomId("lottery:scratch_tier")
    .setPlaceholder("Choose a scratcher…")
    .addOptions(
      SCRATCH_TIER_KEYS.map(k => {
        const t = SCRATCH_TIERS[k];
        const left = stock.remaining[k] ?? 0;
        return {
          label: t.name,
          value: t.key,
          emoji: t.emoji,
          description: `${plainCashLabel(t.price)} · ${left > 0 ? `${left} left today` : "sold out"}`.slice(0, 100),
        };
      }),
    );

  await interaction.editReply({
    content: undefined,
    embeds: [embed],
    files,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("lottery:store").setLabel("Back to store").setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

async function showScratchVisibilityPrompt(
  interaction: StringSelectMenuInteraction,
  tierKey: ScratchTierKey,
): Promise<void> {
  await interaction.deferUpdate();
  const tier = SCRATCH_TIERS[tierKey];
  const stock = await getScratchStock(interaction.guildId!);
  const left = stock.remaining[tierKey] ?? 0;
  if (left <= 0) {
    await interaction.editReply({
      content: `**${tier.name}** is sold out today. Stock restocks at **00:00 UTC**.`,
      embeds: [],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("lottery:store").setLabel("Back to store").setStyle(ButtonStyle.Secondary),
        ),
      ],
      files: [],
    });
    return;
  }

  let symbol = "💵";
  try { ({ symbol } = await requireEconomy(interaction.guildId!)); } catch { /* */ }

  const embed = new EmbedBuilder()
    .setColor(tier.color)
    .setTitle(`${tier.emoji} ${tier.name}`)
    .setDescription(
      [
        `Price **${symbol}${fmtCash(tier.price)}** · **${left}** left in today's stock.`,
        "",
        "**Scratch Publicly** shows your card in the channel.",
        "**Scratch Privately** keeps the foil between you and the bot.",
        "",
        "_Nothing is charged until you pick._",
      ].join("\n"),
    );

  await interaction.editReply({
    content: undefined,
    embeds: [embed],
    files: [],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`lottery:scratch_vis:pub:${tierKey}`)
          .setLabel("Scratch Publicly")
          .setEmoji("📢")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`lottery:scratch_vis:priv:${tierKey}`)
          .setLabel("Scratch Privately")
          .setEmoji("🙈")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("lottery:store")
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Danger),
      ),
    ],
  });
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
  let symbol = "💵";
  try { ({ symbol } = await requireEconomy(interaction.guildId!)); } catch { /* */ }
  await interaction.deferUpdate();
  await interaction.editReply({
    content: undefined,
    files: [],
    embeds: [
      new EmbedBuilder()
        .setColor(def.color)
        .setTitle(`${def.emoji} ${def.name} — pick your numbers`)
        .setDescription(
          [
            "🔒 **Only you can see this** — your numbers stay private until the public draw.",
            "",
            `Ticket price: **${symbol}${fmtCash(pool.ticketPrice)}** (cash first, then bank)`,
            `Current jackpot: **${symbol}${fmtCash(pool.poolAmount)}**`,
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
    let symbol = "";
    try { ({ symbol } = await requireEconomy(interaction.guildId!)); } catch { /* */ }
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
              `Paid **${symbol}${fmtCash(pool.ticketPrice)}**` +
                (spent.fromBank > 0 ? ` (${fmtCash(spent.fromCash)} cash + ${fmtCash(spent.fromBank)} bank)` : ""),
              `Pool now **${symbol}${fmtCash(nextPool.poolAmount)}** · **${open}** open ticket(s) for next draw`,
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

async function beginScratchPurchase(
  interaction: ButtonInteraction,
  tierKey: ScratchTierKey,
  vis: "pub" | "priv",
): Promise<void> {
  const guildId = interaction.guildId!;
  const tier = SCRATCH_TIERS[tierKey];
  const gate = await assertCanBuy(guildId, "scratch");
  if (!gate.ok) {
    await interaction.reply({ content: gate.message, ...EPHEMERAL });
    return;
  }

  // Stock gate before charging — pack-style: charge only after visibility choice.
  const stock = await getScratchStock(guildId);
  if ((stock.remaining[tierKey] ?? 0) <= 0) {
    await interaction.reply({
      content: `**${tier.name}** is sold out today. Comes back at **00:00 UTC**.`,
      ...EPHEMERAL,
    });
    return;
  }

  if (vis === "priv") {
    await interaction.deferUpdate();
  } else {
    // Public reveal → fresh channel message (like pack:open:pub).
    await interaction.deferReply().catch(() => {});
    // Soft-update the ephemeral prompt so it doesn't look stuck.
    await interaction.message.edit({
      content: `📢 Scratching **${tier.name}** publicly…`,
      embeds: [],
      components: [],
      files: [],
    }).catch(() => {});
  }

  const consumed = await consumeScratchStock(guildId, tierKey);
  if ("soldOut" in consumed) {
    const payload = {
      content: `**${tier.name}** just sold out. Stock restocks at **00:00 UTC**.`,
      embeds: [],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("lottery:store").setLabel("Back to store").setStyle(ButtonStyle.Secondary),
        ),
      ],
      files: [] as AttachmentBuilder[],
    };
    await interaction.editReply(payload);
    return;
  }

  try {
    await spendFunds(guildId, interaction.user.id, tier.price, `${tier.name}`);
    await addToPool(guildId, "scratch", tier.price);
    const refreshed = await getPool(guildId, "scratch");
    const prize = rollScratchPrizeForTier(tierKey, refreshed.poolAmount);
    const cells = buildScratchCells(prize, tier.price);
    const card = await createScratcher({
      guildId,
      userId: interaction.user.id,
      tierKey,
      cost: tier.price,
      prize,
      cells,
      publicReveal: vis === "pub",
    });
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
      tierKey,
    });
    const files = gif ? [new AttachmentBuilder(gif, { name: "scratch.gif" })] : [];
    const privacy = vis === "pub"
      ? "📢 **Public scratch** — the channel can watch you peel the foil."
      : "🔒 **Only you see this card.**";
    const embed = new EmbedBuilder()
      .setColor(tier.color)
      .setTitle(`${tier.emoji} ${tier.name} ready`)
      .setDescription(
        `${privacy}\nMash **Scratch** to peel the foil — spam until all 9 cells are open.`,
      )
      .setFooter({
        text: `Paid ${symbol}${fmtCash(tier.price)} · #${card.id} · ${consumed.remaining} left today`,
      });
    if (gif) embed.setImage("attachment://scratch.gif");
    await interaction.editReply({
      content: vis === "pub" ? `${interaction.user} bought a **${tier.name}**!` : undefined,
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
    await restoreScratchStock(guildId, tierKey).catch(() => {});
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
  const tierKey = (isScratchTier(next.tierKey) ? next.tierKey : "silver") as ScratchTierKey;
  const gif = await renderScratchGif({
    cells: next.cells,
    revealedCount: next.revealedCount,
    prize: next.prize,
    symbol,
    tierKey,
  });
  const files = gif ? [new AttachmentBuilder(gif, { name: "scratch.gif" })] : [];
  if (next.fullyRevealed) {
    await showRedeem(interaction, next.id, files);
    return;
  }
  const tier = SCRATCH_TIERS[tierKey];
  const embed = new EmbedBuilder()
    .setColor(tier.color)
    .setTitle(`${tier.emoji} Keep scratching…`)
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
  const tierKey = (isScratchTier(card.tierKey) ? card.tierKey : "silver") as ScratchTierKey;
  const gifFiles = files ?? (
    await renderScratchGif({
      cells: card.cells,
      revealedCount: 9,
      prize: card.prize,
      symbol,
      tierKey,
    }).then(b => (b ? [new AttachmentBuilder(b, { name: "scratch.gif" })] : []))
  );
  const won = card.prize > 0;
  const embed = new EmbedBuilder()
    .setColor(won ? 0x57f287 : 0x4e5058)
    .setTitle(won ? "🎉 Scratch complete — you won!" : "Scratch complete")
    .setDescription(
      won
        ? `Prize **${symbol}${fmtCash(card.prize)}** — redeem to **cash** or send straight to **bank**.`
        : "No prize on this ticket. Try another from the Scratch Shop!",
    )
    .setImage(gifFiles?.length ? "attachment://scratch.gif" : null);
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
      await earnCash(interaction.guildId!, interaction.user.id, claimed.prize, "Scratch prize");
      await depositCash(interaction.guildId!, interaction.user.id, claimed.prize);
    } else {
      await earnCash(interaction.guildId!, interaction.user.id, claimed.prize, "Scratch prize");
    }
    let symbol = "";
    try { ({ symbol } = await requireEconomy(interaction.guildId!)); } catch { /* */ }
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle("💰 Prize redeemed")
          .setDescription(`**${symbol}${fmtCash(claimed.prize)}** sent to your **${to}**.`),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("lottery:store").setLabel("Store").setStyle(ButtonStyle.Secondary),
        ),
      ],
      files: [],
    });
  } catch (err) {
    const msg = err instanceof CashError ? err.message : "Payout failed — contact staff.";
    await interaction.editReply({ content: msg, embeds: [], components: [], files: [] });
  }
}

/** Entry from /casino hub button. */
export async function openLotteryFromCasino(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferReply(EPHEMERAL);
  await showStore(interaction);
}
