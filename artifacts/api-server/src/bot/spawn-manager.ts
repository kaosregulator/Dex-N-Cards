import {
  Client, TextChannel, EmbedBuilder, AttachmentBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  type Message,
} from "discord.js";
import { getScaledStats } from "./battle/stat-engine.js";
import { effectiveRarityKey, rarityLadderRank } from "./rarity-runtime.js";
import { getCardProgress } from "./cards/leveling.js";
import { getBattleSettings } from "./battle/config-engine.js";
import { renderCardReveal, createSpawnRevealSession, renderShinyReveal, renderCardEntrance, resolveEntranceType, resolveShinyStyle, type RevealStats, type RevealMode, type SpawnRevealSession, type EntranceSkin } from "./animations/index.js";
import { withGuildFrames } from "./animations/card-frames.js";
import type { AnimationSpeed } from "./animations/types.js";
import type { RenderCard } from "./battle/image/render.js";
import {
  getOrCreateGuildSettings,
  pickRandomCard,
  catchCard,
  logSpawn,
  markCaught,
  getAllCardsCached,
  getCardWishlisters,
  removeWishlist,
  getUserTimeout,
  getActiveEventBoosts,
  getRarityContext,
  applyRarityContext,
  getActiveSetSpawnPoolCached,
  getActiveSetSpawnPoolCachedSecondary,
  getRarityDisplayOverrides,
  getGuildRarityWeights,
  getCardDisplayRarity,
} from "./db.js";
import {
  getTypeEmoji,
  SHINY_EMOJI, SHINY_MULTIPLIER, getShinyMultiplier,
  type Rarity,
} from "./cards-data.js";
import { toAbsoluteImageUrl, isAnimatedCard } from "./image-url.js";
import { applyEmbedOverride } from "./embed-overrides.js";
import { logger } from "../lib/logger.js";
import {
  isMiniGameArmed, consumeMiniGameArm, initMiniGameSchedules,
} from "./minigame/scheduler.js";
import type { Card, AcquisitionSource, GuildSettings } from "@workspace/db";
import type { CardProgressionGrant } from "./cards/progression.js";

interface PendingCatch {
  userId: string;
  timestamp: number; // message createdTimestamp — lower wins
}

interface ActiveSpawn {
  spawnId: string;
  cardId: number;
  cardName: string;
  burnValue: number;
  channelId: string;
  spawnLogId: number;
  message: Message;
  expiresAt: Date;
  caught: boolean;
  winnerUserId: string | null;
  catchMode: "type" | "button" | "both";
  // Fair-claim buffer for typing mode: collect matches in a small grace
  // window, then award to the message with the smallest server timestamp.
  pending: PendingCatch[];
  resolveTimer: ReturnType<typeof setTimeout> | null;
  // Set once the winner clicks Burn / Keep / Trade so the auto-keep timer
  // doesn't overwrite their actual decision 90s later.
  decisionMade: boolean;
  // Anti-paste: count wrong guesses and progressively reveal hints.
  failedAttempts: number;
  hintLevel: number;
  // Filename of the reveal frame attached to the spawn message (or null when the
  // reveal was disabled / failed and the static card image is used). Hint edits
  // re-reference this so the current frame survives; the catch/expire edits clear
  // it via `attachments: []`.
  revealFile: string | null;
  // Timer for the progressive reveal (edits the message with a slightly more
  // revealed frame over the catch window). Cleared the instant the card is
  // caught or the spawn expires so it never overwrites the caught/escaped card.
  revealTimer: ReturnType<typeof setTimeout> | null;
  // Variable acquisition: which config the catch rolls its Star/Level from
  // ("spawn" for random autodrops, "drop" for admin /drop), and an optional
  // explicit Star/Level that overrides the roll (admin /drop star:… level:…).
  source: AcquisitionSource;
  forcedProgression: CardProgressionGrant | null;
  // The randomly-chosen "a card appeared" headline, fixed for the lifetime of
  // this spawn so every re-render (hint bump, reveal frame) keeps the same line.
  appearMessage: string;
}

// Attachment name for the progressive spawn reveal frame.
const SPAWN_REVEAL_FILE = "spawn-reveal.png";
// Attachment name for the card-entrance pre-intro GIF (image-only spawns).
const SPAWN_ENTRANCE_FILE = "spawn-entrance.gif";
// How long the entrance GIF plays before the spawn message settles onto the
// plain card image (a GIF card settles onto its own live animation). Matches the
// entrance's motion+hold length with a little slack.
const ENTRANCE_HOLD_MS = 2000;
// Minimum spacing between reveal edits (keeps well under Discord's edit rate
// limits) and the cap on how many reveal steps a single spawn plays.
const REVEAL_MIN_INTERVAL_MS = 3000;
const REVEAL_MAX_STEPS = 24;

// After a spawn is caught, keep its entry around for a short cooldown so
// late clicks (double-taps, mobile retries, both-mode type+click race) from
// the actual winner can be silently swallowed instead of showing a confusing
// "spawn expired" message to the person who just caught it.
const POST_CATCH_LINGER_MS = 300_000;

// Funny one-liners shown when a card spawn expires uncaught. Kept short so
// the embed stays scannable.
const ESCAPE_QUIPS: readonly string[] = [
  "It slipped through your fingers and into the void. \ud83d\ude2d",
  "The card looked at you, sighed, and walked away. \ud83d\udeb6",
  "Too slow! It went AWOL. \ud83c\udfc3\u200d\u2642\ufe0f\ud83d\udca8",
  "Mission failed. We'll get 'em next time. \ud83e\udee1",
  "It hopped a chopper and dipped. \ud83d\ude81",
  "Stealth mode engaged. Card is gone. \ud83e\udd77",
  "Nobody typed fast enough \u2014 it deserted. \ud83c\udfc1",
  "Lost contact. Card is MIA. \ud83d\udce1",
  "It saw the chat and noped out. \ud83d\ude45",
  "Tactical retreat. Better luck next drop. \u26f0\ufe0f",
];

// Spawn "a card appeared" headlines. One is picked at random per spawn and used
// for BOTH the embed title and the animated reveal canvas so the two always
// match. Deliberately never name or hint the card — the whole point is to guess
// it. Mirrors the ESCAPE_QUIPS pattern (pick one at random, no fixed order).
const SPAWN_APPEAR_MESSAGES: readonly string[] = [
  "🎴 A mystery card has appeared… what is it?",
  "👀 Something is hiding… take your guess!",
  "🔍 Can you figure out what card this is?",
  "🎯 A hidden card is up for grabs!",
  "🕵️ Think you know your cards? Prove it!",
  "🎴 What card is hiding? Start guessing!",
  "👀 I know the card… do you?",
  "🧩 A mystery has appeared. Name the card!",
  "🔥 The guessing starts now! What card is it?",
  "😈 Something's hiding… who can guess it first?",
];

function pickSpawnAppearMessage(): string {
  return SPAWN_APPEAR_MESSAGES[Math.floor(Math.random() * SPAWN_APPEAR_MESSAGES.length)]!;
}

// Wishlist teases — shown when a card on someone's wishlist spawns. These must
// NEVER name the card: the whole point is you have to type its name to catch it,
// so revealing it would give the catch away. One is picked at random per ping.
const WISHLIST_TEASES: readonly string[] = [
  "👀 — a card on your **wishlist** just dropped. No spoilers… go catch it!",
  "⭐ — something you've been hunting just spawned. Type fast!",
  "🔔 — psst, one of your **wishlisted** cards is in the drop channel *right now*.",
  "🎯 — a wishlist target just appeared. You know what to do.",
  "🃏 — a card you starred just showed up. First to type its name wins it!",
  "📡 — incoming! A **wishlist** card just deployed to the channel.",
];

// Short catch confirmations — mirror the escape-quip format so both ends
// of the spawn feel equally flavourful. Template: {card} … {mention}.
// The card name and mention are interpolated at runtime; these strings
// supply only the surrounding flavour text.
const CATCH_QUIPS: ReadonlyArray<(card: string, mention: string) => string> = [
  (c, u) => `\ud83c\udfaf **${c}** was secured by ${u}.`,
  (c, u) => `\u26a1 **${c}** joined ${u}'s collection.`,
  (c, u) => `\ud83d\udd25 **${c}** has been claimed by ${u}.`,
  (c, u) => `\u2694\ufe0f **${c}** reported for duty to ${u}.`,
  (c, u) => `\ud83c\udfc6 **${c}** has found its home with ${u}.`,
  (c, u) => `\ud83d\udce6 **${c}** secured and shipped to ${u}.`,
  (c, u) => `\ud83c\udf96\ufe0f **${c}** enlisted by ${u}.`,
  (c, u) => `\ud83d\ude80 **${c}** launched straight into ${u}'s arsenal.`,
  (c, u) => `\ud83d\udcf2 Incoming! **${c}** locked on to ${u}.`,
  (c, u) => `\u2705 Pinpoint accuracy \u2014 ${u} snagged **${c}**.`,
];

