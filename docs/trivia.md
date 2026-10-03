# Community Trivia / QOTD / Flash Host

Addon for DN Cards — staff-hosted flash quizzes, trivia rounds, picture guesses,
and a daily **Question of the Day**. Does **not** replace cards, UB, or Tatsu.

# Sources (no custom scrape)

| Source | Key? | Use |
| --- | --- | --- |
| [Open Trivia DB](https://opentdb.com/) | **None** | Categories, multiple choice, true/false |
| [QuizAPI.io](https://quizapi.io/) | `QUIZAPI_KEY` | Programming / tagged quizzes |
| [boneitis.org](https://boneitis.org/) | **None** | Fun community conversation prompts |
| [dog.ceo](https://dog.ceo/) | **None** | Picture flash — guess the breed |

```env
QUIZAPI_KEY=your_quizapi_key   # optional
```

# Discord — `/trivia`

Staff-only (owner / Manage Server / Manage Messages / Administrator). Ephemeral hub.

| Control | What it does |
| --- | --- |
| **Flash quiz** | OpenTDB card → preview → pick channel → post |
| **Trivia round** | Choose OpenTDB / QuizAPI / boneitis → category → preview |
| **Picture flash** | Random dog photo; players type or Guess the breed |
| **QOTD setup** | Channel + UTC hour + enable; auto-posts & auto-starts |
| **Next card** | Preview tomorrow/next queue card; **Skip** reshuffles |
| **Audience & source** | `younger` (easy + safer cats) or `general`; default provider |
| **Winner roles** | Ensures Trivia Winner, QOTD Champion, Flash Champ, Smart Cookie, Brainiac |

## Live round flow

1. Staff posts a round (status **ready**).
2. **Start** (staff) opens guesses — button becomes **End**.
3. Players answer with big choice buttons, **Guess** modal, and/or typing in chat.
4. One guess per player while live. Typing guesses are reacted + cleaned.
5. **End** reveals the answer, posts a confetti winner GIF (public), awards a role until the next winner (or 24h).
6. Winner announcement cleans up after ~1 minute.

# Schema

`trivia_settings` · `trivia_rounds` · `trivia_guesses` · `trivia_role_holds` — created on boot with `IF NOT EXISTS`.

# Slash budget

One top-level command: **`/trivia`**. Prefer buttons/modals over new slash names.

## Files

```
lib/db/src/schema/trivia.ts
artifacts/api-server/src/lib/trivia/{client,db}.ts
artifacts/api-server/src/bot/trivia/{access,discord-admin,rounds,roles,winner-canvas,sweeper}.ts
docs/trivia.md
```
