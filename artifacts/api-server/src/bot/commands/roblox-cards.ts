// /create_card_from_roblox — search a Roblox user, preview the full-body
// avatar, then create a DN card with that name + image (same addCard path
// as /create_card_from_mttv / the old Kitsu create).
//
// A Discord role (Bloxlink nicknames) lists members with the search string
// already filled in. Roblox is contacted only after an admin picks someone.

import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  type AutocompleteInteraction, type ButtonInteraction, type StringSelectMenuInteraction,
  type ChatInputCommandInteraction, type GuildMember,
} from "discord.js";
import { isAdmin, addCard, addCardToSet, builtinRarityEconomy, getAllCards, getSetByName } from "../db.js";
import { duplicateCardMessage, findCollidingCard } from "../cards/name-collision.js";
import { renderPanel, persistBotImage } from "./edit-card.js";
import { type Rarity } from "../cards-data.js";
import { logger } from "../../lib/logger.js";
import {
  searchUsers, getUserById, getFullBodyAvatar, profileUrl, resolveRobloxUser,
  readyRobloxHits, roleSearchEntries,
  type RobloxSearchHit, type RobloxUser,
} from "./roblox-users.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;
const CREATE_CARD_RARITIES = new Set<string>(["common", "uncommon", "rare", "epic", "legendary", "mythic"]);
const TTL_MS = 15 * 60 * 1000;
const PAGE = 25;

async function createCardRarityDefaults(guildId: string, rarity: Rarity) {
  const econ = await builtinRarityEconomy(guildId, rarity);
  return { worth: econ.worthValue, burn: econ.burnValue, weight: econ.dropWeight };
}

type CreateFields = {
  rarity: Rarity;
  type: string;
  setName: string | null;
  descriptionOverride: string;
  limited: boolean;
  maxCopies: number | null;
  eventExclusive: boolean;
  uploadedImageUrl?: string;
  uploadedContentType?: string;
};

type Draft = CreateFields & {
  guildId: string;
  userId: string;
  roblox: RobloxUser;
  fullBody: string | null;
};

type RoleSearch = CreateFields & {
  guildId: string;
  userId: string;
  roleId: string;
  roleName: string;
  members: ReturnType<typeof roleSearchEntries>;
  skipped: number;
  page: number;
  note?: string;
  pendingHits?: { memberId: string; query: string; hits: RobloxSearchHit[] };
};

const drafts = new Map<string, Draft>();
const roleSearches = new Map<string, RoleSearch>();
const draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
const roleTimers = new Map<string, ReturnType<typeof setTimeout>>();

function sessionKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

function armTimer(map: Map<string, ReturnType<typeof setTimeout>>, key: string, drop: () => void): void {
  const prev = map.get(key);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    drop();
    map.delete(key);
  }, TTL_MS);
  t.unref?.();
  map.set(key, t);
}

function touchDraft(d: Draft): Draft {
  const key = sessionKey(d.guildId, d.userId);
  drafts.set(key, d);
  armTimer(draftTimers, key, () => drafts.delete(key));
  return d;
}

function touchRole(s: RoleSearch): RoleSearch {
  const key = sessionKey(s.guildId, s.userId);
  roleSearches.set(key, s);
  armTimer(roleTimers, key, () => roleSearches.delete(key));
  return s;
}

function dropDraft(guildId: string, userId: string): void {
  const key = sessionKey(guildId, userId);
  drafts.delete(key);
  const t = draftTimers.get(key);
  if (t) clearTimeout(t);
  draftTimers.delete(key);
}

function dropRole(guildId: string, userId: string): void {
  const key = sessionKey(guildId, userId);
  roleSearches.delete(key);
  const t = roleTimers.get(key);
  if (t) clearTimeout(t);
  roleTimers.delete(key);
}

type AdminInteraction = ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction;

