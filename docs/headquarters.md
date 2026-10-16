# DN Cards — Player Headquarters (HQ)

A persistent, per-server **Headquarters**: every player's customizable home and
showcase, and the answer to *"what has this player accomplished?"* Cards stay the
centerpiece — the HQ is where you **display** them. Purely additive: its own
tables (`player_hq`, `hq_unlocks`, `hq_displays`, `hq_placements`,
`hq_defenders`, `hq_base_state`, `hq_base_attacks`, `hq_base_reigns`,
`hq_world_nodes`, `hq_terrain`) and the `/hq` and `/hqadmin`
commands. HQ progression is **derived** from the systems you already play
(collection, battles, raids, achievements, daily streak), so nothing is
duplicated and existing players are back-filled the first time they open `/hq`.

**Phase 1** shipped the generic engine plus one polished **Trophy Hall**.
**Phase 2** builds on the same engine (no rewrite): more ways to earn
decorations, gradually-unlocking showcase rooms, slot-based decorating (you
choose the layout), and personalization (a custom HQ name + motto).

## Deployment (one step)

```bash
pnpm --filter @workspace/db push
```

On the hosted deployment every HQ table is also created idempotently in
`runBootMigrations()` (`artifacts/api-server/src/index.ts`), so a republish
provisions them with no manual push.

## Commands (`/hq`)

