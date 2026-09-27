import {
  ChatInputCommandInteraction, ButtonInteraction, ModalSubmitInteraction,
  StringSelectMenuInteraction,
  EmbedBuilder, MessageFlags, ButtonBuilder, ButtonStyle, ActionRowBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, PermissionFlagsBits,
  AttachmentBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  type GuildTextBasedChannel, type BaseMessageOptions,
} from "discord.js";
import {
  fetchMTTVItems, formatMTTVValue, matchScore,
  calcItemValue, calcWeightedDemand, calcSideValue, shortValue,
  type MTTVItem, type CalcItem, type CalcTier,
} from "./mttvalues.js";
import { renderCalcResultsCanvas, CALC_RESULTS_FILE } from "./calc-results-canvas.js";
import { createCalculatorMessage, getCalculatorMessage, isAdmin } from "../db.js";
import type { CalculatorMessage } from "@workspace/db";
import { logger } from "../../lib/logger.js";

// ── Persistent MTTV Trade Calculator Hub ─────────────────────────────────────
// One private session panel per user (ephemeral). Your/Their open a search
// modal; ambiguous results render a numbered canvas + multi-select on that
// same panel — no nested manage embeds / Back hopping between sides.

const MAX_ITEMS = 3;
const PREFIX = "mttcalc_hub";

const TIER_CHOICES: CalcTier[] = ["low", "mid", "high"];

const STAR_LABELS = ["", "⭐", "⭐⭐", "⭐⭐⭐", "⭐⭐⭐⭐", "⭐⭐⭐⭐⭐"];

const EMPTY_SIDE = "*No items yet — press **Your Items** / **Their Items***";

type UserSession = {
  yourItems: CalcItem[];
  theirItems: CalcItem[];
  lastSearch: { your: MTTVItem[] | null; their: MTTVItem[] | null };
  touchedAt: number;
};
const sessions = new Map<string, UserSession>();

function sessionKey(messageId: string, userId: string) {
  return `${messageId}:${userId}`;
}

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour of inactivity

function getSession(messageId: string, userId: string): UserSession {
  const key = sessionKey(messageId, userId);
  let s = sessions.get(key);
  if (!s) {
    s = { yourItems: [], theirItems: [], lastSearch: { your: null, their: null }, touchedAt: Date.now() };
    sessions.set(key, s);
  } else {
    s.touchedAt = Date.now();
  }
  return s;
}

function clearSession(messageId: string, userId: string) {
  sessions.delete(sessionKey(messageId, userId));
}

function evictStaleSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [key, s] of sessions) {
    if (s.touchedAt < cutoff) sessions.delete(key);
  }
}

function sideField(session: UserSession, side: "your" | "their") {
  return side === "your" ? session.yourItems : session.theirItems;
}

function rarityEmoji(rarity: string): string {
  const map: Record<string, string> = {
    Common: "⚪",
    Rare: "🔵",
    Legendary: "🟡",
    Epic: "🟣",
    Exotic: "🔥",
    Limited: "💎",
  };
  return map[rarity] ?? "";
}

function formatItemLine(c: CalcItem): string {
  const val = calcItemValue(c);
  const rarity = c.item.rarity.map(rarityEmoji).join("") || "—";
  const starText = c.stars > 1 ? ` ${STAR_LABELS[c.stars]}` : "";
  const tierText = c.tier !== "mid" ? ` · ${c.tier}` : "";
  const qtyText = c.quantity > 1 ? ` x${c.quantity}` : "";
  return `${rarity} ${c.item.name}${qtyText}${tierText}${starText} — 💎 ${shortValue(val)}`;
}

