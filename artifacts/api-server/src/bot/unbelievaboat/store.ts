// UnbelievaBoat storefront — live UB store roles + local perk links.

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
  listRoleLinks,
  writeUbAudit,
} from "../../lib/unbelievaboat/db.js";
import { isUbConfigured, ubApi } from "../../lib/unbelievaboat/client.js";
import { UNBELIEVABOAT_AUTHOR, UNBELIEVABOAT_COLOR } from "./branding.js";
import {
  CashError, spendFunds, fmtCash, requireEconomy, formatSpendNote, getCashBalance,
} from "./cash.js";
import { replyThenPostAsUnbelievaBoat } from "./webhook.js";
import { isAnimatedStoreImage, resolveSelectEmoji, titleSafeStoreEmoji } from "./store-icons.js";
import {
  applyUbBuyActions,
  checkUbRequirements,
  type NormalizedUbItem,
} from "./ub-items.js";
import { syncUbStoreRoleLinks } from "./ub-sync.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

export function buildCashStoreCommandJson() {
  return new SlashCommandBuilder()
    .setName("cashstore")
    .setDescription("UnbelievaBoat store — buy roles with cash")
    .setDMPermission(false)
    .toJSON();
}

type StashRow = {
  key: string;
  source: "ub" | "local";
  name: string;
  description: string;
  price: number;
  emoji: string;
  roleIds: string[];
  imageUrl?: string;
  animated?: boolean;
  ubItem?: NormalizedUbItem;
  localLinkId?: number;
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

    const member = interaction.member as GuildMember | null;
    const ownedRoleIds = new Set(member?.roles?.cache?.keys?.() ?? []);
    const rows: StashRow[] = [];
    const seenRoles = new Set<string>();
    const seenUb = new Set<string>();

    // Live UnbelievaBoat store (role items) — flat list, no categories.
    if (isUbConfigured() && settings.enabled) {
      try {
        const synced = await syncUbStoreRoleLinks(
          interaction.guildId,
          settings.ubGuildId,
          interaction.guild,
        );
        for (const item of synced.items) {
          if (!item.listed) continue;
          // Prefer role-granting items; still show other listed goods cleanly.
          const roleIds = item.grantRoleIds;
          if (roleIds.length) {
            const key = roleIds.sort().join(",");
            if (seenRoles.has(key)) continue;
            seenRoles.add(key);
          }
          seenUb.add(item.id);
          const owned = roleIds.some(id => ownedRoleIds.has(id));
          rows.push({
            key: `ub:${item.id}`,
            source: "ub",
            name: item.name,
            description: owned
              ? "Already owned — use Collect for income"
              : item.description,
            price: item.price,
            emoji: item.emoji,
            roleIds,
            imageUrl: item.imageUrl,
            animated: item.animated,
            ubItem: item,
          });
        }
      } catch (err) {
        await interaction.editReply(
          `Couldn't load UnbelievaBoat store: ${err instanceof Error ? err.message : err}`,
        );
        return;
      }
    }

    // Local-only role links (not backed by a UB item we already listed).
    const links = await listRoleLinks(interaction.guildId);
    for (const r of links) {
      if (!r.enabled || !r.discordRoleId) continue;
      if (r.ubItemId && seenUb.has(r.ubItemId)) continue;
      if (seenRoles.has(r.discordRoleId)) continue;
      seenRoles.add(r.discordRoleId);
      const m = (r.meta ?? {}) as Record<string, unknown>;
      const imageUrl = typeof m.imageUrl === "string" ? m.imageUrl
        : typeof m.iconGif === "string" ? m.iconGif : undefined;
      const owned = ownedRoleIds.has(r.discordRoleId);
      rows.push({
        key: `role:${r.id}`,
        source: "local",
        name: r.name,
        description: owned
          ? "Already owned — use Collect for income"
          : (r.description || "Role perk"),
        price: r.price,
        emoji: r.emoji || "✨",
        roleIds: [r.discordRoleId],
        imageUrl,
        // Prefer persisted capture flag (Tenor/Giphy), else URL sniff.
        animated: m.animated === true || isAnimatedStoreImage(imageUrl),
        localLinkId: r.id,
      });
    }

    if (rows.length === 0) {
      await interaction.editReply(
        "No store roles yet. Admins add items in UnbelievaBoat’s store (or `/unbelievaboat` → Roles & economy).",
      );
      return;
    }

    const lines = rows.slice(0, 12).map(r => {
      const owned = r.roleIds.some(id => ownedRoleIds.has(id));
      return `${r.emoji} **${r.name}** — **${fmtCash(r.price)}** cash` +
        (r.imageUrl ? (r.animated ? " · 🎞️" : " · 🖼️") : "") +
        (owned ? " · ✅ **owned**" : "") +
        `\n_${r.description.slice(0, 120)}_`;
    }).join("\n\n");

    const embed = new EmbedBuilder()
      .setColor(UNBELIEVABOAT_COLOR)
      .setAuthor(UNBELIEVABOAT_AUTHOR)
      .setTitle("Role Store")
      .setDescription(
        [
          "UnbelievaBoat store roles — prices in **cash**. No categories, just the roles.",
          "Already own one? Use **`/casino` → Collect** for income.",
          "",
          lines,
          rows.length > 12 ? `\n_…and ${rows.length - 12} more in the menu._` : "",
        ].filter(Boolean).join("\n"),
      )
      .setFooter({ text: "Pick a role below · GIFs animate on the board" });

    const animated = rows.find(r => r.imageUrl && r.animated)?.imageUrl
      ?? rows.find(r => r.imageUrl && isAnimatedStoreImage(r.imageUrl))?.imageUrl;
    const firstImage = animated ?? rows.find(r => r.imageUrl)?.imageUrl;
    if (firstImage) {
      if (isAnimatedStoreImage(firstImage) || animated) embed.setImage(firstImage);
      else embed.setThumbnail(firstImage);
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId("unbstore:buy")
      .setPlaceholder("Choose a role to buy…")
      .addOptions(rows.slice(0, 25).map(r => {
        const emoji = resolveSelectEmoji(r.emoji);
        const owned = r.roleIds.some(id => ownedRoleIds.has(id));
        return {
          label: `${owned ? "✓ " : ""}${r.name}`.slice(0, 100),
          description: (owned
            ? "Already owned · Collect income"
            : `${r.price} cash · ${r.description}`
          ).slice(0, 100),
          value: r.key,
          ...(emoji ? { emoji } : {}),
        };
      }));

    stashStore(interaction.guildId, interaction.user.id, rows);

    await interaction.editReply({
      embeds: [embed],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    });
  } catch (err) {
    await interaction.editReply(err instanceof CashError ? err.message : `Failed: ${err instanceof Error ? err.message : err}`);
  }
}

