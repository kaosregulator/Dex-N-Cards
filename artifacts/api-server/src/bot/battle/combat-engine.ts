// Combat Engine — turn-based resolution.
//
// Pure(ish) logic: given two Combatants, the guild's settings, and a chosen
// move, it mutates combatant state and returns the log events that happened.
// The battle-manager owns turn order, timers, and rendering; this module owns
// the maths and the random events (crit / miss / dodge / counter / perfect
// block / shield break / combo / last stand). All rates come from settings so
// every formula is admin-configurable.

import type { BattleSettings } from "@workspace/db";
import type { Combatant, BattleEvent, MoveType, TurnResult, StatusEffect } from "./types.js";
import { getEffectDef } from "./special-cards.js";
import { getMoveset } from "./movesets.js";
import { getBattleItem, applyItemEffect } from "./items.js";
import { applyTurnStartPassive } from "./passives.js";
import { sideCombatRules } from "./side-rules.js";

// Apply a moveset's effect. Reuses the shared special-effects registry for the
// common effects; "stealth" and "weaken" are combat-engine-native mechanics.
function applyMovesetEffect(
  effect: string, self: Combatant, foe: Combatant, settings: BattleSettings,
): BattleEvent[] {
  if (effect === "stealth") {
    const st: StatusEffect = { kind: "stealth", turns: 2, magnitude: 0, label: "Stealth", emoji: "🫥" };
    self.status.push(st);
    return [{ text: `🫥 **${self.cardName}** slips into **Stealth** — the next attack against it will miss!`, flash: "dodge" }];
  }
  if (effect === "weaken") {
    const dmgDown = 25;
    foe.status.push({ kind: "weaken", turns: 3, magnitude: dmgDown, label: "Suppressed", emoji: "🔻" });
    return [{ text: `🔻 **${foe.cardName}** is suppressed — **-${dmgDown}%** attack for 3 turns!`, flash: "miss" }];
  }
  const def = getEffectDef(effect);
  if (def) return def.apply(self, foe, settings);
  return [];
}

const chance = (pct: number) => Math.random() * 100 < pct;
const vary = (n: number, spread: number) => n * (1 + (Math.random() - 0.5) * 2 * spread);

// Apply start-of-turn effects for the combatant about to act: DoT ticks,
// regen, status decay, energy regain. Returns log events + whether they were
// knocked out by DoT and whether their turn is skipped (frozen).
export function startOfTurn(
  actor: Combatant, settings: BattleSettings,
): { events: BattleEvent[]; koed: boolean; skipped: boolean } {
  const events: BattleEvent[] = [];
  actor.defending = false;

  // Turn-start passive (regen / energy / shield) fires before status ticks.
  const passiveEvent = applyTurnStartPassive(actor);
  if (passiveEvent) events.push(passiveEvent);

  for (const st of actor.status) {
    if (st.kind === "poison" || st.kind === "burn") {
      const dmg = Math.max(1, Math.round(st.magnitude));
      actor.hp -= dmg;
      events.push({
        text: `${st.emoji} **${actor.cardName}** takes **${dmg}** ${st.label.toLowerCase()} damage.`,
        flash: st.kind,
      });
    } else if (st.kind === "regen") {
      const heal = Math.max(1, Math.round(st.magnitude));
      actor.hp = Math.min(actor.stats.maxHealth, actor.hp + heal);
      events.push({ text: `${st.emoji} **${actor.cardName}** regenerates **${heal}** HP.`, flash: "heal" });
    }
  }
  // Decay statuses (freeze is consumed via frozenTurns below).
  actor.status = actor.status
    .map(s => ({ ...s, turns: s.turns - 1 }))
    .filter(s => s.turns > 0);

  // Energy regen each of the combatant's turns.
  actor.energy = Math.min(actor.stats.energyMax, actor.energy + settings.energyGainPerTurn);
  actor.ultimate = Math.min(actor.stats.ultimateMax, actor.ultimate + settings.ultimateChargePerTurn);
  if (actor.specialCooldownRemaining > 0) actor.specialCooldownRemaining--;
  if ((actor.itemCooldownRemaining ?? 0) > 0) actor.itemCooldownRemaining = actor.itemCooldownRemaining! - 1;

  if (actor.hp <= 0) return { events, koed: true, skipped: false };

  if (actor.frozenTurns > 0) {
    actor.frozenTurns--;
    events.push({ text: `❄️ **${actor.cardName}** is frozen and cannot move!`, flash: "freeze" });
    return { events, koed: false, skipped: true };
  }
  return { events, koed: false, skipped: false };
}

