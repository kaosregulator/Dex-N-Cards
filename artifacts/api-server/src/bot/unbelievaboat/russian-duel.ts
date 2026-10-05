// Russian roulette duel — interactive Pull Trigger turns (player / AI).
// Reuses battle canvas patterns (loadArt, particles) via render-russian-duel.

import type {
  ChatInputCommandInteraction,
  ButtonInteraction,
  User,
} from "discord.js";
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  MessageFlags,
} from "discord.js";
import { UNBELIEVABOAT_AUTHOR, UNBELIEVABOAT_COLOR } from "./branding.js";
import {
  CashError, earnCash, spendFunds, getCashBalance, fmtCash, formatSpendNote,
} from "./cash.js";
import { assertGameCooldown, markGameCooldown } from "./cooldowns.js";
import { getOrCreateUbSettings, writeUbAudit } from "../../lib/unbelievaboat/db.js";
import { replyThenPostAsUnbelievaBoat, openTableAsUnbelievaBoat } from "./webhook.js";
import { renderRussianScene, type RussianScene } from "./render-russian-duel.js";
import { RESPONSIBLE_PLAY } from "./live-slots.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

type DuelSession = {
  guildId: string;
  challengerId: string;
  targetId: string;
  bet: number;
  mode: "challenge" | "ai";
  /** Chamber index (0–5) that has the round. */
  bulletIndex: number;
  /** Next chamber to fire (0–5). */
  nextChamber: number;
  turn: "challenger" | "target";
  expires: number;
};

const challenges = new Map<string, {
  guildId: string; challengerId: string; targetId: string; bet: number; expires: number;
}>();
const duels = new Map<string, DuelSession>();

function duelKey(guildId: string, a: string, b: string) {
  return `${guildId}:${a}:${b}`;
}

function brandEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(UNBELIEVABOAT_COLOR)
    .setAuthor(UNBELIEVABOAT_AUTHOR)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: `${RESPONSIBLE_PLAY} · Toy prop only — no real firearms.` });
}

async function attachGif(result: { buffer: Buffer } | null, name: string) {
  if (!result) return { files: [] as AttachmentBuilder[], imageName: null as string | null };
  return { files: [new AttachmentBuilder(result.buffer, { name })], imageName: name };
}

async function assertGamesOn(guildId: string) {
  const s = await getOrCreateUbSettings(guildId);
  if (!s.gamesEnabled) throw new CashError("UnbelievaBoat mini-games are disabled on this server.");
}

function pullButton(sessionKey: string, turnUserId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`unbgame:russian:pull:${sessionKey}:${turnUserId}`)
      .setLabel("Pull Trigger")
      .setEmoji("🔫")
      .setStyle(ButtonStyle.Danger),
  );
}

async function updateTable(
  interaction: ButtonInteraction,
  payload: {
    content?: string | null;
    embeds?: EmbedBuilder[];
    files?: AttachmentBuilder[];
    components?: ActionRowBuilder<ButtonBuilder>[];
  },
) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
      return;
    }
    await interaction.update(payload);
  } catch {
    await interaction.message.edit(payload).catch(() => {});
  }
}

async function sceneGif(opts: {
  scene: RussianScene;
  challenger: User;
  target: User;
  aimedAt?: "challenger" | "target";
  chamber?: number;
  countdown?: number;
}) {
  return renderRussianScene({
    scene: opts.scene,
    challengerUrl: opts.challenger.displayAvatarURL({ size: 256, extension: "png" }),
    targetUrl: opts.target.displayAvatarURL({ size: 256, extension: "png" }),
    challengerName: opts.challenger.username,
    targetName: opts.target.username,
    aimedAt: opts.aimedAt,
    chamber: opts.chamber,
    countdown: opts.countdown,
  });
}

async function showWaitingForPull(
  interaction: ButtonInteraction | ChatInputCommandInteraction,
  session: DuelSession,
  challenger: User,
  target: User,
  note: string,
) {
  const turnUser = session.turn === "challenger" ? challenger : target;
  const key = duelKey(session.guildId, session.challengerId, session.targetId);
  const gif = await sceneGif({
    scene: "intro",
    challenger,
    target,
    aimedAt: session.turn,
  });
  const { files, imageName } = await attachGif(gif, "rr-wait.gif");
  const chambersLeft = 6 - session.nextChamber;
  const embed = brandEmbed("🔫 Pull the trigger", [
    `${challenger} vs ${target}${session.mode === "ai" ? " *(AI)*" : ""}`,
    `Stake **${fmtCash(session.bet)}** · **${chambersLeft}** chamber(s) left`,
    note,
    "",
    `👉 ${turnUser} — press **Pull Trigger**`,
  ].join("\n"));
  if (imageName) embed.setImage(`attachment://${imageName}`);

  const payload = {
    content: `${turnUser} — **your turn**: press **Pull Trigger**`,
    embeds: [embed],
    files,
    components: [pullButton(key, turnUser.id)],
  };

  if (interaction.isButton()) {
    await updateTable(interaction, payload);
  } else {
    await openTableAsUnbelievaBoat(
      interaction,
      { ...payload, slashHint: `/russian_ub bet:${session.bet}` },
      "✅ Duel table opened — press **Pull Trigger** on the floor.",
    );
  }
}

