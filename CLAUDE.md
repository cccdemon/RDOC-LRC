# CLAUDE.md

Guidance for Claude Code working on this repo.

# Raumdock-Longrange-Communicator (RDOC-LC)

## Overview
Self-hosted Discord bot that bridges arbitrary text channels across multiple guilds in near-realtime, with **operator-issued one-time tokens** controlling who may join. The bot operator (host admin) is the federation gatekeeper — there is no Discord-side workflow for self-onboarding.

## Architecture

| Component | Container | Port | Purpose |
|---|---|---|---|
| `bot`   | rdoc-lc-bot   | 3007 | discord.js gateway client + webhook fan-out + slash commands + token sweep + /health |
| Redis   | rdoc-lc-redis | 6379 (internal) | Persistent room/channel/token registry |

Single Node.js process. No HTTP exposure beyond `/health`. No PostgreSQL.

## Concepts

- **Room**: named group of channels across guilds that mirror each other.
- **Channel binding**: one channel ↔ at most one room. Stored as `{ guildId, channelId, webhookUrl, webhookId, room }`.
- **Webhook fan-out**: relayed messages are sent through per-target webhooks owned by the bot, so they display the original sender's name + avatar — not the bot.
- **One-time token**: operator-generated single-use string of the form `rdoc-XXXX-XXXX-XXXX-XXXX` (Crockford base32, ~80 bits entropy). Bound to a room name; optionally bound to a specific guild ID. Required for `/bridge join`.
- **Audit channel**: optional per-guild text channel that receives bridge events affecting rooms this guild participates in.

## Hot path (`messageCreate` → fan-out)

