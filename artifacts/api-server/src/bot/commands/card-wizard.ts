import type { Message } from "discord.js";
import { addCard, getCardByName, updateCard } from "../db.js";
import {
  RARITY_WEIGHTS, RARITY_WORTH, RARITY_BURN,
  TYPE_EMOJI, getTypeEmoji,
  type Rarity, rarityLabel, rarityEmoji,
} from "../cards-data.js";
import { getRarityDisplayOverrides } from "../db.js";
import { persistBotImage } from "./edit-card.js";
import type { Card } from "@workspace/db";

// ── Types ─────────────────────────────────────────────────────────────────────
type CardKind = "standard" | "limited" | "event";

type CardWizardStep =
  | "card_name"
  | "card_desc"
  | "card_rarity"
  | "card_ctype"
  | "card_maxcopies"
  | "card_image"
  | "card_confirm";

interface CardWizardSession {
  step: CardWizardStep;
  guildId: string;
  channelId: string;
  lastActivity: number;
  kind: CardKind;
  data: {
    name?: string;
    description?: string;
    rarity?: Rarity;
    cardType?: string;
    maxCopies?: number;
    imageUrl?: string;
  };
}

const WIZARD_TIMEOUT_MS = 5 * 60 * 1000;
const sessions = new Map<string, CardWizardSession>();

function key(guildId: string, userId: string) { return `cw:${guildId}:${userId}`; }

const RARITY_CHOICES: Rarity[] = ["common", "uncommon", "rare", "epic", "legendary"];
const TYPE_CHOICES: string[] = [
  "tank", "aircraft", "ship", "vehicle", "infantry",
  "boss", "community", "event", "achievement", "limited",
];

const KIND_LABEL: Record<CardKind, string> = {
  standard: "Standard Card",
  limited: "Limited Edition",
  event: "Event Exclusive",
};

// ── Start card wizard ─────────────────────────────────────────────────────────
export async function startCardWizard(msg: Message, kind: CardKind): Promise<void> {
  if (!msg.guild) return;

  sessions.set(key(msg.guild.id, msg.author.id), {
    step: "card_name",
    guildId: msg.guild.id,
    channelId: msg.channelId,
    lastActivity: Date.now(),
    kind,
    data: {},
  });

  const kindEmoji = kind === "standard" ? "🃏" : kind === "limited" ? "💎" : "🎆";
  await msg.reply(
    `## ${kindEmoji} Card Creation — ${KIND_LABEL[kind]}\n` +
    (kind === "limited" ? "Admin-drop only, capped copies, 4× worth/burn value.\n\n" : "") +
    (kind === "event" ? "Admin-drop only, never spawns randomly, 3× worth/burn value.\n\n" : "") +
    "Type `cancel` at any step to abort.\n\n" +
    "**Step 1 — Name**\nWhat is the card's name?",
  );
}

// ── Handle wizard message ─────────────────────────────────────────────────────
export async function handleCardWizardStep(msg: Message): Promise<boolean> {
  if (!msg.guild) return false;

  const sessionKey = key(msg.guild.id, msg.author.id);
  const session = sessions.get(sessionKey);
  if (!session) return false;
  if (msg.channelId !== session.channelId) return false;

  if (Date.now() - session.lastActivity > WIZARD_TIMEOUT_MS) {
    sessions.delete(sessionKey);
    return false;
  }
  session.lastActivity = Date.now();

  const content = msg.content.trim();

  if (content.toLowerCase() === "cancel") {
    sessions.delete(sessionKey);
    await msg.reply("❌ Card creation cancelled.");
    return true;
  }

  return processStep(msg, session, sessionKey, content);
}

