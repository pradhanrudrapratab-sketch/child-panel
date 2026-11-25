'use strict';
const express = require('express');
const db = require('../lib/db');
const S = require('../lib/secure');
const A = require('../lib/accounts');
const O = require('../lib/orders');
const W = require('../lib/wallet');
const MP = require('../lib/mainpanel');
const P = require('../lib/palette');
const { parsePaise, MoneyError } = require('../lib/money');
const C = require('./common');
const { HttpError, cleanStr, cleanUrl } = S;

const r = express.Router();
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
const int = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const money = (v) => { try { return parsePaise(v); } catch (e) { if (e instanceof MoneyError) throw new HttpError(400, 'invalid_amount', e.message); throw e; } };

/* ---------- auth ---------- */
r.post('/login', C.csrfCustomer, C.ah(async (req, res) => {
  if (!C.configured()) throw new HttpError(503, 'not_configured', 'Finish setup first.');
  const ip = S.clientIp(req);
  const email = cleanStr((req.body || {}).email, 200).toLowerCase();
  S.rateGuard('admin-login-ip', ip, 20, 15 * 60 * 1000);
  S.rateGuard('admin-login-email', email || 'none', 8, 15 * 60 * 1000);
  const a = db.get('SELECT * FROM admin WHERE id = 1');
  const pw = typeof (req.body || {}).password === 'string' ? req.body.password.slice(0, 200) : '';
  const ok = a && email === a.email ? await S.verifyPassword(pw, a.password_hash) : (await S.verifyPassword(pw, 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAA'), false);
  if (!ok) { S.audit(email || '?', 'admin.login_failed', {}, req); throw new HttpError(401, 'invalid_credentials', 'Wrong email or password.'); }
  S.rateReset('admin-login-email', email);
  const old = S.loadSession(req, 'admin'); if (old) db.run('DELETE FROM sessions WHERE id = ?', old.id);
  const s = S.createSession(req, res, 'admin', 1);
  S.audit(a.email, 'admin.login', {}, req);
  res.json({ ok: true, csrf: s.csrf, email: a.email });
}));
r.post('/logout', (req, res) => { S.destroySession(req, res, 'admin'); res.json({ ok: true }); });
r.get('/me', (req, res) => {
  if (!req.as || req.as.user_id !== 1) throw new HttpError(401, 'unauthorized', 'Admin login required.');
  res.json({ email: db.get('SELECT email FROM admin WHERE id = 1').email, csrf: req.as.csrf });
});

r.use(C.requireAdmin);

r.put('/account/password', C.ah(async (req, res) => {
  const b = req.body || {};
  S.rateGuard('admin-pw', req.admin.email, 5, 15 * 60 * 1000);
  if (!(await S.verifyPassword(String(b.current || ''), req.admin.password_hash))) throw new HttpError(403, 'wrong_password', 'Current password is incorrect.');
  S.checkPasswordStrength(b.next);
  db.run('UPDATE admin SET password_hash = ?, updated_at = ? WHERE id = 1', await S.hashPassword(b.next), Date.now());
  S.purgeUserSessions('admin', 1, req.as.id);
  S.audit(req.admin.email, 'admin.password_changed', {}, req);
  res.json({ ok: true });
}));

async function confirmPassword(req) {
  if (!(await S.verifyPassword(String((req.body || {}).password || ''), req.admin.password_hash))) throw new HttpError(403, 'wrong_password', 'Password is incorrect.');
}

/* ---------- dashboard ---------- */
r.get('/dashboard', (req, res) => {
  const one = (sql, ...p) => db.get(sql, ...p);
  const srv = db.get('SELECT * FROM server WHERE id = 1');
  const day = Date.now() - 864e5;
  res.json({
    stats: {
      customers: one('SELECT COUNT(*) n FROM customers').n,
      orders: one("SELECT COUNT(*) n FROM orders WHERE kind='PURCHASE'").n,
      revenuePaise: one("SELECT COALESCE(SUM(amount_paise),0) n FROM orders WHERE kind='PURCHASE'").n,
      revenue24hPaise: one("SELECT COALESCE(SUM(amount_paise),0) n FROM orders WHERE kind='PURCHASE' AND created_at > ?", day).n,
      walletHeldPaise: one('SELECT COALESCE(SUM(balance_paise),0) n FROM customers').n,
      depositsPaise: one("SELECT COALESCE(SUM(amount_paise),0) n FROM deposits WHERE credited = 1").n,
      pendingDeposits: one("SELECT COUNT(*) n FROM deposits WHERE status = 'PENDING'").n,
      products: one('SELECT COUNT(*) n FROM products WHERE deleted_at IS NULL').n,
      queued: one("SELECT COUNT(*) n FROM delivery_tasks WHERE status IN ('QUEUED','FETCHED','RECEIVED')").n,
      failedTasks: one("SELECT COUNT(*) n FROM delivery_tasks WHERE status = 'FAILED'").n,
    },
    plugin: srv ? { status: srv.status, lastSeenAt: srv.last_seen_at, lastPollAt: srv.last_poll_at, version: srv.plugin_version } : null,
    mainPanel: { ...MP.getState(), contractConfirmed: !!MP.getContract().confirmed },
    recentOrders: db.all('SELECT * FROM orders ORDER BY created_at DESC, id DESC LIMIT 8').map((o) => O.orderView(o, { admin: true })),
  });
});

/* ---------- settings ---------- */
function settingsView() {
  const g = (k, d = '') => S.getSetting(k, d);
  const srv = db.get('SELECT * FROM server WHERE id = 1');
  return {
    store: { name: g('store_name'), icon: g('store_icon'), logo: g('store_logo'), favicon: g('store_favicon'), discordInvite: g('discord_invite'), mcHost: g('mc_host'), mcPort: g('mc_port'), description: g('store_description'), website: g('website_url'), defaultColour: g('default_colour', 'blue') },
    discord: { clientId: g('discord_client_id'), hasClientSecret: !!g('discord_client_secret'), hasBotToken: !!g('discord_bot_token'), logChannel: g('discord_log_channel'), redirectUri: (g('public_url') || '') + '/auth/discord/callback' },
    general: { publicUrl: g('public_url'), minDeposit: (S.getInt('min_deposit_paise', 1000) / 100).toFixed(2), maxDeposit: (S.getInt('max_deposit_paise', 5000000) / 100).toFixed(2), trustProxyHops: S.getInt('trust_proxy_hops', 1) },
    main: { url: g('main_url'), panelId: g('main_panel_id'), ...MP.getState(), contractConfirmed: !!MP.getContract().confirmed, serverInfoError: g('mp_server_info_error') || null },
    server: srv ? { status: srv.status, name: srv.name, pairedAt: srv.paired_at, lastSeenAt: srv.last_seen_at, lastPollAt: srv.last_poll_at, version: srv.plugin_version, id: srv.server_uid } : null,
    palette: Object.fromEntries(Object.entries(P.PALETTE).map(([k, v]) => [k, v.accent])),
  };
}
r.get('/settings', (req, res) => res.json(settingsView()));

r.put('/settings/store', C.ah(async (req, res) => {
  const b = req.body || {};
  const host = cleanStr(b.mcHost, 100);
  if (host && !/^[A-Za-z0-9.\-]+$/.test(host)) throw new HttpError(400, 'invalid_host', 'Server IP/host may only contain letters, numbers, dots and dashes.');
  const port = cleanStr(String(b.mcPort ?? ''), 5);
  if (port && !(/^\d+$/.test(port) && +port >= 1 && +port <= 65535)) throw new HttpError(400, 'invalid_port', 'Port must be 1-65535.');
  const invite = cleanUrl(b.discordInvite, 'Discord invite');
  if (invite && !/^(discord\.gg|discord\.com|www\.discord\.com|discordapp\.com)$/.test(new URL(invite).hostname)) throw new HttpError(400, 'invalid_url', 'Discord invite must be a discord.gg or discord.com link.');
  const colour = cleanStr(b.defaultColour, 20) || 'blue';
  if (!P.valid(colour)) throw new HttpError(400, 'invalid_color', 'Unknown colour.');
  const v = {
    store_name: cleanStr(b.name, 60, { allowEmpty: false, name: 'Store name' }), store_icon: cleanUrl(b.icon, 'Icon URL'), store_logo: cleanUrl(b.logo, 'Logo URL'),
    store_favicon: cleanUrl(b.favicon, 'Favicon URL'), discord_invite: invite, mc_host: host, mc_port: port, store_description: cleanStr(b.description, 300),
    website_url: cleanUrl(b.website, 'Website URL'), default_colour: colour,
  };
  db.tx(() => Object.entries(v).forEach(([k, val]) => S.setSetting(k, val || (val === '' ? '' : null))));
  S.audit(req.admin.email, 'settings.store', Object.keys(v), req);
  MP.pushServerInfo().catch(() => {});
  res.json({ ok: true });
}));

r.put('/settings/discord', (req, res) => {
  const b = req.body || {};
  const id = cleanStr(b.clientId, 25); const ch = cleanStr(b.logChannel, 25);
  if (id && !/^\d{5,25}$/.test(id)) throw new HttpError(400, 'invalid_input', 'Client ID must be numeric.');
  if (ch && !/^\d{5,25}$/.test(ch)) throw new HttpError(400, 'invalid_input', 'Channel ID must be numeric.');
  db.tx(() => {
    S.setSetting('discord_client_id', id || null); S.setSetting('discord_log_channel', ch || null);
    if (typeof b.clientSecret === 'string' && b.clientSecret.trim()) S.setSetting('discord_client_secret', b.clientSecret.trim().slice(0, 200));
    if (typeof b.botToken === 'string' && b.botToken.trim()) S.setSetting('discord_bot_token', b.botToken.trim().slice(0, 300));
    if (b.clearClientSecret) S.setSetting('discord_client_secret', null);
    if (b.clearBotToken) S.setSetting('discord_bot_token', null);
  });
  S.audit(req.admin.email, 'settings.discord', {}, req);
  res.json({ ok: true });
});

r.put('/settings/general', (req, res) => {
  const b = req.body || {};
  const min = money(b.minDeposit); const max = money(b.maxDeposit);
  if (min < 100 || max < min) throw new HttpError(400, 'invalid_amount', 'Min deposit must be at least ₹1 and not above the max.');
  let pub = cleanStr(b.publicUrl, 300, { allowEmpty: false, name: 'Public URL' });
  try { const u = new URL(pub); if (!(u.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(u.hostname))) throw new Error('x'); pub = u.origin; } catch (_) { throw new HttpError(400, 'invalid_url', 'Public URL must be an https:// address.'); }
  const hops = int(b.trustProxyHops, 1); if (hops < 0 || hops > 5) throw new HttpError(400, 'invalid_input', 'Proxy hops must be 0-5.');
  db.tx(() => { S.setSetting('min_deposit_paise', min); S.setSetting('max_deposit_paise', max); S.setSetting('public_url', pub); S.setSetting('trust_proxy_hops', hops); });
  S.audit(req.admin.email, 'settings.general', {}, req);
  res.json({ ok: true });
});

/* ---------- Main Panel: payment config / status / secret rotation ---------- */
const mpFail = (e) => { if (e instanceof MP.MainPanelError) return new HttpError(e.status && e.status >= 400 ? e.status : 502, e.code, e.message + (e.detail ? ` (${e.detail})` : '')); return e; };

r.get('/payment', C.ah(async (req, res) => {
  try { res.json({ ok: true, status: await MP.getPaymentStatus() }); } catch (e) { res.json({ ok: false, error: mpFail(e).message, code: e.code }); }
}));
r.put('/payment', C.ah(async (req, res) => {
  const b = req.body || {};
  const upi = cleanStr(b.upiId, 100, { allowEmpty: false, name: 'UPI ID' });
  if (!/^[\w.\-]{2,100}@[A-Za-z0-9.\-]{2,60}$/.test(upi)) throw new HttpError(400, 'invalid_upi', 'UPI ID must look like name@bank.');
  try { await MP.putPaymentConfig({ upiId: upi, payeeName: cleanStr(b.payeeName, 60) }); } catch (e) { throw mpFail(e); }
  S.audit(req.admin.email, 'payment.config', { upi }, req);
  res.json({ ok: true });
}));
r.post('/main/refresh', C.ah(async (req, res) => {
  await MP.heartbeat(); const info = await MP.pushServerInfo();
  res.json({ ok: true, state: MP.getState(), serverInfo: info });
}));
r.post('/main/rotate-secret', C.ah(async (req, res) => {
  S.rateGuard('rotate', req.admin.email, 3, 60 * 60 * 1000);
  await confirmPassword(req);
  try { await MP.rotateSecret(); } catch (e) { throw mpFail(e); }
  S.audit(req.admin.email, 'main.rotate_secret', {}, req);
  res.json({ ok: true });
}));

/* ---------- Minecraft server (exactly one) ---------- */
r.get('/server', (req, res) => res.json({ server: settingsView().server }));
r.post('/server/pairing-code', (req, res) => res.json(A.createPairingCode(req.admin.email, req)));
r.post('/server/revoke', C.ah(async (req, res) => { await confirmPassword(req); A.revokeServer(req.admin.email, req); res.json({ ok: true }); }));

/* ---------- categories ---------- */
function parseCategory(b) {
  return { name: cleanStr(b.name, 60, { allowEmpty: false, name: 'Category name' }), description: cleanStr(b.description, 300), image: cleanUrl(b.image, 'Image URL'), sort: int(b.sort), active: bool(b.active ?? 1) };
}
r.get('/categories', (req, res) => {
  res.json({ categories: db.all('SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.deleted_at IS NULL) AS products FROM categories c WHERE c.deleted_at IS NULL ORDER BY c.sort, c.id').map((c) => ({ id: c.id, name: c.name, description: c.description, image: c.image_url, sort: c.sort, active: !!c.active, products: c.products })) });
});
r.post('/categories', (req, res) => {
  const c = parseCategory(req.body || {});
  const id = db.run('INSERT INTO categories(name,description,image_url,sort,active,created_at) VALUES (?,?,?,?,?,?)', c.name, c.description, c.image, c.sort, c.active, Date.now()).lastInsertRowid;
  S.audit(req.admin.email, 'category.create', { id }, req); res.json({ ok: true, id });
});
r.put('/categories/:id', (req, res) => {
  const c = parseCategory(req.body || {});
  const n = db.run('UPDATE categories SET name=?, description=?, image_url=?, sort=?, active=? WHERE id=? AND deleted_at IS NULL', c.name, c.description, c.image, c.sort, c.active, int(req.params.id)).changes;
  if (!n) throw new HttpError(404, 'not_found', 'Category not found.');
  S.audit(req.admin.email, 'category.update', { id: req.params.id }, req); res.json({ ok: true });
});
r.delete('/categories/:id', (req, res) => {
  const id = int(req.params.id);
  db.tx(() => {
    const n = db.run('UPDATE categories SET deleted_at = ?, active = 0 WHERE id = ? AND deleted_at IS NULL', Date.now(), id).changes;
    if (!n) throw new HttpError(404, 'not_found', 'Category not found.');
    db.run('UPDATE products SET category_id = NULL WHERE category_id = ?', id);   // products stay, orders untouched
  });
  S.audit(req.admin.email, 'category.delete', { id }, req); res.json({ ok: true });
});

/* ---------- products ---------- */
function parseProduct(b) {
  const isBundle = bool(b.isBundle);
  const price = money(b.price);
  if (price < 1) throw new HttpError(400, 'invalid_amount', 'Price must be above 0.');
  if (!Array.isArray(b.rewards) || !b.rewards.length || b.rewards.length > 20) throw new HttpError(400, 'invalid_rewards', 'Add 1-20 delivery commands/rewards.');
  const rewards = b.rewards.map((x, i) => ({ label: cleanStr(x.label, 80) || (isBundle ? `Reward ${i + 1}` : cleanStr(b.name, 80)), command: O.cleanCommand(x.command) }));
  const perks = (Array.isArray(b.perks) ? b.perks : []).slice(0, 12).map((p) => cleanStr(p, 100)).filter(Boolean);
  const colour = cleanStr(b.colour, 20);
  if (colour && !P.valid(colour)) throw new HttpError(400, 'invalid_color', 'Unknown colour.');
  let cat = null;
  if (b.categoryId !== null && b.categoryId !== undefined && b.categoryId !== '') {
    cat = int(b.categoryId, -1);
    if (!db.get('SELECT 1 FROM categories WHERE id = ? AND deleted_at IS NULL', cat)) throw new HttpError(400, 'invalid_category', 'Category does not exist.');
  }
  return {
    name: cleanStr(b.name, 80, { allowEmpty: false, name: 'Product name' }), tagline: cleanStr(b.tagline, 140), description: cleanStr(b.description, 1000), price, image: cleanUrl(b.image, 'Image URL'),
    perks: JSON.stringify(perks), badge: cleanStr(b.badge, 24), colour, featured: bool(b.featured), active: bool(b.active ?? 1), isBundle, sort: int(b.sort), cat, rewards,
  };
}
const productView = (p) => ({
  id: p.id, categoryId: p.category_id, name: p.name, tagline: p.tagline, description: p.description, pricePaise: p.price_paise, image: p.image_url, perks: JSON.parse(p.perks || '[]'),
  badge: p.badge, colour: p.colour, featured: !!p.featured, active: !!p.active, isBundle: !!p.is_bundle, sort: p.sort,
  rewards: db.all('SELECT id, label, command FROM product_rewards WHERE product_id = ? ORDER BY sort, id', p.id),
});
r.get('/products', (req, res) => res.json({ products: db.all('SELECT * FROM products WHERE deleted_at IS NULL ORDER BY sort, id').map(productView) }));
function saveRewards(pid, rewards) {
  db.run('DELETE FROM product_rewards WHERE product_id = ?', pid);
  rewards.forEach((x, i) => db.run('INSERT INTO product_rewards(product_id,label,command,sort) VALUES (?,?,?,?)', pid, x.label, x.command, i));
}
r.post('/products', (req, res) => {
  const p = parseProduct(req.body || {});
  const id = db.tx(() => {
    const pid = db.run('INSERT INTO products(category_id,name,tagline,description,price_paise,image_url,perks,badge,colour,featured,active,is_bundle,sort,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      p.cat, p.name, p.tagline, p.description, p.price, p.image, p.perks, p.badge, p.colour, p.featured, p.active, p.isBundle, p.sort, Date.now(), Date.now()).lastInsertRowid;
    saveRewards(pid, p.rewards); return pid;
  });
  S.audit(req.admin.email, 'product.create', { id, price: p.price }, req); res.json({ ok: true, id });
});
r.put('/products/:id', (req, res) => {
  const id = int(req.params.id); const p = parseProduct(req.body || {});
  db.tx(() => {
    const n = db.run('UPDATE products SET category_id=?,name=?,tagline=?,description=?,price_paise=?,image_url=?,perks=?,badge=?,colour=?,featured=?,active=?,is_bundle=?,sort=?,updated_at=? WHERE id=? AND deleted_at IS NULL',
      p.cat, p.name, p.tagline, p.description, p.price, p.image, p.perks, p.badge, p.colour, p.featured, p.active, p.isBundle, p.sort, Date.now(), id).changes;
    if (!n) throw new HttpError(404, 'not_found', 'Product not found.');
    saveRewards(id, p.rewards);   // existing orders keep their own snapshot
  });
  S.audit(req.admin.email, 'product.update', { id, price: p.price }, req); res.json({ ok: true });
});
r.delete('/products/:id', (req, res) => {
  const n = db.run('UPDATE products SET deleted_at = ?, active = 0 WHERE id = ? AND deleted_at IS NULL', Date.now(), int(req.params.id)).changes;
  if (!n) throw new HttpError(404, 'not_found', 'Product not found.');
  S.audit(req.admin.email, 'product.delete', { id: req.params.id }, req); res.json({ ok: true });
});

/* ---------- orders ---------- */
r.get('/orders', (req, res) => {
  const q = req.query;
  res.json(O.listAdminOrders({ q: q.q, status: q.status, kind: q.kind, sort: q.sort, dir: q.dir, limit: int(q.limit, 50), offset: int(q.offset, 0) }));
});
r.get('/orders/:id', (req, res) => {
  const o = db.get('SELECT * FROM orders WHERE public_id = ?', String(req.params.id).slice(0, 30));
  if (!o) throw new HttpError(404, 'not_found', 'Order not found.');
  res.json({ order: O.orderView(o, { admin: true, tasks: true }), snapshot: JSON.parse(o.snapshot || '{}') });
});
r.post('/orders/custom', (req, res) => {
  const b = req.body || {};
  const o = O.createAdminOrder({ kind: b.kind, mcUsername: b.minecraft, name: b.name, rewards: b.rewards, deliverAt: b.deliverAt, note: b.note }, req.admin.email, req);
  res.json({ ok: true, order: O.orderView(o, { admin: true }) });
});
r.post('/orders/:id/cancel', (req, res) => res.json({ ok: true, cancelled: O.cancelOrder(String(req.params.id).slice(0, 30), req.admin.email, req) }));
r.post('/tasks/:id/cancel', (req, res) => { O.cancelTask(int(req.params.id), req.admin.email, req); res.json({ ok: true }); });
r.post('/tasks/:id/requeue', (req, res) => { O.requeueTask(int(req.params.id), req.admin.email, req); res.json({ ok: true }); });

/* ---------- customers / wallet ---------- */
r.get('/customers', (req, res) => {
  const q = cleanStr(req.query.q, 40).replace(/[%_]/g, ''); const l = `%${q}%`;
  const rows = q ? db.all('SELECT * FROM customers WHERE discord_username LIKE ? OR mc_username LIKE ? OR discord_id LIKE ? ORDER BY id DESC LIMIT 100', l, l, l) : db.all('SELECT * FROM customers ORDER BY id DESC LIMIT 100');
  res.json({ customers: rows.map(A.customerView) });
});
r.get('/customers/:id', (req, res) => {
  const c = db.get('SELECT * FROM customers WHERE id = ?', int(req.params.id));
  if (!c) throw new HttpError(404, 'not_found', 'Customer not found.');
  res.json({ customer: A.customerView(c), orders: db.all('SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50', c.id).map((o) => O.orderView(o, { admin: true })), transactions: W.listTransactions(c.id, 50) });
});
r.post('/customers/:id/adjust', (req, res) => {
  const b = req.body || {}; const c = db.get('SELECT id FROM customers WHERE id = ?', int(req.params.id));
  if (!c) throw new HttpError(404, 'not_found', 'Customer not found.');
  const neg = String(b.amount || '').trim().startsWith('-');
  const paise = money(String(b.amount || '').trim().replace(/^[-+]/, '')) * (neg ? -1 : 1);
  res.json({ ok: true, balancePaise: W.adjust(c.id, paise, b.note, req.admin.email, req) });
});

/* ---------- transactions & audit ---------- */
r.get('/transactions', (req, res) => {
  const lim = Math.min(int(req.query.limit, 100), 300);
  const deps = db.all('SELECT d.*, c.discord_username, c.mc_username FROM deposits d JOIN customers c ON c.id = d.customer_id ORDER BY d.created_at DESC LIMIT ?', lim).map((d) => ({ kind: 'deposit', at: d.created_at, customer: d.discord_username || d.mc_username, ...W.view(d) }));
  const led = db.all("SELECT t.*, c.discord_username, c.mc_username FROM wallet_transactions t JOIN customers c ON c.id = t.customer_id WHERE t.type != 'DEPOSIT' ORDER BY t.created_at DESC LIMIT ?", lim)
    .map((t) => ({ kind: 'ledger', at: t.created_at, customer: t.discord_username || t.mc_username, id: t.id, type: t.type, amountPaise: t.amount_paise, balanceAfterPaise: t.balance_after_paise, note: t.note }));
  res.json({ transactions: deps.concat(led).sort((a, b) => b.at - a.at).slice(0, lim) });
});
r.get('/audit', (req, res) => res.json({ entries: db.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200') }));

module.exports = r;