async function resolvePull(
  interaction: ButtonInteraction,
  session: DuelSession,
  challenger: User,
  target: User,
) {
  const key = duelKey(session.guildId, session.challengerId, session.targetId);
  const aimedAt = session.turn;
  const turnUser = aimedAt === "challenger" ? challenger : target;
  const other = aimedAt === "challenger" ? target : challenger;
  const bang = session.nextChamber === session.bulletIndex;

  // Pre-render countdown + outcome while the first beat plays — less dead air.
  const [count3, count2, count1, outcomeGif] = await Promise.all([
    sceneGif({ scene: "raise", challenger, target, aimedAt, countdown: 3 }),
    sceneGif({ scene: "raise", challenger, target, aimedAt, countdown: 2 }),
    sceneGif({ scene: "raise", challenger, target, aimedAt, countdown: 1 }),
    bang
      ? sceneGif({ scene: "bang", challenger, target, aimedAt, chamber: session.bulletIndex })
      : sceneGif({ scene: "click", challenger, target, aimedAt }),
  ]);

  for (const [n, gif] of [[3, count3], [2, count2], [1, count1]] as const) {
    const { files, imageName } = await attachGif(gif, `rr-count-${n}.gif`);
    const embed = brandEmbed(`🔫 ${n}…`, [
      `${challenger} vs ${target}`,
      `${turnUser} is pulling the trigger…`,
    ].join("\n"));
    if (imageName) embed.setImage(`attachment://${imageName}`);
    await updateTable(interaction, { content: `**${n}…**`, embeds: [embed], files, components: [] });
    await new Promise(r => setTimeout(r, 550));
  }

  if (bang) {
    duels.delete(key);
    const gif = outcomeGif;
    const { files, imageName } = await attachGif(gif, "rr-bang.gif");
    const pot = session.mode === "challenge" ? session.bet * 2 : session.bet * 2;
    let resultLine: string;
    if (session.mode === "challenge") {
      const bal = await earnCash(session.guildId, other.id, pot, "Russian challenge pot");
      resultLine = `💥 **BANG!** ${turnUser} is out.\n🏆 ${other} takes the pot **${fmtCash(pot)}**\nCash **${fmtCash(bal.cash)}** · bank **${fmtCash(bal.bank)}**`;
      await writeUbAudit(session.guildId, session.challengerId, "russian_challenge", {
        bet: session.bet, winner: other.id, loser: turnUser.id,
      }, session.targetId);
    } else {
      // AI duel — user already paid stake; bang on user = lose, bang on AI = win
      if (aimedAt === "challenger") {
        const bal = await getCashBalance(session.guildId, challenger.id);
        resultLine = `💥 **BANG!** You lost the stake **${fmtCash(session.bet)}**.\nCash **${fmtCash(bal.cash)}** · bank **${fmtCash(bal.bank)}**`;
      } else {
        const bal = await earnCash(session.guildId, challenger.id, pot, "Russian win");
        resultLine = `💥 **BANG!** ${target} (AI) is out — you win **${fmtCash(session.bet)}** net.\nCash **${fmtCash(bal.cash)}** · bank **${fmtCash(bal.bank)}**`;
      }
    }
    const embed = brandEmbed("🔫 BANG!", [
      `${challenger} vs ${target}`,
      resultLine,
    ].join("\n"));
    if (imageName) embed.setImage(`attachment://${imageName}`);
    await updateTable(interaction, { content: "💥 **BANG!**", embeds: [embed], files, components: [] });
    return;
  }

  // Click — survive, next chamber / next turn
  session.nextChamber += 1;
  session.turn = aimedAt === "challenger" ? "target" : "challenger";
  duels.set(key, session);

  const gif = outcomeGif;
  const { files, imageName } = await attachGif(gif, "rr-click.gif");
  const nextUser = session.turn === "challenger" ? challenger : target;
  const embed = brandEmbed("🔫 Click — safe", [
    `${challenger} vs ${target}`,
    `🟢 ${turnUser} survives. Chamber advances.`,
    `**${6 - session.nextChamber}** left · next: ${nextUser}`,
  ].join("\n"));
  if (imageName) embed.setImage(`attachment://${imageName}`);

  // Overlap AI spin encode with the click hold when the AI is next.
  const aiSpinPromise = session.mode === "ai" && session.turn === "target"
    ? sceneGif({ scene: "spin", challenger, target, aimedAt: "target" })
    : Promise.resolve(null);

  await updateTable(interaction, {
    content: `🟢 Click — ${nextUser}'s turn`,
    embeds: [embed],
    files,
    components: [],
  });
  const [, waitGif] = await Promise.all([
    new Promise(r => setTimeout(r, 1000)),
    aiSpinPromise,
  ]);

  // AI turn — auto pull (no button)
  if (session.mode === "ai" && session.turn === "target") {
    const waitAtt = await attachGif(waitGif, "rr-ai.gif");
    const waitEmbed = brandEmbed("🔫 AI pulling…", [
      `${challenger} vs ${target} *(AI)*`,
      "Watch the AI take their turn…",
    ].join("\n"));
    if (waitAtt.imageName) waitEmbed.setImage(`attachment://${waitAtt.imageName}`);
    await updateTable(interaction, {
      content: "🤖 AI is pulling the trigger…",
      embeds: [waitEmbed],
      files: waitAtt.files,
      components: [],
    });
    await new Promise(r => setTimeout(r, 1100));
    await resolvePull(interaction, session, challenger, target);
    return;
  }

  await showWaitingForPull(
    interaction,
    session,
    challenger,
    target,
    `🟢 ${turnUser} is safe — pass the gun.`,
  );
}

