'use strict';

const { EmbedBuilder } = require('discord.js');
const rooms = require('./rooms');
const { logErr } = require('./log');

const COLORS = {
  info: 0x5865F2,
  success: 0x57F287,
  warning: 0xFEE75C,
  error: 0xED4245,
};

let client = null;

function init(discordClient) { client = discordClient; }

async function dispatch({ recipients, title, description, color, fields }) {
  if (!client || !recipients || recipients.length === 0) return;
  const unique = [...new Set(recipients)];
  await Promise.all(unique.map(g => postOne(g, { title, description, color, fields })));
}

async function postOne(guildId, { title, description, color, fields }) {
  let channelId;
  try {
    channelId = await rooms.getGuildAuditChannel(guildId);
  } catch (e) {
    logErr('Audit', `lookup failed for guild=${guildId}: ${e.message}`);
    return;
  }
  if (!channelId) return;

  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(color || COLORS.info)
      .setTimestamp(new Date());
    if (description) embed.setDescription(description);
    if (fields && fields.length) embed.addFields(fields);
    await channel.send({ embeds: [embed] });
  } catch (e) {
    logErr('Audit', `post failed guild=${guildId} channel=${channelId}: ${e.message}`);
  }
}

async function tokenConsumed({ room, joiningGuild, joiningChannel }) {
  const allMembers = rooms.getRoomMembers(room);
  const recipients = allMembers.map(m => m.guildId);
  await dispatch({
    recipients,
    title: 'Bridge: server joined room',
    color: COLORS.success,
    fields: [
      { name: 'Room',    value: `\`${room}\``, inline: true },
      { name: 'Server',  value: `${joiningGuild.name}\n\`${joiningGuild.id}\``, inline: true },
      { name: 'Channel', value: `<#${joiningChannel.id}>`, inline: true },
    ],
  });
}

async function channelLeft({ room, leavingGuildId, channelId }) {
  await dispatch({
    recipients: [leavingGuildId],
    title: 'Bridge: channel unlinked',
    color: COLORS.warning,
    fields: [
      { name: 'Room',    value: `\`${room}\``, inline: true },
      { name: 'Channel', value: `<#${channelId}>`, inline: true },
    ],
  });
}

async function webhookError({ sourceGuildId, room, targetChannelId, errorMessage }) {
  await dispatch({
    recipients: [sourceGuildId],
    title: 'Bridge: webhook send failed',
    color: COLORS.error,
    fields: [
      { name: 'Room',           value: `\`${room}\``, inline: true },
      { name: 'Target channel', value: `<#${targetChannelId}>`, inline: true },
      { name: 'Error',          value: (errorMessage || 'unknown').slice(0, 1000) },
    ],
  });
}

async function serverKicked({ room, targetGuildId, executedByGuildId, executedByUserId }) {
  const allMembers = rooms.getRoomMembers(room);
  const recipients = allMembers.map(m => m.guildId);
  if (!recipients.includes(targetGuildId)) recipients.push(targetGuildId);
  await dispatch({
    recipients,
    title: 'Bridge: server kicked from room',
    color: COLORS.error,
    fields: [
      { name: 'Room',          value: `\`${room}\``,           inline: true },
      { name: 'Removed guild', value: `\`${targetGuildId}\``,  inline: true },
      { name: 'Executed by',   value: executedByUserId
        ? `<@${executedByUserId}> (guild \`${executedByGuildId}\`)`
        : `guild \`${executedByGuildId}\``,
        inline: false },
    ],
  });
}

async function weblinkBlocked({ room, guildId, channelId, userId, reason, blockedUrl, messageContent }) {
  await dispatch({
    recipients: [guildId],
    title: 'Bridge: weblink blocked',
    color: COLORS.warning,
    fields: [
      { name: 'Room',      value: `\`${room}\``, inline: true },
      { name: 'Channel',   value: `<#${channelId}>`, inline: true },
      { name: 'User',      value: `<@${userId}>`, inline: true },
      { name: 'Reason',    value: reason, inline: false },
      { name: 'Blocked URL', value: blockedUrl, inline: false },
      { name: 'Message',   value: (messageContent || '').slice(0, 500), inline: false },
    ],
  });
}

module.exports = { init, tokenConsumed, channelLeft, webhookError, serverKicked, weblinkBlocked, COLORS };
