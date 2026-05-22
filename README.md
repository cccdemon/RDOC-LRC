# Discord-Federated-Textchannels (RDOC-LC)
## Raumdock Long Range Communication between Discord Servers

Self-hosted Discord bot that bridges arbitrary text channels across multiple guilds in near-realtime, with **operator-issued one-time tokens** controlling who may join.

- **One bot, many guilds, many rooms.** A *room* is a named group of channels across guilds that mirror each other.
- **Operator-controlled federation.** The host operator (you) issues a single-use token per Discord server you want to admit. Without a valid token, no server can join — even if they know the room name.
- **Webhook fan-out.** Relayed messages display the original sender's name + avatar in the form `From <Server> / <Member>` — not "Bot says...".
- **Public membership announcements.** When a server joins, leaves, or is kicked from a room, all participating channels see a one-line system message (`**New Channel joined - <Server>**`, `**Channel left - <Server>**`, `**Channel removed - <Server>**`) under the `RDOC-LC` system identity.
- **Near-realtime.** Single Discord Gateway connection (push), in-memory channel-to-room cache (no Redis read on the hot path), webhook fan-out via `Promise.all`. Typical source-to-target latency: 150–500 ms.

## Security model

- Joining a room requires a one-time token. Tokens are generated **only via the CLI**, by the host operator. There is no slash command for issuing tokens.
- Each token: single use, room-bound, optional guild-bound, expires (default 7 days).
- `/bridge rooms` shows only rooms **this server** participates in — no cross-guild enumeration.
- Per-guild **audit channel** (optional): receives an embed when a new server joins one of this guild's rooms, when a channel is unlinked, or when a webhook send fails.
- All slash commands require **Manage Channels** and reply ephemerally.
- Relayed messages have `@everyone`, `@here`, role and user pings disabled.

## Setup

### 1. Create the Discord application

1. https://discord.com/developers/applications → New Application.
2. **Bot** tab → enable **Message Content Intent**. Reset and copy the token.
3. **General Information** → copy the **Application ID**.
4. **OAuth2 → URL Generator** → scopes: `bot`, `applications.commands`. Bot permissions: `View Channels`, `Send Messages`, `Embed Links`, `Attach Files`, `Manage Webhooks`, `Use Application Commands`.
5. Use that URL to invite the bot to every guild you want bridged.
https://discord.com/oauth2/authorize?client_id=1502198332594978916&permissions=140123629648&integration_type=0&scope=bot+applications.commands

### 2. Configure and run

```bash
cp .env.example .env
# Edit .env — set DISCORD_TOKEN and DISCORD_APP_ID

docker compose up -d --build
docker compose logs -f bot
```

Health: `curl http://localhost:3007/health`

### 3. Onboard a server (operator workflow)

```bash
# On the host:
docker exec rdoc-lc-bot npm run admin -- token create alliance-chat
# Token:        rdoc-Vk7m-9pXr-Tq2N-aB4d
# Room:         alliance-chat   (NEW — does not exist yet; first join creates it)
# Expires:      2026-05-15 09:43:00 UTC  (168h)
# Guild bind:   (none — any guild can use)
```

Send the printed token out-of-band (DM, Signal, email) to the admin of the receiving Discord server. They run, in the channel they want to bridge:

```
/bridge join alliance-chat rdoc-Vk7m-9pXr-Tq2N-aB4d
```

Bot creates the webhook, links the channel, consumes the token. Subsequent uses of the same token are rejected.

To bind a token so only one specific guild may consume it (defends against token leakage):

```bash
docker exec rdoc-lc-bot npm run admin -- token create alliance-chat --guild=1234567890123456789
```

The receiving guild's **Server ID**: enable Discord Developer Mode (Settings → Advanced → Developer Mode) → right-click the server icon → Copy Server ID.

## CLI reference

Run inside the container:

```bash
docker exec rdoc-lc-bot npm run admin -- <subcommand>
# or:
docker exec rdoc-lc-bot node bin/admin.js <subcommand>
```

| Subcommand | Purpose |
|---|---|
| `token create <room> [--guild=<id>] [--expires-h=<n>]` | Generate a single-use **join** token. Default expiry 168h. |
| `token create-kick <room> <target-guild-id> [--expires-h=<n>]` | Generate a single-use **kick** token. Whoever runs `/bridge kick <token>` removes the target guild from the room. |
| `token list [--room=<name>]` | List active (unconsumed) tokens with kind, room, expiry, and binding/target. |
| `token revoke <prefix>` | Revoke an unconsumed token (join or kick) by 8+ char prefix. Errors if ambiguous. |
| `room list` | All rooms + member counts. |
| `room members <room>` | List `guildId:channelId` entries in a room. |

