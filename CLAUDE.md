# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
| `announcer.js`  | `broadcastSystem(room, content)` + `broadcastRules(room)` + `formatRules(room, rules)`. Public announcement helpers — send webhook messages to every channel in `room` under the `RDOC-LC` system username. `broadcastRules` is a no-op when no rules are set. Errors per target are logged; never throws. |
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
| `rdoc:room:<room>:rules`              | STRING | Room rules Markdown (max 1900 chars). Operator-set via CLI or web UI. |

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

`/bridge join <room> <token>` / `leave` / `list` / `rooms` / `audit-channel <channel?>` / `kick <token>` / `rules`. Registered globally on `clientReady` via REST. Default permission: `ManageChannels`. Replies are ephemeral (`MessageFlags.Ephemeral`) — except `/bridge rules`, which posts the rules as a **public** message into the invoking channel (so the whole guild can read them).

`/bridge kick` consumes a kick token whose payload encodes both the room and the target guild. The runner's guild does not need to be in the room — anyone with the token + Manage Channels in any guild can execute it. The slash command runner's identity is logged in the audit embed for accountability. The kick removes ALL of the target guild's channel bindings in the specified room and deletes their webhooks; failures during webhook deletion are logged but do not block the in-Redis state cleanup.

`/bridge rooms` is **scoped** to the caller's guild — only rooms this guild participates in are shown. Per-room counts include this-guild count and total-across-all-guilds count, since the executing guild is already a member.

## Public membership announcements

When a server joins, leaves, or is kicked, `announcer.broadcastSystem(room, content)` posts a one-line message to every channel in the room under the `RDOC-LC` system username (distinct from relay messages, which use `From <guild> / <member>`).

| Slash command | When the announcement fires | Message |
|---|---|---|
| `/bridge join`  | after `rooms.join(...)` so the new channel's webhook is in the cache and receives it too | `**New Channel joined - <Server>**` |
| `/bridge leave` | **before** webhook deletion, so the leaving channel still sees its own goodbye | `**Channel left - <Server>**` |
| `/bridge kick`  | **before** webhook deletion of any of the kicked guild's channels, after the audit dispatch | `**Channel removed - <Server>**` |

After a successful `/bridge join`, `announcer.broadcastRules(room)` runs as a separate fire-and-forget broadcast — if the room has rules set, every channel in the room (including the newly joined one) receives a webhook post `**Room Rules — <room>**\n\n<markdown>`. If no rules are set the broadcast is a no-op. Failures are logged but never block the join.

The kick announcement resolves the target guild's name from `client.guilds.cache.get(targetGuildId)`. If the bot is not in the kicked guild's cache (e.g. it left after kick processing began), the announcement falls back to the raw guild ID.

`allowedMentions: { parse: [] }` ensures no @everyone / role / user pings ever leak via system announcements.

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
- No PostgreSQL.
- All relays disable @mentions via `allowedMentions: { parse: [] }`.
- No emojis in code or docs unless the user explicitly asks.
- Never expose tokens in logs except as a 13-char prefix (e.g. `token=rdoc-Vk7m-9p...`).

## Out of scope (intentional)

- Edit / delete propagation
- Replies-as-quotes, stickers, voice messages, embed re-rendering
- Cross-guild emoji / mention rewriting
- Per-room rate limiting
- Encryption of webhook URLs at rest

## Development

Node 20+ is required (see `engines` in `package.json`).

```bash
npm install                                          # local dev (without Docker)
npm run dev                                          # node --watch server.js (auto-restart)
docker compose up -d --build                         # full stack
docker compose logs -f bot                           # tail bot logs
docker exec rdoc-lc-bot npm run admin -- <args>      # CLI inside container
```

For local dev against a non-Docker Redis:
`REDIS_HOST=127.0.0.1 DISCORD_TOKEN=... DISCORD_APP_ID=... npm run dev`

There is no test suite, linter, or build step. Iteration is by running the bot (Docker or `npm run dev`) and exercising slash commands against a real Discord application + Redis.

