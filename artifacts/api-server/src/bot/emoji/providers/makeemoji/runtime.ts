// ─────────────────────────────────────────────────────────────────────────────
// Playwright runtime.
//
// Playwright is an OPTIONAL dependency: the bot must start and serve every other
// command on a host where it isn't installed, or where no Chromium binary
// exists. So it is never imported statically — this module loads it on demand
// and turns "not installed" into an ordinary unavailable-provider reason rather
// than a module-resolution crash at boot.
//
// Browser builds also drift: a Playwright upgrade expects a newer Chromium
// revision than the one already on the host, which is a confusing failure to
// debug from the raw error. `MAKEEMOJI_CHROMIUM_PATH` pins an existing binary.
//
// Memory: a fresh Chromium per /emoji generate is 150–400+ MB RSS. We keep a
// single shared browser, serialize browser-path jobs (concurrency 1), and idle-
// close after inactivity so a quiet host drops that footprint.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, LaunchOptions } from "playwright";
import { logger } from "../../../../lib/logger.js";
import { EmojiError } from "../../utils/errors.js";

/** Point at a Chromium binary already on the host. */
const ENV_EXECUTABLE = "MAKEEMOJI_CHROMIUM_PATH";
/** Set to "0"/"false" to watch the automation in a headed browser while debugging. */
const ENV_HEADLESS = "MAKEEMOJI_HEADLESS";
/** Idle ms before the shared Chromium is closed (default 3 minutes). */
const IDLE_CLOSE_MS = Math.max(
  30_000,
  Number(process.env["MAKEEMOJI_BROWSER_IDLE_MS"] ?? 180_000) || 180_000,
);

type PlaywrightModule = typeof import("playwright");

let cached: PlaywrightModule | null | undefined;

/** Load Playwright, or null when it isn't installed. */
export async function loadPlaywright(): Promise<PlaywrightModule | null> {
  if (cached !== undefined) return cached;
  try {
    cached = await import("playwright");
  } catch {
    cached = null;
  }
  return cached;
}

/** Why the browser stack can't run, or null when it can. */
export async function browserProblem(): Promise<string | null> {
  const pw = await loadPlaywright();
  if (!pw) {
    return "playwright is not installed — run `pnpm install` (it is an optional dependency)";
  }

  // The package alone is not enough. Reporting "available" on the strength of a
  // successful import meant status() claimed the generator was healthy while
  // every request failed at launch — and the admin endpoint agreed with it, so
  // the real cause never surfaced anywhere an operator would look.
  if (await resolveChromiumPath() === null) {
    const configured = process.env[ENV_EXECUTABLE]?.trim();
    return configured
      ? `no Chromium binary at ${ENV_EXECUTABLE}=${configured}`
      : "no Chromium browser is installed — run `pnpm emoji:install-browser` "
        + `(or set ${ENV_EXECUTABLE} to an existing binary)`;
  }

  return null;
}

export function launchOptions(): LaunchOptions {
  const executablePath = process.env[ENV_EXECUTABLE]?.trim();
  const headless = !/^(0|false|no)$/i.test(process.env[ENV_HEADLESS]?.trim() ?? "");

  return {
    headless,
    ...(executablePath ? { executablePath } : {}),
    args: [
      // Containers (Replit, Docker) usually lack the shared memory and user
      // namespaces Chromium's sandbox expects. Without these it fails to start
      // with an error that says nothing useful about the real cause.
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      // Cap Chromium extras — MakeEmoji is a short-lived page, not a desktop session.
      "--renderer-process-limit=1",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-translate",
      "--mute-audio",
      "--no-first-run",
      "--js-flags=--max-old-space-size=128",
    ],
  };
}

/** Directories Playwright installs browsers into, most specific first. */
function browserRoots(): string[] {
  const configured = process.env["PLAYWRIGHT_BROWSERS_PATH"]?.trim();
  const home = homedir();

  // Some hosts put the cache under the project rather than the user's home —
  // Replit installs to `<workspace>/.cache/ms-playwright` while `HOME` points
  // somewhere else entirely, so a home-only search finds nothing even though
  // the browser is right there. The bot may run from the repo root or from the
  // package directory, so walk up as well.
  const cwd = process.cwd();
  const projectRoots = [cwd, join(cwd, ".."), join(cwd, "..", ".."), join(cwd, "..", "..", "..")]
    .map(root => join(root, ".cache", "ms-playwright"));

  return [
    ...(configured ? [configured] : []),
    ...projectRoots,
    // Playwright's own defaults, per platform.
    join(home, ".cache", "ms-playwright"),
    join(home, "Library", "Caches", "ms-playwright"),
    join(home, "AppData", "Local", "ms-playwright"),
  ];
}

