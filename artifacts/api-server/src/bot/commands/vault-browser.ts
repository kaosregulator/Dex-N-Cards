// Discord mini-browser for live value sites.
// User picks a site → bot opens the real page in Playwright → screenshot embed
// with numbered click targets, search (types into the site), scroll, and back.
// Sites: Value Vault X · Vaulted Values X · MTT Values.

import type {
  ButtonInteraction,
  StringSelectMenuInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
} from "discord.js";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import type { Browser, BrowserContext, Page } from "playwright";
import { logger } from "../../lib/logger.js";
import {
  MTTVALUES_SITE_URL,
  VAULTEDVALUESX_LIST_URL,
  VALUEVAULTX_SITE_URL,
} from "./vault-sources.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;
const SESSION_TTL_MS = 12 * 60 * 1000;
const MAX_CLICK_TARGETS = 20;
const VIEWPORT = { width: 1100, height: 720 };
const SCROLL_PX = 520;

export type BrowserSite = "valuevaultx" | "vaultedvaluesx" | "mttvalues";

const SITE_HOME: Record<BrowserSite, { label: string; emoji: string; url: string; color: number }> = {
  valuevaultx: {
    label: "Value Vault X",
    emoji: "📦",
    url: VALUEVAULTX_SITE_URL,
    color: 0x9b59b6,
  },
  vaultedvaluesx: {
    label: "Vaulted Values X",
    emoji: "🌐",
    url: VAULTEDVALUESX_LIST_URL,
    color: 0x3b82f6,
  },
  mttvalues: {
    label: "MTT Values",
    emoji: "📈",
    url: MTTVALUES_SITE_URL,
    color: 0x22c55e,
  },
};

type ClickTarget = {
  index: number;
  label: string;
  kind: "link" | "button" | "input";
};

type MiniSession = {
  ownerUserId: string;
  site: BrowserSite;
  context: BrowserContext;
  page: Page;
  history: string[];
  targets: ClickTarget[];
  expiresAt: number;
  timer: ReturnType<typeof setTimeout> | null;
};

const sessions = new Map<string, MiniSession>();
let sharedBrowser: Browser | null = null;
let launching: Promise<Browser> | null = null;

function sessionKey(userId: string, channelId: string): string {
  return `${userId}:${channelId}`;
}

async function getBrowser(): Promise<Browser> {
  if (sharedBrowser?.isConnected()) return sharedBrowser;
  if (launching) return launching;
  launching = (async () => {
    try {
      // Reuse the emoji Chromium launcher when available (correct binary path).
      const { launchBrowser } = await import("../emoji/providers/makeemoji/runtime.js");
      sharedBrowser = await launchBrowser();
    } catch {
      const pw = await import("playwright");
      sharedBrowser = await pw.chromium.launch({
        headless: true,
        args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
      });
    }
    return sharedBrowser!;
  })();
  try {
    return await launching;
  } finally {
    launching = null;
  }
}

async function destroySession(key: string): Promise<void> {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  if (s.timer) clearTimeout(s.timer);
  try { await s.context.close(); } catch { /* ignore */ }
}

function armTimer(key: string, s: MiniSession): void {
  if (s.timer) clearTimeout(s.timer);
  s.expiresAt = Date.now() + SESSION_TTL_MS;
  s.timer = setTimeout(() => {
    void destroySession(key);
  }, SESSION_TTL_MS);
  s.timer.unref?.();
}

async function createSession(
  userId: string,
  channelId: string,
  site: BrowserSite,
): Promise<MiniSession> {
  const key = sessionKey(userId, channelId);
  await destroySession(key);

  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    locale: "en-US",
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await context.newPage();
  const session: MiniSession = {
    ownerUserId: userId,
    site,
    context,
    page,
    history: [],
    targets: [],
    expiresAt: Date.now() + SESSION_TTL_MS,
    timer: null,
  };
  sessions.set(key, session);
  armTimer(key, session);
  return session;
}

