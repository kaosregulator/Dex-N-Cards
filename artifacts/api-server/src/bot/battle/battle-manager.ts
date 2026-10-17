// Battle Manager — orchestrates the whole battle lifecycle inside ONE message.
//
// Owns the in-memory battle state machine (challenge → prep → combat → ended),
// all component interactions, turn timers, the AI loop, and the cinematic edits.
// It ties together every engine (stat, combat, ai, reward, achievement, daily,
// season, logging) but keeps them decoupled — this file is the only place that
// knows about Discord messages/interactions.
//
// The design is deliberately N-combatant-friendly: a battle is two "sides", each
// currently a single Combatant. New modes (2v2, boss raids, tower, tournaments)
// slot in by growing a side into an array without touching combat-engine.

import {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, MessageFlags, AttachmentBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  type ChatInputCommandInteraction, type ButtonInteraction,
  type StringSelectMenuInteraction, type ModalSubmitInteraction,
  type Message, type User,
} from "discord.js";
import { logger } from "../../lib/logger.js";
import { consumeCooldown } from "../../lib/cooldowns.js";
import { scheduleMessageDelete } from "../../lib/temp-message.js";
import { renderBattleImage, type RenderCard } from "./image/render.js";
import { renderAttackFrame, renderBattleVictory, renderBattleTurn, renderBattleIdle } from "../animations/index.js";
import { withGuildFrames } from "../animations/card-frames.js";
import type { BattleAnimationInput } from "../animations/index.js";
import { DEFAULT_SCENE_ARENA, isSceneArenaKey, SCENE_ARENAS, SCENE_ARENA_KEYS, sceneArenaLabel } from "./scene-arenas.js";
import { arenaAssetsAvailable } from "../animations/arena-bg.js";
import { computeMoveVisual } from "./turn-visual.js";
import { renderFatalityCinematic } from "../animations/cinematic/index.js";
import type { AnimationSpeed } from "../animations/types.js";
import { toAbsoluteImageUrl } from "../image-url.js";
import { getBotClient } from "../client-holder.js";
import { removeCardFromUser, restoreCardToUser, getOrCreateGuildSettings, getCardsInSet, getBattleBackgrounds } from "../db.js";
import type { BattleSettings } from "@workspace/db";
import type { Combatant, MoveType, AiDifficulty, Rarity, TurnResult } from "./types.js";
import { AI_DIFFICULTIES } from "./types.js";
import { getBattleSettings, rarityAllowed, typeAllowed } from "./config-engine.js";
import { progTierForFrameId } from "../cards/frames.js";
import { getScaledStats, powerRating } from "./stat-engine.js";
import { inferMoveset, getMoveset, loadGuildMovesets } from "./movesets.js";
import { getPassive, loadGuildPassives, applyBattleStartPassive } from "./passives.js";
import { inferSpecialEffect, getEffectDef } from "./special-cards.js";
import { getBattleItem, listBattleItems, applyItemEffect, loadGuildBattleItems } from "./items.js";
import { resolveMove, startOfTurn, availableMoves } from "./combat-engine.js";
import { chooseAiMove, pickAiCardIndex } from "./ai-engine.js";
import { ARENAS, ARENA_KEYS, getArena, arenaLabel, isArenaKey } from "./arenas.js";
import {
  getOwnedBattleCards, getAllBattleCards, acquireBattleLock, releaseBattleLock,
  getUserLock, sweepStaleLocks, getAllLocks, deleteAllLocks, type OwnedBattleCard,
} from "./db.js";
import { processBattleRewards, type ParticipantResult, type RewardOutcome } from "./reward-engine.js";
import { advanceDaily } from "./daily-engine.js";
import { ensureSeason } from "./season-engine.js";
import { logBattleResult } from "./logging-engine.js";
import { grantFreePack } from "./pack-grant.js";
import {
  buildBattleLogEmbed, buildBattleStatusEmbed, buildIntroFrame, buildCoinFlipEmbed, buildWinnerEmbed,
  currentTurnLine,
  type BattleView,
} from "./embeds.js";
import {
  statusThemeOf, hudFighter, renderStatusStill, renderStatusDrain,
  DRAIN_SETTLE_MS, HUD_FILE_PNG, HUD_FILE_GIF,
  type StatusTheme, type HudBoard, type HudFighter,
} from "./status-hud.js";
import { formatAchievementLine } from "./achievement-engine.js";
import { rarityLabel, rarityEmoji, rarityColor, type RarityDisplayMap } from "../cards-data.js";
import { getRarityContext, getRarityDisplayOverrides } from "../db.js";
import { getCardDisplayRarity, BUILTIN_POSITIONS, effectiveRarityKey, rarityLadderRank, type RarityContext } from "../rarity-runtime.js";

// Strength-ladder rank for an owned card's EFFECTIVE rarity: a per-card battle
// rarity override wins; else the card's custom-tier assignment; else its
// built-in rarity — all ranked on the guild ladder so custom/reordered tiers
// scale correctly.
function ladderRankFor(card: { id: number; rarity: string; config?: { rarity?: string | null } | null }, ctx: RarityContext): number {
  const key = card.config?.rarity ? String(card.config.rarity) : effectiveRarityKey(card, ctx);
  return rarityLadderRank(key, ctx);
}
import { MAX_LEVEL } from "../cards/leveling.js";
import {
  renderPrepBoard, renderCardConfirm, renderCoinFlip, type PrepCardStat,
} from "./prep-canvas.js";

const MAX_BATTLE_MS = 20 * 60 * 1000;   // hard TTL safety net
const DEFAULT_FRAME_MS = 950;            // fallback delay between animation frames
const MAX_COMBAT_TURNS = 30;             // sudden-death cap → decide by HP%

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const AI_ID = "AI";

// Per-guild animation pace (the "speed controller"), clamped to a sane range.
function frameMs(rt: BattleRuntime): number {
  const v = rt.settings.frameDelayMs ?? DEFAULT_FRAME_MS;
  return Math.max(120, Math.min(4000, v));
}

type Phase = "challenge" | "aidiff" | "prep" | "combat" | "ended";

interface PrepState {
  cardId: number | null;
  specialCardId: number | null;   // legacy; retained for stored-state compatibility
  itemId: string | null;          // Battle Item chosen for this fight (replaces special slot)
  stake: boolean;
  coin: "heads" | "tails" | null;
  ready: boolean;
  page: number; // legacy; the card picker is no longer paged (search covers the tail)
  // Cached prep-board PNG keyed by the selected card, so tapping coin/item/stake
  // doesn't re-render the canvas — only a change of fighter does.
  boardImage?: Buffer | null;
  boardKey?: number | null;   // selectedId the cached board was rendered for (0 = none)
}

interface BattleRuntime {
  id: string;
  guildId: string;
  channelId: string;
  message: Message | null;
  settings: BattleSettings;

  challengerId: string;
  challengerName: string;
  opponentId: string | null;   // null until accepted; AI_ID for AI
  opponentName: string;
  isAi: boolean;
  aiDifficulty: AiDifficulty;

  phase: Phase;
  prep: Map<string, PrepState>;   // human userId → prep
  eligibleCache: Map<string, OwnedBattleCard[]>;
  // Active Card Set membership (card IDs) — the single source of truth for which
  // cards may battle. `null` = no active set configured → no restriction (so
  // battles never lock out). Memoized per battle. `undefined` = not resolved yet.
  activeSetIds?: Set<number> | null;

  a: Combatant | null;   // side 0 = challenger
  b: Combatant | null;   // side 1 = opponent / AI
  turnNumber: number;
  currentSide: 0 | 1;
  staked: boolean;
  displayMap: RarityDisplayMap | null;   // source-of-truth rarity display overrides
  ctx: RarityContext;                    // source-of-truth rarity context (profiles + custom tiers)
  // When a staked PvP battle starts, one copy of each fighter's card is removed
  // from their collection and held here (escrow). This makes it impossible to
  // burn/trade a staked card mid-battle to dodge a loss; the copies are settled
  // (winner takes both / draw returns both) exactly once when the battle ends.
  escrow: { challengerCardId: number; opponentCardId: number } | null;
  escrowSettled: boolean;
  log: string[];
  coinCall: string;

  // per-side battle telemetry for rewards/achievements
  crits: [number, number];
  dmg: [number, number];
  wentLow: [boolean, boolean];

  // Optional GIF frame shown once on the next combat render, then cleared.
  turnAnimation: Buffer | null;

  turnTimer: ReturnType<typeof setTimeout> | null;
  aiOfferTimer: ReturnType<typeof setTimeout> | null;
  ttlTimer: ReturnType<typeof setTimeout> | null;
  processing: boolean;
  createdAt: number;

  // Layered VS battle image (rendered once at combat start; re-attached each
  // combat render). null when @napi-rs/canvas isn't installed — the battle then
  // shows the plain embed with no image, never an error.
  vsImage: Buffer | null;
  // The one arena background chosen for this fight (admin-uploaded, or null for
  // the themed gradient). Reused by every combat frame so the battlefield never
  // changes mid-fight — keeping the VS→combat→result sequence continuous.
  battleBgUrl: string | null;
  // The pickable VISUAL arena (animated pixel-art backdrop, see scene-arenas.ts)
  // for this fight's animated scene. Chosen by the challenger at setup; drives
  // renderBattleTurn/Idle `background`. null → procedural fallback.
  sceneArenaKey: string | null;
  // True once vsImage holds an animated GIF (victory / fatality cinematic) rather
  // than a static PNG — Discord only animates an embed image whose ATTACHMENT
  // FILENAME ends in .gif, so the end-screen attach must match.
  vsImageIsGif: boolean;
  // Last HP shown on the status picture, so a drain GIF starts from the previous
  // value. The settle timer swaps that GIF for a still during its hold.
  hudShown?: { a: number; b: number } | null;
  hudGen?: number;
  hudSettle?: ReturnType<typeof setTimeout> | null;
  hudSnapshot?: {
    gen: number;
    embeds: EmbedBuilder[];
    hudEmbed: EmbedBuilder;
    components: ActionRowBuilder<ButtonBuilder>[];
    combat: { buffer: Buffer; name: string } | null;
    still: Buffer;
  } | null;
  // Set when a player triggers a 💀 Fatality finisher; drives the cinematic
  // end-screen. `null` for every normal ending (which stays byte-for-byte as-is).
  fatality: { side: 0 | 1; userName: string } | null;
}

const battles = new Map<string, BattleRuntime>();

function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function getRuntime(id: string): BattleRuntime | undefined {
  return battles.get(id);
}

// ── Eligibility ──────────────────────────────────────────────────────────────
// Use the card's source-of-truth rarity (built-in or custom tier position) for
// the rarity window check. Custom tiers compare their position against the
// built-in min/max rarity positions so "allow all" still includes them.
export function isCardEligible(settings: BattleSettings, c: OwnedBattleCard, ctx?: RarityContext): boolean {
  if (c.config && c.config.enabled === false) return false;
  const key = c.effectiveRarityKey ?? c.rarity;
  if (ctx && key.startsWith("custom:")) {
    const tier = ctx.customByCard.get(c.id);
    if (tier) {
      const minPos = BUILTIN_POSITIONS[settings.minRarity as Rarity] ?? 1;
      const maxPos = BUILTIN_POSITIONS[settings.maxRarity as Rarity] ?? 6;
      return tier.position >= minPos && tier.position <= maxPos && typeAllowed(settings, c.cardType);
    }
  }
  return rarityAllowed(settings, c.rarity) && typeAllowed(settings, c.cardType);
}

// Resolve (and memoize) the Active Card Set membership for this battle. This is
// the SAME set source packs/spawns use (`getCardsInSet` over the guild's active
// set + secondary set). `null` means no active set is configured, in which case
// we impose no restriction so battles keep working.
async function resolveActiveSetIds(rt: BattleRuntime): Promise<Set<number> | null> {
  if (rt.activeSetIds !== undefined) return rt.activeSetIds;
  try {
    const settings = await getOrCreateGuildSettings(rt.guildId);
    const setIds = [settings.activeSetId, settings.activeSetIdSecondary]
      .filter((x): x is number => x != null);
    if (setIds.length === 0) { rt.activeSetIds = null; return null; }
    const lists = await Promise.all(setIds.map(sid => getCardsInSet(sid, rt.guildId)));
    const ids = new Set<number>();
    for (const list of lists) for (const c of list) ids.add(c.id);
    rt.activeSetIds = ids.size > 0 ? ids : null;
  } catch {
    rt.activeSetIds = null; // never block battles on a lookup failure
  }
  return rt.activeSetIds;
}

// A card may battle only if it passes battle eligibility AND (when an active set
// exists) belongs to it.
function inActiveSet(setIds: Set<number> | null, cardId: number): boolean {
  return !setIds || setIds.has(cardId);
}

