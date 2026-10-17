// Raid manager — the live co-op boss fight. Runs entirely in memory (like live
// battles) since raids never risk a player's cards. Drives a single message
// through: lobby (join / pick card) → simultaneous-action rounds → clear/wipe.

import {
  ChatInputCommandInteraction, ButtonInteraction, StringSelectMenuInteraction,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, MessageFlags, AttachmentBuilder, type Message,
} from "discord.js";
import { randomBytes } from "crypto";
import { db, cardProgressTable } from "@workspace/db";
import type { BattleSettings, RaidBoss } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import type { Combatant, MoveType } from "../battle/types.js";
import type { Rarity } from "../cards-data.js";
import { withGuildFrames } from "../animations/card-frames.js";
import { getOrCreateGuildSettings } from "../db.js";
import { getBattleSettings, rarityAllowed } from "../battle/config-engine.js";
import {
  listBattleItems, getBattleItem, loadGuildBattleItems, applyItemUse, isOffensiveItem,
  type BattleItem,
} from "../battle/items.js";
import { getOwnedBattleCards, getOrCreateProfile } from "../battle/db.js";
import { progTierForFrameId } from "../cards/frames.js";
import { getRarityContext } from "../db.js";
import type { OwnedBattleCard } from "../battle/db.js";
import { bar, WHITE_LINE } from "../battle/embeds.js";
import { statusThemeOf, hudFighter, renderStatusStill, HUD_FILE_PNG } from "../battle/status-hud.js";
import { starString } from "../cards/leveling.js";
import { getStarRankMap } from "../cards/stars.js";
import { toAbsoluteImageUrl } from "../image-url.js";
import { logger } from "../../lib/logger.js";
import { consumeCooldown } from "../../lib/cooldowns.js";
import { getBossByName, getBossById, getEnabledBosses, getNextBoss, grantRaidFrame, getCampaignProgress } from "./db.js";
import { raidFrameForBoss } from "../cards/frames.js";
import { renderAttackFrame } from "../animations/index.js";
import { renderFatalityCinematic } from "../animations/cinematic/index.js";
import { getRarityEffectColor } from "../animations/effects.js";
import { renderSiegeCinematic, SIEGE_CINEMATIC_FILE, type SiegeCinematicView } from "../hq/cinematic.js";
import type { RenderCard } from "../battle/image/render.js";
import {
  buildBossCombatant, buildPlayerCombatant, resolveRaidRound,
  BOSS_USER_ID, type PartyMemberSpec, type RaidBeat,
} from "./engine.js";
import { buildRaidIntroScript, buildRaidIntroBeats, buildRaidClearLine, buildRaidWipeLine } from "./story.js";
import {
  renderRaidIntro, renderRaidWipeScene, renderCampaignProgress,
  RAID_INTRO_FILE, RAID_WIPE_FILE, RAID_CAMPAIGN_FILE,
} from "./canvas.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;
const MAX_ROUNDS = 25;
const ROUND_TIMEOUT_MS = 60_000;
// Boss cards enter a winner's collection battle-ready — close to maxed
// (MAX_LEVEL is 100) rather than starting at level 1 like a normal catch.
const BOSS_CARD_REWARD_LEVEL = 50;
const RAID_ATTACK_FILE = "raid-attack.png";
// Must end in .gif — Discord animates an embed image by attachment extension.
const RAID_FATALITY_FILE = "raid-fatality.gif";
// The boss is "finishable" once it drops to this fraction of max HP: the party
// can choose to end it with a 💀 Fatality cinematic instead of a normal clear.
const RAID_FATALITY_HP_FRACTION = 0.10;
// Each raider carries a small satchel of field items for the whole raid — med
// kits, shields, grenades — usable on themselves, a teammate, or the boss.
const RAID_ITEM_USES = 3;
const RAID_BEAT_MS = 1100;   // hold per animated hit
const RAID_TICK_MS = 550;    // hold per text-only beat (status ticks)
const RAID_MAX_ANIM_BEATS = 10; // cap frames per round so big parties stay snappy
const LOBBY_TTL_MS = 5 * 60_000;

interface PartySlot {
  member: PartyMemberSpec;
  combatant?: Combatant;
}

interface RaidSession {
  id: string;
  guildId: string;
  channelId: string;
  starterId: string;
  boss: RaidBoss;
  settings: BattleSettings;
  phase: "lobby" | "intro" | "fight" | "ended";
  party: Map<string, PartySlot>;   // userId → slot
  accepted: Set<string>;           // during "intro": who has hit Accept
  bossCombatant?: Combatant;
  roundNumber: number;
  pendingActions: Map<string, MoveType>;
  // Field-item support: how many item uses each member has left for the whole
  // raid, and who has already spent their action on an item THIS round (so they
  // can't also attack). Reset per round in resolveRound.
  itemUsesLeft: Map<string, number>;
  itemUsedThisRound: Set<string>;
  resolving: boolean;
  recentLog: string[];
  message?: Message;
  timer?: NodeJS.Timeout;
  // Rendered once at Begin (boss vs the party's cards on the battlefield) and
  // re-attached on every fight edit so the arena stays on screen all fight.
  introImage?: Buffer | null;
  // Set when a party member lands a 💀 Fatality on the boss — drives the
  // cinematic end-screen. `null` for every normal clear/wipe/timeout.
  fatality?: { userName: string; winner: RenderCard } | null;
}

const sessions = new Map<string, RaidSession>();
const userSession = new Map<string, string>(); // "guild:user" → sessionId

// ── Reward store ─────────────────────────────────────────────────────────────
// A cleared raid's claimable rewards. Lives independently of the (torn-down)
// session so winners can claim after the fight, and self-expires. In-memory to
// match the rest of the raid runtime (a restart ends active raids anyway).
interface RaidReward {
  guildId: string;
  bossName: string;
  cardId: number | null;
  cardName: string | null;
  frameId: string;
  frameName: string;
  frameEmoji: string;
  winners: Set<string>;         // eligible userIds (survivors)
  choice: Map<string, "frame" | "card">; // userId → what they claimed
  channelId: string;             // where the final raid embed lives
  messageId: string | null;      // so we can delete it once everyone has claimed
}
const raidRewards = new Map<string, RaidReward>();
const REWARD_TTL_MS = 30 * 60_000;

function uKey(guildId: string, userId: string): string { return `${guildId}:${userId}`; }

/** Is this user currently in a live raid lobby/fight? Used for battle↔raid exclusion. */
export function isUserInRaid(guildId: string, userId: string): boolean {
  return userSession.has(uKey(guildId, userId));
}

function livingSlots(session: RaidSession): PartySlot[] {
  return [...session.party.values()].filter(s => (s.combatant?.hp ?? 0) > 0);
}

function newId(): string { return randomBytes(4).toString("hex"); }

// ── Entry: /raid start ───────────────────────────────────────────────────────
export async function startRaid(interaction: ChatInputCommandInteraction, bossName: string): Promise<void> {
  const guild = interaction.guild;
  if (!guild) { await interaction.reply({ content: "Raids can only be started in a server.", ...EPHEMERAL }); return; }
  const guildId = guild.id;
  const settings = await getBattleSettings(guildId);
  if (!settings.enabled || !settings.setupComplete) {
    await interaction.reply({ content: "🛠️ The battle system must be set up first (`/battle_admin` → Setup Wizard).", ...EPHEMERAL });
    return;
  }
  if (userSession.has(uKey(guildId, interaction.user.id))) {
    await interaction.reply({ content: "You're already in a raid. Finish or leave it first.", ...EPHEMERAL });
    return;
  }
  // Mutual exclusion: you must finish a live battle before starting a raid.
  const { getUserLock } = await import("../battle/db.js");
  if (await getUserLock(guildId, interaction.user.id)) {
    await interaction.reply({ content: "⚔️ Finish your current **battle** before starting a raid.", ...EPHEMERAL });
    return;
  }
  // Cooldown: no back-to-back raids.
  const cd = await consumeCooldown("raid", guildId, interaction.user.id);
  if (!cd.ok) { await interaction.reply({ content: cd.message ?? "You're on cooldown.", ...EPHEMERAL }); return; }
  const boss = await getBossByName(guildId, bossName);
  if (!boss || !boss.enabled) {
    await interaction.reply({ content: `❌ No enabled boss called "**${bossName}**". Ask an admin to create one with \`/raid_admin create\`, or see \`/raid bosses\`.`, ...EPHEMERAL });
    return;
  }

  const id = newId();
  const session: RaidSession = {
    id, guildId, channelId: interaction.channelId!, starterId: interaction.user.id,
    boss, settings, phase: "lobby", party: new Map(), accepted: new Set(), roundNumber: 1,
    pendingActions: new Map(), itemUsesLeft: new Map(), itemUsedThisRound: new Set(),
    resolving: false, recentLog: [],
  };
  sessions.set(id, session);

  await interaction.reply({ embeds: [buildLobbyEmbed(session)], components: buildLobbyComponents(session) });
  session.message = await interaction.fetchReply() as Message;
  armTimer(session, LOBBY_TTL_MS);
}

