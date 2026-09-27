// /vaultvalue — panel hub + optional autocomplete lookup.
// Info → pick a site → search → pick item → prices/description (webhook, ~45s).
// Browse → live mini-browser (public webhook, site-branded).

import type {
  ChatInputCommandInteraction,
  ButtonInteraction,
  ChannelSelectMenuInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from "discord.js";
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import { withOptionValues } from "./option-proxy.js";
import { VAULT_SITE_BRANDS, getVaultBrand, type VaultBrandId } from "./vault-branding.js";
import {
  ackThenPostVault,
  applyVaultBrand,
  postVaultWebhook,
  refreshVaultCleanup,
  VAULT_MSG_TTL_MS,
} from "./vault-webhook.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

export function buildVaultValueCommandJson() {
  return new SlashCommandBuilder()
    .setName("vaultvalue")
    .setDescription("Vault Values — MT prices, calculator, top list (valuevaultx.com)")
    .setDMPermission(false)
    .addStringOption((o) =>
      o
        .setName("item")
        .setDescription("Look up an item (type to autocomplete)")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .toJSON();
}

function hubEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xf59e0b)
    .setTitle("📦 Vault Values Hub")
    .setDescription(
      [
        "Live Military Tycoon prices — look up one item, or **Browse** a real site in Discord.",
        "",
        "**Quick lookup:** `/vaultvalue item:Sea Dragon` (autocomplete)",
        "",
        "**Info** — choose a site → search → pick an item → prices & description",
        "**Browse** — live page photos · numbered clicks · site search · scroll",
        "**Calc** — two-sided trade calculator",
        "**List** — top items by value",
        "**Help** / **Sources** — docs + site health",
        "**Post Calc** — (admin) pin a calculator in a channel",
        "",
        `_Info & Browse post publicly as each site (~${Math.round(VAULT_MSG_TTL_MS / 1000)}s cleanup)._`,
      ].join("\n"),
    )
    .setFooter({ text: "Info = site-branded lookup · Browse = live website photos" });
}

function hubRows(isAdmin: boolean) {
  const rows = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("vvhub:info").setLabel("Info").setEmoji("🔎").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("vvhub:browse").setLabel("Browse").setEmoji("🧭").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("vvhub:calc").setLabel("Calculator").setEmoji("🧮").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("vvhub:list").setLabel("Top list").setEmoji("📊").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("vvhub:help").setLabel("Help").setEmoji("❓").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("vvhub:sources").setLabel("Sources").setEmoji("🛰️").setStyle(ButtonStyle.Secondary),
    ),
  ];
  if (isAdmin) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("vvhub:postcalc").setLabel("Post calculator").setEmoji("📌").setStyle(ButtonStyle.Danger),
      ),
    );
  }
  return rows;
}

function infoSitePickerEmbed(): EmbedBuilder {
  const lines = (Object.keys(VAULT_SITE_BRANDS) as VaultBrandId[]).map((id) => {
    const b = VAULT_SITE_BRANDS[id];
    return `${b.emoji} **${b.name}** — [open site](${b.url})`;
  });
  return applyVaultBrand(
    new EmbedBuilder()
      .setTitle("🔎 Pick a value site")
      .setDescription(
        [
          `Hey <@USER> — choose where you want to look things up.`,
          "",
          ...lines,
          "",
          "Next: type a search → pick from the list → see **price + description**.",
          `_Posted as the site · cleans up in ~${Math.round(VAULT_MSG_TTL_MS / 1000)}s_`,
        ].join("\n"),
      )
      .setImage(VAULT_SITE_BRANDS.valuevaultx.bannerUrl),
    "valuevaultx",
    { useBanner: false },
  );
}

function infoSitePickerRows(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("vvhub:info:site:valuevaultx")
        .setLabel("Value Vault X")
        .setEmoji("📦")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("vvhub:info:site:vaultedvaluesx")
        .setLabel("Vaulted Values X")
        .setEmoji("🌐")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("vvhub:info:site:mttvalues")
        .setLabel("MTT Values")
        .setEmoji("📈")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

export async function handleVaultValueCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "Server only.", ...EPHEMERAL });
    return;
  }

  const item = interaction.options.getString("item")?.trim();
  if (item) {
    // Fast path: brand as Value Vault X (primary JSON feed) via webhook
    await postItemLookup(interaction, "valuevaultx", item);
    return;
  }

  await interaction.deferReply(EPHEMERAL);
  const isAdmin = !!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  await interaction.editReply({ embeds: [hubEmbed()], components: hubRows(isAdmin) });
}

