// ─────────────────────────────────────────────────────────────────────────────
// HQ — the turn-for-turn Siege Battle runtime.
//
// This is the SINGLE player-facing combat experience for HQ / base / outpost
// attacks. HQ itself stays world/base/navigation; combat maths stay in the
// shared battle engine; this module owns the Discord surface around SiegeBattle
// state:
//
//   HQ target selection → muster → Siege Battle (draw → main → resolve → …)
//                                 → result → HQ capture / reward callbacks
//
// Card Clash is an INTERNAL cinematic played after certain resolved actions —
// never a separate mode or navigation button.
//
// Capture / tribute / shields live in the caller's `applyOutcome` callback.
// ─────────────────────────────────────────────────────────────────────────────

import {
  ButtonInteraction, StringSelectMenuInteraction, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  MessageFlags, AttachmentBuilder, type Message,
} from "discord.js";
import { randomBytes } from "crypto";
import type { BattleSettings } from "@workspace/db";
import type { Combatant, MoveType, AiDifficulty } from "../battle/types.js";
import { availableMoves } from "../battle/combat-engine.js";
import { powerRating } from "../battle/stat-engine.js";
import { WHITE_LINE } from "../battle/embeds.js";
import { getMoveset } from "../battle/movesets.js";
import {
  listBattleItems, getBattleItem, loadGuildBattleItems, applyItemUse, isOffensiveItem,
} from "../battle/items.js";
import { renderSiegeField, renderSiegeFieldStill, type AnimationSpeed } from "../animations/index.js";
import { renderCardClash, renderCardClashStill } from "../animations/index.js";
import type { SiegeFieldInput } from "../animations/index.js";
import {
  buildSiegeBattle, startTurn as engineStartTurn, enterMainPhase as engineEnterMain,
  endTurn as engineEndTurn,
  resolveAction, checkAction, chooseSiegeAction, legalActions,
  toSiegeRoster, toFieldInput, toClashInput, summariseResult, describeAction,
  livingSlots, formationEmpty, lpExposed, canReinforce, otherSide as engineOtherSide,
  getSiegeCard, HAND_SIZE, defaultMaxTurns, describeMove,
  type SiegeBattleState, type SiegeAction, type SiegeTurnResult,
} from "../siege/index.js";
import { renderCoinFlip } from "../battle/prep-canvas.js";
import { renderSiegeFrame, type HqBaseView, type SiegeOverlay, type HqRenderDefender } from "./render.js";
import { withGuildFrames } from "../animations/card-frames.js";
import { getOrCreateGuildSettings } from "../db.js";
import type { HqSiegeConfig } from "./settings.js";
import { logger } from "../../lib/logger.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;
// The garrison fights at a competent (not perfect) skill so specials, items and
// passives actually get used and an upset stays possible — same as the headless
// resolver.
const SIEGE_AI: AiDifficulty = "elite";
// The garrison commander's skill in the Siege Battle engine. It scores the same
// legalActions() a player's buttons are built from — never its own rules.
const SIEGE_AI_SKILL = "hard" as const;
/** Board squares per side, mirroring the engine's formation size. */
const FORMATION_SIZE = 4;
// Hard stop so a walked-away siege can never pin its target forever.
const MAX_SIEGE_MS = 20 * 60 * 1000;
const DEFAULT_FRAME_MS = 950;
/**
 * Discord doesn't publish a hard "max edits" for channel messages, but long
 * sieges that re-edit the same message dozens of times get flaky (rate limits,
 * stale attachment URLs, clients that stop refreshing). After this many edits
 * we post a fresh board message and continue there.
 */
const MAX_BOARD_EDITS = 48;

// ── Siege pressure ────────────────────────────────────────────────────────────
// A defender that braces gains a shield bigger than a normal hit, and the battle
// AI rationally braces every turn once it is hurt. In a 1v1 battle that just
// runs the clock out; in a siege — where the attacker must break EVERY rank to
// win — it makes a turtling garrison literally unkillable, so a base could never
// be taken.
//
// Siege pressure is the battering ram. Every commander turn a rank survives, the
// ram bites deeper: chip damage that scales with how long that rank has stalled
// and IGNORES shields, because bracing does nothing about the wall being
// undermined. A rank that trades normally dies long before pressure matters; a
// rank that only turtles gets torn down. The defender's answer is fortification
// (more HP to grind through), not an infinite guard.
/** Top embed: the castle scene. */
export const SIEGE_CASTLE_IMAGE = "siege-castle.png";
/** Bottom embed: the per-turn attack frame (`.gif` only when animated). */
const SIEGE_TURN_PNG = "siege-turn.png";
const SIEGE_TURN_GIF = "siege-turn.gif";
/** Card Clash frame (stage two), swapped in for the battlefield frame. */
const SIEGE_CLASH_PNG = "siege-clash.png";
const SIEGE_CLASH_GIF = "siege-clash.gif";

// ── Public contract ───────────────────────────────────────────────────────────

export interface SiegeResultView {
  title: string;
  description: string;
  color: number;
  fields?: { name: string; value: string; inline?: boolean }[];
}

export interface SiegeOutcome {
  attackerWon: boolean;
  /** Turns fought (a turn = one side acting, matching /battle's counter). */
  turns: number;
  attackerCardsLost: number;
  defenderCardsLost: number;
  attackerPower: number;
  defenderPower: number;
  /** 0–100. 100 = every defender broken. */
  destructionPct: number;
  /** 0–3, Clash-style. */
  stars: number;
}

export interface SiegeRuntimeConfig {
  guildId: string;
  /** Shared key that stops two assaults hitting one target at once. */
  targetKey?: string;
  starterId: string;            // only this user may command
  attackerName: string;
  targetName: string;
  /** Shown under the castle name — the faction or holder being fought. */
  holderName: string;
  accent: number;
  attackers: Combatant[];       // side 0, strongest first — the DEFAULT column
  /**
   * The whole roster the commander can march, strongest first (side 0). When
   * given, the muster board lets the player hand-pick which cards fill the
   * column instead of always taking the top `attackers.length`. The default
   * column is `attackers`; a chosen subset replaces it. Omit to lock the column.
   */
  attackerPool?: Combatant[];
  defenders: Combatant[];       // side 1, fortified, strongest first
  settings: BattleSettings;
  siege: HqSiegeConfig;
  /** The base/territory scene the castle frame is painted from. */
  baseView: HqBaseView | null;
  /** The attacker's champion, drawn storming the gate. */
  champion: HqRenderDefender | null;
  /** Commit the result (capture / reward / log) and return the result screen. */
  applyOutcome: (outcome: SiegeOutcome) => Promise<SiegeResultView>;
  /**
   * Skip the muster board and resolve the fight with the Siege AI on both sides.
   * Used when a guild's presentation mode is auto (cinematic / classic / …) so
   * EVERY attack still runs the NEW Siege Battle engine — never the legacy
   * gauntlet / power resolver as a parallel combat system.
   */
  autoResolve?: boolean;
}

type Phase = "muster" | "assault" | "ended";

interface SiegeSession extends SiegeRuntimeConfig {
  id: string;
  phase: Phase;
  /**
   * The live Siege Battle: four cards a side on the board, reserves behind
   * them, life points behind those, and a hand of Siege Battle Cards. This is
   * the single source of truth for the fight — the session only owns the
   * Discord surface around it.
   */
  battle: SiegeBattleState;
  /** Which of the commander's own squares is chosen to act (stage one). */
  actorSlot: number;
  /** Which enemy square that fighter is aimed at (stage one). */
  targetSlot: number | null;
  /**
   * True while the Card Clash cinematic is on screen after a resolved action.
   * Never a player-toggled "mode" — set internally for the beat, then cleared.
   */
  inClash: boolean;
  /** The Card Clash frame currently shown, kept between renders like the field. */
  clashFrame: Buffer | null;
  clashFrameIsGif: boolean;
  ai: number;                   // attacker cards destroyed (result bookkeeping)
  di: number;                   // defender cards destroyed (result bookkeeping)
  turnNumber: number;
  currentSide: 0 | 1;
  /** The commander's heads/tails call — call it right and your column strikes first. */
  coinCall: "heads" | "tails" | null;
  /** How many cards the column may hold (= the garrison's rank count). */
  columnSize: number;
  /**
   * When true the whole assault is auto-played by the AI with no board renders
   * or timers — the "send them in and tell me how it went" path. The commander
   * gets a DM with the result instead of driving the fight.
   */
  headless: boolean;
  log: string[];
  message?: Message;
  turnTimer?: NodeJS.Timeout;
  ttlTimer?: NodeJS.Timeout;
  processing: boolean;
  // Synchronous input latch: claimed the instant a commander input is accepted,
  // BEFORE the (awaited) interaction ack, so a burst of rapid clicks can't slip
  // multiple moves through the `processing` check while the first is still
  // awaiting deferUpdate. Released when the resulting turn fully resolves.
  inputPending: boolean;
  attackerPower: number;
  defenderPower: number;
  /** Cached castle frame; only re-rendered when the siege visibly changes. */
  castleImage: Buffer | null;
  castleKey: string;
  /** True while a castle frame is rendering in the background (non-blocking). */
  castleRendering: boolean;
  // The battlefield image currently shown under the board. It PERSISTS across
  // renders (it is not consumed) so wind-up / garrison beats can keep the last
  // strike on screen — matching /battle's resting VS image between turns.
  turnFrame: Buffer | null;
  turnFrameIsGif: boolean;
  /** Item equipped for the whole assault, chosen at muster. */
  equippedItemId: string | null;
  /** Ranks fully broken, for the destruction meter. */
  defendersBroken: number;
  /** Commander turns the CURRENT rank has survived — drives siege pressure. */
  rankStall: number;
  /**
   * High-water destruction. A defender that heals (regen, defend, a support
   * item) would otherwise walk the meter BACKWARDS, which no siege scoreboard
   * should ever do — ground taken stays taken.
   */
  peakDestruction: number;
  /**
   * Locked for the whole fight from guild battle settings — either the entire
   * presentation is LIVE (GIF) or STATIC (PNG). Never mixed mid-siege.
   */
  liveVisuals: boolean;
  /** Discord message.edit count — rollover to a fresh message before soft limits. */
  editCount: number;
}

const sessions = new Map<string, SiegeSession>();
const activeTargetKeys = new Set<string>();

// ── Replay (auto/skip only) ───────────────────────────────────────────────────
// A player who chose Auto Skip Mode didn't watch the fight, so the clean result
// keeps a "View Replay" button that reveals the blow-by-blow. The session is
// gone by then, so the recap is stashed here under a short-lived id.
interface SiegeReplay { title: string; scoreLine: string; log: string[]; accent: number; targetName: string; }
const replays = new Map<string, SiegeReplay>();
const REPLAY_TTL_MS = 15 * 60 * 1000; // a replay stays viewable for 15 minutes
// A deliberate beat so the result reads as its own screen, not just the last
// combat frame flicking to text.
const RESULT_HOLD_MS = 1300;

