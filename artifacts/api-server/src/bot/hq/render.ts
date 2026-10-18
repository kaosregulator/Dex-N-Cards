// ─────────────────────────────────────────────────────────────────────────────
// HQ renderer — composites a player's Headquarters to a PNG as an ISOMETRIC room.
//
// Built as a "stack of pure layer functions" (the doctrine from
// battle/image/render.ts and raid/canvas.ts): renderHq only iterates the layers.
// Phase 3 replaced the flat back-wall look with a true isometric room — two
// corner walls, a diamond floor grid, and furniture placed on floor tiles / wall
// faces with depth-sorted draw order. Everything is still drawn PROCEDURALLY so
// the feature ships with zero art, and every visual first asks the asset manager
// (spriteForPrefix); a bundled/uploaded PNG transparently replaces the
// procedural drawing — walls, floor and furniture each swap independently.
//
// This renderer is a LEAF: it does its own createCanvas + encode and is queued
// once, so it must never call another queued renderer (deadlock rule in
// render-queue.ts). The hub builds the HqRenderView (resolving card art URLs,
// rarity via getCardDisplayRarity, and any sprite paths); this file never
// touches the DB.
// ─────────────────────────────────────────────────────────────────────────────

import {
  getCanvas, roundRectPath, hexToRgba, encodeAnimation,
  type Ctx, type CanvasMod,
} from "../animations/engine.js";
import {
  drawCardArt, drawCardFrame, drawRarityGlow,
  drawTextWithShadow, drawTitle, fitText, TITLE_FONT,
} from "../animations/effects.js";
import { type ProgTier } from "../animations/card-frames.js";
import type { Rarity } from "../cards-data.js";
import { drawAtmosphere, atmospherePreset } from "../animations/atmosphere.js";
import { queueRender } from "../animations/render-queue.js";
import { loadSprite, spriteForPrefix } from "./assets.js";
import {
  ellipse, blit, blitClippedQuad, polyPath, diamond, seededRng, hashString, stripEmoji,
  drawIslandTier, drawPine, drawHqHeader, HQ_HEADER_H,
  type Pt, type HqHeaderInfo,
} from "./paint.js";
import {
  paintTerrain, paintCursor, paintGridGuides,
  type HqTerrainFeature, type IsoProjector,
} from "./render-terrain.js";
import { paintVoid, paintOpenAtmosphere } from "./render-atmosphere.js";
import { paintOutdoorMiniverse, drawOutdoorVisitors, OUTDOOR } from "./render-outdoor.js";
import { drawWallpaperFace } from "./render-wallpaper.js";
import { drawProp, propKindFor, type PropKind } from "./props.js";
import { spriteForProp } from "./prop-sprites.js";
import type { HqWallpaper } from "./defs/wallpapers.js";
import type { HqTheme } from "./defs/themes.js";
import type { HqWall } from "./defs/walls.js";
import type { HqFloor } from "./defs/floors.js";
import type { DecoCategory } from "./defs/decorations.js";
import type { CompanionKind } from "./defs/companions.js";
import type { HqSkybox } from "./defs/skyboxes.js";
import { HQ_GRID, HQ_BASE_GRID } from "./grid.js";
import { blueprintAsDecos } from "./defs/room-blueprints.js";

export type { HqHeaderInfo };

const W = 1120, H = 680;
const HEADER_H = HQ_HEADER_H;

// ── Isometric projection ───────────────────────────────────────────────────────
// A GRID×GRID floor. project() maps a lattice point (gx,gy) to screen space; a
// floor tile (i,j) is the diamond between (i,j),(i+1,j),(i+1,j+1),(i,j+1).
// The room is deliberately large (an 8×8 hall) so it reads like a proper
// decoratable space — a "mini-Sims" room, not a diorama.
const GRID = HQ_GRID;
const TILE_W = 116, TILE_H = 58;   // full diamond width/height (2:1 iso)
const ORIGIN_X = W / 2, ORIGIN_Y = 176; // screen position of lattice corner (0,0)
const WALL_H = 200;