// Anti-paste hint thresholds for the typing-mode catch flow. Wrong guesses
// gradually reveal more of the card name so copy-paste of the raw name is
// no longer an instant win, while still giving legitimate players a path.
const HINT_LEVELS = [
  { threshold: 0, label: "Easy" },
  { threshold: 3, label: "Medium" },
  { threshold: 6, label: "Hard" },
];

function hintLevelForFailures(failures: number): number {
  let level = 0;
  for (let i = HINT_LEVELS.length - 1; i >= 0; i--) {
    if (failures >= HINT_LEVELS[i]!.threshold) {
      level = i;
      break;
    }
  }
  return level;
}

function maskName(name: string, level: number): string {
  if (level >= HINT_LEVELS.length - 1) return name;
  const reveal = level === 0 ? 1 : 3;
  return name
    .split(" ")
    .map(word => {
      const shown = Math.min(reveal, word.length);
      return word.slice(0, shown) + "\u25cf".repeat(Math.max(0, word.length - shown));
    })
    .join(" ");
}

function buildHintLines(name: string, level: number): string {
  const masked = maskName(name, level);
  const lines: string[] = [];
  if (level === 0) {
    lines.push(`\u2139\ufe0f Name hint: \`${masked}\` (first letter of each word)`);
  } else if (level === 1) {
    lines.push(`\u2139\ufe0f Name hint: \`${masked}\` (first three letters of each word)`);
  } else {
    lines.push(`\u2139\ufe0f Name revealed: \`${masked}\``);
  }
  return lines.join("\n");
}

// Grace window for collecting concurrent typing-mode catch attempts.
// Anyone whose Discord-stamped message lands within this window of the first
// matching message gets considered; lowest timestamp wins.
const TYPE_GRACE_MS = 600;

// Multiple active spawns per guild (for cardsPerSpawn > 1)
const activeSpawns = new Map<string, Map<string, ActiveSpawn>>();
const spawnTimers = new Map<string, ReturnType<typeof setTimeout>>();
const spawnTimersSecondary = new Map<string, ReturnType<typeof setTimeout>>();
// One-shot timers that fire when a scheduled boost starts or ends, so the rate
// change lands on time even between spawns.
const boostTimers = new Map<string, ReturnType<typeof setTimeout>>();

let botClient: Client | null = null;

// ── Scheduled spawn boost ─────────────────────────────────────────────────────
// The active rate multiplier: 2 = twice as many spawns (half the delay), 0.5 =
// half. 1 when no boost is active (none set, not started yet, or already ended).
function spawnBoostFactor(settings: GuildSettings): number {
  const endsAt = settings.spawnBoostEndsAt;
  if (!endsAt) return 1;
  const now = Date.now();
  if (endsAt.getTime() <= now) return 1;
  const startsAt = settings.spawnBoostStartsAt;
  if (startsAt && startsAt.getTime() > now) return 1; // scheduled, not started yet
  const pct = Math.max(10, Math.min(1000, settings.spawnBoostPct ?? 100));
  return pct / 100;
}

// Apply the active boost to a base spawn delay (more spawns → shorter delay).
function applyBoostToDelay(delayMs: number, settings: GuildSettings): number {
  const factor = spawnBoostFactor(settings);
  if (factor === 1) return delayMs;
  return Math.max(5000, Math.round(delayMs / factor));
}

function clearBoostTimer(guildId: string) {
  const t = boostTimers.get(guildId);
  if (t) { clearTimeout(t); boostTimers.delete(guildId); }
}

// Arm a one-shot timer at the boost's next transition (start, then end) so a
// scheduled boost kicks in / expires on time even during a long gap between
// spawns. Re-arms itself after each transition; a no-op when no boost is set.
async function armBoostTransition(guildId: string) {
  clearBoostTimer(guildId);
  const settings = await getOrCreateGuildSettings(guildId);
  const endsAt = settings.spawnBoostEndsAt;
  if (!endsAt) return;
  const now = Date.now();
  const startsAt = settings.spawnBoostStartsAt;
  let next: number | null = null;
  if (startsAt && startsAt.getTime() > now) next = startsAt.getTime();  // boost will start
  else if (endsAt.getTime() > now) next = endsAt.getTime();             // boost will end
  if (next == null) return;
  const delay = Math.max(0, Math.min(next - now + 250, 2_000_000_000));
  const timer = setTimeout(() => {
    void (async () => {
      // The rate just changed (boost started or ended): reschedule both streams
      // at the new rate, then arm the following transition.
      await scheduleNextSpawn(guildId);
      await scheduleNextSpawnSecondary(guildId);
      await armBoostTransition(guildId);
    })();
  }, delay);
  boostTimers.set(guildId, timer);
}

// Called after an admin sets/clears a boost: apply it now (reschedule the next
// spawn at the new rate) and arm the scheduled start/end transition.
export async function applySpawnBoostChange(guildId: string) {
  await scheduleNextSpawn(guildId);
  await scheduleNextSpawnSecondary(guildId);
  await armBoostTransition(guildId);
}

export function getBotClient(): Client | null { return botClient; }

// True when a spawn stream (identified by its channel) already has a card that
// is live — sent, not yet caught, and not yet expired. Used to enforce "one
// active spawn per stream": a scheduled tick will not stack a new card on top of
// a card players can still catch. Scoped by channelId so the primary and
// secondary streams are independent, and a caught-but-lingering entry (kept
// around for late-click handling) does NOT count as live.
function hasLiveSpawnInChannel(guildId: string, channelId: string): boolean {
  const gs = activeSpawns.get(guildId);
  if (!gs) return false;
  const now = Date.now();
  for (const s of gs.values()) {
    if (s.channelId === channelId && !s.caught && s.expiresAt.getTime() > now) return true;
  }
  return false;
}

export function initSpawnManager(client: Client) {
  botClient = client;
}

// ── Schedule next spawn ───────────────────────────────────────────────────────
export async function scheduleNextSpawn(guildId: string) {
  clearSpawnTimer(guildId);
  const settings = await getOrCreateGuildSettings(guildId);
  if (!settings.spawnEnabled || !settings.spawnChannelId) return;

  let delayMs: number;
  if (settings.useRandomInterval && settings.spawnIntervalMin && settings.spawnIntervalMax) {
    const minMs = settings.spawnIntervalMin * 1000;
    const maxMs = settings.spawnIntervalMax * 1000;
    delayMs = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  } else {
    delayMs = settings.spawnIntervalSeconds * 1000;
  }
  delayMs = applyBoostToDelay(delayMs, settings);

  logger.info({ guildId, delayMs }, "Next card spawn scheduled");
  const timer = setTimeout(() => doSpawnBatch(guildId), delayMs);
  spawnTimers.set(guildId, timer);
}

export function clearSpawnTimer(guildId: string) {
  const t = spawnTimers.get(guildId);
  if (t) { clearTimeout(t); spawnTimers.delete(guildId); }
}

// ── Secondary spawn stream scheduling ─────────────────────────────────────────
export async function scheduleNextSpawnSecondary(guildId: string) {
  clearSpawnTimerSecondary(guildId);
  const settings = await getOrCreateGuildSettings(guildId);
  if (!settings.spawnEnabledSecondary || !settings.spawnChannelIdSecondary) return;

  let delayMs: number;
  if (settings.useRandomInterval && settings.spawnIntervalMin && settings.spawnIntervalMax) {
    const minMs = settings.spawnIntervalMin * 1000;
    const maxMs = settings.spawnIntervalMax * 1000;
    delayMs = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  } else {
    delayMs = settings.spawnIntervalSeconds * 1000;
  }
  delayMs = applyBoostToDelay(delayMs, settings);

  logger.info({ guildId, delayMs }, "Next secondary card spawn scheduled");
  const timer = setTimeout(() => doSpawnBatchSecondary(guildId), delayMs);
  spawnTimersSecondary.set(guildId, timer);
}

