// /rarity — Discord-first rarity settings. Built-in rarities are the primary
// admin-facing system; advanced custom-tier tools remain for compatibility.
//   🎛️ Rarity Settings — display + spawn % + worth/burn per built-in tier
//   🎨 Display          — focused cosmetic editor
//   📊 Values           — focused spawn % / worth / burn editor
//   ⚙️ Advanced         — legacy custom-tier/assignment tools
//
// Discord = source of truth. The website only ever READS these tables.

import {
  EmbedBuilder, MessageFlags,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  type ChatInputCommandInteraction, type ButtonInteraction,
  type StringSelectMenuInteraction, type ModalSubmitInteraction,
} from "discord.js";
import {
  upsertRarityProfile, deleteRarityProfile, listRarityProfiles,
  createCustomRarity, updateCustomRarity, deleteCustomRarity,
  listCustomRarities, getCustomRarityBySlug,
  assignCardToCustomRarity, unassignCardCustomRarity,
  getCardByName,
  getRarityDisplayOverrides, upsertRarityDisplayOverride,
  clearRarityDisplayOverride, clearAllRarityDisplayOverrides,
  getOrCreateGuildSettings,
  updateGuildSettings,
} from "../db.js";
import {
  RARITY_EMOJI, RARITY_LABELS, RARITY_COLORS, selectMenuEmoji, type Rarity, type RarityDisplayMap,
  rarityLabel, rarityEmoji, rarityColor, getRarityOrder, BUILTIN_RARITIES,
} from "../cards-data.js";

export { RARITY_COLORS, BUILTIN_RARITIES };

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseHexColor(input: string): number | null {
  const s = input.trim().replace(/^#/, "").replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{6}$/.test(s) && !/^[0-9a-fA-F]{3}$/.test(s)) return null;
  const full = s.length === 3 ? s.split("").map(c => c + c).join("") : s;
  const n = parseInt(full, 16);
  return Number.isFinite(n) ? n : null;
}

function hex(n: number): string {
  return "#" + n.toString(16).padStart(6, "0");
}

function fmtVal(v: number | null | undefined, suffix = ""): string {
  if (v === null || v === undefined) return "*(default)*";
  return `${v.toLocaleString()}${suffix}`;
}

type ProfileRow = { rarity: string; worthValue: number | null; burnValue: number | null; dropWeight: number | null };
type CustomRow = Awaited<ReturnType<typeof listCustomRarities>>[number];

// ── Hub ───────────────────────────────────────────────────────────────────────

function buildHubPanel() {
  const embed = new EmbedBuilder()
    .setTitle("🎛️ Rarity Settings")
    .setColor(0x5865f2)
    .setDescription(
      "This hub is the **source of truth** for rarity names, colors, spawn %, worth, and burn.\n\n" +
      "Default labels follow Vault Values: Common → Uncommon → Rare → Epic → Legendary → **Limited Edition** (top). " +
      "**Exotic** is a custom tier. Event/special cards use Limited Edition + event flag.\n\n" +
      "Guild nicknames you set here always win over code defaults.\n​",
    )
    .setFooter({ text: "Discord /rarity writes · website only reads · Reset All clears nicknames back to site names" });
  const primaryRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("rarity_hub:settings").setLabel("🎛️ Edit Rarities").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("rarity_hub:display").setLabel("🎨 Display Only").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("rarity_hub:economy").setLabel("📊 Values Only").setStyle(ButtonStyle.Secondary),
  );
  const secondaryRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("rarity_hub:order").setLabel("🧾 Order").setStyle(ButtonStyle.Secondary),
  );
  const advancedRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("rarity_hub:custom").setLabel("⚙️ Advanced Labels").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("rarity_hub:cardtier").setLabel("⚙️ Legacy Assignments").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [primaryRow, secondaryRow, advancedRow] };
}

export async function handleRarityHubCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.editReply("❌ This command can only be used in a server.");
    return;
  }
  await interaction.editReply(buildHubPanel());
}

// ── Order maker ───────────────────────────────────────────────────────────────

