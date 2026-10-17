/**
 * Create-time duplicate guard.
 *
 * Exact names and near-typos of the whole name are blocked.
 * A shorter name that is only a word inside a longer one is a different card
 * ("edjer" vs "super edjer").
 */

export function normalizeCardName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ac = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ac === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}

/** True when `incoming` should be refused because `existing` is the same card. */
export function cardNamesCollide(existing: string, incoming: string): boolean {
  const a = normalizeCardName(existing);
  const b = normalizeCardName(incoming);
  if (!a || !b) return false;
  if (a === b) return true;
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  // Shared word only — "edjer" inside "super edjer" is not a duplicate.
  if (shorter.length < Math.ceil(longer.length * 0.85)) return false;
  if (shorter.length < 4) return false;
  const allowance = longer.length >= 12 ? 2 : 1;
  return levenshtein(a, b) <= allowance;
}

export function findCollidingCard<T extends { name: string }>(cards: T[], incoming: string): T | undefined {
  return cards.find(c => cardNamesCollide(c.name, incoming));
}

export function duplicateCardMessage(incoming: string, existing: { id: number; name: string }): string {
  const same = normalizeCardName(incoming) === normalizeCardName(existing.name);
  if (same) {
    return `❌ A card named **${existing.name}** already exists (ID #${existing.id}). Use \`/edit_card\` or \`/edit_image\` to change it.`;
  }
  return `❌ **${incoming}** is too close to existing card **${existing.name}** (ID #${existing.id}). Use \`/edit_card\` if that is the one you meant.`;
}
