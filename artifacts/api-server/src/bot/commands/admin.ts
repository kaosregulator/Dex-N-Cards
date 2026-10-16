import { MessageFlags, type ChatInputCommandInteraction, type GuildMember } from "discord.js";
import {
  isAdmin, getAllCards, addShards, catchCard, getOrCreateGuildSettings,
  removeCardFromUser, deductShards, addAdmin, removeAdmin, listAdmins,
  giveCardCopy, getCardsInSet,
} from "../db.js";
import { isHomeGuild, GLOBAL_ONLY_MSG } from "../home-guild.js";
import { spawnCard, scheduleNextSpawn } from "../spawn-manager.js";
import { RARITY_EMOJI, RARITY_LABELS, type Rarity, rarityLabel, rarityEmoji } from "../cards-data.js";
import { getRarityDisplayOverrides } from "../db.js";
import { logger } from "../../lib/logger.js";
import { handleConfigCommand } from "./config-panel.js";
import { handleAdminHubCommand } from "./admin-hub.js";
import { handleEventCommand } from "./event.js";
import { handleDashboardCommand } from "./dashboard.js";
import { EmbedBuilder } from "discord.js";

// ── /admin_help — admin/setup command reference ───────────────────────────────
async function handleAdminHelp(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!(await checkAdmin(interaction))) {
    await interaction.editReply("❌ Admins only.");
    return;
  }
  // Unified /help hub, opened on the Admin page (single source of truth).
  const { handleHelpHub } = await import("./help-hub.js");
  await handleHelpHub(interaction, "admin");
}

// ── Permission check ──────────────────────────────────────────────────────────
async function checkAdmin(interaction: ChatInputCommandInteraction): Promise<boolean> {
  if (!interaction.guild) return false;
  if (interaction.guild.ownerId === interaction.user.id) return true;
  const member = interaction.member as GuildMember | null;
  if (member?.permissions.has("Administrator")) return true;
  return isAdmin(interaction.guild.id, interaction.user.id);
}

