'use strict';
// Crypto, settings storage (secrets encrypted at rest), sessions, cookies, rate limits, audit log.
const crypto = require('crypto');
const fs = require('fs');
const { KEY_FILE } = require('./paths');
const db = require('./db');

class HttpError extends Error {
  constructor(status, code, message, extra) { super(message || code); this.status = status; this.code = code; this.extra = extra; }
}

/* ---------- master key (auto-generated on first boot, 0600, never in git) ---------- */
function loadKey() {
  if (fs.existsSync(KEY_FILE)) {
    const b = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
    if (b.length === 32) return b;
    throw new Error('data/secret.key is corrupt. Restore it from backup (without it stored secrets cannot be decrypted).');
  }
  const k = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, k.toString('hex'), { mode: 0o600 });
  return k;
}
const KEY = loadKey();

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1:' + [iv, c.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
}
function decrypt(blob) {
  if (!blob || !blob.startsWith('v1:')) return null;
  const [iv, tag, ct] = blob.slice(3).split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/* ---------- settings ---------- */
const SECRET_KEYS = new Set(['main_secret', 'discord_client_secret', 'discord_bot_token']);
function getSetting(key, def = null) {
  const r = db.get('SELECT value, is_secret FROM settings WHERE key = ?', key);
  if (!r || r.value === null) return def;
  return r.is_secret ? decrypt(r.value) : r.value;
}
function setSetting(key, value) {
  const secret = SECRET_KEYS.has(key) ? 1 : 0;
  if (value === null || value === undefined) { db.run('DELETE FROM settings WHERE key = ?', key); return; }
  const stored = secret ? encrypt(value) : String(value);
  db.run(
    'INSERT INTO settings(key,value,is_secret,updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, is_secret=excluded.is_secret, updated_at=excluded.updated_at',
    key, stored, secret, Date.now(),
  );
}
const getInt = (k, d) => { const v = parseInt(getSetting(k), 10); return Number.isFinite(v) ? v : d; };

/* ---------- tokens / hashing ---------- */
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const randomDigits = (n) => Array.from({ length: n }, () => crypto.randomInt(0, 10)).join('');
function safeEq(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* ---------- passwords (scrypt) ---------- */
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return 'scrypt$' + salt.toString('base64') + '$' + (await scrypt(pw, salt)).toString('base64');
}
async function verifyPassword(pw, stored) {
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const k = await scrypt(pw, Buffer.from(salt, 'base64'));
  const h = Buffer.from(hash, 'base64');
  return k.length === h.length && crypto.timingSafeEqual(k, h);
}
function checkPasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw new HttpError(400, 'weak_password', 'Password must be at least 10 characters.');
  if (pw.length > 200) throw new HttpError(400, 'weak_password', 'Password is too long.');
}

/* ---------- request helpers ---------- */
function clientIp(req) {
  const hops = getInt('trust_proxy_hops', 1);
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (hops > 0 && xff.length) return xff[Math.max(0, xff.length - hops)];
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
function isHttps(req) {
  const p = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return p === 'https' || !!(req.socket && req.socket.encrypted);
}
function baseUrl(req) {
  const configured = getSetting('public_url');
  if (configured) return configured.replace(/\/+$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return (isHttps(req) ? 'https://' : 'http://') + host;
}

/* ---------- cookies ---------- */
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) { try { out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch (_) { /* skip */ } }
  });
  return out;
}
function setCookie(req, res, name, value, maxAgeSec) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeSec !== undefined) parts.push(`Max-Age=${maxAgeSec}`);
  if (isHttps(req)) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  res.setHeader('Set-Cookie', list.concat(parts.join('; ')));
}

