'use strict';
// Storefront data, customer login (Discord + Minecraft), customer dashboard APIs, purchases.
const express = require('express');
const db = require('../lib/db');
const S = require('../lib/secure');
const A = require('../lib/accounts');
const D = require('../lib/discord');
const W = require('../lib/wallet');
const O = require('../lib/orders');
const MP = require('../lib/mainpanel');
const P = require('../lib/palette');
const { parsePaise, MoneyError } = require('../lib/money');
const C = require('./common');
const { HttpError } = S;

const api = express.Router();   // mounted at /api
const pages = express.Router(); // mounted at /  (Discord OAuth redirects)
const DEFAULT_MAIN = 'https://mkweb-panel.onrender.com';

/* ---------- session + storefront ---------- */
api.get('/session', (req, res) => {
  C.ensureGuest(req, res);
  res.json({ csrf: req.cs.csrf, customer: req.customer ? A.customerView(req.customer) : null });
});

function storeInfo() {
  const g = (k, d = '') => S.getSetting(k, d);
  const pal = P.resolve(g('default_colour', 'blue'));
  const srv = db.get('SELECT status FROM server WHERE id = 1');
  return {
    name: g('store_name', 'My Minecraft Store'), icon: g('store_icon'), logo: g('store_logo'), favicon: g('store_favicon'),
    discordInvite: g('discord_invite'), mcHost: g('mc_host'), mcPort: parseInt(g('mc_port'), 10) || null, description: g('store_description'),
    website: g('website_url'), defaultColour: pal, serverConnected: !!(srv && srv.status === 'ACTIVE'), paymentsBlocked: MP.panelBlocked(),
    discordLogin: D.configured(), mainUrl: g('main_url') || DEFAULT_MAIN, minDepositPaise: S.getInt('min_deposit_paise', 1000), maxDepositPaise: S.getInt('max_deposit_paise', 5000000),
  };
}

api.get('/store', (req, res) => {
  const cats = db.all('SELECT * FROM categories WHERE active = 1 AND deleted_at IS NULL ORDER BY sort, id');
  const okCat = new Set(cats.map((c) => c.id));
  const prods = db.all('SELECT * FROM products WHERE active = 1 AND deleted_at IS NULL ORDER BY sort, id').filter((p) => p.category_id === null || okCat.has(p.category_id));
  const rewards = db.all('SELECT product_id, label FROM product_rewards ORDER BY sort, id');
  res.json({
    store: storeInfo(),
    categories: cats.map((c) => ({ id: c.id, name: c.name, description: c.description, image: c.image_url })),
    products: prods.map((p) => ({
      id: p.id, categoryId: p.category_id, name: p.name, tagline: p.tagline, description: p.description, pricePaise: p.price_paise, image: p.image_url,
      perks: JSON.parse(p.perks || '[]'), badge: p.badge, colour: p.colour ? P.resolve(p.colour) : null, featured: !!p.featured, isBundle: !!p.is_bundle,
      rewards: p.is_bundle ? rewards.filter((r) => r.product_id === p.id).map((r) => r.label) : [],
    })),
  });
});

/* ---------- Discord OAuth ---------- */
pages.get('/auth/discord', C.ah(async (req, res) => {
  if (!D.configured()) return res.redirect('/login?error=discord_not_configured');
  C.ensureGuest(req, res);
  S.rateGuard('oauth-start', S.clientIp(req), 30, 10 * 60 * 1000);
  const state = S.randomToken(24);
  db.run('INSERT INTO oauth_states(state,session_id,link,expires_at) VALUES (?,?,?,?)', state, req.cs.id, req.customer && req.query.link ? 1 : 0, Date.now() + 10 * 60 * 1000);
  res.redirect(D.buildAuthorizeUrl(req, state));
}));

pages.get('/auth/discord/callback', C.ah(async (req, res) => {
  const fail = (code) => res.redirect('/login?error=' + code);
  const { code, state, error } = req.query;
  if (error) return fail('discord_denied');
  if (typeof code !== 'string' || typeof state !== 'string' || !req.cs) return fail('invalid_state');
  const st = db.get('SELECT * FROM oauth_states WHERE state = ?', state);
  db.run('DELETE FROM oauth_states WHERE state = ?', state);            // single use
  if (!st || st.expires_at < Date.now() || !S.safeEq(st.session_id, req.cs.id)) return fail('invalid_state');
  try {
    const token = await D.exchangeCode(req, code);
    const profile = await D.fetchProfile(token);
    const cust = A.upsertDiscordCustomer(profile, st.link && req.customer ? req.customer.id : null);
    S.rotateSession(req, res, 'customer', cust.id);
    db.run('UPDATE customers SET last_login = ? WHERE id = ?', Date.now(), cust.id);
    res.redirect('/account');
  } catch (e) {
    console.warn('[discord oauth]', e.message);
    fail(e instanceof HttpError && e.code === 'discord_taken' ? 'discord_taken' : 'discord_failed');
  }
}));

