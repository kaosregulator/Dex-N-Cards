// ─────────────────────────────────────────────────────────────────────────────
// Card Fusion Hub — the /card_recycle command (internal key "tradein").
//
// /card_recycle opens a HUB whose canvas leads with your 5 MOST-DUPLICATED cards
// (the ones closest to a fuse), plus your Scrap balance. Per card:
//   🔧  Fuse        — spend N copies → +1 Star Rank (★), boosting battle stats.
//                     Fusing RESETS the card's level to 1 — you re-grind level
//                     each star. On success a premium 2–3s canvas GIF plays.
//   ♻️  Scrap       — turn spendable duplicate copies into Scrap (⚙️).
//   ⚙️  Spend Scrap — pour Scrap back into a card as battle XP (1 ⚙️ = 1 XP).
//   🔒  Lock        — protect a card from fuse / scrap / burn.
//
// Scrap is NOT a separate economy — it only levels cards. It comes from scrapping
// spare dupes and from overflow XP a maxed (Lv100) card can no longer use (see
// leveling.ts grantCardBattleXp). Canvas renders go through the shared render
// queue / encodeAnimation pipeline with timeout-guarded image loads so they can
// never hang the interaction; if canvas is unavailable the views fall back to
// plain embeds.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  ChatInputCommandInteraction, ButtonInteraction, StringSelectMenuInteraction, ModalSubmitInteraction,
} from "discord.js";
import {
  EmbedBuilder, MessageFlags, AttachmentBuilder,
  ActionRowBuilder, ButtonBuilder, StringSelectMenuBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} from "discord.js";
import {
  getCanvas, hexToRgba, type Ctx, type FrameCtx,
  lerp, easeOutBack, clamp01,
  drawGradientBackground,
  encodeAnimation,
} from "../animations/engine.js";
import type { AnimationResult } from "../animations/types.js";
import {
  drawCardArt, drawCardFrame, drawRarityGlow, drawRarityBadge, drawTextWithShadow,
  drawTitle, fitText, getRarityEffectColor, TITLE_FONT,
} from "../animations/effects.js";
import { drawSparks, drawEmbers, drawExplosion } from "../animations/particles.js";
import { queueRender } from "../animations/render-queue.js";
import {
  getOrCreateGuildSettings, getRarityContext, getRarityDisplayOverrides,
  getCardDisplayRarity, getUserCollection, getCardByName, getScrap,
} from "../db.js";
import { toAbsoluteImageUrl } from "../image-url.js";
import {
  recycleForScrap, fuseUpStar, fuseUpQuote, spendScrapForXp, scrapValueForCard,
  starRankString, starStatMultiplier, MAX_STAR, getRecycleSettings, getFusionConfig,
} from "./stars.js";
import { getCardProgress, getCardProgressBatch, MAX_LEVEL } from "./leveling.js";
import { isCardLocked, setCardLocked } from "./locks.js";
import type { Rarity } from "../cards-data.js";
import { withGuildFrames } from "../animations/card-frames.js";
import { logger } from "../../lib/logger.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;
const CARD_CANVAS = { width: 520, height: 660 } as const;
const HUB_CANVAS = { width: 1000, height: 540 } as const;
const FUSION_FILE = "fusion.gif";
const HUB_FILE = "fusion-hub.png";

interface FusionEntry {
  cardId: number;
  name: string;
  rarity: Rarity;
  rarityLabel: string;
  rarityColor: number | null;
  imageUrl: string | null;
  count: number;
  worthValue: number;
  star: number;
  level: number;
}

// ── Data ─────────────────────────────────────────────────────────────────────