/* ---------- sessions ---------- */
const COOKIE = { customer: 'mk_sid', admin: 'mk_admin' };
const LIFE = {
  customer: { abs: 30 * 864e5, idle: 7 * 864e5 },
  admin: { abs: 12 * 36e5, idle: 2 * 36e5 },
};
function createSession(req, res, kind, userId = null) {
  const token = randomToken(32);
  const id = sha256(token);
  const now = Date.now();
  db.run('INSERT INTO sessions(id,kind,user_id,csrf,created_at,expires_at,last_seen,ip,ua) VALUES (?,?,?,?,?,?,?,?,?)',
    id, kind, userId, randomToken(24), now, now + LIFE[kind].abs, now, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 200));
  setCookie(req, res, COOKIE[kind], token, Math.floor(LIFE[kind].abs / 1000));
  return db.get('SELECT * FROM sessions WHERE id = ?', id);
}
function loadSession(req, kind) {
  const token = parseCookies(req)[COOKIE[kind]];
  if (!token || token.length > 100) return null;
  const s = db.get('SELECT * FROM sessions WHERE id = ? AND kind = ?', sha256(token), kind);
  if (!s) return null;
  const now = Date.now();
  if (s.expires_at < now || now - s.last_seen > LIFE[kind].idle) { db.run('DELETE FROM sessions WHERE id = ?', s.id); return null; }
  if (now - s.last_seen > 60000) db.run('UPDATE sessions SET last_seen = ? WHERE id = ?', now, s.id);
  return s;
}
function destroySession(req, res, kind) {
  const s = loadSession(req, kind);
  if (s) db.run('DELETE FROM sessions WHERE id = ?', s.id);
  setCookie(req, res, COOKIE[kind], '', 0);
}
/** Replace a session (new id + csrf) when identity changes - prevents session fixation. */
function rotateSession(req, res, kind, userId) {
  const old = loadSession(req, kind);
  if (old) db.run('DELETE FROM sessions WHERE id = ?', old.id);
  const fresh = createSession(req, res, kind, userId);
  if (old) db.run('UPDATE auth_challenges SET session_id = ? WHERE session_id = ?', fresh.id, old.id);
  return fresh;
}
function purgeUserSessions(kind, userId, exceptId = null) {
  db.run('DELETE FROM sessions WHERE kind = ? AND user_id = ? AND id != ?', kind, userId, exceptId || '');
}

/* ---------- rate limiting (in-memory sliding window, per process) ---------- */
const buckets = new Map();
function rateHit(name, key, max, windowMs) {
  const k = name + '|' + key; const now = Date.now();
  const arr = (buckets.get(k) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { buckets.set(k, arr); return { ok: false, retryAfter: Math.max(1, Math.ceil((windowMs - (now - arr[0])) / 1000)) }; }
  arr.push(now); buckets.set(k, arr);
  return { ok: true };
}
function rateGuard(name, key, max, windowMs) {
  const r = rateHit(name, key, max, windowMs);
  if (!r.ok) throw new HttpError(429, 'rate_limited', 'Too many requests. Please slow down.', { retryAfter: r.retryAfter });
}
const rateReset = (name, key) => buckets.delete(name + '|' + key);
setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (!v.length || now - v[v.length - 1] > 3600e3) buckets.delete(k); }, 600e3).unref();

/* ---------- audit ---------- */
function audit(actor, action, detail, req) {
  try {
    db.run('INSERT INTO audit_log(actor,action,detail,ip,created_at) VALUES (?,?,?,?,?)', actor, action,
      detail === undefined ? null : JSON.stringify(detail).slice(0, 2000), req ? clientIp(req) : null, Date.now());
  } catch (_) { /* never break a request because of audit */ }
}

/* ---------- validation helpers ---------- */
const MC_RE = /^[A-Za-z0-9_]{3,16}$/;
const isMcName = (s) => typeof s === 'string' && MC_RE.test(s);
function cleanStr(v, max, { allowEmpty = true, name = 'value' } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw new HttpError(400, 'invalid_input', `${name} must be text.`);
  v = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  if (!allowEmpty && !v) throw new HttpError(400, 'invalid_input', `${name} is required.`);
  if (v.length > max) throw new HttpError(400, 'invalid_input', `${name} is too long (max ${max}).`);
  return v;
}
/** Only absolute https:// URLs (or empty). Blocks javascript:, data:, file: and credentials in URLs. */
function cleanUrl(v, name = 'URL', { allowEmpty = true } = {}) {
  v = cleanStr(v, 500, { name });
  if (!v) { if (allowEmpty) return ''; throw new HttpError(400, 'invalid_input', `${name} is required.`); }
  let u;
  try { u = new URL(v); } catch (_) { throw new HttpError(400, 'invalid_url', `${name} is not a valid URL.`); }
  if (u.protocol !== 'https:' || u.username || u.password) throw new HttpError(400, 'invalid_url', `${name} must be an https:// link.`);
  return u.toString();
}
const HEX = /^#[0-9a-fA-F]{6}$/;

module.exports = {
  HttpError, encrypt, decrypt, getSetting, setSetting, getInt, SECRET_KEYS, sha256, randomToken, randomDigits, safeEq,
  hashPassword, verifyPassword, checkPasswordStrength, clientIp, isHttps, baseUrl, parseCookies, setCookie,
  createSession, loadSession, destroySession, rotateSession, purgeUserSessions, rateHit, rateGuard, rateReset, audit,
  isMcName, cleanStr, cleanUrl, HEX, COOKIE,
};
