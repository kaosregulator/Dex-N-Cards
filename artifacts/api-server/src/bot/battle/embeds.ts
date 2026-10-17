// Animation / Embed Engine — the cinematic visuals.
//
// Everything a battle shows the player is built here: HP/energy/ultimate bars,
// the live combat card, intro frames, and the victory screen. The battle lives
// in ONE message that these builders keep re-rendering (embed editing), which is
// what makes it feel alive without spamming the channel. Rarity colors come
// straight from the existing project palette (cards-data).

import { EmbedBuilder } from "discord.js";
import { rarityLabel, rarityEmoji, rarityColor, type RarityDisplayMap } from "../cards-data.js";
import type { Combatant, Rarity } from "./types.js";

export interface BattleView {
  a: Combatant;          // side 0 (challenger)
  b: Combatant;          // side 1 (opponent / AI)
  turnNumber: number;
  currentSide: 0 | 1;
  staked: boolean;
  log: string[];
  turnEndsAt?: number;   // epoch ms for the turn timer countdown
  displayMap: RarityDisplayMap | null;   // source-of-truth rarity display overrides
}

const BATTLE_COLOR = 0xed4245;

// Visual separator used between embed sections / log entries. Replace with your
// Discord server's custom white-line emoji if you prefer a different look.
export const WHITE_LINE = "▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭";

// ── Progress bars ────────────────────────────────────────────────────────────
// `██████░░░░ 60%` style bar. Exported for reuse by prep/summary screens.
export function bar(value: number, max: number, width = 10, filled = "█", empty = "░"): string {
  return `${meter(value, max, width, filled, empty)} ${pct(value, max)}%`;
}

function meter(value: number, max: number, width = 10, filled = "█", empty = "░"): string {
  const pct = max <= 0 ? 0 : Math.max(0, Math.min(1, value / max));
  const n = Math.max(0, Math.min(width, Math.round(pct * width)));
  return filled.repeat(n) + empty.repeat(width - n);
}

function hpBar(value: number, max: number): string {
  const pct = max <= 0 ? 0 : Math.max(0, Math.min(1, value / max));
  const width = 12;
  const n = Math.max(0, Math.min(width, Math.round(pct * width)));
  const glyph = pct > 0.5 ? "🟩" : pct > 0.25 ? "🟨" : "🟥";
  return glyph.repeat(n) + "⬛".repeat(width - n);
}

function pct(value: number, max: number): number {
  return max <= 0 ? 0 : Math.round(Math.max(0, Math.min(1, value / max)) * 100);
}

function rarityColorOf(r: Rarity, displayMap: RarityDisplayMap | null): number {
  return rarityColor(r, null, displayMap) ?? BATTLE_COLOR;
}

// Source-of-truth display rarity for a combatant: custom tiers / profile overrides
// from /rarity take precedence over the built-in rarity key.
function displayRarityOf(c: Combatant, displayMap: RarityDisplayMap | null) {
  if (c.cardRarityDisplay) {
    return {
      emoji: c.cardRarityDisplay.emoji,
      label: c.cardRarityDisplay.label,
      color: c.cardRarityDisplay.color ?? BATTLE_COLOR,
    };
  }
  return {
    emoji: rarityEmoji(c.cardRarity, null, displayMap) ?? "•",
    label: rarityLabel(c.cardRarity, null, displayMap) ?? c.cardRarity,
    color: rarityColorOf(c.cardRarity, displayMap),
  };
}

function statusLine(c: Combatant): string {
  if (c.status.length === 0 && c.frozenTurns === 0) return "";
  const parts = c.status.map(s => `${s.emoji}${s.turns > 1 ? `×${s.turns}` : ""}`);
  if (c.frozenTurns > 0 && !c.status.some(s => s.kind === "freeze")) parts.push(`❄️×${c.frozenTurns}`);
  return parts.length ? `\n${parts.join(" ")}` : "";
}

// A combatant's stat block for the live battle embed.
export function combatantField(c: Combatant, active: boolean, displayMap: RarityDisplayMap | null): { name: string; value: string; inline: boolean } {
  const disp = displayRarityOf(c, displayMap);
  const turnMark = active ? "🔹 " : "";
  const name = `${turnMark}${disp.emoji} ${c.cardName}`;
  const lines = [
    `<@${c.userId}>`.replace(/^<@AI>$/, "🤖 **AI**") + ` · *${disp.label}*`,
    `❤️ ${hpBar(c.hp, c.stats.maxHealth)}`,
    `\`${Math.max(0, c.hp)}/${c.stats.maxHealth}\`${c.shield > 0 ? ` 🛡️ ${c.shield}` : ""}`,
    `⚡ \`${meter(c.energy, c.stats.energyMax, 8)}\` ${pct(c.energy, c.stats.energyMax)}%`,
    `💀 \`${meter(c.ultimate, c.stats.ultimateMax, 8)}\` ${pct(c.ultimate, c.stats.ultimateMax)}%`,
  ];
  const st = statusLine(c);
  if (st) lines.push(st.trim());
  if (c.specialEffect) {
    lines.push(c.specialCooldownRemaining > 0
      ? `✨ ${c.specialCardName ?? "Special"} (⏳${c.specialCooldownRemaining})`
      : `✨ ${c.specialCardName ?? "Special"} ready`);
  }
  return { name, value: lines.join("\n"), inline: true };
}

