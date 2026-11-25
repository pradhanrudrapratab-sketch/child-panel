'use strict';
// Customers (Discord + Minecraft identities), the Minecraft /auth challenge, and the ONE paired server.
const db = require('./db');
const S = require('./secure');
const D = require('./discord');
const { HttpError } = S;

const CHALLENGE_TTL = 20 * 60 * 1000;
const PAIR_TTL = 15 * 60 * 1000;

/* ---------- customers ---------- */
function customerView(c) {
  return {
    id: c.id, discord: c.discord_id ? { id: c.discord_id, username: c.discord_username, name: c.discord_name, avatar: D.avatarUrl(c) } : null,
    minecraft: c.mc_username ? { username: c.mc_username, linkedAt: c.mc_linked_at } : null,
    balancePaise: c.balance_paise, accent: c.accent_color, createdAt: c.created_at,
  };
}

function upsertDiscordCustomer(profile, linkToCustomerId) {
  return db.tx(() => {
    const now = Date.now();
    const existing = db.get('SELECT * FROM customers WHERE discord_id = ?', profile.id);
    if (linkToCustomerId) {
      if (existing && existing.id !== linkToCustomerId) throw new HttpError(409, 'discord_taken', 'That Discord account is already linked to another customer.');
      db.run('UPDATE customers SET discord_id=?, discord_username=?, discord_name=?, discord_avatar=?, last_login=? WHERE id=?', profile.id, profile.username, profile.name, profile.avatar, now, linkToCustomerId);
      return db.get('SELECT * FROM customers WHERE id = ?', linkToCustomerId);
    }
    if (existing) {
      db.run('UPDATE customers SET discord_username=?, discord_name=?, discord_avatar=?, last_login=? WHERE id=?', profile.username, profile.name, profile.avatar, now, existing.id);
      return db.get('SELECT * FROM customers WHERE id = ?', existing.id);
    }
    const r = db.run('INSERT INTO customers(discord_id,discord_username,discord_name,discord_avatar,created_at,last_login) VALUES (?,?,?,?,?,?)', profile.id, profile.username, profile.name, profile.avatar, now, now);
    return db.get('SELECT * FROM customers WHERE id = ?', r.lastInsertRowid);
  });
}

function setAccent(customerId, color) {
  if (color !== null && !S.HEX.test(color || '')) throw new HttpError(400, 'invalid_color', 'Colour must look like #3b82ff.');
  db.run('UPDATE customers SET accent_color = ? WHERE id = ?', color ? color.toLowerCase() : null, customerId);
}

function unlinkMinecraft(customerId) {
  const c = db.get('SELECT * FROM customers WHERE id = ?', customerId);
  if (!c || !c.mc_username) return;
  if (!c.discord_id) throw new HttpError(409, 'last_identity', 'Link a Discord account first - otherwise you could not log in again.');
  db.run('UPDATE customers SET mc_username=NULL, mc_username_lc=NULL, mc_linked_at=NULL WHERE id=?', customerId);
}

/* ---------- Minecraft challenge ---------- */
function activeServer() {
  const s = db.get("SELECT * FROM server WHERE id = 1 AND status = 'ACTIVE'");
  if (!s) throw new HttpError(409, 'server_not_connected', 'The Minecraft server is not connected to this store yet.');
  return s;
}

function startChallenge(sessionRow, username, customerId) {
  activeServer();
  if (!S.isMcName(username)) throw new HttpError(400, 'invalid_username', 'Minecraft username must be 3-16 letters, numbers or underscores.');
  const lc = username.toLowerCase();
  const owner = db.get('SELECT id FROM customers WHERE mc_username_lc = ?', lc);
  if (customerId && owner && owner.id !== customerId) throw new HttpError(409, 'minecraft_taken', 'That Minecraft account is already linked to another customer. Use "Login with Minecraft" instead.');
  return db.tx(() => {
    const now = Date.now();
    db.run("UPDATE auth_challenges SET status='EXPIRED' WHERE session_id = ? AND status = 'PENDING'", sessionRow.id);
    let token; let tries = 0;
    for (;;) {
      token = S.randomDigits(9);
      try {
        const r = db.run('INSERT INTO auth_challenges(token,username,username_lc,session_id,customer_id,status,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)', token, username, lc, sessionRow.id, customerId || null, 'PENDING', now + CHALLENGE_TTL, now);
        return { id: r.lastInsertRowid, command: `/auth ${username} ${token}`, expiresAt: now + CHALLENGE_TTL };
      } catch (e) { if (++tries > 8 || !/UNIQUE/i.test(e.message)) throw e; }
    }
  });
}