async function eligibleForUser(rt: BattleRuntime, userId: string): Promise<OwnedBattleCard[]> {
  const cached = rt.eligibleCache.get(userId);
  if (cached) return cached;
  const [owned, setIds] = await Promise.all([
    getOwnedBattleCards(rt.guildId, userId, rt.ctx),
    resolveActiveSetIds(rt),
  ]);
  const list = owned
    .filter(c => isCardEligible(rt.settings, c, rt.ctx) && inActiveSet(setIds, c.id))
    .sort((x, y) =>
      powerRating(getScaledStats(cardish(y), y.config, rt.settings, y.level, undefined, y.starRank, ladderRankFor(y, rt.ctx)))
      - powerRating(getScaledStats(cardish(x), x.config, rt.settings, x.level, undefined, x.starRank, ladderRankFor(x, rt.ctx))));
  rt.eligibleCache.set(userId, list);
  return list;
}

function cardish(c: OwnedBattleCard) {
  return { id: c.id, name: c.name, rarity: c.rarity, worthValue: c.worthValue, cardType: c.cardType };
}

function buildCombatant(
  rt: BattleRuntime, userId: string, name: string, isAi: boolean, side: 0 | 1,
  card: OwnedBattleCard, special: OwnedBattleCard | null, aiDifficulty?: AiDifficulty,
  levelOverride?: number, itemId?: string | null,
): Combatant {
  // A per-card battle-rarity override (set in the admin card editor) drives both
  // stat derivation and the rarity shown in the battle embed, without touching
  // the real card. Stats resolve through the single get_scaled_stats entry point,
  // scaled by the card's level (the AI can override to match the player's card).
  const battleRarity = (card.config?.rarity as Rarity) || (card.rarity as Rarity);
  const level = levelOverride ?? card.level;
  // Star Rank (Card Recycle) adds a battle stat bonus on top of level scaling.
  // Strength scales by the card's rank on the GUILD rarity ladder, so custom /
  // reordered tiers are as strong as their ladder position (not the built-in).
  const stats = getScaledStats(cardish(card), card.config, rt.settings, level, battleRarity, card.starRank, ladderRankFor(card, rt.ctx));
  const moveset = card.config?.moveset ?? inferMoveset(card.cardType, battleRarity);
  // Card-owned move set: every card now carries its OWN Special ability (moved
  // off the old support-card slot, which is freed for Battle Items). Still gated
  // by the admin `specialCardsEnabled` toggle.
  let specialEffect: string | null = null;
  let specialCooldownMax = 3;
  if (rt.settings.specialCardsEnabled) {
    specialEffect = card.config?.specialEffect ?? inferSpecialEffect(card.cardType, battleRarity);
    specialCooldownMax = card.config?.specialCooldown ?? 3;
  }
  return {
    userId, displayName: name, isAi, aiDifficulty, side,
    cardId: card.id, cardName: card.name, cardRarity: battleRarity,
    cardType: card.cardType, cardImageUrl: toAbsoluteImageUrl(card.imageUrl),
    cardRarityDisplay: card.displayRarity,
    progTier: progTierForFrameId(card.equippedFrame),
    moveset,
    // Snapshot the guild-scoped moveset definition (custom or default) up-front.
    movesetDef: getMoveset(moveset, rt.guildId),
    // Resolve the card's assigned passive (auto-triggering ability), if any.
    passive: getPassive(card.config?.passive ?? null, rt.guildId),
    stats,
    hp: stats.maxHealth, shield: 0, energy: 40, ultimate: 0, status: [],
    // The special is now intrinsic to the card, so there's no separate support card.
    specialCardId: card.id,
    specialCardName: card.name,
    specialEffect,
    specialCooldownMax, specialCooldownRemaining: 0,
    defending: false, nextAttackBoostPct: 0, doubleNextAttack: false,
    frozenTurns: 0, lastStandUsed: false,
    // Battle Item for this fight (replaces the old special support-card slot).
    // Resolve the guild-scoped definition (custom or default) once, up-front.
    itemId: itemId ?? null,
    item: getBattleItem(itemId, rt.guildId),
    itemChargesRemaining: getBattleItem(itemId, rt.guildId)?.charges ?? 0,
    itemCooldownRemaining: 0,
  };
}