// Player is "AI" — render mention safely.
function who(c: Combatant): string {
  return c.isAi ? `🤖 **AI (${c.aiDifficulty ?? "normal"})**` : `<@${c.userId}>`;
}

// The routine basic-attack line — "⚔️ X's attack hits for N" — is now shown far
// more clearly on the combat canvas (damage number + draining HP bar), so it's
// dropped from the text log. Everything NOTABLE stays: crits (💥) and ultimates
// (☄️) use different icons, and misses/dodges/shields/counters/heals/buffs/
// debuffs/status/KOs all read through, keeping the log a highlight reel.
const ROUTINE_HIT = /^⚔️ .* hits for /u;

// Condense the log for display: drop routine hits (the canvas covers them), keep
// notable events, and always keep the final line for context. Joined with a
// single newline instead of a heavy divider between every entry.
function condensedLog(log: string[], max = 5): string {
  if (log.length === 0) return "_The battlefield is quiet…_";
  const notable = log.filter((l, i) => i === log.length - 1 || !ROUTINE_HIT.test(l));
  const shown = (notable.length ? notable : log).slice(-max);
  return shown.join("\n");
}

// ── Live combat embed ────────────────────────────────────────────────────────
export function buildCombatEmbed(v: BattleView, opts?: { currentMove?: string }): EmbedBuilder {
  const active = v.currentSide === 0 ? v.a : v.b;
  const activeDisp = displayRarityOf(active, v.displayMap);
  const embed = new EmbedBuilder()
    .setColor(activeDisp.color)
    .setTitle(`⚔️ Card Battle — Turn ${v.turnNumber}${v.staked ? " · 💰 Staked" : ""}`)
    .addFields(
      combatantField(v.a, v.currentSide === 0, v.displayMap),
      combatantField(v.b, v.currentSide === 1, v.displayMap),
    );

  if (active.cardImageUrl) embed.setThumbnail(active.cardImageUrl);

  embed.addFields({ name: `📜 Battle Log ${WHITE_LINE}`, value: condensedLog(v.log).slice(0, 1024), inline: false });

  const turnLine = active.isAi
    ? `🤖 **AI** is deciding…`
    : `🔹 ${who(active)} — it's your move!`;
  const timer = v.turnEndsAt ? ` · ends <t:${Math.floor(v.turnEndsAt / 1000)}:R>` : "";
  embed.addFields({ name: "🎯 Current Turn", value: turnLine + timer, inline: false });

  if (opts?.currentMove) embed.setFooter({ text: opts.currentMove });
  return embed;
}

// The "whose turn is it" line, shared by the layout below.
export function currentTurnLine(v: BattleView): string {
  const active = v.currentSide === 0 ? v.a : v.b;
  const turnLine = active.isAi
    ? `🤖 **AI** is deciding…`
    : `🔹 ${who(active)} — **it's your move!**`;
  const timer = v.turnEndsAt ? ` · ends <t:${Math.floor(v.turnEndsAt / 1000)}:R>` : "";
  return turnLine + timer;
}

// ── Two-embed combat layout ──────────────────────────────────────────────────
// TOP embed: the recent battle log (last 4–6 actions). The log lives in the
// description so it reads bigger/cleaner. The "whose turn" indicator is NOT here
// — it now rides with the health bars in the status embed (see below) so players
// see it right next to the battlefield instead of scrolled off at the top.
export function buildBattleLogEmbed(v: BattleView): EmbedBuilder {
  const active = v.currentSide === 0 ? v.a : v.b;
  const activeDisp = displayRarityOf(active, v.displayMap);
  return new EmbedBuilder()
    .setColor(activeDisp.color)
    .setTitle(`📜 Battle Log — Turn ${v.turnNumber}${v.staked ? " · 💰 Staked" : ""}`)
    .setDescription(condensedLog(v.log).slice(0, 4000));
}

