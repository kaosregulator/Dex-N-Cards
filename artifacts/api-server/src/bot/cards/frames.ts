// Cosmetic frame registry for card leveling.
//
// Each rarity has a DEFAULT frame (always available) plus two EXTRA frames that
// unlock as the card levels up. A frame is a purely-visual decoration applied
// to a card's showcase embed: a title wrap, an accent color, and a name. No
// gameplay effect whatsoever.

import type { Rarity } from "../cards-data.js";

export interface Frame {
  id: string;
  name: string;
  emoji: string;
  rarity: Rarity;
  unlockLevel: number;         // card level required to equip
  color: number;               // embed accent
  // Decorative wrap applied around the card name in the showcase title.
  wrap: (name: string) => string;
  // Account-wide prestige frame (a raid reward). Equippable on ANY owned card,
  // ignores rarity + level; instead gated on an explicit unlock (raid clear).
  // The `rarity` field is nominal for these and not used for matching.
  account?: boolean;
}

// Level thresholds at which each rarity's frames unlock.
export const FRAME_UNLOCK_LEVELS = [1, 5, 10] as const;

const plain = (l: string, r: string) => (name: string) => `${l} ${name} ${r}`;

// Three frames per rarity: [default @L1, extra @L5, extra @L10].
const RARITY_FRAMES: Record<Rarity, [Frame, Frame, Frame]> = {
  common: [
    { id: "common_default", name: "Standard", emoji: "⚪", rarity: "common", unlockLevel: 1, color: 0x95a5a6, wrap: plain("⟨", "⟩") },
    { id: "common_iron", name: "Iron Edge", emoji: "🔩", rarity: "common", unlockLevel: 50, color: 0x808b96, wrap: plain("┃", "┃") },
    { id: "common_slate", name: "Slate", emoji: "◾", rarity: "common", unlockLevel: 100, color: 0x5d6d7e, wrap: plain("▪", "▪") },
  ],
  uncommon: [
    { id: "uncommon_default", name: "Verdant", emoji: "🟢", rarity: "uncommon", unlockLevel: 1, color: 0x2ecc71, wrap: plain("⟨", "⟩") },
    { id: "uncommon_leaf", name: "Leafbound", emoji: "🍃", rarity: "uncommon", unlockLevel: 50, color: 0x27ae60, wrap: plain("❨", "❩") },
    { id: "uncommon_jade", name: "Jade", emoji: "💚", rarity: "uncommon", unlockLevel: 100, color: 0x1abc9c, wrap: plain("༺", "༻") },
  ],
  rare: [
    { id: "rare_default", name: "Azure", emoji: "🔵", rarity: "rare", unlockLevel: 1, color: 0x3498db, wrap: plain("⟨", "⟩") },
    { id: "rare_tide", name: "Tidecaller", emoji: "🌊", rarity: "rare", unlockLevel: 50, color: 0x2980b9, wrap: plain("❨", "❩") },
    { id: "rare_frost", name: "Frostline", emoji: "❄️", rarity: "rare", unlockLevel: 100, color: 0x5dade2, wrap: plain("༺", "༻") },
  ],
  epic: [
    { id: "epic_default", name: "Amethyst", emoji: "🟣", rarity: "epic", unlockLevel: 1, color: 0x9b59b6, wrap: plain("⟨", "⟩") },
    { id: "epic_arcane", name: "Arcane", emoji: "🔮", rarity: "epic", unlockLevel: 50, color: 0x8e44ad, wrap: plain("❰", "❱") },
    { id: "epic_void", name: "Voidtouched", emoji: "🌌", rarity: "epic", unlockLevel: 100, color: 0x6c3483, wrap: plain("༺", "༻") },
  ],
  legendary: [
    { id: "legendary_default", name: "Golden", emoji: "🟡", rarity: "legendary", unlockLevel: 1, color: 0xf1c40f, wrap: plain("⟨", "⟩") },
    { id: "legendary_sunfire", name: "Sunfire", emoji: "☀️", rarity: "legendary", unlockLevel: 50, color: 0xf39c12, wrap: plain("❰", "❱") },
    { id: "legendary_royal", name: "Royal Crest", emoji: "👑", rarity: "legendary", unlockLevel: 100, color: 0xe67e22, wrap: plain("♜", "♜") },
  ],
  mythic: [
    { id: "mythic_default", name: "Limited Edition", emoji: "💎", rarity: "mythic", unlockLevel: 1, color: 0xe74c3c, wrap: plain("⟨", "⟩") },
    { id: "mythic_ember", name: "Ember Rift", emoji: "🔥", rarity: "mythic", unlockLevel: 50, color: 0xc0392b, wrap: plain("❰", "❱") },
    { id: "mythic_celestial", name: "Celestial", emoji: "✨", rarity: "mythic", unlockLevel: 100, color: 0xff5e78, wrap: plain("༺✧", "✧༻") },
  ],
};