export function clearSpawnTimerSecondary(guildId: string) {
  const t = spawnTimersSecondary.get(guildId);
  if (t) { clearTimeout(t); spawnTimersSecondary.delete(guildId); }
}

async function doSpawnBatchSecondary(guildId: string) {
  const settings = await getOrCreateGuildSettings(guildId);
  // One active spawn per stream: don't stack a new card while the previous one
  // is still catchable in the secondary channel — reschedule and try next tick.
  if (settings.spawnChannelIdSecondary && hasLiveSpawnInChannel(guildId, settings.spawnChannelIdSecondary)) {
    logger.debug({ guildId }, "Secondary spawn skipped — a spawn is still active in the channel");
    scheduleNextSpawnSecondary(guildId);
    return;
  }
  let count = settings.cardsPerSpawn;
  if (count === -1) count = Math.floor(Math.random() * 3) + 1;
  if (count < 1) count = 1;

  for (let i = 0; i < count; i++) {
    if (i > 0) await sleep(5000);
    await doSingleSpawn(guildId, undefined, false, { secondary: true });
  }
  scheduleNextSpawnSecondary(guildId);
}

// ── Spawn batch (timer-triggered, respects cardsPerSpawn) ─────────────────────
async function doSpawnBatch(guildId: string) {
  const settings = await getOrCreateGuildSettings(guildId);
  // One active spawn per stream: don't stack a new card while the previous one
  // is still catchable in the spawn channel. Skipping + rescheduling makes the
  // spawn timer effectively restart once the active card is caught or expires,
  // and guarantees a new card never appears on top of a live one (e.g. when the
  // configured interval is shorter than the catch window).
  if (settings.spawnChannelId && hasLiveSpawnInChannel(guildId, settings.spawnChannelId)) {
    logger.debug({ guildId }, "Spawn batch skipped — a spawn is still active in the channel");
    scheduleNextSpawn(guildId);
    return;
  }
  let count = settings.cardsPerSpawn;
  if (count === -1) count = Math.floor(Math.random() * 3) + 1;
  if (count < 1) count = 1;

  for (let i = 0; i < count; i++) {
    if (i > 0) await sleep(5000);
    await doSingleSpawn(guildId);
  }
  scheduleNextSpawn(guildId);
}

// ── Core single-card spawn (no scheduling) ────────────────────────────────────
// Pass opts.secondary=true to use the secondary channel + set instead of primary.
async function doSingleSpawn(guildId: string, forcedCardId?: number, isForced = false, opts?: { secondary?: boolean; progression?: CardProgressionGrant | null }): Promise<void> {
  if (!botClient) return;
  const settings = await getOrCreateGuildSettings(guildId);
  const isSecondary = opts?.secondary ?? false;
  const channelId = isSecondary ? settings.spawnChannelIdSecondary : settings.spawnChannelId;
  if (!channelId) return;
  const displayMap = await getRarityDisplayOverrides(guildId);

  let card: Card | undefined;
  if (forcedCardId) {
    const cards = await getAllCardsCached(guildId);
    card = cards.find(c => c.id === forcedCardId);
    if (card?.isArchived) {
      logger.info({ cardId: card.id }, "Refusing to spawn archived card");
      return;
    }
  } else {
    // Sets-driven spawn pool (Phases 1-3): random spawns now pull EXCLUSIVELY
    // from the guild's active set. No active set → no random spawns (Option B).
    // Admin `/drop` and `/cardadmin` give bypass this by setting forcedCardId.
    const spawnPool = await getActiveSetSpawnPoolCached(guildId);
    if (spawnPool.cards.length === 0) {
      logger.debug({ guildId, isSecondary }, "No active set or active set is empty — skipping random spawn");
      return;
    }
    const rarityWeights = getGuildRarityWeights(settings);
    const eventBoosts = await getActiveEventBoosts(guildId);
    const ctx = await getRarityContext(guildId);
    card = await pickRandomCard(
      rarityWeights, eventBoosts, ctx, spawnPool.cards, spawnPool.rarityWeights,
    );
  }
  if (!card) return;

  // Apply server rarity context (Stage-1 profile + Stage-2 custom tiers) so
  // the spawn/claim embeds and the catch flow (burn payout button label,
  // worth display) all use the overridden numbers.
  const ctxForGuild = await getRarityContext(guildId);
  card = applyRarityContext(card, ctxForGuild);
  const spawnDisplayRarity = getCardDisplayRarity(card, ctxForGuild, settings, displayMap);

  if (card.maxCopies && card.totalMinted >= card.maxCopies) {
    logger.info({ cardId: card.id }, "Card max copies reached, skipping");
    return;
  }

  const channel = botClient.channels.cache.get(channelId) as TextChannel | undefined;
  if (!channel) return;

  const mode = ((settings as unknown as { catchMode?: string }).catchMode ?? "type") as "type" | "button" | "both";
  const spawnId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // ── Progressive reveal ─────────────────────────────────────────────────────
  // The card art is revealed across the WHOLE catch window via message edits:
  // the message starts fully hidden and a timer edits it with a slightly more
  // revealed frame until the timer expires or the card is caught. The style is
  // the admin's `spawnRevealMode` (auto = by rarity), and "off" skips it. Fully
  // best-effort: no session just shows the plain card image, exactly as before.
  // One random "a card appeared" headline, shared by the embed title and the
  // reveal canvas so both always show the same line for this spawn.
  const appearMessage = pickSpawnAppearMessage();

  const revealMode = (settings as unknown as { spawnRevealMode?: string }).spawnRevealMode ?? "auto";
  let revealSession: SpawnRevealSession | null = null;
  let revealBuffer: Buffer | null = null;
  if (revealMode !== "off") {
    revealSession = await createSpawnRevealSession({
      artUrl: toAbsoluteImageUrl(card.imageUrl),
      rarity: card.rarity as Rarity,
      rarityLabel: spawnDisplayRarity.label,
      rarityColor: spawnDisplayRarity.color,
      mode: revealMode === "auto" ? undefined : (revealMode as RevealMode),
      appearMessage,
    });
    // Frame 0 = fully hidden (blank/blurred/silhouette) — the spawn opens on it.
    if (revealSession) revealBuffer = await revealSession.renderFrame(0);
    if (!revealBuffer) revealSession = null;
  }

  // ── Card entrance pre-intro ─────────────────────────────────────────────────
  // Only for image-only spawns (reveal "off"): a short "the card enters" GIF
  // (fly/teleport/bounce/warp/flip) plays first, then the message settles onto
  // the plain card image. Also covers spawns that lead into a wild mini-game
  // (the game triggers on the catch, after this intro has shown). Best-effort.
  let entranceBuffer: Buffer | null = null;
  if (revealMode === "off") {
    const entranceType = resolveEntranceType(settings.spawnEntranceAnimation);
    if (entranceType) {
      entranceBuffer = await withGuildFrames(settings, () => renderCardEntrance({
        artUrl: toAbsoluteImageUrl(card.imageUrl),
        rarity: card.rarity as Rarity,
        rarityColor: spawnDisplayRarity.color,
        type: entranceType,
        skin: (settings.spawnEntranceSkin as EntranceSkin) ?? "rarity",
        speed: (settings.packAnimationSpeed as "slow" | "normal" | "fast") ?? "normal",
      })).catch(() => null);
    }
  }

  // The opening image: the reveal frame (hidden phase) OR the entrance GIF OR
  // nothing (plain card image via the embed). Routed through one attachment slot.
  const introBuffer = revealBuffer ?? entranceBuffer;
  const introFile = revealBuffer ? SPAWN_REVEAL_FILE : (entranceBuffer ? SPAWN_ENTRANCE_FILE : null);
  const revealFile = introFile;

  const embed = await buildSpawnEmbed(card, settings.catchWindowSeconds, mode, guildId, 0, revealFile, appearMessage);
  const spawnLog = await logSpawn(guildId, channelId, card.id, isForced);
  const components = mode === "type" ? [] : [buildClaimRow(guildId, spawnId)];
  const files = introBuffer ? [new AttachmentBuilder(introBuffer, { name: introFile! })] : [];
  let message: Message;
  try {
    message = await channel.send({ embeds: [embed], components, files });
  } catch (sendErr) {
    logger.warn({ err: sendErr, channelId, guildId }, "Failed to send spawn message — check bot permissions in the spawn channel");
    return;
  }

  // ── Wishlist ping: notify users who have this card on their wishlist ──────
  // Chunk into batches so a popular card doesn't blast a 100-mention message
  // (Discord rate-limits + spam filters).
  try {
    const wishers = await getCardWishlisters(guildId, card.id);
    const CHUNK = 20;
    for (let i = 0; i < wishers.length; i += CHUNK) {
      const slice = wishers.slice(i, i + CHUNK);
      const mentions = slice.map(u => `<@${u}>`).join(" ");
      // Random tease that never reveals the card name (typing it is the catch).
      const tease = WISHLIST_TEASES[Math.floor(Math.random() * WISHLIST_TEASES.length)]!;
      await channel.send({
        content: `${mentions} ${tease}`,
        allowedMentions: { users: slice },
      }).catch(() => { /* permissions / rate limit — ignore */ });
    }
  } catch (err) {
    logger.warn({ err }, "Wishlist ping failed");
  }

  // ── Collector role ping: opt-in role that gets @mentioned on every spawn ──
  if (settings.collectorRoleId) {
    await channel.send({
      content: `🔔 <@&${settings.collectorRoleId}> a wild **${card.name}** appeared!`,
      allowedMentions: { roles: [settings.collectorRoleId] },
    }).catch(() => { /* role deleted / permissions — ignore */ });
  }

  const spawn: ActiveSpawn = {
    spawnId,
    cardId: card.id,
    cardName: card.name,
    burnValue: card.burnValue,
    channelId,
    spawnLogId: spawnLog.id,
    message,
    expiresAt: new Date(Date.now() + settings.catchWindowSeconds * 1000),
    caught: false,
    winnerUserId: null,
    catchMode: mode,
    pending: [],
    resolveTimer: null,
    decisionMade: false,
    failedAttempts: 0,
    hintLevel: 0,
    revealFile,
    revealTimer: null,
    source: isForced ? "drop" : "spawn",
    forcedProgression: opts?.progression ?? null,
    appearMessage,
  };

  let guildSpawns = activeSpawns.get(guildId);
  if (!guildSpawns) { guildSpawns = new Map(); activeSpawns.set(guildId, guildSpawns); }
  guildSpawns.set(spawnId, spawn);

  // Auto-expire
  const cardRef = card;
  setTimeout(async () => {
    const gs = activeSpawns.get(guildId);
    const s = gs?.get(spawnId);
    if (s && !s.caught) {
      clearRevealTimer(s); // stop the reveal before showing the "escaped" card
      gs?.delete(spawnId);
      if (gs && gs.size === 0) activeSpawns.delete(guildId);
      try {
        const quip = ESCAPE_QUIPS[Math.floor(Math.random() * ESCAPE_QUIPS.length)]!;
        await message.edit({
          embeds: [
            new EmbedBuilder()
              .setTitle(`\ud83d\udca8 ${cardRef.name} escaped!`)
              .setDescription(
                `${quip}\n\n` +
                `**Rarity:** ${spawnDisplayRarity.emoji} ${spawnDisplayRarity.label}\n` +
                `**Caught by:** *nobody — too slow!*`,
              )
              .setColor(0x636e72)
              .setFooter({ text: "Better luck on the next spawn \u2728" })
              .setTimestamp(),
          ],
          // Clear the stale Claim button row and the reveal GIF attachment so
          // the message reads cleanly (a retained attachment would show as a
          // stray image under the "escaped" embed).
          components: [],
          attachments: [],
        });
      } catch { /* deleted */ }
    }
  }, settings.catchWindowSeconds * 1000);

  // ── Kick off the progressive reveal across the catch window ─────────────────
  if (revealSession) {
    startProgressiveReveal(guildId, spawnId, revealSession, card, settings.catchWindowSeconds);
  }

  // ── Settle the entrance intro onto the plain card image ─────────────────────
  // After the entrance GIF has played, edit the spawn to the plain image (a GIF
  // card settles onto its own live animation). Skipped if already caught.
  if (entranceBuffer) {
    setTimeout(async () => {
      const s = activeSpawns.get(guildId)?.get(spawnId);
      if (!s || s.caught || Date.now() >= s.expiresAt.getTime()) return;
      try {
        const settled = await buildSpawnEmbed(card, settings.catchWindowSeconds, s.catchMode, guildId, s.hintLevel, null, s.appearMessage);
        await s.message.edit({ embeds: [settled], attachments: [], files: [] });
        s.revealFile = null; // later hint edits keep the plain image, not the intro attachment
      } catch { /* deleted / no perms — leave the intro up */ }
    }, ENTRANCE_HOLD_MS);
  }
}