/** Executable locations inside one browser directory, per platform. */
const EXECUTABLE_PATHS = [
  "chrome-linux/chrome",
  "chrome-linux64/chrome",
  "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
  "chrome-win/chrome.exe",
  "chrome-linux/headless_shell",
  "chrome-headless-shell-linux64/chrome-headless-shell",
];

/**
 * Find an installed Chromium.
 *
 * Playwright pins an exact browser revision, so upgrading the package leaves it
 * looking for a build the host doesn't have — even though a usable Chromium is
 * sitting right beside it. Rather than fail with "Executable doesn't exist at
 * …/chromium-1234", find what IS installed and use that.
 *
 * Full `chromium-*` builds are preferred over `chromium_headless_shell-*`: the
 * shell cannot run headed, which `MAKEEMOJI_HEADLESS=0` needs for debugging.
 * Within each kind the highest build wins, compared NUMERICALLY — a
 * lexicographic sort ranks `chromium-999` above `chromium-1194`.
 */
function findInstalledChromium(): string | null {
  const buildNumber = (name: string) => Number(/-(\d+)$/.exec(name)?.[1] ?? 0);

  for (const root of browserRoots()) {
    if (!existsSync(root)) continue;

    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }

    const candidates = entries
      .filter(name => name.startsWith("chromium"))
      .sort((a, b) => {
        const aShell = a.startsWith("chromium_headless_shell");
        const bShell = b.startsWith("chromium_headless_shell");
        if (aShell !== bShell) return aShell ? 1 : -1;
        return buildNumber(b) - buildNumber(a);
      });

    for (const dir of candidates) {
      for (const relative of EXECUTABLE_PATHS) {
        const path = join(root, dir, relative);
        if (existsSync(path)) return path;
      }
    }
  }

  return null;
}

/**
 * The Chromium this host will actually launch, or null when there is none.
 *
 * Checked in order: an operator's explicit path, the revision Playwright itself
 * expects, then whatever is installed. Resolving up front — rather than
 * launching and handling the failure — is what lets `status()` tell the truth
 * about whether generation can work.
 */
export async function resolveChromiumPath(): Promise<string | null> {
  const configured = process.env[ENV_EXECUTABLE]?.trim();
  if (configured) return existsSync(configured) ? configured : null;

  // Prefer env/project-aware discovery so HOME, PLAYWRIGHT_BROWSERS_PATH, and
  // workspace `.cache/ms-playwright` win over Playwright's baked-in default
  // path (which ignores a HOME override and can hide a workspace-local build).
  const discovered = findInstalledChromium();
  if (discovered) return discovered;

  // When PLAYWRIGHT_BROWSERS_PATH is pinned, stay inside that tree — do not
  // fall back to Playwright's default home cache (breaks isolation and the
  // "missing browser" status check used by admin/health).
  if (process.env["PLAYWRIGHT_BROWSERS_PATH"]?.trim()) return null;

  const pw = await loadPlaywright();
  if (pw) {
    try {
      const expected = pw.chromium.executablePath();
      if (expected && existsSync(expected)) return expected;
    } catch { /* no browser registered for this build; fall through */ }
  }

  return null;
}

// ── Shared Chromium (singleton + serial lane) ────────────────────────────────

let sharedBrowser: Browser | null = null;
let launching: Promise<Browser> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/** Serialise browser-path generations so two Chromiums never stack. */
let browserLane: Promise<unknown> = Promise.resolve();

function bumpIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void closeSharedBrowser("idle");
  }, IDLE_CLOSE_MS);
  // Don't keep the event loop alive solely for the idle timer.
  idleTimer.unref?.();
}

