import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  type ButtonInteraction,
  type GuildTextBasedChannel,
  type Message,
  type ModalSubmitInteraction,
  type TextChannel,
} from "discord.js";
import {
  answersMatch,
  normalizeAnswer,
  type NormalizedQuestion,
} from "../../lib/trivia/client.js";
import {
  createTriviaRound,
  findLiveRoundInChannel,
  getTriviaRound,
  listCorrectGuessers,
  listFirstGuesser,
  recordTriviaGuess,
  updateTriviaRound,
} from "../../lib/trivia/db.js";
import { awardTriviaWinnerRole, TRIVIA_ROLE_DEFS } from "./roles.js";
import { renderTriviaWinnerGif } from "./winner-canvas.js";
import { memberIsTriviaStaff } from "./access.js";
import { logger } from "../../lib/logger.js";

const TRIVIA_COLOR = 0x5865f2;
const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;
const CLEANUP_MS = 60_000;

const CHOICE_EMOJIS = ["🅰️", "🅱️", "🇨", "🇩", "🇪", "🇫"];

export function questionToPayload(q: NormalizedQuestion): Record<string, unknown> {
  return {
    id: q.id,
    provider: q.provider,
    category: q.category,
    difficulty: q.difficulty,
    type: q.type,
    question: q.question,
    choices: q.choices,
    correctAnswer: q.correctAnswer,
    imageUrl: q.imageUrl ?? null,
    meta: q.meta ?? {},
  };
}

export function payloadToQuestion(p: Record<string, unknown>): NormalizedQuestion {
  return {
    id: String(p.id ?? ""),
    provider: (p.provider as NormalizedQuestion["provider"]) ?? "opentdb",
    category: String(p.category ?? ""),
    difficulty: String(p.difficulty ?? ""),
    type: (p.type as NormalizedQuestion["type"]) ?? "multiple",
    question: String(p.question ?? ""),
    choices: Array.isArray(p.choices) ? p.choices.map(String) : [],
    correctAnswer: String(p.correctAnswer ?? ""),
    imageUrl: (p.imageUrl as string | null) ?? null,
    meta: (p.meta as Record<string, unknown>) ?? {},
  };
}

export function buildQuestionEmbed(
  q: NormalizedQuestion,
  opts: { status: "ready" | "live" | "ended"; hostId: string; mode: string; revealAnswer?: boolean },
): EmbedBuilder {
  const statusLine =
    opts.status === "ready" ? "🟡 Waiting for host to **Start**"
      : opts.status === "live" ? "🟢 Live — guesses are open!"
        : "🔴 Ended";

  const embed = new EmbedBuilder()
    .setColor(opts.status === "live" ? 0x57f287 : opts.status === "ended" ? 0xed4245 : TRIVIA_COLOR)
    .setAuthor({ name: `${opts.mode.toUpperCase()} · ${q.provider}` })
    .setTitle(q.question.slice(0, 250))
    .setDescription(
      [
        `**Category:** ${q.category}`,
        `**Difficulty:** ${q.difficulty || "—"}`,
        statusLine,
        `Host: <@${opts.hostId}>`,
        "",
        q.type === "picture" || q.type === "open"
          ? "_Type your guess in chat, or press **Guess**._"
          : q.choices.map((c, i) => `${CHOICE_EMOJIS[i] ?? "▪️"} **${c}**`).join("\n"),
      ].join("\n"),
    )
    .setFooter({ text: "Safe community trivia · no NSFW" });

  if (q.imageUrl) embed.setImage(q.imageUrl);
  if (opts.revealAnswer && q.correctAnswer) {
    embed.addFields({ name: "Answer", value: `||${q.correctAnswer}||` });
  }
  return embed;
}