/* ---------- Minecraft challenge (browser side) ---------- */
api.post('/auth/minecraft/start', C.csrfCustomer, C.ah(async (req, res) => {
  if (!req.cs) throw new HttpError(403, 'no_session', 'Reload the page and try again.');
  S.rateGuard('mc-start-s', req.cs.id, 5, 10 * 60 * 1000);
  S.rateGuard('mc-start-ip', S.clientIp(req), 40, 10 * 60 * 1000);
  const username = S.cleanStr((req.body || {}).username, 32, { allowEmpty: false, name: 'Minecraft username' });
  res.json(A.startChallenge(req.cs, username, req.customer ? req.customer.id : null));
}));

api.get('/auth/minecraft/status', C.ah(async (req, res) => {
  if (!req.cs) throw new HttpError(403, 'no_session', 'Reload the page and try again.');
  S.rateGuard('mc-status', req.cs.id, 120, 60 * 1000);
  const ch = A.claimChallenge(req.cs, parseInt(req.query.id, 10));
  const out = { status: ch.status };
  if (ch.status === 'COMPLETED' && !ch.claimed) {
    db.run('UPDATE auth_challenges SET claimed = 1 WHERE id = ? AND claimed = 0', ch.id);
    if (!req.customer || req.customer.id !== ch.result_customer_id) {
      const fresh = S.rotateSession(req, res, 'customer', ch.result_customer_id);
      out.csrf = fresh.csrf;
    }
    db.run('UPDATE customers SET last_login = ? WHERE id = ?', Date.now(), ch.result_customer_id);
  }
  if (ch.status === 'FAILED') out.reason = ch.fail_reason;
  res.json(out);
}));

api.post('/auth/logout', C.csrfCustomer, (req, res) => {
  S.destroySession(req, res, 'customer');
  res.json({ ok: true });
});

/* ---------- customer dashboard ---------- */
const me = express.Router();
me.use(C.csrfCustomer, C.requireCustomer);

me.get('/', (req, res) => res.json({ customer: A.customerView(req.customer) }));

me.put('/accent', (req, res) => {
  const v = (req.body || {}).color;
  A.setAccent(req.customer.id, v === null || v === '' ? null : v);
  res.json({ ok: true });
});

me.delete('/minecraft', (req, res) => {
  A.unlinkMinecraft(req.customer.id);
  S.audit('customer:' + req.customer.id, 'minecraft.unlink', {}, req);
  res.json({ ok: true });
});

me.get('/transactions', (req, res) => res.json({ transactions: W.listTransactions(req.customer.id) }));

me.post('/deposits', C.ah(async (req, res) => {
  S.rateGuard('deposit', req.customer.id, 10, 10 * 60 * 1000);
  let paise;
  try { paise = parsePaise((req.body || {}).amount); } catch (e) { if (e instanceof MoneyError) throw new HttpError(400, 'invalid_amount', e.message); throw e; }
  res.json({ deposit: await W.createDeposit(req.customer, paise) });
}));
me.get('/deposits/:id', C.ah(async (req, res) => {
  const d = db.get('SELECT * FROM deposits WHERE public_id = ? AND customer_id = ?', String(req.params.id).slice(0, 40), req.customer.id);
  if (!d) throw new HttpError(404, 'not_found', 'Deposit not found.');
  res.json({ deposit: W.view(d) });
}));
me.post('/deposits/:id/start', C.ah(async (req, res) => {
  S.rateGuard('deposit-start', req.customer.id, 20, 10 * 60 * 1000);
  res.json({ deposit: await W.startDeposit(req.customer.id, req.params.id) });
}));
me.post('/deposits/:id/check', C.ah(async (req, res) => {
  S.rateGuard('deposit-check', req.customer.id, 30, 5 * 60 * 1000);
  const deposit = await W.checkDeposit(req.customer.id, req.params.id);
  const c = db.get('SELECT balance_paise FROM customers WHERE id = ?', req.customer.id);
  res.json({ deposit, balancePaise: c.balance_paise });
}));

me.get('/orders', (req, res) => {
  const rows = db.all('SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC, id DESC LIMIT 100', req.customer.id);
  res.json({ orders: rows.map((o) => O.orderView(o)) });
});
me.get('/orders/:id', (req, res) => {
  const o = db.get('SELECT * FROM orders WHERE public_id = ? AND customer_id = ?', String(req.params.id).slice(0, 30), req.customer.id);
  if (!o) throw new HttpError(404, 'not_found', 'Order not found.');
  res.json({ order: O.orderView(o, { tasks: true }) });
});

api.use('/me', me);

api.post('/store/purchase', C.csrfCustomer, C.requireCustomer, C.ah(async (req, res) => {
  S.rateGuard('purchase', req.customer.id, 20, 60 * 1000);
  if (MP.panelBlocked()) throw new HttpError(503, 'panel_suspended', 'This store is temporarily unavailable.');
  const b = req.body || {};
  const out = O.purchase(req.customer.id, b.productId, b.quantity === undefined ? 1 : b.quantity, b.idempotencyKey);
  const c = db.get('SELECT balance_paise FROM customers WHERE id = ?', req.customer.id);
  if (!out.duplicate) S.audit('customer:' + req.customer.id, 'purchase', { order: out.order.public_id, amount: out.order.amount_paise }, req);
  res.json({ order: O.orderView(out.order), duplicate: out.duplicate, balancePaise: c.balance_paise });
}));

module.exports = { api, pages, storeInfo };
