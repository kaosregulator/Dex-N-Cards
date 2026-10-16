// /create_cards_from_mttv — stepped bulk create from Vault Values.
// Vault rarity is only a filter (which website items to look at), not the DN
// card rarity. Tag up to 5, preview images, then each tagged item is created
// one at a time through the /edit_card panel so it can be customized.

import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags,
  StringSelectMenuBuilder,
  type ButtonInteraction, type ChatInputCommandInteraction,
  type GuildMember, type StringSelectMenuInteraction,
} from "discord.js";
import { isAdmin, getAllCards, getOrCreateGuildSettings, getRarityDisplayOverrides } from "../db.js";
import { rarityEmoji as dnRarityEmoji, rarityLabel, type Rarity } from "../cards-data.js";
import {
  fetchMTTVItems, createCardFromVaultItem, rarityEmoji,
  type MTTVItem,
} from "./mttvalues.js";
import { logger } from "../../lib/logger.js";
import { renderPanel } from "./edit-card.js";
import { setEditPanelExtras } from "./edit-panel-extras.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;
const PAGE = 5;
const MAX_TAG = 5;
const TTL_MS = 15 * 60 * 1000;

export const VAULT_RARITY_FILTERS = [
  { id: "common", label: "Common" },
  { id: "uncommon", label: "Uncommon" },
  { id: "rare", label: "Rare" },
  { id: "epic", label: "Epic" },
  { id: "legendary", label: "Legendary" },
  { id: "exotic", label: "Exotic" },
  { id: "limited", label: "Limited Edition" },
] as const;

export type VaultRarityFilterId = (typeof VAULT_RARITY_FILTERS)[number]["id"];

export function vaultRarityKey(raw: string | undefined): VaultRarityFilterId | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s.includes("limited")) return "limited";
  if (s.includes("exotic")) return "exotic";
  if (s.includes("legend")) return "legendary";
  if (s.includes("epic")) return "epic";
  if (s === "uncommon") return "uncommon";
  if (s === "rare") return "rare";
  if (s === "common") return "common";
  return null;
}

export function itemsForVaultRarity(items: MTTVItem[], rarityId: string): MTTVItem[] {
  return items
    .filter(i => vaultRarityKey(i.rarity[0]) === rarityId && i.image)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function pageItems<T>(items: T[], page: number, size = PAGE): T[] {
  const start = Math.max(0, page) * size;
  return items.slice(start, start + size);
}

type CreatedCard = { id: number; name: string; rarity: string };

type Session = {
  guildId: string;
  userId: string;
  rarityId: VaultRarityFilterId | null;
  page: number;
  tagged: string[];
  dnRarity: string;
  setName: string | null;
  view: "rarity" | "browse" | "preview";
  queue: string[];
  created: CreatedCard[];
  skipped: string[];
  creating: boolean;
};

const sessions = new Map<string, Session>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function sessionKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

function touch(s: Session): Session {
  const key = sessionKey(s.guildId, s.userId);
  sessions.set(key, s);
  const prev = timers.get(key);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    sessions.delete(key);
    timers.delete(key);
  }, TTL_MS);
  t.unref?.();
  timers.set(key, t);
  return s;
}

function getSession(guildId: string, userId: string): Session | null {
  return sessions.get(sessionKey(guildId, userId)) ?? null;
}

async function memberIsAdmin(
  interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction,
): Promise<boolean> {
  if (!interaction.guild) return false;
  if (interaction.guild.ownerId === interaction.user.id) return true;
  const member = interaction.member as GuildMember | null;
  if (member?.permissions?.has("Administrator")) return true;
  return isAdmin(interaction.guild.id, interaction.user.id);
}

function filterLabel(id: string): string {
  return VAULT_RARITY_FILTERS.find(f => f.id === id)?.label ?? id;
}

async function existingNames(guildId: string): Promise<Set<string>> {
  const cards = await getAllCards(guildId);
  return new Set(cards.map(c => c.name.toLowerCase()));
}

function imageEmbed(item: MTTVItem, withName = false): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(0x9b59b6);
  if (withName) embed.setTitle(item.name.slice(0, 256));
  if (item.image) embed.setImage(item.image);
  return embed;
}

function rarityBackRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("vaultbatch:back").setLabel("Rarities").setStyle(ButtonStyle.Secondary),
  );
}

