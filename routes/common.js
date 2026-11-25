'use strict';
const db = require('../lib/db');
const S = require('../lib/secure');
const { HttpError } = S;

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const configured = () => S.getSetting('setup_complete') === '1';

/** Same-origin guard for state-changing browser requests. */
function originCheck(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const o = req.headers.origin;
  if (o) {
    let host; try { host = new URL(o).host; } catch (_) { return next(new HttpError(403, 'bad_origin', 'Bad origin.')); }
    const mine = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (host !== mine) return next(new HttpError(403, 'bad_origin', 'Cross-site request blocked.'));
  }
  next();
}

/** Loads (never creates) sessions. */
function loadSessions(req, res, next) {
  req.cs = S.loadSession(req, 'customer');
  req.as = S.loadSession(req, 'admin');
  req.customer = req.cs && req.cs.user_id ? db.get('SELECT * FROM customers WHERE id = ?', req.cs.user_id) || null : null;
  next();
}
function ensureGuest(req, res) {
  if (!req.cs) { req.cs = S.createSession(req, res, 'customer', null); req.customer = null; }
  return req.cs;
}

function csrfOk(req, session) {
  const t = req.headers['x-csrf-token'];
  return !!(session && t && S.safeEq(t, session.csrf));
}
/** Customer-session CSRF for state-changing requests (guest or logged in). */
function csrfCustomer(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!csrfOk(req, req.cs)) return next(new HttpError(403, 'csrf', 'Session expired. Reload the page and try again.'));
  next();
}
function requireCustomer(req, res, next) {
  if (!req.customer) return next(new HttpError(401, 'unauthorized', 'Please log in.'));
  next();
}
function requireAdmin(req, res, next) {
  const a = req.as && db.get('SELECT * FROM admin WHERE id = 1');
  if (!a || req.as.user_id !== 1) return next(new HttpError(401, 'unauthorized', 'Admin login required.'));
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !csrfOk(req, req.as)) return next(new HttpError(403, 'csrf', 'Session expired. Reload the page and try again.'));
  req.admin = a;
  next();
}

module.exports = { ah, configured, originCheck, loadSessions, ensureGuest, csrfCustomer, csrfOk, requireCustomer, requireAdmin };