function project(gx: number, gy: number): Pt {
  return {
    x: ORIGIN_X + (gx - gy) * (TILE_W / 2),
    y: ORIGIN_Y + (gx + gy) * (TILE_H / 2),
  };
}
function lerp(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

// The interior room's projector, handed to the terrain painter so build-mode
// surfaces land on exactly the same lattice as decorations.
const ROOM_PROJECTOR: IsoProjector = { project, grid: GRID, tileW: TILE_W, tileH: TILE_H };
export const HQ_ROOM_PROJECTOR = ROOM_PROJECTOR;

// ── View contract (built by the hub) ───────────────────────────────────────────
export interface HqRenderCard {
  cardId: number;
  name: string;
  artUrl: string | null;
  rarityLabel: string;
  rarityColor: number;
  rarity?: Rarity;
  progTier?: ProgTier | null;
}

export interface HqRenderDeco {
  slot: number;
  category: DecoCategory;
  name: string;
  rarityColor: number;
  spritePath: string | null;
  // Card wall-art: when set, this decoration is a framed portrait of a real card
  // (its art, shrunk into a hanging frame on the wall). rarityColor tints the frame.
  cardArtUrl?: string | null;
  /** Optional explicit prop kind (blueprints / furniture). */
  propKind?: PropKind;
  scale?: number;
  seed?: number;
  /** Blueprint props are virtual — not player-owned placements. */
  fromBlueprint?: boolean;
}

// An earned companion (pet) standing in the scene — drawn procedurally by `kind`.
export interface HqRenderCompanion {
  kind: CompanionKind;
  name: string;
  body: string;    // hex colour string
  accent: string;
}

// A card assigned to defend the base — rendered as an upright "standee" figure
// (the card art) standing on an isometric base, like tabletop miniatures.
export interface HqRenderDefender {
  slot: number;
  cardId: number;
  name: string;
  artUrl: string | null;
  rarityColor: number;
  rarity?: Rarity;
  progTier?: ProgTier | null;
  basePath: string | null; // base sprite (CC0); procedural disc when null
}

// A highlighted build cursor drawn over the floor: the rectangle the next
// place/remove will affect, plus a label so the player can read the coordinates
// straight off the image instead of guessing at slot numbers.
export interface HqBuildCursor {
  x: number; y: number; w: number; h: number;
  color: number;
  label: string;
  valid: boolean;
}

export interface HqRenderView extends HqHeaderInfo {
  ownerName: string;
  wall: HqWall;     // wall style (faces, trim, windows)
  floor: HqFloor;   // floor style (tiles, grout)
  // Optional art (resolved by the hub via spriteForPrefix). When present these
  // replace the procedural wall faces / floor tiles; otherwise procedural.
  wallSprite?: string | null;
  floorSprite?: string | null;
  backdropSprite?: string | null;     // scene behind the room (sky/landscape)
  // A real repeating wallpaper painted onto the wall faces in iso perspective.
  // Takes priority over wallSprite; null keeps the wall style's own look.
  wallpaper?: HqWallpaper | null;
  wallsOff?: boolean;                 // "outside" — open the walls
  glassOff?: boolean;                 // hide the glass display cases
  pedestals: (HqRenderCard | null)[]; // length = room.pedestals
  decorations: HqRenderDeco[];        // placed decorations (with slot index)
  terrain?: HqTerrainFeature[];       // build-mode surfaces, water & raised platforms
  cursor?: HqBuildCursor | null;      // build-mode selection overlay
  defenders?: HqRenderDefender[];     // cards set to defend the base (figures on bases)
  companion?: HqRenderCompanion | null; // active pet standing in the room
  visitors?: number;                  // ambient NPC guests (0-4), derived from prestige
  /** Optional open atmosphere beyond the room (does NOT replace architectural walls). */
  skybox?: HqSkybox | null;
  /** Active room id — used to merge furnished blueprints when placements are sparse. */
  roomId?: string;
}

// ── Exterior "town base" view ──────────────────────────────────────────────────
// A SEPARATE outdoor scene (castles/buildings) — the attackable/defendable town,
// not the interior showcase room. Buildings are placed by ROLE; each resolves art
// via spriteForPrefix("building", role) with a procedural fallback. Defenders
// stand out front as standees (reusing drawDefender), and the whole scene is
// depth-sorted by screen-y.
export type HqBuildingRole =
  | "castle" | "keep" | "tower" | "wall" | "cathedral" | "houses" | "village" | "camp" | "hut";

export interface HqBaseBuilding {
  role: HqBuildingRole;
  spritePath: string | null; // spriteForPrefix("building", role); null → procedural
}

export interface HqBaseView extends HqHeaderInfo {
  ownerName: string;
  buildings: HqBaseBuilding[];    // which structures the town has
  defenders: HqRenderDefender[];  // stationed cards, rendered as standees
  decorations?: HqRenderDeco[];   // player-placed grounds decorations (trees, items…)
  terrain?: HqTerrainFeature[];   // build-mode ponds, hills & paved surfaces
  cursor?: HqBuildCursor | null;  // build-mode selection overlay — ALSO enables grid guides
  /** Show edit grid. Defaults to true when cursor is set; false on overview. */
  showGrid?: boolean;
  captured?: boolean;             // show a captured/held banner (red)
  bannerColor?: number;           // override the castle banner colour (faction/holder)
  companion?: HqRenderCompanion | null; // active pet roaming the grounds
  visitors?: number;              // ambient NPC guests (0-4), derived from prestige
  /** Optional open atmosphere beyond the grounds (not architectural walls). */
  skybox?: HqSkybox | null;
  /** Soft blue shield around the castle (outdoor). */
  shieldActive?: boolean;
  /** Optional pulse 0..1 for animated shield aura frames. */
  shieldPulse?: number;
  /**
   * Outdoor only: when true, skip the two giant diorama sky-walls and leave a
   * dark void behind the grassy platform (mockup "walls off" look).
   */
  giantWallsOff?: boolean;
  /** Outdoor only: bare platform (no castle / nature) for starter previews. */
  emptyPlatform?: boolean;
}

// Placement encoding (stored in hq_placements.slot, so no schema change):
//   • floor tile (gx,gy) → slot = gy*GRID + gx   (0 … GRID²-1)
//   • wall anchor i       → slot = WALL_SLOT_BASE + i
// The renderer decodes the slot back to a screen position; the hub builds the
// same encoding when the player picks a tile/wall spot.
export { HQ_GRID, HQ_BASE_GRID };
export const HQ_WALL_SLOT_BASE = 100;
// Wall-art anchors are DERIVED from the two wall faces so they scale with the
// room. Each face gets evenly-spaced spots at ~55% up the wall — a big room means
// plenty of wall space for framed cards, banners and medals. Right face runs
// project(0,GRID)→project(0,0); left face project(0,0)→project(GRID,0).
const WALL_ANCHORS: { x: number; y: number; scale: number }[] = (() => {
  const out: { x: number; y: number; scale: number }[] = [];
  const lift = WALL_H * 0.66;   // high on the wall, clear of the pedestal row
  const rA = { x: ORIGIN_X + (0 - GRID) * (TILE_W / 2), y: ORIGIN_Y + (0 + GRID) * (TILE_H / 2) };
  const rB = { x: ORIGIN_X, y: ORIGIN_Y };                                   // project(0,0) = back corner
  const lB = { x: ORIGIN_X + GRID * (TILE_W / 2), y: ORIGIN_Y + GRID * (TILE_H / 2) };
  const at = (a: { x: number; y: number }, b: { x: number; y: number }, u: number, scale: number) =>
    ({ x: a.x + (b.x - a.x) * u, y: (a.y + (b.y - a.y) * u) - lift, scale });
  // Keep art on the SIDE portions of each wall, away from the back corner (where
  // the pedestals sit). Right face runs far-left→corner, so use small u; left
  // face runs corner→far-right, so use large u.
  for (const u of [0.12, 0.26, 0.40]) out.push(at(rA, rB, u, 0.92));  // right wall
  for (const u of [0.60, 0.74, 0.88]) out.push(at(rB, lB, u, 0.92));  // left wall
  return out;
})();
export const HQ_WALL_ANCHOR_COUNT = WALL_ANCHORS.length;
export function floorSlot(gx: number, gy: number): number { return gy * GRID + gx; }
export function wallSlot(i: number): number { return HQ_WALL_SLOT_BASE + i; }
export function slotIsWall(slot: number): boolean { return slot >= HQ_WALL_SLOT_BASE; }
export function slotToTile(slot: number): { gx: number; gy: number } {
  return { gx: slot % GRID, gy: Math.floor(slot / GRID) % GRID };
}

// Dev/preview utility — lay out companions on a labelled grid so their procedural
// silhouettes can be eyeballed at a glance (not used by the hub).
export async function renderCompanionSheet(
  comps: { name: string; kind: CompanionKind; body: string; accent: string }[],
): Promise<Buffer | null> {
  return queueRender("hq-sheet", async () => {
    const mod = await getCanvas();
    if (!mod) return null;
    try {
      const cols = 4, cellW = 220, cellH = 200, pad = 20;
      const rows = Math.ceil(comps.length / cols);
      const cw = cols * cellW + pad * 2, ch = rows * cellH + pad * 2 + 40;
      const canvas = mod.createCanvas(cw, ch);
      const ctx = canvas.getContext("2d") as unknown as Ctx;
      const bg = ctx.createLinearGradient(0, 0, 0, ch);
      bg.addColorStop(0, "#1b2030"); bg.addColorStop(1, "#0d1017");
      ctx.fillStyle = bg; ctx.fillRect(0, 0, cw, ch);
      drawTitle(ctx, "HQ Companions", cw / 2 - 90, 30, "#e8ecf5", 26);
      for (let i = 0; i < comps.length; i++) {
        const c = comps[i]!;
        const gx = i % cols, gy = Math.floor(i / cols);
        const x = pad + gx * cellW, y = 44 + pad + gy * cellH;
        ctx.fillStyle = "rgba(255,255,255,0.04)"; roundRectPath(ctx, x + 6, y + 6, cellW - 12, cellH - 12, 14); ctx.fill();
        const feetY = y + cellH - 46;
        drawCompanion(ctx, x + cellW / 2, feetY, c, 1.25);
        ctx.textAlign = "center";
        drawTitle(ctx, c.name, x + cellW / 2, y + cellH - 22, "#ffffff", 16);
        ctx.textAlign = "left";
      }
      return await canvas.encode("png");
    } catch { return null; }
  });
}

// Where defenders stand — a front arc facing the viewer, centre outwards.
const DEFENDER_TILES: { gx: number; gy: number }[] = [
  { gx: 3.0, gy: 3.0 }, { gx: 1.7, gy: 4.0 }, { gx: 4.3, gy: 1.7 },
  { gx: 4.6, gy: 3.4 }, { gx: 1.7, gy: 1.7 },
];
export const HQ_DEFENDER_SLOTS = DEFENDER_TILES.length;

export async function renderHq(view: HqRenderView): Promise<Buffer | null> {
  return queueRender("hq", async () => {
    const mod = await getCanvas();
    if (!mod) return null;
    try {
      const canvas = mod.createCanvas(W, H);
      const ctx = canvas.getContext("2d") as unknown as Ctx;

      // Rooms sit in a dark void — architectural walls are the room shell.
      // (Giant diorama sky-walls are outdoor-only.)
      paintVoid(ctx, W, H);
      if (view.wallsOff) {
        // "Outside peek" through open room walls — soft atmosphere only.
        await paintOpenAtmosphere(ctx, mod, view.skybox ?? null, {
          w: W, h: H, focusX: ORIGIN_X, focusY: ORIGIN_Y + GRID * (TILE_H / 2), radius: 300,
        });
        await layerSceneryBackdrop(ctx, mod, view.backdropSprite ?? null);
      }
      if (!view.wallsOff) {
        await layerWalls(ctx, mod, view.wall, view.wallSprite ?? null, view.wallpaper ?? null);
        await layerWallDecorations(ctx, mod, { ...view, decorations: mergeRoomDecorations(view) });
      }
      await layerFloor(ctx, mod, view.floor, view.floorSprite ?? null);
      if (view.terrain?.length) await paintTerrain(ctx, mod, ROOM_PROJECTOR, view.terrain);
      layerRoomAmbience(ctx, view.theme);
      await layerFurniture(ctx, mod, { ...view, decorations: mergeRoomDecorations(view) });
      if (view.cursor) {
        paintGridGuides(ctx, ROOM_PROJECTOR);
        paintCursor(ctx, ROOM_PROJECTOR, view.cursor);
      }
      await drawHqHeader(ctx, mod, view, W);

      return await canvas.encode("png");
    } catch {
      return null;
    }
  });
}

/** Merge furnished blueprints under player placements so rooms never look empty. */
function mergeRoomDecorations(view: HqRenderView): HqRenderDeco[] {
  const placed = view.decorations ?? [];
  const occupied = new Set(placed.map(d => d.slot));
  const roomId = view.roomId ?? "entrance";
  // Always fill gaps from the blueprint so the room tells its story.
  const bp = blueprintAsDecos(roomId, occupied).map(d => ({
    slot: d.slot,
    category: d.category,
    name: d.name,
    rarityColor: d.rarityColor,
    spritePath: d.spritePath,
    propKind: d.propKind,
    scale: d.scale,
    seed: d.seed,
    fromBlueprint: true,
  } satisfies HqRenderDeco));
  return [...bp, ...placed];
}

// ── Exterior town-base renderer ─────────────────────────────────────────────
// Fresh miniverse recreate from the kaos-hq mockups: ONE flat grassy platform,
// wooden fence, river + bridge, stylized pines, dominant castle. Optional giant
// diorama sky-walls behind the island (not wallpaper). Shield = soft blue dome
// around the castle.
const BASE_CX = OUTDOOR.cx;
const ISLAND_CY = OUTDOOR.cy;
const ISLAND_HW = OUTDOOR.hw;
const ISLAND_HH = OUTDOOR.hh;
const TIER_THICK = OUTDOOR.thick;
const CASTLE_W = 180, CASTLE_H = 200;

// The outdoor build lattice: a GRID×GRID iso grid laid over the island's top
// face so the SAME rectangle editor works on the grounds as inside a room.
// (0,0) is the island's back corner; the grid spans the full diamond.
const BASE_GRID = HQ_BASE_GRID;
const BASE_TILE_W = (ISLAND_HW * 2) / BASE_GRID;
const BASE_TILE_H = (ISLAND_HH * 2) / BASE_GRID;
function baseProject(gx: number, gy: number): Pt {
  return {
    x: BASE_CX + (gx - gy) * (BASE_TILE_W / 2),
    y: (ISLAND_CY - ISLAND_HH) + (gx + gy) * (BASE_TILE_H / 2),
  };
}
const BASE_PROJECTOR: IsoProjector = { project: baseProject, grid: BASE_GRID, tileW: BASE_TILE_W, tileH: BASE_TILE_H };
export const HQ_BASE_PROJECTOR = BASE_PROJECTOR;

// A siege overlay painted ON the base scene (no separate VS screen): the castle
// health drains, defeated defenders dim + get an ✕, the attacker champion
// advances on the castle, and a result banner lands at the end.
export interface SiegeOverlay {
  healthFrac: number;         // castle HP remaining (0..1)
  defeated: Set<number>;      // defender indices knocked out
  attacker: HqRenderDefender | null; // attacker champion assaulting
  advance: number;            // 0..1 how far the attacker has pushed in
  banner: { text: string; color: number } | null;
  caption?: { text: string; color: number } | null; // "X used <Move>!" (classic)
  flashSlot?: number | null;  // defender post taking the current hit (classic)
  // Clash-style scoreboard for the interactive assault: how much of the base is
  // wrecked and how many stars that has earned. Omitted by the auto-resolvers,
  // which have no meaningful mid-fight progress to show.
  destructionPct?: number;    // 0..100
  stars?: number;             // 0..3
  turnLabel?: string | null;  // "Turn 7 · your move" strip under the scoreboard
}

// Deterministic castle-sprite pick per base among the real building art the pack
// ships (falls back to procedural when none is bundled).
const CASTLE_SPRITE_ROLES = ["castle", "keep", "tower"];
function pickCastleSprite(view: HqBaseView): string | null {
  // Prefer the premium castle sprite — HQ must dominate the scene.
  const castle = spriteForPrefix("building", "castle");
  if (castle) return castle;
  const avail = CASTLE_SPRITE_ROLES.map(r => spriteForPrefix("building", r)).filter((p): p is string => !!p);
  if (avail.length === 0) return null;
  let seed = 0; for (const c of (view.displayTitle || "base")) seed = (seed * 31 + c.charCodeAt(0)) | 0;
  return avail[Math.abs(seed) % avail.length]!;
}

// Screen anchors where the OWNER can place grounds decorations (trees, items…)
// on the outdoor base — spread on the grass, clear of the castle and defender row.
const BASE_DECO_TILES: { x: number; y: number }[] = [
  { x: BASE_CX - 300, y: ISLAND_CY - 6 }, { x: BASE_CX + 300, y: ISLAND_CY - 6 },
  { x: BASE_CX - 340, y: ISLAND_CY + 70 }, { x: BASE_CX + 340, y: ISLAND_CY + 70 },
  { x: BASE_CX - 210, y: ISLAND_CY + 150 }, { x: BASE_CX + 210, y: ISLAND_CY + 150 },
  { x: BASE_CX - 130, y: ISLAND_CY - 70 }, { x: BASE_CX + 150, y: ISLAND_CY - 70 },
];
export const HQ_BASE_DECO_SLOTS = BASE_DECO_TILES.length;

// Player-placed grounds decorations on the base (slot = index into BASE_DECO_TILES).
async function drawBaseDecorations(ctx: Ctx, mod: CanvasMod, view: HqBaseView): Promise<void> {
  const decos = (view.decorations ?? []).slice().sort((a, b) => {
    const pa = BASE_DECO_TILES[a.slot % BASE_DECO_TILES.length]!, pb = BASE_DECO_TILES[b.slot % BASE_DECO_TILES.length]!;
    return pa.y - pb.y;
  });
  for (const d of decos) {
    const p = BASE_DECO_TILES[d.slot % BASE_DECO_TILES.length]!;
    await drawDecoAt(ctx, mod, p.x, p.y, 0.9, d, true);
  }
}

// The whole base scene in one painter, reused for the static base view AND every
// frame of a live siege (so the siege looks identical to the base, just in motion).
async function paintBaseScene(ctx: Ctx, mod: CanvasMod, view: HqBaseView, siege?: SiegeOverlay): Promise<void> {
  const { castleTop, castleFeetY } = await paintOutdoorMiniverse(ctx, mod, {
    skybox: view.skybox ?? null,
    giantWallsOff: view.giantWallsOff ?? false,
    shieldActive: !!(view.shieldActive && !siege),
    shieldPulse: view.shieldPulse ?? 0.55,
    showGrid: view.showGrid ?? !!view.cursor,
    seed: view.displayTitle || view.ownerName || "base",
    empty: !!view.emptyPlatform,
  });

  // Player-built terrain / decorations on top of the fresh platform.
  if (view.terrain?.length) await paintTerrain(ctx, mod, BASE_PROJECTOR, view.terrain);
  await drawBaseDecorations(ctx, mod, view);

  if (siege?.destructionPct === undefined) {
    drawBannerAndHealth(ctx, BASE_CX, castleTop, view, siege?.healthFrac);
  }
  await drawBaseDefenders(ctx, mod, view, siege?.defeated, siege?.flashSlot ?? null);
  if (!siege) {
    await drawOutdoorVisitors(ctx, mod, Math.max(0, Math.min(4, view.visitors ?? 0)));
    if (view.companion) drawCompanion(ctx, BASE_CX + 60, ISLAND_CY + 150, view.companion, 1.05);
  }
  if (siege?.attacker) await drawAttacker(ctx, mod, siege.attacker, siege.advance);
  if (view.cursor) paintCursor(ctx, BASE_PROJECTOR, view.cursor);
  if (siege?.destructionPct !== undefined) {
    drawDestructionScoreboard(ctx, siege.destructionPct, siege.stars ?? 0, siege.turnLabel ?? null);
  }
  if (siege?.caption) drawMoveCaption(ctx, siege.caption.text, siege.caption.color);
  if (siege?.banner) drawResultBanner(ctx, siege.banner.text, siege.banner.color);
  await drawHqHeader(ctx, mod, view, W);
  void castleFeetY;
}

/** Multi-tier cliffs so the HQ dominates the open void. */
function drawPremiumIsland(ctx: Ctx, view: HqBaseView): void {
  // Deep rock under-tiers for chunky cliff depth
  drawIslandTier(ctx, BASE_CX, ISLAND_CY + 36, ISLAND_HW + 48, ISLAND_HH + 22, {
    thickness: 52, topA: "#2a3a18", topB: "#1e2a10",
  });
  drawIslandTier(ctx, BASE_CX, ISLAND_CY + 16, ISLAND_HW + 22, ISLAND_HH + 10, {
    thickness: 38, topA: "#3a5a28", topB: "#2a4218",
  });
  drawIslandTier(ctx, BASE_CX, ISLAND_CY, ISLAND_HW, ISLAND_HH, {
    thickness: TIER_THICK + 8, topA: "#4f8a3c", topB: "#3a6a2c",
  });
  // Cliff face strata
  ctx.save();
  const [top, right, bottom, left] = diamond(BASE_CX, ISLAND_CY, ISLAND_HW, ISLAND_HH);
  const thick = TIER_THICK + 8;
  for (let i = 1; i <= 4; i++) {
    const t = i / 5;
    ctx.strokeStyle = i % 2 === 0 ? "rgba(160,120,70,0.28)" : "rgba(60,40,20,0.35)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(left!.x, left!.y + thick * t);
    ctx.lineTo(bottom!.x, bottom!.y + thick * t);
    ctx.lineTo(right!.x, right!.y + thick * t);
    ctx.stroke();
  }
  // Dirt road from front edge toward the castle plateau
  ctx.globalAlpha = 0.85;
  ctx.strokeStyle = "#8a7048"; ctx.lineWidth = 22;
  (ctx as unknown as { lineCap: string }).lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(BASE_CX + 40, ISLAND_CY + ISLAND_HH - 30);
  ctx.quadraticCurveTo(BASE_CX + 90, ISLAND_CY + 80, BASE_CX + 20, ISLAND_CY - 10);
  ctx.stroke();
  ctx.strokeStyle = "#a89060"; ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.moveTo(BASE_CX + 40, ISLAND_CY + ISLAND_HH - 30);
  ctx.quadraticCurveTo(BASE_CX + 90, ISLAND_CY + 80, BASE_CX + 20, ISLAND_CY - 10);
  ctx.stroke();
  // Soft grass highlight toward the sun
  polyPath(ctx, [top!, right!, bottom!, left!]);
  ctx.clip();
  const g = ctx.createLinearGradient(BASE_CX - 200, ISLAND_CY - 120, BASE_CX + 200, ISLAND_CY + 120);
  g.addColorStop(0, "rgba(180,230,120,0.18)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.restore();
  void view;
}

function drawWaterfall(ctx: Ctx): void {
  // Cascading fall off the back-left cliff into the river source.
  const x0 = BASE_CX - 210, y0 = ISLAND_CY - 150;
  ctx.save();
  for (let i = 0; i < 5; i++) {
    ctx.strokeStyle = `rgba(180,220,255,${0.35 + i * 0.08})`;
    ctx.lineWidth = 6 - i * 0.6;
    ctx.beginPath();
    ctx.moveTo(x0 - 10 + i * 5, y0);
    ctx.bezierCurveTo(x0 - 20 + i * 4, y0 + 40, x0 - 30 + i * 3, y0 + 70, x0 - 40 + i * 2, y0 + 100);
    ctx.stroke();
  }
  // Mist at the base
  ctx.fillStyle = "rgba(200,230,255,0.25)";
  ctx.beginPath(); ellipse(ctx, x0 - 30, y0 + 105, 36, 10); ctx.fill();
  ctx.restore();
}

function drawPerimeterFence(ctx: Ctx): void {
  // Wooden rail fence around the island rim (mockup look).
  const pts: Pt[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    // Trace the diamond rim inset slightly
    const u = t < 0.25 ? t * 4 : t < 0.5 ? (t - 0.25) * 4 : t < 0.75 ? (t - 0.5) * 4 : (t - 0.75) * 4;
    let gx: number, gy: number;
    if (t < 0.25) { gx = u; gy = 0; }
    else if (t < 0.5) { gx = 1; gy = u; }
    else if (t < 0.75) { gx = 1 - u; gy = 1; }
    else { gx = 0; gy = 1 - u; }
    // Map unit diamond → screen via island extents
    pts.push({
      x: BASE_CX + (gx - gy) * ISLAND_HW * 0.92,
      y: ISLAND_CY + (gx + gy - 1) * ISLAND_HH * 0.92,
    });
  }
  ctx.save();
  ctx.strokeStyle = "#a07840"; ctx.lineWidth = 3;
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
  }
  ctx.closePath(); ctx.stroke();
  ctx.strokeStyle = "#c49a5a"; ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    if (i === 0) ctx.moveTo(p.x, p.y - 8); else ctx.lineTo(p.x, p.y - 8);
  }
  ctx.closePath(); ctx.stroke();
  // Posts
  ctx.fillStyle = "#8a6230";
  for (let i = 0; i < pts.length; i += 2) {
    const p = pts[i]!;
    ctx.fillRect(p.x - 2, p.y - 18, 4, 20);
  }
  ctx.restore();
}

