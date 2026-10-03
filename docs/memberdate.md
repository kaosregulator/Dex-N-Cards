# `/memberdate` — staff member tenure

Staff-only Discord command to inspect **when someone joined the server**, how long they've been around, and **when they received a targeted role** (promotion / staff / admin, etc.) — without scrolling Discord's member list.

## Commands

### `/memberdate lookup`

| Option | Required | Description |
|--------|----------|-------------|
| `user` | yes | Member to inspect (Discord native @ picker / autocomplete) |
| `role` | no | If set, show when they got that role and how long they've held it |

Ephemeral embed shows:

- Display name / username + avatar
- Server join date + relative + **“been in server for X months / years”**
- Discord account creation + account age
- Targeted role tenure (when available)
- Top roles

### `/memberdate browse`

Filter the roster:

| Option | Description |
|--------|-------------|
| `role` | Only members who currently have this role |
| `min_joined` | At least 1m / 3m / 6m / 1y / 2y / 5y in the server |
| `min_role` | At least N holding the role (requires `role`) |
| `sort` | Newest/oldest joins, role grants, or name |

Results are ephemeral with **Prev / Next** paging.

## How role grant dates work

Discord's API exposes `joinedAt` and account creation, but **not** “when this role was granted” on the member object.

Dex fills that gap two ways:

1. **Live tracking** — on `GuildMemberUpdate`, when a role is added/removed, Dex stores the timestamp in `member_role_grants`.
2. **Audit log backfill** — on lookup (and small browse sets), if the bot has **View Audit Log**, Dex searches recent `MemberRoleUpdate` entries and caches a hit.

If neither has the date yet, the embed says the member has the role but the grant date is unknown — new grants are recorded going forward.

## Permissions

- **Staff:** server owner, Administrator, Manage Server, or Manage Messages
- **Bot:** must be in the server; **View Audit Log** unlocks audit backfill (optional but recommended)

## Database

Table `member_role_grants` (`guild_id`, `user_id`, `role_id`, `granted_at`, `source` = `live` | `audit`). Created via boot / production `CREATE TABLE IF NOT EXISTS` migrations.