function buildPreview(session: UserSession, description?: string): EmbedBuilder {
  const yourLines = session.yourItems.length > 0 ? session.yourItems.map(formatItemLine).join("\n") : EMPTY_SIDE;
  const theirLines = session.theirItems.length > 0 ? session.theirItems.map(formatItemLine).join("\n") : EMPTY_SIDE;
  const yourTotal = calcSideValue(session.yourItems);
  const theirTotal = calcSideValue(session.theirItems);
  const yourDemand = calcWeightedDemand(session.yourItems);
  const theirDemand = calcWeightedDemand(session.theirItems);

  return new EmbedBuilder()
    .setTitle("🧮 Vault Trade Calculator")
    .setColor(0x74cdd8)
    .setDescription(
      (description ? `${description}\n\n` : "") +
      `**Your offer** — 💎 ${shortValue(yourTotal)}${yourDemand != null ? ` · Demand ${yourDemand.toFixed(1)}/10` : ""}\n${yourLines}\n\n` +
      `**Their offer** — 💎 ${shortValue(theirTotal)}${theirDemand != null ? ` · Demand ${theirDemand.toFixed(1)}/10` : ""}\n${theirLines}`,
    )
    .setFooter({ text: "Prices from Vault Values" });
}

function buildMainComponents(messageId: string, userId: string, session: UserSession): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}:add:${messageId}:your:${userId}`)
        .setLabel("🙂 Your Items")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(session.yourItems.length >= MAX_ITEMS),
      new ButtonBuilder()
        .setCustomId(`${PREFIX}:add:${messageId}:their:${userId}`)
        .setLabel("🤝 Their Items")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(session.theirItems.length >= MAX_ITEMS),
      new ButtonBuilder().setCustomId(`${PREFIX}:calc:${messageId}:${userId}`).setLabel("🧮 Calculate").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${PREFIX}:clear:${messageId}:${userId}`).setLabel("🗑️ Clear").setStyle(ButtonStyle.Danger),
    ),
  ];
  const manage = new ActionRowBuilder<ButtonBuilder>();
  if (session.yourItems.length > 0) {
    manage.addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}:edit:${messageId}:your:${userId}`).setLabel("✏️ Edit Yours").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${PREFIX}:remove:${messageId}:your:${userId}`).setLabel("🗑️ Remove Yours").setStyle(ButtonStyle.Secondary),
    );
  }
  if (session.theirItems.length > 0) {
    manage.addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}:edit:${messageId}:their:${userId}`).setLabel("✏️ Edit Theirs").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${PREFIX}:remove:${messageId}:their:${userId}`).setLabel("🗑️ Remove Theirs").setStyle(ButtonStyle.Secondary),
    );
  }
  if (manage.components.length > 0) rows.push(manage);
  return rows;
}

/** Public hub buttons posted in-channel (opens each user's private session). */
function buildHubLaunchComponents(messageId: string): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}:open:${messageId}`).setLabel("🧮 Open my calculator").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${PREFIX}:resetsession:${messageId}`).setLabel("🗑️ Clear my session").setStyle(ButtonStyle.Danger),
    ),
  ];
}

function buildItemListComponents(
  messageId: string,
  side: "your" | "their",
  userId: string,
  items: CalcItem[],
  action: "remove" | "edit",
): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>();
  items.forEach((c, idx) => {
    const label = `${action === "remove" ? "🗑️" : "✏️"} ${idx + 1}. ${c.item.name.slice(0, 30)}`.slice(0, 80);
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}:${action}:${messageId}:${side}:${userId}:${idx}`)
        .setLabel(label)
        .setStyle(action === "remove" ? ButtonStyle.Danger : ButtonStyle.Primary),
    );
  });
  return [
    row,
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}:back:${messageId}:${userId}`).setLabel("↩️ Done").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildEditComponents(
  messageId: string,
  side: "your" | "their",
  userId: string,
  idx: number,
  item: CalcItem,
): ActionRowBuilder<ButtonBuilder>[] {
  const base = `${messageId}:${side}:${userId}:${idx}`;
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}:qty:${base}:label`).setLabel(`Qty: ${item.quantity}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId(`${PREFIX}:qty:${base}:inc`).setLabel("➕").setStyle(ButtonStyle.Primary).setDisabled(item.quantity >= 99),
      new ButtonBuilder().setCustomId(`${PREFIX}:qty:${base}:dec`).setLabel("➖").setStyle(ButtonStyle.Primary).setDisabled(item.quantity <= 1),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...TIER_CHOICES.map(tier =>
        new ButtonBuilder()
          .setCustomId(`${PREFIX}:tier:${base}:${tier}`)
          .setLabel(tier === item.tier ? `✓ ${tier}` : tier)
          .setStyle(tier === item.tier ? ButtonStyle.Success : ButtonStyle.Secondary)
      ),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...([1, 2, 3, 4, 5] as const).map(stars =>
        new ButtonBuilder()
          .setCustomId(`${PREFIX}:stars:${base}:${stars}`)
          .setLabel(stars === item.stars ? `✓ ${STAR_LABELS[stars]}` : STAR_LABELS[stars])
          .setStyle(stars === item.stars ? ButtonStyle.Success : ButtonStyle.Secondary)
      ),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}:back:${messageId}:${userId}`).setLabel("↩️ Done").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${PREFIX}:remove:${messageId}:${side}:${userId}:${idx}`).setLabel("🗑️ Delete this item").setStyle(ButtonStyle.Danger),
    ),
  ];
}

