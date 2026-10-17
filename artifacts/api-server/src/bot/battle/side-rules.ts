// Player rules and AI rules.
//
// The shared miss / dodge / crit numbers stay the baseline. A side uses its own
// number only after an admin types one. Blank on that side falls back here.

export interface SideRuleSettings {
  missChancePct: number;
  dodgeChancePct: number;
  critChancePct: number;
  userMissChancePct?: number | null;
  userDodgeChancePct?: number | null;
  userCritChancePct?: number | null;
  aiMissChancePct?: number | null;
  aiDodgeChancePct?: number | null;
  aiCritChancePct?: number | null;
  aiAllowUltimate?: boolean | null;
  aiAllowSpecial?: boolean | null;
  aiAllowItem?: boolean | null;
  aiAllowDefend?: boolean | null;
  aiAllowCharge?: boolean | null;
}

export interface SideCombatRules {
  missChancePct: number;
  dodgeChancePct: number;
  critChancePct: number;
}

export function sideCombatRules(settings: SideRuleSettings, isAi: boolean): SideCombatRules {
  if (isAi) {
    return {
      missChancePct: settings.aiMissChancePct ?? settings.missChancePct,
      dodgeChancePct: settings.aiDodgeChancePct ?? settings.dodgeChancePct,
      critChancePct: settings.aiCritChancePct ?? settings.critChancePct,
    };
  }
  return {
    missChancePct: settings.userMissChancePct ?? settings.missChancePct,
    dodgeChancePct: settings.userDodgeChancePct ?? settings.dodgeChancePct,
    critChancePct: settings.userCritChancePct ?? settings.critChancePct,
  };
}

export function sideRuleLabel(value: number | null | undefined, shared: number): string {
  if (value == null) return `${shared}% · shared`;
  return `${value}%`;
}

const AI_MOVES: Record<string, keyof SideRuleSettings> = {
  ultimate: "aiAllowUltimate",
  special: "aiAllowSpecial",
  item: "aiAllowItem",
  defend: "aiAllowDefend",
  charge: "aiAllowCharge",
};

/** Attack and skip stay available. A missing toggle means the move is allowed. */
export function aiMoveAllowed(settings: SideRuleSettings, move: string): boolean {
  const key = AI_MOVES[move];
  if (!key) return true;
  return settings[key] !== false;
}
