'use strict';
// Wallet ledger + deposits. Integer paise only. Every balance change has a ledger row.
const db = require('./db');
const S = require('./secure');
const MP = require('./mainpanel');
const D = require('./discord');
const { HttpError } = S;

function applyBalance(customerId, delta) {
  if (delta < 0) {
    const r = db.run('UPDATE customers SET balance_paise = balance_paise + ? WHERE id = ? AND balance_paise + ? >= 0', delta, customerId, delta);
    if (r.changes !== 1) throw new HttpError(402, 'insufficient_balance', 'Insufficient wallet balance.');
  } else {
    const r = db.run('UPDATE customers SET balance_paise = balance_paise + ? WHERE id = ?', delta, customerId);
    if (r.changes !== 1) throw new HttpError(404, 'not_found', 'Customer not found.');
  }
  return db.get('SELECT balance_paise AS b FROM customers WHERE id = ?', customerId).b;
}

/** MUST run inside db.tx. Unique (type, ref_type, ref_id) makes a repeated reference impossible. */
function addLedger({ customerId, type, amount, refType = null, refId = null, note = null }) {
  const bal = applyBalance(customerId, amount);
  db.run('INSERT INTO wallet_transactions(customer_id,type,amount_paise,balance_after_paise,ref_type,ref_id,note,created_at) VALUES (?,?,?,?,?,?,?,?)',
    customerId, type, amount, bal, refType, refId, note, Date.now());
  return bal;
}

function adjust(customerId, amountPaise, note, adminEmail, req) {
  if (!Number.isInteger(amountPaise) || amountPaise === 0 || Math.abs(amountPaise) > 1e9) throw new HttpError(400, 'invalid_amount', 'Invalid adjustment amount.');
  const bal = db.tx(() => addLedger({ customerId, type: 'ADJUSTMENT', amount: amountPaise, refType: 'adjust', refId: S.randomToken(9), note: S.cleanStr(note, 200) || 'Manual adjustment' }));
  S.audit(adminEmail, 'wallet.adjust', { customerId, amountPaise }, req);
  return bal;
}

/* ---------------- deposits ---------------- */
const DEPOSIT_WINDOW_MS = 10 * 60 * 1000; // fallback if the Main Panel omits expiresAt
const inflight = new Set();

function view(d) {
  const now = Date.now();
  const expired = d.status === 'EXPIRED' || (d.status === 'PENDING' && d.started_at && d.expires_at && d.expires_at < now);
  const live = d.status === 'PENDING' && d.started_at && !expired;
  return {
    id: d.public_id, amountPaise: d.amount_paise, payAmountPaise: d.pay_amount_paise || d.amount_paise, status: d.status, credited: !!d.credited,
    expired: !!expired, canStart: d.status === 'PENDING' && !d.started_at, expiresAt: d.expires_at, startedAt: d.started_at, createdAt: d.created_at,
    upiId: live ? d.upi_id : null, paymentLink: live ? d.payment_link : null, qrData: live ? d.qr_data : null, error: d.status === 'FAILED' ? d.last_error : null,
  };
}

const own = (customerId, publicId) => {
  const d = db.get('SELECT * FROM deposits WHERE public_id = ? AND customer_id = ?', String(publicId).slice(0, 40), customerId);
  if (!d) throw new HttpError(404, 'not_found', 'Deposit not found.');
  return d;
};

function mpError(e) {
  if (!(e instanceof MP.MainPanelError)) return e;
  const map = { 409: 409, 503: 503, 429: 429, 403: 503, 401: 502 };
  const msg = e.status === 403 ? 'This store is temporarily unavailable for payments.' : e.status === 401 ? 'Payments are temporarily unavailable. Please contact the store owner.' : e.message;
  return new HttpError(map[e.status] || 502, e.code, msg, e.retryAfter ? { retryAfter: e.retryAfter } : undefined);
}