// BOTTOM embed: the battle status — HP/Energy/Ultimate for both combatants, the
// "current turn" indicator sitting right beside those health bars, and the combat
// canvas as the big image filling the lower section. Keeping the turn line here
// means it's always visible next to the battlefield, not stranded above the log.
export function buildBattleStatusEmbed(v: BattleView, opts?: { currentMove?: string }): EmbedBuilder {
  const active = v.currentSide === 0 ? v.a : v.b;
  const activeDisp = displayRarityOf(active, v.displayMap);
  const embed = new EmbedBuilder()
    .setColor(activeDisp.color)
    .addFields(
      combatantField(v.a, v.currentSide === 0, v.displayMap),
      combatantField(v.b, v.currentSide === 1, v.displayMap),
      { name: "🎯 Current Turn", value: currentTurnLine(v), inline: false },
    );
  if (opts?.currentMove) embed.setFooter({ text: opts.currentMove });
  return embed;
}

// ── Intro animation frames ───────────────────────────────────────────────────
export function buildIntroFrame(v: BattleView, frame: number): EmbedBuilder {
  const e = new EmbedBuilder().setColor(BATTLE_COLOR);
  switch (frame) {
    case 0:
      e.setTitle("⚔️ Battle Starting…").setDescription("The arena crackles with energy.");
      break;
    case 1: {
      const aDisp = displayRarityOf(v.a, v.displayMap);
      e.setTitle("🔥 A challenger enters!")
        .setDescription(`${aDisp.emoji} **${v.a.cardName}** steps onto the battlefield for ${who(v.a)}!`);
      if (v.a.cardImageUrl) e.setThumbnail(v.a.cardImageUrl);
      break;
    }
    case 2: {
      const bDisp = displayRarityOf(v.b, v.displayMap);
      e.setTitle("💥 The opponent answers!")
        .setDescription(`${bDisp.emoji} **${v.b.cardName}** rises to fight for ${who(v.b)}!`);
      if (v.b.cardImageUrl) e.setThumbnail(v.b.cardImageUrl);
      break;
    }
    default: {
      const aDisp = displayRarityOf(v.a, v.displayMap);
      const bDisp = displayRarityOf(v.b, v.displayMap);
      e.setTitle("🪙 Coin toss decides who strikes first…")
        .setDescription(`${aDisp.emoji} **${v.a.cardName}**  ⚔️  **${v.b.cardName}** ${bDisp.emoji}`)
        .addFields(
          { name: who(v.a), value: `❤️ ${v.a.stats.maxHealth} · ⚔️ ${v.a.stats.attack} · 🛡️ ${v.a.stats.defense}`, inline: true },
          { name: who(v.b), value: `❤️ ${v.b.stats.maxHealth} · ⚔️ ${v.b.stats.attack} · 🛡️ ${v.b.stats.defense}`, inline: true },
        );
    }
      break;
  }
  return e;
}

export function buildCoinFlipEmbed(v: BattleView, firstSide: 0 | 1, call: string): EmbedBuilder {
  const first = firstSide === 0 ? v.a : v.b;
  return new EmbedBuilder()
    .setColor(BATTLE_COLOR)
    .setTitle(`🪙 The coin lands on **${call.toUpperCase()}**!`)
    .setDescription(`${who(first)} with **${first.cardName}** moves first!`);
}

// ── Victory screen ───────────────────────────────────────────────────────────
export function buildWinnerEmbed(
  v: BattleView, winnerSide: 0 | 1 | null, rewardLines: string[],
  opts?: { hideMeters?: boolean },
): EmbedBuilder {
  const e = new EmbedBuilder();
  if (winnerSide === null) {
    e.setColor(0x99aab5).setTitle("🤝 Draw!").setDescription("Both cards fell together — an even match.");
  } else {
    const w = winnerSide === 0 ? v.a : v.b;
    const l = winnerSide === 0 ? v.b : v.a;
    const wDisp = displayRarityOf(w, v.displayMap);
    e.setColor(wDisp.color)
      .setTitle("🏆 Victory!")
      .setDescription(`${wDisp.emoji} **${w.cardName}** defeats **${l.cardName}**!\n${who(w)} wins the battle.`);
    if (w.cardImageUrl) {
      e.setThumbnail(w.cardImageUrl)
       .setImage(w.cardImageUrl);
    }
  }
  if (!opts?.hideMeters) {
    e.addFields(
      combatantField(v.a, false, v.displayMap),
      combatantField(v.b, false, v.displayMap),
    );
  }
  if (rewardLines.length) e.addFields({ name: "🎁 Rewards", value: rewardLines.join("\n").slice(0, 1024), inline: false });
  e.setFooter({ text: `Battle lasted ${v.turnNumber} turn${v.turnNumber === 1 ? "" : "s"}` });
  return e;
}
