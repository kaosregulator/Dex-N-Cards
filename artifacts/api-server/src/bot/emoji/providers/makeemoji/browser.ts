// ─────────────────────────────────────────────────────────────────────────────
// Browser path.
//
// Drives MakeEmoji's own editor in headless Chromium: upload the image, set the
// controls, trigger generation, take the finished file. Slower than a direct
// request, but it is the path that works when generation happens inside the page
// — which, for an emoji editor, is the likely case.
//
// Every selector and option value comes from the discovery manifest. Nothing
// here knows what MakeEmoji's DOM looks like, so a redesign of the site is fixed
// by re-running discovery rather than by editing this file.
//
// Reliability rules this file follows, because it runs on a Discord bot:
//   • shared Chromium via withSharedBrowser — one process, serial jobs, idle-close
//     (launching a fresh Chromium per generate was a 150–400 MB RSS spike)
//   • every wait is bounded; nothing blocks forever on a selector that changed
//   • a missing selector is `site_changed`, not a crash, so the user gets a
//     clean message and an operator gets a log line naming the selector
// ─────────────────────────────────────────────────────────────────────────────

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Download, Page } from "playwright";
import { logger } from "../../../../lib/logger.js";
import { EmojiError } from "../../utils/errors.js";
import type { GenerateOptions, GenerateResult } from "../../types.js";
import { withSharedBrowser, newContext } from "./runtime.js";
import { resolveValue } from "./manifest.js";
import type { ControlSpec, Manifest, OptionKey } from "./types.js";
import { recordNetwork } from "./discovery/recorder.js";
import { writeDebugTrace } from "./debug.js";
import type { BrowserWindow, DomElement, DomMedia } from "./discovery/dom-types.js";

/** Budget for one whole generation, browser launch included. */
const GENERATE_TIMEOUT_MS = 60_000;
/** Budget for any single page interaction. */
const STEP_TIMEOUT_MS = 15_000;
/** How long to wait for the editor to produce a result after the trigger. */
const RESULT_TIMEOUT_MS = 25_000;

/** Why the browser path can't run against this manifest, or null when it can. */
export function browserPathProblem(manifest: Manifest | null): string | null {
  if (!manifest) return "no manifest loaded";
  if (!manifest.browser.fileInputSelector) {
    return "manifest has no file-input selector — re-run discovery";
  }
  return null;
}