/** True while any interactive siege is occupying this base or territory. */
export function isSiegeTargetActive(targetKey: string): boolean {
  return activeTargetKeys.has(targetKey);
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
// Per-frame pacing — a no-op in a headless (send-them-in) siege so it resolves
// instantly instead of playing every beat out.
const pace = (s: SiegeSession) => s.headless ? Promise.resolve() : sleep(frameMs(s));

// Animation pacing follows the guild's battle settings, so a siege moves at the
// same speed as a battle in that server.
function frameMs(s: SiegeSession): number {
  return Math.max(120, Math.min(4000, s.settings.frameDelayMs ?? DEFAULT_FRAME_MS));
}
/**
 * LIVE vs STATIC — locked on the session for the whole fight (same convention
 * as /battle arena scenes). Never mix GIF and PNG mid-siege.
 */
function sceneAnimated(s: SiegeSession): boolean {
  return s.liveVisuals;
}
function resolveLiveVisuals(settings: BattleSettings, siege: HqSiegeConfig): boolean {
  return !!(siege.turnVisuals && settings.battleAnimationEnabled && settings.battleSceneAnimated);
}

// ── Destruction & stars ───────────────────────────────────────────────────────
// Progress is measured in wrecked garrison, not raw HP: each defender is an
// equal slice of the base, and the one currently being fought contributes its
// own missing-HP fraction. That makes the meter move on every good hit while
// still making a broken rank feel like a milestone.
function destructionPct(s: SiegeSession): number {
  // Progress is how far the garrison's life points have been driven down —
  // ground taken. It is high-water (a heal never walks the meter backwards), and
  // the whole garrison line contributes: breaking cards is the means, LP is the
  // score, so a fight that has cracked the wall but not yet reached LP still
  // reads real progress from the cards destroyed.
  const garrison = s.battle.teams[1];
  const lpFrac = garrison.lpMax > 0 ? 1 - garrison.lp / garrison.lpMax : 1;
  const cardsFrac = destroyedCount(s, 1) / Math.max(1, s.defenders.length);
  const now = Math.max(0, Math.min(100, Math.max(lpFrac, cardsFrac * 0.6) * 100));
  s.peakDestruction = Math.max(s.peakDestruction, now);
  return s.peakDestruction;
}

/**
 * A commander's life points, derived from the army standing in front of them.
 * A bigger, tougher roster defends a proportionally bigger life pool, so LP
 * stays meaningful across a scrappy four-card raid and a full mythic column
 * without needing its own admin setting (or a schema migration) to tune.
 */
function commanderLp(roster: Combatant[]): number {
  const pool = roster.reduce((sum, c) => sum + c.stats.maxHealth, 0);
  return Math.max(3000, Math.min(12000, Math.round((pool * 0.4) / 100) * 100));
}

// ★ at half the base wrecked, ★★ for taking it, ★★★ for taking it clean.
function starsFor(pct: number, captured: boolean, cardsLost: number): number {
  if (captured) return cardsLost === 0 ? 3 : 2;
  return pct >= 50 ? 1 : 0;
}

// ── Entry ─────────────────────────────────────────────────────────────────────

/**
 * Open the muster board into an already-deferred interaction. The caller has
 * built and fortified both squads; nothing is committed until the assault ends.
 */
export async function startSiege(
  interaction: ButtonInteraction, config: SiegeRuntimeConfig,
): Promise<void> {
  const fail = (msg: string) => interaction.editReply({
    embeds: [new EmbedBuilder().setColor(0xc0392b).setDescription(`❌ ${msg}`)],
    components: [], files: [],
  }).then(() => {}).catch(() => {});

  if (config.attackers.length === 0 || config.defenders.length === 0) {
    await fail("A siege needs cards on both sides."); return;
  }
  if (config.targetKey && activeTargetKeys.has(config.targetKey)) {
    await fail("That target is already under siege. Wait for the current assault to resolve."); return;
  }
  if (config.targetKey) activeTargetKeys.add(config.targetKey);
  await loadGuildBattleItems(config.guildId).catch(() => {});

  // The squad builders are shared with the HEADLESS resolver, which drives both
  // sides with the AI and therefore marks every combatant `isAi`. In here side 0
  // is a person: claim it, or `startTurn` would auto-play the commander's turns
  // and the player would never get a button. Also point the combatant at the
  // real user so the battle embed mentions them instead of rendering "🤖 AI".
  for (const c of config.attackers) {
    c.isAi = false;
    c.userId = config.starterId;
    c.displayName = config.attackerName;
  }
  for (const c of config.defenders) {
    c.isAi = true;
    c.aiDifficulty = SIEGE_AI;
  }
  // The pool is a marching roster the player may re-order into a column; it must
  // obey the same side-0 / non-AI ownership as the active column.
  for (const c of config.attackerPool ?? []) {
    c.isAi = false;
    c.userId = config.starterId;
    c.displayName = config.attackerName;
    c.side = 0;
  }

  const session: SiegeSession = {
    ...config,
    id: randomBytes(4).toString("hex"),
    phase: "muster",
    battle: buildSiegeBattle({
      attacker: {
        side: 0, name: config.attackerName, userId: config.starterId, isAi: false,
        roster: toSiegeRoster(config.attackers), lp: commanderLp(config.attackers),
        itemUses: config.siege.itemUses,
      },
      defender: {
        side: 1, name: config.holderName || config.targetName, userId: "AI", isAi: true,
        roster: toSiegeRoster(config.defenders), lp: commanderLp(config.defenders),
        itemUses: config.siege.itemUses,
      },
      settings: config.settings,
      // The guild's turn cap still applies, but never below what an army of this
      // size actually needs to reach a decision — life points only become
      // reachable after every card on a side is destroyed, so a big roster
      // legitimately needs more turns than a small one.
      maxTurns: Math.max(
        config.siege.maxTurns,
        defaultMaxTurns(config.attackers.length, config.defenders.length),
      ),
    }),
    actorSlot: 0, targetSlot: null, inClash: false,
    clashFrame: null, clashFrameIsGif: false,
    ai: 0, di: 0, turnNumber: 1, currentSide: 0,
    coinCall: null,
    columnSize: config.attackers.length,
    headless: !!config.autoResolve,
    log: [],
    processing: false,
    inputPending: false,
    attackerPower: config.attackers.reduce((sum, c) => sum + powerRating(c.stats), 0),
    defenderPower: config.defenders.reduce((sum, c) => sum + powerRating(c.stats), 0),
    castleImage: null, castleKey: "", castleRendering: false,
    turnFrame: null, turnFrameIsGif: false,
    equippedItemId: null,
    defendersBroken: 0,
    rankStall: 0,
    peakDestruction: 0,
    liveVisuals: resolveLiveVisuals(config.settings, config.siege),
    editCount: 0,
  };
  sessions.set(session.id, session);
  session.ttlTimer = setTimeout(() => { void abandon(session); }, MAX_SIEGE_MS);

  // Auto-resolve path: no muster board — run the NEW Siege Battle headlessly and
  // surface only the result (optionally after a brief "deployed" notice).
  if (config.autoResolve) {
    const channel = interaction.channel;
    if (channel?.isSendable()) {
      session.message = await channel.send({
        embeds: [new EmbedBuilder().setColor(session.accent)
          .setTitle(`🏰 Siege Battle — ${session.targetName}`)
          .setDescription(`**${session.attackerName}** lays siege to **${session.targetName}**. Resolving the Siege Battle…`)],
        components: [],
      }).then((m) => m as Message).catch(() => undefined);
      if (session.message) {
        await interaction.editReply({
          embeds: [new EmbedBuilder().setColor(session.accent)
            .setTitle(`🏰 Assault on ${session.targetName}`)
            .setDescription("Your Siege Battle is resolving in this channel. ⬇️")],
          components: [], files: [],
        }).catch(() => {});
      }
    }
    if (!session.message) {
      session.message = await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(session.accent)
          .setTitle(`🏰 Siege Battle — ${session.targetName}`)
          .setDescription("Resolving…")],
        components: [], files: [],
      }).then((m) => m as Message).catch(() => undefined);
    }
    if (!session.message) { await release(session); return; }
    session.phase = "assault";
    const call = session.coinCall ?? (Math.random() < 0.5 ? "heads" : "tails");
    const flip: "heads" | "tails" = Math.random() < 0.5 ? "heads" : "tails";
    session.currentSide = call === flip ? 0 : 1;
    session.battle.activeSide = session.currentSide;
    pushLog(session, [`⚔️ **${session.attackerName}** lays siege to **${session.targetName}**.`]);
    await startTurn(session);
    return;
  }

  // The siege board MUST live on a real channel message (like /battle and
  // /raid), NOT the ephemeral /hq hub reply it was launched from.
  //
  // Why: the runtime renders every frame — the coin toss, each turn, the result
  // — with `message.edit()`, and many of those edits fire from BACKGROUND TIMERS
  // (the AI's answer, the coin animation, the turn clock) with no live
  // interaction to hand. `Message#edit()` routes through the channel endpoint,
  // which an ephemeral message has no route on — editing an ephemeral reply only
  // works through the interaction webhook token (`interaction.editReply`), and
  // even that expires 15 minutes in, short of a full 20-minute siege. On an
  // ephemeral board every render after muster silently no-ops, so the coin flip
  // never shows and the assault freezes on the muster screen. A public channel
  // message makes `message.edit()` work for the whole siege.
  const channel = interaction.channel;
  if (channel?.isSendable()) {
    session.message = await channel.send(await musterPayload(session))
      .then((m) => m as Message)
      .catch((err) => {
        logger.warn({ err, siege: session.id }, "siege board channel.send failed");
        return undefined;
      });
    // Retire the ephemeral hub board so the commander isn't left on a dead
    // briefing; the live Siege Battle is the channel message from here on.
    if (session.message) {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(session.accent)
          .setTitle(`🏰 Assault on ${session.targetName}`)
          .setDescription("Your Siege Battle is live in this channel. ⬇️")],
        components: [], files: [],
      }).catch(() => {});
    }
  }
  // Fallback: no sendable channel (rare — e.g. missing Send Messages perms).
  // Use the ephemeral reply so a board still appears; a long animated siege may
  // stop updating past the 15-minute token window, but short ones resolve.
  if (!session.message) {
    session.message = await interaction.editReply(await musterPayload(session))
      .then((m) => m as Message)
      .catch((err) => {
        logger.warn({ err, siege: session.id }, "siege muster message edit failed");
        return undefined;
      });
  }
  if (!session.message) { await release(session); return; }

  // Post first, render second. Castle/card art can take seconds to decode (or
  // fail at the remote image boundary); waiting for it before creating the
  // board made a valid siege look like the button had done nothing. The board
  // is visible immediately, then receives the rendered castle image.
  await refreshCastle(session);
  if (session.message && session.phase === "muster") {
    await session.message.edit(await musterPayload(session)).catch((err) => {
      logger.warn({ err, siege: session.id }, "siege muster image edit failed");
    });
  }
}

// ── Component routing (hq-hub:ls:<action>:<sid>[:extra]) ──────────────────────
// The `ls` namespace is kept from the previous engine so buttons already sitting
// in a channel keep routing here instead of falling through as unknown.
export async function handleSiegeComponent(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): Promise<void> {
  const parts = interaction.customId.split(":"); // hq-hub:ls:<action>:<sid>[:extra]
  const action = parts[2];
  // Replay is answered from the stashed recap, not a live session (which has
  // already ended by the time the button exists), so it routes first.
  if (action === "replay") return handleReplay(interaction as ButtonInteraction, parts[3] ?? "");
  const session = sessions.get(parts[3] ?? "");
  if (!session || session.phase === "ended") {
    await interaction.reply({ content: "⌛ This siege has ended.", ...EPHEMERAL }).catch(() => {});
    return;
  }
  if (interaction.user.id !== session.starterId) {
    await interaction.reply({ content: "Only the commander can direct this assault.", ...EPHEMERAL }).catch(() => {});
    return;
  }
  switch (action) {
    case "begin": return handleBegin(interaction as ButtonInteraction, session);
    case "skip": return handleSkip(interaction as ButtonInteraction, session);
    case "coin": return handleCoinCall(interaction as ButtonInteraction, session, parts[4] as "heads" | "tails");
    case "column": return handleColumnOpen(interaction as ButtonInteraction, session);
    case "columnsel": return handleColumnSelect(interaction as StringSelectMenuInteraction, session);
    case "equip": return handleEquipOpen(interaction as ButtonInteraction, session);
    case "equipsel": return handleEquipSelect(interaction as StringSelectMenuInteraction, session);
    case "move": return handleMove(interaction as ButtonInteraction, session, parts[4] as MoveType);
    case "tgt": return handleMoveTarget(interaction as StringSelectMenuInteraction, session, parts[4] as MoveType);
    case "fighter": return handleFighterOpen(interaction as ButtonInteraction, session);
    case "fightersel": return handleFighterSelect(interaction as StringSelectMenuInteraction, session);
    case "cards": return handleCardsOpen(interaction as ButtonInteraction, session);
    case "cardsel": return handleCardSelect(interaction as StringSelectMenuInteraction, session);
    case "cardtgt": return handleCardTarget(interaction as StringSelectMenuInteraction, session, parts[4] ?? "");
    case "lp": return handleDirectLp(interaction as ButtonInteraction, session);
    case "clash":
      // Legacy button id — Card Clash is no longer a player control. Ignore and
      // re-render the Siege Battle board so old messages don't soft-lock.
      await interaction.deferUpdate().catch(() => {});
      await render(session);
      return;
    case "item": return handleItemOpen(interaction as ButtonInteraction, session);
    case "itemsel": return handleItemSelect(interaction as StringSelectMenuInteraction, session);
    case "itemtgt": return handleItemTarget(interaction as StringSelectMenuInteraction, session, parts[4]!);
    case "moves": return handleMovesQuickView(interaction as ButtonInteraction, session);
    case "more": return handleMoreOpen(interaction as ButtonInteraction, session);
    case "moresel": return handleMoreSelect(interaction as StringSelectMenuInteraction, session);
    case "concede": return handleConcede(interaction as ButtonInteraction, session);
    default:
      await interaction.reply({ content: "Unknown siege action.", ...EPHEMERAL }).catch(() => {});
  }
}

