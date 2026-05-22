'use strict';

const crypto = require('crypto');

const AUTHORIZE_URL = 'https://discord.com/api/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const ME_URL = 'https://discord.com/api/users/@me';
const STATE_TTL_S = 600;

const kState = (s) => `rdoc:webui:oauth:state:${s}`;

let cfg = null;
let redis = null;

function init({ clientId, clientSecret, redirectUri }, redisClient) {
  cfg = { clientId, clientSecret, redirectUri };
  redis = redisClient;
}

async function startFlow(returnTo) {
  const state = crypto.randomBytes(16).toString('base64url');
  await redis.set(kState(state), returnTo || '/', 'EX', STATE_TTL_S);
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: 'identify',
    state,
    prompt: 'none',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function consumeState(state) {
  if (!state) return null;
  const value = await redis.get(kState(state));
  if (value === null) return null;
  await redis.del(kState(state));
  return value;
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
  });
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!r.ok) throw new Error(`token exchange failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function fetchMe(accessToken) {
  const r = await fetch(ME_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`fetch /users/@me failed: ${r.status}`);
  return r.json();
}

module.exports = { init, startFlow, consumeState, exchangeCode, fetchMe };
