// Pack rarity allow-lists.
// null / empty = the pack's built-in rates (including spill into nearby rarities).
// A saved list is the only set of rarities that pack may pull. Keys are the
// same ones /rarity uses: built-in ids, or `custom:<slug>`.

export function normalizeAllowList(keys: readonly string[] | null | undefined): string[] | null {
  if (!keys || keys.length === 0) return null;
  const unique = [...new Set(keys.map(k => k.trim()).filter(Boolean))];
  return unique.length > 0 ? unique : null;
}

/**
 * Weights for an explicit allow-list.
 * Built-in rates stay when they are already above zero.
 * A rarity the admin turned on that has a 0% rate gets a small floor (the
 * smallest positive rate in the pack's table) so it can drop without taking
 * over. "Only mythic" — every selected rate is 0 — is an even split, which
 * is 100% when a single rarity is selected.
 */
export function allowListWeights(
  base: Record<string, number>,
  allowed: readonly string[],
): Array<{ key: string; weight: number }> {
  const unique = normalizeAllowList(allowed);
  if (!unique) return [];
  const raw = unique.map(key => ({
    key,
    weight: Math.max(0, Number(base[key] ?? 0)) || 0,
  }));
  const positive = raw.filter(w => w.weight > 0);
  if (positive.length === 0) return raw.map(w => ({ key: w.key, weight: 1 }));
  const basePositive = Object.values(base)
    .map(n => Math.max(0, Number(n) || 0))
    .filter(w => w > 0);
  const floor = basePositive.length > 0 ? Math.min(...basePositive) : 1;
  return raw.map(w => ({ key: w.key, weight: w.weight > 0 ? w.weight : floor }));
}

export function rollWeightedKey(
  weights: ReadonlyArray<{ key: string; weight: number }>,
  rng: () => number = Math.random,
): string | null {
  const usable = weights.filter(w => w.weight > 0);
  const total = usable.reduce((sum, w) => sum + w.weight, 0);
  if (total <= 0) return null;
  let cursor = rng() * total;
  for (const w of usable) {
    cursor -= w.weight;
    if (cursor <= 0) return w.key;
  }
  return usable[usable.length - 1]?.key ?? null;
}
