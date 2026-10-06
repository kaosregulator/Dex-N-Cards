# Community Art Show

Simple loop:

1. Staff runs **`/artshow setup`** → bot creates **two channels** and posts a Submit station  
2. Members tap **Submit** → popup (title, description, photo from their device)  
3. Piece posts to the **gallery** with the **original photo** + ▲ / Remove vote / Bump me  
4. Staff runs **`/artshow crown`** → weekly winner is announced on the **board** with emblem  
5. New week → more submits → repeat  

## Staff

```
/artshow setup
  # optional overrides:
  board_name:art-show
  gallery_name:art-gallery
  # or pick existing: board:#… gallery:#…
```

```
/artshow setup champion_role:@YourWinnerRole   # optional — your existing champ role
/artshow crown              # end the week on the board
/artshow fix                # repair: sync emblems + force-post missing gallery pieces
```

**`/artshow crown` at week end**
- New winner → champion embed + their photo + gives them `champion_role` (removes it from the old holder)
- Same person wins again, **or** nobody new this week → still posts on the board as **Still Undefeated** with the same original winner photo (keeps the role) so the channel stays alive

That’s the whole slash surface. Members never need a command.

## Member flow

1. Open the **board** channel  
2. Tap **Submit**  
3. Fill title + optional description + pick **1–10 photos** (still one post)  
4. Gallery shows a clean gold card (photos letterboxed, never cropped) + ▲ votes  
5. **View photos** (if more than one) opens an ephemeral pager — only you see it  

Also update CREATE TABLE for artshow_pieces if needed - image_urls via ALTER is enough.

Typecheck.

## Channels

| Channel | Purpose |
|---------|---------|
| Board | Submit station; weekly champion announcement + emblems |
| Gallery | Hung pieces (original photo), vote buttons; read-only for members |

## Emblems

First submit unlocks **Exhibitor** (and later studio / vote / crown emblems).  
Shown on the board + in the Submit reply. Confirm anytime with `/badges`.