async function loadFusionEntries(guildId: string, userId: string): Promise<FusionEntry[]> {
  const [collection, ctx, settings, displayMap, progress] = await Promise.all([
    getUserCollection(guildId, userId),
    getRarityContext(guildId),
    getOrCreateGuildSettings(guildId),
    getRarityDisplayOverrides(guildId),
    getCardProgressBatch(guildId, userId),
  ]);
  return collection
    .filter(c => c.count > 1)                          // must have a spendable duplicate
    .map(c => {
      const display = getCardDisplayRarity(c, ctx, settings, displayMap);
      const prog = progress.get(c.id);
      return {
        cardId: c.id,
        name: c.name,
        rarity: c.rarity as Rarity,
        rarityLabel: display.label,
        rarityColor: display.color,
        imageUrl: c.imageUrl,
        count: c.count,
        worthValue: c.worthValue,
        star: prog?.starRank ?? 0,
        level: prog?.level ?? 1,
      };
    })
    // Hub shows the MOST-DUPLICATED cards first — the ones ready to fuse.
    .sort((a, b) => b.count - a.count || b.star - a.star || a.name.localeCompare(b.name));
}

async function loadSingleEntry(guildId: string, userId: string, cardId: number): Promise<FusionEntry | null> {
  const [collection, ctx, settings, displayMap, prog] = await Promise.all([
    getUserCollection(guildId, userId),
    getRarityContext(guildId),
    getOrCreateGuildSettings(guildId),
    getRarityDisplayOverrides(guildId),
    getCardProgress(guildId, userId, cardId).catch(() => null),
  ]);
  const row = collection.find(c => c.id === cardId);
  if (!row) return null;
  const display = getCardDisplayRarity(row, ctx, settings, displayMap);
  return {
    cardId: row.id,
    name: row.name,
    rarity: row.rarity as Rarity,
    rarityLabel: display.label,
    rarityColor: display.color,
    imageUrl: row.imageUrl,
    count: row.count,
    worthValue: row.worthValue,
    star: prog?.starRank ?? 0,
    level: prog?.level ?? 1,
  };
}

// ── Hub canvas: your top-5 most-duplicated cards ─────────────────────────────

// A profile-style board that leads with the cards you own the MOST copies of —
// the ones closest to a fuse. Each shows its star rank, level and copy count.
export async function renderFusionHubCanvas(
  guildId: string, userId: string, cards: FusionEntry[], scrap: number, copiesPerStar: number,
): Promise<{ buffer: Buffer } | null> {
  return queueRender("fusion-hub", async () => {
    const mod = await getCanvas();
    if (!mod) return null;
    try {
      const { width, height } = HUB_CANVAS;
      const canvas = mod.createCanvas(width, height);
      const ctx = canvas.getContext("2d") as unknown as Ctx;
      const accent = 0x2ecc71;

      drawGradientBackground(ctx, width, height, [
        [0, hexToRgba(accent, 0.35)],
        [0.55, "#0c0e14"],
        [1, "#070810"],
      ], 0.3);

      drawTitle(ctx, "CARD FUSION HUB", width / 2, 46, "#ffffff", 34);
      drawTextWithShadow(ctx, "Your most-duplicated cards — ready to fuse", width / 2, 80, "#aab0c0", 18);
      drawTextWithShadow(
        ctx, `Scrap ${scrap.toLocaleString()}   |   ${copiesPerStar} copies = +1 star`,
        width / 2, 104, "#64d4a4", 16,
      );

      const shown = cards.slice(0, 5);
      const cw = 150, ch = 200, gap = 24;
      const totalW = shown.length * cw + Math.max(0, shown.length - 1) * gap;
      const startX = (width - totalW) / 2;
      const y = 140;

      for (let i = 0; i < shown.length; i++) {
        const c = shown[i]!;
        const x = startX + i * (cw + gap);
        const color = c.rarityColor ?? getRarityEffectColor(c.rarity);
        const ready = c.star < MAX_STAR && c.count >= copiesPerStar;

        drawRarityGlow(ctx, x, y, cw, ch, ready ? 0xffd54a : color, ready ? 0.75 : 0.5);
        await drawCardArt(ctx, mod, x, y, cw, ch, toAbsoluteImageUrl(c.imageUrl), c.rarity);
        drawCardFrame(ctx, x, y, cw, ch, ready ? 0xffd54a : color, 5, c.rarity);
        drawRarityBadge(ctx, x + cw - 10, y + 10, c.rarityLabel, color);
        drawTextWithShadow(ctx, `#${i + 1}`, x + 14, y + 18, "#ffffff", 16);
        if (ready) drawTextWithShadow(ctx, "READY", x + cw / 2, y + ch - 16, "#ffd54a", 15);

        const labelY = y + ch + 24;
        drawTextWithShadow(ctx, c.name, x + cw / 2, labelY, "#ffffff", fitText(ctx, c.name, cw + 20, 15, 11, TITLE_FONT));
        drawTextWithShadow(ctx, starRankString(c.star), x + cw / 2, labelY + 20, "#ffd54a", 17);
        drawTextWithShadow(ctx, `Lv ${c.level}  x${c.count}`, x + cw / 2, labelY + 40, "#aab0c0", 14);
      }

      if (shown.length === 0) {
        drawTextWithShadow(ctx, "No duplicate cards yet — catch more spawns!", width / 2, height / 2, "#aab0c0", 20);
      }

      return { buffer: Buffer.from(await canvas.encode("png")) };
    } catch (err) {
      logger.debug({ err, guildId, userId }, "renderFusionHubCanvas failed");
      return null;
    }
  });
}