function buildOrderPanel(
  order: Rarity[],
  displayMap: RarityDisplayMap,
  settings: EditSettings | null,
  selected: Rarity = order[0]!,
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] } {
  const selectedIndex = order.indexOf(selected);
  const safeSelected = selectedIndex >= 0 ? selected : order[0]!;
  const safeIndex = order.indexOf(safeSelected);
  const embed = new EmbedBuilder()
    .setTitle("🧾 Rarity Display Order")
    .setColor(0x5865f2)
    .setDescription(
      "Pick a rarity, then tap **Move Up** or **Move Down**. This order is used in the roster, `/rarity`, `/config`, and `/collection`.\n\n" +
      order.map((r, i) => {
        const marker = r === safeSelected ? "▶" : "•";
        const label = rarityLabel(r, settings, displayMap);
        const emoji = rarityEmoji(r, settings, displayMap);
        return `${marker} ${i + 1}. ${emoji} ${label}`;
      }).join("\n"),
    )
    .setFooter({ text: "Drag-free order editor · Reset restores the default order" });

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("rarity_hub:order:select")
      .setPlaceholder("Pick a rarity to move")
      .addOptions(
        order.map(r => {
          const label = rarityLabel(r, settings, displayMap);
          const emoji = rarityEmoji(r, settings, displayMap);
          const emojiObj = selectMenuEmoji(emoji, RARITY_EMOJI[r]);
          return { label: `${emoji} ${label}`, value: r, emoji: emojiObj, default: r === safeSelected };
        }),
      ),
  );

  const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rarity_hub:order:up:${safeSelected}`).setLabel("⬆️ Move Up").setStyle(ButtonStyle.Secondary).setDisabled(safeIndex <= 0),
    new ButtonBuilder().setCustomId(`rarity_hub:order:down:${safeSelected}`).setLabel("⬇️ Move Down").setStyle(ButtonStyle.Secondary).setDisabled(safeIndex >= order.length - 1),
    new ButtonBuilder().setCustomId("rarity_hub:order:reset").setLabel("↩️ Reset").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("rarity_hub:main").setLabel("← Back").setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [selectRow, btnRow] };
}

function buildSettingsPanel(
  displayMap: RarityDisplayMap,
  settings: EditSettings | null,
  profiles: ProfileRow[],
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] } {
  const byRarity = new Map(profiles.map(r => [r.rarity as Rarity, r]));
  const embed = new EmbedBuilder()
    .setTitle("🎛️ Built-in Rarity Settings")
    .setColor(0x5865f2)
    .setDescription(
      "Pick a built-in rarity to edit its display, spawn chance, worth, and burn for this server. " +
      "Cards keep their internal rarity identity; these settings only change server behavior and presentation.\n​",
    );

  const order = getRarityOrder(settings);
  for (const r of order) {
    const display = getEffectiveDisplay(r, displayMap, settings);
    const profile = byRarity.get(r);
    const values = [
      `Spawn: ${fmtVal(profile?.dropWeight, "%")}`,
      `Worth: ${fmtVal(profile?.worthValue, " 💠")}`,
      `Burn: ${fmtVal(profile?.burnValue, " 💠")}`,
    ].join(" · ");
    embed.addFields({ name: `${display.emoji} ${display.label}`, value: values, inline: false });
  }

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("rarity_hub:settings:select")
      .setPlaceholder("Choose a built-in rarity to edit…")
      .addOptions(order.map(r => {
        const display = getEffectiveDisplay(r, displayMap, settings);
        const profile = byRarity.get(r);
        const hasValues = profile && (profile.worthValue !== null || profile.burnValue !== null || profile.dropWeight !== null);
        const emojiObj = selectMenuEmoji(display.emoji, RARITY_EMOJI[r]);
        return {
          label: `${display.emoji} ${display.label}`,
          value: r,
          emoji: emojiObj,
          description: `${display.hasOverride ? "Display set" : "Default display"} · ${hasValues ? "Values set" : "Default values"}`.slice(0, 100),
        };
      })),
  );
  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("rarity_hub:main").setLabel("← Back").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [selectRow, backRow] };
}

function buildSettingsTierPanel(
  r: Rarity,
  displayMap: RarityDisplayMap,
  settings: EditSettings | null,
  profile: ProfileRow | undefined,
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const display = getEffectiveDisplay(r, displayMap, settings);
  const embed = new EmbedBuilder()
    .setTitle(`🎛️ ${display.emoji} ${display.label}`)
    .setColor(display.color)
    .setDescription(
      `Internal rarity: \`${r}\` — stable for inventories and compatibility.\n` +
      "Edit what admins and players see: display, spawn chance, worth, and burn.\n​",
    )
    .addFields(
      { name: "Display", value: `${display.emoji} **${display.label}** · ${hex(display.color)}`, inline: false },
      { name: "Spawn Chance", value: fmtVal(profile?.dropWeight, "%"), inline: true },
      { name: "Worth", value: fmtVal(profile?.worthValue, " 💠"), inline: true },
      { name: "Burn", value: fmtVal(profile?.burnValue, " 💠"), inline: true },
    )
    .setFooter({ text: "Blank/default values fall back to card defaults and the shared rarity runtime." });

  const displayRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rarity_edit:name:${r}`).setLabel("Name").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`rarity_edit:emoji:${r}`).setLabel("Emoji").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`rarity_edit:color:${r}`).setLabel("Color").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`rarity_edit:preview:${r}`).setLabel("Preview").setStyle(ButtonStyle.Secondary),
  );
  const valuesRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rarity_hub:settings:editvalues:${r}`).setLabel("Spawn % / Worth / Burn").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`rarity_hub:settings:resetvalues:${r}`).setLabel("Reset Values").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("rarity_hub:settings").setLabel("← Rarities").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [displayRow, valuesRow] };
}

// ── Economy Overrides ─────────────────────────────────────────────────────────

function buildEconomyPanel(
  profiles: ProfileRow[],
  displayMap?: RarityDisplayMap | null,
  settings?: EditSettings | null,
) {
  const byRarity = new Map(profiles.map(r => [r.rarity as Rarity, r]));
  const embed = new EmbedBuilder()
    .setTitle("📊 Rarity Values")
    .setColor(0x5865f2)
    .setDescription(
      "Set spawn chance, worth, and burn for built-in rarities. " +
      "These values apply to **every card in that rarity** for this server.\n" +
      "Pick a rarity from the menu to configure it.\n\u200b",
    );
  const order = getRarityOrder(settings);
  for (const r of order) {
    const row = byRarity.get(r);
    const hasAny = row && (row.worthValue !== null || row.burnValue !== null || row.dropWeight !== null);
    const dispLabel = rarityLabel(r, settings, displayMap);
    const dispEmoji = rarityEmoji(r, settings, displayMap);
    embed.addFields({
      name: `${dispEmoji} ${dispLabel}`,
      value: hasAny
        ? `Worth: ${fmtVal(row?.worthValue, " 💠")} · Burn: ${fmtVal(row?.burnValue, " 💠")} · Spawn %: ${fmtVal(row?.dropWeight)}`
        : "*(using card defaults)*",
      inline: false,
    });
  }
  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("rarity_hub:economy:select")
      .setPlaceholder("Pick a tier to configure…")
      .addOptions(order.map(r => {
        const row = byRarity.get(r);
        const parts: string[] = [];
        if (row?.worthValue != null) parts.push(`Worth: ${row.worthValue}`);
        if (row?.burnValue != null) parts.push(`Burn: ${row.burnValue}`);
        if (row?.dropWeight != null) parts.push(`Spawn: ${row.dropWeight}%`);
        const emojiObj = selectMenuEmoji(rarityEmoji(r, settings, displayMap), RARITY_EMOJI[r]);
        return {
          label: `${rarityEmoji(r, settings, displayMap)} ${rarityLabel(r, settings, displayMap)}`,
          value: r,
          emoji: emojiObj,
          description: (parts.length ? parts.join(" · ") : "No overrides").slice(0, 100),
        };
      })),
  );
  const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("rarity_hub:economy:resetall").setLabel("🔄 Reset All").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("rarity_hub:main").setLabel("← Hub").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [selectRow, btnRow] };
}

