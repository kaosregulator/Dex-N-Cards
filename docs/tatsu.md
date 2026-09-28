# Tatsu addon

Addon for DN Cards — Discord dashboard for **Tatsu** score / points / leaderboards.
Does **not** replace DN shards or UnbelievaBoat. No mini-games (unlike `/casino`).

Official API: [dev.tatsu.gg](https://dev.tatsu.gg/) · Base `https://api.tatsu.gg/v1`

# Get an API key

There is **no public keyless Tatsu API**. Every client (including ours) must use a key
from Tatsu’s own Discord bot. Official docs: [dev.tatsu.gg](https://dev.tatsu.gg/).

In any Discord server with **Tatsu** invited, run:

```text
t!apikey create
```

(Some older guides say `t!apikey` — `create` is the current form.)

Put the key in env:

```env
TATSU_API_KEY=your_key_here
```

(`TATSU_TOKEN` is also accepted.)

### If you “can’t obtain” a key

- You must be able to use Tatsu’s prefix commands in a server where Tatsu is present.
- If Tatsu isn’t on your server: invite it from [tatsu.gg](https://tatsu.gg), then run `t!apikey create`.
- Keys are **per Discord user**, free, and created inside Discord — there is no paid storefront key and no scrape/workaround we can ship (that would violate Tatsu’s API rules).
- Without `TATSU_API_KEY`, `/tatsu` still loads but overview shows the link as off and live probes fail until the key is set.

**Requirements for edits:** the Discord account that owns the API key must be a **member of the guild** and have **Manage Server** (`MANAGE_GUILD`). Guild-scoped reads also require membership (anti-snooping).

**Rate limit:** 60 requests / minute. Exceeding regularly can revoke the key.

## What the API can do (we harvest all of this)

| Capability | Endpoint |
| --- | --- |
| Guild leaderboard (all / month / week) | `GET /guilds/:id/rankings/{all\|month\|week}?offset=` (≤100/page) |
| Member score rank | `GET /guilds/:id/rankings/members/:user/{all\|month\|week}` |
| Member points + points-rank | `GET /guilds/:id/members/:user/points` |
| Add / remove points | `PATCH …/points` `{ action: 0\|1, amount: 1–100000 }` |
| Add / remove score | `PATCH …/score` `{ action: 0\|1, amount: 1–100000 }` |
| Global Tatsu profile | `GET /users/:id/profile` (credits, tokens, XP, rep, title) |
| Global cosmetic store listing | `GET /store/listings/:id` (rarely useful for guild ops) |

`action`: **0 = add**, **1 = remove**. Amounts above 100k are **chunked** by our client.

## What the API cannot do (use Tatsu’s own UI)

These stay on [tatsu.gg](https://tatsu.gg) / Discord `t@` menus — **not** in the public API:

| Feature | Where |
| --- | --- |
| Points / score gain per message (anti-spam rate) | `t@persistence` |
| Wipe / prune / reset economy | `t@points` |
| Score settings | `t@scores` |
| Leveled roles | `t@leveledroles` |
| Absolute **set** balance (only add/remove) | — |

## Discord dashboard — `/tatsu`

Administrator-only, ephemeral. Same spirit as `/unbelievaboat`, without games/store/pets.

| Control | What it does |
| --- | --- |
| **Overview** | Key status, period, log channel, watchlist size, live top probe |
| **Leaderboard** | Paginated score board (20/page — Discord embed limit; all/month/week) |
| **Go to rank #** | Type an all-time rank → open that user (in or out of server) + edit dropdown |
| **Prune left** | Find board accounts no longer in Discord; zero using **board score** (member API often lies at 0) |
| **Edit user** | Live lookup + board scan + adjust/zero dropdown (supports raw user ID) |
| **Lookup user** | Points + all/month/week score ranks + global profile |
| **Adjust points / score** | **Add** / **Remove** buttons (no typing action); member pick or user ID |

**MANAGE_GUILD on remove:** that text is returned by `api.tatsu.gg` on the PATCH — we do not check Manage Server ourselves (Administrator on `/tatsu` is separate). Add and remove use the same endpoint/`TATSU_API_KEY`. If remove fails while add works, retry with the **Remove** button; if it persists, recreate the key (`t!apikey create`) as an account that has Manage Server in the guild.
| **Strip spam** | Bulk remove points + score, auto-watchlist |
| **Watchlist** | Local suspect list + notes (DN-side only) |
| **Snapshot + climbers** | Save board slice; flag score Δ ≥ threshold |
| **Audit log** | Our edits / strips / watches |
| **Log channel** | Public admin action embeds |
| **Toggle API link** | Soft-disable without deleting the key |

## Schema

`tatsu_settings` · `tatsu_audit_log` · `tatsu_watchlist` · `tatsu_snapshots` — created on boot with `IF NOT EXISTS` (same pattern as UnbelievaBoat).

## Slash budget

One top-level command: **`/tatsu`**. Prefer buttons/modals over new slash names.