// Stop a spawn's progressive-reveal timer (idempotent).
function clearRevealTimer(spawn: ActiveSpawn): void {
  if (spawn.revealTimer) { clearTimeout(spawn.revealTimer); spawn.revealTimer = null; }
}

// Drive the reveal: edit the spawn message with a slightly more revealed frame
// on a cadence that fits the whole catch window, then stop. The number of steps
// scales with the window so the reveal lasts the entire guessing period; puzzle
// reveals one piece per step. Every tick re-checks caught/expired (before AND
// after the async render) so it never clobbers a caught or escaped card, and it
// rebuilds the embed at the current hint level so wrong-guess hints survive.
function startProgressiveReveal(
  guildId: string, spawnId: string, session: SpawnRevealSession, card: Card, windowSeconds: number,
): void {
  const guildSpawns = activeSpawns.get(guildId);
  const spawn = guildSpawns?.get(spawnId);
  if (!spawn) return;

  const windowMs = Math.max(2000, windowSeconds * 1000);
  const maxSteps = Math.min(session.maxSteps, REVEAL_MAX_STEPS);
  // Leave ~1s of lead-in (first piece appears about a second after the spawn)
  // and pace the rest so the last full-reveal frame lands near the window's end.
  const steps = Math.max(4, Math.min(maxSteps, Math.floor((windowMs - 1000) / REVEAL_MIN_INTERVAL_MS)));
  const intervalMs = Math.max(REVEAL_MIN_INTERVAL_MS, Math.floor((windowMs - 1000) / steps));

  let step = 1;
  const tick = async (): Promise<void> => {
    const s = activeSpawns.get(guildId)?.get(spawnId);
    if (!s || s.caught || Date.now() >= s.expiresAt.getTime()) return; // stop
    const progress = Math.min(1, step / steps);
    // Reveal-then-swap (Option C): once an animated-GIF card is fully revealed,
    // drop the flattened canvas frame and show the live looping GIF so the card's
    // own animation plays out. The hidden phase still used the reveal frames, so
    // the guessing game is preserved — only the final, fully-revealed image
    // becomes the real animated art.
    if (progress >= 1 && isAnimatedCard(card)) {
      const s2 = activeSpawns.get(guildId)?.get(spawnId);
      if (!s2 || s2.caught || Date.now() >= s2.expiresAt.getTime()) return;
      try {
        const embed = await buildSpawnEmbed(card, windowSeconds, s2.catchMode, guildId, s2.hintLevel, null, s2.appearMessage);
        await s2.message.edit({ embeds: [embed], attachments: [], files: [] });
        s2.revealFile = null; // subsequent hint edits keep the live GIF, not the attachment
      } catch { /* deleted / no perms / rate-limited — skip */ }
      return; // fully revealed; nothing more to animate
    }
    const frame = await session.renderFrame(progress);
    // Re-check after the async render — a catch/expire may have landed meanwhile.
    const s2 = activeSpawns.get(guildId)?.get(spawnId);
    if (!s2 || s2.caught || Date.now() >= s2.expiresAt.getTime()) return;
    if (frame) {
      try {
        const embed = await buildSpawnEmbed(card, windowSeconds, s2.catchMode, guildId, s2.hintLevel, s2.revealFile, s2.appearMessage);
        await s2.message.edit({
          embeds: [embed],
          attachments: [],
          files: [new AttachmentBuilder(frame, { name: SPAWN_REVEAL_FILE })],
        });
      } catch { /* deleted / no perms / rate-limited — skip this frame */ }
    }
    step++;
    if (step <= steps) {
      const s3 = activeSpawns.get(guildId)?.get(spawnId);
      if (s3 && !s3.caught) s3.revealTimer = setTimeout(() => void tick(), intervalMs);
    }
  };
  // First reveal step ~1s after the spawn appears.
  spawn.revealTimer = setTimeout(() => void tick(), 1000);
}