async function createDeposit(customer, amountPaise) {
  if (MP.panelBlocked()) throw new HttpError(503, 'panel_suspended', 'This store is temporarily unavailable for payments.');
  const min = S.getInt('min_deposit_paise', 1000); const max = S.getInt('max_deposit_paise', 5000000);
  if (amountPaise < min || amountPaise > max) throw new HttpError(400, 'invalid_amount', `Deposit must be between ₹${min / 100} and ₹${max / 100}.`);
  const open = db.get("SELECT COUNT(*) AS n FROM deposits WHERE customer_id = ? AND status IN ('CREATED','PENDING') AND created_at > ?", customer.id, Date.now() - 24 * 36e5).n;
  if (open >= 3) throw new HttpError(429, 'too_many_open_deposits', 'You already have 3 unfinished deposits. Open one from Transaction History or wait for it to expire.');
  const publicId = 'DEP-' + S.randomToken(6).toUpperCase().replace(/[-_]/g, 'X');
  const r = db.run("INSERT INTO deposits(public_id,customer_id,amount_paise,status,created_at) VALUES (?,?,?,'CREATED',?)", publicId, customer.id, amountPaise, Date.now());
  const id = r.lastInsertRowid;
  try {
    const p = await MP.createPayment({ amountPaise, reference: publicId });
    if (!p.transactionId) throw new MP.MainPanelError(502, 'main_invalid', 'Main Panel did not return a transaction id.');
    const pay = p.amountPaise || amountPaise;
    if (pay < amountPaise || pay > amountPaise + 99) throw new MP.MainPanelError(502, 'amount_mismatch', 'Main Panel returned an unexpected payable amount.');
    db.run("UPDATE deposits SET main_transaction_id=?, pay_amount_paise=?, upi_id=?, payment_link=?, qr_data=?, expires_at=?, status='PENDING' WHERE id=?",
      String(p.transactionId), pay, p.upiId || null, p.paymentLink || null, p.qrData || null, p.expiresAt || null, id);
  } catch (e) {
    db.run("UPDATE deposits SET status='FAILED', last_error=? WHERE id=?", String(e.message).slice(0, 200), id);
    throw mpError(e);
  }
  return view(db.get('SELECT * FROM deposits WHERE id = ?', id));
}

/** Starts the 10-minute payment window exactly once; repeats return the stored payment info. */
async function startDeposit(customerId, publicId) {
  let d = own(customerId, publicId);
  if (d.status !== 'PENDING' || d.started_at) return view(d);
  if (MP.panelBlocked()) throw new HttpError(503, 'panel_suspended', 'This store is temporarily unavailable for payments.');
  if (inflight.has(d.id)) return view(db.get('SELECT * FROM deposits WHERE id = ?', d.id));
  inflight.add(d.id);
  try {
    const claim = db.run('UPDATE deposits SET started_at = ? WHERE id = ? AND started_at IS NULL AND status = ?', Date.now(), d.id, 'PENDING');
    if (claim.changes !== 1) return view(db.get('SELECT * FROM deposits WHERE id = ?', d.id));
    try {
      const p = await MP.startPayment(d.main_transaction_id);
      db.run('UPDATE deposits SET expires_at=?, upi_id=COALESCE(?,upi_id), payment_link=COALESCE(?,payment_link), qr_data=COALESCE(?,qr_data), pay_amount_paise=COALESCE(?,pay_amount_paise) WHERE id=?',
        p.expiresAt || Date.now() + DEPOSIT_WINDOW_MS, p.upiId || null, p.paymentLink || null, p.qrData || null, p.amountPaise && p.amountPaise >= d.amount_paise && p.amountPaise <= d.amount_paise + 99 ? p.amountPaise : null, d.id);
    } catch (e) {
      db.run('UPDATE deposits SET started_at = NULL WHERE id = ?', d.id); // allow retry
      throw mpError(e);
    }
  } finally { inflight.delete(d.id); }
  return view(db.get('SELECT * FROM deposits WHERE id = ?', d.id));
}

