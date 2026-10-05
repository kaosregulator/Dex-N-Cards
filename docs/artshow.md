# Community Art Show

Two channels:

1. **Submission board** — slim station + members drop photos like a normal Discord upload  
2. **Gallery** — hung pieces with ▲ vote buttons (read-only for everyone except staff)

## Quick start (staff)

```
/artshow post
  create_board:art-show
  create_gallery:art-hall
  staff_role:@Mods          ← optional; can still post in the gallery

  # OR pick existing channels:
  board:#art-show
  gallery:#art-hall

  votes_per_day:5
  bonus_on_submit:2
  refresh_hours:6
  bump_cost:3
  crown_at:25
```

This:
- Posts a **slim station** on the board (How to submit / Browse / Hall of Fame / My votes)
- Pins the station
- Makes the **gallery read-only** for `@everyone` (bot + optional `staff_role` can still send)
- Lets members **Send + Attach** on the board so they can drop photos

### Thresholds & reset

- Tune anytime: `/artshow setup votes_per_day:…` etc.
- **Reset to defaults:** `/artshow setup reset_defaults:True`

Defaults: 5 votes/day · +2 on submit · +1 every 6h · bump costs 3 · auto-crown at 25 ▲

## Member submit flow

**Drop a photo** in the board channel (optional title in the message text).  
The bot hangs it in the gallery and clears the board drop.

Or one-shot: `/artshow submit` with a Discord **image** attachment + title.

No 2-minute timers. No Create/Cancel draft. No sticky board spam.

## Live piece buttons (gallery)

| Button | Action |
|--------|--------|
| ▲ Upvote | Spend 1 vote (wallet). Blocked on own piece / already voted / no votes left |
| Remove vote | Undo your vote **until the week is crowned** — refunds 1 vote |
| Bump | Re-post your piece near the top (costs votes or Rising Artist free bump) |
| Browse halls | Pick another piece’s hall canvas to view |

## One winner

Many halls on the floor; **one** weekly Hall of Fame champion:
- Auto-crown: first piece to hit `crown_at` ▲ that week, **or**
- Staff: `/artshow crown`

After crowning, **Remove vote** locks for that week.

## Museum look

The Hall of Fame canvas stamps a real gallery hall photo, hangs shuffled
**public-domain masterpieces** in gold frames, places classical marble statues on
pedestals, and puts the community champion **center stage**.  
Assets + credits: `assets/artshow/ATTRIBUTION.md`.

Emblem GIFs live under `/artshow badges` and `/badges` — not on the station board.

## Data

Tables: `artshow_settings` (`board_channel_id`, `gallery_channel_id`, …),
`artshow_pieces`, `artshow_votes`, `artshow_wallets`, `artshow_fame`.
