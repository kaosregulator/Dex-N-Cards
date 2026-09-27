// Discord mini-browser for live value sites.
// Public (webhook) posts branded as each site — screenshot + numbered clicks,
// search into the site, scroll/back. Auto-cleans ~45s after last touch.
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
import { getVaultBrand } from "./vault-branding.js";
import {
  ackThenPostVault,
  applyVaultBrand,
  editVaultWebhookMessage,
  postVaultWebhook,
  refreshVaultCleanup,
  VAULT_MSG_TTL_MS,
} from "./vault-webhook.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;
/** Playwright session idle (browser context). Floor message TTL is separate (~45s). */
const SESSION_TTL_MS = 3 * 60 * 1000;
const MAX_CLICK_TARGETS = 20;
const VIEWPORT = { width: 1100, height: 720 };
const SCROLL_PX = 520;

export type BrowserSite = "valuevaultx" | "vaultedvaluesx" | "mttvalues";

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
  /** Public floor message (webhook) we keep updating. */
  floorMessageId: string | null;
  floorChannelId: string | null;
};

const sessions = new Map<string, MiniSession>();
let sharedBrowser: Browser | null = null;
let launching: Promise<Browser> | null = null;

function sessionKey(userId: string, channelId: string): string {
  return `${userId}:${channelId}`;
}

function siteUrl(site: BrowserSite): string {
  return getVaultBrand(site).url;
}

/**
 * Launch Chromium robustly. Production failures looked like
 * `browserType.launch: Target page, context or browser has been closed`
 * when a stale shared browser or a path-less fallback was used.
 */
async function getBrowser(): Promise<Browser> {
  if (sharedBrowser) {
    if (sharedBrowser.isConnected()) return sharedBrowser;
    try { await sharedBrowser.close(); } catch { /* ignore */ }
    sharedBrowser = null;
  }
  if (launching) return launching;

  launching = (async () => {
    const runtime = await import("../emoji/providers/makeemoji/runtime.js");
    const pw = await runtime.loadPlaywright();
    if (!pw) {
      throw new Error("Playwright is not installed on this host");
    }
    const executablePath = await runtime.resolveChromiumPath();
    const base = runtime.launchOptions();
    const args = [
      ...(base.args ?? []),
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ];
    const uniq = [...new Set(args)];
    logger.info(
      { executablePath: executablePath ?? "(playwright default)" },
      "mini-browser launching Chromium",
    );

    try {
      const browser = await pw.chromium.launch({
        ...base,
        headless: true,
        ...(executablePath ? { executablePath } : {}),
        args: uniq,
      });
      browser.on("disconnected", () => {
        if (sharedBrowser === browser) sharedBrowser = null;
      });
      sharedBrowser = browser;
      return browser;
    } catch (err) {
      // Surface missing .so libs — common Railway failure when aptPkgs lag behind.
      let hint = "";
      if (executablePath) {
        try {
          const { spawnSync } = await import("node:child_process");
          const ldd = spawnSync("ldd", [executablePath], { encoding: "utf8" });
          const missing = (ldd.stdout || "")
            .split("\n")
            .filter((l) => /not found/i.test(l))
            .map((l) => l.trim().split(/\s+/)[0])
            .filter(Boolean)
            .slice(0, 8);
          if (missing.length) {
            hint = ` Missing libraries: ${missing.join(", ")}. Redeploy so Railway installs nixpacks.toml Chromium aptPkgs.`;
          }
        } catch { /* ignore */ }
      }
      const msg = (err as Error).message || String(err);
      throw new Error(
        (/has been closed|Target closed|Failed to launch/i.test(msg)
          ? "Chromium crashed on start (usually missing system libraries on Railway)."
          : msg) + hint,
      );
    }
  })();

  try {
    return await launching;
  } catch (err) {
    sharedBrowser = null;
    throw err;
  } finally {
    launching = null;
  }
}