function countsLine(items: MTTVItem[]): string {
  const counts = new Map<string, number>();
  for (const f of VAULT_RARITY_FILTERS) counts.set(f.id, 0);
  for (const item of items) {
    const key = vaultRarityKey(item.rarity[0]);
    if (key && item.image) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return VAULT_RARITY_FILTERS
    .map(f => `${rarityEmoji(f.label)} **${f.label}** — ${counts.get(f.id) ?? 0}`)
    .join("\n");
}

async function rarityPayload(s: Session) {
  let items: MTTVItem[] = [];
  let err: string | null = null;
  try {
    items = await fetchMTTVItems();
  } catch {
    err = "Could not load Vault Values right now. Try again in a moment.";
  }
  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle("📦 Batch from Vault Values")
    .setDescription(
      err
      ?? [
        "Pick a **Vault Values rarity** to browse. That rarity is only a filter — it is **not** the DN card rarity.",
        "Then tag up to **5** items, preview their images, and create them with the same flow as `/create_card_from_mttv`.",
        s.dnRarity && s.dnRarity !== "auto" ? `\nDN rarity for new cards: **${s.dnRarity}**.` : "\nDN rarity: **auto** (mapped from each item’s Vault rarity).",
        s.setName ? `Set: **${s.setName}**.` : "",
        "",
        countsLine(items),
      ].filter(Boolean).join("\n"),
    );
  const select = new StringSelectMenuBuilder()
    .setCustomId("vaultbatch:rarity")
    .setPlaceholder("Filter by Vault rarity…")
    .addOptions(VAULT_RARITY_FILTERS.map(f => ({
      label: f.label,
      value: f.id,
      emoji: rarityEmoji(f.label) || undefined,
    })));
  return {
    content: null as string | null,
    embeds: [embed],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
  };
}

async function browsePayload(s: Session) {
  let items: MTTVItem[] = [];
  try {
    items = await fetchMTTVItems();
  } catch {
    return {
      content: "Could not load Vault Values right now. Try again in a moment.",
      embeds: [],
      components: [rarityBackRow()],
    };
  }
  const have = await existingNames(s.guildId);
  const all = itemsForVaultRarity(items, s.rarityId ?? "");
  const pool = all.filter(i => !have.has(i.name.toLowerCase()));
  const pages = Math.max(1, Math.ceil(pool.length / PAGE));
  if (s.page < 0) s.page = 0;
  s.page = s.page % pages;
  const page = pageItems(pool, s.page);
  const taggedSet = new Set(s.tagged);
  const label = filterLabel(s.rarityId ?? "");
  const taggedNames = s.tagged
    .map(id => items.find(i => i.id === id)?.name ?? id)
    .join(", ");

  const intro = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle(`${rarityEmoji(label)} ${label} · page ${s.page + 1}/${pages}`)
    .setDescription(
      [
        `Vault filter only — **not** the DN card rarity. **${pool.length}** left to add (${all.length} with art). Tag up to **${MAX_TAG}**.`,
        taggedSet.size
          ? `Tagged **${taggedSet.size}/${MAX_TAG}**: ${taggedNames}`
          : "Nothing tagged yet — pick from the dropdown.",
        taggedSet.size >= MAX_TAG ? "Tag limit reached — Preview or Clear tags from the next screen." : "",
        "Cards that already exist are hidden.",
      ].filter(Boolean).join("\n"),
    );

  if (pool.length === 0) {
    return {
      content: null as string | null,
      embeds: [intro],
      components: [rarityBackRow()],
    };
  }

  const embeds: EmbedBuilder[] = [intro, ...page.map(i => imageEmbed(i, true))];
  const room = Math.max(0, MAX_TAG - s.tagged.filter(id => !page.some(i => i.id === id)).length);
  const components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];
  if (page.length > 0 && room > 0) {
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("vaultbatch:pick")
        .setPlaceholder("Tag items from this page…")
        .setMinValues(1)
        .setMaxValues(Math.min(room, page.length))
        .addOptions(page.map(i => ({
          label: i.name.slice(0, 100),
          value: i.id.slice(0, 100),
          description: (taggedSet.has(i.id) ? "Tagged · " : "") + (i.rarity[0] ?? label).slice(0, 90),
          default: taggedSet.has(i.id),
        }))),
    ));
  }
  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("vaultbatch:prev").setLabel("Prev").setStyle(ButtonStyle.Secondary).setDisabled(s.page <= 0 || pages <= 1),
    new ButtonBuilder().setCustomId("vaultbatch:next").setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(s.page >= pages - 1 || pages <= 1),
    new ButtonBuilder().setCustomId("vaultbatch:shuffle").setLabel("New five").setStyle(ButtonStyle.Secondary).setDisabled(pool.length <= PAGE),
    new ButtonBuilder().setCustomId("vaultbatch:preview").setLabel("Preview").setEmoji("🖼️").setStyle(ButtonStyle.Primary).setDisabled(s.tagged.length === 0),
    new ButtonBuilder().setCustomId("vaultbatch:back").setLabel("Rarities").setStyle(ButtonStyle.Secondary),
  ));
  return { content: null as string | null, embeds, components };
}

