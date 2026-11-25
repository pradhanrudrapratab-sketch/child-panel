'use strict';
// Plugin-facing API (the plugin itself is NOT part of this project). Pull model: the plugin calls us over HTTPS.
const express = require('express');
const db = require('../lib/db');
const S = require('../lib/secure');
const A = require('../lib/accounts');
const O = require('../lib/orders');
const { ah } = require('./common');
const { HttpError } = S;

const r = express.Router();
const POLL_SECONDS = 300;

/** Authenticates the registered server API key on EVERY protected request. */
function pluginAuth(req, res, next) {
  const ip = S.clientIp(req);
  S.rateGuard('plugin-ip', ip, 600, 60 * 1000);
  const server = A.authenticateServer(req);
  if (!server) {
    const f = S.rateHit('plugin-fail', ip, 10, 60 * 1000);
    if (!f.ok) return next(new HttpError(429, 'rate_limited', 'Too many failed attempts.', { retryAfter: f.retryAfter }));
    return next(new HttpError(401, 'invalid_credentials', 'Invalid or revoked server credentials.'));
  }
  req.server = server;
  db.run('UPDATE server SET last_seen_at = ? WHERE id = 1', Date.now());
  next();
}

// Initial pairing: plugin exchanges the one-time pairing code (created in the admin dashboard) for its API key.
r.post('/pair', ah(async (req, res) => {
  S.rateGuard('pair', S.clientIp(req), 5, 15 * 60 * 1000);
  const b = req.body || {};
  const out = A.pairServer(b.code, b.name, b.version);
  S.audit('plugin', 'server.paired', { serverId: out.serverId }, req);
  res.json({ ok: true, serverId: out.serverId, apiKey: out.apiKey, pollIntervalSeconds: POLL_SECONDS });
}));

r.post('/heartbeat', pluginAuth, ah(async (req, res) => {
  S.rateGuard('plugin-hb', req.server.server_uid, 12, 60 * 1000);
  const v = S.cleanStr((req.body || {}).version, 30);
  if (v) db.run('UPDATE server SET plugin_version = ? WHERE id = 1', v);
  res.json({ ok: true, serverTime: Date.now() });
}));

// STAGE 1 - FETCH. Returns pending operations + a confirm token and a success token for each.
const getHandler = ah(async (req, res) => {
  S.rateGuard('plugin-get', req.server.server_uid, 12, 5 * 60 * 1000);
  db.run('UPDATE server SET last_poll_at = ? WHERE id = 1', Date.now());
  res.json({ ok: true, serverTime: Date.now(), pollIntervalSeconds: POLL_SECONDS, operations: O.fetchOperations(req.server) });
});
r.get('/get', pluginAuth, getHandler);
r.post('/get', pluginAuth, getHandler);

// STAGE 2 (RECEIVED) and STAGE 3 (SUCCESS / optional FAILED): the token itself decides which stage.
const confirmHandler = ah(async (req, res) => {
  S.rateGuard('plugin-confirm', req.server.server_uid, 240, 60 * 1000);
  const b = req.body || {};
  res.json(O.confirm(req.server, b.token, { failed: String(b.status || '').toUpperCase() === 'FAILED', reason: b.reason }));
});
r.post('/confirm', pluginAuth, confirmHandler);

// Minecraft login: plugin reports "/auth <username> <token>" executed in game.
r.post('/auth', pluginAuth, ah(async (req, res) => {
  S.rateGuard('plugin-auth', req.server.server_uid, 60, 60 * 1000);
  const b = req.body || {};
  res.json(A.completeChallenge(req.server, String(b.token || ''), String(b.username || '')));
}));

// root-level aliases (/get, /confirm) are mounted by server.js
r.aliases = { get: [pluginAuth, getHandler], confirm: [pluginAuth, confirmHandler] };
module.exports = r;
