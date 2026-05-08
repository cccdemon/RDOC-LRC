'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const rooms = require('./rooms');
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
      .setDescription('Link this channel to a bridge room')
      .addStringOption(o => o.setName('room')
        .setDescription('Room name (a-z, 0-9, dash; 2-31 chars)')
        .setRequired(true)))
    .addSubcommand(sub => sub
      .setName('leave')
      .setDescription('Disconnect this channel from its bridge room'))
    .addSubcommand(sub => sub
      .setName('list')
      .setDescription('Channels in this guild that are linked to bridge rooms'))
    .addSubcommand(sub => sub
      .setName('rooms')
      .setDescription('All known bridge rooms and their member counts')),
];

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'bridge') return;

  const sub = interaction.options.getSubcommand();
  switch (sub) {
    case 'join':  return handleJoin(interaction);
    case 'leave': return handleLeave(interaction);
    case 'list':  return handleList(interaction);
    case 'rooms': return handleRooms(interaction);
    default:      return reply(interaction, `Unknown subcommand: ${sub}`);
  }
}

async function handleJoin(interaction) {
  const room = interaction.options.getString('room', true).toLowerCase();
  if (!ROOM_NAME_RE.test(room)) {
    return reply(interaction, 'Invalid room name. Use a-z, 0-9, dashes; 2-31 chars; must start with a letter or digit.');
  }

  const channel = interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildText) {
    return reply(interaction, 'This command only works in regular text channels.');
  }

  const existing = rooms.getChannel(channel.id);
  if (existing) {
    return reply(interaction, `This channel is already linked to room "${existing.room}". Run /bridge leave first.`);
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
  log('Join', `[${room}] ${interaction.guild.name}#${channel.name} (${channel.id}) — ${total} member(s) total`);
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
  const all = rooms.summary();
  const names = Object.keys(all).sort();
  if (names.length === 0) return reply(interaction, 'No bridge rooms exist yet. Run `/bridge join <room>` to create one.');

  const lines = names.map(n => `- "${n}" — ${all[n]} channel(s)`);
  return reply(interaction, lines.join('\n'));
}

function reply(interaction, content) {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

module.exports = { commands, handleInteraction };
