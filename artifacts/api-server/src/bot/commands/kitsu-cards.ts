import type {
  ChatInputCommandInteraction,
  AutocompleteInteraction,
} from "discord.js";
import { MessageFlags, EmbedBuilder } from "discord.js";
import { addCard, addCardToSet, getCardByName, getSetByName } from "../db.js";
import { renderPanel, persistBotImage } from "./edit-card.js";
import { RARITY_BURN, RARITY_WEIGHTS, RARITY_WORTH, type Rarity } from "../cards-data.js";
import { logger } from "../../lib/logger.js";

// ── Kitsu.io card source ───────────────────────────────────────────────────
// Kitsu is a JSON:API anime/manga/characters database. We pull only the title,
// synopsis (bio), and poster/cover image. Value, rarity, and type are supplied
// by the admin running the command, just like /create_card_from_mttv.
//
// Supported categories:
//   anime      — canonicalTitle + posterImage + synopsis
//   manga      — canonicalTitle + posterImage + synopsis
//   character  — name + image + description
//
// No API key is required, but we cache searches to keep autocomplete keystrokes
// from hammering the public endpoint.

const KITSU_API_BASE = "https://kitsu.io/api/edge";
const KITSU_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export type KitsuCategory = "anime" | "manga" | "character";

export interface KitsuItem {
  id: string;
  type: KitsuCategory;
  name: string;
  description: string;
  imageUrl: string | null;
}

interface KitsuAttributes {
  canonicalTitle?: string;
  canonicalName?: string;
  titles?: Record<string, string | null | undefined>;
  synopsis?: string | null;
  description?: string | null;
  name?: string;
  posterImage?: KitsuImage | null;
  coverImage?: KitsuImage | null;
  image?: KitsuImage | null;
}

interface KitsuImage {
  tiny?: string;
  small?: string;
  medium?: string;
  large?: string;
  original?: string;
}

interface KitsuResponse {
  data: Array<{
    id: string;
    type: string;
    attributes: KitsuAttributes;
  }>;
}

const searchCache = new Map<string, { at: number; items: KitsuItem[] }>();

function cacheKey(category: string, query: string): string {
  return `${category}:${query.toLowerCase().trim()}`;
}

function bestImageUrl(attrs: KitsuAttributes): string | null {
  const candidates = [
    attrs.posterImage?.large,
    attrs.posterImage?.medium,
    attrs.posterImage?.small,
    attrs.coverImage?.large,
    attrs.coverImage?.medium,
    attrs.coverImage?.small,
    attrs.image?.large,
    attrs.image?.medium,
    attrs.image?.small,
  ];
  for (const url of candidates) {
    if (url) return url;
  }
  return null;
}

function buildName(attrs: KitsuAttributes, type: string): string {
  if (attrs.canonicalTitle) return attrs.canonicalTitle;
  if (attrs.canonicalName) return attrs.canonicalName;
  if (attrs.name) return attrs.name;
  const title = attrs.titles?.en || attrs.titles?.en_jp || attrs.titles?.en_us || attrs.titles?.ja_jp;
  if (typeof title === "string") return title;
  return `${type} #${Math.floor(Math.random() * 100000)}`;
}

function buildDescription(attrs: KitsuAttributes): string {
  const raw = attrs.synopsis ?? attrs.description ?? "";
  return raw.trim();
}

export function isKitsuCategory(v: string | null | undefined): v is KitsuCategory {
  return v === "anime" || v === "manga" || v === "character";
}

export async function searchKitsu(category: KitsuCategory, query: string): Promise<KitsuItem[]> {
  const q = query.trim();
  if (!q) return [];

  const key = cacheKey(category, q);
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.at < KITSU_CACHE_TTL_MS) return cached.items;

  try {
    const filterParam = category === "character" ? "filter[name]" : "filter[text]";
    const url = `${KITSU_API_BASE}/${category}?${filterParam}=${encodeURIComponent(q)}&page[limit]=20`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }
    const data = (await resp.json()) as KitsuResponse;
    if (!Array.isArray(data?.data)) {
      throw new Error("Unexpected Kitsu response shape");
    }

    const items: KitsuItem[] = data.data.map((entry) => {
      const attrs = entry.attributes ?? {};
      return {
        id: entry.id,
        type: category,
        name: buildName(attrs, category),
        description: buildDescription(attrs),
        imageUrl: bestImageUrl(attrs),
      };
    });

    // Rank before caching so autocomplete + free-text create share the same order.
    items.sort((a, b) => matchScore(b, q) - matchScore(a, q));

    searchCache.set(key, { at: Date.now(), items });
    return items;
  } catch (err) {
    logger.error({ err: (err as Error).message, category, query }, "Failed to search Kitsu");
    throw new Error("Could not reach Kitsu. Try again in a moment.");
  }
}

