// /edit_card — interactive admin slash command for editing ANY card (defaults
// and custom alike). Mirrors the dashboard editor so admins can manage their
// roster without leaving Discord.
//
// Flow:
//   /edit_card name:<autocomplete>
//     → ephemeral preview + StringSelect "what to edit?"
//   On select:
//     • rarity / type        → secondary StringSelect with the valid values
//     • text/number fields   → Modal with a single input
//     • image upload         → pass image:<file> to /edit_card
//     • boolean toggles      → flipped immediately, panel re-renders
//
// Custom IDs:
//   editcard:menu:<id>            — main field picker select
//   editcard:rarity:<id>          — rarity sub-select
//   editcard:type:<id>            — card type sub-select
//   editcard:toggle:<field>:<id>  — immediate boolean flip via the menu select
//   editcard:modal:<field>:<id>   — text/number input modal

import {
  ActionRowBuilder, EmbedBuilder, ModalBuilder, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle, MessageFlags,
  type ChatInputCommandInteraction, type StringSelectMenuInteraction,
  type ModalSubmitInteraction, type RepliableInteraction,
} from "discord.js";
import { randomUUID } from "crypto";
import { logger } from "../../lib/logger.js";
import {
  assignCardToCustomRarity,
  getCardByName,
  getCardById,
  getCardDisplayRarity,
  getDisplayRarities,
  getOrCreateGuildSettings,
  getRarityContext,
  getRarityDisplayOverrides,
  unassignCardCustomRarity,
  updateCard,
} from "../db.js";
import { RARITY_EMOJI, selectMenuEmoji, type Rarity } from "../cards-data.js";
import { isOwnedBy } from "../home-guild.js";
import { ObjectStorageService } from "../../lib/objectStorage.js";
import { toAbsoluteImageUrl } from "../image-url.js";

// Helper: convert a stored imageUrl (absolute URL or /objects/... path) to an
// absolute URL that Discord embeds accept. Null/undefined passes through.
function cardImageUrl(url: string | null | undefined): string | null {
  return toAbsoluteImageUrl(url);
}

// ── Permanent image upload ────────────────────────────────────────────────────
// Discord slash-command attachment URLs are ephemeral — they expire within
// hours/days. Download the bytes and re-upload to the project's object storage
// (private object dir) so the app can serve them permanently via
// /api/storage/objects/<objectPath>. Returns an object path like /objects/uploads/...
// or an absolute URL if persistence is unavailable.
export async function persistBotImage(url: string, contentType?: string): Promise<string> {
  const storage = new ObjectStorageService();
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!resp.ok) {
      logger.warn({ url, status: resp.status, reason: "fetch_failed" }, "Image persistence skipped: fetch failed");
      return url;
    }
    const ct = contentType ?? resp.headers.get("content-type") ?? "image/png";
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0 || buf.length > 10 * 1024 * 1024) {
      logger.warn({ url, size: buf.length, reason: buf.length === 0 ? "empty" : "too_large" }, "Image persistence skipped: invalid size");
      return url; // 10 MB cap
    }

    const uploadURL = await storage.getObjectEntityUploadURL();
    const put = await fetch(uploadURL, {
      method: "PUT",
      headers: { "Content-Type": ct, "Content-Length": String(buf.length) },
      body: buf,
      signal: AbortSignal.timeout(30_000),
    });
    if (!put.ok) {
      const detail = await put.text().catch(() => "");
      logger.warn({ url, status: put.status, detail, reason: "gcs_put_failed" }, "Image persistence skipped: GCS PUT failed");
      return url;
    }

    const signed = new URL(uploadURL);
    const objectPath = storage.normalizeObjectEntityPath(`https://storage.googleapis.com${signed.pathname}`);
    return objectPath;
  } catch (err) {
    logger.warn({ url, reason: "upload_error", error: err instanceof Error ? err.message : String(err) }, "Image persistence skipped: upload error");
    return url; // graceful fallback — command still works, image just ephemeral
  }
}

const RARITIES: Rarity[] = ["common", "uncommon", "rare", "epic", "legendary", "mythic"];
const TYPE_CHOICES = ["tank", "aircraft", "ship", "vehicle", "infantry", "boss", "community", "event", "achievement", "limited"];

