# UnbelievaBoat addon

Addon for DN Cards — does **not** replace shards, packs, or the existing bot. Public results post **as UnbelievaBoat** (channel webhook).

## Money

Bets and store purchases spend **cash first, then bank** via the UnbelievaBoat API. Wins credit **cash**.

Casino vault:

| Command | Effect |
| --- | --- |
| `/casino deposit amount:` | Cash → bank |
| `/casino withdraw amount:` | Bank → cash |
| `/casino balance` | Wallet view |

## Cooldowns + payouts (Casino station)

UnbelievaBoat’s Discord `set-cooldown` / `set-game-cooldown` settings are **not** on their public REST API. Configure **ours** in `/unbelievaboat` → **Casino station**:

| Command | Default CD | Default payout |
| --- | --- | --- |
| Cash Check-In (`/daily_ub`) | 20h | 100–250 |
| Role collect | 24h | perk `income_amount` |
| Work | 4h | 20–250 |
| Crime | 4h | win 250–700 · 55% fail · fine ≥10 (1–2% wallet) |
| Beg | 4h | 55% pity · 15–104 |
| Rob | 24h | 40% success · steal 25–500 · fail fine 50–199 |
| Games (BJ/slots/…) | 4 plays / 5 min | bet multipliers (unchanged) |

Pick a command in the dropdown → edit cooldown + payout fields. Cooldown accepts human times:
`30m`, `4h`, `daily`, `90s`, or a bare number of **minutes** (not seconds). **Reset all defaults** restores factory values.

### Prefix games (per guild)

Default games prefix is `.` (separate from the admin/card prefix `!`):

```text
.slots 100
.blackjack 50
.daily
.rob @user
.setgamesprefix .     # via admin prefix: !setgamesprefix .
!setprefix !          # admin/card commands
```

Change either prefix per guild; they must not be identical.

## Discord dashboard — `/unbelievaboat`

Leaderboard · adjust/set cash · toggles · add perk (with **collect income**) · **Casino station** (cooldowns + payouts) · **log channel** · **rob immunity roles** · pets tools.

## Player hub — `/casino`

All player economy/casino actions live under **`/casino`** (full floor dashboard).
**Also:** 18 short aliases ending in **`_ub`** (`/daily_ub`, `/slots_ub`, …) — Discord
forces lowercase, so the suffix avoids colliding with DN `/daily` (shards).

| Subcommand | Notes |
| --- | --- |
| `daily` | Animated Cash Check-In — coins reverse-collect into wallet |
| `collect` | Role income from owned perk roles (animated) |
| `deposit` / `withdraw` | Casino vault |
| `blackjack` | Interactive 21 — Hit / Stand / Double Down |
| `higherlower` · `redblack` | Card guesses |
| `roulette` · `slots` | Table games |
| `uno` | Mini UNO vs house — buttons, 2× pot |
| `russian` · `rob` · `beg` | Challenge / stick-up (honors immunity) / PG beg |
| `work` · `crime` | Income |
| `store` | Role perk store |
| `top` | Dex N Cards × UnbelievaBoat animated leaderboard |
| `games` | Menu |

Floor webhooks append `_▶️ Run \`/…_ub\` · all tables: \`/casino\`` so bystanders see the slash.

## Logs

`/unbelievaboat` → **Log channel** — universal economy/casino logs (avatar, timestamp, action). Categories: economy · games · trades · quiet · admin · bot.

## Rob immunity

`/unbelievaboat` → **Rob immunity** — pick Discord roles that `/casino rob` cannot target.

## Schema

`ub_settings` · `ub_game_state` · `ub_role_links` · `ub_store_catalog` · `ub_audit_log`
(plus columns like `log_channel_id`, `rob_immune_role_ids`, `cooldowns`, `payouts`, `daily_min`/`daily_max`).

On Railway, `start-production.mjs` + boot migrations `CREATE TABLE IF NOT EXISTS` these
on every redeploy when drizzle push is skipped — no manual push needed. See `docs/railway.md`.

## Slash command budget

`/casino` hub + 18 `*_ub` shortcuts ≈ **78** chat-input (under Discord’s 100). Prefer new
games as `/casino` subcommands (max 25 per command) instead of more top-level names.
Slash registration runs automatically on bot login — redeploy is enough.

## Secrets

`UNBELIEVABOAT_TOKEN` · bot needs **Manage Webhooks** for public UnbelievaBoat posting.
