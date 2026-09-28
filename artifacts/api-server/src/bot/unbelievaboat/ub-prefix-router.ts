// Prefix casino games — e.g. `.slots 100`, `.daily`, `.rob @user`
// Uses the guild `gamesPrefix` (default `.`), separate from admin `commandPrefix`.

import type { Message, User } from "discord.js";
import { messageAsChatInput } from "../commands/message-as-chat.js";
import type { OptBag } from "../commands/option-proxy.js";

const HELP = [
  "**Casino prefix commands** (games prefix — default `.`)",
  "`daily` · `collect` · `bal` · `deposit <amt>` · `withdraw <amt>` · `top` · `store`",
  "`slots <credits>` · `blackjack <bet>` · `roulette <bet> [red|black|green|0-36]`",
  "`uno <bet>` · `hl <bet>` / `higherlower <bet>` · `rb <bet> <red|black>`",
  "`work` · `crime` · `beg` · `rob @user` · `russian @user <bet>`",
  "Change games prefix: `!setgamesprefix .` (uses your admin command prefix).",
].join("\n");

function parseBet(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(String(raw).replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function resolveMentionUser(msg: Message, token: string | undefined): User | null {
  if (!token) return null;
  const id = token.match(/^<@!?(\d+)>$/)?.[1] ?? (/^\d{17,20}$/.test(token) ? token : null);
  if (!id) return null;
  return msg.mentions.users.get(id) ?? msg.client.users.cache.get(id) ?? null;
}

export async function handleUbPrefixCommand(msg: Message, gamesPrefix: string): Promise<boolean> {
  if (!msg.guild || !msg.content.startsWith(gamesPrefix)) return false;
  const body = msg.content.slice(gamesPrefix.length).trim();
  if (!body) return false;

  const [rawCmd, ...args] = body.split(/\s+/);
  const cmd = (rawCmd ?? "").toLowerCase();
  if (!cmd) return false;

  const run = async (handler: (i: import("discord.js").ChatInputCommandInteraction) => Promise<void>, values: OptBag = {}) => {
    const proxied = messageAsChatInput(msg, values);
    await handler(proxied);
  };

  try {
    if (cmd === "help" || cmd === "games" || cmd === "casino") {
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
    if (cmd === "bal" || cmd === "balance" || cmd === "cash") {
      const { handleBalance } = await import("./casino.js");
      await run(handleBalance);
      return true;
    }
    if (cmd === "deposit") {
      const amount = parseBet(args[0]);
      if (!amount) { await msg.reply(`Usage: \`${gamesPrefix}deposit <amount>\``); return true; }
      const { handleDeposit } = await import("./casino.js");
      await run(handleDeposit, { integers: { amount } });
      return true;
    }
    if (cmd === "withdraw") {
      const amount = parseBet(args[0]);
      if (!amount) { await msg.reply(`Usage: \`${gamesPrefix}withdraw <amount>\``); return true; }
      const { handleWithdraw } = await import("./casino.js");
      await run(handleWithdraw, { integers: { amount } });
      return true;
    }
    if (cmd === "top" || cmd === "lb" || cmd === "leaderboard") {
      const { handleCasinoTop } = await import("./casino.js");
      await run(handleCasinoTop);
      return true;
    }
    if (cmd === "store" || cmd === "shop") {
      const { handleCashStore } = await import("./store.js");
      await run(handleCashStore);
      return true;
    }
    if (cmd === "slots" || cmd === "slot") {
      const bet = parseBet(args[0]);
      if (!bet) { await msg.reply(`Usage: \`${gamesPrefix}slots <credits>\``); return true; }
      const { handleSlots } = await import("./live-slots.js");
      await run(handleSlots, { integers: { bet } });
      return true;
    }
    if (cmd === "blackjack" || cmd === "bj") {
      const bet = parseBet(args[0]);
      if (!bet) { await msg.reply(`Usage: \`${gamesPrefix}blackjack <bet>\``); return true; }
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
    if (cmd === "hl" || cmd === "higherlower" || cmd === "higher") {
      const bet = parseBet(args[0]);
      if (!bet) { await msg.reply(`Usage: \`${gamesPrefix}hl <bet>\``); return true; }
      const { handleHigherLower } = await import("./games.js");
      await run(handleHigherLower, { integers: { bet } });
      return true;
    }
    if (cmd === "rb" || cmd === "redblack") {
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
    if (cmd === "beg" || cmd === "slut") {
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
    if (cmd === "russian" || cmd === "rr") {
      const target = resolveMentionUser(msg, args[0]) ?? msg.mentions.users.first() ?? null;
      const bet = parseBet(args[1] ?? args[0]);
      // Allow `.russian @user 100` or `.russian 100 @user`
      const t = target ?? (args[1] ? resolveMentionUser(msg, args[1]) : null);
      const b = bet ?? parseBet(args[0]);
      if (!t || !b) { await msg.reply(`Usage: \`${gamesPrefix}russian @user <bet>\``); return true; }
      const { handleRussian } = await import("./russian-duel.js");
      await run(handleRussian, { users: { target: t }, integers: { bet: b } });
      return true;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Command failed.";
    await msg.reply(`❌ ${message}`).catch(() => {});
    return true;
  }

  return false;
}