function drawAnimatedFlags(ctx: Ctx, view: HqBaseView): void {
  const color = view.bannerColor ?? 0xc0392b;
  const poles: { x: number; y: number }[] = [
    { x: BASE_CX - 200, y: ISLAND_CY - 20 },
    { x: BASE_CX + 210, y: ISLAND_CY - 10 },
    { x: BASE_CX - 80, y: ISLAND_CY + 130 },
  ];
  for (let i = 0; i < poles.length; i++) {
    const p = poles[i]!;
    const wave = Math.sin(i * 1.7) * 4;
    ctx.save();
    ctx.strokeStyle = "#c9c1a8"; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x, p.y - 48); ctx.stroke();
    ctx.fillStyle = hexToRgba(color, 0.95);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - 48);
    ctx.quadraticCurveTo(p.x + 18 + wave, p.y - 40, p.x + 28, p.y - 36 + wave * 0.3);
    ctx.quadraticCurveTo(p.x + 16, p.y - 28, p.x, p.y - 24);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.beginPath();
    ctx.moveTo(p.x + 8, p.y - 40); ctx.lineTo(p.x + 12, p.y - 36); ctx.lineTo(p.x + 8, p.y - 32); ctx.lineTo(p.x + 4, p.y - 36);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }
}

async function drawScatterSprites(ctx: Ctx, mod: CanvasMod, view: HqBaseView): Promise<void> {
  const rnd = seededRng(hashString(view.displayTitle || "base"));
  const treePath = spriteForPrefix("nature", "tree") ?? spriteForPrefix("nature", "tree-tall");
  const tallPath = spriteForPrefix("nature", "tree-tall");
  const bushPath = spriteForPrefix("nature", "bush");
  const rockPath = spriteForPrefix("nature", "rock");
  const treeImg = treePath ? await loadSprite(mod, treePath).catch(() => null) : null;
  const tallImg = tallPath ? await loadSprite(mod, tallPath).catch(() => null) : null;
  const bushImg = bushPath ? await loadSprite(mod, bushPath).catch(() => null) : null;
  const rockImg = rockPath ? await loadSprite(mod, rockPath).catch(() => null) : null;

  const inRiver = (x: number, y: number) =>
    Math.abs((x - BASE_CX) - (ISLAND_CY - y) * 0.4) < 46 && y > ISLAND_CY - 150 && y < ISLAND_CY + 150;

  let placed = 0, tries = 0;
  while (placed < 32 && tries++ < 500) {
    const u = rnd() * 2 - 1, v = rnd() * 2 - 1;
    if (Math.abs(u) + Math.abs(v) > 0.92) continue;
    if (Math.abs(u) + Math.abs(v) < 0.36) continue;
    const x = BASE_CX + u * ISLAND_HW, y = ISLAND_CY + v * ISLAND_HH;
    if (inRiver(x, y)) continue;
    const roll = rnd();
    const s = 0.85 + rnd() * 0.55;
    if (roll < 0.55 && (tallImg || treeImg)) {
      const img = (rnd() < 0.45 && tallImg) ? tallImg : (treeImg ?? tallImg)!;
      const iw = Math.max(1, (img as { width: number }).width);
      const ih = Math.max(1, (img as { height: number }).height);
      const h = 70 * s, w = h * (iw / ih);
      ctx.save(); ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.beginPath(); ellipse(ctx, x, y, w * 0.28, 6 * s); ctx.fill(); ctx.restore();
      blit(ctx, img, x - w / 2, y - h + 4, w, h);
    } else if (roll < 0.72 && bushImg) {
      const iw = Math.max(1, (bushImg as { width: number }).width);
      const ih = Math.max(1, (bushImg as { height: number }).height);
      const h = 36 * s, w = h * (iw / ih);
      blit(ctx, bushImg, x - w / 2, y - h + 2, w, h);
    } else if (roll < 0.88 && rockImg) {
      const iw = Math.max(1, (rockImg as { width: number }).width);
      const ih = Math.max(1, (rockImg as { height: number }).height);
      const h = 28 * s, w = h * (iw / ih);
      blit(ctx, rockImg, x - w / 2, y - h + 2, w, h);
    } else if (roll < 0.94) {
      drawProp(ctx, "flowers", x, y, s * 0.85);
    } else {
      drawPine(ctx, x, y, s);
    }
    placed++;
  }
}

/** @deprecated — replaced by paintOpenAtmosphere; kept as no-op shim for safety. */
async function paintSkybox(ctx: Ctx, mod: CanvasMod, skybox: HqSkybox | null): Promise<void> {
  paintVoid(ctx, W, H);
  await paintOpenAtmosphere(ctx, mod, skybox, {
    w: W, h: H, focusX: BASE_CX, focusY: ISLAND_CY - 40, radius: 420,
  });
}

/**
 * Subtle blue shield aura around the playable island — a soft luminous rim
 * hugging the grounds edge, NOT a large transparent dome over the castle.
 * Soft Kenney puff/flash sprites reinforce the ward when available.
 * `pulse` (0..1) gently scales opacity so animated frames can breathe.
 */
async function drawShieldAura(ctx: Ctx, mod: CanvasMod, pulse: number): Promise<void> {
  const p = Math.max(0, Math.min(1, pulse));
  // Sit just outside the island rim so it reads as a ward around the playable
  // area rather than a glass bubble covering the castle.
  const rx = ISLAND_HW * (1.02 + p * 0.02);
  const ry = ISLAND_HH * (1.04 + p * 0.02);
  const cx = BASE_CX, cy = ISLAND_CY + 10;

  ctx.save();
  // Soft outer wash — keep it rim-local so it never reads as a glass dome.
  const fill = ctx.createRadialGradient(cx, cy, Math.min(rx, ry) * 0.88, cx, cy, Math.max(rx, ry) * 1.04);
  fill.addColorStop(0, "rgba(80,170,255,0)");
  fill.addColorStop(0.9, `rgba(70,160,255,${0.015 + p * 0.015})`);
  fill.addColorStop(1, `rgba(100,190,255,${0.08 + p * 0.05})`);
  ctx.fillStyle = fill;
  ctx.beginPath(); ellipse(ctx, cx, cy, rx * 1.03, ry * 1.04); ctx.fill();

  // Thin luminous rim hugging the island edge.
  ctx.strokeStyle = `rgba(140,210,255,${0.45 + p * 0.25})`;
  ctx.lineWidth = 2.5;
  ctx.shadowColor = "rgba(90,180,255,0.8)";
  ctx.shadowBlur = 12 + p * 10;
  ctx.beginPath(); ellipse(ctx, cx, cy, rx, ry); ctx.stroke();

  // Faint inner hairline for a soft double-rim (aura, not dome).
  ctx.shadowBlur = 0;
  ctx.strokeStyle = `rgba(190,230,255,${0.22 + p * 0.12})`;
  ctx.lineWidth = 1;
  ctx.beginPath(); ellipse(ctx, cx, cy, rx * 0.985, ry * 0.985); ctx.stroke();
  ctx.restore();

  // Soft particle accents along the rim (smoke/flash FX from the art pack).
  const puffPath = spriteForPrefix("fx", "shield-puff");
  const flashPath = spriteForPrefix("fx", "shield-flash");
  const puff = puffPath ? await loadSprite(mod, puffPath).catch(() => null) : null;
  const flash = flashPath ? await loadSprite(mod, flashPath).catch(() => null) : null;
  if (!puff && !flash) return;
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + p * 0.4;
    const x = cx + Math.cos(a) * rx * 0.98;
    const y = cy + Math.sin(a) * ry * 0.98;
    const img = (i % 3 === 0 && flash) ? flash : (puff ?? flash)!;
    const size = 28 + (i % 3) * 8 + p * 6;
    ctx.globalAlpha = 0.18 + p * 0.12;
    blit(ctx, img, x - size / 2, y - size / 2, size, size);
  }
  ctx.restore();
}

export async function renderBase(view: HqBaseView): Promise<Buffer | null> {
  return queueRender("hq-base", async () => {
    const mod = await getCanvas();
    if (!mod) return null;
    try {
      const canvas = mod.createCanvas(W, H);
      const ctx = canvas.getContext("2d") as unknown as Ctx;
      await paintBaseScene(ctx, mod, view);
      return await canvas.encode("png");
    } catch { return null; }
  });
}

// ── Siege on the base scene (static frame OR live GIF) ────────────────────────
export interface SiegePlan {
  duels: { slot: number; attackerWon: boolean; move: string }[]; // in order; slot = defender index
  defenderCount: number;
  captured: boolean;
  attacker: HqRenderDefender | null;
  attackerName: string;
  defenderName: string;
}

// The overlay state at battle progress p (0=start, 1=resolved+banner). When
// `showMoves` is on (CLASSIC mode) the current duel surfaces a move caption and
// flashes the defender being hit — the move-by-move battle, on the castle.
function siegeStateAt(plan: SiegePlan, p: number, showMoves: boolean): SiegeOverlay {
  const D = plan.duels.length;
  const step = p * (D + 0.999);
  const resolved = Math.min(D, Math.floor(step)); // fully-resolved duels
  const defeated = new Set<number>();
  let fallen = 0;
  for (let i = 0; i < resolved; i++) { const d = plan.duels[i]!; if (d.attackerWon) { defeated.add(d.slot); fallen++; } }
  const remainingFrac = plan.defenderCount > 0 ? (plan.defenderCount - fallen) / plan.defenderCount : 0;
  const done = resolved >= D;
  const healthFrac = done && plan.captured ? 0 : remainingFrac;
  const banner = done
    ? (plan.captured
      ? { text: `⚔️ ${plan.attackerName} CAPTURED THE BASE`, color: 0xc0392b }
      : { text: `🛡️ ${plan.defenderName} HELD THE BASE`, color: 0x4fd06a })
    : null;
  const current = !done ? plan.duels[resolved] : undefined; // the duel being fought now
  const caption = showMoves && current
    ? { text: `${plan.attacker?.name ?? plan.attackerName} used ${current.move}!`, color: current.attackerWon ? 0x4fd06a : 0xd0483a }
    : null;
  const flashSlot = showMoves && current ? current.slot : null;
  return { healthFrac, defeated, attacker: plan.attacker, advance: Math.min(1, p * 1.15), banner, caption, flashSlot };
}

export async function renderSiege(view: HqBaseView, plan: SiegePlan, live: boolean, showMoves = false): Promise<Buffer | null> {
  if (!live) {
    return queueRender("hq-siege", async () => {
      const mod = await getCanvas();
      if (!mod) return null;
      try {
        const canvas = mod.createCanvas(W, H);
        const ctx = canvas.getContext("2d") as unknown as Ctx;
        await paintBaseScene(ctx, mod, view, siegeStateAt(plan, 1, false));
        return await canvas.encode("png");
      } catch { return null; }
    });
  }
  // Classic (moves) runs a touch slower + more frames so captions are readable.
  const res = await encodeAnimation({
    width: W, height: H, speed: "normal", durationMs: showMoves ? 3600 : 2800,
    maxFrames: showMoves ? 26 : 20, quality: 26, renderScale: 0.6,
    render: async ({ ctx, t, mod }) => { await paintBaseScene(ctx as unknown as Ctx, mod, view, siegeStateAt(plan, t, showMoves)); },
  });
  return res?.buffer ?? null;
}

