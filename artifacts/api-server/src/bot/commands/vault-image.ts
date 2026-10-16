// Pure helpers for turning a Vault Values item into a DN card.
// Kept out of mttvalues.ts so tests don't have to open the database.

import type { Rarity } from "../cards-data.js";

/**
 * Vault Values stores the real item art as a `wix:image://` URI. `imagelink`
 * is a small cropped thumbnail (often a different file, sometimes AVIF) that
 * Discord won't show as a card. Prefer the original media file.
 */
export function vaultItemImageUrl(
  wixImage: string | null | undefined,
  imageLink: string | null | undefined,
): string | null {
  if (wixImage?.startsWith("wix:image://")) {
    const rest = wixImage.slice("wix:image://v1/".length);
    const mediaId = decodeURIComponent(rest.split("/")[0]?.split("#")[0] ?? "");
    if (mediaId) return `https://static.wixstatic.com/media/${mediaId}`;
  }
  if (imageLink) {
    const match = imageLink.match(/\/media\/([^/?#]+)/);
    if (match?.[1]) return `https://static.wixstatic.com/media/${decodeURIComponent(match[1])}`;
    return imageLink;
  }
  return null;
}

/** Map a Vault Values suggested rarity onto a built-in DN card rarity. */
export function dnRarityFromVault(suggested: string | null | undefined): Rarity | null {
  const s = (suggested ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s.includes("mythic") || s.includes("limited") || s.includes("exotic")) return "mythic";
  if (s.includes("legend")) return "legendary";
  if (s.includes("epic")) return "epic";
  if (s.includes("uncommon")) return "uncommon";
  if (s.includes("rare")) return "rare";
  if (s.includes("common")) return "common";
  return null;
}
