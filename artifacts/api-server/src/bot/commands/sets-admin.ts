import type { ChatInputCommandInteraction, GuildMember } from "discord.js";
import { AttachmentBuilder, MessageFlags, EmbedBuilder, ChannelType } from "discord.js";
import {
  isAdmin, invalidateActiveSetCardsCache,
  createSet, renameSet, deleteSetById, deleteSetByName, deleteAllSets,
  addCardToSet, removeCardFromSet, moveCardBetweenSets,
  bulkAddCardsToSet, bulkRemoveCardsFromSet,
  getSetByName, getCardsInSet, getCardByName,
  setActiveSet, clearActiveSet, getActiveSet,
  setActiveSetSecondary, clearActiveSetSecondary,
  listSets, listSetsV2,
  patchSetRarityWeight, setSetRarityWeights,
  setSetAwardsCompletion,
  getUnassignedCards,
  getAllCards,
  loadDefaultCards, unloadDefaultCards, DEFAULTS_SET_NAME,
  getDisplayRarities, getRarityContext, effectiveRarityKey,
  updateGuildSettings,
} from "../db.js";
import { importCardsFromJson } from "./import.js";
import { logger } from "../../lib/logger.js";
import { db, cardsTable, cardSetMembershipsTable } from "@workspace/db";
import { eq, inArray, and } from "drizzle-orm";
import type { Card, CardSet } from "@workspace/db";
import { RARITY_EMOJI, type Rarity, rarityLabel, rarityEmoji } from "../cards-data.js";
import { getRarityDisplayOverrides } from "../db.js";

async function checkAdmin(interaction: ChatInputCommandInteraction): Promise<boolean> {
  if (!interaction.guild) return false;
  if (interaction.guild.ownerId === interaction.user.id) return true;
  const member = interaction.member as GuildMember | null;
  if (member?.permissions.has("Administrator")) return true;
  return isAdmin(interaction.guild.id, interaction.user.id);
}

// Split a comma/newline/space-separated list into trimmed card-name candidates.
function parseList(raw: string): string[] {
  return raw.split(/[,\n]+/).map(s => s.trim()).filter(s => s.length > 0);
}

