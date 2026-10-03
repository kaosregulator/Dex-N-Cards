import type { Client, GuildTextBasedChannel } from "discord.js";
import { getBotClient } from "../client-holder.js";
import {
  getOrCreateTriviaSettings,
  listDueCleanupRounds,
  listGuildsNeedingQotd,
  updateTriviaSettings,
} from "../../lib/trivia/db.js";
import {
  fetchQuestion,
  normalizeAnswer,
  type TriviaProvider,
} from "../../lib/trivia/client.js";
import { postRoundMessage, cleanupRoundArtifacts } from "./rounds.js";
import { sweepExpiredTriviaRoles } from "./roles.js";
import { logger } from "../../lib/logger.js";

const SWEEP_MS = 30_000;
let started = false;

function utcDateKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function startTriviaMaintenance(): void {
  if (started) return;
  started = true;
  setTimeout(() => { void sweepOnce(); }, 25_000);
  setInterval(() => { void sweepOnce(); }, SWEEP_MS);
}

async function sweepOnce(): Promise<void> {
  const client = getBotClient();
  if (!client) return;

  try {
    await sweepExpiredTriviaRoles(async (guildId) => {
      return client.guilds.fetch(guildId).catch(() => null);
    });
  } catch (err) {
    logger.debug({ err }, "trivia role sweep failed");
  }

  try {
    const due = await listDueCleanupRounds();
    for (const round of due) {
      try {
        const guild = await client.guilds.fetch(round.guildId).catch(() => null);
        if (guild) await cleanupRoundArtifacts(guild, round.id);
      } catch (err) {
        logger.debug({ err, roundId: round.id }, "trivia cleanup failed");
      }
    }
  } catch (err) {
    logger.debug({ err }, "trivia cleanup sweep failed");
  }

  try {
    await maybePostQotd(client);
  } catch (err) {
    logger.warn({ err }, "trivia qotd sweep failed");
  }
}

async function maybePostQotd(client: Client): Promise<void> {
  const now = new Date();
  const hour = now.getUTCHours();
  const dateKey = utcDateKey(now);
  const dueGuilds = await listGuildsNeedingQotd(hour, dateKey);

  for (const settings of dueGuilds) {
    if (!settings.qotdChannelId) continue;
    try {
      const guild = await client.guilds.fetch(settings.guildId).catch(() => null);
      if (!guild) continue;
      const ch = await guild.channels.fetch(settings.qotdChannelId).catch(() => null);
      if (!ch || !ch.isTextBased()) continue;

      let question = settings.nextCard
        ? {
            id: String(settings.nextCard.id ?? "cached"),
            provider: (settings.nextCard.provider as TriviaProvider) ?? "opentdb",
            category: String(settings.nextCard.category ?? ""),
            difficulty: String(settings.nextCard.difficulty ?? ""),
            type: (settings.nextCard.type as "multiple") ?? "multiple",
            question: String(settings.nextCard.question ?? ""),
            choices: Array.isArray(settings.nextCard.choices) ? settings.nextCard.choices.map(String) : [],
            correctAnswer: String(settings.nextCard.correctAnswer ?? ""),
            imageUrl: (settings.nextCard.imageUrl as string | null) ?? null,
            meta: (settings.nextCard.meta as Record<string, unknown>) ?? {},
          }
        : await fetchQuestion({
            provider: (settings.qotdSource as TriviaProvider) || "opentdb",
            categoryId: settings.qotdCategory ? Number(settings.qotdCategory) || null : null,
            categoryName: settings.qotdCategory,
            audience: (settings.audience as "younger" | "general") || "general",
          });

      if (!question.question) {
        question = await fetchQuestion({
          provider: "opentdb",
          audience: (settings.audience as "younger" | "general") || "general",
        });
      }

      const { roundId } = await postRoundMessage({
        channel: ch as GuildTextBasedChannel,
        guildId: guild.id,
        hostId: client.user?.id ?? "0",
        mode: "qotd",
        source: question.provider,
        guessMode: settings.defaultGuessMode || "buttons",
        question,
      });

      // Auto-start QOTD so the community can play immediately.
      const { updateTriviaRound } = await import("../../lib/trivia/db.js");
      await updateTriviaRound(roundId, { status: "live", startedAt: new Date() });
      // Refresh message components to live state
      const { getTriviaRound } = await import("../../lib/trivia/db.js");
      const round = await getTriviaRound(roundId);
      if (round?.messageId) {
        const { buildQuestionEmbed, buildRoundComponents, payloadToQuestion } = await import("./rounds.js");
        const q = payloadToQuestion(round.question);
        const msg = await (ch as GuildTextBasedChannel).messages.fetch(round.messageId).catch(() => null);
        if (msg) {
          await msg.edit({
            embeds: [buildQuestionEmbed(q, { status: "live", hostId: round.hostId, mode: "qotd" })],
            components: buildRoundComponents(round.id, q, "live", round.guessMode),
          }).catch(() => {});
        }
      }

      // Prefetch tomorrow's card for admin preview
      const next = await fetchQuestion({
        provider: (settings.qotdSource as TriviaProvider) || "opentdb",
        categoryId: settings.qotdCategory ? Number(settings.qotdCategory) || null : null,
        categoryName: settings.qotdCategory,
        audience: (settings.audience as "younger" | "general") || "general",
      }).catch(() => null);

      await updateTriviaSettings(guild.id, {
        lastQotdDate: dateKey,
        nextCard: next
          ? {
              id: next.id,
              provider: next.provider,
              category: next.category,
              difficulty: next.difficulty,
              type: next.type,
              question: next.question,
              choices: next.choices,
              correctAnswer: next.correctAnswer,
              imageUrl: next.imageUrl ?? null,
              meta: next.meta ?? {},
              answerNorm: normalizeAnswer(next.correctAnswer),
            }
          : null,
      });

      logger.info({ guildId: guild.id, roundId }, "trivia QOTD posted");
    } catch (err) {
      logger.warn({ err, guildId: settings.guildId }, "trivia QOTD post failed");
    }
  }
}

/** Warm a next-card cache for a guild (admin preview). */
export async function refreshNextCard(guildId: string): Promise<void> {
  const settings = await getOrCreateTriviaSettings(guildId);
  const next = await fetchQuestion({
    provider: (settings.defaultSource as TriviaProvider) || "opentdb",
    categoryId: settings.defaultCategory ? Number(settings.defaultCategory) || null : null,
    categoryName: settings.defaultCategory,
    audience: (settings.audience as "younger" | "general") || "general",
  });
  await updateTriviaSettings(guildId, {
    nextCard: {
      id: next.id,
      provider: next.provider,
      category: next.category,
      difficulty: next.difficulty,
      type: next.type,
      question: next.question,
      choices: next.choices,
      correctAnswer: next.correctAnswer,
      imageUrl: next.imageUrl ?? null,
      meta: next.meta ?? {},
      answerNorm: normalizeAnswer(next.correctAnswer),
    },
  });
}