// ── Preview embed + field-picker select ─────────────────────────────────────
async function buildPanel(cardId: number, guildId?: string | null): Promise<{ embeds: EmbedBuilder[]; components: ActionRowBuilder<StringSelectMenuBuilder>[] } | null> {
  const card = await getCardById(cardId, guildId);
  if (!card) return null;
  const [settings, displayMap, ctx] = guildId
    ? await Promise.all([getOrCreateGuildSettings(guildId), getRarityDisplayOverrides(guildId), getRarityContext(guildId)])
    : [null, null, null] as const;
  const displayRarity = getCardDisplayRarity(card, ctx, settings, displayMap);
  const embed = new EmbedBuilder()
    .setTitle(`✏️ Edit: ${card.name}`)
    .setColor(displayRarity.color)
    .setDescription(card.description || "_(no description)_")
    .addFields(
      { name: "Rarity", value: `${displayRarity.emoji} ${displayRarity.label}`, inline: true },
      { name: "Type", value: card.cardType, inline: true },
      { name: "Worth", value: `💠 ${card.worthValue.toLocaleString()}`, inline: true },
      { name: "Burn", value: `💠 ${card.burnValue.toLocaleString()}`, inline: true },
      { name: "In Packs", value: card.inPacks ? "✅ Yes" : "❌ No", inline: true },
      { name: "Droppable", value: card.droppable ? "✅ Yes" : "❌ No", inline: true },
      { name: "Archived", value: card.isArchived ? "🗄️ Yes" : "❌ No", inline: true },
      { name: "Limited", value: card.isLimitedEdition ? `💎 Yes (${card.totalMinted}/${card.maxCopies ?? "?"})` : "❌ No", inline: true },
    )
    .setFooter({ text: `Card #${card.id} — /edit_image name:${card.name} to pull a Vault Values image or upload a file.` });
  const thumbUrl = cardImageUrl(card.imageUrl);
  if (thumbUrl) embed.setThumbnail(thumbUrl);

  const select = new StringSelectMenuBuilder()
    .setCustomId(`editcard:menu:${card.id}`)
    .setPlaceholder("Pick a field to edit…")
    .addOptions(
      { label: "Rarity", value: "rarity", emoji: "✨", description: `Currently ${displayRarity.label}` },
      { label: "Name", value: "name", emoji: "🏷️" },
      { label: "Description", value: "description", emoji: "📝" },
      { label: "Type", value: "type", emoji: "🎯", description: `Currently ${card.cardType}` },
      { label: "Worth value", value: "worthValue", emoji: "💠", description: `Currently ${card.worthValue.toLocaleString()}` },
      { label: "Burn value", value: "burnValue", emoji: "🔥", description: `Currently ${card.burnValue.toLocaleString()}` },
      { label: `Max copies ${card.maxCopies ?? "∞"}`, value: "maxCopies", emoji: "🔢", description: card.isLimitedEdition ? `Limited (${card.totalMinted}/${card.maxCopies ?? "?"})` : "Not limited" },
      { label: `Total minted ${card.totalMinted.toLocaleString()}`, value: "totalMinted", emoji: "🏭", description: "How many copies currently exist" },
      { label: card.inPacks ? "Toggle: remove from packs" : "Toggle: add to packs", value: "toggle:inPacks", emoji: "📦" },
      { label: card.droppable ? "Toggle: make undroppable" : "Toggle: make droppable", value: "toggle:droppable", emoji: "🎁" },
      { label: card.isArchived ? "Toggle: un-archive" : "Toggle: archive", value: "toggle:isArchived", emoji: "🗄️" },
      { label: card.isLimitedEdition ? "Toggle: not limited" : "Toggle: limited", value: "toggle:isLimitedEdition", emoji: "💎" },
    );

  return { embeds: [embed], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)] };
}