// ── Messages ───────────────────────────────────────────────────────────────

function fusionDropdown(entries: FusionEntry[]): ActionRowBuilder<StringSelectMenuBuilder> {
  const options = entries.slice(0, 25).map(e => ({
    label: `${starRankString(e.star)} ${e.name}`.slice(0, 100),
    description: `×${e.count} owned · ${e.rarityLabel}`.slice(0, 100),
    value: String(e.cardId),
  }));
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("recycle:select")
      .setPlaceholder(options.length ? "🔧 Pick a card to fuse…" : "No duplicate cards yet")
      .setOptions(options.length ? options : [{ label: "No cards", value: "__none__", description: "Collect duplicates first" }])
      .setDisabled(options.length === 0),
  );
}

async function buildFusionHubMessage(guildId: string, userId: string) {
  const [entries, scrap, cfg] = await Promise.all([
    loadFusionEntries(guildId, userId),
    getScrap(guildId, userId),
    getFusionConfig(guildId),
  ]);

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle("🔧 Card Fusion Hub")
    .setDescription(
      entries.length === 0
        ? "You have no duplicate cards yet. Open packs and catch spawns — once you own **2+ copies** of a card you can fuse it here."
        : `**Fuse** ${cfg.copiesPerStar} copies of a card → **+1 Star** (★) and stronger battle stats — this **resets its level to 1**, so re-grind it back up.\n\n` +
          "Pick a card below, or **search by name**. **♻️ Scrap** spare dupes for currency you can pour back into leveling any card.",
    )
    .setFooter({ text: `⚙️ Scrap: ${scrap.toLocaleString()}  ·  ★ +8% battle stats per star` });

  // Render the top-5-dupes hub board; fall back to the embed alone if canvas is off.
  const hubFrames = await getOrCreateGuildSettings(guildId).catch(() => null);
  const hub = await withGuildFrames(hubFrames, () => renderFusionHubCanvas(guildId, userId, entries, scrap, cfg.copiesPerStar)).catch(() => null);
  const files: AttachmentBuilder[] = [];
  if (hub) {
    embed.setImage(`attachment://${HUB_FILE}`);
    files.push(new AttachmentBuilder(hub.buffer, { name: HUB_FILE }));
  }

  const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [
    fusionDropdown(entries),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("recycle:search").setLabel("🔍 Search by Name").setStyle(ButtonStyle.Primary).setDisabled(entries.length === 0),
    ),
  ];
  return { embeds: [embed], components: rows, files };
}