// ── Public API: force-drop a specific card (admin use) ────────────────────────
// `progression` lets an admin drop a card that will be caught at an explicit
// Star Rank / Level (e.g. `/drop … star:3 level:50`); omit to fall back to the
// guild's configured "drop" acquisition range (or 0★ / Lv 1 if unconfigured).
export async function spawnCard(
  guildId: string, forcedCardId?: number, isForced = false,
  progression?: CardProgressionGrant | null,
): Promise<void> {
  await doSingleSpawn(guildId, forcedCardId, isForced, { progression });
}

// ── Handle catch attempt (typing) ────────────────────────────────────────────
// Lag-fair: when the first match arrives we open a short grace window and
// collect all matching messages. Whoever has the earliest Discord-stamped
// timestamp (msg.createdTimestamp) wins, not whoever the bot processed first.
export async function handleCatchAttempt(
  guildId: string, userId: string, guess: string,
  messageTimestamp: number, channelId: string,
): Promise<{ matched: boolean; awaiting: boolean; timedOutUntil?: Date }> {
  const guildSpawns = activeSpawns.get(guildId);
  if (!guildSpawns || guildSpawns.size === 0) return { matched: false, awaiting: false };

  const normalizedGuess = guess.trim().toLowerCase();
  const now = new Date();

  // First find a matching spawn so we don't query the DB on every random msg.
  let matchedSpawnId: string | null = null;
  for (const [spawnId, spawn] of guildSpawns) {
    if (now > spawn.expiresAt) { guildSpawns.delete(spawnId); continue; }
    if (spawn.caught) continue;
    if (spawn.catchMode === "button") continue; // typing disabled
    if (normalizedGuess !== spawn.cardName.toLowerCase()) continue;
    matchedSpawnId = spawnId;
    break;
  }

  if (!matchedSpawnId) {
    // Wrong guess: count it against typing-mode spawns in the same channel and
    // reveal a stronger hint when the threshold is crossed.
    const sameChannelSpawns = Array.from(guildSpawns.values()).filter(
      s => !s.caught && now <= s.expiresAt && s.catchMode !== "button" && s.channelId === channelId,
    );
    if (sameChannelSpawns.length > 0) {
      void bumpSpawnHints(sameChannelSpawns, guildId);
    }
    return { matched: false, awaiting: false };
  }

  // Admin-imposed catch timeout — block before queuing.
  const timeout = await getUserTimeout(guildId, userId);
  if (timeout) return { matched: true, awaiting: false, timedOutUntil: timeout.expiresAt };

  const spawn = guildSpawns.get(matchedSpawnId)!;
  spawn.pending.push({ userId, timestamp: messageTimestamp });
  if (!spawn.resolveTimer) {
    spawn.resolveTimer = setTimeout(() => { void resolveTypingSpawn(guildId, matchedSpawnId!); }, TYPE_GRACE_MS);
  }
  return { matched: true, awaiting: true };
}

async function bumpSpawnHints(spawns: ActiveSpawn[], guildId: string): Promise<void> {
  const settings = await getOrCreateGuildSettings(guildId);
  const cards = await getAllCardsCached(guildId);
  for (const spawn of spawns) {
    spawn.failedAttempts += 1;
    const newLevel = hintLevelForFailures(spawn.failedAttempts);
    if (newLevel <= spawn.hintLevel) continue;
    spawn.hintLevel = newLevel;
    const card = cards.find(c => c.id === spawn.cardId);
    if (!card) continue;
    // Pass revealFile so the hint edit keeps referencing the reveal GIF (the
    // attachment persists across edits when `files`/`attachments` are omitted).
    const embed = await buildSpawnEmbed(card, settings.catchWindowSeconds, spawn.catchMode, guildId, spawn.hintLevel, spawn.revealFile, spawn.appearMessage);
    await spawn.message.edit({ embeds: [embed] }).catch(() => { /* deleted / no perms */ });
  }
}

async function resolveTypingSpawn(guildId: string, spawnId: string): Promise<void> {
  const guildSpawns = activeSpawns.get(guildId);
  const spawn = guildSpawns?.get(spawnId);
  if (!spawn || spawn.caught || spawn.pending.length === 0) return;

  spawn.pending.sort((a, b) => a.timestamp - b.timestamp);
  const winner = spawn.pending[0];
  await awardSpawn(guildId, spawnId, winner.userId);
}

// Award a spawn to a specific user atomically (used by both typing winner and button click).
// Optional private delivery for the catch preview. When the catch came from a
// button interaction we can DM the catcher an ephemeral canvas; typed catches
// (plain chat message) have no interaction, so the canvas rides the public
// confirmation instead.
export interface CatchDelivery {
  sendEphemeral?: (payload: { embeds: EmbedBuilder[]; files: AttachmentBuilder[] }) => Promise<void>;
}

const CATCH_STAT_FILE = "catch.png";
const CATCH_SHINY_FILE = "catch-shiny.gif";

// Build the compact battle-style Stats line + reveal canvas for a caught card,
// reusing the pack canvas pipeline (renderCardReveal) and the shared battle stat
// engine. Stats reflect the catcher's ACTUAL current Level/Star for this card
// (read from the same card_progress row battles use, after any acquisition grant
// is applied) — so catching a levelled/fused card shows its real power, not a
// hardcoded Level 1. Best-effort — a null canvas just means no image.
async function buildCatchPreview(
  guildId: string, userId: string, cardId: number, isShiny: boolean,
): Promise<{ statsLine: string | null; canvas: Buffer | null; fileName: string; color: number; rarityLabel: string } | null> {
  try {
    const [cards, ctx, settings, displayMap, battleSettings, progress] = await Promise.all([
      getAllCardsCached(guildId),
      getRarityContext(guildId),
      getOrCreateGuildSettings(guildId),
      getRarityDisplayOverrides(guildId),
      getBattleSettings(guildId).catch(() => null),
      getCardProgress(guildId, userId, cardId).catch(() => null),
    ]);
    const card = cards.find(c => c.id === cardId);
    if (!card) return null;
    const display = getCardDisplayRarity(card, ctx, settings, displayMap);
    const color = display.color ?? 0x00b894;

    const level = Math.max(1, progress?.level ?? 1);
    const starRank = Math.max(0, progress?.starRank ?? 0);
    const statLabel = (level > 1 || starRank > 0)
      ? `LV ${level}${starRank > 0 ? ` · ${starRank}★` : ""} · BATTLE STATS`
      : "LEVEL 1 · BATTLE STATS";

    let statsLine: string | null = null;
    let revealStats: RevealStats | null = null;
    if (battleSettings) {
      const s = getScaledStats(
        { id: card.id, name: card.name, rarity: card.rarity, worthValue: card.worthValue, cardType: card.cardType },
        null, battleSettings, level, undefined, starRank,
        rarityLadderRank(effectiveRarityKey(card, ctx), ctx),
      );
      revealStats = {
        hp: s.maxHealth, atk: s.attack, def: s.defense, spd: s.speed,
        critChance: Math.round(s.critChance), accuracy: Math.round(s.accuracy),
      };
      const header = (level > 1 || starRank > 0)
        ? `⚡ **Battle-ready — Lv ${level}${starRank > 0 ? ` · ${starRank}★` : ""}**\n`
        : "";
      statsLine = header +
        `❤️ **HP** ${s.maxHealth.toLocaleString()}  ·  ⚔️ **ATK** ${s.attack.toLocaleString()}  ·  🛡️ **DEF** ${s.defense.toLocaleString()}\n` +
        `💨 **SPD** ${s.speed.toLocaleString()}  ·  🎯 **Crit** ${Math.round(s.critChance)}%  ·  🏹 **Acc** ${Math.round(s.accuracy)}%`;
    }

    const renderCard: RenderCard = {
      name: card.name,
      rarity: card.rarity as Rarity,
      rarityLabel: display.label,
      rarityColor: display.color,
      cardId: card.id,
      cardType: card.cardType,
      artUrl: toAbsoluteImageUrl(card.imageUrl),
    };
    // Shiny catch: play the animated sparkle/shine reveal (if enabled) so a
    // shiny is instantly recognisable; otherwise the static card canvas. Either
    // is best-effort — a null canvas just means no image on the catch embed.
    const shinyAnimEnabled = (settings as unknown as { shinyAnimationEnabled?: boolean }).shinyAnimationEnabled ?? true;
    const speed = (settings.packAnimationSpeed as AnimationSpeed) ?? "normal";
    let canvas: Buffer | null = null;
    let fileName = CATCH_STAT_FILE;
    if (isShiny && shinyAnimEnabled) {
      const shinyStyle = resolveShinyStyle((settings as unknown as { shinyAnimationStyle?: string }).shinyAnimationStyle);
      canvas = await withGuildFrames(settings, () => renderShinyReveal({
        artUrl: renderCard.artUrl, rarity: renderCard.rarity, rarityLabel: display.label,
        rarityColor: display.color, name: card.name, speed, style: shinyStyle,
      }));
      if (canvas) fileName = CATCH_SHINY_FILE;
    }
    if (!canvas) {
      canvas = await withGuildFrames(settings, () => renderCardReveal({ card: renderCard, stats: revealStats, shiny: isShiny, index: 1, total: 1, statLabel }));
    }
    return { statsLine, canvas, fileName, color, rarityLabel: display.label };
  } catch (err) {
    logger.debug({ err, guildId, cardId }, "buildCatchPreview failed (non-fatal)");
    return null;
  }
}

