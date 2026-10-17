// /add_card — interactive slash command replacing !addcard / !addlimited / !addevent.
//
// The command itself takes the core required fields (name, rarity, type) plus
// optional extras. Images are provided with Discord's native file upload.
//
// After creation the bot renders the /edit_card panel in the same ephemeral
// message so the admin can immediately refine anything.

import {
  type ChatInputCommandInteraction,
} from "discord.js";
import { addCard, addCardToSet, builtinRarityEconomy, getAllCards, getSetByName } from "../db.js";
import { duplicateCardMessage, findCollidingCard } from "../cards/name-collision.js";
import { renderPanel, persistBotImage } from "./edit-card.js";
import type { Rarity } from "../cards-data.js";

const BUILTIN_RARITIES = new Set<string>(["common", "uncommon", "rare", "epic", "legendary", "mythic"]);

export async function handleAddCardCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const opts        = interaction.options;
  const guildId     = interaction.guildId!;
  const name        = opts.getString("name", true).trim();
  const rarityInput = opts.getString("rarity", true);
  const type        = opts.getString("type", true).trim().toLowerCase().replace(/\s+/g, " ").slice(0, 40);
  const imageAttachment = opts.getAttachment("image");
  const imageUrl = imageAttachment
    ? await persistBotImage(imageAttachment.url, imageAttachment.contentType ?? undefined)
    : undefined;
  const setName     = opts.getString("set")?.trim();
  const description = opts.getString("description") ?? "";
  const limited        = opts.getBoolean("limited") ?? false;
  const maxCopies      = opts.getInteger("max_copies") ?? undefined;
  const eventExclusive = opts.getBoolean("event_exclusive") ?? false;

  if (!name) {
    await interaction.editReply("❌ Card name cannot be empty.");
    return;
  }

  if (!type) {
    await interaction.editReply("❌ Card type cannot be empty. Enter a type/tag such as `tank`, `aircraft`, or `nuke`.");
    return;
  }

  if (!BUILTIN_RARITIES.has(rarityInput)) {
    await interaction.editReply("❌ Pick one of the built-in rarities from autocomplete. Advanced labels can be managed from `/rarity`.");
    return;
  }
  const baseRarity = rarityInput as Rarity;
  const econ = await builtinRarityEconomy(guildId, baseRarity);
  const defs = { worth: econ.worthValue, burn: econ.burnValue, weight: econ.dropWeight };
  const worth = defs.worth;
  const burn = defs.burn;
  const weight = defs.weight;

  const existing = findCollidingCard(await getAllCards(guildId), name);
  if (existing) {
    await interaction.editReply(duplicateCardMessage(name, existing));
    return;
  }

  const card = await addCard({
    name,
    rarity: baseRarity,
    cardType: type,
    description,
    imageUrl,
    worthValue: worth,
    burnValue:  burn,
    dropWeight: weight,
    isLimitedEdition: limited,
    maxCopies: limited ? (maxCopies ?? 50) : undefined,
    isEventExclusive: eventExclusive,
    droppable: !eventExclusive,
    inPacks:   !eventExclusive && baseRarity !== "mythic",
  }, guildId);

  let setNote = "";
  if (setName) {
    const set = await getSetByName(setName, guildId);
    if (set) {
      await addCardToSet(set.id, card.id, guildId);
      setNote = ` and added to set \`${set.name}\``;
    } else {
      setNote = ` (set \`${setName}\` was not found, so no set was assigned)`;
    }
  }

  const rarityLabel = `**${baseRarity}**`;
  await renderPanel(interaction, card.id, false, `✅ Created **${card.name}** (${rarityLabel})${setNote} — tweak any field below`);
}
