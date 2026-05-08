'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const rooms = require('./rooms');
const tokens = require('./tokens');
const audit = require('./audit');
const { log, logErr } = require('./log');

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
      .addStringOption(o => o.setName('token')
        .setDescription('Kick token (rdoc-XXXX-XXXX-XXXX-XXXX) issued via the operator CLI')
        .setRequired(true))),
];

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'bridge') return;

  const sub = interaction.options.getSubcommand();
  switch (sub) {
    case 'join':           return handleJoin(interaction);
    case 'leave':          return handleLeave(interaction);
    case 'list':           return handleList(interaction);
    case 'rooms':          return handleRooms(interaction);
    case 'audit-channel':  return handleAuditChannel(interaction);
    case 'kick':           return handleKick(interaction);
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
  if (!channel || channel.type !== ChannelType.GuildText) {
    return reply(interaction, 'This command only works in regular text channels.');
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

  await rooms.join(room, channel.guildId, channel.id, webhook.url, webhook.id);

  const total = rooms.getRoomMembers(room).length;
  log('Join', `[${room}] ${interaction.guild.name}#${channel.name} (${channel.id}) — ${total} member(s) total — token=${token.slice(0, 13)}...`);

  audit.tokenConsumed({
    room,
    joiningGuild: interaction.guild,
    joiningChannel: channel,
  }).catch(e => logErr('Audit', e.message));

  return reply(interaction, `Linked #${channel.name} to room "${room}". This room now has ${total} channel(s) across all servers.`);
}

async function handleLeave(interaction) {
  const channel = interaction.channel;
  const entry = rooms.getChannel(channel.id);
  if (!entry) return reply(interaction, 'This channel is not linked to any bridge room.');

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

  const lines = entries.map(e => {
    const ch = interaction.guild.channels.cache.get(e.channelId);
    return `- ${ch ? `#${ch.name}` : `<#${e.channelId}>`} -> "${e.room}"`;
  });
  return reply(interaction, lines.join('\n'));
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
  const token = interaction.options.getString('token', true).trim();

  if (!tokens.isValidFormat(token)) {
    return reply(interaction, 'Invalid token format. Expected `rdoc-XXXX-XXXX-XXXX-XXXX`.');
  }

  let data;
  try {
    data = await tokens.consumeKick({ token });
  } catch (e) {
    const msg = ({
      NOT_FOUND:   'Invalid or already-used token.',
      EXPIRED:     'This token has expired.',
      WRONG_KIND:  'This is a join token, not a kick token. Ask the operator for a kick token.',
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

function reply(interaction, content) {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

module.exports = { commands, handleInteraction };
