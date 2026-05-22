'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const rooms = require('./rooms');
const tokens = require('./tokens');
const audit = require('./audit');
const announcer = require('./announcer');
const { log, logErr } = require('./log');

function shortName(s) { return String(s || '').slice(0, 80); }

const ROOM_NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

const commands = [
  new SlashCommandBuilder()
    .setName('bridge')
    .setDescription('RDOC-LC long-range Discord bridge management')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .setDMPermission(false)
    .addSubcommand(sub => sub
      .setName('join')
      .setDescription('Link this channel to a bridge room (requires a one-time token)')
      .addStringOption(o => o.setName('room')
        .setDescription('Room name')
        .setRequired(true))
      .addStringOption(o => o.setName('token')
        .setDescription('One-time join token (rdoc-XXXX-XXXX-XXXX-XXXX)')
        .setRequired(true)))
    .addSubcommand(sub => sub
      .setName('leave')
      .setDescription('Disconnect this channel from its bridge room'))
    .addSubcommand(sub => sub
      .setName('list')
      .setDescription('Channels in this guild that are linked to bridge rooms'))
    .addSubcommand(sub => sub
      .setName('rooms')
      .setDescription('Bridge rooms this server participates in'))
    .addSubcommand(sub => sub
      .setName('audit-channel')
      .setDescription('Set or clear the audit log channel for this server')
      .addChannelOption(o => o
        .setName('channel')
        .setDescription('Text channel to receive audit events (omit to clear)')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)))
    .addSubcommand(sub => sub
      .setName('kick')
      .setDescription('Remove a server from a bridge room (requires a kick token from the operator)')
      .addStringOption(o => o.setName('target')
        .setDescription('Server to remove (pick from list)')
        .setRequired(true)
        .setAutocomplete(true))
      .addStringOption(o => o.setName('token')
        .setDescription('Kick token (rdoc-XXXX-XXXX-XXXX-XXXX) issued via the operator CLI')
        .setRequired(true)))
    .addSubcommand(sub => sub
      .setName('rules')
      .setDescription('Post this room\'s rules into the current channel'))
    .addSubcommand(sub => sub
      .setName('weblink-mode')
      .setDescription('Set weblink filtering mode for this room federation')
      .addStringOption(o => o.setName('mode')
        .setDescription('Filtering mode')
        .setRequired(true)
        .addChoices(
          { name: 'Disabled (no filtering)', value: 'none' },
          { name: 'Allowlist (only listed domains allowed)', value: 'allowlist' }
        )))
    .addSubcommand(sub => sub
      .setName('weblink-add')
      .setDescription('Add a domain to the weblink filter list for this room federation')
      .addStringOption(o => o.setName('domain')
        .setDescription('Domain to add (e.g., example.com or *.example.com for wildcards)')
        .setRequired(true)))
    .addSubcommand(sub => sub
      .setName('weblink-remove')
      .setDescription('Remove a domain from the weblink filter list for this room federation')
      .addStringOption(o => o.setName('domain')
        .setDescription('Domain to remove')
        .setRequired(true)))
    .addSubcommand(sub => sub
      .setName('weblink-list')
      .setDescription('Show current weblink filtering configuration for this room federation'))
    .addSubcommand(sub => sub
      .setName('weblink-clear')
      .setDescription('Clear all domains from the weblink filter list for this room federation'))
    .addSubcommand(sub => sub
      .setName('mention-mode')
      .setDescription('Set how user mentions are relayed for this room federation')
      .addStringOption(o => o.setName('mode')
        .setDescription('Mention mode')
        .setRequired(true)
        .addChoices(
          { name: 'Off (strip to plain names)', value: 'off' },
          { name: 'Names only (safe default)', value: 'names-only' },
          { name: 'Resolve users when possible', value: 'resolve-users' }
        )))
    .addSubcommand(sub => sub
      .setName('ban-user')
      .setDescription('Ban a Discord user from relaying messages in this room')
      .addStringOption(o => o.setName('user-id')
        .setDescription('Discord user ID')
        .setRequired(true)))
    .addSubcommand(sub => sub
      .setName('unban-user')
      .setDescription('Remove a room relay ban for a Discord user')
      .addStringOption(o => o.setName('user-id')
        .setDescription('Discord user ID')
        .setRequired(true)))
    .addSubcommand(sub => sub
      .setName('banned-users')
      .setDescription('List Discord users banned from relaying in this room'))
    .addSubcommand(sub => sub
      .setName('badword-mode')
      .setDescription('Set bad-word filter mode for this room federation')
      .addStringOption(o => o.setName('mode')
        .setDescription('Bad-word mode')
        .setRequired(true)
        .addChoices(
          { name: 'Off', value: 'off' },
          { name: 'Block matching messages', value: 'block' },
          { name: 'Mask matches with ***', value: 'mask' }
        )))
    .addSubcommand(sub => sub
      .setName('badword-add')
      .setDescription('Add a word or phrase to the room bad-word filter')
      .addStringOption(o => o.setName('word')
        .setDescription('Word or phrase to match')
        .setRequired(true)))
    .addSubcommand(sub => sub
      .setName('badword-remove')
      .setDescription('Remove a word or phrase from the room bad-word filter')
      .addStringOption(o => o.setName('word')
        .setDescription('Word or phrase to remove')
        .setRequired(true)))
    .addSubcommand(sub => sub
      .setName('badword-list')
      .setDescription('Show bad-word filter configuration for this room'))
    .addSubcommand(sub => sub
      .setName('badword-clear')
      .setDescription('Clear the room bad-word filter list')),
];

