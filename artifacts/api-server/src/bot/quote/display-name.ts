// ─────────────────────────────────────────────────────────────────────────────
// Quote display names — Discord lets people use "fancy font" Unicode (math bold,
// fullwidth, circled, …) that looks fine in the client but paints as □ / tofu
// on @napi-rs/canvas (Arial / Orbitron don't cover those planes).
//
// Fold those styles back to plain Latin so canvas + webhook usernames stay
// readable. Prefer the real @handle when the nick is still unreadable.
// ─────────────────────────────────────────────────────────────────────────────

/** Build cp → ASCII for a contiguous A–Z then a–z block (52 code points). */
function fillAz(map: Map<number, string>, start: number): void {
  for (let i = 0; i < 26; i++) map.set(start + i, String.fromCharCode(0x41 + i));
  for (let i = 0; i < 26; i++) map.set(start + 26 + i, String.fromCharCode(0x61 + i));
}

/** Contiguous digit block (10 code points → 0–9). */
function fillDigits(map: Map<number, string>, start: number): void {
  for (let i = 0; i < 10; i++) map.set(start + i, String.fromCharCode(0x30 + i));
}

function buildFancyMap(): Map<number, string> {
  const m = new Map<number, string>();

  // Contiguous Mathematical Alphanumeric styles (A–Z + a–z).
  fillAz(m, 0x1d400); // bold
  fillAz(m, 0x1d434); // italic — h hole patched below
  fillAz(m, 0x1d468); // bold italic
  fillAz(m, 0x1d4d0); // bold script
  fillAz(m, 0x1d56c); // bold fraktur
  fillAz(m, 0x1d5a0); // sans-serif
  fillAz(m, 0x1d5d4); // sans-serif bold
  fillAz(m, 0x1d608); // sans-serif italic
  fillAz(m, 0x1d63c); // sans-serif bold italic
  fillAz(m, 0x1d670); // monospace

  // Digits
  fillDigits(m, 0x1d7ce); // bold
  fillDigits(m, 0x1d7d8); // double-struck
  fillDigits(m, 0x1d7e2); // sans-serif
  fillDigits(m, 0x1d7ec); // sans-serif bold
  fillDigits(m, 0x1d7f6); // monospace

  // Italic h is Planck constant; fillAz wrote a wrong glyph into the hole slot —
  // remove the unassigned slot mapping if present and map the real letterlike.
  m.delete(0x1d455);
  m.set(0x210e, "h");

  // Script / Fraktur / Double-struck have holes → Letterlike Symbols. Map both
  // the assigned math slots and the letterlike stand-ins explicitly.
  const scriptCap: Array<[number, string]> = [
    [0x1d49c, "A"], [0x212c, "B"], [0x1d49e, "C"], [0x1d49f, "D"],
    [0x2130, "E"], [0x2131, "F"], [0x1d4a2, "G"], [0x210b, "H"],
    [0x2110, "I"], [0x1d4a5, "J"], [0x1d4a6, "K"], [0x2112, "L"],
    [0x2133, "M"], [0x1d4a9, "N"], [0x1d4aa, "O"], [0x1d4ab, "P"],
    [0x1d4ac, "Q"], [0x211b, "R"], [0x1d4ae, "S"], [0x1d4af, "T"],
    [0x1d4b0, "U"], [0x1d4b1, "V"], [0x1d4b2, "W"], [0x1d4b3, "X"],
    [0x1d4b4, "Y"], [0x1d4b5, "Z"],
  ];
  const scriptSmall: Array<[number, string]> = [
    [0x1d4b6, "a"], [0x1d4b7, "b"], [0x1d4b8, "c"], [0x1d4b9, "d"],
    [0x212f, "e"], [0x1d4bb, "f"], [0x210a, "g"], [0x1d4bd, "h"],
    [0x1d4be, "i"], [0x1d4bf, "j"], [0x1d4c0, "k"], [0x1d4c1, "l"],
    [0x1d4c2, "m"], [0x1d4c3, "n"], [0x2134, "o"], [0x1d4c5, "p"],
    [0x1d4c6, "q"], [0x1d4c7, "r"], [0x1d4c8, "s"], [0x1d4c9, "t"],
    [0x1d4ca, "u"], [0x1d4cb, "v"], [0x1d4cc, "w"], [0x1d4cd, "x"],
    [0x1d4ce, "y"], [0x1d4cf, "z"],
  ];
  const frakturCap: Array<[number, string]> = [
    [0x1d504, "A"], [0x1d505, "B"], [0x212d, "C"], [0x1d507, "D"],
    [0x1d508, "E"], [0x1d509, "F"], [0x1d50a, "G"], [0x210c, "H"],
    [0x2111, "I"], [0x1d50d, "J"], [0x1d50e, "K"], [0x1d50f, "L"],
    [0x1d510, "M"], [0x1d511, "N"], [0x1d512, "O"], [0x1d513, "P"],
    [0x1d514, "Q"], [0x211c, "R"], [0x1d516, "S"], [0x1d517, "T"],
    [0x1d518, "U"], [0x1d519, "V"], [0x1d51a, "W"], [0x1d51b, "X"],
    [0x1d51c, "Y"], [0x2128, "Z"],
  ];
  // Fraktur small is contiguous 1D51E–1D537
  fillAz(m, 0x1d504); // will overwrite caps with wrong holes — fix via frakturCap
  for (let i = 0; i < 26; i++) m.set(0x1d51e + i, String.fromCharCode(0x61 + i));

  const doubleCap: Array<[number, string]> = [
    [0x1d538, "A"], [0x1d539, "B"], [0x2102, "C"], [0x1d53b, "D"],
    [0x1d53c, "E"], [0x1d53d, "F"], [0x1d53e, "G"], [0x210d, "H"],
    [0x1d540, "I"], [0x1d541, "J"], [0x1d542, "K"], [0x1d543, "L"],
    [0x1d544, "M"], [0x2115, "N"], [0x1d546, "O"], [0x2119, "P"],
    [0x211a, "Q"], [0x211d, "R"], [0x1d54a, "S"], [0x1d54b, "T"],
    [0x1d54c, "U"], [0x1d54d, "V"], [0x1d54e, "W"], [0x1d54f, "X"],
    [0x1d550, "Y"], [0x2124, "Z"],
  ];
  // Double-struck small contiguous 1D552–1D56B
  for (let i = 0; i < 26; i++) m.set(0x1d552 + i, String.fromCharCode(0x61 + i));

  for (const [cp, ch] of [...scriptCap, ...scriptSmall, ...frakturCap, ...doubleCap]) {
    m.set(cp, ch);
  }

  // Parenthesized / circled Latin a–z / A–Z
  for (let i = 0; i < 26; i++) {
    m.set(0x249c + i, String.fromCharCode(0x61 + i)); // ⒜
    m.set(0x24b6 + i, String.fromCharCode(0x41 + i)); // Ⓐ
    m.set(0x24d0 + i, String.fromCharCode(0x61 + i)); // ⓐ
  }

  // Fullwidth ASCII
  for (let cp = 0xff01; cp <= 0xff5e; cp++) {
    m.set(cp, String.fromCharCode(cp - 0xfee0));
  }
  m.set(0x3000, " ");

  // Circled digits
  m.set(0x24ea, "0");
  m.set(0x24ff, "0");
  for (let i = 0; i < 9; i++) m.set(0x2460 + i, String.fromCharCode(0x31 + i));

  // A few common "aesthetic" / small-cap lookalikes
  m.set(0x1d00, "a"); m.set(0x0299, "b"); m.set(0x1d04, "c"); m.set(0x1d05, "d");
  m.set(0x1d07, "e"); m.set(0xa730, "f"); m.set(0x0262, "g"); m.set(0x029c, "h");
  m.set(0x026a, "i"); m.set(0x1d0a, "j"); m.set(0x1d0b, "k"); m.set(0x029f, "l");
  m.set(0x1d0d, "m"); m.set(0x0274, "n"); m.set(0x1d0f, "o"); m.set(0x1d18, "p");
  m.set(0x01eb, "q"); m.set(0x0280, "r"); m.set(0xa731, "s"); m.set(0x1d1b, "t");
  m.set(0x1d1c, "u"); m.set(0x1d20, "v"); m.set(0x1d21, "w"); m.set(0x028f, "y");
  m.set(0x1d22, "z");

  return m;
}