// ── Component router (buttons + select) ──────────────────────────────────────
export async function handleRaidComponent(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): Promise<void> {
  const parts = interaction.customId.split(":"); // raid:<action>:<sid>[:extra]
  const action = parts[1];
  const sid = parts[2]!;

  // Reward-claim actions outlive the raid session (the fight is torn down, but
  // winners still claim afterward), so they route to the reward store first.
  if (action === "reward" || action === "rwframe" || action === "rwcard") {
    return handleRaidReward(interaction as ButtonInteraction, action, sid);
  }
  // Campaign end-screen buttons also outlive the session.
  if (action === "next") return handleContinueToNext(interaction as ButtonInteraction, Number(sid));
  if (action === "hub") return showCampaignHub(interaction as ButtonInteraction);

  const session = sessions.get(sid);
  if (!session) {
    await interaction.reply({ content: "⌛ This raid has ended or expired.", ...EPHEMERAL }).catch(() => {});
    return;
  }
  switch (action) {
    case "join": return handleJoin(interaction as ButtonInteraction, session);
    case "pick": return handlePick(interaction as StringSelectMenuInteraction, session);
    case "leave": return handleLeave(interaction as ButtonInteraction, session);
    case "begin": return handleBegin(interaction as ButtonInteraction, session);
    case "accept": return handleAccept(interaction as ButtonInteraction, session);
    case "decline": return handleDecline(interaction as ButtonInteraction, session);
    case "cancel": return handleCancel(interaction as ButtonInteraction, session);
    case "act": return handleAct(interaction as ButtonInteraction, session, parts[3] as MoveType);
    case "item": return handleItemOpen(interaction as ButtonInteraction, session);
    case "itemsel": return handleItemSelect(interaction as StringSelectMenuInteraction, session);
    case "itemtgt": return handleItemTarget(interaction as StringSelectMenuInteraction, session, parts[3]!);
    case "fatality": return handleRaidFatality(interaction as ButtonInteraction, session);
    default:
      await interaction.reply({ content: "Unknown raid action.", ...EPHEMERAL }).catch(() => {});
  }
}

// ── Lobby: join → pick a card ────────────────────────────────────────────────
async function handleJoin(interaction: ButtonInteraction, session: RaidSession): Promise<void> {
  if (session.phase !== "lobby") { await interaction.reply({ content: "This raid has already started.", ...EPHEMERAL }); return; }
  const userId = interaction.user.id;
  if (session.party.has(userId)) { await interaction.reply({ content: "You're already in this raid. Pick again below to swap your card.", ...EPHEMERAL }); return; }
  if (session.party.size >= session.boss.maxPlayers) { await interaction.reply({ content: "This raid party is full.", ...EPHEMERAL }); return; }
  const otherSid = userSession.get(uKey(session.guildId, userId));
  if (otherSid && otherSid !== session.id) { await interaction.reply({ content: "You're already in another raid.", ...EPHEMERAL }); return; }

  const { eligible, reason } = await eligibleCards(session, userId);
  if (eligible.length === 0) {
    await interaction.reply({ content: reason ?? "You have no cards eligible for this raid.", ...EPHEMERAL });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`raid:pick:${session.id}`)
    .setPlaceholder("Choose the card you'll bring to the raid")
    .addOptions(eligible.slice(0, 25).map(e => ({
      label: `${e.card.name}`.slice(0, 100),
      description: `${e.card.rarity} · Lv ${e.level} · ${starString(e.stars)}`.slice(0, 100),
      value: String(e.card.id),
    })));
  await interaction.reply({
    content: "🃏 Pick your fighter for this raid:",
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    ...EPHEMERAL,
  });
}

async function handlePick(interaction: StringSelectMenuInteraction, session: RaidSession): Promise<void> {
  if (session.phase !== "lobby") { await interaction.update({ content: "This raid has already started.", components: [] }).catch(() => {}); return; }
  const userId = interaction.user.id;
  const cardId = parseInt(interaction.values[0], 10);
  const { eligible } = await eligibleCards(session, userId);
  const pick = eligible.find(e => e.card.id === cardId);
  if (!pick) { await interaction.update({ content: "That card is no longer eligible.", components: [] }).catch(() => {}); return; }

  session.party.set(userId, {
    member: {
      userId, displayName: interaction.user.username,
      avatarUrl: interaction.user.displayAvatarURL({ extension: "png", size: 128 }),
      card: pick.card, cardLevel: pick.level, cardStars: pick.stars,
    },
  });
  userSession.set(uKey(session.guildId, userId), session.id);
  await interaction.update({ content: `✅ You joined with **${pick.card.name}** (${starString(pick.stars)}).`, components: [] }).catch(() => {});
  await refreshLobby(session);
}

async function handleLeave(interaction: ButtonInteraction, session: RaidSession): Promise<void> {
  const userId = interaction.user.id;
  if (session.phase === "fight") { await interaction.reply({ content: "You can't leave once the fight has started — see it through!", ...EPHEMERAL }); return; }
  if (!session.party.has(userId)) { await interaction.reply({ content: "You're not in this raid.", ...EPHEMERAL }); return; }
  session.party.delete(userId);
  userSession.delete(uKey(session.guildId, userId));
  await interaction.reply({ content: "👋 You left the raid party.", ...EPHEMERAL });
  await refreshLobby(session);
}

async function handleCancel(interaction: ButtonInteraction, session: RaidSession): Promise<void> {
  if (interaction.user.id !== session.starterId) { await interaction.reply({ content: "Only the raid starter can cancel.", ...EPHEMERAL }); return; }
  await interaction.reply({ content: "🚫 Raid cancelled.", ...EPHEMERAL });
  if (session.message) {
    await session.message.edit({ embeds: [new EmbedBuilder().setTitle("🚫 Raid cancelled").setColor(0x95a5a6).setDescription(`The raid on **${session.boss.name}** was cancelled.`)], components: [] }).catch(() => {});
  }
  teardown(session);
}

// Begin → play a short intro cutscene (small boss portrait + story beats), then
// present Accept / Back Out. The fight only commits once the starter Accepts.
async function handleBegin(interaction: ButtonInteraction, session: RaidSession): Promise<void> {
  if (interaction.user.id !== session.starterId) { await interaction.reply({ content: "Only the raid starter can begin the fight.", ...EPHEMERAL }); return; }
  if (session.phase !== "lobby") { await interaction.reply({ content: "The fight has already started.", ...EPHEMERAL }); return; }
  if (session.party.size < session.boss.minPlayers) {
    await interaction.reply({ content: `You need at least **${session.boss.minPlayers}** players to start this raid.`, ...EPHEMERAL });
    return;
  }
  await interaction.deferUpdate().catch(() => {});
  session.phase = "intro";
  session.accepted = new Set();
  if (session.timer) { clearTimeout(session.timer); session.timer = undefined; }
  void runIntroCutscene(session);
}

// ── Intro cutscene: small boss portrait + 3 story beats → Accept / Back Out ───
const INTRO_BEAT_MS = 2600;

