// Prefix casino games — e.g. `.slots 100`, `.daily`, `.dep`, `.bj 50`
// Uses the guild `gamesPrefix` (default `.`), separate from admin `commandPrefix`.
// Short aliases mirror UnbelievaBoat habits (dep / with / col / bj / …).

import type { Message, User } from "discord.js";
import { messageAsChatInput } from "../commands/message-as-chat.js";
import type { OptBag } from "../commands/option-proxy.js";

const HELP = [
  "**Casino** — short prefix (default `.`). Results post as **UnbelievaBoat**.",
  "`.dep` / `.dep all` · `.with` / `.wd` · `.col` · `.bal` · `.daily`",
  "`.work` · `.crime` · `.beg` · `.rob @user`",
  "`.bj 50` · `.slots 100` · `.roulette 50 red` · `.uno 50`",
  "`.hl 50` · `.rb 50 red` · `.rr @user 50` · `.top` · `.store`",
  "Full names work too (`.deposit`, `.blackjack`, `.collect`, …).",
  "Slash: `/deposit_ub` `/blackjack_ub` … or `/casino`. Change prefix: `!setgamesprefix .`",
].join("\n");

/** Canonical command → common short / UB-style aliases people type. */
const ALIAS_TO_CMD: Record<string, string> = {
  // wallet
  dep: "deposit",
  deposit: "deposit",
  with: "withdraw",
  wd: "withdraw",
  withd: "withdraw",
  withdraw: "withdraw",
  col: "collect",
  collect: "collect",
  "collect-income": "collect",
  income: "collect",
  bal: "balance",
  balance: "balance",
  cash: "balance",
  money: "balance",
  wallet: "balance",
  // income
  daily: "daily",
  paycheck: "daily",
  work: "work",
  crime: "crime",
  beg: "beg",
  slut: "beg",
  rob: "rob",
  // games
  bj: "blackjack",
  blackjack: "blackjack",
  "21": "blackjack",
  slots: "slots",
  slot: "slots",
  roulette: "roulette",
  roul: "roulette",
  uno: "uno",
  hl: "higherlower",
  higherlower: "higherlower",
  higher: "higherlower",
  rb: "redblack",
  redblack: "redblack",
  russian: "russian",
  rr: "russian",
  // meta
  top: "top",
  lb: "top",
  leaderboard: "top",
  store: "store",
  shop: "store",
  help: "help",
  games: "help",
  casino: "help",
};

export function resolveUbPrefixCmd(raw: string): string {
  const key = raw.trim().toLowerCase();
  return ALIAS_TO_CMD[key] ?? key;
}

