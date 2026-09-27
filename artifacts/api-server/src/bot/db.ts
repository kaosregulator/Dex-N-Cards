import {
  db, pool,
  cardsTable, collectionsTable, guildSettingsTable,
  adminUsersTable, spawnLogTable, userCurrencyTable, tradesTable,
  wishlistsTable, userTimeoutsTable, cardEventsTable,
  rarityProfilesTable,
  customRaritiesTable, cardRarityOverridesTable,
  rarityDisplayOverridesTable,
  cardDisplayOverridesTable,
  setsTable, cardSetMembershipsTable,
  customPacksTable, customPackCardsTable, userCustomPackWeekTable,
  calculatorMessagesTable, showcaseBackgroundsTable,
  battleBackgroundsTable,
} from "@workspace/db";
import { eq, and, or, sql, desc, inArray, isNull, type SQL } from "drizzle-orm";
import { fuzzyFindCard, bumpCardsSearchVersion } from "./search/fuse-service.js";
import { detectAnimatedImage } from "./image-url.js";
import type { Card, CardEvent, CardSet, CalculatorMessage, CustomPack, CustomPackCard, CustomRarity, GuildSettings, RarityProfile, Trade } from "@workspace/db";
import {
  DEFAULT_CARDS, SHINY_RATE, SHINY_MULTIPLIER, getRarityOrder, type Rarity,
  type RarityDisplayMap,
} from "./cards-data.js";
import {
  applyRarityProfile,
  applyRarityProfileAll,
  applyRarityContext,
  applyRarityContextAll,
  effectiveRarityKey,
  getCardDisplayRarity,
  getDisplayRarities,
  getGuildRarityWeights,
  isRandomDroppable,
  getEffectiveDropWeight,
  buildDropChanceSummary,
  buildRarityRankMap,
  type RarityProfileMap,
  type RarityContext,
} from "./rarity-runtime.js";
export {
  applyRarityProfile,
  applyRarityProfileAll,
  applyRarityContext,
  applyRarityContextAll,
  effectiveRarityKey,
  getCardDisplayRarity,
  getDisplayRarities,
  getGuildRarityWeights,
  isRandomDroppable,
  getEffectiveDropWeight,
  buildDropChanceSummary,
} from "./rarity-runtime.js";
export type {
  RarityProfileMap,
  RarityContext,
  DisplayRarity,
  DropWeightOptions,
  DropChanceSummary,
} from "./rarity-runtime.js";
import { logger } from "../lib/logger.js";
import { HOME_GUILD_ID, isHomeGuild, isVisibleTo, isOwnedBy } from "./home-guild.js";

// ── Per-guild rarity profile (worth/burn/dropWeight overrides) ───────────────
// One row per (guild, rarity). Any null column means "use the card's value".
// Tiny dataset (≤6 rows/guild) — cached for 5s like the cards cache. Caches
// per-guild so a write for one server doesn't pollute another's view.
const _profileCache = new Map<string, { value: RarityProfileMap; expiresAt: number }>();
const PROFILE_TTL_MS = 5_000;

export async function getRarityProfile(guildId: string): Promise<RarityProfileMap> {
  const cached = _profileCache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const rows = await db.select().from(rarityProfilesTable).where(eq(rarityProfilesTable.guildId, guildId));
  const map: RarityProfileMap = new Map();
  for (const r of rows) map.set(r.rarity as Rarity, r);
  _profileCache.set(guildId, { value: map, expiresAt: Date.now() + PROFILE_TTL_MS });
  return map;
}

export function invalidateRarityProfileCache(guildId?: string): void {
  if (guildId) _profileCache.delete(guildId);
  else _profileCache.clear();
}

// ── Custom Rarity Tiers (Stage 2) ────────────────────────────────────────────
// Per-guild context that bundles BOTH the Stage-1 rarity profile (per-tier
// numeric overrides for built-in rarities) AND Stage-2 custom tiers + card
// overrides. When a card is assigned to a custom tier, that tier's values
// REPLACE the card's worth/burn/dropWeight entirely — no layering with the
// Stage-1 profile for that card. For un-overridden cards the Stage-1
// profile still applies as before, so Server 1 (zero custom rows) is
// unchanged.
//
const _ctxCache = new Map<string, { value: RarityContext; expiresAt: number }>();
const CTX_TTL_MS = 5_000;

export async function getRarityContext(guildId: string): Promise<RarityContext> {
  const cached = _ctxCache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const [profile, customs, overrides, settings] = await Promise.all([
    getRarityProfile(guildId),
    db.select().from(customRaritiesTable).where(eq(customRaritiesTable.guildId, guildId)),
    db.select().from(cardRarityOverridesTable).where(eq(cardRarityOverridesTable.guildId, guildId)),
    getOrCreateGuildSettings(guildId),
  ]);
  const customBySlug = new Map<string, CustomRarity>();
  for (const c of customs) customBySlug.set(c.slug, c);
  const customByCard = new Map<number, CustomRarity>();
  for (const o of overrides) {
    const tier = customBySlug.get(o.customRaritySlug);
    if (tier) customByCard.set(o.cardId, tier);
  }
  const sorted = [...customs].sort((a, b) => a.position - b.position);
  // Strength ladder (single source of truth for rarity rank): built-ins in the
  // guild's configured order + custom tiers by position. Baked into the ctx so
  // battles/raids/stats rank identically.
  const order = getRarityOrder(settings);
  const rankByKey = buildRarityRankMap(order, sorted);
  const value: RarityContext = {
    guildId, profile, customByCard, customBySlug, customs: sorted,
    order, rankByKey, maxRank: Math.max(0, rankByKey.size - 1),
  };
  _ctxCache.set(guildId, { value, expiresAt: Date.now() + CTX_TTL_MS });
  return value;
}

export function invalidateRarityContextCache(guildId?: string): void {
  if (guildId) _ctxCache.delete(guildId);
  else _ctxCache.clear();
}

// ── Rarity Display Overrides (per-guild cosmetic rename of built-in tiers) ───
// Cosmetic layer only — does NOT affect economy values. One row per (guild,
// rarity). Cached for 5s per guild; invalidated on every write. Callers
// pass the returned map as the 3rd argument to rarityLabel/rarityEmoji/
// rarityColor in cards-data.ts, which applies it with highest priority.
const _displayCache = new Map<string, { value: RarityDisplayMap; expiresAt: number }>();
const DISPLAY_TTL_MS = 5_000;

export async function getRarityDisplayOverrides(guildId: string): Promise<RarityDisplayMap> {
  const cached = _displayCache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const rows = await db.select().from(rarityDisplayOverridesTable)
    .where(eq(rarityDisplayOverridesTable.guildId, guildId));
  const map: RarityDisplayMap = new Map();
  for (const r of rows) {
    map.set(r.rarity as Rarity, {
      displayName: r.displayName,
      emoji: r.emoji,
      color: r.color,
    });
  }
  _displayCache.set(guildId, { value: map, expiresAt: Date.now() + DISPLAY_TTL_MS });
  return map;
}

export function invalidateRarityDisplayCache(guildId?: string): void {
  if (guildId) _displayCache.delete(guildId);
  else _displayCache.clear();
}

export async function upsertRarityDisplayOverride(
  guildId: string,
  rarity: Rarity,
  patch: { displayName?: string | null; emoji?: string | null; color?: number | null },
  updatedBy?: string,
): Promise<void> {
  await db.insert(rarityDisplayOverridesTable)
    .values({ guildId, rarity, ...patch, updatedAt: new Date(), updatedBy: updatedBy ?? null })
    .onConflictDoUpdate({
      target: [rarityDisplayOverridesTable.guildId, rarityDisplayOverridesTable.rarity],
      set: { ...patch, updatedAt: new Date(), updatedBy: updatedBy ?? null },
    });
  invalidateRarityDisplayCache(guildId);
}

export async function clearRarityDisplayOverride(guildId: string, rarity: Rarity): Promise<void> {
  await db.delete(rarityDisplayOverridesTable).where(
    and(
      eq(rarityDisplayOverridesTable.guildId, guildId),
      eq(rarityDisplayOverridesTable.rarity, rarity),
    ),
  );
  invalidateRarityDisplayCache(guildId);
}

export async function clearAllRarityDisplayOverrides(guildId: string): Promise<void> {
  await db.delete(rarityDisplayOverridesTable)
    .where(eq(rarityDisplayOverridesTable.guildId, guildId));
  invalidateRarityDisplayCache(guildId);
}

export async function getGuildDropChanceRuntime(guildId: string) {
  const [settings, ctx, spawnPool, eventBoosts] = await Promise.all([
    getOrCreateGuildSettings(guildId),
    getRarityContext(guildId),
    getActiveSetSpawnPoolCached(guildId),
    getActiveEventBoosts(guildId),
  ]);
  const rarityWeights = getGuildRarityWeights(settings);
  const chanceSummary = buildDropChanceSummary(spawnPool.cards, {
    ctx,
    rarityWeights,
    setRarityWeights: spawnPool.rarityWeights,
    eventBoosts,
  });
  return { settings, ctx, spawnPool, rarityWeights, eventBoosts, chanceSummary };
}

// ── Seed / resync default cards ───────────────────────────────────────────────
// Defaults are now tracked purely
// via the first-class `sets` + `card_set_memberships` tables.
export const DEFAULTS_SET_NAME = "defaults";

// Seed defaults ONLY on a completely empty database — never re-sync or re-add
// after unload, so admin removals are permanent. Membership rows are added to
// the "defaults" set (created if missing) so the cards are immediately
// activatable via `/set_hub` / `/set_admin` (activate the "defaults" set).
// Force-add default cards (used by /loadset defaults). Skips names already in DB.
// Each newly-added card is also joined to the "defaults" set.
export async function loadDefaultCards(actorGuildId: string): Promise<{ added: number; skipped: number }> {
  let added = 0, skipped = 0;
  const defaultsSet = (await getSetByName(DEFAULTS_SET_NAME, actorGuildId)) ?? (await createSet(DEFAULTS_SET_NAME, undefined, actorGuildId));

  // Seed Vault Values "Exotic" as a custom tier between Legendary and Limited Edition.
  // /rarity remains source of truth — admins can rename/reorder afterward.
  let exotic = await getCustomRarityBySlug(actorGuildId, "exotic");
  if (!exotic) {
    exotic = await createCustomRarity(actorGuildId, {
      slug: "exotic",
      name: "Exotic",
      emoji: "🔥",
      position: 55, // between legendary (built-in) and Limited Edition (mythic)
      worthValue: 4000,
      burnValue: 2000,
      color: 0xff6b35,
      dropWeight: 0.5,
      droppable: true,
      inPacks: true,
    });
  }

  for (const card of DEFAULT_CARDS) {
    const { customRaritySlug, ...cardRow } = card;
    const existing = await getCardByName(card.name, actorGuildId);
    if (existing) {
      // Ensure existing copies are still members of the defaults set.
      await db.insert(cardSetMembershipsTable)
        .values({ setId: defaultsSet.id, cardId: existing.id })
        .onConflictDoNothing();
      if (customRaritySlug === "exotic") {
        await assignCardToCustomRarity(actorGuildId, existing.id, "exotic").catch(() => {});
      }
      skipped++;
      continue;
    }
    const [inserted] = await db.insert(cardsTable).values({ ...cardRow, guildId: actorGuildId }).onConflictDoNothing().returning({ id: cardsTable.id });
    if (inserted) {
      await db.insert(cardSetMembershipsTable)
        .values({ setId: defaultsSet.id, cardId: inserted.id })
        .onConflictDoNothing();
      if (customRaritySlug === "exotic") {
        await assignCardToCustomRarity(actorGuildId, inserted.id, "exotic").catch(() => {});
      }
      added++;
    }
  }
  invalidateActiveSetCardsCache();
  return { added, skipped };
}

// Remove all default-roster cards (and their FK dependents) — destructive.
export async function unloadDefaultCards(actorGuildId: string): Promise<{ removed: number }> {
  return deleteSetByName(DEFAULTS_SET_NAME, actorGuildId);
}

