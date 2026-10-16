# Agent Instructions

## Cursor Cloud specific instructions

- See `README.md` and `replit.md` for the standard pnpm workspace commands and product/service overview.
- Node.js is 24.16.0 at `/usr/local/lib/nodejs` (pnpm 10.34.5 via corepack). `/exec-daemon/node` is Node 22 and appears earlier on `PATH` in non-login shells, so prepend `/usr/local/lib/nodejs/bin` before pnpm scripts. Login shells pick this up from `/etc/profile.d/nodejs.sh`.
- Local development uses Postgres 16 with `DATABASE_URL=postgresql://dn_cards_dev:dn_cards_dev@127.0.0.1:5432/dn_cards_dev`. The Cloud Agent `start` script starts the cluster if needed. When schema state is stale, run `pnpm --filter @workspace/db run push` with that `DATABASE_URL`. Local credentials pass `ssl: false` into Drizzle Kit; omitting `ssl` makes Kit turn TLS on and reject Ubuntu's self-signed cert.
- The API process requires `PORT` (dev uses `5000`). For dashboard/API development without connecting to Discord, set a placeholder `DISCORD_BOT_TOKEN`, set `HOME_GUILD_ID` to a local placeholder such as `000000000000000001` so boot migrations can run, and leave `FORCE_DISCORD_LOGIN` unset so the bot logs its dev-mode skip. Use a separate real dev bot token plus `FORCE_DISCORD_LOGIN=1` only for Discord gateway E2E testing. A fresh database gets the Drizzle schema on API boot (`ensureBaseSchema`) unless `AUTO_DB_PUSH=0`.
- Published hosts auto-enable Discord login when `REPLIT_DEPLOYMENT=1`, any `RAILWAY_*` service env is present, or `DN_DEPLOYMENT=1`. See `docs/railway.md` for Railway Postgres + secrets.
- `pnpm install` runs the API server postinstall, which downloads Playwright's Chromium for `/emoji`. Set `SKIP_PLAYWRIGHT_INSTALL=1` only when that download should be skipped.
- The dashboard Vite dev server does not proxy `/api/*` (it listens on `5173`). Cloud Agent `start` also runs a one-origin proxy on port `8080` that sends `/api` to the API server and every other path to the dashboard. Use `http://127.0.0.1:8080` for browser checks.
