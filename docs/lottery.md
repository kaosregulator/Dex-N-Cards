# UB Lottery Suite

Lottery games funded by **UnbelievaBoat** currency. Ticket spend goes into a **prize pool**; winners are paid from that pool. Pools start with a seed jackpot so the board is never empty.

## Player — `/lottery` (also Casino → Lottery)

| Game | Ticket (default) | Seed jackpot | Play |
|------|------------------|--------------|------|
| Classic Lottery | 250 | 15,000 | Pick 5 (1–50) |
| Powerball | 500 | 75,000 | 5 whites (1–69) + Powerball (1–26) |
| Mega Millionaire | 750 | 150,000 | 5 (1–70) + Mega (1–25) |
| Scratch Ticket | 100 | 5,000 | Instant foil scratch |

### Number tickets
1. Choose a game in the store  
2. Enter numbers one-by-one (ephemeral modals)  
3. Preview → **Buy ticket** → UB cash/bank deducted → pool grows  

### Scratchers
1. Buy → GIF foil card  
2. Spam **Scratch!** until 9/9 revealed  
3. **Redeem to cash** or **Send to bank**  

## Admin — `/lotteryadmin`

- Set announce channel (live reveals + jackpot boards)  
- **Prices** — per-game ticket price + seed jackpot  
- **Buy hours** — per-game UTC start/end hour + weekdays (`all` or `0,1,2…`)  
- **Start / announce** — post flashy jackpot board for Powerball / Mega / Classic  
- **Live draw now** — animated ball-by-ball reveal in channel, score tickets, pay winners, reset/roll pool  
- Weekly schedule (UTC day + hour) — sweeper auto-runs draws when due  
- Enable/disable suite  

## Privacy & safeguards

- `/lottery` store, number picking, previews, scratch cards, and redeems are **ephemeral** (only the buyer sees them)  
- Buy checks: suite enabled · game enabled · pool `open` · UTC buy window · ownership on scratch/redeem  
- Public channel only gets jackpot boards, live ball drops, and winner announcements  

## Ties / multi-winners

When 2+ tickets share the top prize (e.g. split jackpot), the announce channel posts an exciting **“IT'S A TIE — N WINNERS!”** message with each Discord mention, their **ticket numbers**, ticket id, and share amount, plus a celebration GIF with **avatars**.

## Money

- Buy: `spendFunds` (cash first, then bank)  
- Win: `earnCash` (scratch bank redeem = earn then deposit)  
- Scratch prizes are escrowed out of the scratch pool at purchase  

## Tables

`ub_lottery_settings`, `ub_lottery_pools`, `ub_lottery_tickets`, `ub_lottery_draws`, `ub_lottery_scratchers` — created via boot / production `CREATE TABLE IF NOT EXISTS`.  
Per-game prices/windows live in `ub_lottery_settings.game_config` JSON.
