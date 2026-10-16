// /create_card_from_roblox — search a Roblox user, preview the full-body
// avatar, then create a DN card with that name + image (same addCard path
// as /create_card_from_mttv / the old Kitsu create).

import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags,
  type AutocompleteInteraction, type ButtonInteraction,
  type ChatInputCommandInteraction, type GuildMember,
} from "discord.js";
import { isAdmin, addCard, addCardToSet, getCardByName, getSetByName } from "../db.js";
import { renderPanel, persistBotImage } from "./edit-card.js";
import { RARITY_BURN, RARITY_WEIGHTS, RARITY_WORTH, type Rarity } from "../cards-data.js";
import { logger } from "../../lib/logger.js";
import {
  searchUsers, resolveRobloxUser, getFullBodyAvatar, profileUrl,
  type RobloxUser,
} from "./roblox-users.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;
const CREATE_CARD_RARITIES = new Set<string>(["common", "uncommon", "rare", "epic", "legendary", "mythic"]);
const TTL_MS = 15 * 60 * 1000;

function createCardRarityDefaults(rarity: Rarity) {
  return {
    worth: RARITY_WORTH[rarity],
    burn: RARITY_BURN[rarity],
    weight: RARITY_WEIGHTS[rarity],
  };
}

type Draft = {
  guildId: string;
  userId: string;
  roblox: RobloxUser;
  fullBody: string | null;
  uploadedImageUrl?: string;
  uploadedContentType?: string;
  rarity: Rarity;
  type: string;
  setName: string | null;
  descriptionOverride: string;
  limited: boolean;
  maxCopies: number | null;
  eventExclusive: boolean;
};

const drafts = new Map<string, Draft>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function draftKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

function touchDraft(d: Draft): Draft {
  const key = draftKey(d.guildId, d.userId);
  drafts.set(key, d);
  const prev = timers.get(key);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    drafts.delete(key);
    timers.delete(key);
  }, TTL_MS);
  t.unref?.();
  timers.set(key, t);
  return d;
}

async function memberIsAdmin(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
): Promise<boolean> {
  if (!interaction.guild) return false;
  if (interaction.guild.ownerId === interaction.user.id) return true;
  const member = interaction.member as GuildMember | null;
  if (member?.permissions?.has("Administrator")) return true;
  return isAdmin(interaction.guild.id, interaction.user.id);
}

function cardNameFor(user: RobloxUser): string {
  return user.name.slice(0, 80);
}

function cardDescription(user: RobloxUser, override: string): string {
  if (override.trim()) return override.trim().slice(0, 500);
  const lines = [
    user.displayName && user.displayName !== user.name ? `${user.displayName} (@${user.name})` : `@${user.name}`,
    profileUrl(user.id),
    user.description?.trim() || "",
  ].filter(Boolean);
  return lines.join("\n").slice(0, 500);
}

export async function handleRobloxUserAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const q = String(interaction.options.getFocused(true).value ?? "").trim();
  if (q.length < 2) {
    await interaction.respond([]);
    return;
  }
  try {
    const hits = await searchUsers(q, 10);
    await interaction.respond(
      hits.slice(0, 25).map(h => ({
        name: `${h.displayName} (@${h.name})${h.hasVerifiedBadge ? " ✓" : ""}`.slice(0, 100),
        value: String(h.id),
      })),
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Roblox username autocomplete failed");
    await interaction.respond([]).catch(() => {});
  }
}

export async function handleCreateCardFromRoblox(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) return;
  if (!(await memberIsAdmin(interaction))) {
    await interaction.reply({ content: "❌ Admins only.", ...EPHEMERAL });
    return;
  }

  const username = interaction.options.getString("username", true).trim();
  const rarityInput = (interaction.options.getString("rarity", true) ?? "").trim().toLowerCase();
  const type = (interaction.options.getString("type") ?? "roblox").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 40) || "roblox";
  const uploaded = interaction.options.getAttachment("image");
  const setName = interaction.options.getString("set")?.trim() || null;
  const descriptionOverride = interaction.options.getString("description") ?? "";
  const limited = interaction.options.getBoolean("limited") ?? false;
  const maxCopies = interaction.options.getInteger("max_copies") ?? null;
  const eventExclusive = interaction.options.getBoolean("event_exclusive") ?? false;

  if (!CREATE_CARD_RARITIES.has(rarityInput)) {
    await interaction.reply({ content: "❌ Pick one of the built-in rarities from autocomplete.", ...EPHEMERAL });
    return;
  }

  await interaction.deferReply(EPHEMERAL);

  let user: RobloxUser | null;
  try {
    user = await resolveRobloxUser(username);
  } catch (err) {
    logger.error({ err, username }, "Roblox resolve failed");
    await interaction.editReply("❌ Could not reach Roblox. Try again in a moment.");
    return;
  }
  if (!user) {
    await interaction.editReply(`❌ Could not find Roblox user **${username}**. Type to search — autocomplete lists live matches.`);
    return;
  }

  const existing = await getCardByName(cardNameFor(user), interaction.guild.id);
  if (existing) {
    await interaction.editReply(
      `❌ A card named **${cardNameFor(user)}** already exists (ID #${existing.id}). Use \`/edit_card\` or \`/edit_image\`.`,
    );
    return;
  }

  const fullBody = uploaded?.url ? null : await getFullBodyAvatar(user.id);
  if (!uploaded?.url && !fullBody) {
    await interaction.editReply(`❌ **${user.name}** has no full-body avatar we can use. Upload an image, or try another user.`);
    return;
  }

  const draft = touchDraft({
    guildId: interaction.guild.id,
    userId: interaction.user.id,
    roblox: user,
    fullBody,
    uploadedImageUrl: uploaded?.url,
    uploadedContentType: uploaded?.contentType ?? undefined,
    rarity: rarityInput as Rarity,
    type,
    setName,
    descriptionOverride,
    limited,
    maxCopies,
    eventExclusive,
  });

  await interaction.editReply(previewPayload(draft));
}