// ── Muster ────────────────────────────────────────────────────────────────────
// The pre-assault board: your column, the garrison, the fortification you're up
// against, and the one item you can carry in. The siege equivalent of /battle's
// prep screen — nothing is committed until Begin Assault.

async function musterPayload(s: SiegeSession) {
  const item = s.equippedItemId ? getBattleItem(s.equippedItemId, s.guildId) : null;
  const embed = new EmbedBuilder()
    .setColor(s.accent)
    .setTitle(`🏰 Muster — Siege Battle on ${s.targetName}`)
    .setDescription(
      `**${s.attackerName}** forms up outside **${s.targetName}**, held by **${s.holderName}**.\n\n` +
      `This opens the **Siege Battle** — Draw Phase, Main Phase, formation combat, and Siege Battle Cards. ` +
      `Four cards form the front line; reserves deploy when the line breaks. ` +
      `Drain the commander's **life points** to take the base.\n\n` +
      `🪙 **Call the toss** — guess right and you strike first. ` +
      `⚔️ **Begin Siege** to command every turn, or ⏩ **Auto Skip** to let captains resolve it.`,
    )
    .addFields(
      {
        name: `⚔️ Your army (${s.attackers.length})`,
        value: squadList(s.attackers),
        inline: true,
      },
      {
        name: `🛡️ Garrison (${s.defenders.length})`,
        value: squadList(s.defenders),
        inline: true,
      },
      {
        name: "📊 Strength",
        value: `⚔️ **${s.attackerPower}** vs 🛡️ **${s.defenderPower}**`,
        inline: false,
      },
      {
        name: "🪙 Coin call",
        value: s.coinCall
          ? `You called **${s.coinCall === "heads" ? "Heads" : "Tails"}** — win the toss and you strike first.`
          : "_Not called — the toss will be left to chance._",
        inline: false,
      },
      {
        name: "🎒 Supplies",
        value: item
          ? `${item.emoji} **${item.name}** — ${item.description}\n_Available to your whole formation._`
          : "_No item equipped._",
        inline: false,
      },
    )
    .setFooter({ text: `${s.battle.teams[0].itemUsesLeft} field use${s.battle.teams[0].itemUsesLeft === 1 ? "" : "s"} · ${s.siege.turnSeconds}s per move once the siege starts` });
  if (s.castleImage) embed.setImage(`attachment://${SIEGE_CASTLE_IMAGE}`);

  const canPick = (s.attackerPool?.length ?? 0) > s.columnSize;
  const coinBtn = (call: "heads" | "tails", label: string, emoji: string) =>
    new ButtonBuilder().setCustomId(`hq-hub:ls:coin:${s.id}:${call}`).setLabel(label).setEmoji(emoji)
      .setStyle(s.coinCall === call ? ButtonStyle.Primary : ButtonStyle.Secondary);
  const rows: ActionRowBuilder<ButtonBuilder>[] = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`hq-hub:ls:begin:${s.id}`).setLabel("Begin Siege").setEmoji("⚔️").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`hq-hub:ls:skip:${s.id}`).setLabel("Auto Skip").setEmoji("⏩").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`hq-hub:ls:concede:${s.id}`).setLabel("Stand down").setEmoji("🏳️").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      coinBtn("heads", "Heads", "🪙"),
      coinBtn("tails", "Tails", "🌙"),
      ...(canPick
        ? [new ButtonBuilder().setCustomId(`hq-hub:ls:column:${s.id}`).setLabel("Choose team").setEmoji("🎴").setStyle(ButtonStyle.Secondary)]
        : []),
      new ButtonBuilder().setCustomId(`hq-hub:ls:equip:${s.id}`).setLabel(item ? "Change item" : "Equip item").setEmoji("🎒").setStyle(ButtonStyle.Secondary),
    ),
  ];
  return { embeds: [embed], components: rows, files: castleFiles(s) };
}

function squadList(cards: Combatant[]): string {
  return cards.slice(0, 6).map((c, i) =>
    `${i === 0 ? "**1.**" : `${i + 1}.`} ${c.cardName} · ❤️ ${c.stats.maxHealth} · ⚔️ ${c.stats.attack}`,
  ).join("\n").slice(0, 1024) || "_none_";
}

async function handleEquipOpen(interaction: ButtonInteraction, s: SiegeSession): Promise<void> {
  if (s.phase !== "muster") { await interaction.reply({ content: "The assault has already begun.", ...EPHEMERAL }).catch(() => {}); return; }
  const items = listBattleItems(s.guildId).slice(0, 24);
  if (items.length === 0) { await interaction.reply({ content: "No battle items are configured here.", ...EPHEMERAL }).catch(() => {}); return; }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`hq-hub:ls:equipsel:${s.id}`)
    .setPlaceholder("Pick the item your column carries")
    .addOptions([
      { label: "No item", value: "none", description: "Travel light", emoji: "🚫" },
      ...items.map(it => ({
        label: it.name.slice(0, 100), value: it.id,
        description: it.description.slice(0, 100), emoji: it.emoji || undefined,
      })),
    ]);
  await interaction.reply({
    content: "🎒 Every card in your column carries the same item into the siege.",
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)], ...EPHEMERAL,
  }).catch(() => {});
}

async function handleEquipSelect(interaction: StringSelectMenuInteraction, s: SiegeSession): Promise<void> {
  const choice = interaction.values[0]!;
  const item = choice === "none" ? null : getBattleItem(choice, s.guildId);
  s.equippedItemId = item?.id ?? null;
  // Mirror /battle: the item lives ON the combatant, so the item move
  // and the move buttons pick it up with no siege-specific plumbing.
  for (const c of s.attackers) {
    c.itemId = item?.id ?? null;
    c.item = item ?? null;
    c.itemChargesRemaining = item?.charges ?? 0;
    c.itemCooldownRemaining = 0;
  }
  await interaction.update({
    content: item ? `${item.emoji} Your column will carry **${item.name}**.` : "Travelling light.",
    components: [],
  }).catch(() => {});
  if (s.message) await s.message.edit(await musterPayload(s)).catch(() => {});
}

// ── Coin call ─────────────────────────────────────────────────────────────────
async function handleCoinCall(interaction: ButtonInteraction, s: SiegeSession, call: "heads" | "tails"): Promise<void> {
  if (s.phase !== "muster") { await interaction.deferUpdate().catch(() => {}); return; }
  // Tapping the current call clears it (back to chance).
  s.coinCall = s.coinCall === call ? null : call;
  await interaction.update(await musterPayload(s)).catch(() => {});
}

// ── Column selection ──────────────────────────────────────────────────────────
// The player picks which of their cards march, and in what order, up to the
// garrison's rank count. Reuses the already-built pool combatants — nothing is
// committed until Begin Assault / Send them in.
async function handleColumnOpen(interaction: ButtonInteraction, s: SiegeSession): Promise<void> {
  if (s.phase !== "muster") { await interaction.reply({ content: "The assault has already begun.", ...EPHEMERAL }).catch(() => {}); return; }
  const pool = s.attackerPool ?? [];
  if (pool.length === 0) { await interaction.reply({ content: "Your whole roster is already committed.", ...EPHEMERAL }).catch(() => {}); return; }
  const chosen = new Set(s.attackers.map(c => c.cardId));
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`hq-hub:ls:columnsel:${s.id}`)
    .setPlaceholder(`Pick up to ${s.columnSize} card${s.columnSize === 1 ? "" : "s"} for the column`)
    .setMinValues(1)
    .setMaxValues(Math.min(s.columnSize, pool.length, 25))
    .addOptions(pool.slice(0, 25).map(c => ({
      label: c.cardName.slice(0, 100),
      description: `❤️ ${c.stats.maxHealth} · ⚔️ ${c.stats.attack} · 🛡️ ${c.stats.defense}`.slice(0, 100),
      value: String(c.cardId),
      default: chosen.has(c.cardId),
    })));
  await interaction.reply({
    content: `🎴 **Pick your team** — the order you pick is the order they fight. You may bring up to **${s.columnSize}** (one per garrison rank).`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)], ...EPHEMERAL,
  }).catch(() => {});
}

async function handleColumnSelect(interaction: StringSelectMenuInteraction, s: SiegeSession): Promise<void> {
  if (s.phase !== "muster") { await interaction.update({ content: "The assault has already begun.", components: [] }).catch(() => {}); return; }
  const pool = s.attackerPool ?? [];
  // Respect the click order so the player controls the charge order.
  const picked = interaction.values
    .map(id => pool.find(c => c.cardId === Number(id)))
    .filter((c): c is Combatant => !!c)
    .slice(0, s.columnSize);
  if (picked.length === 0) { await interaction.update({ content: "Pick at least one card.", components: [] }).catch(() => {}); return; }
  s.attackers = picked;
  // The equipped item lives on each combatant — carry it onto the new column.
  const item = s.equippedItemId ? getBattleItem(s.equippedItemId, s.guildId) : null;
  for (const c of s.attackers) {
    c.itemId = item?.id ?? null;
    c.item = item ?? null;
    c.itemChargesRemaining = item?.charges ?? 0;
    c.itemCooldownRemaining = 0;
  }
  s.attackerPower = s.attackers.reduce((sum, c) => sum + powerRating(c.stats), 0);
  rebuildBattle(s);
  await interaction.update({
    content: `🎴 Team set: ${picked.map(c => `**${c.cardName}**`).join(" → ")}.`,
    components: [],
  }).catch(() => {});
  if (s.message) await s.message.edit(await musterPayload(s)).catch(() => {});
}

/**
 * Rebuild the live battle from the session's current rosters. Called when the
 * commander re-picks their column at muster (nothing is committed until Begin),
 * so the board they fight on matches the team they chose.
 */
function rebuildBattle(s: SiegeSession): void {
  s.battle = buildSiegeBattle({
    attacker: {
      side: 0, name: s.attackerName, userId: s.starterId, isAi: false,
      roster: toSiegeRoster(s.attackers), lp: commanderLp(s.attackers),
      itemUses: s.siege.itemUses,
    },
    defender: {
      side: 1, name: s.holderName || s.targetName, userId: "AI", isAi: true,
      roster: toSiegeRoster(s.defenders), lp: commanderLp(s.defenders),
      itemUses: s.siege.itemUses,
    },
    settings: s.settings,
    maxTurns: Math.max(s.siege.maxTurns, defaultMaxTurns(s.attackers.length, s.defenders.length)),
  });
  s.actorSlot = 0; s.targetSlot = null;
}

// ── Send them in (skip / auto-resolve) ────────────────────────────────────────
// "Sending soldiers off": the captains auto-play the whole siege at speed with no
// board or timers, then the commander is DM'd the result. Reuses the exact same
// engine, break-rank and finish/commit path as a hand-driven assault.
async function handleSkip(interaction: ButtonInteraction, s: SiegeSession): Promise<void> {
  if (s.phase !== "muster") { await interaction.deferUpdate().catch(() => {}); return; }
  await interaction.deferUpdate().catch(() => {});
  s.headless = true;
  s.phase = "assault";
  // Coin toss still decides initiative, silently.
  const call = s.coinCall ?? (Math.random() < 0.5 ? "heads" : "tails");
  const flip: "heads" | "tails" = Math.random() < 0.5 ? "heads" : "tails";
  s.currentSide = call === flip ? 0 : 1;
  s.battle.activeSide = s.currentSide;
  pushLog(s, [`📨 **${s.attackerName}** sends the column at **${s.targetName}** and awaits word from the field.`]);
  // Let the muster message acknowledge the send-off while the fight resolves.
  if (s.message) {
    await s.message.edit({
      embeds: [new EmbedBuilder().setColor(s.accent).setTitle("📨 Column deployed")
        .setDescription(`Your captains are fighting the Siege Battle at **${s.targetName}**. You'll be pinged the moment it's decided.`)],
      components: [], files: [],
    }).catch(() => {});
  }
  await startTurn(s);
}

