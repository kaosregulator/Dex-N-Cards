// Loads each rarity's frame colour before a card render.
// The sample always comes from the frame that rarity is wearing right now, so a
// rainbow frame and a red frame take the same path with a different picture.

import type { Rarity } from "../cards-data.js";
import { RARITY_ORDER } from "../cards-data.js";
import type { RarityAccent } from "../animations/card-frames.js";
import { peekBattleSettings } from "./config-engine.js";
import { parseHexColor, resolveFrameAccent, type FrameImageColor } from "./frame-color.js";
import { builtinRarityFrame, resolveRarityFrame } from "./rarity-frame.js";
import type { FrameDraw } from "./frame-styles.js";

export async function loadRarityAccents(
  guildId: string,
  frames: Partial<Record<Rarity, FrameImageColor>>,
  buffers: Partial<Record<FrameImageColor, Buffer>>,
): Promise<Partial<Record<Rarity, RarityAccent>>> {
  const settings = await peekBattleSettings(guildId) ?? {
    battleFrameColorMode: "image",
    battleFrameColorA: null,
    battleFrameColorB: null,
    battleFrameByRarity: null,
  };
  const out: Partial<Record<Rarity, RarityAccent>> = {};
  for (const rarity of RARITY_ORDER) {
    const spec = resolveRarityFrame(settings, rarity);
    const fallback = parseHexColor(builtinRarityFrame(rarity).a);
    const frameImage = frames[rarity] ?? null;
    const accent = await resolveFrameAccent({
      mode: spec.mode,
      colorA: spec.colorA,
      colorB: spec.colorB,
      rarityColor: fallback,
      frameImage,
      frameBuffer: frameImage ? buffers[frameImage] ?? null : null,
    });
    out[rarity] = { ...accent, style: spec.style };
  }
  return out;
}

/** The frame a card should wear right now, including outside a render scope. */
export async function loadCardFrameDraw(
  guildId: string,
  rarity: Rarity,
  opts?: { artUrl?: string | null; rarityEmoji?: string | null },
): Promise<FrameDraw> {
  const settings = await peekBattleSettings(guildId) ?? {
    battleFrameColorMode: "image",
    battleFrameColorA: null,
    battleFrameColorB: null,
    battleFrameByRarity: null,
  };
  const spec = resolveRarityFrame(settings, rarity);
  const fallback = parseHexColor(builtinRarityFrame(rarity).a) ?? 0x95a5a6;
  const accent = await resolveFrameAccent({
    mode: spec.mode,
    colorA: spec.colorA,
    colorB: spec.colorB,
    rarityColor: fallback,
    artUrl: opts?.artUrl,
    rarityEmoji: opts?.rarityEmoji,
  });
  return {
    style: spec.style,
    color: accent.color ?? fallback,
    paint: accent.paint,
    blendA: accent.blendA,
    blendB: accent.blendB,
  };
}