function getOwnedSession(userId: string, channelId: string): MiniSession | null {
  const key = sessionKey(userId, channelId);
  const s = sessions.get(key);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    void destroySession(key);
    return null;
  }
  if (s.ownerUserId !== userId) return null;
  armTimer(key, s);
  return s;
}

async function gotoSite(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  // Cloudflare / slow Wix / Next hydration
  await page.waitForTimeout(2200);
  const title = await page.title().catch(() => "");
  if (/just a moment|checking your browser/i.test(title)) {
    await page.waitForTimeout(4000);
  }
}

/** Stamp visible interactive elements with Discord-matching numbers, collect labels. */
async function stampAndCollect(page: Page): Promise<ClickTarget[]> {
  return page.evaluate((max) => {
    document.querySelectorAll("[data-dn-click]").forEach((el) => {
      el.removeAttribute("data-dn-click");
      const badge = el.querySelector(":scope > .dn-click-badge");
      badge?.remove();
    });

    const isVisible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return false;
      if (r.bottom < 0 || r.top > window.innerHeight) return false;
      if (r.right < 0 || r.left > window.innerWidth) return false;
      const st = window.getComputedStyle(el as HTMLElement);
      if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) return false;
      return true;
    };

    const candidates: Array<{ el: HTMLElement; kind: "link" | "button" | "input"; label: string }> = [];
    const push = (el: Element, kind: "link" | "button" | "input") => {
      if (!(el instanceof HTMLElement) || !isVisible(el)) return;
      if (el.closest("[data-dn-click]")) return;
      let label = (el.getAttribute("aria-label")
        || el.getAttribute("placeholder")
        || el.getAttribute("title")
        || (el as HTMLInputElement).value
        || el.textContent
        || el.getAttribute("href")
        || kind).replace(/\s+/g, " ").trim();
      if (label.length < 1) return;
      if (label.length > 80) label = label.slice(0, 77) + "…";
      // Skip pure chrome
      if (/^(skip to|cookie|accept all|log in|sign up|menu)$/i.test(label)) return;
      candidates.push({ el, kind, label });
    };

    document.querySelectorAll("a[href]").forEach((el) => push(el, "link"));
    document.querySelectorAll("button, [role='button']").forEach((el) => push(el, "button"));
    document.querySelectorAll("input[type='search'], input[type='text'], input:not([type]), textarea").forEach((el) => {
      const t = ((el as HTMLInputElement).type || "text").toLowerCase();
      if (["hidden", "password", "submit", "checkbox", "radio", "file"].includes(t)) return;
      push(el, "input");
    });
    // Card-like / pointer targets (Next/Wix often use divs)
    document.querySelectorAll("[onclick], [data-testid], article, [class*='card' i], [class*='item' i]").forEach((el) => {
      if (el.closest("a, button, input, textarea")) return;
      const st = window.getComputedStyle(el as HTMLElement);
      if (st.cursor === "pointer" || el.getAttribute("onclick")) push(el, "button");
    });

    // Prefer in-viewport unique labels; cap count
    const seen = new Set<string>();
    const picked: typeof candidates = [];
    for (const c of candidates) {
      const key = c.kind + "|" + c.label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(c);
      if (picked.length >= max) break;
    }

    const style = document.createElement("style");
    style.id = "dn-click-style";
    style.textContent = `
      .dn-click-badge {
        position: absolute; top: 2px; left: 2px; z-index: 2147483646;
        background: #f59e0b; color: #111; font: 700 12px/1.2 system-ui,sans-serif;
        padding: 2px 5px; border-radius: 4px; pointer-events: none;
        box-shadow: 0 1px 3px rgba(0,0,0,.45);
      }
      [data-dn-click] { outline: 2px solid rgba(245,158,11,.85) !important; outline-offset: 1px; }
    `;
    document.getElementById("dn-click-style")?.remove();
    document.head.appendChild(style);

    return picked.map((c, i) => {
      const idx = i + 1;
      c.el.setAttribute("data-dn-click", String(idx));
      const badge = document.createElement("span");
      badge.className = "dn-click-badge";
      badge.textContent = String(idx);
      const tag = c.el.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "img") {
        // Can't put children inside replaced/void elements — float badge near them.
        const r = c.el.getBoundingClientRect();
        badge.style.position = "fixed";
        badge.style.top = `${Math.max(0, r.top + window.scrollY)}px`;
        badge.style.left = `${Math.max(0, r.left + window.scrollX)}px`;
        document.body.appendChild(badge);
      } else {
        const pos = window.getComputedStyle(c.el).position;
        if (pos === "static") c.el.style.position = "relative";
        c.el.prepend(badge);
      }
      return { index: idx, label: c.label, kind: c.kind };
    });
  }, MAX_CLICK_TARGETS);
}