export async function renderPanel(
  interaction: RepliableInteraction,
  cardId: number,
  reply: boolean,
  content?: string,
): Promise<void> {
  const panel = await buildPanel(cardId, (interaction as { guildId?: string | null }).guildId);
  if (!panel) {
    const errContent = "❌ Card not found.";
    if (reply) await interaction.reply({ content: errContent, flags: MessageFlags.Ephemeral }).catch(() => {});
    else if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
      await interaction.editReply({ content: errContent, embeds: [], components: [] }).catch(() => {});
    }
    return;
  }
  if (reply) {
    await interaction.reply({ ...panel, content, flags: MessageFlags.Ephemeral });
  } else {
    await interaction.editReply({ ...panel, content: content ?? "" });
  }
}

// ── Slash entry ─────────────────────────────────────────────────────────────
// admin.ts already called deferReply(ephemeral) before dispatching here,
// so we use editReply (reply=false) instead of reply.
export async function handleEditCardCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const name = interaction.options.getString("name", true).trim();
  const image = interaction.options.getAttachment("image");
  const maxCopiesOpt = interaction.options.getInteger("max_copies");
  const totalMintedOpt = interaction.options.getInteger("total_minted");
  const limitedOpt = interaction.options.getBoolean("limited");
  const guildId = interaction.guildId;
  if (!guildId) return;
  const card = await getCardByName(name, guildId);
  if (!card) {
    await interaction.editReply(`❌ No card named **${name}**. Use autocomplete to pick one.`);
    return;
  }
  if (!isOwnedBy(card, guildId)) {
    await interaction.editReply(`❌ You can only edit cards owned by this server.`);
    return;
  }

  const directPatch: Parameters<typeof updateCard>[1] = {};
  if (image) {
    directPatch.imageUrl = await persistBotImage(image.url, image.contentType ?? undefined);
  }
  if (maxCopiesOpt !== null) {
    directPatch.maxCopies = maxCopiesOpt === 0 ? null : maxCopiesOpt;
    if (maxCopiesOpt > 0) directPatch.isLimitedEdition = true;
  }
  if (totalMintedOpt !== null) {
    directPatch.totalMinted = totalMintedOpt;
  }
  if (limitedOpt !== null) {
    directPatch.isLimitedEdition = limitedOpt;
    // Match /addcard: turning limited on with no cap defaults to 50.
    if (limitedOpt && maxCopiesOpt === null && card.maxCopies === null) {
      directPatch.maxCopies = 50;
    }
  }

  const directFields = Object.keys(directPatch).length;
  if (directFields > 0) {
    await updateCard(card.id, directPatch);
  }

  await renderPanel(
    interaction,
    card.id,
    false,
    directFields > 0 || image
      ? `✅ Updated **${card.name}**.`
      : undefined,
  );
}