function buffMultiplier(c: Combatant): number {
  let m = 1;
  for (const s of c.status) if (s.kind === "buff") m += s.magnitude / 100;
  for (const s of c.status) if (s.kind === "weaken") m -= s.magnitude / 100;
  return Math.max(0.3, m);
}

// Core attack resolution shared by Attack / Special / Ultimate.
function strike(
  attacker: Combatant, defender: Combatant, settings: BattleSettings,
  opts: { powerPct: number; guaranteedHit?: boolean; label: string; ultimate?: boolean },
): { events: BattleEvent[]; koed: boolean } {
  const events: BattleEvent[] = [];

  // Stealth: a stealthed defender phases out of the next non-guaranteed attack.
  if (!opts.guaranteedHit) {
    const stealthIdx = defender.status.findIndex(s => s.kind === "stealth");
    if (stealthIdx >= 0) {
      defender.status.splice(stealthIdx, 1); // consumed by dodging one hit
      events.push({ text: `🫥 **${defender.cardName}** is in **Stealth** — the ${opts.label} finds only shadow!`, flash: "dodge" });
      return { events, koed: false };
    }
  }

  // Miss / dodge (skipped for guaranteed-hit ultimates).
  // Each fighter uses its own side's numbers. A blank side falls back to the
  // shared rule, which is what both fighters used before the split.
  if (!opts.guaranteedHit) {
    const atkRules = sideCombatRules(settings, attacker.isAi);
    const defRules = sideCombatRules(settings, defender.isAi);
    const missPct = Math.max(0, atkRules.missChancePct - attacker.stats.accuracy + 90);
    if (chance(missPct)) {
      events.push({ text: `💨 **${attacker.cardName}**'s ${opts.label} misses!`, flash: "miss" });
      return { events, koed: false };
    }
    const dodgePct = Math.min(70, defender.stats.dodge - settings.dodgeChancePct + defRules.dodgeChancePct + defender.stats.luck / 4);
    if (chance(dodgePct)) {
      events.push({ text: `🌀 **${defender.cardName}** dodges the ${opts.label}!`, flash: "dodge" });
      maybeCounter(defender, attacker, settings, events);
      return { events, koed: defender.hp > 0 && attacker.hp <= 0 };
    }
  }

  // Perfect block when defending.
  if (defender.defending && chance(25)) {
    events.push({ text: `🧱 **${defender.cardName}** perfectly blocks the ${opts.label}!`, flash: "shield" });
    maybeCounter(defender, attacker, settings, events);
    return { events, koed: false };
  }

  // Base damage with diminishing returns vs defense.
  const boost = 1 + attacker.nextAttackBoostPct / 100;
  const rawAtk = attacker.stats.attack * (opts.powerPct / 100) * boost * buffMultiplier(attacker);
  const effDef = defender.stats.defense * (defender.defending ? 2 : 1);
  let dmg = rawAtk * (rawAtk / (rawAtk + effDef * 0.9));

  // Critical hit. The attacker's side shifts the derived crit the same way dodge does.
  const atkCrit = sideCombatRules(settings, attacker.isAi);
  const critPct = Math.min(80, attacker.stats.critChance - settings.critChancePct + atkCrit.critChancePct + attacker.stats.luck / 3);
  let crit = false;
  if (!opts.ultimate && chance(critPct)) {
    crit = true;
    dmg *= settings.critMultiplierPct / 100;
  }
  dmg = Math.max(1, Math.round(vary(dmg, 0.12)));

  // Reflect: part of the damage bounces back before mitigation of shield.
  const reflect = defender.status.find(s => s.kind === "reflect");
  if (reflect) {
    const back = Math.max(1, Math.round(dmg * reflect.magnitude / 100));
    attacker.hp -= back;
    events.push({ text: `🪞 **${defender.cardName}** reflects **${back}** damage back!`, flash: "counter" });
  }

  // Shield soak → HP.
  let text = "";
  if (defender.shield > 0) {
    const absorbed = Math.min(defender.shield, dmg);
    defender.shield -= absorbed;
    const overflow = dmg - absorbed;
    defender.hp -= overflow;
    if (defender.shield <= 0 && overflow >= 0) {
      text = `🛡️💥 **${attacker.cardName}**'s ${opts.label} shatters the shield and deals **${overflow}**!`;
      events.push({ text, flash: "shield_break" });
    } else {
      text = `🛡️ Shield absorbs **${absorbed}** of **${attacker.cardName}**'s ${opts.label}.`;
      events.push({ text, flash: "shield" });
    }
  } else {
    defender.hp -= dmg;
    const icon = crit ? "💥" : opts.ultimate ? "☄️" : "⚔️";
    text = `${icon} **${attacker.cardName}**'s ${opts.label} hits for **${dmg}**${crit ? " — CRITICAL!" : ""}`;
    events.push({ text, flash: crit ? "crit" : opts.ultimate ? "ultimate" : undefined });
  }

  attacker.nextAttackBoostPct = 0;

  // Last stand — survive a lethal blow once.
  if (defender.hp <= 0 && !defender.lastStandUsed && chance(Math.min(35, 8 + defender.stats.luck))) {
    defender.hp = 1;
    defender.lastStandUsed = true;
    events.push({ text: `🔆 **${defender.cardName}** refuses to fall — **LAST STAND** at 1 HP!`, flash: "laststand" });
    return { events, koed: false };
  }

  if (defender.hp > 0) maybeCounter(defender, attacker, settings, events);
  return { events, koed: defender.hp <= 0 };
}