// ── Entry: /battle ───────────────────────────────────────────────────────────
export async function startChallenge(
  interaction: ChatInputCommandInteraction, opponent: User | null,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) { await interaction.reply({ content: "Battles can only be started in a server.", flags: MessageFlags.Ephemeral }); return; }
  const guildId = guild.id;
  const settings = await getBattleSettings(guildId);
  const [displayMap, ctx] = await Promise.all([getRarityDisplayOverrides(guildId), getRarityContext(guildId)]);

  if (!settings.enabled) {
    await interaction.reply({ content: "⚔️ The battle system is currently disabled on this server.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!settings.setupComplete) {
    await interaction.reply({ content: "🛠️ Battles aren't set up yet. An admin needs to run **/battle_admin** → **Setup Wizard** first.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (settings.battleChannelId && settings.battleChannelId !== interaction.channelId) {
    await interaction.reply({ content: `⚔️ Battles must be started in <#${settings.battleChannelId}>.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (opponent && (opponent.bot || opponent.id === interaction.user.id)) {
    await interaction.reply({ content: "Pick a real opponent (not yourself or a bot). Leave it empty to battle the AI.", flags: MessageFlags.Ephemeral });
    return;
  }

  // Multiple-battle prevention (in-memory + DB lock).
  const existingLock = await getUserLock(guildId, interaction.user.id);
  if (existingLock) {
    await interaction.reply({ content: "⚠️ You're already in a battle. Finish it first.", flags: MessageFlags.Ephemeral });
    return;
  }
  // Mutual exclusion: finish a live raid before starting a battle. (Dynamic
  // import keeps the battle↔raid module dependency one-directional.)
  const { isUserInRaid } = await import("../raid/manager.js");
  if (isUserInRaid(guildId, interaction.user.id)) {
    await interaction.reply({ content: "🐉 Finish your current **raid** before starting a battle.", flags: MessageFlags.Ephemeral });
    return;
  }
  // Cooldown: no back-to-back battles (keeps leveling earned, not spammed).
  const cd = await consumeCooldown("battle", guildId, interaction.user.id);
  if (!cd.ok) { await interaction.reply({ content: cd.message ?? "You're on cooldown.", flags: MessageFlags.Ephemeral }); return; }
  const challengerCards = await getOwnedBattleCards(guildId, interaction.user.id, ctx);
  if (challengerCards.filter(c => isCardEligible(settings, c, ctx)).length === 0) {
    await interaction.reply({ content: "You don't own any battle-eligible cards yet. Catch or open packs first!", flags: MessageFlags.Ephemeral });
    return;
  }

  const id = newId();
  const rt: BattleRuntime = {
    id, guildId, channelId: interaction.channelId!, message: null, settings,
    challengerId: interaction.user.id, challengerName: interaction.user.username,
    opponentId: opponent ? opponent.id : null,
    opponentName: opponent ? opponent.username : "AI",
    isAi: !opponent, aiDifficulty: "beginner",
    phase: opponent ? "challenge" : "aidiff",
    prep: new Map(), eligibleCache: new Map(),
    a: null, b: null, turnNumber: 1, currentSide: 0, staked: false,
    escrow: null, escrowSettled: false, log: [], coinCall: "heads",
    crits: [0, 0], dmg: [0, 0], wentLow: [false, false],
    turnAnimation: null,
    turnTimer: null, aiOfferTimer: null, ttlTimer: null, processing: false, createdAt: Date.now(),
    displayMap,
    ctx,
    vsImage: null, battleBgUrl: null, sceneArenaKey: null, vsImageIsGif: false, fatality: null,
    hudShown: null, hudGen: 0, hudSettle: null, hudSnapshot: null,
  };
  battles.set(id, rt);

  // Reserve the challenger immediately (DB lock).
  const locked = await acquireBattleLock(guildId, interaction.user.id, id, null, false);
  if (!locked) {
    battles.delete(id);
    await interaction.reply({ content: "⚠️ You're already in a battle. Finish it first.", flags: MessageFlags.Ephemeral });
    return;
  }

  rt.ttlTimer = setTimeout(() => { void endBattleByTimeout(rt); }, MAX_BATTLE_MS);

  if (opponent) {
    await interaction.reply({
      embeds: [buildChallengeEmbed(rt, opponent)],
      components: buildChallengeComponents(rt),
    });
    rt.message = await interaction.fetchReply();
    // Offer AI after the configured wait if the opponent hasn't accepted.
    rt.aiOfferTimer = setTimeout(() => { void offerAi(rt); }, Math.max(5, rt.settings.aiOfferSeconds) * 1000);
  } else {
    await interaction.reply({
      embeds: [buildAiDifficultyEmbed(rt)],
      components: buildAiDifficultyComponents(rt),
    });
    rt.message = await interaction.fetchReply();
  }
}

// ── Component dispatch (called from index.ts for any `battle:` customId) ──────
export async function handleBattleComponent(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): Promise<void> {
  const parts = interaction.customId.split(":"); // battle:<action>:<id>[:...]
  const action = parts[1];
  const id = parts[2];
  const rt = id ? getRuntime(id) : undefined;

  if (!rt) {
    await safeEphemeral(interaction, "This battle has ended or expired.");
    return;
  }

  try {
    if (interaction.isButton()) {
      switch (action) {
        case "accept": return void await onAccept(rt, interaction);
        case "decline": return void await onDecline(rt, interaction);
        case "cancel": return void await onCancel(rt, interaction);
        case "ai": return void await onConvertToAi(rt, interaction);
        case "aidiff": return void await onPickAiDifficulty(rt, interaction, parts[3] as AiDifficulty);
        case "prep": return void await onOpenPrep(rt, interaction);
        case "pstake": return void await onToggleStake(rt, interaction);
        case "pcoin": return void await onPickCoin(rt, interaction, parts[3] as "heads" | "tails");
        case "pquick": return void await onQuickPick(rt, interaction);
        case "psearch": return void await onSearchOpen(rt, interaction);
        case "pback": return void await refreshPrep(rt, interaction);
        case "pready": return void await onReady(rt, interaction);
        case "pconfirm": return void await onConfirmReady(rt, interaction);
        case "move": return void await onMoveButton(rt, interaction, parts[3] as MoveType);
        case "fatality": return void await onFatalityButton(rt, interaction);
        case "moves": return void await onMovesButton(rt, interaction);
        default: return void await safeEphemeral(interaction, "Unknown action.");
      }
    } else {
      switch (action) {
        case "pcard": return void await onSelectCard(rt, interaction);
        case "pitem": return void await onSelectItem(rt, interaction);
        case "arena": return void await onPickArena(rt, interaction);
        default: return void await safeEphemeral(interaction, "Unknown selection.");
      }
    }
  } catch (err) {
    logger.error({ err, battleId: rt.id, action }, "battle component error");
    await safeEphemeral(interaction, "Something went wrong with that action.").catch(() => {});
  }
}

// ── Challenge phase ──────────────────────────────────────────────────────────
async function onAccept(rt: BattleRuntime, interaction: ButtonInteraction) {
  if (interaction.user.id !== rt.opponentId) {
    return safeEphemeral(interaction, "Only the challenged player can accept.");
  }
  if (rt.phase !== "challenge") return safeEphemeral(interaction, "This challenge is no longer open.");
  const eligible = (await getOwnedBattleCards(rt.guildId, interaction.user.id, rt.ctx)).filter(c => isCardEligible(rt.settings, c, rt.ctx));
  if (eligible.length === 0) return safeEphemeral(interaction, "You have no battle-eligible cards to fight with.");
  const locked = await acquireBattleLock(rt.guildId, interaction.user.id, rt.id, null, false);
  if (!locked) return safeEphemeral(interaction, "You're already in another battle.");

  clearTimer(rt, "aiOfferTimer");
  rt.opponentName = interaction.user.username;
  await enterPrep(rt, interaction);
}

async function onDecline(rt: BattleRuntime, interaction: ButtonInteraction) {
  if (interaction.user.id !== rt.opponentId && interaction.user.id !== rt.challengerId) {
    return safeEphemeral(interaction, "Only the players involved can decline.");
  }
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(0x99aab5).setTitle("❌ Challenge declined").setDescription(`<@${rt.opponentId}> declined the battle.`)],
    components: [],
  }).catch(() => {});
  await teardown(rt);
}

async function onCancel(rt: BattleRuntime, interaction: ButtonInteraction) {
  if (interaction.user.id !== rt.challengerId) return safeEphemeral(interaction, "Only the challenger can cancel.");
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(0x99aab5).setTitle("🚫 Battle cancelled").setDescription("The challenger called it off.")],
    components: [],
  }).catch(() => {});
  await teardown(rt);
}

async function offerAi(rt: BattleRuntime) {
  if (rt.phase !== "challenge" || !rt.message) return;
  await rt.message.edit({
    embeds: [buildChallengeEmbed(rt, null, true)],
    components: buildChallengeComponents(rt, true),
  }).catch(() => {});
}

async function onConvertToAi(rt: BattleRuntime, interaction: ButtonInteraction) {
  if (interaction.user.id !== rt.challengerId) return safeEphemeral(interaction, "Only the challenger can switch to an AI battle.");
  if (!rt.settings.aiEnabled) return safeEphemeral(interaction, "AI battles are disabled on this server.");
  clearTimer(rt, "aiOfferTimer");
  rt.isAi = true; rt.opponentId = AI_ID; rt.opponentName = "AI"; rt.phase = "aidiff";
  await interaction.update({
    embeds: [buildAiDifficultyEmbed(rt)],
    components: buildAiDifficultyComponents(rt),
  }).catch(() => {});
}

async function onPickAiDifficulty(rt: BattleRuntime, interaction: ButtonInteraction, diff: AiDifficulty) {
  if (interaction.user.id !== rt.challengerId) return safeEphemeral(interaction, "Only the challenger picks the arena.");
  if (!isArenaKey(diff)) return safeEphemeral(interaction, "Unknown arena.");
  rt.isAi = true; rt.opponentId = AI_ID; rt.aiDifficulty = diff;
  await enterPrep(rt, interaction);
}

// ── Prep phase ───────────────────────────────────────────────────────────────
async function enterPrep(rt: BattleRuntime, interaction: ButtonInteraction) {
  rt.phase = "prep";
  rt.prep.set(rt.challengerId, { cardId: null, specialCardId: null, itemId: null, stake: false, coin: null, ready: false, page: 0 });
  if (!rt.isAi && rt.opponentId) {
    rt.prep.set(rt.opponentId, { cardId: null, specialCardId: null, itemId: null, stake: false, coin: null, ready: false, page: 0 });
  }
  await interaction.update({
    embeds: [buildPrepEmbed(rt)],
    components: buildPrepSharedComponents(rt),
  }).catch(() => {});
}

async function onOpenPrep(rt: BattleRuntime, interaction: ButtonInteraction) {
  if (!rt.prep.has(interaction.user.id)) return safeEphemeral(interaction, "You're not part of this battle.");
  // Load the guild's custom Battle Items so the prep selector shows them.
  await loadGuildBattleItems(rt.guildId).catch(() => {});
  await loadGuildMovesets(rt.guildId).catch(() => {});
  await loadGuildPassives(rt.guildId).catch(() => {});
  const eligible = await eligibleForUser(rt, interaction.user.id);
  if (eligible.length === 0) return safeEphemeral(interaction, "You have no battle-eligible cards.");
  await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  const view = await renderPersonalPrepView(rt, interaction.user.id);
  await interaction.editReply(view).catch(() => {});
}

// Re-render the ephemeral prep screen after any change. The board PNG is cached
// per selected card, so coin/item/stake taps don't pay the canvas cost.
async function refreshPrep(rt: BattleRuntime, interaction: StringSelectMenuInteraction | ButtonInteraction) {
  const view = await renderPersonalPrepView(rt, interaction.user.id);
  await interaction.update(view).catch(() => {});
}

async function onSelectCard(rt: BattleRuntime, interaction: StringSelectMenuInteraction) {
  const prep = rt.prep.get(interaction.user.id);
  if (!prep) return safeEphemeral(interaction, "You're not part of this battle.");
  prep.cardId = Number(interaction.values[0]);
  await refreshPrep(rt, interaction);
}

async function onSelectItem(rt: BattleRuntime, interaction: StringSelectMenuInteraction) {
  const prep = rt.prep.get(interaction.user.id);
  if (!prep) return safeEphemeral(interaction, "You're not part of this battle.");
  const v = interaction.values[0];
  prep.itemId = v === "none" ? null : v;
  await refreshPrep(rt, interaction);
}

async function onToggleStake(rt: BattleRuntime, interaction: ButtonInteraction) {
  const prep = rt.prep.get(interaction.user.id);
  if (!prep) return safeEphemeral(interaction, "You're not part of this battle.");
  if (rt.isAi || !rt.settings.stakingEnabled) return safeEphemeral(interaction, "Staking isn't available for this battle.");
  prep.stake = !prep.stake;
  await refreshPrep(rt, interaction);
}

async function onPickCoin(rt: BattleRuntime, interaction: ButtonInteraction, coin: "heads" | "tails") {
  const prep = rt.prep.get(interaction.user.id);
  if (!prep) return safeEphemeral(interaction, "You're not part of this battle.");
  prep.coin = coin;
  await refreshPrep(rt, interaction);
}

// Quick Pick: auto-select your strongest (highest-level) eligible card, then
// leave you on the prep screen to set an item / coin / stake and Ready up.
async function onQuickPick(rt: BattleRuntime, interaction: ButtonInteraction) {
  const prep = rt.prep.get(interaction.user.id);
  if (!prep) return safeEphemeral(interaction, "You're not part of this battle.");
  const eligible = sortForPrep(await eligibleForUser(rt, interaction.user.id));
  if (eligible.length === 0) return safeEphemeral(interaction, "You have no battle-eligible cards.");
  prep.cardId = eligible[0]!.id;
  await refreshPrep(rt, interaction);
}

// Search by name — opens a modal so a large collection needs no paging.
async function onSearchOpen(rt: BattleRuntime, interaction: ButtonInteraction) {
  if (!rt.prep.has(interaction.user.id)) return safeEphemeral(interaction, "You're not part of this battle.");
  const modal = new ModalBuilder().setCustomId(`battle:psearch:${rt.id}`).setTitle("Search your cards");
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder().setCustomId("q").setLabel("Card name").setStyle(TextInputStyle.Short)
      .setRequired(true).setMaxLength(100).setPlaceholder("Type part of a card's name…"),
  ));
  await interaction.showModal(modal).catch(() => {});
}

export async function handleBattlePrepSearchModal(interaction: ModalSubmitInteraction): Promise<void> {
  const parts = interaction.customId.split(":"); // battle:psearch:<id>
  const rt = getRuntime(parts[2]);
  await interaction.deferUpdate().catch(() => {});
  if (!rt) return void await interaction.followUp({ content: "This battle has ended or expired.", flags: MessageFlags.Ephemeral }).catch(() => {});
  const prep = rt.prep.get(interaction.user.id);
  if (!prep) return void await interaction.followUp({ content: "You're not part of this battle.", flags: MessageFlags.Ephemeral }).catch(() => {});
  const q = interaction.fields.getTextInputValue("q").trim().toLowerCase();
  const eligible = await eligibleForUser(rt, interaction.user.id);
  const hit = eligible.find(c => c.name.toLowerCase() === q)
    ?? eligible.find(c => c.name.toLowerCase().includes(q));
  if (!hit) {
    return void await interaction.followUp({
      content: `No battle-eligible card matching “${q}”. It may be outside this battle's rarity/type rules.`,
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }
  prep.cardId = hit.id;
  const view = await renderPersonalPrepView(rt, interaction.user.id);
  await interaction.editReply(view).catch(() => {});
}

// Ready → show the private confirm preview (chosen card + full current stats +
// move/special/item) with a Confirm button before locking in.
async function onReady(rt: BattleRuntime, interaction: ButtonInteraction) {
  const prep = rt.prep.get(interaction.user.id);
  if (!prep) return safeEphemeral(interaction, "You're not part of this battle.");
  if (!prep.cardId) return safeEphemeral(interaction, "Pick a battle card first.");
  if (!prep.coin) prep.coin = Math.random() < 0.5 ? "heads" : "tails";

  const eligible = await eligibleForUser(rt, interaction.user.id);
  const card = eligible.find(c => c.id === prep.cardId);
  if (!card) return safeEphemeral(interaction, "That card is no longer available — pick another.");

  const stat = prepStatFor(rt, card);
  const effRarity = (card.config?.rarity as Rarity) || (card.rarity as Rarity);
  const move = getMoveset(card.config?.moveset ?? inferMoveset(card.cardType, effRarity));
  const special = getEffectDef(card.config?.specialEffect ?? inferSpecialEffect(card.cardType, effRarity));
  const item = getBattleItem(prep.itemId, rt.guildId);
  const confirmFrames = await getOrCreateGuildSettings(rt.guildId).catch(() => null);
  const img = await withGuildFrames(confirmFrames, () => renderCardConfirm(
    stat,
    move ? { name: move.name, emoji: move.emoji, description: move.description } : null,
    special ? { name: special.label, emoji: special.emoji, description: special.description } : null,
    item ? item.name : null,
    prep.coin,
  )).catch(() => null);

  const embed = new EmbedBuilder().setColor(stat.rarityColor ?? 0xed4245)
    .setTitle("Confirm your fighter")
    .setDescription(`**${card.name}** · ${"★".repeat(stat.star)}${"☆".repeat(5 - stat.star)} · Lv ${stat.level}\nReview your pick, then **Confirm** to lock in.`);
  const files: AttachmentBuilder[] = [];
  if (img) { embed.setImage("attachment://prep-confirm.png"); files.push(new AttachmentBuilder(img, { name: "prep-confirm.png" })); }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`battle:pconfirm:${rt.id}`).setLabel("Confirm & Ready").setEmoji("⚔️").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`battle:pback:${rt.id}`).setLabel("Change pick").setStyle(ButtonStyle.Secondary),
  );
  await interaction.update({ content: null, embeds: [embed], files, components: [row] }).catch(() => {});
}

async function onConfirmReady(rt: BattleRuntime, interaction: ButtonInteraction) {
  const prep = rt.prep.get(interaction.user.id);
  if (!prep) return safeEphemeral(interaction, "You're not part of this battle.");
  if (!prep.cardId) return safeEphemeral(interaction, "Pick a battle card first.");
  if (!prep.coin) prep.coin = Math.random() < 0.5 ? "heads" : "tails";
  prep.ready = true;

  await interaction.update({
    content: "✅ You're ready! Waiting for the battle to begin…",
    embeds: [buildPersonalPrepEmbed(rt, interaction.user.id)],
    files: [],
    components: [],
  }).catch(() => {});

  // Refresh the shared readiness board.
  if (rt.message) {
    await rt.message.edit({ embeds: [buildPrepEmbed(rt)], components: buildPrepSharedComponents(rt) }).catch(() => {});
  }

  const humans = [...rt.prep.values()];
  if (humans.every(p => p.ready)) {
    await beginCombat(rt);
  }
}

// ── Prep view (canvas board + controls) ──────────────────────────────────────
// Highest-level first — the board leads with your 5 strongest, the dropdown
// carries the top 25, and search covers the long tail.
function sortForPrep(cards: OwnedBattleCard[]): OwnedBattleCard[] {
  return [...cards].sort((a, b) => b.level - a.level || b.starRank - a.starRank || b.owned - a.owned || a.name.localeCompare(b.name));
}

function prepStatFor(rt: BattleRuntime, card: OwnedBattleCard): PrepCardStat {
  const effRarity = (card.config?.rarity as Rarity) || (card.rarity as Rarity);
  const s = getScaledStats(card, card.config, rt.settings, card.level, effRarity, card.starRank, ladderRankFor(card, rt.ctx));
  return {
    cardId: card.id,
    name: card.name,
    rarity: card.rarity,
    rarityLabel: card.displayRarity?.label ?? rarityLabel(card.rarity, null, rt.displayMap) ?? card.rarity,
    rarityColor: rarityColor(card.rarity, null, rt.displayMap) ?? null,
    imageUrl: card.imageUrl,
    level: card.level,
    star: card.starRank,
    maxLevel: MAX_LEVEL,
    hp: s.maxHealth, atk: s.attack, def: s.defense, spd: s.speed,
  };
}

async function renderPersonalPrepView(
  rt: BattleRuntime, userId: string,
): Promise<{ content: string | null; embeds: EmbedBuilder[]; files: AttachmentBuilder[]; components: ActionRowBuilder<any>[] }> {
  const prep = rt.prep.get(userId);
  const eligible = sortForPrep(await eligibleForUser(rt, userId));
  const selectedId = prep?.cardId ?? null;

  // Render (or reuse) the top-5 board PNG. Cache keyed by selected card so only a
  // change of fighter re-renders the canvas.
  const key = selectedId ?? 0;
  if (!prep?.boardImage || prep.boardKey !== key) {
    const top5 = eligible.slice(0, 5).map(c => prepStatFor(rt, c));
    const prepFrames = await getOrCreateGuildSettings(rt.guildId).catch(() => null);
    const img = await withGuildFrames(prepFrames, () => renderPrepBoard(rt.prep.has(userId) ? (userIdName(rt, userId)) : "Fighter", top5, selectedId)).catch(() => null);
    if (prep) { prep.boardImage = img; prep.boardKey = key; }
  }

  const embed = buildPersonalPrepEmbed(rt, userId);
  const files: AttachmentBuilder[] = [];
  if (prep?.boardImage) { embed.setImage("attachment://prep-board.png"); files.push(new AttachmentBuilder(prep.boardImage, { name: "prep-board.png" })); }

  return {
    content: null,
    embeds: [embed],
    files,
    components: buildPersonalPrepComponents(rt, userId, eligible),
  };
}

function userIdName(rt: BattleRuntime, userId: string): string {
  if (userId === rt.challengerId) return rt.challengerName;
  if (userId === rt.opponentId) return rt.opponentName;
  return "Fighter";
}

// ── Combat start ─────────────────────────────────────────────────────────────
async function beginCombat(rt: BattleRuntime) {
  rt.phase = "combat";
  clearTimer(rt, "aiOfferTimer");
  // Ensure the guild's custom Battle Items are resolved before building combatants.
  await loadGuildBattleItems(rt.guildId).catch(() => {});
  await loadGuildMovesets(rt.guildId).catch(() => {});
  await loadGuildPassives(rt.guildId).catch(() => {});

  // Build challenger.
  const chalPrep = rt.prep.get(rt.challengerId)!;
  const chalEligible = await eligibleForUser(rt, rt.challengerId);
  const chalCard = chalEligible.find(c => c.id === chalPrep.cardId) ?? chalEligible[0]!;
  const chalSpecial = chalPrep.specialCardId ? chalEligible.find(c => c.id === chalPrep.specialCardId) ?? null : null;
  rt.a = buildCombatant(rt, rt.challengerId, rt.challengerName, false, 0, chalCard, chalSpecial, undefined, undefined, chalPrep.itemId);

  // Build opponent (human or AI).
  if (rt.isAi) {
    // AI draws from the SAME Active Card Set as packs/players — never the whole
    // database. Falls back to the challenger's eligible cards if the set is empty.
    const setIds = await resolveActiveSetIds(rt);
    const pool = (await getAllBattleCards(rt.guildId, rt.ctx))
      .filter(c => isCardEligible(rt.settings, c, rt.ctx) && inActiveSet(setIds, c.id));
    const usePool = pool.length ? pool : chalEligible;
    const scores = usePool.map(c => powerRating(getScaledStats(cardish(c), c.config, rt.settings, c.level)));
    const idx = pickAiCardIndex(scores, rt.aiDifficulty);
    const aiCard = usePool[idx] ?? usePool[0]!;
    const aiSpecial = usePool[Math.floor(Math.random() * usePool.length)] ?? null;
    // The AI card is scaled to the ARENA's level — an under-levelled player
    // card facing the Ascended Arena's Lv 100 AI is a fast wipe (the grind hook).
    const arena = getArena(rt.aiDifficulty);
    // The AI equips a random usable Battle Item (its move engine decides when to
    // use it). Item usage scales the challenge alongside arena level.
    const aiItems = listBattleItems(rt.guildId);
    const aiItemId = aiItems.length ? aiItems[Math.floor(Math.random() * aiItems.length)]!.id : null;
    rt.b = buildCombatant(rt, AI_ID, `AI · ${arena.name}`, true, 1, aiCard, aiSpecial, rt.aiDifficulty, arena.aiLevel, aiItemId);
    rt.staked = false;
  } else {
    const oppPrep = rt.prep.get(rt.opponentId!)!;
    const oppEligible = await eligibleForUser(rt, rt.opponentId!);
    const oppCard = oppEligible.find(c => c.id === oppPrep.cardId) ?? oppEligible[0]!;
    const oppSpecial = oppPrep.specialCardId ? oppEligible.find(c => c.id === oppPrep.specialCardId) ?? null : null;
    rt.b = buildCombatant(rt, rt.opponentId!, rt.opponentName, false, 1, oppCard, oppSpecial, undefined, undefined, oppPrep.itemId);
    rt.staked = rt.settings.stakingEnabled && chalPrep.stake && oppPrep.stake;
  }

  // Apply battle-start passives (shield/buff/regen/reflect/stealth/energy) once,
  // logging any that fire so players see them before the first turn.
  for (const c of [rt.a, rt.b]) {
    if (!c) continue;
    const ev = applyBattleStartPassive(c);
    if (ev) rt.log.push(ev.text);
  }

  // Escrow staked cards up-front (before locks reflect the stake) so neither
  // player can burn or trade the card away mid-battle. If either escrow fails
  // (card no longer owned), refund the other and fall back to a normal battle.
  if (rt.staked && rt.a && rt.b) {
    const okA = await removeCardFromUser(rt.guildId, rt.a.userId, rt.a.cardId).catch(() => ({ success: false, remaining: 0 }));
    const okB = okA.success
      ? await removeCardFromUser(rt.guildId, rt.b.userId, rt.b.cardId).catch(() => ({ success: false, remaining: 0 }))
      : { success: false, remaining: 0 };
    if (okA.success && okB.success) {
      rt.escrow = { challengerCardId: rt.a.cardId, opponentCardId: rt.b.cardId };
    } else {
      if (okA.success) await restoreCardToUser(rt.guildId, rt.a.userId, rt.a.cardId).catch(() => {});
      rt.staked = false;
      rt.log.push("⚠️ Stake cancelled — a staked card was no longer owned. Fighting a normal battle.");
    }
  }

  // Record staked cards on the locks (card-lock during battle).
  await releaseAndRelock(rt);

  // Render the layered VS battle image once (background + both cards + VS).
  // Fire-and-forget safe: null on any failure → battle just shows no image.
  // Admin-uploaded arena backgrounds auto-shuffle: pick one at random per fight.
  if (rt.a && rt.b) {
    const backgrounds = await getBattleBackgrounds(rt.guildId).catch(() => [] as string[]);
    // Pick ONE arena for the whole fight and remember it, so the VS reveal and
    // every combat frame share the exact same battlefield (no shuffle mid-fight).
    rt.battleBgUrl = backgrounds.length
      ? toAbsoluteImageUrl(backgrounds[Math.floor(Math.random() * backgrounds.length)]!)
      : null;
    // Default the visual arena if the challenger didn't pick one at setup.
    if (!isSceneArenaKey(rt.sceneArenaKey)) rt.sceneArenaKey = DEFAULT_SCENE_ARENA;
    // Animated "arena scene" mode only: a looping battlefield (both cards + the
    // chosen arena) that stays alive between turns because Discord loops the GIF.
    // Classic / Off modes use the cheap static VS image below.
    if (sceneAnimated(rt)) {
      const idle = await withGuildFrames(await getOrCreateGuildSettings(rt.guildId).catch(() => null), () => renderBattleIdle(
        buildAnimInput(rt, 0), rt.settings.battleAnimationSpeed as AnimationSpeed,
      )).catch(() => null);
      if (idle) { rt.vsImage = Buffer.from(idle.buffer); rt.vsImageIsGif = true; }
    }
    // Classic / Off modes (or a failed GIF render): the static VS image.
    if (!rt.vsImage) {
      rt.vsImage = await renderBattleImage(
        combatantToRenderCard(rt, rt.a),
        combatantToRenderCard(rt, rt.b),
        { backgroundUrl: rt.battleBgUrl },
      ).catch(() => null);
      rt.vsImageIsGif = false;
    }
  }

  // Coin flip → first mover.
  const flip = Math.random() < 0.5 ? "heads" : "tails";
  rt.coinCall = flip;
  const aCall = rt.prep.get(rt.challengerId)?.coin ?? "heads";
  const bCall = rt.isAi ? (Math.random() < 0.5 ? "heads" : "tails") : (rt.prep.get(rt.opponentId!)?.coin ?? "tails");
  const aMatch = aCall === flip, bMatch = bCall === flip;
  let firstSide: 0 | 1;
  if (aMatch && !bMatch) firstSide = 0;
  else if (bMatch && !aMatch) firstSide = 1;
  else firstSide = Math.random() < 0.5 ? 0 : 1;
  rt.currentSide = firstSide;

  await ensureSeason(rt.guildId).catch(() => {});
  await playIntro(rt, firstSide, flip);
}

// Re-acquire locks so both users' rows carry their staked card id. (The DB lock
// is one row per user; we upsert-by-delete+insert to update the card id.)
async function releaseAndRelock(rt: BattleRuntime) {
  if (!rt.a) return;
  await releaseBattleLock(rt.guildId, rt.challengerId, rt.id).catch(() => {});
  await acquireBattleLock(rt.guildId, rt.challengerId, rt.id, rt.a.cardId, rt.staked).catch(() => {});
  if (!rt.isAi && rt.b) {
    await releaseBattleLock(rt.guildId, rt.b.userId, rt.id).catch(() => {});
    await acquireBattleLock(rt.guildId, rt.b.userId, rt.id, rt.b.cardId, rt.staked).catch(() => {});
  }
}

async function playIntro(rt: BattleRuntime, firstSide: 0 | 1, flip: string) {
  if (!rt.message) return;
  const view = () => toView(rt);

  // ── VS reveal ──────────────────────────────────────────────────────────────
  // Show the battlefield VS image FIRST, like a real fight intro, before the
  // battle screen appears. If the image lib isn't installed, fall back to the
  // original text intro frames so the reveal still plays.
  const reveal = vsTop(rt, `⚔️ ${rt.a?.cardName ?? "Challenger"} VS ${rt.b?.cardName ?? "Opponent"}`);
  if (reveal.embed) {
    await rt.message.edit({ content: null, embeds: [reveal.embed], files: [reveal.file!], components: [] }).catch(() => {});
    await sleep(Math.max(1400, frameMs(rt) * 2));
  } else {
    for (let f = 0; f < 4; f++) {
      await rt.message.edit({ embeds: [buildIntroFrame(view(), f)], components: [] }).catch(() => {});
      await sleep(frameMs(rt));
    }
  }

  // ── Animated coin toss ───────────────────────────────────────────────────
  // A short GIF of the coin spinning and landing on the real result, then a
  // brief matchup preview naming who strikes first — before combat begins.
  const coinAnim = await renderCoinFlip(flip as "heads" | "tails").catch(() => null);
  if (coinAnim) {
    const coinEmbed = new EmbedBuilder()
      .setColor(0xf1c40f)
      .setTitle("🪙 Coin toss…")
      .setImage("attachment://coin.gif");
    await rt.message.edit({
      content: null,
      embeds: [coinEmbed],
      files: [new AttachmentBuilder(Buffer.from(coinAnim.buffer), { name: "coin.gif" })],
      components: [],
    }).catch(() => {});
    await sleep(Math.max(1500, coinAnim.durationMs));
  }

  // Result / matchup preview — keep the VS image pinned on top while it resolves.
  const coinTop = vsTop(rt);
  await rt.message.edit({
    embeds: coinTop.embed ? [coinTop.embed, buildCoinFlipEmbed(view(), firstSide, flip)] : [buildCoinFlipEmbed(view(), firstSide, flip)],
    files: coinTop.file ? [coinTop.file] : [],
    components: [],
  }).catch(() => {});
  await sleep(Math.max(frameMs(rt), 1400));

  rt.log.push(`🔔 Battle begins! ${firstSide === 0 ? "Challenger" : "Opponent"} moves first.`);
  await renderCombat(rt);
  await startTurn(rt);
}

// ── Turn handling ────────────────────────────────────────────────────────────
async function startTurn(rt: BattleRuntime) {
  if (rt.phase !== "combat") return;
  const actor = rt.currentSide === 0 ? rt.a! : rt.b!;
  if (actor.isAi) {
    await sleep(frameMs(rt));
    const move = chooseAiMove(actor, other(rt, rt.currentSide), rt.settings, rt.aiDifficulty);
    await applyMove(rt, rt.currentSide, move);
    return;
  }
  // Human: arm the turn timer (auto-skip on timeout).
  clearTimer(rt, "turnTimer");
  const ms = Math.max(10, rt.settings.turnTimerSeconds) * 1000;
  rt.turnTimer = setTimeout(() => {
    rt.log.push(`⏱️ ${actor.cardName} hesitated — turn skipped.`);
    void applyMove(rt, rt.currentSide, "skip");
  }, ms);
  await renderCombat(rt, { turnEndsAt: Date.now() + ms });
}

async function onMoveButton(rt: BattleRuntime, interaction: ButtonInteraction, move: MoveType) {
  if (rt.phase !== "combat") return safeEphemeral(interaction, "The battle isn't in combat.");
  const actor = rt.currentSide === 0 ? rt.a! : rt.b!;
  if (interaction.user.id !== actor.userId) return safeEphemeral(interaction, "It's not your turn.");
  if (rt.processing) return safeEphemeral(interaction, "Resolving the previous move…");
  await interaction.deferUpdate().catch(() => {});
  await applyMove(rt, rt.currentSide, move);
}

async function onFatalityButton(rt: BattleRuntime, interaction: ButtonInteraction) {
  if (rt.phase !== "combat") return safeEphemeral(interaction, "The battle isn't in combat.");
  const side = rt.currentSide;
  const actor = side === 0 ? rt.a! : rt.b!;
  const foe = other(rt, side);
  if (interaction.user.id !== actor.userId) return safeEphemeral(interaction, "It's not your turn.");
  if (rt.processing) return safeEphemeral(interaction, "Resolving the previous move…");
  // Re-check the window server-side: never trust a stale button.
  if (!fatalityReady(actor, foe)) return safeEphemeral(interaction, "The moment has passed — that's no longer a guaranteed finish.");
  await interaction.deferUpdate().catch(() => {});
  await applyFatality(rt, side);
}

// A Fatality is a guaranteed finishing blow: it stops the battle immediately,
// credits the killing damage exactly like a normal KO (so winner/rewards/XP/
// stats are byte-for-byte identical to attacking), adds the finisher log line,
// and routes through the SAME finishBattle path — which renders the cinematic
// instead of the normal victory image because rt.fatality is set.
async function applyFatality(rt: BattleRuntime, side: 0 | 1) {
  if (rt.phase !== "combat" || rt.processing) return;
  rt.processing = true;
  clearTimer(rt, "turnTimer");
  try {
    const actor = side === 0 ? rt.a! : rt.b!;
    const foe = other(rt, side);
    // Credit the lethal blow to the attacker's dealt-damage total, matching a
    // normal killing hit so leaderboard/reward telemetry is unchanged.
    const lethal = Math.max(0, foe.hp) + Math.max(0, foe.shield);
    rt.dmg[side] += lethal;
    foe.shield = 0;
    foe.hp = 0;
    rt.wentLow[foeSide(side)] = true;
    const userName = side === 0 ? rt.challengerName : rt.opponentName;
    rt.log.push(`💀 **${userName}** used FATALITY!`);
    rt.fatality = { side, userName };
    await finishBattle(rt, side, "fatality");
  } catch (err) {
    logger.error({ err, battleId: rt.id }, "applyFatality failed");
    rt.processing = false;
  }
}

async function applyMove(rt: BattleRuntime, side: 0 | 1, move: MoveType) {
  if (rt.phase !== "combat" || rt.processing) return;
  rt.processing = true;
  clearTimer(rt, "turnTimer");
  try {
    const actor = side === 0 ? rt.a! : rt.b!;
    const foe = other(rt, side);

    // Start-of-turn ticks (DoT / regen / freeze / energy). Attribute any DoT
    // loss to the foe's dealt-damage total so leaderboard stats stay honest.
    const actorPoolBefore = actor.hp + actor.shield;
    const start = startOfTurn(actor, rt.settings);
    const dotLoss = Math.max(0, actorPoolBefore - (actor.hp + actor.shield));
    if (dotLoss > 0) rt.dmg[foeSide(side)] += dotLoss;
    for (const e of start.events) rt.log.push(e.text);
    if (actor.hp / actor.stats.maxHealth <= 0.15) rt.wentLow[side] = true;
    if (start.koed) {
      await finishBattle(rt, foeSide(side), "dot");
      return;
    }

    // "Current move" animation frame.
    await renderCombat(rt, { currentMove: `${actor.cardName} → ${moveLabel(move)}…` });
    await sleep(frameMs(rt));

    if (!start.skipped) {
      // Measure BOTH combatants' losses so counters/reflect count correctly:
      // the actor's own loss (counter/reflect) is damage the foe dealt.
      const foePoolBefore = foe.hp + foe.shield;
      const selfPoolBefore = actor.hp + actor.shield;
      // Per-side HP before the exchange — drives the HP-bar "damage chip" so the
      // struck fighter's bar shows exactly how much it just lost.
      const aHpBefore = rt.a!.hp, bHpBefore = rt.b!.hp;
      const result = resolveMove(rt.settings, actor, foe, move);
      for (const e of result.events) {
        rt.log.push(e.text);
        if (e.flash === "crit") rt.crits[side]++;
      }
      const damage = Math.max(0, foePoolBefore - (foe.hp + foe.shield));
      rt.dmg[side] += damage;
      rt.dmg[foeSide(side)] += Math.max(0, selfPoolBefore - (actor.hp + actor.shield));
      if (foe.hp / foe.stats.maxHealth <= 0.15) rt.wentLow[foeSide(side)] = true;
      if (actor.hp / actor.stats.maxHealth <= 0.15) rt.wentLow[side] = true;

      // Per-turn attack frame: a fresh canvas focused on the acting card,
      // move name, and impact FX — same renderer raids use, so the hit is
      // visible and readable instead of blended into a busy battlefield.
      const visual = computeMoveVisual(move, result, actor, foe, foePoolBefore, selfPoolBefore);
      if (sceneAnimated(rt)) {
        // ANIMATED mode: Street-Fighter-style turn — the attacker dashes across
        // the living arena, impact FX fire on contact, the foe recoils, HP
        // drains. The GIF loops between turns, keeping the scene alive.
        const ended = result.koed || foe.hp <= 0;
        const frameGs = await getOrCreateGuildSettings(rt.guildId).catch(() => null);
        const anim = await withGuildFrames(frameGs, () => renderBattleTurn(
          buildAnimInput(rt, side, {
            moveName: moveLabel(move), damage: visual.damage,
            isCrit: visual.isCrit, isHit: visual.isHit, ended,
          }),
          rt.settings.battleAnimationSpeed as AnimationSpeed,
        )).catch(() => null);
        rt.turnAnimation = anim ? Buffer.from(anim.buffer) : null;
      } else if (rt.settings.battleAnimationEnabled) {
        // CLASSIC mode: the lighter single-frame attack card (pre-arena style).
        const frameGs = await getOrCreateGuildSettings(rt.guildId).catch(() => null);
        rt.turnAnimation = await withGuildFrames(frameGs, () => renderAttackFrame({
          attacker: combatantToRenderCard(rt, actor),
          moveName: moveLabel(move),
          damage: visual.damage,
          isCrit: visual.isCrit,
          isHit: visual.isHit,
          scene: visual.scene,
          subtitle: visual.subtitle,
        })).catch(() => null);
      }

      await renderCombat(rt);
      await sleep(frameMs(rt));

      // A counter/reflect can KO the attacker — check both.
      if (actor.hp <= 0 && foe.hp > 0) {
        await finishBattle(rt, foeSide(side), "ko");
        return;
      }
      if (result.koed || foe.hp <= 0) {
        await finishBattle(rt, actor.hp <= 0 ? null : side, "ko");
        return;
      }
    } else {
      await renderCombat(rt);
    }

    // Next turn.
    rt.currentSide = foeSide(side);
    if (rt.currentSide === 0) rt.turnNumber++;
    // Sudden-death cap keeps battles snappy — decide by remaining HP%.
    if (rt.turnNumber > MAX_COMBAT_TURNS) {
      rt.log.push("⌛ Time limit reached — the fighter with more HP wins!");
      await finishBattle(rt, decideByHp(rt), "turnlimit");
      return;
    }
    rt.processing = false;
    await startTurn(rt);
  } catch (err) {
    logger.error({ err, battleId: rt.id }, "applyMove failed");
    rt.processing = false;
  }
}

// ── Battle end + rewards ─────────────────────────────────────────────────────
async function finishBattle(rt: BattleRuntime, winnerSide: 0 | 1 | null, reason: string) {
  if (rt.phase === "ended") return;
  rt.phase = "ended";
  clearTimer(rt, "turnTimer"); clearTimer(rt, "ttlTimer"); clearTimer(rt, "aiOfferTimer");
  rt.processing = true;
  const a = rt.a!, b = rt.b!;

  const winnerId = winnerSide === null ? null : (winnerSide === 0 ? a.userId : b.userId);

  const mkResult = (c: Combatant, side: 0 | 1, won: boolean): ParticipantResult => ({
    userId: c.userId, isAi: c.isAi, cardId: c.cardId, cardName: c.cardName,
    damageDealt: rt.dmg[side], damageTaken: rt.dmg[foeSide(side)],
    crits: rt.crits[side], perfect: won && rt.dmg[foeSide(side)] === 0,
    comeback: won && rt.wentLow[side],
  });

  const season = await ensureSeason(rt.guildId).catch(() => null);
  let outcomes: RewardOutcome[] = [];
  let levelUps: import("./reward-engine.js").CardLevelUp[] = [];
  try {
    const res = await processBattleRewards({
      guildId: rt.guildId, settings: rt.settings, season,
      staked: rt.staked, isAi: rt.isAi, aiDifficulty: rt.isAi ? rt.aiDifficulty : null,
      challenger: mkResult(a, 0, winnerSide === 0),
      opponent: mkResult(b, 1, winnerSide === 1),
      winnerId, turns: rt.turnNumber, endedReason: reason,
      grantPack: grantFreePack,
    });
    outcomes = res.outcomes;
    levelUps = res.levelUps;

    // Daily challenge progress + unified account XP for humans.
    const { awardPlayerXp, XP } = await import("../player/xp.js");
    for (const side of [0, 1] as const) {
      const c = side === 0 ? a : b;
      if (c.isAi) continue;
      await advanceDaily(rt.guildId, c.userId, {
        won: winnerId === c.userId, vsAi: rt.isAi, damageDealt: rt.dmg[side],
        perfect: winnerId === c.userId && rt.dmg[foeSide(side)] === 0,
        cardRarity: c.cardRarity, crits: rt.crits[side],
      }).catch(() => {});
      await awardPlayerXp(rt.guildId, c.userId, "battle", winnerId === c.userId ? XP.battleWin : XP.battleLoss);
    }
  } catch (err) {
    logger.error({ err, battleId: rt.id }, "reward processing failed");
  }

  // Settle escrowed staked cards exactly once (winner takes both, draw returns).
  await settleEscrow(rt, winnerSide);

  cancelHudSettle(rt);
  const rewardLines = buildRewardLines(rt, outcomes);
  const view = toView(rt);
  const winner = winnerSide === null ? null : (winnerSide === 0 ? rt.a : rt.b);
  const endTheme = statusThemeOf(rt.settings.battleStatusTheme);
  const endHud = endTheme === "classic" ? null : await renderStatusStill(battleHudBoard(
    rt, view, endTheme === "gauges" ? "gauges" : "drain", winner ? "VICTORY" : "DRAW",
  ));

  // End-screen image. A Fatality finisher plays the full cinematic GIF; every
  // other ending keeps its existing victory GIF exactly as before.
  if (winner && rt.fatality && rt.a && rt.b) {
    const cine = await renderFatalityCinematic({
      winner: combatantToRenderCard(rt, winner),
      loser: combatantToRenderCard(rt, winnerSide === 0 ? rt.b : rt.a),
    }).catch(() => null);
    if (cine) { rt.vsImage = cine.buffer; rt.vsImageIsGif = true; }
  } else if (winner && rt.settings.battleAnimationEnabled && rt.a && rt.b) {
    const w = winner, la = rt.a, lb = rt.b; // narrowed non-null captures for the closure below
    const victory = await withGuildFrames(await getOrCreateGuildSettings(rt.guildId).catch(() => null), () => renderBattleVictory({
      winner: combatantToRenderCard(rt, w),
      loser: combatantToRenderCard(rt, winnerSide === 0 ? lb : la),
      background: rt.sceneArenaKey,
    }, rt.settings.battleAnimationSpeed as AnimationSpeed)).catch(() => null);
    if (victory) { rt.vsImage = victory.buffer; rt.vsImageIsGif = true; }
  }

  // Build the victory embed once and reuse it for the message + the battle log.
  // The winner's card stays the thumbnail (buildWinnerEmbed); the VS battle image
  // is reused as the big embed image so it isn't wasted, plus an "HP left" line.
  // Animated end-screens MUST attach under a .gif name or Discord freezes them.
  const endFileName = rt.vsImageIsGif ? VS_IMAGE_NAME_GIF : VS_IMAGE_NAME;
  const winnerEmbed = buildWinnerEmbed(view, winnerSide, rewardLines, { hideMeters: !!endHud });
  if (rt.vsImage) winnerEmbed.setImage(`attachment://${endFileName}`);
  if (winner) {
    const pct = Math.max(0, Math.round((winner.hp / Math.max(1, winner.stats.maxHealth)) * 100));
    winnerEmbed.addFields({
      name: "💪 Survived",
      value: `Won with **${Math.max(0, winner.hp).toLocaleString()} / ${winner.stats.maxHealth.toLocaleString()} HP** left (${pct}%)`,
      inline: false,
    });
  }
  const winnerFiles = rt.vsImage ? [new AttachmentBuilder(rt.vsImage, { name: endFileName })] : [];
  const winnerEmbeds = [winnerEmbed];
  if (endHud) {
    winnerEmbeds.push(new EmbedBuilder().setColor(winnerEmbed.data.color ?? 0xed4245).setImage(`attachment://${HUD_FILE_PNG}`));
    winnerFiles.push(new AttachmentBuilder(endHud, { name: HUD_FILE_PNG }));
  }

  if (rt.message) {
    await rt.message.edit({ embeds: winnerEmbeds, components: [], files: winnerFiles }).catch(() => {});
  }

  // Achievement toasts + battle log channel.
  const client = getBotClient();
  if (rt.message) {
    const channel = rt.message.channel;
    for (const o of outcomes) {
      if (o.achievements.length > 0 && channel.isSendable()) {
        const toast = await channel.send({
          content: `🏆 <@${o.userId}> unlocked:\n${o.achievements.map(formatAchievementLine).join("\n")}`,
          allowedMentions: { users: [o.userId] },
        }).catch(() => null);
        // Notification, not a record — show it, then keep the channel clean.
        scheduleMessageDelete(toast, 20_000);
      }
    }
    // Log the same victory embed, re-attaching the VS image so it stays with
    // the logged result too.
    if (client) await logBattleResult(client, rt.guildId, winnerEmbed,
      rt.vsImage ? { buffer: rt.vsImage, name: endFileName } : undefined).catch(() => {});

    // Victory embed is dramatic but temporary; the battle log keeps the result.
    setTimeout(() => {
      rt.message?.delete().catch(() => {});
    }, 15000).unref();

    // Card level-up / star-up toasts.
    if (levelUps.length > 0 && rt.message.channel.isSendable()) {
      const lines = levelUps.map(l => {
        const starUp = l.newStars > l.oldStars ? `  ⭐ **${l.newStars}-star!**` : "";
        const frames = l.newFrames.length > 0 ? `  ·  🖼️ unlocked: ${l.newFrames.join(", ")}` : "";
        return `🎖️ <@${l.userId}>'s **${l.cardName}** reached **Level ${l.newLevel}**${starUp}${frames}`;
      });
      const toast = await rt.message.channel.send({
        content: lines.join("\n"),
        allowedMentions: { users: levelUps.map(l => l.userId) },
      }).catch(() => null);
      scheduleMessageDelete(toast, 20_000);
    }
  }

  await teardown(rt);
}

function buildRewardLines(rt: BattleRuntime, outcomes: RewardOutcome[]): string[] {
  const lines: string[] = [];
  for (const o of outcomes) {
    const bits: string[] = [];
    if (o.shards > 0) bits.push(`💠 +${o.shards}`);
    if (o.xp > 0) bits.push(`✨ +${o.xp} XP`);
    if (o.streakBonus > 0) bits.push(`🔥 streak +${o.streakBonus}`);
    if (o.rankDelta !== 0) bits.push(`${o.rankDelta > 0 ? "📈" : "📉"} ${o.rankDelta > 0 ? "+" : ""}${o.rankDelta} rank`);
    if (o.leveledUp) bits.push(`⬆️ Level ${o.level}`);
    if (o.cardWonId) bits.push("🎴 won opponent's card!");
    if (o.cardLostId) bits.push("💔 lost staked card");
    if (o.freePackTier) bits.push(`🎁 free ${o.freePackTier} pack`);
    if (o.throttled) bits.push("⚠️ daily reward cap reached");
    const status = o.won ? "🏆 Win" : o.draw ? "🤝 Draw" : "❌ Loss";
    lines.push(`${status}: <@${o.userId}> — ${bits.length ? bits.join(" · ") : "no rewards"}`);
  }
  return lines;
}

// Return escrowed staked cards. Winner receives BOTH cards; a draw returns each
// player their own. Idempotent via `escrowSettled`. Uses restoreCardToUser so
// the global mint count is untouched (a transfer, not a new card).
async function settleEscrow(rt: BattleRuntime, winnerSide: 0 | 1 | null): Promise<void> {
  if (!rt.escrow || rt.escrowSettled) return;
  rt.escrowSettled = true;
  const { challengerCardId, opponentCardId } = rt.escrow;
  const chalId = rt.challengerId;
  const oppId = rt.b?.userId ?? rt.opponentId ?? "";
  // Consume the lock rows BEFORE restoring so a crash mid-settlement can't let
  // startup recovery restore the same cards a second time (prefer a rare loss
  // over any chance of duplication).
  await releaseBattleLock(rt.guildId, chalId, rt.id).catch(() => {});
  if (oppId && oppId !== AI_ID) await releaseBattleLock(rt.guildId, oppId, rt.id).catch(() => {});
  if (!oppId || oppId === AI_ID) {
    // No valid opponent (shouldn't happen for staked PvP) — refund challenger.
    await restoreCardToUser(rt.guildId, chalId, challengerCardId).catch(() => {});
    return;
  }
  if (winnerSide === null) {
    await restoreCardToUser(rt.guildId, chalId, challengerCardId).catch(() => {});
    await restoreCardToUser(rt.guildId, oppId, opponentCardId).catch(() => {});
  } else {
    const winnerId = winnerSide === 0 ? chalId : oppId;
    await restoreCardToUser(rt.guildId, winnerId, challengerCardId).catch(() => {});
    await restoreCardToUser(rt.guildId, winnerId, opponentCardId).catch(() => {});
  }
}

async function endBattleByTimeout(rt: BattleRuntime) {
  if (rt.phase === "ended") return;
  if (rt.phase === "combat" && rt.a && rt.b) {
    rt.log.push("⌛ Battle timed out — winner decided by remaining HP.");
    await finishBattle(rt, decideByHp(rt), "timeout");
    return;
  }
  if (rt.message) {
    await rt.message.edit({
      embeds: [new EmbedBuilder().setColor(0x99aab5).setTitle("⌛ Battle expired").setDescription("This battle timed out during setup.")],
      components: [],
    }).catch(() => {});
  }
  await teardown(rt);
}

async function teardown(rt: BattleRuntime) {
  clearTimer(rt, "turnTimer"); clearTimer(rt, "ttlTimer"); clearTimer(rt, "aiOfferTimer");
  await releaseBattleLock(rt.guildId, rt.challengerId, rt.id).catch(() => {});
  if (rt.opponentId && rt.opponentId !== AI_ID) {
    await releaseBattleLock(rt.guildId, rt.opponentId, rt.id).catch(() => {});
  }
  battles.delete(rt.id);
}

// ── Admin safety valve: force-cancel a stuck battle ──────────────────────────
// Covers the cases sweepStaleLocks/MAX_BATTLE_MS can't fix on demand: the battle
// message got deleted so the player has no buttons to act on, or a bug otherwise
// wedges a battle and an admin needs to unstick the player right now rather than
// wait out the 20-minute TTL. Any staked cards in escrow are refunded (a forced
// cancel is nobody's win) and the lock is always cleared even if the in-memory
// runtime is already gone (process restart, crash) — so the player is never left
// stuck "already in a battle" no matter how the state got wedged.
export interface ForceEndResult {
  found: boolean;         // was there anything to cancel?
  inMemory: boolean;      // true = a live runtime was torn down; false = DB-only lock cleanup
  opponentName?: string;
  refundedStakedCard: boolean;
}

export async function forceEndUserBattle(guildId: string, userId: string): Promise<ForceEndResult> {
  const rt = [...battles.values()].find(
    b => b.guildId === guildId && b.phase !== "ended" &&
      (b.challengerId === userId || (b.opponentId === userId && b.opponentId !== AI_ID)),
  );

  if (rt) {
    const hadEscrow = !!rt.escrow && !rt.escrowSettled;
    // Draw semantics: nobody "won" an admin-forced cancel, so any staked cards
    // return to their original owners rather than being awarded to either side.
    await settleEscrow(rt, null);
    if (rt.message) {
      await rt.message.edit({
        embeds: [new EmbedBuilder().setColor(0x99aab5).setTitle("🛑 Battle cancelled").setDescription("An admin force-ended this battle.")],
        components: [],
      }).catch(() => {});
    }
    const opponentName = rt.challengerId === userId ? rt.opponentName : rt.challengerName;
    await teardown(rt);
    return { found: true, inMemory: true, opponentName, refundedStakedCard: hadEscrow };
  }

  // No live runtime (bot restarted, or the state is DB-only for some other
  // reason) — fall back to clearing the lock row directly, mirroring the
  // startup recovery path so a staked card isn't silently lost.
  const lock = await getUserLock(guildId, userId);
  if (!lock) return { found: false, inMemory: false, refundedStakedCard: false };
  const refund = lock.staked && lock.cardId != null;
  if (refund) await restoreCardToUser(guildId, userId, lock.cardId!).catch(() => {});
  await releaseBattleLock(guildId, userId).catch(() => {});
  return { found: true, inMemory: false, refundedStakedCard: refund };
}

// ── Rendering ────────────────────────────────────────────────────────────────
const VS_IMAGE_NAME = "battle-vs.png";
// Animated end-screens (victory / fatality) must attach as .gif or Discord shows
// only a frozen first frame — the extension, not the bytes, drives animation.
const VS_IMAGE_NAME_GIF = "battle-vs.gif";

// Map a live Combatant to the renderer's card description.
function combatantToRenderCard(rt: BattleRuntime, c: Combatant): RenderCard {
  const display = c.cardRarityDisplay;
  return {
    name: c.cardName,
    rarity: c.cardRarity,
    rarityLabel: display ? `${display.emoji} ${display.label}` : (rarityLabel(c.cardRarity, null, rt.displayMap) ?? c.cardRarity),
    rarityColor: display?.color ?? rarityColor(c.cardRarity, null, rt.displayMap),
    cardId: c.cardId,
    cardType: c.cardType,
    artUrl: c.cardImageUrl,
    attack: c.stats.attack,
    special: getMoveset(c.moveset)?.name ?? null,
    progTier: c.progTier,
  };
}

// Discord animates an embed image only when the ATTACHMENT filename ends in
// .gif — the extension, not the bytes, drives it. During the animated fight the
// combat images are GIFs, so they must attach under the .gif name.
function combatImageName(isGif: boolean): string {
  return isGif ? VS_IMAGE_NAME_GIF : VS_IMAGE_NAME;
}

// Build the animated-scene input from current combat state. `actorSide` is the
// side drawn on the LEFT (the attacker); the foe is on the right.
function buildAnimInput(
  rt: BattleRuntime, actorSide: 0 | 1,
  move?: { moveName: string; damage: number; isCrit: boolean; isHit: boolean; ended: boolean },
): BattleAnimationInput {
  const actor = actorSide === 0 ? rt.a! : rt.b!;
  const foe = actorSide === 0 ? rt.b! : rt.a!;
  return {
    attacker: combatantToRenderCard(rt, actor),
    defender: combatantToRenderCard(rt, foe),
    attackerHp: Math.max(0, actor.hp),
    attackerMaxHp: actor.stats.maxHealth,
    defenderHp: Math.max(0, foe.hp),
    defenderMaxHp: foe.stats.maxHealth,
    damage: move?.damage ?? 0,
    isCrit: move?.isCrit ?? false,
    isHit: move?.isHit ?? false,
    moveName: move?.moveName ?? "",
    attackerWon: move?.ended ?? false,
    defenderWon: false,
    background: rt.sceneArenaKey,
  };
}

// True when this fight uses the heavy ANIMATED arena scene (both cards dashing
// over a looping backdrop). Requires the master GIF switch AND the arena-scene
// style. When false the fight is either CLASSIC (cheap single-frame attack
// cards) or fully static — both far lighter to render.
function sceneAnimated(rt: BattleRuntime): boolean {
  return rt.settings.battleAnimationEnabled && rt.settings.battleSceneAnimated;
}

// The pinned VS-image embed that sits ABOVE the battle embed. Optional title is
// used for the dramatic pre-combat reveal; combat renders it title-less so the
// battlefield picture just stays at the top the whole fight.
function vsTop(rt: BattleRuntime, title?: string, image?: Buffer | null): { embed: EmbedBuilder | null; file: AttachmentBuilder | null } {
  const img = image ?? rt.vsImage;
  if (!img) return { embed: null, file: null };
  const name = combatImageName(rt.vsImageIsGif);
  const embed = new EmbedBuilder()
    .setColor(rarityColorOfSide(rt))
    .setImage(`attachment://${name}`);
  if (title) embed.setTitle(title);
  return { embed, file: new AttachmentBuilder(img, { name }) };
}

function rarityColorOfSide(rt: BattleRuntime): number {
  const active = rt.currentSide === 0 ? rt.a : rt.b;
  return rarityColor(active?.cardRarity ?? "common", null, rt.displayMap) ?? 0xed4245;
}

function cancelHudSettle(rt: BattleRuntime): void {
  if (rt.hudSettle) clearTimeout(rt.hudSettle);
  rt.hudSettle = null;
  rt.hudGen = (rt.hudGen ?? 0) + 1;
}

function battleHudBoard(rt: BattleRuntime, view: BattleView, style: "drain" | "gauges", headline?: string): HudBoard {
  const prev = rt.hudShown;
  const active = view.currentSide === 0 ? view.a : view.b;
  const title = headline ?? (active.isAi ? "AI IS DECIDING" : "YOUR MOVE");
  const mapSide = (c: BattleView["a"], side: 0 | 1): HudFighter => hudFighter(c, {
    tag: c.isAi ? "AI" : "YOU",
    tagTone: c.isAi ? "ai" : "you",
    sub: c.isAi ? "AI" : c.displayName,
    active: view.currentSide === side,
    fromHp: prev ? (side === 0 ? prev.a : prev.b) : c.hp,
  });
  return {
    style,
    headline: title,
    turnLabel: `TURN ${view.turnNumber}`,
    fighters: [mapSide(view.a, 0), mapSide(view.b, 1)],
  };
}

async function renderThemedCombat(
  rt: BattleRuntime, opts: { currentMove?: string; turnEndsAt?: number } | undefined, theme: StatusTheme, gen: number,
): Promise<void> {
  if (!rt.message || !rt.a || !rt.b || theme === "classic") return;
  const view = toView(rt, opts?.turnEndsAt);
  const style = theme === "gauges" ? "gauges" : "drain";
  const board = battleHudBoard(rt, view, style);
  const changed = board.fighters.some(f => Math.round(f.fromHp) !== Math.round(f.hp));
  rt.hudShown = { a: view.a.hp, b: view.b.hp };
  const stillBoard: HudBoard = {
    ...board,
    fighters: board.fighters.map(f => ({ ...f, fromHp: f.hp })),
  };
  const animated = style === "drain" && changed ? await renderStatusDrain(board) : null;
  const still = animated?.still ?? await renderStatusStill(stillBoard);
  const gif = animated?.gif ?? null;
  if (rt.hudGen !== gen || !rt.message) return;
  if (!still) {
    await renderClassicCombat(rt, opts);
    return;
  }
  const actor = rt.currentSide === 0 ? rt.a : rt.b;
  const components = actor.isAi ? [] : buildMoveComponents(rt, actor);
  const logEmbed = buildBattleLogEmbed(view);
  const color = rarityColorOfSide(rt);
  const hudEmbed = new EmbedBuilder().setColor(color).setDescription(currentTurnLine(view));
  const hudName = gif ? HUD_FILE_GIF : HUD_FILE_PNG;
  hudEmbed.setImage(`attachment://${hudName}`);
  const files: AttachmentBuilder[] = [new AttachmentBuilder(gif ?? still, { name: hudName })];
  const turnImg = rt.turnAnimation;
  rt.turnAnimation = null;
  const combatImg = turnImg ?? rt.vsImage;
  const isGif = turnImg ? sceneAnimated(rt) : rt.vsImageIsGif;
  const embeds = [logEmbed, hudEmbed];
  let combat: { buffer: Buffer; name: string } | null = null;
  if (combatImg) {
    const name = combatImageName(isGif);
    const battleEmbed = new EmbedBuilder().setColor(color).setImage(`attachment://${name}`);
    embeds.push(battleEmbed);
    combat = { buffer: combatImg, name };
    files.push(new AttachmentBuilder(combatImg, { name }));
  }
  if (opts?.currentMove) hudEmbed.setFooter({ text: opts.currentMove });
  if (rt.hudGen !== gen) return;
  if (gif && still) {
    rt.hudSnapshot = { gen, embeds, hudEmbed, components, combat, still };
    rt.hudSettle = setTimeout(() => {
      if (rt.hudGen !== gen || !rt.message || !rt.hudSnapshot || rt.hudSnapshot.gen !== gen) return;
      const snap = rt.hudSnapshot;
      snap.hudEmbed.setImage(`attachment://${HUD_FILE_PNG}`);
      const next: AttachmentBuilder[] = [new AttachmentBuilder(snap.still, { name: HUD_FILE_PNG })];
      if (snap.combat) next.push(new AttachmentBuilder(snap.combat.buffer, { name: snap.combat.name }));
      rt.message.edit({ embeds: snap.embeds, components: snap.components, files: next }).catch(() => {});
    }, DRAIN_SETTLE_MS);
  }
  await rt.message.edit({ content: null, embeds, components, files }).catch(() => {});
}

async function renderCombat(rt: BattleRuntime, opts?: { currentMove?: string; turnEndsAt?: number }) {
  if (!rt.message || !rt.a || !rt.b) return;
  cancelHudSettle(rt);
  const fresh = await getBattleSettings(rt.guildId).catch(() => null);
  if (fresh) rt.settings = { ...rt.settings, battleStatusTheme: fresh.battleStatusTheme };
  const theme = statusThemeOf(rt.settings.battleStatusTheme);
  if (theme !== "classic") {
    await renderThemedCombat(rt, opts, theme, rt.hudGen ?? 0);
    return;
  }
  await renderClassicCombat(rt, opts);
}

async function renderClassicCombat(rt: BattleRuntime, opts?: { currentMove?: string; turnEndsAt?: number }) {
  if (!rt.message || !rt.a || !rt.b) return;
  const view = toView(rt, opts?.turnEndsAt);
  const actor = rt.currentSide === 0 ? rt.a : rt.b;
  const components = actor.isAi ? [] : buildMoveComponents(rt, actor);

  // Two-embed layout:
  //   TOP    = recent battle log + current turn (buildBattleLogEmbed)
  //   BOTTOM = HP/Energy/Ultimate status + the combat canvas as its image
  // A one-shot turn animation, if queued, is consumed for this render only.
  const logEmbed = buildBattleLogEmbed(view);
  const statusEmbed = buildBattleStatusEmbed(view, { currentMove: opts?.currentMove });
  const turnImg = rt.turnAnimation;
  rt.turnAnimation = null;
  const combatImg = turnImg ?? rt.vsImage;
  // A one-shot turn animation is a GIF only in ANIMATED mode (renderBattleTurn);
  // in CLASSIC mode it's a static PNG. Otherwise the resting image decides.
  const isGif = turnImg ? sceneAnimated(rt) : rt.vsImageIsGif;
  const files: AttachmentBuilder[] = [];
  if (combatImg) {
    const name = combatImageName(isGif);
    statusEmbed.setImage(`attachment://${name}`);
    files.push(new AttachmentBuilder(combatImg, { name }));
  }
  await rt.message.edit({
    content: null,
    embeds: [logEmbed, statusEmbed],
    components,
    files,
  }).catch(() => {});
}

function toView(rt: BattleRuntime, turnEndsAt?: number): BattleView {
  return {
    a: rt.a!, b: rt.b!, turnNumber: rt.turnNumber, currentSide: rt.currentSide,
    staked: rt.staked, log: rt.log, turnEndsAt,
    displayMap: rt.displayMap,
  };
}

function other(rt: BattleRuntime, side: 0 | 1): Combatant {
  return side === 0 ? rt.b! : rt.a!;
}
function foeSide(side: 0 | 1): 0 | 1 { return side === 0 ? 1 : 0; }

// Decide a winner by remaining HP fraction (ties = draw). Used by the turn cap
// and the TTL safety net.
function decideByHp(rt: BattleRuntime): 0 | 1 | null {
  if (!rt.a || !rt.b) return null;
  const aPct = rt.a.hp / rt.a.stats.maxHealth;
  const bPct = rt.b.hp / rt.b.stats.maxHealth;
  return aPct === bPct ? null : aPct > bPct ? 0 : 1;
}

// ── Component builders ───────────────────────────────────────────────────────
function buildChallengeEmbed(rt: BattleRuntime, opponent: User | null, aiOffered = false): EmbedBuilder {
  const e = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("⚔️ Battle Challenge!")
    .setDescription(
      `<@${rt.challengerId}> challenges ${opponent ? `<@${opponent.id}>` : "an opponent"} to a card battle!\n\n` +
      `${opponent ? `<@${opponent.id}>, do you accept?` : ""}`,
    )
    .setFooter({ text: aiOffered ? "No response? The challenger can battle the AI instead." : `Waiting for a response… AI offered after ${rt.settings.aiOfferSeconds}s.` });
  return e;
}

function buildChallengeComponents(rt: BattleRuntime, aiOffered = false): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`battle:accept:${rt.id}`).setLabel("Accept").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`battle:decline:${rt.id}`).setLabel("Decline").setEmoji("❌").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`battle:cancel:${rt.id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
  );
  if (rt.settings.aiEnabled) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`battle:ai:${rt.id}`).setLabel("Battle AI Instead").setEmoji("🤖")
        .setStyle(aiOffered ? ButtonStyle.Primary : ButtonStyle.Secondary),
    );
  }
  return [row];
}

function buildAiDifficultyEmbed(_rt: BattleRuntime): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🤖 Choose your Arena")
    .setDescription(
      "The AI card scales to the **arena's level** — nothing is locked, but bringing an " +
      "under-levelled card to a high arena is a fast wipe. Grind your card to **Lv 100** to " +
      "breeze the Ascended Arena (and hit **5⭐** for boss raids). Higher arenas pay out more.",
    )
    .addFields(
      ARENA_KEYS.map(k => {
        const a = ARENAS[k];
        const band = a.minLevel === a.maxLevel ? `Lv ${a.minLevel}` : `Lv ${a.minLevel}–${a.maxLevel}`;
        return { name: `${a.emoji} ${a.name}`, value: `${band} · AI Lv ${a.aiLevel} · ×${a.rewardMult} rewards`, inline: true };
      }),
    );
}

function buildAiDifficultyComponents(rt: BattleRuntime): ActionRowBuilder<ButtonBuilder>[] {
  // 6 arenas over two rows (Discord allows ≤5 buttons per row).
  const mk = (k: typeof ARENA_KEYS[number]) =>
    new ButtonBuilder().setCustomId(`battle:aidiff:${rt.id}:${k}`).setLabel(ARENAS[k].name.replace(/ Arena$/, ""))
      .setEmoji(ARENAS[k].emoji).setStyle(ButtonStyle.Secondary);
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(ARENA_KEYS.slice(0, 3).map(mk));
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(ARENA_KEYS.slice(3).map(mk));
  return [row1, row2];
}

function buildPrepEmbed(rt: BattleRuntime): EmbedBuilder {
  const readyMark = (uid: string) => rt.prep.get(uid)?.ready ? "✅ Ready" : "⏳ Preparing…";
  const e = new EmbedBuilder()
    .setColor(0xfaa61a)
    .setTitle("🎴 Prepare for Battle")
    .setDescription("Both fighters: press **Prepare** to choose your card, coin call, and stake — then **Ready** up.")
    .addFields(
      { name: `Challenger — ${rt.challengerName}`, value: readyMark(rt.challengerId), inline: true },
    );
  if (rt.isAi) {
    e.addFields({ name: `Opponent — AI`, value: `${arenaLabel(rt.aiDifficulty)} · ✅ Ready`, inline: true });
  } else if (rt.opponentId) {
    e.addFields({ name: `Opponent — ${rt.opponentName}`, value: readyMark(rt.opponentId), inline: true });
  }
  if (rt.settings.stakingEnabled && !rt.isAi) {
    e.addFields({ name: "💰 Staking", value: "If **both** players stake, the winner takes the loser's card!", inline: false });
  }
  if (arenaAssetsAvailable()) {
    e.addFields({ name: "🌌 Battlefield", value: `${sceneArenaLabel(rt.sceneArenaKey ?? DEFAULT_SCENE_ARENA)} — challenger picks below.`, inline: false });
  }
  return e;
}

function buildPrepSharedComponents(rt: BattleRuntime): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
  // Battlefield backdrop picker (challenger chooses the animated arena for this
  // fight). Only shown when the bundled arena assets are present.
  if (arenaAssetsAvailable()) {
    const current = rt.sceneArenaKey ?? DEFAULT_SCENE_ARENA;
    const arenaSelect = new StringSelectMenuBuilder()
      .setCustomId(`battle:arena:${rt.id}`)
      .setPlaceholder("🌌 Choose the battlefield")
      .addOptions(SCENE_ARENA_KEYS.map(k => ({
        label: SCENE_ARENAS[k]!.name,
        value: k,
        emoji: SCENE_ARENAS[k]!.emoji,
        default: k === current,
      })));
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(arenaSelect));
  }
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`battle:prep:${rt.id}`).setLabel("Prepare").setEmoji("🎴").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`battle:cancel:${rt.id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
  ));
  return rows;
}

