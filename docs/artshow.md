# Community Art Show

A gallery channel where members hang artwork (drawings, builds, clay, crafts — any photo of something they made), earn **button upvotes** (not emoji reactions), grow **Art Show emblems** on the shared badge system, and compete for a weekly **Hall of Fame** museum crown.

## Quick start (staff)

1. `/artshow post` in (or targeting) your gallery channel — posts the station with **Submit your art**, **Hall of Fame**, **Emblem path**, **My votes**.
2. Optional: `/artshow setup` to tune daily votes, submit bonus, refresh hours, bump cost, auto-crown threshold.

## Member flow

1. Press **Submit your art** → modal (title + description).
2. Upload an image in the gallery channel within 2 minutes (Discord attachment from phone/laptop).  
   Or one-shot: `/artshow submit image:… title:…`.
3. The bot hangs a **hall canvas** (spotlight + frame). The photo is **letterboxed, never cropped**. Landscape / portrait / square pick different wall scenes.
4. Others press **▲ Upvote** on the piece (one vote per member per piece). Votes spend from a daily wallet.
5. Artists can **Bump** to re-post their piece at the bottom of the channel (reads as “back on top”).

## Vote wallet

| Source | Default |
|--------|---------|
| Base votes / UTC day | 5 |
| Bonus when you submit | +2 |
| Timed refresh | +1 every 6h (capped) |
| Bump cost | 3 votes |
| Rising Artist perk | 1 free bump / day |

Self-votes are blocked. Already-voted pieces cannot be voted again.

## Emblems (badge trigger `artshow`)

Extends the community badge catalogue (see `/badges`):

| Emblem | How |
|--------|-----|
| Exhibitor | First submit |
| Studio Regular | 5 submits |
| Gallery Maker | 15 submits |
| Patron | 10 votes cast |
| Critic | 50 votes cast |
| Rising Artist | One piece hits 10 ▲ |
| Crowd Favorite | One piece hits 25 ▲ |
| Show Star | One piece hits 50 ▲ |
| Hall Champion | Weekly museum crown |
| Museum Legend | 3 crowns |

Unlocks and tier-ups use the same animated emblem GIFs as trivia/manual badges. Station **Emblem path** shows the progression canvas.

## Winning / museum

- **Weekly lead** — highest ▲ for the ISO week (shown on the station).
- **Auto-crown** — first piece to hit `crown_threshold` (default 25) that week enters the Hall of Fame.
- **Staff crown** — `/artshow crown` locks the weekly champion if auto-crown is off or you want a judge pick.
- **Museum canvas** — world wings (RU / UK / US / ES / CN / JP / FR / BR) as stylized cultural abstracts (not copyrighted masterpieces); the crowned community piece is **center stage** under museum lights.

## Commands

| Command | Who | Purpose |
|---------|-----|---------|
| `/artshow post` | Staff | Post station |
| `/artshow setup` | Staff | Tune economy |
| `/artshow crown` | Staff | Crown weekly winner |
| `/artshow submit` | Everyone | Submit with attachment |
| `/artshow museum` | Everyone | Hall of Fame |
| `/artshow badges` | Everyone | Emblem path |
| `/artshow leaderboard` | Everyone | Week / all-time |
| `/artshow votes` | Everyone | Wallet check |

## Data

Tables: `artshow_settings`, `artshow_pieces`, `artshow_votes`, `artshow_wallets`, `artshow_fame` (bootstrapped in API `index.ts`; Drizzle schema in `lib/db/src/schema/artshow.ts`).