/** Close the shared browser (best-effort). Safe to call when none is open. */
export async function closeSharedBrowser(reason = "manual"): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const browser = sharedBrowser;
  sharedBrowser = null;
  launching = null;
  if (!browser) return;
  try {
    await browser.close();
    logger.info({ reason }, "MakeEmoji shared Chromium closed");
  } catch (err) {
    logger.debug({ err, reason }, "MakeEmoji shared Chromium close failed");
  }
}

async function ensureSharedBrowser(): Promise<Browser> {
  if (sharedBrowser?.isConnected()) {
    bumpIdleClose();
    return sharedBrowser;
  }
  sharedBrowser = null;

  if (!launching) {
    launching = (async () => {
      const pw = await loadPlaywright();
      if (!pw) {
        logger.error("playwright is not installed; /emoji cannot generate");
        throw new EmojiError(
          "provider_unavailable",
          "The emoji generator isn't set up on this host right now.",
        );
      }

      const executablePath = await resolveChromiumPath();
      if (!executablePath) {
        logger.error(
          { fix: "pnpm emoji:install-browser", override: ENV_EXECUTABLE },
          "no Chromium browser is installed; /emoji cannot generate",
        );
        throw new EmojiError(
          "provider_unavailable",
          "The emoji generator isn't set up on this server yet. An admin needs to install its browser.",
        );
      }

      try {
        const browser = await pw.chromium.launch({ ...launchOptions(), executablePath });
        browser.on("disconnected", () => {
          if (sharedBrowser === browser) sharedBrowser = null;
        });
        sharedBrowser = browser;
        logger.info({ executablePath }, "MakeEmoji shared Chromium launched");
        bumpIdleClose();
        return browser;
      } catch (err) {
        logger.error(
          { err: (err as Error).message, executablePath },
          "chromium failed to launch",
        );
        throw new EmojiError(
          "browser_failed",
          "The emoji generator's browser wouldn't start. This is usually temporary — try again in a moment.",
        );
      } finally {
        launching = null;
      }
    })();
  }

  return launching;
}

/**
 * Launch (or reuse) the shared Chromium.
 *
 * Prefer `withSharedBrowser` from generation code so jobs stay serialised.
 * Callers that only need a Browser handle (tests / discovery) can use this;
 * they must NOT call `browser.close()` — use `closeSharedBrowser` instead.
 */
export async function launchBrowser(): Promise<Browser> {
  return ensureSharedBrowser();
}

/**
 * Run `fn` with exclusive access to a fresh BrowserContext on the shared
 * Chromium. Contexts are always closed; the browser stays warm for the next job.
 */
export async function withSharedBrowser<T>(
  fn: (browser: Browser) => Promise<T>,
): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const prev = browserLane;
  browserLane = prev.then(() => gate).catch(() => gate);
  await prev.catch(() => {});
  try {
    const browser = await ensureSharedBrowser();
    bumpIdleClose();
    return await fn(browser);
  } finally {
    bumpIdleClose();
    release();
  }
}

/**
 * Shim for esbuild's `keepNames` helper.
 *
 * `page.evaluate` works by stringifying our function and running the source in
 * the browser. Both tsx (dev/CLI) and esbuild (the bot bundle) rewrite nested
 * functions to call a `__name` helper they emit alongside — but only the
 * function body crosses into the page, not the helper, so every evaluate throws
 * `ReferenceError: __name is not defined` there.
 *
 * Defining a no-op `__name` in the page before any script runs makes the
 * rewritten code work unchanged. This is not a test-only concern: it is exactly
 * how the browser provider fails in production, and the failure never appears
 * under vitest because its transform does not rewrite names.
 */
const KEEP_NAMES_SHIM = `
  if (typeof globalThis.__name !== "function") {
    Object.defineProperty(globalThis, "__name", {
      value: (fn) => fn, writable: true, configurable: true,
    });
  }
`;

/**
 * A context that looks like an ordinary desktop browser.
 *
 * Not to evade anything — MakeEmoji's editor is a normal public page — but
 * because a default automation context has no viewport size or user-agent that
 * a responsive layout expects, and can render a mobile variant with entirely
 * different controls than the ones discovery recorded.
 */
export async function newContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    acceptDownloads: true,
  });
  // Runs before any page script, on every document in this context.
  await context.addInitScript(KEEP_NAMES_SHIM);
  return context;
}
