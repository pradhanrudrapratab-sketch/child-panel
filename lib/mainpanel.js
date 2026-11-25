'use strict';
/*
 * Main Panel client (HMAC-SHA256 signed requests).
 *
 * !! CONTRACT STATUS: UNCONFIRMED !!
 * The Main Panel integration document was not supplied with the source code, so every value in
 * DEFAULT_CONTRACT below (paths, header names, canonical string, field names) is a PLACEHOLDER
 * that must be confirmed against the real Main Panel. Nothing here is hard-wired elsewhere:
 * you can fix the contract WITHOUT touching code by creating data/contract.json, e.g.
 *
 *   { "confirmed": true,
 *     "headers": { "panelId": "X-Panel-Id", "timestamp": "X-Timestamp", "nonce": "X-Nonce", "signature": "X-Signature" },
 *     "canonical": "{method}\n{path}\n{timestamp}\n{nonce}\n{bodySha256}",
 *     "paths": { "redeem": "/api/panel/redeem" } }
 *
 * Canonical-string variables: {panelId} {method} {path} (path + query as sent) {pathname} {query}
 * {timestamp} {nonce} {body} {bodySha256}.  Set "confirmed": true once verified; until then the
 * admin dashboard shows a warning banner.
 */
const crypto = require('crypto');
const fs = require('fs');
const { CONTRACT_FILE } = require('./paths');
const S = require('./secure');
const { parsePaise, formatPaise } = require('./money');

const DEFAULT_CONTRACT = {
  confirmed: false,
  timestampUnit: 'seconds', // 'seconds' | 'milliseconds'
  signatureEncoding: 'hex', // 'hex' | 'base64'
  headers: { panelId: 'X-Panel-Id', timestamp: 'X-Panel-Timestamp', nonce: 'X-Panel-Nonce', signature: 'X-Panel-Signature' },
  canonical: '{method}\n{path}\n{timestamp}\n{nonce}\n{bodySha256}',
  paths: {
    redeem: '/api/panel/redeem',
    paymentConfig: '/api/panel/payment-config',
    paymentStatus: '/api/panel/payment-status',
    serverInfo: '/api/panel/server-info',
    createPayment: '/api/panel/payments',
    startPayment: '/api/panel/payments/:id/start',
    checkPayment: '/cheque',
    rotateSecret: '/api/panel/rotate-secret',
    heartbeat: '/api/panel/heartbeat',
  },
  discord: { api: 'https://discord.com/api/v10', authorize: 'https://discord.com/oauth2/authorize' },
};

function loadContract() {
  let over = {};
  try { if (fs.existsSync(CONTRACT_FILE)) over = JSON.parse(fs.readFileSync(CONTRACT_FILE, 'utf8')); } catch (e) { console.error('contract.json is invalid JSON, ignoring:', e.message); }
  return {
    ...DEFAULT_CONTRACT, ...over,
    headers: { ...DEFAULT_CONTRACT.headers, ...(over.headers || {}) },
    paths: { ...DEFAULT_CONTRACT.paths, ...(over.paths || {}) },
    discord: { ...DEFAULT_CONTRACT.discord, ...(over.discord || {}) },
  };
}
let contract = loadContract();
const getContract = () => contract;
const reloadContract = () => { contract = loadContract(); return contract; };

class MainPanelError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; Object.assign(this, extra); }
}

/** Refuse SSRF-prone Main Panel URLs: https only (http only for localhost), no creds, no IP literals / internal names. */
function validateMainUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch (_) { throw new S.HttpError(400, 'invalid_url', 'Main Panel URL is not valid.'); }
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new S.HttpError(400, 'invalid_url', 'Main Panel URL must use https://');
  if (u.username || u.password) throw new S.HttpError(400, 'invalid_url', 'Main Panel URL must not contain credentials.');
  if (!local) {
    const h = u.hostname.toLowerCase();
    if (/^[\d.]+$/.test(h) || h.includes(':') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.')) {
      throw new S.HttpError(400, 'invalid_url', 'Main Panel URL must be a public domain name.');
    }
  }
  return u.origin;
}

/* ---------- signing ---------- */
function signHeaders(method, pathWithQuery, bodyStr, { panelId, secret, now = Date.now(), nonce } = {}) {
  panelId = panelId || S.getSetting('main_panel_id');
  secret = secret || S.getSetting('main_secret');
  if (!panelId || !secret) throw new MainPanelError(0, 'not_registered', 'This panel is not registered with the Main Panel yet.');
  const c = contract;
  const timestamp = String(c.timestampUnit === 'milliseconds' ? now : Math.floor(now / 1000));
  nonce = nonce || crypto.randomBytes(16).toString('hex');
  const [pathname, query = ''] = pathWithQuery.split('?');
  const vars = {
    panelId, method: method.toUpperCase(), path: pathWithQuery, pathname, query, timestamp, nonce,
    body: bodyStr || '', bodySha256: crypto.createHash('sha256').update(bodyStr || '').digest('hex'),
  };
  const canonical = c.canonical.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  const sig = crypto.createHmac('sha256', secret).update(canonical).digest(c.signatureEncoding === 'base64' ? 'base64' : 'hex');
  return {
    [c.headers.panelId]: panelId, [c.headers.timestamp]: timestamp, [c.headers.nonce]: nonce, [c.headers.signature]: sig,
  };
}

