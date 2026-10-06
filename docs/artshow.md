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
/artshow crown              # crown this week's leader, announce on the board
/artshow fix                # repair: sync emblems + force-post missing gallery pieces
```

That’s the whole slash surface. Members never need a command.

## Member flow

1. Open the **board** channel  
2. Tap **Submit**  
3. Fill title + optional description + pick a photo  
4. Vote in the **gallery** with ▲ (daily vote wallet)  

## Channels

| Channel | Purpose |
|---------|---------|
| Board | Submit station; weekly champion announcement + emblems |
| Gallery | Hung pieces (original photo), vote buttons; read-only for members |

## Emblems

First submit unlocks **Exhibitor** (and later studio / vote / crown emblems).  
Shown on the board + in the Submit reply. Confirm anytime with `/badges`.
