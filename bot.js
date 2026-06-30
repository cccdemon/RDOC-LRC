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
let commandsRegistered = false;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeModerationText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function badwordMaskPattern(word) {
  const parts = [...String(word || '')].map(ch => /\s/u.test(ch) ? '\\s+' : escapeRegExp(ch));
  return new RegExp(parts.join('[\\u200B-\\u200D\\uFEFF\\u2060]*'), 'giu');
}

function applyBadwordPolicy(content, config) {
  const text = String(content || '');
  if (!text || !config || config.mode === 'off' || !config.words || config.words.length === 0) {
    return { allowed: true, content: text };
  }

  const normalizedText = normalizeModerationText(text);
  let masked = text;
  for (const word of config.words) {
    const normalized = normalizeModerationText(word);
    if (!normalized) continue;
    if (normalizedText.includes(normalized)) {
      if (config.mode === 'block') {
        return { allowed: false, matched: normalized, content: text };
      }
      const before = masked;
      masked = masked.replace(badwordMaskPattern(normalized), '***');
      if (masked === before) {
        return { allowed: false, matched: normalized, content: text };
      }
    }
  }
  return { allowed: true, content: masked };
}

function mentionDisplayName(message, userId) {
  const member = message.mentions?.members?.get(userId);
  const user = message.mentions?.users?.get(userId);
  return member?.displayName || user?.globalName || user?.username || userId;
}

async function rewriteMentionsForTarget(content, message, target, mode) {
  const text = String(content || '');
  if (!text || !message.mentions?.users?.size) {
    return { content: text, allowedUsers: [] };
  }

  const allowedUsers = [];
  let output = text;
  const mentionIds = [...message.mentions.users.keys()];
  for (const userId of mentionIds) {
    const fallback = `@${mentionDisplayName(message, userId)}`;
    let replacement = fallback;
    if (mode === 'off') {
      replacement = mentionDisplayName(message, userId);
    } else if (mode === 'resolve-users') {
      const guild = client?.guilds?.cache?.get(target.guildId);
      if (guild) {
        const cached = guild.members?.cache?.has(userId);
        let exists = cached;
        if (!exists) {
          exists = Boolean(await guild.members.fetch(userId).catch(() => null));
        }
        if (exists) {
          replacement = `<@${userId}>`;
          allowedUsers.push(userId);
        }
      }
    }
    output = output
      .replace(new RegExp(`<@!?${escapeRegExp(userId)}>`, 'g'), replacement)
      .replace(new RegExp(`<@${escapeRegExp(userId)}>`, 'g'), replacement);
  }
  return { content: output, allowedUsers };
}