async function runIntroCutscene(session: RaidSession): Promise<void> {
  if (!session.message) return;
  const beats = buildRaidIntroBeats(session.boss);
  const thumb = toAbsoluteImageUrl(session.boss.imageUrl);

  // Opening film first: the same cinematic the HQ siege uses, but the thing on
  // the ridge is the BOSS and the party's cards fly in — with the intro script
  // typed over it word-for-word. Best-effort; on any failure we fall straight
  // through to the classic text cutscene below (which is preserved as-is).
  await playRaidCinematic(session, beats).catch(() => {});
  if (session.phase !== "intro" || !session.message) return;

  const beatEmbed = (idx: number, withButtons: boolean) => {
    const e = new EmbedBuilder()
      .setTitle(`🐉 ${session.boss.name}`)
      .setColor(0xc0392b)
      .setDescription(beats.slice(0, idx + 1).join("\n\n"))
      .setFooter({ text: withButtons ? "Accept to enter the arena · Back Out to leave the party" : "…" });
    if (thumb) e.setThumbnail(thumb);
    return e;
  };

  // Beat 1 immediately (buttons hidden), then reveal the rest on a timer. Guard
  // every edit on the session still being in the intro phase. `files: []` clears
  // the cinematic attachment so the text cutscene starts clean.
  await session.message.edit({ embeds: [beatEmbed(0, false)], components: [], files: [] }).catch(() => {});
  for (let i = 1; i < beats.length; i++) {
    await sleep(INTRO_BEAT_MS);
    if (session.phase !== "intro" || !session.message) return;
    const last = i === beats.length - 1;
    await session.message.edit({
      embeds: [beatEmbed(i, last)],
      components: last ? buildIntroComponents(session) : [],
    }).catch(() => {});
  }
  // Auto-expire the intro if nobody accepts.
  armIntroTimer(session);
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

// Roughly the raid cinematic's runtime (see renderSiegeCinematic's boss path),
// so the film plays out before the text cutscene replaces it.
const RAID_CINEMATIC_HOLD_MS = 5600;

// A raid's weather, derived from the boss's rarity so bigger bosses arrive under
// a heavier sky. Deterministic per boss.
function moodForBoss(boss: RaidBoss): SiegeCinematicView["mood"] {
  switch (boss.rarity) {
    case "mythic": return "ash";
    case "legendary": return "night";
    case "epic": return "storm";
    case "rare": return "dusk";
    default: return "dawn";
  }
}

// The party's banner name for the cinematic's attacker caption.
function partyBannerName(session: RaidSession): string {
  const starter = session.party.get(session.starterId)?.member.displayName
    ?? [...session.party.values()][0]?.member.displayName ?? "The Party";
  return session.party.size <= 1 ? starter : `${starter}'s Party`;
}

// Render + play the boss-raid opening film into the raid message. Reuses the HQ
// siege cinematic engine in its "boss" mode. Best-effort — the caller falls
// through to the classic text cutscene if this returns without posting.
async function playRaidCinematic(session: RaidSession, beats: string[]): Promise<void> {
  if (!session.message || session.phase !== "intro") return;
  const boss = session.boss;
  const party = [...session.party.values()].map(s => s.member);
  const view: SiegeCinematicView = {
    kind: "boss",
    targetName: boss.name,
    holderName: `${(boss.rarity as string).toUpperCase()} BOSS`,
    defenderColor: getRarityEffectColor(boss.rarity as Rarity),
    attackerColor: 0x4aa3ff,
    attackerName: partyBannerName(session),
    cards: party.slice(0, 5).map(m => ({
      name: m.card.name,
      artUrl: toAbsoluteImageUrl(m.card.imageUrl),
      rarityColor: getRarityEffectColor(m.card.rarity as Rarity),
    })),
    garrison: 0,
    structure: "boss",
    mood: moodForBoss(boss),
    bossArtUrl: toAbsoluteImageUrl(boss.imageUrl),
    beats,
    titleText: "THE RAID BEGINS",
    tagline: boss.description ?? undefined,
  };

  const buf = await renderSiegeCinematic(view).catch(() => null);
  if (!buf || session.phase !== "intro" || !session.message) return;
  const embed = new EmbedBuilder()
    .setTitle(`🎥 ${view.attackerName} march on ${boss.name}`)
    .setColor(0xc0392b)
    .setDescription(`_The horns sound. The party descends on **${boss.name}**._`)
    .setImage(`attachment://${SIEGE_CINEMATIC_FILE}`);
  await session.message.edit({
    embeds: [embed], components: [],
    files: [new AttachmentBuilder(buf, { name: SIEGE_CINEMATIC_FILE })],
  }).catch(() => {});
  await sleep(RAID_CINEMATIC_HOLD_MS);
}

function buildIntroComponents(session: RaidSession): ActionRowBuilder<ButtonBuilder>[] {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`raid:accept:${session.id}`).setLabel("Accept — Let the Raid Begin!").setEmoji("⚔️").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`raid:decline:${session.id}`).setLabel("Back Out").setEmoji("🚪").setStyle(ButtonStyle.Danger),
  )];
}

function armIntroTimer(session: RaidSession): void {
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    if (session.phase === "intro" && session.message) {
      session.message.edit({ embeds: [new EmbedBuilder().setTitle("⌛ Raid expired").setColor(0x95a5a6).setDescription(`The party hesitated too long before **${session.boss.name}**.`)], components: [] }).catch(() => {});
      teardown(session);
    }
  }, LOBBY_TTL_MS);
}

async function handleAccept(interaction: ButtonInteraction, session: RaidSession): Promise<void> {
  if (session.phase !== "intro") { await interaction.reply({ content: "The raid isn't waiting to start.", ...EPHEMERAL }); return; }
  const userId = interaction.user.id;
  if (!session.party.has(userId)) { await interaction.reply({ content: "You're not in this raid party.", ...EPHEMERAL }); return; }
  session.accepted.add(userId);

  // The starter's Accept launches the fight (as long as the party still meets
  // the minimum). Everyone else's Accept just marks them ready.
  if (userId === session.starterId) {
    if (session.party.size < session.boss.minPlayers) {
      await interaction.reply({ content: `Too many backed out — you need **${session.boss.minPlayers}** fighters. Wait for more or Back Out.`, ...EPHEMERAL });
      return;
    }
    await interaction.deferUpdate().catch(() => {});
    await commenceFight(session);
    return;
  }
  await interaction.reply({ content: "⚔️ Ready! Waiting for the starter to launch the raid…", ...EPHEMERAL });
}

async function handleDecline(interaction: ButtonInteraction, session: RaidSession): Promise<void> {
  const userId = interaction.user.id;
  if (session.phase !== "intro") { await interaction.reply({ content: "You can't back out now.", ...EPHEMERAL }); return; }
  if (!session.party.has(userId)) { await interaction.reply({ content: "You're not in this raid.", ...EPHEMERAL }); return; }

  // The starter backing out cancels the whole raid.
  if (userId === session.starterId) {
    await interaction.deferUpdate().catch(() => {});
    if (session.message) {
      await session.message.edit({ embeds: [new EmbedBuilder().setTitle("🚫 Raid called off").setColor(0x95a5a6).setDescription(`The starter backed out of the raid on **${session.boss.name}**.`)], components: [] }).catch(() => {});
    }
    teardown(session);
    return;
  }
  session.party.delete(userId);
  session.accepted.delete(userId);
  userSession.delete(uKey(session.guildId, userId));
  await interaction.reply({ content: "🚪 You backed out of the raid.", ...EPHEMERAL });
}

// Commit the fight: build combatants, render the VS arena, start round 1.
async function commenceFight(session: RaidSession): Promise<void> {
  if (session.timer) { clearTimeout(session.timer); session.timer = undefined; }
  session.phase = "fight";
  // Field items: preload the guild's item registry and hand every member their
  // satchel for the fight. Best-effort — a load failure just keeps code defaults.
  await loadGuildBattleItems(session.guildId).catch(() => {});
  for (const userId of session.party.keys()) session.itemUsesLeft.set(userId, RAID_ITEM_USES);
  session.itemUsedThisRound.clear();
  const party = [...session.party.values()].map(s => s.member);
  // Guild rarity ladder so raid stats + boss scaling rank custom/reordered tiers
  // the same way PvP battles do.
  const rarityCtx = await getRarityContext(session.guildId);
  session.bossCombatant = buildBossCombatant(session.boss, session.settings, party, rarityCtx);
  for (const slot of session.party.values()) {
    slot.combatant = buildPlayerCombatant(slot.member, session.settings, rarityCtx);
  }

  // VS arena canvas: boss (prominent) vs the party's cards on the battlefield.
  // Rendered once and reused as the fight image every round. Best-effort.
  session.introImage = await withGuildFrames(await getOrCreateGuildSettings(session.guildId).catch(() => null), () => renderRaidIntro(
    {
      name: session.boss.name,
      imageUrl: toAbsoluteImageUrl(session.boss.imageUrl),
      rarity: session.boss.rarity as Rarity,
      battlefieldUrl: toAbsoluteImageUrl(session.boss.battlefieldUrl),
    },
    party.map(m => ({
      name: m.card.name,
      imageUrl: toAbsoluteImageUrl(m.card.imageUrl),
      rarity: m.card.rarity as Rarity,
      progTier: progTierForFrameId(m.card.equippedFrame),
      stars: m.cardStars,
    })),
  )).catch(() => null);

  session.recentLog = [`⚔️ The party descends on **${session.boss.name}**! Choose your actions.`];
  await renderFight(session);
  armRoundTimer(session);
}

// ── Fight: collect one action per living player, then resolve ─────────────────
async function handleAct(interaction: ButtonInteraction, session: RaidSession, move: MoveType): Promise<void> {
  if (session.phase !== "fight") { await interaction.reply({ content: "The raid isn't in a fighting phase.", ...EPHEMERAL }); return; }
  const slot = session.party.get(interaction.user.id);
  if (!slot || !slot.combatant) { await interaction.reply({ content: "You're not in this raid.", ...EPHEMERAL }); return; }
  if (slot.combatant.hp <= 0) { await interaction.reply({ content: "💀 Your fighter is down — the rest of the party fights on.", ...EPHEMERAL }); return; }
  if (session.resolving) { await interaction.reply({ content: "The round is resolving — hang on.", ...EPHEMERAL }); return; }
  if (session.itemUsedThisRound.has(interaction.user.id)) { await interaction.reply({ content: "🎒 You already used an item this round — that was your action.", ...EPHEMERAL }); return; }

  session.pendingActions.set(interaction.user.id, move);
  // No ephemeral "locked in" reply — those piled up and shoved the raid board
  // off-screen. Silently ack the button; the player's ✅ + the "locked in" count
  // now appear on the single raid board embed itself (like the battle log does).
  await interaction.deferUpdate().catch(() => {});

  const living = livingSlots(session);
  if (living.every(s => session.pendingActions.has(s.member.userId))) {
    await resolveRound(session);
  } else {
    // Refresh the board in place so everyone sees who has locked in.
    await renderFight(session);
  }
}

