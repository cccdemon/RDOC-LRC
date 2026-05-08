# Raumdock-Longrange-Communicator (RDOC-LC)

Self-hosted Discord bot that bridges arbitrary text channels across multiple guilds in near-realtime.

- **One bot, many guilds, many rooms.** A *room* is a named group of channels across guilds that mirror each other.
- **Onboarding by slash command.** New communities run `/bridge join <room>` in the channel they want to attach. No env edits, no redeploy.
- **Webhook fan-out.** Relayed messages display the original sender's name + avatar — not "Bot says...".
- **Near-realtime.** Single Discord Gateway connection (push), in-memory channel-to-room cache (no Redis read on the hot path), webhook fan-out via `Promise.all`. Typical source-to-target latency: 150–500 ms.

## Setup

### 1. Create the Discord application

1. https://discord.com/developers/applications → New Application.
2. **Bot** tab → enable **Message Content Intent** and **Server Members Intent**. Reset and copy the token.
3. **General Information** → copy the **Application ID**.
4. **OAuth2 → URL Generator** → scopes: `bot`, `applications.commands`. Bot permissions: `View Channels`, `Send Messages`, `Embed Links`, `Attach Files`, `Manage Webhooks`, `Use Application Commands`.
5. Use that URL to invite the bot to every guild you want bridged. Owners of new communities use the same URL — no separate bot per guild.

### 2. Configure and run

```bash
cp .env.example .env
# Edit .env — set DISCORD_TOKEN and DISCORD_APP_ID

docker compose up -d --build
docker compose logs -f bot
```

Health: `curl http://localhost:3007/health`

### 3. Link channels into rooms

In each guild, in the channel that should bridge:

```
/bridge join alliance-chat
```

Repeat in every other guild for the same room name. Add more rooms (e.g. `traders`, `events`) any time. Channels can leave and rejoin freely.

## Slash commands

| Command | Effect |
|---|---|
| `/bridge join <room>` | Link the current channel to a room (creates a webhook in this channel) |
| `/bridge leave` | Unlink the current channel and delete its webhook |
| `/bridge list` | Channels in this guild that are linked to bridge rooms |
| `/bridge rooms` | All known rooms and their member counts |

All commands require **Manage Channels** in the executing guild.
Room-name rule: `^[a-z0-9][a-z0-9-]{1,30}$`.

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

Redis only. No SQL.

| Key | Type | Contents |
|---|---|---|
| `rdoc:rooms` | SET | All room names |
| `rdoc:room:<name>:members` | SET | `"<guildId>:<channelId>"` for each member |
| `rdoc:channel:<channelId>` | HASH | `{ room, guildId, webhookUrl, webhookId }` |

Joins/leaves are atomic Redis transactions. The bot rebuilds its in-memory cache from Redis on startup.

## Out of scope (v1)

- Edits and deletes are not propagated.
- Stickers, voice messages, replies-as-quotes, custom-emoji rewriting are passed through as-is or stripped.
- Cross-guild @mentions never resolve — Discord shows them as raw IDs. Mentions are also disabled on relayed messages (`allowedMentions: { parse: [] }`) so the bot can't ping anyone via a relay.
- No moderation features (banlist, slowmode, anti-spam) — rely on each guild's native moderation tools per channel.

## Local development (without Docker)

```bash
npm install
DISCORD_TOKEN=... DISCORD_APP_ID=... REDIS_HOST=127.0.0.1 npm run dev
```

`npm run dev` runs the bot under `node --watch` for auto-restart on file changes.
