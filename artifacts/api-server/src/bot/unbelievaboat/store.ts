// UnbelievaBoat role perk storefront — Discord-side economy store (our addon).

import type {
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
  GuildMember,
} from "discord.js";
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
} from "discord.js";
import {
  getOrCreateUbSettings,
  listCatalog,
  listRoleLinks,
  writeUbAudit,
} from "../../lib/unbelievaboat/db.js";
import { UNBELIEVABOAT_AUTHOR, UNBELIEVABOAT_COLOR } from "./branding.js";
import {
  CashError, spendFunds, fmtCash, requireEconomy, formatSpendNote,
} from "./cash.js";
import { replyThenPostAsUnbelievaBoat } from "./webhook.js";
import { resolveSelectEmoji } from "./store-icons.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

export type StoreMeta = {
  imageUrl?: string;
  purchaseMessage?: string;
  iconGif?: string;
};

export function buildCashStoreCommandJson() {
  return new SlashCommandBuilder()
    .setName("cashstore")
    .setDescription("UnbelievaBoat perk store — buy admin-linked roles with cash")
    .setDMPermission(false)
    .toJSON();
}

function metaOf(raw: Record<string, unknown> | null | undefined): StoreMeta {
  if (!raw) return {};
  return {
    imageUrl: typeof raw.imageUrl === "string" ? raw.imageUrl : undefined,
    purchaseMessage: typeof raw.purchaseMessage === "string" ? raw.purchaseMessage : undefined,
    iconGif: typeof raw.iconGif === "string" ? raw.iconGif : undefined,
  };
}

export async function handleCashStore(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: "Server only.", ...EPHEMERAL });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    const settings = await getOrCreateUbSettings(interaction.guildId);
    if (!settings.storeEnabled) {
      await interaction.editReply("The UnbelievaBoat perk store is disabled on this server.");
      return;
    }
    await requireEconomy(interaction.guildId);

    const [catalog, roles] = await Promise.all([
      listCatalog(interaction.guildId),
      listRoleLinks(interaction.guildId),
    ]);

    // Role-linked goods: enabled role links + catalog rows with grantRoleId (non-pet).
    const roleItems = roles.filter(r => r.enabled && r.discordRoleId && r.price >= 0);
    const catalogItems = catalog.filter(c => c.listed && !c.forPets && c.grantRoleId);

    type Row = {
      key: string;
      name: string;
      description: string;
      price: number;
      emoji: string;
      roleId: string;
      imageUrl?: string;
      purchaseMessage?: string;
    };

    const rows: Row[] = [];
    for (const r of roleItems) {
      const m = metaOf(r.meta as Record<string, unknown>);
      rows.push({
        key: `role:${r.id}`,
        name: r.name,
        description: r.description || "Role perk",
        price: r.price,
        emoji: r.emoji || "✨",
        roleId: r.discordRoleId!,
        imageUrl: m.imageUrl || m.iconGif,
        purchaseMessage: m.purchaseMessage,
      });
    }
    for (const c of catalogItems) {
      const m = metaOf(c.meta as Record<string, unknown>);
      rows.push({
        key: `cat:${c.id}`,
        name: c.name,
        description: c.description || "Store perk",
        price: c.price,
        emoji: c.emoji || "🛒",
        roleId: c.grantRoleId!,
        imageUrl: m.imageUrl || m.iconGif,
        purchaseMessage: m.purchaseMessage,
      });
    }

    if (rows.length === 0) {
      await interaction.editReply(
        "No perk items yet. Admins add role links / catalog goods in `/unbelievaboat` → Store.",
      );
      return;
    }

    const lines = rows.slice(0, 12).map(r =>
      `${r.emoji} **${r.name}** — **${fmtCash(r.price)}** cash` +
      (r.imageUrl ? " · 🖼️" : "") +
      `\n_${r.description.slice(0, 120)}_`,
    ).join("\n\n");

    const embed = new EmbedBuilder()
      .setColor(UNBELIEVABOAT_COLOR)
      .setAuthor(UNBELIEVABOAT_AUTHOR)
      .setTitle("Perk Store")
      .setDescription(
        [
          "Buy roles your admins linked — settled in **UnbelievaBoat** cash.",
          "Stacks with UnbelievaBoat’s own store; this is our Discord storefront.",
          "",
          lines,
        ].join("\n"),
      )
      .setFooter({ text: "Pick an item below · posted publicly as UnbelievaBoat when you buy" });

    const firstImage = rows.find(r => r.imageUrl)?.imageUrl;
    if (firstImage) embed.setThumbnail(firstImage);

    const menu = new StringSelectMenuBuilder()
      .setCustomId("unbstore:buy")
      .setPlaceholder("Choose a perk to buy…")
      .addOptions(rows.slice(0, 25).map(r => {
        const emoji = resolveSelectEmoji(r.emoji);
        return {
          label: `${r.name}`.slice(0, 100),
          description: `${r.price} cash · ${r.description}`.slice(0, 100),
          value: r.key,
          ...(emoji ? { emoji } : {}),
        };
      }));

    // Stash row payload on a short-lived map keyed by interaction user
    stashStore(interaction.guildId, interaction.user.id, rows);

    await interaction.editReply({
      embeds: [embed],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    });
  } catch (err) {
    await interaction.editReply(err instanceof CashError ? err.message : `Failed: ${err instanceof Error ? err.message : err}`);
  }
}