// ── Raid-exclusive prestige frames (account-wide) ────────────────────────────
// Earned only by clearing a raid boss. Once unlocked they can be equipped on ANY
// owned card via /frame, regardless of that card's rarity or level. A boss can
// name a specific one via reward_frame_id; unspecified bosses grant the generic
// "Raid Champion". These are the endgame flex.
const raid = (id: string, name: string, emoji: string, color: number, wrap: (n: string) => string): Frame => ({
  id, name, emoji, rarity: "mythic", unlockLevel: 0, color, wrap, account: true,
});

export const RAID_FRAMES: Frame[] = [
  raid("raid_champion", "Raid Champion", "🐉", 0x2ecc71, plain("⟦🐉", "🐉⟧")),
  raid("raid_slayer", "Boss Slayer", "⚔️", 0xe74c3c, plain("⚔", "⚔")),
  raid("raid_vanguard", "Vanguard", "🛡️", 0x3498db, plain("❰🛡", "🛡❱")),
  raid("raid_ember", "Emberforged", "🔥", 0xe67e22, plain("🔥", "🔥")),
  raid("raid_eclipse", "Eclipse", "🌑", 0x8e44ad, plain("༺🌑", "🌑༻")),
  raid("raid_apex", "Apex Predator", "👑", 0xf1c40f, plain("♛", "♛")),
];

// The default raid frame granted when a boss doesn't name a specific one.
export const DEFAULT_RAID_FRAME_ID = "raid_champion";

const ALL_FRAMES: Frame[] = [...Object.values(RARITY_FRAMES).flat(), ...RAID_FRAMES];
const FRAME_BY_ID = new Map(ALL_FRAMES.map(f => [f.id, f]));

export function getRaidFrames(): Frame[] { return RAID_FRAMES; }

// Resolve a boss's reward frame id → a real frame (falls back to the generic
// Raid Champion when the id is unset or unknown).
export function raidFrameForBoss(rewardFrameId: string | null | undefined): Frame {
  return (rewardFrameId ? FRAME_BY_ID.get(rewardFrameId) : undefined)
    ?? FRAME_BY_ID.get(DEFAULT_RAID_FRAME_ID)!;
}

export function framesForRarity(rarity: Rarity): Frame[] {
  return RARITY_FRAMES[rarity] ?? RARITY_FRAMES.common;
}

export function getFrameById(id: string): Frame | undefined {
  return FRAME_BY_ID.get(id);
}

export function defaultFrameForRarity(rarity: Rarity): Frame {
  return framesForRarity(rarity)[0];
}

// The frame a user currently has active on a card: their equipped one if still
// valid, otherwise the rarity default. An account-wide raid frame is valid on
// ANY card as long as the viewer has unlocked it (pass the unlocked-id set);
// otherwise the usual rarity + level gate applies.
export function resolveActiveFrame(
  rarity: Rarity, equippedId: string | null, level: number,
  unlockedAccountFrames?: Set<string>,
): Frame {
  if (equippedId) {
    const f = FRAME_BY_ID.get(equippedId);
    if (f) {
      if (f.account) {
        if (unlockedAccountFrames?.has(f.id)) return f;
      } else if (f.rarity === rarity && level >= f.unlockLevel) {
        return f;
      }
    }
  }
  return defaultFrameForRarity(rarity);
}

export function isFrameUnlocked(frame: Frame, level: number): boolean {
  return level >= frame.unlockLevel;
}

// Map an EXPLICITLY equipped per-rarity level frame to its progression-image
// tier (the visual level frame drawn on the card). Returns null when nothing is
// equipped, or the equipped frame is an account/raid frame — those keep their
// own presentation and never override with a level image. Because the tiers are
// keyed on the frame's unlock level (1 / 50 / 100), the image reflects how far
// the card was levelled to earn that frame.
export function progTierForFrameId(
  equippedId: string | null | undefined,
): "l1" | "l50" | "l100" | null {
  if (!equippedId) return null;
  const f = FRAME_BY_ID.get(equippedId);
  if (!f || f.account) return null;
  return f.unlockLevel >= 100 ? "l100" : f.unlockLevel >= 50 ? "l50" : "l1";
}