// Copy the home guild's largest set, including all of its cards, into a new
// server. The copied set is immediately set as the active spawn set so the
// server can use it right away. Every copied card is stamped with the actor
// guild's ID, so later edits, trades, burns, or deletes stay isolated to that
// server and never touch the home server or the dashboard.
export async function copyHomeSetTemplate(
  actorGuildId: string,
): Promise<{ copiedSetName: string | null; copiedCards: number; skipped: boolean }> {
  if (!HOME_GUILD_ID) {
    throw new Error("HOME_GUILD_ID is not configured — cannot copy home set template.");
  }
  if (actorGuildId === HOME_GUILD_ID) {
    return { copiedSetName: null, copiedCards: 0, skipped: true };
  }

  // Find the home guild's largest set (by card count).
  const rows = await db
    .select({
      id: setsTable.id,
      name: setsTable.name,
      description: setsTable.description,
      rarityWeights: setsTable.rarityWeights,
      awardsCompletion: setsTable.awardsCompletion,
      cardCount: sql<number>`count(${cardSetMembershipsTable.cardId})::int`,
    })
    .from(setsTable)
    .leftJoin(cardSetMembershipsTable, eq(cardSetMembershipsTable.setId, setsTable.id))
    .where(eq(setsTable.guildId, HOME_GUILD_ID))
    .groupBy(setsTable.id)
    .orderBy(sql`count(${cardSetMembershipsTable.cardId}) DESC`)
    .limit(1);

  const homeSet = rows[0];
  if (!homeSet) {
    return { copiedSetName: null, copiedCards: 0, skipped: true };
  }

  // Idempotent: don't overwrite if the actor already has this set.
  const existing = await getSetByName(homeSet.name, actorGuildId);
  if (existing) {
    return { copiedSetName: null, copiedCards: 0, skipped: true };
  }

  // Fetch every card in the home set so we can mirror it in the actor guild.
  const homeCards = await db.select({
    id: cardsTable.id,
    name: cardsTable.name,
    description: cardsTable.description,
    rarity: cardsTable.rarity,
    cardType: cardsTable.cardType,
    dropWeight: cardsTable.dropWeight,
    worthValue: cardsTable.worthValue,
    burnValue: cardsTable.burnValue,
    isLimitedEdition: cardsTable.isLimitedEdition,
    isEventExclusive: cardsTable.isEventExclusive,
    maxCopies: cardsTable.maxCopies,
    imageUrl: cardsTable.imageUrl,
    flavor: cardsTable.flavor,
    droppable: cardsTable.droppable,
    inPacks: cardsTable.inPacks,
    isArchived: cardsTable.isArchived,
    previewAnimation: cardsTable.previewAnimation,
    previewBgColor: cardsTable.previewBgColor,
    displayOrientation: cardsTable.displayOrientation,
  })
    .from(cardsTable)
    .innerJoin(cardSetMembershipsTable, eq(cardSetMembershipsTable.cardId, cardsTable.id))
    .where(eq(cardSetMembershipsTable.setId, homeSet.id));

  const newSet = await createSet(homeSet.name, homeSet.description ?? undefined, actorGuildId);
  if (homeSet.rarityWeights) {
    await setSetRarityWeights(newSet.id, homeSet.rarityWeights, actorGuildId);
  }
  if (homeSet.awardsCompletion) {
    await setSetAwardsCompletion(newSet.id, true, actorGuildId);
  }

  let copiedCards = 0;
  for (const homeCard of homeCards) {
    // If the actor already has a card with the same name, add that copy to the
    // set instead of creating a duplicate. This mirrors `loadDefaultCards`.
    const existingCard = await getCardByName(homeCard.name, actorGuildId);
    if (existingCard) {
      await db.insert(cardSetMembershipsTable)
        .values({ setId: newSet.id, cardId: existingCard.id })
        .onConflictDoNothing();
      continue;
    }

    const [inserted] = await db.insert(cardsTable)
      .values({
        guildId: actorGuildId,
        name: homeCard.name,
        description: homeCard.description,
        rarity: homeCard.rarity,
        cardType: homeCard.cardType,
        dropWeight: homeCard.dropWeight,
        worthValue: homeCard.worthValue,
        burnValue: homeCard.burnValue,
        isLimitedEdition: homeCard.isLimitedEdition,
        isEventExclusive: homeCard.isEventExclusive,
        maxCopies: homeCard.maxCopies,
        imageUrl: homeCard.imageUrl,
        flavor: homeCard.flavor,
        droppable: homeCard.droppable,
        inPacks: homeCard.inPacks,
        isArchived: homeCard.isArchived,
        previewAnimation: homeCard.previewAnimation,
        previewBgColor: homeCard.previewBgColor,
        displayOrientation: homeCard.displayOrientation,
      })
      .onConflictDoNothing()
      .returning({ id: cardsTable.id });
    if (inserted) {
      await db.insert(cardSetMembershipsTable)
        .values({ setId: newSet.id, cardId: inserted.id })
        .onConflictDoNothing();
      copiedCards++;
    }
  }

  // Make the copied set the active spawn set immediately so the server can use it.
  await setActiveSet(actorGuildId, newSet.id);
  invalidateCardCache();
  invalidateActiveSetCardsCache();
  return { copiedSetName: newSet.name, copiedCards, skipped: false };
}

// ── Card Sets ─────────────────────────────────────────────────────────────────
// ⚠️ REPLIT SAFETY REVIEW — STRICT PER-GUILD SET FILTER ⚠️
// Same strict model as cards: a set is only visible to the guild that owns it.
// No guildId → `false` (match nothing) so a forgotten guild arg leaks ZERO
// sets instead of every server's sets.
function setVisibilityFilter(viewerGuildId: string | null | undefined): SQL {
  if (!viewerGuildId) {
    logger.error(
      "[ISOLATION] setVisibilityFilter() called without a guildId — matching no rows to prevent a cross-server set leak.",
    );
    return sql`false`;
  }
  return eq(setsTable.guildId, viewerGuildId);
}

// Thin wrapper for legacy callers that expect the old `{ setName, cardCount }` shape.
export async function listSets(viewerGuildId?: string | null): Promise<Array<{ setName: string; cardCount: number }>> {
  const rows = await listSetsV2(viewerGuildId);
  return rows.map(r => ({ setName: r.set.name, cardCount: r.cardCount }));
}

// Delete every card in a set by NAME — destructive (used by `/unloadset` and
// `unloadDefaultCards`). Cards are looked up via the memberships junction.
// Cascades through collections, spawn_log, trades, and finally the set row itself.
export async function deleteSetByName(setName: string, actorGuildId: string): Promise<{ removed: number }> {
  const set = await getSetByName(setName, actorGuildId);
  if (!set) return { removed: 0 };
  if (!isOwnedBy(set, actorGuildId)) throw new Error("You can only delete sets owned by your server.");
  const members = await db.select({ cardId: cardSetMembershipsTable.cardId })
    .from(cardSetMembershipsTable).where(eq(cardSetMembershipsTable.setId, set.id));
  const ids = members.map(m => m.cardId);

  if (ids.length > 0) {
    await db.delete(collectionsTable).where(inArray(collectionsTable.cardId, ids));
    await db.delete(spawnLogTable).where(inArray(spawnLogTable.cardId, ids));
    await db.delete(tradesTable).where(
      sql`${tradesTable.offeredCardId} IN ${ids} OR ${tradesTable.requestedCardId} IN ${ids}`,
    );
    await db.delete(cardsTable).where(inArray(cardsTable.id, ids));
  }
  // Memberships cascade with cards, but if the set was empty we still drop
  // the set row to match the legacy "no traces left" semantics.
  await db.delete(setsTable).where(eq(setsTable.id, set.id));

  invalidateCardCache();
  invalidateActiveSetCardsCache();
  logger.info({ setName, removed: ids.length }, "Deleted card set");
  return { removed: ids.length };
}

// ── Card Sets v2 (first-class sets + memberships, Phase 1-3) ─────────────────
// Replaces the ad-hoc cards.set_name aggregation with a proper sets table +
// junction table. Guilds pick an active set via
// /set_hub · /set_admin — only its cards spawn (Option B: no active set = no
// random spawns).