// ── Field items (heal a teammate, shield up, grenade the boss) ────────────────
// A member's item use IS their action for the round: it applies immediately (so
// you can save a teammate before the boss strikes) and braces them. Each member
// has RAID_ITEM_USES for the whole raid.
function canUseItem(session: RaidSession, userId: string): { slot: PartySlot } | { error: string } {
  if (session.phase !== "fight") return { error: "The raid isn't in a fighting phase." };
  if (session.resolving) return { error: "The round is resolving — hang on." };
  const slot = session.party.get(userId);
  if (!slot || !slot.combatant) return { error: "You're not in this raid." };
  if (slot.combatant.hp <= 0) return { error: "💀 Your fighter is down — you can't use items." };
  if (session.itemUsedThisRound.has(userId)) return { error: "🎒 You already used an item this round." };
  if ((session.itemUsesLeft.get(userId) ?? 0) <= 0) return { error: "🎒 You're out of field items for this raid." };
  return { slot };
}

async function handleItemOpen(interaction: ButtonInteraction, session: RaidSession): Promise<void> {
  const chk = canUseItem(session, interaction.user.id);
  if ("error" in chk) { await interaction.reply({ content: chk.error, ...EPHEMERAL }); return; }
  const items = listBattleItems(session.guildId).slice(0, 25);
  if (items.length === 0) { await interaction.reply({ content: "No usable items are configured on this server.", ...EPHEMERAL }); return; }
  const left = session.itemUsesLeft.get(interaction.user.id) ?? 0;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`raid:itemsel:${session.id}`)
    .setPlaceholder("Choose a field item to use")
    .addOptions(items.map(it => ({
      label: it.name.slice(0, 100),
      description: it.description.slice(0, 100),
      emoji: it.emoji || undefined,
      value: it.id,
    })));
  await interaction.reply({
    content: `🎒 **Field items** — **${left}** use(s) left this raid.\nSupport items can go to you *or a teammate*; offensive items hit the boss.`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    ...EPHEMERAL,
  });
}

async function handleItemSelect(interaction: StringSelectMenuInteraction, session: RaidSession): Promise<void> {
  const chk = canUseItem(session, interaction.user.id);
  if ("error" in chk) { await interaction.update({ content: chk.error, components: [] }).catch(() => {}); return; }
  const item = getBattleItem(interaction.values[0], session.guildId);
  if (!item) { await interaction.update({ content: "That item is no longer available.", components: [] }).catch(() => {}); return; }

  // Offensive items go straight at the boss — no target to choose.
  if (isOffensiveItem(item)) { await applyRaidItem(session, interaction, item, BOSS_USER_ID); return; }

  // Support items: choose a target (self or any teammate). Heals may target a
  // downed ally — they REVIVE them.
  const canRevive = item.effectType === "heal";
  const targets = [...session.party.values()].filter(s => s.combatant && (canRevive || s.combatant.hp > 0));
  const opts = targets.map(s => {
    const c = s.combatant!;
    const me = s.member.userId === interaction.user.id;
    const downed = c.hp <= 0;
    return {
      label: `${me ? "Yourself" : s.member.displayName} — ${c.cardName}`.slice(0, 100),
      description: (downed ? "downed — revive" : `${c.hp}/${c.stats.maxHealth} HP`).slice(0, 100),
      value: s.member.userId,
    };
  });
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`raid:itemtgt:${session.id}:${item.id}`)
    .setPlaceholder(`Who gets the ${item.name}?`.slice(0, 100))
    .addOptions(opts.slice(0, 25));
  await interaction.update({
    content: `${item.emoji} **${item.name}** — ${item.description}\nChoose who to use it on:`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  }).catch(() => {});
}

async function handleItemTarget(interaction: StringSelectMenuInteraction, session: RaidSession, itemId: string): Promise<void> {
  const chk = canUseItem(session, interaction.user.id);
  if ("error" in chk) { await interaction.update({ content: chk.error, components: [] }).catch(() => {}); return; }
  const item = getBattleItem(itemId, session.guildId);
  if (!item) { await interaction.update({ content: "That item is no longer available.", components: [] }).catch(() => {}); return; }
  await applyRaidItem(session, interaction, item, interaction.values[0]!);
}

// Apply an item from the acting user onto a target (a teammate userId or the
// boss), consume a use + the round action, log it, then refresh/resolve.
async function applyRaidItem(
  session: RaidSession,
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  item: BattleItem,
  targetId: string,
): Promise<void> {
  const userId = interaction.user.id;
  const actor = session.party.get(userId)?.combatant;
  if (!actor) { await interaction.update({ content: "You're not in this raid.", components: [] }).catch(() => {}); return; }

  const target = targetId === BOSS_USER_ID
    ? session.bossCombatant
    : session.party.get(targetId)?.combatant;
  if (!target) { await interaction.update({ content: "That target is no longer in the fight.", components: [] }).catch(() => {}); return; }

  const outcome = applyItemUse(item, actor, target);
  // Consume: one satchel use + this round's action (they brace).
  session.itemUsesLeft.set(userId, Math.max(0, (session.itemUsesLeft.get(userId) ?? 1) - 1));
  session.itemUsedThisRound.add(userId);
  session.pendingActions.set(userId, "defend");

  for (const e of outcome.events) session.recentLog.push(e.text);
  session.recentLog = session.recentLog.slice(-8);

  await interaction.update({
    content: `${item.emoji} Used **${item.name}**. ${outcome.events[0]?.text ?? ""}`.slice(0, 400),
    components: [],
  }).catch(() => {});

  // Grenading the boss can finish it outright.
  if (targetId === BOSS_USER_ID && (session.bossCombatant?.hp ?? 1) <= 0) {
    await finishRaid(session, "clear");
    return;
  }

  const living = livingSlots(session);
  if (living.length && living.every(s => session.pendingActions.has(s.member.userId))) {
    await resolveRound(session);
  } else {
    await renderFight(session);
  }
}

// Is the boss finishable — low enough that the party may end it with a Fatality
// cinematic this round? Reads HP only; the option is offered co-op (any living
// member may take the finishing blow).
function raidFatalityReady(session: RaidSession): boolean {
  const boss = session.bossCombatant;
  if (!boss || session.phase !== "fight" || session.resolving) return false;
  return boss.hp > 0 && boss.hp <= boss.stats.maxHealth * RAID_FATALITY_HP_FRACTION;
}

// A party member lands the finishing blow: end the raid as a clear immediately,
// preserving the exact clear/rewards/XP/frame/card path — only the end-screen
// image changes to the Fatality cinematic (via session.fatality).
async function handleRaidFatality(interaction: ButtonInteraction, session: RaidSession): Promise<void> {
  if (session.phase !== "fight") { await interaction.reply({ content: "The raid isn't in a fighting phase.", ...EPHEMERAL }); return; }
  const slot = session.party.get(interaction.user.id);
  if (!slot || !slot.combatant) { await interaction.reply({ content: "You're not in this raid.", ...EPHEMERAL }); return; }
  if (slot.combatant.hp <= 0) { await interaction.reply({ content: "💀 Your fighter is down — you can't land the finisher.", ...EPHEMERAL }); return; }
  if (session.resolving) { await interaction.reply({ content: "The round is resolving — hang on.", ...EPHEMERAL }); return; }
  if (!raidFatalityReady(session)) { await interaction.reply({ content: "The boss isn't finishable yet — wear it down more first.", ...EPHEMERAL }); return; }

  await interaction.deferUpdate().catch(() => {});
  session.resolving = true;                     // freeze the round loop
  if (session.timer) { clearTimeout(session.timer); session.timer = undefined; }
  const boss = session.bossCombatant!;
  boss.hp = 0;                                  // the finishing blow
  session.recentLog.push(`💀 **${slot.member.displayName}** used FATALITY!`);
  session.recentLog = session.recentLog.slice(-8);
  session.fatality = {
    userName: slot.member.displayName,
    winner: {
      name: slot.member.card.name,
      rarity: slot.member.card.rarity as Rarity,
      rarityLabel: (slot.member.card.rarity as string).toUpperCase(),
      cardType: slot.member.card.cardType,
      artUrl: toAbsoluteImageUrl(slot.member.card.imageUrl),
    },
  };
  await finishRaid(session, "clear");
}

async function resolveRound(session: RaidSession): Promise<void> {
  if (session.resolving || session.phase !== "fight") return;
  session.resolving = true;
  if (session.timer) { clearTimeout(session.timer); session.timer = undefined; }

  try {
    const boss = session.bossCombatant!;
    const players = [...session.party.values()].map(s => s.combatant!);
    const result = resolveRaidRound({
      settings: session.settings, boss, players,
      actions: session.pendingActions, roundNumber: session.roundNumber,
      enrageTurn: session.boss.enrageTurn,
    });
    session.pendingActions.clear();
    session.itemUsedThisRound.clear();

    // Replay the round hit-by-hit through the SHARED battle animation pipeline
    // (boss-intensity attack frames), or fall back to a single log update when
    // animations are off. Either way recentLog ends on the last events.
    if (session.settings.battleAnimationEnabled && result.beats.length) {
      await playRaidBeats(session, result.beats);
    } else {
      session.recentLog = result.events.map(e => e.text).slice(-8);
    }

    if (result.bossKoed) { await finishRaid(session, "clear"); return; }
    if (result.wiped) { await finishRaid(session, "wipe"); return; }
    if (session.roundNumber >= MAX_ROUNDS) { await finishRaid(session, "timeout"); return; }

    session.roundNumber++;
    session.resolving = false;
    await renderFight(session);
    armRoundTimer(session);
  } catch (err) {
    logger.error({ err, raidId: session.id }, "raid round resolution failed");
    session.resolving = false;
  }
}