async function onWebhooksUpdate(channel) {
  const entry = rooms.getChannel(channel.id);
  if (!entry) return;

  let webhooks;
  try {
    webhooks = await channel.fetchWebhooks();
  } catch (e) {
    logErr('Webhook', `fetchWebhooks failed channel=${channel.id}: ${e.message}`);
    return;
  }

  if (webhooks.has(entry.webhookId)) return;

  log('Webhook', `Webhook gone for room=${entry.room} channel=${channel.id} (#${channel.name}) — recreating`);

  let newWebhook;
  try {
    newWebhook = await channel.createWebhook({
      name: 'RDOC-LC Relay',
      reason: 'Restoring RDOC-LC relay webhook after deletion',
    });
  } catch (e) {
    logErr('Webhook', `recreate failed room=${entry.room} channel=${channel.id}: ${e.message}`);
    return;
  }

  await rooms.updateWebhook(channel.id, newWebhook.url, newWebhook.id);
  log('Webhook', `Webhook restored room=${entry.room} channel=${channel.id}`);
}

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

  const handleReady = async (c) => {
    if (commandsRegistered) return;
    commandsRegistered = true;
    log('Discord', `Logged in as ${c.user.tag} — ${c.guilds.cache.size} guild(s)`);
    ready = true;
    audit.init(c);
    await registerCommands({ token, appId });
    setTimeout(() => {
      registerCommands({ token, appId }).catch(e => logErr('Commands', `Retry register failed: ${e.message}`));
    }, 15000);
    scheduleTokenSweep();
  };

  client.once('ready', handleReady);
  client.once('clientReady', handleReady);

  client.on('messageCreate', (m) => onMessage(m).catch(e => logErr('Relay', e.message)));
  client.on('interactionCreate', (i) => handleInteraction(i).catch(e => logErr('Interaction', e.message)));
  client.on('webhooksUpdate', (ch) => onWebhooksUpdate(ch).catch(e => logErr('Webhook', e.message)));
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

  if (await rooms.isUserBanned(entry.room, message.author.id)) {
    log('Moderation', `blocked banned user room=${entry.room} user=${message.author.id}`);
    audit.moderationBlocked({
      room: entry.room,
      guildId: message.guild.id,
      channelId: message.channelId,
      userId: message.author.id,
      reason: 'banned-user',
      matched: message.author.id,
      messageContent: message.content,
    }).catch(e => logErr('Audit', e.message));
    return;
  }

  const targets = rooms.getRoomMembers(entry.room).filter(m => m.channelId !== message.channelId);
  if (targets.length === 0) return;

  const weblinkConfig = await rooms.getWeblinkConfig('room', entry.room);

  if (weblinkConfig.mode !== 'none') {
    const urls = weblink.extractUrls(message.content);
    const check = weblink.checkWeblinkPolicy(urls, weblinkConfig.mode, weblinkConfig.list);

    if (!check.allowed) {
      const canDelete = message.guild.members.me.permissionsIn(message.channel).has('ManageMessages');

      if (!canDelete) {
        logErr('Weblink', `cannot delete blocked message in ${entry.room} (no ManageMessages): ${check.blockedUrl}`);
        try {
          const warn = await message.channel.send({
            content: `<@${message.author.id}> Your message contains a blocked link and could not be deleted because I do not have Manage Messages permission. The message will not be relayed.`,
            allowedMentions: { users: [message.author.id] },
          });
          setTimeout(() => warn.delete().catch(() => {}), 10000);
        } catch (e) {
          logErr('Weblink', `failed to send warning: ${e.message}`);
        }
      } else {
        try {
          await message.delete();
          const warn = await message.channel.send({
            content: `<@${message.author.id}> Your message was deleted because it contained a link violation: ${check.reason}`,
            allowedMentions: { users: [message.author.id] },
          });
          setTimeout(() => warn.delete().catch(() => {}), 10000);
        } catch (e) {
          logErr('Weblink', `failed to delete/warn: ${e.message}`);
        }
      }

      log('Weblink', `blocked in ${entry.room} by ${message.author.tag}: ${check.blockedUrl}`);
      audit.weblinkBlocked({
        room: entry.room,
        guildId: message.guild.id,
        channelId: message.channelId,
        userId: message.author.id,
        reason: check.reason,
        blockedUrl: check.blockedUrl,
        messageContent: message.content,
      }).catch(e => logErr('Audit', e.message));

      return;
    }
  }

  const badwordConfig = await rooms.getBadwordConfig(entry.room);
  const badwordCheck = applyBadwordPolicy(message.content, badwordConfig);
  if (!badwordCheck.allowed) {
    log('Moderation', `bad-word blocked room=${entry.room} user=${message.author.id} match="${badwordCheck.matched}"`);
    audit.moderationBlocked({
      room: entry.room,
      guildId: message.guild.id,
      channelId: message.channelId,
      userId: message.author.id,
      reason: 'bad-word',
      matched: badwordCheck.matched,
      messageContent: message.content,
    }).catch(e => logErr('Audit', e.message));
    return;
  }

  const displayName = message.member?.displayName || message.author.username;
  const avatarURL =
    (typeof message.member?.displayAvatarURL === 'function' ? message.member.displayAvatarURL() : null) ||
    (typeof message.author.displayAvatarURL === 'function' ? message.author.displayAvatarURL() : undefined);

  const files = message.attachments.size > 0
    ? [...message.attachments.values()].map(a => a.url)
    : undefined;

  const basePayload = {
    username: `From ${message.guild.name} / ${displayName}`.slice(0, 80),
    avatarURL,
    content: badwordCheck.content || undefined,
    files,
    allowedMentions: { parse: [] },
  };

  if (!basePayload.content && !basePayload.files) return;

  const t0 = Date.now();
  const mentionMode = await rooms.getMentionMode(entry.room);
  await Promise.all(targets.map(async t => {
    try {
      const payload = { ...basePayload };
      const rewritten = await rewriteMentionsForTarget(payload.content, message, t, mentionMode);
      payload.content = rewritten.content || undefined;
      payload.allowedMentions = rewritten.allowedUsers.length > 0
        ? { parse: [], users: rewritten.allowedUsers }
        : { parse: [] };
      await sendToTarget(t, payload);
    } catch (e) {
      if (e?.code === 10015) {
        logErr('Relay', `Unknown Webhook (10015) room=${entry.room} channel=${t.channelId} — webhook was deleted or channel renamed; webhooksUpdate should auto-recover`);
      } else {
        logErr('Relay', `-> ${t.guildId}/${t.channelId}: ${e.message}`);
      }
      audit.webhookError({
        sourceGuildId: message.guild.id,
        room: entry.room,
        targetChannelId: t.channelId,
        errorMessage: e.message,
      }).catch(err => logErr('Audit', err.message));
    }
  }));
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
  if (!token || !appId) {
    logErr('Commands', 'Register skipped: missing DISCORD_TOKEN or DISCORD_APP_ID');
    return;
  }

  const body = commands.map(c => c.toJSON());
  const rest = new REST({ version: '10' }).setToken(token);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await rest.put(Routes.applicationCommands(appId), { body });
      log('Commands', `Registered ${commands.length} global slash command(s)`);
      return;
    } catch (e) {
      const retryable = e?.status === 429 || e?.code === 50001 || e?.code === 50035;
      logErr('Commands', `Register attempt ${attempt}/3 failed: ${e.message}`);
      if (!retryable || attempt === 3) return;
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
}

function getClient() { return client; }

module.exports = { startBot, getBotStatus, getClient };
