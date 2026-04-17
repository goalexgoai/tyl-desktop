const { Database } = require('node-sqlite3-wasm');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const dbPath = process.env.TYL_DB_PATH || path.join(__dirname, 'tyl.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// Shim: node-sqlite3-wasm prepared statements need params as arrays.
// better-sqlite3 accepts spread params. Wrap prepare() to normalize both.
const _prepare = db.prepare.bind(db);
db.prepare = function(sql) {
  const stmt = _prepare(sql);
  const wrap = {
    get(...args) {
      const params = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
      return stmt.get(params);
    },
    all(...args) {
      const params = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
      return stmt.all(params);
    },
    run(...args) {
      const params = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
      return stmt.run(params);
    },
  };
  return wrap;
};

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    plan TEXT NOT NULL DEFAULT 'free',
    monthly_sends INTEGER NOT NULL DEFAULT 0,
    period_start TEXT NOT NULL DEFAULT (date('now')),
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_active_at TEXT
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    scope TEXT NOT NULL DEFAULT 'all',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    name TEXT NOT NULL,
    template TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    pace_seconds INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    sent INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    phone TEXT NOT NULL,
    first_name TEXT,
    last_name TEXT,
    link TEXT,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    picked_at TEXT,
    last_attempt_at TEXT,
    sent_at TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS suppression_list (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    phone TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, phone)
  );

  CREATE TABLE IF NOT EXISTS send_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    message_id TEXT NOT NULL,
    job_id TEXT,
    phone TEXT,
    status TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS contact_lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    csv_data TEXT NOT NULL,
    columns TEXT NOT NULL,
    row_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migrate existing api_keys that have no user_id — assign to first admin or leave null
// This handles existing installs gracefully
try {
  db.exec(`ALTER TABLE suppression_list ADD COLUMN user_id INTEGER REFERENCES users(id)`);
} catch (_) {} // already exists

try {
  db.exec(`ALTER TABLE send_logs ADD COLUMN user_id INTEGER REFERENCES users(id)`);
} catch (_) {}

try {
  db.exec(`ALTER TABLE jobs ADD COLUMN user_id INTEGER REFERENCES users(id)`);
} catch (_) {}

try {
  db.exec(`ALTER TABLE api_keys ADD COLUMN user_id INTEGER REFERENCES users(id)`);
} catch (_) {}

// Change 5 migrations — admin overhaul columns
try {
  db.exec(`ALTER TABLE users ADD COLUMN subscription_status TEXT NOT NULL DEFAULT 'free'`);
} catch (_) {}

try {
  db.exec(`ALTER TABLE users ADD COLUMN billing_period_end TEXT`);
} catch (_) {}

try {
  db.exec(`ALTER TABLE users ADD COLUMN manual_account INTEGER NOT NULL DEFAULT 0`);
} catch (_) {}

// Sync subscription_status for existing paid users who have a subscription id
try {
  db.exec(`
    UPDATE users SET subscription_status = 'active'
    WHERE plan != 'free' AND stripe_subscription_id IS NOT NULL AND subscription_status = 'free'
  `);
} catch (_) {}

// Change 6: billing_interval for plan breakdown stats
try {
  db.exec(`ALTER TABLE users ADD COLUMN billing_interval TEXT`);
} catch (_) {}

// Change 6 & 7: reset token columns
try {
  db.exec(`ALTER TABLE users ADD COLUMN reset_token TEXT`);
} catch (_) {}

try {
  db.exec(`ALTER TABLE users ADD COLUMN reset_token_expires TEXT`);
} catch (_) {}

// Plan expiry — allows admin to grant a plan with an automatic revert date
try {
  db.exec(`ALTER TABLE users ADD COLUMN plan_expires_at TEXT`);
} catch (_) {}

// Platform scoping — prevents Mac and Windows companions from racing on the same queue
try {
  db.exec(`ALTER TABLE api_keys ADD COLUMN platform TEXT`);
} catch (_) {}

module.exports = db;
