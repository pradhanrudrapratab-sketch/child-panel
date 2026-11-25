'use strict';
/*
 * End-to-end tests: starts the real server against a MOCK Main Panel (independent HMAC verifier, replay detection,
 * payments) and a MOCK Discord. Run: `npm test`.
 * NOTE: when real Express is not installed (offline sandbox) the test-only shim in test/shim is used instead.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let express; try { require.resolve('express'); } catch (_) {
  process.env.NODE_PATH = path.join(__dirname, 'shim', 'node_modules'); require('module').Module._initPaths();
  console.log('(using test-only express shim)');
}

let pass = 0; let fail = 0;
const ok = (c, name, extra) => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FAIL:', name, extra !== undefined ? JSON.stringify(extra) : ''); } };
const section = (t) => console.log('\n' + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= mock Main Panel ================= */
const MAIN = { panels: new Map(), nonces: new Set(), payments: new Map(), codes: new Set(['SETUP-1234']), serverInfo: null, hb: 0, force: {}, suspended: false, log: [], seq: 1 };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function verify(req, body, urlPath) {
  // Mirrors the real Main Panel (mkweb-store-master/src/server.js panelAuth)
  const h = req.headers; const id = h['x-panel-id']; const p = MAIN.panels.get(id);
  if (!p) return 401;
  const ts = +h['x-timestamp'];
  if (!h['x-nonce'] || !h['x-signature'] || !(Math.abs(Date.now() / 1000 - ts) <= 60)) return 401;
  const msg = `${ts}.${h['x-nonce']}.${req.method}.${urlPath}.${sha(body)}`;
  const sig = crypto.createHmac('sha256', p.secret).update(msg).digest('hex');
  if (h['x-signature'] !== sig) return 401;
  if (MAIN.suspended) return 403;
  if (MAIN.nonces.has(id + h['x-nonce'])) return 401;      // replay
  MAIN.nonces.add(id + h['x-nonce']);
  return 200;
}
const amt = (n) => Math.round(n * 100) / 100;
const mainServer = http.createServer();
function discord(req, u, j, send) {
  if (u.pathname === '/discord/users/@me') {
    const t = req.headers.authorization || '';
    if (t === 'Bearer tok-good-A') return send(200, { id: '111111111111111111', username: 'alice', global_name: 'Alice', avatar: 'abc123' });
    if (t === 'Bearer tok-good-B') return send(200, { id: '222222222222222222', username: 'bob', global_name: 'Bob', avatar: null });
    return send(401, {});
  }
  if (u.pathname.startsWith('/discord/channels/')) { MAIN.discordLog = (MAIN.discordLog || 0) + 1; return send(200, { id: '1' }); }
  return send(404, {});
}

/* ================= HTTP client with cookie jar ================= */
class Client {
  constructor(base) { this.base = base; this.jar = {}; this.csrf = null; }
  async req(method, p, body, headers = {}) {
    const h = { ...headers };
    const ck = Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; '); if (ck) h.cookie = ck;
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(this.base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    (r.headers.getSetCookie ? r.headers.getSetCookie() : []).forEach((c) => { const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i); const v = decodeURIComponent(kv.slice(i + 1)); if (/Max-Age=0/i.test(c) || v === '') delete this.jar[k]; else this.jar[k] = v; });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (_) { /* not json */ }
    return { status: r.status, json, text, headers: r.headers };
  }
  async session() { const r = await this.req('GET', '/api/session'); this.csrf = r.json.csrf; return r.json; }
  call(method, p, body, headers) { return this.req(method, p, body, { 'x-csrf-token': this.csrf || '', ...(headers || {}) }); }
  get(p) { return this.req('GET', p); }
  post(p, b, h) { return this.call('POST', p, b === undefined ? {} : b, h); }
  put(p, b) { return this.call('PUT', p, b); }
  del(p) { return this.call('DELETE', p); }
}

