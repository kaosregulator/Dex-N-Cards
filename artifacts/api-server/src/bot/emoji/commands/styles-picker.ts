// ─────────────────────────────────────────────────────────────────────────────
// Visual style browser for /emoji.
//
// Replaces the truncated 25-option animation dropdown with a paginated picker
// that shows MakeEmoji's prerendered cat preview for the focused style, lets
// users search by name, and remembers per-user favorites.
// ─────────────────────────────────────────────────────────────────────────────

import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  ModalBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  AttachmentBuilder,
  TextInputBuilder, TextInputStyle, type APIEmbed,
} from "discord.js";
import { fuzzyRank } from "../../search/fuse-service.js";
import { getManifest } from "../providers/makeemoji/manifest.js";
import { isFavorite, listFavorites } from "./favorites.js";
import { resolveStylePreviewUrl } from "./previews.js";
import { renderStylePreview } from "../preview/index.js";
import { renderBoard, BOARD_PAGE_SIZE } from "./board.js";
import { sceneStyleEntries } from "../providers/offline/scene-pack.js";
import type { EmojiSession } from "./session.js";
import { cid } from "./ui.js";

/** Attachment name the animated focus preview points at with `attachment://`. */
const PREVIEW_FILENAME = "style-preview.gif";

/**
 * Styles per board page. One source of truth so the canvas grid, the number
 * picker, and pagination all agree.
 */
export const STYLES_PAGE_SIZE = BOARD_PAGE_SIZE;

/** Max search query length in the modal. */
export const MAX_STYLE_QUERY = 40;

export interface StyleEntry {
  value: string;
  label: string;
}

/** Payload shape accepted by interaction.editReply for the style browser. */
export interface StylesPickerReply {
  content: string;
  embeds: (EmbedBuilder | APIEmbed)[];
  components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[];
  files: AttachmentBuilder[];
}

/**
 * Styles that do nothing useful on the board (plain tiling / passthrough), hidden
 * from the picker at the user's request. They stay in the manifest — just not
 * offered as options.
 */
const HIDDEN_STYLES = new Set([
  "gen_btn_none",
  "gen_btn_3d-flip",
  "gen_btn_2x-wide-1", "gen_btn_2x-wide-2",
  "gen_btn_3x-wide-1", "gen_btn_3x-wide-2", "gen_btn_3x-wide-3",
  "gen_btn_4x-wide-1", "gen_btn_4x-wide-2", "gen_btn_4x-wide-3", "gen_btn_4x-wide-4",
]);

/**
 * Every style the picker offers: the featured green/blue-screen scene packs
 * first (in their curated order), then the MakeEmoji catalog alphabetically,
 * minus the hidden tiling styles.
 */
export function allStyles(): StyleEntry[] {
  const scenes = sceneStyleEntries();
  const values = getManifest().manifest?.controls.animation?.values ?? [];
  const rows = values
    .map(v => ({ value: v.value, label: (v.label && v.label.trim()) || v.value }))
    .filter(r => !HIDDEN_STYLES.has(r.value));
  rows.sort((a, b) => a.label.localeCompare(b.label));
  return [...scenes, ...rows];
}

export function findStyle(value: string): StyleEntry | undefined {
  return allStyles().find(s => s.value === value);
}

/** The full catalog after the session's favorites filter and name search. */
export function filteredStyles(session: EmojiSession, userId: string): StyleEntry[] {
  let rows = allStyles();

  if (session.styleFilter === "favorites") {
    const favs = new Set(listFavorites(userId));
    rows = rows.filter(s => favs.has(s.value));
    // Keep the user's favorite order (most recent first).
    const order = listFavorites(userId);
    rows.sort((a, b) => order.indexOf(a.value) - order.indexOf(b.value));
  }

  const query = session.styleQuery?.trim() ?? "";
  if (query) {
    rows = fuzzyRank(rows, query, s => s.label);
  }
  return rows;
}

/** Filter + page the catalog for the current session picker state. */
export function pageStyles(session: EmojiSession, userId: string): {
  rows: StyleEntry[];
  page: number;
  pages: number;
  total: number;
} {
  const rows = filteredStyles(session, userId);
  const pages = Math.max(1, Math.ceil(rows.length / STYLES_PAGE_SIZE));
  const page = Math.min(Math.max(0, session.stylePage ?? 0), pages - 1);
  const slice = rows.slice(page * STYLES_PAGE_SIZE, (page + 1) * STYLES_PAGE_SIZE);
  return { rows: slice, page, pages, total: rows.length };
}