// Replay a resolved round beat-by-beat: render each hit's attack frame (the same
// renderer battles use, with boss intensity) and edit the board with the beat's
// HP snapshot, so the party watches the fight unfold. Best-effort — a failed
// render just skips that frame's image.
async function playRaidBeats(session: RaidSession, beats: RaidBeat[]): Promise<void> {
  if (!session.message) return;
  let animated = 0;
  for (const beat of beats) {
    for (const t of beat.texts) session.recentLog.push(t);
    session.recentLog = session.recentLog.slice(-8);

    let image: Buffer | null = null;
    const wantsFrame = beat.attacker && beat.visual && animated < RAID_MAX_ANIM_BEATS;
    if (wantsFrame) {
      // Try the animated GIF first (both attacker + defender cards, lunge, HP bars).
      // Falls back to the lightweight static PNG if GIF encoding fails/overflows.
      image = await renderAttackFrame({
        attacker: beat.attacker!,
        moveName: beat.moveName ?? "Attack",
        damage: beat.visual!.damage,
        isCrit: beat.visual!.isCrit,
        isHit: beat.visual!.isHit,
        scene: beat.visual!.scene,
        subtitle: beat.visual!.subtitle,
        boss: true,
      }).catch(() => null);
      if (image) animated++;
    }

    const files = image ? [new AttachmentBuilder(image, { name: RAID_ATTACK_FILE })] : [];
    const hud = await raidStatusHud(session, beat.bossHp, beat.partyHp);
    if (hud) files.push(hud.file);
    const embeds = buildFightEmbeds(session, {
      bossHp: beat.bossHp, partyHp: beat.partyHp,
      attackFile: image ? RAID_ATTACK_FILE : undefined,
      metersInImage: !!hud,
    });
    if (hud) embeds.splice(1, 0, hud.embed);
    await session.message.edit({
      embeds,
      components: [],
      files,
    }).catch(() => {});
    await sleep(image ? RAID_BEAT_MS : RAID_TICK_MS);
  }
}

function armRoundTimer(session: RaidSession): void {
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => { void resolveRound(session); }, ROUND_TIMEOUT_MS);
}

// ── Rewards / end ────────────────────────────────────────────────────────────
async function finishRaid(session: RaidSession, outcome: "clear" | "wipe" | "timeout"): Promise<void> {
  session.phase = "ended";
  if (session.timer) { clearTimeout(session.timer); session.timer = undefined; }
  const boss = session.boss;

  let rewardNote = "";
  if (outcome === "clear") {
    const survivors = [...session.party.values()].filter(s => (s.combatant?.hp ?? 0) > 0);
    const { addShards } = await import("../db.js");
    const { grantCardBattleXp } = await import("../cards/leveling.js");
    for (const s of survivors) {
      await addShards(session.guildId, s.member.userId, boss.rewardShards).catch(() => {});
      await grantCardBattleXp(session.guildId, s.member.userId, s.member.card.id, s.member.card.rarity as Rarity, "win", boss.rewardCardXp).catch(() => {});
    }
    // Downed members still get a consolation of card XP (a "loss").
    for (const s of session.party.values()) {
      if ((s.combatant?.hp ?? 0) > 0) continue;
      await grantCardBattleXp(session.guildId, s.member.userId, s.member.card.id, s.member.card.rarity as Rarity, "loss").catch(() => {});
    }
    rewardNote = `🏆 **Victory!** ${survivors.length} survivor(s) each earned 💠 **${boss.rewardShards.toLocaleString()}** and +${boss.rewardCardXp} card XP.`;
    try {
      const { recordQuestEvent } = await import("../quests/engine.js");
      for (const s of survivors) await recordQuestEvent(session.guildId, s.member.userId, "battle_win", 1);
    } catch { /* non-fatal */ }

    // Campaign progression: record EVERY participant's clear of this boss (they
    // were part of the winning party). First clear grants the "🏆 Boss Defeated!"
    // achievement row + a small one-time bonus; finishing the ladder crowns them.
    try {
      const { markBossCleared, getCampaignProgress } = await import("./db.js");
      const { grantAchievement } = await import("../achievements.js");
      const { awardPlayerXp, XP } = await import("../player/xp.js");
      const FIRST_CLEAR_BONUS = 250;
      for (const s of session.party.values()) {
        const firstClear = await markBossCleared(session.guildId, s.member.userId, boss.id).catch(() => false);
        if (!firstClear) continue;
        await addShards(session.guildId, s.member.userId, FIRST_CLEAR_BONUS).catch(() => {});
        await awardPlayerXp(session.guildId, s.member.userId, "achievement", XP.achievement).catch(() => {});
        const prog = await getCampaignProgress(session.guildId, s.member.userId).catch(() => null);
        if (prog?.isComplete) await grantAchievement(session.guildId, s.member.userId, "raid_campaign_complete").catch(() => {});
      }
    } catch { /* non-fatal */ }

    // Stage each winner's PRESTIGE reward choice (exclusive frame or boss card),
    // claimed privately via the button on the end screen.
    if (survivors.length > 0) {
      const frame = raidFrameForBoss(boss.rewardFrameId);
      let cardName: string | null = null;
      if (boss.cardId != null) {
        try {
          const { getAllCardsCached } = await import("../db.js");
          const cards = await getAllCardsCached(session.guildId);
          cardName = cards.find(c => c.id === boss.cardId)?.name ?? null;
        } catch { /* non-fatal */ }
      }
      raidRewards.set(session.id, {
        guildId: session.guildId, bossName: boss.name,
        cardId: cardName ? boss.cardId : null, cardName,
        frameId: frame.id, frameName: frame.name, frameEmoji: frame.emoji,
        winners: new Set(survivors.map(s => s.member.userId)),
        choice: new Map(),
        channelId: session.channelId, messageId: session.message?.id ?? null,
      });
      setTimeout(() => raidRewards.delete(session.id), REWARD_TTL_MS).unref?.();
    }
  } else if (outcome === "wipe") {
    rewardNote = `💀 **Wipe!** The party fell to **${boss.name}**. Regroup, level your cards, and try again.`;
  } else {
    rewardNote = `⌛ **${boss.name}** outlasted the party after ${MAX_ROUNDS} rounds. Bring more firepower next time.`;
  }

  // Giveaway progress — every party member (survivors AND downed) gets raid
  // participation credit, plus an even share of the damage the party dealt to
  // the boss as their contribution. Best-effort; never blocks the raid.
  try {
    const { recordGiveawayEvent } = await import("../giveaway/engine.js");
    const { awardPlayerXp, XP } = await import("../player/xp.js");
    const { addRaidStats } = await import("../battle/db.js");
    const bc = session.bossCombatant;
    const bossDamage = bc ? Math.max(0, bc.stats.maxHealth - Math.max(0, bc.hp)) : 0;
    const share = session.party.size > 0 ? Math.round(bossDamage / session.party.size) : 0;
    const solo = session.party.size === 1;
    for (const s of session.party.values()) {
      await recordGiveawayEvent(session.guildId, s.member.userId, "raid_join", 1);
      if (share > 0) await recordGiveawayEvent(session.guildId, s.member.userId, "raid_damage", share);
      // Unified account XP: a raid clear pays more than a participation-only run.
      await awardPlayerXp(session.guildId, s.member.userId, "raid", outcome === "clear" ? XP.raidClear : XP.raidParticipate);
      // Raid stats for the /top Raid leaderboard.
      const survived = (s.combatant?.hp ?? 0) > 0;
      const taken = s.combatant ? Math.max(0, s.combatant.stats.maxHealth - Math.max(0, s.combatant.hp)) : 0;
      await addRaidStats(session.guildId, s.member.userId, {
        raidsWon: outcome === "clear" ? 1 : 0,
        raidsLost: outcome === "clear" ? 0 : 1,
        soloRaidsWon: outcome === "clear" && solo ? 1 : 0,
        raidsSurvived: outcome === "clear" && survived ? 1 : 0,
        raidDamageDealt: share,
        raidDamageTaken: taken,
      }).catch(() => {});
    }
  } catch { /* non-fatal */ }

  // On a clear, render the trophy-wall gallery: every enabled boss with a red ✗
  // struck through the one just defeated. On a wipe/timeout, render the mirror
  // scene: the boss dominant over the fallen party. Both best-effort → fall
  // back to boss art if the canvas can't render.
  let endImage: Buffer | null = null;
  let endFile: string | null = null;
  let storyLine: string | null = null;
  // A Fatality clear plays the cinematic finisher in place of the roster gallery.
  if (outcome === "clear" && session.fatality) {
    try {
      const enabled = await getEnabledBosses(session.guildId);
      storyLine = buildRaidClearLine(boss, Math.max(0, enabled.length - 1));
    } catch { /* non-fatal */ }
    const cine = await renderFatalityCinematic({
      winner: session.fatality.winner,
      loser: {
        name: boss.name,
        rarity: boss.rarity as Rarity,
        rarityLabel: "BOSS",
        cardType: "boss",
        artUrl: toAbsoluteImageUrl(boss.imageUrl),
      },
    }).catch(() => null);
    if (cine) { endImage = cine.buffer; endFile = RAID_FATALITY_FILE; }
  }
  if (outcome === "clear") {
    // Skip the campaign canvas when a Fatality cinematic already produced the image.
    if (!endImage) try {
      // The shared end screen shows the STARTER's campaign progress (clears were
      // just recorded above, so this reflects the boss they beat this run).
      const prog = await getCampaignProgress(session.guildId, session.starterId);
      storyLine = buildRaidClearLine(boss, Math.max(0, prog.total - prog.defeated));
      // Reward labels for the campaign end screen.
      const rewards: string[] = [];
      if (boss.cardId != null) rewards.push("Boss Card");
      rewards.push(`${raidFrameForBoss(boss.rewardFrameId).name} Frame`);
      rewards.push(`${boss.rewardShards.toLocaleString()} Shards`);
      // Solo clear (one player start→finish) → badge their Discord avatar.
      const soloAvatarUrl = session.party.size === 1
        ? ([...session.party.values()][0]?.member.avatarUrl ?? null)
        : null;
      endImage = await withGuildFrames(await getOrCreateGuildSettings(session.guildId).catch(() => null), () => renderCampaignProgress({
        defeatedBoss: {
          name: boss.name, imageUrl: toAbsoluteImageUrl(boss.imageUrl),
          rarity: boss.rarity as Rarity, battlefieldUrl: toAbsoluteImageUrl(boss.battlefieldUrl),
        },
        soloAvatarUrl,
        rewards,
        defeated: prog.defeated,
        total: prog.total,
        next: prog.next
          ? { name: prog.next.name, imageUrl: toAbsoluteImageUrl(prog.next.imageUrl), rarity: prog.next.rarity as Rarity }
          : null,
        isFinaleNext: prog.isFinaleNext,
        isComplete: prog.isComplete,
      })).catch(() => null);
      if (endImage) endFile = RAID_CAMPAIGN_FILE;
    } catch { /* non-fatal — plain end embed */ }
  } else {
    try {
      const bc = session.bossCombatant;
      const damageDealt = bc ? Math.max(0, bc.stats.maxHealth - Math.max(0, bc.hp)) : 0;
      const damageTaken = [...session.party.values()].reduce(
        (sum, s) => sum + (s.combatant ? Math.max(0, s.combatant.stats.maxHealth - Math.max(0, s.combatant.hp)) : 0), 0,
      );
      storyLine = buildRaidWipeLine(boss);
      endImage = await withGuildFrames(await getOrCreateGuildSettings(session.guildId).catch(() => null), () => renderRaidWipeScene(
        {
          name: boss.name,
          imageUrl: toAbsoluteImageUrl(boss.imageUrl),
          rarity: boss.rarity as Rarity,
          battlefieldUrl: toAbsoluteImageUrl(boss.battlefieldUrl),
        },
        [...session.party.values()].map(s => ({
          name: s.member.card.name,
          imageUrl: toAbsoluteImageUrl(s.member.card.imageUrl),
          rarity: s.member.card.rarity as Rarity,
          progTier: progTierForFrameId(s.member.card.equippedFrame),
          downed: (s.combatant?.hp ?? 0) <= 0,
        })),
        damageDealt, damageTaken,
      )).catch(() => null);
      if (endImage) endFile = RAID_WIPE_FILE;
    } catch { /* non-fatal — plain end embed */ }
  }

  // Progression: on a clear, point the party toward the next boss — or crown
  // them if they just beat the finale.
  let progression: string | null = null;
  let nextBoss: RaidBoss | null = null;
  if (outcome === "clear") {
    try {
      nextBoss = await getNextBoss(session.guildId, boss);
      progression = nextBoss
        ? `🧭 **Next boss:** ${nextBoss.name} — hit **Continue** below or \`/raid start boss:${nextBoss.name}\`.`
        : "👑 **Campaign complete!** This was the **final boss** — the whole ladder has fallen to you.";
    } catch { /* non-fatal */ }
  }

  const reward = raidRewards.get(session.id);
  if (session.message) {
    const endEmbed = buildEndEmbed(session, outcome, rewardNote, storyLine, endFile, progression, !!reward);
    const files = endImage && endFile ? [new AttachmentBuilder(endImage, { name: endFile })] : [];
    const components = buildEndComponents(session.id, outcome === "clear", !!reward, nextBoss);
    await session.message.edit({ embeds: [endEmbed], components, files }).catch(() => {});
  }
  teardown(session);
}