type StashRow = {
  key: string;
  name: string;
  description: string;
  price: number;
  emoji: string;
  roleId: string;
  imageUrl?: string;
  purchaseMessage?: string;
};

const storeStash = new Map<string, { at: number; rows: StashRow[] }>();
function stashKey(guildId: string, userId: string) { return `${guildId}:${userId}`; }
function stashStore(guildId: string, userId: string, rows: StashRow[]) {
  storeStash.set(stashKey(guildId, userId), { at: Date.now(), rows });
}
function readStash(guildId: string, userId: string): StashRow[] | null {
  const hit = storeStash.get(stashKey(guildId, userId));
  if (!hit || Date.now() - hit.at > 10 * 60_000) return null;
  return hit.rows;
}

export async function handleCashStoreSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: "Server only.", ...EPHEMERAL });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    const key = interaction.values[0]!;
    const rows = readStash(interaction.guildId, interaction.user.id);
    let item = rows?.find(r => r.key === key) ?? null;

    // Rebuild from DB if stash expired
    if (!item) {
      await handleCashStoreRebuildFind(interaction, key);
      return;
    }

    await purchaseItem(interaction, item);
  } catch (err) {
    await interaction.editReply(err instanceof CashError ? err.message : `Failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function handleCashStoreRebuildFind(interaction: StringSelectMenuInteraction, key: string) {
  const guildId = interaction.guildId!;
  const [catalog, roles] = await Promise.all([listCatalog(guildId), listRoleLinks(guildId)]);
  let item: StashRow | null = null;
  if (key.startsWith("role:")) {
    const id = Number(key.slice(5));
    const r = roles.find(x => x.id === id);
    if (r?.discordRoleId) {
      const m = metaOf(r.meta as Record<string, unknown>);
      item = {
        key, name: r.name, description: r.description || "Role perk", price: r.price,
        emoji: r.emoji || "✨", roleId: r.discordRoleId,
        imageUrl: m.imageUrl || m.iconGif, purchaseMessage: m.purchaseMessage,
      };
    }
  } else if (key.startsWith("cat:")) {
    const id = Number(key.slice(4));
    const c = catalog.find(x => x.id === id);
    if (c?.grantRoleId) {
      const m = metaOf(c.meta as Record<string, unknown>);
      item = {
        key, name: c.name, description: c.description || "Store perk", price: c.price,
        emoji: c.emoji || "🛒", roleId: c.grantRoleId,
        imageUrl: m.imageUrl || m.iconGif, purchaseMessage: m.purchaseMessage,
      };
    }
  }
  if (!item) {
    await interaction.editReply("That item is gone — open `/casino store` again.");
    return;
  }
  await purchaseItem(interaction, item);
}

async function purchaseItem(interaction: StringSelectMenuInteraction, item: StashRow) {
  const guild = interaction.guild!;
  const member = interaction.member as GuildMember;
  const role = guild.roles.cache.get(item.roleId) ?? await guild.roles.fetch(item.roleId).catch(() => null);
  if (!role) {
    await interaction.editReply("That role no longer exists — ask an admin to fix the store link.");
    return;
  }
  if (member.roles.cache.has(role.id)) {
    await interaction.editReply(`You already have **${role.name}**.`);
    return;
  }

  const spent = await spendFunds(guild.id, interaction.user.id, item.price, `Perk store: ${item.name}`);
  const bal = spent.balance;
  try {
    await member.roles.add(role, `UnbelievaBoat perk store: ${item.name}`);
  } catch {
    // Refund on role failure
    const { earnCash } = await import("./cash.js");
    await earnCash(guild.id, interaction.user.id, item.price, `Refund perk store: ${item.name}`);
    await interaction.editReply("Couldn't grant the role (check bot role position). Cash refunded.");
    return;
  }

  await writeUbAudit(guild.id, interaction.user.id, "store_purchase", {
    item: item.name, price: item.price, roleId: role.id,
    fromCash: spent.fromCash, fromBank: spent.fromBank,
  });

  const purchaseEmbed = new EmbedBuilder()
    .setColor(UNBELIEVABOAT_COLOR)
    .setAuthor(UNBELIEVABOAT_AUTHOR)
    .setTitle(`${item.emoji} Purchased — ${item.name}`)
    .setDescription(
      [
        `${interaction.user} bought **${item.name}** for **${fmtCash(item.price)}** ${bal.symbol}`,
        formatSpendNote(spent.fromCash, spent.fromBank, bal.symbol),
        `Role granted: ${role}`,
        item.purchaseMessage ? `\n${item.purchaseMessage}` : null,
        `\nCash **${fmtCash(bal.cash)}** · bank **${fmtCash(bal.bank)}** ${bal.symbol}`,
      ].filter(Boolean).join("\n"),
    );
  if (item.imageUrl) purchaseEmbed.setImage(item.imageUrl);

  await replyThenPostAsUnbelievaBoat(
    interaction as unknown as ChatInputCommandInteraction,
    { embeds: [purchaseEmbed] },
    `✅ You bought **${item.name}** — receipt posted as **UnbelievaBoat**.`,
  );
}
