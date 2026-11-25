'use strict';
// Orders, bundle rewards, the persistent delivery queue and the plugin two-token confirmation flow.
const crypto = require('crypto');
const db = require('./db');
const S = require('./secure');
const W = require('./wallet');
const { HttpError } = S;

const MAX_QTY = 10;
const TOKEN_TTL = 24 * 36e5;           // confirm/success tokens issued on fetch
const SUCCESS_TTL = 7 * 24 * 36e5;     // after RECEIVED the plugin may wait (e.g. offline player) before executing

/* ---------- command validation (admin-configured only; never customer input) ---------- */
function cleanCommand(cmd) {
  let c = S.cleanStr(cmd, 256, { allowEmpty: false, name: 'Command' });
  c = c.replace(/^\/+/, '');
  if (/[\r\n\t]/.test(cmd) || !c) throw new HttpError(400, 'invalid_command', 'Commands must be a single line.');
  return c;
}
const resolveCommand = (tpl, player) => tpl.replace(/%player%/gi, player);

/* ---------- status helpers ---------- */
function aggregate(tasks, now = Date.now()) {
  if (!tasks.length) return 'PENDING';
  const live = tasks.filter((t) => t.status !== 'CANCELLED');
  if (!live.length) return 'CANCELLED';
  const n = live.length; const c = (s) => live.filter((t) => t.status === s).length;
  if (c('DELIVERED') === n) return 'DELIVERED';
  if (c('FAILED') > 0 && live.every((t) => ['FAILED', 'DELIVERED'].includes(t.status))) return 'FAILED';
  if (c('RECEIVED') === n) return 'RECEIVED';
  if (live.some((t) => ['FETCHED', 'RECEIVED', 'DELIVERED'].includes(t.status))) return 'PROCESSING';
  if (live.every((t) => t.status === 'QUEUED' && t.available_at > now)) return 'SCHEDULED';
  return 'PENDING';
}
const taskLabelStatus = (t, now = Date.now()) => (t.status === 'QUEUED' ? (t.available_at > now ? 'SCHEDULED' : 'PENDING') : t.status === 'FETCHED' ? 'PROCESSING' : t.status);

function recompute(orderId) {
  const tasks = db.all('SELECT status, available_at FROM delivery_tasks WHERE order_id = ?', orderId);
  const st = aggregate(tasks);
  db.run('UPDATE orders SET delivery_status = ? WHERE id = ?', st, orderId);
  return st;
}

function newPublicId() {
  for (let i = 0; i < 5; i++) {
    const id = 'MK-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    if (!db.get('SELECT 1 FROM orders WHERE public_id = ?', id)) return id;
  }
  throw new HttpError(500, 'id_collision', 'Could not allocate an order id.');
}

/* ---------- purchases ---------- */
function purchase(customerId, productId, qty, idemKey) {
  qty = parseInt(qty, 10);
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new HttpError(400, 'invalid_quantity', `Quantity must be 1-${MAX_QTY}.`);
  if (typeof idemKey !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(idemKey)) throw new HttpError(400, 'idempotency_required', 'Missing idempotency key.');
  productId = parseInt(productId, 10);
  if (!Number.isInteger(productId)) throw new HttpError(404, 'product_unavailable', 'This product is not available.');

  return db.tx(() => {
    const dupe = db.get('SELECT * FROM orders WHERE customer_id = ? AND idem_key = ?', customerId, idemKey);
    if (dupe) return { order: dupe, duplicate: true };
    const c = db.get('SELECT * FROM customers WHERE id = ?', customerId);
    if (!c) throw new HttpError(401, 'unauthorized', 'Please log in.');
    if (!c.mc_username) throw new HttpError(403, 'minecraft_required', 'Verify your Minecraft account before buying.');
    const srv = db.get('SELECT status FROM server WHERE id = 1');
    if (!srv || srv.status !== 'ACTIVE') throw new HttpError(503, 'server_not_connected', 'The Minecraft server is not connected, so purchases are paused.');
    const p = db.get('SELECT p.* FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ? AND p.active = 1 AND p.deleted_at IS NULL AND (c.id IS NULL OR (c.active = 1 AND c.deleted_at IS NULL))', productId);
    if (!p) throw new HttpError(404, 'product_unavailable', 'This product is not available.');
    const rewards = db.all('SELECT label, command FROM product_rewards WHERE product_id = ? ORDER BY sort, id', p.id);
    if (!rewards.length) throw new HttpError(409, 'product_unavailable', 'This product has no delivery set up yet.');
    const total = p.price_paise * qty;
    const now = Date.now();
    const publicId = newPublicId();
    const snapshot = JSON.stringify({ product: { id: p.id, name: p.name, price_paise: p.price_paise, is_bundle: p.is_bundle }, rewards });
    const o = db.run(`INSERT INTO orders(public_id,kind,customer_id,discord_username,mc_username,product_id,product_name,is_bundle,snapshot,quantity,amount_paise,payment_status,delivery_status,idem_key,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'PAID','PENDING',?,?)`,
    publicId, 'PURCHASE', c.id, c.discord_username, c.mc_username, p.id, p.name, p.is_bundle, snapshot, qty, total, idemKey, now);
    const orderId = o.lastInsertRowid;
    db.run('INSERT INTO order_items(order_id,product_id,name,unit_price_paise,quantity) VALUES (?,?,?,?,?)', orderId, p.id, p.name, p.price_paise, qty);
    W.addLedger({ customerId: c.id, type: 'PURCHASE', amount: -total, refType: 'order', refId: publicId, note: `${p.name} x${qty}` });
    for (let i = 0; i < qty; i++) for (const r of rewards) addTask(orderId, r.label, resolveCommand(r.command, c.mc_username), now);
    recompute(orderId);
    return { order: db.get('SELECT * FROM orders WHERE id = ?', orderId), duplicate: false };
  });
}

