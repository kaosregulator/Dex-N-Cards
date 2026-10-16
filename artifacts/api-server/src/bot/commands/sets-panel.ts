import {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, MessageFlags, ModalBuilder, TextInputBuilder,
  TextInputStyle, AttachmentBuilder,
  type ChatInputCommandInteraction, type ButtonInteraction,
  type StringSelectMenuInteraction, type ModalSubmitInteraction,
} from "discord.js";
import { isAdmin, listSetsV2, getCardsInSet, createSet, setActiveSet, clearActiveSet, getActiveSet, setSetAwardsCompletion, invalidateActiveSetCardsCache, deleteSetById, deleteAllSets } from "../db.js";
import { buildSingleSetPayload } from "./sets-admin.js";

// ── Permission guard ──────────────────────────────────────────────────────────
// Callers must defer (deferReply or deferUpdate) before calling this so
// editReply works correctly and the DB query can't blow Discord's 3s window.
async function ensureAdmin(interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction): Promise<boolean> {
  if (!interaction.guild) return false;
  if (interaction.guild.ownerId === interaction.user.id) return true;
  if (interaction.memberPermissions?.has("Administrator")) return true;
  if (await isAdmin(interaction.guild.id, interaction.user.id)) return true;
  await interaction.editReply({ content: "❌ Admins only." }).catch(() => {});
  return false;
}

// Fast sync check (zero RTT) — safe to call before the interaction is
// acknowledged. Does NOT check DB-added bot admins.
function ensureAdminInline(interaction: ButtonInteraction): boolean {
  if (!interaction.guild) return false;
  if (interaction.guild.ownerId === interaction.user.id) return true;
  return !!(interaction.memberPermissions?.has("Administrator"));
}

// ── Embed builder ─────────────────────────────────────────────────────────────
async function buildHubEmbed(guildId: string, selectedSetId?: number): Promise<EmbedBuilder> {
  const [sets, activeSet] = await Promise.all([listSetsV2(guildId), getActiveSet(guildId)]);
  const embed = new EmbedBuilder()
    .setTitle("🗂️ Set Manager")
    .setColor(0x5865f2);

  const activeId = activeSet?.id;
  const desc = activeSet
    ? `**Active spawn pool:** \`${activeSet.name}\` (${sets.find(s => s.set.id === activeSet.id)?.cardCount ?? "?"} cards)\n`
    : "**Active spawn pool:** None — random spawns are disabled\n";

  if (sets.length === 0) {
    embed.setDescription(desc + "\nNo sets yet. Click **➕ Create** to make your first one.");
    return embed;
  }

  const lines = sets.map(({ set, cardCount }) => {
    const active = set.id === activeId ? " 🟢" : "";
    const showcase = set.awardsCompletion ? " ✨" : "";
    const selected = set.id === selectedSetId ? " ◀" : "";
    return `\`${set.name}\` — ${cardCount} card${cardCount === 1 ? "" : "s"}${active}${showcase}${selected}`;
  });

  embed.setDescription(desc + "\n" + lines.join("\n"));
  embed.setFooter({ text: "🟢 = active spawn pool · ✨ = showcase (completion achievement) · ◀ = selected" });
  return embed;
}

// ── Component builders ────────────────────────────────────────────────────────
function buildSelectRow(sets: Awaited<ReturnType<typeof listSetsV2>>, activeId: number | undefined, selectedSetId?: number) {
  if (sets.length === 0) return null;
  const menu = new StringSelectMenuBuilder()
    .setCustomId("sets:pick")
    .setPlaceholder("Pick a set to manage…")
    .addOptions(
      sets.slice(0, 25).map(({ set, cardCount }) => ({
        label: (set.id === activeId ? "🟢 " : "") + set.name,
        description: `${cardCount} card${cardCount === 1 ? "" : "s"}${set.awardsCompletion ? " · ✨ showcase" : ""}`,
        value: String(set.id),
        default: set.id === selectedSetId,
      })),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function buildSetActionRow(setId: number | undefined, showcaseOn: boolean) {
  const has = setId !== undefined;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(has ? `sets:active:${setId}` : "sets:active:0")
      .setLabel("Set Active")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!has),
    new ButtonBuilder()
      .setCustomId(has ? `sets:view:${setId}` : "sets:view:0")
      .setLabel("View Cards")
      .setEmoji("👁")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!has),
    new ButtonBuilder()
      .setCustomId(has ? `sets:export:${setId}` : "sets:export:0")
      .setLabel("Export Set")
      .setEmoji("📤")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!has),
    new ButtonBuilder()
      .setCustomId(has ? `sets:showcase:${setId}` : "sets:showcase:0")
      .setLabel(showcaseOn ? "Showcase: ON" : "Showcase: OFF")
      .setEmoji("✨")
      .setStyle(showcaseOn ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(!has),
    new ButtonBuilder()
      .setCustomId(has ? `sets:delete:${setId}` : "sets:delete:0")
      .setLabel("Delete")
      .setEmoji("🗑️")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!has),
  );
}

function buildGlobalRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("sets:exportall")
      .setLabel("Export ALL")
      .setEmoji("📦")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("sets:create")
      .setLabel("Create Set")
      .setEmoji("➕")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("sets:deactivate")
      .setLabel("Deactivate")
      .setEmoji("⛔")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("sets:deleteall")
      .setLabel("Delete all sets")
      .setEmoji("🗑️")
      .setStyle(ButtonStyle.Danger),
  );
}

function confirmRow(yesId: string, yesLabel: string, noId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(yesId).setLabel(yesLabel).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(noId).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
  );
}

async function reportSetDeleteFailure(interaction: ButtonInteraction, err: unknown): Promise<void> {
  const reason = err instanceof Error ? err.message : "The database refused the delete.";
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle("Could not delete the set")
        .setDescription(reason.slice(0, 500)),
    ],
    components: [],
  }).catch(() => {});
}

async function buildPanelPayload(guildId: string, selectedSetId?: number) {
  const [sets, activeSet] = await Promise.all([listSetsV2(guildId), getActiveSet(guildId)]);
  const activeId = activeSet?.id;
  const embed = await buildHubEmbed(guildId, selectedSetId);
  const components: ActionRowBuilder<any>[] = [];

  const selectRow = buildSelectRow(sets, activeId, selectedSetId);
  if (selectRow) components.push(selectRow);

  const selectedSet = selectedSetId !== undefined ? sets.find(s => s.set.id === selectedSetId) : undefined;
  components.push(buildSetActionRow(selectedSetId, selectedSet?.set.awardsCompletion ?? false));
  components.push(buildGlobalRow());

  return { embeds: [embed], components };
}

// ── Entry: /set_hub slash command ──────────────────────────────────────────────
export async function handleSetsHubCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  // admin.ts dispatcher has already called deferReply(ephemeral) — use editReply, not reply.
  if (!await ensureAdmin(interaction)) return;
  const guildId = interaction.guild!.id;
  const payload = await buildPanelPayload(guildId);
  await interaction.editReply(payload);
}

// ── Select: user picks a set from the dropdown ────────────────────────────────
export async function handleSetsHubSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.guild) return;
  await interaction.deferUpdate();
  if (!await ensureAdmin(interaction)) return;
  const guildId = interaction.guild.id;
  const setId = parseInt(interaction.values[0]!, 10);
  const payload = await buildPanelPayload(guildId, setId);
  await interaction.editReply(payload);
}