async function previewPayload(s: Session) {
  let items: MTTVItem[] = [];
  try {
    items = await fetchMTTVItems();
  } catch {
    return {
      content: "Could not load Vault Values right now. Try again in a moment.",
      embeds: [],
      components: [rarityBackRow()],
    };
  }
  const tagged = s.tagged
    .map(id => items.find(i => i.id === id))
    .filter((i): i is MTTVItem => !!i && !!i.image);
  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle("🖼️ Preview batch")
    .setDescription(
      tagged.length
        ? `**${tagged.length}** item${tagged.length === 1 ? "" : "s"} — images only. Continue to run each through the same create path as \`/create_card_from_mttv\`.`
        : "Nothing tagged. Go back and pick items.",
    );
  const embeds: EmbedBuilder[] = [embed, ...tagged.map(i => imageEmbed(i, false))];
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("vaultbatch:create").setLabel("Create cards").setEmoji("✅").setStyle(ButtonStyle.Success).setDisabled(tagged.length === 0),
    new ButtonBuilder().setCustomId("vaultbatch:clear").setLabel("Clear tags").setStyle(ButtonStyle.Danger).setDisabled(tagged.length === 0),
    new ButtonBuilder().setCustomId("vaultbatch:browse").setLabel("Back").setStyle(ButtonStyle.Secondary),
  );
  return { content: null as string | null, embeds, components: [row] };
}

async function payload(s: Session) {
  if (s.view === "preview") return previewPayload(s);
  if (s.view === "browse" && s.rarityId) return browsePayload(s);
  return rarityPayload(s);
}

export async function handleVaultBatchCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) return;
  if (!(await memberIsAdmin(interaction))) {
    await interaction.reply({ content: "❌ Admins only.", ...EPHEMERAL });
    return;
  }
  const dnRarity = (interaction.options.getString("rarity") ?? "auto").trim().toLowerCase() || "auto";
  const allowedDn = new Set(["auto", "common", "uncommon", "rare", "epic", "legendary", "mythic"]);
  if (!allowedDn.has(dnRarity)) {
    await interaction.reply({
      content: "❌ Pick a built-in DN rarity (or `auto` to map each item’s Vault rarity). Vault rarity is chosen in the next step as a filter only.",
      ...EPHEMERAL,
    });
    return;
  }
  const setName = interaction.options.getString("set")?.trim() || null;
  const s = touch({
    guildId: interaction.guild.id,
    userId: interaction.user.id,
    rarityId: null,
    page: 0,
    tagged: [],
    dnRarity,
    setName,
    view: "rarity",
    queue: [],
    created: [],
    skipped: [],
    creating: false,
  });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply(await rarityPayload(s));
}

export async function handleVaultBatchButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) return;
  if (!(await memberIsAdmin(interaction))) {
    await interaction.reply({ content: "❌ Admins only.", ...EPHEMERAL });
    return;
  }
  const s = getSession(interaction.guild.id, interaction.user.id);
  if (!s) {
    await interaction.reply({ content: "This batch expired — run `/create_cards_from_mttv` again.", ...EPHEMERAL });
    return;
  }
  const action = interaction.customId.split(":")[1];
  if (action === "advance") {
    await presentNext(interaction, s);
    return;
  }
  if (action === "finish") {
    await showBatchDone(interaction, s);
    return;
  }
  if (action === "next") s.page += 1;
  if (action === "prev") s.page -= 1;
  if (action === "shuffle") {
    s.page = Math.floor(Math.random() * 1000);
  }
  if (action === "preview") s.view = "preview";
  if (action === "browse" || action === "back") {
    s.view = action === "back" ? "rarity" : "browse";
    if (action === "back") s.rarityId = null;
  }
  if (action === "clear") {
    s.tagged = [];
    s.view = "browse";
  }
  if (action === "create") {
    await runCreate(interaction, s);
    return;
  }
  touch(s);
  await interaction.deferUpdate();
  await interaction.editReply(await payload(s));
}

export async function handleVaultBatchSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.guild) return;
  if (!(await memberIsAdmin(interaction))) {
    await interaction.reply({ content: "❌ Admins only.", ...EPHEMERAL });
    return;
  }
  const s = getSession(interaction.guild.id, interaction.user.id);
  if (!s) {
    await interaction.reply({ content: "This batch expired — run `/create_cards_from_mttv` again.", ...EPHEMERAL });
    return;
  }
  const action = interaction.customId.split(":")[1];
  if (action === "rarity") {
    s.rarityId = (interaction.values[0] ?? null) as VaultRarityFilterId | null;
    s.page = 0;
    s.tagged = [];
    s.view = "browse";
  }
  if (action === "pick") {
    const have = await existingNames(s.guildId);
    const items = await fetchMTTVItems();
    const picked = interaction.values.filter(id => {
      const item = items.find(i => i.id === id);
      return item && !have.has(item.name.toLowerCase());
    });
    const merged = [...s.tagged];
    for (const id of picked) {
      if (!merged.includes(id) && merged.length < MAX_TAG) merged.push(id);
    }
    s.tagged = merged.slice(0, MAX_TAG);
  }
  touch(s);
  await interaction.deferUpdate();
  await interaction.editReply(await payload(s));
}

