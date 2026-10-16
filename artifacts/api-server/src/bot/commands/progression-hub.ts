// /progression — one admin hub for acquisition Star/Level.
// Shows which area (spawn / pack / drop / all) is in control, then the
// per-card overrides that beat those defaults.

import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags,
  ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
  type ButtonInteraction, type ChatInputCommandInteraction,
  type ModalSubmitInteraction, type StringSelectMenuInteraction, type GuildMember,
} from "discord.js";
import { isAdmin, getAllCards } from "../db.js";
import {
  getGuildAcquisitionConfigs, setGuildAcquisitionConfig,
  getCardAcquisitionOverrides, setCardAcquisitionOverride, deleteCardAcquisitionOverride,
} from "../cards/progression.js";
import type { AcquisitionSource } from "@workspace/db";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;
const SOURCES: Array<{ id: AcquisitionSource | "*"; label: string; area: string }> = [
  { id: "*", label: "All sources", area: "Spawn, pack, and admin drop — unless a row below is more specific" },
  { id: "spawn", label: "Spawn", area: "Random wild cards in the spawn channel" },
  { id: "pack", label: "Pack", area: "Cards pulled from `/pack`" },
  { id: "drop", label: "Drop", area: "Admin `/drop` and `/mass_drop` (when star/level are not set on the slash)" },
];

function fmtRange(row: { enabled: boolean; starMin: number; starMax: number; levelMin: number; levelMax: number } | undefined): string {
  if (!row) return "Baseline **0★ / Lv 1** (nothing set)";
  if (!row.enabled) return "Off — cards arrive **0★ / Lv 1**";
  const stars = row.starMin === row.starMax ? `${row.starMin}★` : `${row.starMin}–${row.starMax}★`;
  const levels = row.levelMin === row.levelMax ? `Lv ${row.levelMin}` : `Lv ${row.levelMin}–${row.levelMax}`;
  return `On — **${stars}** · **${levels}**`;
}

async function memberIsAdmin(interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction): Promise<boolean> {
  if (!interaction.guild) return false;
  if (interaction.guild.ownerId === interaction.user.id) return true;
  const member = interaction.member as GuildMember | null;
  if (member?.permissions?.has("Administrator")) return true;
  return isAdmin(interaction.guild.id, interaction.user.id);
}

async function buildPayload(guildId: string) {
  const [configs, overrides, cards] = await Promise.all([
    getGuildAcquisitionConfigs(guildId),
    getCardAcquisitionOverrides(guildId),
    getAllCards(guildId),
  ]);
  const byName = new Map(cards.map(c => [c.id, c.name]));
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("⚡ Arrival progression")
    .setDescription(
      "This hub controls the **Star Rank** and **Level** a card arrives with when it is caught, pulled, or dropped.\n" +
      "More specific rows win: **card override** → **source default** → **all sources** → baseline 0★ / Lv 1.",
    );

  for (const src of SOURCES) {
    const row = configs.find(c => c.source === src.id);
    embed.addFields({
      name: `${src.label} — ${src.area}`,
      value: fmtRange(row),
      inline: false,
    });
  }

  if (overrides.length === 0) {
    embed.addFields({ name: "Card overrides", value: "_None. These beat the source defaults for one card._" });
  } else {
    const lines = overrides.slice(0, 15).map(o => {
      const name = byName.get(o.cardId) ?? `card #${o.cardId}`;
      const src = o.source === "*" ? "all sources" : o.source;
      return `• **${name}** (${src}) — ${fmtRange(o)}`;
    });
    if (overrides.length > 15) lines.push(`_…and ${overrides.length - 15} more._`);
    embed.addFields({ name: `Card overrides (${overrides.length})`, value: lines.join("\n").slice(0, 1024) });
  }

  const setRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("progresshub:set:*").setLabel("Set all sources").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("progresshub:set:spawn").setLabel("Set spawn").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("progresshub:set:pack").setLabel("Set pack").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("progresshub:set:drop").setLabel("Set drop").setStyle(ButtonStyle.Secondary),
  );
  const cardRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("progresshub:addcard").setLabel("Add card override").setEmoji("➕").setStyle(ButtonStyle.Success),
  );
  const components: ActionRowBuilder<any>[] = [setRow, cardRow];
  if (overrides.length > 0) {
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("progresshub:clear")
        .setPlaceholder("Clear a card override…")
        .addOptions(overrides.slice(0, 25).map(o => ({
          label: `${byName.get(o.cardId) ?? `#${o.cardId}`} (${o.source === "*" ? "all" : o.source})`.slice(0, 100),
          value: `${o.cardId}:${o.source}`,
        }))),
    ));
  }
  return { embeds: [embed], components };
}

export async function handleProgressionHubCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) return;
  if (!(await memberIsAdmin(interaction))) {
    await interaction.reply({ content: "❌ Admins only.", ...EPHEMERAL });
    return;
  }
  await interaction.reply({ ...(await buildPayload(interaction.guild.id)), ...EPHEMERAL });
}