async function buildFusionSelectedMessage(
  guildId: string, userId: string, cardId: number,
): Promise<{ embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[]; files: AttachmentBuilder[] } | string> {
  const entry = await loadSingleEntry(guildId, userId, cardId);
  if (!entry) return "You don't own this card.";

  const [quote, settings, scrap, prog, locked] = await Promise.all([
    fuseUpQuote(guildId, userId, cardId),
    getRecycleSettings(guildId),
    getScrap(guildId, userId),
    getCardProgress(guildId, userId, cardId),
    isCardLocked(guildId, userId, cardId),
  ]);
  const level = prog?.level ?? 1;
  const spendable = Math.max(0, entry.count - 1);
  const scrapPer = scrapValueForCard(entry.rarity, entry.worthValue, settings);
  const recycleGain = spendable * scrapPer;
  const curMult = starStatMultiplier(entry.star);
  const nextMult = starStatMultiplier(entry.star + 1);
  const atMaxLevel = level >= MAX_LEVEL;

  const lines: string[] = [
    `**${entry.rarityLabel}** · ${starRankString(entry.star)}  (${entry.star}/${MAX_STAR}★)`,
    `Owned: **×${entry.count}**  ·  Level **${level}/${MAX_LEVEL}**${locked ? "  ·  🔒 Locked" : ""}`,
    `⚙️ Scrap: **${scrap.toLocaleString()}**  ·  ★ battle bonus **+${Math.round((curMult - 1) * 100)}%**`,
    "",
  ];
  if (entry.star >= MAX_STAR) {
    lines.push(`⭐ **Max Star** (${MAX_STAR}★) reached — keep leveling to Lv ${MAX_LEVEL}.`);
  } else {
    lines.push(
      `🔧 **Fuse → ${entry.star + 1}★** — consumes **${quote.copiesNeeded} copies** (you have ${quote.copiesOwned}).`,
      `   Fusing **resets level to 1** and boosts stats to **+${Math.round((nextMult - 1) * 100)}%**.`,
    );
    if (quote.reason === "insufficient_copies") lines.push(`   ❌ Catch **${quote.copiesNeeded - quote.copiesOwned}** more to fuse.`);
  }
  lines.push(
    `♻️ **Scrap** ${spendable} spare dupe${spendable !== 1 ? "s" : ""} → **+${recycleGain.toLocaleString()} ⚙️**`,
    atMaxLevel ? "⚙️ Card is max level — Scrap it toward another." : "⚙️ **Spend Scrap** to level this card (1 ⚙️ = 1 XP).",
  );

  const embed = new EmbedBuilder()
    .setColor(entry.rarityColor ?? 0x2ecc71)
    .setTitle(entry.name)
    .setDescription(lines.join("\n"));
  const thumb = toAbsoluteImageUrl(entry.imageUrl);
  if (thumb) embed.setThumbnail(thumb);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`recycle:fuse:${cardId}`).setLabel(`🔧 Fuse (${quote.copiesNeeded})`).setStyle(ButtonStyle.Success).setDisabled(!quote.canFuse || locked),
    new ButtonBuilder().setCustomId(`recycle:recycle:${cardId}`).setLabel("♻️ Scrap").setStyle(ButtonStyle.Secondary).setDisabled(spendable === 0 || locked),
    new ButtonBuilder().setCustomId(`recycle:spendxp:${cardId}`).setLabel("⚙️ Spend Scrap").setStyle(ButtonStyle.Primary).setDisabled(scrap <= 0 || atMaxLevel),
    new ButtonBuilder().setCustomId(`recycle:lock:${cardId}`).setLabel(locked ? "🔓 Unlock" : "🔒 Lock").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("recycle:back").setLabel("⬅️ Back").setStyle(ButtonStyle.Secondary),
  );
  // files:[] clears any leftover hub/fuse attachment when we swap to this view.
  return { embeds: [embed], components: [row], files: [] };
}

// ── Fuse animation (premium GIF) ─────────────────────────────────────────────

// Draw a filled 5-pointed star at (cx,cy).
function fillStar(ctx: Ctx, cx: number, cy: number, outerR: number, innerR: number, fill: string, glow: string): void {
  ctx.save();
  ctx.shadowColor = glow;
  ctx.shadowBlur = outerR * 0.9;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
}

