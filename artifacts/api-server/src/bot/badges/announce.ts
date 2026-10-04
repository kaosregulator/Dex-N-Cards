/** Build small Discord embeds + animated emblem attachments for badge events. */

import {
  AttachmentBuilder,
  EmbedBuilder,
  type MessageCreateOptions,
} from "discord.js";
import type { BadgeRule } from "@workspace/db";
import {
  progressBar,
  shouldShowEmblem,
  xpToNextLevel,
  BADGE_LEVEL_MAX,
  type LevelGainResult,
} from "../../lib/badges/levels.js";
import { renderBadgeEmblemGif } from "./emblem-canvas.js";

export async function buildBadgeShowcase(opts: {
  result: LevelGainResult;
  rule: BadgeRule;
  mention?: string | null;
  forceEmblem?: boolean;
}): Promise<{ embeds: EmbedBuilder[]; files: AttachmentBuilder[]; content?: string }> {
  const { result, rule } = opts;
  const showGif = opts.forceEmblem || shouldShowEmblem(result);
  const tier = result.tier;
  const level = result.badge.level;
  const bar = progressBar(level, result.badge.xp);
  const need = level >= BADGE_LEVEL_MAX ? 0 : xpToNextLevel(level);

  let headline: string;
  if (result.unlocked) headline = "Emblem awakened";
  else if (result.tierChanged) headline = `${result.previousTier.label} → ${tier.label}`;
  else if (result.leveled) headline = `Level up · ${result.previousLevel} → ${level}`;
  else headline = "Emblem resonates";

  const embed = new EmbedBuilder()
    .setColor(tier.accent)
    .setTitle(`${rule.emoji} ${rule.name}`)
    .setDescription(
      [
        `**${headline}**`,
        `Lv. **${level}** · ${tier.label}`,
        level >= BADGE_LEVEL_MAX
          ? "`██████████` Apex"
          : `\`${bar}\` ${result.badge.xp}/${need}`,
      ].join("\n"),
    )
    .setFooter({ text: "This emblem notice cleans up shortly" });

  const files: AttachmentBuilder[] = [];
  if (showGif) {
    const gif = await renderBadgeEmblemGif({
      name: rule.name,
      emoji: rule.emoji,
      level,
      subtitle: result.unlocked
        ? "First spark"
        : result.tierChanged
          ? `${tier.label} form unlocked`
          : `Lv. ${level}`,
      seed: `${rule.id}-${level}-${tier.key}`,
    });
    if (gif) {
      const filename = `badge-${rule.id}-lv${level}.gif`;
      files.push(new AttachmentBuilder(gif, { name: filename }));
      embed.setImage(`attachment://${filename}`);
    }
  }

  const content = opts.mention
    ? (result.unlocked
      ? `✨ ${opts.mention} awakened **${rule.name}**`
      : result.leveled
        ? `✨ ${opts.mention} — **${rule.name}** grew to **Lv. ${level}**`
        : undefined)
    : undefined;

  return { embeds: [embed], files, content };
}

export async function buildMultiBadgePayload(opts: {
  results: LevelGainResult[];
  rules: BadgeRule[];
  mention: string;
}): Promise<MessageCreateOptions | null> {
  const flashy = opts.results.filter(r => shouldShowEmblem(r) || r.leveled || r.unlocked);
  if (!flashy.length) return null;

  // Prefer the most exciting single emblem (tier change > unlock > highest level).
  const ranked = [...flashy].sort((a, b) => {
    const score = (r: LevelGainResult) =>
      (r.tierChanged ? 1000 : 0) + (r.unlocked ? 500 : 0) + r.badge.level + r.levelsGained;
    return score(b) - score(a);
  });
  const primary = ranked[0]!;
  const rule = opts.rules.find(r => r.id === primary.badge.id);
  if (!rule) return null;

  const showcase = await buildBadgeShowcase({
    result: primary,
    rule,
    mention: opts.mention,
    forceEmblem: true,
  });

  const extras = flashy
    .filter(r => r.badge.id !== primary.badge.id)
    .map(r => {
      const rr = opts.rules.find(x => x.id === r.badge.id);
      if (!rr) return null;
      return `${rr.emoji} **${rr.name}** Lv.${r.badge.level}`;
    })
    .filter(Boolean);

  if (extras.length) {
    showcase.embeds[0]?.addFields({
      name: "Also evolving",
      value: extras.join("\n").slice(0, 1000),
      inline: false,
    });
  }

  return {
    content: showcase.content,
    embeds: showcase.embeds,
    files: showcase.files,
  };
}