/** Credit exactly once. Safe against repeated checks and simultaneous requests. */
function creditDeposit(depositId) {
  const out = db.tx(() => {
    const claim = db.run("UPDATE deposits SET credited = 1, status = 'SUCCESS', credited_at = ? WHERE id = ? AND credited = 0", Date.now(), depositId);
    if (claim.changes !== 1) return { credited: false };
    const d = db.get('SELECT * FROM deposits WHERE id = ?', depositId);
    const bal = addLedger({ customerId: d.customer_id, type: 'DEPOSIT', amount: d.amount_paise, refType: 'deposit', refId: d.public_id, note: 'Wallet deposit ' + d.public_id });
    return { credited: true, deposit: d, balance: bal };
  });
  if (out.credited) {
    const c = db.get('SELECT * FROM customers WHERE id = ?', out.deposit.customer_id);
    D.logDeposit(out.deposit, c); // not awaited: logging problems must not touch the credit
  }
  return out;
}

async function checkDeposit(customerId, publicId) {
  let d = own(customerId, publicId);
  if (d.credited || d.status === 'SUCCESS') return view(d);
  if (!d.main_transaction_id) return view(d);
  if (inflight.has('c' + d.id)) return view(d);
  inflight.add('c' + d.id);
  try {
    let p;
    try { p = await MP.checkPayment(d.main_transaction_id); } catch (e) { throw mpError(e); }
    db.run('UPDATE deposits SET last_checked_at = ? WHERE id = ?', Date.now(), d.id);
    const myPanel = S.getSetting('main_panel_id');
    if (p.panelId && myPanel && p.panelId !== myPanel) {
      S.audit('system', 'deposit.wrong_panel', { deposit: d.public_id });
      throw new HttpError(502, 'payment_mismatch', 'This payment does not belong to this store.');
    }
    if (p.transactionId && String(p.transactionId) !== d.main_transaction_id) throw new HttpError(502, 'payment_mismatch', 'Payment reference mismatch.');
    if (p.status === 'SUCCESS') {
      if (p.amountPaise !== null && p.amountPaise !== (d.pay_amount_paise || d.amount_paise)) {
        db.run('UPDATE deposits SET last_error = ? WHERE id = ?', 'Amount mismatch reported by Main Panel', d.id);
        S.audit('system', 'deposit.amount_mismatch', { deposit: d.public_id, got: p.amountPaise, want: d.pay_amount_paise });
        throw new HttpError(409, 'amount_mismatch', 'The paid amount does not match this deposit. Please contact the store owner.');
      }
      creditDeposit(d.id);
    } else if (p.status === 'EXPIRED') db.run("UPDATE deposits SET status='EXPIRED' WHERE id = ? AND credited = 0 AND status IN ('PENDING','CREATED')", d.id);
    else if (p.status === 'FAILED') db.run("UPDATE deposits SET status='FAILED', last_error='Payment failed' WHERE id = ? AND credited = 0 AND status IN ('PENDING','CREATED')", d.id);
  } finally { inflight.delete('c' + d.id); }
  return view(db.get('SELECT * FROM deposits WHERE id = ?', d.id));
}

/** Background: settle deposits whose window ended, so late payments are still credited and dead ones are marked expired. */
async function sweepDeposits() {
  const rows = db.all("SELECT * FROM deposits WHERE status='PENDING' AND started_at IS NOT NULL AND expires_at < ? AND (last_checked_at IS NULL OR last_checked_at < expires_at + 60000) LIMIT 10", Date.now() - 60000);
  for (const d of rows) { try { await checkDeposit(d.customer_id, d.public_id); } catch (_) { /* retry next sweep */ } }
}

function listTransactions(customerId, limit = 100) {
  const deps = db.all('SELECT * FROM deposits WHERE customer_id = ? ORDER BY created_at DESC LIMIT ?', customerId, limit).map((d) => ({ kind: 'deposit', at: d.created_at, ...view(d) }));
  const led = db.all("SELECT * FROM wallet_transactions WHERE customer_id = ? AND type != 'DEPOSIT' ORDER BY created_at DESC LIMIT ?", customerId, limit)
    .map((t) => ({ kind: 'ledger', at: t.created_at, id: t.id, type: t.type, amountPaise: t.amount_paise, balanceAfterPaise: t.balance_after_paise, note: t.note }));
  return deps.concat(led).sort((a, b) => b.at - a.at).slice(0, limit);
}

module.exports = { addLedger, adjust, createDeposit, startDeposit, checkDeposit, creditDeposit, sweepDeposits, listTransactions, view, DEPOSIT_WINDOW_MS };