// ── Select handler ──────────────────────────────────────────────────────────
export async function handleEditCardSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const parts = interaction.customId.split(":"); // editcard:<sub>:<id> or editcard:toggle:<field>:<id>
  const sub = parts[1];
  const cardId = Number(parts[parts.length - 1]);
  const value = interaction.values[0]!;

  // Main menu — route to sub-flows
  if (sub === "menu") {
    // Boolean toggle: "toggle:<field>"
    if (value.startsWith("toggle:")) {
      await interaction.deferUpdate();
      if (!interaction.guildId) return;
      const field = value.slice("toggle:".length) as "inPacks" | "droppable" | "isArchived" | "isLimitedEdition";
      const card = await getCardById(cardId, interaction.guildId);
      if (!card || !isOwnedBy(card, interaction.guildId)) {
        await interaction.editReply({ content: "❌ Card not found or not owned by this server.", embeds: [], components: [] });
        return;
      }
      const cur = (card as unknown as Record<string, boolean>)[field];
      const patch: Parameters<typeof updateCard>[1] = { [field]: !cur };
      // Turning on limited edition without a cap is confusing; default to 50 like /addcard.
      if (field === "isLimitedEdition" && !cur && card.maxCopies === null) {
        patch.maxCopies = 50;
      }
      await updateCard(card.id, patch);
      await renderPanel(interaction, cardId, false);
      return;
    }

    // Rarity → secondary select. Built-ins update the card identity; custom
    // tiers write the same Setup Hub assignment table used by /rarity.
    if (value === "rarity") {
      const [settings, displayMap, ctx] = interaction.guildId
        ? await Promise.all([getOrCreateGuildSettings(interaction.guildId), getRarityDisplayOverrides(interaction.guildId), getRarityContext(interaction.guildId)])
        : [null, null, null] as const;
      const rarities = ctx
        ? getDisplayRarities(ctx, settings, { displayMap, rarestFirst: false })
        : RARITIES.map(r => getCardDisplayRarity({ id: -1, rarity: r }, null, settings, displayMap));
      const select = new StringSelectMenuBuilder()
        .setCustomId(`editcard:rarity:${cardId}`)
        .setPlaceholder("Pick a rarity…")
        .addOptions(rarities.slice(0, 25).map(r => ({
          label: r.label.slice(0, 100),
          value: r.isCustom ? `custom:${r.slug}` : `builtin:${r.rarity}`,
          emoji: selectMenuEmoji(r.emoji, r.isCustom ? "⭐" : RARITY_EMOJI[r.rarity as Rarity] ?? "🃏"),
        })));
      await interaction.update({
        content: "✨ Pick the new rarity:",
        embeds: [],
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
      });
      return;
    }

    // Type → modal with free-text input (accepts any tag, not limited to fixed choices)
    if (value === "type") {
      await openFieldModal(interaction, cardId, "type");
      return;
    }

    // Text/number fields → open a modal
    await openFieldModal(interaction, cardId, value);
    return;
  }

  // Rarity sub-select. Built-ins clear any custom assignment; custom tiers use
  // the authoritative card_rarity_overrides row so every display stays synced.
  if (sub === "rarity") {
    await interaction.deferUpdate();
    if (!interaction.guildId) return;
    const card = await getCardById(cardId, interaction.guildId);
    if (!card || !isOwnedBy(card, interaction.guildId)) {
      await renderPanel(interaction, cardId, false, "❌ Card not found or not owned by this server.");
      return;
    }
    if (value.startsWith("custom:")) {
      const slug = value.slice("custom:".length);
      const ctx = await getRarityContext(interaction.guildId);
      if (!ctx.customBySlug.has(slug)) {
        await renderPanel(interaction, cardId, false, "❌ That custom rarity no longer exists.");
        return;
      }
      await assignCardToCustomRarity(interaction.guildId, cardId, slug);
    } else {
      const rarity = value.startsWith("builtin:") ? value.slice("builtin:".length) : value;
      if (!RARITIES.includes(rarity as Rarity)) return;
      await updateCard(cardId, { rarity });
      await unassignCardCustomRarity(interaction.guildId, cardId);
    }
    await renderPanel(interaction, cardId, false);
    return;
  }

  // Type sub-select
  if (sub === "type") {
    await interaction.deferUpdate();
    if (!interaction.guildId) return;
    const card = await getCardById(cardId, interaction.guildId);
    if (!card || !isOwnedBy(card, interaction.guildId)) {
      await renderPanel(interaction, cardId, false, "❌ Card not found or not owned by this server.");
      return;
    }
    await updateCard(cardId, { cardType: value });
    await renderPanel(interaction, cardId, false);
    return;
  }
}

// ── Modal for text/number fields ────────────────────────────────────────────
const TEXT_FIELDS: Record<string, { title: string; label: string; style: TextInputStyle; max?: number; placeholder?: string }> = {
  name:        { title: "Edit Name",        label: "Card name (1–80 chars)",                      style: TextInputStyle.Short,     max: 80 },
  description: { title: "Edit Description", label: "Description (max 500 chars)",                  style: TextInputStyle.Paragraph, max: 500 },
  worthValue:  { title: "Edit Worth Value", label: "Worth value in DN Shards",                     style: TextInputStyle.Short,     placeholder: "Example: 2500" },
  burnValue:   { title: "Edit Burn Value",  label: "Burn value in DN Shards",                      style: TextInputStyle.Short,     placeholder: "Example: 1250" },
  type:        { title: "Edit Card Type",   label: "Type/tag (e.g. tank, aircraft, nuke)", style: TextInputStyle.Short,     max: 40, placeholder: "e.g. tank, aircraft, nuke" },
  maxCopies:   { title: "Edit Max Copies",  label: "Max copies (0 = remove limit)", style: TextInputStyle.Short,     placeholder: "Example: 50" },
  totalMinted: { title: "Edit Total Minted", label: "Copies in existence (manual)", style: TextInputStyle.Short,     placeholder: "Example: 12" },
};

