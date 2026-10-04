/** Progressive answer hints — letter reveals after unique guesses (spawn-style). */

/** Unique guesses needed to unlock each extra letter beyond the baseline. */
export const GUESSES_PER_EXTRA_LETTER = 2;

/** Never fully reveal via hints while the round is live (leave this fraction hidden). */
export const LIVE_HINT_HIDE_FRACTION = 0.28;

export type HintMaskResult = {
  /** Display string using ● for hidden letters */
  masked: string;
  /** How many letter slots are still hidden */
  hiddenCount: number;
  /** How many unique guesses drove this stage */
  guessCount: number;
  /** Human label for the embed footer */
  stageLabel: string;
};

/**
 * Build a progressive mask of `answer`.
 * Baseline: first letter of each word visible (like card-spawn Easy).
 * Then one extra letter every {@link GUESSES_PER_EXTRA_LETTER} unique guesses.
 * Never fully reveals while live (keeps a fraction hidden).
 */
export function maskAnswerHint(answer: string, uniqueGuessCount: number): HintMaskResult {
  const text = String(answer ?? "").trim().slice(0, 80);
  if (!text) {
    return { masked: "—", hiddenCount: 0, guessCount: uniqueGuessCount, stageLabel: "No graded answer" };
  }

  const chars = [...text];
  const isLetter = (ch: string) => /[A-Za-z0-9]/.test(ch);

  // Indices that can be hidden/revealed
  const letterIdx: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (isLetter(chars[i]!)) letterIdx.push(i);
  }

  // Baseline: first letter of each word always shown
  const revealed = new Set<number>();
  let atWordStart = true;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (!isLetter(ch)) {
      atWordStart = true;
      continue;
    }
    if (atWordStart) {
      revealed.add(i);
      atWordStart = false;
    }
  }

  // Remaining letters in left-to-right order for predictable hangman feel
  const remaining = letterIdx.filter(i => !revealed.has(i));
  const maxHide = Math.max(1, Math.ceil(remaining.length * LIVE_HINT_HIDE_FRACTION));
  const maxReveal = Math.max(0, remaining.length - maxHide);
  const extra = Math.min(
    maxReveal,
    Math.max(0, Math.floor(Math.max(0, uniqueGuessCount) / GUESSES_PER_EXTRA_LETTER)),
  );
  for (let i = 0; i < extra; i++) revealed.add(remaining[i]!);

  const masked = chars.map((ch, i) => {
    if (!isLetter(ch)) return ch === " " ? "   " : ch;
    return revealed.has(i) ? ch.toUpperCase() : "●";
  }).join("");

  const hiddenCount = letterIdx.filter(i => !revealed.has(i)).length;
  const stageLabel = uniqueGuessCount <= 0
    ? "First letters unlocked"
    : hiddenCount === 0
      ? "Nearly revealed"
      : `+${extra} letter${extra === 1 ? "" : "s"} from guesses`;

  return { masked, hiddenCount, guessCount: uniqueGuessCount, stageLabel };
}