// Challenger-only: set the animated battlefield backdrop for this fight.
async function onPickArena(rt: BattleRuntime, interaction: StringSelectMenuInteraction) {
  if (interaction.user.id !== rt.challengerId) {
    return safeEphemeral(interaction, "Only the challenger picks the battlefield.");
  }
  const key = interaction.values[0];
  if (isSceneArenaKey(key)) rt.sceneArenaKey = key;
  await interaction.update({ embeds: [buildPrepEmbed(rt)], components: buildPrepSharedComponents(rt) }).catch(() => {});
}

function buildPersonalPrepEmbed(rt: BattleRuntime, userId: string): EmbedBuilder {
  const prep = rt.prep.get(userId);
  const cardName = prep?.cardId ? (rt.eligibleCache.get(userId)?.find(c => c.id === prep.cardId)?.name ?? `#${prep.cardId}`) : "—";
  const item = getBattleItem(prep?.itemId, rt.guildId);
  const itemName = item ? `${item.emoji} ${item.name}` : "None";
  return new EmbedBuilder()
    .setColor(0xfaa61a)
    .setTitle("🎴 Choose your fighter")
    .setDescription("Your top-leveled cards are shown below. Pick from the dropdown, **Quick Pick** your strongest, or **Search** by name — then **Ready** up.")
    .addFields(
      { name: "🎴 Card", value: cardName, inline: true },
      { name: "🎒 Battle Item", value: itemName, inline: true },
      { name: "🪙 Coin", value: prep?.coin ? prep.coin[0].toUpperCase() + prep.coin.slice(1) : "—", inline: true },
      ...(rt.settings.stakingEnabled && !rt.isAi
        ? [{ name: "💰 Stake", value: prep?.stake ? "Yes — card on the line!" : "No", inline: true }]
        : []),
    );
}