// ── Button: all sets: button actions ─────────────────────────────────────────
export async function handleSetsHubButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) return;
  const guildId = interaction.guild.id;
  const [, action, argStr] = interaction.customId.split(":");
  const argId = argStr ? parseInt(argStr, 10) : undefined;

  // ── Create: showModal() must be the first response — cannot defer first.
  // Use fast inline check (no DB); full DB check + home-guild gate happen on
  // modal submit. Home-guild gate is sync (env lookup) so safe here too.
  if (action === "create") {
    if (!ensureAdminInline(interaction)) {
      await interaction.reply({ content: "❌ Admins only.", flags: MessageFlags.Ephemeral });
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId("sets:modal:create")
      .setTitle("Create a New Set")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("sets:name")
            .setLabel("Set Name")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("e.g. Season 2, Event Pack, Starter Set")
            .setRequired(true)
            .setMaxLength(64),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("sets:desc")
            .setLabel("Description (optional)")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(256),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  // ── All other buttons: defer immediately, then admin-check ──────────────
  await interaction.deferUpdate();
  if (!await ensureAdmin(interaction)) return;

  // ── Export ALL — sends a file, then refreshes the panel ───────────────────
  if (action === "exportall") {
    const all = await listSetsV2(guildId);
    if (all.length === 0) {
      await interaction.followUp({ content: "❌ No sets to export yet.", flags: MessageFlags.Ephemeral });
      return;
    }
    const bundle: { exportedAt: string; sets: ReturnType<typeof buildSingleSetPayload>[] } = {
      exportedAt: new Date().toISOString(),
      sets: [],
    };
    let totalCards = 0;
    for (const { set } of all) {
      const cards = await getCardsInSet(set.id, guildId);
      bundle.sets.push(buildSingleSetPayload(set, cards));
      totalCards += cards.length;
    }
    const file = new AttachmentBuilder(Buffer.from(JSON.stringify(bundle, null, 2), "utf8"), { name: "all-sets.json" });
    await interaction.followUp({
      content: `📦 Exported **${all.length}** set${all.length === 1 ? "" : "s"} (${totalCards} card${totalCards === 1 ? "" : "s"} total). Re-import with \`!loadset\` and attaching the file.`,
      files: [file],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === "deleteall") {
    const sets = await listSetsV2(guildId);
    const lines = sets.slice(0, 20).map(s => `• \`${s.set.name}\` — ${s.cardCount} card${s.cardCount === 1 ? "" : "s"}`).join("\n");
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle("Delete every set on this server?")
          .setDescription(
            [
              `This removes **${sets.length}** set${sets.length === 1 ? "" : "s"} from this server, including legacy ones like Set 1 and Set 2.`,
              "Their cards stay in the roster. `/delete_all_cards` is what erases the cards.",
              "",
              lines || "_No sets._",
            ].join("\n"),
          ),
      ],
      components: [confirmRow("sets:deleteallyes", "Yes, delete all sets", "sets:deleteallno")],
    });
    return;
  }

  if (action === "deleteallyes") {
    try {
      const { deletedSets, removedMemberships } = await deleteAllSets(guildId);
      await interaction.editReply(await buildPanelPayload(guildId));
      await interaction.followUp({
        content: deletedSets === 0
          ? "📭 No sets to delete on this server."
          : `🗑️ Deleted **${deletedSets}** set${deletedSets === 1 ? "" : "s"} and unlinked **${removedMemberships}** card membership${removedMemberships === 1 ? "" : "s"}. The cards are still in the roster.`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      await reportSetDeleteFailure(interaction, err);
    }
    return;
  }

  if (action === "deleteallno") {
    await interaction.editReply(await buildPanelPayload(guildId));
    return;
  }

  // ── Deactivate ────────────────────────────────────────────────────────────
  if (action === "deactivate") {
    await clearActiveSet(guildId);
    const payload = await buildPanelPayload(guildId);
    await interaction.editReply(payload);
    await interaction.followUp({ content: "⛔ Spawn pool deactivated — random spawns are now paused.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (!argId) return;

  // ── Set Active ────────────────────────────────────────────────────────────
  if (action === "active") {
    await setActiveSet(guildId, argId);
    const payload = await buildPanelPayload(guildId, argId);
    await interaction.editReply(payload);
    const sets = await listSetsV2(guildId);
    const set = sets.find(s => s.set.id === argId);
    if (set) {
      const warn = set.cardCount === 0 ? " ⚠️ This set has no cards yet — add some with `/set_admin add`." : "";
      await interaction.followUp({ content: `✅ **${set.set.name}** is now the active spawn pool.${warn}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  // ── View Cards — send as new ephemeral followUp (hub panel stays intact) ──
  if (action === "view") {
    const cards = await getCardsInSet(argId, guildId);
    if (cards.length === 0) {
      await interaction.followUp({ content: "📭 No cards in this set yet. Add some with `/set_admin add`.", flags: MessageFlags.Ephemeral });
      return;
    }
    const lines = cards.map(c => `• **${c.name}** — ${c.rarity}`);
    const chunks: string[] = [];
    let cur = "";
    for (const l of lines) {
      if ((cur + "\n" + l).length > 1900) { chunks.push(cur); cur = l; }
      else cur = cur ? cur + "\n" + l : l;
    }
    if (cur) chunks.push(cur);
    const sets = await listSetsV2(guildId);
    const set = sets.find(s => s.set.id === argId);
    const title = `**${set?.set.name ?? "Set"} — ${cards.length} card${cards.length === 1 ? "" : "s"}**\n`;
    await interaction.followUp({ content: title + (chunks[0] ?? ""), flags: MessageFlags.Ephemeral });
    for (const chunk of chunks.slice(1)) {
      await interaction.followUp({ content: chunk, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  // ── Export single set ─────────────────────────────────────────────────────
  if (action === "export") {
    const sets = await listSetsV2(guildId);
    const entry = sets.find(s => s.set.id === argId);
    if (!entry) { await interaction.followUp({ content: "❌ Set not found.", flags: MessageFlags.Ephemeral }); return; }
    const cards = await getCardsInSet(argId, guildId);
    const payload = JSON.stringify({ exportedAt: new Date().toISOString(), ...buildSingleSetPayload(entry.set, cards) }, null, 2);
    const safeName = entry.set.name.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
    const file = new AttachmentBuilder(Buffer.from(payload, "utf8"), { name: `${safeName}.json` });
    await interaction.followUp({
      content: `📤 Exported **${entry.set.name}** (${cards.length} card${cards.length === 1 ? "" : "s"}). Re-import with \`!loadset\` and attaching the file.`,
      files: [file],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === "delete") {
    const entry = (await listSetsV2(guildId)).find(s => s.set.id === argId);
    if (!entry) {
      await interaction.followUp({ content: "❌ Set not found.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle(`Delete set “${entry.set.name}”?`)
          .setDescription(
            `This removes the set from this server and unlinks its **${entry.cardCount}** card${entry.cardCount === 1 ? "" : "s"}. The cards stay in the roster.\n\n` +
            "Use `/delete_all_cards` if you also want the cards gone.",
          ),
      ],
      components: [confirmRow(`sets:deleteyes:${argId}`, "Yes, delete this set", `sets:deleteno:${argId}`)],
    });
    return;
  }

  if (action === "deleteyes") {
    const entry = (await listSetsV2(guildId)).find(s => s.set.id === argId);
    const name = entry?.set.name ?? "that set";
    try {
      const { removedMemberships } = await deleteSetById(argId, guildId);
      await interaction.editReply(await buildPanelPayload(guildId));
      await interaction.followUp({
        content: removedMemberships === 0 && !entry
          ? "❌ That set is already gone."
          : `🗑️ Deleted \`${name}\` and unlinked **${removedMemberships}** card${removedMemberships === 1 ? "" : "s"}. The cards are still in the roster.`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      await reportSetDeleteFailure(interaction, err);
    }
    return;
  }

  if (action === "deleteno") {
    await interaction.editReply(await buildPanelPayload(guildId, argId));
    return;
  }

  // ── Toggle Showcase ───────────────────────────────────────────────────────
  if (action === "showcase") {
    const sets = await listSetsV2(guildId);
    const entry = sets.find(s => s.set.id === argId);
    if (!entry) { await interaction.followUp({ content: "❌ Set not found.", flags: MessageFlags.Ephemeral }); return; }
    const next = !entry.set.awardsCompletion;
    await setSetAwardsCompletion(argId, next, guildId);
    const payload = await buildPanelPayload(guildId, argId);
    await interaction.editReply(payload);
    const msg = next
      ? `✨ **${entry.set.name}** is now a showcase set — collectors who own every card unlock a dedicated achievement.`
      : `✅ **${entry.set.name}** showcase achievement disabled.`;
    await interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral });
    return;
  }
}

// ── Modal: create set ─────────────────────────────────────────────────────────
export async function handleSetsHubModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.guild) return;
  // Defer immediately — ensureAdmin() has a DB call, createSet() is a DB write.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!await ensureAdmin(interaction)) return;
  const guildId = interaction.guild.id;
  const name = interaction.fields.getTextInputValue("sets:name").trim();
  const desc = interaction.fields.getTextInputValue("sets:desc").trim() || undefined;
  if (!name) { await interaction.editReply("❌ Set name cannot be empty."); return; }
  const set = await createSet(name, desc, guildId);
  await interaction.editReply(
    `✅ Created set **${set.name}**. Add cards with \`/set_admin add set:${set.name} card:<Name>\`.`,
  );
  await invalidateActiveSetCardsCache(guildId);
}