/* ---------- state ---------- */
const setState = (state, err) => {
  S.setSetting('mp_state', state);
  if (err) S.setSetting('mp_last_error', String(err).slice(0, 300)); else S.setSetting('mp_last_error', null);
  if (state === 'OK') S.setSetting('mp_last_ok_at', Date.now());
};
const getState = () => ({
  state: S.getSetting('mp_state', 'UNKNOWN'), lastError: S.getSetting('mp_last_error'),
  lastOkAt: parseInt(S.getSetting('mp_last_ok_at'), 10) || null, lastHeartbeatAt: parseInt(S.getSetting('mp_last_heartbeat_at'), 10) || null,
});
const panelBlocked = () => ['SUSPENDED', 'REVOKED'].includes(S.getSetting('mp_state', 'UNKNOWN'));

/* ---------- transport ---------- */
async function rawFetch(method, url, headers, bodyStr) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await fetch(url, { method, headers, body: bodyStr || undefined, signal: ac.signal, redirect: 'error' });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-json */ }
    return { status: res.status, json, text, retryAfter: parseInt(res.headers.get('retry-after'), 10) || null };
  } catch (e) {
    throw new MainPanelError(0, 'network', e.name === 'AbortError' ? 'Main Panel timed out.' : 'Could not reach the Main Panel.', { network: true });
  } finally { clearTimeout(t); }
}

function mapFailure(r, label) {
  const msg = (r.json && (r.json.error || r.json.message)) || r.text.slice(0, 160) || `HTTP ${r.status}`;
  switch (r.status) {
    case 401: setState('AUTH_ERROR', msg); return new MainPanelError(401, 'auth_failed', 'Main Panel rejected this panel\'s signature or credentials (invalid signature, stale timestamp or replayed nonce).', { detail: msg });
    case 403: {
      const revoked = /revok|ban/i.test(msg);
      setState(revoked ? 'REVOKED' : 'SUSPENDED', msg);
      return new MainPanelError(403, revoked ? 'panel_revoked' : 'panel_suspended', 'This panel is suspended, revoked or banned by the Main Panel.', { detail: msg });
    }
    case 409: return new MainPanelError(409, 'payment_not_configured', 'Payments are not configured for this panel yet.', { detail: msg });
    case 503: return new MainPanelError(503, 'slots_exhausted', 'No payment amount slots are free right now. Please try again in a few minutes.', { detail: msg });
    case 429: return new MainPanelError(429, 'main_rate_limited', 'The payment service is rate limiting this panel. Please try again shortly.', { retryAfter: r.retryAfter, detail: msg });
    default: return new MainPanelError(r.status, 'main_error', `Main Panel error on ${label} (${r.status}).`, { detail: msg });
  }
}

async function call(method, p, body, { signed = true, label = p } = {}) {
  const base = S.getSetting('main_url');
  if (!base) throw new MainPanelError(0, 'not_registered', 'This panel is not registered with the Main Panel yet.');
  const bodyStr = body === undefined ? '' : JSON.stringify(body);
  const headers = { Accept: 'application/json' };
  if (bodyStr) headers['Content-Type'] = 'application/json';
  if (signed) Object.assign(headers, signHeaders(method, p, bodyStr));
  const r = await rawFetch(method, base + p, headers, bodyStr);
  if (r.status >= 200 && r.status < 300) {
    if (signed && S.getSetting('mp_state') !== 'OK') setState('OK');
    return r.json || {};
  }
  throw mapFailure(r, label);
}

/* ---------- registration ---------- */
async function redeemSetupCode(mainUrl, code, publicUrl) {
  const origin = validateMainUrl(mainUrl);
  const r = await rawFetch('POST', origin + contract.paths.redeem, { 'Content-Type': 'application/json', Accept: 'application/json' }, JSON.stringify({ code, publicUrl }));
  if (r.status < 200 || r.status >= 300) {
    const msg = (r.json && (r.json.error || r.json.message)) || `HTTP ${r.status}`;
    if (r.status === 429) throw new S.HttpError(429, 'main_rate_limited', 'Main Panel rate limited the setup attempt. Try again shortly.');
    throw new S.HttpError(r.status === 404 || r.status === 400 || r.status === 410 || r.status === 401 ? 400 : 502, 'redeem_failed', `Main Panel did not accept the setup code: ${msg}`);
  }
  const j = r.json || {};
  if (![j.panelId, j.secret, j.ownerEmail].every((x) => typeof x === 'string' && x.length)) {
    throw new S.HttpError(502, 'redeem_invalid', 'Main Panel response did not contain panelId, secret and ownerEmail.');
  }
  return { origin, panelId: j.panelId, secret: j.secret, ownerEmail: j.ownerEmail.trim().toLowerCase() };
}