## Slash commands

| Command | Effect |
|---|---|
| `/bridge join <room> <token>` | Link this channel to a bridge room. Both args required. |
| `/bridge leave` | Unlink this channel and delete its webhook. |
| `/bridge list` | Channels in this server linked to bridge rooms. |
| `/bridge rooms` | Bridge rooms **this server** participates in (scoped). |
| `/bridge audit-channel [channel]` | Set or clear (omit `channel`) this server's audit log channel. |
| `/bridge kick <token>` | Remove a server from a bridge room. Token (issued by the operator) specifies which room and which guild to remove. |

All require **Manage Channels**. Room-name rule: `^[a-z0-9][a-z0-9-]{1,30}$`.

## Audit events

If a guild has set an audit channel via `/bridge audit-channel`, it receives:

| Event | When |
|---|---|
| **Server joined room** | When any guild consumes a join token to join a room this guild participates in. Cross-guild broadcast. |
| **Server kicked from room** | When a kick token is consumed against a guild in a room this guild participates in. Cross-guild broadcast (also reaches the kicked guild). |
| **Channel unlinked** | When a channel in this guild runs `/bridge leave`. Scoped to leaving guild only. |
| **Webhook send failed** | When a relay outbound from this guild's channel fails. Scoped to source guild only. |

Audit failures (channel deleted, missing permissions) are silently dropped — never block the operational path.

## Environment variables

| Name | Required | Default | Purpose |
|---|---|---|---|
| `DISCORD_TOKEN` | yes | – | Bot token |
| `DISCORD_APP_ID` | yes | – | Application ID (slash command registration) |
| `REDIS_HOST` | no | `redis` | Redis hostname |
| `REDIS_PORT` | no | `6379` | Redis port |
| `REDIS_DB` | no | `0` | Redis DB index |
| `PORT` | no | `3007` | HTTP health port |
| `TZ` | no | `Europe/Berlin` | Container timezone |

## Health endpoint

`GET /health`:

```json
{
  "status": "ok",
  "gateway": "connected",
  "guilds": 3,
  "rooms": { "alliance-chat": 3, "traders": 2 },
  "redis": "ok"
}
```

## Storage

Redis only.

| Key | Type | Contents |
|---|---|---|
| `rdoc:rooms` | SET | All room names |
| `rdoc:room:<name>:members` | SET | `"<guildId>:<channelId>"` for each member |
| `rdoc:channel:<channelId>` | HASH | `{ room, guildId, webhookUrl, webhookId }` |
| `rdoc:tokens` | SET | All active (unconsumed) tokens |
| `rdoc:token:<token>` | HASH | `{ kind: 'join'\|'kick', room, guildId?, targetGuildId?, createdAt, expiresAt }` |
| `rdoc:room:<room>:tokens` | SET | Active tokens for this room |
| `rdoc:guild:<guildId>:audit_channel` | STRING | Configured audit channel ID (nullable) |

Token consumption is atomic via a Redis Lua script — no race condition between two simultaneous `/bridge join` calls.

## Out of scope (current)

- Edits and deletes are not propagated.
- Stickers, voice messages, replies-as-quotes, custom-emoji rewriting are passed through as-is or stripped.
- Cross-guild @mentions never resolve — Discord shows them as raw IDs. Mentions are also disabled on relayed messages so the bot can't ping anyone via a relay.
- No moderation features inside the bridge stream (slowmode, anti-spam) — rely on each guild's native moderation tools. Removing an entire guild from a room is supported via `/bridge kick <token>` (token issued by the operator).

## Local development (without Docker)

```bash
npm install
DISCORD_TOKEN=... DISCORD_APP_ID=... REDIS_HOST=127.0.0.1 npm run dev
```

`npm run dev` runs the bot under `node --watch` for auto-restart on file changes.

CLI against a non-Docker Redis:

```bash
REDIS_HOST=127.0.0.1 npm run admin -- token create alliance-chat
```

## License

GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). See [LICENSE](LICENSE) for the full text.

The Affero clause matters here: if you run a modified version of RDOC-LC as a network service that other people interact with (over Discord, HTTP, anything), you must offer those users the corresponding source of your modified version. Plain GPL would not require that for hosted-service use; AGPL closes that gap.


# Open Tasks:

- Add Havensupport (https://ancsemi.github.io/Haven/) 
- better interface (a WebGUI)