export function parseBet(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(String(raw).replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** `all` / `max` / `*` / empty → all; else a positive integer. */
export function parseAmountToken(raw: string | undefined): "all" | number | null {
  if (raw == null || raw === "") return "all";
  const t = String(raw).trim().toLowerCase();
  if (t === "all" || t === "max" || t === "*") return "all";
  return parseBet(t);
}

function resolveMentionUser(msg: Message, token: string | undefined): User | null {
  if (!token) return null;
  const id = token.match(/^<@!?(\d+)>$/)?.[1] ?? (/^\d{17,20}$/.test(token) ? token : null);
  if (!id) return null;
  return msg.mentions.users.get(id) ?? msg.client.users.cache.get(id) ?? null;
}

async function resolveTransferAmount(
  msg: Message,
  raw: string | undefined,
  kind: "cash" | "bank",
  gamesPrefix: string,
  usageCmd: string,
): Promise<number | null> {
  const parsed = parseAmountToken(raw);
  if (parsed === null) {
    await msg.reply(
      `Usage: \`${gamesPrefix}${usageCmd}\` or \`${gamesPrefix}${usageCmd} all\` or \`${gamesPrefix}${usageCmd} <amount>\``,
    );
    return null;
  }
  if (parsed === "all") {
    const { getCashBalance } = await import("./cash.js");
    const bal = await getCashBalance(msg.guild!.id, msg.author.id);
    const amount = kind === "cash" ? (bal.cash ?? 0) : (bal.bank ?? 0);
    if (amount <= 0) {
      await msg.reply(
        kind === "cash"
          ? "No cash to deposit — wallet is empty."
          : "No bank funds to withdraw.",
      );
      return null;
    }
    return amount;
  }
  return parsed;
}

export async function handleUbPrefixCommand(msg: Message, gamesPrefix: string): Promise<boolean> {
  if (!msg.guild || !msg.content.startsWith(gamesPrefix)) return false;
  const body = msg.content.slice(gamesPrefix.length).trim();
  if (!body) return false;

  const [rawCmd, ...args] = body.split(/\s+/);
  const cmd = resolveUbPrefixCmd(rawCmd ?? "");
  if (!cmd) return false;

  const run = async (
    handler: (i: import("discord.js").ChatInputCommandInteraction) => Promise<void>,
    values: OptBag = {},
  ) => {
    const proxied = messageAsChatInput(msg, values);
    await handler(proxied);
  };

  try {
    if (cmd === "help") {
      await msg.reply(HELP);
      return true;
    }

    if (cmd === "daily") {
      const { handleAnimatedDaily } = await import("./casino.js");
      await run(handleAnimatedDaily);
      return true;
    }
    if (cmd === "collect") {
      const { handleCollect } = await import("./casino.js");
      await run(handleCollect);
      return true;
    }
    if (cmd === "balance") {
      const { handleBalance } = await import("./casino.js");
      await run(handleBalance);
      return true;
    }
    if (cmd === "deposit") {
      // `.dep` / `.dep all` → entire cash balance (UB-style)
      const amount = await resolveTransferAmount(msg, args[0], "cash", gamesPrefix, "dep");
      if (amount == null) return true;
      const { handleDeposit } = await import("./casino.js");
      await run(handleDeposit, { integers: { amount } });
      return true;
    }
    if (cmd === "withdraw") {
      const amount = await resolveTransferAmount(msg, args[0], "bank", gamesPrefix, "with");
      if (amount == null) return true;
      const { handleWithdraw } = await import("./casino.js");
      await run(handleWithdraw, { integers: { amount } });
      return true;
    }
    if (cmd === "top") {
      const { handleCasinoTop } = await import("./casino.js");
      await run(handleCasinoTop);
      return true;
    }
    if (cmd === "store") {
      const { handleCashStore } = await import("./store.js");
      await run(handleCashStore);
      return true;
    }
    if (cmd === "slots") {
      const bet = parseBet(args[0]);
      if (!bet) { await msg.reply(`Usage: \`${gamesPrefix}slots <credits>\``); return true; }
      const { handleSlots } = await import("./live-slots.js");
      await run(handleSlots, { integers: { bet } });
      return true;
    }
    if (cmd === "blackjack") {
      const bet = parseBet(args[0]);
      if (!bet) { await msg.reply(`Usage: \`${gamesPrefix}bj <bet>\` or \`${gamesPrefix}blackjack <bet>\``); return true; }
      const { handleBlackjack } = await import("./games.js");
      await run(handleBlackjack, { integers: { bet } });
      return true;
    }
    if (cmd === "roulette") {
      const bet = parseBet(args[0]);
      if (!bet) { await msg.reply(`Usage: \`${gamesPrefix}roulette <bet> [red|black|green]\``); return true; }
      const color = args[1]?.toLowerCase();
      const { handleRoulette } = await import("./live-roulette.js");
      await run(handleRoulette, {
        integers: { bet },
        strings: { color: color ?? null },
      });
      return true;
    }
    if (cmd === "uno") {
      const bet = parseBet(args[0]);
      if (!bet) { await msg.reply(`Usage: \`${gamesPrefix}uno <bet>\``); return true; }
      const { handleUno } = await import("./uno.js");
      await run(handleUno, { integers: { bet } });
      return true;
    }
    if (cmd === "higherlower") {
      const bet = parseBet(args[0]);
      if (!bet) { await msg.reply(`Usage: \`${gamesPrefix}hl <bet>\``); return true; }
      const { handleHigherLower } = await import("./games.js");
      await run(handleHigherLower, { integers: { bet } });
      return true;
    }
    if (cmd === "redblack") {
      const bet = parseBet(args[0]);
      const color = (args[1] ?? "").toLowerCase();
      if (!bet || (color !== "red" && color !== "black")) {
        await msg.reply(`Usage: \`${gamesPrefix}rb <bet> <red|black>\``);
        return true;
      }
      const { handleRedBlack } = await import("./games.js");
      await run(handleRedBlack, { integers: { bet }, strings: { color } });
      return true;
    }
    if (cmd === "work") {
      const { handleCashWork } = await import("./games.js");
      await run(handleCashWork);
      return true;
    }
    if (cmd === "crime") {
      const { handleCashCrime } = await import("./games.js");
      await run(handleCashCrime);
      return true;
    }
    if (cmd === "beg") {
      const { handleSlut } = await import("./games.js");
      await run(handleSlut);
      return true;
    }
    if (cmd === "rob") {
      const target = resolveMentionUser(msg, args[0]) ?? msg.mentions.users.first() ?? null;
      if (!target) { await msg.reply(`Usage: \`${gamesPrefix}rob @user\``); return true; }
      const { handleRob } = await import("./games.js");
      await run(handleRob, { users: { target } });
      return true;
    }
    if (cmd === "russian") {
      // `.rr @user 100` challenge · `.rr ai @user 100` avatar/AI duel
      const modeArg = (args[0] ?? "").toLowerCase();
      const mode = modeArg === "ai" || modeArg === "bot" ? "ai" : "challenge";
      const rest = mode === "ai" ? args.slice(1) : args;
      const target = resolveMentionUser(msg, rest[0]) ?? msg.mentions.users.first()
        ?? (rest[1] ? resolveMentionUser(msg, rest[1]) : null);
      const bet = parseBet(rest[1] ?? rest[0]) ?? parseBet(rest[0]);
      if (!target || !bet) {
        await msg.reply(
          `Usage: \`${gamesPrefix}rr @user <bet>\` (challenge) or \`${gamesPrefix}rr ai @user <bet>\``,
        );
        return true;
      }
      const { handleRussian } = await import("./russian-duel.js");
      await run(handleRussian, {
        users: { target },
        integers: { bet },
        strings: { mode },
      });
      return true;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Command failed.";
    await msg.reply(`❌ ${message}`).catch(() => {});
    return true;
  }

  return false;
}