export function buildRoundComponents(
  roundId: number,
  q: NormalizedQuestion,
  status: "ready" | "live" | "ended",
  guessMode: string,
): ActionRowBuilder<ButtonBuilder>[] {
  if (status === "ended") {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`trivia:noop:${roundId}`).setLabel("Round ended").setStyle(ButtonStyle.Secondary).setDisabled(true),
      ),
    ];
  }

  const hostRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    status === "ready"
      ? new ButtonBuilder().setCustomId(`trivia:start:${roundId}`).setLabel("Start").setEmoji("▶️").setStyle(ButtonStyle.Success)
      : new ButtonBuilder().setCustomId(`trivia:end:${roundId}`).setLabel("End").setEmoji("⏹️").setStyle(ButtonStyle.Danger),
  );

  const rows: ActionRowBuilder<ButtonBuilder>[] = [hostRow];

  if (status === "live") {
    if (q.choices.length > 0 && (guessMode === "buttons" || guessMode === "both")) {
      const choiceRow = new ActionRowBuilder<ButtonBuilder>();
      q.choices.slice(0, 4).forEach((c, i) => {
        choiceRow.addComponents(
          new ButtonBuilder()
            .setCustomId(`trivia:pick:${roundId}:${i}`)
            .setLabel(c.slice(0, 70))
            .setEmoji(CHOICE_EMOJIS[i] ?? "▪️")
            .setStyle(ButtonStyle.Primary),
        );
      });
      rows.push(choiceRow);
    }
    if (guessMode === "modal" || guessMode === "type" || guessMode === "both" || q.choices.length === 0) {
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`trivia:guess:${roundId}`)
            .setLabel("Guess")
            .setEmoji("✍️")
            .setStyle(ButtonStyle.Secondary),
        ),
      );
    }
  }

  return rows;
}

export async function postRoundMessage(opts: {
  channel: GuildTextBasedChannel;
  guildId: string;
  hostId: string;
  mode: string;
  source: string;
  guessMode: string;
  question: NormalizedQuestion;
}): Promise<{ roundId: number; message: Message }> {
  const answerNorm = normalizeAnswer(opts.question.correctAnswer);
  const round = await createTriviaRound({
    guildId: opts.guildId,
    channelId: opts.channel.id,
    mode: opts.mode,
    status: "ready",
    source: opts.source,
    guessMode: opts.guessMode,
    question: questionToPayload(opts.question),
    answerNorm,
    hostId: opts.hostId,
  });

  const msg = await opts.channel.send({
    embeds: [buildQuestionEmbed(opts.question, { status: "ready", hostId: opts.hostId, mode: opts.mode })],
    components: buildRoundComponents(round.id, opts.question, "ready", opts.guessMode),
  });

  await updateTriviaRound(round.id, { messageId: msg.id });
  return { roundId: round.id, message: msg };
}

async function refreshRoundMessage(interactionGuild: NonNullable<ButtonInteraction["guild"]>, roundId: number): Promise<void> {
  const round = await getTriviaRound(roundId);
  if (!round?.messageId) return;
  const q = payloadToQuestion(round.question);
  const status = round.status === "live" ? "live" : round.status === "ended" ? "ended" : "ready";
  const ch = await interactionGuild.channels.fetch(round.channelId).catch(() => null);
  if (!ch || !ch.isTextBased() || !("messages" in ch)) return;
  const msg = await ch.messages.fetch(round.messageId).catch(() => null);
  if (!msg) return;
  await msg.edit({
    embeds: [buildQuestionEmbed(q, {
      status,
      hostId: round.hostId,
      mode: round.mode,
      revealAnswer: status === "ended",
    })],
    components: buildRoundComponents(round.id, q, status, round.guessMode),
  }).catch(() => {});
}

export async function handleTriviaStart(interaction: ButtonInteraction, roundId: number): Promise<void> {
  const round = await getTriviaRound(roundId);
  if (!round || !interaction.guild) {
    await interaction.reply({ content: "Round not found.", ...EPHEMERAL });
    return;
  }
  if (!memberIsTriviaStaff(interaction.user.id, interaction.guild.ownerId, interaction.memberPermissions)) {
    await interaction.reply({ content: "Only staff can start the round.", ...EPHEMERAL });
    return;
  }
  if (round.status !== "ready") {
    await interaction.reply({ content: "This round already started or ended.", ...EPHEMERAL });
    return;
  }
  await updateTriviaRound(roundId, { status: "live", startedAt: new Date() });
  await interaction.deferUpdate();
  await refreshRoundMessage(interaction.guild, roundId);
}