/**
 * Called ONLY from the authenticated plugin endpoint. Idempotent: if the first request succeeded and the
 * response was lost, the retry returns the original success instead of rejecting a consumed token.
 */
function completeChallenge(server, token, username) {
  if (!/^\d{9}$/.test(String(token)) || !S.isMcName(username)) throw new HttpError(400, 'invalid_request', 'Invalid token or username.');
  const lc = username.toLowerCase();
  return db.tx(() => {
    const now = Date.now();
    // 1) already completed with this exact token+username -> replay the original success
    const done = db.get("SELECT * FROM auth_challenges WHERE token = ? AND username_lc = ? AND status = 'COMPLETED' ORDER BY completed_at DESC LIMIT 1", token, lc);
    if (done) return { ok: true, idempotent: true, username: done.username };
    const ch = db.get("SELECT * FROM auth_challenges WHERE token = ? AND status = 'PENDING'", token);
    if (!ch) throw new HttpError(404, 'invalid_challenge', 'No pending authentication for this token.');
    if (ch.expires_at < now) { db.run("UPDATE auth_challenges SET status='EXPIRED' WHERE id = ?", ch.id); throw new HttpError(410, 'challenge_expired', 'This authentication request expired.'); }
    if (ch.username_lc !== lc) throw new HttpError(403, 'username_mismatch', 'This token was issued for a different Minecraft username.');

    const owner = db.get('SELECT * FROM customers WHERE mc_username_lc = ?', lc);
    let customerId;
    if (ch.customer_id) {                         // linking from a logged-in customer
      if (owner && owner.id !== ch.customer_id) {
        db.run("UPDATE auth_challenges SET status='FAILED', fail_reason='claimed' WHERE id = ?", ch.id);
        throw new HttpError(409, 'minecraft_taken', 'This Minecraft account is already linked to another customer.');
      }
      db.run('UPDATE customers SET mc_username=?, mc_username_lc=?, mc_linked_at=? WHERE id=?', username, lc, now, ch.customer_id);
      customerId = ch.customer_id;
    } else if (owner) {                           // logging in as an existing Minecraft identity
      db.run('UPDATE customers SET mc_username=?, last_login=? WHERE id=?', username, now, owner.id);
      customerId = owner.id;
    } else {                                      // brand new customer proven by the game
      customerId = db.run('INSERT INTO customers(mc_username,mc_username_lc,mc_linked_at,created_at,last_login) VALUES (?,?,?,?,?)', username, lc, now, now, now).lastInsertRowid;
    }
    db.run("UPDATE auth_challenges SET status='COMPLETED', completed_at=?, result_customer_id=? WHERE id = ?", now, customerId, ch.id);
    return { ok: true, idempotent: false, username };
  });
}

/** Browser side: if this session's challenge has completed, attach the customer to the session (once). */
function claimChallenge(sessionRow, challengeId) {
  const ch = db.get('SELECT * FROM auth_challenges WHERE id = ? AND session_id = ?', challengeId, sessionRow.id);
  if (!ch) throw new HttpError(404, 'not_found', 'Unknown challenge.');
  if (ch.status === 'PENDING' && ch.expires_at < Date.now()) { db.run("UPDATE auth_challenges SET status='EXPIRED' WHERE id = ?", ch.id); ch.status = 'EXPIRED'; }
  return ch;
}