// The attacker champion assaulting the castle: a framed card that advances from
// the front of the island up toward the gate as the battle progresses.
async function drawAttacker(ctx: Ctx, mod: CanvasMod, def: HqRenderDefender, advance: number): Promise<void> {
  const cw = 78, ch = 104;
  const x = BASE_CX - cw / 2;
  const y = lerp({ x: 0, y: ISLAND_CY + 150 }, { x: 0, y: ISLAND_CY + 34 }, advance).y - ch / 2;
  ctx.save(); ctx.fillStyle = "rgba(0,0,0,0.34)"; ctx.beginPath(); ellipse(ctx, x + cw / 2, y + ch, cw * 0.5, 9); ctx.fill(); ctx.restore();
  ctx.save(); ctx.shadowColor = hexToRgba(def.rarityColor, 0.7); ctx.shadowBlur = 14;
  roundRectPath(ctx, x, y, cw, ch, 8); ctx.fillStyle = "#0d0f14"; ctx.fill(); ctx.restore();
  ctx.save(); roundRectPath(ctx, x, y, cw, ch, 8); ctx.clip();
  await drawCardArt(ctx, mod, x, y, cw, ch, def.artUrl, def.rarity, def.progTier);
  ctx.restore();
  drawCardFrame(ctx, x, y, cw, ch, def.rarityColor, 3, def.rarity, def.progTier);
  ctx.save(); ctx.textAlign = "center"; ctx.textBaseline = "middle";
  drawTextWithShadow(ctx, "⚔️", x + cw / 2, y - 8, "#ffffff", 20);
  ctx.restore();
}

// The Clash-style scoreboard for an interactive assault: three stars, a
// destruction meter and the turn strip, pinned under the header so it reads as
// a HUD over the battlefield rather than part of the scenery.
function drawDestructionScoreboard(ctx: Ctx, pct: number, stars: number, turnLabel: string | null): void {
  const clamped = Math.max(0, Math.min(100, pct));
  const panelW = 360, panelH = turnLabel ? 104 : 82;
  const px = W / 2 - panelW / 2, py = HEADER_H + 14;

  // Opaque, not tinted: the castle's own banner and health bar sit right behind
  // this strip, and a see-through panel let them bleed through the stars.
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.55)"; ctx.shadowBlur = 18; ctx.shadowOffsetY = 4;
  ctx.fillStyle = "#11151c";
  roundRectPath(ctx, px, py, panelW, panelH, 14); ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = "rgba(226,210,170,0.5)"; ctx.lineWidth = 1.5;
  roundRectPath(ctx, px, py, panelW, panelH, 14); ctx.stroke();
  ctx.restore();

  // Three stars. Earned stars glow gold; the rest are hollow slots, so the
  // remaining objective is readable at a glance.
  const starY = py + 26;
  for (let i = 0; i < 3; i++) {
    const sx = W / 2 + (i - 1) * 62;
    drawStar(ctx, sx, starY, 19, i < stars);
  }

  // Destruction meter.
  const barY = py + 50, barW = panelW - 56;
  const frac = clamped / 100;
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  roundRectPath(ctx, W / 2 - barW / 2 - 2, barY - 2, barW + 4, 14, 7); ctx.fill();
  ctx.fillStyle = "#241a16";
  roundRectPath(ctx, W / 2 - barW / 2, barY, barW, 10, 5); ctx.fill();
  const g = ctx.createLinearGradient(W / 2 - barW / 2, 0, W / 2 + barW / 2, 0);
  g.addColorStop(0, "#e0813a"); g.addColorStop(1, "#d0483a");
  ctx.fillStyle = g;
  roundRectPath(ctx, W / 2 - barW / 2, barY, Math.max(3, barW * frac), 10, 5); ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  drawTitle(ctx, `${Math.round(clamped)}% DESTRUCTION`, W / 2, barY + 22, "#ffe9c8", 15);
  if (turnLabel) {
    drawTextWithShadow(ctx, stripEmoji(turnLabel), W / 2, py + panelH - 14, "rgba(226,226,232,0.9)", 13);
  }
  ctx.restore();
}

function drawStar(ctx: Ctx, cx: number, cy: number, r: number, earned: boolean): void {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? r : r * 0.44;
    pts.push({ x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad });
  }
  ctx.save();
  if (earned) {
    ctx.shadowColor = "rgba(255,205,90,0.9)"; ctx.shadowBlur = 16;
    const g = ctx.createLinearGradient(cx, cy - r, cx, cy + r);
    g.addColorStop(0, "#ffe9a8"); g.addColorStop(1, "#e8a92e");
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = "rgba(255,255,255,0.07)";
  }
  polyPath(ctx, pts); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = earned ? "rgba(255,240,200,0.95)" : "rgba(255,255,255,0.22)";
  ctx.lineWidth = 2;
  polyPath(ctx, pts); ctx.stroke();
  ctx.restore();
}

/**
 * One still frame of an interactive assault — the castle as it stands right
 * now, with the scoreboard, the fallen defenders and the attacker's champion
 * pushing in. This is the picture that sits at the top of the siege message and
 * updates as the base comes apart.
 */
export async function renderSiegeFrame(view: HqBaseView, overlay: SiegeOverlay): Promise<Buffer | null> {
  return queueRender("hq-siege-frame", async () => {
    const mod = await getCanvas();
    if (!mod) return null;
    try {
      const canvas = mod.createCanvas(W, H);
      const ctx = canvas.getContext("2d") as unknown as Ctx;
      await paintBaseScene(ctx, mod, view, overlay);
      return await canvas.encode("png");
    } catch { return null; }
  });
}

function drawResultBanner(ctx: Ctx, text: string, color: number): void {
  ctx.save();
  const bw = W - 160, bh = 60, bx = 80, by = H / 2 - 30;
  ctx.fillStyle = "rgba(0,0,0,0.72)"; roundRectPath(ctx, bx, by, bw, bh, 16); ctx.fill();
  ctx.strokeStyle = hexToRgba(color, 0.95); ctx.lineWidth = 3; roundRectPath(ctx, bx, by, bw, bh, 16); ctx.stroke();
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.shadowColor = hexToRgba(color, 0.8); ctx.shadowBlur = 16;
  drawTitle(ctx, text, W / 2, by + bh / 2, "#ffffff", fitText(ctx, text, bw - 40, 30, 16, TITLE_FONT));
  ctx.restore();
}

// A meandering river across the base tier, clipped to the grass, with a bridge.
function drawRiver(ctx: Ctx): void {
  const [top, right, bottom, left] = diamond(BASE_CX, ISLAND_CY, ISLAND_HW, ISLAND_HH) as [Pt, Pt, Pt, Pt];
  ctx.save();
  polyPath(ctx, [top, right, bottom, left]); ctx.clip();
  const pts: Pt[] = [
    { x: BASE_CX + 210, y: ISLAND_CY - 150 },
    { x: BASE_CX + 90, y: ISLAND_CY - 40 },
    { x: BASE_CX + 150, y: ISLAND_CY + 60 },
    { x: BASE_CX + 20, y: ISLAND_CY + 150 },
  ];
  (ctx as unknown as { lineCap: string; lineJoin: string }).lineCap = "round";
  (ctx as unknown as { lineCap: string; lineJoin: string }).lineJoin = "round";
  ctx.strokeStyle = "#2f5d86"; ctx.lineWidth = 30;
  ctx.beginPath(); ctx.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) { const p = pts[i]!, pv = pts[i - 1]!; ctx.quadraticCurveTo(pv.x, (pv.y + p.y) / 2, p.x, p.y); }
  ctx.stroke();
  ctx.strokeStyle = "#4a86bd"; ctx.lineWidth = 18;
  ctx.beginPath(); ctx.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) { const p = pts[i]!, pv = pts[i - 1]!; ctx.quadraticCurveTo(pv.x, (pv.y + p.y) / 2, p.x, p.y); }
  ctx.stroke();
  ctx.strokeStyle = "rgba(200,230,255,0.4)"; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) { const p = pts[i]!, pv = pts[i - 1]!; ctx.quadraticCurveTo(pv.x, (pv.y + p.y) / 2, p.x, p.y); }
  ctx.stroke();
  ctx.restore();
  // Bridge across the lower bend.
  const bx = BASE_CX + 95, by = ISLAND_CY + 95;
  ctx.save(); ctx.translate(bx, by); ctx.rotate(-0.5);
  ctx.fillStyle = "#8a6a3f"; ctx.fillRect(-30, -12, 60, 24);
  ctx.fillStyle = "#6b4f2c"; for (let i = -28; i < 30; i += 8) ctx.fillRect(i, -12, 4, 24);
  ctx.restore();
}

// Legacy scatter kept for reference — outdoor scene uses drawScatterSprites.
function drawScatter(ctx: Ctx, view: HqBaseView): void {
  const rnd = seededRng(hashString(view.displayTitle || "base"));
  const inRiver = (x: number, y: number) => Math.abs((x - BASE_CX) - (ISLAND_CY - y) * 0.4) < 46 && y > ISLAND_CY - 150 && y < ISLAND_CY + 150;
  let placed = 0, tries = 0;
  while (placed < 26 && tries++ < 400) {
    const u = rnd() * 2 - 1, v = rnd() * 2 - 1;
    if (Math.abs(u) + Math.abs(v) > 0.96) continue;
    const x = BASE_CX + u * ISLAND_HW, y = ISLAND_CY + v * ISLAND_HH;
    if (Math.abs(u) + Math.abs(v) < 0.34) continue;
    if (inRiver(x, y)) continue;
    const s = 0.8 + rnd() * 0.5;
    if (rnd() < 0.8) drawPine(ctx, x, y, s); else drawProp(ctx, "rock", x, y, s);
    placed++;
  }
}

// A clean light-stone castle: central keep + two crenellated towers, front-iso.
// Draw the castle and return the Y of its top (where the banner/health sit).
// Uses a real castle SPRITE when one is bundled; otherwise a clean procedural
// castle. Either way the feet sit on the plateau at `feetY`.
async function drawCastle(ctx: Ctx, mod: CanvasMod, cx: number, feetY: number, spritePath: string | null): Promise<number> {
  ctx.save(); ctx.fillStyle = "rgba(0,0,0,0.38)"; ctx.beginPath(); ellipse(ctx, cx, feetY, CASTLE_W * 0.78, 22); ctx.fill(); ctx.restore();
  if (spritePath) {
    const img = await loadSprite(mod, spritePath).catch(() => null);
    if (img) {
      const iw = Math.max(1, (img as { width: number }).width);
      const ih = Math.max(1, (img as { height: number }).height);
      // Larger castle so the HQ dominates the outdoor scene.
      const h = 310, w = h * (iw / ih);
      blit(ctx, img, cx - w / 2, feetY - h + 8, w, h);
      return feetY - h + 40;
    }
  }
  return drawCastleProcedural(ctx, cx, feetY);
}

function drawCastleProcedural(ctx: Ctx, cx: number, feetY: number): number {
  const stoneL = "#d8d2c0", stone = "#c3bca7", stoneD = "#9a927c", dark = "#2a2620";

  const crenel = (x: number, w: number, topY: number) => {
    ctx.fillStyle = stone;
    const teeth = Math.max(3, Math.floor(w / 12));
    const tw = w / (teeth * 2 - 1);
    for (let i = 0; i < teeth; i++) ctx.fillRect(x + i * tw * 2, topY, tw, 8);
  };
  const tower = (tx: number, tw: number, th: number) => {
    const g = ctx.createLinearGradient(tx, 0, tx + tw, 0);
    g.addColorStop(0, stoneL); g.addColorStop(0.5, stone); g.addColorStop(1, stoneD);
    ctx.fillStyle = g; ctx.fillRect(tx, feetY - th, tw, th);
    crenel(tx - 2, tw + 4, feetY - th - 8);
    ctx.fillStyle = dark; // slit windows
    for (const wy of [0.72, 0.5, 0.28]) { ctx.fillRect(tx + tw * 0.42, feetY - th * wy, tw * 0.16, th * 0.12); }
  };

  // Back central keep (tallest).
  const keepW = CASTLE_W * 0.34;
  tower(cx - keepW / 2, keepW, CASTLE_H);
  // Front curtain wall.
  const wallW = CASTLE_W * 0.86, wallH = CASTLE_H * 0.52;
  const wg = ctx.createLinearGradient(cx - wallW / 2, 0, cx + wallW / 2, 0);
  wg.addColorStop(0, stoneL); wg.addColorStop(1, stoneD);
  ctx.fillStyle = wg; ctx.fillRect(cx - wallW / 2, feetY - wallH, wallW, wallH);
  crenel(cx - wallW / 2, wallW, feetY - wallH - 8);
  // Gate.
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.moveTo(cx - wallW * 0.1, feetY); ctx.lineTo(cx - wallW * 0.1, feetY - wallH * 0.5);
  ctx.arc(cx, feetY - wallH * 0.5, wallW * 0.1, Math.PI, 0); ctx.lineTo(cx + wallW * 0.1, feetY); ctx.closePath(); ctx.fill();
  // Two front corner towers.
  const ctw = CASTLE_W * 0.2, cth = CASTLE_H * 0.78;
  tower(cx - wallW / 2 - ctw * 0.3, ctw, cth);
  tower(cx + wallW / 2 - ctw * 0.7, ctw, cth);
  return feetY - CASTLE_H - 8;
}