async function awardSpawn(guildId: string, spawnId: string, userId: string, delivery?: CatchDelivery): Promise<boolean> {
  const guildSpawns = activeSpawns.get(guildId);
  const spawn = guildSpawns?.get(spawnId);
  if (!spawn || spawn.caught) return false;

  spawn.caught = true;
  spawn.winnerUserId = userId;
  clearRevealTimer(spawn); // immediately stop the reveal — the catch card takes over
  // Keep the spawn entry around briefly so we can recognise late clicks from
  // the winner (double-tap, both-mode type+click race) instead of telling
  // them the spawn expired. It's cleaned up after POST_CATCH_LINGER_MS.
  setTimeout(() => {
    const gs = activeSpawns.get(guildId);
    if (gs?.get(spawnId)?.caught) {
      gs.delete(spawnId);
      if (gs.size === 0) activeSpawns.delete(guildId);
    }
  }, POST_CATCH_LINGER_MS);
  if (spawn.resolveTimer) { clearTimeout(spawn.resolveTimer); spawn.resolveTimer = null; }

  // ── Wild Mini-Game interception ─────────────────────────────────────────────
  // If a mini-game is armed, the catcher truly caught the card — but it isn't
  // awarded yet. A "wild" mini-game pops out: win → the card is granted (the same
  // grantCatch below), lose → it escapes and nothing is granted. Consuming the arm
  // ensures only this one catch triggers it; the schedule re-arms after it
  // resolves. Any failure here falls through to the normal instant grant, so a
  // broken game never costs the player their catch.
  try {
    if (await isMiniGameArmed(guildId)) {
      await consumeMiniGameArm(guildId);
      const launched = await launchMiniGameForCatch(guildId, spawn, userId);
      if (launched) return true;
    }
  } catch (err) {
    logger.warn({ err, guildId }, "mini-game interception failed — granting card normally");
  }

  await grantCatch(guildId, spawn, userId, delivery);
  return true;
}

// Launch a wild mini-game for a just-caught card. Returns true when a game
// actually took over the spawn message (the card is granted later via the win
// callback); false → the caller should grant normally.
async function launchMiniGameForCatch(guildId: string, spawn: ActiveSpawn, userId: string): Promise<boolean> {
  const settings = await getOrCreateGuildSettings(guildId);
  const cards = await getAllCardsCached(guildId);
  const rawCard = cards.find(c => c.id === spawn.cardId);
  if (!rawCard) return false;
  const ctx = await getRarityContext(guildId);
  const card = applyRarityContext(rawCard, ctx);
  const displayMap = await getRarityDisplayOverrides(guildId);
  const display = getCardDisplayRarity(card, ctx, settings, displayMap);
  // Other cards from the guild pool (with art) for games that show decoys /
  // other cards — Memory Match, Choose-a-Card. Shuffled, capped, caught excluded.
  const decoyArt = cards
    .filter(c => c.id !== card.id && c.imageUrl && !c.isArchived)
    .map(c => ({ name: c.name, url: toAbsoluteImageUrl(c.imageUrl) }))
    .sort(() => Math.random() - 0.5)
    .slice(0, 12);
  // The catcher's Discord avatar for the wild-encounter intro (best-effort).
  let avatarUrl: string | null = null;
  try {
    const user = await botClient?.users.fetch(userId);
    avatarUrl = user?.displayAvatarURL({ extension: "png", size: 128 }) ?? null;
  } catch { /* avatar is best-effort */ }
  const { startMiniGame } = await import("./minigame/manager.js");
  return await startMiniGame({
    guildId,
    channelId: spawn.channelId,
    userId,
    card,
    rarityLabel: display.label,
    rarityColor: display.color ?? 0x00b894,
    cardArtUrl: toAbsoluteImageUrl(card.imageUrl),
    avatarUrl,
    decoyArt,
    spawnMessage: spawn.message,
    animate: (settings as unknown as { miniGameAnimationEnabled?: boolean }).miniGameAnimationEnabled ?? true,
    selection: (settings as unknown as { miniGameSelection?: string }).miniGameSelection ?? "shuffle",
    onWin: () => grantCatch(guildId, spawn, userId),
    onLose: () => escapeAfterMiniGame(spawn),
  });
}

// On a mini-game loss the card escapes: the game already rendered the "escaped"
// screen on the message, so just clean it up after a short beat.
async function escapeAfterMiniGame(spawn: ActiveSpawn): Promise<void> {
  setTimeout(() => { spawn.message.delete().catch(() => { /* deleted / no perms */ }); }, 8000);
}

// Grant a caught card to a user: write the collection row, mark the spawn log,
// run best-effort side effects (wishlist/HQ/quests/XP), and edit the spawn
// message into the catch preview. Extracted from awardSpawn so a wild mini-game
// can wedge between "winner determined" and "card granted" (win → this runs).
async function grantCatch(guildId: string, spawn: ActiveSpawn, userId: string, delivery?: CatchDelivery): Promise<void> {
  // Parallel: write collection row + mark spawn log. Both independent DB calls.
  // The catch also rolls variable acquisition progression (Star/Level) for this
  // spawn's source — or applies an admin-forced Star/Level — through the shared
  // progression service, writing the same card_progress row battles read.
  const [{ isShiny, progression }] = await Promise.all([
    catchCard(guildId, userId, spawn.cardId, spawn.forcedProgression
      ? { forcedProgression: spawn.forcedProgression }
      : { acquisitionSource: spawn.source }),
    markCaught(spawn.spawnLogId, userId),
  ]);

  // Auto-remove the caught card from the winner's wishlist so they stop
  // receiving pings every time that card spawns again.
  removeWishlist(guildId, userId, spawn.cardId).catch(err => {
    logger.warn({ err }, "Wishlist auto-remove after catch failed");
  });

  // HQ bonus: a small chance the catch also yields a Headquarters decoration.
  // Best-effort — never block or break a catch on the HQ side.
  let hqDrop: { name: string; emoji: string } | null = null;
  try {
    const { rollCatchDrop } = await import("./hq/drops.js");
    hqDrop = await rollCatchDrop(guildId, userId);
  } catch { /* non-fatal */ }

  // Quest progress (catch) — best-effort, never blocks the catch flow.
  void (async () => {
    try {
      const cards = await getAllCardsCached(guildId);
      const rarity = cards.find(c => c.id === spawn.cardId)?.rarity as Rarity | undefined;
      const { recordQuestEvent } = await import("./quests/engine.js");
      await recordQuestEvent(guildId, userId, "catch", 1, rarity);
      const { recordGiveawayEvent } = await import("./giveaway/engine.js");
      await recordGiveawayEvent(guildId, userId, "catch", 1, { rarity });
      // Unified account XP: catching a card + any collection milestones crossed.
      const { awardPlayerXp, awardCollectionMilestoneXp, XP } = await import("./player/xp.js");
      await awardPlayerXp(guildId, userId, "catch", XP.catch);
      await awardCollectionMilestoneXp(guildId, userId);
    } catch { /* non-fatal */ }
  })();

  try {
    const quipFn = CATCH_QUIPS[Math.floor(Math.random() * CATCH_QUIPS.length)]!;
    const cards = await getAllCardsCached(guildId);
    const rawCard = cards.find(c => c.id === spawn.cardId);
    const cardName = rawCard?.name ?? spawn.cardName;
    const shinyBadge = isShiny ? ` ✨` : "";

    // A card that arrives pre-levelled/fused gets a shiny-style flair so pulling
    // a battle-ready card feels as special as a shiny.
    const leveled = !!progression && (progression.level > 1 || progression.starRank > 0);
    const readyBadge = leveled
      ? `\n⚡ **BATTLE-READY!** Arrived at **Lv ${progression!.level}${progression!.starRank > 0 ? ` · ${progression!.starRank}★` : ""}** — ready to fight!`
      : "";

    // Build the catch card: compact Stats section (replaces the old plain
    // description) + a reveal canvas, reusing the pack canvas pipeline. Stats
    // reflect the catcher's real current Level/Star for this card so the preview
    // is battle-accurate (a levelled card no longer shows Level 1).
    const preview = await buildCatchPreview(guildId, userId, spawn.cardId, isShiny);
    const dropLine = hqDrop
      ? `\n🎁 **HQ drop:** ${hqDrop.emoji} ${hqDrop.name} — added to your **/hq** decorations!`
      : "";
    const headline = quipFn(`${cardName}${shinyBadge}`, `<@${userId}>`) + readyBadge + dropLine;

    const publicEmbed = new EmbedBuilder()
      .setColor(preview?.color ?? (isShiny || leveled ? 0xf1c40f : 0x00b894))
      .setDescription(
        preview?.statsLine
          ? `${headline}\n\n**📊 Stats**\n${preview.statsLine}`
          : headline,
      );

    // Deliver the canvas privately (button catch) when we can; otherwise ride
    // the public confirmation with it.
    const catchFile = preview?.fileName ?? CATCH_STAT_FILE;
    const canEphemeral = !!(delivery?.sendEphemeral && preview?.canvas);
    if (canEphemeral) {
      const privEmbed = new EmbedBuilder()
        .setColor(preview!.color)
        .setTitle(`✅ Caught ${cardName}${shinyBadge}!`)
        .setImage(`attachment://${catchFile}`);
      if (preview!.statsLine) privEmbed.setDescription(`**📊 Stats**\n${preview!.statsLine}`);
      await delivery!.sendEphemeral!({
        embeds: [privEmbed],
        files: [new AttachmentBuilder(preview!.canvas!, { name: catchFile })],
      }).catch(() => { /* ephemeral is best-effort */ });
    } else if (preview?.canvas) {
      publicEmbed.setImage(`attachment://${catchFile}`);
    }

    await spawn.message.edit({
      embeds: [publicEmbed],
      components: [],
      // Drop the spawn-reveal GIF (attachments: []) before attaching the catch
      // canvas so the caught message never shows a leftover reveal image.
      attachments: [],
      files: (!canEphemeral && preview?.canvas)
        ? [new AttachmentBuilder(preview.canvas, { name: catchFile })]
        : [],
    });
    // Fun ephemeral message — vanishes after a few seconds so the channel stays clean.
    setTimeout(() => {
      spawn.message.delete().catch(() => { /* may be deleted / no perms */ });
    }, 6_000);
  } catch { /* deleted or lacking edit perms */ }
}