function buildEconomyTierPanel(
  rarity: Rarity,
  profile: ProfileRow | undefined,
  displayMap?: RarityDisplayMap | null,
  settings?: EditSettings | null,
) {
  const label = rarityLabel(rarity, settings, displayMap);
  const emoji = rarityEmoji(rarity, settings, displayMap);
  const hasOverride = profile && (profile.worthValue !== null || profile.burnValue !== null || profile.dropWeight !== null);
  const embed = new EmbedBuilder()
    .setTitle(`📊 ${emoji} ${label} — Economy`)
    .setColor(rarityColor(rarity, settings, displayMap))
    .addFields(
      { name: "Worth", value: fmtVal(profile?.worthValue, " 💠"), inline: true },
      { name: "Burn", value: fmtVal(profile?.burnValue, " 💠"), inline: true },
      { name: "Spawn Chance", value: fmtVal(profile?.dropWeight, "%"), inline: true },
    );
  if (!hasOverride) embed.setDescription("*No overrides — cards in this tier use their own values.*\n\u200b");
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rarity_hub:economy:set:${rarity}`).setLabel("✏️ Edit Values").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`rarity_hub:economy:reset:${rarity}`).setLabel("🔄 Reset").setStyle(ButtonStyle.Danger),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("rarity_hub:economy").setLabel("← Economy").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("rarity_hub:main").setLabel("← Hub").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row1, row2] };
}

// ── Custom Tiers ──────────────────────────────────────────────────────────────

function buildCustomPanel(tiers: CustomRow[]) {
  const embed = new EmbedBuilder()
    .setTitle("⚙️ Advanced Labels (Legacy Custom Tiers)")
    .setColor(0x5865f2)
    .setDescription(
      tiers.length === 0
        ? "_No advanced labels yet. Most servers do not need these._\n\u200b"
        : `${tiers.length} advanced label${tiers.length === 1 ? "" : "s"} in this server. Built-in rarities remain the primary system.\n\u200b`,
    );
  for (const t of tiers) {
    embed.addFields({
      name: `${t.emoji} ${t.name}`,
      value:
        `Position **${t.position}** · Color ${hex(t.color)}\n` +
        `Worth 💠 ${t.worthValue.toLocaleString()} · Burn 💠 ${t.burnValue.toLocaleString()} · Spawn % ${t.dropWeight}\n` +
        `Spawns: ${t.droppable ? "✅" : "❌"} · In packs: ${t.inPacks ? "✅" : "❌"}`,
      inline: false,
    });
  }
  const btns: ButtonBuilder[] = [
    new ButtonBuilder().setCustomId("rarity_hub:custom:add").setLabel("➕ Add Advanced Label").setStyle(ButtonStyle.Success),
  ];
  if (tiers.length > 0) {
    btns.push(
      new ButtonBuilder().setCustomId("rarity_hub:custom:edit").setLabel("✏️ Edit Label").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("rarity_hub:custom:remove").setLabel("🗑️ Remove Label").setStyle(ButtonStyle.Danger),
    );
  }
  btns.push(new ButtonBuilder().setCustomId("rarity_hub:main").setLabel("← Hub").setStyle(ButtonStyle.Secondary));
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(btns);
  return { embeds: [embed], components: [row] };
}

function buildCustomSelectPanel(tiers: CustomRow[], action: "edit" | "remove") {
  const embed = new EmbedBuilder()
    .setTitle(action === "edit" ? "✏️ Pick an Advanced Label to Edit" : "🗑️ Pick an Advanced Label to Remove")
    .setColor(action === "edit" ? 0x5865f2 : 0xe74c3c)
    .setDescription(
      action === "remove"
        ? "⚠️ Cards assigned to this legacy label will revert to their built-in rarity.\n\u200b"
        : "Select an advanced label to edit. Most servers should use built-in rarity settings instead.\n\u200b",
    );
  const select = new StringSelectMenuBuilder()
    .setCustomId(`rarity_hub:custom:select:${action}`)
    .setPlaceholder("Pick a custom tier…")
    .addOptions(tiers.slice(0, 25).map(t => ({
      label: `${t.emoji} ${t.name}`,
      value: t.slug,
      emoji: selectMenuEmoji(t.emoji, "⭐"),
      description: `Advanced · Worth ${t.worthValue} · Burn ${t.burnValue} · Spawn ${t.dropWeight}%`.slice(0, 100),
    })));
  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("rarity_hub:custom").setLabel("← Advanced Labels").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [selectRow, backRow] };
}

// ── Card Tiers ────────────────────────────────────────────────────────────────

function buildCardTierPanel() {
  const embed = new EmbedBuilder()
    .setTitle("⚙️ Legacy Card Assignments")
    .setColor(0x5865f2)
    .setDescription(
      "Advanced compatibility tool: assign a card to a legacy custom tier.\n" +
      "For normal rarity setup, use built-in rarity settings instead. Unassigning reverts the card back to its built-in rarity.\n\u200b",
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("rarity_hub:cardtier:assign").setLabel("📌 Assign Legacy Label").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("rarity_hub:cardtier:unassign").setLabel("🔓 Clear Legacy Label").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("rarity_hub:main").setLabel("← Hub").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

// ── Button Handler ────────────────────────────────────────────────────────────
// Buttons that open modals MUST NOT call deferUpdate first.

export async function handleRarityHubButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) { await interaction.deferUpdate(); return; }
  const parts = interaction.customId.split(":");
  // parts: ["rarity_hub", section, sub?, extra?]
  const section = parts[1]!;
  const sub = parts[2];
  const extra = parts[3];

  // ── Built-in settings: values modal (no defer) ────────────────────────────
  if (section === "settings" && sub === "editvalues" && extra && BUILTIN_RARITIES.includes(extra as Rarity)) {
    const r = extra as Rarity;
    const displayMap = await getRarityDisplayOverrides(interaction.guild.id);
    const modal = new ModalBuilder()
      .setCustomId(`rarity_hub:modal:settingsvalues:${r}`)
      .setTitle(`Edit ${rarityLabel(r, null, displayMap)} — Values`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("worth").setLabel("Worth (💠 shards)").setStyle(TextInputStyle.Short)
            .setRequired(false).setPlaceholder("Leave blank to keep current value").setMaxLength(10),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("burn").setLabel("Burn value (💠 shards)").setStyle(TextInputStyle.Short)
            .setRequired(false).setPlaceholder("Leave blank to keep current value").setMaxLength(10),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("weight").setLabel("Spawn chance % (e.g. 30)").setStyle(TextInputStyle.Short)
            .setRequired(false).setPlaceholder("Leave blank to keep current value").setMaxLength(10),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  // ── Economy: set override → modal (no defer) ──────────────────────────────
  if (section === "economy" && sub === "set" && extra && BUILTIN_RARITIES.includes(extra as Rarity)) {
    const r = extra as Rarity;
    const displayMap = await getRarityDisplayOverrides(interaction.guild.id);
    const modal = new ModalBuilder()
      .setCustomId(`rarity_hub:modal:economy:${r}`)
      .setTitle(`${rarityEmoji(r, null, displayMap)} ${rarityLabel(r, null, displayMap)} — Values`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("worth").setLabel("Worth (💠 shards)").setStyle(TextInputStyle.Short)
            .setRequired(false).setPlaceholder("Leave blank to keep current value").setMaxLength(10),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("burn").setLabel("Burn value (💠 shards)").setStyle(TextInputStyle.Short)
            .setRequired(false).setPlaceholder("Leave blank to keep current value").setMaxLength(10),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("weight").setLabel("Spawn chance % (e.g. 30)").setStyle(TextInputStyle.Short)
            .setRequired(false).setPlaceholder("Leave blank to keep current value").setMaxLength(10),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  // ── Custom: add → modal (no defer) ───────────────────────────────────────
  if (section === "custom" && sub === "add") {
    const modal = new ModalBuilder()
      .setCustomId("rarity_hub:modal:custom:add")
      .setTitle("Create Advanced Label")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("name").setLabel("Display name (e.g. Ultra, Prismatic)").setStyle(TextInputStyle.Short)
            .setRequired(true).setMaxLength(32),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("emoji").setLabel("Emoji (e.g. 🌈 or 💫)").setStyle(TextInputStyle.Short)
            .setRequired(true).setMaxLength(8),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("position").setLabel("Advanced order (1=Common … 6=Mythic)").setStyle(TextInputStyle.Short)
            .setRequired(true).setMaxLength(10).setPlaceholder("e.g. 5.5 to sit between Legendary and Mythic"),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("worth").setLabel("Worth (💠 shards per card — burn = 50%)").setStyle(TextInputStyle.Short)
            .setRequired(true).setMaxLength(10).setPlaceholder("e.g. 3000"),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("drop").setLabel("Legacy spawn % (0 = disabled)").setStyle(TextInputStyle.Short)
            .setRequired(true).setMaxLength(10).setPlaceholder("e.g. 15 for ~15% of spawns"),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  // ── Card tier: assign / unassign → modal (no defer) ──────────────────────
  if (section === "cardtier" && sub === "assign") {
    const modal = new ModalBuilder()
      .setCustomId("rarity_hub:modal:cardtier:assign")
      .setTitle("Assign Legacy Label")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("card").setLabel("Card name (exact)").setStyle(TextInputStyle.Short)
            .setRequired(true).setMaxLength(100),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("tier").setLabel("Advanced label name (e.g. Event)").setStyle(TextInputStyle.Short)
            .setRequired(true).setMaxLength(100),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  if (section === "cardtier" && sub === "unassign") {
    const modal = new ModalBuilder()
      .setCustomId("rarity_hub:modal:cardtier:unassign")
      .setTitle("Clear Legacy Label")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("card").setLabel("Card name (exact)").setStyle(TextInputStyle.Short)
            .setRequired(true).setMaxLength(100),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  // ── All other buttons (no modal) — safe to defer ──────────────────────────
  await interaction.deferUpdate();
  const guildId = interaction.guild.id;

  if (section === "main") {
    await interaction.editReply(buildHubPanel());
    return;
  }

  if (section === "settings") {
    if (sub === "resetvalues" && extra && BUILTIN_RARITIES.includes(extra as Rarity)) {
      const r = extra as Rarity;
      await deleteRarityProfile(guildId, r);
      const [displayMap, settings, profiles] = await Promise.all([
        getRarityDisplayOverrides(guildId),
        getOrCreateGuildSettings(guildId),
        listRarityProfiles(guildId),
      ]);
      await interaction.editReply(buildSettingsTierPanel(r, displayMap, settings, profiles.find(p => p.rarity === r)));
      return;
    }
    const [displayMap, settings, profiles] = await Promise.all([
      getRarityDisplayOverrides(guildId),
      getOrCreateGuildSettings(guildId),
      listRarityProfiles(guildId),
    ]);
    await interaction.editReply(buildSettingsPanel(displayMap, settings, profiles));
    return;
  }

  if (section === "display") {
    const [displayMap, settings] = await Promise.all([
      getRarityDisplayOverrides(guildId),
      getOrCreateGuildSettings(guildId),
    ]);
    await interaction.editReply(buildEditPanel(displayMap, settings));
    return;
  }

  if (section === "order") {
    if (sub === "reset") {
      await updateGuildSettings(guildId, { rarityOrder: null });
      const [displayMap, settings] = await Promise.all([
        getRarityDisplayOverrides(guildId),
        getOrCreateGuildSettings(guildId),
      ]);
      await interaction.editReply(buildOrderPanel(getRarityOrder(settings), displayMap, settings));
      return;
    }
    if ((sub === "up" || sub === "down") && extra) {
      const r = extra as Rarity;
      const [displayMap, settings] = await Promise.all([
        getRarityDisplayOverrides(guildId),
        getOrCreateGuildSettings(guildId),
      ]);
      const order = getRarityOrder(settings);
      const idx = order.indexOf(r);
      if (idx >= 0) {
        const swapIdx = sub === "up" ? idx - 1 : idx + 1;
        if (swapIdx >= 0 && swapIdx < order.length) {
          const next = [...order];
          [next[idx], next[swapIdx]] = [next[swapIdx]!, next[idx]!];
          await updateGuildSettings(guildId, { rarityOrder: next });
          const updatedSettings = await getOrCreateGuildSettings(guildId);
          await interaction.editReply(buildOrderPanel(getRarityOrder(updatedSettings), displayMap, updatedSettings, r));
          return;
        }
      }
      await interaction.editReply(buildOrderPanel(order, displayMap, settings, r));
      return;
    }
    const [displayMap, settings] = await Promise.all([
      getRarityDisplayOverrides(guildId),
      getOrCreateGuildSettings(guildId),
    ]);
    await interaction.editReply(buildOrderPanel(getRarityOrder(settings), displayMap, settings));
    return;
  }

  if (section === "economy") {
    if (sub === "reset" && extra) {
      await deleteRarityProfile(guildId, extra as Rarity);
      const [profiles, displayMap, settings] = await Promise.all([
        listRarityProfiles(guildId),
        getRarityDisplayOverrides(guildId),
        getOrCreateGuildSettings(guildId),
      ]);
      const profile = profiles.find(p => p.rarity === extra);
      await interaction.editReply(buildEconomyTierPanel(extra as Rarity, profile, displayMap, settings));
      return;
    }
    const [profiles, displayMap, settings] = await Promise.all([
      listRarityProfiles(guildId),
      getRarityDisplayOverrides(guildId),
      getOrCreateGuildSettings(guildId),
    ]);
    if (!sub) {
      await interaction.editReply(buildEconomyPanel(profiles, displayMap, settings));
      return;
    }
    if (sub === "resetall") {
      for (const r of BUILTIN_RARITIES) await deleteRarityProfile(guildId, r);
      const freshProfiles = await listRarityProfiles(guildId);
      await interaction.editReply(buildEconomyPanel(freshProfiles, displayMap, settings));
      return;
    }
    if (sub === "economy" && !extra) {
      await interaction.editReply(buildEconomyPanel(profiles, displayMap, settings));
      return;
    }
  }

  if (section === "custom") {
    if (!sub) {
      const tiers = await listCustomRarities(guildId);
      await interaction.editReply(buildCustomPanel(tiers));
      return;
    }
    if (sub === "edit") {
      const tiers = await listCustomRarities(guildId);
      if (tiers.length === 0) {
        await interaction.followUp({ content: "❌ No advanced labels to edit. Add one first.", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.editReply(buildCustomSelectPanel(tiers, "edit"));
      return;
    }
    if (sub === "remove") {
      const tiers = await listCustomRarities(guildId);
      if (tiers.length === 0) {
        await interaction.followUp({ content: "❌ No advanced labels to remove.", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.editReply(buildCustomSelectPanel(tiers, "remove"));
      return;
    }
  }

  if (section === "cardtier" && !sub) {
    await interaction.editReply(buildCardTierPanel());
    return;
  }
}

// ── Select Menu Handler ───────────────────────────────────────────────────────

export async function handleRarityHubSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.guild) { await interaction.deferUpdate(); return; }
  const guildId = interaction.guild.id;
  const parts = interaction.customId.split(":");
  // "rarity_hub:economy:select" or "rarity_hub:custom:select:edit|remove"
  const section = parts[1]!;
  const sub = parts[2];
  const action = parts[3] as "edit" | "remove" | undefined;

  if (section === "settings" && sub === "select") {
    await interaction.deferUpdate();
    const r = interaction.values[0] as Rarity;
    const [displayMap, settings, profiles] = await Promise.all([
      getRarityDisplayOverrides(guildId),
      getOrCreateGuildSettings(guildId),
      listRarityProfiles(guildId),
    ]);
    await interaction.editReply(buildSettingsTierPanel(r, displayMap, settings, profiles.find(p => p.rarity === r)));
    return;
  }

  if (section === "economy" && sub === "select") {
    await interaction.deferUpdate();
    const r = interaction.values[0] as Rarity;
    const [profiles, displayMap, settings] = await Promise.all([
      listRarityProfiles(guildId),
      getRarityDisplayOverrides(guildId),
      getOrCreateGuildSettings(guildId),
    ]);
    const profile = profiles.find(p => p.rarity === r);
    await interaction.editReply(buildEconomyTierPanel(r, profile, displayMap, settings));
    return;
  }

  if (section === "order" && sub === "select") {
    await interaction.deferUpdate();
    const r = interaction.values[0] as Rarity;
    const [displayMap, settings] = await Promise.all([
      getRarityDisplayOverrides(guildId),
      getOrCreateGuildSettings(guildId),
    ]);
    await interaction.editReply(buildOrderPanel(getRarityOrder(settings), displayMap, settings, r));
    return;
  }

  if (section === "custom" && sub === "select" && action === "remove") {
    await interaction.deferUpdate();
    const slug = interaction.values[0]!;
    const { removed, clearedAssignments } = await deleteCustomRarity(guildId, slug);
    const tiers = await listCustomRarities(guildId);
    const panel = buildCustomPanel(tiers);
    if (removed) {
      panel.embeds[0]!.setFooter({ text: `✅ Removed "${slug}" — ${clearedAssignments} card assignment(s) cleared` });
    } else {
      panel.embeds[0]!.setFooter({ text: `❌ Tier "${slug}" not found` });
    }
    await interaction.editReply(panel);
    return;
  }

  if (section === "custom" && sub === "select" && action === "edit") {
    const slug = interaction.values[0]!;
    const tier = await getCustomRarityBySlug(guildId, slug);
    if (!tier) {
      await interaction.deferUpdate();
      const tiers = await listCustomRarities(guildId);
      await interaction.editReply(buildCustomPanel(tiers));
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId(`rarity_hub:modal:custom:edit:${slug}`)
      .setTitle(`Edit: ${tier.emoji} ${tier.name}`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("name").setLabel("Display name").setStyle(TextInputStyle.Short)
            .setRequired(false).setMaxLength(32).setValue(tier.name),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("emoji").setLabel("Emoji").setStyle(TextInputStyle.Short)
            .setRequired(false).setMaxLength(8).setValue(tier.emoji),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("drop").setLabel("Legacy spawn % (0 = disabled)").setStyle(TextInputStyle.Short)
            .setRequired(false).setMaxLength(10).setValue(String(tier.dropWeight)),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("worth").setLabel("Worth (💠 shards)").setStyle(TextInputStyle.Short)
            .setRequired(false).setMaxLength(10).setValue(String(tier.worthValue)),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("burn").setLabel("Burn (💠 shards)").setStyle(TextInputStyle.Short)
            .setRequired(false).setMaxLength(10).setValue(String(tier.burnValue)),
        ),
      );
    await interaction.showModal(modal);
    return;
  }
}

// ── Modal Handler ─────────────────────────────────────────────────────────────

export async function handleRarityHubModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.guild) { await interaction.deferUpdate(); return; }
  await interaction.deferUpdate();
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const parts = interaction.customId.split(":");
  // "rarity_hub:modal:<section>:<extra>[:<slug>]"
  const section = parts[2]!;
  const extra = parts[3];
  const slugExtra = parts[4];

  // ── Economy modal ─────────────────────────────────────────────────────────
  if ((section === "economy" || section === "settingsvalues") && extra) {
    const r = extra as Rarity;
    const worthRaw = interaction.fields.getTextInputValue("worth").trim();
    const burnRaw = interaction.fields.getTextInputValue("burn").trim();
    const weightRaw = interaction.fields.getTextInputValue("weight").trim();

    const patch: { worthValue?: number; burnValue?: number; dropWeight?: number; updatedBy?: string } = { updatedBy: userId };
    if (worthRaw) {
      const v = parseInt(worthRaw, 10);
      if (isNaN(v) || v < 0) { await interaction.followUp({ content: "❌ Worth must be a non-negative whole number.", flags: MessageFlags.Ephemeral }); return; }
      patch.worthValue = v;
    }
    if (burnRaw) {
      const v = parseInt(burnRaw, 10);
      if (isNaN(v) || v < 0) { await interaction.followUp({ content: "❌ Burn must be a non-negative whole number.", flags: MessageFlags.Ephemeral }); return; }
      patch.burnValue = v;
    }
    if (weightRaw) {
      const v = parseFloat(weightRaw);
      if (isNaN(v) || v < 0) { await interaction.followUp({ content: "❌ Spawn chance must be a non-negative number.", flags: MessageFlags.Ephemeral }); return; }
      patch.dropWeight = v;
    }
    if (Object.keys(patch).length <= 1) {
      await interaction.followUp({ content: "❌ Fill in at least one field.", flags: MessageFlags.Ephemeral });
      return;
    }
    await upsertRarityProfile(guildId, r, patch);
    const profiles = await listRarityProfiles(guildId);
    const profile = profiles.find(p => p.rarity === r);
    if (section === "settingsvalues") {
      const [displayMap, settings] = await Promise.all([
        getRarityDisplayOverrides(guildId),
        getOrCreateGuildSettings(guildId),
      ]);
      await interaction.editReply(buildSettingsTierPanel(r, displayMap, settings, profile));
    } else {
      const [displayMap, settings] = await Promise.all([
        getRarityDisplayOverrides(guildId),
        getOrCreateGuildSettings(guildId),
      ]);
      await interaction.editReply(buildEconomyTierPanel(r, profile, displayMap, settings));
    }
    return;
  }

  // ── Custom tier: add ──────────────────────────────────────────────────────
  if (section === "custom" && extra === "add") {
    const name = interaction.fields.getTextInputValue("name").trim();
    const emoji = interaction.fields.getTextInputValue("emoji").trim();
    const positionRaw = interaction.fields.getTextInputValue("position").trim();
    const worthRaw = interaction.fields.getTextInputValue("worth").trim();
    const dropRaw = interaction.fields.getTextInputValue("drop").trim();

    if (!name || name.length > 32) { await interaction.followUp({ content: "❌ Name must be 1–32 chars.", flags: MessageFlags.Ephemeral }); return; }
    if (!emoji || emoji.length > 8) { await interaction.followUp({ content: "❌ Emoji must be 1–8 chars.", flags: MessageFlags.Ephemeral }); return; }
    const position = parseFloat(positionRaw);
    if (isNaN(position) || position <= 0 || position > 100) { await interaction.followUp({ content: "❌ Position must be 0.01–100 (e.g. 5.5 = between Legendary and Mythic).", flags: MessageFlags.Ephemeral }); return; }
    const worth = parseInt(worthRaw, 10);
    if (isNaN(worth) || worth < 0) { await interaction.followUp({ content: "❌ Worth must be a non-negative whole number.", flags: MessageFlags.Ephemeral }); return; }
    const drop = parseFloat(dropRaw);
    if (isNaN(drop) || drop < 0 || drop > 100) { await interaction.followUp({ content: "❌ Drop % must be 0–100.", flags: MessageFlags.Ephemeral }); return; }
    const burn = Math.floor(worth * 0.5);

    let slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "tier";
    let attempts = 0;
    while (attempts < 5) {
      try {
        await createCustomRarity(guildId, {
          slug, name, emoji, position, worthValue: worth, burnValue: burn,
          color: 0x5865f2, dropWeight: drop, droppable: drop > 0, inPacks: false,
          updatedBy: userId,
        });
        break;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/unique|duplicate key|23505/i.test(msg)) {
          attempts++;
          slug = (slug.replace(/_\d+$/, "") + `_${attempts + 1}`).slice(0, 32);
        } else throw err;
      }
    }
    const tiers = await listCustomRarities(guildId);
    const panel = buildCustomPanel(tiers);
    panel.embeds[0]!.setFooter({ text: `✅ Created tier "${name}"` });
    await interaction.editReply(panel);
    return;
  }

  // ── Custom tier: edit ─────────────────────────────────────────────────────
  if (section === "custom" && extra === "edit" && slugExtra) {
    const name = interaction.fields.getTextInputValue("name").trim();
    const emoji = interaction.fields.getTextInputValue("emoji").trim();
    const dropRaw = interaction.fields.getTextInputValue("drop").trim();
    const worthRaw = interaction.fields.getTextInputValue("worth").trim();
    const burnRaw = interaction.fields.getTextInputValue("burn").trim();

    const patch: Parameters<typeof updateCustomRarity>[2] = { updatedBy: userId };
    if (name) { if (name.length > 32) { await interaction.followUp({ content: "❌ Name too long (max 32 chars).", flags: MessageFlags.Ephemeral }); return; } patch.name = name; }
    if (emoji) { if (emoji.length > 8) { await interaction.followUp({ content: "❌ Emoji too long (max 8 chars).", flags: MessageFlags.Ephemeral }); return; } patch.emoji = emoji; }
    if (dropRaw) { const v = parseFloat(dropRaw); if (isNaN(v) || v < 0 || v > 100) { await interaction.followUp({ content: "❌ Drop % must be 0–100.", flags: MessageFlags.Ephemeral }); return; } patch.dropWeight = v; patch.droppable = v > 0; }
    if (worthRaw) { const v = parseInt(worthRaw, 10); if (isNaN(v) || v < 0) { await interaction.followUp({ content: "❌ Worth must be ≥ 0.", flags: MessageFlags.Ephemeral }); return; } patch.worthValue = v; }
    if (burnRaw) { const v = parseInt(burnRaw, 10); if (isNaN(v) || v < 0) { await interaction.followUp({ content: "❌ Burn must be ≥ 0.", flags: MessageFlags.Ephemeral }); return; } patch.burnValue = v; }

    if (Object.keys(patch).length <= 1) {
      await interaction.followUp({ content: "❌ Change at least one field.", flags: MessageFlags.Ephemeral });
      return;
    }
    const updated = await updateCustomRarity(guildId, slugExtra, patch);
    const tiers = await listCustomRarities(guildId);
    const panel = buildCustomPanel(tiers);
    if (updated) panel.embeds[0]!.setFooter({ text: `✅ Updated "${updated.name}"` });
    await interaction.editReply(panel);
    return;
  }

  // ── Card tier: assign ─────────────────────────────────────────────────────
  if (section === "cardtier" && extra === "assign") {
    const cardName = interaction.fields.getTextInputValue("card").trim();
    const tierInput = interaction.fields.getTextInputValue("tier").trim().toLowerCase();
    const card = await getCardByName(cardName, guildId);
    if (!card) { await interaction.followUp({ content: `❌ No card named **${cardName}**.`, flags: MessageFlags.Ephemeral }); return; }
    const tiers = await listCustomRarities(guildId);
    const tier = tiers.find(t => t.slug === tierInput || t.name.toLowerCase() === tierInput);
    if (!tier) {
      const names = tiers.map(t => `${t.emoji} ${t.name}`).join(", ") || "none created yet";
      await interaction.followUp({ content: `❌ No custom tier named **"${tierInput}"**.\nAvailable: ${names}`, flags: MessageFlags.Ephemeral });
      return;
    }
    await assignCardToCustomRarity(guildId, card.id, tier.slug);
    await interaction.followUp({
      content: `✅ **${card.name}** → ${tier.emoji} **${tier.name}** (worth 💠 ${tier.worthValue.toLocaleString()}, burn 💠 ${tier.burnValue.toLocaleString()}).`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // ── Card tier: unassign ───────────────────────────────────────────────────
  if (section === "cardtier" && extra === "unassign") {
    const cardName = interaction.fields.getTextInputValue("card").trim();
    const card = await getCardByName(cardName, guildId);
    if (!card) { await interaction.followUp({ content: `❌ No card named **${cardName}**.`, flags: MessageFlags.Ephemeral }); return; }
    const removed = await unassignCardCustomRarity(guildId, card.id);
    const r = card.rarity as Rarity;
    const displayMap = await getRarityDisplayOverrides(guildId);
    await interaction.followUp({
      content: removed
        ? `🔄 **${card.name}** reverted to ${rarityEmoji(r, null, displayMap)} **${rarityLabel(r, null, displayMap)}**.`
        : `ℹ️ **${card.name}** wasn't in any custom tier.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
}