function sourceModal(source: string, title: string) {
  return new ModalBuilder()
    .setCustomId(`progresshub:modal:set:${source}`)
    .setTitle(title.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("enabled").setLabel("On or off? (on / off)").setStyle(TextInputStyle.Short).setRequired(true).setValue("on").setMaxLength(3),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("stars").setLabel("Star range (0-5), e.g. 0-2 or 3").setStyle(TextInputStyle.Short).setRequired(true).setValue("0").setMaxLength(7),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("levels").setLabel("Level range (1-100), e.g. 1-10 or 50").setStyle(TextInputStyle.Short).setRequired(true).setValue("1").setMaxLength(9),
      ),
    );
}

function parseRange(raw: string, floor: number, ceil: number): [number, number] | null {
  const m = raw.trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] != null ? Number(m[2]) : a;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return [Math.max(floor, Math.min(ceil, a)), Math.max(floor, Math.min(ceil, b))];
}

export async function handleProgressionHubButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) return;
  const parts = interaction.customId.split(":");
  const action = parts[1];
  if (!(await memberIsAdmin(interaction))) {
    await interaction.reply({ content: "❌ Admins only.", ...EPHEMERAL });
    return;
  }
  if (action === "set") {
    const source = parts[2] ?? "*";
    const label = SOURCES.find(s => s.id === source)?.label ?? source;
    await interaction.showModal(sourceModal(source, `Set ${label}`));
    return;
  }
  if (action === "addcard") {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId("progresshub:modal:addcard")
        .setTitle("Card override")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId("name").setLabel("Card name").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId("source").setLabel("Area: all, spawn, pack, or drop").setStyle(TextInputStyle.Short).setRequired(true).setValue("all").setMaxLength(8),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId("enabled").setLabel("On or off? (on / off)").setStyle(TextInputStyle.Short).setRequired(true).setValue("on").setMaxLength(3),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId("stars").setLabel("Star range (0-5)").setStyle(TextInputStyle.Short).setRequired(true).setValue("0").setMaxLength(7),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId("levels").setLabel("Level range (1-100)").setStyle(TextInputStyle.Short).setRequired(true).setValue("1").setMaxLength(9),
          ),
        ),
    );
  }
}

export async function handleProgressionHubSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.guild) return;
  if (!(await memberIsAdmin(interaction))) {
    await interaction.reply({ content: "❌ Admins only.", ...EPHEMERAL });
    return;
  }
  const [cardIdRaw, source] = (interaction.values[0] ?? "").split(":");
  const cardId = Number(cardIdRaw);
  if (!Number.isInteger(cardId) || !source) {
    await interaction.deferUpdate();
    return;
  }
  await deleteCardAcquisitionOverride(interaction.guild.id, cardId, source as AcquisitionSource | "*");
  await interaction.update(await buildPayload(interaction.guild.id));
}

export async function handleProgressionHubModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.guild) return;
  if (!(await memberIsAdmin(interaction))) {
    await interaction.reply({ content: "❌ Admins only.", ...EPHEMERAL });
    return;
  }
  await interaction.deferUpdate();
  const parts = interaction.customId.split(":"); // progresshub:modal:set:spawn | progresshub:modal:addcard
  const kind = parts[2];
  const enabledRaw = interaction.fields.getTextInputValue("enabled").trim().toLowerCase();
  const enabled = enabledRaw === "on" || enabledRaw === "true" || enabledRaw === "yes" || enabledRaw === "1";
  const stars = parseRange(interaction.fields.getTextInputValue("stars"), 0, 5);
  const levels = parseRange(interaction.fields.getTextInputValue("levels"), 1, 100);
  if (!stars || !levels) {
    await interaction.followUp({ content: "❌ Use ranges like `0-2` for stars and `1-10` for levels.", ...EPHEMERAL });
    return;
  }
  const range = { enabled, starMin: stars[0], starMax: stars[1], levelMin: levels[0], levelMax: levels[1] };
  const guildId = interaction.guild.id;

  if (kind === "set") {
    const source = (parts[3] ?? "*") as AcquisitionSource | "*";
    await setGuildAcquisitionConfig(guildId, source, range, interaction.user.id);
  } else if (kind === "addcard") {
    const name = interaction.fields.getTextInputValue("name").trim();
    const sourceRaw = interaction.fields.getTextInputValue("source").trim().toLowerCase();
    const source = (sourceRaw === "all" || sourceRaw === "*" ? "*" : sourceRaw) as AcquisitionSource | "*";
    if (source !== "*" && source !== "spawn" && source !== "pack" && source !== "drop") {
      await interaction.followUp({ content: "❌ Area must be all, spawn, pack, or drop.", ...EPHEMERAL });
      return;
    }
    const cards = await getAllCards(guildId);
    const card = cards.find(c => c.name.toLowerCase() === name.toLowerCase());
    if (!card) {
      await interaction.followUp({ content: `❌ No card named **${name}**.`, ...EPHEMERAL });
      return;
    }
    await setCardAcquisitionOverride(guildId, card.id, source, range, interaction.user.id);
  }
  await interaction.editReply(await buildPayload(guildId));
}