export async function handleTriviaEnd(interaction: ButtonInteraction, roundId: number): Promise<void> {
  const round = await getTriviaRound(roundId);
  if (!round || !interaction.guild) {
    await interaction.reply({ content: "Round not found.", ...EPHEMERAL });
    return;
  }
  if (!memberIsTriviaStaff(interaction.user.id, interaction.guild.ownerId, interaction.memberPermissions)) {
    await interaction.reply({ content: "Only staff can end the round.", ...EPHEMERAL });
    return;
  }
  if (round.status !== "live" && round.status !== "ready") {
    await interaction.reply({ content: "Round is not active.", ...EPHEMERAL });
    return;
  }
  await interaction.deferUpdate();
  await finishRound(interaction.guild, roundId);
}

async function finishRound(guild: NonNullable<ButtonInteraction["guild"]>, roundId: number): Promise<void> {
  const round = await getTriviaRound(roundId);
  if (!round) return;
  const q = payloadToQuestion(round.question);
  let winners = (await listCorrectGuessers(roundId)).map(g => g.userId);
  // Conversation prompts have no graded answer — pick first participant as winner.
  if (!winners.length && !round.answerNorm) {
    const first = await listFirstGuesser(roundId);
    if (first) winners = [first.userId];
  }
  const cleanupAt = new Date(Date.now() + CLEANUP_MS);

  await updateTriviaRound(roundId, {
    status: "ended",
    endedAt: new Date(),
    winners,
    cleanupAt,
  });
  await refreshRoundMessage(guild, roundId);

  const ch = await guild.channels.fetch(round.channelId).catch(() => null);
  if (!ch || !ch.isTextBased() || !("send" in ch)) return;
  const textCh = ch as TextChannel;

  if (!winners.length) {
    const msg = await textCh.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle("No correct guesses")
          .setDescription(
            q.correctAnswer
              ? `The answer was **${q.correctAnswer}**.\nThis message cleans up shortly.`
              : "Round closed — thanks for playing!\nThis message cleans up shortly.",
          ),
      ],
    });
    await updateTriviaRound(roundId, { winnerMessageId: msg.id });
    return;
  }

  const primaryId = winners[0]!;
  const member = await guild.members.fetch(primaryId).catch(() => null);
  const awarded = await awardTriviaWinnerRole({
    guild,
    userId: primaryId,
    mode: round.mode,
    roundId,
    alsoBrainiac: winners.length === 1,
  });
  const roleNames = awarded
    .map(k => TRIVIA_ROLE_DEFS.find(d => d.key === k)?.name ?? k)
    .join(", ");

  const gif = await renderTriviaWinnerGif({
    displayName: member?.displayName ?? primaryId,
    avatarUrl: member?.user.displayAvatarURL({ extension: "png", size: 256 }),
    title: "WINNER!",
    subtitle: q.correctAnswer ? `Answer: ${q.correctAnswer}` : "Nice work!",
    roleLabel: roleNames || null,
  });

  const others = winners.slice(1);
  const files = gif ? [new AttachmentBuilder(gif, { name: "trivia-winner.gif" })] : [];
  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle("🎉 Round complete")
    .setDescription(
      [
        `**Winner:** <@${primaryId}>`,
        others.length ? `Also correct: ${others.map(id => `<@${id}>`).join(", ")}` : null,
        q.correctAnswer ? `Answer: **${q.correctAnswer}**` : null,
        roleNames ? `Role: **${roleNames}** (until next winner / 24h)` : null,
        "_Winner card cleans up in about a minute._",
      ].filter(Boolean).join("\n"),
    );
  if (gif) embed.setImage("attachment://trivia-winner.gif");

  const winMsg = await textCh.send({ embeds: [embed], files });
  await updateTriviaRound(roundId, { winnerMessageId: winMsg.id });
}

export async function handleTriviaPick(interaction: ButtonInteraction, roundId: number, choiceIndex: number): Promise<void> {
  const round = await getTriviaRound(roundId);
  if (!round || round.status !== "live") {
    await interaction.reply({ content: "Guessing is closed.", ...EPHEMERAL });
    return;
  }
  const q = payloadToQuestion(round.question);
  const choice = q.choices[choiceIndex];
  if (!choice) {
    await interaction.reply({ content: "Invalid choice.", ...EPHEMERAL });
    return;
  }
  await submitGuess({
    interaction,
    roundId,
    guildId: round.guildId,
    userId: interaction.user.id,
    guess: choice,
    answerNorm: round.answerNorm,
    conversational: !round.answerNorm,
  });
}