export async function handleSetAdminCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  // The /set_admin defer happens up the stack in admin.ts. Here we just route.
  if (!interaction.guild) return;
  if (!(await checkAdmin(interaction))) {
    await interaction.editReply("❌ Admins only.");
    return;
  }
  const guildId = interaction.guild.id;
  const sub = interaction.options.getSubcommand(true);


  // ── create ───────────────────────────────────────────────────────────────
  if (sub === "create") {
    const name = interaction.options.getString("name", true);
    const description = interaction.options.getString("description") ?? undefined;
    try {
      const existing = await getSetByName(name, guildId);
      if (existing) {
        await interaction.editReply(`⚠️ Set \`${existing.name}\` already exists.`);
        return;
      }
      const set = await createSet(name, description, guildId);
      await interaction.editReply(
        `✅ Created set \`${set.name}\`. Add cards with \`/set_admin add set:${set.name} card:<Name>\` or activate it for spawns with \`/set_admin active set:${set.name}\`.`,
      );
    } catch (err: any) {
      await interaction.editReply(`❌ ${err?.message ?? "Failed to create set."}`);
    }
    return;
  }

  // ── rename ───────────────────────────────────────────────────────────────
  if (sub === "rename") {
    const fromName = interaction.options.getString("from", true);
    const toName = interaction.options.getString("to", true);
    const set = await getSetByName(fromName, guildId);
    if (!set) { await interaction.editReply(`❌ No set named \`${fromName}\`.`); return; }
    try {
      const updated = await renameSet(set.id, toName, guildId);
      await interaction.editReply(`✅ Renamed \`${set.name}\` → \`${updated?.name}\`.`);
    } catch (err: any) {
      await interaction.editReply(`❌ ${err?.message ?? "Rename failed."}`);
    }
    return;
  }

  // ── delete ───────────────────────────────────────────────────────────────
  if (sub === "delete") {
    const name = interaction.options.getString("name", true);
    const set = await getSetByName(name, guildId);
    if (!set) { await interaction.editReply(`❌ No set named \`${name}\`.`); return; }
    const { removedMemberships } = await deleteSetById(set.id, guildId);
    await interaction.editReply(
      `✅ Deleted set \`${set.name}\` — kept all cards intact, removed **${removedMemberships}** membership${removedMemberships === 1 ? "" : "s"}. ` +
      `To delete cards too, use \`!removecard <Name>\` per card.`,
    );
    return;
  }

  // ── deleteall ──────────────────────────────────────────────────────────────
  // Non-destructive: removes every set (and its memberships) in this server.
  // Cards themselves are left untouched so they can be re-added to new sets.
  if (sub === "deleteall") {
    const { deletedSets, removedMemberships } = await deleteAllSets(guildId);
    if (deletedSets === 0) {
      await interaction.editReply("📭 No sets to delete in this server.");
      return;
    }
    await interaction.editReply(
      `✅ Deleted **${deletedSets}** set${deletedSets === 1 ? "" : "s"} — kept all cards intact, removed **${removedMemberships}** membership${removedMemberships === 1 ? "" : "s"}. ` +
      `To delete the cards too, use \`/setadmin exportcards\` to back them up, then \`!removecard <Name>\` per card.`,
    );
    return;
  }

  // ── add ──────────────────────────────────────────────────────────────────
  if (sub === "add") {
    const setName = interaction.options.getString("set", true);
    const cardName = interaction.options.getString("card", true);
    const set = await getSetByName(setName, guildId);
    if (!set) { await interaction.editReply(`❌ No set named \`${setName}\`.`); return; }
    const card = await getCardByName(cardName, guildId);
    if (!card) { await interaction.editReply(`❌ No card named **${cardName}**.`); return; }
    const { added } = await addCardToSet(set.id, card.id, guildId);
    await interaction.editReply(
      added
        ? `✅ Added **${card.name}** to \`${set.name}\`.`
        : `⚠️ **${card.name}** is already in \`${set.name}\`.`,
    );
    return;
  }

  // ── remove ───────────────────────────────────────────────────────────────
  if (sub === "remove") {
    const setName = interaction.options.getString("set", true);
    const cardName = interaction.options.getString("card", true);
    const set = await getSetByName(setName, guildId);
    if (!set) { await interaction.editReply(`❌ No set named \`${setName}\`.`); return; }
    const card = await getCardByName(cardName, guildId);
    if (!card) { await interaction.editReply(`❌ No card named **${cardName}**.`); return; }
    const { removed } = await removeCardFromSet(set.id, card.id, guildId);
    await interaction.editReply(
      removed
        ? `✅ Removed **${card.name}** from \`${set.name}\`. Card itself is untouched.`
        : `⚠️ **${card.name}** wasn't in \`${set.name}\`.`,
    );
    return;
  }

  // ── move ─────────────────────────────────────────────────────────────────
  if (sub === "move") {
    const fromName = interaction.options.getString("from", true);
    const toName = interaction.options.getString("to", true);
    const cardName = interaction.options.getString("card", true);
    const fromSet = await getSetByName(fromName, guildId);
    const toSet = await getSetByName(toName, guildId);
    if (!fromSet) { await interaction.editReply(`❌ No set named \`${fromName}\`.`); return; }
    if (!toSet) { await interaction.editReply(`❌ No set named \`${toName}\`.`); return; }
    const card = await getCardByName(cardName, guildId);
    if (!card) { await interaction.editReply(`❌ No card named **${cardName}**.`); return; }
    await moveCardBetweenSets(fromSet.id, toSet.id, card.id, guildId);
    await interaction.editReply(`✅ Moved **${card.name}** from \`${fromSet.name}\` → \`${toSet.name}\`.`);
    return;
  }

  // ── bulkadd ──────────────────────────────────────────────────────────────
  if (sub === "bulkadd") {
    const setName = interaction.options.getString("set", true);
    const cardsRaw = interaction.options.getString("cards", true);
    const set = await getSetByName(setName, guildId);
    if (!set) { await interaction.editReply(`❌ No set named \`${setName}\`.`); return; }
    const names = parseList(cardsRaw);
    if (names.length === 0) { await interaction.editReply("❌ Provide a comma-separated list of card names."); return; }
    const { added, alreadyIn, notFound } = await bulkAddCardsToSet(set.id, names, guildId);
    await interaction.editReply(
      `✅ Bulk add → \`${set.name}\`\n` +
      `➕ Added: **${added}**\n` +
      `⏭️ Already in set: **${alreadyIn}**` +
      (notFound.length > 0 ? `\n❓ Not found: ${notFound.slice(0, 10).map(n => `\`${n}\``).join(", ")}${notFound.length > 10 ? ` (+${notFound.length - 10} more)` : ""}` : ""),
    );
    return;
  }

  // ── bulkremove ───────────────────────────────────────────────────────────
  if (sub === "bulkremove") {
    const setName = interaction.options.getString("set", true);
    const cardsRaw = interaction.options.getString("cards", true);
    const set = await getSetByName(setName, guildId);
    if (!set) { await interaction.editReply(`❌ No set named \`${setName}\`.`); return; }
    const names = parseList(cardsRaw);
    if (names.length === 0) { await interaction.editReply("❌ Provide a comma-separated list of card names."); return; }
    const { removed, notInSet, notFound } = await bulkRemoveCardsFromSet(set.id, names, guildId);
    await interaction.editReply(
      `✅ Bulk remove from \`${set.name}\`\n` +
      `➖ Removed: **${removed}**\n` +
      `⏭️ Wasn't in set: **${notInSet}**` +
      (notFound.length > 0 ? `\n❓ Not found: ${notFound.slice(0, 10).map(n => `\`${n}\``).join(", ")}${notFound.length > 10 ? ` (+${notFound.length - 10} more)` : ""}` : ""),
    );
    return;
  }

  // ── active ───────────────────────────────────────────────────────────────
  if (sub === "active") {
    const setName = interaction.options.getString("set", true);
    const isSecondary = interaction.options.getBoolean("secondary") ?? false;
    const set = await getSetByName(setName, guildId);
    if (!set) { await interaction.editReply(`❌ No set named \`${setName}\`.`); return; }
    const memberCount = (await getCardsInSet(set.id)).filter(c => c.droppable && !c.isArchived).length;
    await setActiveSet(guildId, set.id);
    await interaction.editReply(
      `✅ Active set for this server → \`${set.name}\` (**${memberCount}** droppable cards).\n` +
      (memberCount === 0
        ? `⚠️ This set has no droppable cards, so random spawns still won't fire. Add cards with \`/set_admin add\`.`
        : `Random spawns now pull exclusively from this set.`),
    );
    return;
  }

  // ── deactivate ───────────────────────────────────────────────────────────
  if (sub === "deactivate") {
    await clearActiveSet(guildId);
    await interaction.editReply(
      `✅ Cleared active set. **Random spawns are now disabled** until you pick a new one with \`/set_admin active\`. Admin \`/drop name:<Card>\` still works.`,
    );
    return;
  }

  // ── view ─────────────────────────────────────────────────────────────────
  if (sub === "view") {
    const setName = interaction.options.getString("name", true);
    const set = await getSetByName(setName, guildId);
    if (!set) { await interaction.editReply(`❌ No set named \`${setName}\`.`); return; }
    const cards = await getCardsInSet(set.id, guildId);
    const active = await getActiveSet(guildId);
    const isActive = active?.id === set.id;
    const sets = await listSetsV2(guildId);
    const setRow = sets.find(s => s.set.id === set.id);
    const total = setRow?.cardCount ?? cards.length;
    const droppable = cards.filter(c => c.droppable && !c.isArchived).length;
    const [displayMap, ctx] = await Promise.all([getRarityDisplayOverrides(guildId), getRarityContext(guildId)]);
    const ladder = getDisplayRarities(ctx, null, { displayMap });
    const grouped = new Map<string, string[]>();
    for (const tier of ladder) grouped.set(tier.key, []);
    for (const c of cards) {
      const key = effectiveRarityKey(c, ctx);
      (grouped.get(key) ?? grouped.set(key, []).get(key)!).push(c.name);
    }
    const fields = ladder
      .filter(tier => (grouped.get(tier.key)?.length ?? 0) > 0)
      .map(tier => {
        const list = grouped.get(tier.key)!.sort();
        const value = list.slice(0, 30).join(", ") + (list.length > 30 ? ` (+${list.length - 30} more)` : "");
        return { name: `${tier.emoji} ${tier.label} (${list.length})`, value: value.slice(0, 1024) };
      });
    const embed = new EmbedBuilder()
      .setTitle(`📦 Set: ${set.name}${isActive ? "  ✦ active" : ""}`)
      .setColor(isActive ? 0x57f287 : 0x5865f2)
      .setDescription(
        (set.description ? `${set.description}\n\n` : "") +
        `**${total}** cards · **${droppable}** droppable`,
      )
      .addFields(fields.length > 0 ? fields : [{ name: "Empty", value: "No cards yet — use `/set_admin add` or `/set_admin bulkadd`." }]);
    // Append a weights footer if any are configured.
    if (set.rarityWeights && Object.keys(set.rarityWeights).length > 0) {
      const w = set.rarityWeights;
      const order: Rarity[] = ["common", "uncommon", "rare", "epic", "legendary", "mythic"];
      const line = order
        .filter(r => w[r] != null)
        .map(r => `${rarityEmoji(r, null, displayMap)} ${rarityLabel(r, null, displayMap)} **${w[r]}**`)
        .join(" · ");
      embed.addFields({ name: "⚖️ Active-set weight overrides", value: line || "—" });
    }
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── setweight ────────────────────────────────────────────────────────────
  if (sub === "setweight") {
    const setName = interaction.options.getString("set", true);
    const rarity = interaction.options.getString("rarity", true);
    const weight = interaction.options.getInteger("weight", true);
    const set = await getSetByName(setName, guildId);
    if (!set) { await interaction.editReply(`❌ No set named \`${setName}\`.`); return; }
    const updated = await patchSetRarityWeight(set.id, rarity, weight, guildId);
    const active = await getActiveSet(guildId);
    const isActive = active?.id === set.id;
    const zeroNote = weight === 0
      ? `\n⚠️ Weight **0** means **${rarity}** cards in this set will *never* spawn while \`${set.name}\` is active.`
      : "";
    const liveNote = isActive
      ? "\n⚖️ This set is active — the new weight is live."
      : `\n💡 Activate this set with \`/set_admin active set:${set.name}\` for the override to take effect.`;
    const displayMap2 = await getRarityDisplayOverrides(guildId);
    const rLabel = rarityLabel(rarity as Rarity, null, displayMap2);
    const rEmoji = rarityEmoji(rarity as Rarity, null, displayMap2);
    await interaction.editReply(
      `✅ \`${set.name}\` · ${rEmoji} **${rLabel}** weight → **${weight}**.` +
      ` Other tiers fall through to the guild rarity profile.${zeroNote}${liveNote}` +
      (updated ? "" : " *(set lookup mismatch — please retry)*"),
    );
    return;
  }

  // ── clearweight ──────────────────────────────────────────────────────────
  if (sub === "clearweight") {
    const setName = interaction.options.getString("set", true);
    const rarity = interaction.options.getString("rarity");
    const set = await getSetByName(setName, guildId);
    if (!set) { await interaction.editReply(`❌ No set named \`${setName}\`.`); return; }
    if (rarity) {
      await patchSetRarityWeight(set.id, rarity, null, guildId);
      await interaction.editReply(`✅ Cleared **${rarity}** override on \`${set.name}\`. Falls back to guild rarity profile.`);
    } else {
      await setSetRarityWeights(set.id, null, guildId);
      await interaction.editReply(`✅ Cleared **all** weight overrides on \`${set.name}\`. Set now uses the guild rarity profile.`);
    }
    return;
  }

  // ── showweights ──────────────────────────────────────────────────────────
  if (sub === "showweights") {
    const setName = interaction.options.getString("set", true);
    const set = await getSetByName(setName, guildId);
    if (!set) { await interaction.editReply(`❌ No set named \`${setName}\`.`); return; }
    const w = set.rarityWeights ?? {};
    const order: Rarity[] = ["common", "uncommon", "rare", "epic", "legendary", "mythic"];
    const active = await getActiveSet(guildId);
    const isActive = active?.id === set.id;
    const displayMap = await getRarityDisplayOverrides(guildId);
    const lines = order.map(r => {
      const v = w[r];
      const tag = v == null ? "*(uses guild profile)*" : `**${v}**`;
      return `${rarityEmoji(r, null, displayMap)} ${rarityLabel(r, null, displayMap)} — ${tag}`;
    });
    const embed = new EmbedBuilder()
      .setTitle(`⚖️ ${set.name} · spawn weights${isActive ? "  ✦ active" : ""}`)
      .setColor(isActive ? 0x57f287 : 0x5865f2)
      .setDescription(
        lines.join("\n") +
        (isActive
          ? "\n\n*Currently active — overrides are live.*"
          : `\n\n*Inactive — activate with \`/set_admin active set:${set.name}\` for these to apply.*`),
      );
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── showcase (toggle set-completion achievement) ─────────────────────────
  if (sub === "showcase") {
    const setName = interaction.options.getString("set", true);
    const enabled = interaction.options.getBoolean("enabled", true);
    const set = await getSetByName(setName, guildId);
    if (!set) { await interaction.editReply(`❌ No set named \`${setName}\`.`); return; }
    await setSetAwardsCompletion(set.id, enabled, guildId);
    const cards = await getCardsInSet(set.id, guildId);
    await interaction.editReply(
      enabled
        ? `✨ \`${set.name}\` is now a **showcase set** — collectors who own all **${cards.length}** of its cards unlock a dedicated achievement. ` +
          `Static "first set complete / 3 / 5" achievements always count completions regardless of this flag.`
        : `✅ \`${set.name}\` is no longer a showcase set — its dedicated completion achievement is disabled. ` +
          `Already-unlocked records stay in members' histories.`,
    );
    return;
  }

  // ── export (single set as JSON attachment) ───────────────────────────────
  if (sub === "export") {
    const setName = interaction.options.getString("set", true);
    const set = await getSetByName(setName, guildId);
    if (!set) { await interaction.editReply(`❌ No set named \`${setName}\`.`); return; }
    const cards = await getCardsInSet(set.id, guildId);
    const payload = buildSingleSetPayload(set, cards);
    const file = new AttachmentBuilder(Buffer.from(JSON.stringify(payload, null, 2), "utf8"), {
      name: `${set.name}.json`,
    });
    await interaction.editReply({
      content: `📤 Exported set \`${set.name}\` — **${cards.length}** cards${set.rarityWeights ? " (including rarity weight overrides)" : ""}. ` +
        `Re-import anywhere with \`/set_admin load file:<this.json>\`.`,
      files: [file],
    });
    return;
  }

  // ── exportall (bundle) ───────────────────────────────────────────────────
  if (sub === "exportall") {
    const filterRaw = interaction.options.getString("sets");
    const filter = filterRaw ? new Set(parseList(filterRaw).map(s => s.toLowerCase())) : null;
    const all = await listSetsV2(guildId);
    const picked = filter ? all.filter(({ set }) => filter.has(set.name.toLowerCase())) : all;
    if (picked.length === 0) {
      await interaction.editReply(filter ? "❌ None of those set names matched." : "❌ No sets to export yet.");
      return;
    }
    const bundle: { exportedAt: string; sets: ReturnType<typeof buildSingleSetPayload>[] } = {
      exportedAt: new Date().toISOString(),
      sets: [],
    };
    let totalCards = 0;
    // Batch: fetch all cards for all sets in one query, then partition by setId.
    const setIds = picked.map(p => p.set.id);
    const allCards = await db.select({
      id: cardsTable.id,
      name: cardsTable.name, description: cardsTable.description,
      rarity: cardsTable.rarity, cardType: cardsTable.cardType, dropWeight: cardsTable.dropWeight,
      worthValue: cardsTable.worthValue, burnValue: cardsTable.burnValue,
      isLimitedEdition: cardsTable.isLimitedEdition, isEventExclusive: cardsTable.isEventExclusive,
      maxCopies: cardsTable.maxCopies, totalMinted: cardsTable.totalMinted,
      imageUrl: cardsTable.imageUrl, flavor: cardsTable.flavor,
      droppable: cardsTable.droppable, inPacks: cardsTable.inPacks,
      isArchived: cardsTable.isArchived,
      setId: cardSetMembershipsTable.setId,
    }).from(cardsTable)
      .innerJoin(cardSetMembershipsTable, eq(cardSetMembershipsTable.cardId, cardsTable.id))
      .where(inArray(cardSetMembershipsTable.setId, setIds));

    const cardsBySet = new Map<number, Card[]>();
    for (const c of allCards) {
      const list = cardsBySet.get(c.setId) ?? [];
      list.push(c as unknown as Card);
      cardsBySet.set(c.setId, list);
    }
    for (const { set } of picked) {
      const cards = cardsBySet.get(set.id) ?? [];
      bundle.sets.push(buildSingleSetPayload(set, cards));
      totalCards += cards.length;
    }

    // Include cards that don't belong to ANY set as a synthetic "Unsorted"
    // bucket — only when the admin is exporting EVERYTHING (no filter).
    // Otherwise an admin asking for "set:foo" would unexpectedly get extras.
    let unassignedCount = 0;
    if (!filter) {
      const orphans = await getUnassignedCards(guildId);
      if (orphans.length > 0) {
        unassignedCount = orphans.length;
        bundle.sets.push(buildSingleSetPayload(
          { id: -1, name: "Unsorted", description: "Cards not assigned to any set at export time.", rarityWeights: null, awardsCompletion: false, createdAt: new Date(), updatedAt: new Date() } as unknown as CardSet,
          orphans,
        ));
        totalCards += orphans.length;
      }
    }

    const filename = picked.length === all.length ? "all-sets.json" : "sets-bundle.json";
    const file = new AttachmentBuilder(Buffer.from(JSON.stringify(bundle, null, 2), "utf8"), { name: filename });
    const orphanNote = unassignedCount > 0
      ? `\n📥 Also included **${unassignedCount}** card${unassignedCount === 1 ? "" : "s"} not in any set, bundled under \`Unsorted\`.`
      : "";
    await interaction.editReply({
      content: `📦 Exported **${picked.length + (unassignedCount > 0 ? 1 : 0)}** set${picked.length === 1 && unassignedCount === 0 ? "" : "s"} (${totalCards} card${totalCards === 1 ? "" : "s"} total).${orphanNote}\n` +
        `Re-import with \`/set_admin load file:<this.json>\` — each set is restored under its own name with its rarity weights.`,
      files: [file],
    });
    return;
  }

  if (sub === "assignall") {
    const setName = interaction.options.getString("set", true);
    const includeArchived = interaction.options.getBoolean("includearchived") ?? false;
    const includeDroppableFalse = interaction.options.getBoolean("includedroppablefalse") ?? false;
      let set = await getSetByName(setName, guildId);
    let createdSet = false;
    if (!set) {
      try {
        set = await createSet(setName, undefined, guildId);
        createdSet = true;
      } catch (err: any) {
        await interaction.editReply(`❌ Couldn't create set \`${setName}\`: ${err?.message ?? "unknown error"}`);
        return;
      }
    }
    const orphansAll = await getUnassignedCards(guildId);
    let orphans = orphansAll;
    if (!includeArchived) orphans = orphans.filter(c => !c.isArchived);
    if (!includeDroppableFalse) orphans = orphans.filter(c => c.droppable);
    if (orphans.length === 0) {
      await interaction.editReply(
        `${createdSet ? `🆕 Created set \`${set.name}\`. ` : ""}` +
        `✅ Nothing to assign — every card already belongs to at least one set (or was filtered out).`,
      );
      return;
    }
    let added = 0;
    // Batch insert: filter out cards already in the set, then insert the rest
    // in a single query. This avoids the N+1 loop that was one round-trip per card.
    if (orphans.length > 0) {
      const existing = await db.select({ cardId: cardSetMembershipsTable.cardId })
        .from(cardSetMembershipsTable)
        .where(and(
          eq(cardSetMembershipsTable.setId, set.id),
          inArray(cardSetMembershipsTable.cardId, orphans.map(c => c.id)),
        ));
      const alreadyIn = new Set(existing.map(r => r.cardId));
      const toInsert = orphans.filter(c => !alreadyIn.has(c.id));
      if (toInsert.length > 0) {
        await db.insert(cardSetMembershipsTable).values(
          toInsert.map(c => ({ setId: set.id, cardId: c.id })),
        );
        invalidateActiveSetCardsCache();
      }
      added = toInsert.length;
    }
    const filterNote: string[] = [];
    if (includeArchived) filterNote.push("archived");
    if (includeDroppableFalse) filterNote.push("non-droppable");
    const note = filterNote.length > 0 ? ` (including ${filterNote.join(" + ")})` : "";
    await interaction.editReply(
      `${createdSet ? `🆕 Created set \`${set.name}\`.\n` : ""}` +
      `✅ Assigned **${added}** card${added === 1 ? "" : "s"} into \`${set.name}\`${note}.\n` +
      `💡 Make it the active spawn pool with \`/set_admin active set:${set.name}\`.`,
    );
    return;
  }

  if (sub === "quickstart") {
    const setName = interaction.options.getString("name", true);
    const channel = interaction.options.getChannel("channel");
    const includeArchived = interaction.options.getBoolean("includearchived") ?? false;
    const includeNonDroppable = interaction.options.getBoolean("includedroppablefalse") ?? false;

      let set = await getSetByName(setName, guildId);
    let createdSet = false;
    if (!set) {
      try {
        set = await createSet(setName, undefined, guildId);
        createdSet = true;
      } catch (err: any) {
        logger.error({ err, setName, guildId }, "Failed to create set via quickstart");
        await interaction.editReply(`❌ Couldn't create set \`${setName}\`: ${err?.message ?? "unknown error"}`);
        return;
      }
    }

    const allCards = await getAllCards(guildId);
    let cardsToAdd = allCards;
    if (!includeArchived) cardsToAdd = cardsToAdd.filter(c => !c.isArchived);
    if (!includeNonDroppable) cardsToAdd = cardsToAdd.filter(c => c.droppable);

    const cardIds = cardsToAdd.map(c => c.id);
    let added = 0;
    let alreadyIn = 0;
    if (cardIds.length > 0) {
      const existing = await db.select({ cardId: cardSetMembershipsTable.cardId })
        .from(cardSetMembershipsTable)
        .where(and(
          eq(cardSetMembershipsTable.setId, set.id),
          inArray(cardSetMembershipsTable.cardId, cardIds),
        ));
      const alreadyInSet = new Set(existing.map(r => r.cardId));
      const toInsert = cardIds.filter(id => !alreadyInSet.has(id));
      added = toInsert.length;
      alreadyIn = alreadyInSet.size;
      if (toInsert.length > 0) {
        await db.insert(cardSetMembershipsTable).values(
          toInsert.map(id => ({ setId: set.id, cardId: id })),
        );
        invalidateActiveSetCardsCache();
      }
    }

    await setActiveSet(guildId, set.id);
    await clearActiveSetSecondary(guildId);
    await updateGuildSettings(guildId, { spawnEnabledSecondary: false });

    if (channel) {
      if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
        await interaction.editReply("❌ The selected channel must be a text or announcement channel.");
        return;
      }
      await updateGuildSettings(guildId, { spawnChannelId: channel.id });
    }

    const filterNote: string[] = [];
    if (includeArchived) filterNote.push("archived");
    if (includeNonDroppable) filterNote.push("non-droppable");
    const note = filterNote.length > 0 ? ` (including ${filterNote.join(" + ")})` : "";

    await interaction.editReply(
      `${createdSet ? `🆕 Created set \`${set.name}\`.\n` : ""}` +
      `✅ Added **${added}** card${added === 1 ? "" : "s"} to \`${set.name}\`${note}.\n` +
      `📦 ${alreadyIn} card${alreadyIn === 1 ? "" : "s"} already in the set.\n` +
      `🎯 \`${set.name}\` is now the active spawn pool.\n` +
      `🚫 Secondary spawn stream disabled.` +
      (channel ? `\n📺 Spawn channel set to <#${channel.id}>.` : "")
    );
    return;
  }

  if (sub === "exportcards") {
    const includeArchived = interaction.options.getBoolean("includearchived") ?? false;
    const all = await getAllCards(guildId);
    const cards = includeArchived ? all : all.filter(c => !c.isArchived);
    if (cards.length === 0) {
      await interaction.editReply("❌ No cards to export.");
      return;
    }
    const payload = {
      exportedAt: new Date().toISOString(),
      cards: cards.map(c => ({
        name: c.name,
        description: c.description,
        rarity: c.rarity,
        cardType: c.cardType,
        dropWeight: c.dropWeight,
        worthValue: c.worthValue,
        burnValue: c.burnValue,
        imageUrl: c.imageUrl ?? undefined,
        flavor: c.flavor ?? undefined,
        droppable: c.droppable,
        inPacks: c.inPacks,
        isLimitedEdition: c.isLimitedEdition,
        isEventExclusive: c.isEventExclusive,
        maxCopies: c.maxCopies ?? undefined,
        isArchived: c.isArchived || undefined,
      })),
    };
    const file = new AttachmentBuilder(
      Buffer.from(JSON.stringify(payload, null, 2), "utf8"),
      { name: "all-cards.json" },
    );
    await interaction.editReply({
      content: `📤 Exported **${cards.length}** card${cards.length === 1 ? "" : "s"}` +
        `${includeArchived ? " (including archived)" : ""}. Re-import with \`/set_admin load file:<this.json>\` — they'll all land in one fresh set.`,
      files: [file],
    });
    return;
  }

  // ── load (legacy /loadset replacement) ─────────────────────────────────────
  if (sub === "load") {
    const file = interaction.options.getAttachment("file");
    const nameOverride = interaction.options.getString("name") ?? undefined;
    if (!file) {
      await interaction.editReply("❌ Attach a `.json` file with the `file:` option.");
      return;
    }
    if (!file.name?.toLowerCase().endsWith(".json")) {
      await interaction.editReply("❌ File must be a `.json` file.");
      return;
    }
    let jsonText: string;
    try {
      const res = await fetch(file.url);
      if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
      jsonText = await res.text();
    } catch (err) {
      logger.error({ err }, "setadmin load: fetch failed");
      await interaction.editReply("❌ Failed to download the JSON file.");
      return;
    }
    try {
      const { created, skipped, failed, errors, setName } =
        await importCardsFromJson(jsonText, file.name, interaction.guildId ?? "unknown", nameOverride);
      await interaction.editReply(
        `✅ **Set loaded** — \`${setName}\`\n` +
        `➕ Created: **${created}**\n` +
        `⏭️ Skipped (already exist): **${skipped}**` +
        (failed > 0 ? `\n❌ Failed: **${failed}**\n${errors.map(e => `• ${e}`).join("\n")}` : "") +
        `\n\nRemove with \`/set_admin unload set:${setName}\` \u00b7 See all with \`/set_admin listloaded\`.`,
      );
    } catch (err: any) {
      await interaction.editReply(`❌ ${err?.message ?? "Import failed"}`);
    }
    return;
  }

  // ── unload (legacy /unloadset replacement) ─────────────────────────────────
  if (sub === "unload") {
    const setName = interaction.options.getString("set", true).toLowerCase().trim();
    if (setName === DEFAULTS_SET_NAME) {
      const { removed } = await unloadDefaultCards(guildId);
      await interaction.editReply(
        `✅ Removed **${removed}** built-in default cards.\nThey will **not** come back on restart. Re-load anytime with \`/set_admin load file:<.json>\` or the \`/setup\` panel.`,
      );
      return;
    }
      const { removed } = await deleteSetByName(setName, guildId);
    if (removed === 0) {
      await interaction.editReply(`❌ No set named \`${setName}\`. Try \`/set_admin listloaded\`.`);
      return;
    }
    await interaction.editReply(
      `✅ Unloaded set \`${setName}\` — removed **${removed}** cards and cleared related collections/trades/spawn history.\n` +
      `💡 Non-destructive alternative: \`/set_admin delete name:${setName}\` only removes memberships and keeps cards.`,
    );
    return;
  }

  // ── listloaded (legacy /listsets replacement) ────────────────────────────────
  if (sub === "listloaded") {
    const sets = await listSets(guildId);
    if (sets.length === 0) {
      await interaction.editReply("📦 No card sets loaded.");
      return;
    }
    sets.sort((a, b) => b.cardCount - a.cardCount);
    const lines = sets.map(s => `• \`${s.setName}\` — **${s.cardCount}** cards`);
    await interaction.editReply(
      `📦 **Loaded card sets** (${sets.length})\n${lines.join("\n")}\n\n` +
      `Load: \`/set_admin load file:<.json>\` · Unload: \`/set_admin unload set:<name>\``,
    );
    return;
  }
  await interaction.editReply(`\u274c Unknown subcommand: \`${sub}\`.`);

}

// Roundtrip-safe payload — every field the importer reads, nothing it
// doesn't. We deliberately drop runtime-derived fields (totalMinted,
// timestamps, podiumPlace) so re-importing into a fresh DB is clean.
// Exported so sets-panel.ts can reuse it for the one-click Export buttons.
export function buildSingleSetPayload(set: CardSet, cards: Card[]) {
  return {
    set: {
      name: set.name,
      description: set.description ?? undefined,
      rarityWeights: set.rarityWeights ?? undefined,
      awardsCompletion: set.awardsCompletion || undefined,
    },
    cards: cards.map(c => ({
      name: c.name,
      description: c.description,
      rarity: c.rarity,
      cardType: c.cardType,
      dropWeight: c.dropWeight,
      worthValue: c.worthValue,
      burnValue: c.burnValue,
      imageUrl: c.imageUrl ?? undefined,
      flavor: c.flavor ?? undefined,
      droppable: c.droppable,
      inPacks: c.inPacks,
      isLimitedEdition: c.isLimitedEdition,
      isEventExclusive: c.isEventExclusive,
      maxCopies: c.maxCopies ?? undefined,
    })),
  };
}