function buildAddModal(messageId: string, side: "your" | "their", userId: string): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`${PREFIX}_modal:add:${messageId}:${side}:${userId}`)
    .setTitle(side === "your" ? "Add to your offer" : "Add to their offer");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("name")
        .setLabel("Item name (fuzzy / acronym OK)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100)
        .setPlaceholder("e.g. STM, Sea Dragon, Abrams…"),
    ),
  );
  return modal;
}

function mainSessionReply(
  messageId: string,
  userId: string,
  session: UserSession,
  description?: string,
): BaseMessageOptions {
  return {
    embeds: [buildPreview(session, description)],
    components: buildMainComponents(messageId, userId, session),
    files: [],
  };
}

async function buildSearchView(
  messageId: string,
  session: UserSession,
  side: "your" | "their",
  userId: string,
  query: string,
  results: MTTVItem[],
): Promise<BaseMessageOptions> {
  const slotsLeft = Math.max(0, MAX_ITEMS - sideField(session, side).length);
  const canvas = await renderCalcResultsCanvas(results);
  const embed = buildPreview(
    session,
    `🔍 Results for **${query}** — pick one or more numbered items below (up to ${slotsLeft}).`,
  );
  if (canvas) embed.setImage(`attachment://${CALC_RESULTS_FILE}`);

  const maxPick = Math.min(slotsLeft, results.length, 25);
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${PREFIX}:multipick:${messageId}:${side}:${userId}`)
    .setPlaceholder(`Select up to ${maxPick} item(s)…`)
    .setMinValues(1)
    .setMaxValues(Math.max(1, maxPick))
    .addOptions(
      results.slice(0, 25).map((item, i) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${i + 1}. ${item.name}`.slice(0, 100))
          .setValue(String(i))
          .setDescription(`💎 ${formatMTTVValue(item)} · ${item.rarity[0] ?? "—"}`.slice(0, 100)),
      ),
    );

  return {
    embeds: [embed],
    files: canvas ? [new AttachmentBuilder(canvas, { name: CALC_RESULTS_FILE })] : [],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`${PREFIX}:back:${messageId}:${userId}`).setLabel("↩️ Cancel").setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function parseCustomId(customId: string): { action: string; parts: string[] } {
  const parts = customId.split(":");
  return { action: parts[1] ?? "", parts };
}

async function getRegisteredHub(messageId: string): Promise<CalculatorMessage | undefined> {
  return getCalculatorMessage(messageId);
}

