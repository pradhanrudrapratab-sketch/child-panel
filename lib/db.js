'use strict';
// SQLite access. Uses better-sqlite3 (declared dependency); falls back to Node's built-in
// node:sqlite (Node 22.5+) so the panel still boots if the native module could not be built.
const { DB_FILE } = require('./paths');
const fs = require('fs');

function open(file) {
  try {
    const B = require('better-sqlite3');
    return { d: new B(file), name: 'better-sqlite3' };
  } catch (e) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      return { d: new DatabaseSync(file), name: 'node:sqlite' };
    } catch (e2) {
      throw new Error('No SQLite driver available. Run `npm install` (better-sqlite3). ' + e.message);
    }
  }
}

const { d: raw, name: driver } = open(DB_FILE);
try { fs.chmodSync(DB_FILE, 0o600); } catch (_) { /* ignore */ }
raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');

const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) { s = raw.prepare(sql); cache.set(sql, s); }
  return s;
}
const norm = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
const run = (sql, ...p) => stmt(sql).run(...norm(p));
const get = (sql, ...p) => stmt(sql).get(...norm(p));
const all = (sql, ...p) => stmt(sql).all(...norm(p));
const exec = (sql) => raw.exec(sql);

let depth = 0;
/** Run fn inside BEGIN IMMEDIATE ... COMMIT (re-entrant). Throws roll everything back. */
function tx(fn) {
  if (depth > 0) return fn();
  raw.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const r = fn();
    raw.exec('COMMIT');
    return r;
  } catch (e) {
    try { raw.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw e;
  } finally { depth--; }
}

const MIGRATIONS = [
`
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, is_secret INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE TABLE admin (
  id INTEGER PRIMARY KEY CHECK (id = 1), email TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  discord_id TEXT UNIQUE, discord_username TEXT, discord_name TEXT, discord_avatar TEXT,
  mc_username TEXT, mc_username_lc TEXT UNIQUE, mc_linked_at INTEGER,
  accent_color TEXT,
  balance_paise INTEGER NOT NULL DEFAULT 0 CHECK (balance_paise >= 0),
  created_at INTEGER NOT NULL, last_login INTEGER
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('customer','admin')), user_id INTEGER,
  csrf TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, ip TEXT, ua TEXT
);
CREATE INDEX idx_sessions_user ON sessions(kind, user_id);
CREATE TABLE oauth_states (state TEXT PRIMARY KEY, session_id TEXT NOT NULL, link INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL);
CREATE TABLE server (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  server_uid TEXT NOT NULL, name TEXT, api_key_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  paired_at INTEGER NOT NULL, revoked_at INTEGER, last_seen_at INTEGER, last_poll_at INTEGER, plugin_version TEXT
);
CREATE TABLE pairing_codes (code_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE categories (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', image_url TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, deleted_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE products (
  id INTEGER PRIMARY KEY, category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL, tagline TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  price_paise INTEGER NOT NULL CHECK (price_paise >= 0), image_url TEXT NOT NULL DEFAULT '',
  perks TEXT NOT NULL DEFAULT '[]', badge TEXT NOT NULL DEFAULT '', colour TEXT NOT NULL DEFAULT '',
  featured INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, is_bundle INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_products_cat ON products(category_id);
CREATE TABLE product_rewards (
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  label TEXT NOT NULL, command TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_rewards_product ON product_rewards(product_id);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY, public_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('PURCHASE','GIVEAWAY','MANUAL','CUSTOM')),
  customer_id INTEGER REFERENCES customers(id), discord_username TEXT, mc_username TEXT NOT NULL,
  product_id INTEGER, product_name TEXT NOT NULL, is_bundle INTEGER NOT NULL DEFAULT 0, snapshot TEXT NOT NULL DEFAULT '{}',
  quantity INTEGER NOT NULL DEFAULT 1, amount_paise INTEGER NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL CHECK (payment_status IN ('PAID','NOT_APPLICABLE')),
  delivery_status TEXT NOT NULL DEFAULT 'PENDING', idem_key TEXT, note TEXT, created_by TEXT, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_orders_idem ON orders(customer_id, idem_key) WHERE idem_key IS NOT NULL;
CREATE INDEX idx_orders_customer ON orders(customer_id, created_at);
CREATE TABLE order_items (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), product_id INTEGER, name TEXT NOT NULL,
  unit_price_paise INTEGER NOT NULL, quantity INTEGER NOT NULL
);
CREATE TABLE delivery_tasks (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), label TEXT NOT NULL, command TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','FETCHED','RECEIVED','DELIVERED','FAILED','CANCELLED')),
  available_at INTEGER NOT NULL, fetched_at INTEGER, received_at INTEGER, delivered_at INTEGER, fetch_count INTEGER NOT NULL DEFAULT 0,
  fail_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_tasks_status ON delivery_tasks(status, available_at);
CREATE INDEX idx_tasks_order ON delivery_tasks(order_id);
CREATE TABLE delivery_tokens (
  token TEXT PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES delivery_tasks(id), server_uid TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('CONFIRM','SUCCESS')), expires_at INTEGER NOT NULL, used_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_tokens_task ON delivery_tokens(task_id);
CREATE TABLE deposits (
  id INTEGER PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, customer_id INTEGER NOT NULL REFERENCES customers(id),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0), pay_amount_paise INTEGER,
  main_transaction_id TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED','PENDING','SUCCESS','EXPIRED','FAILED')),
  upi_id TEXT, payment_link TEXT, qr_data TEXT, expires_at INTEGER, started_at INTEGER,
  credited INTEGER NOT NULL DEFAULT 0, credited_at INTEGER, last_checked_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX idx_deposits_customer ON deposits(customer_id, created_at);
CREATE TABLE wallet_transactions (
  id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id),
  type TEXT NOT NULL CHECK (type IN ('DEPOSIT','PURCHASE','ADJUSTMENT')),
  amount_paise INTEGER NOT NULL, balance_after_paise INTEGER NOT NULL,
  ref_type TEXT, ref_id TEXT, note TEXT, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_wallet_ref ON wallet_transactions(type, ref_type, ref_id) WHERE ref_type IS NOT NULL;
CREATE INDEX idx_wallet_customer ON wallet_transactions(customer_id, created_at);
CREATE TABLE auth_challenges (
  id INTEGER PRIMARY KEY, token TEXT NOT NULL, username TEXT NOT NULL, username_lc TEXT NOT NULL,
  session_id TEXT NOT NULL, customer_id INTEGER REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETED','EXPIRED','FAILED')),
  expires_at INTEGER NOT NULL, completed_at INTEGER, result_customer_id INTEGER, claimed INTEGER NOT NULL DEFAULT 0,
  fail_reason TEXT, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_challenge_pending_token ON auth_challenges(token) WHERE status = 'PENDING';
CREATE INDEX idx_challenge_session ON auth_challenges(session_id);
CREATE TABLE audit_log (id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT, ip TEXT, created_at INTEGER NOT NULL);
CREATE INDEX idx_audit_time ON audit_log(created_at);
`,
];

function migrate() {
  exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const done = new Set(all('SELECT version FROM schema_migrations').map((r) => r.version));
  MIGRATIONS.forEach((sql, i) => {
    const v = i + 1;
    if (done.has(v)) return;
    tx(() => { exec(sql); run('INSERT INTO schema_migrations(version, applied_at) VALUES (?,?)', v, Date.now()); });
  });
}
migrate();

module.exports = { run, get, all, exec, tx, driver, raw };