function addTask(orderId, label, command, availableAt) {
  const now = Date.now();
  db.run('INSERT INTO delivery_tasks(order_id,label,command,status,available_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', orderId, label, command, 'QUEUED', availableAt, now, now);
}

/* ---------- admin custom orders / giveaways ---------- */
function createAdminOrder({ kind, mcUsername, name, rewards, deliverAt, note }, adminEmail, req) {
  if (!['GIVEAWAY', 'MANUAL', 'CUSTOM'].includes(kind)) throw new HttpError(400, 'invalid_kind', 'Invalid order type.');
  if (!S.isMcName(mcUsername)) throw new HttpError(400, 'invalid_username', 'Minecraft username must be 3-16 letters, numbers or underscores.');
  if (!Array.isArray(rewards) || !rewards.length || rewards.length > 20) throw new HttpError(400, 'invalid_rewards', 'Add 1-20 delivery commands.');
  const items = rewards.map((r, i) => ({ label: S.cleanStr(r.label, 80) || `Reward ${i + 1}`, command: cleanCommand(r.command) }));
  const title = S.cleanStr(name, 80) || ({ GIVEAWAY: 'Giveaway', MANUAL: 'Manual order', CUSTOM: 'Custom reward' })[kind];
  let at = Date.now();
  if (deliverAt) { at = Number(deliverAt); if (!Number.isFinite(at) || at > Date.now() + 365 * 864e5) throw new HttpError(400, 'invalid_time', 'Invalid delivery time.'); at = Math.max(at, 0); }
  return db.tx(() => {
    const known = db.get('SELECT id, discord_username FROM customers WHERE mc_username_lc = ?', mcUsername.toLowerCase());
    const publicId = newPublicId();
    const o = db.run(`INSERT INTO orders(public_id,kind,customer_id,discord_username,mc_username,product_id,product_name,is_bundle,snapshot,quantity,amount_paise,payment_status,delivery_status,note,created_by,created_at)
      VALUES (?,?,?,?,?,NULL,?,?,?,1,0,'NOT_APPLICABLE','PENDING',?,?,?)`,
    publicId, kind, known ? known.id : null, known ? known.discord_username : null, mcUsername, title, items.length > 1 ? 1 : 0, JSON.stringify({ rewards: items }), S.cleanStr(note, 300) || null, adminEmail, Date.now());
    for (const r of items) addTask(o.lastInsertRowid, r.label, resolveCommand(r.command, mcUsername), at);
    recompute(o.lastInsertRowid);
    S.audit(adminEmail, 'order.custom', { publicId, kind, mcUsername }, req);
    return db.get('SELECT * FROM orders WHERE id = ?', o.lastInsertRowid);
  });
}

/* ---------- plugin: fetch / confirm ---------- */
function issueTokens(task, serverUid, now) {
  const have = db.all('SELECT * FROM delivery_tokens WHERE task_id = ? AND revoked = 0', task.id);
  const out = {};
  for (const kind of ['CONFIRM', 'SUCCESS']) {
    let t = have.find((x) => x.kind === kind && x.server_uid === serverUid);
    if (!t) {
      t = { token: S.randomToken(32), kind };
      db.run('INSERT INTO delivery_tokens(token,task_id,server_uid,kind,expires_at) VALUES (?,?,?,?,?)', t.token, task.id, serverUid, kind, now + TOKEN_TTL);
    } else if (!t.used_at) db.run('UPDATE delivery_tokens SET expires_at = ? WHERE token = ?', now + TOKEN_TTL, t.token);
    out[kind] = t.token;
  }
  return out;
}