- `/hq` — open **your** Headquarters (ephemeral, editable). Sections:
  **Overview**, **Trophy Hall**, **Base**, **World Map**, **Build**,
  **Decorations**, **Shop**, **Rooms**, **Style**.
  - **Overview → Name your HQ** — set a custom HQ name (shown on the rendered
    banner) and a short motto. Stored in the additive `player_hq.stats` jsonb —
    no schema change.
  - **Decorations** — pick a decoration, then choose **which floor tile or wall
    spot** it goes on (or *Auto*). Placement is grid-precise: the tile is encoded
    in `hq_placements.slot` (`gy*GRID+gx` for floor, `100+i` for walls — no schema
    change), so items land exactly where you put them and picking an occupied
    spot swaps. Each room caps how many items you can display at once.
  - **🛒 Shop** — buy furniture with shards (rotates daily) or crack a **Mystery
    Crate** for a random piece. Stock includes **rugs & lighting** and the
    **Portrait Frame**.
  - **🖼️ Card wall-art** — buy the **Portrait Frame** once, then *frame any card
    you own* and hang its **real art (shrunk into a rarity-tinted frame)** on a
    wall spot. A framed card is stored as a compound placement id
    `portrait-frame:<cardId>` (so no schema change; the base id `portrait-frame`
    is what ownership/prune checks resolve to). Pick a card → pick a wall spot;
    the renderer pulls the card's live art via `drawCardPortrait`.
  - **🗺️ World Map** — a continent already held by six AI factions. March on a
    castle, take it, and it pays 💠 every hour you hold it. See
    [The world map](#the-world-map-hq--️-world-map).
  - **🛠️ Build** — the world editor. See [Build mode](#build-mode-the-world-editor).
- `/hq user:@member` — visit another member's HQ, read-only.

## Build mode (the world editor)

Slot pickers are fine for hanging a banner, but they are the wrong tool for
landscaping — you cannot see where anything is going, and a pond is not a slot.
Build mode adds **areas**: rectangles of ground stamped onto the isometric
lattice, indoors or on the grounds.

The visual editor in **`/hq → 🛠️ Build`** is the front end. It shares the cursor
(`player_hq.stats.build`), the rows (`hq_terrain`) and the validation
(`bot/hq/terrain.ts`).

- **`/hq → 🛠️ Build`** renders the canvas with **X/Y rulers** and a live neon
  **cursor**, and drives it with buttons: ⬅️⬆️⬇️➡️ to move, `W`/`H` to cycle the
  brush size, `Lift` for height, then **Place** / **Remove** / **Clear all**.
  Selects choose the material and which space to build on.

**Materials** (`bot/hq/defs/surfaces.ts`) are generic: a `kind` decides how
`render-terrain.ts` paints the rectangle, so the renderer never hardcodes what
"water" means.

| Kind | Painted as | Examples |
| --- | --- | --- |
| `flat` | A coloured patch on the floor plane | grass, dirt, stone path, sand, snow, marble inlay, red carpet, lava |
| `water` | Recessed banks, ripple arcs, a specular sheen and a bright shoreline | pond, deep water, hot spring |
| `raised` | An iso slab with two lit side walls | wood deck, stone plinth, battlement |
| `mound` | Concentric rings lofted inward into a dome | grass hill, dirt bump, sand dune, rock crag, snow drift |

**Two lattices, one painter.** The interior room is 8×8 and the outdoor grounds
are 10×10 (`bot/hq/grid.ts`); `paintTerrain` takes an `IsoProjector`, so the same
code paints a pond in a Trophy Hall and a hill on the grounds. Rectangles are
depth-sorted by their near corner and then by an explicit `z`, so a deck
correctly overlaps the paving behind it and a path can be laid *over* grass
without deleting the grass.

Limits: **8×8** tiles per rectangle, **5** steps of lift/depth, **40** surfaces
per space. Materials with a `price` are sold in the Shop's Surfaces aisle and
granted as `itemType: "material"`.

## The engine is theme-agnostic (data-driven)

The engine knows only generic concepts — **theme**, **room**, **display**,
**decoration**, **placement**. What a "Military Base" or "Castle" looks like
lives entirely in data:

- `bot/hq/defs/themes.ts` — palette, lighting, ambient particles, asset prefix.
- `bot/hq/defs/rooms.ts` — pedestal count, decoration-slot count, unlock rule.
- `bot/hq/defs/decorations.ts` — rarity, category, unlock rule, earning story.
- `bot/hq/defs/wallpapers.ts` — motif, colours, repeat density, dado/skirting.
- `bot/hq/defs/surfaces.ts` — build materials: kind, colours, texture, height.
- `bot/hq/defs/world.ts` — AI factions, territories, trade routes, tier economics.
- `bot/hq/defs/unlock-rules.ts` — one declarative `UnlockRule` union + evaluator.

**Adding a theme/room/decoration = append to a registry.** No engine changes.

## The room is an isometric scene (Phase 3)

`bot/hq/render.ts` draws a true **isometric room**: two corner walls, a diamond
floor grid, and furniture placed on floor tiles / wall faces with depth-sorted
draw order (nearer objects overlap further ones). Card pedestals are upright
display cases on iso plinths. **Walls** and **floor** are their own data-driven,
unlockable style registries (`defs/walls.ts`, `defs/floors.ts`) — the theme sets
lighting/mood while walls + floor reskin the room itself:

- `defs/walls.ts` — two face colours, trim, optional procedural windows.
- `defs/floors.ts` — a two-tone tile checker + grout colour.
- `defs/backdrops.ts` — a **backdrop** is the scene painted _behind_ the room
  (meadow, forest, autumn, desert, castle vista). Some are default; others are
  **earned** (account level, battle wins, achievements — not just drops), the
  same unlock-rule contract as walls/floors, reconciled into `hq_unlocks` as
  `itemType: "backdrop"`. The backdrop PNG cover-fits the canvas with a soft
  dark overlay; `none` renders the plain themed backdrop.
- `defs/wallpapers.ts` — **real wallpaper**: a repeating motif papered onto the
  two wall faces *in isometric perspective*, with a dado rail and skirting.
  Twelve styles ship (stripe, quatrefoil damask, floral, harlequin, chevron,
  exposed brick, wainscot panels, plaid, neon hex, circuit, starfield, plain).
  Chosen in 🎨 Style, stored as `stats.wallpaperId`, reconciled into
  `hq_unlocks` as `itemType: "wallpaper"`.

  Motifs are stamped in the wall's own `(u, v)` parameter space rather than
  blitted flat, so the pattern follows the wall's perspective at any room size.
  Dropping `wallpaper/<id>.png` into the art pack replaces the procedural motif
  with a seamless tile.

  *Migration note:* this replaces the old wallpaper, which stretched a single
  **backdrop photo** across the walls. Backdrop ids no longer resolve as
  wallpaper, so an HQ that had one set falls back to the plain wall style until
  a real wallpaper is picked — the usual resolve-to-default contract.

Everything in the Style section persists to the additive `player_hq.stats` jsonb
(no schema change): `backdropId`, plus two room-shell toggles — `wallsOff`
("outside": the walls open onto the backdrop) and `glassOff` (hide the pedestal
display cases). **Inside/Outside presets** set both in one tap (going outside also
drops the glass for an open-air showcase). Small (≤48 px) sprites render with
image-smoothing off so pixel-art figures stay crisp.

Change a wall/floor/backdrop, toggle walls/glass, or hit an Inside/Outside preset
from **`/hq` → 🎨 Style**. New styles unlock as you play.

## Rendering is separated from assets

The whole scene is drawn **procedurally**, so the feature ships with **zero
art**. Every visual first asks the asset manager
(`bot/hq/assets.ts` → `spriteForPrefix(prefix, key)`); when a bundled or uploaded
PNG exists it transparently replaces the procedural drawing. Walls, floors and
furniture each resolve by their **own** `spritePrefix`, so an art pack can
replace any subset independently — a future theme pack (Military, Anime,
Fantasy, Vehicles, …) is **assets + config only**.

### Drop-in art specs (for uploaded 2D assets)

Drop image files (`.png`, `.webp`, `.jpg`) under
`artifacts/api-server/assets/hq/` and restart. **No JSON editing is needed** —
`spriteForPrefix` resolves `<dir>/<prefix>/<key>.<ext>` by convention, so a file
lands wherever its folder and filename say it should:

| Seam | Where to put the file | Notes |
| --- | --- | --- |
| Furniture / decorations | `deco/<decorationId>.png` | Square, transparent, ~256×256. Drawn ~108 px, base-anchored on the tile. |
| Build materials | `surface/<materialId>.png` | Tiles the rectangle's top face. |
| Wallpaper | `wallpaper/<wallpaperId>.png` | A **seamless** tile; repeated `repeatX × repeatY` per wall face. |
| Wall faces | `<wallPrefix>/wall.png` | e.g. `wall/windowed/wall.png`. |
| Floor tiles | `<floorPrefix>/tile.png` | e.g. `floor/marble/tile.png`. |
| Buildings | `building/<role>.png` | `castle`, `keep`, `tower`, `cathedral`, `houses`, `village`, `camp`, `hut`, `wall`. Used by the world map, the base scene and the siege cinematic. |
| Defender bases | `base/round.png` | The disc a card standee stands on. |
| Backdrops | `backdrop/<backdropId>.png` | Cover-fit behind the room. |

Two escape hatches for cases the convention can't express:

- `manifest.json` still wins when present, so one file can serve several keys or
  live under a name that doesn't match its key. Regenerate it from whatever is
  on disk (credits and hand-written aliases preserved) with:

  ```bash
  pnpm --filter @workspace/scripts run hq:manifest        # add --dry to preview
  ```

- `HQ_ASSETS_DIR` overrides the pack directory outright, so a deployment can
  mount an uploaded pack from outside the repo without a rebuild.

Anything not found stays **procedural**, so a partial pack is fine — art can be
added one seam at a time.

### Previewing art changes

`pnpm --filter @workspace/scripts run hq:preview [outDir]` renders every HQ
canvas — world map, siege cinematic (as a GIF plus one still per beat), rooms
with wallpaper and built terrain, and the outdoor grounds — straight to files
using the real renderers. No database and no Discord.

## How you get decorations

Most decorations are **earned** by playing (below). Phase 3b adds two more paths
that reuse existing systems — no new grind, no parallel currency:

- **🛒 Rotating shop** (`/hq → Shop`) — furniture priced in **shards** (the same
  economy the market uses). The stock is computed deterministically from the UTC
  date (`bot/hq/shop.ts`), so it **rotates daily** with no storage or cron, and
  some items are discounted. Buying debits shards atomically and grants the item
  into the same `hq_unlocks` ledger.
- **🎁 Mystery crates** — a fixed-price shard sink (`/hq → Shop → Open Mystery
  Crate`) that grants a random furniture piece you don't own, rarity-weighted.
- **🎁 Catch drops** — a small chance (`bot/hq/drops.ts`, weighted so commons
  drop more often) that catching a card also yields a decoration, surfaced right
  on the catch card. Hooked best-effort into the catch flow — it never blocks or
  breaks a catch.

Shop/drop furniture is marked in data with `price` / `drop` and an
`unlock: { kind: "shop" }` (never auto-granted). Everything below is still
**earned**, and each carries the story of how it was earned:

| Earned from | Example decoration |
|---|---|
| First / 25 / 100 battle wins | First Blood Banner · Veteran Medals · Champion's Banner |
| Defeat a raid boss | Commander's Trophy |
| Clear the raid campaign | Hall of Heroes Monument |
| 50 / 100 unique cards | Curator's Plinth · Collector's Statue |
| Complete a card set | Set Display Case |
| Own a shiny | Shiny Prism |
| 7 / 30 / 100-day login streak | Streak Lantern · Dedication Brazier · Eternal Flame |
| Account level 25 | Founder's Obelisk |
| Own a limited-edition card | Limited Pedestal |
| 25 / 250 cards owned (with duplicates) | Welcome Rug · Archive Stacks |
| 25K / 100K-shard collection value | Treasury Crystal · Sovereign's Hoard |
| Own 10 shinies | Shiny Constellation |
| Win 250 battles | Warlord's Standard |
| Achievements (all Legendaries · first trade · Master Collector) | Sovereign's Crown · Diplomat's Seal · Collector's Crest |

Decorations use the game's own rarity tiers/colours and are **cosmetic only** —
they never affect gameplay balance. New earning conditions are just new
`UnlockRule` kinds (`totalCards`, `netWorth`, `achievement`, …) evaluated against
the same derived snapshot — no new grind and no call-site edits.

## How progression works (no new grind)

`bot/hq/engine.ts` builds one `HqProgress` snapshot by reusing the existing
readers (`getPlayerProfile`, `getUserCollection`, `getCompletedSetIds`,
`getCampaignProgress`, `getUnlockedKeys`) and idempotently records every earned
cosmetic into `hq_unlocks` on each `/hq` open — the same self-backfilling,
pull-based pattern as achievements and giveaway progress. `hq_level` is a derived
cache that rewards the breadth of what you've accomplished.

## Trophy Hall

Pin **3 featured cards** on lit pedestals in glass display cases. Opening a
featured card shows the normal DN Card view (the `/info` reveal canvas + your
level). Everyone who visits your HQ sees your pinned cards first.

## Rooms

Rooms unlock gradually as you play, giving a reason to return:

| Room | Unlocks at | Purpose |
|---|---|---|
| 🚪 Entrance | from the start | The welcome hall — always open. |
| 🏆 Trophy Hall | 10 unique cards | Pin featured cards on pedestals. |
| 🌿 Atrium | 25 unique cards | A decoration-only gallery for your favourite mementos. |
| 🏅 Hall of Fame | account level 15 | Where your hardest-won trophies stand together. |

Featured-card pedestals live in the Trophy Hall (displays are indexed by slot,
not room). The other rooms are decorating canvases — decoration placements are
stored **per room**, so each room keeps its own layout and personality.

## The exterior town base (`/hq → 🏰 Base`)

The **base** is a **separate outdoor town view**, distinct from the interior
showcase rooms: an isometric ground slab with a **keep, walls, camps and huts**,
and the player's **stationed defender cards** rendered as upright **standee
figures** out front. It's drawn by its own leaf renderer, `renderBase` (queue
label `hq-base`) in `bot/hq/render.ts`:

- Buildings are placed by **role** (keep centre-back, camps/huts on the flanks,
  wall/gate at the front) and blit their art base-anchored to a target height,
  with a **per-role procedural fallback** when no art is present — so the scene
  renders with or without an art pack.
- Everything (buildings + defenders) is **depth-sorted by screen-y** so nearer
  objects overlap further ones.

`/hq → 🏰 Base` lets a player station cards to guard the town (up to
`HQ_DEFENDER_SLOTS`), persisted in the additive `hq_defenders` table (one row per
post). **Visiting** another player renders their exterior base — *that's what an
attacker scouts*. This is the defence half; the attack/capture side
(raid-/gym-style, solo or clan co-op, reusing `bot/battle/*`) reads these
defenders and adds its own state in a later phase without changing this table.

### Art licensing note

Bundled art under `assets/hq/` is **CC0 (Kenney)** — furniture, medals and the
defender base plates — and safe to redistribute. The **`buildings/` sprites**
(keep, wall, camp, hut) are from a third-party isometric pack and are **not
CC0**; they are included **with the project owner's stated permission** and must
not be treated as freely redistributable. The renderer never depends on them —
every building has a procedural fallback — so they can be removed at any time
without breaking the base view. See `assets/hq/manifest.json` `_credits`.

## Who decides how a siege looks

**The server owner, not the attacker.** A siege used to open with "how do you
want to watch this?", which put a presentation choice in front of a gameplay
action and meant no two assaults in a server looked alike. One style is now set
for the whole guild in **`/hqadmin`** (with no `user` option), exactly like
`/battle`'s animation settings, and every siege runs that way. Members just
attack.

The panel (`hq_settings`, read through `bot/hq/settings.ts`) holds:

| Setting | Default | What it does |
| --- | --- | --- |
| Siege style | **Turn-for-Turn** | `turn` · `cinematic` · `classic` · `live` · `static` |
| Opening film | On | Roll the landscape cinematic before the assault |
| Turn clock | 45s | Seconds per move before the column presses on alone |
| Turn visuals | On | Per-turn attack frames; the STYLE follows `/battle_admin` |
| Field items | 3 | Item uses per assault |
| Turn cap | 40 | Turns before the siege is decided on ground taken |

An unknown or removed style degrades to the default rather than throwing, so
retiring one never breaks a server.

## Base siege (attack / capture mini-game)

Scout another player with `/hq user:@member` — the visit shows their **exterior
base** and stationed defenders — then **⚔️ Attack** it. The attacker's strongest
cards fight the stationed defenders in a **Siege Battle** and must drain the
commander's **life points** to **capture** the base (its banner flips red and it's **shielded** for an
hour so it can't be farmed); if the assault is broken, the walls hold.

**Combat runs the actual battle engine.** `bot/hq/siege-battle.ts`
(`simulateSiegeBattle`) drives the same turn-based combat as `/battle` —
headlessly, no click-through — over a **gauntlet**: the attacker's active card
fights the defender's active card; whoever is knocked out is replaced by their
side's next card (the survivor keeps its HP) until one side is wiped. True stats,
movesets, specials, passives, statuses, crits and KOs all apply — stats come from
the single `get_scaled_stats` entry point (level, star rank, config, and the
guild strength ladder `rarityLadderRank`), the same source of truth `/battle`
uses, so there's no separate balance surface. A turn-cap standoff is decided by
attrition progress, with a dead-even standoff favouring the defender. If the
battle system is disabled or a squad can't be built, it falls back to the power
auto-resolver (`bot/hq/siege.ts`, `resolveSiege`). A per-target attacker
**cooldown** limits repeat hits; captures lazily revert to the owner when the
shield expires.

## The siege itself (`turn` style)

A siege is a **real battle**, not a summary. It runs the same combat engine, the
same move set, the same per-turn attack frames and the same timers as `/battle`
— so anyone who has fought a battle already knows the Siege Battle loop — with a
siege layer on top. `bot/hq/siege-runtime.ts` owns it.

**Both sides take turns.** You pick a move, the board re-renders, the garrison
answers, the board re-renders again. Attack, Special, Defend, Charge, Ultimate,
Supplies and a read-only Moves reference — the same controls a battle turn has,
built from the same `availableMoves`.

**A knockout breaks a rank, it does not end the fight.** When a card falls the
next one on that side steps up and the assault grinds on, so a siege is a column
against a wall rather than a duel. Only running a whole side out ends it.

**Progress is destruction, not hit points.** Each rank is an equal slice of the
base and the rank being fought contributes its own missing HP, so the meter moves
on every good hit and jumps when a rank breaks. It is a **high-water mark** — a
defender that heals or braces can never walk it backwards. Stars follow Clash:

| Stars | Earned for |
| --- | --- |
| ★ | 50% destruction |
| ★★ | Taking the base |
| ★★★ | Taking it without losing a card |

Stars pay: loot scales 15% per star above the baseline, and a failed assault that
still wrecked half the base out-earns one that bounced off the wall.

### Siege pressure (why a turtle can't hold forever)

A braced defender gains a shield larger than a normal hit, and the battle AI
rationally braces every turn once it is hurt. In a 1v1 battle that just runs the
clock out and the turn cap decides on HP. In a siege — where the attacker must
break **every** rank to win — it made a turtling garrison literally unkillable: a
driven test spent 40 commander turns and broke zero ranks.

**Siege pressure** is the battering ram. Every commander turn a rank survives,
the ram bites deeper: chip damage that scales with how long that rank has stalled
and **ignores shields**, because bracing does nothing about a wall being
undermined (`PRESSURE_GRACE_TURNS` 2, `PRESSURE_STEP_PCT` 5, capped at 25% of max
HP per turn). A rank that trades normally dies long before pressure matters; a
rank that only turtles gets torn down. The defender's answer is **fortification**
— more HP to grind through — not an infinite guard. The same assault now resolves
in ~17 moves with all three ranks broken.

### The board

Two embeds, matching the split between "what is happening to the castle" and
"what is happening in the fight":

- **Top — the castle.** The live scene with the destruction scoreboard (three
  stars, the meter, the turn strip) painted over it, the ranks still holding, and
  the running siege log. *The picture is the log.* The castle only re-renders
  when a rank breaks or the meter crosses a 5% step; the cached buffer is re-sent
  on every edit because Discord drops attachments that aren't resent.
- **Bottom — the battle.** Both active cards' HP / energy / ultimate built from
  the very same `combatantField` renderer `/battle` uses, whose turn it is, the
  turn clock as a Discord relative timestamp, and the per-turn attack frame.

A **muster** board opens the assault (your column, the garrison, the fortification
you are up against, and the one item the column carries) — the siege equivalent
of `/battle`'s prep screen. Nothing is committed until it resolves.

## Auto-resolved siege styles

The other four styles skip the interactive fight and render the result on the
castle base scene — never a separate VS screen:

- **Cinematic** — the full opening film, then an auto-resolved animated siege.
- **Classic** — animated with **move-by-move captions** and hit flashes.
- **Static** — a single final frame.
- **Animated** — the clean animated siege with no captions.

### The siege cinematic

`bot/hq/cinematic.ts` renders a **landscape (16:9)** opening film — deliberately
a different shape from the 1120×680 room, because the shot is a wide
establishing view of a battlefield, not a diorama. It plays into the ephemeral
hub message, holds for its own runtime, and is then replaced by the battle
result. Everything is a pure function of one normalised timeline:

| Beat | `t` | What happens |
| --- | --- | --- |
| Arrival | 0.00–0.20 | Fade up, letterbox slides in, camera pushes in on the castle; the target's name and its holder title in. |
| Muster | 0.20–0.42 | The portcullis lifts, light spills from the gate, and the garrison forms a line outside it. |
| The cards | 0.42–0.66 | The raider's cards streak in from off-frame with motion trails and slam into a fan, each with a landing shockwave. |
| Deploy | 0.66–0.86 | The siege line goes up: stakes, pavise shields and braziers, while the ranks finish marching in. |
| Engage | 0.86–1.00 | Horn-blast flash, a light wipe, and the **THE SIEGE BEGINS** title card. |

The **mood** (`dawn` · `dusk` · `night` · `storm` · `snow` · `ash`) sets the sky,
the ground, the key light and the weather particles, and is derived from the
target's biome — so a volcanic citadel fights under falling ash and a frost
bastion under snow. The castle uses `building/<role>` art when the pack has it
(with ground-planted banners flanking it, since a sprite's own headroom is
unknown) and a procedural keep otherwise.

`renderCinematicStill(view, t)` renders any single beat as a PNG. It is the
fallback when GIF encoding is unavailable or blows the attachment budget, and
what the preview harness uses to check the beats frame by frame.

## The world map (`/hq → 🗺️ World Map`)

The map used to be a directory of other players' bases, which meant a new or
quiet server had nothing to attack. It is now a **campaign map that ships
already conquered**: six AI factions hold a ring of twelve territories across a
rendered continent, and members take them off the factions (and off each other).

`bot/hq/render-world.ts` draws the whole thing procedurally — ocean and swell,
a lumpy coastline with a continental shelf and beach, biome regions with
matching scatter (pines, snowcaps, dunes, reeds, ash vents, hillocks), rivers
and an inland lake, dusty trade roads between holdings, a compass rose and a
holdings tally. Every castle flies its current owner's banner and carries a name
plate with the faction tag, tier and garrison size; plates are laid out in a
second pass with collision avoidance so a crowded continent stays readable.
Castles use `building/<role>` art when available and a tier-scaled procedural
keep otherwise (a palisaded outpost at T1, a walled castle with conical corner
towers at T6).

**The blueprint is data.** `bot/hq/defs/world.ts` holds the factions, the
territories (position, biome, tier, garrison, structure, blurb), the trade
routes, the member-base anchors, and the tier economics:

| Tier | Label | Garrison level | Bounty | Tribute |
| --- | --- | --- | --- | --- |
| 1 | Outpost | ~8 | 120 💠 | 4 💠/hr |
| 2 | Redoubt | ~18 | 220 💠 | 6 💠/hr |
| 3 | Keep | ~30 | 360 💠 | 9 💠/hr |
| 4 | Stronghold | ~45 | 540 💠 | 13 💠/hr |
| 5 | Citadel | ~62 | 780 💠 | 18 💠/hr |
| 6 | Capital | ~80 | 1100 💠 | 25 💠/hr |

Adding a territory or a faction is an append to that file; `ensureWorld` creates
the missing `hq_world_nodes` rows on the next map view, so existing servers pick
it up with no migration. The table owns only **who holds what** — never where a
castle is.

**The AI garrison is real cards.** There is no AI player and no AI collection,
so `buildGarrison` synthesises defenders from the guild's own card pool: seeded
by the territory id (the same castle always fields the same faces, which makes
scouting meaningful), drawn at or above the tier's rarity floor, and scaled
through the ordinary level and star-rank knobs. They are plain
`OwnedBattleCard`s, so `simulateSiegeBattle` fights them with no AI-specific
branch. The front rank is slightly softer than the captain behind it, so a
garrison has a shape to break.

Territory attacks are logged into the same `hq_base_attacks` table keyed
`world:<nodeId>`, so the per-target cooldown and the conquest leaderboard cover
the campaign without a second log. Sieges are serialized per territory
(`withHqLock`), so two raiders clicking at once can't both capture the same
castle.

Member bases still share the map, pinned along the settled southern coast.
**Captures persist until reclaimed** — a base owner gets a Reclaim button once
the conqueror's shield lapses, and whoever loses a territory gets a DM.

**Shards while you hold.** Every base you hold pays a passive **hold-tribute** of
`TRIBUTE_PER_HOUR` (5) 💠/hr, and every **world territory** pays its tier's rate
(4 → 25 💠/hr) — minted, never drained from anyone. It's collected **pull-based**:
opening the 🗺️ World Map pays out everything owed across both and restarts the
clocks. Accrual is capped at 48h so a holding left unvisited doesn't dump a
jackpot (`tributeOwed` in `siege.ts`, `territoryTributeOwed` in `world.ts`).

**Longest-hold leaderboard + Sovereign title.** Each hold is timed; when a reign
ends (recaptured or reclaimed) it's logged to `hq_base_reigns`. The World Map
shows a **👑 Longest hold** board — each holder's best single reign, combined at
read time with any still-running reign (`now − held_since`) so a current holder
ranks live (🚩) — and crowns the #1 as the guild's **Sovereign** (`getReignLeaders`).

State is additive: `hq_base_state` (holder + shield + hold clock), `hq_base_attacks`
(log + cooldown) and `hq_base_reigns` (completed reigns → leaderboard). *Clan
co-op attacks are the next step and slot in behind the same `resolveSiege`
interface.*

## Companions & visitors (living HQ)

Two touches make a Headquarters feel alive; both render in the interior room AND
the exterior base.

- **Companions** are EARNED pets. `bot/hq/defs/companions.ts` is a data-driven
  registry (mirrors the decoration/theme registries): each companion's `kind`
  picks the procedural creature the renderer draws (`drawCompanion`) and its
  `body`/`accent` colour it, so a future asset pack can drop in real sprites with
  no code change. They're granted by the same pull-based `reconcileUnlocks`
  (itemType `"companion"` in `hq_unlocks`) as every other cosmetic — e.g. the
  **Scout Pup** for 10 battle wins, the **Wise Owl** for a 50-card collection, the
  **Ember Drake** from a raid boss. Pick your active pet in **Overview → 🐾 Choose
  a companion…** (or send it away); the choice lives in the additive
  `player_hq.stats.companionId` (no schema change) and the pet then stands in your
  room and roams your grounds.
- **Visitors** are ambient NPC guests — purely DERIVED, never stored or earned.
  The count grows with HQ prestige (`visitorCount(hqLevel)`, 0 → 4) so a
  well-developed Headquarters visibly draws a crowd; the renderer scatters that
  many procedural figures (`drawVisitor`) at out-of-the-way spots. They stay out
  of a live siege so combat stays readable.

Set-completion also feeds the earned decorations: finishing **3 / 5 / 10** whole
card sets unlocks the **Set Collector's Plinth**, **Curator's Gallery** and
**Master Archive** (`setComplete` milestones in `defs/decorations.ts`).

## Admin editor (`/hqadmin`)

Admin-gated (same check as `/admin` / `/edit-user`), with two panels:

- **`/hqadmin`** (no user) — the **server siege ruleset** above: style, opening
  film, turn clock, turn visuals, field items and turn cap.
- **`/hqadmin user:@member`** — the per-member HQ editor — all HQ-only data, never the base
game: **Set HQ level**, **Unlock everything** / **Revoke all unlocks**,
**Re-sync from progress** (runs the reconcile), **Reset base capture** (clears a
stuck flag/shield), **Clear defenders**, and **Wipe layout** (placements + built
terrain + defenders). Accessors live in `bot/hq/db.ts`, `bot/hq/terrain.ts` and
`bot/hq/settings.ts`; the command is `bot/commands/hq-admin.ts`.

## Addon boundaries (ties in without changing the base game)

This whole feature is an **addon**: it only **adds** tables, **reads** existing
systems (collection/battles/raids/achievements/rarity ladder) to derive
progress, and **reuses** the battle/animation engines. Original files are touched
only at small, additive integration seams — command registration + dispatch, one
best-effort catch-drop hook, help text, and boot migrations. Content is all
registries under `bot/hq/defs/*` and art is drop-in via the manifest, so it stays
easy to extend or tweak.

## Validation

Plain Node asserts against the real runtime modules — no test framework,
mirroring `validate:rarity`.

```bash
pnpm --filter @workspace/scripts run validate:hq   # pure logic, no database
DATABASE_URL=… pnpm --filter @workspace/scripts run smoke:hq
```

`validate:hq` covers globally unique **gated** cosmetic ids (they all share one
`hq_unlocks` ledger, so a collision between two gated items would cross-wire
them), a world blueprint whose markers actually land on the rendered landmass,
a monotonic tier ladder with no gaps, deterministic and tier-scaled AI
garrisons, capped and non-negative tribute, and a build cursor that clamps onto
whichever grid it is read against.

`smoke:hq` builds **every `/hq` section** plus the `/hqadmin` server panel and
validates the payload Discord would receive: at most five action rows, every
select carrying 1–25 options, labels and descriptions inside their limits, embed
fields under 1024 characters, and an image that actually rendered. These are the
failures a typecheck can't see and that otherwise surface as a 400 from the API
in production.

```bash
DATABASE_URL=… pnpm --filter @workspace/scripts run drive:siege [outDir]
```

`drive:siege` plays a **whole turn-for-turn assault** headlessly. The runtime
talks to Discord through only four calls (`editReply`, `fetchReply`,
`deferUpdate`, `Message#edit`), so a small stand-in for those is enough to run a
real siege from muster to result with the production combat engine, AI, castle
renderer and board. It asserts every board is a legal payload, that the
castle+battle pair holds for the whole assault, that destruction never walks
backwards, and that the outcome is self-consistent (a capture is 100% and at
least two stars; a failure can't exceed one star) — then writes the rendered
frames out. It is what caught the auto-played commander, the reversible
destruction meter and the unkillable turtling garrison.

## Future phases (same engine, no rewrite)

Faction counter-attacks that take territory back · clan co-op sieges behind the
same `resolveSiege` interface · per-room featured-card pedestals · rotation for
placed decorations · community art packs · guild HQ · weather / day-night.