async function screenshotPage(page: Page): Promise<Buffer> {
  return page.screenshot({ type: "jpeg", quality: 72, fullPage: false });
}

function navRows(hasTargets: boolean): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("vvbrowse:scroll:up").setLabel("Scroll up").setEmoji("⬆️").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("vvbrowse:scroll:down").setLabel("Scroll down").setEmoji("⬇️").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("vvbrowse:search").setLabel("Search").setEmoji("🔎").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("vvbrowse:back").setLabel("Back").setEmoji("◀️").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("vvbrowse:refresh").setLabel("Refresh").setEmoji("🔄").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("vvbrowse:home").setLabel("Sites").setEmoji("🏠").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("vvbrowse:close").setLabel("Close").setStyle(ButtonStyle.Danger),
    ),
  ];
  return rows;
}

function clickSelect(targets: ClickTarget[]): ActionRowBuilder<StringSelectMenuBuilder> | null {
  if (!targets.length) return null;
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("vvbrowse:click")
      .setPlaceholder("Go here — pick a numbered spot on the page")
      .addOptions(
        targets.slice(0, 25).map((t) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(`${t.index}. ${t.label}`.slice(0, 100))
            .setValue(String(t.index))
            .setDescription(t.kind === "input" ? "Type into this field (use Search)" : `Click ${t.kind}`)
            .setEmoji(t.kind === "input" ? "⌨️" : t.kind === "button" ? "🔘" : "🔗"),
        ),
      ),
  );
}

function sitePickerEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xf59e0b)
    .setTitle("🧭 Live mini-browser")
    .setDescription(
      [
        "Open a **real website** inside Discord — photo of the page, numbered clicks, search, scroll.",
        "",
        `${SITE_HOME.valuevaultx.emoji} **Value Vault X** — ${VALUEVAULTX_SITE_URL}`,
        `${SITE_HOME.vaultedvaluesx.emoji} **Vaulted Values X** — ${VAULTEDVALUESX_LIST_URL}`,
        `${SITE_HOME.mttvalues.emoji} **MTT Values** — ${MTTVALUES_SITE_URL}`,
        "",
        "Yellow numbers on the screenshot match the dropdown. **Search** types into the site’s own search box.",
      ].join("\n"),
    )
    .setFooter({ text: "Ephemeral · your session only · closes after ~12 min idle" });
}