async function openFieldModal(interaction: StringSelectMenuInteraction, cardId: number, field: string): Promise<void> {
  const def = TEXT_FIELDS[field];
  if (!def) { await interaction.deferUpdate().catch(() => {}); return; }
  const card = await getCardById(cardId, interaction.guildId);
  // "type" in the UI maps to "cardType" in the card object
  const propKey = field === "type" ? "cardType" : field;
  const current = card ? String((card as unknown as Record<string, unknown>)[propKey] ?? "") : "";
  const input = new TextInputBuilder()
    .setCustomId("value")
    .setLabel(def.label)
    .setStyle(def.style)
    .setRequired(field === "name") // only name is required; others may be blank/0
    .setValue(current.length <= (def.max ?? 4000) ? current : "");
  if (def.max) input.setMaxLength(def.max);
  if (def.placeholder) input.setPlaceholder(def.placeholder);

  const modal = new ModalBuilder()
    .setCustomId(`editcard:modal:${field}:${cardId}`)
    .setTitle(def.title)
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  await interaction.showModal(modal);
}

export async function handleEditCardModal(interaction: ModalSubmitInteraction): Promise<void> {
  const parts = interaction.customId.split(":"); // editcard:modal:<field>:<id>
  const field = parts[2]!;
  const cardId = Number(parts[3]);
  const raw = interaction.fields.getTextInputValue("value").trim();

  const patch: Record<string, unknown> = {};
  switch (field) {
    case "name":
      if (!raw) { await interaction.reply({ content: "❌ Name cannot be empty.", flags: MessageFlags.Ephemeral }); return; }
      patch.name = raw;
      break;
    case "description":
      patch.description = raw;
      break;
    case "worthValue":
    case "burnValue": {
      const value = Number(raw.replace(/,/g, ""));
      if (!Number.isInteger(value) || value < 0) {
        await interaction.reply({ content: "❌ Enter a whole number of shards, 0 or higher.", flags: MessageFlags.Ephemeral });
        return;
      }
      patch[field] = value;
      break;
    }
    case "maxCopies": {
      const value = Number(raw.replace(/,/g, ""));
      if (!Number.isInteger(value) || value < 0) {
        await interaction.reply({ content: "❌ Enter a whole number, 0 or higher. Use 0 to remove the copy limit.", flags: MessageFlags.Ephemeral });
        return;
      }
      patch.maxCopies = value === 0 ? null : value;
      if (value > 0) patch.isLimitedEdition = true;
      break;
    }
    case "totalMinted": {
      const value = Number(raw.replace(/,/g, ""));
      if (!Number.isInteger(value) || value < 0) {
        await interaction.reply({ content: "❌ Enter a whole number of copies, 0 or higher.", flags: MessageFlags.Ephemeral });
        return;
      }
      patch.totalMinted = value;
      break;
    }
    case "type":
      patch.cardType = raw.toLowerCase().trim().slice(0, 40) || "vehicle";
      break;
    default:
      await interaction.reply({ content: "❌ Unknown field.", flags: MessageFlags.Ephemeral });
      return;
  }

  if (!interaction.guildId) {
    await interaction.reply({ content: "❌ This command can only be used in a server.", flags: MessageFlags.Ephemeral });
    return;
  }
  const card = await getCardById(cardId, interaction.guildId);
  if (!card || !isOwnedBy(card, interaction.guildId)) {
    await interaction.reply({ content: "❌ Card not found or not owned by this server.", flags: MessageFlags.Ephemeral });
    return;
  }

  try {
    await updateCard(cardId, patch as Parameters<typeof updateCard>[1]);
  } catch (err) {
    const msg = err instanceof Error && /unique|duplicate/i.test(err.message)
      ? "❌ Another card already has that name."
      : "❌ Update failed.";
    await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    return;
  }

  // Re-render the panel in the original ephemeral message.
  await interaction.deferUpdate();
  await renderPanel(interaction, cardId, false);
}