function previewPayload(d: Draft) {
  const image = d.uploadedImageUrl || d.fullBody;
  const embed = new EmbedBuilder()
    .setColor(0x00a2ff)
    .setTitle(`Preview · ${d.roblox.name}`)
    .setURL(profileUrl(d.roblox.id))
    .setDescription(
      [
        d.roblox.displayName !== d.roblox.name ? `Display name: **${d.roblox.displayName}**` : null,
        `Card name: **${cardNameFor(d.roblox)}** · DN rarity: **${d.rarity}** · type: **${d.type}**`,
        d.setName ? `Set: **${d.setName}**` : null,
        "",
        "Full-body avatar below. Create to run the same card flow as `/add_card`.",
      ].filter(Boolean).join("\n"),
    )
    .setFooter({ text: `Roblox ID ${d.roblox.id}` });
  if (image) embed.setImage(image);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("rbxcreate:confirm").setLabel("Create card").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("rbxcreate:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
  );
  return { content: null as string | null, embeds: [embed], components: [row] };
}

export async function handleRobloxCreateButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) return;
  if (!(await memberIsAdmin(interaction))) {
    await interaction.reply({ content: "❌ Admins only.", ...EPHEMERAL });
    return;
  }
  const d = drafts.get(draftKey(interaction.guild.id, interaction.user.id));
  if (!d) {
    await interaction.reply({ content: "This preview expired — run `/create_card_from_roblox` again.", ...EPHEMERAL });
    return;
  }
  const action = interaction.customId.split(":")[1];
  if (action === "cancel") {
    drafts.delete(draftKey(d.guildId, d.userId));
    await interaction.update({ content: "Cancelled.", embeds: [], components: [] });
    return;
  }
  if (action !== "confirm") return;
  await runCreate(interaction, d);
}

async function runCreate(interaction: ButtonInteraction, d: Draft): Promise<void> {
  await interaction.deferUpdate();
  drafts.delete(draftKey(d.guildId, d.userId));

  const name = cardNameFor(d.roblox);
  const existing = await getCardByName(name, d.guildId);
  if (existing) {
    await interaction.editReply({
      content: `❌ A card named **${name}** already exists (ID #${existing.id}).`,
      embeds: [],
      components: [],
    });
    return;
  }

  const defs = createCardRarityDefaults(d.rarity);
  let imageUrl: string | undefined;
  try {
    if (d.uploadedImageUrl) imageUrl = await persistBotImage(d.uploadedImageUrl, d.uploadedContentType);
    else if (d.fullBody) imageUrl = await persistBotImage(d.fullBody);
  } catch (err) {
    logger.error({ err, name }, "Failed to persist Roblox avatar");
    await interaction.editReply({ content: `❌ Could not save **${name}**'s avatar. Try again.`, embeds: [], components: [] });
    return;
  }
  if (!imageUrl) {
    await interaction.editReply({ content: `❌ **${name}** has no image to save.`, embeds: [], components: [] });
    return;
  }

  let card;
  try {
    card = await addCard({
      name,
      rarity: d.rarity,
      cardType: d.type,
      description: cardDescription(d.roblox, d.descriptionOverride),
      imageUrl,
      worthValue: defs.worth,
      burnValue: defs.burn,
      dropWeight: defs.weight,
      isLimitedEdition: d.limited,
      maxCopies: d.limited ? (d.maxCopies ?? 50) : undefined,
      isEventExclusive: d.eventExclusive,
      droppable: !d.eventExclusive,
      inPacks: !d.eventExclusive && d.rarity !== "mythic",
    }, d.guildId);
  } catch (err) {
    logger.error({ err, name, guildId: d.guildId }, "Failed to create card from Roblox");
    await interaction.editReply({
      content: `❌ Could not create card **${name}** — the server hit an error while saving it.`,
      embeds: [],
      components: [],
    });
    return;
  }

  let setNote = "";
  if (d.setName) {
    try {
      const set = await getSetByName(d.setName, d.guildId);
      if (set) {
        await addCardToSet(set.id, card.id, d.guildId);
        setNote = ` and added to set \`${set.name}\``;
      } else {
        setNote = ` (set \`${d.setName}\` was not found, so no set was assigned)`;
      }
    } catch (err) {
      logger.error({ err, cardId: card.id, setName: d.setName }, "Failed to add Roblox-created card to set");
      setNote = ` (could not add to set \`${d.setName}\`)`;
    }
  }

  await renderPanel(
    interaction,
    card.id,
    false,
    `✅ Created **${card.name}** from Roblox (${d.rarity})${setNote} — tweak any field below`,
  );
}
