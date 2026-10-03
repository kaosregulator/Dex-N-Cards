// /trivia — staff game-host dashboard for Flash / Trivia / QOTD.
// Sources: OpenTDB (no key), QuizAPI (QUIZAPI_KEY), boneitis prompts, dog pics.

import type {
  ChatInputCommandInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction,
  ChannelSelectMenuInteraction,
  ModalSubmitInteraction,
  GuildTextBasedChannel,
} from "discord.js";
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  MessageFlags,
} from "discord.js";
import {
  OPENTDB_CATEGORIES,
  fetchQuestion,
  isQuizApiConfigured,
  listQuizApiCategories,
  type TriviaProvider,
  type NormalizedQuestion,
} from "../../lib/trivia/client.js";
import {
  getOrCreateTriviaSettings,
  updateTriviaSettings,
} from "../../lib/trivia/db.js";
import {
  resolveTriviaStaffAccess,
  TRIVIA_DEFAULT_MEMBER_PERMISSIONS,
} from "./access.js";
import { ensureTriviaRoles, TRIVIA_ROLE_DEFS } from "./roles.js";
import {
  buildQuestionEmbed,
  postRoundMessage,
  handleTriviaStart,
  handleTriviaEnd,
  handleTriviaPick,
  handleTriviaGuessButton,
  handleTriviaGuessModal,
} from "./rounds.js";
import { refreshNextCard } from "./sweeper.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;
const COLOR = 0x5865f2;

/** Draft host sessions keyed by userId. */
const hostDraft = new Map<string, {
  mode: string;
  provider: TriviaProvider;
  categoryId?: number | null;
  categoryName?: string | null;
  guessMode: string;
  question?: NormalizedQuestion;
  expires: number;
}>();

function draftKey(userId: string) { return userId; }

export function buildTriviaAdminCommandJson() {
  return new SlashCommandBuilder()
    .setName("trivia")
    .setDescription("Host flash trivia, QOTD, and community quiz rounds")
    .setDMPermission(false)
    .setDefaultMemberPermissions(TRIVIA_DEFAULT_MEMBER_PERMISSIONS)
    .toJSON();
}

async function denyUnlessStaff(
  interaction:
    | ChatInputCommandInteraction
    | ButtonInteraction
    | StringSelectMenuInteraction
    | ChannelSelectMenuInteraction
    | ModalSubmitInteraction,
): Promise<boolean> {
  const access = await resolveTriviaStaffAccess({
    userId: interaction.user.id,
    guild: interaction.guild,
    memberPermissions: interaction.memberPermissions,
  });
  if (access.ok) return true;
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content: access.message, ...EPHEMERAL }).catch(() => {});
  } else {
    await interaction.reply({ content: access.message, ...EPHEMERAL }).catch(() => {});
  }
  return false;
}

function hubRows() {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("trivia:hub").setLabel("Home").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("trivia:host_flash").setLabel("Flash quiz").setEmoji("⚡").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("trivia:host_trivia").setLabel("Trivia round").setEmoji("🧠").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("trivia:host_picture").setLabel("Picture flash").setEmoji("🖼️").setStyle(ButtonStyle.Success),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("trivia:qotd").setLabel("QOTD setup").setEmoji("☀️").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("trivia:next").setLabel("Next card").setEmoji("🃏").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("trivia:config").setLabel("Audience & source").setEmoji("⚙️").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("trivia:roles").setLabel("Winner roles").setEmoji("🏅").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

async function buildHubEmbed(guildId: string): Promise<EmbedBuilder> {
  const s = await getOrCreateTriviaSettings(guildId);
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("🎮 Community Trivia Host")
    .setDescription(
      [
        "Drop a **flash quiz**, run a **trivia round**, or schedule **QOTD**.",
        "Players guess with big answer buttons, a **Guess** popup, or typing — only while the round is live.",
        "Staff **Start** → becomes **End**. Winners get a confetti card + a temporary role.",
        "",
        `Audience: **${s.audience}** · Default source: **${s.defaultSource}**`,
        `Guess mode: **${s.defaultGuessMode}**`,
        `QOTD: **${s.qotdEnabled ? "on" : "off"}** ${s.qotdChannelId ? `→ <#${s.qotdChannelId}>` : ""} @ **${s.qotdHourUtc}:00 UTC**`,
        `QuizAPI key: **${isQuizApiConfigured() ? "yes" : "no"}** _(OpenTDB & boneitis need none)_`,
        s.nextCard?.question
          ? `\n**Next card preview:** ${String(s.nextCard.question).slice(0, 140)}`
          : "\n_No next card cached — open **Next card** to load one._",
      ].join("\n"),
    )
    .setFooter({ text: "Safe · no NSFW · OpenTDB · QuizAPI · boneitis · dog.ceo" });
}

export async function handleTriviaAdminCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!(await denyUnlessStaff(interaction))) return;
  await interaction.deferReply(EPHEMERAL);
  const embed = await buildHubEmbed(interaction.guildId!);
  await interaction.editReply({ embeds: [embed], components: hubRows() });
}

