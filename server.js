'use strict';
const express = require('express');
const path = require('path');
const { PUBLIC_DIR, PORT } = require('./lib/paths');
const db = require('./lib/db');
const S = require('./lib/secure');
const MP = require('./lib/mainpanel');
const W = require('./lib/wallet');
const A = require('./lib/accounts');
const C = require('./routes/common');
const { HttpError } = S;

const app = express();
app.disable('x-powered-by');

/* ---------- security headers ---------- */
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (S.isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.url.startsWith('/api') || req.url === '/get' || req.url === '/confirm') res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(express.json({ limit: '100kb' }));

app.get('/health', (req, res) => res.json({ ok: true, build: require('./lib/mainpanel').BUILD }));

/* ---------- setup gate (no .env: first run is configured through the wizard) ---------- */
app.use((req, res, next) => {
  if (C.configured()) return next();
  const p = req.path;
  if (p === '/setup' || p.startsWith('/api/setup') || p === '/api/session' || /^\/(css|js|img)\//.test(p) || p === '/favicon.ico') return next();
  if (p.startsWith('/api/') || p === '/get' || p === '/confirm') return next(new HttpError(503, 'not_configured', 'This panel has not been set up yet.'));
  return res.redirect('/setup');
});

/* ---------- plugin-facing API (token/API-key auth, no cookies, no CSRF) ---------- */
const plugin = require('./routes/plugin');
app.use('/api/plugin', plugin);
app.get('/get', ...plugin.aliases.get);
app.post('/get', ...plugin.aliases.get);
app.post('/confirm', ...plugin.aliases.confirm);

/* ---------- browser API ---------- */
app.use(C.originCheck, C.loadSessions);
app.use('/api/setup', C.csrfCustomer, require('./routes/setup'));
app.use('/api/admin', require('./routes/admin'));
const pub = require('./routes/public');
app.use('/api', pub.api);
app.use('/', pub.pages);

app.get('/favicon.ico', (req, res) => {
  const f = S.getSetting('store_favicon');
  if (f) return res.redirect(f);
  res.sendFile(path.join(PUBLIC_DIR, 'img', 'favicon.svg'));
});

/* ---------- pages ---------- */
app.use(express.static(PUBLIC_DIR, { index: false }));
const page = (file) => (req, res) => res.sendFile(path.join(PUBLIC_DIR, file));
app.get('/', page('index.html'));
app.get('/login', page('login.html'));
app.get('/account', page('account.html'));
app.get('/admin', page('admin.html'));
app.get('/setup', (req, res) => (C.configured() ? res.redirect('/') : page('setup.html')(req, res)));

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next(new HttpError(404, 'not_found', 'Unknown API route.'));
  res.status(404);
  return page('404.html')(req, res);
});

/* ---------- errors ---------- */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return;
  let status = 500; let code = 'server_error'; let message = 'Something went wrong.';
  if (err.type === 'entity.parse.failed') { status = 400; code = 'invalid_json'; message = 'Request body is not valid JSON.'; }
  else if (err.type === 'entity.too.large') { status = 413; code = 'too_large'; message = 'Request is too large.'; }
  else if (err instanceof HttpError) {
    status = err.status; code = err.code; message = err.message;
    if (err.extra && err.extra.retryAfter) res.setHeader('Retry-After', String(err.extra.retryAfter));
  } else console.error('[error]', req.method, req.path, err);
  if (req.path.startsWith('/api/') || req.path === '/get' || req.path === '/confirm') return res.status(status).json({ error: { code, message } });
  return res.status(status).send(message);
});

function start(port = PORT) {
  const server = app.listen(port, () => console.log(`MrKrishna Child Panel listening on :${port} (sqlite driver: ${db.driver})`));
  MP.startBackground();
  const t = setInterval(() => { try { A.sweep(); } catch (e) { console.warn('[sweep]', e.message); } W.sweepDeposits().catch(() => {}); }, 5 * 60 * 1000);
  t.unref();
  return server;
}

if (require.main === module) start();
module.exports = { app, start };