export async function handleTriviaGuessButton(interaction: ButtonInteraction, roundId: number): Promise<void> {
  const round = await getTriviaRound(roundId);
  if (!round || round.status !== "live") {
    await interaction.reply({ content: "Guessing is closed.", ...EPHEMERAL });
    return;
  }
  const modal = new ModalBuilder()
    .setCustomId(`trivia:guess_modal:${roundId}`)
    .setTitle("Your guess")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("guess")
          .setLabel("Type your answer")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(120),
      ),
    );
  await interaction.showModal(modal);
}

export async function handleTriviaGuessModal(interaction: ModalSubmitInteraction, roundId: number): Promise<void> {
  const round = await getTriviaRound(roundId);
  if (!round || round.status !== "live") {
    await interaction.reply({ content: "Guessing is closed.", ...EPHEMERAL });
    return;
  }
  const guess = interaction.fields.getTextInputValue("guess");
  await submitGuess({
    interaction,
    roundId,
    guildId: round.guildId,
    userId: interaction.user.id,
    guess,
    answerNorm: round.answerNorm,
    conversational: !round.answerNorm,
  });
}

async function submitGuess(opts: {
  interaction: ButtonInteraction | ModalSubmitInteraction;
  roundId: number;
  guildId: string;
  userId: string;
  guess: string;
  answerNorm: string;
  conversational: boolean;
}): Promise<void> {
  const correct = opts.conversational ? false : answersMatch(opts.guess, opts.answerNorm);
  const { firstForUser } = await recordTriviaGuess({
    roundId: opts.roundId,
    guildId: opts.guildId,
    userId: opts.userId,
    guess: opts.guess.slice(0, 200),
    correct,
  });

  if (!firstForUser) {
    await opts.interaction.reply({ content: "You already guessed this round.", ...EPHEMERAL });
    return;
  }

  if (opts.conversational) {
    await opts.interaction.reply({
      content: "Answer locked in! Host will wrap up when they hit **End**.",
      ...EPHEMERAL,
    });
    return;
  }

  // Don't reveal correctness publicly — keep it fair until End.
  await opts.interaction.reply({
    content: correct
      ? "✅ Answer received — hang tight until the host ends the round!"
      : "📥 Answer received — hang tight until the host ends the round!",
    ...EPHEMERAL,
  });
}

/** Channel typing guesses while a live round allows type/both/picture/open. */
export async function handleTriviaChannelMessage(message: Message): Promise<boolean> {
  if (!message.guildId || message.author.bot || !message.content.trim()) return false;
  const round = await findLiveRoundInChannel(message.guildId, message.channelId);
  if (!round) return false;
  if (!(round.guessMode === "type" || round.guessMode === "both" || !round.answerNorm || payloadToQuestion(round.question).type === "picture")) {
    // Still allow typing when choices exist if guessMode includes type
    if (round.guessMode !== "type" && round.guessMode !== "both") return false;
  }

  const conversational = !round.answerNorm;
  const correct = conversational ? false : answersMatch(message.content, round.answerNorm);
  const { firstForUser } = await recordTriviaGuess({
    roundId: round.id,
    guildId: round.guildId,
    userId: message.author.id,
    guess: message.content.slice(0, 200),
    correct,
  });
  if (!firstForUser) return true;

  // Quiet react — no spoilers
  await message.react(correct || conversational ? "📝" : "📝").catch(() => {});
  // Delete guess to keep channel clean (optional soft cleanup)
  if (message.deletable) {
    setTimeout(() => { void message.delete().catch(() => {}); }, 2500);
  }
  return true;
}

export async function cleanupRoundArtifacts(
  guild: NonNullable<ButtonInteraction["guild"]>,
  roundId: number,
): Promise<void> {
  const round = await getTriviaRound(roundId);
  if (!round) return;
  const ch = await guild.channels.fetch(round.channelId).catch(() => null);
  if (!ch || !ch.isTextBased() || !("messages" in ch)) return;
  if (round.winnerMessageId) {
    await ch.messages.delete(round.winnerMessageId).catch(() => {});
  }
  // Clear cleanup marker so sweeper doesn't loop
  await updateTriviaRound(roundId, { cleanupAt: null, winnerMessageId: null }).catch(() => {});
  logger.debug({ roundId }, "trivia winner message cleaned");
}
