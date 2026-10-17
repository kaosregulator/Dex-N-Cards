// ─────────────────────────────────────────────────────────────────────────────
// HQ — asset manager.
//
// The ONLY bridge between the HQ renderer and any bundled/uploaded art. The
// renderer never reads files or knows about themes' art directly; it asks
// `spriteFor(theme, key)` and, if it gets a path back, blits it — otherwise it
// draws the element procedurally. That single seam is what lets a future theme
// pack (Military, Anime, Fantasy, …) replace the procedural look with zero code
// changes, and it means Phase 1 ships with no art at all.
//
// Directory resolution tries the source tree and cwd (assets ship from the
// repo tree, not the esbuild bundle, so cwd-relative fallbacks carry production).
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HqTheme } from "./defs/themes.js";
import { logger } from "../../lib/logger.js";

// manifest.json (when present) enumerates which sprite keys have art, so the
// renderer can decide procedural-vs-art without a filesystem stat per element.
interface HqManifest {
  // Map of "<themePrefix>/<key>" (and bare "<key>") → relative PNG file name.
  sprites?: Record<string, string>;
}

function resolveHqDir(): string | null {
  // An explicit override wins outright, so a deployment can mount an uploaded
  // art pack outside the repo tree without a rebuild — even when the bundled
  // pack is also present.
  const override = process.env["HQ_ASSETS_DIR"];
  if (override && existsSync(override)) return override;

  const candidates: string[] = [];
  // The module-relative path is best in dev/prod ESM, but a non-file import URL
  // (e.g. a CJS/test bundle where import.meta.url is unset) makes new URL()/
  // fileURLToPath throw — never let that crash the whole render; just fall
  // through to the cwd-relative candidates below.
  try {
    candidates.push(fileURLToPath(new URL("../../../assets/hq/", import.meta.url)));
  } catch { /* import.meta.url unusable here — use cwd fallbacks */ }
  candidates.push(join(process.cwd(), "assets/hq"));
  candidates.push(join(process.cwd(), "artifacts/api-server/assets/hq"));
  for (const dir of candidates) {
    if (existsSync(join(dir, "manifest.json"))) return dir;
  }
  // A directory with art but no manifest is still usable — the by-convention
  // lookup below finds "<prefix>/<key>.png" on its own. This is what makes
  // "drop your PNGs in and restart" work with no JSON editing.
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

let _dir: string | null | undefined;
let _manifest: HqManifest | null | undefined;

function assetDir(): string | null {
  if (_dir === undefined) _dir = resolveHqDir();
  return _dir;
}

/**
 * Absolute path of the resolved HQ art-pack directory (the folder holding
 * manifest.json + the category subdirs), or null if no pack is present. Exposed
 * so the Activity's HTTP layer can serve the SAME art the server-side renderer
 * uses — one pack, two consumers.
 */
export function hqAssetsRoot(): string | null {
  return assetDir();
}

function manifest(): { dir: string; manifest: HqManifest } | null {
  const dir = assetDir();
  if (!dir) return null;
  if (_manifest === undefined) {
    try {
      _manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as HqManifest;
    } catch (err) {
      logger.debug({ err }, "hq-assets: no readable manifest (falling back to by-convention paths)");
      _manifest = null;
    }
  }
  return _manifest ? { dir, manifest: _manifest } : null;
}

/** True when an HQ asset pack is available (gates any "art available" UI/feature). */
export function hqAssetsAvailable(): boolean {
  return assetDir() !== null;
}

// Image extensions tried when resolving a key by convention, best first.
const ART_EXTENSIONS = [".png", ".webp", ".jpg", ".jpeg"];

// Resolve a sprite by an explicit asset-pack prefix. Returns an absolute file
// path or null. This is the single lookup every visual goes through — walls,
// floors, wallpapers, build materials and furniture each pass their own
// registry prefix, so an uploaded pack replaces any of them independently with
// no code change. Nothing found → null → the renderer draws it procedurally.
//
// Two resolution strategies, in order:
//   1. manifest.json, which can map a key to any relative path;
//   2. BY CONVENTION — "<dir>/<prefix>/<key>.<ext>" then "<dir>/<key>.<ext>".
// The second is what lets someone drop `surface/pond.png` (or a whole folder of
// 2D-iso art) into the pack and have it picked up on the next restart without
// touching any JSON.
export function spriteForPrefix(prefix: string, key: string): string | null {
  const dir = assetDir();
  if (!dir) return null;

  const m = manifest();
  if (m) {
    const sprites = m.manifest.sprites ?? {};
    const rel = sprites[`${prefix}/${key}`] ?? sprites[key];
    if (rel) {
      const path = join(dir, rel);
      if (existsSync(path)) return path;
    }
  }

  const cacheKey = `${prefix}/${key}`;
  const cached = _pathCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let found: string | null = null;
  for (const stem of [join(dir, prefix, key), join(dir, key)]) {
    for (const ext of ART_EXTENSIONS) {
      if (existsSync(stem + ext)) { found = stem + ext; break; }
    }
    if (found) break;
  }
  _pathCache.set(cacheKey, found);
  return found;
}

// Convention lookups hit the filesystem, and a render asks for dozens of keys
// per frame — remember the answer (including "not found") for the process.
const _pathCache = new Map<string, string | null>();

// Resolve a sprite for a theme (decoration art keyed by the theme prefix).
export function spriteFor(theme: HqTheme, key: string): string | null {
  return spriteForPrefix(theme.spritePrefix, key);
}

// Decoded-image cache shared across renders (a busy channel re-renders the same
// theme repeatedly). Keyed by absolute path; promise-cached so concurrent
// renders share one decode.
type LoadedImage = import("@napi-rs/canvas").Image;
const spriteCache = new Map<string, Promise<LoadedImage | null>>();
const SPRITE_CACHE_MAX = 128;

export function loadSprite(
  mod: typeof import("@napi-rs/canvas"), path: string,
): Promise<LoadedImage | null> {
  const cached = spriteCache.get(path);
  if (cached) return cached;
  const p = (async (): Promise<LoadedImage | null> => {
    try {
      return await mod.loadImage(readFileSync(path));
    } catch (err) {
      logger.debug({ err, path }, "hq-assets: failed to decode sprite");
      return null;
    }
  })();
  spriteCache.set(path, p);
  if (spriteCache.size > SPRITE_CACHE_MAX) {
    const oldest = spriteCache.keys().next().value;
    if (oldest !== undefined) spriteCache.delete(oldest);
  }
  return p;
}