const OPERATOR_SUBCOMMANDS = new Set([
  'weblink-mode',
  'weblink-add',
  'weblink-remove',
  'weblink-list',
  'weblink-clear',
  'mention-mode',
  'ban-user',
  'unban-user',
  'banned-users',
  'badword-mode',
  'badword-add',
  'badword-remove',
  'badword-list',
  'badword-clear',
]);

function operatorUserIds() {
  return [
    process.env.RDOC_BOOTSTRAP_ADMIN_ID || '',
    ...(process.env.RDOC_OPERATOR_USER_IDS || '').split(','),
  ].map(id => id.trim()).filter(Boolean);
}

function isOperatorUser(userId) {
  return operatorUserIds().includes(String(userId || ''));
}

async function handleInteraction(interaction) {
  if (interaction.isAutocomplete?.() && interaction.commandName === 'bridge') {
    return handleAutocomplete(interaction);
  }
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'bridge') return;

  const sub = interaction.options.getSubcommand();
  if (OPERATOR_SUBCOMMANDS.has(sub) && !isOperatorUser(interaction.user.id)) {
    log('Security', `blocked operator-only /bridge ${sub} by user=${interaction.user.id} guild=${interaction.guildId}`);
    return reply(interaction, 'This room-wide moderation setting is operator-only. Ask an RDOC-LRC admin to change it in the web UI or CLI.');
  }

  switch (sub) {
    case 'join':           return handleJoin(interaction);
    case 'leave':          return handleLeave(interaction);
    case 'list':           return handleList(interaction);
    case 'rooms':          return handleRooms(interaction);
    case 'audit-channel':  return handleAuditChannel(interaction);
    case 'kick':           return handleKick(interaction);
    case 'rules':          return handleRules(interaction);
    case 'weblink-mode':   return handleWeblinkMode(interaction);
    case 'weblink-add':    return handleWeblinkAdd(interaction);
    case 'weblink-remove': return handleWeblinkRemove(interaction);
    case 'weblink-list':   return handleWeblinkList(interaction);
    case 'weblink-clear':  return handleWeblinkClear(interaction);
    case 'mention-mode':   return handleMentionMode(interaction);
    case 'ban-user':       return handleBanUser(interaction);
    case 'unban-user':     return handleUnbanUser(interaction);
    case 'banned-users':   return handleBannedUsers(interaction);
    case 'badword-mode':   return handleBadwordMode(interaction);
    case 'badword-add':    return handleBadwordAdd(interaction);
    case 'badword-remove': return handleBadwordRemove(interaction);
    case 'badword-list':   return handleBadwordList(interaction);
    case 'badword-clear':  return handleBadwordClear(interaction);
    default:               return reply(interaction, `Unknown subcommand: ${sub}`);
  }
}