// ── Display Names Panel (cosmetic overrides for built-in tiers) ───────────────
// Accessed from the hub via the "🎨 Display Names" button.

type EditSettings = { mythicLabel?: string | null; mythicEmoji?: string | null; mythicColor?: number | null; rarityOrder?: string[] | null };

function getEffectiveDisplay(r: Rarity, displayMap: RarityDisplayMap, settings: EditSettings | null) {
  const ov = displayMap.get(r);
  const label = ov?.displayName?.trim()
    || (r === "mythic" && settings?.mythicLabel?.trim() ? settings.mythicLabel.trim() : RARITY_LABELS[r]);
  const emoji = ov?.emoji?.trim()
    || (r === "mythic" && settings?.mythicEmoji?.trim() ? settings.mythicEmoji.trim() : RARITY_EMOJI[r]);
  const color = ov?.color != null
    ? ov.color
    : (r === "mythic" && settings?.mythicColor != null ? settings.mythicColor : RARITY_COLORS[r]);
  return { label, emoji, color: color ?? 0x5865f2, hasOverride: !!ov };
}

function buildEditPanel(
  displayMap: RarityDisplayMap,
  settings: EditSettings | null,
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] } {
  const embed = new EmbedBuilder()
    .setTitle("🎨 Rarity Display Names")
    .setColor(0x5865f2)
    .setDescription(
      "Rename any built-in rarity tier for this server — changes the display name, emoji, and embed color " +
      "in spawns, collections, packs, and trade-ins. Economy values are unaffected.\n\u200b",
    );
  const order = getRarityOrder(settings);
  for (const r of order) {
    const { label, emoji, color, hasOverride } = getEffectiveDisplay(r, displayMap, settings);
    embed.addFields({
      name: `${emoji} ${label}`,
      value: hasOverride ? `\`${hex(color)}\` *(overrides active)*` : `\`${hex(color)}\` *(defaults)*`,
      inline: true,
    });
  }
  embed.setFooter({ text: "Select a tier below to edit it · Reset All clears every override" });

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("rarity_edit:select")
      .setPlaceholder("Pick a rarity tier to edit…")
      .addOptions(
        order.map(r => {
          const { label, emoji, hasOverride } = getEffectiveDisplay(r, displayMap, settings);
          // Custom emoji shortcodes (e.g. ":yellow_heart:") crash Discord select options;
          // StringSelectMenu emojis must be Unicode or {id,name}. Fall back to the default Unicode emoji.
          const emojiObj = selectMenuEmoji(emoji, RARITY_EMOJI[r]);
          return { label, emoji: emojiObj, value: r, description: hasOverride ? "Has overrides" : "Using defaults" };
        }),
      ),
  );
  const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("rarity_edit:resetall").setLabel("🗑️ Reset All").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("rarity_hub:main").setLabel("← Hub").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [selectRow, btnRow] };
}