function maybeCounter(defender: Combatant, attacker: Combatant, settings: BattleSettings, events: BattleEvent[]) {
  if (defender.hp <= 0 || attacker.hp <= 0) return;
  if (!chance(settings.counterChancePct + defender.stats.luck / 5)) return;
  const dmg = Math.max(1, Math.round(defender.stats.attack * 0.5 * buffMultiplier(defender)));
  const absorbed = Math.min(attacker.shield, dmg);
  attacker.shield -= absorbed;
  attacker.hp -= (dmg - absorbed);
  events.push({ text: `↩️ **${defender.cardName}** counters for **${dmg}**!`, flash: "counter" });
}

export function resolveMove(
  settings: BattleSettings, actor: Combatant, foe: Combatant, move: MoveType,
): TurnResult {
  const events: BattleEvent[] = [];
  let koed = false;

  switch (move) {
    case "attack": {
      const r = strike(actor, foe, settings, { powerPct: 100, label: "attack" });
      events.push(...r.events); koed = r.koed;
      if (!koed && actor.doubleNextAttack) {
        actor.doubleNextAttack = false;
        events.push({ text: `⚡ Double strike!`, flash: "combo" });
        const r2 = strike(actor, foe, settings, { powerPct: 65, label: "follow-up" });
        events.push(...r2.events); koed = r2.koed;
      } else if (!koed && chance(10 + actor.stats.luck / 4)) {
        events.push({ text: `🔗 **${actor.cardName}** chains a **combo**!`, flash: "combo" });
        const r2 = strike(actor, foe, settings, { powerPct: 45, label: "combo hit" });
        events.push(...r2.events); koed = r2.koed;
      }
      break;
    }
    case "special": {
      // The card's signature moveset drives its Special (falls back to a
      // generic heavy strike for a card with no assigned moveset).
      const ms = actor.movesetDef ?? getMoveset(actor.moveset);
      const cost = ms?.energyCost ?? settings.specialCost;
      if (actor.energy < cost) {
        events.push({ text: `⚠️ **${actor.cardName}** lacks energy for ${ms ? `**${ms.name}**` : "a Special Attack"} and staggers.` });
        break;
      }
      actor.energy -= cost;
      if (!ms || ms.kind === "strike") {
        const label = ms?.name ?? "Special Attack";
        if (ms) events.push({ text: `${ms.emoji} **${actor.cardName}** uses **${ms.name}**!` });
        const r = strike(actor, foe, settings, { powerPct: ms?.powerPct ?? 160, label });
        events.push(...r.events); koed = r.koed;
        if (!koed && ms?.followUpPct) {
          const r2 = strike(actor, foe, settings, { powerPct: ms.followUpPct, label: `${label} (follow-up)` });
          events.push(...r2.events); koed = r2.koed;
        }
      } else {
        events.push({ text: `${ms.emoji} **${actor.cardName}** uses **${ms.name}**!` });
        events.push(...applyMovesetEffect(ms.effect!, actor, foe, settings));
        koed = foe.hp <= 0;
      }
      break;
    }
    case "ultimate": {
      if (actor.ultimate < actor.stats.ultimateMax) {
        events.push({ text: `⚠️ **${actor.cardName}**'s ultimate isn't charged yet.` });
        break;
      }
      actor.ultimate = 0;
      events.push({ text: `💀 **${actor.cardName}** unleashes its **ULTIMATE**!`, flash: "ultimate" });
      const r = strike(actor, foe, settings, { powerPct: settings.ultimateDamagePct, label: "ultimate", guaranteedHit: true, ultimate: true });
      events.push(...r.events); koed = r.koed;
      break;
    }
    case "defend": {
      actor.defending = true;
      const shield = Math.round(actor.stats.maxHealth * settings.shieldStrengthPct / 100);
      actor.shield += shield;
      events.push({ text: `🛡️ **${actor.cardName}** braces and gains a **${shield}** HP shield.`, flash: "shield" });
      break;
    }
    case "charge": {
      actor.energy = Math.min(actor.stats.energyMax, actor.energy + settings.chargeEnergyGain);
      actor.ultimate = Math.min(actor.stats.ultimateMax, actor.ultimate + settings.ultimateChargePerTurn);
      actor.nextAttackBoostPct += 30;
      events.push({ text: `⚡ **${actor.cardName}** charges — energy up, next attack empowered.`, flash: "combo" });
      break;
    }
    case "special_card": {
      const def = getEffectDef(actor.specialEffect);
      if (!def || !actor.specialCardId) {
        events.push({ text: `⚠️ **${actor.cardName}** has no special support card equipped.` });
        break;
      }
      if (actor.specialCooldownRemaining > 0) {
        events.push({ text: `⏳ Special card on cooldown (${actor.specialCooldownRemaining} more turn(s)).` });
        break;
      }
      actor.specialCooldownRemaining = actor.specialCooldownMax;
      events.push(...def.apply(actor, foe, settings));
      koed = foe.hp <= 0;
      break;
    }
    case "item": {
      const item = actor.item ?? getBattleItem(actor.itemId);
      if (!item) {
        events.push({ text: `⚠️ **${actor.cardName}** has no battle item equipped.` });
        break;
      }
      if ((actor.itemChargesRemaining ?? 0) <= 0) {
        events.push({ text: `🎒 **${item.name}** is out of charges.` });
        break;
      }
      if ((actor.itemCooldownRemaining ?? 0) > 0) {
        events.push({ text: `⏳ **${item.name}** on cooldown (${actor.itemCooldownRemaining} more turn(s)).` });
        break;
      }
      const outcome = applyItemEffect(item, actor, foe);
      events.push(...outcome.events);
      koed = outcome.koed || foe.hp <= 0;
      actor.itemChargesRemaining = (actor.itemChargesRemaining ?? 0) - 1;
      actor.itemCooldownRemaining = item.cooldown;
      break;
    }
    case "skip": {
      actor.energy = Math.min(actor.stats.energyMax, actor.energy + Math.round(settings.energyGainPerTurn / 2));
      events.push({ text: `⏭️ **${actor.cardName}** waits and watches.` });
      break;
    }
    default:
      break;
  }

  if (actor.hp < 0) actor.hp = 0;
  if (foe.hp < 0) foe.hp = 0;
  return { events, koed };
}