async function handleBegin(interaction: ButtonInteraction, s: SiegeSession): Promise<void> {
  if (s.phase !== "muster") { await interaction.deferUpdate().catch(() => {}); return; }
  await interaction.deferUpdate().catch(() => {});
  s.phase = "assault";
  // ── Coin toss → who strikes first ──────────────────────────────────────────
  // The SAME heads/tails flow as /battle: the toss is random, and calling it
  // right earns the initiative. No call left it to chance.
  const firstSide = await playCoinToss(s);
  s.currentSide = firstSide;
  s.battle.activeSide = firstSide;   // the engine and the board share one turn owner
  const lead = s.battle.teams[0].slots.find(sl => sl.unit)?.unit;
  const garrison = s.battle.teams[1].slots.find(sl => sl.unit)?.unit;
  pushLog(s, [
    `⚔️ **${s.attackerName}** opens the Siege Battle at **${s.targetName}**.`,
    firstSide === 0 ? "🎯 Your column seizes the initiative — you move first." : "🛡️ The garrison reacts first.",
    lead && garrison ? `🔹 **${lead.cardName}** meets **${garrison.cardName}** on the front line.` : "",
  ]);
  // Start the assault IMMEDIATELY — do not wait on a castle render here (that
  // 8s stack after the coin toss is exactly what made the fight look frozen).
  // The board paints with the muster's castle frame and refreshes in the
  // background.
  scheduleCastleRefresh(s, true);
  await startTurn(s);
}

// Play the heads/tails toss and return who moves first. Reuses /battle's coin
// GIF; a correct call gives the commander (side 0) the opening move.
async function playCoinToss(s: SiegeSession): Promise<0 | 1> {
  const flip: "heads" | "tails" = Math.random() < 0.5 ? "heads" : "tails";
  const call = s.coinCall ?? (Math.random() < 0.5 ? "heads" : "tails");
  const firstSide: 0 | 1 = call === flip ? 0 : 1;
  if (!s.message) return firstSide;
  // LIVE presentation may play the coin GIF; STATIC stays text-only so the
  // whole fight never mixes GIF + still styles.
  if (sceneAnimated(s)) {
    const anim = await Promise.race([
      renderCoinFlip(flip).catch(() => null),
      sleep(12_000).then(() => null),
    ]);
    if (anim) {
      const coinEmbed = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle("🪙 Coin toss…")
        .setDescription(s.coinCall ? `You called **${s.coinCall === "heads" ? "Heads" : "Tails"}**.` : "_No call — leaving it to fate._")
        .setImage("attachment://coin.gif");
      await s.message.edit({
        content: null, embeds: [coinEmbed],
        files: [new AttachmentBuilder(Buffer.from(anim.buffer), { name: "coin.gif" })], components: [],
      }).catch((err) => {
        logger.warn({ err, siege: s.id }, "siege coin animation edit failed");
      });
      s.editCount++;
      await sleep(Math.max(1500, anim.durationMs));
    }
  }
  const landed = flip === "heads" ? "Heads 🪙" : "Tails 🌙";
  const resultEmbed = new EmbedBuilder()
    .setColor(firstSide === 0 ? 0x4fd06a : s.accent)
    .setTitle(`🪙 ${landed}`)
    .setDescription(firstSide === 0
      ? `You **won the toss** — your column moves first.`
      : `The toss goes to the defenders — the garrison moves first.`);
  await s.message.edit({ content: null, embeds: [resultEmbed], files: [], components: [] }).catch((err) => {
    logger.warn({ err, siege: s.id }, "siege coin result edit failed");
  });
  s.editCount++;
  await sleep(sceneAnimated(s) ? 1300 : 800);
  return firstSide;
}

// ── Turn loop (mirrors battle-manager) ───────────────────────────────────────

// ── The turn loop ────────────────────────────────────────────────────────────
// One turn = one side acting. The ENGINE owns the rules (startTurn ticks status
// and refills the hand, resolveAction applies exactly one action, endTurn
// deploys reinforcements, exposes life points and decides a winner). This layer
// owns only the Discord surface: whose buttons are live, the clock, and the
// frames.

async function startTurn(s: SiegeSession): Promise<void> {
  if (s.phase !== "assault") return;

  // Status ticks, energy regen, card cooldowns and the hand refill (DRAW → MAIN).
  const opening = engineStartTurn(s.battle);
  pushLog(s, opening.events.map(e => e.text));

  const side = s.battle.activeSide;
  const team = s.battle.teams[side];

  // A side with nothing standing cannot act; hand straight over so the other
  // side gets its swing (endTurn is what deploys reserves / exposes LP).
  if (livingSlots(team).length === 0) {
    await advanceTurn(s);
    return;
  }

  // Default the commander's selection to a card that can actually act.
  if (side === 0) {
    const living = livingSlots(team).map(sl => sl.index);
    if (!living.includes(s.actorSlot)) s.actorSlot = living[0] ?? 0;
    const foes = s.battle.teams[1];
    const foeLiving = livingSlots(foes).map(sl => sl.index);
    if (s.targetSlot == null || !foeLiving.includes(s.targetSlot)) {
      s.targetSlot = foeLiving[0] ?? null;
    }
  }

  // Present DRAW while engine is still in DRAW (no combat buttons), then open MAIN.
  if (!s.headless) {
    await presentPhase(s, "draw", {
      moveName: "Draw Phase",
      drawnCards: (opening.drawnCards ?? []).map(c => ({ name: c.name, emoji: c.emoji })),
    });
    await pace(s);
  }
  const mainBeat = engineEnterMain(s.battle);
  pushLog(s, mainBeat.events.map(e => e.text));
  if (!s.headless) {
    await presentPhase(s, "main", {
      moveName: s.battle.activeSide === 0 ? "Your move" : "Enemy turn",
    });
  } else {
    await refreshRestingFrame(s);
  }

  // The garrison — and, in a headless send-off, BOTH sides — answer on their own.
  if (team.isAi || s.headless) {
    if (s.headless) await render(s);
    await pace(s);
    const action = chooseSiegeAction(s.battle, SIEGE_AI_SKILL);
    await applySiegeAction(s, action);
    return;
  }

  clearTurnTimer(s);
  const ms = s.siege.turnSeconds * 1000;
  s.turnTimer = setTimeout(() => {
    pushLog(s, ["⏱️ The commander hesitated — the line presses on regardless."]);
    void applySiegeAction(s, autoAction(s));
  }, ms);
  await render(s, { turnEndsAt: Date.now() + ms });
}

/** What a commander who ran out the clock does: the best legal swing available. */
function autoAction(s: SiegeSession): SiegeAction | null {
  const basic: SiegeAction = {
    kind: "move", actorSlot: s.actorSlot, move: "attack",
    targetSlot: s.targetSlot ?? undefined,
  };
  if (checkAction(s.battle, basic).ok) return basic;
  return chooseSiegeAction(s.battle, "normal");
}

/**
 * Resolve exactly one action and play the beat: wind-up frame, the resolved
 * blow (with an automatic Card Clash cinematic when appropriate), then hand
 * over. A null action (nothing legal) simply passes the turn.
 */
async function applySiegeAction(s: SiegeSession, action: SiegeAction | null): Promise<void> {
  if (s.phase !== "assault" || s.processing) return;
  s.processing = true;
  clearTurnTimer(s);
  try {
    if (!action) { await advanceTurn(s); return; }
    const side = s.battle.activeSide;

    // Wind-up: the board shows what is about to happen while the frame encodes.
    await render(s, { currentMove: `${describeAction(s.battle, action)}…` });

    const result = resolveAction(s.battle, action);
    pushLog(s, result.events.map(e => e.text));

    // Rejected (illegal) action: nothing changed, so DON'T advance the turn.
    // Re-render so the reason shows and the controls come back live, and re-arm
    // the turn clock for a human commander.
    if (result.rejected) {
      s.processing = false;
      if (!s.headless && s.battle.activeSide === 0) {
        clearTurnTimer(s);
        const ms = s.siege.turnSeconds * 1000;
        s.turnTimer = setTimeout(() => {
          pushLog(s, ["⏱️ The commander hesitated — the line presses on regardless."]);
          void applySiegeAction(s, autoAction(s));
        }, ms);
        await render(s, { turnEndsAt: Date.now() + ms });
      } else {
        await render(s);
      }
      return;
    }

    s.di = destroyedCount(s, 1);
    s.ai = destroyedCount(s, 0);

    const playClash = !s.headless && shouldPlayClashCinematic(action, result);

    // Await the FINAL frame before editing the board — never upgrade a still to
    // a GIF mid-message, which restarts Discord's looping and reads as a stutter.
    const [, holdMs] = await Promise.all([
      pace(s),
      buildTurnFrames(s, side, action, result, playClash),
    ]);
    await refreshCastle(s, result.destroyed.length > 0);

    // Card Clash is an INTERNAL cinematic: show it briefly when the beat warrants
    // it, then return to the Siege Battle field. The player never clicks "Card Clash".
    if (playClash && s.clashFrame) {
      s.inClash = true;
      await render(s);
      await sleep(Math.max(frameMs(s), Math.min(holdMs || 1800, 2800)));
      s.inClash = false;
    }

    await render(s);
    if (!playClash) {
      await (s.headless ? Promise.resolve() : sleep(Math.max(frameMs(s), holdMs)));
    } else if (!s.headless) {
      // Brief settle on the field after the cinematic.
      await sleep(Math.max(400, Math.floor(frameMs(s) * 0.6)));
    }

    await advanceTurn(s);
  } catch (err) {
    logger.error({ err, siege: s.id }, "siege action failed");
    s.processing = false;
  }
}

/** Attack screen (Card Clash) — plays for combat actions like /battle turn GIFs. */
function shouldPlayClashCinematic(action: SiegeAction, result: SiegeTurnResult): boolean {
  if (result.destroyed.length > 0) return true;
  if (result.events.some(e => e.ko || e.event === "ko")) return true;
  if (result.damageDealt > 0 || result.lpDamage > 0) return true;
  if (action.kind === "siege_card") return true;
  if (action.kind === "direct_lp") return true;
  if (action.kind === "item") return true;
  if (action.kind === "move") {
    // Offensive / decisive moves get the attack screen; charge/defend stay on field.
    return action.move === "attack" || action.move === "special" || action.move === "ultimate";
  }
  return false;
}

/** Close the turn through the engine, then either finish or start the next one. */
async function advanceTurn(s: SiegeSession): Promise<void> {
  const closing = engineEndTurn(s.battle);
  pushLog(s, closing.events.map(e => e.text));
  s.di = destroyedCount(s, 1);
  s.ai = destroyedCount(s, 0);
  s.turnNumber = s.battle.turn;
  s.currentSide = s.battle.activeSide;

  const reinforced = closing.events.some(e => e.event === "deploy" || e.event === "wipe");
  if (!s.headless && reinforced && !closing.battleOver) {
    // Brief REINFORCE beat — presentation overlay only; engine phase unchanged.
    await presentPhase(s, "reinforce", { moveName: "Reinforcements!" });
    await pace(s);
  }

  if (closing.battleOver || s.battle.phase === "ended") {
    if (!s.headless) {
      await presentPhase(s, "end", {
        moveName: s.battle.winner === 0 ? `${s.attackerName} wins!` : `${s.targetName} holds!`,
      });
      await pace(s);
    }
    await finish(s);
    return;
  }
  s.processing = false;
  await startTurn(s);
}

/**
 * Present a phase beat on the Siege field. LIVE = GIF (when enabled for the
 * whole fight); STATIC = crisp PNG. Never mixes mid-siege.
 */