export async function handleCashStoreSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: "Server only.", ...EPHEMERAL });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    const key = interaction.values[0]!;
    let rows = readStash(interaction.guildId, interaction.user.id);
    if (!rows) {
      // Rebuild stash by re-running store load logic lightly
      await handleCashStore(interaction as unknown as ChatInputCommandInteraction);
      rows = readStash(interaction.guildId, interaction.user.id);
    }
    const item = rows?.find(r => r.key === key) ?? null;
    if (!item) {
      await interaction.editReply("That item is gone — open `/casino store` again.");
      return;
    }
    await purchaseItem(interaction, item);
  } catch (err) {
    await interaction.editReply(err instanceof CashError ? err.message : `Failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function purchaseItem(interaction: StringSelectMenuInteraction, item: StashRow) {
  const guild = interaction.guild!;
  const member = interaction.member as GuildMember;
  const settings = await getOrCreateUbSettings(guild.id);

  const ownedAll = item.roleIds.length > 0 && item.roleIds.every(id => member.roles.cache.has(id));
  if (ownedAll) {
    const links = await listRoleLinks(guild.id);
    const incomes = item.roleIds.map(rid => links.find(l => l.discordRoleId === rid)?.incomeAmount ?? 0);
    const income = incomes.reduce((a, b) => a + (b > 0 ? b : 0), 0);
    await interaction.editReply(
      [
        `You already have ${item.emoji} **${item.name}**.`,
        income > 0
          ? `Claim **${fmtCash(income)}** income with **\`/casino\` → Collect** (or \`/collect_ub\`).`
          : "You own this role — ask an admin to **Sync UB** / **Seed collect** in `/unbelievaboat` → Roles & economy.",
        "_No cash was charged._",
      ].join("\n"),
    );
    return;
  }

  // UB store item — check real requirements, charge, apply actions.
  if (item.source === "ub" && item.ubItem) {
    if (!isUbConfigured() || !settings.enabled) {
      await interaction.editReply("UnbelievaBoat API link is off — flip it on in `/unbelievaboat`.");
      return;
    }
    const bal = await getCashBalance(guild.id, interaction.user.id);
    let invIds = new Set<string>();
    try {
      const inv = await ubApi.getInventory(settings.ubGuildId, interaction.user.id);
      invIds = new Set(inv.map(i => i.item_id));
    } catch { /* inventory optional for req check */ }

    const req = await checkUbRequirements(item.ubItem.requirements, member, bal, invIds);
    if (!req.ok) {
      await interaction.editReply(`Can't buy yet — ${req.reason}`);
      return;
    }

    const spent = await spendFunds(guild.id, interaction.user.id, item.price, `UB store: ${item.name}`);
    const notes = await applyUbBuyActions({
      ubGuildId: settings.ubGuildId,
      member,
      actions: item.ubItem.actions,
      spendAlreadyDone: true,
    });

    if (item.ubItem.raw.is_inventory !== false) {
      try {
        await ubApi.addInventoryItem(settings.ubGuildId, interaction.user.id, {
          item_id: item.ubItem.id,
          quantity: 1,
        });
      } catch { /* some items aren't inventory */ }
    }

    await writeUbAudit(guild.id, interaction.user.id, "ub_store_purchase", {
      itemId: item.ubItem.id, name: item.name, price: item.price, notes,
    });

    const purchaseEmbed = new EmbedBuilder()
      .setColor(UNBELIEVABOAT_COLOR)
      .setAuthor(UNBELIEVABOAT_AUTHOR)
      .setTitle(`${titleSafeStoreEmoji(item.emoji)} Purchased — ${item.name}`)
      .setDescription(
        [
          `${interaction.user} bought **${item.name}** for **${fmtCash(item.price)}** ${spent.balance.symbol}`,
          formatSpendNote(spent.fromCash, spent.fromBank, spent.balance.symbol),
          notes.length ? notes.map(n => `• ${n}`).join("\n") : null,
          item.ubItem.requirements.length
            ? `_Requirements were checked before purchase._`
            : null,
          `\nCash **${fmtCash(spent.balance.cash)}** · bank **${fmtCash(spent.balance.bank)}**`,
          (item.ubItem.actions.some(a => a.type === 2)
            ? "\nClaim income later with **`/casino` → Collect**."
            : ""),
        ].filter(Boolean).join("\n"),
      );
    if (item.imageUrl) {
      if (item.animated || isAnimatedStoreImage(item.imageUrl)) purchaseEmbed.setImage(item.imageUrl);
      else purchaseEmbed.setThumbnail(item.imageUrl);
    }

    await replyThenPostAsUnbelievaBoat(
      interaction as unknown as ChatInputCommandInteraction,
      { embeds: [purchaseEmbed] },
      `✅ You bought **${item.name}** — receipt posted as **UnbelievaBoat**.`,
    );
    return;
  }

  // Local role link purchase
  const roleId = item.roleIds[0];
  if (!roleId) {
    await interaction.editReply("That perk has no role linked.");
    return;
  }
  const role = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId).catch(() => null);
  if (!role) {
    await interaction.editReply("That role no longer exists — ask an admin to fix the store link.");
    return;
  }

  const spent = await spendFunds(guild.id, interaction.user.id, item.price, `Perk store: ${item.name}`);
  try {
    await member.roles.add(role, `UnbelievaBoat perk store: ${item.name}`);
  } catch {
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
    .setTitle(`${titleSafeStoreEmoji(item.emoji)} Purchased — ${item.name}`)
    .setDescription(
      [
        `${interaction.user} bought **${item.name}** for **${fmtCash(item.price)}** ${spent.balance.symbol}`,
        formatSpendNote(spent.fromCash, spent.fromBank, spent.balance.symbol),
        `Role granted: ${role}`,
        `\nCash **${fmtCash(spent.balance.cash)}** · bank **${fmtCash(spent.balance.bank)}**`,
        "\nClaim income with **`/casino` → Collect**.",
      ].join("\n"),
    );
  if (item.imageUrl) {
    if (item.animated || isAnimatedStoreImage(item.imageUrl)) purchaseEmbed.setImage(item.imageUrl);
    else purchaseEmbed.setThumbnail(item.imageUrl);
  }

  await replyThenPostAsUnbelievaBoat(
    interaction as unknown as ChatInputCommandInteraction,
    { embeds: [purchaseEmbed] },
    `✅ You bought **${item.name}** — receipt posted as **UnbelievaBoat**.`,
  );
}