// Public: button-click claim. Returns success/false.
// `reason: "self_already"` means this user is the actual winner clicking
// again (double-tap / both-mode race) — caller should silently swallow it.
export async function handleClaimButtonClick(guildId: string, spawnId: string, userId: string, delivery?: CatchDelivery): Promise<{
  ok: boolean; reason?: "expired" | "wrong_mode" | "already_caught" | "self_already" | "timed_out";
  timedOutUntil?: Date;
}> {
  const guildSpawns = activeSpawns.get(guildId);
  const spawn = guildSpawns?.get(spawnId);
  if (!spawn) return { ok: false, reason: "expired" };
  if (spawn.catchMode === "type") return { ok: false, reason: "wrong_mode" };
  if (spawn.caught) {
    return { ok: false, reason: spawn.winnerUserId === userId ? "self_already" : "already_caught" };
  }
  const timeout = await getUserTimeout(guildId, userId);
  if (timeout) return { ok: false, reason: "timed_out", timedOutUntil: timeout.expiresAt };
  const awarded = await awardSpawn(guildId, spawnId, userId, delivery);
  if (awarded) return { ok: true };
  // Race: someone else won between our checks. If that someone is us, swallow.
  const after = activeSpawns.get(guildId)?.get(spawnId);
  if (after?.winnerUserId === userId) return { ok: false, reason: "self_already" };
  return { ok: false, reason: "already_caught" };
}

// Decision buttons row for the caught card.
// `isShiny` is encoded into the burn customId as a 5th `:1`/`:0` segment
// so the click handler knows which pile to torch and what payout to credit.
// Index.ts treats a missing segment as 0 for backwards-compat.
function buildDecisionRow(guildId: string, userId: string, cardId: number, burnValue: number, isShiny = false, shinyMultiplier = SHINY_MULTIPLIER): ActionRowBuilder<ButtonBuilder> {
  const effectiveBurn = isShiny ? burnValue * shinyMultiplier : burnValue;
  const shinyFlag = isShiny ? "1" : "0";
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`catch_burn:${guildId}:${userId}:${cardId}:${shinyFlag}`)
      .setLabel(`🔥 Burn (+${effectiveBurn.toLocaleString()} 💠)`)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`catch_keep:${guildId}:${userId}:${cardId}`)
      .setLabel("💾 Keep it")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`catch_trade:${guildId}:${userId}:${cardId}`)
      .setLabel("🔄 Offer Trade")
      .setStyle(ButtonStyle.Primary),
  );
}

// Disabled (greyed-out) version of the decision row, used after the catcher
// picks one of the three options so the buttons stay visible but inert.
export function buildDisabledDecisionRow(
  guildId: string, userId: string, cardId: number, burnValue: number, chosen: "burn" | "keep" | "trade",
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`catch_burn_done:${guildId}:${userId}:${cardId}`)
      .setLabel(chosen === "burn" ? `🔥 Burned (+${burnValue.toLocaleString()} 💠)` : `🔥 Burn (+${burnValue.toLocaleString()} 💠)`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`catch_keep_done:${guildId}:${userId}:${cardId}`)
      .setLabel(chosen === "keep" ? "💾 Kept" : "💾 Keep it")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`catch_trade_done:${guildId}:${userId}:${cardId}`)
      .setLabel(chosen === "trade" ? "🔄 Open to Trade" : "🔄 Offer Trade")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );
}

// Build a 5-button row with the Claim button at a random column 0–4. The
// other 4 slots are disabled spacers — this randomizes the click target each
// spawn so players can't camp a fixed screen position.
function buildClaimRow(guildId: string, spawnId: string): ActionRowBuilder<ButtonBuilder> {
  const claimPos = Math.floor(Math.random() * 5);
  const buttons: ButtonBuilder[] = [];
  for (let i = 0; i < 5; i++) {
    if (i === claimPos) {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`spawn_claim:${guildId}:${spawnId}`)
          .setLabel("🎯 Claim")
          .setStyle(ButtonStyle.Success),
      );
    } else {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`spawn_spacer:${spawnId}:${i}`)
          .setLabel("\u200b")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
      );
    }
  }
  return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
}

// ── Burn / Keep / Offer Trade buttons after catching ─────────────────────────
// Posted in-channel; everyone sees the prompt but only the catcher's clicks
// are accepted (others get an ephemeral "not yours" reply).
export function getActiveSpawns(guildId: string): ActiveSpawn[] {
  const gs = activeSpawns.get(guildId);
  return gs ? [...gs.values()] : [];
}

// Marks the winner's Burn/Keep/Trade decision so the auto-keep timer
// won't overwrite the message with a stale "KEPT" embed 90s later.
// Looks up the spawn by (guildId, cardId, userId) since the button handler
// doesn't carry the spawnId. Safe no-op if the entry already lingered out.
export function markDecisionMade(guildId: string, userId: string, cardId: number): void {
  const gs = activeSpawns.get(guildId);
  if (!gs) return;
  for (const spawn of gs.values()) {
    if (spawn.cardId === cardId && spawn.winnerUserId === userId) {
      spawn.decisionMade = true;
      return;
    }
  }
}

export async function initAllGuilds(client: Client) {
  for (const [guildId] of client.guilds.cache) {
    const settings = await getOrCreateGuildSettings(guildId);
    if (settings.spawnEnabled && settings.spawnChannelId) {
      scheduleNextSpawn(guildId);
    }
    if (settings.spawnEnabledSecondary && settings.spawnChannelIdSecondary) {
      scheduleNextSpawnSecondary(guildId);
    }
    // Re-arm any scheduled spawn boost so it survives a restart.
    if (settings.spawnBoostEndsAt) await armBoostTransition(guildId);
  }
  // Re-arm Wild Mini-Game schedules from persisted state (survives restart).
  await initMiniGameSchedules([...client.guilds.cache.keys()]).catch(err => {
    logger.debug({ err }, "initMiniGameSchedules failed (non-fatal)");
  });
}

