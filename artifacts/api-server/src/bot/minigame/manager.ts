// ─────────────────────────────────────────────────────────────────────────────
// Wild Mini-Game session manager — owns the live encounter between "caught" and
// "granted". startMiniGame() takes over the spawn message, posts the animated
// intro + interactive buttons, routes the catcher's clicks to the game, and on
// resolution calls back into the spawn-manager's grant (win) or escape (lose).
//
// Sessions are in-memory (like raid/manager.ts). A per-encounter step timer
// escapes the card if the player never acts. Only the catcher can interact.
// ─────────────────────────────────────────────────────────────────────────────

import {
  EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
  type Message, type ButtonInteraction,
} from "discord.js";
import { nanoid } from "nanoid";
import type { Card } from "@workspace/db";
import { pickGame, GAMES } from "./registry.js";
import { withGuildFrames } from "../animations/card-frames.js";
import { getOrCreateGuildSettings } from "../db.js";
import type { Rarity } from "../cards-data.js";
import { logMiniGameStart, logMiniGameResolve } from "./db.js";
import { rearmAfterResolve } from "./scheduler.js";
import {
  renderWildEncounterIntro, renderWildEncounterStill,
  ENCOUNTER_GIF_FILE, ENCOUNTER_PNG_FILE,
} from "./encounter-canvas.js";
import { pickMenu, labelForAction, menuQuip } from "./encounter-menu.js";
import { logger } from "../../lib/logger.js";
import type { MiniGameSession, MiniGameRender } from "./types.js";

const sessions = new Map<string, MiniGameSession>();

// How long the joke encounter menu waits before it auto-advances into the game
// (so the flow never dead-ends if the catcher never clicks an option).
const ENCOUNTER_TIMEOUT_MS = 30_000;

export interface StartMiniGameOpts {
  guildId: string;
  channelId: string;
  userId: string;
  card: Card;
  rarityLabel: string;
  rarityColor: number;
  cardArtUrl: string | null;
  avatarUrl?: string | null;
  decoyArt?: { name: string; url: string | null }[];
  spawnMessage: Message;
  animate: boolean;
  selection: string;
  onWin: () => Promise<void>;
  onLose: () => Promise<void>;
}

function payloadFor(render: MiniGameRender, fallbackArt?: string | null): {
  embeds: EmbedBuilder[]; files: AttachmentBuilder[]; components: MiniGameRender["components"];
} {
  const embed = new EmbedBuilder()
    .setTitle(render.title)
    .setDescription(render.description)
    .setColor(render.color)
    .setTimestamp();
  const files: AttachmentBuilder[] = [];
  if (render.image) {
    files.push(new AttachmentBuilder(render.image, { name: render.imageName }));
    embed.setImage(`attachment://${render.imageName}`);
  } else if (fallbackArt) {
    // Canvas missed — still show the caught card's image on the embed.
    embed.setImage(fallbackArt);
  }
  return { embeds: [embed], files, components: render.components };
}

// Arm the step timer. Phase-aware on fire: during the encounter it auto-advances
// into the game (never a dead-end); during play it escapes the card on timeout.
function armTimeout(session: MiniGameSession, timeoutMs: number): void {
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => { void onTimeoutFired(session.id); }, timeoutMs);
}

// Build the joke battle-menu button row for the encounter phase. The full joke
// text is drawn in the on-canvas menu box; the buttons are numbered 1–4 to match
// that list (classic "pick option N").
function encounterMenuRows(sessionId: string, menu: { action: string; label: string }[]): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  // Two per row so the full option text fits and every button answers.
  for (let i = 0; i < menu.length; i += 2) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const m of menu.slice(i, i + 2)) {
      const n = menu.indexOf(m) + 1;
      const label = `${n}. ${m.label}`.replace(/[“”]/g, "\"").slice(0, 80);
      row.addComponents(new ButtonBuilder()
        .setCustomId(`mg:${sessionId}:${m.action}`)
        .setLabel(label.length > 0 ? label : `${n}`)
        .setStyle(ButtonStyle.Secondary));
    }
    rows.push(row);
  }
  return rows;
}