export async function handleRussian(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "Server only.", ...EPHEMERAL });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    await assertGamesOn(interaction.guildId);
    await assertGameCooldown(interaction.guildId, interaction.user.id);
    const target = interaction.options.getUser("target", true);
    const bet = interaction.options.getInteger("bet", true);
    const mode = interaction.options.getString("mode") ?? "challenge";
    if (target.id === interaction.user.id) {
      await interaction.editReply("Pick someone else (or use mode **ai** with another member’s avatar).");
      return;
    }
    // Challenge needs a real human; AI mode can use any avatar (including bots).
    if (mode === "challenge" && target.bot) {
      await interaction.editReply("Challenge a real member — or use mode **ai** with any avatar (bots OK).");
      return;
    }

    if (mode === "challenge") {
      await markGameCooldown(interaction.guildId, interaction.user.id);
      const key = duelKey(interaction.guildId, interaction.user.id, target.id);
      challenges.set(key, {
        guildId: interaction.guildId,
        challengerId: interaction.user.id,
        targetId: target.id,
        bet,
        expires: Date.now() + 5 * 60_000,
      });
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`unbgame:russian:accept:${interaction.user.id}:${bet}`).setLabel("Accept duel").setEmoji("🔫").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`unbgame:russian:decline:${interaction.user.id}`).setLabel("Decline").setStyle(ButtonStyle.Secondary),
      );
      const embed = brandEmbed("🔫 Toy Duel Challenge", [
        `${interaction.user} challenges ${target}`,
        `Pot stake **${fmtCash(bet)}** each (cash then bank)`,
        "",
        `${target} — **Accept duel**, then you take turns pressing **Pull Trigger**.`,
      ].join("\n"));
      await openTableAsUnbelievaBoat(interaction, {
        content: `${target} — accept the duel to play`,
        embeds: [embed],
        components: [row],
        slashHint: `/russian_ub bet:${bet}`,
      }, "✅ Challenge posted as **UnbelievaBoat** — wait for accept on the floor.");
      return;
    }

    // AI / avatar duel — interactive pulls for the user; AI auto-pulls on its turn
    const spent = await spendFunds(interaction.guildId, interaction.user.id, bet, `Russian vs ${target.id}`);
    await markGameCooldown(interaction.guildId, interaction.user.id);
    const key = duelKey(interaction.guildId, interaction.user.id, target.id);
    const session: DuelSession = {
      guildId: interaction.guildId,
      challengerId: interaction.user.id,
      targetId: target.id,
      bet,
      mode: "ai",
      bulletIndex: Math.floor(Math.random() * 6),
      nextChamber: 0,
      turn: "challenger",
      expires: Date.now() + 10 * 60_000,
    };
    duels.set(key, session);
    void spent;

    const gif = await sceneGif({
      scene: "load",
      challenger: interaction.user,
      target,
    });
    const { files, imageName } = await attachGif(gif, "rr-load.gif");
    const embed = brandEmbed("🔫 AI Duel — loaded", [
      `${interaction.user} vs ${target} *(avatar / AI)*`,
      formatSpendNote(spent.fromCash, spent.fromBank, spent.balance.symbol),
      "Take turns. **You** press Pull Trigger — the AI plays its turn automatically.",
    ].join("\n"));
    if (imageName) embed.setImage(`attachment://${imageName}`);
    await openTableAsUnbelievaBoat(interaction, {
      content: `${interaction.user} — **your turn**: press **Pull Trigger**`,
      embeds: [embed],
      files,
      components: [pullButton(key, interaction.user.id)],
      slashHint: `/russian_ub bet:${bet}`,
    }, "✅ AI duel opened — press **Pull Trigger** on the floor.");
  } catch (err) {
    await interaction.editReply(err instanceof CashError ? err.message : `Failed: ${err instanceof Error ? err.message : err}`);
  }
}

