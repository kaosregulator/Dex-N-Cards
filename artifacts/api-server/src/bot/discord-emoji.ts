/**
 * Discord shows a blank square when a custom emoji name is missing or is the
 * one-character placeholder `_`. Canvas text does the same if that markup is
 * painted with fillText. These helpers keep a real name on the markup and a
 * real glyph (or nothing) on buttons.
 */

const CUSTOM = /^<(a)?:([\w~]+):(\d+)>$/;
const CUSTOM_GLOBAL = /<(a)?:([\w~]+):(\d+)>/g;

export function repairDiscordEmojiMarkup(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(CUSTOM);
  if (!match) return trimmed;
  const animated = Boolean(match[1]);
  const name = safeEmojiName(match[2] ?? "");
  const id = match[3]!;
  return animated ? `<a:${name}:${id}>` : `<:${name}:${id}>`;
}

function safeEmojiName(name: string): string {
  if (/^[\w~]{2,32}$/.test(name) && name !== "_") return name;
  return "emoji";
}

/** Button and select emoji. Null means leave the emoji off so one bad glyph cannot reject the message. */
export function buttonEmoji(
  raw: string | null | undefined,
): string | { id: string; name: string; animated?: boolean } | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const match = trimmed.match(CUSTOM);
  if (match) {
    return {
      id: match[3]!,
      name: safeEmojiName(match[2] ?? ""),
      animated: Boolean(match[1]),
    };
  }
  const unicode = trimmed.replace(/[\uFE00-\uFE0F]/g, "").trim();
  if (!unicode || /[<>]/.test(unicode)) return null;
  return unicode;
}

/** Text safe to paint on a canvas. Custom markup becomes its name, never `<:_:id>`. */
export function canvasSafeText(text: string): string {
  return text.replace(CUSTOM_GLOBAL, (_all, _animated, name: string) => {
    return safeEmojiName(name) === "emoji" && (name === "_" || name.length < 2) ? "" : safeEmojiName(name);
  }).replace(/\s{2,}/g, " ").trim();
}

/**
 * Text for the canvas painter. Real `<:name:id>` markup stays so the image
 * drawer can paint the custom emoji. A broken `_` placeholder is dropped.
 */
export function canvasPaintableText(text: string): string {
  return text.replace(CUSTOM_GLOBAL, (all, _animated, name: string) => {
    if (!name || name === "_" || name.length < 2) return "";
    return all;
  }).replace(/\s{2,}/g, " ").trim();
}
