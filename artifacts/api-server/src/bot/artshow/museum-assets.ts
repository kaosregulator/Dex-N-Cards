/**
 * Local public-domain / CC0 museum assets for the Hall of Fame canvas.
 * Paths resolve relative to the api-server package (same pattern as fonts).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { seededRng } from "../animations/particles.js";

export type WingCode = "RU" | "UK" | "US" | "ES" | "CN" | "JP" | "FR" | "BR";

export type WingDef = {
  code: WingCode;
  label: string;
  /** Asset filenames under assets/artshow/art/ */
  files: string[];
};

export const WORLD_WINGS: WingDef[] = [
  { code: "RU", label: "Russia", files: ["ru-cle.jpg"] },
  {
    code: "UK",
    label: "United Kingdom",
    files: ["uk-turner.jpg", "uk-turner-cle.jpg", "uk-constable.jpg"],
  },
  {
    code: "US",
    label: "United States",
    files: ["us-bierstadt.jpg", "us-church.jpg", "us-sargent.jpg"],
  },
  {
    code: "ES",
    label: "Spain",
    files: ["es-velazquez.jpg", "es-goya-cle.jpg", "es-elgreco.jpg"],
  },
  { code: "CN", label: "China", files: ["cn-cle.jpg", "cn-scroll2.jpg"] },
  {
    code: "JP",
    label: "Japan",
    files: ["jp-great-wave.jpg", "jp-hokusai-cle.jpg", "jp-hiroshige-cle.jpg"],
  },
  {
    code: "FR",
    label: "France",
    files: ["fr-monet-cle.jpg", "fr-socrates.jpg", "nl-wheat.jpg", "nl-irises.jpg", "nl-cypresses.jpg"],
  },
  { code: "BR", label: "Brazil", files: ["br-cle.jpg"] },
];

export const STATUE_FILES = [
  "thinker.jpg",
  "apollo.jpg",
  "roman.jpg",
  "david.jpg",
  "classical.jpg",
] as const;

export const HALL_FILES = ["salon-teal.jpg", "skylight-gallery.jpg"] as const;

function resolveArtshowRoot(): string {
  const candidates = [
    fileURLToPath(new URL("../../../assets/artshow/", import.meta.url)),
    join(process.cwd(), "assets/artshow"),
    join(process.cwd(), "artifacts/api-server/assets/artshow"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "halls"))) return dir;
  }
  return candidates[0]!;
}

const ROOT = resolveArtshowRoot();

export function artPath(file: string): string {
  return join(ROOT, "art", file);
}

export function statuePath(file: string): string {
  return join(ROOT, "statues", file);
}

export function hallPath(file: string): string {
  return join(ROOT, "halls", file);
}

/** Pick a hall background — deterministic per seed so GIF frames stay stable. */
export function pickHall(seed: string): string {
  const rng = seededRng(`${seed}-hall`);
  const idx = Math.floor(rng.range(0, HALL_FILES.length));
  return hallPath(HALL_FILES[idx]!);
}

/** Shuffle wing order + pick one artwork file per wing (stable for a seed). */
export function pickWingArt(seed: string): { wing: WingDef; file: string; abs: string }[] {
  const rng = seededRng(`${seed}-wings`);
  const order = [...WORLD_WINGS];
  // Fisher–Yates
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng.range(0, i + 1));
    const tmp = order[i]!;
    order[i] = order[j]!;
    order[j] = tmp;
  }
  return order.map((wing) => {
    const available = wing.files.filter((f) => existsSync(artPath(f)));
    const pool = available.length ? available : wing.files;
    const file = pool[Math.floor(rng.range(0, pool.length))]!;
    return { wing, file, abs: artPath(file) };
  });
}

/** Pick two statues for left/right pedestals. */
export function pickStatues(seed: string): { left: string; right: string } {
  const rng = seededRng(`${seed}-statues`);
  const available = STATUE_FILES.filter((f) => existsSync(statuePath(f)));
  const pool = available.length ? [...available] : [...STATUE_FILES];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng.range(0, i + 1));
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
  }
  return {
    left: statuePath(pool[0]!),
    right: statuePath(pool[1] ?? pool[0]!),
  };
}