function buildTierPanel(
  r: Rarity,
  displayMap: RarityDisplayMap,
  settings: EditSettings | null,
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const { label, emoji, color, hasOverride } = getEffectiveDisplay(r, displayMap, settings);
  const ov = displayMap.get(r);
  const defLabel = r === "mythic" && settings?.mythicLabel?.trim() ? settings.mythicLabel.trim() : RARITY_LABELS[r];
  const defEmoji = r === "mythic" && settings?.mythicEmoji?.trim() ? settings.mythicEmoji.trim() : RARITY_EMOJI[r];
  const defColor = r === "mythic" && settings?.mythicColor != null ? settings.mythicColor : (RARITY_COLORS[r] ?? 0x5865f2);

  const embed = new EmbedBuilder()
    .setTitle(`🎨 Edit: ${emoji} ${label}`)
    .setColor(color)
    .addFields(
      {
        name: "Display Name",
        value: ov?.displayName ? `**${ov.displayName}** *(overridden)*` : `${defLabel} *(default)*`,
        inline: true,
      },
      {
        name: "Emoji",
        value: ov?.emoji ? `${ov.emoji} *(overridden)*` : `${defEmoji} *(default)*`,
        inline: true,
      },
      {
        name: "Color",
        value: ov?.color != null ? `\`${hex(ov.color)}\` *(overridden)*` : `\`${hex(defColor)}\` *(default)*`,
        inline: true,
      },
    )
    .setFooter({ text: "Changes apply immediately across all bot embeds for this server" });

  if (!hasOverride) embed.setDescription("*All fields are currently at defaults.*\n\u200b");

  const editRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rarity_edit:name:${r}`).setLabel("📝 Set Name").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`rarity_edit:emoji:${r}`).setLabel("😀 Set Emoji").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`rarity_edit:color:${r}`).setLabel("🎨 Set Color").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`rarity_edit:reset:${r}`).setLabel("🔄 Reset Tier").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("rarity_edit:back").setLabel("← Back").setStyle(ButtonStyle.Secondary),
  );
  const previewRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rarity_edit:preview:${r}`).setLabel("👁️ Preview Tier").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [editRow, previewRow] };
}