async function destroySession(key: string): Promise<void> {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  if (s.timer) clearTimeout(s.timer);
  try { await s.context?.close(); } catch { /* ignore */ }
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
  const prior = sessions.get(key);
  const floorMessageId = prior?.floorMessageId ?? null;
  const floorChannelId = prior?.floorChannelId ?? null;
  await destroySession(key);

  let browser: Browser;
  try {
    browser = await getBrowser();
  } catch (first) {
    // One hard reset + retry (covers "browser has been closed" mid-launch races)
    sharedBrowser = null;
    logger.warn({ err: (first as Error).message }, "mini-browser launch retry");
    browser = await getBrowser();
  }

  let context: BrowserContext;
  try {
    context = await browser.newContext({
      viewport: VIEWPORT,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      locale: "en-US",
    });
  } catch (err) {
    // Browser died between launch and newContext — reset and try once more
    sharedBrowser = null;
    browser = await getBrowser();
    context = await browser.newContext({
      viewport: VIEWPORT,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      locale: "en-US",
    });
    void err;
  }

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    // esbuild keepNames shim (same as makeemoji runtime)
    if (typeof (globalThis as { __name?: unknown }).__name !== "function") {
      Object.defineProperty(globalThis, "__name", {
        value: (fn: unknown) => fn,
        writable: true,
        configurable: true,
      });
    }
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
    floorMessageId,
    floorChannelId,
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
    document.querySelectorAll(".dn-click-badge").forEach((b) => b.remove());

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
    document.querySelectorAll("[onclick], [data-testid], article, [class*='card' i], [class*='item' i]").forEach((el) => {
      if (el.closest("a, button, input, textarea")) return;
      const st = window.getComputedStyle(el as HTMLElement);
      if (st.cursor === "pointer" || el.getAttribute("onclick")) push(el, "button");
    });

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
        const r = c.el.getBoundingClientRect();
        badge.style.position = "fixed";
        badge.style.top = `${Math.max(0, r.top)}px`;
        badge.style.left = `${Math.max(0, r.left)}px`;
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

function navRows(): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  return [
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
  const brand = getVaultBrand("valuevaultx");
  return applyVaultBrand(
    new EmbedBuilder()
      .setTitle("🧭 Live mini-browser")
      .setDescription(
        [
          "Open a **real website** in Discord — photo of the page, numbered clicks, search, scroll.",
          "",
          `${getVaultBrand("valuevaultx").emoji} **Value Vault X**`,
          `${getVaultBrand("vaultedvaluesx").emoji} **Vaulted Values X**`,
          `${getVaultBrand("mttvalues").emoji} **MTT Values**`,
          "",
          "Yellow numbers match the dropdown. **Search** types into the site’s own box.",
          "💰 Search also attaches Value Vault X JSON prices if a site is loading/redesigning.",
          "",
          `_Public · site-branded webhook · cleans up ~${Math.round(VAULT_MSG_TTL_MS / 1000)}s after last click_`,
        ].join("\n"),
      )
      .setImage(brand.bannerUrl)
      .setFooter({ text: `Cleans up in ~${Math.round(VAULT_MSG_TTL_MS / 1000)}s idle` }),
    "valuevaultx",
  );
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

async function pageLooksPriceEmpty(page: Page, site: BrowserSite): Promise<boolean> {
  if (site !== "mttvalues") return false;
  try {
    return await page.evaluate(() => {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ");
      const loadingHeavy = (text.match(/\bLoading\b/gi) || []).length >= 2;
      const hasGemRange = /\d[\d,]{2,}\s*[-–]\s*\d|\b\d+(\.\d+)?\s*[MmKk]\b/.test(text);
      return loadingHeavy && !hasGemRange;
    });
  } catch {
    return false;
  }
}

async function vaultPriceOverlay(query: string): Promise<string> {
  try {
    const { searchVaultPrices, formatVaultPriceLine } = await import("./mttvalues.js");
    const hits = await searchVaultPrices(query, 5);
    if (!hits.length) {
      return `_No JSON feed matches for **${query}** — try another spelling._`;
    }
    return ["📦 **Value Vault X prices (JSON):**", ...hits.map((h) => `• ${formatVaultPriceLine(h)}`)].join("\n");
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "mini-browser JSON price overlay failed");
    return "_Price feed briefly unavailable — try Discord **/vaultvalue** Info._";
  }
}

async function buildViewPayload(session: MiniSession, note?: string) {
  const brand = getVaultBrand(session.site);
  session.targets = await stampAndCollect(session.page);
  const buf = await screenshotPage(session.page);
  const url = session.page.url();
  const title = (await session.page.title().catch(() => brand.name)).slice(0, 200);
  const file = new AttachmentBuilder(buf, { name: "browse.jpg" });

  const lines = session.targets.slice(0, 12).map((t) => {
    const icon = t.kind === "input" ? "⌨️" : t.kind === "button" ? "🔘" : "🔗";
    return `**${t.index}.** ${icon} ${t.label}`;
  });

  const embed = applyVaultBrand(
    new EmbedBuilder()
      .setTitle(`${brand.emoji} ${title}`.slice(0, 256))
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
      .setFooter({ text: `${brand.name} · ~${Math.round(VAULT_MSG_TTL_MS / 1000)}s cleanup · Search / Scroll` }),
    session.site,
  );

  const components = [...navRows()];
  const sel = clickSelect(session.targets);
  if (sel) components.splice(1, 0, sel);

  return { embeds: [embed], components, files: [file] };
}

/** Push a view to the public floor message (webhook), not ephemeral. */
async function publishView(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  session: MiniSession,
  note?: string,
): Promise<void> {
  const payload = await buildViewPayload(session, note);
  const key = sessionKey(session.ownerUserId, interaction.channelId!);

  // Prefer updating the existing floor webhook message in place
  if (session.floorMessageId && session.floorChannelId) {
    const ok = await editVaultWebhookMessage(
      interaction.client,
      session.floorChannelId,
      session.floorMessageId,
      session.site,
      payload,
    );
    if (ok) {
      // Acknowledge the button without replacing the floor post
      if (interaction.deferred || interaction.replied) {
        /* already deferredUpdate */
      } else if (interaction.isButton() || interaction.isStringSelectMenu()) {
        // If the click was ON the floor message, update() already consumed — but
        // we edited via webhook API, so deferUpdate + empty ack if needed.
        try {
          if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
        } catch { /* ignore */ }
      }
      armTimer(key, session);
      return;
    }
  }

  // First publish or edit failed → new webhook post
  if (!interaction.deferred && !interaction.replied) {
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      await interaction.deferUpdate().catch(async () => {
        await interaction.deferReply(EPHEMERAL);
      });
    } else {
      await interaction.deferReply(EPHEMERAL);
    }
  }

  const ref = await postVaultWebhook(interaction, session.site, payload);
  if (ref) {
    session.floorMessageId = ref.messageId;
    session.floorChannelId = ref.channelId;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({
        content: `✅ Browsing as **${getVaultBrand(session.site).name}** · use the floor message`,
        embeds: [],
        components: [],
        files: [],
      }).catch(() => {});
    }
  } else {
    // Bot fallback (public)
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      try {
        await interaction.message.edit(payload);
        session.floorMessageId = interaction.message.id;
        session.floorChannelId = interaction.channelId;
        refreshVaultCleanup(interaction.client, interaction.channelId!, interaction.message.id);
      } catch {
        await interaction.followUp({ ...payload });
      }
    } else {
      await interaction.editReply(payload);
    }
  }
  armTimer(key, session);
}