`/health` (port 3007) returns `{ status, gateway, guilds, rooms, redis }`.

## Misc constraints

- Room name regex (enforced in `commands.js` / `bin/admin.js`): `^[a-z0-9][a-z0-9-]{1,30}$`.
- Default token expiry: 168 hours (7 days). Override with `--expires-h=<n>` on `token create` / `token create-kick`.
- Token prefix for `token revoke` must be at least 8 chars and unambiguous; ambiguous prefixes are rejected.

## Web UI (`web/`)

Optional admin UI mounted on the same Express instance as `/health`. Server-rendered EJS with a tiny HTMX layer (polling on the audit page only). Disabled unless `DISCORD_OAUTH_CLIENT_ID`, `DISCORD_OAUTH_CLIENT_SECRET`, and `WEB_PUBLIC_URL` are all set.

### Layout

| File | Purpose |
|---|---|
| `web/index.js`         | `mountWeb(app, redis)` — wires session, OAuth callback, routers, 404 + 500 handlers. Reads env vars; bails out (no mount) if OAuth config absent. |
| `web/session.js`       | Redis-backed sessions (no `express-session` dep). 32-byte base64url session ID in HttpOnly+SameSite=Lax cookie. CSRF token generated on login, stored in the session HASH. Flash helper (`res.flash` / `req.consumeFlash`) backed by `rdoc:webui:flash:<sid>` with 60s TTL. `destroyAllForUser` scans + deletes all session keys for a Discord user ID (used when removing a user). |
| `web/oauth.js`         | Discord OAuth `identify` scope. Anti-CSRF `state` is stored in `rdoc:webui:oauth:state:<state>` with 600s TTL and is single-use. |
| `web/users.js`         | Role storage (`rdoc:webui:user:<discordUserId>` HASH: `role`, `username`, `addedBy`, `addedAt`, `updatedAt`). `bootstrapAdmin(userId)` ensures the env-configured user is admin on every startup. |
| `web/audit.js`         | `rdoc:webui:audit` LIST. `LPUSH` + `LTRIM` keeps the newest 5000 entries. Read via `list({ limit, offset })` / `count()`. Append never throws. |
| `web/ratelimit.js`     | Atomic `INCR` + `EXPIRE` per `<bucket>:<userIdOrIp>`. 429 with `Retry-After`. Falls open on Redis errors. |
| `web/middleware.js`    | `requireAuth`, `requireRole('admin')`, `requireCsrf` (matches `req.body._csrf` against `req.session.csrf`). |
| `web/routes/tokens.js` | `/tokens` listing + create-join / create-kick / revoke (admin). Rate-limited bucket `token-create` 60/min/user. |
| `web/routes/rooms.js`  | `/rooms` + `/rooms/:room` + per-room and global prune (admin) + per-room weblink mode + allowlist add/remove/clear (admin). |
| `web/routes/users.js`  | Admin-only. Add, change role, remove (also calls `session.destroyAllForUser`). Refuses self-removal, self-demotion, and last-admin demotion/removal. Factory: `createUsersRouter(redis)`. |
| `web/routes/audit.js`  | Admin-only `/audit` (paginated 50/page) and `/audit/fragment` (rows-only, HTMX target). |
| `web/views/`           | EJS partials: `_header.ejs`, `_footer.ejs`; pages: `login`, `dashboard`, `tokens`, `rooms`, `room-detail`, `room-weblink`, `users`, `audit`, `audit-rows` (HTMX partial), `error`. |
| `web/public/`          | `style.css`, `htmx.min.js` (v2.0.4, self-hosted, ~51 KB). |

### Auth & role flow

1. Anonymous GET `/login` → click → `/auth/start` → 302 to Discord OAuth (`scope=identify`).
2. `/auth/callback?code&state` — consumes `state` from Redis (single-use), exchanges `code` for an access token, fetches `users/@me`.
3. Lookup `rdoc:webui:user:<id>`. If absent: 403 + `auth.login.unauthorized` audit entry. If present: `setUsername`, issue session, audit `auth.login`.
4. Session cookie `rdoc_sid` HttpOnly+SameSite=Lax+Secure (Secure inferred from `X-Forwarded-Proto: https` — `trust proxy` is set).