async function memberIsAdmin(interaction: AdminInteraction): Promise<boolean> {
  if (!interaction.guild) return false;
  if (interaction.guild.ownerId === interaction.user.id) return true;
  const member = interaction.member as GuildMember | null;
  if (member?.permissions?.has("Administrator")) return true;
  return isAdmin(interaction.guild.id, interaction.user.id);
}

function cardNameFor(user: RobloxUser): string {
  return user.name.slice(0, 80);
}

function cardDescription(user: RobloxUser, override: string): string {
  if (override.trim()) return override.trim().slice(0, 500);
  const lines = [
    user.displayName && user.displayName !== user.name ? `${user.displayName} (@${user.name})` : `@${user.name}`,
    profileUrl(user.id),
    user.description?.trim() || "",
  ].filter(Boolean);
  return lines.join("\n").slice(0, 500);
}

function readFields(interaction: ChatInputCommandInteraction): CreateFields | string {
  const rarityInput = (interaction.options.getString("rarity", true) ?? "").trim().toLowerCase();
  if (!CREATE_CARD_RARITIES.has(rarityInput)) {
    return "❌ Pick one of the built-in rarities from autocomplete.";
  }
  const uploaded = interaction.options.getAttachment("image");
  return {
    rarity: rarityInput as Rarity,
    type: (interaction.options.getString("type") ?? "roblox").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 40) || "roblox",
    setName: interaction.options.getString("set")?.trim() || null,
    descriptionOverride: interaction.options.getString("description") ?? "",
    limited: interaction.options.getBoolean("limited") ?? false,
    maxCopies: interaction.options.getInteger("max_copies") ?? null,
    eventExclusive: interaction.options.getBoolean("event_exclusive") ?? false,
    uploadedImageUrl: uploaded?.url,
    uploadedContentType: uploaded?.contentType ?? undefined,
  };
}

export async function handleRobloxUserAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const q = String(interaction.options.getFocused(true).value ?? "").trim();
  if (q.length < 2) {
    await interaction.respond([]);
    return;
  }
  try {
    const hits = await searchUsers(q, 10);
    await interaction.respond(
      hits.slice(0, 25).map(h => ({
        name: `${h.displayName} (@${h.name})${h.hasVerifiedBadge ? " ✓" : ""}`.slice(0, 100),
        value: String(h.id),
      })),
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Roblox username autocomplete failed");
    await interaction.respond([]).catch(() => {});
  }
}

export async function handleCreateCardFromRoblox(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) return;
  if (!(await memberIsAdmin(interaction))) {
    await interaction.reply({ content: "❌ Admins only.", ...EPHEMERAL });
    return;
  }

  const fields = readFields(interaction);
  if (typeof fields === "string") {
    await interaction.reply({ content: fields, ...EPHEMERAL });
    return;
  }

  const role = interaction.options.getRole("role");
  const username = interaction.options.getString("username")?.trim() ?? "";
  if (!role && !username) {
    await interaction.reply({
      content: "❌ Give a Roblox **username**, or a Discord **role** whose nicknames are Roblox names (Bloxlink).",
      ...EPHEMERAL,
    });
    return;
  }

  if (role) {
    await openRoleSearch(interaction, role.id, role.name, fields);
    return;
  }
  await openUsernamePreview(interaction, username, fields);
}