1. Drop if `author.bot || webhookId || system`.
2. Lookup `channelMap[message.channelId]` (in-memory `Map`, populated on boot from Redis). If not in a room, drop.
3. Build webhook payload: `{ username: "<displayName> · <guildName>", avatarURL, content, files: attachment URLs, allowedMentions: { parse: [] } }`.
4. `Promise.all(targets.map(t => webhookClients[t.channelId].send(payload)))`.
5. On any send failure → fire-and-forget `audit.webhookError({ sourceGuildId, ... })` (scoped to source guild's audit channel).

**No Redis I/O on the hot path.** Persistent `WebhookClient` instances are kept per channel.

## Files

| File | Purpose |
|---|---|
| `server.js`     | Entry. Loads env, connects Redis, calls `initRooms`, `tokens.init`, `startBot`, starts express `/health`. |
| `bot.js`        | discord.js client. `messageCreate` → `onMessage` (fan-out). `interactionCreate` → `commands.handleInteraction`. On `clientReady` registers slash commands and schedules `tokens.sweepExpired()` every 30 minutes. |
| `commands.js`   | Slash command builders + `handleInteraction` switch. Subcommands: `join`, `leave`, `list`, `rooms`, `audit-channel`. All gated on `ManageChannels`. |
| `rooms.js`      | Redis-backed room registry. `initRooms(redis)` populates in-memory `channelMap` / `roomMembers` / `webhookClients`. Mutations (`join`, `leave`) update Redis + cache atomically. Also stores per-guild audit channel. |
| `tokens.js`     | Token registry. `create`, `consume` (atomic via Redis Lua), `revoke`, `list`, `sweepExpired`. Token format regex + alphabet defined here. |
| `audit.js`      | `init(client)` + helpers (`tokenConsumed`, `channelLeft`, `webhookError`). Looks up each recipient's audit channel via `rooms.getGuildAuditChannel`. Failures are caught and logged; never block operations. |
| `bin/admin.js`  | CLI tool. Connects to Redis, runs subcommand, exits. Subcommands: `token create/list/revoke`, `room list/members`. |
| `log.js`        | `log(tag, ...)` / `logErr(tag, ...)` helpers — never raw `console.log`. |

## Redis schema

| Key | Type | Contents |
|---|---|---|
| `rdoc:rooms`                          | SET    | All room names |
| `rdoc:room:<room>:members`            | SET    | `"<guildId>:<channelId>"` |
| `rdoc:channel:<channelId>`            | HASH   | `{ room, guildId, webhookUrl, webhookId }` |
| `rdoc:tokens`                         | SET    | All active (unconsumed) tokens |
| `rdoc:token:<token>`                  | HASH   | `{ room, guildId?, createdAt, expiresAt }` (also has `PEXPIREAT` for safety) |
| `rdoc:room:<room>:tokens`             | SET    | Active tokens for this room |
| `rdoc:guild:<guildId>:audit_channel`  | STRING | Configured audit channel ID (nullable) |

## Token consumption — atomic Lua script

`tokens.consume({ token, room, guildId })` calls a Redis Lua script that:

1. Checks token hash exists → else `NOT_FOUND`
2. Reads expiry → if past, deletes token and returns `EXPIRED`
3. Compares `room` field to expected → `ROOM_MISMATCH`
4. If `guildId` field is set, compares to caller → `GUILD_MISMATCH`
5. `DEL`s the token hash, removes from `rdoc:tokens` and `rdoc:room:<room>:tokens`
6. Returns the hash data

Errors come back as `redis.error_reply(...)`; the JS wrapper translates them into a `TokenError` with a code field. Two simultaneous calls cannot both succeed — Redis runs the script atomically.

## Sweep

`tokens.sweepExpired()` runs once on `clientReady` and then every 30 min. Walks `rdoc:tokens`, deletes any tokens whose `expiresAt` is past or whose hash is missing. Idempotent.

## Discord intents

Required: `Guilds`, `GuildMessages`, `MessageContent` (privileged), `GuildWebhooks`. **Server Members Intent is NOT required** — member.displayName is included in MESSAGE_CREATE payloads automatically.

## Loop prevention

`message.author.bot || message.webhookId || message.system` → drop. Both `bot` and `webhookId` are checked because the bot's own forwarded copies arrive as webhook messages, not bot-account messages.

## Slash commands

`/bridge join <room> <token>` / `leave` / `list` / `rooms` / `audit-channel <channel?>`. Registered globally on `clientReady` via REST. Default permission: `ManageChannels`. Replies are ephemeral (`MessageFlags.Ephemeral`).

`/bridge rooms` is **scoped** to the caller's guild — only rooms this guild participates in are shown. Per-room counts include this-guild count and total-across-all-guilds count, since the executing guild is already a member.

## Audit policy

- `tokenConsumed` (server joined room) — broadcast to **all** guilds in the affected room (cross-guild).
- `channelLeft` — only the leaving guild.
- `webhookError` — only the source guild.

Posts are best-effort `EmbedBuilder` messages. Audit channel can be deleted, bot can lack permissions — every failure is logged but does not block the originating operation.

## CLI (`bin/admin.js`)

Designed to be run with `docker exec rdoc-lc-bot node bin/admin.js ...` (or `npm run admin -- ...`). Connects to the same Redis as the bot, uses the same token format and Redis keys.

`token create` outputs a flag indicating whether the room is new or already exists. Operator can pre-issue tokens for non-existent rooms — first join creates the room as a side effect.

## Conventions

- Default to no comments. Only add a comment when the WHY is non-obvious.
- `log(tag, ...)` / `logErr(tag, ...)` — never raw `console.log`.
- Strict mode in every JS file (`'use strict'`).
- All slash command replies are ephemeral.
- No PostgreSQL. No HTTP routes other than `/health`.
- All relays disable @mentions via `allowedMentions: { parse: [] }`.
- No emojis in code or docs unless the user explicitly asks.
- Never expose tokens in logs except as a 13-char prefix (e.g. `token=rdoc-Vk7m-9p...`).

## Out of scope (intentional)

- Edit / delete propagation
- Replies-as-quotes, stickers, voice messages, embed re-rendering
- Cross-guild emoji / mention rewriting
- Web/admin UI
- `/bridge kick` slash command for owner-side removal (CLI workaround: manually clear `rdoc:channel:<id>` + remove from `rdoc:room:<r>:members`)
- Per-room rate limiting
- Encryption of webhook URLs at rest

## Development

```bash
npm install                                          # local dev (without Docker)
docker compose up -d --build                         # full stack
docker compose logs -f bot                           # tail bot logs
docker exec rdoc-lc-bot npm run admin -- <args>      # CLI inside container
```

`/health` (port 3007) returns `{ status, gateway, guilds, rooms, redis }`.

## Operator runbook

1. **Add a new community to an existing room.**
   - `docker exec rdoc-lc-bot npm run admin -- token create <room>` (optionally `--guild=<id>`).
   - Send token out-of-band to the new community's admin.
   - They run `/bridge join <room> <token>` in the channel they want bridged.
   - Audit log is broadcast to all participating guilds' configured audit channels.
2. **Bootstrap a new room.**
   - Same as above; first token consumption creates the room. The CLI prints a `(NEW)` flag if the room doesn't yet exist.
3. **Revoke a leaked or unwanted token.**
   - `docker exec rdoc-lc-bot npm run admin -- token list` to find the prefix.
   - `docker exec rdoc-lc-bot npm run admin -- token revoke <prefix>` (≥8 chars, must be unambiguous).
4. **Audit room membership.**
   - `docker exec rdoc-lc-bot npm run admin -- room list`
   - `docker exec rdoc-lc-bot npm run admin -- room members <room>`