// Build the "CLAIMED" version of a spawn embed — keeps the image, replaces
// the prompt with a giant CLAIMED banner and the catcher's name.
async function buildClaimedEmbed(
  cardId: number, userId: string, isShiny: boolean = false, guildId: string | null = null,
): Promise<EmbedBuilder | null> {
  const cards = await getAllCardsCached(guildId);
  const rawCard = cards.find(c => c.id === cardId);
  if (!rawCard) return null;
  const ctx = guildId ? await getRarityContext(guildId) : null;
  const card = ctx ? applyRarityContext(rawCard, ctx) : rawCard;
  const rarity = card.rarity as Rarity;
  const cardType = card.cardType;
  const typeEmoji = getTypeEmoji(cardType);
  const settings = guildId ? await getOrCreateGuildSettings(guildId) : null;
  const displayMap = guildId ? await getRarityDisplayOverrides(guildId) : null;
  const displayRarity = getCardDisplayRarity(card, ctx, settings, displayMap);
  const shinyPrefix = isShiny ? `${SHINY_EMOJI} ` : "";
  const worth = isShiny ? card.worthValue * SHINY_MULTIPLIER : card.worthValue;
  const embed = new EmbedBuilder()
    .setTitle(`✅ CLAIMED — ${shinyPrefix}${card.name}`)
    .setColor(isShiny ? 0xf1c40f : 0x00b894)
    .setDescription(
      `# 🎉 CLAIMED BY <@${userId}>` +
      (isShiny ? `\n## ${SHINY_EMOJI} **SHINY!** (1 in 200 — counts at ${SHINY_MULTIPLIER}× value)` : "") +
      `\n\u200b`,
    )
    .addFields(
      { name: `${typeEmoji} ${shinyPrefix}${card.name}`, value: card.description || "\u200b", inline: false },
      { name: "Rarity", value: `${displayRarity.emoji} ${displayRarity.label}`, inline: true },
      { name: "Worth", value: `💠 ${worth.toLocaleString()} shards${isShiny ? ` *(${SHINY_MULTIPLIER}×)*` : ""}`, inline: true },
      { name: "Caught by", value: `<@${userId}>`, inline: true },
    )
    .setTimestamp();
  if (card.flavor) embed.setFooter({ text: card.flavor });
  const defaultImg = toAbsoluteImageUrl(card.imageUrl);
  if (defaultImg) embed.setImage(defaultImg);
  await applyEmbedOverride(embed, {
    guildId, key: "claimed", rarity, defaultImageUrl: defaultImg,
    ctx: { userId, card: card.name, rarity: displayRarity.label, worth },
  });
  return embed;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function buildSpawnEmbed(card: Card, windowSeconds: number, mode: "type" | "button" | "both" = "type", guildId: string | null = null, hintLevel = 0, revealFile: string | null = null, appearMessage: string = SPAWN_APPEAR_MESSAGES[0]!): Promise<EmbedBuilder> {
  const rarity = card.rarity as Rarity;
  const cardType = card.cardType;
  const settings = guildId ? await getOrCreateGuildSettings(guildId) : null;
  const displayMap = guildId ? await getRarityDisplayOverrides(guildId) : null;
  const ctx = guildId ? await getRarityContext(guildId) : null;
  const displayRarity = getCardDisplayRarity(card, ctx, settings, displayMap);
  const badges: string[] = [];
  if (card.isLimitedEdition) badges.push("💎 **LIMITED EDITION**");
  if (card.isEventExclusive) badges.push("🎆 **EVENT EXCLUSIVE**");
  if (card.maxCopies) badges.push(`📦 Only ${card.maxCopies - card.totalMinted} copies remaining`);

  const howTo =
    mode === "button" ? `Hit the **🎯 Claim** button to catch this card.`
    : mode === "both" ? `Type the card name **or** hit **🎯 Claim** to catch it.`
    : `Type the card name to catch it.`;

  const hintText = buildHintLines(card.name, hintLevel);
  const embed = new EmbedBuilder()
    .setTitle(appearMessage)
    .setColor(displayRarity.color)
    .setDescription(
      `${badges.length > 0 ? badges.join("\n") + "\n\n" : ""}${howTo}\n\n${hintText}`,
    )
    .addFields(
      { name: `${getTypeEmoji(cardType)} ${maskName(card.name, hintLevel)}`, value: card.description || "\u200b", inline: false },
      { name: "Rarity", value: `${displayRarity.emoji} ${displayRarity.label}`, inline: true },
      { name: "Worth", value: `💠 ${card.worthValue.toLocaleString()} shards`, inline: true },
      { name: "⏱️ Window", value: `${windowSeconds}s`, inline: true },
    )
    .setTimestamp();

  if (card.flavor) embed.setFooter({ text: card.flavor });
  // When an animated reveal GIF is attached, route it through the SAME image
  // pipeline the static card image used, so admin embed overrides (imageMode /
  // customImageUrl / none) keep working unchanged.
  const defaultImg = revealFile ? `attachment://${revealFile}` : toAbsoluteImageUrl(card.imageUrl);
  if (defaultImg) embed.setImage(defaultImg);
  await applyEmbedOverride(embed, {
    guildId, key: "spawn", rarity, defaultImageUrl: defaultImg,
    ctx: { card: card.name, rarity: displayRarity.label, worth: card.worthValue },
  });
  return embed;
}

export async function buildPostDecisionEmbed(
  cardId: number, userId: string, action: "burned" | "kept" | "trade", guildId: string | null = null,
): Promise<EmbedBuilder | null> {
  const cards = await getAllCardsCached(guildId);
  const rawCard = cards.find(c => c.id === cardId);
  if (!rawCard) return null;
  const ctxForDecision = guildId ? await getRarityContext(guildId) : null;
  const card = ctxForDecision ? applyRarityContext(rawCard, ctxForDecision) : rawCard;
  const rarity = card.rarity as Rarity;
  const cardType = card.cardType;

  const titles = {
    burned: `\ud83d\udd25 CAUGHT & BURNED \u2014 ${card.name}`,
    kept:   `\ud83d\udcbe CAUGHT & KEPT \u2014 ${card.name}`,
    trade:  `\ud83d\udd04 CAUGHT & OPEN TO TRADE \u2014 ${card.name}`,
  };
  const descriptions = {
    burned: `\u2705 Caught by <@${userId}> \u2192 \ud83d\udd25 burned for shards\n\n\u200b`,
    kept:   `\u2705 Caught by <@${userId}> \u2192 \ud83d\udcbe kept in collection\n\n\u200b`,
    trade:  `\u2705 Caught by <@${userId}> \u2192 \ud83d\udd04 open to trade!\n\n\u200b`,
  };
  const colors = { burned: 0xe74c3c, kept: 0x00b894, trade: 0x3498db };
  const statusLabels = {
    burned: "\ud83d\udd25 Burned",
    kept:   "\ud83d\udcbe Kept",
    trade:  "\ud83d\udd04 Open to Trade",
  };

  const settings = guildId ? await getOrCreateGuildSettings(guildId) : null;
  const displayMap = guildId ? await getRarityDisplayOverrides(guildId) : null;
  const displayRarity = getCardDisplayRarity(card, ctxForDecision, settings, displayMap);
  const embed = new EmbedBuilder()
    .setTitle(titles[action])
    .setColor(colors[action])
    .setDescription(descriptions[action])
    .addFields(
      { name: `${getTypeEmoji(cardType)} ${card.name}`, value: card.description || "\u200b", inline: false },
      { name: "Rarity", value: `${displayRarity.emoji} ${displayRarity.label}`, inline: true },
      { name: "Worth", value: `\ud83d\udca0 ${card.worthValue.toLocaleString()} shards`, inline: true },
      { name: "Caught by", value: `<@${userId}>`, inline: true },
      { name: "Status", value: statusLabels[action], inline: true },
    )
    .setTimestamp();
  if (card.flavor) embed.setFooter({ text: card.flavor });
  const defaultImg = toAbsoluteImageUrl(card.imageUrl);
  if (defaultImg) embed.setImage(defaultImg);
  await applyEmbedOverride(embed, {
    guildId, key: "claimed", rarity, defaultImageUrl: defaultImg,
    ctx: { userId, card: card.name, rarity: displayRarity.label, worth: card.worthValue },
  });
  return embed;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
