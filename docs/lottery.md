# UnbelievaBoat Lottery Suite

Lottery games funded by **UnbelievaBoat** currency. Ticket spend goes into a **prize pool**; winners are paid from that pool. Pools start with a seed jackpot so the board is never empty.

**Public boards, live draws, and public scratch reveals post as UnbelievaBoat webhooks** (not the DN bot), matching the rest of the economy suite.

## Player — `/lottery` (also Casino → Lottery)

Private animated store board (subtle bounce, no fade flash). Select menus use plain `N cash` labels. Canvas loads currency + game icons from Discord CDN / Twemoji.

| Game | Ticket (default) | Seed jackpot | Play |
|------|------------------|--------------|------|
| Classic Lottery | 250 | 15,000 | Pick 5 (1–50) |
| Powerball | 500 | 75,000 | 5 whites + Powerball |
| Mega Millionaire | 750 | 150,000 | 5 + Mega |
| Scratch Shop | tiered | 5,000 (shared) | Instant special scratchers |

### Scratch Shop (4 games · daily stock)

| Tier | Game | Price | Daily stock |
|------|------|------:|------------:|
| Copper Classic | WIN / TRY / MISS foil | 50 | 80 |
| Lucky Numbers | Match a vast lucky number | 250 | 50 |
| Connect Three | 3-in-a-row symbols | 1,000 | 25 |
| Pick Three | Reveal all → pick 3 cells | 5,000 | 10 |

Marks legend (shop button **What marks mean**):
- **WIN** — cash prize on this ticket  
- **TRY** — tease amount only (does not pay)  
- **MISS** — blank  
- **MATCH** — hits the lucky number  
- **LINE** — part of a Connect 3 win  
- **PICK** — choose three cells; values bank (capped)

Flow: pick tier → **Scratch Publicly** (UnbelievaBoat webhook) or **Scratch Privately** → peel foil → redeem cash/bank.  
Stock restocks at **00:00 UTC**. Sold out → wait (or ask staff to restock under the daily cap).

## Admin — `/lotteryadmin`

Hub shows a **pre-draw ticket summary** (tickets + unique players per game) and **scratch stock**.

- **Live draw now** → see who's playing → confirm → runs immediately (skips weekly schedule wait); posts as UnbelievaBoat  
- **Scratch stock** → fill to default daily cap, or **add amount** (never exceeds each tier’s default cap)  
- Announce channel, prices, buy hours, weekly schedule, enable/disable  

## Privacy & money

- Number picks stay ephemeral  
- Scratch can be public (webhook) or private  
- Buy: `spendFunds` · Win: `earnCash` (bank redeem = earn then deposit)  
- Scratch prizes escrowed from the scratch pool at purchase  

## Tables

`ub_lottery_settings`, `ub_lottery_pools`, `ub_lottery_tickets`, `ub_lottery_draws`, `ub_lottery_scratchers`  
Scratch stock: `game_config.scratch.scratchStock` `{ date, remaining }`  
Scratcher rows: `tier_key`, `game_mode`, `meta`, `public_reveal`