// End-screen buttons. On a clear: claim reward (if any) + Continue to Next Boss
// (when one remains) + Raid Hub. Non-clear ends show nothing (kept as today).
function buildEndComponents(
  rid: string, isClear: boolean, hasReward: boolean, nextBoss: RaidBoss | null,
): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (hasReward) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`raid:reward:${rid}`).setLabel("Claim Your Reward").setEmoji("🎁").setStyle(ButtonStyle.Success),
    );
  }
  if (isClear) {
    if (nextBoss) {
      row.addComponents(
        new ButtonBuilder().setCustomId(`raid:next:${nextBoss.id}`).setLabel("Continue to Next Boss").setEmoji("➡️").setStyle(ButtonStyle.Primary),
      );
    }
    row.addComponents(
      new ButtonBuilder().setCustomId("raid:hub:0").setLabel("Raid Hub").setEmoji("🏠").setStyle(ButtonStyle.Secondary),
    );
  }
  return row.components.length ? [row] : [];
}

// ➡️ Continue to Next Boss — launch a fresh raid lobby on the next ladder boss,
// reusing the full startRaid path (all its checks: locks, cooldown, setup).
async function handleContinueToNext(interaction: ButtonInteraction, bossId: number): Promise<void> {
  const boss = bossId ? await getBossById(bossId) : null;
  if (!boss || !boss.enabled) {
    await interaction.reply({ content: "That boss isn't available anymore — see `/raid bosses`.", ...EPHEMERAL }).catch(() => {});
    return;
  }
  // startRaid only uses reply/fetchReply/guild/channelId/user, all present on a
  // ButtonInteraction; the cast just satisfies the slash-command signature.
  await startRaid(interaction as unknown as ChatInputCommandInteraction, boss.name);
}

// 🏠 Raid Hub — show the clicker THEIR OWN campaign map (ephemeral).
async function showCampaignHub(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) { await interaction.reply({ content: "Server only.", ...EPHEMERAL }).catch(() => {}); return; }
  const { buildCampaignEmbed } = await import("./command.js");
  const embed = await buildCampaignEmbed(interaction.guild.id, interaction.user.id);
  await interaction.reply({ embeds: [embed], ...EPHEMERAL }).catch(() => {});
}

