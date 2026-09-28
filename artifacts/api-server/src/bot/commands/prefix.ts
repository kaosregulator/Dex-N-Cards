import type { Message, GuildMember } from "discord.js";
import type { GuildSettings } from "@workspace/db";
import { BRAND_NAME } from "../help-banners.js";
import {
  isAdmin, addAdmin, removeAdmin, listAdmins,
  getOrCreateGuildSettings, updateGuildSettings,
  loadDefaultCards, unloadDefaultCards,
} from "../db.js";
import { scheduleNextSpawn, clearSpawnTimer } from "../spawn-manager.js";
import { RARITY_EMOJI, RARITY_WEIGHTS, type Rarity, rarityLabel, rarityEmoji } from "../cards-data.js";
import { getRarityDisplayOverrides } from "../db.js";
import { startSetupWizard } from "./setup-wizard.js";
import { startCardWizard, startEditWizard } from "./card-wizard.js";
import { handleImport } from "./import.js";
import { GLOBAL_ONLY_MSG_TEXT } from "../home-guild.js";
// ── Permission check ──────────────────────────────────────────────────────────
async function checkAdmin(msg: Message): Promise<boolean> {
  if (!msg.guild) return false;
  if (msg.guild.ownerId === msg.author.id) return true;
  if ((msg.member as GuildMember | null)?.permissions.has("Administrator")) return true;
  return isAdmin(msg.guild.id, msg.author.id);
}