function slugifySetName(raw: string): string {
  return raw.toLowerCase().trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// Resolve a set by its name (case-insensitive) within the viewer's guild.
// Returns undefined when missing. No cross-guild fallback.
export async function getSetByName(name: string, viewerGuildId?: string | null): Promise<CardSet | undefined> {
  const slug = slugifySetName(name);
  if (!slug) return undefined;
  if (!viewerGuildId) return undefined;
  const [row] = await db.select().from(setsTable)
    .where(and(eq(setsTable.guildId, viewerGuildId), sql`lower(${setsTable.name}) = ${slug}`))
    .limit(1);
  return row;
}

export async function getSetById(id: number, viewerGuildId?: string | null): Promise<CardSet | undefined> {
  const [row] = await db.select().from(setsTable).where(eq(setsTable.id, id)).limit(1);
  if (!row) return undefined;
  if (!isVisibleTo(row, viewerGuildId ?? null)) return undefined;
  return row;
}

/** Idempotent: returns existing set if one with this slug already exists. */
export async function createSet(name: string, description?: string, guildId?: string): Promise<CardSet> {
  const slug = slugifySetName(name);
  if (!slug) throw new Error("Set name must contain at least one letter or digit.");
  const ownerId = guildId ?? HOME_GUILD_ID ?? "unknown";
  const existing = await getSetByName(slug, ownerId);
  if (existing) return existing;
  const [row] = await db.insert(setsTable)
    .values({ name: slug, description: description ?? null, guildId: ownerId })
    .returning();
  invalidateActiveSetCardsCache();
  return row;
}

export async function renameSet(setId: number, newName: string, actorGuildId: string): Promise<CardSet | undefined> {
  const set = await getSetById(setId, actorGuildId);
  if (!set) return undefined;
  if (!isOwnedBy(set, actorGuildId)) throw new Error("You can only rename sets owned by your server.");
  const slug = slugifySetName(newName);
  if (!slug) throw new Error("New set name must contain at least one letter or digit.");
  const clash = await getSetByName(slug, actorGuildId);
  if (clash && clash.id !== setId) throw new Error(`A set named \`${slug}\` already exists in your server.`);
  const [row] = await db.update(setsTable)
    .set({ name: slug, updatedAt: new Date() })
    .where(eq(setsTable.id, setId))
    .returning();
  invalidateActiveSetCardsCache();
  return row;
}

/** Non-destructive — deletes the set row + membership rows only. Cards stay. */
export async function deleteSetById(setId: number, actorGuildId: string): Promise<{ removedMemberships: number }> {
  const set = await getSetById(setId, actorGuildId);
  if (!set) return { removedMemberships: 0 };
  if (!isOwnedBy(set, actorGuildId)) throw new Error("You can only delete sets owned by your server.");
  const memberships = await db.select({ cardId: cardSetMembershipsTable.cardId })
    .from(cardSetMembershipsTable).where(eq(cardSetMembershipsTable.setId, setId));
  await db.delete(setsTable).where(eq(setsTable.id, setId));
  // Cascade clears cardSetMembershipsTable rows automatically.
  invalidateActiveSetCardsCache();
  return { removedMemberships: memberships.length };
}

/** Non-destructive — deletes every set (and its memberships) owned by the
 * actor guild. Cards themselves are left untouched. */
export async function deleteAllSets(actorGuildId: string): Promise<{ deletedSets: number; removedMemberships: number }> {
  const rows = await listSetsV2(actorGuildId);
  if (rows.length === 0) return { deletedSets: 0, removedMemberships: 0 };
  const setIds = rows.map(r => r.set.id);
  const memberships = await db.select({ cardId: cardSetMembershipsTable.cardId, setId: cardSetMembershipsTable.setId })
    .from(cardSetMembershipsTable).where(inArray(cardSetMembershipsTable.setId, setIds));
  await db.delete(setsTable).where(inArray(setsTable.id, setIds));
  // Cascade clears memberships; clear active set if it pointed to one of these.
  await db.update(guildSettingsTable)
    .set({ activeSetId: null, updatedAt: new Date() })
    .where(and(eq(guildSettingsTable.guildId, actorGuildId), inArray(guildSettingsTable.activeSetId, setIds)));
  await db.update(guildSettingsTable)
    .set({ activeSetIdSecondary: null, updatedAt: new Date() })
    .where(and(eq(guildSettingsTable.guildId, actorGuildId), inArray(guildSettingsTable.activeSetIdSecondary, setIds)));
  invalidateActiveSetCardsCache();
  return { deletedSets: setIds.length, removedMemberships: memberships.length };
}

// A set can only contain cards from its own guild. It must never contain a
// card from another guild, and only the set's owner may modify its membership.
async function assertMembershipAllowed(setId: number, cardId: number, actorGuildId: string): Promise<void> {
  const [set, card] = await Promise.all([
    getSetById(setId, actorGuildId),
    getCardById(cardId, actorGuildId),
  ]);
  if (!set || !isOwnedBy(set, actorGuildId)) throw new Error("You can only modify sets owned by your server.");
  if (!card) throw new Error("Card not found or not available in your server.");
  if (set.guildId !== card.guildId) {
    throw new Error("Cards in a set must belong to the same server as the set.");
  }
}

export async function addCardToSet(setId: number, cardId: number, actorGuildId: string): Promise<{ added: boolean }> {
  await assertMembershipAllowed(setId, cardId, actorGuildId);
  const existing = await db.select({ cardId: cardSetMembershipsTable.cardId })
    .from(cardSetMembershipsTable)
    .where(and(eq(cardSetMembershipsTable.setId, setId), eq(cardSetMembershipsTable.cardId, cardId)))
    .limit(1);
  if (existing.length > 0) return { added: false };
  await db.insert(cardSetMembershipsTable).values({ setId, cardId });
  invalidateActiveSetCardsCache();
  return { added: true };
}

export async function removeCardFromSet(setId: number, cardId: number, actorGuildId: string): Promise<{ removed: boolean }> {
  await assertMembershipAllowed(setId, cardId, actorGuildId);
  const res = await db.delete(cardSetMembershipsTable)
    .where(and(eq(cardSetMembershipsTable.setId, setId), eq(cardSetMembershipsTable.cardId, cardId)))
    .returning({ cardId: cardSetMembershipsTable.cardId });
  if (res.length === 0) return { removed: false };
  invalidateActiveSetCardsCache();
  return { removed: true };
}

export async function moveCardBetweenSets(fromSetId: number, toSetId: number, cardId: number, actorGuildId: string): Promise<void> {
  await assertMembershipAllowed(fromSetId, cardId, actorGuildId);
  await assertMembershipAllowed(toSetId, cardId, actorGuildId);
  await db.delete(cardSetMembershipsTable)
    .where(and(eq(cardSetMembershipsTable.setId, fromSetId), eq(cardSetMembershipsTable.cardId, cardId)));
  await db.insert(cardSetMembershipsTable).values({ setId: toSetId, cardId }).onConflictDoNothing();
  invalidateActiveSetCardsCache();
}

/** Resolves names → ids leniently. Returns counts + any names not found.
 *  Uses a single bulk insert/delete instead of one round-trip per card. */
export async function bulkAddCardsToSet(
  setId: number, cardNames: string[], viewerGuildId?: string | null,
): Promise<{ added: number; alreadyIn: number; notFound: string[] }> {
  if (!viewerGuildId) throw new Error("Guild ID is required to modify a set.");
  const set = await getSetById(setId, viewerGuildId);
  if (!set || !isOwnedBy(set, viewerGuildId)) throw new Error("You can only modify sets owned by your server.");
  const all = await getAllCards(viewerGuildId);
  const byName = new Map(all.map(c => [c.name.toLowerCase(), c]));
  const notFound: string[] = [];
  const cardIds: number[] = [];
  for (const raw of cardNames) {
    const card = byName.get(raw.toLowerCase().trim());
    if (!card) { notFound.push(raw); continue; }
    cardIds.push(card.id);
  }
  if (cardIds.length === 0) return { added: 0, alreadyIn: 0, notFound };

  // Find which cards are already in the set
  const existing = await db.select({ cardId: cardSetMembershipsTable.cardId })
    .from(cardSetMembershipsTable)
    .where(and(
      eq(cardSetMembershipsTable.setId, setId),
      inArray(cardSetMembershipsTable.cardId, cardIds),
    ));
  const alreadySet = new Set(existing.map(r => r.cardId));
  const toAdd = cardIds.filter(id => !alreadySet.has(id));
  if (toAdd.length > 0) {
    await db.insert(cardSetMembershipsTable).values(
      toAdd.map(id => ({ setId, cardId: id })),
    );
    invalidateActiveSetCardsCache();
  }
  return { added: toAdd.length, alreadyIn: alreadySet.size, notFound };
}

export async function bulkRemoveCardsFromSet(
  setId: number, cardNames: string[], viewerGuildId?: string | null,
): Promise<{ removed: number; notInSet: number; notFound: string[] }> {
  if (!viewerGuildId) throw new Error("Guild ID is required to modify a set.");
  const set = await getSetById(setId, viewerGuildId);
  if (!set || !isOwnedBy(set, viewerGuildId)) throw new Error("You can only modify sets owned by your server.");
  const all = await getAllCards(viewerGuildId);
  const byName = new Map(all.map(c => [c.name.toLowerCase(), c]));
  const notFound: string[] = [];
  const cardIds: number[] = [];
  for (const raw of cardNames) {
    const card = byName.get(raw.toLowerCase().trim());
    if (!card) { notFound.push(raw); continue; }
    cardIds.push(card.id);
  }
  if (cardIds.length === 0) return { removed: 0, notInSet: 0, notFound };

  const res = await db.delete(cardSetMembershipsTable)
    .where(and(
      eq(cardSetMembershipsTable.setId, setId),
      inArray(cardSetMembershipsTable.cardId, cardIds),
    ))
    .returning({ cardId: cardSetMembershipsTable.cardId });
  const removedSet = new Set(res.map(r => r.cardId));
  const notInSet = cardIds.length - removedSet.size;
  if (removedSet.size > 0) invalidateActiveSetCardsCache();
  return { removed: removedSet.size, notInSet, notFound };
}

export async function getCardsInSet(setId: number, viewerGuildId?: string | null): Promise<Card[]> {
  const filter = cardVisibilityFilter(viewerGuildId);
  const where = filter
    ? and(eq(cardSetMembershipsTable.setId, setId), filter)
    : eq(cardSetMembershipsTable.setId, setId);
  return db.select({
    id: cardsTable.id, guildId: cardsTable.guildId, name: cardsTable.name, description: cardsTable.description,
    rarity: cardsTable.rarity, cardType: cardsTable.cardType, dropWeight: cardsTable.dropWeight,
    worthValue: cardsTable.worthValue, burnValue: cardsTable.burnValue,
    isLimitedEdition: cardsTable.isLimitedEdition, isEventExclusive: cardsTable.isEventExclusive,
    maxCopies: cardsTable.maxCopies, totalMinted: cardsTable.totalMinted,
    imageUrl: cardsTable.imageUrl, isAnimated: cardsTable.isAnimated, flavor: cardsTable.flavor,
    droppable: cardsTable.droppable, inPacks: cardsTable.inPacks,
    isArchived: cardsTable.isArchived, isBossCard: cardsTable.isBossCard,
    podiumPlace: cardsTable.podiumPlace,
    previewAnimation: cardsTable.previewAnimation, previewBgColor: cardsTable.previewBgColor,
    displayOrientation: cardsTable.displayOrientation,
    createdAt: cardsTable.createdAt,
  }).from(cardsTable)
    .innerJoin(cardSetMembershipsTable, eq(cardSetMembershipsTable.cardId, cardsTable.id))
    .where(where);
}

/**
 * Cards that aren't a member of ANY set. Used by set-hub export-all so a
 * single export gives admins a full backup even if some cards were never
 * assigned to a set (common on Server 2 where the legacy roster pre-dates
 * the sets system).
 */
export async function getUnassignedCards(viewerGuildId?: string | null): Promise<Card[]> {
  const filter = cardVisibilityFilter(viewerGuildId);
  const where = filter
    ? and(isNull(cardSetMembershipsTable.cardId), filter)
    : isNull(cardSetMembershipsTable.cardId);
  return db.select({
    id: cardsTable.id, guildId: cardsTable.guildId, name: cardsTable.name, description: cardsTable.description,
    rarity: cardsTable.rarity, cardType: cardsTable.cardType, dropWeight: cardsTable.dropWeight,
    worthValue: cardsTable.worthValue, burnValue: cardsTable.burnValue,
    isLimitedEdition: cardsTable.isLimitedEdition, isEventExclusive: cardsTable.isEventExclusive,
    maxCopies: cardsTable.maxCopies, totalMinted: cardsTable.totalMinted,
    imageUrl: cardsTable.imageUrl, isAnimated: cardsTable.isAnimated, flavor: cardsTable.flavor,
    droppable: cardsTable.droppable, inPacks: cardsTable.inPacks,
    isArchived: cardsTable.isArchived, isBossCard: cardsTable.isBossCard,
    podiumPlace: cardsTable.podiumPlace,
    previewAnimation: cardsTable.previewAnimation, previewBgColor: cardsTable.previewBgColor,
    displayOrientation: cardsTable.displayOrientation,
    createdAt: cardsTable.createdAt,
  }).from(cardsTable)
    .leftJoin(cardSetMembershipsTable, eq(cardSetMembershipsTable.cardId, cardsTable.id))
    .where(where);
}

/** Returns true iff a card belongs to a given set. O(1) round-trip. */
export async function isCardInSet(setId: number, cardId: number): Promise<boolean> {
  const [row] = await db.select({ cardId: cardSetMembershipsTable.cardId })
    .from(cardSetMembershipsTable)
    .where(and(eq(cardSetMembershipsTable.setId, setId), eq(cardSetMembershipsTable.cardId, cardId)))
    .limit(1);
  return !!row;
}

/** List all sets with card counts. Sorted by largest first. */
export async function listSetsV2(viewerGuildId?: string | null): Promise<Array<{ set: CardSet; cardCount: number }>> {
  const filter = setVisibilityFilter(viewerGuildId);
  const rows = await db.select({
    id: setsTable.id, guildId: setsTable.guildId, name: setsTable.name, description: setsTable.description,
    rarityWeights: setsTable.rarityWeights, awardsCompletion: setsTable.awardsCompletion,
    createdAt: setsTable.createdAt, updatedAt: setsTable.updatedAt,
    cardCount: sql<number>`coalesce(count(${cardSetMembershipsTable.cardId}), 0)::int`.as("card_count"),
  })
    .from(setsTable)
    .leftJoin(cardSetMembershipsTable, eq(cardSetMembershipsTable.setId, setsTable.id))
    .where(filter)
    .groupBy(setsTable.id);
  return rows
    .map(r => ({
      set: {
        id: r.id, guildId: r.guildId, name: r.name, description: r.description,
        rarityWeights: r.rarityWeights, awardsCompletion: r.awardsCompletion,
        createdAt: r.createdAt, updatedAt: r.updatedAt,
      } satisfies CardSet,
      cardCount: Number(r.cardCount),
    }))
    .sort((a, b) => b.cardCount - a.cardCount || a.set.name.localeCompare(b.set.name));
}

// ── Active set per guild ─────────────────────────────────────────────────────
export async function setActiveSet(guildId: string, setId: number): Promise<void> {
  await getOrCreateGuildSettings(guildId);
  await db.update(guildSettingsTable)
    .set({ activeSetId: setId, updatedAt: new Date() })
    .where(eq(guildSettingsTable.guildId, guildId));
  invalidateActiveSetCardsCache(guildId);
}

export async function clearActiveSet(guildId: string): Promise<void> {
  await db.update(guildSettingsTable)
    .set({ activeSetId: null, updatedAt: new Date() })
    .where(eq(guildSettingsTable.guildId, guildId));
  invalidateActiveSetCardsCache(guildId);
}

export async function getActiveSet(guildId: string): Promise<CardSet | null> {
  const settings = await getOrCreateGuildSettings(guildId);
  if (!settings.activeSetId) return null;
  const set = await getSetById(settings.activeSetId, guildId);
  return set ?? null;
}

// Spawn-pool cache: which cards are eligible for random spawns in this guild
// right now, plus the active set's per-tier weight overrides (if any). 5s
// TTL like the cards cache. Empty pool when no active set is selected
// (Option B: nothing spawns until an admin picks one).
type ActiveSetSpawnPool = { cards: Card[]; rarityWeights: Record<string, number> | null };
const _activeSetCardsCache = new Map<string, { value: ActiveSetSpawnPool; expiresAt: number }>();
const ACTIVE_SET_CACHE_TTL_MS = 5_000;

export async function getActiveSetSpawnPoolCached(guildId: string): Promise<ActiveSetSpawnPool> {
  const cached = _activeSetCardsCache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const settings = await getOrCreateGuildSettings(guildId);
  let pool: ActiveSetSpawnPool = { cards: [], rarityWeights: null };
  if (settings.activeSetId) {
    const [set, all] = await Promise.all([
      getSetById(settings.activeSetId, guildId),
      getCardsInSet(settings.activeSetId, guildId),
    ]);
    pool = {
      cards: all.filter(c => c.droppable && !c.isArchived),
      rarityWeights: set?.rarityWeights ?? null,
    };
  }
  _activeSetCardsCache.set(guildId, { value: pool, expiresAt: Date.now() + ACTIVE_SET_CACHE_TTL_MS });
  return pool;
}

// Per-set rarity-weight CRUD. Only the keys present in `weights` are kept;
// pass `null` to clear all overrides for the set. The cache is invalidated
// globally because we don't know which guild has this set active.
export async function setSetRarityWeights(
  setId: number,
  weights: Record<string, number> | null,
  actorGuildId: string,
): Promise<CardSet | undefined> {
  const set = await getSetById(setId, actorGuildId);
  if (!set) return undefined;
  if (!isOwnedBy(set, actorGuildId)) throw new Error("You can only edit sets owned by your server.");
  const [row] = await db.update(setsTable)
    .set({ rarityWeights: weights, updatedAt: new Date() })
    .where(eq(setsTable.id, setId))
    .returning();
  invalidateActiveSetCardsCache();
  return row;
}

export async function patchSetRarityWeight(
  setId: number,
  rarity: string,
  weight: number | null,
  actorGuildId: string,
): Promise<CardSet | undefined> {
  const existing = await getSetById(setId, actorGuildId);
  if (!existing) return undefined;
  if (!isOwnedBy(existing, actorGuildId)) throw new Error("You can only edit sets owned by your server.");
  const next = { ...(existing.rarityWeights ?? {}) };
  if (weight == null) delete next[rarity];
  else next[rarity] = weight;
  const cleaned = Object.keys(next).length > 0 ? next : null;
  return setSetRarityWeights(setId, cleaned, actorGuildId);
}

// P6: showcase toggle for set-completion achievements. Off by default.
export async function setSetAwardsCompletion(setId: number, enabled: boolean, actorGuildId: string): Promise<CardSet | undefined> {
  const set = await getSetById(setId, actorGuildId);
  if (!set) return undefined;
  if (!isOwnedBy(set, actorGuildId)) throw new Error("You can only edit sets owned by your server.");
  const [row] = await db.update(setsTable)
    .set({ awardsCompletion: enabled, updatedAt: new Date() })
    .where(eq(setsTable.id, setId))
    .returning();
  return row;
}

// P6: return IDs of every set the user has fully completed (owns every
// membership card) in this guild. Non-empty sets only — empty sets can't be
// "completed". Shinies don't matter here; ownership = collections row exists.
export async function getCompletedSetIds(guildId: string, userId: string): Promise<number[]> {
  const rows = await db.execute(sql<{ set_id: number }>`
    SELECT m.set_id
    FROM ${cardSetMembershipsTable} m
    LEFT JOIN ${collectionsTable} c
      ON c.card_id = m.card_id
     AND c.guild_id = ${guildId}
     AND c.user_id = ${userId}
    GROUP BY m.set_id
    HAVING COUNT(DISTINCT m.card_id) > 0
       AND COUNT(DISTINCT m.card_id) = COUNT(DISTINCT c.card_id)
  `);
  // drizzle .execute returns { rows } for pg
  const list = (rows as any).rows ?? rows;
  return (list as Array<{ set_id: number }>).map(r => Number(r.set_id));
}

// P6: every set flagged with awardsCompletion = true (for dynamic showcase
// achievement generation) within the viewer's guild. Per-guild scoped so one
// server's showcase sets don't leak into another's achievements.
export async function listShowcaseSets(viewerGuildId?: string | null): Promise<CardSet[]> {
  const filter = setVisibilityFilter(viewerGuildId);
  return db.select().from(setsTable).where(and(eq(setsTable.awardsCompletion, true), filter));
}

export function invalidateActiveSetCardsCache(guildId?: string): void {
  if (guildId) { _activeSetCardsCache.delete(guildId); _activeSetCardsCacheSecondary.delete(guildId); }
  else { _activeSetCardsCache.clear(); _activeSetCardsCacheSecondary.clear(); }
}

// ── Secondary spawn-pool cache ─────────────────────────────────────────────
const _activeSetCardsCacheSecondary = new Map<string, { value: ActiveSetSpawnPool; expiresAt: number }>();

export async function getActiveSetSpawnPoolCachedSecondary(guildId: string): Promise<ActiveSetSpawnPool> {
  const cached = _activeSetCardsCacheSecondary.get(guildId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const settings = await getOrCreateGuildSettings(guildId);
  let pool: ActiveSetSpawnPool = { cards: [], rarityWeights: null };
  if (settings.activeSetIdSecondary) {
    const [set, all] = await Promise.all([
      getSetById(settings.activeSetIdSecondary, guildId),
      getCardsInSet(settings.activeSetIdSecondary, guildId),
    ]);
    pool = {
      cards: all.filter(c => c.droppable && !c.isArchived),
      rarityWeights: set?.rarityWeights ?? null,
    };
  }
  _activeSetCardsCacheSecondary.set(guildId, { value: pool, expiresAt: Date.now() + ACTIVE_SET_CACHE_TTL_MS });
  return pool;
}

export async function setActiveSetSecondary(guildId: string, setId: number): Promise<void> {
  await getOrCreateGuildSettings(guildId);
  await db.update(guildSettingsTable)
    .set({ activeSetIdSecondary: setId, updatedAt: new Date() })
    .where(eq(guildSettingsTable.guildId, guildId));
  _activeSetCardsCacheSecondary.delete(guildId);
}

export async function clearActiveSetSecondary(guildId: string): Promise<void> {
  await db.update(guildSettingsTable)
    .set({ activeSetIdSecondary: null, updatedAt: new Date() })
    .where(eq(guildSettingsTable.guildId, guildId));
  _activeSetCardsCacheSecondary.delete(guildId);
}

export async function getActiveSetSecondary(guildId: string): Promise<CardSet | null> {
  const settings = await getOrCreateGuildSettings(guildId);
  if (!settings.activeSetIdSecondary) return null;
  const set = await getSetById(settings.activeSetIdSecondary);
  return set ?? null;
}

// ── Guild Settings ────────────────────────────────────────────────────────────
export async function getOrCreateGuildSettings(guildId: string): Promise<GuildSettings> {
  const [row] = await db
    .select().from(guildSettingsTable)
    .where(eq(guildSettingsTable.guildId, guildId)).limit(1);
  if (row) return row;
  const [created] = await db.insert(guildSettingsTable).values({ guildId }).returning();
  return created;
}

export async function updateGuildSettings(guildId: string, values: Partial<GuildSettings>) {
  await db
    .update(guildSettingsTable)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(guildSettingsTable.guildId, guildId));
}

// ── Admin Users ───────────────────────────────────────────────────────────────
export async function isAdmin(guildId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: adminUsersTable.id })
    .from(adminUsersTable)
    .where(and(eq(adminUsersTable.guildId, guildId), eq(adminUsersTable.userId, userId)));
  return rows.length > 0;
}

