// ─────────────────────────────────────────────────────────────────────────────
// Quote text helpers — strip Discord markdown-ish noise and wrap for canvas.
// ─────────────────────────────────────────────────────────────────────────────

import { unstyleFancyText } from "./display-name.js";

/** Soften Discord markdown into readable quote text (not a perfect parser). */
export function stripDiscordMarkdown(input: string): string {
  let s = input;
  // Code fences / inline code — keep contents.
  s = s.replace(/```(?:\w+\n)?([\s\S]*?)```/g, "$1");
  s = s.replace(/`([^`]+)`/g, "$1");
  // Spoilers, bold, underline, italic, strike.
  s = s.replace(/\|\|([^|]+)\|\|/g, "$1");
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, "$1");
  s = s.replace(/\*\*(.+?)\*\*/g, "$1");
  s = s.replace(/__(.+?)__/g, "$1");
  s = s.replace(/~~(.+?)~~/g, "$1");
  s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1");
  s = s.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, "$1");
  // Headers / subtext / list markers Discord shows as formatting.
  s = s.replace(/^#{1,3}\s+/gm, "");
  s = s.replace(/^-#\s+/gm, "");
  s = s.replace(/^>\s?/gm, "");
  s = s.replace(/^[-*]\s+/gm, "");
  s = s.replace(/^\d+\.\s+/gm, "");
  // Masked links keep the label.
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Collapse excess whitespace but keep intentional newlines.
  s = s.replace(/[^\S\n]+/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/** Resolve Discord mention tokens using a message's mention caches when present. */
export function resolveMentions(
  content: string,
  mentions?: {
    users?: Iterable<{ id: string; username: string; displayName?: string | null }>;
    roles?: Iterable<{ id: string; name: string }>;
    channels?: Iterable<{ id: string; name: string }>;
  },
): string {
  let s = content;
  if (mentions?.users) {
    for (const u of mentions.users) {
      const name = unstyleFancyText(u.displayName || u.username) || u.username;
      s = s.replace(new RegExp(`<@!?${u.id}>`, "g"), `@${name}`);
    }
  }
  if (mentions?.roles) {
    for (const r of mentions.roles) {
      s = s.replace(new RegExp(`<@&${r.id}>`, "g"), `@${r.name}`);
    }
  }
  if (mentions?.channels) {
    for (const c of mentions.channels) {
      s = s.replace(new RegExp(`<#${c.id}>`, "g"), `#${c.name}`);
    }
  }
  // Unresolved leftovers — leave readable stubs.
  s = s.replace(/<@!?\d+>/g, "@someone");
  s = s.replace(/<@&\d+>/g, "@role");
  s = s.replace(/<#\d+>/g, "#channel");
  s = s.replace(/<a?:(\w+):\d+>/g, ":$1:");
  s = s.replace(/<\/?[\w:-]+:\d+>/g, "");
  return s;
}

export function prepareQuoteText(
  raw: string,
  mentions?: Parameters<typeof resolveMentions>[1],
): string {
  // Unstyle fancy Unicode in the body too (same tofu problem on canvas).
  return unstyleFancyText(stripDiscordMarkdown(resolveMentions(raw, mentions)), false);
}

type MeasureCtx = { measureText(text: string): { width: number } };

/** Word-wrap + honour explicit newlines. */
export function wrapLines(ctx: MeasureCtx, text: string, maxWidth: number): string[] {
  const paragraphs = text.split(/\n/);
  const lines: string[] = [];
  for (const para of paragraphs) {
    const words = para.trim().length === 0 ? [""] : para.trim().split(/\s+/);
    let line = "";
    for (const word of words) {
      if (!word && lines.length) {
        lines.push("");
        continue;
      }
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line || para.trim().length === 0) lines.push(line);
  }
  return lines.length ? lines : [""];
}

/** Shrink font until the wrapped block fits in maxLines / maxHeight. */
export function fitFontSize(
  ctx: { font: string; measureText(text: string): { width: number } },
  text: string,
  maxWidth: number,
  maxHeight: number,
  maxSize: number,
  minSize: number,
  fontFamily: string,
  weight = "600",
): { size: number; lines: string[]; lineHeight: number } {
  for (let size = maxSize; size >= minSize; size -= 2) {
    ctx.font = `${weight} ${size}px ${fontFamily}`;
    const lines = wrapLines(ctx, text, maxWidth);
    const lineHeight = Math.round(size * 1.28);
    if (lines.length * lineHeight <= maxHeight && lines.every(l => ctx.measureText(l).width <= maxWidth + 1)) {
      return { size, lines, lineHeight };
    }
  }
  ctx.font = `${weight} ${minSize}px ${fontFamily}`;
  const lines = wrapLines(ctx, text, maxWidth);
  return { size: minSize, lines: lines.slice(0, Math.max(1, Math.floor(maxHeight / (minSize * 1.28)))), lineHeight: Math.round(minSize * 1.28) };
}

/** Truncate a select-menu label safely. */
export function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}
