// Animation system types.
// These describe the inputs/outputs of the pack and battle renderers. They are
// intentionally decoupled from Discord so the animation modules can be tested
// offline and reused for other surfaces (e.g. a web dashboard).

import type { Rarity } from "../cards-data.js";
import type { RenderCard } from "../battle/image/render.js";

export type AnimationSpeed = "slow" | "normal" | "fast";

export interface AnimationSettings {
  enabled: boolean;
  speed: AnimationSpeed;
}

export interface PackAnimationInput {
  tier: string;          // e.g. "Basic", "Premium", "Legendary"
  tierColor: number;
  cards: RenderCard[];
  shinies: boolean[];
}

export interface BattleAnimationInput {
  attacker: RenderCard;
  defender: RenderCard;
  attackerHp: number;
  attackerMaxHp: number;
  defenderHp: number;
  defenderMaxHp: number;
  damage: number;
  isCrit: boolean;
  isHit: boolean;        // false = miss/dodge
  moveName: string;
  attackerWon: boolean;    // if this blow ended the battle
  defenderWon: boolean;  // (should not happen on a single hit, but kept for symmetry)
  background?: string | null;
  /**
   * Admin-uploaded backdrop (raw bytes or a URL). Fighters trade blows over
   * this image, cover-fit with a readability wash. The HQ siege passes its
   * castle frame here. When it is missing, the fight uses the gradient.
   */
  backgroundImage?: Buffer | string | null;
}

export interface VictoryAnimationInput {
  winner: RenderCard;
  loser: RenderCard;
  background?: string | null;
  /** Admin-uploaded battle image (bytes or URL). Wins over the gradient. */
  backgroundImage?: Buffer | string | null;
}

export interface AnimationResult {
  buffer: Buffer;
  width: number;
  height: number;
  frameCount: number;
  durationMs: number;
}