export async function addAdmin(guildId: string, userId: string, addedBy: string) {
  await db.insert(adminUsersTable).values({ guildId, userId, addedBy }).onConflictDoNothing();
}

export async function removeAdmin(guildId: string, userId: string) {
  await db.delete(adminUsersTable)
    .where(and(eq(adminUsersTable.guildId, guildId), eq(adminUsersTable.userId, userId)));
}

export async function listAdmins(guildId: string) {
  return db.select().from(adminUsersTable).where(eq(adminUsersTable.guildId, guildId));
}

// ── User Catch Timeouts ───────────────────────────────────────────────────────
export async function setUserTimeout(
  guildId: string, userId: string, expiresAt: Date, issuedBy: string, reason?: string,
): Promise<void> {
  // Clear any existing timeout for this user, then insert the new one.
  await db.delete(userTimeoutsTable)
    .where(and(eq(userTimeoutsTable.guildId, guildId), eq(userTimeoutsTable.userId, userId)));
  await db.insert(userTimeoutsTable).values({
    guildId, userId, expiresAt, issuedBy, reason: reason ?? null,
  });
}

export async function clearUserTimeout(guildId: string, userId: string): Promise<void> {
  await db.delete(userTimeoutsTable)
    .where(and(eq(userTimeoutsTable.guildId, guildId), eq(userTimeoutsTable.userId, userId)));
}

/** Returns the active timeout row if the user is currently timed-out, else null. */
export async function getUserTimeout(guildId: string, userId: string) {
  const [row] = await db.select().from(userTimeoutsTable)
    .where(and(
      eq(userTimeoutsTable.guildId, guildId),
      eq(userTimeoutsTable.userId, userId),
      sql`${userTimeoutsTable.expiresAt} > NOW()`,
    ))
    .limit(1);
  return row ?? null;
}

/** All active (non-expired) timeouts in a guild. */
export async function listActiveTimeouts(guildId: string) {
  return db.select().from(userTimeoutsTable)
    .where(and(
      eq(userTimeoutsTable.guildId, guildId),
      sql`${userTimeoutsTable.expiresAt} > NOW()`,
    ))
    .orderBy(userTimeoutsTable.expiresAt);
}

// ── Cards ─────────────────────────────────────────────────────────────────────
// Per-guild cache: home guild cards are shared, each other guild sees its own
// plus the home guild's cards. Dashboard/home-guild callers pass HOME_GUILD_ID.
const _cardsCache = new Map<string, { value: Card[]; expiresAt: number }>();
const CARD_CACHE_TTL_MS = 5_000;

function cardsCacheKey(viewerGuildId: string | null): string {
  return viewerGuildId ?? "__public__";
}

// ⚠️ REPLIT SAFETY REVIEW — STRICT PER-GUILD CARD FILTER ⚠️
// Builds the SQL predicate that scopes a card query to a single server. This is
// the strict model: a card is only ever visible to the guild that owns it.
//   • with a viewerGuildId → cards.guild_id = viewerGuildId
//   • WITHOUT a viewerGuildId → `false` (match nothing) so a query that forgot
//     to pass a guild leaks ZERO rows instead of every server's cards.
// Used by the set-membership reads (getCardsInSet / getUnassignedCards) that
// join cards to card_set_memberships and still need a guild predicate.
function cardVisibilityFilter(viewerGuildId?: string | null): SQL {
  if (!viewerGuildId) {
    logger.error(
      "[ISOLATION] cardVisibilityFilter() called without a guildId — matching no rows to prevent a cross-server card leak.",
    );
    return sql`false`;
  }
  return eq(cardsTable.guildId, viewerGuildId);
}

// ⚠️ REPLIT SAFETY REVIEW — CROSS-SERVER CARD ISOLATION ⚠️
// Cards are per-server (cards.guild_id). A card read WITHOUT a viewer guildId
// used to return EVERY server's cards — a cross-tenant leak (Server B seeing
// Server A's roster, spawning it, autocompleting it). To make that class of bug
// impossible, getAllCards now FAILS SAFE: no guildId → return [] and shout in
// the logs, instead of silently leaking. Intentional cross-guild maintenance
// (e.g. the market sweeper resolving card names for every due auction) must use
// getAllCardsAllGuilds() explicitly.
export async function getAllCards(viewerGuildId?: string | null | undefined): Promise<Card[]> {
  if (!viewerGuildId) {
    logger.error(
      "[ISOLATION] getAllCards() called without a guildId — returning [] to prevent a cross-server card leak. " +
      "Fix the caller to pass the viewer's guildId, or use getAllCardsAllGuilds() for intentional cross-guild maintenance.",
    );
    return [];
  }
  return db.select().from(cardsTable).where(eq(cardsTable.guildId, viewerGuildId));
}

// Explicit, INTERNAL-ONLY cross-guild read. Never expose the result to a player
// or a per-guild flow — only for global maintenance (market sweeper, isolation
// self-check). Kept deliberately verbose so a code search flags every use.
export async function getAllCardsAllGuilds(): Promise<Card[]> {
  return db.select().from(cardsTable);
}

// Cached variant for the hot path (spawn embeds, catch embeds, decision buttons).
// 5s TTL keeps it fresh while eliminating repeated DB round-trips. Same fail-safe
// rule: no guildId → [] (never a cross-server leak).
export async function getAllCardsCached(viewerGuildId?: string | null | undefined): Promise<Card[]> {
  if (!viewerGuildId) {
    logger.error("[ISOLATION] getAllCardsCached() called without a guildId — returning [] to prevent a cross-server card leak.");
    return [];
  }
  const key = cardsCacheKey(viewerGuildId);
  const cached = _cardsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const cards = await getAllCards(viewerGuildId);
  _cardsCache.set(key, { value: cards, expiresAt: Date.now() + CARD_CACHE_TTL_MS });
  return cards;
}

export function invalidateCardCache(): void {
  _cardsCache.clear();
  // Card data changed → let the shared fuzzy-search index rebuild lazily.
  bumpCardsSearchVersion();
}

export async function getCardByName(name: string, viewerGuildId?: string | null | undefined): Promise<Card | undefined> {
  const slug = name.trim().toLowerCase();
  if (!viewerGuildId) return undefined;
  // Strictly within the viewer's guild.
  const [local] = await db.select().from(cardsTable)
    .where(and(eq(cardsTable.guildId, viewerGuildId), sql`lower(${cardsTable.name}) = ${slug}`))
    .limit(1);
  if (local) return local;
  // Fallback: if the name didn't match cards.name, try card_display_overrides.display_name
  // — but only if the override points to a card visible in this guild.
  const [override] = await db
    .select({ cardId: cardDisplayOverridesTable.cardId })
    .from(cardDisplayOverridesTable)
    .where(sql`lower(${cardDisplayOverridesTable.displayName}) = ${slug}`)
    .limit(1);
  if (override) return getCardById(override.cardId, viewerGuildId);
  // Last resort: fuzzy match (typos / partial / acronym) via the shared search
  // service, so every command that resolves a card by name (info, burn, frame,
  // level, lock, market, raid admin, …) tolerates imperfect input — no per-call
  // duplication. Uses the cached per-guild card index.
  const roster = await getAllCardsCached(viewerGuildId);
  return fuzzyFindCard(viewerGuildId, roster, name);
}

export async function getCardById(id: number, viewerGuildId?: string | null): Promise<Card | undefined> {
  const [card] = await db.select().from(cardsTable).where(eq(cardsTable.id, id));
  if (!card) return undefined;
  if (!isVisibleTo(card, viewerGuildId ?? null)) return undefined;
  return card;
}

// Flag an existing card as a boss card (untradeable by default; see
// guildSettings.allowBossCardTrades). Used when an admin links an EXISTING
// card as a raid boss's reward instead of auto-creating a new one.
export async function markCardAsBoss(cardId: number): Promise<void> {
  await db.update(cardsTable).set({ isBossCard: true }).where(eq(cardsTable.id, cardId));
  invalidateCardCache();
}

export async function addCard(values: {
  name: string; description: string; rarity: string; cardType?: string;
  dropWeight: number; worthValue: number; burnValue: number;
  isLimitedEdition?: boolean; isEventExclusive?: boolean;
  maxCopies?: number; imageUrl?: string; flavor?: string; droppable?: boolean;
  inPacks?: boolean; isBossCard?: boolean;
}, guildId: string) {
  // Flag animated-GIF art so render paths route it to the live GIF instead of a
  // flattened canvas frame. Best-effort — a failed sniff just leaves it false.
  const isAnimated = await detectAnimatedImage(values.imageUrl).catch(() => false);
  try {
    const [card] = await db.insert(cardsTable).values({ ...values as any, isAnimated, guildId }).returning();
    await db.update(cardsTable).set({ totalMinted: 0 }).where(eq(cardsTable.id, card.id));
    invalidateCardCache();
    return card;
  } catch (err) {
    const msg = String(err ?? "") + " " + String((err as any)?.cause ?? "");
    if (msg.includes("duplicate key") && msg.includes("cards_pkey")) {
      // Sequence fell behind the table (common after a restore/import with explicit IDs).
      // Allocate the next free id explicitly and bump the sequence so the default path works again.
      const maxRow = await db.select({ max: sql<number>`MAX(id)` }).from(cardsTable);
      const nextId = (maxRow[0]?.max ?? 0) + 1;
      await db.execute(sql`SELECT setval(pg_get_serial_sequence('cards', 'id'), ${nextId}, true)`);
      const [card] = await db.insert(cardsTable).values({ id: nextId, ...values as any, isAnimated, guildId }).returning();
      await db.update(cardsTable).set({ totalMinted: 0 }).where(eq(cardsTable.id, card.id));
      invalidateCardCache();
      return card;
    }
    throw err;
  }
}

export async function removeCard(name: string, actorGuildId: string) {
  const card = await getCardByName(name, actorGuildId);
  if (!card) return;
  if (!isOwnedBy(card, actorGuildId)) throw new Error("You can only delete cards owned by your server.");
  const id = card.id;
  await db.transaction(async (tx) => {
    await tx.delete(collectionsTable).where(eq(collectionsTable.cardId, id));
    await tx.delete(spawnLogTable).where(eq(spawnLogTable.cardId, id));
    await tx.delete(tradesTable).where(
      sql`${tradesTable.offeredCardId} = ${id} OR ${tradesTable.requestedCardId} = ${id}`,
    );
    await tx.delete(cardsTable).where(eq(cardsTable.id, id));
  });
  invalidateCardCache();
  invalidateActiveSetCardsCache();
}

export async function updateCard(cardId: number, values: Partial<{
  name: string; description: string; rarity: string; cardType: string;
  dropWeight: number; worthValue: number; burnValue: number;
  isLimitedEdition: boolean; isEventExclusive: boolean; isArchived: boolean; inPacks: boolean;
  maxCopies: number | null; totalMinted: number; imageUrl: string | null; flavor: string | null; droppable: boolean;
}>) {
  // Re-sniff the animated flag whenever the image changes so a card swapped to
  // (or away from) a GIF updates how it's rendered. Only when imageUrl is in the
  // patch — other edits leave the existing flag untouched.
  const patch: Record<string, unknown> = { ...values };
  if ("imageUrl" in values) {
    patch["isAnimated"] = await detectAnimatedImage(values.imageUrl).catch(() => false);
  }
  const [updated] = await db.update(cardsTable).set(patch as any).where(eq(cardsTable.id, cardId)).returning();
  invalidateCardCache();
  // `droppable` / `isArchived` flips change whether this card belongs in any
  // guild's active-set spawn pool. Blow the per-guild cache so the next
  // spawn re-reads from DB. (Other fields don't affect membership but the
  // cache invalidation is cheap — a guard would be premature optimization.)
  invalidateActiveSetCardsCache();
  return updated;
}

// ── Weighted Random Card Pick (with optional guild rarity weight overrides) ────
// `eventBoosts` multiplies a card's effective weight when an active event
// targets it (see card_events). Applied AFTER the rarity-tier override so
// admins can boost a card above its tier's baseline without bumping the
// whole tier.
export async function pickRandomCard(
  rarityWeights?: Record<string, number>,
  eventBoosts?: Map<number, number>,
  ctx?: RarityContext,
  availableCards?: Card[],
  setRarityWeights?: Record<string, number> | null,
): Promise<Card | undefined> {
  // When the caller passes `availableCards`, trust it as-is (already filtered
  // — e.g. by guild active set). Spawn-manager and pack-grant ALWAYS provide
  // `availableCards` (already scoped to the actor's guild), so this fallback
  // should never fire in practice. If it ever does, we must NOT reach for a
  // global pool — that would spawn one server's cards into another. Fail safe
  // to an empty pool and shout in the logs. ⚠️ REPLIT SAFETY REVIEW ⚠️
  if (!availableCards) {
    logger.error(
      "[ISOLATION] pickRandomCard() called without availableCards — refusing to fall back to a cross-guild pool. " +
      "Returning no card. The caller must pass a guild-scoped card list.",
    );
  }
  let cards = availableCards ?? [];
  // Respect each custom tier's `droppable` flag — a card assigned to a
  // non-droppable custom tier is excluded from random spawns even if its own
  // column says droppable=true.
  cards = cards.filter(c => isRandomDroppable(c, ctx));
  if (cards.length === 0) return undefined;

  // Event boost multiplies whichever base wins so admins can still spike a
  // single card above its tier baseline. Note: set weights are read from a
  // PARTIAL map — keys the admin didn't override fall through.
  const getWeight = (card: Card) => getEffectiveDropWeight(card, {
    rarityWeights,
    eventBoosts,
    ctx,
    setRarityWeights,
  });

  const totalWeight = cards.reduce((sum, c) => sum + getWeight(c), 0);
  if (totalWeight <= 0) {
    logger.debug(
      { pool: cards.length, hasSetWeights: !!setRarityWeights },
      "pickRandomCard: total effective weight is 0 — no spawn this tick",
    );
    return undefined;
  }
  let rand = Math.random() * totalWeight;
  for (const card of cards) {
    rand -= getWeight(card);
    if (rand <= 0) return card;
  }
  return cards[cards.length - 1];
}

