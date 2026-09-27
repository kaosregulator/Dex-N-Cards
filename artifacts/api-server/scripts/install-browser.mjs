#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Install the Chromium /emoji drives, at dependency-install time.
//
// This exists because of a real production failure. `playwright install` had
// been run by hand in the Replit workspace, but deployments BUILD IN A FRESH
// CONTAINER — so the deployed bot had the playwright package and no browser,
// and /emoji failed at provider selection before it ever tried to launch:
//
//   no emoji provider is available
//   reasons: ["makeemoji: no Chromium browser is installed — …"]
//
// Running as a postinstall means the browser lands wherever dependencies do, in
// every environment that installs them, including the deployment container.
//
// It must NEVER fail an install. A missing browser degrades one command; a
// failed postinstall breaks the whole bot. Every problem here is a warning and
// an exit code of 0.
// ─────────────────────────────────────────────────────────────────────────────

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Set to skip entirely — CI images that ship their own browser, for example. */
const SKIP = process.env["SKIP_PLAYWRIGHT_INSTALL"];

function log(message) {
  console.log(`[emoji] ${message}`);
}

if (/^(1|true|yes)$/i.test(SKIP ?? "")) {
  log("SKIP_PLAYWRIGHT_INSTALL set — not installing Chromium.");
  process.exit(0);
}

// playwright is an optional dependency: on a host where it did not install,
// there is nothing to do and nothing is wrong.
let playwright;
try {
  playwright = require("playwright");
} catch {
  log("playwright is not installed — skipping the browser download.");
  process.exit(0);
}

/**
 * Is a usable Chromium already here?
 *
 * This mirrors the runtime's own search (providers/makeemoji/runtime.ts) rather
 * than trusting `executablePath()` alone. Playwright pins an exact revision, so
 * after a package bump that call names a build the host does not have — while a
 * perfectly usable Chromium sits beside it. Downloading another copy in that
 * case wastes a few hundred megabytes on every install for no benefit.
 */
function findExistingChromium() {
  const { existsSync, readdirSync } = require("node:fs");
  const { homedir } = require("node:os");
  const { join } = require("node:path");

  try {
    const expected = playwright.chromium.executablePath();
    if (expected && existsSync(expected)) return expected;
  } catch {
    // No browser registered for this build — keep looking.
  }

  const home = homedir();
  const cwd = process.cwd();
  const roots = [
    process.env["PLAYWRIGHT_BROWSERS_PATH"],
    join(cwd, ".cache", "ms-playwright"),
    join(cwd, "..", ".cache", "ms-playwright"),
    join(cwd, "..", "..", ".cache", "ms-playwright"),
    join(home, ".cache", "ms-playwright"),
    join(home, "Library", "Caches", "ms-playwright"),
    join(home, "AppData", "Local", "ms-playwright"),
  ].filter(Boolean);

  const executables = [
    "chrome-linux/chrome", "chrome-linux64/chrome",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-win/chrome.exe",
    "chrome-linux/headless_shell", "chrome-headless-shell-linux64/chrome-headless-shell",
  ];

  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries = [];
    try {
      entries = readdirSync(root).filter(name => name.startsWith("chromium"));
    } catch {
      continue;
    }
    for (const dir of entries) {
      for (const relative of executables) {
        const path = join(root, dir, relative);
        if (existsSync(path)) return path;
      }
    }
  }

  return null;
}

function verifyChromiumLaunch(chromePath) {
  const { spawnSync: run } = require("node:child_process");
  const ldd = run("ldd", [chromePath], { encoding: "utf8" });
  const missing = (ldd.stdout || "")
    .split("\n")
    .filter((line) => /not found/i.test(line))
    .map((line) => line.trim());
  if (missing.length) {
    log(`WARNING: Chromium is missing shared libraries (${missing.length}):`);
    for (const line of missing.slice(0, 12)) log(`  ${line}`);
    log(
      "Fix: ensure nixpacks.toml aptPkgs includes Playwright Chromium deps " +
      "(libgbm1, libnss3, …) and redeploy so Railway rebuilds the image.",
    );
    return;
  }
  const probe = run(
    chromePath,
    ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--dump-dom", "about:blank"],
    { encoding: "utf8", timeout: 20_000, env: { ...process.env, HOME: process.env.HOME || "/tmp" } },
  );
  if (probe.status === 0) {
    log("Chromium smoke launch OK.");
  } else {
    const errText = `${probe.stderr || ""}\n${probe.stdout || ""}`.trim().slice(0, 400);
    log(`WARNING: Chromium smoke launch failed (exit ${probe.status}). ${errText}`);
  }
}

const existing = findExistingChromium();
if (existing) {
  log(`Chromium is already installed (${existing}).`);
  verifyChromiumLaunch(existing);
  process.exit(0);
}

log("installing Chromium for /emoji + vault Browse (this is a one-off download)…");

/**
 * Locate playwright's CLI.
 *
 * Its `bin` is `cli.js` at the package root, but that path is not listed in the
 * package's `exports`, so `require.resolve("playwright/cli.js")` throws. Resolve
 * the package entry point instead and walk to the root beside it.
 */
function resolveCli() {
  const { dirname, join } = require("node:path");
  const { existsSync } = require("node:fs");
  try {
    const root = dirname(require.resolve("playwright"));
    const cli = join(root, "cli.js");
    return existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

const cli = resolveCli();
const result = cli
  ? spawnSync(process.execPath, [cli, "install", "chromium"], {
      stdio: "inherit", env: process.env,
    })
  // Fall back to the package manager's resolution when the layout is unfamiliar.
  : spawnSync("npx", ["--yes", "playwright", "install", "chromium"], {
      stdio: "inherit", env: process.env, shell: process.platform === "win32",
    });

if (result.status !== 0) {
  // Deliberately exit 0: /emoji + Browse degrade; the rest of the bot still boots.
  log(
    "could not install Chromium automatically. /emoji and /vaultvalue Browse will stay " +
    "unavailable until `pnpm emoji:install-browser` is run on this host.",
  );
  if (result.error) log(`reason: ${result.error.message}`);
  process.exit(0);
}

log("Chromium installed.");
const chrome = findExistingChromium();
if (chrome) verifyChromiumLaunch(chrome);
process.exit(0);