// Launch a mini-game on the caught card. Opens with the Pokémon-style wild
// encounter (slide-in GIF + joke menu); any menu click drops into the real game.
// Returns true if the encounter actually started (false → caller grants normally).
export async function startMiniGame(opts: StartMiniGameOpts): Promise<boolean> {
  const game = pickGame(opts.selection);
  const session: MiniGameSession = {
    id: nanoid(10),
    guildId: opts.guildId,
    channelId: opts.channelId,
    userId: opts.userId,
    card: opts.card,
    rarityLabel: opts.rarityLabel,
    rarityColor: opts.rarityColor,
    cardArtUrl: opts.cardArtUrl,
    gameKey: game.key,
    animate: opts.animate,
    phase: "encounter",
    avatarUrl: opts.avatarUrl ?? null,
    decoyArt: opts.decoyArt ?? [],
    logId: null,
    message: opts.spawnMessage,
    state: {},
    timer: null,
    resolved: false,
    onWin: opts.onWin,
    onLose: opts.onLose,
  };

  try {
    session.logId = await logMiniGameStart(opts.guildId, opts.channelId, opts.userId, opts.card.id, game.key);

    // ── Wild encounter opener ────────────────────────────────────────────────
    const menu = pickMenu();
    session.state.__menu = menu;
    const encInput = {
      cardArtUrl: opts.cardArtUrl, cardName: opts.card.name,
      rarityLabel: opts.rarityLabel, rarityColor: opts.rarityColor,
      rarity: opts.card.rarity as Rarity, avatarUrl: opts.avatarUrl ?? null,
      menuLabels: menu.map(m => m.label),
    };
    const encSettings = await getOrCreateGuildSettings(opts.guildId).catch(() => null);
    const encImage = await withGuildFrames(encSettings, () => opts.animate
      ? renderWildEncounterIntro(encInput)
      : renderWildEncounterStill(encInput));
    const encName = opts.animate && encImage ? ENCOUNTER_GIF_FILE : ENCOUNTER_PNG_FILE;

    const menuList = menu.map((m, i) => `**${i + 1}.** ${m.label}`).join("\n");
    const embed = new EmbedBuilder()
      .setTitle(`⚔️ A WILD ${opts.card.name.toUpperCase()} APPEARED!`)
      .setDescription(`**Prepare for battle!** What do you do?\n${menuList}`)
      .setColor(opts.rarityColor)
      .setTimestamp();
    const files: AttachmentBuilder[] = [];
    if (encImage) {
      files.push(new AttachmentBuilder(encImage, { name: encName }));
      embed.setImage(`attachment://${encName}`);
    } else if (opts.cardArtUrl) {
      embed.setImage(opts.cardArtUrl);
    }

    await opts.spawnMessage.edit({
      embeds: [embed], files, attachments: [],
      components: encounterMenuRows(session.id, menu),
    });
    sessions.set(session.id, session);
    armTimeout(session, ENCOUNTER_TIMEOUT_MS);
    logger.info({ guildId: opts.guildId, userId: opts.userId, game: game.key }, "Wild encounter started");
    return true;
  } catch (err) {
    logger.warn({ err, guildId: opts.guildId }, "startMiniGame failed — granting card normally");
    // If we couldn't even start, don't punish the catcher: grant the card.
    try { await opts.onWin(); } catch { /* already logged */ }
    return false;
  }
}

// Transition from the joke encounter into the actual game's intro + flow. Guarded
// so a menu click and the encounter timeout can't both fire it.
async function transitionToGame(session: MiniGameSession): Promise<void> {
  if (session.resolved || session.phase !== "encounter") return;
  session.phase = "playing";
  if (session.timer) { clearTimeout(session.timer); session.timer = null; }
  const game = pickGameForSession(session);
  if (!game) { await finalize(session, true); return; } // no game → don't strand the catcher
  try {
    const render = await game.start(session);
    const { embeds, files, components } = payloadFor(render, session.cardArtUrl);
    if (session.message) await session.message.edit({ embeds, files, components, attachments: [] }).catch(() => {});
    armTimeout(session, game.timeoutMs);
  } catch (err) {
    logger.warn({ err, sessionId: session.id }, "transitionToGame failed — granting card");
    await finalize(session, true);
  }
}

