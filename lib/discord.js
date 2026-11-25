'use strict';
// Discord OAuth2 (identify scope) + optional deposit log via bot token.
const S = require('./secure');
const { formatPaise } = require('./money');
const MP = require('./mainpanel');

const api = () => MP.getContract().discord.api;
const authorizeUrl = () => MP.getContract().discord.authorize;

function configured() { return !!(S.getSetting('discord_client_id') && S.getSetting('discord_client_secret')); }
const redirectUri = (req) => S.baseUrl(req) + '/auth/discord/callback';

function buildAuthorizeUrl(req, state) {
  const u = new URL(authorizeUrl());
  u.searchParams.set('client_id', S.getSetting('discord_client_id'));
  u.searchParams.set('redirect_uri', redirectUri(req));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'identify');
  u.searchParams.set('state', state);
  u.searchParams.set('prompt', 'none');
  return u.toString();
}

async function exchangeCode(req, code) {
  const body = new URLSearchParams({
    client_id: S.getSetting('discord_client_id'), client_secret: S.getSetting('discord_client_secret'),
    grant_type: 'authorization_code', code, redirect_uri: redirectUri(req),
  });
  const r = await fetch(api() + '/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new S.HttpError(502, 'discord_token_failed', 'Discord rejected the login. Please try again.');
  const j = await r.json();
  if (!j.access_token) throw new S.HttpError(502, 'discord_token_failed', 'Discord did not return an access token.');
  return j.access_token;
}

async function fetchProfile(accessToken) {
  const r = await fetch(api() + '/users/@me', { headers: { Authorization: 'Bearer ' + accessToken }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new S.HttpError(502, 'discord_profile_failed', 'Could not read your Discord profile.');
  const u = await r.json();
  if (!u.id || !/^\d{5,25}$/.test(String(u.id))) throw new S.HttpError(502, 'discord_profile_failed', 'Discord returned an invalid profile.');
  return { id: String(u.id), username: String(u.username || '').slice(0, 64), name: String(u.global_name || u.username || '').slice(0, 64), avatar: /^[a-zA-Z0-9_]+$/.test(u.avatar || '') ? u.avatar : null };
}

const avatarUrl = (c) => (c.discord_id && c.discord_avatar ? `https://cdn.discordapp.com/avatars/${c.discord_id}/${c.discord_avatar}.png?size=64` : null);

/** Fire-and-forget deposit log. A Discord failure NEVER affects the wallet credit. */
async function logDeposit(deposit, customer) {
  try {
    const token = S.getSetting('discord_bot_token'); const ch = S.getSetting('discord_log_channel');
    if (!token || !ch || !/^\d{5,25}$/.test(ch)) return;
    const content = {
      embeds: [{
        title: 'Deposit received', color: 0x22c55e,
        fields: [
          { name: 'Customer', value: String(customer.discord_username || customer.mc_username || 'Customer #' + customer.id).slice(0, 100), inline: true },
          { name: 'Minecraft', value: String(customer.mc_username || '-'), inline: true },
          { name: 'Credited', value: '₹' + formatPaise(deposit.amount_paise), inline: true },
          { name: 'Deposit', value: deposit.public_id, inline: true },
        ],
        timestamp: new Date().toISOString(),
      }],
      allowed_mentions: { parse: [] },
    };
    await fetch(`${api()}/channels/${ch}/messages`, {
      method: 'POST', headers: { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(content), signal: AbortSignal.timeout(8000),
    });
  } catch (e) { console.warn('[discord] deposit log failed:', e.message); }
}

module.exports = { configured, buildAuthorizeUrl, exchangeCode, fetchProfile, avatarUrl, logDeposit, redirectUri };