// The dropdown carries the top 25 leveled cards; Quick Pick + Search cover the
// rest, so the picker is never paged.
const PICKER_MENU_SIZE = 25;

function buildPersonalPrepComponents(
  rt: BattleRuntime, userId: string, eligible: OwnedBattleCard[],
): ActionRowBuilder<any>[] {
  const prep = rt.prep.get(userId);
  const menuCards = eligible.slice(0, PICKER_MENU_SIZE);
  const extra = Math.max(0, eligible.length - menuCards.length);

  const cardSelect = new StringSelectMenuBuilder()
    .setCustomId(`battle:pcard:${rt.id}`)
    .setPlaceholder(`🎴 Your top ${menuCards.length} cards${extra ? ` · +${extra} more via Search` : ""}`)
    .addOptions(menuCards.map(c => {
      const display = c.displayRarity;
      const rarityTag = display
        ? `${display.emoji} ${display.label}`
        : rarityLabel(c.rarity, null, rt.displayMap);
      return {
        label: c.name.slice(0, 100),
        description: `Lv ${c.level}${c.starRank > 0 ? ` · ${c.starRank}★` : ""} · ${rarityTag}`.slice(0, 100),
        value: String(c.id),
        default: prep?.cardId === c.id,
      };
    }));

  const rows: ActionRowBuilder<any>[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(cardSelect),
  ];

  // Quick Pick (auto-select strongest) + Search by name (modal) — replaces paging.
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`battle:pquick:${rt.id}`).setLabel("Quick Pick").setEmoji("⚡").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`battle:psearch:${rt.id}`).setLabel("Search by Name").setEmoji("🔍").setStyle(ButtonStyle.Secondary),
  ));

  // Battle Item selector (replaces the old special support-card slot). Items are
  // data-driven — this list comes straight from the registry.
  const items = listBattleItems(rt.guildId);
  if (items.length) {
    const itemSelect = new StringSelectMenuBuilder()
      .setCustomId(`battle:pitem:${rt.id}`)
      .setPlaceholder("🎒 Optional: equip a battle item")
      .addOptions(
        { label: "None", description: "Fight without a battle item", value: "none", default: !prep?.itemId },
        ...items.slice(0, 24).map(it => ({
          label: `${it.name}`.slice(0, 100),
          description: it.description.slice(0, 100),
          emoji: it.emoji,
          value: it.id,
          default: prep?.itemId === it.id,
        })),
      );
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(itemSelect));
  }

  const coinRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`battle:pcoin:${rt.id}:heads`).setLabel("Heads").setEmoji("🪙")
      .setStyle(prep?.coin === "heads" ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`battle:pcoin:${rt.id}:tails`).setLabel("Tails").setEmoji("🪙")
      .setStyle(prep?.coin === "tails" ? ButtonStyle.Primary : ButtonStyle.Secondary),
  );
  if (rt.settings.stakingEnabled && !rt.isAi) {
    coinRow.addComponents(
      new ButtonBuilder().setCustomId(`battle:pstake:${rt.id}`).setLabel(prep?.stake ? "Staking: ON" : "Stake Card")
        .setEmoji("💰").setStyle(prep?.stake ? ButtonStyle.Danger : ButtonStyle.Secondary),
    );
  }
  rows.push(coinRow);

  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`battle:pready:${rt.id}`).setLabel("Ready").setEmoji("⚔️")
      .setStyle(ButtonStyle.Success).setDisabled(!prep?.cardId),
  ));
  return rows;
}