async function openRoleSearch(
  interaction: ChatInputCommandInteraction,
  roleId: string,
  roleName: string,
  fields: CreateFields,
): Promise<void> {
  await interaction.deferReply(EPHEMERAL);
  const guild = interaction.guild!;
  let fetched;
  try {
    fetched = await guild.members.fetch();
  } catch (err) {
    logger.warn({ err, guildId: guild.id, roleId }, "Could not fetch members for Roblox role search");
    await interaction.editReply("❌ Could not load members for that role.");
    return;
  }
  const inRole = [...fetched.values()].filter(m => m.roles.cache.has(roleId));
  const members = roleSearchEntries(inRole.map(m => ({
    id: m.id,
    bot: m.user.bot,
    nickname: m.nickname,
    displayName: m.displayName,
    username: m.user.username,
  })));
  const humans = inRole.filter(m => !m.user.bot).length;
  if (!inRole.length) {
    await interaction.editReply(`❌ **${roleName}** has no members.`);
    return;
  }
  if (!members.length) {
    await interaction.editReply(
      `❌ Nobody in **${roleName}** has a nickname long enough to search. Bloxlink should set nicknames to Roblox names.`,
    );
    return;
  }
  dropDraft(guild.id, interaction.user.id);
  const search = touchRole({
    ...fields,
    guildId: guild.id,
    userId: interaction.user.id,
    roleId,
    roleName,
    members,
    skipped: Math.max(0, humans - members.length),
    page: 0,
  });
  await interaction.editReply(roleListPayload(search));
}

async function openUsernamePreview(
  interaction: ChatInputCommandInteraction,
  username: string,
  fields: CreateFields,
): Promise<void> {
  await interaction.deferReply(EPHEMERAL);
  dropRole(interaction.guild!.id, interaction.user.id);

  let user: RobloxUser | null;
  try {
    user = await resolveRobloxUser(username);
  } catch (err) {
    logger.error({ err, username }, "Roblox resolve failed");
    await interaction.editReply("❌ Could not reach Roblox. Try again in a moment.");
    return;
  }
  if (!user) {
    await interaction.editReply(`❌ Could not find Roblox user **${username}**. Type to search — autocomplete lists live matches.`);
    return;
  }

  const blocked = await colliding(interaction.guild!.id, cardNameFor(user));
  if (blocked) {
    await interaction.editReply(blocked);
    return;
  }

  const fullBody = fields.uploadedImageUrl ? null : await getFullBodyAvatar(user.id);
  if (!fields.uploadedImageUrl && !fullBody) {
    await interaction.editReply(`❌ **${user.name}** has no full-body avatar we can use. Upload an image, or try another user.`);
    return;
  }

  const draft = touchDraft({
    ...fields,
    guildId: interaction.guild!.id,
    userId: interaction.user.id,
    roblox: user,
    fullBody,
  });
  await interaction.editReply(previewPayload(draft, false));
}

async function colliding(guildId: string, name: string): Promise<string | null> {
  const existing = findCollidingCard(await getAllCards(guildId), name);
  return existing ? duplicateCardMessage(name, existing) : null;
}

function roleListPayload(s: RoleSearch) {
  const pages = Math.max(1, Math.ceil(s.members.length / PAGE));
  const page = Math.min(Math.max(0, s.page), pages - 1);
  s.page = page;
  const slice = s.members.slice(page * PAGE, page * PAGE + PAGE);
  const lines = slice.map((m, i) => {
    const who = m.discord ? ` — @${m.discord}` : "";
    return `**${page * PAGE + i + 1}.** **${m.query}**${who} <@${m.id}>`;
  });
  const embed = new EmbedBuilder()
    .setColor(0x00a2ff)
    .setTitle(`Roblox search ready · ${s.roleName}`)
    .setDescription([
      `**${s.members.length}** members · page **${page + 1}/${pages}**`,
      s.skipped ? `Skipped **${s.skipped}** with no usable nickname.` : null,
      "Nicknames are the search (Bloxlink). Roblox runs only after you pick someone.",
      "",
      ...lines,
      s.note ? `\n${s.note}` : null,
    ].filter(Boolean).join("\n").slice(0, 4096))
    .setFooter({ text: `${s.rarity} · ${s.type}` });
  const select = new StringSelectMenuBuilder()
    .setCustomId("rbxcreate:member")
    .setPlaceholder("Pick a member — search stays local until then")
    .addOptions(slice.map(m => {
      const opt = new StringSelectMenuOptionBuilder()
        .setLabel(m.query.slice(0, 100))
        .setValue(m.id);
      const desc = (m.discord ? `@${m.discord}` : m.label).slice(0, 100);
      if (desc) opt.setDescription(desc);
      return opt;
    }));
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("rbxcreate:page:prev").setLabel("Prev").setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId("rbxcreate:page:next").setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
    new ButtonBuilder().setCustomId("rbxcreate:cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger),
  );
  return {
    content: null as string | null,
    embeds: [embed],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      buttons,
    ],
  };
}

