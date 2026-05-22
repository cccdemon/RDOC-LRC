'use strict';

const rooms = require('./rooms');
const { logErr } = require('./log');

async function broadcastSystem(room, content) {
  const targets = rooms.getRoomMembers(room);
  await Promise.all(targets.map(t => {
    const wh = rooms.getWebhookClient(t.channelId);
    if (!wh) return null;
    return wh.send({
      username: 'RDOC-LC',
      content,
      allowedMentions: { parse: [] },
    }).catch(e => logErr('System', `-> ${t.guildId}/${t.channelId}: ${e.message}`));
  }));
}

function formatRules(room, rules) {
  return `**Room Rules — ${room}**\n\n${rules}`;
}

async function broadcastRules(room) {
  const rules = await rooms.getRoomRules(room);
  if (!rules) return false;
  await broadcastSystem(room, formatRules(room, rules));
  return true;
}

module.exports = { broadcastSystem, broadcastRules, formatRules };
