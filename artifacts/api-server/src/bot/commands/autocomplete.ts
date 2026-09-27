import type { AutocompleteInteraction } from "discord.js";
import Fuse from "fuse.js";
import { internalCommandName } from "./register.js";
import { getAllCards, listSetsV2, getUserCollection, getUserWishlist, listCustomRarities, getRarityContext, getOrCreateGuildSettings, getRarityDisplayOverrides, getDisplayRarities, getDistinctCardTypes, listCustomPacks } from "../db.js";
import { RARITY_EMOJI, rarityEmoji, rarityLabel, type Rarity } from "../cards-data.js";
import { tierLabel, PACK_TIER_META, PACK_TIERS } from "./pack.js";

const MAX_CHOICES = 25;

// Cache the full card list briefly so we don't hammer the DB on every keystroke.
// ⚠️ REPLIT SAFETY REVIEW ⚠️ Keyed PER GUILD — a shared cache would let one
// server's roster autocomplete into another server. Callers MUST pass the
// viewer's guildId; without one we return [] (never another server's cards).
const cardCache = new Map<string, { at: number; cards: Array<{ name: string; rarity: string }> }>();
const CACHE_MS = 15_000;

async function getCardsCached(guildId: string | null | undefined): Promise<Array<{ name: string; rarity: string }>> {
  if (!guildId) return [];
  const now = Date.now();
  const cached = cardCache.get(guildId);
  if (cached && now - cached.at < CACHE_MS) return cached.cards;
  const cards = await getAllCards(guildId);
  const slim = cards.map(c => ({ name: c.name, rarity: c.rarity }));
  cardCache.set(guildId, { at: now, cards: slim });
  return slim;
}

// Per-guild set cache — same isolation rule as the card cache above.
const setCache = new Map<string, { at: number; sets: Awaited<ReturnType<typeof listSetsV2>> }>();
const SET_CACHE_MS = 5_000;
async function getSetsCached(guildId: string | null | undefined): Promise<Awaited<ReturnType<typeof listSetsV2>>> {
  if (!guildId) return [];
  const now = Date.now();
  const cached = setCache.get(guildId);
  if (cached && now - cached.at < SET_CACHE_MS) return cached.sets;
  const sets = await listSetsV2(guildId);
  setCache.set(guildId, { at: now, sets });
  return sets;
}

const customTierCache = new Map<string, { at: number; tiers: Awaited<ReturnType<typeof listCustomRarities>> }>();
const CUSTOM_TIER_CACHE_MS = 5_000;
async function getCustomRaritiesCached(guildId: string): Promise<Awaited<ReturnType<typeof listCustomRarities>>> {
  const now = Date.now();
  const cached = customTierCache.get(guildId);
  if (cached && now - cached.at < CUSTOM_TIER_CACHE_MS) return cached.tiers;
  const tiers = await listCustomRarities(guildId);
  customTierCache.set(guildId, { at: now, tiers });
  return tiers;
}

const collectionCache = new Map<string, { at: number; rows: Awaited<ReturnType<typeof getUserCollection>> }>();
const COLLECTION_CACHE_MS = 5_000;
async function getUserCollectionCached(guildId: string, userId: string): Promise<Awaited<ReturnType<typeof getUserCollection>>> {
  const key = `${guildId}:${userId}`;
  const now = Date.now();
  const cached = collectionCache.get(key);
  if (cached && now - cached.at < COLLECTION_CACHE_MS) return cached.rows;
  const rows = await getUserCollection(guildId, userId);
  collectionCache.set(key, { at: now, rows });
  return rows;
}

const wishlistCache = new Map<string, { at: number; rows: Awaited<ReturnType<typeof getUserWishlist>> }>();
const WISHLIST_CACHE_MS = 5_000;
async function getUserWishlistCached(guildId: string, userId: string): Promise<Awaited<ReturnType<typeof getUserWishlist>>> {
  const key = `${guildId}:${userId}`;
  const now = Date.now();
  const cached = wishlistCache.get(key);
  if (cached && now - cached.at < WISHLIST_CACHE_MS) return cached.rows;
  const rows = await getUserWishlist(guildId, userId);
  wishlistCache.set(key, { at: now, rows });
  return rows;
}

function acronym(name: string): string {
  return name
    .split(/\s+/)
    .map(w => w.replace(/[^a-zA-Z0-9]/g, "").slice(0, 1).toUpperCase())
    .join("");
}

function formatCardChoice(c: { name: string; rarity: string }) {
  const emoji = rarityEmoji(c.rarity as Rarity, null, null) ?? "🃏";
  const display = `${emoji} ${c.name}`.slice(0, 100);
  return { name: display, value: c.name.slice(0, 100) };
}

