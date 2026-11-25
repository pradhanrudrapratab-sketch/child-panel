'use strict';
const express = require('express');
const db = require('../lib/db');
const S = require('../lib/secure');
const MP = require('../lib/mainpanel');
const C = require('./common');
const { HttpError } = S;

const r = express.Router();
const DEFAULT_MAIN = 'https://mkweb-panel.onrender.com';
let busy = false;

r.get('/status', (req, res) => {
  res.json({ configured: C.configured(), defaultMainUrl: DEFAULT_MAIN, contractConfirmed: !!MP.getContract().confirmed });
});

r.post('/redeem', C.ah(async (req, res) => {
  if (C.configured()) throw new HttpError(409, 'already_configured', 'This panel is already set up.');
  S.rateGuard('setup', S.clientIp(req), 10, 15 * 60 * 1000);
  if (busy) throw new HttpError(409, 'busy', 'Setup is already running.');
  busy = true;
  try {
    const b = req.body || {};
    const code = S.cleanStr(b.code, 128, { allowEmpty: false, name: 'Setup code' });
    S.checkPasswordStrength(b.password);
    if (b.password !== b.passwordConfirm) throw new HttpError(400, 'password_mismatch', 'Passwords do not match.');
    let publicUrl = S.cleanStr(b.publicUrl, 300, { allowEmpty: false, name: 'Public URL' });
    try {
      const u = new URL(publicUrl);
      const local = ['localhost', '127.0.0.1'].includes(u.hostname);
      if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('scheme');
      publicUrl = u.origin;
    } catch (_) { throw new HttpError(400, 'invalid_url', 'Public URL must be this site\'s https:// address.'); }
    const origin = MP.validateMainUrl(b.mainUrl || DEFAULT_MAIN);

    const passHash = await S.hashPassword(b.password);
    const reg = await MP.redeemSetupCode(origin, code, publicUrl);   // single-use code is burned here
    db.tx(() => {
      S.setSetting('main_url', reg.origin); S.setSetting('main_panel_id', reg.panelId); S.setSetting('main_secret', reg.secret);
      S.setSetting('public_url', publicUrl); S.setSetting('store_name', 'My Minecraft Store'); S.setSetting('default_colour', 'blue');
      S.setSetting('mp_state', 'OK'); S.setSetting('mp_last_ok_at', Date.now());
      db.run('DELETE FROM admin');
      db.run('INSERT INTO admin(id,email,password_hash,created_at,updated_at) VALUES (1,?,?,?,?)', reg.ownerEmail, passHash, Date.now(), Date.now());
      S.setSetting('setup_complete', '1');
    });
    S.audit(reg.ownerEmail, 'setup.complete', { panelId: reg.panelId }, req);
    const old = S.loadSession(req, 'admin'); if (old) db.run('DELETE FROM sessions WHERE id = ?', old.id);
    S.createSession(req, res, 'admin', 1);
    MP.pushServerInfo().catch(() => {});
    res.json({ ok: true, adminEmail: reg.ownerEmail });
  } finally { busy = false; }
}));

module.exports = r;