// ── Reward claim (winner-only, private) ──────────────────────────────────────
async function handleRaidReward(
  interaction: ButtonInteraction, action: string, rid: string,
): Promise<void> {
  const reward = raidRewards.get(rid);
  if (!reward) { await interaction.reply({ content: "⌛ This raid's reward window has closed.", ...EPHEMERAL }).catch(() => {}); return; }
  const userId = interaction.user.id;
  if (!reward.winners.has(userId)) {
    await interaction.reply({ content: "🔒 Only the winners of this raid can claim a reward.", ...EPHEMERAL }).catch(() => {});
    return;
  }

  // Open the private chooser.
  if (action === "reward") {
    if (reward.choice.has(userId)) {
      await interaction.reply({ content: "✅ You've already claimed your reward from this raid.", ...EPHEMERAL }).catch(() => {});
      return;
    }
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`raid:rwframe:${rid}`).setLabel(`Exclusive Frame — ${reward.frameName}`).setEmoji(reward.frameEmoji).setStyle(ButtonStyle.Primary),
    );
    if (reward.cardId != null && reward.cardName) {
      row.addComponents(
        new ButtonBuilder().setCustomId(`raid:rwcard:${rid}`).setLabel(`Boss Card — ${reward.cardName}`.slice(0, 80)).setEmoji("🃏").setStyle(ButtonStyle.Secondary),
      );
    }
    await interaction.reply({
      content: `🎁 **Choose your raid reward** for defeating **${reward.bossName}** — you can pick **one**:\n` +
        `🖼️ **${reward.frameName}** — a permanent, account-wide frame equippable on any card. Equip it from **User Hub → 🖼️ Frames**.` +
        (reward.cardId != null ? `\n🃏 **${reward.cardName}** — the boss's own card (near-max level), added to your collection.` : ""),
      components: [row],
      ...EPHEMERAL,
    }).catch(() => {});
    return;
  }

  // Commit a choice (idempotent guard).
  if (reward.choice.has(userId)) {
    await interaction.update({ content: "✅ You've already claimed your reward from this raid.", components: [] }).catch(() => {});
    return;
  }
  if (!interaction.guild) { await interaction.reply({ content: "Claims must be made in the server.", ...EPHEMERAL }).catch(() => {}); return; }

  if (action === "rwframe") {
    reward.choice.set(userId, "frame");
    const granted = await grantRaidFrame(reward.guildId, userId, reward.frameId, null).catch(() => false);
    await interaction.update({
      content: granted !== false
        ? `🖼️ **${reward.frameEmoji} ${reward.frameName}** unlocked! Equip it on any card from **User Hub → 🖼️ Frames**.`
        : `🖼️ You already have **${reward.frameEmoji} ${reward.frameName}** — no change made. Equip it from **User Hub → 🖼️ Frames**.`,
      components: [],
    }).catch(() => {});
    return;
  }
  if (action === "rwcard") {
    if (reward.cardId == null) { await interaction.update({ content: "This raid has no boss card reward.", components: [] }).catch(() => {}); return; }
    reward.choice.set(userId, "card");
    try {
      const { catchCard } = await import("../db.js");
      const { setCardLevel } = await import("../cards/leveling.js");
      await catchCard(reward.guildId, userId, reward.cardId, { noShiny: true });
      // Boss cards enter battle-ready — near-maxed, not level 1.
      await setCardLevel(reward.guildId, userId, reward.cardId, BOSS_CARD_REWARD_LEVEL);
    } catch { /* non-fatal */ }
    await interaction.update({
      content: `🃏 **${reward.cardName}** — the boss's own card — has been added to your collection at **Level ${BOSS_CARD_REWARD_LEVEL}**! View it with \`/info name:${reward.cardName}\`.`,
      components: [],
    }).catch(() => {});
  }

  // Once every winner has claimed, the final raid embed has done its job —
  // clear it from the channel instead of leaving a stale "Claim Your Reward"
  // board around forever.
  if (reward.choice.size >= reward.winners.size && reward.messageId) {
    try {
      const channel = await interaction.client.channels.fetch(reward.channelId).catch(() => null);
      if (channel?.isTextBased()) {
        const msg = await channel.messages.fetch(reward.messageId).catch(() => null);
        await msg?.delete().catch(() => {});
      }
    } catch { /* non-fatal */ }
    raidRewards.delete(rid);
  }
}

function teardown(session: RaidSession): void {
  if (session.timer) { clearTimeout(session.timer); session.timer = undefined; }
  for (const userId of session.party.keys()) userSession.delete(uKey(session.guildId, userId));
  sessions.delete(session.id);
}

// ── Eligibility ──────────────────────────────────────────────────────────────
async function eligibleCards(session: RaidSession, userId: string): Promise<{
  eligible: { card: OwnedBattleCard; level: number; stars: number }[]; reason?: string;
}> {
  const { boss, settings, guildId } = session;
  const [owned, levels, stars, profile] = await Promise.all([
    getOwnedBattleCards(guildId, userId),
    getUserCardLevels(guildId, userId),
    getStarRankMap(guildId, userId),
    getOrCreateProfile(guildId, userId),
  ]);
  if (profile.level < boss.minPlayerLevel) {
    return { eligible: [], reason: `🔒 You must be **battle level ${boss.minPlayerLevel}** to join this raid (you're level ${profile.level}). Win battles in \`/battle\` to level up.` };
  }
  // Star Rank is the canonical star (earned by fusing copies in /card_recycle),
  // not level-derived. The raid gate reads it directly.
  const eligible = owned
    .filter(c => c.owned > 0)
    .filter(c => (c.config?.enabled ?? true))
    .filter(c => rarityAllowed(settings, (c.config?.rarity as Rarity) || (c.rarity as Rarity)))
    .map(c => ({ card: c, level: levels.get(c.id) ?? 1, stars: stars.get(c.id) ?? 0 }))
    .filter(e => e.stars >= boss.minStars)
    .sort((a, b) => b.stars - a.stars || b.level - a.level);

  if (eligible.length === 0) {
    return { eligible, reason: `🔒 This raid needs a **${boss.minStars}-star** card (${starString(boss.minStars)}) — **fuse** a card to ${boss.minStars}★ in \`/card_recycle\` (${boss.minStars * 5}+ copies). ` };
  }
  return { eligible };
}

async function getUserCardLevels(guildId: string, userId: string): Promise<Map<number, number>> {
  const rows = await db.select({ cardId: cardProgressTable.cardId, level: cardProgressTable.level })
    .from(cardProgressTable)
    .where(and(eq(cardProgressTable.guildId, guildId), eq(cardProgressTable.userId, userId)));
  return new Map(rows.map(r => [r.cardId, r.level]));
}

// ── Rendering ────────────────────────────────────────────────────────────────
const MOVE_LABEL: Record<string, string> = {
  attack: "⚔️ Attack", special: "✨ Special", defend: "🛡️ Defend", charge: "⚡ Charge",
};

function buildLobbyEmbed(session: RaidSession): EmbedBuilder {
  const b = session.boss;
  const members = [...session.party.values()].map(s =>
    `• <@${s.member.userId}> — **${s.member.card.name}** ${starString(s.member.cardStars)}`).join("\n") || "*No one has joined yet.*";
  const embed = new EmbedBuilder()
    .setTitle(`🐉 BOSS RAID — ${b.name}`)
    .setColor(0xc0392b)
    .setDescription(
      // The gym-battle opening: arrival beat + boss taunt (weaves in any admin
      // description) + one-line co-op coaching. Deterministic per boss.
      `${buildRaidIntroScript(b)}\n\n` +
      `A co-op boss fight for **${b.minPlayers}–${b.maxPlayers}** players. The boss focuses the weakest and **sweeps** the whole party.\n\n` +
      `**Entry:** a ${starString(b.minStars)} card (fuse ${b.minStars * 5}+ copies in \`/card_recycle\`)` +
      (b.minPlayerLevel > 1 ? ` · battle level **${b.minPlayerLevel}+**` : "") + "\n" +
      `**Reward on clear:** 💠 ${b.rewardShards.toLocaleString()} + ${b.rewardCardXp} card XP each`,
    )
    .addFields({ name: `👥 Party (${session.party.size}/${b.maxPlayers})`, value: members, inline: false })
    .setFooter({ text: "Click Join to pick your card · Starter clicks Begin when ready" });
  const thumb = toAbsoluteImageUrl(b.imageUrl);
  if (thumb) embed.setThumbnail(thumb);
  return embed;
}

function buildLobbyComponents(session: RaidSession): ActionRowBuilder<ButtonBuilder>[] {
  const canBegin = session.party.size >= session.boss.minPlayers;
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`raid:join:${session.id}`).setLabel("Join").setEmoji("🃏").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`raid:leave:${session.id}`).setLabel("Leave").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`raid:begin:${session.id}`).setLabel("Begin").setEmoji("⚔️").setStyle(ButtonStyle.Success).setDisabled(!canBegin),
    new ButtonBuilder().setCustomId(`raid:cancel:${session.id}`).setLabel("Cancel").setStyle(ButtonStyle.Danger),
  )];
}

async function refreshLobby(session: RaidSession): Promise<void> {
  if (session.phase !== "lobby" || !session.message) return;
  await session.message.edit({ embeds: [buildLobbyEmbed(session)], components: buildLobbyComponents(session) }).catch(() => {});
}

// Raids mirror the battle screen: TWO stacked embeds in one message — a top
// LOG embed (the running combat feed) and a bottom STATUS embed (boss HP, party,
// arena image). Same shape battles use, so it reads identically. When `opts`
// carries HP snapshots + an attack image (during beat replay), the board shows
// that historical moment plus the current attack frame instead of the arena.
async function raidStatusHud(
  session: RaidSession, bossHp: number, partyHp?: Record<string, number>,
): Promise<{ embed: EmbedBuilder; file: AttachmentBuilder } | null> {
  const theme = statusThemeOf(session.settings.battleStatusTheme);
  const boss = session.bossCombatant;
  if (theme === "classic" || !boss) return null;
  const party = [...session.party.values()].filter(s => s.combatant).slice(0, 4);
  const fighters = [
    hudFighter(boss, { tag: "BOSS", tagTone: "boss", sub: "Boss", active: true, hp: bossHp }),
    ...party.map(s => hudFighter(s.combatant!, {
      tag: "PARTY",
      tagTone: "you" as const,
      sub: "",
      hp: partyHp?.[s.member.userId] ?? s.combatant!.hp,
      active: false,
    })),
  ];
  const png = await renderStatusStill({
    style: theme === "gauges" ? "gauges" : "drain",
    headline: `ROUND ${session.roundNumber}`,
    turnLabel: "RAID",
    fighters,
  }).catch(() => null);
  if (!png) return null;
  return {
    embed: new EmbedBuilder().setColor(0xe74c3c).setDescription("❤️ **Boss and party**").setImage(`attachment://${HUD_FILE_PNG}`),
    file: new AttachmentBuilder(png, { name: HUD_FILE_PNG }),
  };
}