// Owner banner (colour + crest) hanging from a pole, with a defence health bar
// floating above the castle — exactly the "banner + HP bar on top" from the mock.
function drawBannerAndHealth(ctx: Ctx, cx: number, castleTopY: number, view: HqBaseView, healthFrac?: number): void {
  // Red when captured; otherwise the caller's colour (an AI faction's crest on a
  // world territory, or the owner's blue on a player base).
  const owner = view.captured ? 0xc0392b : (view.bannerColor ?? 0x3f78c8);
  const barY = castleTopY - 54, barW = 96, barH = 9;
  // Health = the siege's remaining castle HP when besieged, else share of posts filled.
  const filled = healthFrac ?? Math.min(1, (view.defenders?.length ?? 0) / Math.max(1, HQ_DEFENDER_SLOTS));
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.6)"; roundRectPath(ctx, cx - barW / 2 - 2, barY - 2, barW + 4, barH + 4, 5); ctx.fill();
  ctx.fillStyle = "#203020"; roundRectPath(ctx, cx - barW / 2, barY, barW, barH, 4); ctx.fill();
  const hpCol = filled > 0.5 ? "#4fd06a" : filled > 0.25 ? "#e0b83a" : "#d0483a"; // green→amber→red
  ctx.fillStyle = hpCol; roundRectPath(ctx, cx - barW / 2, barY, Math.max(2, barW * filled), barH, 4); ctx.fill();
  ctx.restore();
  // Banner pole + cloth.
  const poleTop = barY + 14, cloth = 44, bw = 34;
  ctx.strokeStyle = "#c9c1a8"; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(cx, poleTop); ctx.lineTo(cx, castleTopY + 6); ctx.stroke();
  ctx.fillStyle = hexToRgba(owner, 1);
  ctx.beginPath();
  ctx.moveTo(cx - bw / 2, poleTop); ctx.lineTo(cx + bw / 2, poleTop);
  ctx.lineTo(cx + bw / 2, poleTop + cloth); ctx.lineTo(cx, poleTop + cloth - 10); ctx.lineTo(cx - bw / 2, poleTop + cloth);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = "rgba(0,0,0,0.18)"; ctx.fillRect(cx, poleTop, bw / 2, cloth - 5); // shaded half
  // Crest (a simple 4-point star).
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  const sc = 8, cyC = poleTop + 18;
  ctx.beginPath();
  ctx.moveTo(cx, cyC - sc); ctx.lineTo(cx + sc * 0.32, cyC - sc * 0.32); ctx.lineTo(cx + sc, cyC);
  ctx.lineTo(cx + sc * 0.32, cyC + sc * 0.32); ctx.lineTo(cx, cyC + sc); ctx.lineTo(cx - sc * 0.32, cyC + sc * 0.32);
  ctx.lineTo(cx - sc, cyC); ctx.lineTo(cx - sc * 0.32, cyC - sc * 0.32); ctx.closePath(); ctx.fill();
}

// The stationed cards, shown as small framed portraits standing in front of the
// castle — "the cards you left to defend." Each: card art + rarity border + name.
async function drawBaseDefenders(ctx: Ctx, mod: CanvasMod, view: HqBaseView, defeated?: Set<number>, flashSlot?: number | null): Promise<void> {
  const defs = view.defenders ?? [];
  if (defs.length === 0) return;
  const n = Math.min(defs.length, 5);
  const cw = 74, ch = 96, gap = 14;
  const totalW = n * cw + (n - 1) * gap;
  const startX = BASE_CX - totalW / 2;
  const rowY = ISLAND_CY + 96;
  for (let i = 0; i < n; i++) {
    const def = defs[i]!;
    const hit = flashSlot === i;
    const jitter = hit ? (Math.random() * 6 - 3) : 0;
    const x = startX + i * (cw + gap) + jitter, y = rowY - ch;
    const down = defeated?.has(i) ?? false;
    ctx.save(); ctx.fillStyle = "rgba(0,0,0,0.32)"; ctx.beginPath(); ellipse(ctx, x + cw / 2, rowY, cw * 0.5, 9); ctx.fill(); ctx.restore();
    ctx.save();
    ctx.shadowColor = hexToRgba(def.rarityColor, down ? 0.15 : 0.6); ctx.shadowBlur = 12;
    roundRectPath(ctx, x, y, cw, ch, 8); ctx.fillStyle = "#0d0f14"; ctx.fill();
    ctx.restore();
    ctx.save(); roundRectPath(ctx, x, y, cw, ch, 8); ctx.clip();
    await drawCardArt(ctx, mod, x, y, cw, ch, def.artUrl, def.rarity, def.progTier);
    const g = ctx.createLinearGradient(0, y + ch - 28, 0, y + ch);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.82)");
    ctx.fillStyle = g; ctx.fillRect(x, y + ch - 28, cw, 28);
    if (down) { ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(x, y, cw, ch); } // knocked out
    ctx.restore();
    drawCardFrame(ctx, x, y, cw, ch, down ? 0x555a63 : def.rarityColor, 3, def.rarity, def.progTier);
    ctx.save(); ctx.textAlign = "center"; ctx.textBaseline = "middle";
    drawTitle(ctx, def.name, x + cw / 2, y + ch - 12, down ? "#9aa0a8" : "#ffffff", fitText(ctx, def.name, cw - 8, 12, 9, TITLE_FONT));
    if (down) { // red ✕ over the fallen defender
      ctx.strokeStyle = "rgba(220,70,60,0.9)"; ctx.lineWidth = 5; ctx.beginPath();
      ctx.moveTo(x + 14, y + 20); ctx.lineTo(x + cw - 14, y + ch - 34);
      ctx.moveTo(x + cw - 14, y + 20); ctx.lineTo(x + 14, y + ch - 34); ctx.stroke();
    }
    ctx.restore();
    if (hit && !down) { // impact flash on the defender taking the current blow
      ctx.save(); roundRectPath(ctx, x, y, cw, ch, 8);
      ctx.fillStyle = "rgba(255,240,180,0.5)"; ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.95)"; ctx.lineWidth = 4; ctx.stroke();
      ctx.restore();
      ctx.save(); ctx.textAlign = "center"; ctx.textBaseline = "middle";
      drawTextWithShadow(ctx, "💥", x + cw / 2, y + ch / 2, "#ffffff", 34);
      ctx.restore();
    }
  }
}

// A move caption banner (classic mode) — "X used <Move>!" high on the scene.
function drawMoveCaption(ctx: Ctx, text: string, color: number): void {
  ctx.save();
  ctx.font = `bold 22px "${TITLE_FONT}", "DejaVu Sans", Arial, sans-serif`;
  const w = Math.min(W - 80, ctx.measureText(text).width + 48), h = 40, x = (W - w) / 2, y = 86;
  ctx.fillStyle = "rgba(0,0,0,0.72)"; roundRectPath(ctx, x, y, w, h, 12); ctx.fill();
  ctx.strokeStyle = hexToRgba(color, 0.95); ctx.lineWidth = 2; roundRectPath(ctx, x, y, w, h, 12); ctx.stroke();
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  drawTitle(ctx, text, W / 2, y + h / 2, "#ffffff", 20);
  ctx.restore();
}

// ── Layers ──────────────────────────────────────────────────────────────────
function layerBackdrop(ctx: Ctx, theme: HqTheme): void {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, theme.palette.wallBottom);
  g.addColorStop(1, "#05070a");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

// Scene behind the room — a chosen sky/landscape backdrop, cover-fit. Shows above
// the walls, and fills the view when the walls are opened ("outside").
async function layerSceneryBackdrop(ctx: Ctx, mod: CanvasMod, spritePath: string | null): Promise<void> {
  if (!spritePath) return;
  const img = await loadSprite(mod, spritePath).catch(() => null);
  if (!img) return;
  const iw = Math.max(1, (img as { width: number }).width);
  const ih = Math.max(1, (img as { height: number }).height);
  const sc = Math.max(W / iw, H / ih); // cover
  const dw = iw * sc, dh = ih * sc;
  blit(ctx, img, (W - dw) / 2, (H - dh) / 2, dw, dh);
  // Soften so foreground furniture still reads.
  ctx.save(); ctx.fillStyle = "rgba(0,0,0,0.22)"; ctx.fillRect(0, 0, W, H); ctx.restore();
}

// Fill a wall face (a parallelogram) with shading, a top trim line, a baseboard,
// and optional window panels. `corners` are base-left, base-right, top-left,
// top-right along the same horizontal parameter u (v=0 base, v=1 top).
function drawWallFace(
  ctx: Ctx, bl: Pt, br: Pt, tl: Pt, tr: Pt, face: string, trim: string,
  window: boolean, windowTint: string, motif: HqWall["motif"] = "plain",
): void {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(bl.x, bl.y); ctx.lineTo(br.x, br.y); ctx.lineTo(tr.x, tr.y); ctx.lineTo(tl.x, tl.y);
  ctx.closePath();
  ctx.fillStyle = face;
  ctx.fill();
  ctx.clip();

  const bilerp = (u: number, v: number): Pt => lerp(lerp(bl, br, u), lerp(tl, tr, u), v);

  if (window) {
    const cols = 3;
    for (let c = 0; c < cols; c++) {
      const u0 = (c + 0.18) / cols, u1 = (c + 0.82) / cols;
      const p00 = bilerp(u0, 0.32), p10 = bilerp(u1, 0.32);
      const p01 = bilerp(u0, 0.9),  p11 = bilerp(u1, 0.9);
      ctx.beginPath();
      ctx.moveTo(p00.x, p00.y); ctx.lineTo(p10.x, p10.y); ctx.lineTo(p11.x, p11.y); ctx.lineTo(p01.x, p01.y);
      ctx.closePath();
      ctx.fillStyle = windowTint; ctx.fill();
      ctx.strokeStyle = hexToRgba(0xffffff, 0.28); ctx.lineWidth = 2; ctx.stroke();
      const m0 = bilerp((u0 + u1) / 2, 0.32), m1 = bilerp((u0 + u1) / 2, 0.9);
      ctx.beginPath(); ctx.moveTo(m0.x, m0.y); ctx.lineTo(m1.x, m1.y); ctx.stroke();
    }
  } else if (motif === "brick" || motif === "blocks") {
    for (let row = 0; row < 6; row++) {
      const v0 = row / 6, v1 = (row + 1) / 6;
      const offset = row % 2 === 0 ? 0 : 0.08;
      for (let col = 0; col < 4; col++) {
        const u0 = offset + col / 4, u1 = offset + (col + 0.92) / 4;
        if (u1 > 1.02) continue;
        const p00 = bilerp(u0, v0 + 0.02), p10 = bilerp(Math.min(1, u1), v0 + 0.02);
        const p01 = bilerp(u0, v1 - 0.02), p11 = bilerp(Math.min(1, u1), v1 - 0.02);
        ctx.beginPath();
        ctx.moveTo(p00.x, p00.y); ctx.lineTo(p10.x, p10.y); ctx.lineTo(p11.x, p11.y); ctx.lineTo(p01.x, p01.y);
        ctx.closePath();
        ctx.strokeStyle = "rgba(0,0,0,0.22)"; ctx.lineWidth = 1; ctx.stroke();
      }
    }
  } else if (motif === "planks") {
    for (let c = 0; c < 6; c++) {
      const a = bilerp((c + 0.5) / 6, 0), b = bilerp((c + 0.5) / 6, 1);
      ctx.strokeStyle = "rgba(0,0,0,0.18)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
  } else if (motif === "panels" || motif === "rivets") {
    for (let c = 1; c < 4; c++) {
      const a = bilerp(c / 4, 0.08), b = bilerp(c / 4, 0.92);
      ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    if (motif === "rivets") {
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
        const p = bilerp((c + 0.5) / 4, (r + 0.5) / 4);
        ctx.fillStyle = "rgba(200,200,210,0.45)";
        ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2); ctx.fill();
      }
    }
  } else if (motif === "runes") {
      ctx.strokeStyle = "rgba(201,162,74,0.35)"; ctx.lineWidth = 1.5;
      for (let i = 0; i < 5; i++) {
        const p = bilerp(0.15 + i * 0.15, 0.35 + (i % 2) * 0.2);
        ctx.beginPath();
        ctx.moveTo(p.x - 6, p.y - 10);
        ctx.lineTo(p.x + 6, p.y - 10);
        ctx.lineTo(p.x + 6, p.y + 10);
        ctx.lineTo(p.x - 6, p.y + 10);
        ctx.closePath();
        ctx.stroke();
      }
  } else {
    for (let c = 1; c < 4; c++) {
      const a = bilerp(c / 4, 0), b = bilerp(c / 4, 1);
      ctx.strokeStyle = hexToRgba(0x000000, 0.12); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
  }
  ctx.restore();

  ctx.strokeStyle = trim; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y); ctx.stroke();
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(bl.x, bl.y); ctx.lineTo(br.x, br.y); ctx.stroke();
}

async function layerWalls(
  ctx: Ctx, mod: CanvasMod, wall: HqWall, spritePath: string | null, wallpaper: HqWallpaper | null,
): Promise<void> {
  const up = (p: Pt): Pt => ({ x: p.x, y: p.y - WALL_H });
  const rBL = project(0, GRID), rBR = project(0, 0);
  const lBL = project(0, 0), lBR = project(GRID, 0);
  // Wallpaper wins: a real repeating covering papered in iso perspective, with
  // its own dado rail and skirting.
  if (wallpaper) {
    await drawWallpaperFace(ctx, mod, rBL, rBR, up(rBL), up(rBR), wallpaper);
    await drawWallpaperFace(ctx, mod, lBL, lBR, up(lBL), up(lBR), wallpaper);
    ctx.strokeStyle = wall.trim; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(up(rBL).x, up(rBL).y); ctx.lineTo(up(rBR).x, up(rBR).y); ctx.lineTo(up(lBR).x, up(lBR).y); ctx.stroke();
    // The inside corner, so the two papered faces read as a folded room.
    ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(rBR.x, rBR.y); ctx.lineTo(up(rBR).x, up(rBR).y); ctx.stroke();
    return;
  }
  // Art path: blit a seamless wall texture onto each face (uploaded packs).
  const img = spritePath ? await loadSprite(mod, spritePath).catch(() => null) : null;
  if (img) {
    blitClippedQuad(ctx, img, [rBL, rBR, up(rBR), up(rBL)]);
    blitClippedQuad(ctx, img, [lBL, lBR, up(lBR), up(lBL)]);
    // Keep trims so the corner still reads crisply over the texture.
    ctx.strokeStyle = wall.trim; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(up(rBL).x, up(rBL).y); ctx.lineTo(up(rBR).x, up(rBR).y); ctx.lineTo(up(lBR).x, up(lBR).y); ctx.stroke();
    return;
  }
  // Procedural: two shaded faces with architectural motif + trim + optional windows.
  drawWallFace(ctx, rBL, rBR, up(rBL), up(rBR), wall.rightFace, wall.trim, wall.window, wall.windowTint, wall.motif);
  drawWallFace(ctx, lBL, lBR, up(lBL), up(lBR), wall.leftFace, wall.trim, wall.window, wall.windowTint, wall.motif);
}

