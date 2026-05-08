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
- **One-time token**: operator-generated single-use string of the form `rdoc-XXXX-XXXX-XXXX-XXXX` (Crockford base32, ~80 bits entropy). Two kinds:
  - **`join`**: bound to a room name; optionally bound to a specific guild ID. Required for `/bridge join`.
  - **`kick`**: bound to a (room, target-guild-id) pair. Required for `/bridge kick`. Whoever runs the slash command in any guild executes the kick.
- **Audit channel**: optional per-guild text channel that receives bridge events affecting rooms this guild participates in.

## Hot path (`messageCreate` → fan-out)

1. Drop if `author.bot || webhookId || system`.
2. Lookup `channelMap[message.channelId]` (in-memory `Map`, populated on boot from Redis). If not in a room, drop.
3. Build webhook payload: `{ username: "From <guildName> / <displayName>", avatarURL, content, files: attachment URLs, allowedMentions: { parse: [] } }`. Username is truncated to 80 chars (Discord limit).
4. `Promise.all(targets.map(t => webhookClients[t.channelId].send(payload)))`.
5. On any send failure → fire-and-forget `audit.webhookError({ sourceGuildId, ... })` (scoped to source guild's audit channel).

**No Redis I/O on the hot path.** Persistent `WebhookClient` instances are kept per channel.

## Files

| File | Purpose |
|---|---|
| `server.js`     | Entry. Loads env, connects Redis, calls `initRooms`, `tokens.init`, `startBot`, starts express `/health`. |
| `bot.js`        | discord.js client. `messageCreate` → `onMessage` (fan-out). `interactionCreate` → `commands.handleInteraction`. On `clientReady` registers slash commands and schedules `tokens.sweepExpired()` every 30 minutes. |
| `commands.js`   | Slash command builders + `handleInteraction` switch. Subcommands: `join`, `leave`, `list`, `rooms`, `audit-channel`, `kick`. All gated on `ManageChannels`. |
| `rooms.js`      | Redis-backed room registry. `initRooms(redis)` populates in-memory `channelMap` / `roomMembers` / `webhookClients`. Mutations (`join`, `leave`) update Redis + cache atomically. Also stores per-guild audit channel. |
| `tokens.js`     | Token registry. `create` / `createKick` / `consume` / `consumeKick` (each via its own atomic Redis Lua script, distinguished by the `kind` HASH field). `revoke` / `list` / `sweepExpired`. Token format regex + alphabet defined here. |
| `audit.js`      | `init(client)` + helpers (`tokenConsumed`, `channelLeft`, `webhookError`, `serverKicked`). Looks up each recipient's audit channel via `rooms.getGuildAuditChannel`. Failures are caught and logged; never block operations. |
| `bin/admin.js`  | CLI tool. Connects to Redis, runs subcommand, exits. Subcommands: `token create / create-kick / list / revoke`, `room list / members`. |
| `log.js`        | `log(tag, ...)` / `logErr(tag, ...)` helpers — never raw `console.log`. |

## Redis schema

| Key | Type | Contents |
|---|---|---|
| `rdoc:rooms`                          | SET    | All room names |
| `rdoc:room:<room>:members`            | SET    | `"<guildId>:<channelId>"` |
| `rdoc:channel:<channelId>`            | HASH   | `{ room, guildId, webhookUrl, webhookId }` |
| `rdoc:tokens`                         | SET    | All active (unconsumed) tokens (any kind) |
| `rdoc:token:<token>`                  | HASH   | `{ kind: 'join'\|'kick', room, guildId?, targetGuildId?, createdAt, expiresAt }` (also has `PEXPIREAT` for safety) |
| `rdoc:room:<room>:tokens`             | SET    | Active tokens for this room (both kinds) |
| `rdoc:guild:<guildId>:audit_channel`  | STRING | Configured audit channel ID (nullable) |

## Token consumption — atomic Lua scripts

Two scripts, one per kind. Both are atomic; two simultaneous calls cannot both succeed.

**`CONSUME_JOIN_LUA`** — used by `tokens.consume({ token, room, guildId })`:
1. Token hash exists → else `NOT_FOUND`
2. `kind` field is `'join'` or unset → else `WRONG_KIND`
3. Expiry not past → else delete + `EXPIRED`
4. `room` field matches expected → else `ROOM_MISMATCH`
5. `guildId` field, if set, matches caller → else `GUILD_MISMATCH`
6. `DEL` token hash, remove from `rdoc:tokens` and `rdoc:room:<room>:tokens`. Return hash data.

**`CONSUME_KICK_LUA`** — used by `tokens.consumeKick({ token })`:
1. Token hash exists → else `NOT_FOUND`
2. `kind` field is `'kick'` → else `WRONG_KIND`
3. Expiry not past → else delete + `EXPIRED`
4. `DEL` + remove from sets. Return hash data containing `room` and `targetGuildId`.

Errors come back as `redis.error_reply(...)`; the JS wrapper translates them into a `TokenError` with a code field.

## Sweep

`tokens.sweepExpired()` runs once on `clientReady` and then every 30 min. Walks `rdoc:tokens`, deletes any tokens whose `expiresAt` is past or whose hash is missing. Idempotent.

## Discord intents

Required: `Guilds`, `GuildMessages`, `MessageContent` (privileged), `GuildWebhooks`. **Server Members Intent is NOT required** — member.displayName is included in MESSAGE_CREATE payloads automatically.

## Loop prevention

`message.author.bot || message.webhookId || message.system` → drop. Both `bot` and `webhookId` are checked because the bot's own forwarded copies arrive as webhook messages, not bot-account messages.

## Slash commands

`/bridge join <room> <token>` / `leave` / `list` / `rooms` / `audit-channel <channel?>` / `kick <token>`. Registered globally on `clientReady` via REST. Default permission: `ManageChannels`. Replies are ephemeral (`MessageFlags.Ephemeral`).

`/bridge kick` consumes a kick token whose payload encodes both the room and the target guild. The runner's guild does not need to be in the room — anyone with the token + Manage Channels in any guild can execute it. The slash command runner's identity is logged in the audit embed for accountability. The kick removes ALL of the target guild's channel bindings in the specified room and deletes their webhooks; failures during webhook deletion are logged but do not block the in-Redis state cleanup.

`/bridge rooms` is **scoped** to the caller's guild — only rooms this guild participates in are shown. Per-room counts include this-guild count and total-across-all-guilds count, since the executing guild is already a member.

## Audit policy

- `tokenConsumed` (server joined room) — broadcast to **all** guilds in the affected room (cross-guild).
- `serverKicked` (server kicked from room) — broadcast to **all** guilds in the affected room (cross-guild). Recipient list is captured BEFORE the kick so the target guild also receives the audit message.
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
   - `docker exec rdoc-lc-bot npm run admin -- token revoke <prefix>` (≥8 chars, must be unambiguous). Works for both join and kick tokens.
4. **Kick a server out of a room.**
   - `docker exec rdoc-lc-bot npm run admin -- token create-kick <room> <target-guild-id>` — issues a kick token. Operator can either run the slash command themselves in any guild they have Manage Channels in, or delegate the action by sending the token to a trusted admin.
   - The recipient runs `/bridge kick <token>`. All of the target guild's channels in that room are unlinked and their webhooks deleted.
5. **Audit room membership.**
   - `docker exec rdoc-lc-bot npm run admin -- room list`
   - `docker exec rdoc-lc-bot npm run admin -- room members <room>`
