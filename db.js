const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const dbPath = process.env.TYL_DB_PATH || path.join(__dirname, 'tyl.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

function openDatabase(filePath) {
  // Remove all stale lock/journal files a crashed session may have left behind.
  for (const ext of ['-wal', '-shm', '-journal']) {
    try { fs.unlinkSync(filePath + ext); } catch (_) {}
  }
  try {
    return new Database(filePath);
  } catch (e) {
    if (e.message && e.message.includes('locked')) {
      // Another process has the DB open — wipe lock files again and retry once.
      console.error('[db] Database locked, clearing lock files and retrying...');
      for (const ext of ['-wal', '-shm', '-journal']) {
        try { fs.unlinkSync(filePath + ext); } catch (_) {}
      }
      try { return new Database(filePath); } catch (_) {}
    }
    // Database corrupted or unrecoverable — wipe and start fresh.
    console.error('[db] Failed to open database, resetting:', e.message);
    try { fs.unlinkSync(filePath); } catch (_) {}
    return new Database(filePath);
  }
}

const db = openDatabase(dbPath);
// Give locked databases up to 10 seconds to clear before erroring
try { db.exec('PRAGMA busy_timeout = 10000'); } catch (_) {}
try { db.exec('PRAGMA foreign_keys = ON'); } catch (_) {}

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

// Shim: better-sqlite3 db.transaction(fn) → returns a function that runs fn inside BEGIN/COMMIT
db.transaction = function(fn) {
  return function(...args) {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw err;
    }
  };
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

// API source tracking — jobs from Make/Zapier/HTTP start as 'api_pending' for user approval
try {
  db.exec(`ALTER TABLE jobs ADD COLUMN source TEXT`);
} catch (_) {}

// API send default pace — null=hold for approval, 0=auto fast, 15=auto drip (Pro only)
try {
  db.exec(`ALTER TABLE users ADD COLUMN api_default_pace INTEGER`);
} catch (_) {}

// API key hashing — store SHA-256 hash for auth instead of plaintext lookup
try {
  db.exec(`ALTER TABLE api_keys ADD COLUMN key_hash TEXT`);
} catch (_) {}

// Migrate existing plaintext keys → SHA-256 hash
try {
  const crypto = require('crypto');
  const unmigratedKeys = db.prepare("SELECT id, key FROM api_keys WHERE key IS NOT NULL AND key != '' AND key_hash IS NULL").all();
  const update = db.prepare('UPDATE api_keys SET key_hash = ? WHERE id = ?');
  const migrate = db.transaction(() => { unmigratedKeys.forEach(k => update.run(crypto.createHash('sha256').update(k.key).digest('hex'), k.id)); });
  migrate();
} catch (_) {}

try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash)`);
} catch (_) {}

// Web auth timestamp — tracks last successful web authentication for 7-day offline grace
try {
  db.exec(`ALTER TABLE users ADD COLUMN last_web_auth_at TEXT`);
} catch (_) {}

// Stable remote user ID — allows upsert by web identity rather than email
try {
  db.exec(`ALTER TABLE users ADD COLUMN web_user_id INTEGER`);
} catch (_) {}

// Offline grace password hash — local bcrypt hash stored on successful web auth for offline validation
try {
  db.exec(`ALTER TABLE users ADD COLUMN offline_hash TEXT`);
} catch (_) {}

// Test send flag — test sends don't count against monthly send limit
try {
  db.exec(`ALTER TABLE jobs ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0`);
} catch (_) {}

// Image attachment — Mac only, Pro plan, one image per job
try {
  db.exec(`ALTER TABLE jobs ADD COLUMN image_path TEXT`);
} catch (_) {}

module.exports = db;