async function suggestCardNames(query: string, guildId: string | null | undefined, pool?: Array<{ name: string; rarity: string }>) {
  const q = query.toLowerCase().trim();
  const cards = pool ?? await getCardsCached(guildId);
  if (!q) return cards.slice(0, MAX_CHOICES).map(formatCardChoice);

  const fuse = new Fuse(cards, {
    keys: ["name"],
    threshold: 0.35,
    includeScore: true,
    ignoreLocation: true,
    minMatchCharLength: 1,
  });

  // Exact / substring / acronym matches get top priority; fuse covers typos.
  const exactAndAcronym = cards
    .filter(c => c.name.toLowerCase().includes(q) || acronym(c.name).toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));

  const seen = new Set(exactAndAcronym.map(c => c.name));
  const fuseHits = fuse.search(q).map(r => r.item).filter(c => !seen.has(c.name));

  return [...exactAndAcronym, ...fuseHits].slice(0, MAX_CHOICES).map(formatCardChoice);
}

export async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  // Commands are flat + publicly renamed; map the registered name (e.g.
  // "raid_admin") back to its internal name (e.g. "raidadmin") for the checks below.
  const cmd = internalCommandName(interaction.commandName);
  const query = (focused.value ?? "").toString();

  try {

    // ── /emoji settings, sourced from the MakeEmoji discovery manifest ────────
    // Autocomplete rather than fixed choices: the vocabulary belongs to
    // MakeEmoji and is read from the manifest, never hardcoded here.
    if (cmd === "emoji") {
      const { handleEmojiAutocomplete } = await import("../emoji/commands/emoji.js");
      await handleEmojiAutocomplete(interaction);
      return;
    }

    // ── Raid boss-name autocomplete for /raid start, /battle raid, /raid_admin ─
    if (((cmd === "raid" || cmd === "battle") && focused.name === "boss") ||
        (cmd === "raidadmin" && focused.name === "name")) {
      if (!interaction.guild) { await interaction.respond([]); return; }
      const { getAllBosses } = await import("../raid/db.js");
      // /raid start & /battle raid only surface enabled bosses; admin sees all.
      const bosses = (await getAllBosses(interaction.guild.id))
        .filter(b => cmd === "raidadmin" || b.enabled);
      const q = query.toLowerCase().trim();
      await interaction.respond(
        bosses
          .filter(b => !q || b.name.toLowerCase().includes(q))
          .slice(0, MAX_CHOICES)
          .map(b => ({ name: `${b.name}${b.enabled ? "" : " (disabled)"}`.slice(0, 100), value: b.name.slice(0, 100) })),
      );
      return;
    }

    // ── Squad-name autocomplete for /squad join + /squad info ───────────────
    if (cmd === "squad" && focused.name === "name" && interaction.guild) {
      const { db, squadsTable } = await import("@workspace/db");
      const { eq } = await import("drizzle-orm");
      const squads = await db.select().from(squadsTable).where(eq(squadsTable.guildId, interaction.guild.id));
      const q = query.toLowerCase().trim();
      await interaction.respond(
        squads
          .filter(s => !q || s.name.toLowerCase().includes(q))
          .slice(0, MAX_CHOICES)
          .map(s => ({ name: (s.tag ? `[${s.tag}] ${s.name}` : s.name).slice(0, 100), value: s.name.slice(0, 100) })),
      );
      return;
    }

    // ── Set-name autocomplete for /drop, /mass_drop, /cardadmin, legacy create ─
    // Any string option named `set` on these commands resolves to a set picker.
    const sub = (() => { try { return interaction.options.getSubcommand(false); } catch { return null; } })();
    const isSetNameOption =
      (cmd === "drop" && focused.name === "set") ||
      (cmd === "massdrop" && focused.name === "set") ||
      (cmd === "addcard" && focused.name === "set") ||
      (cmd === "createcardfrommttv" && focused.name === "set") ||
      (cmd === "createcardfrom" && focused.name === "set") ||
      (cmd === "cardadmin" && focused.name === "set" &&
        ["create", "create_kitsu", "create_vault", "giveall", "drop", "mass_drop"].includes(sub ?? ""));
    if (isSetNameOption) {
      const sets = await getSetsCached(interaction.guildId);
      const q = query.toLowerCase().trim();
      const matches = sets
        .filter(s => !q || s.set.name.toLowerCase().includes(q))
        .sort((a, b) => b.cardCount - a.cardCount || a.set.name.localeCompare(b.set.name))
        .slice(0, MAX_CHOICES)
        .map(s => ({
          name: `${s.set.name} (${s.cardCount} card${s.cardCount === 1 ? "" : "s"})`.slice(0, 100),
          value: s.set.name.slice(0, 100),
        }));
      await interaction.respond(matches);
      return;
    }

    // ── /burn, /level, /frame, /lock, /market sell — suggest owned cards ────
    if ((cmd === "burn" || cmd === "level" || cmd === "frame" || cmd === "lock" || cmd === "market" || cmd === "tradein") && focused.name === "name" && interaction.guild) {
      const owned = await getUserCollectionCached(interaction.guild.id, interaction.user.id);
      const pool = owned.map(o => ({ name: o.name, rarity: o.rarity }));
      await interaction.respond(await suggestCardNames(query, interaction.guild.id, pool));
      return;
    }

    // ── /trade offer — only cards the user owns ─────────────────────────────
    if (cmd === "trade" && focused.name === "offer" && interaction.guild) {
      const owned = await getUserCollectionCached(interaction.guild.id, interaction.user.id);
      const pool = owned.map(o => ({ name: o.name, rarity: o.rarity }));
      await interaction.respond(await suggestCardNames(query, interaction.guild.id, pool));
      return;
    }

    // ── /trade want — only cards the TARGET user owns ───────────────────────
    if (cmd === "trade" && focused.name === "want" && interaction.guild) {
      const targetOpt = interaction.options.get("user", false);
      const targetId = targetOpt?.user?.id;
      if (targetId && targetId !== interaction.user.id) {
        const targetOwned = await getUserCollectionCached(interaction.guild.id, targetId);
        if (targetOwned.length === 0) {
          await interaction.respond([{ name: `⚠️ ${targetOpt?.user?.username ?? "They"} have no cards yet`, value: "" }]);
          return;
        }
        const pool = targetOwned.map(o => ({ name: o.name, rarity: o.rarity }));
        await interaction.respond(await suggestCardNames(query, interaction.guild.id, pool));
        return;
      }
      // No user picked yet → fall through to full roster so the dropdown isn't empty
    }

    // ── /wishlist remove — only suggest cards already on the user's wishlist ─
    if (cmd === "wishlist" && focused.name === "name" && interaction.guild) {
      const sub = interaction.options.getSubcommand(false);
      if (sub === "remove") {
        const wished = await getUserWishlistCached(interaction.guild.id, interaction.user.id);
        const pool = wished.map(w => ({ name: w.name, rarity: w.rarity }));
        await interaction.respond(await suggestCardNames(query, interaction.guild.id, pool));
        return;
      }
    }


    // ── /trade_in rarity — built-ins plus custom tiers in server ladder order ──
    if (cmd === "tradein" && focused.name === "rarity" && interaction.guild) {
      const q = query.toLowerCase().trim();
      const [ctx, settings, displayMap] = await Promise.all([
        getRarityContext(interaction.guild.id),
        getOrCreateGuildSettings(interaction.guild.id),
        getRarityDisplayOverrides(interaction.guild.id),
      ]);
      const ladder = getDisplayRarities(ctx, settings, { rarestFirst: false, displayMap });
      const options = ladder.slice(0, -1).map((tier, idx) => {
        const next = ladder[idx + 1];
        const value = tier.isCustom ? `custom:${tier.slug}` : tier.rarity!;
        return {
          name: `${tier.emoji} ${tier.label} → ${next?.emoji ?? "⬆️"} ${next?.label ?? "next"}`.slice(0, 100),
          value: value.slice(0, 100),
        };
      });
      const filtered = !q
        ? options
        : options.filter(o => o.name.toLowerCase().includes(q) || o.value.toLowerCase().includes(q));
      await interaction.respond(filtered.slice(0, MAX_CHOICES));
      return;
    }

    // ── /add_card, /cardadmin create*, rarity — built-in rarities only ────
    // Legacy custom-tier assignment still exists in advanced tools; new cards
    // should start with a stable built-in rarity identity.
    if (
      ((cmd === "addcard" || cmd === "createcardfrommttv" || cmd === "createcardfrom") && focused.name === "rarity") ||
      (cmd === "cardadmin" && focused.name === "rarity" && ["create", "create_kitsu", "create_vault"].includes(sub ?? ""))
    ) {
      if (!interaction.guild) { await interaction.respond([]); return; }
      const q = query.toLowerCase().trim();
      const [settings, displayMap] = await Promise.all([
        getOrCreateGuildSettings(interaction.guild.id),
        getRarityDisplayOverrides(interaction.guild.id),
      ]);
      const builtIn: Rarity[] = ["common", "uncommon", "rare", "epic", "legendary", "mythic"];
      const builtInOptions = builtIn.map(r => ({
        name: `${rarityEmoji(r, settings, displayMap)} ${rarityLabel(r, settings, displayMap)}`.slice(0, 100),
        value: r,
      }));
      const filtered = !q
        ? builtInOptions
        : builtInOptions.filter(o => o.name.toLowerCase().includes(q) || o.value.includes(q));
      await interaction.respond(filtered.slice(0, MAX_CHOICES));
      return;
    }

    // ── /add_card and /cardadmin create* type — existing card types plus free entry ──
    if (
      ((cmd === "addcard" || cmd === "createcardfrommttv" || cmd === "createcardfrom") && focused.name === "type") ||
      (cmd === "cardadmin" && focused.name === "type" && ["create", "create_kitsu", "create_vault"].includes(sub ?? ""))
    ) {
      if (!interaction.guild) { await interaction.respond([]); return; }
      const q = query.toLowerCase().trim();
      const types = await getDistinctCardTypes(interaction.guild.id);
      const options = types
        .filter(t => !q || t.toLowerCase().includes(q))
        .slice(0, MAX_CHOICES)
        .map(t => ({ name: t.slice(0, 100), value: t.slice(0, 100) }));
      // If the user typed something completely new, offer it as-is so they can create a new type.
      if (q && !types.some(t => t.toLowerCase() === q)) {
        options.unshift({ name: `New: ${focused.value}`.slice(0, 100), value: focused.value.slice(0, 100) });
        if (options.length > MAX_CHOICES) options.pop();
      }
      await interaction.respond(options);
      return;
    }

    // ── Vault Values item AC — /vaultvalue item: + /cardadmin create_vault (+ legacy) ──
    if (
      ((cmd === "info_mttv" || cmd === "createcardfrommttv") && focused.name === "item") ||
      (cmd === "vaultvalue" && focused.name === "item") ||
      (cmd === "cardadmin" && sub === "create_vault" && focused.name === "item")
    ) {
      const { handleMTTVAutocomplete } = await import("./mttvalues.js");
      await handleMTTVAutocomplete(interaction, focused);
      return;
    }

    // ── Kitsu AC — /cardadmin create_kitsu|library (+ legacy) ──
    if (
      (cmd === "createcardfrom" && focused.name === "item") ||
      (cmd === "library" && focused.name === "name") ||
      (cmd === "cardadmin" && sub === "create_kitsu" && focused.name === "item") ||
      (cmd === "cardadmin" && sub === "library" && focused.name === "name")
    ) {
      const { handleKitsuAutocomplete } = await import("./kitsu-cards.js");
      await handleKitsuAutocomplete(interaction);
      return;
    }

    // ── /pack tier — built-in tiers + active custom packs (not cards) ────────
    if (cmd === "pack" && focused.name === "tier" && interaction.guild) {
      const q = query.toLowerCase().trim();
      const [settings, customPacks] = await Promise.all([
        getOrCreateGuildSettings(interaction.guild.id),
        listCustomPacks(interaction.guild.id, false),
      ]);
      const builtInOptions = PACK_TIERS.map(t => {
        const meta = PACK_TIER_META[t];
        const label = tierLabel(settings, t);
        return { name: `${meta.emoji} ${label}`.slice(0, 100), value: t };
      });
      const customOptions = customPacks.map(p => ({
        name: `${p.emoji || "📦"} ${p.name}`.slice(0, 100),
        value: `custom:${p.id}`,
      }));
      const options = [...builtInOptions, ...customOptions];
      const filtered = !q
        ? options
        : options.filter(o => o.name.toLowerCase().includes(q) || o.value.toLowerCase().includes(q));
      await interaction.respond(filtered.slice(0, MAX_CHOICES));
      return;
    }

    // ── /edit_pack pack — this guild's custom packs (incl. disabled), NOT cards ──
    if (cmd === "editpack" && focused.name === "pack" && interaction.guild) {
      const q = query.toLowerCase().trim();
      const packs = await listCustomPacks(interaction.guild.id, true);
      const options = packs
        .filter(p => !q || p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q))
        .slice(0, MAX_CHOICES)
        .map(p => ({
          name: `${p.emoji || "📦"} ${p.name}${p.isActive ? "" : " (disabled)"}`.slice(0, 100),
          value: p.name.slice(0, 100),
        }));
      await interaction.respond(options);
      return;
    }

    // ── /rarity custom slug — show existing custom tiers by name ────────────
    if (cmd === "rarity" && focused.name === "slug" && interaction.guild) {
      const tiers = await getCustomRaritiesCached(interaction.guild.id);
      const q = query.toLowerCase().trim();
      const matches = tiers
        .filter(t => !q || t.name.toLowerCase().includes(q) || t.slug.includes(q))
        .slice(0, MAX_CHOICES)
        .map(t => ({ name: `${t.emoji} ${t.name}`.slice(0, 100), value: t.slug }));
      await interaction.respond(matches);
      return;
    }

    // ── All other card-name fields → full roster ────────────────────────────
    // /info, /drop, /give, /take_back, /trade.want, /wishlist add
    // Scope to THIS guild's roster only (getCardsCached returns [] without one).
    await interaction.respond(await suggestCardNames(query, interaction.guildId));
  } catch {
    try { await interaction.respond([]); } catch { /* ignore */ }
  }
}