function buildFightEmbeds(
  session: RaidSession,
  opts?: { bossHp?: number; partyHp?: Record<string, number>; attackFile?: string; metersInImage?: boolean },
): EmbedBuilder[] {
  const boss = session.bossCombatant!;
  const replaying = !!opts?.attackFile;
  const bossHp = opts?.bossHp ?? Math.max(0, boss.hp);

  // ── Top: battle log ──
  const logEmbed = new EmbedBuilder()
    .setTitle(`📜 Raid Log — Round ${session.roundNumber}`)
    .setColor(0xc0392b)
    .setDescription(
      session.recentLog.length
        ? session.recentLog.join(`\n${WHITE_LINE}\n`).slice(0, 4000)
        : `⚔️ The party faces **${boss.cardName}**…`,
    );

  // ── Bottom: status (boss HP + party + arena/attack image) ──
  const hpPct = Math.max(0, Math.min(100, Math.round((bossHp / boss.stats.maxHealth) * 100)));
  const statusEmbed = new EmbedBuilder()
    .setTitle(`🐉 ${boss.cardName}`)
    .setColor(0xe74c3c)
    .setDescription(
      opts?.metersInImage
        ? `**${boss.cardName}** · **${bossHp.toLocaleString()}** / ${boss.stats.maxHealth.toLocaleString()} HP (${hpPct}%)` +
          (boss.status.length ? `\n${boss.status.map(s => `${s.emoji} ${s.label} (${s.turns})`).join(" ")}` : "")
        : `**Boss HP**\n${bar(bossHp, boss.stats.maxHealth, 16)}  **${bossHp.toLocaleString()}** / ${boss.stats.maxHealth.toLocaleString()} HP (${hpPct}%)` +
          (boss.status.length ? `\n${boss.status.map(s => `${s.emoji} ${s.label} (${s.turns})`).join(" ")}` : ""),
    );
  const partyLines = [...session.party.values()].map(s => {
    const c = s.combatant!;
    const hp = opts?.partyHp?.[s.member.userId] ?? c.hp;
    const acted = !replaying && session.pendingActions.has(s.member.userId) ? " ✅" : "";
    if (hp <= 0) return `💀 <@${s.member.userId}> **${c.cardName}** — *downed*`;
    if (opts?.metersInImage) return `❤️ <@${s.member.userId}> **${c.cardName}**${acted} — ${hp}/${c.stats.maxHealth}`;
    const shield = c.shield > 0 ? ` 🛡️${c.shield}` : "";
    return `❤️ <@${s.member.userId}> **${c.cardName}**${acted}\n${bar(hp, c.stats.maxHealth, 10)} ${hp}/${c.stats.maxHealth}${shield} · ⚡${c.energy}`;
  });
  statusEmbed.addFields({ name: `👥 Party ${WHITE_LINE}`, value: partyLines.join(`\n${WHITE_LINE}\n`) || "—", inline: false });
  if (replaying) {
    statusEmbed.setFooter({ text: "⚔️ Resolving the round…" });
  } else {
    const livingCount = [...session.party.values()].filter(s => (s.combatant?.hp ?? 0) > 0).length;
    const lockedIn = [...session.party.values()].filter(s => (s.combatant?.hp ?? 0) > 0 && session.pendingActions.has(s.member.userId)).length;
    statusEmbed.setFooter({ text: `🔒 Locked in ${lockedIn}/${livingCount} — the round resolves once all living fighters act (or after 60s).` });
  }
  if (opts?.attackFile) statusEmbed.setImage(`attachment://${opts.attackFile}`);
  else if (session.introImage) statusEmbed.setImage(`attachment://${RAID_INTRO_FILE}`);
  else if (boss.cardImageUrl) statusEmbed.setImage(boss.cardImageUrl);

  return [logEmbed, statusEmbed];
}

function buildFightComponents(session: RaidSession): ActionRowBuilder<ButtonBuilder>[] {
  const moves: MoveType[] = ["attack", "special", "defend", "charge"];
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    moves.map(m => new ButtonBuilder()
      .setCustomId(`raid:act:${session.id}:${m}`)
      .setLabel(MOVE_LABEL[m] ?? m)
      .setStyle(m === "attack" ? ButtonStyle.Danger : m === "defend" ? ButtonStyle.Primary : ButtonStyle.Secondary)),
  );
  // 🎒 Item — heal/shield a teammate, buff yourself, or grenade the boss.
  row1.addComponents(
    new ButtonBuilder().setCustomId(`raid:item:${session.id}`).setLabel("Item").setEmoji("🎒").setStyle(ButtonStyle.Success),
  );
  const rows = [row1];
  // Once the boss is finishable, offer the optional 💀 Fatality — any living
  // member can take the killing blow for the cinematic. Normal moves still work.
  if (raidFatalityReady(session)) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`raid:fatality:${session.id}`).setLabel("FATALITY").setEmoji("💀").setStyle(ButtonStyle.Danger),
    ));
  }
  return rows;
}

async function renderFight(session: RaidSession): Promise<void> {
  if (!session.message) return;
  const fresh = await getBattleSettings(session.guildId).catch(() => null);
  if (fresh) session.settings = { ...session.settings, battleStatusTheme: fresh.battleStatusTheme };
  const files = session.introImage
    ? [new AttachmentBuilder(session.introImage, { name: RAID_INTRO_FILE })]
    : [];
  const bossHp = Math.max(0, session.bossCombatant?.hp ?? 0);
  const hud = await raidStatusHud(session, bossHp);
  if (hud) files.push(hud.file);
  const embeds = buildFightEmbeds(session, { metersInImage: !!hud });
  if (hud) embeds.splice(1, 0, hud.embed);
  await session.message.edit({ embeds, components: buildFightComponents(session), files }).catch(() => {});
}

function buildEndEmbed(
  session: RaidSession, outcome: "clear" | "wipe" | "timeout", note: string,
  storyLine?: string | null, endFile?: string | null,
  progression?: string | null, hasReward?: boolean,
): EmbedBuilder {
  const color = outcome === "clear" ? 0x2ecc71 : 0x7f8c8d;
  const title = outcome === "clear" ? "🏆 BOSS DEFEATED" : "💀 RAID FAILED";
  const boss = session.bossCombatant!;
  const bossMax = boss.stats.maxHealth;
  const bossHp = Math.max(0, boss.hp);
  const damageDealt = bossMax - bossHp;
  const hpPct = Math.max(0, Math.min(100, Math.round((bossHp / bossMax) * 100)));
  const bossHpLine = `${bar(bossHp, bossMax, 16)} **${bossHp.toLocaleString()}** / ${bossMax.toLocaleString()} HP (${hpPct}%)`;

  const partyLines = [...session.party.values()].map(s => {
    const c = s.combatant!;
    const alive = c.hp > 0;
    const shield = c.shield > 0 ? ` · 🛡️ ${c.shield}` : "";
    const hpLine = alive ? `${bar(c.hp, c.stats.maxHealth, 10)} ${c.hp}/${c.stats.maxHealth} HP${shield}` : "downed";
    return `${alive ? "❤️" : "💀"} <@${s.member.userId}> · **${c.cardName}**\n${hpLine}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setDescription(
      (storyLine ? `${storyLine}\n${WHITE_LINE}\n` : "") +
      `**Boss HP**\n${bossHpLine}\n${WHITE_LINE}\n` +
      `**Damage Dealt** · **${damageDealt.toLocaleString()}** damage across the party`
    )
    .addFields(
      { name: `👥 Party Cards ${WHITE_LINE}`, value: partyLines.join(`\n${WHITE_LINE}\n`) || "—", inline: false },
      {
        name: `🎁 Rewards ${WHITE_LINE}`,
        value: note + (hasReward ? "\n\n🏅 **Winners:** tap **Claim Your Reward** to pick your exclusive frame or the boss card." : ""),
        inline: false,
      },
    )
    .setFooter({ text: `Raid lasted ${session.roundNumber} round(s) · ${session.party.size} fighter(s) fielded their own cards` });
  if (progression) embed.addFields({ name: `🧭 The Ladder ${WHITE_LINE}`, value: progression, inline: false });
  // Clear → the boss-roster gallery (defeated boss struck out). Loss → the
  // wipe scene (boss victorious, downed fighters struck out). Else boss art.
  if (endFile) embed.setImage(`attachment://${endFile}`);
  else if (boss.cardImageUrl) embed.setImage(boss.cardImageUrl);
  return embed;
}

// ── TTL / lobby-abandon cleanup ──────────────────────────────────────────────
function armTimer(session: RaidSession, ms: number): void {
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    if (session.phase === "lobby") {
      if (session.message) session.message.edit({ embeds: [new EmbedBuilder().setTitle("⌛ Raid expired").setColor(0x95a5a6).setDescription(`The lobby for **${session.boss.name}** expired before it started.`)], components: [] }).catch(() => {});
      teardown(session);
    }
  }, ms);
}