// ── /postcalculator ───────────────────────────────────────────────────────────
export async function handlePostCalculator(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) return;

  const isAuthorized =
    interaction.guild.ownerId === interaction.user.id ||
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    (await isAdmin(interaction.guild.id, interaction.user.id));
  if (!isAuthorized) {
    await interaction.editReply("❌ Only admins can post a trade calculator.");
    return;
  }

  const channel = interaction.options.getChannel("channel", true);
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
    await interaction.editReply("❌ Choose a text channel.");
    return;
  }
  const textChannel = channel as GuildTextBasedChannel;

  const resultChannelRaw = interaction.options.getChannel("result_channel");
  const resultChannel =
    resultChannelRaw && (resultChannelRaw.type === ChannelType.GuildText || resultChannelRaw.type === ChannelType.GuildAnnouncement)
      ? (resultChannelRaw as GuildTextBasedChannel)
      : null;

  const me = interaction.guild.members.me;
  if (!me?.permissionsIn(textChannel).has(PermissionFlagsBits.SendMessages | PermissionFlagsBits.EmbedLinks)) {
    await interaction.editReply("❌ I don't have permission to send messages/embeds in the calculator channel.");
    return;
  }
  if (resultChannel && !me?.permissionsIn(resultChannel).has(PermissionFlagsBits.SendMessages | PermissionFlagsBits.EmbedLinks)) {
    await interaction.editReply("❌ I don't have permission to send messages/embeds in the result channel.");
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("🧮 Vault Trade Calculator")
    .setColor(0x74cdd8)
    .setDescription(
      "Open your **private** calculator panel — both offer sides stay on one embed.\n\n" +
      "• Search → numbered results canvas → multi-pick\n" +
      "• **Calculate** posts the trade result publicly\n" +
      "• **Clear** resets only your session",
    )
    .setFooter({ text: "Prices from Vault Values · each user has their own private session" });

  try {
    const message = await textChannel.send({ embeds: [embed], components: buildHubLaunchComponents("placeholder") });
    const messageId = message.id;
    await message.edit({ components: buildHubLaunchComponents(messageId) });
    await createCalculatorMessage(interaction.guild.id, textChannel.id, messageId, interaction.user.id, resultChannel?.id ?? null);
    await interaction.editReply(`✅ Posted the calculator in ${textChannel.toString()}${resultChannel ? `; results will go to ${resultChannel.toString()}` : ""}.`);
  } catch (err) {
    logger.error({ err }, "Failed to post calculator");
    await interaction.editReply("❌ Could not post the calculator. Check my permissions.");
  }
}