export async function renderFusionAnimation(
  entry: FusionEntry, fromStar: number, toStar: number,
): Promise<AnimationResult | null> {
  const artUrl = toAbsoluteImageUrl(entry.imageUrl);
  const color = entry.rarityColor ?? getRarityEffectColor(entry.rarity);
  const scrapColor = 0x64d4a4;
  const starColor = 0xffd54a;
  const { width, height } = CARD_CANVAS;

  return encodeAnimation({
    width, height,
    speed: "normal",
    durationMs: 2400,
    maxFrames: 34,
    quality: 18,
    renderScale: 0.75,
    render: async (frame: FrameCtx) => {
      const { ctx, t, mod } = frame;
      const cx = width / 2, cy = height / 2 - 30;

      // Background
      drawGradientBackground(ctx, width, height, [
        [0, hexToRgba(color, 0.30)],
        [0.5, "#0c0e14"],
        [1, "#070810"],
      ], 0.3);

      // Phase envelopes
      const inflow = clamp01(t / 0.55);                  // dupes spiral in + shatter
      const charge = clamp01((t - 0.35) / 0.4);          // card glows / energy streams
      const burst  = clamp01((t - 0.72) / 0.28);         // star ignites

      // Central card, growing slightly and glowing brighter as it charges.
      const baseW = 250, baseH = 250;
      const scale = lerp(0.92, 1.06, charge);
      const cw = baseW * scale, ch = baseH * scale;
      drawRarityGlow(ctx, cx - cw / 2, cy - ch / 2, cw, ch, color, 0.5 + charge * 0.6);
      await drawCardArt(ctx, mod, cx - cw / 2, cy - ch / 2, cw, ch, artUrl, entry.rarity);
      drawCardFrame(ctx, cx - cw / 2, cy - ch / 2, cw, ch, color, 6, entry.rarity);

      // Duplicate "ghost" cards spiral inward and shatter into scrap energy.
      const dupes = Math.min(4, Math.max(2, entry.count - 1));
      if (inflow < 1) {
        for (let i = 0; i < dupes; i++) {
          const a0 = (i / dupes) * Math.PI * 2;
          const ang = a0 + inflow * Math.PI * 1.5;
          const dist = lerp(230, 8, inflow);
          const gx = cx + Math.cos(ang) * dist;
          const gy = cy + Math.sin(ang) * dist * 0.8;
          const gs = lerp(0.5, 0.08, inflow);
          const gw = baseW * gs, gh = baseH * gs;
          ctx.save();
          ctx.globalAlpha = 0.85 * (1 - inflow);
          drawRarityGlow(ctx, gx - gw / 2, gy - gh / 2, gw, gh, scrapColor, 0.6);
          await drawCardArt(ctx, mod, gx - gw / 2, gy - gh / 2, gw, gh, artUrl, entry.rarity);
          ctx.restore();
        }
      }

      // Scrap energy streaming into the card.
      if (charge > 0.02 && burst < 1) {
        drawSparks(ctx, cx, cy, {
          color: scrapColor, count: 20, maxLen: 120, seed: `fuse-in-${entry.cardId}`,
        });
      }
      drawEmbers(ctx, 0, height * 0.35, width, height * 0.65, {
        color: scrapColor, count: 18, seed: `fuse-embers-${entry.cardId}`,
      });

      // Burst: flash + explosion + the new star igniting.
      if (burst > 0.02) {
        ctx.save();
        ctx.globalAlpha = Math.max(0, 0.6 * (1 - burst));
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);
        ctx.restore();
        drawExplosion(ctx, cx, cy, { color: starColor, radius: 130, ringCount: 2, seed: `fuse-boom-${entry.cardId}` });
      }

      // Star track along the bottom: existing stars solid, the new one pops in.
      const starY = cy + ch / 2 + 46;
      const gap = 46, sr = 16;
      const startX = cx - ((MAX_STAR - 1) * gap) / 2;
      for (let i = 0; i < MAX_STAR; i++) {
        const sx = startX + i * gap;
        const filledBefore = i < fromStar;
        const isNew = i === toStar - 1;
        if (filledBefore) {
          fillStar(ctx, sx, starY, sr, sr * 0.45, hexToRgba(starColor, 1), hexToRgba(starColor, 0.6));
        } else if (isNew) {
          const pop = easeOutBack(burst);
          if (pop > 0.02) fillStar(ctx, sx, starY, sr * pop, sr * 0.45 * pop, hexToRgba(starColor, 1), hexToRgba(starColor, 1));
        } else {
          fillStar(ctx, sx, starY, sr, sr * 0.45, "rgba(255,255,255,0.10)", "rgba(0,0,0,0)");
        }
      }

      // Header + payoff text. Stars use the shared symbol font.
      drawTextWithShadow(ctx, "CARD FUSION", cx, 30, hexToRgba(color, 1), 16);
      drawTextWithShadow(ctx, entry.name, cx, 54, "#ffffff", 24);
      if (burst > 0.25) {
        ctx.save();
        ctx.globalAlpha = clamp01((burst - 0.25) / 0.5);
        drawTitle(ctx, `${fromStar}★ → ${toStar}★`, cx, height - 96, hexToRgba(starColor, 1), 40);
        const bonus = Math.round((starStatMultiplier(toStar) - 1) * 100);
        drawTextWithShadow(ctx, `Battle stats +${bonus}%`, cx, height - 56, "#a8e6cf", 20);
        ctx.restore();
      }
    },
  });
}