async function beginHost(
  interaction: ButtonInteraction,
  mode: string,
  provider: TriviaProvider,
): Promise<void> {
  const settings = await getOrCreateTriviaSettings(interaction.guildId!);
  hostDraft.set(draftKey(interaction.user.id), {
    mode,
    provider,
    categoryId: settings.defaultCategory ? Number(settings.defaultCategory) || null : null,
    categoryName: settings.defaultCategory,
    guessMode: settings.defaultGuessMode || "buttons",
    expires: Date.now() + 15 * 60_000,
  });

  if (provider === "picture") {
    await interaction.deferUpdate();
    await loadAndPreview(interaction, interaction.user.id);
    return;
  }

  if (provider === "opentdb") {
    await interaction.deferUpdate();
    const menu = new StringSelectMenuBuilder()
      .setCustomId("trivia:cat_opentdb")
      .setPlaceholder("Pick an OpenTDB category…")
      .addOptions(
        { label: "Random (safe mix)", value: "random", emoji: "🎲" },
        ...OPENTDB_CATEGORIES.slice(0, 24).map(c => ({
          label: c.name.slice(0, 100),
          value: String(c.id),
          emoji: c.emoji,
        })),
      );
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR)
          .setTitle(mode === "flash" ? "⚡ Flash quiz" : "🧠 Trivia round")
          .setDescription("Choose a category. Younger audience filters stay on if configured."),
      ],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("trivia:hub").setLabel("Home").setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    return;
  }

  if (provider === "quizapi") {
    await interaction.deferUpdate();
    if (!isQuizApiConfigured()) {
      await interaction.editReply({
        content: "Set `QUIZAPI_KEY` to use QuizAPI.io — or host with OpenTDB (no key).",
        embeds: [],
        components: hubRows(),
      });
      return;
    }
    const cats = await listQuizApiCategories();
    const menu = new StringSelectMenuBuilder()
      .setCustomId("trivia:cat_quizapi")
      .setPlaceholder("Pick a QuizAPI category…")
      .addOptions(
        { label: "Any / random", value: "random" },
        ...cats.slice(0, 24).map(c => ({ label: c.name.slice(0, 100), value: c.slug })),
      );
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(COLOR).setTitle("QuizAPI round").setDescription("Pick a category, then preview.")],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("trivia:hub").setLabel("Home").setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    return;
  }

  // boneitis conversational
  await interaction.deferUpdate();
  await loadAndPreview(interaction, interaction.user.id);
}

async function loadAndPreview(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  userId: string,
): Promise<void> {
  const draft = hostDraft.get(draftKey(userId));
  if (!draft || draft.expires < Date.now()) {
    await interaction.editReply({ content: "Host draft expired — start again from Home.", embeds: [], components: hubRows() });
    return;
  }
  const settings = await getOrCreateTriviaSettings(interaction.guildId!);
  try {
    const q = await fetchQuestion({
      provider: draft.provider,
      categoryId: draft.categoryId,
      categoryName: draft.categoryName,
      audience: (settings.audience as "younger" | "general") || "general",
      conversational: draft.provider === "boneitis",
    });
    draft.question = q;
    hostDraft.set(draftKey(userId), draft);

    const guessMenu = new StringSelectMenuBuilder()
      .setCustomId("trivia:guessmode")
      .setPlaceholder("How should players answer?")
      .addOptions(
        { label: "Big answer buttons", value: "buttons", default: draft.guessMode === "buttons" },
        { label: "Guess popup (modal)", value: "modal", default: draft.guessMode === "modal" },
        { label: "Type in chat", value: "type", default: draft.guessMode === "type" },
        { label: "Buttons + type/popup", value: "both", default: draft.guessMode === "both" },
      );

    const channelPick = new ChannelSelectMenuBuilder()
      .setCustomId("trivia:post_channel")
      .setPlaceholder("Post round to channel…")
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

    await interaction.editReply({
      embeds: [
        buildQuestionEmbed(q, { status: "ready", hostId: userId, mode: draft.mode }).setFooter({
          text: "Preview — not posted yet · Skip pulls a new card",
        }),
      ],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(guessMenu),
        new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(channelPick),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("trivia:skip").setLabel("Skip card").setEmoji("⏭️").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("trivia:hub").setLabel("Home").setStyle(ButtonStyle.Primary),
        ),
      ],
    });
  } catch (err) {
    await interaction.editReply({
      content: `⚠️ Could not load a question: ${err instanceof Error ? err.message : err}`,
      embeds: [],
      components: hubRows(),
    });
  }
}