export async function handleRarityEditButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) { await interaction.deferUpdate(); return; }
  const guildId = interaction.guild.id;
  const parts = interaction.customId.split(":");
  const action = parts[1]!;
  const rarityPart = parts[2] as Rarity | undefined;

  if (action === "back" || action === "resetall") {
    await interaction.deferUpdate();
    if (action === "resetall") await clearAllRarityDisplayOverrides(guildId);
    const [displayMap, settings] = await Promise.all([
      getRarityDisplayOverrides(guildId),
      getOrCreateGuildSettings(guildId),
    ]);
    await interaction.editReply(buildEditPanel(displayMap, settings));
    return;
  }

  if (action === "reset" && rarityPart && BUILTIN_RARITIES.includes(rarityPart)) {
    await interaction.deferUpdate();
    await clearRarityDisplayOverride(guildId, rarityPart);
    const [displayMap, settings] = await Promise.all([
      getRarityDisplayOverrides(guildId),
      getOrCreateGuildSettings(guildId),
    ]);
    await interaction.editReply(buildTierPanel(rarityPart, displayMap, settings));
    return;
  }

  if (action === "preview" && rarityPart && BUILTIN_RARITIES.includes(rarityPart)) {
    await interaction.deferReply({ ephemeral: true });
    const [displayMap, settings] = await Promise.all([
      getRarityDisplayOverrides(guildId),
      getOrCreateGuildSettings(guildId),
    ]);
    const { label, emoji, color } = getEffectiveDisplay(rarityPart, displayMap, settings);
    const sampleCard = { name: "Dark Titan", dropWeight: 1.0, worthValue: 2500, burnValue: 1250 };
    const preview = new EmbedBuilder()
      .setTitle(`${emoji} ${label} — Preview`)
      .setColor(color)
      .setDescription(
        `This is how **${label}** tier cards will appear in bot embeds for this server.\n\n` +
        `**Sample card:** ${emoji} **${sampleCard.name}**\n` +
        `Worth: 💠 ${sampleCard.worthValue.toLocaleString()} · Burn: 🔥 ${sampleCard.burnValue.toLocaleString()}`,
      )
      .setFooter({ text: "Dismiss this preview — your changes are already live" });
    await interaction.followUp({ embeds: [preview], ephemeral: true });
    return;
  }

  // name, emoji, color — show modal (MUST be first response; no deferUpdate).
  if ((action === "name" || action === "emoji" || action === "color") && rarityPart && BUILTIN_RARITIES.includes(rarityPart)) {
    const cfgs = {
      name:  { label: "Display Name",  placeholder: "e.g. Cosmic, Prismatic, Ultra (1–32 chars)", max: 32 },
      emoji: { label: "Emoji",          placeholder: "e.g. 🌈 or 💫 (leave blank to clear)", max: 8 },
      color: { label: "Color (hex)",    placeholder: "e.g. #ff2d92 or #00d4ff (leave blank to clear)", max: 9 },
    } as const;
    const cfg = cfgs[action];
    const displayMap = await getRarityDisplayOverrides(guildId);
    const modal = new ModalBuilder()
      .setCustomId(`rarity_edit:modal:${action}:${rarityPart}`)
      .setTitle(`Edit ${rarityLabel(rarityPart, null, displayMap)} — ${cfg.label}`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("value")
            .setLabel(cfg.label)
            .setPlaceholder(cfg.placeholder)
            .setStyle(TextInputStyle.Short)
            .setMaxLength(cfg.max)
            .setRequired(false),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  await interaction.deferUpdate();
}

export async function handleRarityEditSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.guild) { await interaction.deferUpdate(); return; }
  await interaction.deferUpdate();
  const guildId = interaction.guild.id;
  const r = interaction.values[0] as Rarity;
  if (!BUILTIN_RARITIES.includes(r)) return;
  const [displayMap, settings] = await Promise.all([
    getRarityDisplayOverrides(guildId),
    getOrCreateGuildSettings(guildId),
  ]);
  await interaction.editReply(buildTierPanel(r, displayMap, settings));
}