async function presentPhase(
  s: SiegeSession,
  phase: "draw" | "main" | "battle" | "reinforce" | "end",
  opts?: { moveName?: string; drawnCards?: { name: string; emoji: string }[] },
): Promise<void> {
  if (!s.siege.turnVisuals) {
    await render(s, { currentMove: opts?.moveName });
    return;
  }
  const input = toFieldInput(s.battle, {
    actingSide: s.battle.activeSide,
    actorSlot: s.actorSlot,
    targetSlot: s.targetSlot ?? undefined,
    moveName: opts?.moveName ?? "",
    damage: 0, isHit: false, isCrit: false, ko: false,
    accent: s.accent,
    backdropKey: fieldBackdropKey(s),
    floorKey: fieldFloorKey(s),
    phase,
    drawnCards: opts?.drawnCards,
  });
  const phaseSpeed: AnimationSpeed = "fast";
  // Phase beats always encode at "fast" in LIVE mode — snappy transitions, lower
  // encode cost. Combat beats (buildTurnFrames) still use the guild speed.
  if (sceneAnimated(s)) {
    const gif = await renderSiegeField(input, phaseSpeed).catch(() => null);
    if (gif) { s.turnFrame = gif.buffer; s.turnFrameIsGif = true; }
    else s.turnFrameIsGif = false;
  } else {
    s.turnFrameIsGif = false;
  }
  if (!s.turnFrameIsGif) {
    const png = await renderSiegeFieldStill(input).catch(() => null);
    if (png) { s.turnFrame = png; s.turnFrameIsGif = false; }
  }
  s.inClash = false;
  await render(s, { currentMove: opts?.moveName });
  if (sceneAnimated(s) && !s.headless) {
    await sleep(Math.min(frameMs(s) + 150, phase === "draw" ? 1000 : 750));
  }
}

/** How many of a side's cards have been destroyed, board and reserves alike. */
function destroyedCount(s: SiegeSession, side: 0 | 1): number {
  const team = s.battle.teams[side];
  const onBoard = team.slots.filter(sl => sl.unit && sl.unit.hp <= 0).length;
  const inReserve = team.reserves.filter(c => c.hp <= 0).length;
  // Cards that died in earlier waves have already left the board, so the waves
  // that were fully replaced are counted too.
  const replaced = Math.max(0, team.wavesLost * FORMATION_SIZE - onBoard - inReserve);
  return onBoard + inReserve + replaced;
}

// Pick a battlefield backdrop + floor deterministically from the target, so a
// given base always storms on the same ground across all its turns (and across
// player sieges, AI conquests and open territories alike — every mode routes
// through here).
const FIELD_BACKDROPS = ["castles", "forest", "desert", "fall", "grass"] as const;
const FIELD_FLOORS = ["stone", "marble", "dirt", "blue-stone", "cobblestone"] as const;
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
/** A given target always storms on the same ground, across every siege mode. */
function fieldBackdropKey(s: SiegeSession): string {
  return FIELD_BACKDROPS[hashStr(s.targetKey ?? s.targetName) % FIELD_BACKDROPS.length]!;
}
function fieldFloorKey(s: SiegeSession): string {
  return FIELD_FLOORS[hashStr(`${s.targetKey ?? s.targetName}:floor`) % FIELD_FLOORS.length]!;
}
/** Animation pacing follows the guild's battle settings, like /battle. */
function animationSpeed(s: SiegeSession): AnimationSpeed {
  return s.settings.battleAnimationSpeed as AnimationSpeed;
}

// ── Projections ──────────────────────────────────────────────────────────────
// The battlefield and the Card Clash screen are both drawn from BATTLE STATE via
// the siege adapter. Nothing here recomputes an outcome: the resolver already
// measured the damage, and these just choose which beat to show.

/** Everything both screens need about the beat that just resolved. */
function projectionFor(
  s: SiegeSession, side: 0 | 1, action: SiegeAction, result: SiegeTurnResult,
) {
  const sum = summariseResult(result, engineOtherSide(side));
  const actorSlot = action.kind === "reinforce" ? 0 : action.actorSlot;
  const targetSlot = sum.struckSlot
    ?? (action.kind === "move" || action.kind === "siege_card" ? action.targetSlot : undefined)
    ?? undefined;
  return {
    actingSide: side,
    actorSlot,
    targetSlot,
    moveName: describeMove(s.battle, action),
    damage: sum.damage || sum.lpDamage,
    isHit: sum.isHit,
    isCrit: sum.isCrit,
    ko: sum.ko,
    aoe: sum.aoe,
    struckBefore: sum.struckBefore,
    accent: s.accent,
    backdropKey: fieldBackdropKey(s),
    floorKey: fieldFloorKey(s),
    arenaName: s.targetName,
    attackerCommanderRole: "Commander",
    defenderCommanderRole: s.holderName || "Garrison",
    playingCardId: action.kind === "siege_card" ? action.cardId : undefined,
  };
}

/** A resting battlefield frame — no strike, just the board as it stands. */
function restingFieldInput(s: SiegeSession): SiegeFieldInput {
  return toFieldInput(s.battle, {
    actingSide: s.battle.activeSide,
    actorSlot: s.actorSlot,
    targetSlot: s.targetSlot ?? undefined,
    moveName: "", damage: 0, isHit: false, isCrit: false, ko: false,
    accent: s.accent,
    backdropKey: fieldBackdropKey(s),
    floorKey: fieldFloorKey(s),
    phase: s.battle.phase === "draw" ? "draw"
      : s.battle.phase === "reinforce" ? "reinforce"
      : s.battle.phase === "ended" ? "end"
      : "main",
  });
}

/**
 * Render the beat. The formation battlefield always refreshes. When `playClash`
 * is set, the Card Clash cinematic is also encoded so the runtime can flash it
 * automatically — never as a player-toggled second battle mode.
 */
async function buildTurnFrames(
  s: SiegeSession, side: 0 | 1, action: SiegeAction, result: SiegeTurnResult,
  playClash = false,
): Promise<number> {
  if (!s.siege.turnVisuals) return 0;
  const proj = projectionFor(s, side, action, result);
  const speed = animationSpeed(s);
  let hold = 0;

  const fieldInput = toFieldInput(s.battle, { ...proj, phase: "battle" });
  if (sceneAnimated(s)) {
    const gif = await renderSiegeField(fieldInput, speed).catch(() => null);
    if (gif) { s.turnFrame = gif.buffer; s.turnFrameIsGif = true; hold = gif.durationMs; }
  }
  if (!s.turnFrameIsGif || !sceneAnimated(s)) {
    const png = await renderSiegeFieldStill(fieldInput).catch(() => null);
    if (png) { s.turnFrame = png; s.turnFrameIsGif = false; }
  }

  if (playClash) {
    const clashInput = toClashInput(s.battle, proj);
    if (clashInput) {
      if (sceneAnimated(s)) {
        const gif = await renderCardClash(clashInput, speed).catch(() => null);
        if (gif) { s.clashFrame = gif.buffer; s.clashFrameIsGif = true; hold = Math.max(hold, gif.durationMs); }
      }
      if (!s.clashFrameIsGif || !sceneAnimated(s)) {
        const png = await renderCardClashStill(clashInput).catch(() => null);
        if (png) { s.clashFrame = png; s.clashFrameIsGif = false; }
      }
    }
  }
  return hold;
}

/** A resting board render, used when a turn starts and nothing has happened yet. */
async function refreshRestingFrame(s: SiegeSession): Promise<void> {
  if (!s.siege.turnVisuals || s.headless) return;
  const png = await renderSiegeFieldStill(restingFieldInput(s)).catch(() => null);
  if (png) { s.turnFrame = png; s.turnFrameIsGif = false; }
}

async function handleItemOpen(interaction: ButtonInteraction, s: SiegeSession): Promise<void> {
  if (s.phase !== "assault") { await interaction.reply({ content: "The assault hasn't started.", ...EPHEMERAL }).catch(() => {}); return; }
  if (s.processing) { await interaction.reply({ content: "The exchange is resolving — hang on.", ...EPHEMERAL }).catch(() => {}); return; }
  if (s.battle.teams[0].itemUsesLeft <= 0) { await interaction.reply({ content: "🎒 Your supplies are spent.", ...EPHEMERAL }).catch(() => {}); return; }
  const items = listBattleItems(s.guildId).slice(0, 25);
  if (items.length === 0) { await interaction.reply({ content: "No usable items are configured.", ...EPHEMERAL }).catch(() => {}); return; }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`hq-hub:ls:itemsel:${s.id}`)
    .setPlaceholder("Call up a field item")
    .addOptions(items.map(it => ({
      label: it.name.slice(0, 100), description: it.description.slice(0, 100),
      emoji: it.emoji || undefined, value: it.id,
    })));
  await interaction.reply({
    content: `🎒 **Field supplies** — **${s.battle.teams[0].itemUsesLeft}** left. Support items reach any of your cards; offensive ones hit the enemy you've targeted.`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)], ...EPHEMERAL,
  }).catch(() => {});
}

async function handleItemSelect(interaction: StringSelectMenuInteraction, s: SiegeSession): Promise<void> {
  const item = getBattleItem(interaction.values[0], s.guildId);
  if (!item) { await interaction.update({ content: "That item is gone.", components: [] }).catch(() => {}); return; }
  if (isOffensiveItem(item)) { await commitItem(interaction, s, item.id, "def"); return; }

  // Support items reach any of the commander's own cards (heal can revive a
  // fallen one). Each option carries the board SLOT so the engine targets it.
  const canRevive = item.effectType === "heal";
  const team = s.battle.teams[0];
  const opts = team.slots
    .filter(sl => sl.unit && (canRevive || sl.unit.hp > 0))
    .map(sl => ({
      label: `${sl.index === s.actorSlot ? "★ " : ""}${sl.unit!.cardName}`.slice(0, 100),
      description: (sl.unit!.hp <= 0 ? "down — revive" : `${sl.unit!.hp}/${sl.unit!.stats.maxHealth} HP`).slice(0, 100),
      value: String(sl.index),
    }));
  if (opts.length === 0) { await interaction.update({ content: "No one in your formation can take that.", components: [] }).catch(() => {}); return; }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`hq-hub:ls:itemtgt:${s.id}:${item.id}`)
    .setPlaceholder(`Who gets the ${item.name}?`.slice(0, 100))
    .addOptions(opts.slice(0, 25));
  await interaction.update({
    content: `${item.emoji} **${item.name}** — ${item.description}\nChoose a card:`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  }).catch(() => {});
}

async function handleItemTarget(
  interaction: StringSelectMenuInteraction, s: SiegeSession, itemId: string,
): Promise<void> {
  await commitItem(interaction, s, itemId, interaction.values[0]!);
}

async function commitItem(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  s: SiegeSession, itemId: string, targetKey: string,
): Promise<void> {
  const item = getBattleItem(itemId, s.guildId);
  const actor = s.battle.teams[0].slots[s.actorSlot]?.unit;
  if (!item || !actor) { await interaction.update({ content: "That item can't be used now.", components: [] }).catch(() => {}); return; }
  if (!commanderCanAct(s) || s.battle.teams[0].itemUsesLeft <= 0) {
    await interaction.update({ content: "You can't use an item right now.", components: [] }).catch(() => {});
    return;
  }

  await interaction.update({ content: `${item.emoji} Called up **${item.name}**.`, components: [] }).catch(() => {});
  // Items are a normal action: the engine validates the target, spends the use
  // and hands the turn over, exactly like a move or a Siege Battle Card.
  await applySiegeAction(s, {
    kind: "item", actorSlot: s.actorSlot, itemId,
    targetSide: targetKey === "def" ? 1 : 0,
    targetSlot: targetKey === "def" ? (s.targetSlot ?? 0) : Number(targetKey),
  });
}

// ── Read-only reference (mirrors /battle's Moves popup) ──────────────────────
/** Compact overflow menu — Moves guide + Retreat stay available without crowding the board. */
async function handleMoreOpen(interaction: ButtonInteraction, s: SiegeSession): Promise<void> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`hq-hub:ls:moresel:${s.id}`)
    .setPlaceholder("More siege options…")
    .addOptions([
      { label: "Moves guide", value: "moves", emoji: "📖", description: "See what each move does" },
      { label: "Retreat", value: "concede", emoji: "🏳️", description: "End the siege and withdraw" },
    ]);
  await interaction.reply({
    content: "⋯ **More** — pick an option:",
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    ...EPHEMERAL,
  }).catch(() => {});
}