function batchNavRow(s: Session): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (s.queue.length > 0) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId("vaultbatch:advance")
        .setLabel(`Next card (${s.queue.length} left)`)
        .setStyle(ButtonStyle.Primary),
    );
  }
  row.addComponents(
    new ButtonBuilder()
      .setCustomId("vaultbatch:finish")
      .setLabel(s.queue.length > 0 ? "Finish" : "Done")
      .setStyle(s.queue.length > 0 ? ButtonStyle.Secondary : ButtonStyle.Success),
  );
  return row;
}

function pinBatchExtras(s: Session): void {
  setEditPanelExtras(s.guildId, s.userId, () => [batchNavRow(s)]);
}

async function presentNext(interaction: ButtonInteraction, s: Session): Promise<void> {
  if (s.creating) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    return;
  }
  s.creating = true;
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const items = await fetchMTTVItems();
    while (s.queue.length > 0) {
      const id = s.queue.shift()!;
      const item = items.find(i => i.id === id);
      if (!item) {
        s.skipped.push("A tagged item is no longer on Vault Values.");
        continue;
      }
      const position = s.created.length + s.skipped.length + 1;
      const total = position + s.queue.length;
      await interaction.editReply({
        content: `Creating **${position}/${total}** — ${item.name}…`,
        embeds: [],
        components: [],
      }).catch(() => {});
      try {
        const result = await createCardFromVaultItem({
          guildId: s.guildId,
          item,
          rarityRaw: s.dnRarity,
          setName: s.setName,
        });
        if (!result.ok) {
          s.skipped.push(`**${item.name}** — ${result.message.replace(/^❌\s*/, "")}`);
          continue;
        }
        s.created.push(result.card);
        touch(s);
        pinBatchExtras(s);
        await renderPanel(
          interaction,
          result.card.id,
          false,
          `Card **${s.created.length}** — **${result.card.name}**. Customize it, then ${s.queue.length ? "Next" : "Done"}.`,
        );
        return;
      } catch (err) {
        logger.error({ err, item: item.name }, "vault batch create failed");
        s.skipped.push(`**${item.name}** — unexpected error`);
      }
    }
    await showBatchDone(interaction, s);
  } finally {
    s.creating = false;
  }
}

async function showBatchDone(interaction: ButtonInteraction, s: Session): Promise<void> {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  setEditPanelExtras(s.guildId, s.userId, null);
  const left = s.queue.length;
  sessions.delete(sessionKey(s.guildId, s.userId));
  const [settings, displayMap] = await Promise.all([
    getOrCreateGuildSettings(s.guildId),
    getRarityDisplayOverrides(s.guildId),
  ]);
  const embed = new EmbedBuilder()
    .setColor(s.created.length ? 0x2ecc71 : 0xe74c3c)
    .setTitle("📦 Vault batch")
    .setDescription(
      [
        s.created.length
          ? `**Created ${s.created.length}**\n${s.created.map(c => {
              const rarity = c.rarity as Rarity;
              return `• **${c.name}** (${dnRarityEmoji(rarity, settings, displayMap)} ${rarityLabel(rarity, settings, displayMap)})`;
            }).join("\n")}`
          : "",
        s.skipped.length ? `**Skipped ${s.skipped.length}**\n${s.skipped.map(l => `• ${l}`).join("\n")}` : "",
        left ? `**Stopped early** — ${left} tagged item${left === 1 ? "" : "s"} not created.` : "",
        s.created.length ? "\nEach card was opened in the edit panel along the way. `/edit_card` still works later." : "",
      ].filter(Boolean).join("\n\n").slice(0, 4000),
    );
  await interaction.editReply({ content: null, embeds: [embed], components: [] });
}

async function runCreate(
  interaction: ButtonInteraction,
  s: Session,
): Promise<void> {
  const items = await fetchMTTVItems();
  const tagged = s.tagged.filter(id => items.some(i => i.id === id));
  if (tagged.length === 0) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    await interaction.editReply(await previewPayload(s));
    return;
  }
  s.queue = tagged;
  s.created = [];
  s.skipped = [];
  touch(s);
  await presentNext(interaction, s);
}