function sitePickerRows(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("vvbrowse:site:valuevaultx").setLabel("Value Vault X").setEmoji("📦").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("vvbrowse:site:vaultedvaluesx").setLabel("Vaulted Values X").setEmoji("🌐").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("vvbrowse:site:mttvalues").setLabel("MTT Values").setEmoji("📈").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

async function renderView(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ChatInputCommandInteraction | ModalSubmitInteraction,
  session: MiniSession,
  note?: string,
): Promise<void> {
  const meta = SITE_HOME[session.site];
  session.targets = await stampAndCollect(session.page);
  const buf = await screenshotPage(session.page);
  const url = session.page.url();
  const title = (await session.page.title().catch(() => meta.label)).slice(0, 200);
  const file = new AttachmentBuilder(buf, { name: "browse.jpg" });

  const lines = session.targets.slice(0, 12).map((t) => {
    const icon = t.kind === "input" ? "⌨️" : t.kind === "button" ? "🔘" : "🔗";
    return `**${t.index}.** ${icon} ${t.label}`;
  });

  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(`${meta.emoji} ${title}`.slice(0, 256))
    .setURL(url)
    .setDescription(
      [
        note ? `${note}\n` : "",
        `📍 \`${url.slice(0, 180)}\``,
        "",
        lines.length ? lines.join("\n") : "_No clickable spots in view — scroll or search._",
        session.targets.length > 12 ? `\n_…+${session.targets.length - 12} more in the menu_` : "",
      ].join("\n"),
    )
    .setImage("attachment://browse.jpg")
    .setFooter({ text: `${meta.label} · pick a number · Search / Scroll / Back` });

  const components = [...navRows(session.targets.length > 0)];
  const sel = clickSelect(session.targets);
  if (sel) components.splice(1, 0, sel); // menu under nav actions

  const payload = { embeds: [embed], components, files: [file] };
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload);
  } else if (interaction.isButton() || interaction.isStringSelectMenu()) {
    await interaction.update(payload);
  } else {
    await interaction.reply({ ...payload, ...EPHEMERAL });
  }
}

export async function startVaultBrowser(
  interaction: ButtonInteraction | ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guildId || !interaction.channelId) {
    const msg = { content: "Server only.", ...EPHEMERAL };
    if (interaction.deferred || interaction.replied) await interaction.editReply(msg);
    else await interaction.reply(msg);
    return;
  }
  // Drop any prior session so Sites picker is clean
  await destroySession(sessionKey(interaction.user.id, interaction.channelId));
  const payload = { embeds: [sitePickerEmbed()], components: sitePickerRows(), files: [] as AttachmentBuilder[] };
  if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
  else if (interaction.isButton()) await interaction.update(payload);
  else await interaction.reply({ ...payload, ...EPHEMERAL });
}

async function openSite(
  interaction: ButtonInteraction,
  site: BrowserSite,
): Promise<void> {
  await interaction.deferUpdate();
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(SITE_HOME[site].color)
        .setTitle(`${SITE_HOME[site].emoji} Opening ${SITE_HOME[site].label}…`)
        .setDescription("Loading the live page — usually a few seconds."),
    ],
    components: [],
    files: [],
  });

  try {
    const session = await createSession(interaction.user.id, interaction.channelId!, site);
    await gotoSite(session.page, SITE_HOME[site].url);
    session.history = [session.page.url()];
    await renderView(interaction, session, "Pick a yellow number or use **Search**.");
  } catch (err) {
    logger.error({ err: (err as Error).message, site }, "mini-browser open failed");
    await interaction.editReply({
      content: `❌ Could not open **${SITE_HOME[site].label}**: ${(err as Error).message.slice(0, 120)}`,
      embeds: [],
      components: sitePickerRows(),
      files: [],
    });
  }
}

