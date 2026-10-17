// 🔐 Code Break (mockup mg6) — a repeating color sequence with the next element
// hidden. Identify the variable that comes next to crack the container.
import { ButtonStyle } from "discord.js";
import type { MiniGameDefinition, MiniGameSession, MiniGameOutcome, MiniGameRender } from "../types.js";
import { renderScreen, winScreen, loseScreen, type ButtonSpec } from "./shared.js";

const COLORS: { action: string; label: string; emoji: string }[] = [
  { action: "blue", label: "BLUE", emoji: "🟦" },
  { action: "green", label: "GREEN", emoji: "🟩" },
  { action: "yellow", label: "YELLOW", emoji: "🟨" },
  { action: "orange", label: "ORANGE", emoji: "🟧" },
];

function emojiFor(action: string): string {
  return COLORS.find(c => c.action === action)?.emoji ?? "⬜";
}

export const codeBreakGame: MiniGameDefinition = {
  key: "code",
  name: "Code Break",
  blurb: "Solve the sequence puzzle to unlock the card.",
  timeoutMs: 20000,

  start(session: MiniGameSession): Promise<MiniGameRender> {
    // Build a repeating base pattern (period 2 or 3) and hide the 6th element.
    const period = 2 + Math.floor(Math.random() * 2);
    const base: string[] = [];
    for (let i = 0; i < period; i++) {
      base.push(COLORS[Math.floor(Math.random() * COLORS.length)]!.action);
    }
    const shown: string[] = [];
    for (let i = 0; i < 5; i++) shown.push(base[i % period]!);
    const next = base[5 % period]!;
    session.state.next = next;

    const shownEmoji = shown.map(emojiFor).join(" ");
    const buttons: ButtonSpec[] = COLORS.map(c => ({
      action: c.action, label: c.label, emoji: c.emoji, style: ButtonStyle.Secondary,
    }));
    return renderScreen(session, {
      theme: 0x84cc16,
      icon: "🔒",
      title: "CARD CONTAINER",
      titleTail: "LOCKED",
      lines: [
        "Security puzzle detected.",
        "Identify the next variable",
        `in the sequence:  ${shownEmoji} ❓`,
      ],
      cardArtUrl: session.cardArtUrl,
      cardName: session.card.name,
      rarityLabel: session.rarityLabel,
      rarityColor: session.rarityColor,
      cardBadge: "LOCKED",
    }, {
      animateIntro: true,
      buttons,
      title: "🔒 CARD CONTAINER LOCKED",
      description:
        `Security puzzle detected. Identify the next variable in the sequence:\n` +
        `${shownEmoji} **❓**`,
    });
  },

  async handle(session: MiniGameSession, action: string): Promise<MiniGameOutcome> {
    const next = session.state.next as string;
    if (action === next) {
      return { done: true, win: true, render: await winScreen(session, `Correct — ${emojiFor(next)} unlocked the container!`) };
    }
    return { done: true, win: false, render: await loseScreen(session, `Wrong code — the container sealed shut. (Answer: ${emojiFor(next)})`) };
  },

  onTimeout(session: MiniGameSession): Promise<MiniGameRender> {
    return loseScreen(session, "The security timer elapsed and the container locked for good.");
  },
};