async function layerFloor(ctx: Ctx, mod: CanvasMod, floor: HqFloor, spritePath: string | null): Promise<void> {
  const img = spritePath ? await loadSprite(mod, spritePath).catch(() => null) : null;
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const a = project(i, j), b = project(i + 1, j), c = project(i + 1, j + 1), d = project(i, j + 1);
      if (img) {
        blitClippedQuad(ctx, img, [a, b, c, d]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.closePath();
        ctx.strokeStyle = floor.grout; ctx.lineWidth = 1; ctx.stroke();
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.closePath();
      ctx.fillStyle = (i + j) % 2 === 0 ? floor.tileA : floor.tileB;
      ctx.fill();
      ctx.strokeStyle = floor.grout; ctx.lineWidth = 1; ctx.stroke();
    }
  }
}

function layerLighting(ctx: Ctx, theme: HqTheme): void {
  layerRoomAmbience(ctx, theme);
}

/** Warm tactical HQ lighting — focused pool on the floor, soft vignette. */
function layerRoomAmbience(ctx: Ctx, theme: HqTheme): void {
  // Soft floor pool only — keep walls dark (tactical HQ look).
  const r = ctx.createRadialGradient(W / 2, ORIGIN_Y + 160, 30, W / 2, ORIGIN_Y + 260, 380);
  r.addColorStop(0, "rgba(255,180,100,0.10)");
  r.addColorStop(0.5, "rgba(255,160,80,0.04)");
  r.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = r;
  ctx.fillRect(0, 0, W, H);

  try {
    drawAtmosphere(ctx, W, H, atmospherePreset(theme.atmosphere), {
      seed: `hq-${theme.id}`, t: 0.35, color: theme.palette.accent, density: 0.18,
    });
  } catch { /* never break a render on ambience */ }

  // Deep vignette so the room reads as a lit stage in the void.
  const v = ctx.createRadialGradient(W / 2, H / 2 + 40, H * 0.22, W / 2, H / 2, W * 0.68);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.72)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
  void theme;
}

// Wall-mounted decorations sit on the wall plane, drawn between walls and floor.
async function layerWallDecorations(ctx: Ctx, mod: CanvasMod, view: HqRenderView): Promise<void> {
  for (const deco of view.decorations) {
    if (!slotIsWall(deco.slot)) continue;
    const a = WALL_ANCHORS[(deco.slot - HQ_WALL_SLOT_BASE) % WALL_ANCHORS.length]!;
    await drawDecoAt(ctx, mod, a.x, a.y, a.scale, deco, false);
  }
}

// Floor furniture (decorations + card pedestals) drawn back-to-front by depth so
// nearer objects overlap further ones.
async function layerFurniture(ctx: Ctx, mod: CanvasMod, view: HqRenderView): Promise<void> {
  interface Item { depth: number; draw: () => Promise<void> }
  const items: Item[] = [];

  // Card pedestals along a back anti-diagonal (constant depth), centred and
  // spaced ~1.4 tiles apart so the display cases never overlap.
  const n = view.pedestals.length;
  const SPREAD = 1.4;
  for (let i = 0; i < n; i++) {
    const d = (i - (n - 1) / 2) * SPREAD;
    const p = project(3.0 + d, 3.0 - d);  // gx+gy = 6 → shallow back row, centred
    const card = view.pedestals[i]!;
    items.push({ depth: p.y, draw: () => drawPedestal(ctx, mod, p.x, p.y, card, view.theme, !!view.glassOff) });
  }

  // Floor decorations, positioned on their exact grid tile.
  for (const deco of view.decorations) {
    if (slotIsWall(deco.slot)) continue;
    const { gx, gy } = slotToTile(deco.slot);
    const p = project(gx + 0.5, gy + 0.5); // tile centre
    items.push({ depth: p.y, draw: async () => { await drawDecoAt(ctx, mod, p.x, p.y, 0.95, deco, true); } });
  }

  // Defenders — cards standing on bases along a front arc.
  const defs = view.defenders ?? [];
  for (let i = 0; i < defs.length; i++) {
    const t = DEFENDER_TILES[i % DEFENDER_TILES.length]!;
    const p = project(t.gx, t.gy);
    const def = defs[i]!;
    items.push({ depth: p.y + 1, draw: () => drawDefender(ctx, mod, p.x, p.y, def, view.theme) });
  }

  // Ambient visitors — a few guests off to the sides so the hall feels lived-in.
  const vis = Math.max(0, Math.min(4, view.visitors ?? 0));
  const VISITOR_TILES = [{ gx: 6.6, gy: 1.4 }, { gx: 1.4, gy: 6.4 }, { gx: 6.9, gy: 5.2 }, { gx: 1.5, gy: 2.2 }];
  for (let i = 0; i < vis; i++) {
    const t = VISITOR_TILES[i]!;
    const p = project(t.gx, t.gy);
    items.push({ depth: p.y, draw: async () => { drawVisitor(ctx, p.x, p.y, i + 1, 1); } });
  }

  // Companion — the pet stands front-and-centre, nearest the viewer.
  if (view.companion) {
    const comp = view.companion;
    const p = project(4.4, 4.4);
    items.push({ depth: p.y + 2, draw: async () => { drawCompanion(ctx, p.x, p.y, comp, 1); } });
  }

  items.sort((a, b) => a.depth - b.depth);
  for (const it of items) await it.draw();
}

// ── Card pedestal (upright display panel on an iso plinth) ─────────────────────
async function drawPedestal(
  ctx: Ctx, mod: CanvasMod, cx: number, cy: number, card: HqRenderCard | null, theme: HqTheme, glassOff = false,
): Promise<void> {
  const cardW = 98, cardH = 128;
  const plinthH = 28, plinthW = cardW + 20;
  const cardBottom = cy - 6;           // card stands just above the plinth top
  const cardTop = cardBottom - cardH;
  const cardX = cx - cardW / 2;

  // Ground shadow.
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.34)";
  ctx.beginPath(); ellipse(ctx, cx, cy + plinthH - 4, plinthW / 2, 12); ctx.fill();
  ctx.restore();

  // Iso plinth (a short box).
  drawIsoBox(ctx, cx, cy, plinthW, plinthH, theme.palette.accent);

  if (!card) {
    if (!glassOff) drawGlassCase(ctx, cardX, cardTop, cardW, cardH, theme, 0x808895);
    ctx.save();
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    drawTitle(ctx, "+", cx, cardTop + cardH / 2 - 8, hexToRgba(theme.palette.accent, 0.85), 42);
    drawTextWithShadow(ctx, "Pin a card", cx, cardTop + cardH / 2 + 24, "rgba(230,230,235,0.75)", 13);
    ctx.restore();
    return;
  }

  drawRarityGlow(ctx, cardX, cardTop, cardW, cardH, card.rarityColor, 0.55);
  await drawCardArt(ctx, mod, cardX, cardTop, cardW, cardH, card.artUrl, card.rarity, card.progTier);
  drawCardFrame(ctx, cardX, cardTop, cardW, cardH, card.rarityColor, 5, card.rarity, card.progTier);
  if (!glassOff) drawGlassCase(ctx, cardX, cardTop, cardW, cardH, theme, card.rarityColor);

  // Nameplate on the plinth.
  ctx.save();
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const nameY = cy + plinthH + 10;
  const nameSize = fitText(ctx, card.name, cardW + 40, 16, 11, TITLE_FONT);
  drawTitle(ctx, card.name, cx, nameY, "#ffffff", nameSize);
  drawTextWithShadow(ctx, card.rarityLabel.toUpperCase(), cx, nameY + 16, hexToRgba(card.rarityColor, 1), 11);
  ctx.restore();
}

// A defender: a card rendered as an upright standee figure standing on an
// isometric base (Kenney base sprite when available, else a procedural disc).
async function drawDefender(
  ctx: Ctx, mod: CanvasMod, cx: number, cy: number, def: HqRenderDefender, theme: HqTheme,
): Promise<void> {
  // Base.
  let baseTopY = cy; // where the figure's feet rest
  const baseImg = def.basePath ? await loadSprite(mod, def.basePath).catch(() => null) : null;
  ctx.save(); ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.beginPath(); ellipse(ctx, cx, cy, 46, 16); ctx.fill(); ctx.restore();
  if (baseImg) {
    const iw = Math.max(1, (baseImg as { width: number }).width);
    const ih = Math.max(1, (baseImg as { height: number }).height);
    const w = 120, h = w * (ih / iw);
    blit(ctx, baseImg, cx - w / 2, cy - h + 8, w, h);
    baseTopY = cy - 16; // stand the figure back on the base top so the plate shows
  } else {
    // Procedural round base.
    ctx.save();
    ctx.fillStyle = hexToRgba(theme.palette.accent, 0.45);
    ctx.beginPath(); ellipse(ctx, cx, cy, 44, 15); ctx.fill();
    ctx.fillStyle = hexToRgba(theme.palette.accent, 0.28);
    ctx.beginPath(); ellipse(ctx, cx, cy - 5, 44, 15); ctx.fill();
    ctx.strokeStyle = hexToRgba(theme.palette.accent, 0.8); ctx.lineWidth = 1.5;
    ctx.beginPath(); ellipse(ctx, cx, cy - 5, 44, 15); ctx.stroke();
    ctx.restore();
    baseTopY = cy - 8;
  }

  // Standee figure: a tall rounded-top panel carrying the card art, tinted by
  // rarity, standing on the base.
  const fw = 74, fh = 104;
  const fx = cx - fw / 2, fy = baseTopY - fh;
  ctx.save();
  ctx.shadowColor = hexToRgba(def.rarityColor, 0.6); ctx.shadowBlur = 14;
  standeePath(ctx, fx, fy, fw, fh);
  ctx.fillStyle = "#0d0f14"; ctx.fill();
  ctx.restore();

  ctx.save();
  standeePath(ctx, fx, fy, fw, fh);
  ctx.clip();
  await drawCardArt(ctx, mod, fx, fy - 6, fw, fh + 12, def.artUrl);
  // Bottom gradient for the nameplate legibility.
  const g = ctx.createLinearGradient(0, fy + fh - 34, 0, fy + fh);
  g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.8)");
  ctx.fillStyle = g; ctx.fillRect(fx, fy + fh - 34, fw, 34);
  ctx.restore();

  // Rarity border.
  ctx.save();
  standeePath(ctx, fx, fy, fw, fh);
  ctx.strokeStyle = hexToRgba(def.rarityColor, 0.95); ctx.lineWidth = 3; ctx.stroke();
  ctx.restore();

  // Name label on the figure.
  ctx.save();
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const size = fitText(ctx, def.name, fw - 8, 13, 9, TITLE_FONT);
  drawTitle(ctx, def.name, cx, fy + fh - 14, "#ffffff", size);
  ctx.restore();
}

