'use strict';

const express = require('express');
const Redis = require('ioredis');
const { startBot, getBotStatus } = require('./bot');
const { initRooms, summary } = require('./rooms');
const { log, logErr } = require('./log');

const CFG = {
  port: parseInt(process.env.PORT || '3007'),
  redis: {
    host: process.env.REDIS_HOST || 'redis',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    db: parseInt(process.env.REDIS_DB || '0'),
    lazyConnect: true,
    retryStrategy: (t) => Math.min(t * 500, 5000),
  },
  discordToken: process.env.DISCORD_TOKEN,
  discordAppId: process.env.DISCORD_APP_ID,
};

if (!CFG.discordToken) { logErr('Boot', 'DISCORD_TOKEN missing'); process.exit(1); }
if (!CFG.discordAppId) { logErr('Boot', 'DISCORD_APP_ID missing'); process.exit(1); }

const redis = new Redis(CFG.redis);
redis.on('connect', () => log('Redis', `Connected (DB ${CFG.redis.db})`));
redis.on('error',   (e) => logErr('Redis', e.message));

async function redisReady() {
  for (let i = 0; i < 30; i++) {
    try {
      if (redis.status !== 'ready' && redis.status !== 'connecting') await redis.connect();
      await redis.ping();
      return;
    } catch (e) {
      log('Redis', `Waiting... (${i + 1}/30): ${e.message}`);
      await sleep(2000);
    }
  }
  throw new Error('Redis: could not connect');
}

const app = express();
app.get('/health', async (req, res) => {
  try {
    await redis.ping();
    const bot = getBotStatus();
    res.json({
      status: 'ok',
      gateway: bot.ready ? 'connected' : 'connecting',
      guilds: bot.guilds,
      rooms: summary(),
      redis: 'ok',
    });
  } catch (e) {
    res.status(503).json({ status: 'error', error: e.message });
  }
});

async function main() {
  await redisReady();
  await initRooms(redis);
  await startBot({ token: CFG.discordToken, appId: CFG.discordAppId });
  app.listen(CFG.port, () => log('RDOC-LC', `Health on :${CFG.port}`));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(e => { logErr('FATAL', e.message, e.stack); process.exit(1); });

process.on('SIGTERM', () => { log('RDOC-LC', 'SIGTERM received, exiting'); process.exit(0); });
process.on('SIGINT',  () => { log('RDOC-LC', 'SIGINT received, exiting'); process.exit(0); });