async function postItemLookup(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
  siteId: VaultBrandId,
  name: string,
): Promise<void> {
  const brand = getVaultBrand(siteId);
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply(EPHEMERAL);
  }

  const {
    fetchMTTVItems,
    matchScore,
    buildMTTVItemEmbed,
    formatMTTVValue,
  } = await import("./mttvalues.js");

  let items;
  try {
    items = await fetchMTTVItems();
  } catch {
    await interaction.editReply({
      content: "❌ Price feed briefly unavailable — try again in a moment.",
    });
    return;
  }

  const exact = items.find((i) => i.name.toLowerCase() === name.trim().toLowerCase());
  const scored = exact
    ? [{ i: exact, score: 999 }]
    : items
        .map((i) => ({ i, score: matchScore(i, name) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    const embed = applyVaultBrand(
      new EmbedBuilder()
        .setTitle("No matches")
        .setDescription(`Couldn’t find **${name}** on the live feed. Try another spelling or acronym.`),
      siteId,
      { useBanner: true },
    );
    await ackThenPostVault(interaction, siteId, { embeds: [embed] });
    return;
  }

  const top = scored.slice(0, 25);
  const clearWinner = top.length === 1 || (top[0]!.score >= (top[1]?.score ?? 0) + 15);

  if (clearWinner) {
    const embed = buildMTTVItemEmbed(top[0]!.i, siteId);
    await ackThenPostVault(
      interaction,
      siteId,
      { embeds: [embed] },
      `✅ **${brand.name}** · ${top[0]!.i.name}`,
    );
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`vvhub:info:pick:${siteId}`)
    .setPlaceholder(`Pick a match for "${name.slice(0, 40)}"`)
    .addOptions(
      top.slice(0, 25).map(({ i }) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(i.name.slice(0, 100))
          .setValue(i.name.slice(0, 100))
          .setDescription(
            `${formatMTTVValue(i)} · ${(i.rarity[0] ?? "—").slice(0, 40)}`.slice(0, 100),
          ),
      ),
    );

  const embed = applyVaultBrand(
    new EmbedBuilder()
      .setTitle(`🔍 Results for “${name.slice(0, 60)}”`)
      .setDescription(
        [
          `Several items match — pick one below for **price + description**.`,
          "",
          `_Prices from the live Value Vault X feed · shown as **${brand.name}**_`,
        ].join("\n"),
      ),
    siteId,
    { useBanner: true },
  );

  await ackThenPostVault(
    interaction,
    siteId,
    {
      embeds: [embed],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    },
    `✅ **${brand.name}** · ${top.length} matches — pick one on the floor message`,
  );
}

export async function handleVaultValueHubComponent(
  interaction: ButtonInteraction | ChannelSelectMenuInteraction | StringSelectMenuInteraction,
): Promise<void> {
  const id = interaction.customId;

  // ── Info: greet with site choice ──────────────────────────────────────────
  if (id === "vvhub:info" && interaction.isButton()) {
    const embed = infoSitePickerEmbed();
    // Personalize greeting
    const desc = (embed.data.description ?? "").replace("<@USER>", `<@${interaction.user.id}>`);
    embed.setDescription(desc);

    await ackThenPostVault(
      interaction,
      "valuevaultx",
      { embeds: [embed], components: infoSitePickerRows() },
      "✅ Choose a site on the floor message",
    );
    return;
  }

  if (id.startsWith("vvhub:info:site:") && interaction.isButton()) {
    const siteId = id.slice("vvhub:info:site:".length) as VaultBrandId;
    if (!VAULT_SITE_BRANDS[siteId]) {
      await interaction.reply({ content: "Unknown site.", ...EPHEMERAL });
      return;
    }
    const brand = getVaultBrand(siteId);
    refreshVaultCleanup(interaction.client, interaction.channelId!, interaction.message.id);

    const modal = new ModalBuilder()
      .setCustomId(`vvhub:modal:info:${siteId}`)
      .setTitle(`Search ${brand.shortName}`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("item")
            .setLabel("Item name (fuzzy / acronym OK)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(100)
            .setPlaceholder("e.g. STM, Sea Dragon, Abrams"),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  if (id.startsWith("vvhub:info:pick:") && interaction.isStringSelectMenu()) {
    const siteId = id.slice("vvhub:info:pick:".length) as VaultBrandId;
    const name = interaction.values[0];
    if (!name) {
      await interaction.reply({ content: "No item selected.", ...EPHEMERAL });
      return;
    }
    refreshVaultCleanup(interaction.client, interaction.channelId!, interaction.message.id);

    const { fetchMTTVItems, buildMTTVItemEmbed } = await import("./mttvalues.js");
    await interaction.deferUpdate();
    const items = await fetchMTTVItems();
    const item = items.find((i) => i.name === name) ?? items.find((i) => i.name.toLowerCase() === name.toLowerCase());
    if (!item) {
      await interaction.followUp({ content: `❌ Lost track of **${name}** — search again.`, ...EPHEMERAL });
      return;
    }
    const embed = buildMTTVItemEmbed(item, siteId);
    // Update the floor message in place (keeps webhook author)
    try {
      await interaction.message.edit({
        embeds: [embed],
        components: [],
        files: [],
      });
      refreshVaultCleanup(interaction.client, interaction.channelId!, interaction.message.id);
    } catch {
      await postVaultWebhook(interaction, siteId, { embeds: [embed] });
    }
    return;
  }

  // Legacy pick id from older menus
  if (id.startsWith("vvhub:pick:") && interaction.isStringSelectMenu()) {
    const name = interaction.values[0];
    if (!name) {
      await interaction.reply({ content: "No item selected.", ...EPHEMERAL });
      return;
    }
    await postItemLookup(interaction, "valuevaultx", name);
    return;
  }

  if (id === "vvhub:browse" && interaction.isButton()) {
    const { startVaultBrowser } = await import("./vault-browser.js");
    await startVaultBrowser(interaction);
    return;
  }

  if (id === "vvhub:calc" && interaction.isButton()) {
    const { handleCalc } = await import("./mttvalues.js");
    await handleCalc(interaction as unknown as ChatInputCommandInteraction);
    return;
  }

  if (id === "vvhub:list" && interaction.isButton()) {
    const { handleValueList } = await import("./mttvalues.js");
    await handleValueList(interaction as unknown as ChatInputCommandInteraction);
    return;
  }

  if (id === "vvhub:help" && interaction.isButton()) {
    const { handleValueHelp } = await import("./mttvalues.js");
    await handleValueHelp(interaction as unknown as ChatInputCommandInteraction);
    return;
  }

  if (id === "vvhub:sources" && interaction.isButton()) {
    await interaction.deferReply(EPHEMERAL);
    const { checkAllVaultSources, loadVaultFeedSnapshot, diffVaultFeedSnapshot, saveVaultFeedSnapshot } =
      await import("./vault-sources.js");
    const statuses = await checkAllVaultSources();
    const feed = statuses.find((s) => s.id === "valuevaultx");
    const prev = loadVaultFeedSnapshot();
    const changes = feed ? diffVaultFeedSnapshot(prev, feed) : [];
    if (feed?.ok) saveVaultFeedSnapshot(feed);

    const lines = statuses.map((s) => {
      const icon = s.ok ? "✅" : "❌";
      const count = s.itemCount != null ? ` · ${s.itemCount} items` : "";
      const http = s.httpStatus != null ? ` HTTP ${s.httpStatus}` : "";
      const note = s.note ? `\n└ ${s.note}` : "";
      return `${icon} **${s.label}**${http}${count}\n[${s.url}](${s.url})${note}`;
    });
    if (changes.length) {
      lines.push("", `📝 **Since last snapshot:** ${changes.slice(0, 8).join("; ")}`);
    } else if (prev) {
      lines.push("", "📝 Feed matches last snapshot.");
    }

    const embed = new EmbedBuilder()
      .setColor(0xf59e0b)
      .setTitle("🛰️ Vault value sources")
      .setDescription(lines.join("\n\n"))
      .setFooter({ text: "Primary prices: valuevaultx.com JSON · snapshot updated on check" });
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (id === "vvhub:postcalc" && interaction.isButton()) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: "Administrator only.", ...EPHEMERAL });
      return;
    }
    const row = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId("vvhub:postcalc_channel")
        .setPlaceholder("Channel to post the calculator in")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMinValues(1)
        .setMaxValues(1),
    );
    await interaction.reply({
      content: "Pick the channel for the persistent calculator hub:",
      components: [row],
      ...EPHEMERAL,
    });
    return;
  }

  if (id === "vvhub:postcalc_channel" && interaction.isChannelSelectMenu()) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: "Administrator only.", ...EPHEMERAL });
      return;
    }
    const channel = interaction.channels.first();
    if (!channel) {
      await interaction.reply({ content: "No channel selected.", ...EPHEMERAL });
      return;
    }
    await interaction.deferReply(EPHEMERAL);
    const proxied = withOptionValues(interaction, {
      channels: { channel: channel as never, result_channel: null },
    });
    const { handlePostCalculator } = await import("./mttcalc-hub.js");
    await handlePostCalculator(proxied);
  }
}

export async function handleVaultValueHubModal(interaction: ModalSubmitInteraction): Promise<void> {
  const id = interaction.customId;

  // New: vvhub:modal:info:<siteId>
  if (id.startsWith("vvhub:modal:info:")) {
    const siteId = id.slice("vvhub:modal:info:".length) as VaultBrandId;
    const item = interaction.fields.getTextInputValue("item").trim();
    if (!item) {
      await interaction.reply({ content: "Enter an item name.", ...EPHEMERAL });
      return;
    }
    if (!VAULT_SITE_BRANDS[siteId]) {
      await interaction.reply({ content: "Unknown site.", ...EPHEMERAL });
      return;
    }
    await postItemLookup(interaction, siteId, item);
    return;
  }

  // Legacy modal without site
  if (id === "vvhub:modal:info") {
    const item = interaction.fields.getTextInputValue("item").trim();
    if (!item) {
      await interaction.reply({ content: "Enter an item name.", ...EPHEMERAL });
      return;
    }
    await postItemLookup(interaction, "valuevaultx", item);
  }
}