// ── Command + component handlers ─────────────────────────────────────────────

export async function handleFusionCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) return;
  const guildId = interaction.guild.id;
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply(EPHEMERAL).catch(() => {});

  try {
    const settings = await getRecycleSettings(guildId);
    if (!settings.enabled) {
      await interaction.editReply({ content: "🔧 Card Fusion is currently disabled by the server admins.", embeds: [], components: [] });
      return;
    }
    const name = interaction.options.getString("name")?.trim();
    if (!name) {
      await interaction.editReply(await buildFusionHubMessage(guildId, interaction.user.id));
      return;
    }
    const card = await getCardByName(name, guildId);
    if (!card) {
      await interaction.editReply(`❌ Couldn't find a card called **${name}**. Run \`/card_recycle\` without a name to browse.`);
      return;
    }
    const msg = await buildFusionSelectedMessage(guildId, interaction.user.id, card.id);
    if (typeof msg === "string") { await interaction.editReply({ content: msg, embeds: [], components: [] }); return; }
    await interaction.editReply(msg);
  } catch (err) {
    logger.error({ err, userId: interaction.user.id, guildId }, "handleFusionCommand failed");
    await interaction.editReply({ content: "❌ Something went wrong opening Card Fusion. Try again in a moment.", embeds: [], components: [] }).catch(() => {});
  }
}

// Routes recycle:* buttons and the card-select menu.
export async function handleFusionComponent(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): Promise<void> {
  if (!interaction.guild) return;
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const parts = interaction.customId.split(":");
  if (parts[0] !== "recycle") return;
  const sub = parts[1];

  // Card picked from the hub dropdown.
  if (interaction.isStringSelectMenu() && sub === "select") {
    await interaction.deferUpdate().catch(() => {});
    const cardId = Number(interaction.values[0]);
    if (!cardId || Number.isNaN(cardId)) { await interaction.editReply({ content: "❌ Invalid selection.", embeds: [], components: [] }).catch(() => {}); return; }
    const msg = await buildFusionSelectedMessage(guildId, userId, cardId);
    if (typeof msg === "string") { await interaction.editReply({ content: msg, embeds: [], components: [] }).catch(() => {}); return; }
    await interaction.editReply(msg).catch(() => {});
    return;
  }

  if (!interaction.isButton()) return;

  // "Fuse Again" jumps straight back into a card's selected view.
  if (sub === "select") {
    await interaction.deferUpdate().catch(() => {});
    const cardId = Number(parts[2]);
    const msg = await buildFusionSelectedMessage(guildId, userId, cardId);
    if (typeof msg === "string") { await interaction.editReply({ content: msg, embeds: [], components: [], files: [] }).catch(() => {}); return; }
    await interaction.editReply(msg).catch(() => {});
    return;
  }

  if (sub === "back") {
    await interaction.deferUpdate().catch(() => {});
    await interaction.editReply(await buildFusionHubMessage(guildId, userId)).catch(() => {});
    return;
  }
  if (sub === "search") {
    const modal = new ModalBuilder().setCustomId("recycle:search").setTitle("Search a card to fuse");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("q").setLabel("Card name").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100),
    ));
    await interaction.showModal(modal).catch(() => {});
    return;
  }
  if (sub === "spendxp") {
    // Modal-launching → must NOT defer first.
    const cardId = parts[2];
    const modal = new ModalBuilder().setCustomId(`recycle:spendxp:${cardId}`).setTitle("Spend Scrap → Level up");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("amt").setLabel("Scrap to spend (1 ⚙️ = 1 XP)").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(9),
    ));
    await interaction.showModal(modal).catch(() => {});
    return;
  }
  if (sub === "fuse")    { await handleFuseButton(interaction); return; }
  if (sub === "recycle") { await handleRecycleButton(interaction); return; }
  if (sub === "lock")    { await handleLockButton(interaction); return; }
}