/** Total pages for the session's current filter/search — for clamping jumps. */
export function totalStylePages(session: EmojiSession, userId: string): number {
  return Math.max(1, Math.ceil(filteredStyles(session, userId).length / STYLES_PAGE_SIZE));
}

/** Ensure the session has a sensible focused style for the current page. */
export function ensureStyleFocus(session: EmojiSession, userId: string): string {
  const { rows } = pageStyles(session, userId);
  const focus = session.styleFocus;
  if (focus && rows.some(r => r.value === focus)) return focus;
  if (focus && findStyle(focus)) return focus;
  // Prefer the currently applied animation when it's on this page / catalog.
  if (rows.some(r => r.value === session.animation)) return session.animation;
  return rows[0]?.value ?? session.animation;
}

/** The focus a page's slice resolves to after navigation (applied style if on it). */
function focusForSlice(slice: StyleEntry[], animation: string): string {
  if (slice.some(r => r.value === animation)) return animation;
  return slice[0]?.value ?? animation;
}

/**
 * Warm the next page's board in the background.
 *
 * Paging felt slow because each page composed eight fresh style GIFs on arrival.
 * While the user looks at page N we warm N+1 (forward browse is the common path)
 * into the bounded board store. Prefetching both neighbours used to triple board
 * compose work and spike RSS; one neighbour is enough for the Next-button case.
 * Warms are best-effort and yield to on-demand renders in the queue.
 */
function prefetchNeighborBoards(
  session: EmojiSession, userId: string, page: number, pages: number,
): void {
  if (!session.image) return;
  const all = filteredStyles(session, userId);
  const image = session.image;
  const warm = (p: number): void => {
    if (p < 0 || p >= pages) return;
    const start = p * STYLES_PAGE_SIZE;
    const slice = all.slice(start, start + STYLES_PAGE_SIZE);
    if (slice.length === 0) return;
    void renderBoard({
      image,
      targetLabel: session.sourceLabel ?? "your image",
      styles: slice,
      focusValue: focusForSlice(slice, session.animation),
      userId,
      page: p,
      pages,
      total: all.length,
      format: session.format,
      background: true,
    }).catch(() => {});
  };
  // Prefer forward; if already on the last page, warm the previous instead.
  if (page + 1 < pages) warm(page + 1);
  else if (page > 0) warm(page - 1);
}

/**
 * Pre-warm the board a user is most likely to open next, on `image`.
 *
 * Called in the background the moment the opening chooser is shown (on the
 * caller's avatar) so tapping **My avatar** or **⭐ Favorites** paints from cache
 * instead of a cold eight-cell compose. Warms favorites page 1 when the user
 * has any, otherwise all-styles page 1. Entirely best-effort — it runs at
 * preview priority and yields to on-demand renders.
 */
export function warmTargetBoards(
  image: Buffer, userId: string, sourceLabel: string, animation: string, format: string,
): void {
  const all = allStyles();
  const warm = (styles: StyleEntry[], total: number, pageCount: number): void => {
    if (styles.length === 0) return;
    void renderBoard({
      image, targetLabel: sourceLabel, styles,
      focusValue: focusForSlice(styles, animation),
      userId, page: 0, pages: pageCount, total, format, background: true,
    }).catch(() => {});
  };

  // Warm only the first all-styles page (or favorites when the user has any).
  // Previously this also warmed favorites + a live preview in parallel, which
  // stacked three board/GIF jobs on every chooser open.
  const favVals = new Set(listFavorites(userId));
  if (favVals.size > 0) {
    const favs = all.filter(s => favVals.has(s.value));
    warm(favs.slice(0, STYLES_PAGE_SIZE), favs.length, Math.max(1, Math.ceil(favs.length / STYLES_PAGE_SIZE)));
  } else {
    const page1 = all.slice(0, STYLES_PAGE_SIZE);
    warm(page1, all.length, Math.max(1, Math.ceil(all.length / STYLES_PAGE_SIZE)));
  }
}

/**
 * Modal to search styles by name.
 *
 * Search is its own thing now — page jumps live on the page dropdown and the
 * "Go to page" button — so this is a single name field. The ranking behind it is
 * typo-tolerant (exact → substring → acronym → fuzzy), so a rough guess still
 * surfaces the closest styles.
 */