const FANCY_MAP = buildFancyMap();

/**
 * Fold fancy / styled Unicode letters & digits back toward plain Latin so
 * canvas fonts can draw them. Leaves most real scripts (CJK, Cyrillic, …) alone
 * after NFKC — those need a wider font, not ASCII folding.
 *
 * @param collapseWhitespace When true (default), squeeze runs of whitespace —
 *   right for display names. Pass false for message bodies that keep newlines.
 */
export function unstyleFancyText(input: string, collapseWhitespace = true): string {
  if (!input) return "";
  let s = input.normalize("NFKC");
  s = s.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, "");
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    out += FANCY_MAP.get(cp) ?? ch;
  }
  if (!collapseWhitespace) {
    return out.replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }
  return out.replace(/\s+/g, " ").trim();
}

/** True when the string has almost nothing a Latin-leaning canvas font can show. */
function looksUnreadable(s: string): boolean {
  if (!s) return true;
  const readable = s.replace(/[^\p{L}\p{N}\p{P}\p{Zs}]/gu, "");
  if (readable.replace(/\s+/g, "").length < 1) return true;
  const chars = [...s];
  const bad = chars.filter((ch) => {
    const cp = ch.codePointAt(0)!;
    return (cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000 || cp === 0xfffd;
  }).length;
  return bad > 0 && bad >= Math.ceil(chars.length / 2);
}

/**
 * Name for canvas + captions. Unstyles fancy fonts; falls back to @handle
 * (usually plain ASCII) when the nick would still paint as squares.
 */
export function quoteDisplayName(
  raw: string | null | undefined,
  fallbackHandle?: string | null,
): string {
  const primary = unstyleFancyText(raw ?? "");
  if (primary && !looksUnreadable(primary)) return primary.slice(0, 80);

  const handle = unstyleFancyText((fallbackHandle ?? "").replace(/^@/, ""));
  if (handle && !looksUnreadable(handle)) return handle.slice(0, 80);

  return primary || handle || "User";
}
