#!/usr/bin/env node
'use strict';

const fs = require('fs');
const Redis = require('ioredis');
const tokens = require('../tokens');
const rooms = require('../rooms');

const ROOM_NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const GUILD_ID_RE = /^\d{17,20}$/;

const CFG = {
  redis: {
    host: process.env.REDIS_HOST || 'redis',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    db: parseInt(process.env.REDIS_DB || '0'),
  },
};

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [k, v] = arg.slice(2).split('=', 2);
      flags[k] = v === undefined ? true : v;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function fail(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function fmtDate(ms) {
  return new Date(Number(ms)).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function usage() {
  process.stdout.write([
    'Usage:',
    '  admin.js token create <room> [--guild=<id>] [--expires-h=<hours>]',
    '  admin.js token create-kick <room> <target-guild-id> [--expires-h=<hours>]',
    '  admin.js token list [--room=<name>]',
    '  admin.js token revoke <prefix>           (prefix: at least 8 chars)',
    '  admin.js room list',
    '  admin.js room members <room>',
    '  admin.js room rules <room>',
    '  admin.js room set-rules <room> [--file=<path>]   (without --file: reads Markdown from stdin)',
    '  admin.js room clear-rules <room>',
    '  admin.js room mention-mode <room> <off|names-only|resolve-users>',
    '  admin.js room ban-user <room> <discord-user-id>',
    '  admin.js room unban-user <room> <discord-user-id>',
    '  admin.js room banned-users <room>',
    '  admin.js room badword-mode <room> <off|block|mask>',
    '  admin.js room badword-add <room> <word-or-phrase>',
    '  admin.js room badword-remove <room> <word-or-phrase>',
    '  admin.js room badword-list <room>',
    '  admin.js room badword-clear <room>',
    '  admin.js state cleanup [--room=<name>]',
    '',
    'Notes:',
    '  Default token expiry is 168h (7 days).',
    '  Join token: --guild binds it to a specific Discord guild ID; without it, any guild can use the token (once).',
    '  Kick token: removes <target-guild-id> from <room>. Whoever runs /bridge kick <token> in any guild executes it.',
    '  state cleanup: logs into Discord, verifies every bridged channel exists, and removes bindings to deleted',
    '                 channels/guilds. Requires DISCORD_TOKEN. Restart the bot afterwards so its in-memory cache reloads.',
    '',
  ].join('\n'));
}

async function cmdTokenCreate(args, flags, redis) {
  const room = (args[0] || '').toLowerCase();
  if (!room) fail('usage: token create <room> [--guild=<id>] [--expires-h=<hours>]');
  if (!ROOM_NAME_RE.test(room)) fail('invalid room name (a-z, 0-9, dashes; 2-31 chars; must start with letter or digit)');

  const guildId = flags.guild;
  if (guildId && !GUILD_ID_RE.test(guildId)) fail('invalid --guild= (expected 17-20 digit Discord guild ID)');

  const hours = flags['expires-h'] !== undefined ? parseInt(flags['expires-h']) : 168;
  if (!Number.isFinite(hours) || hours <= 0) fail('--expires-h must be a positive integer');

  const isNewRoom = (await redis.sismember('rdoc:rooms', room)) === 0;

  const result = await tokens.create({
    room,
    guildId: guildId || undefined,
    expiresInMs: hours * 3600 * 1000,
  });

  process.stdout.write([
    `Token:        ${result.token}`,
    `Room:         ${result.room}${isNewRoom ? '   (NEW — does not exist yet; first join creates it)' : ''}`,
    `Expires:      ${fmtDate(result.expiresAt)}  (${hours}h)`,
    `Guild bind:   ${result.guildId || '(none — any guild can use)'}`,
    '',
    'Send the token out-of-band (DM/Signal/email) to the receiving Discord server admin. They run:',
    `  /bridge join ${result.room} ${result.token}`,
    '',
  ].join('\n'));
}

async function cmdTokenCreateKick(args, flags, redis) {
  const room = (args[0] || '').toLowerCase();
  const targetGuildId = args[1];
  if (!room || !targetGuildId) fail('usage: token create-kick <room> <target-guild-id> [--expires-h=<hours>]');
  if (!ROOM_NAME_RE.test(room)) fail('invalid room name');
  if (!GUILD_ID_RE.test(targetGuildId)) fail('invalid target guild ID (expected 17-20 digits)');

  const hours = flags['expires-h'] !== undefined ? parseInt(flags['expires-h']) : 168;
  if (!Number.isFinite(hours) || hours <= 0) fail('--expires-h must be a positive integer');

  const members = await redis.smembers(`rdoc:room:${room}:members`);
  const targetIsMember = members.some(m => m.startsWith(`${targetGuildId}:`));

  const result = await tokens.createKick({
    room,
    targetGuildId,
    expiresInMs: hours * 3600 * 1000,
  });

  process.stdout.write([
    `Kick token:    ${result.token}`,
    `Room:          ${result.room}`,
    `Target guild:  ${result.targetGuildId}${targetIsMember ? '' : '   (WARNING: not currently a member of this room)'}`,
    `Expires:       ${fmtDate(result.expiresAt)}  (${hours}h)`,
    '',
    'Send the token to whoever should execute the kick. They run, in any guild they have Manage Channels:',
    `  /bridge kick ${result.token}`,
    '',
  ].join('\n'));
}

async function cmdTokenList(args, flags) {
  const room = flags.room ? String(flags.room).toLowerCase() : undefined;
  const list = await tokens.list({ room });

  if (list.length === 0) {
    process.stdout.write(room ? `No active tokens for room "${room}".\n` : 'No active tokens.\n');
    return;
  }
  for (const t of list) {
    const tail = t.kind === 'kick'
      ? `target=${t.targetGuildId}`
      : `guild=${t.guildId || '(any)'}`;
    process.stdout.write(
      `${t.token}  kind=${t.kind}  room="${t.room}"  expires=${fmtDate(t.expiresAt)}  ${tail}\n`
    );
  }
}

async function cmdTokenRevoke(args) {
  const prefix = args[0];
  if (!prefix) fail('usage: token revoke <prefix>');

  try {
    const result = await tokens.revoke(prefix);
    process.stdout.write(`Revoked: ${result.token}  (room="${result.room}")\n`);
  } catch (e) {
    fail(e.message);
  }
}

async function cmdRoomList() {
  const summary = rooms.summary();
  const names = Object.keys(summary).sort();
  if (names.length === 0) { process.stdout.write('No rooms.\n'); return; }
  for (const name of names) process.stdout.write(`${name}  ${summary[name]} channel(s)\n`);
}

async function cmdRoomMembers(args) {
  const room = (args[0] || '').toLowerCase();
  if (!room) fail('usage: room members <room>');
  const members = rooms.getRoomMembers(room);
  if (members.length === 0) { process.stdout.write(`No members in room "${room}".\n`); return; }
  for (const m of members) {
    const gn = m.guildName || '(unknown)';
    const cn = m.channelName || '(unknown)';
    process.stdout.write(
      `${m.guildId}:${m.channelId}  webhookId=${m.webhookId} discord-name=${gn} channel-name: ${cn}\n`
    );
  }
}

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

async function cmdRoomRules(args) {
  const room = (args[0] || '').toLowerCase();
  if (!room) fail('usage: room rules <room>');
  if (!ROOM_NAME_RE.test(room)) fail('invalid room name');
  const text = await rooms.getRoomRules(room);
  if (!text) { process.stdout.write(`No rules set for room "${room}".\n`); return; }
  process.stdout.write(`# Rules for room "${room}" (${text.length} chars)\n${text}\n`);
}

async function cmdRoomSetRules(args, flags) {
  const room = (args[0] || '').toLowerCase();
  if (!room) fail('usage: room set-rules <room> [--file=<path>]');
  if (!ROOM_NAME_RE.test(room)) fail('invalid room name');

  let text;
  if (flags.file) {
    try { text = fs.readFileSync(String(flags.file), 'utf8'); }
    catch (e) { fail(`could not read --file=${flags.file}: ${e.message}`); }
  } else {
    if (process.stdin.isTTY) {
      fail('no --file= given and stdin is a TTY. Pipe the rules text or use --file=<path>.');
    }
    text = readStdinSync();
  }

  text = text.replace(/\r\n/g, '\n').replace(/^﻿/, '').trim();
  if (!text) fail('rules text is empty');

  try {
    await rooms.setRoomRules(room, text);
  } catch (e) {
    fail(e.message);
  }
  process.stdout.write(`Rules set for room "${room}" (${text.length} chars, max ${rooms.ROOM_RULES_MAX}).\n`);
  process.stdout.write('They will be posted to every channel in the room on the next /bridge join, and on /bridge rules.\n');
}

async function cmdRoomClearRules(args) {
  const room = (args[0] || '').toLowerCase();
  if (!room) fail('usage: room clear-rules <room>');
  if (!ROOM_NAME_RE.test(room)) fail('invalid room name');
  await rooms.setRoomRules(room, null);
  process.stdout.write(`Rules cleared for room "${room}".\n`);
}

function requireRoomArg(args, usageText) {
  const room = (args[0] || '').toLowerCase();
  if (!room) fail(usageText);
  if (!ROOM_NAME_RE.test(room)) fail('invalid room name');
  return room;
}

async function cmdRoomMentionMode(args) {
  const room = requireRoomArg(args, 'usage: room mention-mode <room> <off|names-only|resolve-users>');
  const mode = args[1];
  if (!rooms.MENTION_MODES.includes(mode)) fail('mode must be off, names-only, or resolve-users');
  await rooms.setMentionMode(room, mode);
  process.stdout.write(`Mention mode for room "${room}" set to "${mode}".\n`);
}

async function cmdRoomBanUser(args) {
  const room = requireRoomArg(args, 'usage: room ban-user <room> <discord-user-id>');
  const userId = args[1];
  await rooms.addBannedUser(room, userId);
  process.stdout.write(`User ${userId} banned from relaying in room "${room}".\n`);
}

async function cmdRoomUnbanUser(args) {
  const room = requireRoomArg(args, 'usage: room unban-user <room> <discord-user-id>');
  const userId = args[1];
  await rooms.removeBannedUser(room, userId);
  process.stdout.write(`User ${userId} unbanned in room "${room}".\n`);
}

async function cmdRoomBannedUsers(args) {
  const room = requireRoomArg(args, 'usage: room banned-users <room>');
  const ids = await rooms.getBannedUsers(room);
  if (ids.length === 0) { process.stdout.write(`No banned users in room "${room}".\n`); return; }
  for (const id of ids) process.stdout.write(`${id}\n`);
}

async function cmdRoomBadwordMode(args) {
  const room = requireRoomArg(args, 'usage: room badword-mode <room> <off|block|mask>');
  const mode = args[1];
  if (!rooms.BADWORD_MODES.includes(mode)) fail('mode must be off, block, or mask');
  await rooms.setBadwordMode(room, mode);
  process.stdout.write(`Bad-word mode for room "${room}" set to "${mode}".\n`);
}

async function cmdRoomBadwordAdd(args) {
  const room = requireRoomArg(args, 'usage: room badword-add <room> <word-or-phrase>');
  const word = args.slice(1).join(' ').trim();
  await rooms.addBadword(room, word);
  process.stdout.write(`Bad-word entry added to room "${room}".\n`);
}

async function cmdRoomBadwordRemove(args) {
  const room = requireRoomArg(args, 'usage: room badword-remove <room> <word-or-phrase>');
  const word = args.slice(1).join(' ').trim();
  await rooms.removeBadword(room, word);
  process.stdout.write(`Bad-word entry removed from room "${room}".\n`);
}

async function cmdRoomBadwordList(args) {
  const room = requireRoomArg(args, 'usage: room badword-list <room>');
  const config = await rooms.getBadwordConfig(room);
  process.stdout.write(`Mode: ${config.mode}\n`);
  if (config.words.length === 0) { process.stdout.write('No bad-word entries.\n'); return; }
  for (const word of config.words) process.stdout.write(`${word}\n`);
}

async function cmdRoomBadwordClear(args) {
  const room = requireRoomArg(args, 'usage: room badword-clear <room>');
  await rooms.clearBadwords(room);
  process.stdout.write(`Bad-word list cleared for room "${room}".\n`);
}

async function cmdStateCleanup(args, flags) {
  const roomFilter = flags.room ? String(flags.room).toLowerCase() : null;
  if (roomFilter && !ROOM_NAME_RE.test(roomFilter)) fail('invalid --room value');

  const token = process.env.DISCORD_TOKEN;
  if (!token) fail('DISCORD_TOKEN env var required (cleanup verifies channels via the Discord API)');

  const { Client, GatewayIntentBits } = require('discord.js');
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  await new Promise((resolve, reject) => {
    client.once('clientReady', () => resolve());
    client.once('error', reject);
    client.login(token).catch(reject);
  });

  try {
    process.stdout.write(`Logged in as ${client.user.tag} — ${client.guilds.cache.size} guild(s) visible\n`);
    if (roomFilter) process.stdout.write(`Scope: room="${roomFilter}"\n`);

    const result = await rooms.pruneStale(client, { roomFilter });
    for (const d of result.details) {
      process.stdout.write(`- pruned room="${d.room}" guild=${d.guildId} channel=${d.channelId}  (${d.reason})\n`);
    }
    process.stdout.write(`Done: ${result.checked} verified, ${result.evicted} pruned, ${result.skipped} skipped (transient errors).\n`);
    if (result.evicted > 0) {
      process.stdout.write('Restart the bot so its in-memory cache reloads:  docker restart rdoc-lc-bot\n');
    }
  } finally {
    await client.destroy().catch(() => {});
  }
}

const ROUTES = {
  'token create':      cmdTokenCreate,
  'token create-kick': cmdTokenCreateKick,
  'token list':        cmdTokenList,
  'token revoke':      cmdTokenRevoke,
  'room list':         cmdRoomList,
  'room members':      cmdRoomMembers,
  'room rules':        cmdRoomRules,
  'room set-rules':    cmdRoomSetRules,
  'room clear-rules':  cmdRoomClearRules,
  'room mention-mode': cmdRoomMentionMode,
  'room ban-user':     cmdRoomBanUser,
  'room unban-user':   cmdRoomUnbanUser,
  'room banned-users': cmdRoomBannedUsers,
  'room badword-mode': cmdRoomBadwordMode,
  'room badword-add':  cmdRoomBadwordAdd,
  'room badword-remove': cmdRoomBadwordRemove,
  'room badword-list': cmdRoomBadwordList,
  'room badword-clear': cmdRoomBadwordClear,
  'state cleanup':     cmdStateCleanup,
};

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [domain, sub, ...rest] = positional;

  if (!domain || flags.help || flags.h) {
    usage();
    process.exit(domain ? 0 : 1);
  }

  const route = sub ? `${domain} ${sub}` : domain;
  const handler = ROUTES[route];
  if (!handler) {
    process.stderr.write(`unknown command: ${route}\n\n`);
    usage();
    process.exit(1);
  }

  const redis = new Redis({ ...CFG.redis, lazyConnect: true });
  redis.on('error', () => {});

  try {
    await redis.connect();
    tokens.init(redis);
    if (domain === 'room' || domain === 'state') await rooms.initRooms(redis);
    await handler(rest, flags, redis);
  } catch (e) {
    fail(e?.code ? `${e.code}: ${e.message || ''}` : (e.message || String(e)));
  } finally {
    redis.disconnect();
  }
}

main();