// ── Companion (pet) — procedural little creature standing in the scene ─────────
// Drawn by `kind`; feet rest at (cx, feetY). Purely cosmetic. `scale` sizes it
// (~1.0 in a room, a touch smaller on the sprawling base).
function drawCompanion(ctx: Ctx, cx: number, feetY: number, comp: HqRenderCompanion, scale = 1): void {
  const s = scale;
  const outline = "rgba(0,0,0,0.38)";
  const fill = (c: string) => { ctx.fillStyle = c; };
  const stroke = () => { ctx.strokeStyle = outline; ctx.lineWidth = 2 * s; ctx.stroke(); };
  const eye = (ex: number, ey: number, r: number) => {
    ctx.beginPath(); ellipse(ctx, ex, ey, r, r); fill("#f7fbff"); ctx.fill();
    ctx.beginPath(); ellipse(ctx, ex + 0.6 * r, ey, r * 0.5, r * 0.6); fill("#12161c"); ctx.fill();
  };

  // Contact shadow.
  ctx.save();
  fill("rgba(0,0,0,0.30)");
  ctx.beginPath(); ellipse(ctx, cx, feetY, 26 * s, 8 * s); ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.lineJoin = "round";
  switch (comp.kind) {
    case "wolf":
    case "cat": {
      const big = comp.kind === "wolf";
      const bodyW = (big ? 52 : 44) * s, bodyH = (big ? 26 : 22) * s;
      const bcx = cx, bcy = feetY - bodyH - 10 * s;
      // Legs.
      fill(comp.body);
      for (const lx of [-bodyW * 0.32, -bodyW * 0.12, bodyW * 0.12, bodyW * 0.32]) {
        ctx.beginPath(); roundRectPath(ctx, bcx + lx - 3 * s, bcy + bodyH * 0.3, 6 * s, 20 * s, 3 * s); ctx.fill(); stroke();
      }
      // Body.
      ctx.beginPath(); ellipse(ctx, bcx, bcy, bodyW / 2, bodyH); fill(comp.body); ctx.fill(); stroke();
      // Tail.
      ctx.beginPath();
      ctx.moveTo(bcx - bodyW / 2, bcy);
      ctx.quadraticCurveTo(bcx - bodyW * 0.85, bcy - (big ? 6 : 22) * s, bcx - bodyW * (big ? 0.7 : 0.55), bcy - (big ? 20 : 34) * s);
      ctx.lineWidth = (big ? 9 : 5) * s; ctx.strokeStyle = comp.body; ctx.lineCap = "round"; ctx.stroke();
      ctx.lineCap = "butt";
      // Head.
      const hx = bcx + bodyW * 0.42, hy = bcy - bodyH * 0.5;
      ctx.beginPath(); ellipse(ctx, hx, hy, 15 * s, 14 * s); fill(comp.body); ctx.fill(); stroke();
      // Ears.
      fill(comp.accent);
      for (const dir of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(hx + dir * 6 * s, hy - 10 * s);
        ctx.lineTo(hx + dir * (big ? 12 : 14) * s, hy - (big ? 22 : 26) * s);
        ctx.lineTo(hx + dir * 13 * s, hy - 8 * s);
        ctx.closePath(); ctx.fill(); stroke();
      }
      // Muzzle + eyes.
      ctx.beginPath(); ellipse(ctx, hx + 8 * s, hy + 3 * s, 6 * s, 5 * s); fill(comp.accent); ctx.fill();
      eye(hx + 3 * s, hy - 1 * s, 3 * s);
      eye(hx + 11 * s, hy - 1 * s, 3 * s);
      break;
    }
    case "owl": {
      const bcx = cx, bcy = feetY - 30 * s;
      // Feet.
      fill(comp.accent);
      for (const dx of [-8, 8]) { ctx.beginPath(); roundRectPath(ctx, bcx + dx * s - 3 * s, feetY - 8 * s, 6 * s, 8 * s, 2 * s); ctx.fill(); }
      // Body (rounded).
      ctx.beginPath(); ellipse(ctx, bcx, bcy, 26 * s, 32 * s); fill(comp.body); ctx.fill(); stroke();
      // Belly.
      ctx.beginPath(); ellipse(ctx, bcx, bcy + 6 * s, 16 * s, 22 * s); fill(comp.accent); ctx.fill();
      // Wings.
      fill(comp.body);
      for (const dir of [-1, 1]) { ctx.beginPath(); ellipse(ctx, bcx + dir * 24 * s, bcy + 4 * s, 8 * s, 20 * s); ctx.fill(); stroke(); }
      // Ear tufts.
      fill(comp.body);
      for (const dir of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(bcx + dir * 12 * s, bcy - 26 * s);
        ctx.lineTo(bcx + dir * 18 * s, bcy - 40 * s);
        ctx.lineTo(bcx + dir * 20 * s, bcy - 24 * s);
        ctx.closePath(); ctx.fill(); stroke();
      }
      // Big eyes + beak.
      eye(bcx - 9 * s, bcy - 10 * s, 8 * s);
      eye(bcx + 9 * s, bcy - 10 * s, 8 * s);
      ctx.beginPath();
      ctx.moveTo(bcx, bcy - 4 * s); ctx.lineTo(bcx - 5 * s, bcy + 2 * s); ctx.lineTo(bcx + 5 * s, bcy + 2 * s);
      ctx.closePath(); fill("#f2b134"); ctx.fill();
      break;
    }
    case "sprite": {
      const bcx = cx, bcy = feetY - 34 * s;
      // Glow.
      ctx.save(); ctx.shadowColor = comp.body; ctx.shadowBlur = 22 * s;
      ctx.beginPath(); ellipse(ctx, bcx, bcy, 15 * s, 15 * s); fill(comp.body); ctx.fill(); ctx.restore();
      // Wings.
      fill(comp.accent);
      for (const dir of [-1, 1]) {
        ctx.save(); ctx.globalAlpha = 0.75;
        ctx.beginPath(); ellipse(ctx, bcx + dir * 16 * s, bcy - 4 * s, 12 * s, 20 * s, dir * 0.5); ctx.fill();
        ctx.restore();
      }
      // Core + face.
      ctx.beginPath(); ellipse(ctx, bcx, bcy, 12 * s, 13 * s); fill(comp.body); ctx.fill(); stroke();
      eye(bcx - 4 * s, bcy - 1 * s, 2.6 * s); eye(bcx + 4 * s, bcy - 1 * s, 2.6 * s);
      // Sparkles.
      fill("#ffffff");
      for (const [sx, sy] of [[-20, -18], [22, -10], [8, 20]] as const) {
        ctx.beginPath(); ellipse(ctx, bcx + sx * s, bcy + sy * s, 2 * s, 2 * s); ctx.fill();
      }
      break;
    }
    case "slime": {
      const bcx = cx, bcy = feetY;
      // Dome body.
      ctx.beginPath();
      ctx.moveTo(bcx - 28 * s, bcy);
      ctx.bezierCurveTo(bcx - 30 * s, bcy - 34 * s, bcx + 30 * s, bcy - 34 * s, bcx + 28 * s, bcy);
      ctx.closePath();
      fill(comp.body); ctx.fill(); stroke();
      // Shine.
      ctx.save(); ctx.globalAlpha = 0.5; fill(comp.accent);
      ctx.beginPath(); ellipse(ctx, bcx - 9 * s, bcy - 20 * s, 6 * s, 9 * s, -0.4); ctx.fill(); ctx.restore();
      eye(bcx - 8 * s, bcy - 14 * s, 4 * s); eye(bcx + 8 * s, bcy - 14 * s, 4 * s);
      break;
    }
    case "golem": {
      const bcx = cx, bcy = feetY - 26 * s;
      fill(comp.body); ctx.strokeStyle = outline; ctx.lineWidth = 2 * s;
      // Legs.
      for (const dx of [-11, 11]) { ctx.beginPath(); roundRectPath(ctx, bcx + dx * s - 6 * s, feetY - 16 * s, 12 * s, 16 * s, 3 * s); ctx.fill(); ctx.stroke(); }
      // Torso (chunky block).
      ctx.beginPath(); roundRectPath(ctx, bcx - 22 * s, bcy - 22 * s, 44 * s, 34 * s, 6 * s); ctx.fill(); ctx.stroke();
      // Arms.
      for (const dir of [-1, 1]) { ctx.beginPath(); roundRectPath(ctx, bcx + dir * 22 * s - 6 * s, bcy - 16 * s, 12 * s, 24 * s, 4 * s); ctx.fill(); ctx.stroke(); }
      // Cracks (accent).
      ctx.strokeStyle = comp.accent; ctx.lineWidth = 2 * s;
      ctx.beginPath(); ctx.moveTo(bcx - 6 * s, bcy - 20 * s); ctx.lineTo(bcx - 2 * s, bcy - 8 * s); ctx.lineTo(bcx - 8 * s, bcy + 2 * s); ctx.stroke();
      // Glowing eyes.
      ctx.save(); ctx.shadowColor = comp.accent; ctx.shadowBlur = 10 * s; fill(comp.accent);
      ctx.beginPath(); ellipse(ctx, bcx - 8 * s, bcy - 6 * s, 3.5 * s, 3.5 * s); ctx.fill();
      ctx.beginPath(); ellipse(ctx, bcx + 8 * s, bcy - 6 * s, 3.5 * s, 3.5 * s); ctx.fill();
      ctx.restore();
      break;
    }
    case "drake": {
      const bcx = cx, bcy = feetY - 24 * s;
      // Tail.
      ctx.strokeStyle = comp.body; ctx.lineWidth = 8 * s; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(bcx - 6 * s, bcy + 6 * s);
      ctx.quadraticCurveTo(bcx - 40 * s, bcy + 4 * s, bcx - 34 * s, bcy - 20 * s); ctx.stroke(); ctx.lineCap = "butt";
      // Legs.
      fill(comp.body);
      for (const dx of [-8, 8]) { ctx.beginPath(); roundRectPath(ctx, bcx + dx * s - 4 * s, feetY - 14 * s, 8 * s, 14 * s, 3 * s); ctx.fill(); stroke(); }
      // Body.
      ctx.beginPath(); ellipse(ctx, bcx, bcy, 24 * s, 18 * s); fill(comp.body); ctx.fill(); stroke();
      // Wings.
      fill(comp.accent);
      ctx.beginPath();
      ctx.moveTo(bcx - 2 * s, bcy - 10 * s);
      ctx.lineTo(bcx - 26 * s, bcy - 34 * s);
      ctx.lineTo(bcx - 4 * s, bcy - 26 * s);
      ctx.lineTo(bcx + 18 * s, bcy - 36 * s);
      ctx.lineTo(bcx + 12 * s, bcy - 10 * s);
      ctx.closePath(); ctx.fill(); stroke();
      // Neck + head.
      const hx = bcx + 20 * s, hy = bcy - 20 * s;
      ctx.strokeStyle = comp.body; ctx.lineWidth = 9 * s; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(bcx + 12 * s, bcy - 4 * s); ctx.lineTo(hx, hy); ctx.stroke(); ctx.lineCap = "butt";
      ctx.beginPath(); ellipse(ctx, hx, hy, 12 * s, 10 * s); fill(comp.body); ctx.fill(); stroke();
      // Snout + horns.
      ctx.beginPath(); ellipse(ctx, hx + 9 * s, hy + 2 * s, 6 * s, 5 * s); fill(comp.body); ctx.fill();
      fill(comp.accent);
      for (const dir of [0, 1]) { ctx.beginPath(); ctx.moveTo(hx - 2 * s + dir * 6 * s, hy - 8 * s); ctx.lineTo(hx + dir * 6 * s, hy - 18 * s); ctx.lineTo(hx + 3 * s + dir * 6 * s, hy - 8 * s); ctx.closePath(); ctx.fill(); }
      eye(hx + 4 * s, hy - 1 * s, 2.6 * s);
      break;
    }
  }
  ctx.restore();
}

// ── Visitor (ambient NPC) — a small procedural guest admiring the HQ ───────────
// Not persisted or earned: the hub passes a COUNT derived from prestige and the
// renderer scatters that many at fixed, out-of-the-way spots so the place feels
// lived-in. Each is a simple hooded/tunic figure tinted from a seed.
// Ambient NPC guests — drawn as stylized characters (never peg placeholders).
function drawVisitor(ctx: Ctx, cx: number, feetY: number, seed: number, scale = 1): void {
  drawProp(ctx, "npc", cx, feetY, scale, 0x3a5a8b, seed);
}

// A "standee" silhouette: rounded top, straight sides, flat bottom.
function standeePath(ctx: Ctx, x: number, y: number, w: number, h: number): void {
  const r = w / 2;
  ctx.beginPath();
  ctx.moveTo(x, y + r);
  ctx.arc(x + r, y + r, r, Math.PI, 0);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
}

// A short isometric box (used for pedestals): top diamond + two lit side faces.
function drawIsoBox(ctx: Ctx, cx: number, cyTop: number, w: number, h: number, accent: number): void {
  const hw = w / 2, hh = w / 4; // diamond half-extents (2:1)
  const top = { x: cx, y: cyTop - hh };
  const right = { x: cx + hw, y: cyTop };
  const bottom = { x: cx, y: cyTop + hh };
  const left = { x: cx - hw, y: cyTop };
  ctx.save();
  // Left face.
  ctx.beginPath();
  ctx.moveTo(left.x, left.y); ctx.lineTo(bottom.x, bottom.y);
  ctx.lineTo(bottom.x, bottom.y + h); ctx.lineTo(left.x, left.y + h); ctx.closePath();
  ctx.fillStyle = hexToRgba(accent, 0.22); ctx.fill();
  // Right face.
  ctx.beginPath();
  ctx.moveTo(right.x, right.y); ctx.lineTo(bottom.x, bottom.y);
  ctx.lineTo(bottom.x, bottom.y + h); ctx.lineTo(right.x, right.y + h); ctx.closePath();
  ctx.fillStyle = hexToRgba(accent, 0.34); ctx.fill();
  // Top diamond.
  ctx.beginPath();
  ctx.moveTo(top.x, top.y); ctx.lineTo(right.x, right.y); ctx.lineTo(bottom.x, bottom.y); ctx.lineTo(left.x, left.y);
  ctx.closePath();
  ctx.fillStyle = hexToRgba(accent, 0.5); ctx.fill();
  ctx.strokeStyle = hexToRgba(accent, 0.8); ctx.lineWidth = 1.5; ctx.stroke();
  ctx.restore();
}

// A glass display case: subtle tinted fill + rim highlight + a diagonal sheen.
function drawGlassCase(ctx: Ctx, x: number, y: number, w: number, h: number, theme: HqTheme, tint: number): void {
  ctx.save();
  roundRectPath(ctx, x - 6, y - 6, w + 12, h + 12, 12);
  ctx.clip();
  ctx.fillStyle = theme.palette.glass;
  ctx.fillRect(x - 6, y - 6, w + 12, h + 12);
  const s = ctx.createLinearGradient(x - 6, y - 6, x + w, y + h);
  s.addColorStop(0, "rgba(255,255,255,0.14)");
  s.addColorStop(0.45, "rgba(255,255,255,0.03)");
  s.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = s;
  ctx.fillRect(x - 6, y - 6, w + 12, h + 12);
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = hexToRgba(tint, 0.5); ctx.lineWidth = 2;
  roundRectPath(ctx, x - 6, y - 6, w + 12, h + 12, 12); ctx.stroke();
  ctx.restore();
}