export function buildStyleSearchModal(token: string, currentQuery: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(cid("styles_modal", token))
    .setTitle("Search styles by name")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("query")
          .setLabel("Style name (leave empty to clear)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(MAX_STYLE_QUERY)
          .setPlaceholder("e.g. rainbow, spin, portal — close spellings work")
          .setValue(currentQuery.slice(0, MAX_STYLE_QUERY)),
      ),
    );
}

/** Modal to jump straight to a page number (paired with the page dropdown). */
export function buildGotoPageModal(token: string, pages: number, currentPage: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(cid("styles_goto_modal", token))
    .setTitle("Go to page")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("page")
          .setLabel(`Page number (1–${pages})`)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder(`Currently on page ${currentPage + 1}`)
          .setMaxLength(5),
      ),
    );
}

/**
 * Up to 25 page numbers (0-based) to offer in the jump dropdown: the first and
 * last page, a window around the current one, and evenly-spaced markers between,
 * so any of many pages is a couple of taps away without exceeding Discord's
 * 25-option select cap. Exact jumps to anything in between use the Go to page
 * button.
 */
export function pageJumpTargets(current: number, pages: number): number[] {
  const set = new Set<number>();
  set.add(0);
  set.add(pages - 1);
  for (let d = -2; d <= 2; d++) {
    const p = current + d;
    if (p >= 0 && p < pages) set.add(p);
  }
  const step = Math.max(1, Math.floor(pages / 12));
  for (let p = 0; p < pages; p += step) set.add(p);
  return [...set].filter(p => p >= 0 && p < pages).sort((a, b) => a - b).slice(0, 25);
}

/**
 * The Style Board dashboard.
 *
 * The embed's main image is a canvas contact sheet of this page's styles, each
 * rendered on the user's own image and numbered. The focused style also rides
 * along as an animated thumbnail, so the board shows "all of them at once" and
 * "this one, moving" together. A numbered dropdown and a highlighting number
 * picker choose a style; nothing regenerates until **Apply**, so browsing is
 * instant.
 */