async function handleJoin(interaction) {
  const room = interaction.options.getString('room', true).toLowerCase();
  const token = interaction.options.getString('token', true).trim();

  if (!ROOM_NAME_RE.test(room)) {
    return reply(interaction, 'Invalid room name. Use a-z, 0-9, dashes; 2-31 chars; must start with a letter or digit.');
  }
  if (!tokens.isValidFormat(token)) {
    return reply(interaction, 'Invalid token format. Expected `rdoc-XXXX-XXXX-XXXX-XXXX`.');
  }

  const channel = interaction.channel;
  if (!channel) {
    return reply(interaction, 'Unable to determine channel information. Channel is null/undefined.');
  }

  // For now, allow any text-based channel that is not a thread
  // This should work for text channels, announcement channels, etc.
  if (!channel.isTextBased() || channel.isThread()) {
    return reply(interaction, `This command only works in text-based channels (not threads). Channel type: ${channel.type}, Text-based: ${channel.isTextBased()}, Thread: ${channel.isThread()}`);
  }

  const existing = rooms.getChannel(channel.id);
  if (existing) {
    return reply(interaction, `This channel is already linked to room "${existing.room}". Run /bridge leave first.`);
  }

  try {
    await tokens.consume({ token, room, guildId: channel.guildId });
  } catch (e) {
    const msg = ({
      NOT_FOUND:      'Invalid or already-used token.',
      EXPIRED:        'This token has expired.',
      ROOM_MISMATCH:  'This token is not valid for that room name.',
      GUILD_MISMATCH: 'This token is not valid for this server.',
    })[e.code] || `Token validation failed: ${e.message}`;
    logErr('Join', `token rejected (${e.code || 'ERR'}) room=${room} guild=${channel.guildId}`);
    return reply(interaction, msg);
  }

  let webhook;
  try {
    webhook = await channel.createWebhook({
      name: 'RDOC-LC Relay',
      reason: `Linking #${channel.name} to bridge room "${room}"`,
    });
  } catch (e) {
    logErr('Join', `webhook create failed: ${e.message}`);
    return reply(interaction, `Could not create webhook: ${e.message}. The bot needs the "Manage Webhooks" permission in this channel.`);
  }

  await rooms.join(room, channel.guildId, channel.id, webhook.url, webhook.id, interaction.guild.name, channel.name);

  const total = rooms.getRoomMembers(room).length;
  log('Join', `[${room}] ${interaction.guild.name}#${channel.name} (${channel.id}) — ${total} member(s) total — token=${token.slice(0, 13)}...`);

  audit.tokenConsumed({
    room,
    joiningGuild: interaction.guild,
    joiningChannel: channel,
  }).catch(e => logErr('Audit', e.message));

  announcer.broadcastSystem(room, `**New Channel joined - ${shortName(interaction.guild.name)}**`)
    .catch(e => logErr('System', e.message));

  announcer.broadcastRules(room)
    .catch(e => logErr('System', `rules broadcast failed: ${e.message}`));

  return reply(interaction, `Linked #${channel.name} to room "${room}". This room now has ${total} channel(s) across all servers.`);
}

async function handleRules(interaction) {
  const channel = interaction.channel;
  if (!channel) {
    return reply(interaction, 'Unable to determine channel information.');
  }
  const entry = rooms.getChannel(channel.id);
  if (!entry) {
    return reply(interaction, 'This channel is not linked to any bridge room.');
  }

  const rulesText = await rooms.getRoomRules(entry.room);
  if (!rulesText) {
    return reply(interaction, `No rules set for room "${entry.room}". Ask the operator to set them.`);
  }

  return interaction.reply({
    content: announcer.formatRules(entry.room, rulesText),
    allowedMentions: { parse: [] },
  });
}

async function handleLeave(interaction) {
  const channel = interaction.channel;
  const entry = rooms.getChannel(channel.id);
  if (!entry) return reply(interaction, 'This channel is not linked to any bridge room.');

  await announcer.broadcastSystem(entry.room, `**Channel left - ${shortName(interaction.guild.name)}**`)
    .catch(e => logErr('System', e.message));

  try {
    const wh = await interaction.client.fetchWebhook(entry.webhookId).catch(() => null);
    if (wh) await wh.delete('Unlinking from RDOC-LC bridge room');
  } catch (e) {
    logErr('Leave', `webhook delete failed (continuing): ${e.message}`);
  }

  await rooms.leave(channel.id);
  log('Leave', `[${entry.room}] ${interaction.guild.name}#${channel.name} (${channel.id})`);

  audit.channelLeft({
    room: entry.room,
    leavingGuildId: entry.guildId,
    channelId: channel.id,
  }).catch(e => logErr('Audit', e.message));

  return reply(interaction, `Unlinked #${channel.name} from room "${entry.room}".`);
}