export async function startVaultBrowser(
  interaction: ButtonInteraction | ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guildId || !interaction.channelId) {
    if (interaction.deferred || interaction.replied) await interaction.editReply({ content: "Server only." });
    else await interaction.reply({ content: "Server only.", ...EPHEMERAL });
    return;
  }
  await destroySession(sessionKey(interaction.user.id, interaction.channelId));

  const payload = {
    embeds: [sitePickerEmbed()],
    components: sitePickerRows(),
  };

  // Public site-branded webhook (not ephemeral)
  const ref = await ackThenPostVault(
    interaction,
    "valuevaultx",
    payload,
    "✅ Pick a site on the floor message (public · ~45s cleanup)",
  );
  if (ref) {
    // Stash floor id so openSite can edit in place — create a stub session without browser yet
    const key = sessionKey(interaction.user.id, interaction.channelId);
    sessions.set(key, {
      ownerUserId: interaction.user.id,
      site: "valuevaultx",
      // placeholder context/page filled when a site opens
      context: null as unknown as BrowserContext,
      page: null as unknown as Page,
      history: [],
      targets: [],
      expiresAt: Date.now() + SESSION_TTL_MS,
      timer: null,
      floorMessageId: ref.messageId,
      floorChannelId: ref.channelId,
    });
    armTimer(key, sessions.get(key)!);
  }
}

