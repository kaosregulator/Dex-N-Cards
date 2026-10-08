# UnbelievaBoat addon

Addon for DN Cards — does **not** replace shards, packs, or the existing bot. Public results post **as UnbelievaBoat** (channel webhook). Role pills on the floor use **no role pings** (`allowedMentions` strips roles).

## Money

Bets and store purchases spend **cash first, then bank** via the UnbelievaBoat API. Wins credit **cash**.

Casino vault (slash shortcuts — `/casino` itself is a **button hub**, not nested subcommands):

| Command | Effect |
| --- | --- |
| `/deposit_ub` · `.dep` / `.dep all` | Cash → bank |
| `/withdraw_ub` · `.with` / `.wd` | Bank → cash |
| `/bal_ub` · `.bal` | Wallet view |

## Cooldowns + payouts (Casino station)

UnbelievaBoat’s Discord `set-cooldown` / `set-game-cooldown` settings are **not** on their public REST API. Configure **ours** in `/unbelievaboat` → **Casino station**:

| Command | Default CD | Default payout |
| --- | --- | --- |
| Cash Check-In (`/daily_ub`) | 20h | 100–250 |
| Role collect | **Per-role** (`meta.collectCooldownSec`); guild value is fallback for unset roles only | perk `income_amount` |
| Work | 4h | 20–250 |
| Crime | 4h | win 250–700 · 55% fail · fine ≥10 (1–2% wallet) |
| Beg | 4h | 55% pity · 15–104 |
| Rob | 24h | 40% success · steal 25–500 · fail fine 50–199 |
| Games (BJ/slots/…) | 4 plays / 5 min | bet multipliers (unchanged) |

Pick a command in the dropdown → edit cooldown + payout fields. **Collect** opens
**Roles & economy** (per-role timers); use **Collect fallback default** only for roles
with no custom CD. Cooldown input: `30m`, `4h`, `daily`, `90s`, or a bare number of
**minutes**. **Reset all defaults** restores station factory values (does **not** wipe
per-role collect timers).

### Prefix games (per guild)

Default games prefix is `.` (separate from the admin/card prefix `!`).
Short aliases match UnbelievaBoat habits (also: `.help` for the in-chat cheat-sheet):

```text
.bj 50                 # also .blackjack / .21
.slots 100 · .uno 50 · .roulette 50 red
.dep / .dep all        # deposit cash → bank
.with / .wd            # withdraw
.col / .daily / .bal / .paycheck
.work · .crime · .beg
.hl 50 · .rb 50 red
.rr @user 50           # challenge
.rr ai @user 50        # avatar / AI duel (bots OK)
.rob @user
.top · .store
.setgamesprefix .      # via admin prefix: !setgamesprefix .
!setprefix !           # admin/card commands
```

Change either prefix per guild; they must not be identical.

## Discord dashboard — `/unbelievaboat`

Leaderboard · **Edit user** (cash, bank, reason — add/subtract, set exact, or clear cash / bank / both to 0) · toggles · **Roles & economy** (per-role collect CD / income, **Pick in chat** Discord emoji/GIF icons, Sync UB / Seed collect) · **Casino station** (cooldowns + payouts) · **log channel** · **rob immunity roles** · pets tools.

The website hub (`/admin/unbelievaboat` → **Edit user**) shows the same Update Balance fields. Rank and total are read-only. UnbelievaBoat has no wipe-user endpoint; clear uses [Update Balance](https://api-docs.unbelievaboat.com/reference/patch-user-balance) / set-balance with `0`.

Store icons: unicode, guild emoji, Discord attachment, or Tenor/Giphy paste — animated images play on the store board (meta `animated` + host sniff).

## Player hub — `/casino`

All player economy/casino actions live under **`/casino`** (full floor **button** dashboard).
**Also:** 18 short aliases ending in **`_ub`** (`/daily_ub`, `/slots_ub`, `/blackjack_ub`, `/collect_ub`, …) — Discord
forces lowercase, so the suffix avoids colliding with DN `/daily` (shards).

| Floor action | Notes |
| --- | --- |
| Daily | Animated Cash Check-In — coins reverse-collect into wallet |
| Collect | Role income from owned perk roles (animated; role pills, no pings) |
| Deposit / Withdraw | Casino vault |
| Blackjack | Interactive 21 — shuffle → one-shot deal → Hit / Stand / Double (GIF settles to PNG) |
| Higher/Lower · Red/Black | Card guesses |
| Roulette · Slots | Table games |
| UNO | Mini UNO vs house — buttons, 2× pot |
| Russian · Rob · Beg | Challenge or AI avatar duel / stick-up (honors immunity) / PG beg |
| Work · Crime | Income |
| Store | Role perk store |
| Top | Dex N Cards × UnbelievaBoat animated leaderboard |

Floor webhooks append `_▶️ Run \`/…_ub\` · all tables: \`/casino\`` so bystanders see the slash.

## Logs

`/unbelievaboat` → **Log channel** — universal economy/casino logs (avatar, timestamp, action). Categories: economy · games · trades · quiet · admin · bot.
Log embeds may show role pills but **do not ping** roles.

## Rob immunity

`/unbelievaboat` → **Rob immunity** — pick Discord roles that rob cannot target.

## Schema

`ub_settings` · `ub_game_state` · `ub_role_links` · `ub_store_catalog` · `ub_audit_log`
(plus columns like `log_channel_id`, `rob_immune_role_ids`, `cooldowns`, `payouts`, `daily_min`/`daily_max`).

On Railway, `start-production.mjs` + boot migrations `CREATE TABLE IF NOT EXISTS` these
on every redeploy when drizzle push is skipped — no manual push needed. See `docs/railway.md`.

## Slash command budget

`/casino` hub + 18 `*_ub` shortcuts ≈ **78** chat-input (under Discord’s 100). Prefer new
games as `/casino` panel buttons (or reuse an existing `*_ub`) instead of more top-level names.
Slash registration runs automatically on bot login — redeploy is enough.

## Secrets

`UNBELIEVABOAT_TOKEN` · bot needs **Manage Webhooks** for public UnbelievaBoat posting.