function hitPickerPayload(s: RoleSearch) {
  const pending = s.pendingHits!;
  const embed = new EmbedBuilder()
    .setColor(0x00a2ff)
    .setTitle(`Roblox results · ${pending.query}`)
    .setDescription(
      [
        `Search ran for **${pending.query}**. Pick the Roblox user to preview.`,
        "",
        ...pending.hits.slice(0, PAGE).map(h => `• **${h.name}**${h.displayName !== h.name ? ` (${h.displayName})` : ""}`),
      ].join("\n").slice(0, 4096),
    );
  const select = new StringSelectMenuBuilder()
    .setCustomId("rbxcreate:hit")
    .setPlaceholder("Pick the Roblox user")
    .addOptions(pending.hits.slice(0, PAGE).map(h => {
      const opt = new StringSelectMenuOptionBuilder()
        .setLabel(`${h.displayName} (@${h.name})`.slice(0, 100))
        .setValue(String(h.id));
      if (h.hasVerifiedBadge) opt.setDescription("Verified");
      return opt;
    }));
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("rbxcreate:back").setLabel("Back to role").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("rbxcreate:cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger),
  );
  return {
    content: null as string | null,
    embeds: [embed],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      buttons,
    ],
  };
}

function previewPayload(d: Draft, fromRole: boolean) {
  const image = d.uploadedImageUrl || d.fullBody;
  const embed = new EmbedBuilder()
    .setColor(0x00a2ff)
    .setTitle(`Preview · ${d.roblox.name}`)
    .setURL(profileUrl(d.roblox.id))
    .setDescription(
      [
        d.roblox.displayName !== d.roblox.name ? `Display name: **${d.roblox.displayName}**` : null,
        `Card name: **${cardNameFor(d.roblox)}** · DN rarity: **${d.rarity}** · type: **${d.type}**`,
        d.setName ? `Set: **${d.setName}**` : null,
        "",
        "Full-body avatar below. Create to run the same card flow as `/add_card`.",
      ].filter(Boolean).join("\n"),
    )
    .setFooter({ text: `Roblox ID ${d.roblox.id}` });
  if (image) embed.setImage(image);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("rbxcreate:confirm").setLabel("Create card").setEmoji("✅").setStyle(ButtonStyle.Success),
    ...(fromRole
      ? [new ButtonBuilder().setCustomId("rbxcreate:back").setLabel("Back to role").setStyle(ButtonStyle.Secondary)]
      : []),
    new ButtonBuilder().setCustomId("rbxcreate:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
  );
  return { content: null as string | null, embeds: [embed], components: [row] };
}