export async function buildStylesPicker(
  session: EmojiSession,
  token: string,
): Promise<StylesPickerReply> {
  const userId = session.ownerId;
  const focusValue = ensureStyleFocus(session, userId);
  session.styleFocus = focusValue;

  const focused = findStyle(focusValue);
  const label = focused?.label ?? focusValue;
  const { rows, page, pages, total } = pageStyles(session, userId);
  const favorited = isFavorite(userId, focusValue);
  const targetLabel = session.sourceLabel ?? "your image";
  const focusIndex = rows.findIndex(r => r.value === focusValue);

  // The board (main image) and the focused animated preview (thumbnail) are the
  // two pictures. Render them in parallel rather than one after the other — the
  // small preview then overlaps the board compose instead of adding to it. Both
  // are on the user's OWN image; the CDN cat is only a last-resort thumbnail.
  const [board, livePreview] = session.image
    ? await Promise.all([
        renderBoard({
          image: session.image,
          targetLabel,
          styles: rows,
          focusValue,
          userId,
          page,
          pages,
          total,
          format: session.format,
        }),
        renderStylePreview(session.image, focusValue),
      ])
    : [null, null];
  const previewUrl = livePreview
    ? null
    : focused ? await resolveStylePreviewUrl(focused.label) : null;

  // Warm the neighbouring pages so Next/Prev usually hit the board cache.
  prefetchNeighborBoards(session, userId, page, pages);

  const filters: string[] = [];
  if (session.styleFilter === "favorites") filters.push("★ favorites");
  if (session.styleQuery?.trim()) filters.push(`search “${session.styleQuery.trim()}”`);

  const favView = session.styleFilter === "favorites";
  const emptyFavs = favView && total === 0;

  const numbered = focusIndex >= 0 ? `#${focusIndex + 1} · ` : "";
  const description = emptyFavs
    ? [
        "You haven't starred any styles yet.",
        "",
        "Tap **Show all**, open any style, and hit **⭐ Favorite** — it lands here for one-tap access next time.",
      ].join("\n")
    : [
        `Selected: **${numbered}${label}** ${favorited ? "★" : ""}`.trim(),
        `\`${focusValue}\` · type \`${session.format.toUpperCase()}\``,
        "",
        "Tap a **number** to select — the board rings your pick.",
        favView
          ? "**Apply** renders it on your target · **Unfavorite** removes it from this list."
          : "**Apply** renders it at full quality on your target.",
      ].join("\n");

  const embed = new EmbedBuilder()
    .setColor(favView ? 0xf1c40f : favorited ? 0xf1c40f : 0x5865f2)
    .setAuthor({ name: `🎯 ${targetLabel}` })
    .setTitle(favView ? "⭐ Your Favorites" : "🎨 Style Board")
    .setDescription(description)
    .setFooter({
      text: [
        `${total} ${favView ? "favorite" : "style"}${total === 1 ? "" : "s"}`,
        favView ? "★ your list" : "all styles",
        `page ${page + 1}/${pages}`,
      ].join(" · "),
    });

  const files: AttachmentBuilder[] = [];

  if (board) {
    files.push(new AttachmentBuilder(board.buffer, { name: board.name }));
    embed.setImage(`attachment://${board.name}`);
  }

  if (livePreview) {
    // Attached rather than linked: the bytes were rendered here and now.
    files.push(new AttachmentBuilder(livePreview, { name: PREVIEW_FILENAME }));
    embed.setThumbnail(`attachment://${PREVIEW_FILENAME}`);
  } else if (previewUrl) {
    embed.setThumbnail(previewUrl);
  }

  if (!board && !livePreview && !previewUrl) {
    embed.addFields({
      name: "Preview",
      value: "_No preview for this style — Apply still works._",
    });
  }

  const components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];

  // Row: page-jump dropdown. The number buttons pick a style; this dropdown moves
  // between pages (with the Go to page button for an exact number). Only shown
  // when there's more than one page to move between.
  if (pages > 1) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(cid("styles_page", token))
      .setPlaceholder(`Page ${page + 1} / ${pages} — jump to a page`)
      .addOptions(pageJumpTargets(page, pages).map(p =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`Page ${p + 1}${p === 0 ? " · first" : p === pages - 1 ? " · last" : ""}`)
          .setDescription(p === page ? "you are here" : `jump to page ${p + 1}`)
          .setValue(String(p))
          .setDefault(p === page),
      ));
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  }

  // Rows: the number picker. Discord caps a row at five buttons, so 1-4 sit on
  // one row and 5-8 on the next. The selected number is the only Primary button,
  // matching the ring the board draws around that cell.
  for (let start = 0; start < rows.length; start += 4) {
    const chunk = rows.slice(start, start + 4);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...chunk.map((s, j) => {
        const index = start + j;
        return new ButtonBuilder()
          .setCustomId(cid(`styles_n${index}`, token))
          .setLabel(String(index + 1))
          .setStyle(index === focusIndex ? ButtonStyle.Primary : ButtonStyle.Secondary);
      }),
    );
    components.push(row);
  }

  // Row: navigation + search + favorites filter. Pages are driven by the dropdown
  // above, Prev/Next for stepping, and Go to page for an exact number; Search is
  // now search-only.
  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(cid("styles_prev", token))
        .setEmoji("◀️")
        .setLabel("Prev")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId(cid("styles_next", token))
        .setEmoji("▶️")
        .setLabel("Next")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= pages - 1),
      new ButtonBuilder()
        .setCustomId(cid("styles_goto", token))
        .setLabel("Go to page")
        .setEmoji("🔢")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(pages <= 1),
      new ButtonBuilder()
        .setCustomId(cid("styles_search", token))
        .setLabel(session.styleQuery?.trim() ? `Search: ${session.styleQuery.trim()}`.slice(0, 60) : "Search")
        .setEmoji("🔍")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(cid("styles_filter", token))
        .setLabel(session.styleFilter === "favorites" ? "Show all" : "Favorites")
        .setEmoji("⭐")
        .setStyle(session.styleFilter === "favorites" ? ButtonStyle.Success : ButtonStyle.Secondary),
    ),
  );

  // Row: act on the focused style + change target.
  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(cid("styles_fav", token))
        .setLabel(favorited ? "Unfavorite" : "Favorite")
        .setEmoji(favorited ? "☆" : "⭐")
        .setStyle(favorited ? ButtonStyle.Secondary : ButtonStyle.Primary)
        .setDisabled(!focused),
      new ButtonBuilder()
        .setCustomId(cid("styles_apply", token))
        .setLabel("Apply style")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success)
        .setDisabled(!focused),
      new ButtonBuilder()
        .setCustomId(cid("styles_target", token))
        .setLabel("Target")
        .setEmoji("🎯")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(cid("styles_back", token))
        .setLabel("Back")
        .setEmoji("↩️")
        .setStyle(ButtonStyle.Secondary),
    ),
  );

  return {
    content: "",
    embeds: [embed],
    components,
    files,
  };
}