async function handleMoreSelect(interaction: StringSelectMenuInteraction, s: SiegeSession): Promise<void> {
  const choice = interaction.values[0];
  if (choice === "moves") {
    const actor = active(s, 0);
    if (!actor) {
      await interaction.update({ content: "No card is leading the column.", components: [] }).catch(() => {});
      return;
    }
    const ms = actor.movesetDef ?? getMoveset(actor.moveset);
    const item = actor.item ?? getBattleItem(actor.itemId, s.guildId);
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`📖 ${actor.cardName} — Move Set`)
      .setDescription("*Quick reference for this assault — only you can see this.*")
      .addFields(
        {
          name: "🔥 Special",
          value: ms ? `${ms.emoji} **${ms.name}** — ${ms.description}\n⚡ ${ms.energyCost} energy` : "_None assigned._",
        },
        {
          name: "🎒 Item",
          value: item ? `${item.emoji} **${item.name}** — ${item.description}` : "_No item equipped._",
        },
        {
          name: "🏰 Siege rules",
          value: "A KO breaks one rank — not the siege. Draw Phase fills your Siege Cards; Main Phase is when you act.",
        },
      );
    await interaction.update({ content: null, embeds: [embed], components: [] }).catch(() => {});
    return;
  }
  if (choice === "concede") {
    await interaction.update({ content: "🏳️ Sounding the retreat…", components: [] }).catch(() => {});
    if (s.phase === "muster") {
      pushLog(s, ["🏳️ The column stands down."]);
      if (s.message) {
        await s.message.edit({
          embeds: [new EmbedBuilder().setColor(0x9aa0a8).setTitle("🏳️ Stood down")
            .setDescription(`No assault was made on **${s.targetName}**.`)],
          components: [], files: [],
        }).catch(() => {});
      }
      await release(s);
      return;
    }
    s.battle.teams[0].lp = 0;
    s.battle.winner = 1;
    s.battle.phase = "ended";
    pushLog(s, ["🏳️ You sound the retreat."]);
    await finish(s);
    return;
  }
  await interaction.update({ content: "Unknown option.", components: [] }).catch(() => {});
}

// ── Read-only reference (mirrors /battle's Moves popup) ──────────────────────
async function handleMovesQuickView(interaction: ButtonInteraction, s: SiegeSession): Promise<void> {
  const actor = active(s, 0);
  if (!actor) { await interaction.reply({ content: "No card is leading the column.", ...EPHEMERAL }).catch(() => {}); return; }
  const ms = actor.movesetDef ?? getMoveset(actor.moveset);
  const item = actor.item ?? getBattleItem(actor.itemId, s.guildId);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📖 ${actor.cardName} — Move Set`)
    .setDescription("*Quick reference for this assault — only you can see this.*")
    .addFields(
      {
        name: "🔥 Special",
        value: ms ? `${ms.emoji} **${ms.name}** — ${ms.description}\n⚡ ${ms.energyCost} energy` : "_None assigned._",
        inline: false,
      },
      {
        name: "🎒 Item",
        value: item ? `${item.emoji} **${item.name}** — ${item.description}` : "_No item equipped._",
        inline: false,
      },
      {
        name: "🏰 Siege rules",
        value:
          "A knockout breaks **one rank**, it doesn't end the assault — the next card steps up on whichever " +
          "side lost one. Break the whole garrison to take the base.",
        inline: false,
      },
    );
  await interaction.reply({ embeds: [embed], ...EPHEMERAL }).catch(() => {});
}

// Offensive moves let the commander pick WHICH enemy card to strike ("this card
// attacks this card"). A charged Ultimate against 2+ ranks is the team wipe —
// the picked card is the FOCUS, the rest take splash.
function isTargetedMove(move: MoveType): boolean {
  return move === "attack" || move === "special" || move === "ultimate";
}

/**
 * Stage one → stage two. The commander presses a move; if more than one enemy
 * card is standing they pick a target first, then the action resolves and the
 * Card Clash plays out.
 */
async function handleMove(interaction: ButtonInteraction, s: SiegeSession, move: MoveType): Promise<void> {
  if (!commanderCanAct(s)) {
    await interaction.reply({ content: "It isn't your turn.", ...EPHEMERAL }).catch(() => {});
    return;
  }
  const foes = s.battle.teams[1];
  const living = livingSlots(foes);

  if (isTargetedMove(move) && living.length > 1) {
    const isUlt = move === "ultimate";
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`hq-hub:ls:tgt:${s.id}:${move}`)
      .setPlaceholder(isUlt ? "Focus the TEAM ULTIMATE on…" : "Strike which enemy card?")
      .addOptions(living.map(sl => ({
        label: `${sl.index === s.targetSlot ? "▶ " : ""}${sl.unit!.cardName}`.slice(0, 100),
        description: `${Math.max(0, sl.unit!.hp)}/${sl.unit!.stats.maxHealth} HP`.slice(0, 100),
        value: String(sl.index),
      })));
    await interaction.reply({
      content: isUlt
        ? "💀 **Team Ultimate** — your whole line blasts the enemy. Pick the card to **wipe** (the rest take splash):"
        : "🎯 **Choose your target** — strike any enemy card:",
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)], ...EPHEMERAL,
    }).catch(() => {});
    return;
  }

  s.inputPending = true;
  await interaction.deferUpdate().catch(() => {});
  const target = living[0]?.index ?? s.targetSlot ?? undefined;
  s.targetSlot = target ?? null;
  const p = applySiegeAction(s, { kind: "move", actorSlot: s.actorSlot, move, targetSlot: target });
  s.inputPending = false;
  await p;
}

/** The commander picked which enemy card to hit → resolve the move on it. */
async function handleMoveTarget(interaction: StringSelectMenuInteraction, s: SiegeSession, move: MoveType): Promise<void> {
  if (!commanderCanAct(s)) {
    await interaction.update({ content: "That moment has passed.", components: [] }).catch(() => {});
    return;
  }
  const targetSlot = Number(interaction.values[0]);
  const target = s.battle.teams[1].slots[targetSlot]?.unit;
  if (!target || target.hp <= 0) {
    await interaction.update({ content: "That card is already down — pick another.", components: [] }).catch(() => {});
    return;
  }
  s.targetSlot = targetSlot;
  await interaction.update({ content: `🎯 Locked on **${target.cardName}**.`, components: [] }).catch(() => {});
  await applySiegeAction(s, { kind: "move", actorSlot: s.actorSlot, move, targetSlot });
}

/** Choose WHICH of the commander's own four cards acts this turn. */
async function handleFighterOpen(interaction: ButtonInteraction, s: SiegeSession): Promise<void> {
  if (!commanderCanAct(s)) {
    await interaction.reply({ content: "It isn't your turn.", ...EPHEMERAL }).catch(() => {});
    return;
  }
  const team = s.battle.teams[0];
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`hq-hub:ls:fightersel:${s.id}`)
    .setPlaceholder("Which of your cards attacks?")
    .addOptions(livingSlots(team).map(sl => ({
      label: `${sl.index === s.actorSlot ? "▶ " : ""}${sl.unit!.cardName}`.slice(0, 100),
      description: `${Math.max(0, sl.unit!.hp)}/${sl.unit!.stats.maxHealth} HP · ${sl.unit!.energy} energy`.slice(0, 100),
      value: String(sl.index),
    })));
  await interaction.reply({
    content: "⚔️ **Choose your fighter** — this card takes the turn:",
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)], ...EPHEMERAL,
  }).catch(() => {});
}

async function handleFighterSelect(interaction: StringSelectMenuInteraction, s: SiegeSession): Promise<void> {
  const slot = Number(interaction.values[0]);
  const unit = s.battle.teams[0].slots[slot]?.unit;
  if (!unit || unit.hp <= 0) {
    await interaction.update({ content: "That card can't fight.", components: [] }).catch(() => {});
    return;
  }
  s.actorSlot = slot;
  await interaction.update({ content: `⚔️ **${unit.cardName}** steps up.`, components: [] }).catch(() => {});
  await render(s);
}

/** Open the hand of Siege Battle Cards. */
async function handleCardsOpen(interaction: ButtonInteraction, s: SiegeSession): Promise<void> {
  if (!commanderCanAct(s)) {
    await interaction.reply({ content: "It isn't your turn.", ...EPHEMERAL }).catch(() => {});
    return;
  }
  const team = s.battle.teams[0];
  if (team.hand.length === 0) {
    await interaction.reply({ content: "🃏 Your hand is empty.", ...EPHEMERAL }).catch(() => {});
    return;
  }
  // Playability comes from the resolver's own gate, so a card can never look
  // playable here and be refused on click.
  const options = team.hand.map((card, i) => {
    const check = checkAction(s.battle, { kind: "siege_card", actorSlot: s.actorSlot, cardId: card.id });
    return {
      label: `${check.ok ? "" : "🚫 "}${card.name} (${card.energyCost}⚡)`.slice(0, 100),
      description: (check.ok ? card.description : check.reason).slice(0, 100),
      value: `${i}:${card.id}`,
    };
  });
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`hq-hub:ls:cardsel:${s.id}`)
    .setPlaceholder("Play a Siege Battle Card…")
    .addOptions(options);
  await interaction.reply({
    content: "🃏 **Your hand** — play a combat action:",
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)], ...EPHEMERAL,
  }).catch(() => {});
}

async function handleCardSelect(interaction: StringSelectMenuInteraction, s: SiegeSession): Promise<void> {
  if (!commanderCanAct(s)) {
    await interaction.update({ content: "That moment has passed.", components: [] }).catch(() => {});
    return;
  }
  const cardId = (interaction.values[0] ?? "").split(":")[1] ?? "";
  const card = getSiegeCard(cardId);
  if (!card) {
    await interaction.update({ content: "Unknown card.", components: [] }).catch(() => {});
    return;
  }
  // A card that needs a target opens the target picker; everything else fires.
  const foes = s.battle.teams[1];
  const living = livingSlots(foes);
  if (card.target === "enemy_unit" && living.length > 1) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`hq-hub:ls:cardtgt:${s.id}:${cardId}`)
      .setPlaceholder(`${card.name} — strike which card?`)
      .addOptions(living.map(sl => ({
        label: sl.unit!.cardName.slice(0, 100),
        description: `${Math.max(0, sl.unit!.hp)}/${sl.unit!.stats.maxHealth} HP`.slice(0, 100),
        value: String(sl.index),
      })));
    await interaction.update({
      content: `${card.emoji} **${card.name}** — choose a target:`,
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    }).catch(() => {});
    return;
  }
  const allies = livingSlots(s.battle.teams[0]);
  if (card.target === "ally_unit" && allies.length > 1) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`hq-hub:ls:cardtgt:${s.id}:${cardId}`)
      .setPlaceholder(`${card.name} — on which of your cards?`)
      .addOptions(allies.map(sl => ({
        label: sl.unit!.cardName.slice(0, 100),
        description: `${Math.max(0, sl.unit!.hp)}/${sl.unit!.stats.maxHealth} HP`.slice(0, 100),
        value: String(sl.index),
      })));
    await interaction.update({
      content: `${card.emoji} **${card.name}** — choose an ally:`,
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    }).catch(() => {});
    return;
  }

  await interaction.update({ content: `${card.emoji} Playing **${card.name}**.`, components: [] }).catch(() => {});
  await applySiegeAction(s, {
    kind: "siege_card", actorSlot: s.actorSlot, cardId,
    targetSlot: card.target === "ally_unit" ? allies[0]?.index : living[0]?.index,
  });
}

async function handleCardTarget(interaction: StringSelectMenuInteraction, s: SiegeSession, cardId: string): Promise<void> {
  if (!commanderCanAct(s)) {
    await interaction.update({ content: "That moment has passed.", components: [] }).catch(() => {});
    return;
  }
  const card = getSiegeCard(cardId);
  const targetSlot = Number(interaction.values[0]);
  await interaction.update({
    content: `${card?.emoji ?? "🃏"} Playing **${card?.name ?? cardId}**.`, components: [],
  }).catch(() => {});
  await applySiegeAction(s, { kind: "siege_card", actorSlot: s.actorSlot, cardId, targetSlot });
}

/** Break through to the enemy commander once nothing is left defending them. */
async function handleDirectLp(interaction: ButtonInteraction, s: SiegeSession): Promise<void> {
  if (!commanderCanAct(s)) {
    await interaction.reply({ content: "It isn't your turn.", ...EPHEMERAL }).catch(() => {});
    return;
  }
  const action: SiegeAction = { kind: "direct_lp", actorSlot: s.actorSlot };
  const check = checkAction(s.battle, action);
  if (!check.ok) {
    await interaction.reply({ content: `🛡️ ${check.reason}`, ...EPHEMERAL }).catch(() => {});
    return;
  }
  s.inputPending = true;
  await interaction.deferUpdate().catch(() => {});
  const p = applySiegeAction(s, action);
  s.inputPending = false;
  await p;
}

/** Only the commander, on their Main Phase, with the board idle. */
function commanderCanAct(s: SiegeSession): boolean {
  return s.phase === "assault"
    && s.battle.phase === "main"
    && s.battle.activeSide === 0
    && !s.processing
    && !s.inputPending;
}

async function handleConcede(interaction: ButtonInteraction, s: SiegeSession): Promise<void> {
  await interaction.deferUpdate().catch(() => {});
  if (s.phase === "muster") {
    // Nothing was committed, so standing down just closes the board.
    pushLog(s, ["🏳️ The column stands down."]);
    if (s.message) {
      await s.message.edit({
        embeds: [new EmbedBuilder().setColor(0x9aa0a8).setTitle("🏳️ Stood down")
          .setDescription(`No assault was made on **${s.targetName}**.`)],
        components: [], files: [],
      }).catch(() => {});
    }
    await release(s);
    return;
  }
  s.battle.teams[0].lp = 0;      // a retreat concedes the commander's life points
  s.battle.winner = 1;
  s.battle.phase = "ended";
  pushLog(s, ["🏳️ You sound the retreat."]);
  await finish(s);
}

// Reveal the stashed blow-by-blow for an auto-resolved siege. Ephemeral, so each
// viewer gets their own recap and the clean result message is left untouched.
async function handleReplay(interaction: ButtonInteraction, replayId: string): Promise<void> {
  const r = replays.get(replayId);
  if (!r) {
    await interaction.reply({ content: "⌛ This replay has expired.", ...EPHEMERAL }).catch(() => {});
    return;
  }
  const body = r.log.length ? r.log.slice(-16).join("\n").slice(0, 3800) : "_No blows were recorded._";
  const embed = new EmbedBuilder().setColor(r.accent)
    .setTitle(`🔁 Replay — ${r.title}`)
    .setDescription(`Assault on **${r.targetName}**\n${r.scoreLine}\n${WHITE_LINE}\n${body}`);
  await interaction.reply({ embeds: [embed], ...EPHEMERAL }).catch(() => {});
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function pushLog(s: SiegeSession, lines: (string | undefined)[]): void {
  for (const l of lines) if (l && l.trim()) s.log.push(l);
  s.log = s.log.slice(-14);
}

function active(s: SiegeSession, side: 0 | 1): Combatant | undefined {
  // The front living card on that side of the live board (the muster board and
  // the castle scene ask "who is fighting now?").
  const team = s.battle.teams[side];
  return livingSlots(team)[0]?.unit ?? team.slots.find(sl => sl.unit)?.unit ?? undefined;
}
function foeSide(side: 0 | 1): 0 | 1 { return side === 0 ? 1 : 0; }

function castleFiles(s: SiegeSession): AttachmentBuilder[] {
  return s.castleImage ? [new AttachmentBuilder(s.castleImage, { name: SIEGE_CASTLE_IMAGE })] : [];
}

// Re-render the castle only when the siege visibly changed (a rank broke, or the
// meter moved a whole step). The buffer is re-sent on every edit — Discord drops
// attachments that aren't resent — but the expensive canvas work is not redone.
async function refreshCastle(s: SiegeSession, force = false): Promise<void> {
  // A headless siege renders no intermediate frames; finish() still paints the
  // final result scene directly.
  if (!s.baseView || s.headless) return;
  const pct = destructionPct(s);
  const key = `${s.di}:${s.ai}:${Math.floor(pct / 5)}:${s.phase}`;
  if (!force && key === s.castleKey && s.castleImage) return;
  const overlay = currentOverlay(s, pct);
  const bvC = s.baseView;
  const castleFrames = await getOrCreateGuildSettings(s.guildId).catch(() => null);
  // Race against a timeout: canvas image loads can hang indefinitely if a card
  // image URL stalls. A null result just skips the castle frame this tick.
  const buf = await Promise.race([
    withGuildFrames(castleFrames, () => renderSiegeFrame(bvC, overlay)).catch(() => null),
    sleep(8_000).then(() => null),
  ]);
  if (buf) { s.castleImage = buf; s.castleKey = key; }
}

// Non-blocking castle refresh for the INTERACTIVE path. Never awaited: the board
// paints immediately with whatever castle frame is already cached (from muster),
// and when a fresh frame finishes it only UPDATES THE BUFFER — it does NOT call
// render(). Re-editing the live message restarts any looping turn GIF (Discord
// reloads attachments on edit), which is exactly the choppiness /hq had. Rank
// breaks still await refreshCastle() on the critical path; every other board
// edit picks up the newer castle on the next intentional render. Only one
// background render runs at a time (castleRendering).
function scheduleCastleRefresh(s: SiegeSession, force = false): void {
  if (!s.baseView || s.headless || s.castleRendering) return;
  const pct = destructionPct(s);
  const key = `${s.di}:${s.ai}:${Math.floor(pct / 5)}:${s.phase}`;
  if (!force && key === s.castleKey && s.castleImage) return;
  s.castleRendering = true;
  const overlay = currentOverlay(s, pct);
  const bvS = s.baseView;
  void getOrCreateGuildSettings(s.guildId).catch(() => null).then((schedFrames) => Promise.race([
    withGuildFrames(schedFrames, () => renderSiegeFrame(bvS, overlay)).catch(() => null),
    sleep(8_000).then(() => null),
  ])).then((buf) => {
    s.castleRendering = false;
    if (buf && s.phase !== "ended") {
      s.castleImage = buf; s.castleKey = key;
    }
  }).catch(() => { s.castleRendering = false; });
}

function currentOverlay(s: SiegeSession, pct: number, banner?: { text: string; color: number }): SiegeOverlay {
  const defeated = new Set<number>();
  for (let i = 0; i < s.di && i < s.defenders.length; i++) defeated.add(i);
  const cardsLost = s.ai;
  const captured = s.di >= s.defenders.length;
  return {
    healthFrac: s.defenders.length === 0 ? 0 : Math.max(0, 1 - pct / 100),
    defeated,
    attacker: s.champion,
    advance: Math.max(0.05, Math.min(1, pct / 100)),
    banner: banner ?? null,
    destructionPct: pct,
    stars: starsFor(pct, captured, cardsLost),
    // The result banner already says how it ended, so the turn strip stands down
    // once it is up.
    turnLabel: banner ? null
      : s.phase === "muster" ? "Muster — the column forms up"
      : `Turn ${s.turnNumber} · ${s.currentSide === 0 ? "your move" : "the garrison answers"}`,
  };
}

// TOP embed was previously the castle scene. Assault renders now use the LARGE
// Siege Battle field as the primary embed (buildBattleEmbed); castle art is
// limited to muster / result frames via refreshCastle.

// The routine "X's attack hits for N" lines are already shown on the battlefield
// frame, so the strip keeps only the notable beats and the last line.
const ROUTINE_HIT = /^⚔️ .* hits for /u;
function latestSiegeLines(s: SiegeSession, max = 2): string {
  if (s.log.length === 0) return "_The field is quiet…_";
  const notable = s.log.filter((l, i) => i === s.log.length - 1 || !ROUTINE_HIT.test(l));
  return (notable.length ? notable : s.log).slice(-max).join("\n").slice(0, 600);
}

// MIDDLE embed: the one-line turn-for-turn strip. It sits between the base
// (above) and the battlefield (below) and does two jobs only — show the latest
// move, and ping whoever is on the clock. No stat block, no wall of log: the
// battlefield frame carries the HP/energy, this is just the play-by-play caption
// and the turn call.
function buildTurnStripEmbed(s: SiegeSession, opts?: { currentMove?: string; turnEndsAt?: number }): EmbedBuilder {
  const timer = opts?.turnEndsAt ? ` · ends <t:${Math.floor(opts.turnEndsAt / 1000)}:R>` : "";
  const phaseLabel = s.battle.phase === "draw" ? "🃏 DRAW"
    : s.battle.phase === "main" ? "⚔️ MAIN"
    : s.battle.phase === "reinforce" ? "🚩 REINFORCE"
    : s.battle.phase === "ended" ? "🏁 END"
    : "⚔️";
  const turnCall = opts?.currentMove
    ? `⚔️ *${opts.currentMove}*`
    : s.currentSide === 1
      ? `🛡️ **Garrison's move…**${timer}`
      : `🔹 <@${s.starterId}> — **your move!**${timer}`;
  return new EmbedBuilder()
    .setColor(s.accent)
    .setDescription(
      `**Turn ${s.turnNumber}** · ${phaseLabel}\n` +
      `${turnCall}\n${WHITE_LINE}\n📜 ${latestSiegeLines(s)}`,
    )
    .setFooter({ text: `🎒 ${s.battle.teams[0].itemUsesLeft} field use${s.battle.teams[0].itemUsesLeft === 1 ? "" : "s"} left · hand ${s.battle.teams[0].hand.length}` });
}