// ── Collections ───────────────────────────────────────────────────────────────
// Acquisition entry point for catches, pack opens, tradein rewards, and
// admin /give. Rolls Shiny once per copy unless `opts.noShiny` is set
// (admin /give skips the roll for predictability). The roll is bot-side
// before the DB write — caller sees the result and surfaces ✨ in the UI.
export async function catchCard(
  guildId: string, userId: string, cardId: number,
  opts?: {
    noShiny?: boolean;
    // When set, roll this source's configured Star/Level and apply it to the
    // shared card_progress row (variable acquisition). Best-effort: with no
    // config the card arrives at 0★ / Lv 1, exactly as before.
    acquisitionSource?: import("@workspace/db").AcquisitionSource;
    // Explicit Star/Level (admin /give /drop) — wins over acquisitionSource.
    forcedProgression?: { starRank: number; level: number };
  },
): Promise<{ isShiny: boolean; progression: import("./cards/progression.js").CardProgressionGrant | null }> {
  const isShiny = !opts?.noShiny && Math.random() < SHINY_RATE;

  // Atomic upsert — the (guild_id, user_id, card_id) unique index makes this
  // race-safe so two simultaneous catches of the same card can never create
  // duplicate collection rows. We increment whichever counter applies; the
  // OTHER counter is left untouched via the column-default trick on insert
  // and an explicit set: shinyCount/count on conflict.
  if (isShiny) {
    await db.insert(collectionsTable)
      .values({ guildId, userId, cardId, count: 0, shinyCount: 1 })
      .onConflictDoUpdate({
        target: [collectionsTable.guildId, collectionsTable.userId, collectionsTable.cardId],
        set: {
          shinyCount: sql`${collectionsTable.shinyCount} + 1`,
          lastCaughtAt: new Date(),
        },
      });
  } else {
    await db.insert(collectionsTable)
      .values({ guildId, userId, cardId, count: 1 })
      .onConflictDoUpdate({
        target: [collectionsTable.guildId, collectionsTable.userId, collectionsTable.cardId],
        set: {
          count: sql`${collectionsTable.count} + 1`,
          lastCaughtAt: new Date(),
        },
      });
  }

  await db.update(cardsTable)
    .set({ totalMinted: sql`${cardsTable.totalMinted} + 1` })
    .where(eq(cardsTable.id, cardId));

  // ── Variable acquisition progression ────────────────────────────────────────
  // Bump the shared card_progress row so a card can arrive pre-levelled / fused.
  // Dynamically imported to avoid any load-time cycle; fully best-effort.
  let progression: import("./cards/progression.js").CardProgressionGrant | null = null;
  try {
    if (opts?.forcedProgression || opts?.acquisitionSource) {
      const prog = await import("./cards/progression.js");
      progression = opts.forcedProgression
        ? await prog.grantCardProgression(guildId, userId, cardId, opts.forcedProgression)
        : await prog.rollAndGrantProgression(guildId, userId, cardId, opts.acquisitionSource!);
    }
  } catch (err) {
    logger.warn({ err, guildId, userId, cardId }, "catchCard: acquisition progression failed (non-fatal)");
  }

  return { isShiny, progression };
}

/**
 * Admin bulk giveaway: give one copy of a card to a user with explicit shiny
 * control. Increments `totalMinted` just like a normal catch. Use this for
 * deterministic /give-all-style commands where the caller already rolled
 * the shiny chance.
 */
export async function giveCardCopy(
  guildId: string,
  userId: string,
  cardId: number,
  isShiny: boolean,
): Promise<void> {
  if (isShiny) {
    await db.insert(collectionsTable)
      .values({ guildId, userId, cardId, count: 0, shinyCount: 1 })
      .onConflictDoUpdate({
        target: [collectionsTable.guildId, collectionsTable.userId, collectionsTable.cardId],
        set: {
          shinyCount: sql`${collectionsTable.shinyCount} + 1`,
          lastCaughtAt: new Date(),
        },
      });
  } else {
    await db.insert(collectionsTable)
      .values({ guildId, userId, cardId, count: 1 })
      .onConflictDoUpdate({
        target: [collectionsTable.guildId, collectionsTable.userId, collectionsTable.cardId],
        set: {
          count: sql`${collectionsTable.count} + 1`,
          lastCaughtAt: new Date(),
        },
      });
  }

  await db.update(cardsTable)
    .set({ totalMinted: sql`${cardsTable.totalMinted} + 1` })
    .where(eq(cardsTable.id, cardId));
}

/**
 * Restore a card copy to a user's collection WITHOUT touching the global
 * `totalMinted` counter. Use this when refunding a card that was previously
 * removed by `removeCardFromUser` (e.g. a failed /trade_in) — the card was
 * never destroyed from the world's perspective, so the mint count shouldn't
 * move. For genuine new mints (drops, packs, admin gives) use `catchCard`.
 */
export async function restoreCardToUser(guildId: string, userId: string, cardId: number) {
  await db.insert(collectionsTable)
    .values({ guildId, userId, cardId, count: 1 })
    .onConflictDoUpdate({
      target: [collectionsTable.guildId, collectionsTable.userId, collectionsTable.cardId],
      set: {
        count: sql`${collectionsTable.count} + 1`,
        lastCaughtAt: new Date(),
      },
    });
}

export async function removeCardFromUser(
  guildId: string, userId: string, cardId: number,
): Promise<{ success: boolean; remaining: number }> {
  const [entry] = await db.select().from(collectionsTable)
    .where(and(
      eq(collectionsTable.guildId, guildId),
      eq(collectionsTable.userId, userId),
      eq(collectionsTable.cardId, cardId),
    ));
  if (!entry || entry.count < 1) return { success: false, remaining: 0 };

  const newCount = entry.count - 1;
  // Only delete the row when BOTH piles are empty — otherwise we'd silently
  // erase the user's shinies for this card when their last normal copy goes
  // (tradein/takeback/etc. only consume the normal pile in v1).
  if (newCount === 0 && entry.shinyCount === 0) {
    await db.delete(collectionsTable).where(eq(collectionsTable.id, entry.id));
  } else {
    await db.update(collectionsTable).set({ count: newCount }).where(eq(collectionsTable.id, entry.id));
  }
  return { success: true, remaining: newCount };
}

export async function getUserCollection(guildId: string, userId: string) {
  const rows = await db.select({
    cardId: collectionsTable.cardId,
    count: collectionsTable.count,
    shinyCount: collectionsTable.shinyCount,
    firstCaughtAt: collectionsTable.firstCaughtAt,
    name: cardsTable.name,
    rarity: cardsTable.rarity,
    cardType: cardsTable.cardType,
    description: cardsTable.description,
    worthValue: cardsTable.worthValue,
    burnValue: cardsTable.burnValue,
    dropWeight: cardsTable.dropWeight,
    isLimitedEdition: cardsTable.isLimitedEdition,
    isEventExclusive: cardsTable.isEventExclusive,
    imageUrl: cardsTable.imageUrl,
  }).from(collectionsTable)
    .innerJoin(cardsTable, eq(collectionsTable.cardId, cardsTable.id))
    .where(and(
      eq(collectionsTable.guildId, guildId),
      eq(collectionsTable.userId, userId),
      // Hide rows that have been fully burned down to zero of both.
      sql`(${collectionsTable.count} + ${collectionsTable.shinyCount}) > 0`,
    ));
  // Apply the per-guild rarity context (Stage-1 profile + Stage-2 custom
  // tiers) so worth/burn shown in /collection, /rank, /catalog, leaderboard
  // net worth, etc. all reflect server overrides AND custom-tier overrides.
  const ctx = await getRarityContext(guildId);
  const enriched = rows.map(r => ({ ...r, id: r.cardId })) as Array<typeof rows[number] & { id: number }>;
  return applyRarityContextAll(enriched, ctx);
}

export async function getUserCardCount(guildId: string, userId: string): Promise<{ unique: number; total: number; netWorth: number }> {
  const items = await getUserCollection(guildId, userId);
  return {
    unique: items.length,
    total: items.reduce((s, i) => s + i.count + i.shinyCount, 0),
    netWorth: items.reduce(
      (s, i) => s + i.worthValue * (i.count + i.shinyCount * SHINY_MULTIPLIER),
      0,
    ),
  };
}

export async function getCollectionEntry(guildId: string, userId: string, cardId: number) {
  const [row] = await db.select().from(collectionsTable)
    .where(and(
      eq(collectionsTable.guildId, guildId),
      eq(collectionsTable.userId, userId),
      eq(collectionsTable.cardId, cardId),
    ));
  return row;
}

// ── Leaderboard ───────────────────────────────────────────────────────────────
// Computes per-user totals with rarity-profile overrides applied. We pull
// per-(user,card) rows and group in JS so that worth uses the profile's
// override when present (per-rarity), falling back to the card's own value.
// Dataset is small (one row per held card per user per guild).
export async function getLeaderboard(guildId: string, sortBy: "worth" | "cards" = "worth", limit = 10) {
  const rows = await db.select({
    userId: collectionsTable.userId,
    rarity: cardsTable.rarity,
    worthValue: cardsTable.worthValue,
    count: collectionsTable.count,
    shinyCount: collectionsTable.shinyCount,
    cardId: collectionsTable.cardId,
  })
    .from(collectionsTable)
    .innerJoin(cardsTable, eq(collectionsTable.cardId, cardsTable.id))
    .where(eq(collectionsTable.guildId, guildId));

  const ctx = await getRarityContext(guildId);
  type Agg = { userId: string; totalCards: number; uniqueCards: number; netWorth: number };
  const byUser = new Map<string, Agg>();
  for (const r of rows) {
    // Custom-tier worth replaces the card's worth entirely; otherwise fall
    // back to the Stage-1 profile, then the card's own worth.
    const customTier = ctx.customByCard.get(r.cardId);
    const worth = customTier
      ? customTier.worthValue
      : (ctx.profile.get(r.rarity as Rarity)?.worthValue ?? r.worthValue);
    let a = byUser.get(r.userId);
    if (!a) { a = { userId: r.userId, totalCards: 0, uniqueCards: 0, netWorth: 0 }; byUser.set(r.userId, a); }
    a.totalCards += r.count + r.shinyCount;
    a.uniqueCards += 1; // one row per (user,card)
    a.netWorth += (r.count + r.shinyCount * SHINY_MULTIPLIER) * worth;
  }
  const sorted = [...byUser.values()].sort((a, b) =>
    sortBy === "cards" ? b.totalCards - a.totalCards : b.netWorth - a.netWorth,
  );
  return sorted.slice(0, limit);
}

// Lifetime pack openers per guild (sorted desc). Used by /top.
export async function getTopPackOpeners(guildId: string, limit = 5) {
  return db.select({
    userId: userCurrencyTable.userId,
    packsOpened: userCurrencyTable.packsOpened,
  })
    .from(userCurrencyTable)
    .where(and(eq(userCurrencyTable.guildId, guildId), sql`${userCurrencyTable.packsOpened} > 0`))
    .orderBy(sql`${userCurrencyTable.packsOpened} desc`)
    .limit(limit);
}

// ── Currency (DN Shards) ──────────────────────────────────────────────────────
export async function getOrCreateCurrency(guildId: string, userId: string) {
  const [row] = await db.select().from(userCurrencyTable)
    .where(and(eq(userCurrencyTable.guildId, guildId), eq(userCurrencyTable.userId, userId)));
  if (row) return row;
  const [created] = await db.insert(userCurrencyTable).values({ guildId, userId }).returning();
  return created;
}

// Atomic: never lose increments under concurrent callers.
export async function addShards(guildId: string, userId: string, amount: number) {
  await getOrCreateCurrency(guildId, userId);
  const earnedDelta = Math.max(0, amount);
  await db.update(userCurrencyTable)
    .set({
      shards: sql`${userCurrencyTable.shards} + ${amount}`,
      totalEarned: sql`${userCurrencyTable.totalEarned} + ${earnedDelta}`,
      updatedAt: new Date(),
    })
    .where(and(eq(userCurrencyTable.guildId, guildId), eq(userCurrencyTable.userId, userId)));
}

// Atomic: never goes below 0 even under concurrency.
export async function deductShards(guildId: string, userId: string, amount: number): Promise<{ success: boolean; remaining: number }> {
  await getOrCreateCurrency(guildId, userId);
  const [row] = await db.update(userCurrencyTable)
    .set({
      shards: sql`GREATEST(0, ${userCurrencyTable.shards} - ${amount})`,
      updatedAt: new Date(),
    })
    .where(and(eq(userCurrencyTable.guildId, guildId), eq(userCurrencyTable.userId, userId)))
    .returning({ shards: userCurrencyTable.shards });
  if (!row) return { success: false, remaining: 0 };
  return { success: row.shards >= 0, remaining: row.shards };
}

// Atomic: only deducts if balance >= amount. Returns false if insufficient.
export async function spendShards(guildId: string, userId: string, amount: number): Promise<boolean> {
  await getOrCreateCurrency(guildId, userId);
  const rows = await db.update(userCurrencyTable)
    .set({
      shards: sql`${userCurrencyTable.shards} - ${amount}`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(userCurrencyTable.guildId, guildId),
      eq(userCurrencyTable.userId, userId),
      sql`${userCurrencyTable.shards} >= ${amount}`,
    ))
    .returning({ id: userCurrencyTable.id });
  return rows.length > 0;
}