async function handleLockButton(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guild!.id;
  const userId = interaction.user.id;
  const cardId = Number(interaction.customId.split(":")[2]);
  await interaction.deferUpdate().catch(() => {});
  const nowLocked = !(await isCardLocked(guildId, userId, cardId));
  await setCardLocked(guildId, userId, cardId, nowLocked).catch(() => {});
  const back = await buildFusionSelectedMessage(guildId, userId, cardId);
  const banner = nowLocked ? "🔒 Locked — protected from fuse, scrap & burn." : "🔓 Unlocked.";
  if (typeof back === "string") { await interaction.editReply({ content: back, embeds: [], components: [] }).catch(() => {}); return; }
  await interaction.editReply({ content: banner, embeds: back.embeds, components: back.components, files: back.files }).catch(() => {});
}

// Spend Scrap → card XP (modal submit customId `recycle:spendxp:<cardId>`).
export async function handleFusionSpendScrapModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.guild) return;
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  await interaction.deferUpdate().catch(() => {});
  const cardId = Number(interaction.customId.split(":")[2]);
  const amt = Math.max(0, Math.floor(Number(interaction.fields.getTextInputValue("amt").replace(/[^0-9]/g, "")) || 0));
  const res = await spendScrapForXp(guildId, userId, cardId, amt);
  const back = await buildFusionSelectedMessage(guildId, userId, cardId);
  let banner: string;
  if (!res.ok) {
    banner = res.reason === "insufficient_scrap" ? "❌ Not enough Scrap."
      : res.reason === "max_level" ? "❌ That card is already max level."
      : "❌ Couldn't spend Scrap.";
  } else {
    banner = `⚙️ Spent **${res.scrapSpent.toLocaleString()}** Scrap → Level **${res.oldLevel} → ${res.newLevel}**` +
      (res.refunded > 0 ? ` (refunded ${res.refunded.toLocaleString()} — card maxed).` : ".");
  }
  if (typeof back === "string") { await interaction.editReply({ content: banner, embeds: [], components: [] }).catch(() => {}); return; }
  await interaction.editReply({ content: banner, embeds: back.embeds, components: back.components, files: back.files }).catch(() => {});
}