function fetchOperations(server, limit = 50) {
  const now = Date.now();
  return db.tx(() => {
    const tasks = db.all("SELECT * FROM delivery_tasks WHERE status IN ('QUEUED','FETCHED') AND available_at <= ? ORDER BY id LIMIT ?", now, limit);
    const ops = tasks.map((t) => {
      const tok = issueTokens(t, server.server_uid, now);
      db.run("UPDATE delivery_tasks SET status = 'FETCHED', fetched_at = COALESCE(fetched_at, ?), fetch_count = fetch_count + 1, updated_at = ? WHERE id = ?", now, now, t.id);
      const order = db.get('SELECT public_id, mc_username FROM orders WHERE id = ?', t.order_id);
      return { operationId: t.id, type: 'COMMAND', orderId: order.public_id, player: order.mc_username, label: t.label, command: t.command, confirmToken: tok.CONFIRM, successToken: tok.SUCCESS, expiresAt: now + TOKEN_TTL };
    });
    [...new Set(tasks.map((t) => t.order_id))].forEach(recompute);
    return ops;
  });
}

function confirm(server, token, { failed = false, reason = '' } = {}) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) throw new HttpError(404, 'invalid_token', 'Unknown token.');
  const now = Date.now();
  return db.tx(() => {
    const t = db.get('SELECT * FROM delivery_tokens WHERE token = ?', token);
    if (!t || t.revoked || t.server_uid !== server.server_uid) throw new HttpError(404, 'invalid_token', 'Unknown token.');
    const task = db.get('SELECT * FROM delivery_tasks WHERE id = ?', t.task_id);
    const done = (status, idempotent) => ({ ok: true, operationId: task.id, status, idempotent });

    if (t.kind === 'CONFIRM') {
      if (['RECEIVED', 'DELIVERED'].includes(task.status)) return done(task.status, true);
      if (task.status !== 'FETCHED') throw new HttpError(409, 'invalid_state', `Operation is ${task.status}.`);
      if (t.expires_at < now) throw new HttpError(410, 'token_expired', 'Token expired; fetch the operation again.');
      db.run("UPDATE delivery_tasks SET status='RECEIVED', received_at=?, updated_at=? WHERE id=?", now, now, task.id);
      db.run('UPDATE delivery_tokens SET used_at = ? WHERE token = ?', now, t.token);
      db.run("UPDATE delivery_tokens SET expires_at = ? WHERE task_id = ? AND kind='SUCCESS' AND revoked=0 AND used_at IS NULL", now + SUCCESS_TTL, task.id);
      recompute(task.order_id);
      return done('RECEIVED', false);
    }
    // SUCCESS token
    if (task.status === 'DELIVERED') return done('DELIVERED', true);
    if (task.status === 'FAILED' && failed) return done('FAILED', true);
    if (task.status === 'FETCHED') throw new HttpError(409, 'received_required', 'Confirm receipt before reporting success.');
    if (task.status !== 'RECEIVED') throw new HttpError(409, 'invalid_state', `Operation is ${task.status}.`);
    if (t.expires_at < now) throw new HttpError(410, 'token_expired', 'Token expired.');
    if (failed) db.run("UPDATE delivery_tasks SET status='FAILED', fail_reason=?, updated_at=? WHERE id=?", S.cleanStr(reason, 200) || 'Plugin reported failure', now, task.id);
    else db.run("UPDATE delivery_tasks SET status='DELIVERED', delivered_at=?, updated_at=? WHERE id=?", now, now, task.id);
    db.run('UPDATE delivery_tokens SET used_at = ? WHERE token = ?', now, t.token);
    recompute(task.order_id);
    return done(failed ? 'FAILED' : 'DELIVERED', false);
  });
}