// Draw one decoration at a screen anchor. `grounded` floor items get a soft
// contact shadow and are lifted so their base sits on the tile; wall items hang.
async function drawDecoAt(
  ctx: Ctx, mod: CanvasMod, x: number, y: number, scale: number, deco: HqRenderDeco, grounded: boolean,
): Promise<void> {
  // Card wall-art: a framed portrait of a real card, hung on the wall.
  if (deco.category === "portrait" && deco.cardArtUrl) {
    await drawCardPortrait(ctx, mod, x, y, scale, deco.cardArtUrl, deco.rarityColor);
    return;
  }
  if (deco.spritePath) {
    const img = await loadSprite(mod, deco.spritePath).catch(() => null);
    if (img) {
      const iw = Math.max(1, (img as { width: number }).width);
      const ih = Math.max(1, (img as { height: number }).height);
      const pixel = iw <= 48;
      const smooth = ctx as unknown as { imageSmoothingEnabled: boolean };
      if (pixel) smooth.imageSmoothingEnabled = false;
      if (grounded) {
        // Pixel figurines → draw as stylized NPCs instead of tiny blurry peeks.
        if (pixel) {
          drawProp(ctx, "npc", x, y, scale * (deco.scale ?? 1), deco.rarityColor, deco.seed ?? deco.slot);
          if (pixel) smooth.imageSmoothingEnabled = true;
          return;
        }
        // Kenney isometric pack is 256×512 with the subject in the lower half —
        // size so furniture reads clearly on the 7×7 room grid.
        const kind = deco.propKind ?? propKindFor(deco.category, deco.name);
        const boost = kind === "rug" ? 1.35 : kind === "npc" ? 1.15 : 1.25;
        const h = 120 * scale * boost * (ih / iw);
        const w = 120 * scale * boost;
        ctx.save(); ctx.fillStyle = "rgba(0,0,0,0.28)";
        ctx.beginPath(); ellipse(ctx, x, y, w * 0.28, w * 0.1); ctx.fill(); ctx.restore();
        blit(ctx, img, x - w / 2, y - h + 6, w, h);
      } else {
        const h = 88 * scale, w = h * (iw / ih);
        blit(ctx, img, x - w / 2, y - h / 2, w, h);
      }
      if (pixel) smooth.imageSmoothingEnabled = true;
      return;
    }
  }
  const kind = deco.propKind ?? propKindFor(deco.category, deco.name);
  drawProp(ctx, kind, x, y, scale * (deco.scale ?? 1), deco.rarityColor, deco.seed ?? deco.slot + 1);
}

// A framed card portrait hung on the wall: a shrunk copy of the real card art
// inside a rarity-tinted frame with a mat border and a little hanging nail — the
// "mini wall art of your cards" the player buys and mounts. Centred on (x,y).
async function drawCardPortrait(
  ctx: Ctx, mod: CanvasMod, x: number, y: number, scale: number, artUrl: string, tint: number,
): Promise<void> {
  const cardW = 66 * scale, cardH = 86 * scale;   // shrunk card
  const mat = 7 * scale, frame = 5 * scale;        // mat + frame thickness
  const outerW = cardW + (mat + frame) * 2, outerH = cardH + (mat + frame) * 2;
  const ox = x - outerW / 2, oy = y - outerH / 2;

  // Hanging nail + drop shadow so it reads as mounted, not floating.
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.30)";
  roundRectPath(ctx, ox + 3, oy + 5, outerW, outerH, 4 * scale); ctx.fill();
  ctx.restore();

  // Outer frame (rarity-tinted, with a soft glow).
  ctx.save();
  ctx.shadowColor = hexToRgba(tint, 0.55); ctx.shadowBlur = 14 * scale;
  ctx.fillStyle = hexToRgba(tint, 0.95);
  roundRectPath(ctx, ox, oy, outerW, outerH, 4 * scale); ctx.fill();
  ctx.restore();
  // Bevel highlight.
  ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = Math.max(1, 1.5 * scale);
  roundRectPath(ctx, ox + 1, oy + 1, outerW - 2, outerH - 2, 4 * scale); ctx.stroke();

  // White mat inside the frame.
  ctx.fillStyle = "rgba(244,244,240,0.96)";
  ctx.fillRect(ox + frame, oy + frame, outerW - frame * 2, outerH - frame * 2);

  // The card art, clipped to the window.
  const ax = ox + frame + mat, ay = oy + frame + mat;
  await drawCardArt(ctx, mod, ax, ay, cardW, cardH, artUrl);
  ctx.strokeStyle = hexToRgba(tint, 0.7); ctx.lineWidth = Math.max(1, 1 * scale);
  ctx.beginPath();
  ctx.moveTo(ax, ay); ctx.lineTo(ax + cardW, ay); ctx.lineTo(ax + cardW, ay + cardH);
  ctx.lineTo(ax, ay + cardH); ctx.closePath(); ctx.stroke();
}

// ── Procedural decorations ────────────────────────────────────────────────────
// Each category draws a compact, self-contained glyph tinted by the decoration's
// rarity colour with a soft glow. An asset pack later replaces these per id.
function drawDecoration(ctx: Ctx, ox: number, oy: number, scale: number, deco: HqRenderDeco): void {
  const s = 62 * scale;
  const col = deco.rarityColor;
  ctx.save();
  ctx.translate(ox, oy);
  ctx.shadowColor = hexToRgba(col, 0.7);
  ctx.shadowBlur = 18;

  switch (deco.category) {
    case "banner": {
      ctx.fillStyle = hexToRgba(col, 0.9);
      ctx.beginPath();
      ctx.moveTo(-s * 0.3, -s * 0.55); ctx.lineTo(s * 0.3, -s * 0.55);
      ctx.lineTo(s * 0.3, s * 0.4); ctx.lineTo(0, s * 0.55); ctx.lineTo(-s * 0.3, s * 0.4);
      ctx.closePath(); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.beginPath(); ctx.arc(0, -s * 0.05, s * 0.13, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case "emblem": {
      ctx.fillStyle = hexToRgba(col, 0.9);
      ctx.beginPath(); ctx.arc(0, 0, s * 0.42, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, s * 0.24, 0, Math.PI * 2); ctx.stroke();
      break;
    }
    case "trophy": {
      ctx.fillStyle = hexToRgba(col, 0.95);
      ctx.beginPath();
      ctx.moveTo(-s * 0.28, -s * 0.4); ctx.lineTo(s * 0.28, -s * 0.4);
      ctx.quadraticCurveTo(s * 0.28, s * 0.05, 0, s * 0.12);
      ctx.quadraticCurveTo(-s * 0.28, s * 0.05, -s * 0.28, -s * 0.4);
      ctx.closePath(); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillRect(-s * 0.06, s * 0.12, s * 0.12, s * 0.2);
      ctx.fillRect(-s * 0.22, s * 0.32, s * 0.44, s * 0.1);
      break;
    }
    case "statue": {
      ctx.fillStyle = hexToRgba(col, 0.5);
      ctx.fillRect(-s * 0.26, s * 0.2, s * 0.52, s * 0.28);
      ctx.shadowBlur = 0;
      ctx.fillStyle = hexToRgba(col, 0.95);
      ctx.beginPath(); ctx.arc(0, -s * 0.16, s * 0.14, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.02); ctx.lineTo(s * 0.16, s * 0.2); ctx.lineTo(-s * 0.16, s * 0.2);
      ctx.closePath(); ctx.fill();
      break;
    }
    case "monument": {
      ctx.fillStyle = hexToRgba(col, 0.9);
      ctx.beginPath();
      ctx.moveTo(-s * 0.12, s * 0.5); ctx.lineTo(-s * 0.06, -s * 0.55);
      ctx.lineTo(s * 0.06, -s * 0.55); ctx.lineTo(s * 0.12, s * 0.5);
      ctx.closePath(); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = hexToRgba(col, 0.5);
      ctx.fillRect(-s * 0.22, s * 0.5, s * 0.44, s * 0.12);
      break;
    }
    case "plant": {
      ctx.shadowBlur = 0;
      ctx.fillStyle = hexToRgba(0xc58b4a, 0.95);
      ctx.beginPath();
      ctx.moveTo(-s * 0.2, s * 0.12); ctx.lineTo(s * 0.2, s * 0.12);
      ctx.lineTo(s * 0.14, s * 0.5); ctx.lineTo(-s * 0.14, s * 0.5);
      ctx.closePath(); ctx.fill();
      ctx.shadowColor = hexToRgba(0x2ecc71, 0.6); ctx.shadowBlur = 12;
      ctx.fillStyle = hexToRgba(0x2ecc71, 0.95);
      for (const dx of [-0.16, 0, 0.16]) {
        ctx.beginPath();
        ellipse(ctx, dx * s, -s * 0.08, s * 0.08, s * 0.24, dx); ctx.fill();
      }
      break;
    }
    case "light": {
      ctx.shadowColor = hexToRgba(col, 0.9); ctx.shadowBlur = 26;
      ctx.fillStyle = hexToRgba(col, 0.95);
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.42);
      ctx.quadraticCurveTo(s * 0.24, 0, 0, s * 0.42);
      ctx.quadraticCurveTo(-s * 0.24, 0, 0, -s * 0.42);
      ctx.closePath(); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.beginPath(); ctx.arc(0, 0, s * 0.1, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case "case": {
      ctx.strokeStyle = hexToRgba(col, 0.9); ctx.lineWidth = 3;
      roundRectPath(ctx, -s * 0.3, -s * 0.42, s * 0.6, s * 0.84, 6); ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = hexToRgba(col, 0.16);
      roundRectPath(ctx, -s * 0.3, -s * 0.42, s * 0.6, s * 0.84, 6); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.fillRect(-s * 0.22, -s * 0.34, s * 0.12, s * 0.68);
      break;
    }
    case "crystal": {
      ctx.shadowColor = hexToRgba(col, 0.9); ctx.shadowBlur = 24;
      ctx.fillStyle = hexToRgba(col, 0.95);
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.5); ctx.lineTo(s * 0.3, -s * 0.05);
      ctx.lineTo(0, s * 0.5); ctx.lineTo(-s * 0.3, -s * 0.05);
      ctx.closePath(); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(255,255,255,0.65)";
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.5); ctx.lineTo(s * 0.12, -s * 0.05);
      ctx.lineTo(0, s * 0.18); ctx.lineTo(-s * 0.12, -s * 0.05);
      ctx.closePath(); ctx.fill();
      break;
    }
    case "rug": {
      ctx.shadowBlur = 0;
      ctx.fillStyle = hexToRgba(col, 0.85);
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.24); ctx.lineTo(s * 0.5, 0); ctx.lineTo(0, s * 0.24); ctx.lineTo(-s * 0.5, 0);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.7)"; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.16); ctx.lineTo(s * 0.34, 0); ctx.lineTo(0, s * 0.16); ctx.lineTo(-s * 0.34, 0);
      ctx.closePath(); ctx.stroke();
      break;
    }
    case "tree": {
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#5a3d22"; ctx.fillRect(-s * 0.06, s * 0.2, s * 0.12, s * 0.32); // trunk
      for (let i = 0; i < 3; i++) {
        const ty = s * 0.2 - i * s * 0.26, wsp = s * (0.34 - i * 0.07);
        ctx.fillStyle = i === 0 ? "#2f6b34" : i === 1 ? "#357a3b" : "#3d8a43";
        ctx.beginPath(); ctx.moveTo(0, ty - s * 0.34); ctx.lineTo(wsp, ty); ctx.lineTo(-wsp, ty); ctx.closePath(); ctx.fill();
      }
      break;
    }
    case "rock": {
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#8b9099"; ctx.beginPath();
      ctx.moveTo(-s * 0.34, s * 0.2); ctx.lineTo(-s * 0.16, -s * 0.24); ctx.lineTo(s * 0.14, -s * 0.28);
      ctx.lineTo(s * 0.34, s * 0.06); ctx.lineTo(s * 0.2, s * 0.2); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#a9aeb6"; ctx.beginPath();
      ctx.moveTo(-s * 0.16, -s * 0.24); ctx.lineTo(s * 0.14, -s * 0.28); ctx.lineTo(s * 0.04, -s * 0.06); ctx.lineTo(-s * 0.08, -s * 0.06); ctx.closePath(); ctx.fill();
      break;
    }
    case "fence": {
      // A short run of pickets with two rails — reads as a garden fence.
      ctx.shadowBlur = 0;
      const woody = deco.rarityColor === 0x2ecc71 ? "#3d8a43" : "#c19a5b"; // hedge vs wood tint
      ctx.strokeStyle = woody; ctx.lineWidth = Math.max(2, s * 0.05);
      const rail = (yy: number) => { ctx.beginPath(); ctx.moveTo(-s * 0.5, yy); ctx.lineTo(s * 0.5, yy); ctx.stroke(); };
      rail(-s * 0.02); rail(s * 0.18);
      ctx.fillStyle = woody;
      for (let i = -2; i <= 2; i++) {
        const px = i * s * 0.22;
        ctx.beginPath();
        ctx.moveTo(px - s * 0.05, s * 0.34); ctx.lineTo(px - s * 0.05, -s * 0.16);
        ctx.lineTo(px, -s * 0.24); ctx.lineTo(px + s * 0.05, -s * 0.16); ctx.lineTo(px + s * 0.05, s * 0.34);
        ctx.closePath(); ctx.fill();
      }
      break;
    }
    case "path": {
      // A short flagstone path segment on the ground.
      ctx.shadowBlur = 0;
      ctx.fillStyle = hexToRgba(0xb9a888, 0.95);
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.2); ctx.lineTo(s * 0.5, 0); ctx.lineTo(0, s * 0.2); ctx.lineTo(-s * 0.5, 0);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = "rgba(90,78,58,0.6)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(-s * 0.24, -s * 0.04); ctx.lineTo(0, s * 0.06);
      ctx.moveTo(0, -s * 0.06); ctx.lineTo(s * 0.24, s * 0.04); ctx.stroke();
      break;
    }
    case "flowers": {
      // A low bed of colourful blooms.
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#5a3d22";
      ctx.beginPath();
      ctx.moveTo(0, s * 0.02); ctx.lineTo(s * 0.4, s * 0.2); ctx.lineTo(0, s * 0.38); ctx.lineTo(-s * 0.4, s * 0.2);
      ctx.closePath(); ctx.fill();
      const petals = ["#e05a7a", "#f2c14e", "#8e6bd6", "#ffffff"];
      for (let i = 0; i < 5; i++) {
        const bx = (i - 2) * s * 0.15, by = s * 0.12 - Math.abs(i - 2) * s * 0.03;
        ctx.fillStyle = petals[i % petals.length]!;
        ctx.beginPath(); ctx.arc(bx, by, s * 0.07, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#f7e07a"; ctx.beginPath(); ctx.arc(bx, by, s * 0.025, 0, Math.PI * 2); ctx.fill();
      }
      break;
    }
  }
  ctx.restore();
}