/* ---------- payments ---------- */
const pick = (o, ...ks) => { for (const k of ks) if (o && o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };
function toMs(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) { const n = Number(v); return n < 1e12 ? n * 1000 : n; }
  const t = Date.parse(v); return Number.isFinite(t) ? t : null;
}
function normPayment(j) {
  let amountPaise = null;
  const a = pick(j, 'amount', 'payableAmount');
  if (a !== undefined) { try { amountPaise = parsePaise(String(a)); } catch (_) { /* ignore */ } }
  const st = String(pick(j, 'status', 'state') || '').toUpperCase();
  const status = ['SUCCESS', 'PAID', 'COMPLETED', 'SUCCEEDED'].includes(st) ? 'SUCCESS'
    : ['EXPIRED', 'TIMEOUT'].includes(st) ? 'EXPIRED' : ['FAILED', 'CANCELLED', 'CANCELED', 'REJECTED'].includes(st) ? 'FAILED' : 'PENDING';
  return {
    transactionId: pick(j, 'transactionId', 'id', 'txnId'), status, rawStatus: st, amountPaise,
    upiId: pick(j, 'upiId', 'upi'), paymentLink: pick(j, 'paymentLink', 'link', 'upiLink'), qrData: pick(j, 'qrData', 'qr'),
    expiresAt: toMs(pick(j, 'expiresAt', 'expiry')), panelId: pick(j, 'panelId'),
  };
}
const createPayment = async ({ amountPaise, reference }) => normPayment(await call('POST', contract.paths.createPayment, { amount: Number(formatPaise(amountPaise)), reference }, { label: 'create payment' }));
const startPayment = async (id) => normPayment(await call('POST', contract.paths.startPayment.replace(':id', encodeURIComponent(id)), {}, { label: 'start payment' }));
const checkPayment = async (id) => normPayment(await call('GET', `${contract.paths.checkPayment}?value=${encodeURIComponent(id)}`, undefined, { label: 'check payment' }));
const getPaymentStatus = () => call('GET', contract.paths.paymentStatus, undefined, { label: 'payment status' });
const putPaymentConfig = (cfg) => call('PUT', contract.paths.paymentConfig, cfg, { label: 'payment config' });

/* ---------- server info + heartbeat ---------- */
function serverInfoBody() {
  const g = (k) => S.getSetting(k, '');
  return {
    serverName: g('store_name'), host: g('mc_host'), port: parseInt(g('mc_port'), 10) || null,
    description: g('store_description'), discordInvite: g('discord_invite'), websiteUrl: g('website_url'), logoUrl: g('store_logo'),
  };
}
async function pushServerInfo() {
  if (!S.getSetting('main_panel_id')) return { skipped: true };
  try { await call('PUT', contract.paths.serverInfo, serverInfoBody(), { label: 'server info' }); S.setSetting('mp_server_info_error', null); return { ok: true }; } catch (e) {
    S.setSetting('mp_server_info_error', e.message); return { ok: false, error: e.message };
  }
}
async function heartbeat() {
  if (!S.getSetting('main_panel_id')) return;
  try {
    await call('POST', contract.paths.heartbeat, { sentAt: Date.now() }, { label: 'heartbeat' });
    S.setSetting('mp_last_heartbeat_at', Date.now());
  } catch (e) { console.warn('[heartbeat]', e.message); }
}
let timer = null;
function startBackground() {
  if (timer) return;
  setTimeout(() => heartbeat().catch(() => {}), 5000).unref();
  timer = setInterval(() => heartbeat().catch(() => {}), 120000);
  timer.unref();
}

async function rotateSecret() {
  const j = await call('POST', contract.paths.rotateSecret, {}, { label: 'rotate secret' });
  const ns = pick(j, 'secret', 'newSecret');
  if (typeof ns !== 'string' || ns.length < 16) throw new MainPanelError(502, 'rotate_invalid', 'Main Panel did not return a new secret; the old secret was kept.');
  S.setSetting('main_secret', ns);
  return true;
}

module.exports = {
  getContract, reloadContract, MainPanelError, validateMainUrl, signHeaders, redeemSetupCode, createPayment, startPayment, checkPayment,
  getPaymentStatus, putPaymentConfig, pushServerInfo, heartbeat, startBackground, rotateSecret, getState, setState, panelBlocked, serverInfoBody,
};