export async function handleTriviaAdminComponent(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ChannelSelectMenuInteraction,
): Promise<void> {
  const id = interaction.customId;

  // Live round buttons (public message) — not staff-hub gated the same way for guesses
  if (id.startsWith("trivia:start:")) {
    await handleTriviaStart(interaction as ButtonInteraction, Number(id.split(":")[2]));
    return;
  }
  if (id.startsWith("trivia:end:")) {
    await handleTriviaEnd(interaction as ButtonInteraction, Number(id.split(":")[2]));
    return;
  }
  if (id.startsWith("trivia:pick:")) {
    const parts = id.split(":");
    await handleTriviaPick(interaction as ButtonInteraction, Number(parts[2]), Number(parts[3]));
    return;
  }
  if (id.startsWith("trivia:guess:") && interaction.isButton()) {
    await handleTriviaGuessButton(interaction, Number(id.split(":")[2]));
    return;
  }
  if (id.startsWith("trivia:noop:")) {
    await interaction.deferUpdate().catch(() => {});
    return;
  }

  if (!(await denyUnlessStaff(interaction))) return;
  const guildId = interaction.guildId!;

  if (id === "trivia:hub" && interaction.isButton()) {
    await interaction.deferUpdate();
    const embed = await buildHubEmbed(guildId);
    await interaction.editReply({ embeds: [embed], components: hubRows(), content: null });
    return;
  }

  if (id === "trivia:host_flash" && interaction.isButton()) {
    await beginHost(interaction, "flash", "opentdb");
    return;
  }
  if (id === "trivia:host_trivia" && interaction.isButton()) {
    // Offer source picker
    await interaction.deferUpdate();
    const menu = new StringSelectMenuBuilder()
      .setCustomId("trivia:provider")
      .setPlaceholder("Choose a question source…")
      .addOptions(
        { label: "OpenTDB (no API key)", value: "opentdb", emoji: "🆓", description: "Categories, multiple choice, true/false" },
        { label: "QuizAPI.io", value: "quizapi", emoji: "🔑", description: isQuizApiConfigured() ? "Key configured" : "Needs QUIZAPI_KEY" },
        { label: "boneitis prompt", value: "boneitis", emoji: "💬", description: "Fun community conversation starter" },
      );
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(COLOR).setTitle("🧠 Trivia round").setDescription("Pick where questions come from.")],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("trivia:hub").setLabel("Home").setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    return;
  }
  if (id === "trivia:host_picture" && interaction.isButton()) {
    await beginHost(interaction, "flash", "picture");
    return;
  }

  if (id === "trivia:provider" && interaction.isStringSelectMenu()) {
    await handleTriviaProviderSelect(interaction);
    return;
  }

  if (id === "trivia:cat_opentdb" && interaction.isStringSelectMenu()) {
    await interaction.deferUpdate();
    const draft = hostDraft.get(draftKey(interaction.user.id));
    if (!draft) {
      await interaction.editReply({ content: "Draft expired.", embeds: [], components: hubRows() });
      return;
    }
    const v = interaction.values[0]!;
    draft.categoryId = v === "random" ? null : Number(v);
    draft.categoryName = v === "random" ? null : OPENTDB_CATEGORIES.find(c => c.id === Number(v))?.name ?? null;
    hostDraft.set(draftKey(interaction.user.id), draft);
    await loadAndPreview(interaction, interaction.user.id);
    return;
  }

  if (id === "trivia:cat_quizapi" && interaction.isStringSelectMenu()) {
    await interaction.deferUpdate();
    const draft = hostDraft.get(draftKey(interaction.user.id));
    if (!draft) {
      await interaction.editReply({ content: "Draft expired.", embeds: [], components: hubRows() });
      return;
    }
    const v = interaction.values[0]!;
    draft.categoryName = v === "random" ? null : v;
    hostDraft.set(draftKey(interaction.user.id), draft);
    await loadAndPreview(interaction, interaction.user.id);
    return;
  }

  if (id === "trivia:guessmode" && interaction.isStringSelectMenu()) {
    await interaction.deferUpdate();
    const draft = hostDraft.get(draftKey(interaction.user.id));
    if (!draft?.question) {
      await interaction.editReply({ content: "Draft expired.", embeds: [], components: hubRows() });
      return;
    }
    draft.guessMode = interaction.values[0]!;
    hostDraft.set(draftKey(interaction.user.id), draft);
    await updateTriviaSettings(guildId, { defaultGuessMode: draft.guessMode });
    await loadAndPreview(interaction, interaction.user.id);
    return;
  }

  if (id === "trivia:skip" && interaction.isButton()) {
    await interaction.deferUpdate();
    await loadAndPreview(interaction, interaction.user.id);
    return;
  }

  if (id === "trivia:post_channel" && interaction.isChannelSelectMenu()) {
    await interaction.deferUpdate();
    const draft = hostDraft.get(draftKey(interaction.user.id));
    if (!draft?.question || !interaction.guild) {
      await interaction.editReply({ content: "Draft expired.", embeds: [], components: hubRows() });
      return;
    }
    const channelId = interaction.values[0]!;
    const ch = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!ch || !ch.isTextBased()) {
      await interaction.editReply({ content: "Pick a text channel.", embeds: [], components: hubRows() });
      return;
    }
    const { roundId } = await postRoundMessage({
      channel: ch as GuildTextBasedChannel,
      guildId,
      hostId: interaction.user.id,
      mode: draft.mode,
      source: draft.provider,
      guessMode: draft.guessMode,
      question: draft.question,
    });
    hostDraft.delete(draftKey(interaction.user.id));
    await interaction.editReply({
      content: null,
      embeds: [
        new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle("Posted!")
          .setDescription(`Round **#${roundId}** is in <#${channelId}>.\nPress **Start** on that message when you're ready — it becomes **End** for staff.`),
      ],
      components: hubRows(),
    });
    return;
  }

  if (id === "trivia:next" && interaction.isButton()) {
    await interaction.deferUpdate();
    const settings = await getOrCreateTriviaSettings(guildId);
    if (!settings.nextCard?.question) {
      await refreshNextCard(guildId);
    }
    const s2 = await getOrCreateTriviaSettings(guildId);
    const card = s2.nextCard;
    if (!card?.question) {
      await interaction.editReply({ content: "Could not load a next card.", embeds: [], components: hubRows() });
      return;
    }
    const q = {
      id: String(card.id ?? ""),
      provider: (card.provider as TriviaProvider) ?? "opentdb",
      category: String(card.category ?? ""),
      difficulty: String(card.difficulty ?? ""),
      type: (card.type as NormalizedQuestion["type"]) ?? "multiple",
      question: String(card.question),
      choices: Array.isArray(card.choices) ? card.choices.map(String) : [],
      correctAnswer: String(card.correctAnswer ?? ""),
      imageUrl: (card.imageUrl as string | null) ?? null,
    };
    await interaction.editReply({
      embeds: [
        buildQuestionEmbed(q, { status: "ready", hostId: interaction.user.id, mode: "preview" })
          .setAuthor({ name: "Next card in queue" })
          .setFooter({ text: "Skip replaces it · Leave it and QOTD/host will use it" }),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("trivia:next_skip").setLabel("Skip / reshuffle").setEmoji("⏭️").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("trivia:hub").setLabel("Keep & home").setStyle(ButtonStyle.Success),
        ),
      ],
    });
    return;
  }

  if (id === "trivia:next_skip" && interaction.isButton()) {
    await interaction.deferUpdate();
    await refreshNextCard(guildId);
    // Re-show
    const s2 = await getOrCreateTriviaSettings(guildId);
    const card = s2.nextCard!;
    const q = {
      id: String(card.id ?? ""),
      provider: (card.provider as TriviaProvider) ?? "opentdb",
      category: String(card.category ?? ""),
      difficulty: String(card.difficulty ?? ""),
      type: (card.type as NormalizedQuestion["type"]) ?? "multiple",
      question: String(card.question ?? ""),
      choices: Array.isArray(card.choices) ? card.choices.map(String) : [],
      correctAnswer: String(card.correctAnswer ?? ""),
      imageUrl: (card.imageUrl as string | null) ?? null,
    };
    await interaction.editReply({
      embeds: [buildQuestionEmbed(q, { status: "ready", hostId: interaction.user.id, mode: "preview" }).setAuthor({ name: "Next card (reshuffled)" })],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("trivia:next_skip").setLabel("Skip again").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("trivia:hub").setLabel("Keep & home").setStyle(ButtonStyle.Success),
        ),
      ],
    });
    return;
  }

  if (id === "trivia:config" && interaction.isButton()) {
    await interaction.deferUpdate();
    const s = await getOrCreateTriviaSettings(guildId);
    const audience = new StringSelectMenuBuilder()
      .setCustomId("trivia:audience")
      .setPlaceholder("Audience filter…")
      .addOptions(
        { label: "General (all safe OpenTDB cats)", value: "general", default: s.audience === "general" },
        { label: "Younger (easy + kid-friendlier cats)", value: "younger", default: s.audience === "younger" },
      );
    const source = new StringSelectMenuBuilder()
      .setCustomId("trivia:default_source")
      .setPlaceholder("Default source…")
      .addOptions(
        { label: "OpenTDB", value: "opentdb", default: s.defaultSource === "opentdb" },
        { label: "QuizAPI", value: "quizapi", default: s.defaultSource === "quizapi" },
        { label: "boneitis prompts", value: "boneitis", default: s.defaultSource === "boneitis" },
      );
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR)
          .setTitle("⚙️ Audience & source")
          .setDescription("Younger mode prefers easy difficulty and skips politics/celebrities. Nothing NSFW is pulled from these sources."),
      ],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(audience),
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(source),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("trivia:hub").setLabel("Home").setStyle(ButtonStyle.Primary),
        ),
      ],
    });
    return;
  }

  if (id === "trivia:audience" && interaction.isStringSelectMenu()) {
    await interaction.deferUpdate();
    await updateTriviaSettings(guildId, { audience: interaction.values[0]! });
    const embed = await buildHubEmbed(guildId);
    await interaction.editReply({ embeds: [embed], components: hubRows() });
    return;
  }
  if (id === "trivia:default_source" && interaction.isStringSelectMenu()) {
    await interaction.deferUpdate();
    await updateTriviaSettings(guildId, { defaultSource: interaction.values[0]! });
    const embed = await buildHubEmbed(guildId);
    await interaction.editReply({ embeds: [embed], components: hubRows() });
    return;
  }

  if (id === "trivia:roles" && interaction.isButton()) {
    await interaction.deferUpdate();
    const roleIds = await ensureTriviaRoles(interaction.guild!);
    const lines = TRIVIA_ROLE_DEFS.map(d => {
      const rid = roleIds[d.key];
      return `• **${d.name}** ${rid ? `<@&${rid}>` : "_missing_"} — ${d.reason}`;
    });
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR)
          .setTitle("🏅 Winner roles")
          .setDescription(
            lines.join("\n") +
            "\n\nRoles move to the newest winner (or expire after 24h).",
          ),
      ],
      components: hubRows(),
    });
    return;
  }

  if (id === "trivia:qotd" && interaction.isButton()) {
    await interaction.deferUpdate();
    const s = await getOrCreateTriviaSettings(guildId);
    const ch = new ChannelSelectMenuBuilder()
      .setCustomId("trivia:qotd_channel")
      .setPlaceholder("QOTD channel…")
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
    const hour = new StringSelectMenuBuilder()
      .setCustomId("trivia:qotd_hour")
      .setPlaceholder("Post hour (UTC)…")
      .addOptions(
        ...[12, 14, 16, 18, 20, 22, 0, 8].map(h => ({
          label: `${String(h).padStart(2, "0")}:00 UTC`,
          value: String(h),
          default: s.qotdHourUtc === h,
        })),
      );
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR)
          .setTitle("☀️ Question of the Day")
          .setDescription(
            [
              `Enabled: **${s.qotdEnabled ? "yes" : "no"}**`,
              `Channel: ${s.qotdChannelId ? `<#${s.qotdChannelId}>` : "_not set_"}`,
              `Hour: **${s.qotdHourUtc}:00 UTC**`,
              `Source: **${s.qotdSource}**`,
              "",
              "Uses the **Next card** queue when present; otherwise fetches a fresh safe question.",
              "Round auto-starts so everyone can guess until staff hits **End**.",
            ].join("\n"),
          ),
      ],
      components: [
        new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(ch),
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(hour),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("trivia:qotd_toggle")
            .setLabel(s.qotdEnabled ? "Disable QOTD" : "Enable QOTD")
            .setStyle(s.qotdEnabled ? ButtonStyle.Danger : ButtonStyle.Success),
          new ButtonBuilder().setCustomId("trivia:hub").setLabel("Home").setStyle(ButtonStyle.Primary),
        ),
      ],
    });
    return;
  }

  if (id === "trivia:qotd_channel" && interaction.isChannelSelectMenu()) {
    await interaction.deferUpdate();
    await updateTriviaSettings(guildId, { qotdChannelId: interaction.values[0]! });
    const embed = await buildHubEmbed(guildId);
    await interaction.editReply({ embeds: [embed], components: hubRows() });
    return;
  }
  if (id === "trivia:qotd_hour" && interaction.isStringSelectMenu()) {
    await interaction.deferUpdate();
    await updateTriviaSettings(guildId, { qotdHourUtc: Number(interaction.values[0]) || 16 });
    const embed = await buildHubEmbed(guildId);
    await interaction.editReply({ embeds: [embed], components: hubRows() });
    return;
  }
  if (id === "trivia:qotd_toggle" && interaction.isButton()) {
    await interaction.deferUpdate();
    const s = await getOrCreateTriviaSettings(guildId);
    await updateTriviaSettings(guildId, { qotdEnabled: !s.qotdEnabled });
    if (!s.nextCard) await refreshNextCard(guildId).catch(() => {});
    const embed = await buildHubEmbed(guildId);
    await interaction.editReply({ embeds: [embed], components: hubRows() });
    return;
  }
}