// Atomic refund — credit shards back without affecting totalEarned.
export async function refundShards(guildId: string, userId: string, amount: number) {
  await getOrCreateCurrency(guildId, userId);
  await db.update(userCurrencyTable)
    .set({
      shards: sql`${userCurrencyTable.shards} + ${amount}`,
      updatedAt: new Date(),
    })
    .where(and(eq(userCurrencyTable.guildId, guildId), eq(userCurrencyTable.userId, userId)));
}

// ── Scrap currency (second currency, earned via ♻️ Recycle) ──────────────────

export async function getScrap(guildId: string, userId: string): Promise<number> {
  const row = await getOrCreateCurrency(guildId, userId);
  return (row as Record<string, unknown>).scrap as number ?? 0;
}

// Atomic: adds scrap (never affect totalEarned — scrap has its own ledger).
export async function addScrap(guildId: string, userId: string, amount: number) {
  await getOrCreateCurrency(guildId, userId);
  await db.update(userCurrencyTable)
    .set({
      scrap: sql`${userCurrencyTable.scrap} + ${amount}`,
      updatedAt: new Date(),
    })
    .where(and(eq(userCurrencyTable.guildId, guildId), eq(userCurrencyTable.userId, userId)));
}

// ── Burn a card ───────────────────────────────────────────────────────────────
export async function incrementCardsBurned(guildId: string, userId: string, by: number = 1) {
  await getOrCreateCurrency(guildId, userId);
  await db.update(userCurrencyTable)
    .set({ cardsBurned: sql`${userCurrencyTable.cardsBurned} + ${by}` })
    .where(and(eq(userCurrencyTable.guildId, guildId), eq(userCurrencyTable.userId, userId)));
}

export async function getUserOwnedCount(
  guildId: string, userId: string, cardId: number,
): Promise<{ count: number; shinyCount: number }> {
  const [row] = await db.select({
    count: collectionsTable.count,
    shinyCount: collectionsTable.shinyCount,
  })
    .from(collectionsTable)
    .where(and(
      eq(collectionsTable.guildId, guildId),
      eq(collectionsTable.userId, userId),
      eq(collectionsTable.cardId, cardId),
    ));
  return { count: row?.count ?? 0, shinyCount: row?.shinyCount ?? 0 };
}

// Burns from the `count` column by default, or the `shinyCount` column when
// `opts.shiny` is set. Atomic: one concurrent burn wins the row. Shiny burns
// pay SHINY_MULTIPLIER × burnValue per copy. `remaining` is of the chosen
// pile (normal or shiny).
export async function burnCard(
  guildId: string, userId: string, cardId: number, amount: number = 1,
  opts?: { shiny?: boolean },
): Promise<{ success: boolean; burned: number; shardsGained: number; remaining: number; isShiny: boolean }> {
  if (amount < 1) return { success: false, burned: 0, shardsGained: 0, remaining: 0, isShiny: !!opts?.shiny };
  const [card] = await db.select({ burnValue: cardsTable.burnValue, rarity: cardsTable.rarity })
    .from(cardsTable).where(eq(cardsTable.id, cardId));
  if (!card) return { success: false, burned: 0, shardsGained: 0, remaining: 0, isShiny: !!opts?.shiny };
  // Per-guild rarity context may override the card's burnValue, either via
  // a Stage-2 custom tier (replaces) or a Stage-1 profile (per built-in tier).
  const ctx = await getRarityContext(guildId);
  const customTier = ctx.customByCard.get(cardId);
  const effectiveBurnValue = customTier
    ? customTier.burnValue
    : (ctx.profile.get(card.rarity as Rarity)?.burnValue ?? card.burnValue);

  const burningShiny = !!opts?.shiny;
  const targetCol = burningShiny ? collectionsTable.shinyCount : collectionsTable.count;

  const updated = await db.update(collectionsTable)
    .set(burningShiny
      ? { shinyCount: sql`${collectionsTable.shinyCount} - ${amount}` }
      : { count: sql`${collectionsTable.count} - ${amount}` })
    .where(and(
      eq(collectionsTable.guildId, guildId),
      eq(collectionsTable.userId, userId),
      eq(collectionsTable.cardId, cardId),
      sql`${targetCol} >= ${amount}`,
    ))
    .returning({
      id: collectionsTable.id,
      count: collectionsTable.count,
      shinyCount: collectionsTable.shinyCount,
    });
  if (updated.length === 0) return { success: false, burned: 0, shardsGained: 0, remaining: 0, isShiny: burningShiny };

  const row = updated[0]!;
  // Only delete the row when BOTH counters are zero — a user may have burned
  // their last normal copy but still own a shiny (or vice versa).
  if (row.count === 0 && row.shinyCount === 0) {
    await db.delete(collectionsTable).where(eq(collectionsTable.id, row.id));
  }
  const perCard = effectiveBurnValue * (burningShiny ? SHINY_MULTIPLIER : 1);
  const shardsGained = perCard * amount;
  await addShards(guildId, userId, shardsGained);
  await incrementCardsBurned(guildId, userId, amount);
  const remaining = burningShiny ? row.shinyCount : row.count;
  return { success: true, burned: amount, shardsGained, remaining, isShiny: burningShiny };
}

// ── Trades ────────────────────────────────────────────────────────────────────
export async function createTrade(args: {
  guildId: string;
  initiatorId: string;
  targetId: string;
  offeredCardId?: number | null;
  requestedCardId?: number | null;
  offeredShards?: number;
  requestedShards?: number;
  channelId: string;
  messageId?: string;
}) {
  const [trade] = await db.insert(tradesTable).values({
    guildId: args.guildId,
    initiatorId: args.initiatorId,
    targetId: args.targetId,
    offeredCardId: args.offeredCardId ?? null,
    requestedCardId: args.requestedCardId ?? null,
    offeredShards: args.offeredShards ?? 0,
    requestedShards: args.requestedShards ?? 0,
    channelId: args.channelId,
    messageId: args.messageId,
  }).returning();
  return trade;
}

export async function getTrade(tradeId: number): Promise<Trade | undefined> {
  const [row] = await db.select().from(tradesTable).where(eq(tradesTable.id, tradeId));
  return row;
}

export async function updateTradeStatus(tradeId: number, status: "accepted" | "declined" | "cancelled" | "expired") {
  await db.update(tradesTable)
    .set({ status, resolvedAt: new Date() })
    .where(eq(tradesTable.id, tradeId));
}

export async function updateTradeMessageId(tradeId: number, messageId: string) {
  await db.update(tradesTable).set({ messageId }).where(eq(tradesTable.id, tradeId));
}

export async function getPendingTradesFor(guildId: string, userId: string) {
  return db.select({
    id: tradesTable.id,
    initiatorId: tradesTable.initiatorId,
    targetId: tradesTable.targetId,
    offeredCardName: sql<string | null>`offered.name`,
    requestedCardName: sql<string | null>`requested.name`,
    offeredShards: tradesTable.offeredShards,
    requestedShards: tradesTable.requestedShards,
    createdAt: tradesTable.createdAt,
  })
    .from(tradesTable)
    .leftJoin(sql`${cardsTable} offered`, sql`offered.id = ${tradesTable.offeredCardId}`)
    .leftJoin(sql`${cardsTable} requested`, sql`requested.id = ${tradesTable.requestedCardId}`)
    .where(and(
      eq(tradesTable.guildId, guildId),
      eq(tradesTable.status, "pending"),
      sql`(${tradesTable.initiatorId} = ${userId} OR ${tradesTable.targetId} = ${userId})`,
    ))
    .orderBy(desc(tradesTable.createdAt))
    .limit(10);
}

// ── Trade history (resolved trades involving a user) ────────────────────────
// Returns the most recent `limit` trades where the user was either the
// initiator or the target and the trade is no longer pending. Joined twice
// against cards for offered/requested names.
export async function getTradeHistoryFor(guildId: string, userId: string, limit = 10) {
  return db.select({
    id: tradesTable.id,
    initiatorId: tradesTable.initiatorId,
    targetId: tradesTable.targetId,
    offeredCardName: sql<string | null>`offered.name`,
    requestedCardName: sql<string | null>`requested.name`,
    offeredShards: tradesTable.offeredShards,
    requestedShards: tradesTable.requestedShards,
    status: tradesTable.status,
    createdAt: tradesTable.createdAt,
    resolvedAt: tradesTable.resolvedAt,
  })
    .from(tradesTable)
    .leftJoin(sql`${cardsTable} offered`, sql`offered.id = ${tradesTable.offeredCardId}`)
    .leftJoin(sql`${cardsTable} requested`, sql`requested.id = ${tradesTable.requestedCardId}`)
    .where(and(
      eq(tradesTable.guildId, guildId),
      sql`${tradesTable.status} <> 'pending'`,
      sql`(${tradesTable.initiatorId} = ${userId} OR ${tradesTable.targetId} = ${userId})`,
    ))
    // NULLS LAST so legacy rows without resolvedAt don't bubble to the top
    // of "recent resolved" history; ties fall back to createdAt.
    .orderBy(sql`${tradesTable.resolvedAt} DESC NULLS LAST`, desc(tradesTable.createdAt))
    .limit(limit);
}

// ── Gift shards (atomic transfer) ────────────────────────────────────────────
export async function giftShards(
  guildId: string, fromUserId: string, toUserId: string, amount: number,
): Promise<{ success: boolean; remaining: number }> {
  if (amount <= 0) {
    const cur = await getOrCreateCurrency(guildId, fromUserId);
    return { success: false, remaining: cur.shards };
  }
  // Ensure both currency rows exist BEFORE entering the transaction so the
  // upsert side-effect doesn't get rolled back on a debit failure.
  await getOrCreateCurrency(guildId, fromUserId);
  await getOrCreateCurrency(guildId, toUserId);

  const success = await db.transaction(async (tx) => {
    const debited = await tx.update(userCurrencyTable)
      .set({
        shards: sql`${userCurrencyTable.shards} - ${amount}`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(userCurrencyTable.guildId, guildId),
        eq(userCurrencyTable.userId, fromUserId),
        sql`${userCurrencyTable.shards} >= ${amount}`,
      ))
      .returning({ id: userCurrencyTable.id });
    if (debited.length === 0) {
      // Transaction rolls back automatically — sender keeps their shards.
      throw new Error("insufficient_shards");
    }
    await tx.update(userCurrencyTable)
      .set({
        shards: sql`${userCurrencyTable.shards} + ${amount}`,
        totalEarned: sql`${userCurrencyTable.totalEarned} + ${amount}`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(userCurrencyTable.guildId, guildId),
        eq(userCurrencyTable.userId, toUserId),
      ));
    return true;
  }).catch((err) => {
    if (err instanceof Error && err.message === "insufficient_shards") return false;
    throw err;
  });

  const cur = await getOrCreateCurrency(guildId, fromUserId);
  return { success, remaining: cur.shards };
}

export type TradeSwapResult = "ok" | "balance_failed" | "already_resolved";

export async function executeTradeSwap(trade: Trade): Promise<TradeSwapResult> {
  // Guard: trades created before validation tightening may carry negatives.
  if (trade.offeredShards < 0 || trade.requestedShards < 0) return "balance_failed";

  // Pre-create currency rows so the on-conflict upsert can't be rolled back
  // alongside the swap. Inside the txn we use atomic conditional UPDATEs so
  // concurrent accepts/burns can't lead to double-spend.
  if (trade.offeredShards > 0) await getOrCreateCurrency(trade.guildId, trade.initiatorId);
  if (trade.requestedShards > 0) await getOrCreateCurrency(trade.guildId, trade.targetId);
  if (trade.requestedCardId) await getOrCreateCurrency(trade.guildId, trade.initiatorId);
  if (trade.offeredCardId) await getOrCreateCurrency(trade.guildId, trade.targetId);

  return await db.transaction(async (tx) => {
    // 0) Atomic status claim — only one concurrent accept can transition
    //    pending→accepted. Prevents double-execution when a user has ≥2
    //    copies of the offered card (atomic count debits would otherwise
    //    BOTH succeed and the recipient would receive two copies).
    const claimed = await tx.update(tradesTable)
      .set({ status: "accepted", resolvedAt: new Date() })
      .where(and(eq(tradesTable.id, trade.id), eq(tradesTable.status, "pending")))
      .returning({ id: tradesTable.id });
    if (claimed.length === 0) throw new Error("trade_already_resolved");

    // 1) Atomic card debits — single SQL per side ensures only one concurrent
    //    trade can claim the last copy.
    if (trade.offeredCardId) {
      const dec = await tx.update(collectionsTable)
        .set({ count: sql`${collectionsTable.count} - 1` })
        .where(and(
          eq(collectionsTable.guildId, trade.guildId),
          eq(collectionsTable.userId, trade.initiatorId),
          eq(collectionsTable.cardId, trade.offeredCardId),
          sql`${collectionsTable.count} >= 1`,
        ))
        .returning({ id: collectionsTable.id, newCount: collectionsTable.count, shinyCount: collectionsTable.shinyCount });
      if (dec.length === 0) throw new Error("initiator_lacks_card");
      // Preserve shiny inventory: only drop the row when both piles are empty.
      if (dec[0]!.newCount === 0 && dec[0]!.shinyCount === 0) {
        await tx.delete(collectionsTable).where(eq(collectionsTable.id, dec[0]!.id));
      }
    }
    if (trade.requestedCardId) {
      const dec = await tx.update(collectionsTable)
        .set({ count: sql`${collectionsTable.count} - 1` })
        .where(and(
          eq(collectionsTable.guildId, trade.guildId),
          eq(collectionsTable.userId, trade.targetId),
          eq(collectionsTable.cardId, trade.requestedCardId),
          sql`${collectionsTable.count} >= 1`,
        ))
        .returning({ id: collectionsTable.id, newCount: collectionsTable.count, shinyCount: collectionsTable.shinyCount });
      if (dec.length === 0) throw new Error("target_lacks_card");
      if (dec[0]!.newCount === 0 && dec[0]!.shinyCount === 0) {
        await tx.delete(collectionsTable).where(eq(collectionsTable.id, dec[0]!.id));
      }
    }

    // 2) Atomic shard debits.
    if (trade.offeredShards > 0) {
      const debit = await tx.update(userCurrencyTable)
        .set({ shards: sql`${userCurrencyTable.shards} - ${trade.offeredShards}`, updatedAt: new Date() })
        .where(and(
          eq(userCurrencyTable.guildId, trade.guildId),
          eq(userCurrencyTable.userId, trade.initiatorId),
          sql`${userCurrencyTable.shards} >= ${trade.offeredShards}`,
        ))
        .returning({ id: userCurrencyTable.id });
      if (debit.length === 0) throw new Error("initiator_lacks_shards");
    }
    if (trade.requestedShards > 0) {
      const debit = await tx.update(userCurrencyTable)
        .set({ shards: sql`${userCurrencyTable.shards} - ${trade.requestedShards}`, updatedAt: new Date() })
        .where(and(
          eq(userCurrencyTable.guildId, trade.guildId),
          eq(userCurrencyTable.userId, trade.targetId),
          sql`${userCurrencyTable.shards} >= ${trade.requestedShards}`,
        ))
        .returning({ id: userCurrencyTable.id });
      if (debit.length === 0) throw new Error("target_lacks_shards");
    }

    // 3) Card credits — trades are MOVES, not new mints, so do not bump
    //    cardsTable.totalMinted (otherwise limited-editions would deplete
    //    on every trade). Mirrors restoreCardToUser semantics.
    if (trade.requestedCardId) await restoreCardToUserTx(tx, trade.guildId, trade.initiatorId, trade.requestedCardId);
    if (trade.offeredCardId) await restoreCardToUserTx(tx, trade.guildId, trade.targetId, trade.offeredCardId);

    // 4) Shard credits — bump totalEarned alongside shards so the
    //    leaderboard / lifetime-earned stat reflects trade income.
    if (trade.requestedShards > 0) {
      await tx.update(userCurrencyTable)
        .set({
          shards: sql`${userCurrencyTable.shards} + ${trade.requestedShards}`,
          totalEarned: sql`${userCurrencyTable.totalEarned} + ${trade.requestedShards}`,
          updatedAt: new Date(),
        })
        .where(and(
          eq(userCurrencyTable.guildId, trade.guildId),
          eq(userCurrencyTable.userId, trade.initiatorId),
        ));
    }
    if (trade.offeredShards > 0) {
      await tx.update(userCurrencyTable)
        .set({
          shards: sql`${userCurrencyTable.shards} + ${trade.offeredShards}`,
          totalEarned: sql`${userCurrencyTable.totalEarned} + ${trade.offeredShards}`,
          updatedAt: new Date(),
        })
        .where(and(
          eq(userCurrencyTable.guildId, trade.guildId),
          eq(userCurrencyTable.userId, trade.targetId),
        ));
    }

    return "ok" as const;
  }).catch((err): TradeSwapResult => {
    if (err instanceof Error && err.message === "trade_already_resolved") return "already_resolved";
    if (err instanceof Error && [
      "initiator_lacks_card", "target_lacks_card",
      "initiator_lacks_shards", "target_lacks_shards",
    ].includes(err.message)) return "balance_failed";
    logger.error({ err, tradeId: trade.id }, "executeTradeSwap failed");
    return "balance_failed";
  });
}