// Fetch a single Kitsu entry by its ID. Used when the user selects an
// autocomplete option (value = Kitsu ID) so the exact item is chosen.
export async function getKitsuById(category: KitsuCategory, id: string): Promise<KitsuItem | null> {
  try {
    const url = `${KITSU_API_BASE}/${category}/${encodeURIComponent(id)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { data?: { id: string; type: string; attributes: KitsuAttributes } };
    if (!data?.data) return null;
    const entry = data.data;
    const attrs = entry.attributes ?? {};
    return {
      id: entry.id,
      type: category,
      name: buildName(attrs, category),
      description: buildDescription(attrs),
      imageUrl: bestImageUrl(attrs),
    };
  } catch (err) {
    logger.error({ err: (err as Error).message, category, id }, "Failed to fetch Kitsu by ID");
    return null;
  }
}

// Resolve the selected Kitsu item. Autocomplete submits the Kitsu ID as the
// value, but users can also type free text, so fall back to a name search.
async function resolveKitsuItem(category: KitsuCategory, value: string): Promise<KitsuItem | undefined> {
  const v = value.trim();
  if (!v) return undefined;

  if (/^\d+$/.test(v)) {
    const byId = await getKitsuById(category, v);
    if (byId) return byId;
  }

  const items = await searchKitsu(category, v);
  return items.find((i) => i.name.toLowerCase() === v.toLowerCase())
    ?? items.sort((a, b) => matchScore(b, v) - matchScore(a, v))[0];
}

const CREATE_CARD_RARITIES = new Set<string>(["common", "uncommon", "rare", "epic", "legendary", "mythic"]);

function createCardRarityDefaults(rarity: Rarity): { worth: number; burn: number; weight: number } {
  return {
    worth: RARITY_WORTH[rarity],
    burn: RARITY_BURN[rarity],
    weight: RARITY_WEIGHTS[rarity],
  };
}

function matchScore(item: KitsuItem, query: string): number {
  const q = query.toLowerCase().trim().replace(/\s+/g, " ");
  const name = item.name.toLowerCase();
  const tokens = q.split(" ").filter(Boolean);
  let score = 0;

  if (name === q) score = 1000;
  else if (name.startsWith(q)) score = 500;
  else if (name.includes(q)) score = 200;
  else {
    // Token coverage — "dbz goku" should prefer names that contain goku, not random DBZ movies.
    let hit = 0;
    for (const t of tokens) {
      if (t.length < 2) continue;
      if (name === t) hit += 120;
      else if (name.includes(t)) hit += 80;
      else if (t === "dbz" && (name.includes("dragon ball z") || name.includes("dragonball z"))) hit += 70;
      else if (t === "dbs" && name.includes("super")) hit += 40;
    }
    score = hit;
  }

  const acronym = name
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/gi, "").slice(0, 1))
    .join("");
  if (acronym && tokens.some((t) => acronym.includes(t))) score = Math.max(score, 50);

  // Prefer short, canonical character names over obscure lookalikes.
  if (item.type === "character" && name.length <= 24) score += 25;
  if (item.type === "anime") {
    const n = name;
    if (/\b(movie|special|ova|ona)\b/i.test(n)) score -= 40;
    if (/^dragon ball z$/i.test(item.name) || /^dragon ball$/i.test(item.name)) score += 80;
  }

  // Prefer entries that actually have art (create-card needs an image).
  if (item.imageUrl) score += 15;
  if (!item.description) score -= 10;

  return score;
}

export async function handleKitsuAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "item" && focused.name !== "name") {
    await interaction.respond([]);
    return;
  }

  const category = interaction.options.getString("category");
  if (!isKitsuCategory(category)) {
    await interaction.respond([
      { name: "Select a category first (Anime / Manga / Character)", value: "__need_category__" },
    ]);
    return;
  }

  const query = focused.value.trim();
  if (!query) {
    await interaction.respond([]);
    return;
  }

  try {
    const items = await searchKitsu(category, query);
    const scored = items
      .map((item) => ({ item, score: matchScore(item, query) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 25);
    await interaction.respond(
      scored.map(({ item }) => {
        const preview = item.description ? ` — ${item.description.slice(0, 60)}`.replace(/\s+/g, " ") : "";
        return {
          name: `${item.name}${preview}`.slice(0, 100),
          value: item.id.slice(0, 100),
        };
      }),
    );
  } catch (err) {
    logger.error({ err: (err as Error).message }, "Kitsu autocomplete failed");
    await interaction.respond([]);
  }
}

export async function handleCreateCardFromKitsu(interaction: ChatInputCommandInteraction): Promise<void> {
  // Caller (admin.ts) has already deferred the reply.
  const guildId = interaction.guildId!;
  const category = interaction.options.getString("category", true);
  const itemName = interaction.options.getString("item", true).trim();
  const rarityInput = interaction.options.getString("rarity", true);
  const type = interaction.options.getString("type", true).trim().toLowerCase().replace(/\s+/g, " ").slice(0, 40);
  const setName = interaction.options.getString("set")?.trim();
  const descriptionOverride = interaction.options.getString("description") ?? "";
  const limited = interaction.options.getBoolean("limited") ?? false;
  const maxCopies = interaction.options.getInteger("max_copies") ?? undefined;
  const eventExclusive = interaction.options.getBoolean("event_exclusive") ?? false;

  if (!isKitsuCategory(category)) {
    await interaction.editReply("❌ Pick a valid category: Anime, Manga, or Character.");
    return;
  }

  if (!type) {
    await interaction.editReply("❌ Card type cannot be empty. Enter a type/tag such as `anime`, `manga`, or `character`.");
    return;
  }

  if (!CREATE_CARD_RARITIES.has(rarityInput)) {
    await interaction.editReply("❌ Pick one of the built-in rarities from autocomplete.");
    return;
  }
  const baseRarity = rarityInput as Rarity;
  const defs = createCardRarityDefaults(baseRarity);

  let item: KitsuItem | undefined;
  try {
    item = await resolveKitsuItem(category, itemName);
  } catch (err) {
    logger.error({ err, category, itemName }, "Failed to search Kitsu for create_card_from");
    await interaction.editReply("❌ Could not reach Kitsu. Try again later.");
    return;
  }

  if (!item) {
    await interaction.editReply(`❌ Could not find "${itemName}" in Kitsu ${category} library. Check the spelling or try another title.`);
    return;
  }

  const existing = await getCardByName(item.name, guildId);
  if (existing) {
    await interaction.editReply(
      `❌ A card named **${item.name}** already exists (ID #${existing.id}). ` +
      `Use \`/edit_card\` to modify it.`,
    );
    return;
  }

  let imageUrl: string | undefined;
  if (item.imageUrl) {
    try {
      imageUrl = await persistBotImage(item.imageUrl);
    } catch (err) {
      logger.error({ err, imageUrl: item.imageUrl }, "Failed to persist Kitsu image");
    }
  }

  let card;
  try {
    card = await addCard({
      name: item.name,
      rarity: baseRarity,
      cardType: type,
      description: descriptionOverride || item.description || "",
      imageUrl,
      worthValue: defs.worth,
      burnValue: defs.burn,
      dropWeight: defs.weight,
      isLimitedEdition: limited,
      maxCopies: limited ? (maxCopies ?? 50) : undefined,
      isEventExclusive: eventExclusive,
      droppable: !eventExclusive,
      inPacks: !eventExclusive && baseRarity !== "mythic",
    }, guildId);
  } catch (err) {
    logger.error({ err, itemName: item.name, guildId, category }, "Failed to create card from Kitsu");
    await interaction.editReply(
      `❌ Could not create card **${item.name}** — the server hit an error while saving it. ` +
      `Try again; if it keeps failing, tell me the exact title and the error message you see.`,
    );
    return;
  }

  let setNote = "";
  if (setName) {
    try {
      const set = await getSetByName(setName, guildId);
      if (set) {
        await addCardToSet(set.id, card.id, guildId);
        setNote = ` and added to set \`${set.name}\``;
      } else {
        setNote = ` (set \`${setName}\` was not found, so no set was assigned)`;
      }
    } catch (err) {
      logger.error({ err, cardId: card.id, setName, guildId }, "Failed to add Kitsu-created card to set");
      setNote = ` (could not add to set \`${setName}\`)`;
    }
  }

  await renderPanel(interaction, card.id, false, `✅ Created **${card.name}** from Kitsu ${category} (${baseRarity})${setNote} — tweak any field below`);
}

export async function handleLibraryCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  // Caller (admin.ts) has already deferred the reply.
  const category = interaction.options.getString("category", true);
  const name = interaction.options.getString("name", true).trim();

  if (!isKitsuCategory(category)) {
    await interaction.editReply("❌ Pick a valid category: Anime, Manga, or Character.");
    return;
  }

  let item: KitsuItem | undefined;
  try {
    item = await resolveKitsuItem(category, name);
  } catch (err) {
    logger.error({ err, category, name }, "Failed to search Kitsu for library");
    await interaction.editReply("❌ Could not reach Kitsu. Try again later.");
    return;
  }

  if (!item) {
    await interaction.editReply(`❌ Could not find "${name}" in Kitsu ${category} library.`);
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(item.name)
    .setDescription(item.description || "No synopsis available.")
    .setColor(0xff6b6b)
    .setImage(item.imageUrl ?? null)
    .setFooter({ text: `Kitsu ${category} · ID ${item.id}` });

  await interaction.editReply({ embeds: [embed] });
}