// ── Step processor ────────────────────────────────────────────────────────────
async function processStep(
  msg: Message, session: CardWizardSession, sessionKey: string, input: string,
): Promise<boolean> {
  switch (session.step) {

    // ── Name ──────────────────────────────────────────────────────────────────
    case "card_name": {
      const name = input.slice(0, 64).trim();
      if (name.length < 2) { await msg.reply("❌ Name must be at least 2 characters. Try again:"); return true; }
      session.data.name = name;
      session.step = "card_desc";
      await msg.reply(
        `✅ Name: **${name}**\n\n` +
        "**Step 2 — Description**\nEnter a short description for this card, or type **skip**:",
      );
      return true;
    }

    // ── Description ───────────────────────────────────────────────────────────
    case "card_desc": {
      session.data.description = input.toLowerCase() === "skip" ? "" : input.slice(0, 256).trim();
      session.step = "card_rarity";

      const displayMap = await getRarityDisplayOverrides(msg.guild!.id);
      const rarityLines = RARITY_CHOICES.map((r, i) =>
        `**${i + 1}️⃣ ${rarityEmoji(r, null, displayMap)} ${rarityLabel(r, null, displayMap)}** — 💠 ${RARITY_WORTH[r].toLocaleString()} worth · 🔥 ${RARITY_BURN[r].toLocaleString()} burn`,
      ).join("\n");

      await msg.reply(
        `✅ Description set.\n\n**Step 3 — Rarity**\nChoose a rarity:\n\n${rarityLines}\n\nType **1–5**:`,
      );
      return true;
    }

    // ── Rarity ────────────────────────────────────────────────────────────────
    case "card_rarity": {
      const idx = parseInt(input, 10) - 1;
      if (idx < 0 || idx >= RARITY_CHOICES.length) {
        await msg.reply("❌ Please type a number **1–5**:");
        return true;
      }
      session.data.rarity = RARITY_CHOICES[idx];
      session.step = "card_ctype";

      const displayMap = await getRarityDisplayOverrides(msg.guild!.id);
      const rLabel = rarityLabel(session.data.rarity!, null, displayMap);
      const rEmoji = rarityEmoji(session.data.rarity!, null, displayMap);
      await msg.reply(
        `✅ Rarity: ${rEmoji} **${rLabel}**\n\n` +
        "**Step 4 — Card Type**\n" +
        "Type any card type/tag (e.g. `tank`, `aircraft`, `nuke`, `infantry`) — or type **skip** for `vehicle`:",
      );
      return true;
    }

    // ── Card Type ─────────────────────────────────────────────────────────────
    case "card_ctype": {
      const lower = input.toLowerCase().trim();
      const cardType = lower === "skip" ? "vehicle" : lower.slice(0, 40);
      if (!cardType) {
        await msg.reply("❌ Please type a card type (e.g. `tank`, `aircraft`, `nuke`) or **skip** for `vehicle`:");
        return true;
      }
      session.data.cardType = cardType;

      if (session.kind === "limited") {
        session.step = "card_maxcopies";
        await msg.reply(
          `✅ Type: ${getTypeEmoji(session.data.cardType)} **${session.data.cardType}**\n\n` +
          "**Step 5 — Max Copies**\nHow many copies of this card can exist? Enter a number:",
        );
      } else {
        session.step = "card_image";
        await askImage(msg, session);
      }
      return true;
    }

    // ── Max Copies (limited only) ─────────────────────────────────────────────
    case "card_maxcopies": {
      const n = parseInt(input, 10);
      if (isNaN(n) || n < 1) { await msg.reply("❌ Enter a whole number ≥ 1:"); return true; }
      session.data.maxCopies = n;
      session.step = "card_image";
      await askImage(msg, session);
      return true;
    }

    // ── Image ─────────────────────────────────────────────────────────────────
    case "card_image": {
      const attachment = msg.attachments.first();
      const isUrl = /^https?:\/\/.+/i.test(input);
      const isSkip = input.toLowerCase() === "skip";

      if (attachment) {
        session.data.imageUrl = await persistBotImage(attachment.url, attachment.contentType ?? undefined);
      } else if (isUrl) {
        session.data.imageUrl = input;
      } else if (isSkip) {
        session.data.imageUrl = undefined;
      } else {
        await msg.reply("❌ Please attach an image, paste an image URL, or type **skip**:");
        return true;
      }

      session.step = "card_confirm";
      await showConfirmation(msg, session);
      return true;
    }

    // ── Confirm ───────────────────────────────────────────────────────────────
    case "card_confirm": {
      if (input.toLowerCase() !== "confirm") {
        if (input.toLowerCase() === "cancel") {
          sessions.delete(sessionKey);
          await msg.reply("❌ Card creation cancelled.");
          return true;
        }
        await msg.reply("Type **confirm** to create the card or **cancel** to abort:");
        return true;
      }

      sessions.delete(sessionKey);
      await createCard(msg, session);
      return true;
    }

    default:
      sessions.delete(sessionKey);
      return false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function askImage(msg: Message, session: CardWizardSession) {
  const stepNum = session.kind === "limited" ? "6" : "5";
  await msg.reply(
    `**Step ${stepNum} — Image (optional)**\n` +
    "Attach an image to this message, paste a direct image URL, or type **skip**:",
  );
}

async function showConfirmation(msg: Message, session: CardWizardSession) {
  const d = session.data;
  const r = d.rarity!;
  const mult = session.kind === "limited" ? 4 : session.kind === "event" ? 3 : 1;
  const worth = RARITY_WORTH[r] * mult;
  const burn = RARITY_BURN[r] * mult;

  const guildId = msg.guild?.id;
  const displayMap = guildId ? await getRarityDisplayOverrides(guildId) : null;
  const rLabel = rarityLabel(r, null, displayMap);
  const rEmoji = rarityEmoji(r, null, displayMap);

  const kindEmoji = session.kind === "standard" ? "🃏" : session.kind === "limited" ? "💎" : "🎆";
  const lines = [
    `**Name:** ${d.name}`,
    `**Kind:** ${kindEmoji} ${KIND_LABEL[session.kind]}`,
    `**Rarity:** ${rEmoji} ${rLabel}`,
    `**Type:** ${getTypeEmoji(d.cardType)} ${d.cardType}`,
    d.description ? `**Description:** ${d.description}` : "*No description*",
    `**Worth:** 💠 ${worth.toLocaleString()} · **Burn:** 🔥 ${burn.toLocaleString()}`,
    session.kind === "limited" ? `**Max Copies:** ${d.maxCopies}` : "",
    d.imageUrl ? `**Image:** [attached/linked]` : "*No image*",
  ].filter(Boolean).join("\n");

  await msg.reply(
    `**📋 Review your card:**\n${lines}\n\n` +
    "Type **confirm** to create it, or **cancel** to abort:",
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// EDIT WIZARD — !editcard <Name>
// ═══════════════════════════════════════════════════════════════════════════════

type EditStep =
  | "edit_menu"
  | "edit_rarity"
  | "edit_worth"
  | "edit_burn"
  | "edit_desc"
  | "edit_image"
  | "edit_ctype"
  | "edit_name";

interface EditSession {
  step: EditStep;
  guildId: string;
  channelId: string;
  lastActivity: number;
  cardId: number;
}

const editSessions = new Map<string, EditSession>();
function ekey(guildId: string, userId: string) { return `ce:${guildId}:${userId}`; }

export async function startEditWizard(msg: Message, cardName: string): Promise<void> {
  if (!msg.guild) return;
  const card = await getCardByName(cardName, msg.guild.id);
  if (!card) {
    await msg.reply(`❌ No card named **${cardName}** found. Try \`/list\` to see all cards.`);
    return;
  }

  editSessions.set(ekey(msg.guild.id, msg.author.id), {
    step: "edit_menu",
    guildId: msg.guild.id,
    channelId: msg.channelId,
    lastActivity: Date.now(),
    cardId: card.id,
  });

  await showEditMenu(msg, card);
}

async function showEditMenu(msg: Message, card: Card) {
  const r = card.rarity as Rarity;
  const guildId = msg.guild?.id;
  const displayMap = guildId ? await getRarityDisplayOverrides(guildId) : null;
  const rLabel = rarityLabel(r, null, displayMap);
  const rEmoji = rarityEmoji(r, null, displayMap);
  await msg.reply(
    `## ✏️ Editing: **${card.name}**\n` +
    `**Current values:**\n` +
    `• Rarity: ${rEmoji} ${rLabel} (spawn chance source ${card.dropWeight})\n` +
    `• Worth: 💠 ${card.worthValue.toLocaleString()} · Burn: 🔥 ${card.burnValue.toLocaleString()}\n` +
    `• Type: ${getTypeEmoji(card.cardType)} ${card.cardType}\n` +
    `• Description: ${card.description || "*none*"}\n` +
    `• Image: ${card.imageUrl ? "✅ set" : "*none*"}\n\n` +
    `**Which field do you want to change?**\n` +
    `**1.** Rarity   **2.** Worth   **3.** Burn value\n` +
    `**4.** Description   **5.** Image   **6.** Card type   **7.** Name\n\n` +
    `Type a number, or **done** to finish:`,
  );
}

export async function handleCardEditStep(msg: Message): Promise<boolean> {
  if (!msg.guild) return false;
  const k = ekey(msg.guild.id, msg.author.id);
  const session = editSessions.get(k);
  if (!session) return false;
  if (msg.channelId !== session.channelId) return false;

  if (Date.now() - session.lastActivity > WIZARD_TIMEOUT_MS) {
    editSessions.delete(k);
    return false;
  }
  session.lastActivity = Date.now();

  const input = msg.content.trim();
  if (input.toLowerCase() === "cancel" || input.toLowerCase() === "done") {
    editSessions.delete(k);
    await msg.reply("✅ Done editing.");
    return true;
  }

  return processEditStep(msg, session, k, input);
}

async function processEditStep(msg: Message, session: EditSession, k: string, input: string): Promise<boolean> {
  const lower = input.toLowerCase();

  switch (session.step) {
    case "edit_menu": {
      const map: Record<string, EditStep> = {
        "1": "edit_rarity", "2": "edit_worth", "3": "edit_burn",
        "4": "edit_desc", "5": "edit_image", "6": "edit_ctype", "7": "edit_name",
      };
      const next = map[input];
      if (!next) { await msg.reply("❌ Type a number **1–7**, or **done** to finish:"); return true; }
      session.step = next;
      await promptForField(msg, next);
      return true;
    }

    case "edit_rarity": {
      const idx = parseInt(input, 10) - 1;
      if (idx < 0 || idx >= RARITY_CHOICES.length) {
        await msg.reply("❌ Type **1–5**:"); return true;
      }
      const newRarity = RARITY_CHOICES[idx];
      await updateCard(session.cardId, { rarity: newRarity, dropWeight: RARITY_WEIGHTS[newRarity] });
      const displayMap = await getRarityDisplayOverrides(msg.guild!.id);
      const rLabel = rarityLabel(newRarity, null, displayMap);
      const rEmoji = rarityEmoji(newRarity, null, displayMap);
      await msg.reply(`✅ Rarity → ${rEmoji} **${rLabel}** (spawn % source reset to ${RARITY_WEIGHTS[newRarity]}).`);
      return await backToMenu(msg, session);
    }

    case "edit_worth": {
      const n = parseInt(input, 10);
      if (isNaN(n) || n < 0) { await msg.reply("❌ Enter a whole number ≥ 0:"); return true; }
      await updateCard(session.cardId, { worthValue: n });
      await msg.reply(`✅ Worth → 💠 **${n.toLocaleString()}** shards.`);
      return await backToMenu(msg, session);
    }

    case "edit_burn": {
      const n = parseInt(input, 10);
      if (isNaN(n) || n < 0) { await msg.reply("❌ Enter a whole number ≥ 0:"); return true; }
      await updateCard(session.cardId, { burnValue: n });
      await msg.reply(`✅ Burn → 🔥 **${n.toLocaleString()}** shards.`);
      return await backToMenu(msg, session);
    }

    case "edit_desc": {
      const desc = lower === "skip" ? "" : input.slice(0, 500);
      await updateCard(session.cardId, { description: desc });
      await msg.reply(desc ? `✅ Description updated.` : `✅ Description cleared.`);
      return await backToMenu(msg, session);
    }

    case "edit_image": {
      const attachment = msg.attachments.first();
      if (attachment) {
        const permanentUrl = await persistBotImage(attachment.url, attachment.contentType ?? undefined);
        await updateCard(session.cardId, { imageUrl: permanentUrl });
        await msg.reply("✅ Image updated.");
      } else if (lower === "remove" || lower === "clear") {
        await updateCard(session.cardId, { imageUrl: null });
        await msg.reply("✅ Image removed.");
      } else if (/^https?:\/\/.+/i.test(input)) {
        await updateCard(session.cardId, { imageUrl: input });
        await msg.reply("✅ Image URL updated.");
      } else {
        await msg.reply("❌ Attach an image, paste an image URL, or type **remove**:");
        return true;
      }
      return await backToMenu(msg, session);
    }

    case "edit_ctype": {
      const newType = input.toLowerCase().trim().slice(0, 40);
      if (!newType) { await msg.reply("❌ Please enter a card type:"); return true; }
      await updateCard(session.cardId, { cardType: newType });
      await msg.reply(`✅ Type → **${newType}**.`);
      return await backToMenu(msg, session);
    }

    case "edit_name": {
      const newName = input.slice(0, 64).trim();
      if (newName.length < 2) { await msg.reply("❌ Name must be at least 2 characters:"); return true; }
      try {
        await updateCard(session.cardId, { name: newName });
        await msg.reply(`✅ Renamed to **${newName}**.`);
      } catch {
        await msg.reply(`❌ A card named **${newName}** already exists.`);
      }
      return await backToMenu(msg, session);
    }
  }
  return false;
}

async function promptForField(msg: Message, step: EditStep) {
  switch (step) {
    case "edit_rarity": {
      const displayMap = await getRarityDisplayOverrides(msg.guild!.id);
      const lines = RARITY_CHOICES.map((r, i) => `**${i + 1}.** ${rarityEmoji(r, null, displayMap)} ${rarityLabel(r, null, displayMap)} — 💠 ${RARITY_WORTH[r]} / 🔥 ${RARITY_BURN[r]} default`).join("\n");
      await msg.reply(`**Choose new rarity:**\n${lines}\n\nType **1–5**:`);
      return;
    }
    case "edit_worth": await msg.reply("Enter new **worth value** (whole number, 💠 shards earned when traded/collected):"); return;
    case "edit_burn": await msg.reply("Enter new **burn value** (whole number, 🔥 shards earned when burned):"); return;
    case "edit_desc": await msg.reply("Enter a new **description**, or type **skip** to clear:"); return;
    case "edit_image": await msg.reply("Attach an image, paste an image URL, or type **remove** to clear:"); return;
    case "edit_ctype": {
      await msg.reply("**Enter new card type/tag** (any text, e.g. `tank`, `aircraft`, `nuke`) or type **cancel** to abort:");
      return;
    }
    case "edit_name": await msg.reply("Enter the new **card name** (must be unique):"); return;
  }
}

async function backToMenu(msg: Message, session: EditSession): Promise<boolean> {
  // Fetch fresh card by ID instead
  const { getAllCards } = await import("../db.js");
  const fresh = (await getAllCards(session.guildId)).find(c => c.id === session.cardId);
  if (fresh) {
    session.step = "edit_menu";
    await showEditMenu(msg, fresh);
  } else {
    editSessions.delete(ekey(session.guildId, msg.author.id));
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// (original create wizard continues)
// ═══════════════════════════════════════════════════════════════════════════════

async function createCard(msg: Message, session: CardWizardSession) {
  const d = session.data;
  const r = d.rarity!;
  const mult = session.kind === "limited" ? 4 : session.kind === "event" ? 3 : 1;

  try {
    const card = await addCard({
      name: d.name!,
      description: d.description ?? "",
      rarity: r,
      cardType: d.cardType!,
      dropWeight: session.kind === "event" ? 0 : RARITY_WEIGHTS[r],
      worthValue: RARITY_WORTH[r] * mult,
      burnValue: RARITY_BURN[r] * mult,
      isLimitedEdition: session.kind === "limited",
      isEventExclusive: session.kind === "event",
      maxCopies: session.kind === "limited" ? d.maxCopies : undefined,
      imageUrl: d.imageUrl,
      droppable: session.kind === "standard",
    }, msg.guild?.id ?? session.guildId);

    const kindEmoji = session.kind === "standard" ? "🃏" : session.kind === "limited" ? "💎" : "🎆";
    const extra = session.kind === "standard"
      ? "It will appear in random card drops automatically."
      : `Use \`/drop name:${card.name}\` to award it to members.`;

    const guildId = msg.guild?.id;
    const displayMap = guildId ? await getRarityDisplayOverrides(guildId) : null;
    const rLabel = rarityLabel(r, null, displayMap);
    const rEmoji = rarityEmoji(r, null, displayMap);
    await msg.reply(
      `## ${kindEmoji} Card Created!\n` +
      `**${card.name}** — ${rEmoji} ${rLabel}\n` +
      `Worth: 💠 ${card.worthValue.toLocaleString()} · Burn: 🔥 ${card.burnValue.toLocaleString()}\n\n` +
      extra +
      (session.kind !== "standard" ? `\nRemove with \`!removecard ${card.name}\` if needed (your prefix may differ).` : ""),
    );
  } catch (err: any) {
    const isDuplicate = err?.message?.includes("unique") || err?.code === "23505";
    await msg.reply(isDuplicate
      ? `❌ A card named **${d.name}** already exists. Remove it first (see \`!removecard\` or use slash commands).`
      : "❌ Failed to create the card. Please try again.",
    );
  }
}