// Public strike primitive.
//
// `strike` above is the single source of truth for the damage maths — variance,
// defense curve, crit, stealth, miss/dodge, perfect block, reflect, shield soak,
// last stand and counters. Team modes (Siege Battle) need to land a blow with a
// custom power/label without re-deriving any of that, so this thin wrapper
// exposes it. Callers get exactly what a normal attack would do.
export function strikeWith(
  settings: BattleSettings, attacker: Combatant, defender: Combatant,
  opts: { powerPct: number; label: string; guaranteedHit?: boolean; ultimate?: boolean },
): { events: BattleEvent[]; koed: boolean } {
  return strike(attacker, defender, settings, opts);
}

// Team / AoE ultimate — the "full bar" pay-off in a team battle. Once an actor's
// meter is charged it can spend it on the whole enemy line at once: the chosen
// FOCUS card takes the full ultimate blow (enough to wipe it), every other living
// foe takes a splash. Returns which foes fell, aligned to the `foes` array, so a
// team fight can advance every rank that dropped. Damage is guaranteed to land
// (like a single-target ultimate) but survivors may still counter.
export function resolveTeamUltimate(
  settings: BattleSettings, actor: Combatant, foes: Combatant[], focusIdx: number,
): { events: BattleEvent[]; koed: boolean[] } {
  const events: BattleEvent[] = [];
  const koed = foes.map(() => false);
  if (actor.ultimate < actor.stats.ultimateMax) {
    events.push({ text: `⚠️ **${actor.cardName}**'s ultimate isn't charged yet.` });
    return { events, koed };
  }
  actor.ultimate = 0;
  events.push({ text: `💀 **${actor.cardName}** unleashes a **TEAM ULTIMATE** on the whole line!`, flash: "ultimate" });
  const focusPct = settings.ultimateDamagePct;
  const splashPct = Math.max(20, Math.round(settings.ultimateDamagePct * 0.5));
  for (let i = 0; i < foes.length; i++) {
    const f = foes[i]!;
    if (f.hp <= 0) continue;
    const isFocus = i === focusIdx;
    const r = strike(actor, f, settings, {
      powerPct: isFocus ? focusPct : splashPct,
      label: isFocus ? "team ultimate" : "ultimate blast",
      guaranteedHit: true, ultimate: true,
    });
    events.push(...r.events);
    if (f.hp <= 0) koed[i] = true;
  }
  if (actor.hp < 0) actor.hp = 0;
  return { events, koed };
}

// Which moves are legal right now (for button enable/disable + AI).
export function availableMoves(actor: Combatant, settings: BattleSettings): Record<MoveType, boolean> {
  const specialCost = (actor.movesetDef ?? getMoveset(actor.moveset))?.energyCost ?? settings.specialCost;
  return {
    attack: true,
    special: actor.energy >= specialCost,
    defend: true,
    special_card: !!actor.specialEffect && !!actor.specialCardId && actor.specialCooldownRemaining === 0,
    charge: true,
    skip: true,
    ultimate: actor.ultimate >= actor.stats.ultimateMax,
    item: !!actor.itemId && (actor.itemChargesRemaining ?? 0) > 0 && (actor.itemCooldownRemaining ?? 0) === 0,
  };
}
