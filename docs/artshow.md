# Community Art Show

Simple loop:

1. Staff runs **`/artshow`** → **Setup** creates **two channels** and posts a Submit station
2. Members tap **Submit** → popup (title, description, photo from their device)
3. Piece posts to the **gallery** with the **original photo** + ▲ / Remove vote / Bump me
4. Staff runs **`/artshow`** → **Crown** — weekly winner is announced on the **board** with emblem
5. New week → more submits → repeat

## Staff

One slash, **`/artshow`**, opens the hub. Setup / Crown / Fix are visible to everyone;
pressing them without admin permission replies that you need to be an admin.

- **Setup** — modal for board / gallery channel names (reuses existing staff and champion roles)
- **Crown** — end the week on the board
- **Fix** — repair: sync emblems + force-post missing gallery pieces

**Crown at week end**
- New winner → champion embed + their photo + gives them `champion_role` (removes it from the old holder)
- Same person wins again, **or** nobody new this week → still posts on the board as **Still Undefeated** with the same original winner photo (keeps the role) so the channel stays alive

Members never need a command. They Submit from the board.

## Member flow

1. Open the **board** channel
2. Tap **Submit**
3. Fill title + optional description + pick **1–10 photos** (still one post)
4. Gallery shows a clean gold card (photos letterboxed, never cropped) + ▲ votes
5. **View photos** (if more than one) opens an ephemeral pager — only you see it

## Channels

| Channel | Purpose |
|---------|---------|
| Board | Submit station; weekly champion announcement + emblems |
| Gallery | Hung pieces (original photo), vote buttons; read-only for members |

## Emblems

First submit unlocks **Exhibitor** (and later studio / vote / crown emblems).
Shown on the board + in the Submit reply. Confirm anytime with `/badges`.
