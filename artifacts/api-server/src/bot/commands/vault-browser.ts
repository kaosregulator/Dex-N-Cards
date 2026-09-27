// Live price guide navigator — browse Value Vault X (JSON) or Vaulted Values X (HTML)
// from Discord with buttons. Fast path prefers the JSON feed; VVX HTML is link-driven.

import type {
  ButtonInteraction,
  StringSelectMenuInteraction,
  ChatInputCommandInteraction,
} from "discord.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import { logger } from "../../lib/logger.js";
import {
  VAULTEDVALUESX_LIST_URL,
  VALUEVAULTX_SITE_URL,
} from "./vault-sources.js";
import {
  buildMTTVItemEmbed,
  fetchMTTVItems,
  formatMTTVValue,
  matchScore,
  rarityEmoji,
  type MTTVItem,
} from "./mttvalues.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;
const PAGE_SIZE = 8;
const SESSION_TTL_MS = 15 * 60 * 1000;

export type BrowserSite = "valuevaultx" | "vaultedvaluesx";

type BrowserState = {
  ownerUserId: string;
  site: BrowserSite;
  rarityFilter: string | null;
  query: string | null;
  page: number;
  expiresAt: number;
};

const sessions = new Map<string, BrowserState>();

function sessionKey(userId: string, channelId: string): string {
  return `${userId}:${channelId}`;
}

function touch(state: BrowserState): void {
  state.expiresAt = Date.now() + SESSION_TTL_MS;
}

function getSession(userId: string, channelId: string): BrowserState | null {
  const key = sessionKey(userId, channelId);
  const s = sessions.get(key);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    sessions.delete(key);
    return null;
  }
  return s;
}

function putSession(state: BrowserState, channelId: string): void {
  touch(state);
  sessions.set(sessionKey(state.ownerUserId, channelId), state);
}

const SITE_RARITIES = [
  "Common",
  "Uncommon",
  "Rare",
  "Epic",
  "Legendary",
  "Exotic",
  "Limited Edition",
] as const;

async function loadVaultedList(): Promise<Array<{ name: string; slug: string }>> {
  const resp = await fetch(VAULTEDVALUESX_LIST_URL, {
    signal: AbortSignal.timeout(15_000),
    headers: { "User-Agent": "DN-Cards-Bot/1.0 (+vaultvalue browser)" },
  });
  if (!resp.ok) throw new Error(`VVX list HTTP ${resp.status}`);
  const html = await resp.text();
  const re = /\/mts\/items\/([a-z0-9-]+)/gi;
  const seen = new Set<string>();
  const out: Array<{ name: string; slug: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const slug = m[1]!;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const name = slug
      .split("-")
      .map((w) => w.toUpperCase() === "LE" ? "LE" : w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    out.push({ name, slug });
  }
  return out;
}

function filterJsonItems(items: MTTVItem[], state: BrowserState): MTTVItem[] {
  let list = items;
  if (state.rarityFilter) {
    const rf = state.rarityFilter.toLowerCase();
    list = list.filter((i) => i.rarity.some((r) => r.toLowerCase() === rf));
  }
  if (state.query) {
    list = list
      .map((i) => ({ i, score: matchScore(i, state.query!) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.i);
  } else {
    list = list
      .slice()
      .sort((a, b) => (b.valueMax ?? 0) - (a.valueMax ?? 0) || a.name.localeCompare(b.name));
  }
  return list;
}

function hubEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xf59e0b)
    .setTitle("🧭 Live price guide")
    .setDescription(
      [
        "Browse Military Tycoon values **inside Discord** — pick a site, filter by rarity, open an item.",
        "",
        `**Value Vault X** — live JSON feed ([site](${VALUEVAULTX_SITE_URL})) · fastest & most detailed`,
        `**Vaulted Values X** — live list UI ([list](${VAULTEDVALUESX_LIST_URL})) · page-style navigation`,
        "",
        "Tip: `/vaultvalue item:Name` still jumps straight to one card.",
      ].join("\n"),
    )
    .setFooter({ text: "No API keys · live fetches · ephemeral for you only" });
}

function siteRows(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("vvbrowse:site:valuevaultx").setLabel("Value Vault X").setEmoji("📦").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("vvbrowse:site:vaultedvaluesx").setLabel("Vaulted Values X").setEmoji("🌐").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("vvbrowse:search").setLabel("Search").setEmoji("🔎").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function rarityRows(site: BrowserSite): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const chunk: typeof SITE_RARITIES[number][][] = [
    ["Common", "Uncommon", "Rare", "Epic"],
    ["Legendary", "Exotic", "Limited Edition"],
  ];
  for (const group of chunk) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...group.map((r) =>
          new ButtonBuilder()
            .setCustomId(`vvbrowse:rarity:${site}:${encodeURIComponent(r)}`)
            .setLabel(r.length > 18 ? r.slice(0, 18) : r)
            .setStyle(ButtonStyle.Secondary),
        ),
      ),
    );
  }
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`vvbrowse:rarity:${site}:`).setLabel("All rarities").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("vvbrowse:home").setLabel("Sites").setEmoji("🏠").setStyle(ButtonStyle.Secondary),
    ),
  );
  return rows;
}