// BOTTOM embed: the battlefield itself — the animated Clash arena. The image is
// the whole story, but the embed MUST carry at least one content field: Discord
// rejects a colour-only embed (400), and on the very first turn there is no
// frame yet — that empty embed silently failing the message edit is exactly what
// froze the siege right after the coin toss. A title of the two active fighters
// keeps it valid whether or not a frame is attached, and reads as a scoreboard.
function buildBattleEmbed(s: SiegeSession): EmbedBuilder {
  const t0 = s.battle.teams[0], t1 = s.battle.teams[1];
  const atk = active(s, 0), def = active(s, 1);
  const pct = destructionPct(s);
  const stars = starsFor(pct, s.di >= s.defenders.length, s.ai);
  const title = atk && def
    ? `⚔️ Siege Battle — ${atk.cardName}  ⚔  ${def.cardName}`
    : `⚔️ Siege Battle — ${s.targetName}`;
  const standing = (t: typeof t0) => livingSlots(t).length;
  const phaseLabel = s.battle.phase === "draw" ? "🃏 Draw Phase"
    : s.battle.phase === "main" ? "⚔️ Main Phase"
    : s.battle.phase === "reinforce" ? "🚩 Reinforce"
    : "🏁 Ended";
  const hand = t0.hand.length
    ? t0.hand.slice(0, 5).map(c => `${c.emoji}${c.name}`).join(" · ")
    : "_empty_";
  return new EmbedBuilder().setColor(s.accent).setTitle(title)
    .setDescription(
      `${phaseLabel} · Turn **${s.turnNumber}** · ${"★".repeat(stars)}${"☆".repeat(3 - stars)} **${Math.round(pct)}%**\n` +
      `🔷 **${t0.name}** — LP **${t0.lp.toLocaleString()}**/${t0.lpMax.toLocaleString()} · ${standing(t0)}/4 standing · ${t0.reserves.filter(c => c.hp > 0).length} reserve\n` +
      `🔻 **${t1.name}** — LP **${t1.lp.toLocaleString()}**/${t1.lpMax.toLocaleString()} · ${standing(t1)}/4 standing · ${t1.reserves.filter(c => c.hp > 0).length} reserve\n` +
      `${WHITE_LINE}\n🃏 **Hand:** ${hand}`,
    );
}