// Transaction-safe variant of restoreCardToUser — credits one copy to the
// user's collection WITHOUT touching cardsTable.totalMinted. Used by trade
// swaps, which are moves (no new card is minted into the world).
async function restoreCardToUserTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  guildId: string, userId: string, cardId: number,
) {
  await tx.insert(collectionsTable)
    .values({ guildId, userId, cardId, count: 1 })
    .onConflictDoUpdate({
      target: [collectionsTable.guildId, collectionsTable.userId, collectionsTable.cardId],
      set: {
        count: sql`${collectionsTable.count} + 1`,
        lastCaughtAt: new Date(),
      },
    });
}

// ── Spawn Log ─────────────────────────────────────────────────────────────────
export async function logSpawn(guildId: string, channelId: string, cardId: number, isForced: boolean) {
  const [row] = await db.insert(spawnLogTable)
    .values({ guildId, channelId, cardId, isForced }).returning();
  return row;
}

export async function markCaught(spawnId: number, userId: string) {
  await db.update(spawnLogTable)
    .set({ caughtBy: userId, caughtAt: new Date() })
    .where(eq(spawnLogTable.id, spawnId));
}

// ── Wishlists ─────────────────────────────────────────────────────────────────
export async function addWishlist(guildId: string, userId: string, cardId: number): Promise<boolean> {
  const inserted = await db.insert(wishlistsTable)
    .values({ guildId, userId, cardId })
    .onConflictDoNothing()
    .returning({ id: wishlistsTable.id });
  return inserted.length > 0;
}

export async function removeWishlist(guildId: string, userId: string, cardId: number): Promise<boolean> {
  const deleted = await db.delete(wishlistsTable)
    .where(and(
      eq(wishlistsTable.guildId, guildId),
      eq(wishlistsTable.userId, userId),
      eq(wishlistsTable.cardId, cardId),
    ))
    .returning({ id: wishlistsTable.id });
  return deleted.length > 0;
}

export async function getUserWishlist(
  guildId: string, userId: string,
): Promise<Array<{ cardId: number; name: string; rarity: string; worthValue: number }>> {
  const rows = await db.select({
    cardId: cardsTable.id,
    name: cardsTable.name,
    rarity: cardsTable.rarity,
    worthValue: cardsTable.worthValue,
  })
    .from(wishlistsTable)
    .innerJoin(cardsTable, eq(cardsTable.id, wishlistsTable.cardId))
    .where(and(eq(wishlistsTable.guildId, guildId), eq(wishlistsTable.userId, userId)))
    .orderBy(desc(cardsTable.worthValue));
  return rows;
}

export async function getCardWishlisters(guildId: string, cardId: number): Promise<string[]> {
  const rows = await db.select({ userId: wishlistsTable.userId })
    .from(wishlistsTable)
    .where(and(eq(wishlistsTable.guildId, guildId), eq(wishlistsTable.cardId, cardId)));
  return rows.map(r => r.userId);
}

// ── Card Events (limited-time spawn boosts) ──────────────────────────────────
export async function createCardEvent(args: {
  guildId: string; cardId: number; weightMultiplier: number;
  endsAt: Date; createdBy: string;
}): Promise<CardEvent> {
  const [row] = await db.insert(cardEventsTable).values({
    guildId: args.guildId,
    cardId: args.cardId,
    weightMultiplier: args.weightMultiplier,
    endsAt: args.endsAt,
    createdBy: args.createdBy,
  }).returning();
  return row;
}

export async function listActiveCardEvents(guildId: string): Promise<Array<CardEvent & { cardName: string }>> {
  const rows = await db.select({
    id: cardEventsTable.id,
    guildId: cardEventsTable.guildId,
    cardId: cardEventsTable.cardId,
    weightMultiplier: cardEventsTable.weightMultiplier,
    startsAt: cardEventsTable.startsAt,
    endsAt: cardEventsTable.endsAt,
    createdBy: cardEventsTable.createdBy,
    createdAt: cardEventsTable.createdAt,
    cardName: cardsTable.name,
  })
    .from(cardEventsTable)
    .innerJoin(cardsTable, eq(cardsTable.id, cardEventsTable.cardId))
    .where(and(
      eq(cardEventsTable.guildId, guildId),
      sql`${cardEventsTable.endsAt} > NOW()`,
      sql`${cardEventsTable.startsAt} <= NOW()`,
    ))
    .orderBy(cardEventsTable.endsAt);
  return rows;
}

// Combined multiplier per card — if two events stack on the same card, the
// effective boost is the product. Used by spawn-manager before pickRandomCard.
export async function getActiveEventBoosts(guildId: string): Promise<Map<number, number>> {
  const events = await listActiveCardEvents(guildId);
  const boosts = new Map<number, number>();
  for (const e of events) {
    boosts.set(e.cardId, (boosts.get(e.cardId) ?? 1) * e.weightMultiplier);
  }
  return boosts;
}

// Stops an event by setting endsAt to NOW. Returns the row + card name if
// the caller owns it (same guild) and it was still active, else null.
export async function stopCardEvent(
  guildId: string, eventId: number,
): Promise<(CardEvent & { cardName: string }) | null> {
  const rows = await db.update(cardEventsTable)
    .set({ endsAt: new Date() })
    .where(and(
      eq(cardEventsTable.id, eventId),
      eq(cardEventsTable.guildId, guildId),
      sql`${cardEventsTable.endsAt} > NOW()`,
    ))
    .returning();
  const row = rows[0];
  if (!row) return null;
  const [card] = await db.select({ name: cardsTable.name })
    .from(cardsTable).where(eq(cardsTable.id, row.cardId));
  return { ...row, cardName: card?.name ?? `card #${row.cardId}` };
}

// ── Rarity admin writes (Discord = source of truth for gameplay) ─────────────
// These helpers exist so Discord slash commands can manage rarity_profiles,
// custom_rarities, and card_rarity_overrides. The website is intentionally
// read-only against these tables; do NOT call these from any HTTP route.

export async function upsertRarityProfile(
  guildId: string,
  rarity: Rarity,
  patch: { worthValue?: number | null; burnValue?: number | null; dropWeight?: number | null; updatedBy?: string },
): Promise<RarityProfile> {
  const insertValues = {
    guildId,
    rarity,
    worthValue: patch.worthValue ?? null,
    burnValue: patch.burnValue ?? null,
    dropWeight: patch.dropWeight ?? null,
    updatedBy: patch.updatedBy ?? null,
  };
  const setOnConflict: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.worthValue !== undefined) setOnConflict.worthValue = patch.worthValue;
  if (patch.burnValue !== undefined) setOnConflict.burnValue = patch.burnValue;
  if (patch.dropWeight !== undefined) setOnConflict.dropWeight = patch.dropWeight;
  if (patch.updatedBy !== undefined) setOnConflict.updatedBy = patch.updatedBy;
  const [row] = await db.insert(rarityProfilesTable)
    .values(insertValues)
    .onConflictDoUpdate({ target: [rarityProfilesTable.guildId, rarityProfilesTable.rarity], set: setOnConflict })
    .returning();
  invalidateRarityProfileCache(guildId);
  invalidateRarityContextCache(guildId);
  invalidateCardCache();
  return row;
}

export async function deleteRarityProfile(guildId: string, rarity: Rarity): Promise<boolean> {
  const res = await db.delete(rarityProfilesTable)
    .where(and(eq(rarityProfilesTable.guildId, guildId), eq(rarityProfilesTable.rarity, rarity)))
    .returning({ id: rarityProfilesTable.id });
  invalidateRarityProfileCache(guildId);
  invalidateRarityContextCache(guildId);
  invalidateCardCache();
  return res.length > 0;
}

export async function listRarityProfiles(guildId: string): Promise<RarityProfile[]> {
  return db.select().from(rarityProfilesTable).where(eq(rarityProfilesTable.guildId, guildId));
}

export async function createCustomRarity(
  guildId: string,
  data: {
    slug: string; name: string; emoji: string; position: number;
    worthValue: number; burnValue: number;
    color?: number; dropWeight?: number; droppable?: boolean; inPacks?: boolean;
    updatedBy?: string;
  },
): Promise<CustomRarity> {
  const [row] = await db.insert(customRaritiesTable).values({
    guildId,
    slug: data.slug,
    name: data.name,
    emoji: data.emoji,
    position: data.position,
    worthValue: data.worthValue,
    burnValue: data.burnValue,
    color: data.color ?? 0x5865f2,
    dropWeight: data.dropWeight ?? 1.0,
    droppable: data.droppable ?? true,
    inPacks: data.inPacks ?? false,
    updatedBy: data.updatedBy ?? null,
  }).returning();
  invalidateRarityContextCache(guildId);
  invalidateCardCache();
  return row;
}

export async function updateCustomRarity(
  guildId: string,
  slug: string,
  patch: Partial<{
    name: string; emoji: string; position: number; worthValue: number; burnValue: number;
    color: number; dropWeight: number; droppable: boolean; inPacks: boolean; updatedBy: string;
  }>,
): Promise<CustomRarity | null> {
  if (Object.keys(patch).length === 0) {
    const [existing] = await db.select().from(customRaritiesTable)
      .where(and(eq(customRaritiesTable.guildId, guildId), eq(customRaritiesTable.slug, slug)));
    return existing ?? null;
  }
  const [row] = await db.update(customRaritiesTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(customRaritiesTable.guildId, guildId), eq(customRaritiesTable.slug, slug)))
    .returning();
  invalidateRarityContextCache(guildId);
  invalidateCardCache();
  return row ?? null;
}

export async function deleteCustomRarity(guildId: string, slug: string): Promise<{ removed: boolean; clearedAssignments: number }> {
  const cleared = await db.delete(cardRarityOverridesTable)
    .where(and(eq(cardRarityOverridesTable.guildId, guildId), eq(cardRarityOverridesTable.customRaritySlug, slug)))
    .returning({ id: cardRarityOverridesTable.id });
  const res = await db.delete(customRaritiesTable)
    .where(and(eq(customRaritiesTable.guildId, guildId), eq(customRaritiesTable.slug, slug)))
    .returning({ id: customRaritiesTable.id });
  invalidateRarityContextCache(guildId);
  invalidateCardCache();
  return { removed: res.length > 0, clearedAssignments: cleared.length };
}

export async function listCustomRarities(guildId: string): Promise<CustomRarity[]> {
  const rows = await db.select().from(customRaritiesTable).where(eq(customRaritiesTable.guildId, guildId));
  return rows.sort((a, b) => a.position - b.position);
}

export async function getCustomRarityBySlug(guildId: string, slug: string): Promise<CustomRarity | null> {
  const [row] = await db.select().from(customRaritiesTable)
    .where(and(eq(customRaritiesTable.guildId, guildId), eq(customRaritiesTable.slug, slug)));
  return row ?? null;
}

export async function assignCardToCustomRarity(guildId: string, cardId: number, slug: string): Promise<void> {
  await db.insert(cardRarityOverridesTable)
    .values({ guildId, cardId, customRaritySlug: slug })
    .onConflictDoUpdate({
      target: [cardRarityOverridesTable.guildId, cardRarityOverridesTable.cardId],
      set: { customRaritySlug: slug },
    });
  invalidateRarityContextCache(guildId);
  invalidateCardCache();
}