// ── Quick admin slash command handler ─────────────────────────────────────────
export async function handleAdminCommand(
  interaction: ChatInputCommandInteraction,
  cmd: string,
): Promise<void> {
  if (!interaction.guild) return;

  // /config opens an ephemeral panel — it handles its own reply (no defer).
  if (cmd === "config") {
    await handleConfigCommand(interaction);
    return;
  }
  // /minigames opens its own ephemeral panel (no defer here).
  if (cmd === "minigames") {
    const { handleMiniGamesCommand } = await import("./minigames-panel.js");
    await handleMiniGamesCommand(interaction);
    return;
  }
  if (cmd === "setup") {
    const { handleSetupCommand } = await import("./setup-wizard.js");
    await handleSetupCommand(interaction);
    return;
  }
  if (cmd === "adminhub") {
    await handleAdminHubCommand(interaction);
    return;
  }
  if (cmd === "adminhelp") {
    await handleAdminHelp(interaction);
    return;
  }
  // /set_admin opens an ephemeral hub panel — handles its own reply (no global defer).
  if (cmd === "set_admin") {
    const { handleSetAdminHubCommand } = await import("./set-admin-hub.js");
    await handleSetAdminHubCommand(interaction);
    return;
  }
  // /delete_all_cards — confirm, then wipe this guild's cards and leftover sets.
  if (cmd === "deleteallcards") {
    const { handleDeleteAllCardsCommand } = await import("./delete-all-cards.js");
    await handleDeleteAllCardsCommand(interaction);
    return;
  }
  if (cmd === "progression") {
    const { handleProgressionHubCommand } = await import("./progression-hub.js");
    await handleProgressionHubCommand(interaction);
    return;
  }
  // /delete_card — permanently removes a card from the global roster.
  if (cmd === "deletecard") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!(await checkAdmin(interaction))) {
      await interaction.editReply("❌ Admins only.");
      return;
    }
    const name = interaction.options.getString("name", true).trim();
    const { getCardByName, removeCard } = await import("../db.js");
    const card = await getCardByName(name, interaction.guild.id);
    if (!card) {
      await interaction.editReply(`❌ No card found named **${name}**.`);
      return;
    }
    await removeCard(card.name, interaction.guild.id);
    await interaction.editReply(`🗑️ **${card.name}** (${card.rarity}) has been permanently deleted.`);
    return;
  }
  // /wishlist_role — set/clear the wishlist spawn ping role.
  if (cmd === "collectorrole") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!(await checkAdmin(interaction))) { await interaction.editReply("❌ Admins only."); return; }
    const { handleSetCollectorRole } = await import("../cards/collector.js");
    await handleSetCollectorRole(interaction);
    return;
  }
  // /add_card — same defer-first pattern as /edit_card; home guild only.
  if (cmd === "addcard") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!(await checkAdmin(interaction))) {
      await interaction.editReply("❌ Admins only.");
      return;
    }
    const { handleAddCardCommand } = await import("./add-card.js");
    await handleAddCardCommand(interaction);
    return;
  }

  // /create_card_from_mttv — creates a DN card using an MTTV item's image + name.
  if (cmd === "createcardfrommttv") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!(await checkAdmin(interaction))) {
      await interaction.editReply("❌ Admins only.");
      return;
    }
    const { handleCreateCardFromMTTV } = await import("./mttvalues.js");
    await handleCreateCardFromMTTV(interaction);
    return;
  }

  // /create_cards_from_mttv — stepped bulk Vault create (own ephemeral hub, no defer).
  if (cmd === "createcardsfrommttv") {
    const { handleVaultBatchCommand } = await import("./vault-batch.js");
    await handleVaultBatchCommand(interaction);
    return;
  }

  // /create_card_from — creates a DN card using Kitsu anime/manga/character data.
  if (cmd === "createcardfrom") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!(await checkAdmin(interaction))) {
      await interaction.editReply("❌ Admins only.");
      return;
    }
    const { handleCreateCardFromKitsu } = await import("./kitsu-cards.js");
    await handleCreateCardFromKitsu(interaction);
    return;
  }

  // /library — search Kitsu and preview the bio + image (admin-only, ephemeral).
  if (cmd === "library") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!(await checkAdmin(interaction))) {
      await interaction.editReply("❌ Admins only.");
      return;
    }
    const { handleLibraryCommand } = await import("./kitsu-cards.js");
    await handleLibraryCommand(interaction);
    return;
  }

  // /edit_card — defer first so checkAdmin()'s isAdmin() DB call can't blow
  // Discord's 3s window. handleEditCardCommand receives an already-deferred
  // interaction and uses editReply for its panel.
  if (cmd === "editcard") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!(await checkAdmin(interaction))) {
      await interaction.editReply("❌ Admins only.");
      return;
    }
    // /edit_card mutates the globally shared cards table — home guild only.
    if (!isHomeGuild(interaction.guild.id)) {
      await interaction.editReply(GLOBAL_ONLY_MSG);
      return;
    }
    const { handleEditCardCommand } = await import("./edit-card.js");
    await handleEditCardCommand(interaction);
    return;
  }

  // /edit_image — same admin/home-guild guard as /edit_card; only changes image.
  if (cmd === "editimage") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!(await checkAdmin(interaction))) {
      await interaction.editReply("❌ Admins only.");
      return;
    }
    if (!isHomeGuild(interaction.guild.id)) {
      await interaction.editReply(GLOBAL_ONLY_MSG);
      return;
    }
    const { handleEditImageCommand } = await import("./edit-image.js");
    await handleEditImageCommand(interaction);
    return;
  }

  // /edituser — guild-scoped member editor; admin-gated above.
  if (cmd === "edituser") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!(await checkAdmin(interaction))) {
      await interaction.editReply("❌ Admins only.");
      return;
    }
    const { handleEditUserCommand } = await import("./edit-user.js");
    await handleEditUserCommand(interaction);
    return;
  }
  // ── /giveall ──────────────────────────────────────────────────────────────
  // Give one copy of every matching card to a user. Shiny chance is configurable;
  // each card rolls independently. Filter by set or base rarity.
  if (cmd === "giveall") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!(await checkAdmin(interaction))) {
      await interaction.editReply("❌ Admins only.");
      return;
    }
    const target = interaction.options.getUser("user", true);
    const setName = interaction.options.getString("set");
    const rarity = interaction.options.getString("rarity") as Rarity | null;
    const shinyRate = Math.min(100, Math.max(0, interaction.options.getInteger("shinyrate") ?? 0.5));
    const gId = interaction.guild.id;

    const { getSetByName } = await import("../db.js");
    let pool = await getAllCards(gId);

    if (setName?.trim()) {
      const set = await getSetByName(setName.trim(), gId);
      if (!set) {
        await interaction.editReply(`❌ Set "**${setName.trim()}**" not found.`);
        return;
      }
      const setCards = await getCardsInSet(set.id, gId);
      const setCardIds = new Set(setCards.map(c => c.id));
      pool = pool.filter(c => setCardIds.has(c.id));
    }

    if (rarity) {
      pool = pool.filter(c => c.rarity === rarity);
    }

    pool = pool.filter(c => !c.isArchived);

    if (pool.length === 0) {
      await interaction.editReply("❌ No cards match the selected set/rarity filter.");
      return;
    }

    let given = 0;
    let shinies = 0;
    for (const card of pool) {
      const isShiny = Math.random() * 100 < shinyRate;
      await giveCardCopy(gId, target.id, card.id, isShiny);
      given++;
      if (isShiny) shinies++;
    }

    const r = rarity ? rarityLabel(rarity as Rarity, null, await getRarityDisplayOverrides(gId)) : "all rarities";
    const suffix = rarity ? ` (${r})` : "";
    const setText = setName?.trim() ? ` from set **${setName.trim()}**` : "";
    await interaction.editReply(
      `✅ Gave **${given} card${given === 1 ? "" : "s"}**${suffix}${setText} to <@${target.id}>.` +
      (shinies > 0 ? ` ${shinies} shiny ✨` : ""),
    );
    return;
  }
  if (cmd === "editpack") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!(await checkAdmin(interaction))) {
      await interaction.editReply("❌ Admins only.");
      return;
    }
    const { handleEditPackCommand } = await import("./editpack.js");
    await handleEditPackCommand(interaction);
    return;
  }
  // All admin replies are ephemeral — only the staff member running the
  // command sees the confirmation. The side effects (card drops, etc.)
  // are already broadcast publicly through their own messages.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const ok = await checkAdmin(interaction);
  if (!ok) {
    await interaction.editReply("❌ You don't have permission to use admin commands.");
    return;
  }

  // /dashboard — admin-gated above; DM the user a one-time setup link.
  if (cmd === "dashboard") {
    await handleDashboardCommand(interaction);
    return;
  }
  if (cmd === "postcalculator") {
    const { handlePostCalculator } = await import("./mttcalc-hub.js");
    await handlePostCalculator(interaction);
    return;
  }
  if (cmd === "postboard") {
    const { handlePostboardCommand } = await import("../emoji/commands/postboard.js");
    await handlePostboardCommand(interaction);
    return;
  }

  const guildId = interaction.guild.id;
  const opts = interaction.options;

  if (cmd === "rarity") {
    const { handleRarityHubCommand } = await import("./rarity-admin.js");
    await handleRarityHubCommand(interaction);
    return;
  }

  if (cmd === "embed") {
    const { handleEmbedAdminCommand } = await import("./embed-admin.js");
    await handleEmbedAdminCommand(interaction);
    return;
  }

  // ── /event start|list|stop ────────────────────────────────────────────────
  // Delegated to event.ts. We've already deferred + admin-checked above so
  // it can go straight to editReply.
  if (cmd === "event") {
    await handleEventCommand(interaction);
    return;
  }

  // ── /set_hub (clickable set manager panel) ────────────────────────────────
  if (cmd === "sethub") {
    const { handleSetsHubCommand } = await import("./sets-panel.js");
    await handleSetsHubCommand(interaction);
    return;
  }

  // ── /welcome_admin (admin onboarding guide — ephemeral) ────────────────────
  if (cmd === "welcomeadmin") {
    const { handleWelcomeAdmin } = await import("./welcome.js");
    await handleWelcomeAdmin(interaction);
    return;
  }

  // ── /drop ─────────────────────────────────────────────────────────────────
  if (cmd === "drop") {
    const cardName = opts.getString("name");
    const setName = opts.getString("set");
    // Optional explicit Star/Level: the caught card will arrive at this exact
    // progression (variable acquisition), overriding the guild's rolled range.
    const starOpt = opts.getInteger("star");
    const levelOpt = opts.getInteger("level");
    const forcedProgression = (starOpt != null || levelOpt != null)
      ? { starRank: starOpt ?? 0, level: levelOpt ?? 1 }
      : null;
    const progressionNote = forcedProgression
      ? ` — arrives at **Lv ${forcedProgression.level}${forcedProgression.starRank > 0 ? ` · ${forcedProgression.starRank}★` : ""}**`
      : "";
    const settings = await getOrCreateGuildSettings(guildId);
    if (!settings.spawnChannelId) {
      const pfx = settings.commandPrefix;
      await interaction.editReply(`❌ No spawn channel set. Run \`${pfx}setchannel #channel\` first.`);
      return;
    }
    let forcedCardId: number | undefined;
    if (cardName) {
      const cards = await getAllCards(guildId);
      const found = cards.find(c => c.name.toLowerCase() === cardName.toLowerCase());
      if (!found) { await interaction.editReply(`❌ Card "**${cardName}**" not found. Try \`/list\`.`); return; }
      forcedCardId = found.id;
    }
    // Optional set override: if a set is named, we pick from that set's cards
    // instead of the guild's active set. Forced card still bypasses everything.
    if (setName && !forcedCardId) {
      const { getSetByName, getCardsInSet } = await import("../db.js");
      const set = await getSetByName(setName, guildId);
      if (!set) { await interaction.editReply(`❌ No set named \`${setName}\`.`); return; }
      const setCards = await getCardsInSet(set.id, guildId);
      const pool = setCards.filter(c => c.droppable && !c.isArchived && (!c.maxCopies || c.totalMinted < c.maxCopies));
      if (pool.length === 0) { await interaction.editReply(`❌ No droppable cards in set \`${setName}\`.`); return; }
      const pick = pool[Math.floor(Math.random() * pool.length)];
      forcedCardId = pick!.id;
      await spawnCard(guildId, forcedCardId, true, forcedProgression);
      await interaction.editReply(`✅ Dropped **${pick!.name}** from set \`${set.name}\`!${progressionNote}`);
      scheduleNextSpawn(guildId);
      return;
    }
    await spawnCard(guildId, forcedCardId, true, forcedProgression);
    await interaction.editReply((forcedCardId ? `✅ Force-dropped **${cardName}**!` : "✅ Dropped a random card!") + progressionNote);
    scheduleNextSpawn(guildId);
    return;
  }

  // ── /mass_drop ─────────────────────────────────────────────────────────────
  // "Admin abuse" — a chaotic event batch tilted heavily toward low rarities
  // with guaranteed mid-tier and one legendary banger. Fires sequentially with
  // a small gap so Discord doesn't rate-limit and so the channel reads as a
  // dramatic event rather than a wall of embeds.
  if (cmd === "massdrop") {
    const amount = opts.getInteger("amount") ?? 15;
    const setName = opts.getString("set");
    const settings = await getOrCreateGuildSettings(guildId);
    if (!settings.spawnChannelId) {
      const pfx = settings.commandPrefix;
      await interaction.editReply(`❌ No spawn channel set. Run \`${pfx}setchannel #channel\` first.`);
      return;
    }
    // /mass_drop respects the guild's active set so chaotic batches don't
    // dump cards that aren't part of the current rotation. If a specific set
    // is named we use that instead. If no active set we fall back to global.
    const { getActiveSetSpawnPoolCached, getSetByName, getCardsInSet } = await import("../db.js");
    let allCards: Awaited<ReturnType<typeof getAllCards>>;
    if (setName) {
      const set = await getSetByName(setName, guildId);
      if (!set) { await interaction.editReply(`❌ No set named \`${setName}\`.`); return; }
      allCards = await getCardsInSet(set.id, guildId);
    } else {
      const activePool = await getActiveSetSpawnPoolCached(guildId);
      allCards = activePool.cards.length > 0 ? activePool.cards : await getAllCards(guildId);
    }
    const pool = allCards.filter(c => c.droppable && !c.isArchived && (!c.maxCopies || c.totalMinted < c.maxCopies));
    const byRarity: Record<Rarity, typeof pool> = { common: [], uncommon: [], rare: [], epic: [], legendary: [], mythic: [] };
    for (const c of pool) byRarity[c.rarity as Rarity].push(c);

    // Distribution: 1 legendary banger, 1 epic, ~2 rare, ~30% uncommon, rest common.
    // Mythic is intentionally excluded from massdrop — it's the new top tier,
    // admins should grant it deliberately via /give or /drop.
    const target = computeMassDropDistribution(amount);
    const pick = (r: Rarity): typeof pool[number] | null => {
      const bucket = byRarity[r];
      if (bucket.length === 0) return null;
      return bucket[Math.floor(Math.random() * bucket.length)] ?? null;
    };
    // Build the queue, falling back down the rarity ladder if a tier is empty.
    const ladder: Rarity[] = ["legendary", "epic", "rare", "uncommon", "common"];
    const queue: typeof pool = [];
    for (const r of ladder) {
      for (let i = 0; i < target[r]; i++) {
        let picked: typeof pool[number] | null = null;
        for (let li = ladder.indexOf(r); li < ladder.length && !picked; li++) picked = pick(ladder[li]!);
        for (let li = ladder.indexOf(r) - 1; li >= 0 && !picked; li--) picked = pick(ladder[li]!);
        if (picked) queue.push(picked);
      }
    }
    if (queue.length === 0) {
      await interaction.editReply("❌ No droppable cards available to mass-drop.");
      return;
    }
    // Shuffle so the legendary isn't always first — keeps the chaos fresh.
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j]!, queue[i]!];
    }

    const counts: Record<Rarity, number> = { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0, mythic: 0 };
    for (const c of queue) counts[c.rarity as Rarity]++;
    const displayMap = await getRarityDisplayOverrides(guildId);
    const summary = ladder
      .filter(r => counts[r] > 0)
      .map(r => `${rarityEmoji(r, null, displayMap)} ×${counts[r]}`)
      .join(" · ");

    await interaction.editReply(
      `💥 **Admin abuse engaged.** Dropping **${queue.length}** cards over ~${Math.round(queue.length * 5)}s.\n${summary}`,
    );

    // Fire the spawns in the background — don't await, so we can return the
    // ephemeral confirmation immediately. Errors are logged, not re-thrown.
    void (async () => {
      for (let i = 0; i < queue.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 5000));
        try {
          await spawnCard(guildId, queue[i]!.id, true);
        } catch (err) {
          logger.warn({ err, cardId: queue[i]!.id }, "massdrop spawn failed");
        }
      }
      scheduleNextSpawn(guildId);
    })();
    return;
  }

  // ── /give ─────────────────────────────────────────────────────────────────
  if (cmd === "give") {
    const target = opts.getUser("user", true);
    const cardName = opts.getString("name", true);
    const amount = opts.getInteger("amount") ?? 1;
    // Optional explicit Star/Level: give the card pre-levelled/fused. Applied
    // through the shared progression service (same card_progress row battles use).
    const starOpt = opts.getInteger("star");
    const levelOpt = opts.getInteger("level");
    const forcedProgression = (starOpt != null || levelOpt != null)
      ? { starRank: starOpt ?? 0, level: levelOpt ?? 1 }
      : undefined;
    const cards = await getAllCards(guildId);
    const card = cards.find(c => c.name.toLowerCase() === cardName.toLowerCase());
    if (!card) { await interaction.editReply(`❌ Card "**${cardName}**" not found.`); return; }
    // Admin gives are deterministic — no shiny roll. Use /event or normal
    // drops if you want shiny chances.
    for (let i = 0; i < amount; i++) {
      await catchCard(guildId, target.id, card.id, { noShiny: true, forcedProgression });
    }
    const r = card.rarity as Rarity;
    const displayMap = await getRarityDisplayOverrides(guildId);
    const rLabel = rarityLabel(r, null, displayMap);
    const rEmoji = rarityEmoji(r, null, displayMap);
    const suffix = amount > 1 ? ` ×${amount}` : "";
    const progNote = forcedProgression
      ? ` — at **Lv ${forcedProgression.level}${forcedProgression.starRank > 0 ? ` · ${forcedProgression.starRank}★` : ""}**`
      : "";
    await interaction.editReply(`✅ Gave **${card.name}**${suffix} (${rEmoji} ${rLabel}) to <@${target.id}>.${progNote}`);
    return;
  }

  // ── /give_shards ───────────────────────────────────────────────────────────
  if (cmd === "giveshards") {
    const target = opts.getUser("user", true);
    const amount = opts.getInteger("amount", true);
    await addShards(guildId, target.id, amount);
    await interaction.editReply(`✅ Gave <@${target.id}> 💠 **${amount.toLocaleString()} shards**.`);
    return;
  }

  // ── /battle_force_end — unstick a member whose battle is wedged (message
  // deleted, a bug, or they're just stuck) instead of making them wait out the
  // 20-minute timeout. Any staked card is refunded; nobody "wins" a forced cancel.
  if (cmd === "battleforceend") {
    const target = opts.getUser("user", true);
    const { forceEndUserBattle } = await import("../battle/battle-manager.js");
    const result = await forceEndUserBattle(guildId, target.id);
    if (!result.found) {
      await interaction.editReply(`ℹ️ <@${target.id}> isn't in a battle — nothing to cancel.`);
      return;
    }
    const bits: string[] = [`✅ Cancelled <@${target.id}>'s battle` + (result.opponentName ? ` vs **${result.opponentName}**` : "") + "."];
    if (result.refundedStakedCard) bits.push("💠 The staked card was refunded.");
    if (!result.inMemory) bits.push("_(Recovered from a stale lock — no live battle message to update.)_");
    await interaction.editReply(bits.join(" "));
    return;
  }

  // ── /take_back ─────────────────────────────────────────────────────────────
  if (cmd === "takeback") {
    const target = opts.getUser("user", true);
    const cardName = opts.getString("name", true);
    const amount = opts.getInteger("amount") ?? 1;
    const cards = await getAllCards(guildId);
    const card = cards.find(c => c.name.toLowerCase() === cardName.toLowerCase());
    if (!card) { await interaction.editReply(`❌ Card "**${cardName}**" not found.`); return; }
    let removed = 0;
    let remaining = 0;
    for (let i = 0; i < amount; i++) {
      const result = await removeCardFromUser(guildId, target.id, card.id);
      if (!result.success) break;
      removed++;
      remaining = result.remaining;
    }
    if (removed === 0) {
      await interaction.editReply(`❌ <@${target.id}> doesn't have **${card.name}**.`);
      return;
    }
    const r = card.rarity as Rarity;
    const displayMap = await getRarityDisplayOverrides(guildId);
    const rLabel = rarityLabel(r, null, displayMap);
    const rEmoji = rarityEmoji(r, null, displayMap);
    const suffix = removed > 1 ? ` ×${removed}` : "";
    const shortfall = removed < amount ? ` (only had ${removed}, requested ${amount})` : "";
    await interaction.editReply(
      `✅ Removed **${card.name}**${suffix} (${rEmoji} ${rLabel}) from <@${target.id}>.${shortfall}` +
      (remaining > 0 ? ` They still have ×${remaining}.` : " Last copy removed."),
    );
    return;
  }

  // ── /take_shards ───────────────────────────────────────────────────────────
  if (cmd === "takeshards") {
    const target = opts.getUser("user", true);
    const amount = opts.getInteger("amount", true);
    const result = await deductShards(guildId, target.id, amount);
    if (!result.success) {
      await interaction.editReply(`❌ <@${target.id}> has no shards to deduct.`);
      return;
    }
    await interaction.editReply(
      `✅ Deducted 💠 **${amount.toLocaleString()} shards** from <@${target.id}>. New balance: **${result.remaining.toLocaleString()}**.`,
    );
    return;
  }

  if (cmd === "massrole") {
    const { handleMassRoleCommand } = await import("./mass-role.js");
    await handleMassRoleCommand(interaction);
    return;
  }

  await interaction.editReply("❌ Unknown command.");
}

// Mass-drop rarity distribution: 1 legendary banger, 1 epic, ~2 rare,
// ~30% uncommon, the rest common. Tuned for 10-25 amounts.
function computeMassDropDistribution(amount: number): Record<Rarity, number> {
  const legendary = 1;
  const epic = 1;
  const rare = Math.max(2, Math.floor(amount * 0.13));
  const uncommon = Math.max(2, Math.floor(amount * 0.30));
  const used = legendary + epic + rare + uncommon;
  const common = Math.max(0, amount - used);
  return { common, uncommon, rare, epic, legendary, mythic: 0 };
}