// Is a plain attack from `actor` a GUARANTEED kill on `foe` this turn? Mirrors
// the deterministic worst case of combat-engine's strike() — no crit, low-end
// variance, defender's current defense/defending/shield — so it only returns
// true when even the weakest normal hit finishes the foe. Reads state only; it
// never mutates combat. Stealth is excluded (it would dodge a normal attack).
// This is the gate for offering the 💀 Fatality finisher.
function fatalityReady(actor: Combatant, foe: Combatant): boolean {
  if (foe.hp <= 0) return false;
  if (foe.status.some(s => s.kind === "stealth")) return false;
  const pool = foe.hp + foe.shield;
  const boost = 1 + actor.nextAttackBoostPct / 100;
  const rawAtk = actor.stats.attack * boost;                    // powerPct 100
  const effDef = foe.stats.defense * (foe.defending ? 2 : 1);
  const base = rawAtk * (rawAtk / (rawAtk + effDef * 0.9));
  const minDmg = Math.max(1, Math.floor(base * 0.88));          // no crit, low variance
  return minDmg >= pool;
}

function buildMoveComponents(rt: BattleRuntime, actor: Combatant): ActionRowBuilder<ButtonBuilder>[] {
  // 💀 Fatality window: when this attack is a guaranteed KO, replace the whole
  // control set with just Attack + Fatality for this one turn. Attacking normally
  // ends the battle exactly as it always has; Fatality triggers the cinematic.
  const foe = actor.userId === rt.a?.userId ? rt.b : rt.a;
  if (foe && !actor.isAi && fatalityReady(actor, foe)) {
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`battle:move:${rt.id}:attack`).setLabel("Attack").setEmoji("⚔️").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`battle:fatality:${rt.id}`).setLabel("FATALITY").setEmoji("💀").setStyle(ButtonStyle.Danger),
    )];
  }
  const avail = availableMoves(actor, rt.settings);
  const mk = (move: MoveType, label: string, emoji: string, style: ButtonStyle) =>
    new ButtonBuilder().setCustomId(`battle:move:${rt.id}:${move}`).setLabel(label).setEmoji(emoji)
      .setStyle(style).setDisabled(!avail[move]);
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    mk("attack", "Attack", "⚔️", ButtonStyle.Primary),
    mk("special", "Special", "🔥", ButtonStyle.Danger),
    mk("defend", "Defend", "🛡️", ButtonStyle.Secondary),
    mk("charge", "Charge", "⚡", ButtonStyle.Secondary),
    mk("skip", "Skip", "⏭️", ButtonStyle.Secondary),
  );
  const item = actor.item ?? getBattleItem(actor.itemId, rt.guildId);
  const itemLabel = item ? item.name.slice(0, 40) : "Use Item";
  const itemEmoji = item?.emoji ?? "🎒";
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    mk("item", itemLabel, itemEmoji, ButtonStyle.Success),
    mk("ultimate", "Ultimate", "💀", ButtonStyle.Danger),
    // Quick-view of THIS fighter's move set — a private floating popup you can
    // dismiss. Never disabled: it's read-only and doesn't spend the turn.
    new ButtonBuilder().setCustomId(`battle:moves:${rt.id}`).setLabel("Moves").setEmoji("📖").setStyle(ButtonStyle.Secondary),
  );
  return [row1, row2];
}