export async function handleRobloxCreateSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.guild) return;
  if (!(await memberIsAdmin(interaction))) {
    await interaction.reply({ content: "❌ Admins only.", ...EPHEMERAL });
    return;
  }
  const search = roleSearches.get(sessionKey(interaction.guild.id, interaction.user.id));
  if (!search) {
    await interaction.reply({ content: "This role list expired — run `/create_card_from_roblox` again.", ...EPHEMERAL });
    return;
  }
  await interaction.deferUpdate();
  const kind = interaction.customId.split(":")[1];
  if (kind === "member") {
    const member = search.members.find(m => m.id === interaction.values[0]);
    if (!member) {
      search.note = "That member is no longer in this role list.";
      await interaction.editReply(roleListPayload(search));
      return;
    }
    let hits: RobloxSearchHit[] = [];
    try {
      hits = await searchUsers(member.query, 10);
    } catch (err) {
      logger.warn({ err, query: member.query }, "Roblox role pick search failed");
      search.note = `Could not reach Roblox for **${member.query}**. The search is still ready.`;
      await interaction.editReply(roleListPayload(search));
      return;
    }
    const ready = readyRobloxHits(hits, member.query);
    if (ready.auto) {
      await openPreviewFromHit(interaction, search, ready.auto);
      return;
    }
    if (!ready.choices.length) {
      search.pendingHits = undefined;
      search.note = `No Roblox user matched **${member.query}**. Pick someone else — nothing else was fetched.`;
      touchRole(search);
      await interaction.editReply(roleListPayload(search));
      return;
    }
    search.pendingHits = { memberId: member.id, query: member.query, hits: ready.choices.slice(0, PAGE) };
    search.note = undefined;
    touchRole(search);
    await interaction.editReply(hitPickerPayload(search));
    return;
  }
  if (kind === "hit") {
    const id = Number(interaction.values[0]);
    const hit = search.pendingHits?.hits.find(h => h.id === id);
    if (!hit) {
      search.note = "That result expired. Pick the member again.";
      await interaction.editReply(roleListPayload(search));
      return;
    }
    await openPreviewFromHit(interaction, search, hit);
  }
}

async function openPreviewFromHit(
  interaction: StringSelectMenuInteraction,
  search: RoleSearch,
  hit: RobloxSearchHit,
): Promise<void> {
  let user: RobloxUser;
  try {
    user = await getUserById(hit.id);
  } catch (err) {
    logger.warn({ err, id: hit.id }, "Roblox user load failed");
    search.note = `Could not load Roblox user **${hit.name}**.`;
    await interaction.editReply(roleListPayload(search));
    return;
  }
  const name = cardNameFor(user);
  const blocked = await colliding(search.guildId, name);
  if (blocked) {
    search.note = blocked;
    touchRole(search);
    await interaction.editReply(roleListPayload(search));
    return;
  }
  const fullBody = search.uploadedImageUrl ? null : await getFullBodyAvatar(user.id);
  if (!search.uploadedImageUrl && !fullBody) {
    search.note = `**${user.name}** has no full-body avatar. Upload an image on the command, or pick someone else.`;
    touchRole(search);
    await interaction.editReply(roleListPayload(search));
    return;
  }
  touchDraft({
    guildId: search.guildId,
    userId: search.userId,
    roblox: user,
    fullBody,
    rarity: search.rarity,
    type: search.type,
    setName: search.setName,
    descriptionOverride: search.descriptionOverride,
    limited: search.limited,
    maxCopies: search.maxCopies,
    eventExclusive: search.eventExclusive,
    uploadedImageUrl: search.uploadedImageUrl,
    uploadedContentType: search.uploadedContentType,
  });
  await interaction.editReply(previewPayload(drafts.get(sessionKey(search.guildId, search.userId))!, true));
}

export async function handleRobloxCreateButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) return;
  if (!(await memberIsAdmin(interaction))) {
    await interaction.reply({ content: "❌ Admins only.", ...EPHEMERAL });
    return;
  }
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const parts = interaction.customId.split(":");
  const action = parts[1];
  const search = roleSearches.get(sessionKey(guildId, userId));

  if (action === "page") {
    if (!search) {
      await interaction.reply({ content: "This role list expired — run `/create_card_from_roblox` again.", ...EPHEMERAL });
      return;
    }
    const pages = Math.max(1, Math.ceil(search.members.length / PAGE));
    if (parts[2] === "next") search.page = Math.min(pages - 1, search.page + 1);
    if (parts[2] === "prev") search.page = Math.max(0, search.page - 1);
    search.note = undefined;
    touchRole(search);
    await interaction.update(roleListPayload(search));
    return;
  }
  if (action === "back") {
    if (!search) {
      await interaction.reply({ content: "This role list expired — run `/create_card_from_roblox` again.", ...EPHEMERAL });
      return;
    }
    search.note = undefined;
    search.pendingHits = undefined;
    touchRole(search);
    dropDraft(guildId, userId);
    await interaction.update(roleListPayload(search));
    return;
  }
  if (action === "cancel") {
    dropDraft(guildId, userId);
    dropRole(guildId, userId);
    await interaction.update({ content: "Cancelled.", embeds: [], components: [] });
    return;
  }

  const d = drafts.get(sessionKey(guildId, userId));
  if (!d) {
    await interaction.reply({ content: "This preview expired — run `/create_card_from_roblox` again.", ...EPHEMERAL });
    return;
  }
  if (action !== "confirm") return;
  await runCreate(interaction, d);
}