/* ---------- the single Minecraft server ---------- */
function createPairingCode(adminEmail, req) {
  const s = db.get('SELECT * FROM server WHERE id = 1');
  if (s && s.status === 'ACTIVE') throw new HttpError(409, 'server_already_paired', 'A Minecraft server is already connected. Disconnect it first to pair a different one.');
  const code = S.randomToken(6).toUpperCase().replace(/[-_]/g, 'A');
  db.run('DELETE FROM pairing_codes WHERE used_at IS NOT NULL OR expires_at < ?', Date.now());
  db.run('INSERT INTO pairing_codes(code_hash, expires_at, created_at) VALUES (?,?,?)', S.sha256(code), Date.now() + PAIR_TTL, Date.now());
  S.audit(adminEmail, 'server.pairing_code', {}, req);
  return { code, expiresAt: Date.now() + PAIR_TTL };
}

function pairServer(code, name, version) {
  return db.tx(() => {
    const cur = db.get('SELECT * FROM server WHERE id = 1');
    if (cur && cur.status === 'ACTIVE') throw new HttpError(409, 'server_already_paired', 'This panel already has a connected server.');
    const row = db.get('SELECT * FROM pairing_codes WHERE code_hash = ?', S.sha256(String(code || '').trim().toUpperCase()));
    if (!row || row.used_at || row.expires_at < Date.now()) throw new HttpError(403, 'invalid_pairing_code', 'Pairing code is invalid or expired.');
    db.run('UPDATE pairing_codes SET used_at = ? WHERE code_hash = ?', Date.now(), row.code_hash);
    const apiKey = 'mkc_' + S.randomToken(32);
    const uid = 'srv_' + S.randomToken(9);
    const now = Date.now();
    db.run('DELETE FROM server WHERE id = 1');
    db.run("INSERT INTO server(id,server_uid,name,api_key_hash,status,paired_at,last_seen_at,plugin_version) VALUES (1,?,?,?,'ACTIVE',?,?,?)", uid, S.cleanStr(name, 60) || 'Minecraft server', S.sha256(apiKey), now, now, S.cleanStr(version, 30) || null);
    return { serverId: uid, apiKey };
  });
}

function revokeServer(adminEmail, req) {
  const s = db.get('SELECT * FROM server WHERE id = 1');
  if (!s) throw new HttpError(404, 'no_server', 'No server is connected.');
  db.tx(() => {
    db.run("UPDATE server SET status='REVOKED', revoked_at=?, api_key_hash='revoked' WHERE id = 1", Date.now());
    db.run('UPDATE delivery_tokens SET revoked = 1 WHERE used_at IS NULL');
    db.run("UPDATE auth_challenges SET status='EXPIRED' WHERE status='PENDING'");
    // anything the old server had fetched but not confirmed goes back to the queue for the next server
    db.run("UPDATE delivery_tasks SET status='QUEUED', updated_at=? WHERE status='FETCHED'", Date.now());
  });
  S.audit(adminEmail, 'server.revoke', { serverUid: s.server_uid }, req);
}

/** Plugin API-key check, run on EVERY protected plugin request. */
function authenticateServer(req) {
  const h = String(req.headers.authorization || '');
  const key = h.startsWith('Bearer ') ? h.slice(7).trim() : String(req.headers['x-api-key'] || '').trim();
  if (!key || key.length > 200) return null;
  const s = db.get("SELECT * FROM server WHERE id = 1 AND status = 'ACTIVE'");
  if (!s || !S.safeEq(S.sha256(key), s.api_key_hash)) return null;
  const claimed = req.headers['x-server-id'];
  if (claimed && !S.safeEq(claimed, s.server_uid)) return null;
  return s;
}

function sweep() {
  const now = Date.now();
  db.run("UPDATE auth_challenges SET status='EXPIRED' WHERE status='PENDING' AND expires_at < ?", now);
  db.run('DELETE FROM auth_challenges WHERE created_at < ?', now - 7 * 864e5);
  db.run('DELETE FROM sessions WHERE expires_at < ?', now);
  db.run('DELETE FROM oauth_states WHERE expires_at < ?', now);
  db.run('DELETE FROM pairing_codes WHERE expires_at < ?', now - 864e5);
}

module.exports = { customerView, upsertDiscordCustomer, setAccent, unlinkMinecraft, startChallenge, completeChallenge, claimChallenge, createPairingCode, pairServer, revokeServer, authenticateServer, activeServer, sweep };
