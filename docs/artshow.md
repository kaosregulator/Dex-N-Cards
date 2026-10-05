# Community Art Show

A gallery channel where members hang artwork, earn **button upvotes** (not emoji reactions), grow **Art Show emblems**, browse other halls, and race for **one** weekly Hall of Fame champion. A **sticky top-3 board** stays glued to the bottom of the channel.

## Quick start (staff)

```
/artshow post
  channel:#art-show          ← use existing
  # OR
  create_channel:art-show    ← bot creates the channel

  votes_per_day:5
  bonus_on_submit:2
  refresh_hours:6
  bump_cost:3
  crown_at:25
```

This posts:
1. The **station embed** (Submit / Browse / Museum / Emblem path / My votes / Reset defaults)
2. A **sticky top-3 board** at the bottom (pinned + delete/reposted on every vote so it stays last)

### Thresholds & reset

- Tune anytime: `/artshow setup votes_per_day:…` etc.
- **Reset to defaults:** `/artshow setup reset_defaults:True` or station button **Reset defaults**

Defaults: 5 votes/day · +2 on submit · +1 every 6h · bump costs 3 · auto-crown at 25 ▲

## Member submit flow

1. Press **Submit your art** → modal (title + description)
2. Upload your photo in the gallery channel (Discord attachment)
3. Preview appears with hall canvas + **Create** / **Cancel**
4. **Create** hangs the piece in the gallery with live buttons; **Cancel** discards

One-shot alternative: `/artshow submit` → same Create/Cancel preview.

## Live piece buttons

| Button | Action |
|--------|--------|
| ▲ Upvote | Spend 1 vote (wallet). Blocked on own piece / already voted / no votes left |
| Remove vote | Undo your vote **until the week is crowned** — refunds 1 vote |
| Bump | Re-post your piece near the top (costs votes or Rising Artist free bump) |
| Browse halls | Pick another piece’s hall canvas to view |

## Sticky board

Always at the **bottom** of the gallery (delete + repost after votes/submits/bumps/crowns). Shows:
- Current **champion** (if crowned) or “race open”
- **Top 3** with live ▲ counts
- Quick links: Browse / Museum / Submit

Discord has no true “glue to bottom” API — re-posting after updates is the sticky.

## One winner

Many halls on the floor; **one** weekly Hall of Fame champion:
- Auto-crown: first piece to hit `crown_at` ▲ that week, **or**
- Staff: `/artshow crown`

After crowning, **Remove vote** locks for that week.

## Emblems

See badge catalogue (`artshow` trigger): Exhibitor → … → Hall Champion → Museum Legend.  
Station **Emblem path** + `/badges`.

## Data

Tables: `artshow_settings` (incl. `sticky_message_id`), `artshow_pieces`, `artshow_votes`, `artshow_wallets`, `artshow_fame`.