async function renderJsonPage(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ChatInputCommandInteraction,
  state: BrowserState,
): Promise<void> {
  const items = filterJsonItems(await fetchMTTVItems(), state);
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  state.page = Math.min(Math.max(0, state.page), pages - 1);
  const slice = items.slice(state.page * PAGE_SIZE, state.page * PAGE_SIZE + PAGE_SIZE);

  const lines = slice.map((it, idx) => {
    const n = state.page * PAGE_SIZE + idx + 1;
    const rare = it.rarity.map((r) => `${rarityEmoji(r)} ${r}`).join(" · ") || "—";
    return `**${n}.** ${it.name}\n💎 ${formatMTTVValue(it)} · ${rare}`;
  });

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle("📦 Value Vault X — browse")
    .setDescription(
      (state.rarityFilter ? `Filter: **${state.rarityFilter}**\n` : "") +
      (state.query ? `Search: **${state.query}**\n` : "") +
      (lines.length ? lines.join("\n\n") : "_No items on this page._") +
      `\n\nPage **${state.page + 1}/${pages}** · **${items.length}** matches`,
    )
    .setFooter({ text: "Select an item below · prices live from valuevaultx.com" });

  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
  if (slice.length) {
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("vvbrowse:pick:valuevaultx")
          .setPlaceholder("Open an item…")
          .addOptions(
            slice.map((it) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(it.name.slice(0, 100))
                .setValue(it.name.slice(0, 100))
                .setDescription(`💎 ${formatMTTVValue(it)}`.slice(0, 100)),
            ),
          ),
      ),
    );
  }
  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("vvbrowse:page:prev").setLabel("◀ Prev").setStyle(ButtonStyle.Secondary).setDisabled(state.page <= 0),
      new ButtonBuilder().setCustomId("vvbrowse:page:next").setLabel("Next ▶").setStyle(ButtonStyle.Secondary).setDisabled(state.page >= pages - 1),
      new ButtonBuilder().setCustomId("vvbrowse:filters").setLabel("Rarities").setEmoji("⭐").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("vvbrowse:home").setLabel("Sites").setStyle(ButtonStyle.Secondary),
    ),
  );

  putSession(state, interaction.channelId!);
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ embeds: [embed], components });
  } else if (interaction.isButton() || interaction.isStringSelectMenu()) {
    await interaction.update({ embeds: [embed], components });
  } else {
    await interaction.reply({ embeds: [embed], components, ...EPHEMERAL });
  }
}

async function renderVvxPage(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  state: BrowserState,
): Promise<void> {
  const list = await loadVaultedList();
  let filtered = list;
  if (state.query) {
    const q = state.query.toLowerCase();
    filtered = list.filter((x) => x.name.toLowerCase().includes(q) || x.slug.includes(q.replace(/\s+/g, "-")));
  }
  // Enrich with JSON prices when names match
  const json = await fetchMTTVItems().catch(() => [] as MTTVItem[]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  state.page = Math.min(Math.max(0, state.page), pages - 1);
  const slice = filtered.slice(state.page * PAGE_SIZE, state.page * PAGE_SIZE + PAGE_SIZE);

  const lines = slice.map((it, idx) => {
    const n = state.page * PAGE_SIZE + idx + 1;
    const hit = json.find((j) => j.name.toLowerCase() === it.name.toLowerCase())
      ?? json.map((j) => ({ j, s: matchScore(j, it.name) })).filter((x) => x.s > 40).sort((a, b) => b.s - a.s)[0]?.j;
    const price = hit ? `💎 ${formatMTTVValue(hit)}` : "🔗 open page";
    return `**${n}.** [${it.name}](https://mts.vaultedvaluesx.com/mts/items/${it.slug}) — ${price}`;
  });

  const embed = new EmbedBuilder()
    .setColor(0x3b82f6)
    .setTitle("🌐 Vaulted Values X — browse")
    .setDescription(
      (state.query ? `Search: **${state.query}**\n` : "") +
      (lines.length ? lines.join("\n") : "_No items — try Search or Value Vault X._") +
      `\n\nPage **${state.page + 1}/${pages}** · **${filtered.length}** on list` +
      `\n[Open full list](${VAULTEDVALUESX_LIST_URL})`,
    )
    .setFooter({ text: "Pick an item for details · prices cross-checked with valuevaultx when names match" });

  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
  if (slice.length) {
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("vvbrowse:pick:vaultedvaluesx")
          .setPlaceholder("Open an item…")
          .addOptions(
            slice.map((it) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(it.name.slice(0, 100))
                .setValue(it.slug.slice(0, 100))
                .setDescription(`mts.vaultedvaluesx.com/mts/items/${it.slug}`.slice(0, 100)),
            ),
          ),
      ),
    );
  }
  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("vvbrowse:page:prev").setLabel("◀ Prev").setStyle(ButtonStyle.Secondary).setDisabled(state.page <= 0),
      new ButtonBuilder().setCustomId("vvbrowse:page:next").setLabel("Next ▶").setStyle(ButtonStyle.Secondary).setDisabled(state.page >= pages - 1),
      new ButtonBuilder().setCustomId("vvbrowse:home").setLabel("Sites").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("vvbrowse:search").setLabel("Search").setStyle(ButtonStyle.Primary),
    ),
  );

  putSession(state, interaction.channelId!);
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ embeds: [embed], components });
  } else {
    await interaction.update({ embeds: [embed], components });
  }
}

