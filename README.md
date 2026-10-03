# DN Cards

🎴 **DarkNight's collectible military trading card game for Discord**

Collect, trade, battle, and build — with a User Hub for daily profile flow, co-op raids, a Phaser Discord Activity, personal HQ, and sanctuary modes (Quiet / Vacation / LOA) when someone needs to step away without leaving the server.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?style=flat-square&logo=discord)](https://discord.js.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Features

### 🎮 Collecting & economy
- **Random card spawns** — timed drops in configured channels
- **Packs** — `/pack` (Basic / Premium / Legendary) with shard economy
- **Burn & fuse** — `/burn` for shards · `/card_recycle` for Card Fusion / star rank
- **Trading** — `/trade` hub (propose / pending / history / accept / decline / gift) with fairness warnings
- **Shinies, limited & event cards** — rare variants, copy caps, admin events (`/event`)

### 🧭 Player hubs
- **`/user-hub`** — profile, collection, **daily claim**, calendar, quests, wishlist, market, squad, reputation (replaces old standalone `/daily`, `/collection`, `/wishlist`, etc.)
- **`/collection-hub`** — browse/filter owned cards
- **`/help`** — interactive command guide for the whole bot

### ⚔️ Battles, raids & live activity
- **`/battle`** — fights, raids, sieges, profile, leaderboards, achievements
- **`/battle phaser`** — Discord Embedded Activity (Phaser 4 duel / open world)
- **`/raid`** · **`/battle_admin`** · **`/raid_admin`** — co-op bosses and admin tools

### 🏠 Headquarters
- **`/hq`** · **`/hqbuild`** — personal base canvas; **`/hqadmin`** for staff

### 🌙 Sanctuary (Quiet / Vacation / LOA)
- One-channel isolation via quarantine roles — disappear without leaving the server
- **`/quiet`** with `mode:quiet|vacation|loa|stepaway` (renameable labels per server)
- Staff force-out: `/quiet user:@Member` · setup: `/quiet_setup`
- Optional CC0 ambience + **Stones in the Water** release exercise — see [`docs/quiet-mode.md`](./docs/quiet-mode.md)

### ⚙️ Admin tools
- **`/setup`** (and `!setup`) — guided configuration
- **`/config`** — visual toggles, intervals, rates, pack settings
- Sets, rarity, embeds, giveaways — `/set_hub`, `/rarity`, `/embed`, `/giveaway`
- **`/cardadmin`** — create (upload / Kitsu / Vault Values), edit, give, drop
- **`/admin_hub`** — staff toolbox · **`/help` → Admin** for the full reference

---

## Quick Start

### Prerequisites
- **Node.js 24+**
- **PostgreSQL** database
- **Discord bot token** with `MESSAGE_CONTENT` and `SERVER MEMBERS` intents enabled

### Installation

```bash
# Install dependencies
pnpm install

# Set up environment variables
export DATABASE_URL="postgresql://user:password@localhost/dn_cards"
export DISCORD_BOT_TOKEN="your_bot_token_here"

# Apply database schema
pnpm --filter @workspace/db run push

# Run the API server + Discord bot
pnpm --filter @workspace/api-server run dev
```

The bot will start on **port 5000** with the API and Discord connection active.

### Environment Variables

```env
# Required
DATABASE_URL=postgresql://user:password@host:5432/database
DISCORD_BOT_TOKEN=your_bot_token
HOME_GUILD_ID=your_discord_server_id
SESSION_SECRET=long-random-string

# Optional
NODE_ENV=development
PUBLIC_BASE_URL=https://your-public-host.example
UNBELIEVABOAT_TOKEN=your_unb_api_token    # optional — UnbelievaBoat hub + pet shop (see docs/unbelievaboat.md)
TATSU_API_KEY=your_tatsu_api_key          # optional — Tatsu dashboard (t!apikey create — see docs/tatsu.md)
QUIZAPI_KEY=your_quizapi_key              # optional — QuizAPI.io for /trivia (OpenTDB needs no key)
```

### Deploy on Railway

See [`docs/railway.md`](./docs/railway.md). Link Railway Postgres (`DATABASE_URL`), set `DISCORD_BOT_TOKEN`, `HOME_GUILD_ID`, and `SESSION_SECRET`, then deploy — Discord login and schema bootstrap are handled automatically on Railway.

---

## Tech Stack

What this project is built with (click through for each upstream project):

| Area | Libraries |
|------|-----------|
| Runtime | [Node.js](https://nodejs.org/) · [TypeScript](https://www.typescriptlang.org/) · [pnpm](https://pnpm.io/) |
| Discord bot & API | [discord.js](https://discord.js.org/) · [Express](https://expressjs.com/) · [Zod](https://zod.dev/) |
| Database | [PostgreSQL](https://www.postgresql.org/) · [Drizzle ORM](https://orm.drizzle.team/) · [node-postgres (pg)](https://node-postgres.com/) |
| Image & canvas | [node-canvas](https://github.com/Automattic/node-canvas) · [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas) · [sharp](https://sharp.pixelplumbing.com/) · [Konva](https://konvajs.org/) |
| Discord Activity | [Phaser](https://phaser.io/) · [Babylon.js](https://www.babylonjs.com/) · [Rive](https://rive.app/) · [Discord Embedded App SDK](https://discord.com/developers/docs/activities/overview) |
| Dashboard | [React](https://react.dev/) · [Vite](https://vite.dev/) · [TanStack Query](https://tanstack.com/query) · [Tailwind CSS](https://tailwindcss.com/) · [Wouter](https://github.com/molefrog/wouter) |
| Tooling | [esbuild](https://esbuild.github.io/) · [Vitest](https://vitest.dev/) · [Playwright](https://playwright.dev/) (optional MakeEmoji browser) |

Also used in-bot: [Matter.js](https://brm.io/matter-js/), [Pino](https://getpino.io/), [Fuse.js](https://www.fusejs.io/), [ws](https://github.com/websockets/ws).

---

## Project Structure

```
DN-cards/
├── artifacts/
│   ├── api-server/          # Express + Discord bot
│   ├── dashboard/           # Admin web interface
│   ├── activity/            # Discord Embedded Activity (Phaser)
│   └── emoji-offline/       # Offline emoji compositor (MakeEmoji-compatible)
├── lib/
│   ├── db/                  # Drizzle schema & migrations
│   └── api-spec/            # OpenAPI contract
├── docs/                    # Feature docs (Quiet Mode, Railway, battles, …)
└── scripts/                 # Utility scripts & validation
```

---

## Core Commands

Slash names below are what Discord registers today. Prefer **`/help`** and **`/user-hub`** for the full surface — many older one-off commands were folded into hubs.

### Player
| Command | Description |
|---------|-------------|
| `/user-hub` | Profile hub: daily claim, collection, quests, wishlist, market, squad, and more |
| `/help` | Interactive command guide |
| `/collection-hub` | Browse / filter your cards |
| `/pack` | Open a card pack |
| `/burn` | Burn cards for shards |
| `/card_recycle` | Card Fusion / star-rank recycle |
| `/trade` | Trade hub — propose, pending, history, accept, decline, gift |
| `/info` · `/top` | Card details · leaderboards |
| `/battle` | Fights, raids, sieges, profile — includes **`/battle phaser`** (live Activity) |
| `/raid` | Co-op raid entry |
| `/hq` · `/hqbuild` | Personal Headquarters |
| `/giveaway` | Giveaway hub |
| `/quiet` | Sanctuary modes (`mode:quiet|vacation|loa|stepaway` — run again to leave) |
| `/begin` | Onboarding |
| `/afk` | AFK Secretary |
| `/secret` | Encrypted Echo — whisper a member or post a staff secret |
| `/vaultvalue` | Vault Values prices + calculator ([valuevaultx.com](https://valuevaultx.com)) |
| `/pet` | Pets (when enabled) |
| `/casino` | UnbelievaBoat casino hub — deposit/withdraw, daily, collect, games, UNO, leaderboard, store |
| `/unbelievaboat` | Admin Discord dashboard (cooldowns, cash, store, logs, rob immunity) |
| `/tatsu` | Staff Tatsu dashboard (leaderboard, points/score, spam watch) |
| `/trivia` | Staff community trivia host (flash, QOTD, picture rounds) |

### Staff / admin
| Command | Description |
|---------|-------------|
| `/setup` · `!setup` | Guided server setup |
| `/config` | Visual configuration panel |
| `/admin_hub` | Admin toolbox |
| `/cardadmin` | Create / edit / give / drop cards (upload · Kitsu · Vault Values) |
| `/battle_admin` · `/raid_admin` | Combat admin |
| `/set_hub` · `/set_admin` | Card sets / spawn rotation |
| `/event` | Limited events |
| `/rarity` · `/embed` | Rarity tiers · embed branding |
| `/quiet_setup` | Sanctuary rooms, quarantine roles, renames, audio |
| `/quiet user:@Member` | Place into sanctuary **or force out** |
| `/hqadmin` | HQ staff tools |
| `/echo` | Echo-Whisper config (viewer roles, override, stats) |

### Prefix helpers (also available)
| Command | Description |
|---------|-------------|
| `!setup` | Interactive setup wizard |
| `!addcard` | Add a card to the pool |
| `!settings` | View current server configuration |

> **Moved into hubs (no longer standalone slash):** many older one-offs. Prefer **`/help`** for the live map.
>
> Discord’s autocomplete lists hub subcommands as `/trade propose`, `/vaultvalue info`, etc. — that **is** the hub. Old flats looked like bare `/gift`, `/accept`, `/drop` (no parent). After deploy, those bare names should be gone; if they linger, the bot failed to clear global commands (Activity Entry Point must be kept — see registration logs).
>
> - **`/user-hub`:** daily, collection, wishlist, quests, market, squad, and related profile shortcuts
> - **`/trade`:** gift, pending trades, history, accept, decline
> - **`/vaultvalue`:** info, calc, list, help, postcalc
> - **`/cardadmin`:** create / Kitsu / Vault Values create, library, edit, give, drop, shards
> - **`/secret`:** whisper, staff secret (`/echo` stays as config)
> - **`/quiet mode:…`:** vacation / loa entry aliases
> - **`/help` → Admin:** adminhelp / welcomeadmin docs
>
> Handlers stay in code for hub buttons and legacy routing — they are not registered as top-level slash commands.
>
> **Removed from the live bot:** Bob entertainment (`/bob`, `/bob_*`, `/bob_admin`). Schema leftovers may remain; the module is not registered. (Unrelated: `/minigames` Wild Mini-Games admin panel is still live.)

---

## Card System

### Rarities & Values
| Rarity | Worth | Burn | Drop Weight |
|--------|-------|------|-------------|
| Common | 10 💠 | 5 💠 | 60% |
| Uncommon | 50 💠 | 25 💠 | 25% |
| Rare | 200 💠 | 100 💠 | 10% |
| Epic | 800 💠 | 400 💠 | 4% |
| Legendary | 2,500 💠 | 1,250 💠 | 1% |
| Mythic | 6,000 💠 | 3,000 💠 | 0% (admin-only) |

### Card Types
tank · aircraft · ship · vehicle · infantry · boss · community · event · achievement · limited

### Default Cards (27)
**8 Common:** M4 Sherman, Jeep Willys, Dog Tags, M1 Helmet, Radio Set, Supply Truck, Recon Drone, Sandbag Bunker

**6 Uncommon:** M1 Abrams, AH-64 Apache, USS Arleigh Burke, F-16 Fighting Falcon, Bradley IFV, T-80 Objekat

**6 Rare:** F-22 Raptor, USS Nimitz, Leopard 2A7, T-14 Armata, B-2 Spirit, USS Virginia

**4 Epic:** SR-71 Blackbird, USS Gerald R. Ford, F-35 Lightning II, Night Stalker

**3 Legendary:** Darknight Titan, Operation Zero, The Warlord

---

## Economy

**DN Shards (💠)** — the in-game currency

**Earned by:**
- Burning duplicate cards
- Daily rewards (50 base + streak bonus up to +200)
- Gifting/trades
- Achievements
- Admin awards

**Spent on:**
- Pack openings
- Trades
- Gifts

---

## Documentation

| Doc | Topic |
|-----|--------|
| [`replit.md`](./replit.md) | Full product / command reference & architecture notes |
| [`docs/quiet-mode.md`](./docs/quiet-mode.md) | Quiet Room quarantine role + audio |
| [`docs/unbelievaboat.md`](./docs/unbelievaboat.md) | UnbelievaBoat + casino |
| [`docs/tatsu.md`](./docs/tatsu.md) | Tatsu score/points Discord dashboard |
| [`docs/trivia.md`](./docs/trivia.md) | Community trivia / QOTD / flash host |
| [`docs/railway.md`](./docs/railway.md) | Railway deploy |
| [`docs/battle-system.md`](./docs/battle-system.md) | Battles |
| [`docs/headquarters.md`](./docs/headquarters.md) | Player HQ |
| [`AGENTS.md`](./AGENTS.md) | Cloud / agent environment notes |

`replit.md` also covers advanced config, card sets, giveaways, sanctuary, and schema gotchas (including retired Bob leftovers).

---

## Thanks

Quick thanks to the upstream projects and ecosystems this bot leans on:

- **[discord.js](https://discord.js.org/)** — Discord API client
- **[Phaser](https://phaser.io/)** — Embedded Activity game scenes
- **[node-canvas](https://github.com/Automattic/node-canvas)** & **[@napi-rs/canvas](https://github.com/Brooooooklyn/canvas)** — card / HQ / battle image rendering
- **[Drizzle](https://orm.drizzle.team/)** & **[PostgreSQL](https://www.postgresql.org/)** — schema and data
- **[Openverse](https://openverse.org/)** & **[Freesound](https://freesound.org/)** creators — CC0 Quiet Room ambience sources (see [`artifacts/api-server/quiet-audio/SOURCES.md`](./artifacts/api-server/quiet-audio/SOURCES.md))
- **[MakeEmoji](https://makeemoji.com/)** — emoji generation pipeline inspiration / provider path
- Everyone shipping the open libraries listed in **Tech Stack** above

---

## Legal

- **[Terms of Service](./TERMS_OF_SERVICE.md)** — Usage terms and restrictions
- **[Privacy Policy](./PRIVACY_POLICY.md)** — Data collection and handling

---

## Invite the Bot

**OAuth2 Install URL:**
```
https://discord.com/api/oauth2/authorize?client_id=YOUR_BOT_CLIENT_ID&permissions=8&scope=bot%20applications.commands
```

Required permissions:
- Send Messages
- Manage Messages (for reactions & updates)
- Embed Links
- Attach Files
- Read Message History
- Moderate Members (for giveaway roles)

---

## Troubleshooting

### Common Issues

**Bot not responding to commands?**
- Ensure `MESSAGE_CONTENT` intent is enabled in Developer Portal
- Check bot has `applications.commands` scope in server invite

**Database connection fails?**
- Verify `DATABASE_URL` environment variable is correct
- Ensure PostgreSQL server is running
- Run `pnpm --filter @workspace/db run push` to apply schema

**Slash commands not appearing?**
- Slash commands are registered globally + per-guild on startup
- Global propagation can take up to 1 hour
- Guild commands should appear instantly

**Images not loading?**
- Card images are added via URL only (no file uploads in prefix commands)
- Use permanent image hosts (Imgur, etc.) — Discord CDN URLs are temporary

---

## Contributing

This is a private project. For issues, feature requests, or contributions, please contact DarkNight or repository maintainers.

---

## License

MIT License — see [LICENSE](LICENSE) for details.

---

## Support

- **Documentation:** [`replit.md`](./replit.md)
- **Issues:** [GitHub Issues](https://github.com/kaosregulator/DN-cards/issues)
- **Community:** DarkNight Discord server

---

**Made with ❤️ for the DarkNight community**