function buildControls(s: SiegeSession): ActionRowBuilder<ButtonBuilder>[] {
  // Actions only during MAIN PHASE — DRAW has no combat buttons.
  if (s.battle.activeSide !== 0 || s.battle.phase !== "main") return [];
  const team = s.battle.teams[0];
  const actor = team.slots[s.actorSlot]?.unit;
  if (!actor || actor.hp <= 0) return [];

  // While a turn is resolving (or an input is already claimed) every control is
  // greyed out, so the board visibly locks the instant the commander acts.
  const busy = s.processing || s.inputPending;
  const avail = availableMoves(actor, s.settings);
  const mk = (move: MoveType, label: string, emoji: string, style: ButtonStyle) =>
    new ButtonBuilder().setCustomId(`hq-hub:ls:move:${s.id}:${move}`).setLabel(label).setEmoji(emoji)
      .setStyle(style).setDisabled(busy || !avail[move]);

  // Clean two-row board: core moves up top, essentials below. Secondary tools
  // (Moves guide / Break Through when illegal / etc.) live under More.
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    mk("attack", "Attack", "⚔️", ButtonStyle.Primary),
    mk("special", "Special", "🔥", ButtonStyle.Danger),
    mk("ultimate", "Ultimate", "💀", ButtonStyle.Danger),
    mk("defend", "Defend", "🛡️", ButtonStyle.Secondary),
    mk("charge", "Charge", "⚡", ButtonStyle.Secondary),
  );

  const canBreakThrough = checkAction(s.battle, { kind: "direct_lp", actorSlot: s.actorSlot }).ok;
  const playable = team.hand.filter(c =>
    checkAction(s.battle, { kind: "siege_card", actorSlot: s.actorSlot, cardId: c.id }).ok).length;

  const row2Btns: ButtonBuilder[] = [
    new ButtonBuilder().setCustomId(`hq-hub:ls:cards:${s.id}`)
      .setLabel(`Cards ${playable}/${team.hand.length}`).setEmoji("🃏")
      .setStyle(ButtonStyle.Primary).setDisabled(busy || team.hand.length === 0),
    new ButtonBuilder().setCustomId(`hq-hub:ls:fighter:${s.id}`)
      .setLabel("Fighter").setEmoji("🎖️")
      .setStyle(ButtonStyle.Secondary).setDisabled(busy || livingSlots(team).length < 2),
    new ButtonBuilder().setCustomId(`hq-hub:ls:item:${s.id}`)
      .setLabel("Bag").setEmoji("🎒")
      .setStyle(ButtonStyle.Success).setDisabled(busy || team.itemUsesLeft <= 0),
  ];
  if (canBreakThrough) {
    row2Btns.push(
      new ButtonBuilder().setCustomId(`hq-hub:ls:lp:${s.id}`)
        .setLabel("Break Through").setEmoji("🎯")
        .setStyle(ButtonStyle.Danger).setDisabled(busy),
    );
  }
  row2Btns.push(
    new ButtonBuilder().setCustomId(`hq-hub:ls:more:${s.id}`)
      .setLabel("More").setEmoji("⋯")
      .setStyle(ButtonStyle.Secondary).setDisabled(busy),
  );

  return [
    row1,
    new ActionRowBuilder<ButtonBuilder>().addComponents(...row2Btns.slice(0, 5)),
  ];
}

async function render(s: SiegeSession, opts?: { currentMove?: string; turnEndsAt?: number }): Promise<void> {
  if (!s.message || s.phase === "ended" || s.headless) return;
  // During assault the LARGE Siege Battle field is the primary screen. Castle
  // art stays on muster / result — not a second layered battle UI mid-fight.
  const files: AttachmentBuilder[] = [];
  const battleEmbed = buildBattleEmbed(s);
  const showClash = s.inClash && !!s.clashFrame;
  const frame = showClash ? s.clashFrame : s.turnFrame;
  if (frame) {
    const name = showClash
      ? (s.clashFrameIsGif ? SIEGE_CLASH_GIF : SIEGE_CLASH_PNG)
      : (s.turnFrameIsGif ? SIEGE_TURN_GIF : SIEGE_TURN_PNG);
    battleEmbed.setImage(`attachment://${name}`);
    files.push(new AttachmentBuilder(frame, { name }));
  }
  // Ping the commander only at the START of their turn (the render that arms the
  // turn clock), so they get exactly one notification per turn instead of one
  // per intermediate re-render.
  const ping = opts?.turnEndsAt && s.currentSide === 0 && s.phase === "assault";
  const payload = {
    content: ping ? `<@${s.starterId}>` : "",
    embeds: [battleEmbed, buildTurnStripEmbed(s, opts)],
    components: buildControls(s),
    files,
    allowedMentions: { users: ping ? [s.starterId] : [] },
  };

  // Soft Discord edit budget: long sieges rollover onto a fresh channel message
  // with the same board so the fight can keep going past flaky edit limits.
  if (s.editCount >= MAX_BOARD_EDITS) {
    await rolloverBoardMessage(s, payload);
    return;
  }

  const ok = await s.message.edit(payload).then(() => true).catch((err) => {
    logger.warn({ err, siege: s.id, edits: s.editCount }, "siege board edit failed");
    return false;
  });
  if (ok) {
    s.editCount++;
    return;
  }
  // Edit failed (rate limit / unknown message) — try a fresh board message.
  await rolloverBoardMessage(s, payload);
}

/** Post a fresh Siege board message and point the session at it. */
async function rolloverBoardMessage(
  s: SiegeSession,
  payload: {
    content: string;
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
    files: AttachmentBuilder[];
    allowedMentions: { users: string[] };
  },
): Promise<void> {
  const channel = s.message?.channel;
  if (!channel || !("send" in channel) || typeof channel.send !== "function") return;
  try {
    const prev = s.message;
    if (prev) {
      await prev.edit({
        content: "",
        embeds: [new EmbedBuilder().setColor(s.accent)
          .setDescription(`↗️ Siege Battle continues below — turn **${s.turnNumber}**.`)],
        components: [], files: [],
      }).catch(() => {});
    }
    const next = await channel.send({
      ...payload,
      content: payload.content || `⚔️ **Siege Battle** continues — <@${s.starterId}>`,
      allowedMentions: { users: [s.starterId] },
    }) as Message;
    s.message = next;
    s.editCount = 1;
    logger.info({ siege: s.id, turn: s.turnNumber }, "siege board rolled over to a fresh message");
  } catch (err) {
    logger.warn({ err, siege: s.id }, "siege board rollover failed");
  }
}

// ── Finish ────────────────────────────────────────────────────────────────────

async function finish(s: SiegeSession): Promise<void> {
  if (s.phase === "ended") return;
  s.phase = "ended";
  s.processing = true;
  clearTurnTimer(s);

  // The engine decides the winner by life points. A siege is "captured" when the
  // commander broke the garrison's LP (winner === 0); the garrison holds when it
  // broke the commander's (winner === 1) or the turn cap fell their way.
  const captured = s.battle.winner === 0;
  const pct = captured ? 100 : destructionPct(s);
  const attackerLost = destroyedCount(s, 0);
  const defenderLost = destroyedCount(s, 1);
  const stars = starsFor(pct, captured, attackerLost);
  const outcome: SiegeOutcome = {
    attackerWon: captured,
    turns: s.turnNumber,
    attackerCardsLost: attackerLost,
    defenderCardsLost: defenderLost,
    attackerPower: s.attackerPower,
    defenderPower: s.defenderPower,
    destructionPct: Math.round(pct),
    stars,
  };

  let view: SiegeResultView;
  try {
    view = await s.applyOutcome(outcome);
  } catch (err) {
    logger.error({ err, siege: s.id }, "siege applyOutcome failed");
    view = {
      title: captured ? "🚩 Base captured!" : "🛡️ The walls held",
      description: captured ? "You took the base." : "Your assault was broken.",
      color: captured ? 0x4fd06a : 0xc0392b,
    };
  }

  // Final castle frame with the result banner painted on.
  if (s.baseView) {
    const banner = captured
      ? { text: `${s.attackerName} CAPTURED ${s.targetName}`, color: 0xc0392b }
      : { text: `${s.targetName} HELD`, color: 0x4fd06a };
    const liveFrames = await getOrCreateGuildSettings(s.guildId).catch(() => null);
    const bvF = s.baseView; // narrowed non-null capture for the closure
    const buf = await withGuildFrames(liveFrames, () => renderSiegeFrame(bvF, currentOverlay(s, pct, banner))).catch(() => null);
    if (buf) s.castleImage = buf;
  }

  const scoreLine =
    `${"★".repeat(stars)}${"☆".repeat(3 - stars)} · **${Math.round(pct)}%** destruction · ` +
    `**${outcome.defenderCardsLost}**/${s.defenders.length} ranks broken · ` +
    `**${outcome.attackerCardsLost}** card${outcome.attackerCardsLost === 1 ? "" : "s"} lost`;

  // A player who FOUGHT it watched every blow, so their result recaps the log
  // inline. A player who chose Auto Skip Mode didn't watch — keep their result
  // clean (outcome only) and tuck the fight behind a "View Replay" button.
  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  const embed = new EmbedBuilder().setColor(view.color).setTitle(view.title)
    .setDescription(s.headless
      ? `${view.description}\n${WHITE_LINE}\n${scoreLine}`
      : `${view.description}\n${WHITE_LINE}\n${scoreLine}\n${WHITE_LINE}\n${latestSiegeLines(s, 6)}`);
  if (view.fields?.length) {
    embed.addFields(view.fields.map(f => ({ name: f.name, value: f.value, inline: f.inline ?? true })));
  }
  if (s.castleImage) embed.setImage(`attachment://${SIEGE_CASTLE_IMAGE}`);
  if (s.headless) {
    const replayId = randomBytes(4).toString("hex");
    replays.set(replayId, { title: view.title, scoreLine, log: [...s.log], accent: s.accent, targetName: s.targetName });
    setTimeout(() => replays.delete(replayId), REPLAY_TTL_MS).unref?.();
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`hq-hub:ls:replay:${replayId}`).setLabel("View Replay").setEmoji("🔁").setStyle(ButtonStyle.Secondary),
    ));
  }
  // A distinct beat before the result lands, so it doesn't flash past — only when
  // a person is watching (a send-off is instant and DM'd).
  if (!s.headless) await sleep(RESULT_HOLD_MS);
  if (s.message) {
    await s.message.edit({ embeds: [embed], components, files: castleFiles(s) }).catch(() => {});
  }
  // Send-off ping: the commander walked away, so DM them the result — "your
  // soldiers are back from the siege". The scene image lives on the (ephemeral)
  // board message; the DM carries the outcome text.
  if (s.headless && s.message) {
    try {
      const user = await s.message.client.users.fetch(s.starterId);
      const dm = new EmbedBuilder().setColor(view.color)
        .setTitle(`📨 ${view.title}`)
        .setDescription(`Your assault on **${s.targetName}** is finished.\n${WHITE_LINE}\n${view.description}\n${WHITE_LINE}\n${scoreLine}`);
      if (view.fields?.length) dm.addFields(view.fields.map(f => ({ name: f.name, value: f.value, inline: f.inline ?? true })));
      await user.send({ embeds: [dm] });
    } catch { /* DMs closed — the board still shows the result. */ }
  }
  await release(s);
}

// The TTL net: a siege nobody finished must not hold its target hostage.
async function abandon(s: SiegeSession): Promise<void> {
  if (s.phase === "ended") return;
  pushLog(s, ["⌛ The siege was abandoned — the column withdraws."]);
  if (s.phase === "muster") {
    if (s.message) {
      await s.message.edit({
        embeds: [new EmbedBuilder().setColor(0x9aa0a8).setTitle("⌛ Assault expired")
          .setDescription(`The column never moved on **${s.targetName}**.`)],
        components: [], files: [],
      }).catch(() => {});
    }
    await release(s);
    return;
  }
  s.ai = s.attackers.length; // an abandoned assault is a failed one
  await finish(s);
}

async function release(s: SiegeSession): Promise<void> {
  s.phase = "ended";
  clearTurnTimer(s);
  if (s.ttlTimer) { clearTimeout(s.ttlTimer); s.ttlTimer = undefined; }
  sessions.delete(s.id);
  if (s.targetKey) activeTargetKeys.delete(s.targetKey);
}

function clearTurnTimer(s: SiegeSession): void {
  if (s.turnTimer) { clearTimeout(s.turnTimer); s.turnTimer = undefined; }
}