export async function startVaultBrowser(interaction: ButtonInteraction | ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId || !interaction.channelId) {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: "Server only." });
    } else {
      await interaction.reply({ content: "Server only.", ...EPHEMERAL });
    }
    return;
  }
  const state: BrowserState = {
    ownerUserId: interaction.user.id,
    site: "valuevaultx",
    rarityFilter: null,
    query: null,
    page: 0,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  putSession(state, interaction.channelId);
  const payload = { embeds: [hubEmbed()], components: siteRows() };
  if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
  else if (interaction.isButton()) await interaction.update(payload);
  else await interaction.reply({ ...payload, ...EPHEMERAL });
}

export async function handleVaultBrowserComponent(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): Promise<void> {
  if (!interaction.guildId || !interaction.channelId) {
    await interaction.reply({ content: "Server only.", ...EPHEMERAL });
    return;
  }

  const id = interaction.customId;
  let state = getSession(interaction.user.id, interaction.channelId);
  if (!state && !id.startsWith("vvbrowse:site:") && id !== "vvbrowse:home") {
    await interaction.reply({
      content: "Session expired — open **Browse** from `/vaultvalue` again.",
      ...EPHEMERAL,
    });
    return;
  }

  try {
    if (id === "vvbrowse:home") {
      await startVaultBrowser(interaction as ButtonInteraction);
      return;
    }

    if (id.startsWith("vvbrowse:site:")) {
      const site = id.slice("vvbrowse:site:".length) as BrowserSite;
      state = {
        ownerUserId: interaction.user.id,
        site,
        rarityFilter: null,
        query: null,
        page: 0,
        expiresAt: Date.now() + SESSION_TTL_MS,
      };
      putSession(state, interaction.channelId);
      if (site === "valuevaultx") {
        await interaction.deferUpdate();
        await renderJsonPage(interaction, state);
      } else {
        await interaction.deferUpdate();
        await renderVvxPage(interaction, state);
      }
      return;
    }

    if (id === "vvbrowse:filters" && state) {
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(0xf59e0b)
            .setTitle("⭐ Filter by site rarity")
            .setDescription("Tap a rarity to jump — Limited Edition is the top trade tier."),
        ],
        components: rarityRows(state.site),
      });
      return;
    }

    if (id.startsWith("vvbrowse:rarity:") && state) {
      const rest = id.slice("vvbrowse:rarity:".length);
      const colon = rest.indexOf(":");
      const site = rest.slice(0, colon) as BrowserSite;
      const rarityRaw = decodeURIComponent(rest.slice(colon + 1));
      state.site = site;
      state.rarityFilter = rarityRaw || null;
      state.page = 0;
      await interaction.deferUpdate();
      if (site === "valuevaultx") await renderJsonPage(interaction, state);
      else await renderVvxPage(interaction, state);
      return;
    }

    if (id === "vvbrowse:page:prev" && state) {
      state.page -= 1;
      await interaction.deferUpdate();
      if (state.site === "valuevaultx") await renderJsonPage(interaction, state);
      else await renderVvxPage(interaction, state);
      return;
    }

    if (id === "vvbrowse:page:next" && state) {
      state.page += 1;
      await interaction.deferUpdate();
      if (state.site === "valuevaultx") await renderJsonPage(interaction, state);
      else await renderVvxPage(interaction, state);
      return;
    }

    if (id === "vvbrowse:search") {
      const modal = new ModalBuilder()
        .setCustomId("vvbrowse:modal:search")
        .setTitle("Search value list")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("q")
              .setLabel("Item name / acronym")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(80)
              .setPlaceholder("Sea Dragon, STM, Abrams…"),
          ),
        );
      await (interaction as ButtonInteraction).showModal(modal);
      return;
    }

    if (id === "vvbrowse:pick:valuevaultx" && interaction.isStringSelectMenu()) {
      const name = interaction.values[0]!;
      await interaction.deferUpdate();
      const items = await fetchMTTVItems();
      const item = items.find((i) => i.name === name)
        ?? items.map((i) => ({ i, s: matchScore(i, name) })).sort((a, b) => b.s - a.s)[0]?.i;
      if (!item) {
        await interaction.followUp({ content: "Item not found.", ...EPHEMERAL });
        return;
      }
      const linkRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setLabel("Open on valuevaultx.com").setStyle(ButtonStyle.Link).setURL(VALUEVAULTX_SITE_URL),
        new ButtonBuilder().setCustomId("vvbrowse:back").setLabel("◀ Back to list").setStyle(ButtonStyle.Secondary),
      );
      await interaction.editReply({
        embeds: [buildMTTVItemEmbed(item).setFooter({ text: "Live from Value Vault X · Back returns to your browse session" })],
        components: [linkRow],
      });
      return;
    }

    if (id === "vvbrowse:pick:vaultedvaluesx" && interaction.isStringSelectMenu()) {
      const slug = interaction.values[0]!;
      await interaction.deferUpdate();
      const url = `https://mts.vaultedvaluesx.com/mts/items/${slug}`;
      const pretty = slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      const json = await fetchMTTVItems().catch(() => [] as MTTVItem[]);
      const hit = json.find((j) => j.name.toLowerCase() === pretty.toLowerCase())
        ?? json.map((j) => ({ j, s: matchScore(j, pretty) })).filter((x) => x.s > 35).sort((a, b) => b.s - a.s)[0]?.j;

      const embed = hit
        ? buildMTTVItemEmbed(hit).setFooter({ text: "Details from Value Vault X feed · page link is Vaulted Values X" })
        : new EmbedBuilder()
          .setColor(0x3b82f6)
          .setTitle(pretty)
          .setDescription(`Open the live item page on Vaulted Values X:\n${url}`)
          .setURL(url);

      const linkRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setLabel("Open item page").setStyle(ButtonStyle.Link).setURL(url),
        new ButtonBuilder().setLabel("Full value list").setStyle(ButtonStyle.Link).setURL(VAULTEDVALUESX_LIST_URL),
        new ButtonBuilder().setCustomId("vvbrowse:back").setLabel("◀ Back to list").setStyle(ButtonStyle.Secondary),
      );
      await interaction.editReply({ embeds: [embed], components: [linkRow] });
      return;
    }

    if (id === "vvbrowse:back" && state) {
      await interaction.deferUpdate();
      if (state.site === "valuevaultx") await renderJsonPage(interaction, state);
      else await renderVvxPage(interaction, state);
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, "vault browser failed");
    const msg = "Could not load that page — try Value Vault X (JSON) or again in a moment.";
    if (interaction.deferred || interaction.replied) await interaction.followUp({ content: msg, ...EPHEMERAL }).catch(() => {});
    else await interaction.reply({ content: msg, ...EPHEMERAL }).catch(() => {});
  }
}

export async function handleVaultBrowserModal(
  interaction: import("discord.js").ModalSubmitInteraction,
): Promise<void> {
  if (interaction.customId !== "vvbrowse:modal:search") return;
  if (!interaction.channelId) {
    await interaction.reply({ content: "Server only.", ...EPHEMERAL });
    return;
  }
  const q = interaction.fields.getTextInputValue("q").trim();
  let state = getSession(interaction.user.id, interaction.channelId);
  if (!state) {
    state = {
      ownerUserId: interaction.user.id,
      site: "valuevaultx",
      rarityFilter: null,
      query: q,
      page: 0,
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
  } else {
    state.query = q;
    state.page = 0;
  }
  putSession(state, interaction.channelId);
  await interaction.deferReply(EPHEMERAL);
  if (state.site === "valuevaultx") await renderJsonPage(interaction as unknown as ButtonInteraction, state);
  else await renderVvxPage(interaction as unknown as ButtonInteraction, state);
}