async function openSite(
  interaction: ButtonInteraction,
  site: BrowserSite,
): Promise<void> {
  const brand = getVaultBrand(site);
  await interaction.deferUpdate();

  // Remember floor message from the picker (this click is on that message)
  const key = sessionKey(interaction.user.id, interaction.channelId!);
  const priorFloorId = interaction.message.id;
  const priorFloorCh = interaction.channelId!;

  // Show loading on the floor message
  await interaction.message.edit({
    embeds: [
      applyVaultBrand(
        new EmbedBuilder()
          .setTitle(`${brand.emoji} Opening ${brand.name}…`)
          .setDescription("Loading the live page — usually a few seconds."),
        site,
        { useBanner: true },
      ),
    ],
    components: [],
    files: [],
  }).catch(() => {});
  refreshVaultCleanup(interaction.client, priorFloorCh, priorFloorId);

  try {
    const session = await createSession(interaction.user.id, interaction.channelId!, site);
    session.floorMessageId = priorFloorId;
    session.floorChannelId = priorFloorCh;
    await gotoSite(session.page, siteUrl(site));
    session.history = [session.page.url()];
    await publishView(interaction, session, "Pick a yellow number or use **Search**.");
  } catch (err) {
    logger.error({ err: (err as Error).message, site }, "mini-browser open failed");
    const msg = `❌ Could not open **${brand.name}**: ${(err as Error).message.slice(0, 140)}`;
    try {
      await interaction.message.edit({
        content: msg,
        embeds: [
          applyVaultBrand(
            new EmbedBuilder()
              .setTitle("Browser failed to start")
              .setDescription(
                [
                  msg,
                  "",
                  "Use **Info** instead for search → prices (no browser needed), or try Browse again.",
                  "",
                  "Admins: ensure Chromium is installed (`pnpm emoji:install-browser`) and the bot has **Manage Webhooks**.",
                ].join("\n"),
              ),
            site,
            { useBanner: true },
          ),
        ],
        components: sitePickerRows(),
        files: [],
      });
    } catch {
      await interaction.followUp({ content: msg, ...EPHEMERAL }).catch(() => {});
    }
    void destroySession(key);
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
    // Re-post site picker on the same floor message
    if (interaction.isButton()) {
      await interaction.deferUpdate();
      const key = sessionKey(interaction.user.id, interaction.channelId);
      await destroySession(key);
      await interaction.message.edit({
        embeds: [sitePickerEmbed()],
        components: sitePickerRows(),
        files: [],
      }).catch(() => {});
      refreshVaultCleanup(interaction.client, interaction.channelId, interaction.message.id);
      sessions.set(key, {
        ownerUserId: interaction.user.id,
        site: "valuevaultx",
        context: null as unknown as BrowserContext,
        page: null as unknown as Page,
        history: [],
        targets: [],
        expiresAt: Date.now() + SESSION_TTL_MS,
        timer: null,
        floorMessageId: interaction.message.id,
        floorChannelId: interaction.channelId,
      });
      armTimer(key, sessions.get(key)!);
    }
    return;
  }

  if (id.startsWith("vvbrowse:site:") && interaction.isButton()) {
    const site = id.slice("vvbrowse:site:".length) as BrowserSite;
    if (!getVaultBrand(site)) {
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
  if (!session || !session.page) {
    await interaction.reply({
      content: "Session expired — open **Browse** again and pick a site.",
      ...EPHEMERAL,
    });
    return;
  }

  // Keep floor TTL alive while navigating
  if (session.floorMessageId && session.floorChannelId) {
    refreshVaultCleanup(interaction.client, session.floorChannelId, session.floorMessageId);
  }

  try {
    if (id === "vvbrowse:scroll:up" && interaction.isButton()) {
      await interaction.deferUpdate();
      await session.page.evaluate((y) => window.scrollBy(0, -y), SCROLL_PX);
      await session.page.waitForTimeout(200);
      await publishView(interaction, session);
      return;
    }

    if (id === "vvbrowse:scroll:down" && interaction.isButton()) {
      await interaction.deferUpdate();
      await session.page.evaluate((y) => window.scrollBy(0, y), SCROLL_PX);
      await session.page.waitForTimeout(200);
      await publishView(interaction, session);
      return;
    }

    if (id === "vvbrowse:refresh" && interaction.isButton()) {
      await interaction.deferUpdate();
      await session.page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
      await session.page.waitForTimeout(1500);
      await publishView(interaction, session, "Page refreshed.");
      return;
    }

    if (id === "vvbrowse:back" && interaction.isButton()) {
      await interaction.deferUpdate();
      if (session.history.length > 1) {
        session.history.pop();
        const prev = session.history[session.history.length - 1]!;
        await gotoSite(session.page, prev);
      } else if (session.page.url() !== siteUrl(session.site)) {
        await gotoSite(session.page, siteUrl(session.site));
        session.history = [session.page.url()];
      } else {
        await session.page.goBack({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
        await session.page.waitForTimeout(800);
      }
      await publishView(interaction, session, "Back.");
      return;
    }

    if (id === "vvbrowse:click" && interaction.isStringSelectMenu()) {
      const idx = Number(interaction.values[0]);
      await interaction.deferUpdate();
      const target = session.targets.find((t) => t.index === idx);
      if (!target) {
        await publishView(interaction, session, "That spot expired — pick again.");
        return;
      }

      if (target.kind === "input") {
        await session.page.locator(`[data-dn-click="${idx}"]`).first().click({ timeout: 5000 }).catch(() => {});
        await publishView(
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
      await publishView(interaction, session, `Opened **${target.label}**.`);
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
  if (!session || !session.page) {
    await interaction.reply({
      content: "Session expired — open **Browse** and pick a site first.",
      ...EPHEMERAL,
    });
    return;
  }

  await interaction.deferReply(EPHEMERAL);
  try {
    let typedOk = false;
    const searchLoc = session.page.locator(
      "input[data-dn-click], [data-dn-click] input, input[placeholder*='earch' i], input[type='search'], input[name*='earch' i], #searchInput, input[type='text']",
    ).first();
    if (await searchLoc.count()) {
      try {
        await searchLoc.scrollIntoViewIfNeeded().catch(() => {});
        await searchLoc.click({ timeout: 5000, force: true });
        await searchLoc.fill("");
        await searchLoc.pressSequentially(q, { delay: 35 });
        await searchLoc.press("Enter");
        typedOk = true;
      } catch {
        typedOk = false;
      }
    }

    if (!typedOk) {
      const typed = await session.page.evaluate(async (query) => {
        const pick =
          document.querySelector<HTMLInputElement>("input[type='search']")
          || document.querySelector<HTMLInputElement>("input[placeholder*='earch' i], input[name*='earch' i], input[aria-label*='earch' i]")
          || document.querySelector<HTMLInputElement>("input[type='text'], input:not([type])");
        let input: HTMLInputElement | HTMLTextAreaElement | null = null;
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
        if (!input) input = pick;
        if (!input) return { ok: false as const };
        input.focus();
        const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        desc?.set?.call(input, query);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        return { ok: true as const };
      }, q);

      if (!typed.ok) {
        const overlay = await vaultPriceOverlay(q);
        await interaction.editReply({
          content: [
            "Couldn’t find a search box on this page — scroll to one (yellow ⌨️) or click into it first.",
            "",
            overlay,
          ].join("\n"),
        });
        return;
      }
    }

    await session.page.waitForTimeout(1800);
    const url = session.page.url();
    if (session.history[session.history.length - 1] !== url) session.history.push(url);

    const [priceNote, emptyShell] = await Promise.all([
      vaultPriceOverlay(q),
      pageLooksPriceEmpty(session.page, session.site),
    ]);
    const shellWarn = emptyShell
      ? "⚠️ This site’s item rows look empty/Loading — prices below are from the **Value Vault X JSON** feed."
      : "";

    const brand = getVaultBrand(session.site);
    session.targets = await stampAndCollect(session.page);
    const buf = await screenshotPage(session.page);
    const file = new AttachmentBuilder(buf, { name: "browse.jpg" });
    const lines = session.targets.slice(0, 8).map((t) => {
      const icon = t.kind === "input" ? "⌨️" : t.kind === "button" ? "🔘" : "🔗";
      return `**${t.index}.** ${icon} ${t.label}`;
    });
    const embed = applyVaultBrand(
      new EmbedBuilder()
        .setTitle(`${brand.emoji} Search: ${q}`.slice(0, 256))
        .setURL(session.page.url())
        .setDescription(
          [
            `Typed **${q}** into the live site.`,
            `📍 \`${session.page.url().slice(0, 160)}\``,
            shellWarn,
            "",
            priceNote,
            "",
            lines.length ? lines.join("\n") : "_Page chrome loaded — scroll if needed._",
          ].filter(Boolean).join("\n"),
        )
        .setImage("attachment://browse.jpg")
        .setFooter({ text: `${brand.name} · JSON prices attached · ~45s cleanup` }),
      session.site,
    );

    const components = [...navRows()];
    const sel = clickSelect(session.targets);
    if (sel) components.splice(1, 0, sel);

    const payload = { embeds: [embed], components, files: [file] };

    // Update floor message when we have one
    if (session.floorMessageId && session.floorChannelId) {
      const ok = await editVaultWebhookMessage(
        interaction.client,
        session.floorChannelId,
        session.floorMessageId,
        session.site,
        payload,
      );
      if (ok) {
        await interaction.editReply({
          content: `✅ Search updated on the **${brand.name}** floor message`,
          embeds: [],
          components: [],
          files: [],
        });
        return;
      }
    }

    const ref = await postVaultWebhook(interaction, session.site, payload);
    if (ref) {
      session.floorMessageId = ref.messageId;
      session.floorChannelId = ref.channelId;
      await interaction.editReply({
        content: `✅ Search posted as **${brand.name}**`,
        embeds: [],
        components: [],
        files: [],
      });
    } else {
      await interaction.editReply(payload);
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, "mini-browser search failed");
    const fallback = await vaultPriceOverlay(q).catch(() => "");
    await interaction.editReply({
      content: [
        `Search on the live page failed: ${(err as Error).message.slice(0, 100)}`,
        fallback,
      ].filter(Boolean).join("\n\n"),
    });
  }
}