// ── Button interactions ──────────────────────────────────────────────────────
export async function handleMttvHubButton(interaction: ButtonInteraction): Promise<void> {
  const { action, parts } = parseCustomId(interaction.customId);
  const messageId = parts[2];
  if (!messageId) return;

  evictStaleSessions();

  const hub = await getRegisteredHub(messageId);
  if (!hub) {
    await interaction.reply({
      content: "❌ This calculator hub is no longer registered. Ask an admin to post a new one with `/vaultvalue` → Post calculator.",
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
    return;
  }

  const userId = interaction.user.id;
  const session = getSession(messageId, userId);

  const denyOther = async () => {
    await interaction.reply({
      content: "❌ This panel belongs to another user. Press **Open my calculator** on the hub.",
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  };

  // Public hub launch row
  if (action === "open" || action === "your" || action === "their") {
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      ...mainSessionReply(
        messageId,
        userId,
        session,
        "One panel for both sides — press **Your Items** or **Their Items** to search. Results show as a numbered canvas; multi-pick OK.",
      ),
    }).catch(() => {});
    return;
  }

  if (action === "resetsession") {
    clearSession(messageId, userId);
    const fresh = getSession(messageId, userId);
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      ...mainSessionReply(messageId, userId, fresh, "🧹 Your session has been reset."),
    }).catch(() => {});
    return;
  }

  // Legacy public hub buttons (pre one-panel redesign): calc/clear with no userId.
  if ((action === "calc" || action === "clear") && parts[3] == null) {
    if (action === "calc") {
      await handleCalculate(interaction, session, hub);
      return;
    }
    clearSession(messageId, userId);
    const fresh = getSession(messageId, userId);
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      ...mainSessionReply(messageId, userId, fresh, "🧹 Your session has been reset."),
    }).catch(() => {});
    return;
  }

  // Session panel — owner is always encoded after messageId for mutating actions.
  // add:messageId:side:userId
  // edit|remove:messageId:side:userId[:idx]
  // back|calc|clear:messageId:userId
  // qty|tier|stars:messageId:side:userId:idx:…

  if (action === "add") {
    const side = parts[3] as "your" | "their";
    const owner = parts[4];
    if (owner !== userId) { await denyOther(); return; }
    if (side !== "your" && side !== "their") return;
    if (sideField(session, side).length >= MAX_ITEMS) {
      await interaction.reply({
        content: `❌ You can only add up to ${MAX_ITEMS} items per side.`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }
    await interaction.showModal(buildAddModal(messageId, side, userId));
    return;
  }

  if (action === "back") {
    if (parts[3] !== userId) { await denyOther(); return; }
    session.lastSearch = { your: null, their: null };
    await interaction.update(mainSessionReply(messageId, userId, session)).catch(() => {});
    return;
  }

  if (action === "calc") {
    if (parts[3] !== userId) { await denyOther(); return; }
    await handleCalculate(interaction, session, hub);
    return;
  }

  if (action === "clear") {
    if (parts[3] !== userId) { await denyOther(); return; }
    clearSession(messageId, userId);
    const fresh = getSession(messageId, userId);
    await interaction.update(mainSessionReply(messageId, userId, fresh, "🧹 Session reset.")).catch(() => {});
    return;
  }

  if (action === "edit" || action === "remove") {
    const side = parts[3] as "your" | "their";
    const owner = parts[4];
    if (owner !== userId) { await denyOther(); return; }
    if (side !== "your" && side !== "their") return;
    const items = sideField(session, side);
    const idx = parts[5] !== undefined ? parseInt(parts[5], 10) : NaN;

    if (Number.isNaN(idx)) {
      if (items.length === 0) {
        await interaction.update(mainSessionReply(messageId, userId, session, "No items to modify on this side.")).catch(() => {});
        return;
      }
      await interaction.update({
        embeds: [buildPreview(session, `Select an item to **${action === "remove" ? "remove" : "edit"}**.`)],
        components: buildItemListComponents(messageId, side, userId, items, action),
        files: [],
      }).catch(() => {});
      return;
    }
    if (idx < 0 || idx >= items.length) {
      await interaction.update(mainSessionReply(messageId, userId, session, "⚠️ That item no longer exists.")).catch(() => {});
      return;
    }
    if (action === "remove") {
      items.splice(idx, 1);
      await interaction.update(mainSessionReply(messageId, userId, session, "🗑️ Item removed.")).catch(() => {});
      return;
    }
    await interaction.update({
      embeds: [buildPreview(session, `Editing **${items[idx]!.item.name}**.`)],
      components: buildEditComponents(messageId, side, userId, idx, items[idx]!),
      files: [],
    }).catch(() => {});
    return;
  }

  if (action === "qty" || action === "tier" || action === "stars") {
    const editSide = parts[3] as "your" | "their";
    const editUser = parts[4];
    const idx = parseInt(parts[5] ?? "", 10);
    if (editUser !== userId) { await denyOther(); return; }
    if (editSide !== "your" && editSide !== "their") return;
    const items = sideField(session, editSide);
    if (Number.isNaN(idx) || idx < 0 || idx >= items.length) return;
    const item = items[idx]!;
    if (action === "qty") {
      const delta = parts[6] === "inc" ? 1 : -1;
      item.quantity = Math.max(1, Math.min(99, item.quantity + delta));
    } else if (action === "tier") {
      const tier = parts[6] as CalcTier;
      if (TIER_CHOICES.includes(tier)) item.tier = tier;
    } else if (action === "stars") {
      const stars = parseInt(parts[6] ?? "", 10);
      if (!Number.isNaN(stars) && stars >= 1 && stars <= 5) item.stars = stars;
    }
    await interaction.update({
      embeds: [buildPreview(session, `Editing **${item.item.name}**.`)],
      components: buildEditComponents(messageId, editSide, userId, idx, item),
      files: [],
    }).catch(() => {});
  }
}

export async function handleMttvHubSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const { action, parts } = parseCustomId(interaction.customId);
  if (action !== "multipick") return;
  const messageId = parts[2];
  const side = parts[3] as "your" | "their";
  const ownerId = parts[4];
  if (!messageId || (side !== "your" && side !== "their")) return;
  if (ownerId !== interaction.user.id) {
    await interaction.reply({
      content: "❌ This panel belongs to another user.",
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
    return;
  }

  evictStaleSessions();
  const hub = await getRegisteredHub(messageId);
  if (!hub) {
    await interaction.reply({
      content: "❌ This calculator hub is no longer registered.",
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
    return;
  }

  await interaction.deferUpdate();
  const session = getSession(messageId, interaction.user.id);
  const items = sideField(session, side);
  const results = session.lastSearch[side] ?? [];
  const picked: string[] = [];
  for (const v of interaction.values) {
    if (items.length >= MAX_ITEMS) break;
    const idx = parseInt(v, 10);
    const hit = results[idx];
    if (!hit) continue;
    if (items.some((c) => c.item.name.toLowerCase() === hit.name.toLowerCase())) continue;
    items.push({ item: hit, quantity: 1, tier: "mid", stars: 1 });
    picked.push(hit.name);
  }
  session.lastSearch[side] = null;
  const note = picked.length
    ? `✅ Added ${picked.map((n) => `**${n}**`).join(", ")}.`
    : "No new items added.";
  await interaction.editReply(mainSessionReply(messageId, interaction.user.id, session, note)).catch(() => {});
}

async function canUserPostIn(
  guild: import("discord.js").Guild,
  userId: string,
  channel: GuildTextBasedChannel,
): Promise<boolean> {
  const member = guild.members.cache.get(userId) ?? await guild.members.fetch(userId).catch(() => null);
  if (!member) return false;
  return channel.permissionsFor(member).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
}

async function handleCalculate(
  interaction: ButtonInteraction,
  session: UserSession,
  hub: CalculatorMessage,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

  if (session.yourItems.length === 0 || session.theirItems.length === 0) {
    await interaction.editReply({
      content: "❌ Add at least one item to both sides before calculating.",
    }).catch(() => {});
    return;
  }

  let items: MTTVItem[];
  try {
    items = await fetchMTTVItems();
  } catch {
    await interaction.editReply({
      content: "❌ Could not fetch latest item values. Please try again.",
    }).catch(() => {});
    return;
  }

  const resolve = (c: CalcItem): CalcItem => {
    const latest = items.find(i => i.name.toLowerCase() === c.item.name.toLowerCase());
    return latest ? { ...c, item: latest } : c;
  };

  const your = session.yourItems.map(resolve);
  const their = session.theirItems.map(resolve);
  const yourTotal = calcSideValue(your);
  const theirTotal = calcSideValue(their);
  const yourDemand = calcWeightedDemand(your);
  const theirDemand = calcWeightedDemand(their);
  const diff = yourTotal - theirTotal;
  const rel = Math.abs(diff) / Math.max(yourTotal, theirTotal, 1);
  let verdict: string;
  let color: number;
  if (rel <= 0.05) {
    verdict = "⚖️ Fair trade";
    color = 0x95a5a6;
  } else if (diff > 0) {
    verdict = `🔴 You lose — their offer is short by 💎 ${shortValue(Math.abs(diff))}`;
    color = 0xe74c3c;
  } else {
    verdict = `🟢 You win — your offer is short by 💎 ${shortValue(Math.abs(diff))}`;
    color = 0x2ecc71;
  }

  const yourLines = your.map(formatItemLine).join("\n");
  const theirLines = their.map(formatItemLine).join("\n");
  const resultEmbed = new EmbedBuilder()
    .setTitle(`🧮 Trade Calculation — ${interaction.user.displayName || interaction.user.username}`)
    .setColor(color)
    .setDescription(
      `**Your offer** — 💎 ${shortValue(yourTotal)}${yourDemand != null ? ` · Demand ${yourDemand.toFixed(1)}/10` : ""}\n${yourLines}\n\n` +
      `**Their offer** — 💎 ${shortValue(theirTotal)}${theirDemand != null ? ` · Demand ${theirDemand.toFixed(1)}/10` : ""}\n${theirLines}\n\n` +
      `**Verdict:** ${verdict}`,
    )
    .setFooter({ text: "Prices from Vault Values" });

  try {
    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply({
        content: "❌ Results can only be posted in a server. Here's your result:",
        embeds: [resultEmbed],
      }).catch(() => {});
      return;
    }

    const resolveChannel = async (channelId: string): Promise<GuildTextBasedChannel | null> => {
      const fetched = await guild.channels.fetch(channelId).catch(() => null);
      if (fetched && (fetched.type === ChannelType.GuildText || fetched.type === ChannelType.GuildAnnouncement)) {
        return fetched as GuildTextBasedChannel;
      }
      return null;
    };

    let targetChannel = await resolveChannel(hub.resultChannelId ?? hub.channelId);
    if (targetChannel && !(await canUserPostIn(guild, interaction.user.id, targetChannel))) {
      targetChannel = null;
    }

    if (!targetChannel) {
      const hubChannel = await resolveChannel(hub.channelId);
      if (hubChannel && await canUserPostIn(guild, interaction.user.id, hubChannel)) {
        targetChannel = hubChannel;
      }
    }

    if (targetChannel) {
      await targetChannel.send({ embeds: [resultEmbed] });
      await interaction.editReply({
        content: `✅ Posted your trade result in ${targetChannel.toString()}.`,
      }).catch(() => {});
    } else {
      await interaction.editReply({
        content: "❌ You don't have permission to post in the configured result channel, so here's your result:",
        embeds: [resultEmbed],
      }).catch(() => {});
    }
  } catch (err) {
    logger.error({ err }, "Failed to post calculator result");
    await interaction.editReply({
      content: "❌ Could not post the result. Please try again.",
    }).catch(() => {});
  }
}

// ── Modal submissions ──────────────────────────────────────────────────────────
export async function handleMttvHubModal(interaction: ModalSubmitInteraction): Promise<void> {
  const parts = interaction.customId.split(":");
  if (parts[0] !== `${PREFIX}_modal` || parts[1] !== "add") return;
  const messageId = parts[2];
  const side = parts[3] as "your" | "their";
  const userId = parts[4];
  if (!messageId || !side || !userId || userId !== interaction.user.id) return;

  await interaction.deferUpdate().catch(() => {});

  evictStaleSessions();

  const hub = await getRegisteredHub(messageId);
  if (!hub) {
    await interaction.editReply({
      content: "❌ This calculator hub is no longer registered. Ask an admin to post a new one with `/vaultvalue` → Post calculator.",
      embeds: [],
      components: [],
    }).catch(() => {});
    return;
  }

  const session = getSession(messageId, userId);
  const items = sideField(session, side);
  const nameRaw = interaction.fields.getTextInputValue("name").trim();

  if (items.length >= MAX_ITEMS) {
    await interaction.editReply(mainSessionReply(messageId, userId, session, `❌ You can only add up to ${MAX_ITEMS} items per side.`)).catch(() => {});
    return;
  }

  let allItems: MTTVItem[];
  try {
    allItems = await fetchMTTVItems();
  } catch {
    await interaction.editReply(mainSessionReply(messageId, userId, session, "❌ Could not fetch item values. Please try again.")).catch(() => {});
    return;
  }

  const exact = allItems.find(i => i.name.toLowerCase() === nameRaw.toLowerCase());
  if (exact) {
    items.push({ item: exact, quantity: 1, tier: "mid", stars: 1 });
    await interaction.editReply(mainSessionReply(messageId, userId, session, `✅ Added **${exact.name}**.`)).catch(() => {});
    return;
  }

  const scored = allItems
    .map(i => ({ i, score: matchScore(i, nameRaw) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  if (scored.length === 0) {
    await interaction.editReply(mainSessionReply(messageId, userId, session, `❌ No items matched "${nameRaw}". Try a different name or acronym.`)).catch(() => {});
    return;
  }

  if (scored.length === 1) {
    const match = scored[0]!.i;
    items.push({ item: match, quantity: 1, tier: "mid", stars: 1 });
    await interaction.editReply(mainSessionReply(messageId, userId, session, `✅ Added **${match.name}**.`)).catch(() => {});
    return;
  }

  session.lastSearch[side] = scored.map(s => s.i);
  await interaction.editReply(
    await buildSearchView(messageId, session, side, userId, nameRaw, scored.map(s => s.i)),
  ).catch(() => {});
}