/* ================= bootstrap ================= */
(async () => {
  await new Promise((r) => mainServer.listen(0, '127.0.0.1', r));
  const mp = mainServer.address().port; const MAINURL = 'http://127.0.0.1:' + mp;
  mainServer.on('request', (req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8'); const send = (st, o) => { res.statusCode = st; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o || {})); };
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/discord/oauth2/token') { const f = Object.fromEntries(new URLSearchParams(body)); return String(f.code).startsWith('good') ? send(200, { access_token: 'tok-' + f.code }) : send(400, { error: 'bad' }); }
      return handleMain(req, res, body, u, send);
    });
  });
  function handleMain(req, res, body, u, send) {
    const j = body && req.headers['content-type'] && /json/.test(req.headers['content-type']) ? JSON.parse(body) : {};
    if (u.pathname === '/__mock/pay') { MAIN.payments.forEach((x) => { if (x.status === 'PENDING') x.status = 'SUCCESS'; }); return send(200, { ok: true }); }
    if (u.pathname === '/discord/authorize') { res.statusCode = 302; res.setHeader('Location', u.searchParams.get('redirect_uri') + '?code=good-A&state=' + encodeURIComponent(u.searchParams.get('state'))); return res.end(); }
    if (u.pathname.startsWith('/discord')) return discord(req, u, j, send);
    if (u.pathname === '/api/panel/redeem') {
      if (!MAIN.codes.has(j.code)) return send(410, { error: 'setup code invalid or already used' });
      MAIN.codes.delete(j.code); MAIN.panels.set('panel-test-1', { secret: 'secret-abcdef-0123456789-xyz' });
      return send(200, { panelId: 'panel-test-1', secret: 'secret-abcdef-0123456789-xyz', ownerEmail: 'Owner@Example.com' });
    }
    const st = verify(req, body, req.url); MAIN.log.push(req.method + ' ' + u.pathname + ' ' + st);
    if (st !== 200) return send(st, { error: st === 403 ? 'panel suspended' : 'bad auth' });
    if (u.pathname === '/api/panel/server-info') { MAIN.serverInfo = j; return send(200, { ok: true }); }
    if (u.pathname === '/api/panel/heartbeat') { MAIN.hb++; return send(200, { ok: true }); }
    if (u.pathname === '/api/panel/payment-status') { MAIN.hb++; return send(200, { gmailState: 'CONNECTED' }); }
    if (u.pathname === '/api/panel/payment-config') { MAIN.payCfg = j; return send(200, { ok: true }); }
    if (u.pathname === '/api/panel/rotate-secret') { const s = 'rotated-' + crypto.randomBytes(12).toString('hex'); MAIN.panels.get('panel-test-1').secret = s; return send(200, { secret: s }); }
    if (u.pathname === '/api/panel/payments') {
      if (MAIN.force.create) return send(MAIN.force.create, { error: 'forced' });
      const id = 'TX' + MAIN.seq++; const pay = amt(j.amount + 0.01);
      MAIN.payments.set(id, { id, status: 'PENDING', amount: pay, ref: j.reference });
      return send(200, { transactionId: id, status: 'PENDING', amount: pay, upiId: 'shop@upi', paymentLink: 'upi://pay?pa=shop@upi&am=' + pay, qrData: 'upi://pay?pa=shop@upi&am=' + pay, expiresAt: new Date(Date.now() + 600000).toISOString() });
    }
    const m = u.pathname.match(/^\/api\/panel\/payments\/([^/]+)\/start$/);
    if (m) { const p = MAIN.payments.get(m[1]); if (!p) return send(404); p.started = (p.started || 0) + 1; return send(200, { ok: true, expiresAt: new Date(Date.now() + 600000).toISOString() }); }
    if (u.pathname === '/cheque') { const p = MAIN.payments.get(u.searchParams.get('value')); if (!p) return send(404); p.checks = (p.checks || 0) + 1; return send(200, { transactionId: p.id, status: p.status, amount: p.reportAmount || p.amount, panelId: 'panel-test-1' }); }
    return send(404, {});
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-test-'));
  process.env.CHILD_PANEL_DATA = dataDir;
  fs.writeFileSync(path.join(dataDir, 'contract.json'), JSON.stringify({ override: true, confirmed: true, discord: { api: MAINURL + '/discord', authorize: MAINURL + '/discord/authorize' } }));
  const { start } = require('../server');
  const db = require('../lib/db'); const S = require('../lib/secure'); const MP = require('../lib/mainpanel'); const O = require('../lib/orders');
  const srv = start(0); await sleep(100);
  const BASE = 'http://127.0.0.1:' + srv.address().port;

  const anon = new Client(BASE); const admin = new Client(BASE);
  const alice = new Client(BASE); const bob = new Client(BASE);

  /* ---------- 1. setup & Main Panel registration ---------- */
  section('Setup wizard / Main Panel registration');
  let r = await anon.get('/api/store'); ok(r.status === 503, 'API blocked before setup', r.status);
  r = await anon.get('/'); ok(r.status === 302 && r.headers.get('location') === '/setup', 'pages redirect to /setup before setup');
  await anon.session();
  r = await anon.post('/api/setup/redeem', { mainUrl: MAINURL, code: 'WRONG', password: 'a-long-password-1', passwordConfirm: 'a-long-password-1', publicUrl: BASE });
  ok(r.status === 400 && r.json.error.code === 'redeem_failed', 'invalid setup code rejected', r.json);
  r = await anon.post('/api/setup/redeem', { mainUrl: MAINURL, code: 'SETUP-1234', password: 'short', passwordConfirm: 'short', publicUrl: BASE });
  ok(r.status === 400 && r.json.error.code === 'weak_password', 'weak admin password rejected (code NOT consumed)');
  r = await anon.post('/api/setup/redeem', { mainUrl: 'https://10.0.0.5', code: 'SETUP-1234', password: 'a-long-password-1', passwordConfirm: 'a-long-password-1', publicUrl: BASE });
  ok(r.status === 400, 'private-IP Main Panel URL rejected (SSRF guard)');
  r = await anon.post('/api/setup/redeem', { mainUrl: MAINURL, code: 'SETUP-1234', password: 'a-long-password-1', passwordConfirm: 'a-long-password-1', publicUrl: BASE });
  ok(r.status === 200 && r.json.adminEmail === 'owner@example.com', 'setup code redeemed; owner email becomes admin', r.json);
  ok(!!S.getSetting('main_panel_id') && S.getSetting('main_secret') === 'secret-abcdef-0123456789-xyz', 'panelId + secret stored');
  ok(!/secret-abcdef/.test(db.get("SELECT value FROM settings WHERE key='main_secret'").value), 'secret encrypted at rest in SQLite');
  r = await anon.post('/api/setup/redeem', { mainUrl: MAINURL, code: 'SETUP-1234', password: 'a-long-password-1', passwordConfirm: 'a-long-password-1', publicUrl: BASE });
  ok(r.status === 409, 'setup cannot run twice', r.status);
  let thrown = null; try { await MP.redeemSetupCode(MAINURL, 'SETUP-1234', BASE); } catch (e) { thrown = e; }
  ok(thrown && /already used|invalid/.test(thrown.message), 'setup code reuse rejected by Main Panel');
  r = await anon.get('/setup'); ok(r.status === 302, '/setup redirects away once configured');

  /* ---------- 2. HMAC to Main Panel ---------- */
  section('Main Panel HMAC authentication');
  const mpState = async () => { await MP.heartbeat(); return MP.getState(); };
  ok((await mpState()).state === 'OK' && MAIN.log.some((l) => l.includes('payment-status 200')), 'valid signed request accepted');
  const hdr = MP.signHeaders('POST', '/api/panel/heartbeat', '{"a":1}');
  const raw = (h, b) => fetch(MAINURL + '/api/panel/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: b });
  ok((await raw(hdr, '{"a":1}')).status === 200, 'fresh nonce accepted');
  ok((await raw(hdr, '{"a":1}')).status === 401, 'replayed request rejected (401)');
  ok((await raw({ ...MP.signHeaders('POST', '/api/panel/heartbeat', '{"a":1}'), 'X-Signature': 'deadbeef' }, '{"a":1}')).status === 401, 'invalid signature rejected (401)');
  ok((await raw(MP.signHeaders('POST', '/api/panel/heartbeat', '{"a":1}'), '{"a":2}')).status === 401, 'tampered body rejected (401)');
  ok((await raw(MP.signHeaders('POST', '/api/panel/heartbeat', '', { now: Date.now() - 5 * 60e3 }), '')).status === 401, 'stale timestamp rejected (401)');
  S.setSetting('main_secret', 'wrong-secret-wrong-secret'); await MP.heartbeat();
  ok(MP.getState().state === 'AUTH_ERROR', '401 from Main Panel surfaced as AUTH_ERROR state');
  S.setSetting('main_secret', 'secret-abcdef-0123456789-xyz'); await MP.heartbeat();
  ok(MP.getState().state === 'OK', 'recovers once credentials valid again');

  /* ---------- 3. admin auth ---------- */
  section('Admin authentication');
  await admin.session();
  r = await admin.post('/api/admin/login', { email: 'owner@example.com', password: 'wrong-password-xx' }); ok(r.status === 401, 'wrong password rejected');
  r = await admin.post('/api/admin/login', { email: 'nobody@example.com', password: 'a-long-password-1' }); ok(r.status === 401, 'wrong email rejected');
  r = await admin.req('POST', '/api/admin/login', { email: 'owner@example.com', password: 'a-long-password-1' }); ok(r.status === 403, 'login without CSRF token rejected');
  r = await admin.req('POST', '/api/admin/login', { email: 'owner@example.com', password: 'a-long-password-1' }, { 'x-csrf-token': admin.csrf, origin: 'https://evil.example' }); ok(r.status === 403, 'cross-origin login rejected');
  r = await admin.post('/api/admin/login', { email: 'owner@example.com', password: 'a-long-password-1' });
  ok(r.status === 200, 'admin login ok', r.json); const adminCsrf = r.json.csrf;
  const A = { get: (p) => admin.req('GET', p), post: (p, b) => admin.req('POST', p, b === undefined ? {} : b, { 'x-csrf-token': adminCsrf }), put: (p, b) => admin.req('PUT', p, b, { 'x-csrf-token': adminCsrf }), del: (p) => admin.req('DELETE', p, undefined, { 'x-csrf-token': adminCsrf }) };
  ok((await A.get('/api/admin/dashboard')).status === 200, 'admin dashboard loads');
  ok((await admin.req('POST', '/api/admin/categories', { name: 'x' })).status === 403, 'admin mutation without CSRF rejected');
  ok((await new Client(BASE).get('/api/admin/dashboard')).status === 401, 'unauthenticated client cannot reach admin API');

  /* ---------- 4. store management ---------- */
  section('Store management');
  r = await A.put('/api/admin/settings/store', { name: 'Krishna SMP', icon: 'https://example.com/i.png', logo: 'https://example.com/l.png', favicon: 'https://example.com/f.png', discordInvite: 'https://discord.gg/abc', mcHost: 'play.example.com', mcPort: '25565', description: 'Best SMP', website: 'https://example.com', defaultColour: 'purple' });
  ok(r.status === 200, 'store settings saved', r.json);
  ok((await A.put('/api/admin/settings/store', { name: 'x', icon: 'javascript:alert(1)' })).status === 400, 'unsafe icon URL rejected');
  ok((await A.put('/api/admin/settings/store', { name: 'x', discordInvite: 'https://evil.com/x' })).status === 400, 'non-Discord invite rejected');
  await sleep(150);
  ok(MAIN.serverInfo && MAIN.serverInfo.name === 'Krishna SMP' && MAIN.serverInfo.host === 'play.example.com' && MAIN.serverInfo.port === 25565, 'server-info synced to Main Panel after change', MAIN.serverInfo);
  r = await anon.get('/api/store'); ok(r.json.store.name === 'Krishna SMP' && r.json.store.favicon === 'https://example.com/f.png' && r.json.store.defaultColour.accent === '#a855f7', 'storefront reflects settings');
  ok(!/secret/i.test(JSON.stringify(r.json)), 'no secrets in public store payload');
  r = await anon.get('/favicon.ico'); ok(r.status === 302 && r.headers.get('location') === 'https://example.com/f.png', 'favicon.ico redirects to configured favicon');

  r = await A.post('/api/admin/categories', { name: 'Ranks', description: 'Ranks', image: '' }); const catRanks = r.json.id; ok(r.status === 200 && catRanks, 'category created');
  r = await A.post('/api/admin/categories', { name: 'Keys' }); const catKeys = r.json.id;
  ok((await A.put('/api/admin/categories/' + catKeys, { name: 'Crate Keys', description: 'edit' })).status === 200, 'category edited');
  const prod = (o = {}) => ({ name: 'VIP', price: '50', categoryId: catRanks, rewards: [{ label: 'VIP rank', command: '/lp user %player% parent set vip' }, { label: 'Money', command: 'eco give %player% 1000' }], ...o });
  r = await A.post('/api/admin/products', prod({ name: 'VIP', price: '50.00' })); const pVip = r.json.id; ok(r.status === 200 && pVip, 'product with multiple commands created', r.json);
  ok((await A.post('/api/admin/products', prod({ price: '0' }))).status === 400, 'zero price rejected');
  ok((await A.post('/api/admin/products', prod({ price: '1.999' }))).status === 400, 'price with >2 decimals rejected');
  ok((await A.post('/api/admin/products', prod({ rewards: [{ label: 'x', command: 'give a\nop b' }] }))).status === 400, 'multi-line command rejected');
  ok((await A.post('/api/admin/products', prod({ categoryId: 9999 }))).status === 400, 'unknown category rejected');
  r = await A.post('/api/admin/products', prod({ name: 'VIP Bundle', price: '120', isBundle: true, rewards: [{ label: 'VIP Rank', command: 'lp user %player% parent set vip' }, { label: '64 Diamonds', command: 'give %player% diamond 64' }, { label: '32 Emeralds', command: 'give %player% emerald 32' }, { label: 'Special Kit', command: 'kit give special %player%' }] })); const pBundle = r.json.id; ok(!!pBundle, 'bundle created');
  r = await A.post('/api/admin/products', prod({ name: 'Cheap', price: '5', rewards: [{ label: 'Key', command: 'crate key give %player% common 1' }] })); const pCheap = r.json.id;
  ok((await A.put('/api/admin/products/' + pCheap, prod({ name: 'Cheap Key', price: '6', image: 'https://example.com/k.png', rewards: [{ label: 'Key', command: 'crate key give %player% common 1' }] }))).status === 200, 'product price/name/image edited');
  r = await anon.get('/api/store'); const shown = r.json.products.find((p) => p.id === pBundle);
  ok(r.json.products.length === 3 && shown.isBundle && shown.rewards.length === 4 && typeof shown.rewards[0] === 'string', 'storefront lists products; bundle rewards listed without commands');
  ok(!JSON.stringify(r.json).includes('lp user'), 'delivery commands never exposed publicly');

  /* ---------- 5. customer login: Minecraft + plugin pairing ---------- */
  section('Minecraft server pairing (exactly one)');
  r = await anon.post('/api/auth/minecraft/start', { username: 'Steve' }); ok(r.status === 409 && r.json.error.code === 'server_not_connected', 'cannot start MC login before a server is paired');
  r = await A.post('/api/admin/server/pairing-code'); const pairCode = r.json.code; ok(r.status === 200 && pairCode, 'pairing code issued');
  r = await fetch(BASE + '/api/plugin/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'NOPE' }) }); ok(r.status === 403, 'pairing with bad code rejected');
  r = await (await fetch(BASE + '/api/plugin/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairCode, name: 'Main', version: '1.0' }) })).json();
  const KEY = r.apiKey; const SID = r.serverId; ok(KEY && KEY.startsWith('mkc_') && SID, 'server paired, API key issued');
  r = await fetch(BASE + '/api/plugin/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairCode }) }); ok(r.status === 409, 'second pairing rejected while one server is connected');
  r = await A.post('/api/admin/server/pairing-code'); ok(r.status === 409, 'cannot even create a second pairing code');
  ok(!db.get('SELECT api_key_hash FROM server').api_key_hash.includes(KEY), 'API key stored only as hash');
  const P = (method, p, body, key = KEY) => fetch(BASE + '/api/plugin' + p, { method, headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (x) => ({ status: x.status, json: await x.json().catch(() => null) }));

  section('Minecraft challenge login');
  await alice.session();
  ok((await alice.post('/api/auth/minecraft/start', { username: 'bad name!' })).status === 400, 'invalid username format rejected');
  r = await alice.post('/api/auth/minecraft/start', { username: 'Steve' }); const ch1 = r.json;
  ok(r.status === 200 && /^\/auth Steve \d{9}$/.test(ch1.command), 'challenge command "/auth Steve #########" issued', ch1);
  const tok1 = ch1.command.split(' ')[2];
  ok((await alice.get('/api/auth/minecraft/status?id=' + ch1.id)).json.status === 'PENDING', 'challenge starts PENDING');
  ok((await P('POST', '/auth', { token: tok1, username: 'Steve' }, 'mkc_wrong')).status === 401, 'plugin with invalid key cannot authenticate identity');
  ok((await P('POST', '/auth', { token: tok1, username: 'Steve' }, null)).status === 401, 'plugin without key cannot authenticate identity');
  ok((await P('POST', '/auth', { token: '000000000', username: 'Steve' })).status === 404, 'unknown token rejected');
  ok((await P('POST', '/auth', { token: tok1, username: 'Notch' })).status === 403, 'token used with a different username rejected');
  ok((await alice.get('/api/auth/minecraft/status?id=' + ch1.id)).json.status === 'PENDING', 'failed attempts do not complete challenge');
  ok((await alice.get('/api/me')).status === 401, 'not logged in before plugin confirms');
  r = await P('POST', '/auth', { token: tok1, username: 'Steve' }); ok(r.status === 200 && r.json.ok && !r.json.idempotent, 'plugin completes challenge');
  r = await P('POST', '/auth', { token: tok1, username: 'Steve' }); ok(r.status === 200 && r.json.ok && r.json.idempotent, 'retry after lost response returns original success (idempotent)');
  r = await alice.get('/api/auth/minecraft/status?id=' + ch1.id); ok(r.json.status === 'COMPLETED' && r.json.csrf, 'browser sees COMPLETED and gets a rotated session');
  alice.csrf = r.json.csrf;
  r = await alice.get('/api/me'); ok(r.status === 200 && r.json.customer.minecraft.username === 'Steve', 'session now authenticated as verified Minecraft identity');
  r = await alice.post('/api/auth/minecraft/start', { username: 'Alex' }); const ch2 = r.json; const tok2 = ch2.command.split(' ')[2];
  db.run('UPDATE auth_challenges SET expires_at = ? WHERE id = ?', Date.now() - 1000, ch2.id);
  ok((await P('POST', '/auth', { token: tok2, username: 'Alex' })).status === 410, 'expired challenge rejected');
  // a second browser may log in again with the same Minecraft identity
  const alice2 = new Client(BASE); await alice2.session(); r = await alice2.post('/api/auth/minecraft/start', { username: 'steve' }); const t3 = r.json.command.split(' ')[2];
  await P('POST', '/auth', { token: t3, username: 'Steve' }); r = await alice2.get('/api/auth/minecraft/status?id=' + r.json.id); alice2.csrf = r.json.csrf;
  ok((await alice2.get('/api/me')).json.customer.id === (await alice.get('/api/me')).json.customer.id, 'logging in again with same Minecraft identity restores the same account');

  /* ---------- 6. Discord OAuth ---------- */
  section('Discord OAuth');
  ok((await A.put('/api/admin/settings/discord', { clientId: '999999999999', clientSecret: 'dsecret-xyz', botToken: 'bot-token-123', logChannel: '555555555555' })).status === 200, 'Discord settings saved');
  const sv = await A.get('/api/admin/settings'); ok(!JSON.stringify(sv.json).includes('dsecret-xyz') && !JSON.stringify(sv.json).includes('bot-token-123') && sv.json.discord.hasClientSecret, 'Discord secrets never returned to the browser');
  await bob.session();
  r = await bob.get('/auth/discord'); const loc = new URL(r.headers.get('location'));
  ok(r.status === 302 && loc.searchParams.get('client_id') === '999999999999' && loc.searchParams.get('state') && loc.searchParams.get('scope') === 'identify', 'OAuth redirect has client_id, scope and state');
  ok((await bob.get('/auth/discord/callback?code=good-A&state=forged')).headers.get('location').includes('invalid_state'), 'forged OAuth state rejected');
  r = await bob.get('/auth/discord'); const st = new URL(r.headers.get('location')).searchParams.get('state');
  const other = new Client(BASE); await other.session();
  ok((await other.get('/auth/discord/callback?code=good-A&state=' + st)).headers.get('location').includes('invalid_state'), 'state is bound to the initiating session');
  r = await bob.get('/auth/discord'); const st2 = new URL(r.headers.get('location')).searchParams.get('state');
  r = await bob.get('/auth/discord/callback?code=good-B&state=' + st2); ok(r.headers.get('location') === '/account', 'Discord callback logs customer in');
  ok((await bob.get('/auth/discord/callback?code=good-B&state=' + st2)).headers.get('location').includes('invalid_state'), 'OAuth state is single-use');
  bob.csrf = (await bob.session()).csrf;
  r = await bob.get('/api/me'); ok(r.json.customer.discord.id === '222222222222222222' && r.json.customer.discord.username === 'bob', 'Discord user id + profile saved');
  // Bob links a Minecraft account; cannot claim Steve
  r = await bob.post('/api/auth/minecraft/start', { username: 'Steve' }); ok(r.status === 409 && r.json.error.code === 'minecraft_taken', 'cannot claim another customer\'s Minecraft identity');
  r = await bob.post('/api/auth/minecraft/start', { username: 'BobMC' }); const tb = r.json.command.split(' ')[2];
  await P('POST', '/auth', { token: tb, username: 'BobMC' }); await bob.get('/api/auth/minecraft/status?id=' + r.json.id);
  r = await bob.get('/api/me'); ok(r.json.customer.minecraft.username === 'BobMC' && r.json.customer.discord, 'Minecraft linked to the Discord customer');
  ok((await bob.del('/api/me/minecraft')).status === 200 && !(await bob.get('/api/me')).json.customer.minecraft, 'Minecraft identity can be disconnected');
  r = await bob.post('/api/auth/minecraft/start', { username: 'BobMC' }); const tb2 = r.json.command.split(' ')[2]; await P('POST', '/auth', { token: tb2, username: 'BobMC' }); await bob.get('/api/auth/minecraft/status?id=' + r.json.id);
  ok((await alice.del('/api/me/minecraft')).status === 409, 'Minecraft-only account cannot disconnect its only identity');
  r = await bob.get('/api/me'); const bobId = r.json.customer.id;

  /* ---------- 7. accent colour ---------- */
  section('Customer accent colour');
  ok((await bob.put('/api/me/accent', { color: '#ff00aa' })).status === 200 && (await bob.get('/api/me')).json.customer.accent === '#ff00aa', 'accent saved to profile');
  ok((await bob.put('/api/me/accent', { color: 'red; background:url(x)' })).status === 400, 'invalid accent rejected');
  ok((await alice.get('/api/me')).json.customer.accent === null && (await anon.get('/api/store')).json.store.defaultColour.accent === '#a855f7', 'accent is per-customer; owner default unchanged');
  ok((await bob.put('/api/me/accent', { color: null })).status === 200 && (await bob.get('/api/me')).json.customer.accent === null, 'restore default');

  /* ---------- 8. deposits ---------- */
  section('Wallet deposits');
  r = await alice.post('/api/me/deposits', { amount: '5' }); ok(r.status === 400, 'below-minimum deposit rejected');
  r = await alice.post('/api/me/deposits', { amount: '100.555' }); ok(r.status === 400, 'amount with 3 decimals rejected');
  r = await alice.post('/api/me/deposits', { amount: '100' }); const dep = r.json.deposit;
  ok(r.status === 200 && dep.status === 'PENDING' && dep.amountPaise === 10000 && dep.payAmountPaise === 10001 && dep.canStart, 'deposit created; Main Panel exact amount (₹100.01) stored', dep);
  r = await alice.post(`/api/me/deposits/${dep.id}/start`); ok(r.json.deposit.upiId === 'shop@upi' && r.json.deposit.startedAt && !r.json.deposit.canStart, 'payment started; QR/link available');
  await alice.post(`/api/me/deposits/${dep.id}/start`); await Promise.all([1, 2, 3].map(() => alice.post(`/api/me/deposits/${dep.id}/start`)));
  ok(MAIN.payments.get('TX1').started === 1, 'Main Panel "start" called exactly once despite repeats/simultaneous clicks', MAIN.payments.get('TX1').started);
  r = await alice.get(`/api/me/deposits/${dep.id}`); ok(r.json.deposit.paymentLink && r.json.deposit.status === 'PENDING', 'pending deposit reopens with payment info (no new payment created)');
  ok(MAIN.payments.size === 1, 'reopening did not create another Main Panel payment');
  r = await alice.get('/api/me/transactions'); ok(r.json.transactions.some((t) => t.id === dep.id && t.status === 'PENDING'), 'pending deposit visible in transaction history');
  r = await alice.post(`/api/me/deposits/${dep.id}/check`); ok(r.json.deposit.status === 'PENDING' && r.json.balancePaise === 0, 'check while pending: no credit');
  ok((await bob.get(`/api/me/deposits/${dep.id}`)).status === 404 && (await bob.post(`/api/me/deposits/${dep.id}/check`)).status === 404, 'another customer cannot read/check this deposit (IDOR)');
  MAIN.payments.get('TX1').reportAmount = 99.99; MAIN.payments.get('TX1').status = 'SUCCESS';
  r = await alice.post(`/api/me/deposits/${dep.id}/check`); ok(r.status === 409 && r.json.error.code === 'amount_mismatch', 'SUCCESS with wrong amount is NOT credited');
  ok((await alice.get('/api/me')).json.customer.balancePaise === 0, 'balance unchanged after amount mismatch');
  delete MAIN.payments.get('TX1').reportAmount;
  await Promise.all([1, 2, 3, 4, 5].map(() => alice.post(`/api/me/deposits/${dep.id}/check`)));
  for (let i = 0; i < 3; i++) await alice.post(`/api/me/deposits/${dep.id}/check`);
  r = await alice.get('/api/me'); ok(r.json.customer.balancePaise === 10000, 'wallet credited exactly once (₹100.00) after repeated + simultaneous checks', r.json.customer.balancePaise);
  ok(db.get("SELECT COUNT(*) n FROM wallet_transactions WHERE type='DEPOSIT'").n === 1, 'exactly one DEPOSIT ledger row');
  db.run("UPDATE deposits SET credited=0 WHERE public_id=?", dep.id); // simulate a racing double-credit attempt at the DB level
  const W = require('../lib/wallet'); let dbl = null; try { db.tx(() => { db.run("UPDATE deposits SET credited=1 WHERE public_id=?", dep.id); W.addLedger({ customerId: db.get('SELECT customer_id c FROM deposits WHERE public_id=?', dep.id).c, type: 'DEPOSIT', amount: 10000, refType: 'deposit', refId: dep.id }); }); } catch (e) { dbl = e; }
  ok(!!dbl && (await alice.get('/api/me')).json.customer.balancePaise === 10000, 'DB unique constraint blocks a duplicate credit even if app logic raced');
  await sleep(50); await sleep(100); ok(MAIN.discordLog >= 1, 'Discord deposit log sent');
  S.setSetting('discord_log_channel', '0'); // invalid -> logging silently skipped, wallet unaffected
  S.setSetting('discord_log_channel', '555555555555');
  // expired deposit
  r = await alice.post('/api/me/deposits', { amount: '20' }); const dep2 = r.json.deposit; await alice.post(`/api/me/deposits/${dep2.id}/start`);
  MAIN.payments.get('TX2').status = 'EXPIRED'; r = await alice.post(`/api/me/deposits/${dep2.id}/check`); ok(r.json.deposit.status === 'EXPIRED' && r.json.balancePaise === 10000, 'expired payment marked EXPIRED, no credit');
  // Main Panel error mapping
  MAIN.force.create = 409; r = await alice.post('/api/me/deposits', { amount: '20' }); ok(r.status === 409 && r.json.error.code === 'payment_not_configured', '409 payment not configured surfaced');
  MAIN.force.create = 503; r = await alice.post('/api/me/deposits', { amount: '20' }); ok(r.status === 503 && r.json.error.code === 'slots_exhausted', '503 amount slots exhausted surfaced');
  MAIN.force.create = 429; r = await alice.post('/api/me/deposits', { amount: '20' }); ok(r.status === 429, '429 rate limited surfaced');
  MAIN.force.create = 401; r = await alice.post('/api/me/deposits', { amount: '20' }); ok(r.status === 502 && MP.getState().state === 'AUTH_ERROR', '401 from Main Panel handled (not silently ignored)');
  MAIN.force = {}; await MP.heartbeat();
  ok((await alice.get('/api/me/transactions')).json.transactions.filter((t) => t.kind === 'deposit' && t.status === 'FAILED').length >= 3, 'failed deposit attempts recorded in history');

  /* ---------- 9. purchases ---------- */
  section('Purchases');
  const buy = (c, productId, extra = {}) => c.post('/api/store/purchase', { productId, quantity: 1, idempotencyKey: crypto.randomUUID(), ...extra });
  const balance = async (c) => (await c.get('/api/me')).json.customer.balancePaise;
  ok((await buy(anon, pVip)).status === 401, 'purchase requires login');
  r = await buy(bob, pCheap); ok(r.status === 402, 'insufficient balance rejected (bob has ₹0)', r.json);
  ok((await buy(alice, 99999)).status === 404, 'invalid product rejected');
  const key = crypto.randomUUID();
  r = await alice.post('/api/store/purchase', { productId: pVip, quantity: 1, idempotencyKey: key, price: 1, amountPaise: 1, command: 'op %player%' });
  ok(r.status === 200 && r.json.order.amountPaise === 5000 && r.json.balancePaise === 5000, 'purchase debits the REAL DB price (₹50), ignoring browser price', r.json);
  const ord1 = r.json.order.id;
  const dupes = await Promise.all([1, 2, 3, 4, 5].map(() => alice.post('/api/store/purchase', { productId: pVip, quantity: 1, idempotencyKey: key })));
  ok(dupes.every((d) => d.status === 200 && d.json.order.id === ord1) && (await balance(alice)) === 5000, 'duplicate/retried purchase (same key, 5 parallel) creates one order and one debit');
  ok(db.get("SELECT COUNT(*) n FROM wallet_transactions WHERE type='PURCHASE'").n === 1, 'exactly one PURCHASE ledger row');
  const t1 = db.all('SELECT label, command FROM delivery_tasks WHERE order_id = (SELECT id FROM orders WHERE public_id=?)', ord1);
  ok(t1.length === 2 && t1[0].command === 'lp user Steve parent set vip' && t1[1].command === 'eco give Steve 1000', 'delivery tasks created with %player% = verified username; customer command ignored', t1);
  r = await buy(alice, pBundle, { quantity: 10 }); ok(r.status === 402, 'quantity x price checked against balance (10×₹120)');
  ok((await buy(alice, pCheap, { quantity: 0 })).status === 400 && (await buy(alice, pCheap, { quantity: 11 })).status === 400, 'quantity bounds enforced');
  ok((await alice.post('/api/store/purchase', { productId: pCheap, quantity: 1 })).status === 400, 'idempotency key required');
  // need more balance for the bundle: admin credit
  r = await A.post(`/api/admin/customers/${(await alice.get('/api/me')).json.customer.id}/adjust`, { amount: '200', note: 'test credit' }); ok(r.json.balancePaise === 25000, 'admin wallet adjustment recorded', r.json);
  r = await buy(alice, pBundle); const bundleOrder = r.json.order; ok(r.status === 200 && bundleOrder.isBundle && bundleOrder.progress.total === 4 && (await balance(alice)) === 13000, 'bundle purchased: 4 independent reward tasks');
  // product edits/deletion must not change history
  await A.put('/api/admin/products/' + pVip, prod({ name: 'VIP v2', price: '99', rewards: [{ label: 'x', command: 'say changed %player%' }] }));
  r = await A.get('/api/admin/orders/' + ord1); ok(r.json.order.product === 'VIP' && r.json.order.amountPaise === 5000 && r.json.order.tasks[0].command === 'lp user Steve parent set vip', 'order keeps snapshot after the product was edited');
  await A.del('/api/admin/products/' + pCheap); ok((await anon.get('/api/store')).json.products.every((p) => p.id !== pCheap) && (await A.get('/api/admin/orders?q=Cheap')).json.total === 0 && (await A.get('/api/admin/orders/' + ord1)).status === 200, 'deleted product disappears from the store; historical orders remain');
  const catDel = (await A.post('/api/admin/categories', { name: 'Temp' })).json.id; await A.del('/api/admin/categories/' + catDel); ok((await A.get('/api/admin/categories')).json.categories.every((c) => c.id !== catDel), 'category deleted safely');
  ok((await bob.get('/api/me/orders/' + ord1)).status === 404, 'customer cannot open another customer\'s order (IDOR)');
  ok((await alice.get('/api/me/orders')).json.orders.length === 2 && !JSON.stringify((await alice.get('/api/me/orders/' + ord1)).json).includes('lp user'), 'customer sees own orders, never the commands');
  ok((await bob.get('/api/admin/orders')).status === 401, 'customer cannot reach admin routes');

  /* ---------- 10. delivery queue + plugin two-token flow ---------- */
  section('Delivery queue / plugin confirmation');
  ok((await P('GET', '/get', undefined, 'mkc_nope')).status === 401, '/get with invalid key rejected');
  r = await P('GET', '/get'); const ops = r.json.operations;
  ok(r.status === 200 && ops.length === 6 && ops.every((o) => o.confirmToken && o.successToken && o.confirmToken !== o.successToken), 'plugin fetches 6 operations with confirm + success tokens (2 + 4)', ops.length);
  ok(db.get("SELECT COUNT(*) n FROM delivery_tasks WHERE status='DELIVERED'").n === 0, 'fetching alone never marks anything delivered');
  const again = (await P('GET', '/get')).json.operations; ok(again.length === 6 && again[0].confirmToken === ops[0].confirmToken, 'lost /get response: re-fetch returns the same operations and tokens (no duplicates)');
  const o0 = ops[0];
  ok((await P('POST', '/confirm', { token: o0.successToken })).status === 409, 'success before received is rejected');
  ok((await P('POST', '/confirm', { token: 'x'.repeat(40) })).status === 404, 'invalid token never advances anything');
  ok((await P('POST', '/confirm', { token: o0.confirmToken }, 'mkc_bad')).status === 401, 'confirm requires valid server key');
  r = await P('POST', '/confirm', { token: o0.confirmToken }); ok(r.json.status === 'RECEIVED' && !r.json.idempotent, 'stage 2: RECEIVED');
  r = await P('POST', '/confirm', { token: o0.confirmToken }); ok(r.json.status === 'RECEIVED' && r.json.idempotent, 'repeated receive confirmation is idempotent');
  ok(!(await P('GET', '/get')).json.operations.some((o) => o.operationId === o0.operationId), 'received operations are no longer re-sent');
  ok(db.get('SELECT delivery_status s FROM orders WHERE public_id=?', ord1).s === 'PROCESSING', 'order shows PROCESSING while partly confirmed');
  r = await P('POST', '/confirm', { token: o0.successToken }); ok(r.json.status === 'DELIVERED', 'stage 3: DELIVERED');
  r = await P('POST', '/confirm', { token: o0.successToken }); ok(r.json.status === 'DELIVERED' && r.json.idempotent, 'repeated success confirmation is idempotent');
  r = await A.get('/api/admin/orders/' + ord1); ok(r.json.order.progress.delivered === 1 && r.json.order.progress.total === 2 && r.json.order.deliveryStatus === 'PROCESSING', 'order progress 1/2 and not DELIVERED yet');
  // tokens are bound to their own operation
  const oBundle = ops.filter((o) => o.orderId === bundleOrder.id);
  await P('POST', '/confirm', { token: oBundle[0].confirmToken }); const rr = await P('POST', '/confirm', { token: oBundle[1].successToken });
  ok(rr.status === 409, 'a success token cannot complete a different, unreceived operation');
  // complete order 1 fully
  const o1 = ops[1]; await P('POST', '/confirm', { token: o1.confirmToken }); await P('POST', '/confirm', { token: o1.successToken });
  ok(db.get('SELECT delivery_status s FROM orders WHERE public_id=?', ord1).s === 'DELIVERED', 'order DELIVERED only after every task succeeded');
  // bundle: individual statuses
  await P('POST', '/confirm', { token: oBundle[0].successToken });
  r = await A.get('/api/admin/orders/' + bundleOrder.id);
  const sts = r.json.order.tasks.map((t) => t.status); ok(sts[0] === 'DELIVERED' && sts[1] === 'PROCESSING' && sts[2] === 'PROCESSING' && r.json.order.deliveryStatus === 'PROCESSING' && r.json.order.progress.delivered === 1, 'bundle: each reward tracked separately; one success does not deliver the bundle', sts);
  r = await P('POST', '/confirm', { token: oBundle[2].confirmToken }); r = await P('POST', '/confirm', { token: oBundle[2].successToken, status: 'FAILED', reason: 'player banned' });
  ok(r.json.status === 'FAILED', 'plugin can report a failed reward');
  r = await A.get('/api/admin/orders/' + bundleOrder.id); ok(r.json.order.tasks[2].failReason === 'player banned', 'failure reason visible to admin');
  ok((await A.post('/api/admin/tasks/' + oBundle[2].operationId + '/requeue')).status === 200 && db.get('SELECT status s FROM delivery_tasks WHERE id=?', oBundle[2].operationId).s === 'QUEUED', 'admin can re-queue a failed reward');
  ok((await P('POST', '/confirm', { token: oBundle[2].successToken })).status === 404, 'old tokens are revoked after re-queue');

  section('Giveaways / manual orders');
  const bal0 = await balance(alice);
  r = await A.post('/api/admin/orders/custom', { kind: 'GIVEAWAY', minecraft: 'WinnerGuy', name: 'Event prize', rewards: [{ label: 'Diamonds', command: 'give %player% diamond 5' }, { label: 'Title', command: '/title %player% title "GG"' }], note: 'event' });
  ok(r.status === 200 && r.json.order.amountPaise === 0 && r.json.order.paymentStatus === 'NOT_APPLICABLE', 'giveaway created without charging anyone', r.json);
  ok((await A.post('/api/admin/orders/custom', { kind: 'MANUAL', minecraft: 'bad name', rewards: [{ command: 'x' }] })).status === 400, 'custom order validates username');
  ok(!JSON.stringify((await anon.get('/api/store')).json).includes('Event prize') && (await balance(alice)) === bal0, 'custom orders absent from public catalogue; no wallet change');
  const gOps = (await P('GET', '/get')).json.operations.filter((o) => o.player === 'WinnerGuy'); ok(gOps.length === 2 && gOps[0].command === 'give WinnerGuy diamond 5', 'giveaway tasks flow through the same queue');
  r = await A.post('/api/admin/orders/custom', { kind: 'CUSTOM', minecraft: 'Later', rewards: [{ label: 'x', command: 'say hi %player%' }], deliverAt: Date.now() + 3600e3 }); ok(r.json.order.deliveryStatus === 'SCHEDULED', 'future delivery shows SCHEDULED');
  ok(!(await P('GET', '/get')).json.operations.some((o) => o.player === 'Later'), 'scheduled task not handed to the plugin early');
  const ol = await A.get('/api/admin/orders?q=WinnerGuy'); ok(ol.json.total === 1 && ol.json.orders[0].kind === 'GIVEAWAY', 'admin order search/filter works');
  ok((await A.get('/api/admin/orders?status=DELIVERED&sort=amount&dir=asc')).json.orders.every((o) => o.deliveryStatus === 'DELIVERED'), 'status filter + sort');
  r = await A.get('/api/admin/transactions'); ok(r.json.transactions.some((t) => t.type === 'PURCHASE') && r.json.transactions.some((t) => t.kind === 'deposit') && r.json.transactions.some((t) => t.type === 'ADJUSTMENT'), 'transaction history separate from orders and complete');

  /* ---------- 11. rate limiting, revoke, suspension, rotation ---------- */
  section('Rate limiting / revoke / suspension / rotation');
  let last; for (let i = 0; i < 14; i++) last = await P('GET', '/get'); ok(last.status === 429, 'backend rate-limits /get polling regardless of plugin cooldown', last.status);
  let f; for (let i = 0; i < 12; i++) f = await P('POST', '/auth', { token: '123456789', username: 'Steve' }, 'mkc_guess' + i); ok(f.status === 429, 'repeated invalid credentials get throttled');
  ok((await A.post('/api/admin/server/revoke', { password: 'nope-nope-nope' })).status === 403, 'revoking requires the admin password');
  ok((await A.post('/api/admin/server/revoke', { password: 'a-long-password-1' })).status === 200, 'server disconnected/revoked');
  r = await fetch(BASE + '/api/plugin/get', { headers: { authorization: 'Bearer ' + KEY } }); ok(r.status === 401 || r.status === 429, 'revoked server can no longer authenticate');
  ok((await P('POST', '/auth', { token: '123456789', username: 'Steve' })).status !== 200, 'revoked server cannot authenticate identities');
  r = await alice.post('/api/store/purchase', { productId: pBundle, quantity: 1, idempotencyKey: crypto.randomUUID() }); ok(r.status === 503 && r.json.error.code === 'server_not_connected', 'purchases paused while no server is connected (no wallet debit)');
  r = await A.post('/api/admin/server/pairing-code'); ok(r.status === 200, 'new pairing code after revoke');
  r = await (await fetch(BASE + '/api/plugin/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: r.json.code }) })).json(); global.__KEY = r.apiKey; ok(r.apiKey && r.apiKey !== KEY, 're-pair issues a brand-new key');
  ok((await P('GET', '/get', undefined, r.apiKey)).status === 200 && [401, 429].includes((await P('GET', '/get')).status), 'only the new key works (old key refused/throttled)');

  r = await A.post('/api/admin/main/rotate-secret', { password: 'a-long-password-1' }); ok(r.status === 200 && S.getSetting('main_secret').startsWith('rotated-'), 'secret rotation via Main Panel API stored the new secret');
  await MP.heartbeat(); ok(MP.getState().state === 'OK', 'requests signed with the rotated secret are accepted');
  MAIN.suspended = true; await MP.heartbeat(); ok(MP.getState().state === 'SUSPENDED', '403 marks the panel SUSPENDED');
  r = await alice.post('/api/me/deposits', { amount: '50' }); ok(r.status === 503 && r.json.error.code === 'panel_suspended', 'deposits blocked while suspended');
  r = await alice.post('/api/store/purchase', { productId: pBundle, quantity: 1, idempotencyKey: crypto.randomUUID() }); ok(r.status === 503, 'purchases blocked while suspended');
  MAIN.suspended = false; MAIN.panels.get('panel-test-1').suspendedClear = true; await MP.heartbeat(); ok(MP.getState().state === 'OK', 'panel recovers after suspension is lifted');

  /* ---------- 12. misc security ---------- */
  section('Misc security');
  r = await alice.req('POST', '/api/me/deposits', { amount: '20' }); ok(r.status === 403, 'customer mutation without CSRF rejected');
  r = await alice.req('PUT', '/api/me/accent', { color: '#fff000' }, { 'x-csrf-token': alice.csrf, origin: 'https://evil.example' }); ok(r.status === 403, 'cross-origin mutation rejected');
  r = await anon.get('/'); ok(/content-security-policy/i.test([...r.headers.keys()].join()) || r.headers.get('content-security-policy'), 'CSP header present');
  const ck = await fetch(BASE + '/api/session'); ok(/HttpOnly/i.test(ck.headers.get('set-cookie')) && /SameSite=Lax/i.test(ck.headers.get('set-cookie')), 'session cookie is HttpOnly + SameSite');
  ok((await admin.post('/api/admin/logout')).status === 200 && (await A.get('/api/admin/dashboard')).status === 401, 'admin logout invalidates session');
  r = await new Client(BASE).get('/api/admin/audit'); ok(r.status === 401, 'audit log is admin-only');
  ok(db.get('SELECT COUNT(*) n FROM audit_log').n > 10, 'audit records written');
  ok(db.get('SELECT COUNT(*) n FROM wallet_transactions').n === db.all('SELECT DISTINCT id FROM wallet_transactions').length, 'every wallet change has its own ledger row');
  const sum = db.get('SELECT COALESCE(SUM(amount_paise),0) s FROM wallet_transactions').s; const bals = db.get('SELECT COALESCE(SUM(balance_paise),0) s FROM customers').s;
  ok(sum === bals, 'ledger total equals the sum of all wallet balances (books balance)', { sum, bals });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (process.env.UI_KEEP) {            // keep everything running so a browser UI test can drive the real server
    console.log('UI_READY ' + JSON.stringify({ base: BASE, key: global.__KEY, main: MAINURL }));
    await new Promise(() => {});
  }
  srv.close(); mainServer.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(2); });