/** Apply one option to its control, using whatever kind of control it is. */
async function applyControl(
  page: Page, key: OptionKey, spec: ControlSpec, value: string,
): Promise<void> {
  switch (spec.kind) {
    case "select":
      await page.selectOption(spec.selector, value, { timeout: STEP_TIMEOUT_MS });
      return;
    case "listbox": {
      // Custom listboxes (MakeEmoji): open the trigger, then click the option
      // whose visible text matches the discovered value (or its compact label).
      await page.click(spec.selector, { timeout: STEP_TIMEOUT_MS });
      const option = page.locator('[role="option"]').filter({ hasText: value }).first();
      // Fall back to a looser contains match when the value is a compact label
      // like "GIF" against option text "📁 GIF".
      if (await option.count()) {
        await option.click({ timeout: STEP_TIMEOUT_MS });
      } else {
        await page.getByRole("option", { name: new RegExp(escapeRegExp(value), "i") })
          .first()
          .click({ timeout: STEP_TIMEOUT_MS });
      }
      await page.keyboard.press("Escape").catch(() => {});
      return;
    }
    case "radio":
      await page.click(`${spec.selector}[value="${value}"]`, { timeout: STEP_TIMEOUT_MS });
      return;
    case "button": {
      const attribute = spec.valueAttribute ?? "data-value";
      const locator = page.locator(`[${attribute}="${value}"]`).first();
      try {
        await locator.scrollIntoViewIfNeeded({ timeout: STEP_TIMEOUT_MS });
        await locator.click({ timeout: STEP_TIMEOUT_MS });
        return;
      } catch {
        // Style grids virtualise. Open the styles filter/search UI if needed,
        // type the style name, then click the tile once it mounts.
        const styleName = value.replace(/^gen_btn_/i, "").replace(/^:|:$/g, "");
        await page.locator("details").filter({ has: page.locator('input[placeholder*="Search" i]') })
          .locator("summary").click({ timeout: 3_000 }).catch(() => {});
        const search = page.locator(
          'input[placeholder*="Search" i], input[aria-label*="Search" i], input[type=search]',
        ).first();
        if (await search.count()) {
          await search.click({ timeout: STEP_TIMEOUT_MS });
          await search.fill("");
          await search.fill(styleName, { timeout: STEP_TIMEOUT_MS });
          await page.waitForTimeout(1200);
          const found = page.locator(`[${attribute}="${value}"]`).first();
          await found.scrollIntoViewIfNeeded({ timeout: STEP_TIMEOUT_MS }).catch(() => {});
          await found.click({ timeout: STEP_TIMEOUT_MS });
          return;
        }
        throw new Error(`button ${attribute}=${value} not found`);
      }
    }
    case "range":
    case "text":
      await page.fill(spec.selector, value, { timeout: STEP_TIMEOUT_MS });
      return;
    case "checkbox":
      await page.setChecked(spec.selector, value !== "false" && value !== "0", {
        timeout: STEP_TIMEOUT_MS,
      });
      return;
    default:
      logger.warn({ key, kind: spec.kind }, "unhandled MakeEmoji control kind");
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Set every option the manifest knows how to drive. */
async function applyOptions(
  page: Page, manifest: Manifest, options: GenerateOptions,
): Promise<string[]> {
  const applied: string[] = [];

  const wanted: [OptionKey, string | undefined][] = [
    // Platform first: on most editors it is a preset that rewrites size and
    // format, so applying it later would silently undo explicit choices.
    ["platform", options.platform],
    ["animation", options.animation],
    ["speed", options.speed],
    ["direction", options.direction],
    ["size", options.size],
    ["color", options.color],
    ["format", options.format],
    ["quality", options.quality],
  ];

  for (const [key, raw] of wanted) {
    if (raw === undefined) continue;
    const spec = manifest.controls[key];
    if (!spec) continue;

    // Free-text controls (a colour hex, a numeric size) accept a value that was
    // never in an enumerated list, so fall back to the raw value for those.
    const resolved = resolveValue(manifest, key, raw)
      ?? (spec.kind === "text" || spec.kind === "range" ? raw : null);
    if (resolved === null) continue;

    try {
      await applyControl(page, key, spec, resolved);
      applied.push(`${key}=${resolved}`);
    } catch {
      // One control that has moved shouldn't sink the whole generation — the
      // rest of the settings still apply and the site's default covers this one.
      logger.warn({ key, selector: spec.selector }, "MakeEmoji control could not be set");
    }
  }

  return applied;
}

/** Read the current preview's bytes from inside the page. */
async function readPreviewBytes(page: Page, src: string): Promise<Buffer> {
  const base64 = await page.evaluate(async (url: string) => {
    const w = globalThis as unknown as BrowserWindow;
    const response = await w.fetch(url);
    const blob = await response.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new w.FileReader();
      reader.onloadend = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.onerror = () => reject(new Error("preview blob unreadable"));
      reader.readAsDataURL(blob);
    });
  }, src);
  return Buffer.from(base64, "base64");
}