Role gating is **per-route via middleware**, not based on the rendered UI alone — moderators can still see `/tokens` and `/rooms` but POST to `/tokens/revoke`, `/rooms/*/prune`, `/rooms/*/weblink/*`, or any `/users/*` returns 403.

### Role matrix

| Action | Moderator | Admin |
|---|---|---|
| View/create join+kick tokens | ✓ | ✓ |
| Revoke token |   | ✓ |
| View rooms + members | ✓ | ✓ |
| Prune stale channels (per-room or global) |   | ✓ |
| Per-room weblink mode + allowlist |   | ✓ |
| Manage web UI users (add/role/remove) |   | ✓ |
| View audit log |   | ✓ |

### Redis keys added by the web UI

```
rdoc:webui:user:<discordUserId>  HASH  { role, username, addedBy, addedAt, updatedAt }
rdoc:webui:users                 SET   member user IDs (for listing)
rdoc:webui:session:<sid>         HASH  { userId, username, role, loginAt, csrf } + PEXPIREAT 7d
rdoc:webui:flash:<sid>           STRING (JSON) EXPIRE 60s
rdoc:webui:oauth:state:<state>   STRING (returnTo) EXPIRE 600s, single-use
rdoc:webui:audit                 LIST   JSON entries, LTRIM to 5000
rdoc:webui:rl:<bucket>:<key>     STRING counter + EXPIRE windowSec
```

### Live behavior

- `pruneStale` reuses `bot.getClient()` instead of spinning up a separate Discord login (the `state cleanup` CLI subcommand does its own login because it has no live process).
- Audit page (`/audit?page=0`) polls `/audit/fragment` every 5s via htmx `hx-trigger="every 5s"`. Older pages don't poll.
- Newly-created tokens are shown **once** in a flash banner with a copy-to-clipboard button. After that they appear in the table only as 13-char prefixes; revoke sends only the prefix back to the server.

### Production deployment

Sits behind LXC 101's TLS-passthrough SNI router. New hostname `relay.raumdock.org`. The TLS-terminating upstream is the existing Caddy on `10.10.10.99:443` (the one that fronts `*.streaming.raumdock.org`); add a vhost there proxying to the bot's `:3007`.

**LXC 101** (`/etc/nginx/stream.d/minecraft.raumdock.org.conf`) — extend the SNI map; reuse the existing `10.10.10.99:443` upstream, no new upstream block:

```
map $ssl_preread_server_name $upstream {
  ...
  relay.raumdock.org    <existing-upstream-for-:443>;
}
```

**Caddy on 10.10.10.99**:

```caddyfile
relay.raumdock.org {
  reverse_proxy 127.0.0.1:3007
}
```

`/health` stays open (no auth) so existing monitoring keeps working. Every other path goes through the session middleware.

### Web UI env vars

| Name | Required | Notes |
|---|---|---|
| `DISCORD_OAUTH_CLIENT_ID` / `DISCORD_OAUTH_CLIENT_SECRET` | only if web UI enabled | From Discord developer portal → OAuth2. |
| `WEB_PUBLIC_URL` | only if web UI enabled | e.g. `https://relay.raumdock.org`. Used to construct the redirect URI. |
| `WEB_SESSION_SECRET` | reserved | Not currently consumed; reserved for a future signed-cookie scheme. |
| `RDOC_BOOTSTRAP_ADMIN_ID` | recommended | Discord user ID granted `admin` on every startup. Recovery hatch. |

The Discord application's OAuth2 redirect URI must be `<WEB_PUBLIC_URL>/auth/callback`.

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
6. **Same operations via the web UI (if enabled).** Browse `https://relay.raumdock.org`; sign in with an authorized Discord account. Tokens, room members, weblink filtering, and audit log are all available without SSH. The CLI remains as a fallback when the UI is unreachable or for scripting.
