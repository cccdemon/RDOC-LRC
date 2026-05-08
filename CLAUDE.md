# CLAUDE.md

Guidance for Claude Code working on this repo.

# Raumdock-Longrange-Communicator (RDOC-LC)

## Overview
Self-hosted Discord bot that bridges arbitrary text channels across multiple guilds in near-realtime. Designed so new communities can attach with a single in-Discord slash command — no env edits, no redeploy.

## Architecture

| Component | Container | Port | Purpose |
|---|---|---|---|
| `bot`   | rdoc-lc-bot   | 3007 | discord.js gateway client + webhook fan-out + slash commands + /health |
| Redis   | rdoc-lc-redis | 6379 (internal) | Persistent room/channel registry |

Single Node.js process. No HTTP exposure beyond `/health`. No PostgreSQL.

## Concepts

- **Room**: named group of channels across guilds that mirror each other (e.g. `alliance-chat`, `traders`).
- **Channel binding**: one channel ↔ at most one room. Stored as `{ guildId, channelId, webhookUrl, webhookId, room }`.
- **Webhook fan-out**: relayed messages are sent through per-target webhooks owned by the bot, so they display the original sender's name + avatar — not the bot.

## Hot path (`messageCreate` → fan-out)

1. Drop if `author.bot || webhookId || system`.
2. Lookup `channelMap[message.channelId]` (in-memory `Map`, populated on boot from Redis). If not in a room, drop.
3. Build webhook payload: `{ username: "<displayName> · <guildName>", avatarURL, content, files: attachment URLs, allowedMentions: { parse: [] } }`.
4. `Promise.all(targets.map(t => webhookClients[t.channelId].send(payload)))`.

**No Redis I/O on the hot path.** Persistent `WebhookClient` instances are kept per channel.

## Files

| File | Purpose |
|---|---|
| `server.js`   | Entry. Loads env, connects Redis, calls `initRooms`, calls `startBot`, starts express `/health`. |
| `bot.js`      | discord.js client. `messageCreate` → `onMessage` (fan-out). `interactionCreate` → `commands.handleInteraction`. Registers slash commands on `ready`. |
| `commands.js` | Slash command builders + `handleInteraction` switch. Subcommands: `join`, `leave`, `list`, `rooms`. All gated on `ManageChannels`. |
| `rooms.js`    | Redis-backed room registry. `initRooms(redis)` populates in-memory `channelMap` / `roomMembers` / `webhookClients`. Mutations (`join`, `leave`) update Redis + cache atomically. |
| `log.js`      | `log(tag, ...)` / `logErr(tag, ...)` helpers — never raw `console.log`. |

## Redis schema

| Key | Type | Contents |
|---|---|---|
| `rdoc:rooms`               | SET  | All room names |
| `rdoc:room:<room>:members` | SET  | `"<guildId>:<channelId>"` |
| `rdoc:channel:<channelId>` | HASH | `{ room, guildId, webhookUrl, webhookId }` |

`join` writes all three in a `MULTI` transaction. `leave` removes from `members` + deletes the channel hash; if the room set becomes empty it's removed from `rdoc:rooms`.

## Discord intents

Required: `Guilds`, `GuildMessages`, `MessageContent` (privileged), `GuildWebhooks`. Privileged intents must be toggled in the Developer Portal.

## Loop prevention

`message.author.bot || message.webhookId || message.system` → drop. Both `bot` and `webhookId` are checked because the bot's own forwarded copies arrive as webhook messages, not bot-account messages.

## Slash commands

`/bridge join <room>` / `leave` / `list` / `rooms`. Registered globally on bot `ready` via REST. Default permission: `ManageChannels`. Replies are ephemeral (`MessageFlags.Ephemeral`).

Room name regex: `^[a-z0-9][a-z0-9-]{1,30}$`.

## Conventions

- Default to no comments. Only add a comment when the WHY is non-obvious.
- `log(tag, ...)` / `logErr(tag, ...)` — never raw `console.log`.
- Strict mode in every JS file (`'use strict'`).
- All slash command replies are ephemeral.
- No PostgreSQL. No HTTP routes other than `/health`.
- All relays disable @mentions via `allowedMentions: { parse: [] }`.
- No emojis in code or docs unless the user explicitly asks.

## Out of scope (intentional, v1)

- Edit / delete propagation
- Replies-as-quotes, stickers, voice messages, embed re-rendering
- Cross-guild emoji / mention rewriting
- Web/admin UI
- Per-room moderation / banlists
- Multiple bot tokens (single bot, all guilds)

## Development

```bash
npm install                      # local dev (without Docker)
docker compose up -d --build     # full stack
docker compose logs -f bot       # tail bot logs
```

`/health` (port 3007) returns `{ status, gateway, guilds, rooms, redis }`.

## Adding a new community

1. Owner of the new guild invites the bot using the OAuth URL (no code change).
2. They run `/bridge join <existing-room>` in the channel they want to attach.
3. Done — the bot creates the webhook and stores the binding in Redis.

No restart, no env edit, no deploy.