// Route a `mg:<sessionId>:<action>` button click.
export async function handleMiniGameInteraction(interaction: ButtonInteraction): Promise<void> {
  const [, sessionId, ...rest] = interaction.customId.split(":");
  const action = rest.join(":");
  const session = sessionId ? sessions.get(sessionId) : undefined;

  if (!session || session.resolved) {
    await interaction.reply({ content: "⌛ This encounter has already ended.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  if (interaction.user.id !== session.userId) {
    await interaction.reply({ content: "🚫 This isn't your encounter — you didn't catch this card.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  // Ack immediately. Canvas renders can outlast Discord's 3s button window,
  // which made every game button look like it did nothing.
  await interaction.deferUpdate().catch(() => {});

  // ── Encounter phase: the joke battle menu ─────────────────────────────────
  // Every option fails with a funny line, then we drop into the real game.
  if (session.phase === "encounter") {
    if (!action.startsWith("menu:")) return;
    if (session.timer) { clearTimeout(session.timer); session.timer = null; }
    const label = labelForAction(action);
    const embed = new EmbedBuilder()
      .setTitle("❌ That didn't work…")
      .setDescription(menuQuip(label, session.card.name))
      .setColor(session.rarityColor);
    if (session.cardArtUrl) embed.setThumbnail(session.cardArtUrl);
    await interaction.editReply({ embeds: [embed], components: [], attachments: [], files: [] }).catch(() => {});
    session.message = interaction.message as Message;
    setTimeout(() => { void transitionToGame(session); }, 1200);
    return;
  }

  const game = pickGameForSession(session);
  if (!game) {
    await interaction.followUp({ content: "⚠️ This game is no longer available.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  // Ignore any stale encounter-menu clicks that arrive after the game started.
  if (action.startsWith("menu:")) return;

  // Stop the timeout while we process this action.
  if (session.timer) { clearTimeout(session.timer); session.timer = null; }

  try {
    const outcome = await game.handle(session, action);
    const { embeds, files, components } = payloadFor(outcome.render, session.cardArtUrl);
    // Clear the previous frame's attachment before adding the new one so the
    // intro GIF and the result frame never stack on the message.
    await interaction.editReply({ embeds, files, components, attachments: [] });
    if (outcome.done) {
      await finalize(session, outcome.win);
    } else {
      // Still playing — re-arm the step timer.
      session.message = interaction.message as Message;
      armTimeout(session, game.timeoutMs);
    }
  } catch (err) {
    logger.warn({ err, sessionId }, "mini-game interaction failed");
    // On an unexpected error, don't strand the catcher — grant the card.
    await finalize(session, true).catch(() => {});
  }
}

// Phase-aware timeout: during the encounter, auto-advance into the game; during
// play, escape the card.
async function onTimeoutFired(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session || session.resolved) return;
  if (session.phase === "encounter") { await transitionToGame(session); return; }
  await resolveTimeout(sessionId);
}

async function resolveTimeout(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session || session.resolved) return;
  const game = pickGameForSession(session);
  try {
    const render = game ? await game.onTimeout(session) : null;
    if (render && session.message) {
      const { embeds, files, components } = payloadFor(render, session.cardArtUrl);
      await session.message.edit({ embeds, files, components, attachments: [] }).catch(() => {});
    }
  } catch (err) {
    logger.debug({ err, sessionId }, "mini-game timeout render failed");
  }
  await finalize(session, false, "timeout");
}

// Resolve a session: grant (win) or escape (lose), log, and re-arm the schedule.
async function finalize(session: MiniGameSession, win: boolean, logResult?: "timeout"): Promise<void> {
  if (session.resolved) return;
  session.resolved = true;
  if (session.timer) { clearTimeout(session.timer); session.timer = null; }
  sessions.delete(session.id);

  await logMiniGameResolve(session.logId, logResult ?? (win ? "win" : "lose"));
  try {
    if (win) await session.onWin();
    else await session.onLose();
  } catch (err) {
    logger.warn({ err, sessionId: session.id }, "mini-game onWin/onLose callback failed");
  }
  await rearmAfterResolve(session.guildId).catch(() => {});
}

// The registry maps key → definition; a session stores its key, so we can look
// the definition back up without holding a function reference on the session.
function pickGameForSession(session: MiniGameSession) {
  return GAMES[session.gameKey];
}
