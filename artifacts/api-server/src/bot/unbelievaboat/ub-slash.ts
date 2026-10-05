// UnbelievaBoat player slash shortcuts — short names ending in `_ub`.
// `/casino` stays as the full floor dashboard. These aliases teach the games.
// Discord forces lowercase: daily_ub, blackjack_ub, …

import { SlashCommandBuilder } from "discord.js";
import type { EmbedBuilder } from "discord.js";

const UB = "UnbelievaBoat";

/** Append a visible “how to run this again” tip for floor webhook posts. */
export function withUbSlashTip(embed: EmbedBuilder, slashName: string, example = ""): EmbedBuilder {
  const cmd = example ? `/${slashName} ${example}` : `/${slashName}`;
  const tip = `_▶️ Run \`${cmd}\` · all tables: \`/casino\`_`;
  const desc = embed.data.description ?? "";
  if (desc.includes(`/${slashName}`)) return embed;
  embed.setDescription(desc ? `${desc}\n\n${tip}` : tip);
  return embed;
}

export function buildUbSlashCommandJsons() {
  return [
    new SlashCommandBuilder()
      .setName("daily_ub")
      .setDescription(`${UB} — claim cash check-in (streak)`)
      .setDMPermission(false)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("collect_ub")
      .setDescription(`${UB} — collect role income perks`)
      .setDMPermission(false)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("bal_ub")
      .setDescription(`${UB} — show cash & bank balance`)
      .setDMPermission(false)
      .addUserOption(o => o.setName("user").setDescription("Member to check"))
      .toJSON(),

    new SlashCommandBuilder()
      .setName("deposit_ub")
      .setDescription(`${UB} — move cash into bank (omit amount = all)`)
      .setDMPermission(false)
      .addIntegerOption(o => o.setName("amount").setDescription("Amount (omit for all cash)").setRequired(false).setMinValue(1))
      .toJSON(),

    new SlashCommandBuilder()
      .setName("withdraw_ub")
      .setDescription(`${UB} — move bank to cash (omit amount = all)`)
      .setDMPermission(false)
      .addIntegerOption(o => o.setName("amount").setDescription("Amount (omit for all bank)").setRequired(false).setMinValue(1))
      .toJSON(),

    new SlashCommandBuilder()
      .setName("slots_ub")
      .setDescription(`${UB} — Vegas slots (buy credits, spin, cash out)`)
      .setDMPermission(false)
      .addIntegerOption(o =>
        o.setName("bet").setDescription("Credits to load (10–5,000)").setRequired(true).setMinValue(10).setMaxValue(5_000))
      .toJSON(),

    new SlashCommandBuilder()
      .setName("blackjack_ub")
      .setDescription(`${UB} — blackjack 21 (Hit / Stand / Double)`)
      .setDMPermission(false)
      .addIntegerOption(o =>
        o.setName("bet").setDescription("Wager").setRequired(true).setMinValue(10).setMaxValue(100_000))
      .toJSON(),

    new SlashCommandBuilder()
      .setName("roulette_ub")
      .setDescription(`${UB} — roulette (red / black / green)`)
      .setDMPermission(false)
      .addIntegerOption(o =>
        o.setName("bet").setDescription("Wager").setRequired(true).setMinValue(10).setMaxValue(100_000))
      .addStringOption(o => o.setName("color").setDescription("Color (optional — can pick on table)")
        .addChoices(
          { name: "Red (2×)", value: "red" },
          { name: "Black (2×)", value: "black" },
          { name: "Green 0 (14×)", value: "green" },
        ))
      .toJSON(),

    new SlashCommandBuilder()
      .setName("uno_ub")
      .setDescription(`${UB} — mini UNO vs the house`)
      .setDMPermission(false)
      .addIntegerOption(o =>
        o.setName("bet").setDescription("Wager").setRequired(true).setMinValue(10).setMaxValue(50_000))
      .toJSON(),

    new SlashCommandBuilder()
      .setName("higherlower_ub")
      .setDescription(`${UB} — higher or lower card guess`)
      .setDMPermission(false)
      .addIntegerOption(o =>
        o.setName("bet").setDescription("Wager").setRequired(true).setMinValue(10).setMaxValue(50_000))
      .toJSON(),

    new SlashCommandBuilder()
      .setName("redblack_ub")
      .setDescription(`${UB} — red or black card flip (2×)`)
      .setDMPermission(false)
      .addIntegerOption(o =>
        o.setName("bet").setDescription("Wager").setRequired(true).setMinValue(10).setMaxValue(50_000))
      .addStringOption(o => o.setName("color").setDescription("Color").setRequired(true)
        .addChoices({ name: "Red", value: "red" }, { name: "Black", value: "black" }))
      .toJSON(),

    new SlashCommandBuilder()
      .setName("work_ub")
      .setDescription(`${UB} — safe work shift for cash`)
      .setDMPermission(false)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("crime_ub")
      .setDescription(`${UB} — risky crime (payout or fine)`)
      .setDMPermission(false)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("beg_ub")
      .setDescription(`${UB} — beg for a little cash`)
      .setDMPermission(false)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("rob_ub")
      .setDescription(`${UB} — try to rob another member`)
      .setDMPermission(false)
      .addUserOption(o => o.setName("target").setDescription("Target").setRequired(true))
      .toJSON(),

    new SlashCommandBuilder()
      .setName("russian_ub")
      .setDescription(`${UB} — toy russian duel (AI or challenge)`)
      .setDMPermission(false)
      .addUserOption(o => o.setName("target").setDescription("Target").setRequired(true))
      .addIntegerOption(o =>
        o.setName("bet").setDescription("Stake").setRequired(true).setMinValue(10).setMaxValue(50_000))
      .addStringOption(o => o.setName("mode").setDescription("Mode")
        .addChoices(
          { name: "AI vs their avatar", value: "ai" },
          { name: "Challenge them live", value: "challenge" },
        ))
      .toJSON(),

    new SlashCommandBuilder()
      .setName("store_ub")
      .setDescription(`${UB} — perk role store (cash)`)
      .setDMPermission(false)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("top_ub")
      .setDescription(`${UB} — cash/bank leaderboard`)
      .setDMPermission(false)
      .toJSON(),
  ];
}

/** Internal names routed in the bot interaction handler. */
export const UB_SLASH_COMMANDS = new Set([
  "daily_ub",
  "collect_ub",
  "bal_ub",
  "deposit_ub",
  "withdraw_ub",
  "slots_ub",
  "blackjack_ub",
  "roulette_ub",
  "uno_ub",
  "higherlower_ub",
  "redblack_ub",
  "work_ub",
  "crime_ub",
  "beg_ub",
  "rob_ub",
  "russian_ub",
  "store_ub",
  "top_ub",
]);
