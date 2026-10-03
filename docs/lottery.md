# UnbelievaBoat Lottery Suite

Lottery games funded by **UnbelievaBoat** currency. Ticket spend goes into a **prize pool**; winners are paid from that pool. Pools start with a seed jackpot so the board is never empty.

## Player — `/lottery` (also Casino → Lottery)

The store opens as a **private** animated canvas board (currency icons load from Discord CDN / Twemoji — never raw `<:name:id>` on GIFs). Select-menu descriptions use plain “N cash” labels so custom economy symbols do not break the dropdown.

| Game | Ticket (default) | Seed jackpot | Play |
|------|------------------|--------------|------|
| Classic Lottery | 250 | 15,000 | Pick 5 (1–50) |
| Powerball | 500 | 75,000 | 5 whites (1–69) + Powerball (1–26) |
| Mega Millionaire | 750 | 150,000 | 5 (1–70) + Mega (1–25) |
| Scratch Shop | tiered | 5,000 (shared pot) | Instant foil scratch |

### Number tickets
1. Choose a game in the store  
2. Enter numbers one-by-one (ephemeral modals)  
3. Preview → **Buy ticket** → UnbelievaBoat cash/bank deducted → pool grows  

### Scratch Shop
Four tiers with **daily stock** (restocks automatically at **00:00 UTC**):

| Tier | Price | Daily stock |
|------|------:|------------:|
| Copper | 50 | 80 |
| Silver | 250 | 50 |
| Gold | 1,000 | 25 |
| Diamond | 5,000 | 10 |

Flow (mirrors pack opens):
1. Open **Scratch Shop** → pick a tier  
2. Choose **Scratch Publicly** or **Scratch Privately** (nothing charged until this step)  
3. GIF foil card → spam **Scratch!** until 9/9 revealed  
4. **Redeem to cash** or **Send to bank**  

Sold-out tiers cannot be bought until the next UTC day.

## Admin — `/lotteryadmin`

- Set announce channel (live reveals + jackpot boards)  
- **Prices** — per-game ticket price + seed jackpot (draw games)  
- **Buy hours** — per-game UTC start/end hour + weekdays (`all` or `0,1,2…`)  
- **Start / announce** — post flashy jackpot board for Powerball / Mega / Classic  
- **Live draw now** — animated ball-by-ball reveal in channel, score tickets, pay winners, reset/roll pool  
- Weekly schedule (UTC day + hour) — sweeper auto-runs draws when due  
- Enable/disable suite  

## Privacy & safeguards

- `/lottery` store and number picking are **ephemeral**  
- Scratch can be **public** (channel message) or **private** (ephemeral), chosen before charge  
- Buy checks: suite enabled · game enabled · pool `open` · UTC buy window · ownership on scratch/redeem · daily scratch stock  
- Public channel also gets jackpot boards, live ball drops, and winner announcements  

## Ties / multi-winners

When 2+ tickets share the top prize (e.g. split jackpot), the announce channel posts an exciting **“IT'S A TIE — N WINNERS!”** message with each Discord mention, their **ticket numbers**, ticket id, and share amount, plus a celebration GIF with **avatars**.

## Money & symbols

- Buy: `spendFunds` (cash first, then bank)  
- Win: `earnCash` (scratch bank redeem = earn then deposit)  
- Scratch prizes are escrowed out of the scratch pool at purchase  
- **Embeds** keep the server currency label (`<:name:id>` renders in Discord)  
- **Canvas / GIFs** draw the emoji image (or a short-name chip) via `currency-canvas`  
- **Select menus** never put custom emoji markup in option descriptions  

## Tables

`ub_lottery_settings`, `ub_lottery_pools`, `ub_lottery_tickets`, `ub_lottery_draws`, `ub_lottery_scratchers` — created via boot / production `CREATE TABLE IF NOT EXISTS`.  
Scratch daily stock lives in `ub_lottery_settings.game_config.scratch.scratchStock` (`{ date, remaining }`).  
Scratcher rows store `tier_key` and `public_reveal`.