// ── Channel resolver: accepts #mention or plain name ─────────────────────────
function resolveChannel(msg: Message, arg: string): string | null {
  const mentionId = arg?.match(/^<#(\d+)>$/)?.[1];
  if (mentionId) return mentionId;
  const name = arg?.replace(/^#/, "");
  const found = msg.guild?.channels.cache.find(c => c.name === name && c.isTextBased());
  return found?.id ?? null;
}

// ── Time parser: "30m", "1h", "90s", "2d" or plain number of seconds ─────────
function parseTime(s: string): number | null {
  const m = s.match(/^(\d+)(s|m|h|d)$/i);
  if (!m) { const n = parseInt(s, 10); return isNaN(n) ? null : n; }
  const v = parseInt(m[1], 10);
  const u = m[2].toLowerCase();
  if (u === "s") return v;
  if (u === "m") return v * 60;
  if (u === "h") return v * 3600;
  if (u === "d") return v * 86400;
  return null;
}

function formatTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) { const m = Math.floor(seconds / 60); const s = seconds % 60; return s > 0 ? `${m}m ${s}s` : `${m}m`; }
  const h = Math.floor(seconds / 3600); const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

const VALID_RARITIES = new Set(["common", "uncommon", "rare", "epic", "legendary"]);

// ── Main prefix command handler ───────────────────────────────────────────────
export async function getGuildPrefix(guildId: string): Promise<string> {
  const { getOrCreateGuildSettings } = await import("../db.js");
  const s = await getOrCreateGuildSettings(guildId);
  return s.commandPrefix || "!";
}

/** UnbelievaBoat casino games prefix (default `.`). Independent of admin prefix. */
export async function getGuildGamesPrefix(guildId: string): Promise<string> {
  const { getOrCreateGuildSettings } = await import("../db.js");
  const s = await getOrCreateGuildSettings(guildId);
  const gp = (s as { gamesPrefix?: string | null }).gamesPrefix;
  return (gp && gp.length > 0 ? gp : ".") || ".";
}

export async function handlePrefixCommand(msg: Message, prefix: string): Promise<void> {
  if (!msg.guild) return;
  const content = msg.content.trim();
  if (!content.startsWith(prefix)) return;

  const [rawCmd, ...args] = content.slice(prefix.length).trim().split(/\s+/);
  const cmd = rawCmd?.toLowerCase();
  const guildId = msg.guild.id;

  // ── Public ─────────────────────────────────────────────────────────────────
  if (cmd === "help") {
    await msg.reply(
      `🃏 **${BRAND_NAME} Help**\n` +
      "• Everyone → run `/help` for the full **interactive guide** — pick any topic from the dropdown.\n" +
      `• Admins → the guide has an **Admin** page, or run \`${prefix}setup\` to open the visual setup panel.\n` +
      `• Prefix commands use \`${prefix}\` (change with \`${prefix}setprefix\`).`,
    );
    return;
  }

  if (cmd === "setup") {
    const ok = await checkAdmin(msg);
    if (!ok) { await msg.reply("❌ Only admins can run the setup wizard."); return; }
    await startSetupWizard(msg);
    return;
  }

  // ── Card creation wizards ──────────────────────────────────────────────────
  // These write to the current server's cards table.
  if (cmd === "addcard" || cmd === "addlimited" || cmd === "addevent") {
    if (!await checkAdmin(msg)) return;
    const kind = cmd === "addcard" ? "standard" : cmd === "addlimited" ? "limited" : "event";
    await startCardWizard(msg, kind as "standard" | "limited" | "event");
    return;
  }

  // ── !editcard <Name> — edit any field of an existing card ──────────────────
  // Writes to the current server's cards table.
  if (cmd === "editcard") {
    if (!await checkAdmin(msg)) return;
    const name = args.join(" ");
    if (!name) { await msg.reply("❌ Usage: `!editcard F-22 Raptor`"); return; }
    await startEditWizard(msg, name);
    return;
  }

  // ── !import — bulk import cards from JSON ──────────────────────────────────
  // Writes to the current server's cards/sets tables.
  if (cmd === "import") {
    if (!await checkAdmin(msg)) return;
    await handleImport(msg);
    return;
  }

  // ── !unloaddefaults / !loaddefaults — kept as aliases; prefer /set_admin load/unload
  // Per-server: loadDefaultCards/unloadDefaultCards write ONLY to the current
  // guild's cards + sets (guildId scoped). Any server's admin can seed its own
  // copy of the 120 default cards; it never touches another server's roster.
  if (cmd === "unloaddefaults") {
    if (!await checkAdmin(msg)) return;
    const { removed } = await unloadDefaultCards(guildId);
    await msg.reply(
      `✅ Removed **${removed}** built-in default cards. Re-load anytime from \`${prefix}setup\` or \`/set_admin\` -> load file:<.json>.`
    );
    return;
  }
  if (cmd === "loaddefaults") {
    if (!await checkAdmin(msg)) return;
    const { added, skipped } = await loadDefaultCards(guildId);
    await msg.reply(
      `✅ Added **${added}** default cards back.` +
      (skipped > 0 ? ` ⏭️ Skipped **${skipped}** already in roster.` : "") +
      ` Tip: use \`/set_admin\` -> load file:<.json> for the slash-command version.`,
    );
    return;
  }

  // All remaining commands require admin
  const ok = await checkAdmin(msg);
  if (!ok) { await msg.reply("❌ You don't have permission to use admin commands."); return; }

  // ── !setchannel [#channel] ─────────────────────────────────────────────────
  if (cmd === "setchannel") {
    const arg = args[0] ?? `<#${msg.channelId}>`;
    const channelId = resolveChannel(msg, arg);
    if (!channelId) { await msg.reply("❌ Channel not found. Try `!setchannel #general`."); return; }
    await updateGuildSettings(guildId, { spawnChannelId: channelId });
    await msg.reply(`✅ Spawn channel set to <#${channelId}>.`);
    scheduleNextSpawn(guildId);
    return;
  }

  // ── !setinterval ───────────────────────────────────────────────────────────
  if (cmd === "setinterval") {
    if (args[0]?.toLowerCase() === "random") {
      const min = parseTime(args[1] ?? "");
      const max = parseTime(args[2] ?? "");
      if (!min || !max) { await msg.reply("❌ Usage: `!setinterval random 10m 60m`"); return; }
      await updateGuildSettings(guildId, { useRandomInterval: true, spawnIntervalMin: min, spawnIntervalMax: max });
      await msg.reply(`✅ Spawn interval → random **${args[1]}** – **${args[2]}**.`);
    } else {
      const seconds = parseTime(args[0] ?? "");
      if (!seconds) { await msg.reply("❌ Usage: `!setinterval 30m` or `!setinterval 1h`"); return; }
      await updateGuildSettings(guildId, { useRandomInterval: false, spawnIntervalSeconds: seconds });
      await msg.reply(`✅ Spawn interval → fixed **${args[0]}** (${formatTime(seconds)}).`);
    }
    scheduleNextSpawn(guildId);
    return;
  }

  // ── !setwindow ─────────────────────────────────────────────────────────────
  if (cmd === "setwindow") {
    const seconds = parseTime(args[0] ?? "");
    if (!seconds) { await msg.reply("❌ Usage: `!setwindow 2m` or `!setwindow 90s`"); return; }
    await updateGuildSettings(guildId, { catchWindowSeconds: seconds });
    await msg.reply(`✅ Catch window → **${args[0]}** (${formatTime(seconds)}).`);
    return;
  }

  // ── !setdrops ──────────────────────────────────────────────────────────────
  if (cmd === "setdrops") {
    const val = args[0]?.toLowerCase();
    const map: Record<string, number> = { "1": 1, "3": 3, "5": 5, "random": -1 };
    if (!(val in map)) { await msg.reply("❌ Usage: `!setdrops 1` / `!setdrops 3` / `!setdrops 5` / `!setdrops random`"); return; }
    await updateGuildSettings(guildId, { cardsPerSpawn: map[val] });
    const label = val === "random" ? "Random (1–3 per batch)" : `${map[val]} card${map[val] > 1 ? "s" : ""} per batch`;
    await msg.reply(`✅ Cards per spawn → **${label}**.`);
    return;
  }

  // ── !setrarity ─────────────────────────────────────────────────────────────
  if (cmd === "setrarity") {
    const rarity = args[0]?.toLowerCase();
    const weight = parseInt(args[1] ?? "", 10);
    if (!VALID_RARITIES.has(rarity) || isNaN(weight) || weight < 0) {
      await msg.reply("❌ Usage: `!setrarity common 60` — rarity: common/uncommon/rare/epic/legendary, weight: 0+");
      return;
    }
    const colMap: Record<string, Partial<{ rarityWeightCommon: number; rarityWeightUncommon: number; rarityWeightRare: number; rarityWeightEpic: number; rarityWeightLegendary: number }>> = {
      common: { rarityWeightCommon: weight },
      uncommon: { rarityWeightUncommon: weight },
      rare: { rarityWeightRare: weight },
      epic: { rarityWeightEpic: weight },
      legendary: { rarityWeightLegendary: weight },
    };
    await updateGuildSettings(guildId, colMap[rarity]);
    const displayMap = await getRarityDisplayOverrides(guildId);
    const rLabel = rarityLabel(rarity as Rarity, null, displayMap);
    const rEmoji = rarityEmoji(rarity as Rarity, null, displayMap);
    await msg.reply(`✅ ${rEmoji} **${rLabel}** spawn chance source → **${weight}** (default: ${RARITY_WEIGHTS[rarity as Rarity]}).`);
    return;
  }

  // ── !setcatchmode type|button|both ────────────────────────────────────────
  if (cmd === "setcatchmode") {
    const mode = args[0]?.toLowerCase();
    if (mode !== "type" && mode !== "button" && mode !== "both") {
      await msg.reply(
        "❌ Usage: `!setcatchmode type` (type card name) · `!setcatchmode button` (click 🎯 Claim) · `!setcatchmode both`",
      );
      return;
    }
    await updateGuildSettings(guildId, { catchMode: mode } as Partial<GuildSettings>);
    const label =
      mode === "type" ? "✍️ Type the card name (with 0.5s lag-fair window — earliest sent message wins)"
      : mode === "button" ? "🎯 Click the Claim button (position randomizes each spawn — no camping)"
      : "✍️ + 🎯 Both — type OR click";
    await msg.reply(`✅ Catch mode → **${mode}**.\n${label}`);
    return;
  }

  // ── Spawn toggle ───────────────────────────────────────────────────────────
  if (cmd === "spawnenable") {
    await updateGuildSettings(guildId, { spawnEnabled: true });
    await msg.reply("✅ Card spawning **enabled**.");
    scheduleNextSpawn(guildId);
    return;
  }
  if (cmd === "spawndisable") {
    await updateGuildSettings(guildId, { spawnEnabled: false });
    clearSpawnTimer(guildId);
    await msg.reply("⏸️ Card spawning **disabled**.");
    return;
  }

  // ── Trading toggle ─────────────────────────────────────────────────────────
  if (cmd === "tradingenable") {
    await updateGuildSettings(guildId, { tradeEnabled: true });
    await msg.reply("✅ Trading **enabled**.");
    return;
  }
  if (cmd === "tradingdisable") {
    await updateGuildSettings(guildId, { tradeEnabled: false });
    await msg.reply("⏸️ Trading **disabled**.");
    return;
  }

  // ── !settradechannel ───────────────────────────────────────────────────────
  if (cmd === "settradechannel") {
    const arg = args[0] ?? `<#${msg.channelId}>`;
    const channelId = resolveChannel(msg, arg);
    if (!channelId) { await msg.reply("❌ Channel not found."); return; }
    await updateGuildSettings(guildId, { tradeChannelId: channelId });
    await msg.reply(`✅ Trade channel set to <#${channelId}>.`);
    return;
  }

  // ── !settings ──────────────────────────────────────────────────────────────
  if (cmd === "settings") {
    const s = await getOrCreateGuildSettings(guildId);
    const cardsPerSpawnLabel = s.cardsPerSpawn === -1 ? "Random (1–3)" : s.cardsPerSpawn.toString();
    const rarityLines = [
      `⚪ Common: **${s.rarityWeightCommon ?? 60}**${s.rarityWeightCommon ? " ✏️" : ""}`,
      `🟢 Uncommon: **${s.rarityWeightUncommon ?? 25}**${s.rarityWeightUncommon ? " ✏️" : ""}`,
      `🔵 Rare: **${s.rarityWeightRare ?? 10}**${s.rarityWeightRare ? " ✏️" : ""}`,
      `🟣 Epic: **${s.rarityWeightEpic ?? 4}**${s.rarityWeightEpic ? " ✏️" : ""}`,
      `🌟 Legendary: **${s.rarityWeightLegendary ?? 1}**${s.rarityWeightLegendary ? " ✏️" : ""}`,
    ].join(" · ");

    await msg.reply(
      `**⚙️ ${BRAND_NAME} — Server Settings**\n` +
      `📢 Spawn Channel: ${s.spawnChannelId ? `<#${s.spawnChannelId}>` : "❌ Not set"}\n` +
      `🔄 Auto-Spawning: ${s.spawnEnabled ? "✅ Enabled" : "⏸️ Disabled"}\n` +
      `⏱️ Interval: ${s.useRandomInterval ? `Random ${formatTime(s.spawnIntervalMin ?? 0)}–${formatTime(s.spawnIntervalMax ?? 0)}` : formatTime(s.spawnIntervalSeconds)}\n` +
      `🪟 Catch Window: ${formatTime(s.catchWindowSeconds)}\n` +
      `📦 Cards per Batch: ${cardsPerSpawnLabel}\n` +
      `🎯 Catch Mode: **${(s as unknown as { catchMode?: string }).catchMode ?? "type"}** (${{type:"✍️ typing — lag-fair (earliest sent wins)",button:"🎯 click Claim — position randomized",both:"✍️ + 🎯 both"}[(s as unknown as { catchMode?: string }).catchMode ?? "type"]})\n` +
      `🎲 Rarity Spawn Chances (✏️ = customised): ${rarityLines}\n` +
      `🔄 Trading: ${s.tradeEnabled ? "✅ Enabled" : "⏸️ Disabled"}\n` +
      `💬 Trade Channel: ${s.tradeChannelId ? `<#${s.tradeChannelId}>` : "Any channel"}\n` +
      `⚖️ Command Prefix: \`${s.commandPrefix}\` (change with \`${s.commandPrefix}setprefix\`)\n` +
      `🎰 Games Prefix: \`${(s as { gamesPrefix?: string }).gamesPrefix || "."}\` (change with \`${s.commandPrefix}setgamesprefix\`)`,
    );
    return;
  }

  // ── !removecard ────────────────────────────────────────────────────────────
  // Deletes a card from the current server's cards table. Scoped to this server.
  if (cmd === "removecard") {
    if (!await checkAdmin(msg)) return;
    const { removeCard } = await import("../db.js");
    const name = args.join(" ");
    if (!name) { await msg.reply("❌ Usage: `!removecard F-22 Raptor`"); return; }
    await removeCard(name, guildId);
    await msg.reply(`✅ Removed **${name}** from the card pool.`);
    return;
  }

  // ── !addadmin ──────────────────────────────────────────────────────────────
  if (cmd === "addadmin") {
    const userId = msg.mentions.users.first()?.id ?? args[0]?.replace(/[<@!>]/g, "");
    if (!userId) { await msg.reply("❌ Mention a user: `!addadmin @User`"); return; }
    await addAdmin(guildId, userId, msg.author.id);
    await msg.reply(`✅ <@${userId}> added as an admin.`);
    return;
  }

  // ── !removeadmin ───────────────────────────────────────────────────────────
  if (cmd === "removeadmin") {
    const userId = msg.mentions.users.first()?.id ?? args[0]?.replace(/[<@!>]/g, "");
    if (!userId) { await msg.reply("❌ Mention a user: `!removeadmin @User`"); return; }
    await removeAdmin(guildId, userId);
    await msg.reply(`✅ <@${userId}> removed from bot admins.`);
    return;
  }

  // ── !listadmins ────────────────────────────────────────────────────────────
  if (cmd === "listadmins") {
    const admins = await listAdmins(guildId);
    if (admins.length === 0) {
      await msg.reply("No custom bot admins. Server owner and Discord Admins always have access.");
      return;
    }
    const lines = admins.map(a => `<@${a.userId}> — added by <@${a.addedBy}>`);
    await msg.reply(`**${BRAND_NAME} Admins:**\n${lines.join("\n")}`);
    return;
  }

  // ── !setprefix ─────────────────────────────────────────────────────────────
  if (cmd === "setprefix") {
    if (!await checkAdmin(msg)) { await msg.reply("❌ Admins only."); return; }
    const newPrefix = args[0]?.trim();
    if (!newPrefix || newPrefix.length > 5) {
      await msg.reply(`❌ Usage: \`${prefix}setprefix !\` (or \`>\`, \`$\`, etc.). Max 5 characters.`);
      return;
    }
    const games = await getGuildGamesPrefix(guildId);
    if (newPrefix === games) {
      await msg.reply("❌ Command prefix cannot match the games prefix. Change one of them first.");
      return;
    }
    await updateGuildSettings(guildId, { commandPrefix: newPrefix });
    await msg.reply(`✅ Command prefix changed to **\`${newPrefix}\`** (admin/card commands).\nGames stay on **\`${games}\`** — change with \`${newPrefix}setgamesprefix\`.`);
    return;
  }

  // ── !setgamesprefix ────────────────────────────────────────────────────────
  if (cmd === "setgamesprefix") {
    if (!await checkAdmin(msg)) { await msg.reply("❌ Admins only."); return; }
    const newPrefix = args[0]?.trim();
    if (!newPrefix || newPrefix.length > 5) {
      await msg.reply(`❌ Usage: \`${prefix}setgamesprefix .\` (casino games). Max 5 characters.`);
      return;
    }
    if (newPrefix === prefix) {
      await msg.reply("❌ Games prefix cannot match the command prefix. Pick a different one.");
      return;
    }
    await updateGuildSettings(guildId, { gamesPrefix: newPrefix } as Partial<GuildSettings>);
    await msg.reply(
      `✅ Games prefix changed to **\`${newPrefix}\`** — try \`${newPrefix}slots 100\` or \`${newPrefix}help\`.`,
    );
    return;
  }
}