export async function handleVaultBrowserComponent(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): Promise<void> {
  if (!interaction.guildId || !interaction.channelId) {
    await interaction.reply({ content: "Server only.", ...EPHEMERAL });
    return;
  }

  const id = interaction.customId;

  if (id === "vvbrowse:home") {
    await startVaultBrowser(interaction as ButtonInteraction);
    return;
  }

  if (id.startsWith("vvbrowse:site:") && interaction.isButton()) {
    const site = id.slice("vvbrowse:site:".length) as BrowserSite;
    if (!SITE_HOME[site]) {
      await interaction.reply({ content: "Unknown site.", ...EPHEMERAL });
      return;
    }
    await openSite(interaction, site);
    return;
  }

  if (id === "vvbrowse:close" && interaction.isButton()) {
    await destroySession(sessionKey(interaction.user.id, interaction.channelId));
    await interaction.update({
      content: "🧭 Mini-browser closed.",
      embeds: [],
      components: [],
      files: [],
    });
    return;
  }

  if (id === "vvbrowse:search" && interaction.isButton()) {
    const modal = new ModalBuilder()
      .setCustomId("vvbrowse:modal:search")
      .setTitle("Type into site search")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("q")
            .setLabel("What to type (site search box)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(80)
            .setPlaceholder("Sea Dragon, Abrams, STM…"),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  const session = getOwnedSession(interaction.user.id, interaction.channelId);
  if (!session) {
    await interaction.reply({
      content: "Session expired — open **Browse** again and pick a site.",
      ...EPHEMERAL,
    });
    return;
  }

  try {
    if (id === "vvbrowse:scroll:up" && interaction.isButton()) {
      await interaction.deferUpdate();
      await session.page.evaluate((y) => window.scrollBy(0, -y), SCROLL_PX);
      await session.page.waitForTimeout(200);
      await renderView(interaction, session);
      return;
    }

    if (id === "vvbrowse:scroll:down" && interaction.isButton()) {
      await interaction.deferUpdate();
      await session.page.evaluate((y) => window.scrollBy(0, y), SCROLL_PX);
      await session.page.waitForTimeout(200);
      await renderView(interaction, session);
      return;
    }

    if (id === "vvbrowse:refresh" && interaction.isButton()) {
      await interaction.deferUpdate();
      await session.page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
      await session.page.waitForTimeout(1500);
      await renderView(interaction, session, "Page refreshed.");
      return;
    }

    if (id === "vvbrowse:back" && interaction.isButton()) {
      await interaction.deferUpdate();
      if (session.history.length > 1) {
        session.history.pop();
        const prev = session.history[session.history.length - 1]!;
        await gotoSite(session.page, prev);
      } else if (session.page.url() !== SITE_HOME[session.site].url) {
        await gotoSite(session.page, SITE_HOME[session.site].url);
        session.history = [session.page.url()];
      } else {
        await session.page.goBack({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
        await session.page.waitForTimeout(800);
      }
      await renderView(interaction, session, "Back.");
      return;
    }

    if (id === "vvbrowse:click" && interaction.isStringSelectMenu()) {
      const idx = Number(interaction.values[0]);
      await interaction.deferUpdate();
      const target = session.targets.find((t) => t.index === idx);
      if (!target) {
        await renderView(interaction, session, "That spot expired — pick again.");
        return;
      }

      if (target.kind === "input") {
        // Focus search-like field and prompt them to use Search modal
        await session.page.locator(`[data-dn-click="${idx}"]`).first().click({ timeout: 5000 }).catch(() => {});
        await renderView(
          interaction,
          session,
          `⌨️ Focused **${target.label}** — press **Search** and type what you want.`,
        );
        return;
      }

      const before = session.page.url();
      const locator = session.page.locator(`[data-dn-click="${idx}"]`).first();
      await Promise.all([
        session.page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {}),
        locator.click({ timeout: 8000 }),
      ]).catch(async () => {
        await locator.click({ timeout: 5000, force: true }).catch(() => {});
      });
      await session.page.waitForTimeout(1200);
      const after = session.page.url();
      if (after !== before) session.history.push(after);
      await renderView(interaction, session, `Opened **${target.label}**.`);
      return;
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, "mini-browser action failed");
    const msg = `Something broke on the page: ${(err as Error).message.slice(0, 100)}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: msg, ...EPHEMERAL }).catch(() => {});
    } else {
      await interaction.reply({ content: msg, ...EPHEMERAL }).catch(() => {});
    }
  }
}

export async function handleVaultBrowserModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (interaction.customId !== "vvbrowse:modal:search") return;
  if (!interaction.channelId) {
    await interaction.reply({ content: "Server only.", ...EPHEMERAL });
    return;
  }
  const q = interaction.fields.getTextInputValue("q").trim();
  if (!q) {
    await interaction.reply({ content: "Type something to search.", ...EPHEMERAL });
    return;
  }

  const session = getOwnedSession(interaction.user.id, interaction.channelId);
  if (!session) {
    await interaction.reply({
      content: "Session expired — open **Browse** and pick a site first.",
      ...EPHEMERAL,
    });
    return;
  }

  await interaction.deferReply(EPHEMERAL);
  try {
    // Prefer a stamped search input, else first visible search/text input
    const typed = await session.page.evaluate(async (query) => {
      const pick =
        document.querySelector<HTMLElement>("[data-dn-click] input, input[data-dn-click], [data-dn-click][type], textarea[data-dn-click]")
        || document.querySelector<HTMLInputElement>("input[type='search']")
        || document.querySelector<HTMLInputElement>("input[placeholder*='earch' i], input[name*='earch' i], input[aria-label*='earch' i]")
        || document.querySelector<HTMLInputElement>("input[type='text'], input:not([type])");

      // If data-dn-click is on a wrapper, find input inside / self
      let input: HTMLInputElement | HTMLTextAreaElement | null = null;
      const stamped = document.querySelector<HTMLElement>("[data-dn-click]");
      // Prefer stamped element that is an input, else first stamped input kind from list
      const stampedInputs = Array.from(document.querySelectorAll<HTMLElement>("[data-dn-click]")).filter((el) => {
        const tag = el.tagName.toLowerCase();
        return tag === "input" || tag === "textarea" || !!el.querySelector("input, textarea");
      });
      const stampedInputHost = stampedInputs[0];
      if (stampedInputHost) {
        input = (stampedInputHost.tagName.toLowerCase() === "input" || stampedInputHost.tagName.toLowerCase() === "textarea")
          ? stampedInputHost as HTMLInputElement
          : stampedInputHost.querySelector("input, textarea");
      }
      if (!input) input = pick as HTMLInputElement | null;
      if (!input) return { ok: false as const, reason: "no-input" };

      input.focus();
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      // Native setter for React-controlled fields
      const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      desc?.set?.call(input, query);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
      // Also try form submit
      input.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      return { ok: true as const };
    }, q);

    if (!typed.ok) {
      // Playwright fill fallback
      const loc = session.page.locator("input[type='search'], input[placeholder*='earch' i], input[name*='earch' i], input[type='text']").first();
      if (await loc.count()) {
        await loc.click({ timeout: 5000 });
        await loc.fill(q);
        await loc.press("Enter");
      } else {
        await interaction.editReply({
          content: "Couldn’t find a search box on this page — scroll to one (yellow ⌨️) or click into it first.",
        });
        return;
      }
    }

    await session.page.waitForTimeout(1800);
    const url = session.page.url();
    if (session.history[session.history.length - 1] !== url) session.history.push(url);

    // Re-render on the deferred reply (new message) — also refresh the original browse message if possible
    session.targets = await stampAndCollect(session.page);
    const buf = await screenshotPage(session.page);
    const meta = SITE_HOME[session.site];
    const file = new AttachmentBuilder(buf, { name: "browse.jpg" });
    const lines = session.targets.slice(0, 12).map((t) => {
      const icon = t.kind === "input" ? "⌨️" : t.kind === "button" ? "🔘" : "🔗";
      return `**${t.index}.** ${icon} ${t.label}`;
    });
    const embed = new EmbedBuilder()
      .setColor(meta.color)
      .setTitle(`${meta.emoji} Search: ${q}`.slice(0, 256))
      .setURL(session.page.url())
      .setDescription(
        [
          `Typed **${q}** into the live site.`,
          `📍 \`${session.page.url().slice(0, 160)}\``,
          "",
          lines.length ? lines.join("\n") : "_Results loaded — scroll if needed._",
        ].join("\n"),
      )
      .setImage("attachment://browse.jpg")
      .setFooter({ text: "Pick a number below · Scroll / Back still work on your Browse message" });

    const components = [...navRows(true)];
    const sel = clickSelect(session.targets);
    if (sel) components.splice(1, 0, sel);

    await interaction.editReply({ embeds: [embed], components, files: [file] });
  } catch (err) {
    logger.error({ err: (err as Error).message }, "mini-browser search failed");
    await interaction.editReply({
      content: `Search failed: ${(err as Error).message.slice(0, 120)}`,
    });
  }
}