/** The newest generated-looking media source in the page, if any. */
async function findPreviewSrc(
  page: Page,
  resultSelector: string | null,
  animation?: string,
): Promise<string | null> {
  return page.evaluate(({ selector, anim }) => {
    const w = globalThis as unknown as BrowserWindow;
    const nodes = Array.from(
      w.document.querySelectorAll(selector ?? "img, video, source") as ArrayLike<DomElement>,
    );
    const styleName = (anim ?? "")
      .replace(/^gen_btn_/i, "")
      .replace(/^:|:$/g, "")
      .toLowerCase();

    type Scored = { src: string; score: number };
    const scored: Scored[] = [];
    for (const el of nodes) {
      const src = (el as DomMedia).src || el.getAttribute("src") || "";
      if (!(
        src.startsWith("blob:") || src.startsWith("data:") ||
        /\.(gif|webp|png)(\?|$)/i.test(src)
      )) continue;
      const alt = (el.getAttribute("alt") || "").toLowerCase();
      let score = 0;
      if (/generated/.test(alt)) score += 2;
      if (src.startsWith("blob:")) score += 1;
      // Prefer the tile that matches the animation the user asked for
      // ("The generated party-parrot animated emoji").
      if (styleName && alt.includes(styleName)) score += 10;
      scored.push({ src, score });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored[scored.length - 1]?.src ?? null;
  }, { selector: resultSelector, anim: animation ?? null });
}

export async function generateViaBrowser(
  manifest: Manifest, options: GenerateOptions,
): Promise<GenerateResult> {
  const problem = browserPathProblem(manifest);
  if (problem) {
    logger.error({ problem }, "MakeEmoji browser path is not configured");
    throw new EmojiError("provider_unavailable", "The emoji generator isn't set up yet.");
  }

  const started = Date.now();
  const deadline = started + GENERATE_TIMEOUT_MS;
  const remaining = () => Math.max(1000, deadline - Date.now());

  const tempDir = mkdtempSync(join(tmpdir(), "makeemoji-"));

  try {
    return await withSharedBrowser(async (browser) => {
      let context: BrowserContext | undefined;
      try {
        context = await newContext(browser);
        const page = await context.newPage();
        page.setDefaultTimeout(STEP_TIMEOUT_MS);

        // Only recorded when explicitly asked for: the trace is large, and even
        // redacted it describes exactly what the bot sent.
        const recorder = options.debug ? recordNetwork(page) : null;

        await page.goto(manifest.siteUrl, { waitUntil: "domcontentloaded", timeout: remaining() });

        // Cookie banners and interstitials intercept the very clicks we need.
        for (const selector of manifest.browser.dismissSelectors) {
          await page.click(selector, { timeout: 3000 }).catch(() => {});
        }

        if (manifest.browser.readySelector) {
          // File inputs are routinely visually hidden (MakeEmoji uses `class="hidden"`),
          // so wait for attachment rather than visibility.
          await page.waitForSelector(manifest.browser.readySelector, {
            timeout: remaining(),
            state: "attached",
          }).catch(() => { throw new EmojiError("site_changed", "The emoji service looks different than expected."); });
        }

        const fileInput = manifest.browser.fileInputSelector!;
        await page.setInputFiles(fileInput, {
          name: "source.png", mimeType: "image/png", buffer: options.image,
        }).catch(() => {
          logger.error({ fileInput }, "MakeEmoji file input not found — manifest is stale");
          throw new EmojiError("site_changed", "The emoji service looks different than expected.");
        });

        // Live editors encode asynchronously after upload; give them a moment
        // before applying options so listboxes and style tiles are interactive.
        await page.waitForTimeout(1500);

        const applied = await applyOptions(page, manifest, options);
        logger.debug({ applied }, "MakeEmoji options applied");

        // Some editors render live on change and have no trigger at all; a missing
        // generate selector is therefore normal, not an error.
        if (manifest.browser.generateSelector) {
          await page.click(manifest.browser.generateSelector, { timeout: remaining() }).catch(() => {
            logger.warn({ selector: manifest.browser.generateSelector }, "MakeEmoji generate control not clickable");
          });
        }

        // After options change, MakeEmoji re-encodes client-side. Wait for a
        // generated preview that matches the requested animation before scraping.
        await page.waitForFunction(
          ({ anim, selector }: { anim: string | null; selector: string | null }) => {
            const w = globalThis as unknown as {
              document: {
                querySelectorAll(sel: string): ArrayLike<{
                  getAttribute(name: string): string | null;
                  src?: string;
                }>;
              };
            };
            const styleName = (anim ?? "")
              .replace(/^gen_btn_/i, "")
              .replace(/^:|:$/g, "")
              .toLowerCase();
            const nodes = Array.from(
              w.document.querySelectorAll(selector ?? 'img[alt*="generated" i], img, video'),
            );
            return nodes.some(el => {
              const alt = (el.getAttribute("alt") || "").toLowerCase();
              const src = el.src || el.getAttribute("src") || "";
              if (!(src.startsWith("blob:") || src.startsWith("data:"))) return false;
              if (!/generated/.test(alt)) return false;
              if (styleName && !alt.includes(styleName)) return false;
              return !/placeholder/i.test(alt);
            });
          },
          {
            anim: options.animation ?? null,
            selector: manifest.browser.resultSelector,
          },
          { timeout: Math.min(RESULT_TIMEOUT_MS, remaining()) },
        ).catch(() => {});
        await page.waitForTimeout(750);

        // ── retrieve the finished file ─────────────────────────────────────────
        let buffer: Buffer | null = null;
        let sourceUrl: string | undefined;

        if (manifest.browser.downloadSelector) {
          // A real download gives the exact bytes the site intends to hand over.
          const downloadPromise: Promise<Download> = page.waitForEvent("download", {
            timeout: Math.min(RESULT_TIMEOUT_MS, remaining()),
          });
          await page.click(manifest.browser.downloadSelector, { timeout: remaining() }).catch(() => {});
          const download = await downloadPromise.catch(() => null);
          if (download) {
            const path = join(tempDir, "result.bin");
            await download.saveAs(path);
            const { readFileSync } = await import("node:fs");
            buffer = readFileSync(path);
            sourceUrl = safeOrigin(download.url());
          }
        }

        if (!buffer) {
          // Fall back to the preview. Poll rather than wait once: generation
          // finishes asynchronously and the element may already exist but still be
          // showing the previous frame.
          const until = Math.min(Date.now() + RESULT_TIMEOUT_MS, deadline);
          const wantGif = !options.format || options.format === "gif";
          const wantWebp = options.format === "webp";
          while (Date.now() < until) {
            const src = await findPreviewSrc(
              page, manifest.browser.resultSelector, options.animation,
            );
            if (src) {
              const candidate = await readPreviewBytes(page, src).catch(() => null);
              if (candidate?.length) {
                const isGif = candidate.subarray(0, 3).toString("ascii") === "GIF";
                const isPng = candidate[0] === 0x89 && candidate[1] === 0x50;
                const isWebp = candidate.subarray(0, 4).toString("ascii") === "RIFF";
                // Skip placeholders that don't match the requested format while
                // MakeEmoji is still re-encoding after an option change.
                if (wantGif && isPng && !isGif) {
                  await page.waitForTimeout(750);
                  continue;
                }
                if (wantWebp && !isWebp) {
                  await page.waitForTimeout(750);
                  continue;
                }
                buffer = candidate;
                sourceUrl = src.startsWith("data:") || src.startsWith("blob:") ? undefined : src;
                break;
              }
            }
            await page.waitForTimeout(750);
          }
        }

        if (recorder) {
          recorder.stop();
          writeDebugTrace("generate", recorder.exchanges, recorder.websockets);
        }

        if (!buffer?.length) {
          logger.warn({ site: manifest.siteUrl }, "MakeEmoji produced no result");
          throw new EmojiError("generation_failed", "The emoji service didn't produce a file. Please try again.");
        }

        return {
          buffer,
          format: options.format,
          bytes: buffer.length,
          providerId: "makeemoji-browser",
          durationMs: Date.now() - started,
          ...(sourceUrl ? { sourceUrl } : {}),
          cached: false,
        };
      } finally {
        // Close the context only — the shared Chromium stays warm for the next job.
        await context?.close().catch(() => {});
      }
    });
  } catch (err) {
    if (err instanceof EmojiError) throw err;
    const message = (err as Error).message ?? "";
    if (/Timeout|timeout/.test(message)) {
      throw new EmojiError("timeout", "The emoji service took too long. Please try again.");
    }
    logger.error({ err: message.split("\n")[0] }, "MakeEmoji browser generation failed");
    throw new EmojiError("browser_failed", "The emoji generator hit a problem. Please try again.");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Origin + path only — download URLs routinely carry signed query parameters.
 *
 * A `blob:` URL parses oddly (its "pathname" is the whole inner URL) and names
 * nothing outside the page, so it is reported as absent rather than as a
 * mangled address.
 */
function safeOrigin(raw: string): string | undefined {
  if (raw.startsWith("blob:") || raw.startsWith("data:")) return undefined;
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}