async function handleList(interaction) {
  const entries = rooms.getGuildChannels(interaction.guildId);
  if (entries.length === 0) return reply(interaction, 'No channels in this server are linked to a bridge room.');

  const byRoom = new Map();
  for (const e of entries) {
    if (!byRoom.has(e.room)) byRoom.set(e.room, []);
    byRoom.get(e.room).push(e);
  }

  const lines = [];
  for (const room of [...byRoom.keys()].sort()) {
    lines.push(`**Room "${room}"**`);

    for (const e of byRoom.get(room)) {
      const ch = interaction.guild.channels.cache.get(e.channelId);
      lines.push(`- Channel here: ${ch ? `#${ch.name}` : `<#${e.channelId}>`}`);
    }

    const members = rooms.getRoomMembers(room);
    const byGuild = new Map();
    for (const m of members) {
      if (!byGuild.has(m.guildId)) byGuild.set(m.guildId, m);
    }

    lines.push(`- Federated servers (${byGuild.size}):`);
    const sortedGuilds = [...byGuild.entries()].sort((a, b) => {
      const an = interaction.client.guilds?.cache?.get(a[0])?.name || a[1].guildName || a[0];
      const bn = interaction.client.guilds?.cache?.get(b[0])?.name || b[1].guildName || b[0];
      return String(an).localeCompare(String(bn));
    });
    for (const [gid, m] of sortedGuilds) {
      const liveName = interaction.client.guilds?.cache?.get(gid)?.name;
      const name = liveName || m.guildName || '(unknown)';
      const here = gid === interaction.guildId ? ' — this server' : '';
      lines.push(`  - ${name} (\`${gid}\`)${here}`);
    }
    lines.push('');
  }

  let content = lines.join('\n').trimEnd();
  if (content.length > 1900) content = content.slice(0, 1900) + '\n…(truncated)';
  return reply(interaction, content);
}

async function handleRooms(interaction) {
  const entries = rooms.getGuildChannels(interaction.guildId);
  if (entries.length === 0) return reply(interaction, 'This server is not part of any bridge room.');

  const byRoom = new Map();
  for (const e of entries) byRoom.set(e.room, (byRoom.get(e.room) || 0) + 1);

  const lines = [...byRoom.keys()].sort().map(room => {
    const here = byRoom.get(room);
    const total = rooms.getRoomMembers(room).length;
    return `- "${room}" — ${here} channel(s) here, ${total} total across all servers`;
  });
  return reply(interaction, lines.join('\n'));
}

async function handleAuditChannel(interaction) {
  const target = interaction.options.getChannel('channel');
  if (!target) {
    await rooms.setGuildAuditChannel(interaction.guildId, null);
    log('Audit', `cleared for guild=${interaction.guildId} (${interaction.guild.name})`);
    return reply(interaction, 'Audit channel cleared. This server will no longer receive bridge audit events.');
  }
  if (target.type !== ChannelType.GuildText) {
    return reply(interaction, 'Audit channel must be a regular text channel.');
  }
  await rooms.setGuildAuditChannel(interaction.guildId, target.id);
  log('Audit', `set for guild=${interaction.guildId} -> channel=${target.id}`);
  return reply(interaction, `Audit channel set to <#${target.id}>. Bridge events for rooms this server participates in will be posted there.`);
}

async function handleKick(interaction) {
  const target = interaction.options.getString('target', true).trim();
  const token = interaction.options.getString('token', true).trim();

  if (!tokens.isValidFormat(token)) {
    return reply(interaction, 'Invalid token format. Expected `rdoc-XXXX-XXXX-XXXX-XXXX`.');
  }
  if (!/^\d{17,20}$/.test(target)) {
    return reply(interaction, 'Invalid target server. Pick one from the autocomplete list.');
  }

  let data;
  try {
    data = await tokens.consumeKick({ token, expectedTargetGuildId: target });
  } catch (e) {
    const msg = ({
      NOT_FOUND:       'Invalid or already-used token.',
      EXPIRED:         'This token has expired.',
      WRONG_KIND:      'This is a join token, not a kick token. Ask the operator for a kick token.',
      TARGET_MISMATCH: 'This kick token does not target the selected server. The token has NOT been consumed — pick the correct server or use the right token.',
    })[e.code] || `Token validation failed: ${e.message}`;
    logErr('Kick', `token rejected (${e.code || 'ERR'})`);
    return reply(interaction, msg);
  }

  const room = data.room;
  const targetGuildId = data.targetGuildId;
  const targets = rooms.getRoomMembers(room).filter(m => m.guildId === targetGuildId);

  if (targets.length === 0) {
    log('Kick', `[${room}] guild=${targetGuildId} not in room (token consumed)`);
    return reply(interaction, `Token was valid but guild \`${targetGuildId}\` has no channels in room "${room}".`);
  }

  audit.serverKicked({
    room,
    targetGuildId,
    executedByGuildId: interaction.guildId,
    executedByUserId: interaction.user.id,
  }).catch(e => logErr('Audit', e.message));

  const targetGuildName = targets[0] && interaction.client.guilds?.cache?.get(targetGuildId)?.name;
  await announcer.broadcastSystem(room, `**Channel removed - ${shortName(targetGuildName || targetGuildId)}**`)
    .catch(e => logErr('System', e.message));

  let removed = 0;
  for (const t of targets) {
    try {
      const wh = await interaction.client.fetchWebhook(t.webhookId).catch(() => null);
      if (wh) await wh.delete('Kicked from RDOC-LC bridge room');
    } catch (e) {
      logErr('Kick', `webhook delete failed for ${t.channelId}: ${e.message}`);
    }
    await rooms.leave(t.channelId);
    removed++;
  }

  log('Kick', `[${room}] guild=${targetGuildId} removed (${removed} channel(s)) by ${interaction.user.tag}@${interaction.guild.name}`);
  return reply(interaction, `Removed ${removed} channel(s) of guild \`${targetGuildId}\` from room "${room}".`);
}

async function handleWeblinkMode(interaction) {
  const mode = interaction.options.getString('mode', true);

  const channel = interaction.channel;
  if (!channel) {
    return reply(interaction, 'Unable to determine channel information. Channel is null/undefined.');
  }

  // For now, allow any text-based channel that is not a thread
  if (!channel.isTextBased() || channel.isThread()) {
    return reply(interaction, `This command only works in text-based channels (not threads). Channel type: ${channel.type}, Text-based: ${channel.isTextBased()}, Thread: ${channel.isThread()}`);
  }

  const entry = rooms.getChannel(channel.id);
  if (!entry) return reply(interaction, 'This channel is not linked to any bridge room.');

  try {
    await rooms.setWeblinkMode('room', entry.room, mode);
    const modeName = {
      'none': 'disabled',
      'allowlist': 'allowlist (only listed domains allowed)'
    }[mode];
    return reply(interaction, `Weblink filtering set to ${modeName} for room federation "${entry.room}".`);
  } catch (e) {
    return reply(interaction, `Error: ${e.message}`);
  }
}

async function handleWeblinkAdd(interaction) {
  const domain = interaction.options.getString('domain', true);

  const channel = interaction.channel;
  if (!channel) {
    return reply(interaction, 'Unable to determine channel information. Channel is null/undefined.');
  }

  // For now, allow any text-based channel that is not a thread
  if (!channel.isTextBased() || channel.isThread()) {
    return reply(interaction, `This command only works in text-based channels (not threads). Channel type: ${channel.type}, Text-based: ${channel.isTextBased()}, Thread: ${channel.isThread()}`);
  }

  const entry = rooms.getChannel(channel.id);
  if (!entry) return reply(interaction, 'This channel is not linked to any bridge room.');

  try {
    await rooms.addToWeblinkList('room', entry.room, domain);
    return reply(interaction, `Added "${domain}" to the weblink filter list for room federation "${entry.room}".`);
  } catch (e) {
    return reply(interaction, `Error: ${e.message}`);
  }
}

async function handleWeblinkRemove(interaction) {
  const domain = interaction.options.getString('domain', true);

  const channel = interaction.channel;
  if (!channel) {
    return reply(interaction, 'Unable to determine channel information. Channel is null/undefined.');
  }

  // For now, allow any text-based channel that is not a thread
  if (!channel.isTextBased() || channel.isThread()) {
    return reply(interaction, `This command only works in text-based channels (not threads). Channel type: ${channel.type}, Text-based: ${channel.isTextBased()}, Thread: ${channel.isThread()}`);
  }

  const entry = rooms.getChannel(channel.id);
  if (!entry) return reply(interaction, 'This channel is not linked to any bridge room.');

  try {
    await rooms.removeFromWeblinkList('room', entry.room, domain);
    return reply(interaction, `Removed "${domain}" from the weblink filter list for room federation "${entry.room}".`);
  } catch (e) {
    return reply(interaction, `Error: ${e.message}`);
  }
}

async function handleWeblinkList(interaction) {
  const channel = interaction.channel;
  if (!channel) {
    return reply(interaction, 'Unable to determine channel information. Channel is null/undefined.');
  }

  // For now, allow any text-based channel that is not a thread
  if (!channel.isTextBased() || channel.isThread()) {
    return reply(interaction, `This command only works in text-based channels (not threads). Channel type: ${channel.type}, Text-based: ${channel.isTextBased()}, Thread: ${channel.isThread()}`);
  }

  const entry = rooms.getChannel(channel.id);
  if (!entry) return reply(interaction, 'This channel is not linked to any bridge room.');

  try {
    const config = await rooms.getWeblinkConfig('room', entry.room);
    const modeName = {
      'none': 'Disabled (no filtering)',
      'allowlist': 'Allowlist (only listed domains allowed)'
    }[config.mode];

    let response = `**Weblink filtering for room federation "${entry.room}":**\nMode: ${modeName}`;

    if (config.list.length > 0) {
      response += '\n\n**Domains:**\n' + config.list.map(d => `- ${d}`).join('\n');
    } else {
      response += '\n\n**Domains:** (none configured)';
    }

    return reply(interaction, response);
  } catch (e) {
    return reply(interaction, `Error: ${e.message}`);
  }
}

async function handleWeblinkClear(interaction) {
  const channel = interaction.channel;
  if (!channel) {
    return reply(interaction, 'Unable to determine channel information. Channel is null/undefined.');
  }

  // For now, allow any text-based channel that is not a thread
  if (!channel.isTextBased() || channel.isThread()) {
    return reply(interaction, `This command only works in text-based channels (not threads). Channel type: ${channel.type}, Text-based: ${channel.isTextBased()}, Thread: ${channel.isThread()}`);
  }

  const entry = rooms.getChannel(channel.id);
  if (!entry) return reply(interaction, 'This channel is not linked to any bridge room.');

  try {
    await rooms.clearWeblinkList('room', entry.room);
    return reply(interaction, `Cleared all domains from the weblink filter list for room federation "${entry.room}".`);
  } catch (e) {
    return reply(interaction, `Error: ${e.message}`);
  }
}

function currentRoomEntry(interaction) {
  const channel = interaction.channel;
  if (!channel) return { error: 'Unable to determine channel information. Channel is null/undefined.' };
  if (!channel.isTextBased() || channel.isThread()) {
    return { error: `This command only works in text-based channels (not threads). Channel type: ${channel.type}, Text-based: ${channel.isTextBased()}, Thread: ${channel.isThread()}` };
  }
  const entry = rooms.getChannel(channel.id);
  if (!entry) return { error: 'This channel is not linked to any bridge room.' };
  return { channel, entry };
}

async function handleMentionMode(interaction) {
  const { entry, error } = currentRoomEntry(interaction);
  if (error) return reply(interaction, error);
  const mode = interaction.options.getString('mode', true);
  try {
    await rooms.setMentionMode(entry.room, mode);
    return reply(interaction, `Mention mode for room "${entry.room}" set to "${mode}".`);
  } catch (e) {
    return reply(interaction, `Error: ${e.message}`);
  }
}

async function handleBanUser(interaction) {
  const { entry, error } = currentRoomEntry(interaction);
  if (error) return reply(interaction, error);
  const userId = interaction.options.getString('user-id', true).trim();
  try {
    await rooms.addBannedUser(entry.room, userId);
    log('Moderation', `ban-user room=${entry.room} user=${userId} by=${interaction.user.id}`);
    return reply(interaction, `User \`${userId}\` is now banned from relaying in room "${entry.room}".`);
  } catch (e) {
    return reply(interaction, `Error: ${e.message}`);
  }
}

async function handleUnbanUser(interaction) {
  const { entry, error } = currentRoomEntry(interaction);
  if (error) return reply(interaction, error);
  const userId = interaction.options.getString('user-id', true).trim();
  try {
    await rooms.removeBannedUser(entry.room, userId);
    log('Moderation', `unban-user room=${entry.room} user=${userId} by=${interaction.user.id}`);
    return reply(interaction, `User \`${userId}\` is no longer banned from relaying in room "${entry.room}".`);
  } catch (e) {
    return reply(interaction, `Error: ${e.message}`);
  }
}

async function handleBannedUsers(interaction) {
  const { entry, error } = currentRoomEntry(interaction);
  if (error) return reply(interaction, error);
  const ids = await rooms.getBannedUsers(entry.room);
  if (ids.length === 0) return reply(interaction, `No users are banned in room "${entry.room}".`);
  return reply(interaction, `Banned users in "${entry.room}":\n` + ids.map(id => `- \`${id}\``).join('\n'));
}

async function handleBadwordMode(interaction) {
  const { entry, error } = currentRoomEntry(interaction);
  if (error) return reply(interaction, error);
  const mode = interaction.options.getString('mode', true);
  try {
    await rooms.setBadwordMode(entry.room, mode);
    return reply(interaction, `Bad-word filter mode for room "${entry.room}" set to "${mode}".`);
  } catch (e) {
    return reply(interaction, `Error: ${e.message}`);
  }
}

async function handleBadwordAdd(interaction) {
  const { entry, error } = currentRoomEntry(interaction);
  if (error) return reply(interaction, error);
  const word = interaction.options.getString('word', true);
  try {
    await rooms.addBadword(entry.room, word);
    log('Moderation', `badword-add room=${entry.room} by=${interaction.user.id}`);
    return reply(interaction, `Added bad-word filter entry to room "${entry.room}".`);
  } catch (e) {
    return reply(interaction, `Error: ${e.message}`);
  }
}

async function handleBadwordRemove(interaction) {
  const { entry, error } = currentRoomEntry(interaction);
  if (error) return reply(interaction, error);
  const word = interaction.options.getString('word', true);
  try {
    await rooms.removeBadword(entry.room, word);
    log('Moderation', `badword-remove room=${entry.room} by=${interaction.user.id}`);
    return reply(interaction, `Removed bad-word filter entry from room "${entry.room}".`);
  } catch (e) {
    return reply(interaction, `Error: ${e.message}`);
  }
}

async function handleBadwordList(interaction) {
  const { entry, error } = currentRoomEntry(interaction);
  if (error) return reply(interaction, error);
  const config = await rooms.getBadwordConfig(entry.room);
  const lines = [`Bad-word filter for "${entry.room}": mode=${config.mode}`];
  if (config.words.length > 0) {
    lines.push('', ...config.words.map(w => `- \`${w}\``));
  } else {
    lines.push('', '(no words configured)');
  }
  return reply(interaction, lines.join('\n'));
}

async function handleBadwordClear(interaction) {
  const { entry, error } = currentRoomEntry(interaction);
  if (error) return reply(interaction, error);
  await rooms.clearBadwords(entry.room);
  log('Moderation', `badword-clear room=${entry.room} by=${interaction.user.id}`);
  return reply(interaction, `Cleared bad-word filter list for room "${entry.room}".`);
}

function reply(interaction, content) {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

async function handleAutocomplete(interaction) {
  if (interaction.options.getSubcommand() !== 'kick') return interaction.respond([]);
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'target') return interaction.respond([]);

  const query = String(focused.value || '').toLowerCase();
  const guilds = rooms.listAllFederatedGuilds().map(g => {
    const liveName = interaction.client.guilds?.cache?.get(g.guildId)?.name;
    return { guildId: g.guildId, name: liveName || g.guildName || '(unknown)', rooms: g.rooms };
  });

  const filtered = guilds
    .filter(g => g.name.toLowerCase().includes(query) || g.guildId.includes(query))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 25)
    .map(g => ({
      name: `${g.name} — ${g.rooms.join(', ')} (${g.guildId.slice(-6)})`.slice(0, 100),
      value: g.guildId,
    }));

  return interaction.respond(filtered);
}

module.exports = { commands, handleInteraction };