// A private, dismissible "what can my card do" reference for the current fight:
// the fighter's Special, equipped Item, Passive, and a basics reminder. Purely
// read-only — reads the live combatant, never mutates or spends a turn.
function buildMovesQuickView(rt: BattleRuntime, actor: Combatant): EmbedBuilder {
  const ms = actor.movesetDef ?? getMoveset(actor.moveset);
  const item = actor.item ?? getBattleItem(actor.itemId, rt.guildId);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📖 ${actor.cardName} — Move Set`)
    .setDescription("*Quick reference for this fight — only you can see this.*")
    .addFields(
      {
        name: "🔥 Special",
        value: ms
          ? `${ms.emoji} **${ms.name}** — ${ms.description}\n⚡ ${ms.energyCost} energy${ms.powerPct ? ` · ${ms.powerPct}% power` : ""}`
          : "_None assigned._",
        inline: false,
      },
      {
        name: "🎒 Item",
        value: item
          ? `${item.emoji} **${item.name}** — ${item.description}\n🔁 ${item.charges} use${item.charges === 1 ? "" : "s"} · cooldown ${item.cooldown}`
          : "_No item equipped._",
        inline: false,
      },
    );
  if (actor.passive) {
    embed.addFields({
      name: "✨ Passive",
      value: `${actor.passive.emoji} **${actor.passive.name}** — ${actor.passive.description}`,
      inline: false,
    });
  }
  embed.addFields({
    name: "🕹️ Basics",
    value: "⚔️ **Attack** · 🛡️ **Defend** (shield) · ⚡ **Charge** (energy + next-hit boost) · 💀 **Ultimate** (once charged)",
    inline: false,
  }).setFooter({ text: "Dismiss to close this window." });
  return embed;
}

async function onMovesButton(rt: BattleRuntime, interaction: ButtonInteraction): Promise<void> {
  const uid = interaction.user.id;
  const actor = rt.a?.userId === uid ? rt.a : rt.b?.userId === uid ? rt.b : null;
  if (!actor) { await safeEphemeral(interaction, "Only the fighters in this battle can view a move set."); return; }
  await interaction.reply({ embeds: [buildMovesQuickView(rt, actor)], flags: MessageFlags.Ephemeral }).catch(() => {});
}

function moveLabel(move: MoveType): string {
  return ({
    attack: "⚔️ Attack", special: "🔥 Special Attack", defend: "🛡️ Defend",
    special_card: "✨ Special Card", charge: "⚡ Charge", skip: "⏭️ Skip", ultimate: "💀 Ultimate",
    item: "🎒 Use Item",
  } as Record<MoveType, string>)[move];
}

// ── Utils ────────────────────────────────────────────────────────────────────
function clearTimer(rt: BattleRuntime, key: "turnTimer" | "aiOfferTimer" | "ttlTimer") {
  const t = rt[key];
  if (t) { clearTimeout(t); rt[key] = null; }
}

async function safeEphemeral(
  interaction: ButtonInteraction | StringSelectMenuInteraction, content: string,
): Promise<void> {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch { /* ignore */ }
}

// Startup recovery + periodic stale-lock sweep — call once at bot startup.
// At a cold start there are no in-memory battles, so any surviving lock row is
// from a crashed process: refund every escrowed staked card to its owner and
// wipe the lock table so no player is left stuck "already in a battle".
export function startBattleMaintenance(): void {
  void recoverAbandonedStakes();
  setInterval(() => { void sweepStaleLocks(MAX_BATTLE_MS + 60_000); }, 5 * 60_000);
}

async function recoverAbandonedStakes(): Promise<void> {
  try {
    const locks = await getAllLocks();
    let refunded = 0;
    for (const l of locks) {
      if (l.staked && l.cardId != null) {
        await restoreCardToUser(l.guildId, l.userId, l.cardId).catch(() => {});
        refunded++;
      }
    }
    await deleteAllLocks();
    if (locks.length > 0) {
      logger.info({ clearedLocks: locks.length, refundedStakes: refunded }, "battle: recovered abandoned locks at startup");
    }
  } catch (err) {
    logger.warn({ err }, "battle: startup lock recovery failed (non-fatal)");
  }
}
