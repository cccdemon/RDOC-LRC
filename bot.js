'use strict';

const { Client, GatewayIntentBits, Partials, REST, Routes } = require('discord.js');
const { commands, handleInteraction } = require('./commands');
const rooms = require('./rooms');
const tokens = require('./tokens');
const audit = require('./audit');
const weblink = require('./weblink');
const { log, logErr } = require('./log');

const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

let client = null;
let ready = false;
let sweepTimer = null;

async function startBot({ token, appId }) {
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildWebhooks,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  client.once('clientReady', async (c) => {
    log('Discord', `Logged in as ${c.user.tag} — ${c.guilds.cache.size} guild(s)`);
    ready = true;
    audit.init(c);
    await registerCommands({ token, appId });
    scheduleTokenSweep();
  });

  client.on('messageCreate', (m) => onMessage(m).catch(e => logErr('Relay', e.message)));
  client.on('interactionCreate', (i) => handleInteraction(i).catch(e => logErr('Interaction', e.message)));
  client.on('error', (e) => logErr('Discord', e.message));
  client.on('shardError', (e) => logErr('Shard', e.message));

  await client.login(token);
}

async function onMessage(message) {
  if (!message.guild) return;
  if (message.author?.bot) return;
  if (message.webhookId) return;
  if (message.system) return;

  const entry = rooms.getChannel(message.channelId);
  if (!entry) return;

  const targets = rooms.getRoomMembers(entry.room).filter(m => m.channelId !== message.channelId);
  if (targets.length === 0) return;

  // Check weblink filtering for the room federation
  const weblinkConfig = await rooms.getWeblinkConfig('room', entry.room);
  console.log(`[WEBLINK DEBUG] Room: ${entry.room}, Mode: ${weblinkConfig.mode}, List: ${JSON.stringify(weblinkConfig.list)}`);

  if (weblinkConfig.mode !== 'none') {
    const urls = weblink.extractUrls(message.content);
    console.log(`[WEBLINK DEBUG] Message content: "${message.content}", URLs: ${JSON.stringify(urls)}`);
    const check = weblink.checkWeblinkPolicy(urls, weblinkConfig.mode, weblinkConfig.list);
    console.log(`[WEBLINK DEBUG] Check result: ${JSON.stringify(check)}`);

    if (!check.allowed) {
      console.log(`[WEBLINK DEBUG] Blocking message - attempting to delete`);
      
      // Check if bot has permission to delete messages
      const botPermissions = message.guild.members.me.permissionsIn(message.channel);
      const canDelete = botPermissions.has('ManageMessages');
      console.log(`[WEBLINK DEBUG] Bot has ManageMessages permission: ${canDelete}`);
      
      if (!canDelete) {
        console.log(`[WEBLINK DEBUG] Bot lacks ManageMessages permission, cannot delete message`);
        logErr('Weblink', 'Bot lacks ManageMessages permission to delete blocked messages');
        try {
          await message.channel.send({
            content: `<@${message.author.id}> Your message contains a blocked link and could not be deleted because I do not have Manage Messages permission. The message will not be relayed.`,
            allowedMentions: { users: [message.author.id] }
          }).then(reply => {
            setTimeout(() => reply.delete().catch(() => {}), 10000);
          });
          console.log(`[WEBLINK DEBUG] Warning sent without deleting original message`);
        } catch (e) {
          console.log(`[WEBLINK DEBUG] Failed to send warning when delete permission missing: ${e.message}`);
          logErr('Weblink', `Failed to send warning for blocked message: ${e.message}`);
        }
      } else {
        // Delete the message and send warning
        try {
          await message.delete();
          console.log(`[WEBLINK DEBUG] Message deleted successfully`);
          await message.channel.send({
            content: `<@${message.author.id}> Your message was deleted because it contained a link violation: ${check.reason}`,
            allowedMentions: { users: [message.author.id] }
          }).then(reply => {
            setTimeout(() => reply.delete().catch(() => {}), 10000); // Auto-delete warning after 10s
          });
          console.log(`[WEBLINK DEBUG] Warning sent`);
        } catch (e) {
          console.log(`[WEBLINK DEBUG] Failed to delete/block message: ${e.message}`);
          logErr('Weblink', `Failed to delete/block message: ${e.message}`);
        }
      }

      // Audit the blocked message
      audit.weblinkBlocked({
        room: entry.room,
        guildId: message.guild.id,
        channelId: message.channelId,
        userId: message.author.id,
        reason: check.reason,
        blockedUrl: check.blockedUrl,
        messageContent: message.content
      }).catch(e => logErr('Audit', e.message));

      return; // Don't relay the message
    }
  }

  const displayName = message.member?.displayName || message.author.username;
  const avatarURL =
    (typeof message.member?.displayAvatarURL === 'function' ? message.member.displayAvatarURL() : null) ||
    (typeof message.author.displayAvatarURL === 'function' ? message.author.displayAvatarURL() : undefined);

  const files = message.attachments.size > 0
    ? [...message.attachments.values()].map(a => a.url)
    : undefined;

  const payload = {
    username: `From ${message.guild.name} / ${displayName}`.slice(0, 80),
    avatarURL,
    content: message.content || undefined,
    files,
    allowedMentions: { parse: [] },
  };

  if (!payload.content && !payload.files) return;

  const t0 = Date.now();
  await Promise.all(targets.map(t => sendToTarget(t, payload).catch(e => {
    logErr('Relay', `-> ${t.guildId}/${t.channelId}: ${e.message}`);
    audit.webhookError({
      sourceGuildId: message.guild.id,
      room: entry.room,
      targetChannelId: t.channelId,
      errorMessage: e.message,
    }).catch(err => logErr('Audit', err.message));
  })));
  log('Relay', `[${entry.room}] ${displayName}@${message.guild.name} -> ${targets.length} target(s) (${Date.now() - t0}ms)`);
}

function scheduleTokenSweep() {
  if (sweepTimer) clearInterval(sweepTimer);
  const run = () => tokens.sweepExpired().catch(e => logErr('Tokens', `sweep failed: ${e.message}`));
  run();
  sweepTimer = setInterval(run, SWEEP_INTERVAL_MS);
}

async function sendToTarget(target, payload) {
  const wh = rooms.getWebhookClient(target.channelId);
  if (!wh) throw new Error('webhook client missing');
  await wh.send(payload);
}

function getBotStatus() {
  return {
    ready,
    guilds: client?.guilds?.cache?.size ?? 0,
  };
}

async function registerCommands({ token, appId }) {
  try {
    const rest = new REST({ version: '10' }).setToken(token);
    await rest.put(Routes.applicationCommands(appId), { body: commands.map(c => c.toJSON()) });
    log('Commands', `Registered ${commands.length} global slash command(s)`);
  } catch (e) {
    logErr('Commands', `Register failed: ${e.message}`);
  }
}

function getClient() { return client; }

module.exports = { startBot, getBotStatus, getClient };