export async function handleRarityEditModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.guild) { await interaction.deferUpdate(); return; }
  await interaction.deferUpdate();
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const parts = interaction.customId.split(":");
  const action = parts[2] as "name" | "emoji" | "color";
  const r = parts[3] as Rarity;
  if (!BUILTIN_RARITIES.includes(r)) return;

  const raw = interaction.fields.getTextInputValue("value").trim();

  if (action === "name") {
    await upsertRarityDisplayOverride(guildId, r, { displayName: raw.length === 0 ? null : raw }, userId);
  } else if (action === "emoji") {
    await upsertRarityDisplayOverride(guildId, r, { emoji: raw.length === 0 ? null : raw }, userId);
  } else if (action === "color") {
    if (raw.length === 0) {
      await upsertRarityDisplayOverride(guildId, r, { color: null }, userId);
    } else {
      const parsed = parseHexColor(raw);
      if (parsed === null) {
        await interaction.followUp({ content: "❌ Color must be a valid hex code like `#ff2d92`.", flags: MessageFlags.Ephemeral });
      } else {
        await upsertRarityDisplayOverride(guildId, r, { color: parsed }, userId);
      }
    }
  }

  const [displayMap, settings] = await Promise.all([
    getRarityDisplayOverrides(guildId),
    getOrCreateGuildSettings(guildId),
  ]);
  await interaction.editReply(buildTierPanel(r, displayMap, settings));
}