/* ---------- admin task controls ---------- */
function cancelTask(taskId, adminEmail, req) {
  return db.tx(() => {
    const t = db.get('SELECT * FROM delivery_tasks WHERE id = ?', taskId);
    if (!t) throw new HttpError(404, 'not_found', 'Task not found.');
    if (!['QUEUED', 'FETCHED'].includes(t.status)) throw new HttpError(409, 'invalid_state', 'Only tasks the plugin has not confirmed yet can be cancelled.');
    db.run("UPDATE delivery_tasks SET status='CANCELLED', updated_at=? WHERE id=?", Date.now(), taskId);
    db.run('UPDATE delivery_tokens SET revoked = 1 WHERE task_id = ?', taskId);
    recompute(t.order_id); S.audit(adminEmail, 'task.cancel', { taskId }, req);
  });
}
function requeueTask(taskId, adminEmail, req) {
  return db.tx(() => {
    const t = db.get('SELECT * FROM delivery_tasks WHERE id = ?', taskId);
    if (!t) throw new HttpError(404, 'not_found', 'Task not found.');
    if (!['FAILED', 'FETCHED', 'RECEIVED'].includes(t.status)) throw new HttpError(409, 'invalid_state', 'Only failed or unconfirmed tasks can be re-queued.');
    db.run('UPDATE delivery_tokens SET revoked = 1 WHERE task_id = ?', taskId);
    db.run("UPDATE delivery_tasks SET status='QUEUED', fail_reason=NULL, available_at=?, updated_at=? WHERE id=?", Date.now(), Date.now(), taskId);
    recompute(t.order_id); S.audit(adminEmail, 'task.requeue', { taskId, was: t.status }, req);
  });
}
function cancelOrder(publicId, adminEmail, req) {
  return db.tx(() => {
    const o = db.get('SELECT * FROM orders WHERE public_id = ?', publicId);
    if (!o) throw new HttpError(404, 'not_found', 'Order not found.');
    const ts = db.all("SELECT id FROM delivery_tasks WHERE order_id = ? AND status IN ('QUEUED','FETCHED')", o.id);
    ts.forEach((t) => { db.run("UPDATE delivery_tasks SET status='CANCELLED', updated_at=? WHERE id=?", Date.now(), t.id); db.run('UPDATE delivery_tokens SET revoked=1 WHERE task_id=?', t.id); });
    recompute(o.id); S.audit(adminEmail, 'order.cancel', { publicId, cancelled: ts.length }, req);
    return ts.length;
  });
}

/* ---------- views ---------- */
function progress(orderId) {
  const ts = db.all('SELECT status FROM delivery_tasks WHERE order_id = ?', orderId).filter((t) => t.status !== 'CANCELLED');
  return { delivered: ts.filter((t) => t.status === 'DELIVERED').length, total: ts.length };
}
function orderView(o, { admin = false, tasks = false } = {}) {
  const v = {
    id: o.public_id, kind: o.kind, product: o.product_name, isBundle: !!o.is_bundle, quantity: o.quantity, amountPaise: o.amount_paise, paymentStatus: o.payment_status,
    deliveryStatus: o.delivery_status, createdAt: o.created_at, minecraft: o.mc_username, progress: progress(o.id),
  };
  if (admin) { v.discord = o.discord_username; v.note = o.note; v.createdBy = o.created_by; v.customerId = o.customer_id; }
  if (tasks) {
    const now = Date.now();
    v.tasks = db.all('SELECT * FROM delivery_tasks WHERE order_id = ? ORDER BY id', o.id).map((t) => ({
      id: t.id, label: t.label, status: taskLabelStatus(t, now), rawStatus: t.status, fetchedAt: t.fetched_at, receivedAt: t.received_at, deliveredAt: t.delivered_at,
      failReason: t.fail_reason, availableAt: t.available_at, ...(admin ? { command: t.command, fetchCount: t.fetch_count } : {}),
    }));
  }
  return v;
}

function listAdminOrders({ q, status, kind, sort, dir, limit = 50, offset = 0 }) {
  const w = []; const p = [];
  if (q) { w.push('(o.public_id LIKE ? OR o.mc_username LIKE ? OR o.discord_username LIKE ? OR o.product_name LIKE ?)'); const l = `%${String(q).slice(0, 50).replace(/[%_]/g, '')}%`; p.push(l, l, l, l); }
  if (status && /^[A-Z]+$/.test(status)) { w.push('o.delivery_status = ?'); p.push(status); }
  if (kind && /^[A-Z]+$/.test(kind)) { w.push('o.kind = ?'); p.push(kind); }
  const col = { amount: 'o.amount_paise', product: 'o.product_name', status: 'o.delivery_status', created: 'o.created_at' }[sort] || 'o.created_at';
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const total = db.get(`SELECT COUNT(*) AS n FROM orders o ${where}`, ...p).n;
  const rows = db.all(`SELECT o.* FROM orders o ${where} ORDER BY ${col} ${dir === 'asc' ? 'ASC' : 'DESC'}, o.id DESC LIMIT ? OFFSET ?`, ...p, Math.min(limit, 200), Math.max(0, offset));
  return { total, orders: rows.map((o) => orderView(o, { admin: true })) };
}

module.exports = { purchase, createAdminOrder, fetchOperations, confirm, cancelTask, requeueTask, cancelOrder, orderView, listAdminOrders, cleanCommand, aggregate, recompute, MAX_QTY };