export async function unassignCardCustomRarity(guildId: string, cardId: number): Promise<boolean> {
  const res = await db.delete(cardRarityOverridesTable)
    .where(and(eq(cardRarityOverridesTable.guildId, guildId), eq(cardRarityOverridesTable.cardId, cardId)))
    .returning({ id: cardRarityOverridesTable.id });
  invalidateRarityContextCache(guildId);
  invalidateCardCache();
  return res.length > 0;
}

// ── Distinct card types (for /addcard and /editcard autocomplete) ─────────────
// Per-guild: types are drawn ONLY from the viewer's own cards so one server's
// custom card types never bleed into another server's autocomplete. ⚠️ REPLIT ⚠️
const _distinctTypesCache = new Map<string, { at: number; types: string[] }>();
const DISTINCT_TYPES_CACHE_MS = 30_000;

export async function getDistinctCardTypes(viewerGuildId?: string | null): Promise<string[]> {
  if (!viewerGuildId) {
    logger.error("[ISOLATION] getDistinctCardTypes() called without a guildId — returning [] to prevent a cross-server type leak.");
    return [];
  }
  const now = Date.now();
  const cached = _distinctTypesCache.get(viewerGuildId);
  if (cached && now - cached.at < DISTINCT_TYPES_CACHE_MS) {
    return cached.types;
  }
  const rows = await db.selectDistinct({ cardType: cardsTable.cardType })
    .from(cardsTable)
    .where(eq(cardsTable.guildId, viewerGuildId));
  const types = rows.map(r => r.cardType).filter(Boolean).sort();
  _distinctTypesCache.set(viewerGuildId, { at: now, types });
  return types;
}

// Invalidate when a card's type changes so autocomplete reflects it quickly.
export function invalidateDistinctTypesCache(): void {
  _distinctTypesCache.clear();
}

// ── Custom Packs CRUD ─────────────────────────────────────────────────────────
// Per-guild cache for active custom packs (used in /pack autocomplete + draw).
const _customPackCache = new Map<string, { value: CustomPack[]; expiresAt: number }>();
const CUSTOM_PACK_CACHE_MS = 10_000;

export function invalidateCustomPackCache(guildId: string): void {
  _customPackCache.delete(guildId);
}

export async function listCustomPacks(
  guildId: string,
  includeInactive = false,
): Promise<CustomPack[]> {
  if (!includeInactive) {
    const cached = _customPackCache.get(guildId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
  }
  const rows = await db.select().from(customPacksTable)
    .where(includeInactive
      ? eq(customPacksTable.guildId, guildId)
      : and(eq(customPacksTable.guildId, guildId), eq(customPacksTable.isActive, true)))
    .orderBy(customPacksTable.createdAt);
  if (!includeInactive) {
    _customPackCache.set(guildId, { value: rows, expiresAt: Date.now() + CUSTOM_PACK_CACHE_MS });
  }
  return rows;
}

export async function getCustomPack(id: number): Promise<CustomPack | undefined> {
  const [row] = await db.select().from(customPacksTable)
    .where(eq(customPacksTable.id, id)).limit(1);
  return row;
}

function slugifyPackName(name: string): string {
  return (
    name.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
  ) || `pack-${Date.now()}`;
}

export async function createCustomPack(
  guildId: string,
  name: string,
  cost: number,
  size: number,
  weeklyLimit: number,
  rarityRates: Record<string, number>,
  cardTypes: string[],
  description = "",
): Promise<CustomPack> {
  const slug = slugifyPackName(name);
  const [row] = await db.insert(customPacksTable)
    .values({ guildId, slug, name, cost, size, weeklyLimit, rarityRates, cardTypes, description, isActive: true })
    .onConflictDoUpdate({
      target: [customPacksTable.guildId, customPacksTable.slug],
      set: { name, cost, size, weeklyLimit, rarityRates, cardTypes, description, isActive: true },
    })
    .returning();
  invalidateCustomPackCache(guildId);
  return row!;
}

export async function updateCustomPack(
  id: number,
  patch: Partial<{
    name: string; slug: string; cost: number; size: number; weeklyLimit: number;
    rarityRates: Record<string, number>; cardTypes: string[]; isActive: boolean; description: string; emoji: string | null;
  }>,
): Promise<void> {
  const [existing] = await db.select({ guildId: customPacksTable.guildId })
    .from(customPacksTable).where(eq(customPacksTable.id, id)).limit(1);
  if (!existing) return;
  await db.update(customPacksTable).set(patch).where(eq(customPacksTable.id, id));
  invalidateCustomPackCache(existing.guildId);
}

export async function deleteCustomPack(id: number): Promise<void> {
  const [existing] = await db.select({ guildId: customPacksTable.guildId })
    .from(customPacksTable).where(eq(customPacksTable.id, id)).limit(1);
  if (!existing) return;
  await db.delete(customPacksTable).where(eq(customPacksTable.id, id));
  invalidateCustomPackCache(existing.guildId);
}

// ── Persistent DN Trade Calculator hubs ───────────────────────────────────────
export async function createCalculatorMessage(
  guildId: string, channelId: string, messageId: string, createdBy: string,
  resultChannelId?: string | null,
): Promise<CalculatorMessage> {
  const [row] = await db.insert(calculatorMessagesTable)
    .values({ guildId, channelId, messageId, createdBy, resultChannelId: resultChannelId ?? null })
    .onConflictDoUpdate({
      target: [calculatorMessagesTable.guildId, calculatorMessagesTable.channelId, calculatorMessagesTable.messageId],
      set: { createdBy, resultChannelId: resultChannelId ?? null },
    })
    .returning();
  return row!;
}

export async function listCalculatorMessages(guildId?: string): Promise<CalculatorMessage[]> {
  return db.select().from(calculatorMessagesTable)
    .where(guildId ? eq(calculatorMessagesTable.guildId, guildId) : undefined)
    .orderBy(desc(calculatorMessagesTable.createdAt));
}

export async function deleteCalculatorMessage(id: number): Promise<void> {
  await db.delete(calculatorMessagesTable).where(eq(calculatorMessagesTable.id, id));
}

export async function isCalculatorMessage(messageId: string): Promise<boolean> {
  const [row] = await db.select({ id: calculatorMessagesTable.id })
    .from(calculatorMessagesTable)
    .where(eq(calculatorMessagesTable.messageId, messageId))
    .limit(1);
  return !!row;
}

export async function getCalculatorMessage(messageId: string): Promise<CalculatorMessage | undefined> {
  const [row] = await db.select().from(calculatorMessagesTable)
    .where(eq(calculatorMessagesTable.messageId, messageId))
    .limit(1);
  return row;
}

// ── Explicit card whitelist for custom packs ─────────────────────────────────
// When a pack has rows in custom_pack_cards, /pack draws from that exact set
// (still respecting droppable/inPacks/archive). Otherwise it falls back to the
// cardTypes filter. Whitelists are managed via /editpack.

export async function getCustomPackCards(packId: number): Promise<CustomPackCard[]> {
  return db.select().from(customPackCardsTable)
    .where(eq(customPackCardsTable.packId, packId))
    .orderBy(desc(customPackCardsTable.addedAt));
}

export async function addCardsToPack(packId: number, cardIds: number[]): Promise<void> {
  if (cardIds.length === 0) return;
  const [existing] = await db.select({ guildId: customPacksTable.guildId })
    .from(customPacksTable).where(eq(customPacksTable.id, packId)).limit(1);
  if (!existing) return;
  await db.insert(customPackCardsTable)
    .values(cardIds.map(cardId => ({ packId, cardId })))
    .onConflictDoNothing({ target: [customPackCardsTable.packId, customPackCardsTable.cardId] });
  invalidateCustomPackCache(existing.guildId);
}

export async function removeCardsFromPack(packId: number, cardIds: number[]): Promise<void> {
  if (cardIds.length === 0) return;
  const [existing] = await db.select({ guildId: customPacksTable.guildId })
    .from(customPacksTable).where(eq(customPacksTable.id, packId)).limit(1);
  if (!existing) return;
  await db.delete(customPackCardsTable)
    .where(and(eq(customPackCardsTable.packId, packId), inArray(customPackCardsTable.cardId, cardIds)));
  invalidateCustomPackCache(existing.guildId);
}

export async function clearPackCards(packId: number): Promise<void> {
  const [existing] = await db.select({ guildId: customPacksTable.guildId })
    .from(customPacksTable).where(eq(customPacksTable.id, packId)).limit(1);
  if (!existing) return;
  await db.delete(customPackCardsTable).where(eq(customPackCardsTable.packId, packId));
  invalidateCustomPackCache(existing.guildId);
}

// ── Custom pack weekly-cap tracking ──────────────────────────────────────────
// Atomic upsert: increments week_opens if the user is under the weekly cap
// (accounting for a mid-week rollover). Returns { ok: true } on success, or
// { ok: false, weekOpens, weekResetAt } when the cap is already reached.
export async function tryClaimCustomPackWeek(
  guildId: string,
  userId: string,
  packId: number,
  weeklyLimit: number,
  nextResetAt: Date,
): Promise<{ ok: true } | { ok: false; weekOpens: number; weekResetAt: Date }> {
  if (weeklyLimit === 0) return { ok: true }; // 0 = unlimited

  const result = await pool.query<{ week_opens: number; week_reset_at: Date }>(`
    INSERT INTO user_custom_pack_week(guild_id, user_id, pack_id, week_opens, week_reset_at)
    VALUES($1, $2, $3, 1, $4)
    ON CONFLICT(guild_id, user_id, pack_id) DO UPDATE
      SET week_opens = CASE
            WHEN user_custom_pack_week.week_reset_at <= NOW() THEN 1
            ELSE user_custom_pack_week.week_opens + 1
          END,
          week_reset_at = CASE
            WHEN user_custom_pack_week.week_reset_at <= NOW() THEN $4
            ELSE user_custom_pack_week.week_reset_at
          END
    WHERE (CASE
             WHEN user_custom_pack_week.week_reset_at <= NOW() THEN 0
             ELSE user_custom_pack_week.week_opens
           END) < $5
    RETURNING week_opens, week_reset_at
  `, [guildId, userId, packId, nextResetAt, weeklyLimit]);

  if (result.rows.length > 0) return { ok: true };

  // Cap reached — read current state so the caller can show the user their usage.
  const [existing] = await db.select({
    weekOpens: userCustomPackWeekTable.weekOpens,
    weekResetAt: userCustomPackWeekTable.weekResetAt,
  }).from(userCustomPackWeekTable)
    .where(and(
      eq(userCustomPackWeekTable.guildId, guildId),
      eq(userCustomPackWeekTable.userId, userId),
      eq(userCustomPackWeekTable.packId, packId),
    )).limit(1);

  return {
    ok: false,
    weekOpens: existing?.weekOpens ?? weeklyLimit,
    weekResetAt: existing?.weekResetAt ?? nextResetAt,
  };
}

// Refund one weekly-cap slot (called when a pack open fails after the cap was claimed).
export async function refundCustomPackWeek(
  guildId: string,
  userId: string,
  packId: number,
): Promise<void> {
  await pool.query(
    `UPDATE user_custom_pack_week
     SET week_opens = GREATEST(0, week_opens - 1)
     WHERE guild_id = $1 AND user_id = $2 AND pack_id = $3`,
    [guildId, userId, packId],
  );
}

// ── Showcase / Canvas Backgrounds ───────────────────────────────────────────
// Up to 3 uploadable backgrounds per guild. The renderer picks one at random
// when a /user-hub "Show Card" trophy is posted; an empty table falls back to
// the built-in gradient.
export async function getShowcaseBackgrounds(guildId: string): Promise<string[]> {
  const rows = await db.select({ url: showcaseBackgroundsTable.url })
    .from(showcaseBackgroundsTable)
    .where(eq(showcaseBackgroundsTable.guildId, guildId))
    .orderBy(showcaseBackgroundsTable.slot);
  return rows.map(r => r.url);
}

export async function setShowcaseBackground(guildId: string, slot: 1 | 2 | 3, url: string, updatedBy?: string): Promise<void> {
  await db.insert(showcaseBackgroundsTable)
    .values({ guildId, slot, url, updatedBy: updatedBy ?? null })
    .onConflictDoUpdate({
      target: [showcaseBackgroundsTable.guildId, showcaseBackgroundsTable.slot],
      set: { url, updatedBy: updatedBy ?? null },
    });
}

export async function clearShowcaseBackground(guildId: string, slot: 1 | 2 | 3): Promise<void> {
  await db.delete(showcaseBackgroundsTable)
    .where(and(eq(showcaseBackgroundsTable.guildId, guildId), eq(showcaseBackgroundsTable.slot, slot)));
}

export async function clearAllShowcaseBackgrounds(guildId: string): Promise<void> {
  await db.delete(showcaseBackgroundsTable).where(eq(showcaseBackgroundsTable.guildId, guildId));
}

// ── Battle Backgrounds (arena canvas) ───────────────────────────────────────
// Up to 3 uploadable arena backgrounds per guild. The battle VS renderer picks
// one at random each fight; an empty table falls back to the vibrant gradient.
export async function getBattleBackgrounds(guildId: string): Promise<string[]> {
  const rows = await db.select({ url: battleBackgroundsTable.url })
    .from(battleBackgroundsTable)
    .where(eq(battleBackgroundsTable.guildId, guildId))
    .orderBy(battleBackgroundsTable.slot);
  return rows.map(r => r.url);
}

export async function setBattleBackground(guildId: string, slot: 1 | 2 | 3, url: string, updatedBy?: string): Promise<void> {
  await db.insert(battleBackgroundsTable)
    .values({ guildId, slot, url, updatedBy: updatedBy ?? null })
    .onConflictDoUpdate({
      target: [battleBackgroundsTable.guildId, battleBackgroundsTable.slot],
      set: { url, updatedBy: updatedBy ?? null },
    });
}

export async function clearBattleBackground(guildId: string, slot: 1 | 2 | 3): Promise<void> {
  await db.delete(battleBackgroundsTable)
    .where(and(eq(battleBackgroundsTable.guildId, guildId), eq(battleBackgroundsTable.slot, slot)));
}

export async function clearAllBattleBackgrounds(guildId: string): Promise<void> {
  await db.delete(battleBackgroundsTable).where(eq(battleBackgroundsTable.guildId, guildId));
}
