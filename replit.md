# DN Cards

DN Cards is DarkNight's collectible military trading card game for the Roblox + Discord community. Members collect cards through random drops, packs, daily rewards, trading, admin giveaways, and special events. Cards represent military vehicles, ships, aircraft, bosses, community members, and exclusive collectibles.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server + Discord bot (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required secret: `DISCORD_BOT_TOKEN` — Discord bot token

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM (enums: rarity, card_type, trade_status)
- Discord: discord.js v14
- Validation: Zod (`zod/v4`), `drizzle-zod`
- Build: esbuild (CJS bundle)

## Where things live

- DB schema: `lib/db/src/schema/cards.ts` (cards, collections, guilds, packs, daily, achievements, embeds, rarity profiles, custom rarities, dashboard users, card display overrides)
- News schema: `lib/db/src/schema/news.ts`
- Suggestions schema: `lib/db/src/schema/suggestions.ts`
- Sets admin helpers + hubs: `artifacts/api-server/src/bot/commands/sets-admin.ts`, `set-admin-hub.ts`, `sets-panel.ts` — live slash: `/set_hub`, `/set_admin` (not `/sets_admin`; there is no standalone `/sets` user command)
- Website-only admin route: `artifacts/api-server/src/routes/admin.ts` (presentation-only — `card_display_overrides` upserts)
- Public roster route (merges overrides): `artifacts/api-server/src/routes/dashboard.ts` `GET /cards`
- News route: `artifacts/api-server/src/routes/news.ts`
- Suggestions route: `artifacts/api-server/src/routes/suggestions.ts`
- Bot entry: `artifacts/api-server/src/bot/index.ts`
- Spawn manager: `artifacts/api-server/src/bot/spawn-manager.ts`
- Admin commands: `artifacts/api-server/src/bot/commands/admin.ts`
- Rarity admin (`/rarity` hub): `artifacts/api-server/src/bot/commands/rarity-admin.ts`
- Embed admin (`/embed` — show/set/reset): `artifacts/api-server/src/bot/commands/embed-admin.ts`
- User commands: `artifacts/api-server/src/bot/commands/user.ts`
- User Hub: `artifacts/api-server/src/bot/commands/user-hub.ts` (`/user-hub` — daily claim, collection, quests, wishlist, market, squad, reputation; several former standalone slash names are hub-only via `HUB_REPLACED_COMMANDS` in `register.ts`)
- Trading commands: `artifacts/api-server/src/bot/commands/trading.ts`
- Pack store: `artifacts/api-server/src/bot/commands/pack.ts`
- Daily reward handler (still used by `/user-hub` Daily; not registered as top-level `/daily`): `artifacts/api-server/src/bot/commands/daily.ts`
- Achievement engine: `artifacts/api-server/src/bot/achievements.ts`
- Wishlist handler (hub-backed): `artifacts/api-server/src/bot/commands/wishlist.ts`
- Tradein / Card Fusion (`/card_recycle`): `artifacts/api-server/src/bot/commands/tradein.ts`
- Visual config panel: `artifacts/api-server/src/bot/commands/config-panel.ts`
- Battles / raids: `artifacts/api-server/src/bot/battle/`, `artifacts/api-server/src/bot/raid/`, commands `battle.ts` / `battle-admin.ts` — `/battle`, `/battle phaser`, `/raid`, `/battle_admin`, `/raid_admin`
- Sanctuary (Quiet / Vacation / LOA): `artifacts/api-server/src/bot/quiet/` — `/quiet` (`mode:quiet|vacation|loa|stepaway`), `/quiet_setup` (see `docs/quiet-mode.md`)
- Card/rank data: `artifacts/api-server/src/bot/cards-data.ts`
- DB helpers: `artifacts/api-server/src/bot/db.ts`
- Slash command registration: `artifacts/api-server/src/bot/commands/register.ts` (source of truth for live slash names)
- Giveaway System schema: `lib/db/src/schema/giveaways.ts` (giveaways, giveaway_entries, giveaway_winners)
- Giveaway System module: `artifacts/api-server/src/bot/giveaway/` (`db.ts` CRUD, `engine.ts` progress+winner draw, `embeds.ts` UI, `manager.ts` message/claim, `hub.ts` `/giveaway` browse+admin, `sweeper.ts` auto-end/reroll, `message-hook.ts` message tracking, `prizes.ts` payout). Old `/giveaways` + `/giveaway_admin` slash names are gone — use `/giveaway`.
- Unified help hub: `artifacts/api-server/src/bot/commands/help-hub.ts` (interactive `/help` — topic dropdown, live-edited pages, animated banner; Admin page is the staff reference). Banner/palette: `artifacts/api-server/src/bot/help-banners.ts`. Rebrandable via `/embed … key:help`.
- Trade / Vault Values / card-admin / secret / casino hubs: `trade-hub.ts`, `vaultvalue-hub.ts`, `cardadmin-hub.ts`, `secret-hub.ts`, `casino.ts` — **true panel hubs** (one slash each, buttons/modals; no Discord subcommand sprawl). Handlers kept; flat slash names dropped via `HUB_REPLACED_COMMANDS`
- Bob (retired entertainment NPC) schema leftovers only: `lib/db/src/schema/bob.ts` + boot `CREATE TABLE IF NOT EXISTS bob_*` in `artifacts/api-server/src/index.ts`. The runtime module `artifacts/api-server/src/bot/bob/` is **gone** — no `/bob` slash commands are registered. Do not drop the tables without a coordinated migration.
- Headquarters (HQ) schema: `lib/db/src/schema/headquarters.ts` (player_hq, hq_unlocks, hq_displays, hq_placements, hq_defenders, hq_base_state, hq_base_attacks, hq_base_reigns, hq_world_nodes, hq_terrain)
- UnbelievaBoat addon schema: `lib/db/src/schema/unbelievaboat.ts` (ub_settings, ub_role_links, ub_store_catalog, ub_audit_log) + `lib/db/src/schema/pets.ts` (pet_settings, pets, pet_challenges, pet_care_log)
- Tatsu addon schema: `lib/db/src/schema/tatsu.ts` (tatsu_settings, tatsu_audit_log, tatsu_watchlist, tatsu_snapshots) — Discord dashboard `/tatsu`
- Trivia addon schema: `lib/db/src/schema/trivia.ts` (trivia_settings, trivia_rounds, trivia_guesses, trivia_role_holds) — Discord host `/trivia`
- UnbelievaBoat client + admin API: `artifacts/api-server/src/lib/unbelievaboat/`, `artifacts/api-server/src/routes/unbelievaboat-admin.ts` (`/api/admin/ub/*`)
- Tatsu client + Discord dashboard: `artifacts/api-server/src/lib/tatsu/`, `artifacts/api-server/src/bot/tatsu/discord-admin.ts` (`/tatsu`)
- Trivia host: `artifacts/api-server/src/lib/trivia/`, `artifacts/api-server/src/bot/trivia/` (`/trivia`)
- Tamagotchi pets: `artifacts/api-server/src/bot/pets/` (`/pet`, `/petadmin` — animated GIF care hub, UB cash shop, challenges)
- Dashboard hub: `artifacts/dashboard/src/pages/unbelievaboat-admin.tsx` at `/admin/unbelievaboat`
- Docs: `docs/unbelievaboat.md`, `docs/tatsu.md`, `docs/trivia.md`
- Headquarters engine (`/hq`): `artifacts/api-server/src/bot/hq/` — data-driven, theme-agnostic. `defs/{themes,rooms,decorations,walls,floors,backdrops,wallpapers,surfaces,companions,world,unlock-rules}.ts` (registries), `assets.ts` (procedural↔asset seam; resolves `<prefix>/<key>.png` by convention and honours `HQ_ASSETS_DIR`), `db.ts`, `engine.ts` (unlocks DERIVED from existing systems), `grid.ts` (lattice sizes). Hub UI: `artifacts/api-server/src/bot/commands/hq-hub.ts`. See `docs/headquarters.md`.
- HQ renderers: `hq/paint.ts` (shared primitives + header + emoji stripping — the canvas has no emoji font), `hq/render.ts` (isometric room + exterior base + siege), `hq/render-world.ts` (the campaign world map), `hq/render-terrain.ts` (built surfaces, water, hills + the build cursor), `hq/render-wallpaper.ts` (repeating wall coverings in iso perspective), `hq/cinematic.ts` (landscape siege intro GIF).
- HQ world campaign: `hq/world.ts` (seeds `hq_world_nodes` from the `defs/world.ts` blueprint, capture/tribute, AI garrisons synthesised from the guild card pool as real `OwnedBattleCard`s). Six AI factions hold twelve tiered territories per guild; members take them and hold them for tribute.
- HQ sieges: `hq/siege-runtime.ts` — the turn-for-turn assault. Mirrors the `/battle` turn loop (startOfTurn → wind-up frame → resolveMove → attack visual → hand over → turn clock) and reuses its move set, `combatantField`, coin toss (`renderCoinFlip`) and animation pipeline. The **muster** (prep) board lets the commander: call the **heads/tails toss** (win it and your column strikes first — decided in `playCoinToss` at Begin Assault, same flow as `/battle`), **hand-pick the column** from a strongest-first roster (`attackerPool`, capped `SIEGE_COLUMN_POOL`), equip an item, then either **Begin Assault** (drive it turn-by-turn) or **Send them in** (a headless auto-resolve — `s.headless` no-ops every render/pace so the same engine + break-rank + finish/commit path runs instantly, then DMs the commander the result, "soldiers back from the siege"). A KO breaks ONE RANK instead of ending the fight; progress is Clash-style destruction (high-water) with stars at 50% / capture / clean capture. Two embeds: castle scene + scoreboard + log on top, the battle underneath. Siege pressure (escalating shield-ignoring chip on a stalling rank) stops a bracing AI garrison being unkillable. Headless resolvers stay in `hq/siege-battle.ts` (real engine) and `hq/siege.ts` (power fallback).
- HQ siege config: `lib/db/src/schema/headquarters.ts` `hq_settings` + `hq/settings.ts` — ONE siege style per guild, set by an admin in `/hqadmin` (no user option), never asked of the attacker. Styles: `turn` (default) · `cinematic` · `classic` · `live` · `static`.
- HQ world editor: `hq/terrain.ts` (rectangle validation + CRUD), `hq/build-state.ts` (the cursor in `player_hq.stats.build`), `hq/build-options.ts` (slash choices — a leaf module so `register.ts` doesn't pull the hub into startup). Visual editor is `/hq → 🛠️ Build`; the typed half is `/hqbuild` (`artifacts/api-server/src/bot/commands/hq-build.ts`).
- HQ tooling: `pnpm --filter @workspace/scripts run hq:preview` renders every HQ canvas to files; `validate:hq` asserts the registry/blueprint/cursor invariants; `smoke:hq` builds every `/hq` section plus the `/hqadmin` server panel and checks them against Discord's payload limits (needs `DATABASE_URL`); `drive:siege` plays a whole turn-for-turn assault headlessly against fake Discord interactions; `hq:manifest` regenerates the art manifest from disk.

### Website vs Discord responsibilities

The website and Discord bot share **one database**, but each owns a distinct slice of it.

**Discord = source of truth for ALL gameplay.** The bot owns every value that
affects spawning, catching, packs, trades, burning, events, and economy:
`cards` (name, rarity, worth, burn, drop weight, image, description, limited
/event flags, max copies, packs/droppable/archived state), `rarity_profiles`,
`custom_rarities`, `card_rarity_overrides`, `embed_overrides`, `guild_settings`,
`card_events`, `collections`, `user_currency`, `trades`, `achievements_unlocked`,
`packs_*`, `daily_*`. Only the bot commands mutate these. The website is
**read-only** against `cards` and never touches the others.

**Website = presentation overrides + its own content.** The website owns:
- `card_display_overrides` — per-card display name/image/description/flavor,
  plus `hidden_from_site`, `featured`, `sort_weight`. Discord never reads it.
- `news_posts`, `suggestions` — website-only content. Discord never reads it.
- `dashboard_users`, `setup_tokens` — website auth.

The old HTTP routes and dashboard pages for per-guild rarity/embed config
(`/api/embeds`, `/api/rarity-profiles`, `/api/custom-rarities`,
`/api/card-rarity-overrides`, and the `/admin/embeds`, `/admin/rarities`,
`/admin/custom-rarities` dashboard pages) have been deleted. All writes to
those tables now happen through Discord slash commands — see
`/rarity` and `/embed` below. The website never reads or writes them.

### Card Display Overrides (Website)
- `/admin` (the "Card Manager" page) edits `card_display_overrides` **only**.
  Gameplay values are shown read-only in a side panel with a "change this in
  Discord" hint.
- Public roster (`/api/cards` via `dashboard.ts`) LEFT JOINs the overrides,
  applies them before responding, filters `hiddenFromSite`, groups by the
  website category override when present, and sorts `featured` →
  `sortWeight` desc → `id` asc.
- Storage: `card_display_overrides` — one row per `cardId` (PK FK→cards.id ON
  DELETE CASCADE). All text override columns are nullable; null = fall back
  to the card's gameplay value. `displayCategory` is website-only grouping
  and does not affect Discord rarity, drops, or inventory. Single global table
  (no `guildId`) because the website is one public showcase.
- API: `GET /api/admin/cards` returns base+override join, `PUT
  /api/admin/cards/:id/display` upserts the override, `DELETE
  /api/admin/cards/:id/display` clears it. Behind `requireDashboardAuth`.
  The router does NOT call the bot's card-cache invalidation because nothing
  on `cards` is mutated.

### News (Website)
- Public: `/news` list, `/news/:slug` detail. Reads `news_posts WHERE
  published_at IS NOT NULL` ordered by `pinned DESC, published_at DESC`.
- Admin: `/admin/news` table + editor. Routes `POST/PATCH/DELETE
  /api/admin/news[/:id]`, `GET /api/admin/news` (includes drafts).
- Storage: `news_posts` (slug UNIQUE, title, bodyMd, imageUrl, pinned,
  publishedAt nullable, authorUserId FK→dashboard_users, timestamps).
- Body is plain text + linebreaks today; markdown rendering can be added
  without a schema change.

### Suggestions (Website)
- Public form at `/suggestions`, no auth. Categories: bug_report,
  card_correction, card_suggestion, event_suggestion, website_feedback.
- Submission protections: honeypot field `website` must be empty; body
  20–4000 chars; max 3 URLs; per-ip-hash rate limit 5/10min and 20/day; 1h
  dedupe on `(ipHash, title)`.
- Privacy: `ipHash = sha256(ip + SESSION_SECRET)` is stored for rate limiting
  only and is **never returned by any API response**. When `anonymous=true`
  the submitter's Discord ID and username are also stripped from admin
  responses. When `anonymous=false` only `submitterDiscordUsername` is
  returned (never the ID).
- Admin: `/admin/suggestions` queue. `GET /api/admin/suggestions[?status=]`,
  `PATCH /api/admin/suggestions/:id` (status + adminNotes). Setting status to
  resolved/rejected/duplicate stamps `resolvedAt` + `resolvedBy`.

### Embed Customization (Dashboard)
- `/admin/embeds` page customizes all 8 bot embeds per guild: spawn, claimed, daily, pack, trade, welcome, rules, commands.
- Knobs per embed: enabled toggle · title · descriptionPrefix · footer · color (or per-rarity colors for spawn/claimed) · imageMode (default/large/thumbnail/none) · customImageUrl · showWorth/showDropChance.
- Tokens in title/footer/prefix: `{user} {username} {card} {rarity} {worth} {chance} {streak} {tier} {amount} {balance} {guild} {channel}`.
- API: `GET/PUT/DELETE /api/embeds/:guildId[/:embedKey]`, behind `requireDashboardAuth`. 60s in-memory cache in the bot, invalidated explicitly on PUT/DELETE.
- Storage: `embed_overrides` table — one row per `(guildId, embedKey)` with a permissive jsonb `config`. Helper `applyEmbedOverride` in `bot/embed-overrides.ts` owns the shape; safe to extend without migration.

### Custom Rarity Tiers (Stage 2)
- `/admin/custom-rarities` lets admins create **brand-new rarity tiers** per guild — beyond the six built-ins — and assign any existing card to them. Server 1 has no rows here so it's completely unaffected.
- Each tier has: slug (URL id), name, emoji, color, **position** (decimal — e.g. `5.5` slots between Epic & Legendary), worth, burn, dropWeight, droppable, inPacks (default false).
- **Replacement, not layering:** a card assigned to a custom tier uses the **tier's** worth/burn/dropWeight — the Stage-1 rarity profile is ignored for that card. One source of truth per card per guild.
- Storage: `custom_rarities` (`(guildId, slug)` unique) and `card_rarity_overrides` (`(guildId, cardId)` unique). Built-in `cards.rarity` is preserved untouched so removing a tier instantly reverts assigned cards.
- API: `GET/PUT/DELETE /api/custom-rarities/:guildId[/:slug]` and `GET/PUT/DELETE /api/card-rarity-overrides/:guildId[/:cardId]`, behind `requireDashboardAuth`.
- Resolver: `getRarityContext(guildId)` returns `{ profile, customBySlug, customByCard }` from a 5s cache. `applyRarityContext(card, ctx)` is THE chokepoint for `worth/burn/dropWeight` — custom override first, then Stage-1 profile, then card's own value. Used by spawn weighting, `/info`, `/list`, collection views, `/catalog`, `/burn`, `/pack` pool, `/card_recycle` ladder, `/trade` fairness, leaderboard.
- `/pack` excludes custom-tier cards by default (toggle `inPacks` true to opt in). Custom tiers with `droppable=false` are skipped by `pickRandomCard`.
- `/card_recycle` ladder is position-ordered: groups user holdings by **effective rarity key** (built-in OR custom slug), so a card moved into a custom tier won't be eligible for the built-in's fusion chain. The slash command rarity option still only exposes the six built-ins as the FROM tier.
- Deleting a tier also wipes its `card_rarity_overrides` rows (no DB-level FK on slug, done in the route).

### Per-Server Rarity Profiles
- `/admin/rarities` dashboard page lets admins override **worth / burn / drop weight** per-rarity per-guild — without editing individual cards.
- Storage: `rarity_profiles` table — one row per `(guildId, rarity)` with nullable `worthValue` / `burnValue` / `dropWeight`. A null column means "use the card's value".
- API: `GET/PUT/DELETE /api/rarity-profiles/:guildId[/:rarity]`, behind `requireDashboardAuth`. 5s per-guild in-memory cache in the bot, invalidated explicitly on PUT/DELETE.
- Resolver: `getRarityProfile(guildId)` → `RarityProfileMap`; `applyRarityProfile(card, profile)` swaps in the overrides. Used by spawn weighting, `/info`, `/list`, `/pack` (pool + display), `/burn` (via `burnCard`), `/collection`, leaderboard net worth, and trade fairness check.
- **Drop-weight precedence:** profile.dropWeight → guildSettings.rarityWeights → card.dropWeight. So the profile is the strongest knob.
- Servers with no profile rows (e.g. Server 1) are completely unaffected — defaults flow through unchanged.

### Per-Set Rarity Weights (Phase 4)
- Each set has an optional `rarity_weights jsonb` column — partial map of `{ rarity: weight }`. Applies **only when the set is the guild's active set**. Cards' rarity/worth/burn/dropWeight are never touched.
- Admin UI: set rarity weights via `/set_hub` / `/set_admin` (helpers live in `sets-admin.ts`; there is no `/sets_admin` slash).
- Precedence inside `pickRandomCard` (top wins):
  1. custom-tier dropWeight
  2. **active set's rarityWeights[rarity]** ← Phase 4
  3. `rarity_profiles.dropWeight`
  4. `guild_settings.rarityWeights*` (legacy)
  5. `cards.dropWeight`
- `getActiveSetSpawnPoolCached` now returns `{ cards, rarityWeights }` so the spawn path takes one DB read per 5s. Cache invalidated globally on any set-weights write (we don't know which guilds have the set active).
- Partial: tiers the admin doesn't override fall through to the rarity profile / guild defaults. Setting weight `0` *does* disable that tier while the set is active (intentional knob).

### Card Sets (spawn rotation)
- **First-class sets** (`sets` + `card_set_memberships` tables) drive random
  spawns. Each guild picks ONE `activeSetId` on `guild_settings`; random
  spawns pull **exclusively** from that set's droppable cards.
- **Option B (no active set = no random spawns)**: with no active set, or
  with an empty active set, `doSingleSpawn` returns early. Admin `/drop` and
  `/give` bypass the set check (forcedCardId path) — they always work.
- **Command surface (live):**
  - `/set_hub` — clickable set manager (create, add cards, activate spawn pool, export).
  - `/set_admin` — interactive set hub (full management with buttons/dropdowns).
  - Shared helpers remain in `sets-admin.ts` (import/export payloads, etc.). The old `/sets_admin …` subcommand slash and the read-only `/sets` user command are **not** registered.
- `pickRandomCard(weights, boosts, ctx, availableCards?)` — new 4th param is
  the pre-filtered pool (active set). Old call sites without it fall back to
  the global droppable pool for back-compat.
- Active-set spawn pool is cached 5s per guild via
  `getActiveSetSpawnPoolCached`, invalidated on any set/membership write OR
  `setActiveSet/clearActiveSet`.
- `/mass_drop` filters to the active set when one is selected (falls back to
  the global pool otherwise so testing still works).
- `/info` shows an "Active Set: ✅ / ⚠️ / none" badge so users know whether
  the displayed drop chance can actually fire right now.
- `/event start` warns (doesn't block) when the boosted card isn't in the
  active set — the boost would silently no-op.
- **Phase 7 — `cards.set_name` is gone.** Sets are now tracked exclusively
  via the first-class `sets` + `card_set_memberships` tables. The legacy
  boot-time backfill (`backfillSetsFromLegacy`) is removed. `seedDefaultCards`
  and `loadDefaultCards` join inserted cards directly to the "defaults" set.
  `importCardsFromJson` writes membership rows only.
- **Phase 5 — export/import roundtrip.**
  - Set hubs can export a single-set JSON (cards + rarity weights +
    `awardsCompletion`) or a multi-set bundle.
  - `importCardsFromJson` accepts three shapes: flat (`{cards:[…]}`),
    single-set (`{set:{…}, cards:[…]}`), and bundle (`{sets:[{set,cards}…]}`).
    It restores `rarityWeights` and `awardsCompletion` per set. Numeric
    fields on cards (worth/burn/dropWeight) are preferred over
    description-string scraping.
- **Phase 6 — set-completion achievements.**
  - Static: `set_first_complete` (1 set, +500 💠), `set_collector` (3 sets,
    +1500 💠), `set_master` (5 sets, +4000 💠) — fire across ALL sets the
    user has finished, regardless of any per-set flag.
  - Dynamic: `set_complete:<setId>` (+1000 💠) — only sets whose admin
    toggled `awardsCompletion=true` (showcase) award their own dedicated
    achievement. "Completion" = own every card in the set (collections row
    exists; shinies irrelevant).
- Legacy `/loadset`, `/listsets`, `/unloadset` were folded into the set hubs.
  Unload paths that delete cards remain destructive; delete-membership paths
  only remove set memberships.

### Limited-Time Events
- `/event start card:<Name> duration:<30m|2h|1d> [multiplier:<1.1–50>]` — boost a card's effective spawn weight. Max 14d duration, default 2× multiplier.
- `/event list` — show all active events (with end time + remaining).
- `/event stop id:<ID>` — end an event early.
- Boost is applied AFTER the rarity-tier weight override (so admins can promote a single card above its tier baseline). Stacking events on the same card multiplies their boosts.
- Activations and stops are announced (best-effort) in the configured spawn channel.

### Trade Fairness Warning
- When the proposing side's worth ratio vs the requesting side exceeds **3:1** (cards by `worthValue`, shards 1:1), the trade embed shows an orange ⚠️ banner naming the disadvantaged party. Trade still goes through if accepted — it's informational only.

### Unified Help Hub
- `/help` (and `!help`) open one interactive, ephemeral help message: an animated banner + a **topic dropdown** (Overview, Collecting, Economy, Trading & Market, Battles/Raids/Squads, Giveaways, Quests & Reputation, Echo & AFK, Admin). Picking a topic **live-edits** the same message — no new messages. The **Admin** topic is admin-gated and is the staff reference. It documents every player and admin command in one place.
- The embed is admin-rebrandable through the existing override system: `/embed set key:help field:customImageUrl|color|title|footer value:<…>` (the `help` key was added to `EMBED_KEYS`). Banner + section palette live in `help-banners.ts`; the banner is a free direct-hotlink animated GIF and swappable per guild.
- Custom-IDs are namespaced `help:*` (select `help:select`, button `help:home`) and routed in `index.ts`.

### Bob — retired (schema leftovers only)
- The Bob entertainment NPC (`/bob`, `/bob_roulette`, `/bob_talk`, `/bob_admin`, …) is **not registered** and the runtime under `artifacts/api-server/src/bot/bob/` is gone.
- Per-guild tables `bob_settings`, `bob_profiles`, `bob_progress` may still exist via `lib/db/src/schema/bob.ts` and boot SQL in `artifacts/api-server/src/index.ts`. Leave them until a deliberate migration drops them — they are unused by the live bot.
- Do not confuse Bob with **`/minigames`** (Wild Mini-Games admin panel) or emoji assets named “bobble” / card art — those are unrelated.

### Giveaway System (add-on)
- Purely additive feature powered by DN Cards. Admins run giveaways with custom prizes; players earn chances through real gameplay. Three per-guild tables (`giveaways`, `giveaway_entries`, `giveaway_winners`); nothing in the core card/battle/raid/echo tables is modified.
- **Prizes** (any mix): `shards`, `pack` (basic/premium/legendary ×N), `card:<Name> xN` (minted via the real `catchCard` path), `nitro`, `role` (auto-assigned on claim), `custom`. Card/pack/shard prizes auto-fulfill through the existing economy; nitro/custom produce an admin hand-off receipt.
- **Requirements** measure activity from when the giveaway goes active, fed by fire-and-forget hooks on the SAME flows quests use: `catch` (rarity-gatable), `burn`, `pack_open`, `battle_win`, `battle_played` (valid, non-forfeit), `raid_join`, `raid_damage`, `echo_use`, `message` (anti-spam: bots/commands ignored, one counted msg per member per 12s).
- **Winner modes:** `entry` (weighted random by earned 🎟️ entries — `*N` per unit, `+N` on completion) or `completion` (must finish every requirement). **Difficulty:** easy/medium/hard/legendary (cosmetic tier + color).
- **UI (raid-style):** one channel message updates in place while entrants join, then the SAME message is edited into a winner announcement with a **Claim Prize** button. Buttons: My Progress / Enter (open giveaways) / Details / Claim. Times use Discord `<t:unix:…>` so every viewer sees their local timezone with no stored preference.
- **Claim + reroll:** winners claim within `claimTimerMinutes` (default 24h); the minute sweeper (`giveaway/sweeper.ts`) auto-ends due giveaways, draws winners, and rerolls unclaimed slots. Admins reroll from `/giveaway` → Admin. Announce via channel / DM / both.
- **Commands:** single hub **`/giveaway`** (browse active giveaways + standing; Admin tools for quick-create, end, cancel, reroll). Replaces the old `/giveaways`, `/giveaway progress`, and `/giveaway_admin` slash sprawl.
- **DB push:** new tables require `pnpm -C lib/db run push` after deploy.

### Sanctuary (Quiet / Vacation / LOA)
- Quarantine-role isolation so a member can step away without leaving the server. Live slash: `/quiet` (`mode:quiet|vacation|loa|stepaway`), `/quiet_setup`. Staff can force-in/force-out with `/quiet user:@Member`. See `docs/quiet-mode.md`.

## Architecture decisions

- Bot runs inside the same Express server process (startBot() called from index.ts) — keeps infra simple, one workflow to manage.
- **Command split:** Setup/config commands use `!` prefix (text commands). Quick admin actions + all user commands use slash commands.
- **Flat slash commands + hubs:** commands register as standalone top-level names (`/burn`, `/setup`, `/user-hub`, `/battle`, `/trade`, `/vaultvalue`, `/cardadmin`, `/secret`, …) — NOT nested under `/cards …` / `/admin …`. `register.ts` `buildCommands()` flattens + applies `COMMAND_RENAMES`, then drops `HUB_REPLACED_COMMANDS` (daily/collection/wishlist/quests/market/squad, trade flats, vaultvalue flats, cardadmin flats, whisper/staff, vacation/loa, …) whose handlers remain for hub buttons / thin routers. `index.ts` routes via `USER_HUB_COMMANDS` / `ADMIN_HUB_COMMANDS` plus explicit branches (battle, quiet, giveaway, pet, casino, vaultvalue, cardadmin, secret, trade, …). Prefer `/help` for the player-facing map. Stay under Discord's 100/guild slash cap.
- Weighted random card drops: each card has a `dropWeight`; guild-specific rarity weights override per-rarity (stored as nullable ints in guild_settings).
- Multi-card spawns: `cardsPerSpawn` (1/3/5/-1=random) fires N independent spawn events with 5s gaps. `activeSpawns` is `Map<guildId, Map<spawnId, ActiveSpawn>>` to support multiple simultaneous spawns.
- Catch detection: any non-`!` message is checked against ALL active spawns for the guild (case-insensitive).
- Server owner + Discord Administrators always have admin access; additional bot admins stored in DB.
- Collector rank is based on unique cards owned (9 ranks: Recruit → Dark Commander).
- Net worth = sum of (worthValue × count) across all owned cards — used for leaderboard ranking.
- Trading is a propose/accept flow: initiator creates a DB record, target accepts/declines with the trade ID. Trades can be cards-only, shards-only, or mixed.
- Limited Edition cards have maxCopies; once totalMinted hits the cap, they cannot spawn. Admin-drop only.
- Event Exclusive cards are droppable=false and dropWeight=0 — never appear in random draws, admin-drop only.
- Burn system: destroys one copy, awards burnValue shards to user's DN Shards balance.
- `!setup` wizard: interactive multi-step setup — choose_type → channel → cooldown_number → cooldown_unit → cards_per_spawn → rarity_choice → (5 rarity steps) → test_card. Sessions stored in memory per `guildId:userId`, 5-min timeout.
- **Pack store atomic claim:** `/pack` open is a single conditional UPDATE that enforces shards ≥ cost, shared cooldown, and per-tier weekly cap (with Monday 00:00 UTC rollover applied inline via CASE). Zero rows = no state change; caller re-reads the row to explain why. Prevents TOCTOU races across concurrent opens. Failed-grant path calls `refundClaim()` to roll back shards + counters.
- **Daily atomic claim:** daily claim (via `/user-hub` → Daily) uses `INSERT … ON CONFLICT DO NOTHING` for first-time, then a cooldown-gated UPDATE for repeats. Streak resets via SQL CASE when last claim > 48h ago. Handler file: `daily.ts` (not a registered top-level slash).
- **Achievements** unlock check fires after catches, /burn, /pack, /trade-accept, daily claim, /card_recycle. Stored in `achievements_unlocked` with a unique (guild, user, key) index so the insert is idempotent.
- **Shinies** are a separate `shinyCount` column on `collections` (not a flag on individual rows) — keeps the (guild, user, card) unique index intact while letting us count shinies once at SHINY_MULTIPLIER for net worth and leaderboard. `catchCard` rolls SHINY_RATE bot-side then UPSERTs the right counter; `burnCard({shiny:true})` decrements `shinyCount` specifically so `/burn name:X all:true` can't accidentally torch rare shinies.
- **Event boosts** are read once per spawn via `getActiveEventBoosts(guildId)` (joined-and-filtered by `endsAt > NOW()`) and passed as `Map<cardId, multiplier>` into `pickRandomCard`. Stopping an event is just `UPDATE … SET endsAt = NOW()` so expired rows stay around as history.

## Product

### Card Acquisition
- **Random drops**: Cards spawn at configured intervals in the spawn channel
- **Card packs**: `/pack tier:basic|premium|legendary` — buy with DN Shards, opens 5 cards
- **Daily reward**: `/user-hub` → Daily (streak bonus); handler still in `daily.ts`, not a top-level `/daily` slash
- **Event drops**: Admin force-drops specific cards with `/cardadmin drop name:<Name>`
- **Limited-time events**: `/event start|list|stop` — admin boosts any card's spawn weight for a duration
- **Admin giveaways**: `/cardadmin give user:@User name:<Card Name>` — direct award (no shiny roll); activity giveaways via `/giveaway`
- **Trading**: `/trade user:@User offer:<card>|shards want:<card>|shards` (shows ⚠️ if value ratio > 3:1)
- **Card Fusion**: `/card_recycle` — burn/fuse path (public name for internal `tradein`)
- **Wishlists**: `/user-hub` → Wishlist (hub-backed; not a top-level `/wishlist` slash)
- **Shinies ✨**: every random/pack/tradein acquisition has a flat 0.5% chance to mint a shiny. Shiny copies count at 2× worth/burn, are tracked separately, and are **not tradeable** in v1.

### Card System
- **6 rarities**: Common (weight 60), Uncommon (25), Rare (10), Epic (4), Legendary (1), **Mythic** (0 — admin-only by default)
- **Worth values**: Common 10 → Legendary 2500 → Mythic 6000 DN Shards
- **Burn values**: Common 5 → Legendary 1250 → Mythic 3000 DN Shards (50% of worth)
- **Mythic tier**: the new top rarity. Default weight 0 (never drops randomly until admins set a weight or run an `/event`). Appears in **Legendary** packs at 0.5% by default. Trade-in: Legendary → Mythic (5 Legendaries for 1 Mythic).
- **`/rarity edit`** (admin) — rename/recolor any built-in rarity tier (including Mythic) with emoji + hex color. Old `/rarityname` is not registered.
- **Limited Edition**: Admin-created, capped at a set number of copies (4× worth/burn)
- **Event Exclusive**: Admin-drop only, never appear in random spawns (3× worth/burn)
- **Card Types**: tank, aircraft, ship, vehicle, infantry, boss, community, event, achievement, limited

### Pack Store (3 tiers)
| Tier | Default Cost | Cards | Weekly Cap | Special |
|---|---|---|---|---|
| 🥉 Basic | 250 💠 | 5 | 50/week | Standard rates (60/25/11/3.5/0.5) |
| 🥈 Premium | 750 💠 | 5 | 20/week | Boosted rare/epic, 6× legendary chance |
| 🥇 Legendary | 2,000 💠 | 5 | 5/week | **No commons**, 20× legendary chance |

- Defaults are EV-tuned (~5% house edge vs. average card worth).
- **Shared cooldown** across all tiers (default 60s, configurable).
- **Separate per-tier weekly caps** — hit Legendary cap, you can still open Basics.
- **Weekly reset**: Monday 00:00 UTC for all three buckets.
- All four knobs (cost / size / cap / shared cooldown) configurable per server via `/config → 🎴 Packs`.
- Use `/pack_stats` to see your per-tier usage, cooldown remaining, and reset countdown.

### Economy (DN Shards 💠)
- **Earned by**: burning duplicate cards (`/burn`), daily rewards via `/user-hub` (50 base + streak bonus up to +200), gifts (`/trade gift`), Card Fusion upgrades, admin awards (`/cardadmin give_shards`), achievement unlocks
- **Spent on**: `/pack` openings, `/trade` offers, `/trade gift` to other members
- Balance + all-time-earned tracked per user per guild
- Admins can deduct with `/cardadmin take_shards`

### Daily Reward
- 20h cooldown (slight grace so dailies don't drift later each day)
- 48h grace before streak resets to 1
- Base 50 💠 + (streak − 1) × 10, capped at +200 bonus
- 7-day streak unlocks the "Devotee" achievement (+1000 💠)

### Achievements (10 unlockable)
Auto-unlock with a shard reward and ephemeral notification on the triggering action.
- 🎣 First Catch (50) · 📦 Rookie 10 unique (100) · 💼 Elite 50 (500) · 🏆 Master 100 (1500)
- 🌟 Legendary Hunter — own ≥1 Legendary (750) · 👑 Sovereign — own every Legendary (5000)
- 🔥 Pyromaniac — burn 50 (500) · 🤝 Diplomat — first trade (200)
- 🎴 Pack Addict — open 10 packs (1000) · 📅 Devotee — 7-day daily streak (1000)

### Collector Progression (9 ranks)
| Rank | Emoji | Unique Cards Needed |
|---|---|---|
| Recruit | 🪖 | 0 |
| Private | ⭐ | 5 |
| Corporal | ⭐⭐ | 15 |
| Sergeant | 🎖️ | 30 |
| Lieutenant | 🔰 | 50 |
| Captain | 🏅 | 75 |
| Colonel | 🌟 | 100 |
| General | 💎 | 150 |
| Dark Commander | 👑 | 200 |

### Default Card Roster (27 cards)
Seeded on first boot. All military-themed.
- 8 Common: M4 Sherman, Jeep Willys, Dog Tags, M1 Helmet, Radio Set, Supply Truck, Recon Drone, Sandbag Bunker
- 6 Uncommon: M1 Abrams, AH-64 Apache, USS Arleigh Burke, F-16 Fighting Falcon, Bradley IFV, T-80 Objekat
- 6 Rare: F-22 Raptor, USS Nimitz, Leopard 2A7, T-14 Armata, B-2 Spirit, USS Virginia
- 4 Epic: SR-71 Blackbird, USS Gerald R. Ford, F-35 Lightning II, Night Stalker
- 3 Legendary: Darknight Titan, Operation Zero, The Warlord

## Gotchas

- The bot requires `MESSAGE_CONTENT` intent — enable in Discord Developer Portal (Bot → Privileged Gateway Intents).
- The bot requires `SERVER MEMBERS` intent — also enable in the portal.
- After changing the DB schema, always run `pnpm --filter @workspace/db run push` then `pnpm run typecheck:libs` to regenerate types before building.
- DB enums (rarity, card_type, trade_status) require `push-force` if enum values change.
- Slash commands are registered globally + per-guild on every restart. Guild commands take effect instantly; global propagation can take up to 1h on first deploy.
- Bot invite must include `applications.commands` scope so slash commands appear in the server.
- Card images for `!addcard`, `!addlimited`, `!addevent` are added via URL only (no attachment support in prefix commands). For guaranteed permanence use Imgur or similar; Discord CDN URLs are stable as long as the source message exists.
- Discord caps: 5 components per ActionRow, 5 rows per message, 4096 chars per embed description, 1024 chars per embed field value, 25 fields per embed — all enforced or budgeted in the codebase.
- `user_currency` has no unique `(guildId, userId)` index — preexisting. Race-only risk on a user's first-ever currency-creating action; new pack code uses atomic UPDATE which is safe once a row exists.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

- Pack tier naming: **Basic / Premium / Legendary** (chosen May 2026)
- Weekly caps: **separate per tier** (not shared)
- Pack cooldown: **shared across all tiers**
- Default pricing: **EV-fair** (~5–10% house edge)

## Bot Commands Reference

Card catching is text-based — when a card spawns, type its name exactly to catch it.

Slash names below match `register.ts` `buildCommands()` (after renames + hub filtering). Prefer **`/help`** and **`/user-hub`** for the full surface.

### Player hubs & collecting
| Command | Description |
|---|---|
| `/user-hub` | Profile hub: daily claim, collection, quests, wishlist, market, squad, reputation |
| `/help` | Interactive command guide |
| `/collection-hub` | Browse / filter owned cards |
| `/welcome` | Public Welcome / Rules / Commands intro |
| `/info name:<Name>` | Card details, worth, burn value, drop chance |
| `/list` · `/catalog` | Full roster · browse by category |
| `/top` | Net-worth leaderboard (+ pack openers) |
| `/burn name:<Name> [shiny:true]` | Burn a card for DN Shards |
| `/shards [user]` | Check shard balance |
| `/pack tier:<basic\|premium\|legendary>` | Open a pack |
| `/pack_stats` | Pack costs, weekly caps, cooldown |
| `/card_recycle` | Card Fusion / star-rank recycle |
| `/trade` | Trade hub — propose, pending, history, accept, decline, gift |
| `/lock` · `/level` · `/collector` | Lock cards · battle level · spawn ping role |
| `/begin` | Onboarding |
| `/funfact` | Fun facts |
| `/vaultvalue` | Vault Values prices + calculator ([valuevaultx.com](https://valuevaultx.com)) |
| `/secret` | Encrypted Echo — whisper / staff |
| `/casino` | UnbelievaBoat casino hub |

### Battles, HQ, giveaways, sanctuary
| Command | Description |
|---|---|
| `/battle` | Fights, raids, sieges, profile — includes **`/battle phaser`** (Discord Activity) |
| `/raid` | Co-op raid entry |
| `/hq` · `/hqbuild` | Personal Headquarters |
| `/giveaway` | Giveaway hub (browse + admin tools) |
| `/quiet` | Sanctuary (`mode:quiet|vacation|loa|stepaway` — run again to leave) |
| `/afk` · `/echo` | AFK Secretary / Echo-Whisper config |
| `/pet` | Tamagotchi pets (when enabled) |

> **Hub-only (handlers kept, not top-level slash):** daily, collection, calendar, frame, rank, achievements, market, squad, quests, wishlist, rep, search — use `/user-hub` (and `/top` for leaderboard). Also folded: trade flats → `/trade`; vaultvalue flats → `/vaultvalue`; card create/give/drop → `/cardadmin`; whisper/staff → `/secret`; vacation/loa → `/quiet mode:…`.
>
> **Removed from live registration:** Bob (`/bob`, `/bob_*`, `/bob_admin`). Schema/boot leftovers may remain.

### Staff / admin
| Command | Description |
|---|---|
| `/setup` · `!setup` | Guided server setup |
| `/config` | Visual config panel |
| `/admin_hub` | Admin toolbox · **`/help` → Admin** for the full reference |
| `/cardadmin` | Create / edit / give / drop (upload · Kitsu · Vault Values) |
| `/battle_admin` · `/raid_admin` · `/hqadmin` | Combat / HQ staff tools |
| `/set_hub` · `/set_admin` | Card sets / spawn rotation |
| `/event` | Limited events |
| `/rarity` · `/embed` | Rarity tiers · embed branding |
| `/quiet_setup` · `/afk_setup` | Sanctuary / AFK setup |
| `/quiet user:@Member` | Place into sanctuary or force out |
| `/minigames` | Wild Mini-Games admin panel (not Bob) |
| `/collector_role` · `/mass_role` | Roles |
| `/progression_default` · `/progression_card` | Arrival star/level defaults |
| `/echo` | Echo-Whisper config |
| `/vaultvalue postcalc` | Post persistent Vault Values calculator hub |
| `/petadmin` | Pet admin (when pets enabled) |
| `/unbelievaboat` | UnbelievaBoat Discord admin dashboard |

### Setup & Config Commands (`!` prefix — admin only)
| Command | Description |
|---|---|
| `!setup` | Interactive setup wizard (channel → interval → cards per drop → rarity → test card) |
| `!setchannel #channel` | Set spawn channel |
| `!setinterval <time>` | Fixed interval (e.g. `30m`, `1h`, `2h`) |
| `!setinterval random <min> <max>` | Random interval range (e.g. `10m 60m`) |
| `!setwindow <time>` | Catch window duration |
| `!setdrops 1\|3\|5\|random` | Cards per spawn batch |
| `!setrarity <rarity> <weight>` | Customize drop weight for a rarity tier |
| `!spawnenable` / `!spawndisable` | Toggle auto-spawning |
| `!tradingenable` / `!tradingdisable` | Toggle trading |
| `!settradechannel #channel` | Set dedicated trade channel |
| `!addcard <rarity> <Name> \| <desc>` | Add a standard card |
| `!addlimited <rarity> <maxcopies> <Name> \| <desc>` | Add limited edition card |
| `!addevent <rarity> <Name> \| <desc>` | Add event exclusive card |
| `!removecard <Name>` | Remove a card from the pool |
| `!addadmin @User` | Grant bot admin access |
| `!removeadmin @User` | Revoke bot admin access |
| `!listadmins` | List bot admins |
| `!settings` | View current server configuration |

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