export async function handleRussianComponent(interaction: ButtonInteraction): Promise<boolean> {
  const id = interaction.customId;
  if (!id.startsWith("unbgame:russian:") || !interaction.guildId) return false;

  if (id.startsWith("unbgame:russian:decline:")) {
    const challengerId = id.slice("unbgame:russian:decline:".length);
    for (const [k, v] of challenges) {
      if (v.targetId === interaction.user.id && v.challengerId === challengerId) {
        challenges.delete(k);
        await interaction.reply({ content: "Challenge declined.", ...EPHEMERAL });
        return true;
      }
    }
    await interaction.reply({ content: "No open challenge.", ...EPHEMERAL });
    return true;
  }

  if (id.startsWith("unbgame:russian:accept:")) {
    const parts = id.split(":");
    const challengerId = parts[3]!;
    const bet = Number(parts[4] ?? 0);
    const mapKey = duelKey(interaction.guildId, challengerId, interaction.user.id);
    const ch = challenges.get(mapKey);
    if (!ch || ch.expires < Date.now()) {
      challenges.delete(mapKey);
      await interaction.reply({ content: "Challenge expired.", ...EPHEMERAL });
      return true;
    }
    if (interaction.user.id !== ch.targetId) {
      await interaction.reply({ content: "Only the challenged member can accept.", ...EPHEMERAL });
      return true;
    }
    challenges.delete(mapKey);
    await interaction.deferUpdate();
    try {
      await assertGamesOn(interaction.guildId);
      const challenger = await interaction.client.users.fetch(challengerId);
      await spendFunds(interaction.guildId, challengerId, bet, "Russian challenge stake");
      try {
        await spendFunds(interaction.guildId, interaction.user.id, bet, "Russian challenge stake");
      } catch (err) {
        await earnCash(interaction.guildId, challengerId, bet, "Russian challenge refund").catch(() => null);
        throw err;
      }
      const session: DuelSession = {
        guildId: interaction.guildId,
        challengerId,
        targetId: interaction.user.id,
        bet,
        mode: "challenge",
        bulletIndex: Math.floor(Math.random() * 6),
        nextChamber: 0,
        turn: Math.random() < 0.5 ? "challenger" : "target",
        expires: Date.now() + 10 * 60_000,
      };
      duels.set(mapKey, session);
      await showWaitingForPull(
        interaction,
        session,
        challenger,
        interaction.user,
        "Both stakes are in. Take turns — press **Pull Trigger** when it’s yours.",
      );
    } catch (err) {
      await interaction.followUp({
        content: err instanceof CashError ? err.message : `Failed: ${err instanceof Error ? err.message : err}`,
        ...EPHEMERAL,
      }).catch(() => {});
      await interaction.editReply({
        content: "Duel failed — check balances if a stake was taken.",
        embeds: [],
        components: [],
        files: [],
      }).catch(() => {});
    }
    return true;
  }

  if (id.startsWith("unbgame:russian:pull:")) {
    // unbgame:russian:pull:guildId:challengerId:targetId:turnUserId
    const parts = id.split(":");
    // customId = unbgame:russian:pull:${sessionKey}:${turnUserId}
    // sessionKey = guildId:challengerId:targetId  → parts[3..5], turnUser = parts[6]
    const guildId = parts[3]!;
    const challengerId = parts[4]!;
    const targetId = parts[5]!;
    const turnUserId = parts[6]!;
    const key = duelKey(guildId, challengerId, targetId);
    const session = duels.get(key);
    if (!session || session.expires < Date.now()) {
      duels.delete(key);
      await interaction.reply({ content: "Duel expired — start again with `/russian_ub` or `.rr`.", ...EPHEMERAL });
      return true;
    }
    if (interaction.user.id !== turnUserId) {
      await interaction.reply({ content: "Not your turn to pull.", ...EPHEMERAL });
      return true;
    }
    const expected = session.turn === "challenger" ? session.challengerId : session.targetId;
    if (interaction.user.id !== expected) {
      await interaction.reply({ content: "Wait for your turn.", ...EPHEMERAL });
      return true;
    }
    await interaction.deferUpdate();
    const challenger = await interaction.client.users.fetch(session.challengerId);
    const target = await interaction.client.users.fetch(session.targetId);
    await resolvePull(interaction, session, challenger, target);
    return true;
  }

  return false;
}