async function handleFuseButton(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guild!.id;
  const userId = interaction.user.id;
  const cardId = Number(interaction.customId.split(":")[2]);
  await interaction.deferUpdate().catch(() => {});

  const entry = await loadSingleEntry(guildId, userId, cardId);
  if (!entry) { await interaction.editReply({ content: "❌ Card no longer available.", embeds: [], components: [] }).catch(() => {}); return; }

  if (await isCardLocked(guildId, userId, cardId)) {
    await interaction.editReply({ content: "🔒 This card is locked — unlock it to fuse.", embeds: [], components: [] }).catch(() => {});
    return;
  }
  const res = await fuseUpStar(guildId, userId, cardId);
  if (!res.ok) {
    const msg =
      res.reason === "max_star" ? "This card is already at max Star."
      : res.reason === "insufficient_copies" ? "You no longer have enough copies to fuse."
      : "Something went wrong fusing that card.";
    // Re-render the selected view so the buttons/costs reflect current state.
    const back = await buildFusionSelectedMessage(guildId, userId, cardId);
    if (typeof back === "string") { await interaction.editReply({ content: `❌ ${msg}`, embeds: [], components: [] }).catch(() => {}); return; }
    await interaction.editReply({ content: `❌ ${msg}`, embeds: back.embeds, components: back.components, files: back.files }).catch(() => {});
    return;
  }

  // Success — play the premium fuse animation, falling back to a static embed.
  const fused = { ...entry, star: res.toStar };
  const animFrames = await getOrCreateGuildSettings(guildId).catch(() => null);
  const anim = await withGuildFrames(animFrames, () => renderFusionAnimation(fused, res.fromStar, res.toStar)).catch(() => null);

  const embed = new EmbedBuilder()
    .setColor(entry.rarityColor ?? 0x2ecc71)
    .setTitle(`🔧 Fusion complete — ${entry.name}`)
    .setDescription(
      `${starRankString(res.fromStar)}  →  **${starRankString(res.toStar)}**  (${res.toStar}/${MAX_STAR}★)\n` +
      `Fused **${res.copiesUsed} copies** — level reset to **1**, now re-grind to Lv ${MAX_LEVEL}.\n` +
      `Battle stats now **+${Math.round((starStatMultiplier(res.toStar) - 1) * 100)}%**.`,
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`recycle:select:${cardId}`).setLabel("🔧 Fuse Again").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("recycle:back").setLabel("⬅️ Back").setStyle(ButtonStyle.Secondary),
  );

  if (anim) {
    embed.setImage(`attachment://${FUSION_FILE}`);
    await interaction.editReply({
      embeds: [embed], components: [row],
      files: [new AttachmentBuilder(Buffer.from(anim.buffer), { name: FUSION_FILE })],
    }).catch(() => {});
  } else {
    const thumb = toAbsoluteImageUrl(entry.imageUrl);
    if (thumb) embed.setThumbnail(thumb);
    await interaction.editReply({ embeds: [embed], components: [row], files: [] }).catch(() => {});
  }
}

async function handleRecycleButton(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guild!.id;
  const userId = interaction.user.id;
  const cardId = Number(interaction.customId.split(":")[2]);
  await interaction.deferUpdate().catch(() => {});

  const entry = await loadSingleEntry(guildId, userId, cardId);
  if (!entry) { await interaction.editReply({ content: "❌ Card no longer available.", embeds: [], components: [] }).catch(() => {}); return; }

  const res = await recycleForScrap(guildId, userId, cardId, entry.rarity, entry.worthValue);
  if (!res.ok) {
    const msg = res.reason === "no_duplicates" ? "No spendable duplicates to recycle." : "Something went wrong recycling.";
    const back = await buildFusionSelectedMessage(guildId, userId, cardId);
    if (typeof back === "string") { await interaction.editReply({ content: `❌ ${msg}`, embeds: [], components: [] }).catch(() => {}); return; }
    await interaction.editReply({ content: `❌ ${msg}`, embeds: back.embeds, components: back.components, files: back.files }).catch(() => {});
    return;
  }

  // Re-render the selected view (now with fresh Scrap balance) plus a banner.
  const back = await buildFusionSelectedMessage(guildId, userId, cardId);
  const banner = `♻️ Recycled **${res.consumed}** dupe${res.consumed !== 1 ? "s" : ""} → **+${res.scrapEarned.toLocaleString()} ⚙️ Scrap**.`;
  if (typeof back === "string") { await interaction.editReply({ content: banner, embeds: [], components: [] }).catch(() => {}); return; }
  await interaction.editReply({ content: banner, embeds: back.embeds, components: back.components, files: back.files }).catch(() => {});
}

export async function handleFusionSearchModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.guild) return;
  const guildId = interaction.guild.id;
  await interaction.deferUpdate().catch(() => {});
  const q = interaction.fields.getTextInputValue("q").trim();
  const card = await getCardByName(q, guildId);
  if (!card) { await interaction.editReply({ content: `❌ No card called **${q}**.`, embeds: [], components: [] }).catch(() => {}); return; }
  const msg = await buildFusionSelectedMessage(guildId, interaction.user.id, card.id);
  if (typeof msg === "string") { await interaction.editReply({ content: msg, embeds: [], components: [] }).catch(() => {}); return; }
  await interaction.editReply(msg).catch(() => {});
}
