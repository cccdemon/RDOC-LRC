'use strict';

const rooms = require('./rooms');
const { logErr } = require('@rdoc-lc/core/log');

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

module.exports = { broadcastSystem };