export async function handleTriviaAdminModal(interaction: ModalSubmitInteraction): Promise<void> {
  const id = interaction.customId;
  if (id.startsWith("trivia:guess_modal:")) {
    await handleTriviaGuessModal(interaction, Number(id.split(":")[2]));
    return;
  }
}

// Fix provider select path — beginHost with StringSelect needs defer first.
export async function handleTriviaProviderSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!(await denyUnlessStaff(interaction))) return;
  await interaction.deferUpdate();
  const provider = interaction.values[0] as TriviaProvider;
  const settings = await getOrCreateTriviaSettings(interaction.guildId!);
  hostDraft.set(draftKey(interaction.user.id), {
    mode: provider === "boneitis" ? "prompt" : "trivia",
    provider,
    categoryId: null,
    categoryName: null,
    guessMode: provider === "boneitis" ? "modal" : (settings.defaultGuessMode || "buttons"),
    expires: Date.now() + 15 * 60_000,
  });
  if (provider === "opentdb") {
    const menu = new StringSelectMenuBuilder()
      .setCustomId("trivia:cat_opentdb")
      .setPlaceholder("Pick an OpenTDB category…")
      .addOptions(
        { label: "Random (safe mix)", value: "random", emoji: "🎲" },
        ...OPENTDB_CATEGORIES.slice(0, 24).map(c => ({
          label: c.name.slice(0, 100),
          value: String(c.id),
          emoji: c.emoji,
        })),
      );
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(COLOR).setTitle("🧠 Trivia · OpenTDB").setDescription("Choose a category.")],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("trivia:hub").setLabel("Home").setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    return;
  }
  if (provider === "quizapi") {
    if (!isQuizApiConfigured()) {
      await interaction.editReply({ content: "Set `QUIZAPI_KEY` first.", embeds: [], components: hubRows() });
      return;
    }
    const cats = await listQuizApiCategories();
    const menu = new StringSelectMenuBuilder()
      .setCustomId("trivia:cat_quizapi")
      .setPlaceholder("Pick a QuizAPI category…")
      .addOptions(
        { label: "Any / random", value: "random" },
        ...cats.slice(0, 24).map(c => ({ label: c.name.slice(0, 100), value: c.slug })),
      );
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(COLOR).setTitle("🧠 Trivia · QuizAPI")],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("trivia:hub").setLabel("Home").setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    return;
  }
  await loadAndPreview(interaction, interaction.user.id);
}
