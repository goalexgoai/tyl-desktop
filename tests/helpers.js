/**
 * Shared test utilities — creates an isolated server + DB for each test suite.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

// Each test run gets its own temp DB so suites can run in parallel
function makeTempPaths() {
  const id = Date.now() + '_' + Math.random().toString(36).slice(2);
  const dir = path.join(os.tmpdir(), 'tyl-test-' + id);
  fs.mkdirSync(dir, { recursive: true });
  return { dbPath: path.join(dir, 'tyl.db'), dataDir: dir };
}

// Boot an isolated server instance and return { app, db, request }
// Caller must call teardown() in afterAll.
async function createTestServer() {
  const { dbPath, dataDir } = makeTempPaths();

  // Env vars must be set before requiring server.js (they're read at module load)
  process.env.TYL_DB_PATH = dbPath;
  process.env.TYL_DATA_DIR = dataDir;
  // Point web URL at an unreachable port — triggers offline-grace auth path in tests
  process.env.TYL_WEB_URL = 'http://127.0.0.1:19743';
  process.env.DESKTOP_LICENSE_SECRET = 'test-secret';
  process.env.SESSION_SECRET = 'test-session-secret';
  // Don't start the send loop
  delete process.env.TYL_DESKTOP;

  // Clear require cache so each suite gets a fresh server with its own DB
  Object.keys(require.cache).forEach(k => {
    if (k.includes('tyl-desktop') && !k.includes('node_modules')) {
      delete require.cache[k];
    }
  });

  const { app, db } = require('../server');
  const request = require('supertest');

  return { app, db, request, dbPath, dataDir };
}

// Insert a test user with offline_hash so login works without hitting the web server
async function createTestUser(db, opts = {}) {
  const email = opts.email || 'test@example.com';
  const password = opts.password || 'TestPass1!';
  const hash = await bcrypt.hash(password, 10);
  const plan = opts.plan || 'starter';

  db.prepare(`
    INSERT OR REPLACE INTO users
      (email, password_hash, plan, subscription_status, monthly_sends,
       is_admin, manual_account, offline_hash, last_web_auth_at, web_user_id)
    VALUES (?, '', ?, 'active', 0, ?, ?, ?, datetime('now'), 1)
  `).run(email, plan, opts.is_admin ? 1 : 0, opts.manual_account ? 1 : 0, hash);

  return { email, password };
}

// Login and return the cookie jar (session cookie)
async function loginAs(app, request, { email, password }) {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email, password })
    .set('Content-Type', 'application/json');
  if (res.status !== 200) throw new Error(`Login failed: ${JSON.stringify(res.body)}`);
  return res.headers['set-cookie'];
}

module.exports = { createTestServer, createTestUser, loginAs };