async function replyOrRoleList(interaction: ButtonInteraction, d: Draft, note: string): Promise<void> {
  const search = roleSearches.get(sessionKey(d.guildId, d.userId));
  if (search) {
    search.note = note;
    touchRole(search);
    await interaction.editReply(roleListPayload(search));
    return;
  }
  await interaction.editReply({ content: note, embeds: [], components: [] });
}

async function runCreate(interaction: ButtonInteraction, d: Draft): Promise<void> {
  await interaction.deferUpdate();
  dropDraft(d.guildId, d.userId);

  const name = cardNameFor(d.roblox);
  const blocked = await colliding(d.guildId, name);
  if (blocked) {
    await replyOrRoleList(interaction, d, blocked);
    return;
  }

  const defs = await createCardRarityDefaults(d.guildId, d.rarity);
  let imageUrl: string | undefined;
  try {
    if (d.uploadedImageUrl) imageUrl = await persistBotImage(d.uploadedImageUrl, d.uploadedContentType);
    else if (d.fullBody) imageUrl = await persistBotImage(d.fullBody);
  } catch (err) {
    logger.error({ err, name }, "Failed to persist Roblox avatar");
    await replyOrRoleList(interaction, d, `❌ Could not save **${name}**'s avatar. Try again.`);
    return;
  }
  if (!imageUrl) {
    await replyOrRoleList(interaction, d, `❌ **${name}** has no image to save.`);
    return;
  }

  let card;
  try {
    card = await addCard({
      name,
      rarity: d.rarity,
      cardType: d.type,
      description: cardDescription(d.roblox, d.descriptionOverride),
      imageUrl,
      worthValue: defs.worth,
      burnValue: defs.burn,
      dropWeight: defs.weight,
      isLimitedEdition: d.limited,
      maxCopies: d.limited ? (d.maxCopies ?? 50) : undefined,
      isEventExclusive: d.eventExclusive,
      droppable: !d.eventExclusive,
      inPacks: !d.eventExclusive && d.rarity !== "mythic",
    }, d.guildId);
  } catch (err) {
    logger.error({ err, name, guildId: d.guildId }, "Failed to create card from Roblox");
    await replyOrRoleList(interaction, d, `❌ Could not create card **${name}** — the server hit an error while saving it.`);
    return;
  }

  let setNote = "";
  if (d.setName) {
    try {
      const set = await getSetByName(d.setName, d.guildId);
      if (set) {
        await addCardToSet(set.id, card.id, d.guildId);
        setNote = ` and added to set \`${set.name}\``;
      } else {
        setNote = ` (set \`${d.setName}\` was not found, so no set was assigned)`;
      }
    } catch (err) {
      logger.error({ err, cardId: card.id, setName: d.setName }, "Failed to add Roblox-created card to set");
      setNote = ` (could not add to set \`${d.setName}\`)`;
    }
  }

  await renderPanel(
    interaction,
    card.id,
    false,
    `✅ Created **${card.name}** from Roblox (${d.rarity})${setNote} — tweak any field below`,
  );
}
