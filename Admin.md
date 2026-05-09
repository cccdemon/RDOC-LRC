# RDOC-LC Admin CLI

All operator-only actions — issuing tokens, listing state, removing federations, cleaning up dead bindings — go through `bin/admin.js`. There is **no** Discord-side workflow for any of this; the bot operator is the federation gatekeeper.

## How to run

Inside the running container:

```bash
docker exec rdoc-lc-bot npm run admin -- <subcommand> [args] [--flags]
# equivalent:
docker exec rdoc-lc-bot node bin/admin.js <subcommand> [args] [--flags]
```

Without Docker (talking to a local Redis on `127.0.0.1`):

```bash
REDIS_HOST=127.0.0.1 npm run admin -- <subcommand> [args] [--flags]
```

The `--` after `npm run admin` is required so npm forwards the remaining arguments to the script instead of consuming them itself.

`admin.js` connects to the same Redis as the bot and uses the same key layout. It does **not** require the bot process to be running, except for `state cleanup`, which needs `DISCORD_TOKEN` to talk to the Discord API.

## Command index

| Command | One-liner |
|---|---|
| [`token create`](#token-create) | Issue a single-use **join** token for a room. |
| [`token create-kick`](#token-create-kick) | Issue a single-use **kick** token that removes a target guild from a room. |
| [`token list`](#token-list) | List all unconsumed tokens (join + kick). |
| [`token revoke`](#token-revoke) | Invalidate an unconsumed token by 8+ char prefix. |
| [`room list`](#room-list) | All rooms + member counts. |
| [`room members`](#room-members) | List `guildId:channelId` entries in a room. |
| [`state cleanup`](#state-cleanup) | Verify every bridged channel still exists in Discord; prune dead bindings. |

---

## `token create`

Issue a one-time **join** token. Whoever holds the token can run `/bridge join <room> <token>` once to link a channel into the named room.

```
admin.js token create <room> [--guild=<id>] [--expires-h=<hours>]
```

**Args**

| Name | Required | Notes |
|---|---|---|
| `<room>` | yes | Room name. Pattern `^[a-z0-9][a-z0-9-]{1,30}$`. Lowercased automatically. |
| `--guild=<id>` | no | Discord guild ID (17–20 digits). If set, only that guild may consume the token. Defends against token leaks: a leaked token is useless to anyone outside the named guild. |
| `--expires-h=<hours>` | no | Token TTL in hours. Default `168` (7 days). |

**Side effects**

- Creates `rdoc:token:<token>` (HASH) with `kind=join`, `room`, optional `guildId`, `createdAt`, `expiresAt`.
- Adds the token to `rdoc:tokens` and `rdoc:room:<room>:tokens`.
- Sets a Redis `PEXPIREAT` on the hash as a safety belt (sweep is the primary expiry path).
- The room itself does **not** have to exist yet; the first successful `/bridge join` creates it. The CLI prints `(NEW)` next to the room name in that case.

**Example**

```
$ docker exec rdoc-lc-bot npm run admin -- token create alliance-chat --guild=1234567890123456789
Token:        rdoc-Vk7m-9pXr-Tq2N-aB4d
Room:         alliance-chat
Expires:      2026-05-16 09:43:00 UTC  (168h)
Guild bind:   1234567890123456789

Send the token out-of-band (DM/Signal/email) to the receiving Discord server admin. They run:
  /bridge join alliance-chat rdoc-Vk7m-9pXr-Tq2N-aB4d
```

---

## `token create-kick`

Issue a one-time **kick** token. Whoever holds the token can run `/bridge kick <token>` in any guild they have Manage Channels in, and that call removes **all** of `<target-guild-id>`'s channels from `<room>`.

```
admin.js token create-kick <room> <target-guild-id> [--expires-h=<hours>]
```

**Args**

| Name | Required | Notes |
|---|---|---|
| `<room>` | yes | Room name. |
| `<target-guild-id>` | yes | The guild that will be removed when the token is consumed (17–20 digit Discord guild ID). |
| `--expires-h=<hours>` | no | Default `168`. |

**Notes**

- The token encodes both the room and the target guild. The runner of `/bridge kick` does not have to be in the room, and does not get a choice — the token's payload determines what is removed.
- If the target guild is not currently a member of the room, the CLI still creates the token but prints a warning. Consuming the token in that case logs the consumption but does nothing operational.
- The runner's identity (user ID + executing guild ID) is logged in audit embeds for accountability.

**Example**

```
$ docker exec rdoc-lc-bot npm run admin -- token create-kick alliance-chat 9876543210987654321
Kick token:    rdoc-7zPq-bL3n-kH8e-RfMc
Room:          alliance-chat
Target guild:  9876543210987654321
Expires:       2026-05-16 09:50:00 UTC  (168h)

Send the token to whoever should execute the kick. They run, in any guild they have Manage Channels:
  /bridge kick rdoc-7zPq-bL3n-kH8e-RfMc
```

---

## `token list`

List all unconsumed tokens (both join and kick), optionally filtered by room.

```
admin.js token list [--room=<name>]
```

**Output columns**: token, `kind=join|kick`, room, expiry, and either `guild=<id>|(any)` (join) or `target=<id>` (kick).

**Example**

```
$ docker exec rdoc-lc-bot npm run admin -- token list
rdoc-Vk7m-9pXr-Tq2N-aB4d  kind=join  room="alliance-chat"  expires=2026-05-16 09:43:00 UTC  guild=1234567890123456789
rdoc-7zPq-bL3n-kH8e-RfMc  kind=kick  room="alliance-chat"  expires=2026-05-16 09:50:00 UTC  target=9876543210987654321
```

Tokens disappear from this list as soon as they are consumed, expired (sweep), or revoked.

---

## `token revoke`

Invalidate an unconsumed token by 8+ char prefix. Works for both join and kick tokens.

```
admin.js token revoke <prefix>
```

**Args**

| Name | Required | Notes |
|---|---|---|
| `<prefix>` | yes | First 8 or more characters of the token (e.g. `rdoc-Vk7m`). Must be unambiguous — if more than one token starts with the prefix, the call fails without revoking anything. |

**Use this for**: leaked tokens, abandoned distributions, or any token you no longer want consumable. Already-consumed tokens are not in `rdoc:tokens` and cannot be "revoked" — there's nothing to revoke.

**Example**

```
$ docker exec rdoc-lc-bot npm run admin -- token revoke rdoc-Vk7m
Revoked: rdoc-Vk7m-9pXr-Tq2N-aB4d  (room="alliance-chat")
```

---

## `room list`

Lists every room and how many channels are bound to it (across all guilds).

```
admin.js room list
```

**Example**

```
$ docker exec rdoc-lc-bot npm run admin -- room list
alliance-chat  3 channel(s)
langstreckenfunk  2 channel(s)
```

---

## `room members`

Lists every channel binding in a single room. Each line is `<guildId>:<channelId>  webhookId=<id>`.

```
admin.js room members <room>
```

**Use this for**: figuring out which channel ID corresponds to a stale or "unbekannt"-rendered entry shown by `/bridge list`, before kicking a server or running [`state cleanup`](#state-cleanup).

**Example**

```
$ docker exec rdoc-lc-bot npm run admin -- room members alliance-chat
1234567890123456789:1502194151712886965  webhookId=1502214942315774045
1234567890123456789:1502597899832393880  webhookId=1502598370173255761
9876543210987654321:1503001112223334445  webhookId=1503010001112223334
```

---

## `state cleanup`

Verify that every bridged channel still exists in Discord, and remove bindings whose channels (or whose entire guild) are gone. This is the cure for `/bridge list` showing a deleted channel as `unbekannt` (German Discord client) or `unknown` (English) — the bot never received a `/bridge leave` because the channel was deleted out from under it.

```
admin.js state cleanup [--room=<name>]
```

**Flags**

| Name | Required | Notes |
|---|---|---|
| `--room=<name>` | no | Limit the scan to one room. Without it, every room is scanned. |

**Requires** `DISCORD_TOKEN` in the environment — the cleanup logs in as a lightweight Discord client (intent: `Guilds` only) and asks the API to fetch each stored channel ID.

**What gets pruned**

| Discord API result | Action |
|---|---|
| Channel exists | keep |
| `10003 Unknown Channel` (channel was deleted) | prune |
| `10004 Unknown Guild` (bot was kicked from the guild) | prune |
| Anything else (missing access, rate limit, network error) | skip + log; entry is left alone so a transient outage cannot wipe legitimate state |

Pruning calls the same `rooms.leave(channelId)` path the slash command uses: atomic Redis tx that removes the member from `rdoc:room:<room>:members`, deletes `rdoc:channel:<channelId>`, and drops the room from `rdoc:rooms` if it became empty. Webhooks attached to deleted channels are already gone on Discord's side — no webhook delete is attempted.

**Important**: `state cleanup` runs in a separate process. The main bot's in-memory `channelMap` is not updated by this script. After a successful prune you should restart the bot so it reloads from Redis:

```bash
docker restart rdoc-lc-bot
```

The CLI prints this reminder when it actually removed something.

**Example**

```
$ docker exec rdoc-lc-bot npm run admin -- state cleanup --room=langstreckenfunk
Logged in as RDOC-LC#1234 — 3 guild(s) visible
Scope: room="langstreckenfunk"
- pruned room="langstreckenfunk" guild=1431307397842079777 channel=1502194151712886965  (Unknown Channel (10003))
Done: 2 verified, 1 pruned, 0 skipped (transient errors).
Restart the bot so its in-memory cache reloads:  docker restart rdoc-lc-bot
```

---

## Operator runbook (cheat sheet)

| Want to… | Run |
|---|---|
| Add a new server to an existing room | `token create <room>` (optionally `--guild=<id>`), send the token, they run `/bridge join` |
| Bootstrap a new room | Same — first `/bridge join` creates the room; CLI prints `(NEW)` |
| Revoke a leaked token | `token list` to find prefix → `token revoke <prefix>` |
| Kick a server out of a room | `token create-kick <room> <target-guild-id>` → recipient runs `/bridge kick <token>` |
| Audit room membership | `room list` then `room members <room>` |
| Fix `/bridge list` showing `unbekannt` (deleted channels) | `state cleanup [--room=<name>]` then `docker restart rdoc-lc-bot` |
