require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const fs = require('fs');
const os = require('os');
const db = require('./db');

// Nodemailer — graceful degradation if SMTP not configured
let transporter = null;
if (process.env.SMTP_USER && process.env.SMTP_USER.trim()) {
  try {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  } catch (_) {}
}

// Stripe — graceful degradation if key is placeholder
let stripe = null;
const stripeKey = process.env.STRIPE_SECRET_KEY || '';
if (stripeKey && !stripeKey.includes('placeholder')) {
  try { stripe = require('stripe')(stripeKey); } catch (_) {}
}

// Finding 2: fail fast if SESSION_SECRET is missing — no insecure fallback
if (!process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET is not set. Add a strong random value to .env and restart.');
  process.exit(1);
}

const app = express();
if (!process.env.TYL_DESKTOP) app.set('trust proxy', 1); // app is behind nginx on web — not needed for desktop local server
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ─── Plan config ─────────────────────────────────────────────────────────────

// Updated plan definitions (Build 5)
// Free: 50 sends/mo, 1 API key, bulk send up to 10 contacts, companion included
// Starter ($10/mo or $96/yr): 2,000 sends, 1 API key, CSV/bulk unlimited, templates, companion
// Pro ($30/mo or $288/yr): 6,000 sends, unlimited API keys, all features, API webhook sends
const PLANS = {
  free:    { label: 'Free',    monthly_limit: 50,   bulk_max_contacts: 10,   api_keys: 1,        companion: true, csv: true,  templates: false, api_send: false, price: 0  },
  starter: { label: 'Starter', monthly_limit: 2000, bulk_max_contacts: 100,  api_keys: 1,        companion: true, csv: true,  templates: true,  api_send: false, price: 10 },
  pro:     { label: 'Pro',     monthly_limit: 6000, bulk_max_contacts: 1000, api_keys: Infinity, companion: true, csv: true,  templates: true,  api_send: true,  price: 30 },
};

// ─── Session ──────────────────────────────────────────────────────────────────

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

if (process.env.TYL_DESKTOP) {
  // Clear stale sessions on restart — prevents old session from mapping to wrong user
  const sessionsDir = path.join(dataDir, 'sessions');
  if (fs.existsSync(sessionsDir)) {
    for (const f of fs.readdirSync(sessionsDir)) {
      try { fs.unlinkSync(path.join(sessionsDir, f)); } catch (_) {}
    }
  }
}

app.use(session({
  store: new FileStore({ path: path.join(dataDir, 'sessions'), ttl: 30 * 24 * 60 * 60 }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' && !process.env.TYL_DESKTOP },
}));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://www.googletagmanager.com', 'https://www.google-analytics.com', 'https://unpkg.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https://www.google-analytics.com', 'https://www.googletagmanager.com'],
      connectSrc: ["'self'", 'https://www.google-analytics.com', 'https://analytics.google.com', 'https://region1.google-analytics.com'],
      styleSrc: ["'self'", 'https:', "'unsafe-inline'"],
      fontSrc: ["'self'", 'https:', 'data:'],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
    },
  },
}));

// Finding 9: CORS policy — same-origin only.
// helmet sets Cross-Origin-Resource-Policy: same-origin and sameSite:lax on cookies handles CSRF.
// No explicit rejection needed; browsers enforce same-origin on their own for cookie-authenticated requests.

// ─── Body parsing ─────────────────────────────────────────────────────────────

// Stripe webhook needs raw body — mount before json middleware
if (!process.env.TYL_DESKTOP) {
  app.post('/billing/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);
}

app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/internal/license-status', (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || '';
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    return res.status(403).end();
  }
  const user = db.prepare('SELECT plan, subscription_status, manual_account FROM users ORDER BY id ASC LIMIT 1').get();
  if (!user) return res.json({ licensed: false, reason: 'no_account' });
  const licensed = user.manual_account || user.plan !== 'free' || user.subscription_status === 'active';
  res.json({ licensed, plan: user.plan, status: user.subscription_status });
});

app.get('/internal/open-billing', (req, res) => {
  const localAddr = req.socket.localAddress || '';
  if (!localAddr.includes('127.0.0.1') && localAddr !== '::1' && localAddr !== '::ffff:127.0.0.1') {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json({ url: `${process.env.APP_URL}/billing/checkout?plan=starter` });
});

// ─── Middleware ───────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Login required' });
  let user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) { req.session.destroy(); return res.status(401).json({ error: 'Login required' }); }
  // Auto-revert expired admin-granted plans
  if (user.plan_expires_at && new Date(user.plan_expires_at) < new Date()) {
    db.prepare("UPDATE users SET plan='free', plan_expires_at=NULL, subscription_status='free' WHERE id=?").run(user.id);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  }
  req.user = user;
  db.prepare("UPDATE users SET last_active_at = datetime('now') WHERE id = ?").run(user.id);
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Login required' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user || !user.is_admin) return res.status(403).json({ error: 'Admin required' });
  req.user = user;
  next();
}

function requireApiKey(req, res, next) {
  const auth = req.headers.authorization || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!key) return res.status(401).json({ error: 'API key required' });
  // Auth by SHA-256 hash — plaintext key is never compared directly
  const keyHash = crypto.createHash('sha256').update(key).digest('hex');
  const row = db.prepare('SELECT ak.*, u.plan, u.monthly_sends, u.period_start FROM api_keys ak JOIN users u ON u.id = ak.user_id WHERE ak.key_hash = ? AND ak.active = 1').get(keyHash);
  if (!row) return res.status(401).json({ error: 'Invalid API key' });
  db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
  req.apiKey = row;
  req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  next();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function syncLicenseFromWeb(userId, email) {
  const licenseUrl = process.env.TYL_LICENSE_URL;
  const licenseSecret = process.env.DESKTOP_LICENSE_SECRET;
  if (!licenseUrl || !licenseSecret || !email) return;

  try {
    const https = require('https');
    const http = require('http');
    const url = new URL(`${licenseUrl}?email=${encodeURIComponent(email)}`);
    const client = url.protocol === 'http:' ? http : https;
    const data = await new Promise((resolve, reject) => {
      const opts = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        headers: { 'x-desktop-secret': licenseSecret },
      };
      client.get(opts, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch (_) { resolve(null); } });
      }).on('error', reject);
    });

    if (!data || !data.found) return;

    db.prepare(
      'UPDATE users SET plan = ?, subscription_status = ?, billing_period_end = ?, manual_account = ? WHERE id = ?'
    ).run(data.plan, data.subscription_status, data.billing_period_end || null, data.manual_account ? 1 : 0, userId);

    console.log(`[license-sync] updated user ${userId} to plan=${data.plan} status=${data.subscription_status}`);
  } catch (err) {
    console.error('[license-sync] failed:', err.message);
  }
}

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  if (digits.length > 7) return '+' + digits;
  return null;
}

function renderTemplate(template, row) {
  // Support both {{field}} and {field} syntax
  return template
    .replace(/\{\{?first_name\}?\}/gi, row.first_name || '')
    .replace(/\{\{?last_name\}?\}/gi, row.last_name || '')
    .replace(/\{\{?full_name\}?\}/gi, [row.first_name, row.last_name].filter(Boolean).join(' '))
    .replace(/\{\{?phone\}?\}/gi, row.phone || '')
    .replace(/\{\{?link\}?\}/gi, row.link || '')
    .replace(/\{\{?special\}?\}/gi, row.special || '');
}

function renderDynamicTemplate(template, row, columnMap) {
  // Render any {ColumnName} placeholder from the CSV row
  let result = renderTemplate(template, {
    first_name: columnMap.first_name ? (row[columnMap.first_name] || '') : '',
    last_name: columnMap.last_name ? (row[columnMap.last_name] || '') : '',
    phone: normalizePhone(row[columnMap.phone]) || row[columnMap.phone] || '',
    link: columnMap.link ? (row[columnMap.link] || '') : '',
    special: columnMap.special ? (row[columnMap.special] || '') : '',
  });
  // Replace {token} via columnMap (token → actual column name), then direct column name fallback
  result = result.replace(/\{(\w+)\}/g, (match, token) => {
    if (columnMap[token] && row[columnMap[token]] !== undefined) return row[columnMap[token]];
    if (row[token] !== undefined) return row[token];
    return match;
  });
  return result;
}

function validateMaxLength(value, max, fieldName) {
  if (value && String(value).length > max) {
    return `${fieldName} must be ${max} characters or fewer`;
  }
  return null;
}

function validateCsvUpload(file) {
  const allowed = ['text/csv', 'application/vnd.ms-excel', 'text/plain'];
  if (!file) return 'No file uploaded';
  if (!allowed.includes(file.mimetype)) return 'File must be a CSV upload';
  return null;
}

function validateCsvRows(rows) {
  if (rows.length === 0) return 'CSV has no data rows';
  if (rows.length > 10000) return 'CSV cannot have more than 10,000 rows';
  return null;
}

function resetPeriodIfNeeded(user) {
  const periodStart = new Date(user.period_start);
  const now = new Date();
  // Reset if more than 30 days since period start
  const daysDiff = (now - periodStart) / (1000 * 60 * 60 * 24);
  if (daysDiff >= 30) {
    db.prepare("UPDATE users SET monthly_sends = 0, period_start = date('now') WHERE id = ?").run(user.id);
    return { ...user, monthly_sends: 0, period_start: now.toISOString().slice(0, 10) };
  }
  return user;
}

function checkSendLimit(user, count = 1) {
  // Admin users bypass all limits
  if (user.is_admin) return { allowed: true, remaining: Infinity, limit: Infinity, plan: user.plan };
  // Manual accounts bypass limits
  if (user.manual_account) return { allowed: true, remaining: Infinity, limit: Infinity, plan: user.plan };
  // Block cancelled/past_due subscriptions (but not free or manual)
  if (user.subscription_status === 'cancelled' || user.subscription_status === 'past_due') {
    return { allowed: false, remaining: 0, limit: 0, plan: user.plan, blocked: true,
      blockReason: 'Your subscription has expired. Upgrade to continue sending.' };
  }
  const fresh = resetPeriodIfNeeded(user);
  const plan = PLANS[fresh.plan] || PLANS.free;
  const remaining = plan.monthly_limit - fresh.monthly_sends;
  if (remaining < count) {
    return { allowed: false, remaining, limit: plan.monthly_limit, plan: fresh.plan };
  }
  return { allowed: true, remaining, limit: plan.monthly_limit, plan: fresh.plan };
}

function incrementSendCount(userId, count = 1) {
  db.prepare('UPDATE users SET monthly_sends = monthly_sends + ? WHERE id = ?').run(count, userId);
}

function log(userId, messageId, jobId, phone, status, error = null) {
  db.prepare('INSERT INTO send_logs (user_id, message_id, job_id, phone, status, error) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId || null, messageId, jobId, phone, status, error);
}

function recountJob(jobId) {
  const counts = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN status IN ('failed','dead') THEN 1 ELSE 0 END) as failed
    FROM messages WHERE job_id = ?
  `).get(jobId);
  db.prepare("UPDATE jobs SET total=?, sent=?, failed=?, updated_at=datetime('now') WHERE id=?")
    .run(counts.total, counts.sent, counts.failed, jobId);
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (job && job.status === 'queued') {
    const pending = db.prepare("SELECT COUNT(*) as c FROM messages WHERE job_id = ? AND status IN ('pending','sending')").get(jobId);
    if (pending.c === 0) {
      db.prepare("UPDATE jobs SET status='completed', updated_at=datetime('now') WHERE id=?").run(jobId);
    }
  }
}

// ─── Static files (public dir, no auth) ──────────────────────────────────────

// Landing page at /
app.get('/', (req, res) => {
  if (process.env.TYL_DESKTOP) return res.redirect('/app');
  if (req.session.userId) return res.redirect('/app');
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// App shell — requires auth
app.get('/app', (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/app');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

if (!process.env.TYL_DESKTOP) {
  app.get('/signup', (req, res) => {
    if (req.session.userId) return res.redirect('/app');
    res.sendFile(path.join(__dirname, 'public', 'signup.html'));
  });
}

app.get('/admin', (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user || !user.is_admin) return res.status(403).send('Forbidden');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/forgot-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'forgot-password.html'));
});

app.get('/reset-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reset-password.html'));
});

// Change 9: Privacy/help/SEO pages are web-only, not used in desktop mode
if (!process.env.TYL_DESKTOP) {
  app.get('/privacy', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
  });

  app.get('/terms', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'terms.html'));
  });

  app.get('/help/companion', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'help-companion.html'));
  });

  app.get('/help/windows', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'help-windows.html'));
  });

  app.get('/help/mac', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'help-mac.html'));
  });

  // SEO landing pages
  app.get('/send-texts-individually', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'seo-send-texts-individually.html'));
  });

  app.get('/church-texting-app', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'seo-church-texting-app.html'));
  });

  app.get('/text-from-computer', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'seo-text-from-computer.html'));
  });

  app.get('/csv-text-message-sender', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'seo-csv-text-message-sender.html'));
  });
}

app.get('/texting-for-coaches', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'seo-coaches-texting.html'));
});

// Serve other static files
app.use(express.static(path.join(__dirname, 'public')));

// ─── Auth endpoints ──────────────────────────────────────────────────────────

// Change 1: Password strength validation helper
function validatePassword(password) {
  if (!password || password.length < 8) {
    return 'Password must be at least 8 characters';
  }
  if (!/[a-zA-Z]/.test(password)) {
    return 'Password must contain at least one letter';
  }
  if (!/[0-9]/.test(password)) {
    return 'Password must contain at least one number';
  }
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    return 'Password must contain at least one special character (!@#$%^&* etc.)';
  }
  return null;
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: { error: 'Too many attempts. Please wait 15 minutes and try again.' },
});

// Stricter limiter for password reset — prevents email flooding and token brute-force
const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: { error: 'Too many password reset attempts. Please wait 1 hour and try again.' },
});

const apiSendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.headers.authorization || ipKeyGenerator(req.ip),
  message: { error: 'API send rate limit exceeded. Max 120 requests per minute per API key.' },
});

app.post('/api/auth/signup', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const pwError = validatePassword(password);
  if (pwError) return res.status(400).json({ error: pwError });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

  const hash = await bcrypt.hash(password, 12);
  const isFirst = db.prepare('SELECT COUNT(*) as c FROM users').get().c === 0;

  const result = db.prepare(
    'INSERT INTO users (email, password_hash, is_admin, plan, subscription_status) VALUES (?, ?, ?, ?, ?)'
  ).run(email.toLowerCase().trim(), hash, isFirst ? 1 : 0, 'free', 'free');

  const userId = result.lastInsertRowid;

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.userId = userId;
    res.status(201).json({ ok: true, email: email.toLowerCase().trim() });
  });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Invalid email or password' });
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.userId = user.id;
    db.prepare("UPDATE users SET last_active_at = datetime('now') WHERE id = ?").run(user.id);
    syncLicenseFromWeb(user.id, user.email).catch(() => {});
    res.json({ ok: true, email: user.email, is_admin: user.is_admin });
  });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// Change 7: Forgot password
app.post('/api/auth/forgot-password', resetLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!user) {
    return res.json({ ok: true }); // identical response — don't reveal account existence
  }
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
  db.prepare('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?').run(token, expires, user.id);
  const appUrl = process.env.APP_URL || 'https://app.textyourlist.com';
  const resetLink = `${appUrl}/reset-password?token=${token}`;

  if (transporter) {
    try {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || 'Text Your List <noreply@app.textyourlist.com>',
        to: email,
        subject: 'Reset your Text Your List password',
        html: `<p>Click the link below to reset your password. This link expires in 1 hour.</p>
               <p><a href="${resetLink}">${resetLink}</a></p>
               <p>If you did not request this, ignore this email.</p>`,
      });
      return res.json({ ok: true });
    } catch (err) {
      console.error('Password reset email failed:', err.message);
      return res.json({ ok: true });
    }
  } else {
    return res.json({ ok: true });
  }
});

// Change 7: Reset password with token
app.post('/api/auth/reset-password', resetLimiter, async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
  const pwError = validatePassword(password);
  if (pwError) return res.status(400).json({ error: pwError });
  const user = db.prepare('SELECT * FROM users WHERE reset_token = ?').get(token);
  if (!user) return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
  if (user.reset_token_expires && new Date(user.reset_token_expires) < new Date()) {
    return res.status(400).json({ error: 'Reset link has expired. Please request a new one.' });
  }
  const hash = await bcrypt.hash(password, 12);
  db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?').run(hash, user.id);
  res.json({ ok: true });
});

// Change 10: Change password (authenticated)
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password required' });
  const pwError = validatePassword(newPassword);
  if (pwError) return res.status(400).json({ error: pwError });
  const match = await bcrypt.compare(currentPassword, req.user.password_hash);
  if (!match) return res.status(401).json({ error: 'Current password is incorrect' });
  const hash = await bcrypt.hash(newPassword, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = req.user;
  syncLicenseFromWeb(user.id, user.email).catch(() => {});
  // Change 8: check if billing_period_end has passed and downgrade if so
  if (user.subscription_status === 'cancelled' && user.billing_period_end) {
    if (new Date(user.billing_period_end) < new Date()) {
      db.prepare("UPDATE users SET plan = 'free', subscription_status = 'free', billing_period_end = NULL WHERE id = ?").run(user.id);
      user.plan = 'free';
      user.subscription_status = 'free';
      user.billing_period_end = null;
    }
  }
  const fresh = resetPeriodIfNeeded(user);
  const plan = PLANS[fresh.plan] || PLANS.free;
  // Admins and manual accounts get unlimited everything
  const isPrivileged = fresh.is_admin || fresh.manual_account;
  res.json({
    id: fresh.id,
    email: fresh.email,
    is_admin: fresh.is_admin,
    plan: fresh.plan,
    plan_label: plan.label,
    monthly_sends: fresh.monthly_sends,
    monthly_limit: isPrivileged ? 999999 : plan.monthly_limit,
    remaining_sends: isPrivileged ? 999999 : Math.max(0, plan.monthly_limit - fresh.monthly_sends),
    period_start: fresh.period_start,
    csv_upload: true, // all plans now support CSV (free limited to 10 contacts)
    bulk_max_contacts: isPrivileged ? Infinity : plan.bulk_max_contacts,
    templates: isPrivileged || plan.templates,
    api_send: isPrivileged || plan.api_send,
    companion: true, // all plans include companion
    subscription_status: fresh.subscription_status,
    manual_account: fresh.manual_account,
    billing_period_end: fresh.billing_period_end || null,
    billing_interval: fresh.billing_interval || null,
    pending_api_count: db.prepare("SELECT COUNT(*) as c FROM jobs WHERE user_id = ? AND status = 'api_pending'").get(fresh.id).c,
    api_default_pace: fresh.api_default_pace != null ? fresh.api_default_pace : null,
    daily_sends: db.prepare("SELECT COUNT(*) as c FROM send_logs WHERE user_id = ? AND status = 'sent' AND date(created_at) = date('now')").get(fresh.id).c || 0,
  });
});

// User settings — Pro users can set api_default_pace
app.patch('/api/user/settings', requireAuth, (req, res) => {
  const { api_default_pace } = req.body;
  const isPrivileged = req.user.is_admin || req.user.manual_account;
  const isPro = req.user.plan === 'pro' || isPrivileged;
  if (!isPro) return res.status(403).json({ error: 'Pro plan required to change API send default.' });

  let pace = null;
  if (api_default_pace !== null && api_default_pace !== undefined) {
    pace = parseInt(api_default_pace, 10);
    if (isNaN(pace) || (pace !== 0 && pace !== 15 && pace !== 20)) {
      return res.status(400).json({ error: 'api_default_pace must be null, 0, or 20' });
    }
  }
  db.prepare('UPDATE users SET api_default_pace = ? WHERE id = ?').run(pace, req.user.id);
  res.json({ ok: true, api_default_pace: pace });
});

// ─── CSV Upload ──────────────────────────────────────────────────────────────

app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
  // All plans support CSV upload; free plan bulk-send contacts are capped at 10 server-side
  try {
    const fileError = validateCsvUpload(req.file);
    if (fileError) return res.status(400).json({ error: fileError });
    const text = req.file.buffer.toString('utf8');
    const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true });
    const rowError = validateCsvRows(rows);
    if (rowError) return res.status(400).json({ error: rowError });
    const columns = Object.keys(rows[0]);
    res.json({ columns, rows: rows.slice(0, 5), total: rows.length, raw: text });
  } catch (err) {
    res.status(400).json({ error: 'Could not parse CSV: ' + err.message });
  }
});

// ─── Jobs ────────────────────────────────────────────────────────────────────

app.get('/api/jobs', requireAuth, (req, res) => {
  const jobs = db.prepare('SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json(jobs);
});

// Release API-pending jobs: set to 'queued' with optional paceSeconds so the send loop picks them up
app.post('/api/jobs/release-api', requireAuth, (req, res) => {
  const { paceSeconds = 0 } = req.body;
  const pace = Math.max(0, parseInt(paceSeconds, 10) || 0);
  const jobs = db.prepare("SELECT id FROM jobs WHERE user_id = ? AND status = 'api_pending'").all(req.user.id);
  if (!jobs.length) return res.json({ released: 0 });
  const update = db.prepare("UPDATE jobs SET status='queued', pace_seconds=?, updated_at=datetime('now') WHERE id=?");
  db.transaction(() => { jobs.forEach(j => update.run(pace, j.id)); })();
  res.json({ released: jobs.length });
});

app.post('/api/jobs/cancel-api', requireAuth, (req, res) => {
  const jobs = db.prepare("SELECT id FROM jobs WHERE user_id = ? AND status = 'api_pending'").all(req.user.id);
  if (!jobs.length) return res.json({ cancelled: 0 });
  db.transaction(() => {
    jobs.forEach(j => {
      db.prepare("UPDATE messages SET status='cancelled', updated_at=datetime('now') WHERE job_id=?").run(j.id);
      db.prepare("UPDATE jobs SET status='cancelled', updated_at=datetime('now') WHERE id=?").run(j.id);
    });
  })();
  res.json({ cancelled: jobs.length });
});

app.get('/api/jobs/:id', requireAuth, (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job);
});

app.get('/api/jobs/:id/messages', requireAuth, (req, res) => {
  const job = db.prepare('SELECT id FROM jobs WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  const { status } = req.query;
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  let query = 'SELECT * FROM messages WHERE job_id = ?';
  const params = [req.params.id];
  if (status) { query += ' AND status = ?'; params.push(status); }
  query += ' ORDER BY created_at ASC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  const messages = db.prepare(query).all(...params);
  const count = db.prepare('SELECT COUNT(*) as c FROM messages WHERE job_id = ?').get(req.params.id);
  res.json({ messages, total: count.c });
});

app.post('/api/jobs', requireAuth, (req, res) => {
  const { name, template, rows, columnMap, paceSeconds = 0 } = req.body;
  if (!name || !template || !rows || !columnMap?.phone) {
    return res.status(400).json({ error: 'name, template, rows, and columnMap.phone are required' });
  }
  const nameError = validateMaxLength(name, 100, 'Campaign name');
  if (nameError) return res.status(400).json({ error: nameError });
  const templateError = validateMaxLength(template, 1600, 'Bulk-send message body');
  if (templateError) return res.status(400).json({ error: templateError });

  let parsedRows;
  try {
    if (typeof rows === 'string') {
      parsedRows = parse(rows, { columns: true, skip_empty_lines: true, trim: true });
    } else {
      parsedRows = rows;
    }
  } catch (err) {
    return res.status(400).json({ error: 'Failed to parse rows: ' + err.message });
  }

  // Check bulk contact limit (free plan capped at 10 per send)
  const isPrivilegedUser = req.user.is_admin || req.user.manual_account;
  if (!isPrivilegedUser) {
    const plan = PLANS[req.user.plan] || PLANS.free;
    const bulkMax = plan.bulk_max_contacts || Infinity;
    if (isFinite(bulkMax) && parsedRows.length > bulkMax) {
      return res.status(403).json({
        error: `Free plan bulk sends are limited to ${bulkMax} contacts. Upgrade to Starter or Pro for unlimited.`,
        upgrade: true,
      });
    }
  }

  // Check send limit
  const limitCheck = checkSendLimit(req.user, parsedRows.length);
  if (!limitCheck.allowed) {
    return res.status(402).json({
      error: `Send limit reached. You have ${limitCheck.remaining} sends left this month on the ${PLANS[limitCheck.plan].label} plan.`,
      upgrade: true,
      remaining: limitCheck.remaining,
      limit: limitCheck.limit,
    });
  }

  const suppressed = db.prepare('SELECT phone FROM suppression_list WHERE user_id = ? OR user_id IS NULL').all(req.user.id).map(r => r.phone);
  const suppressedSet = new Set(suppressed);

  const jobId = uuidv4();
  const insertJob = db.prepare('INSERT INTO jobs (id, user_id, name, template, pace_seconds) VALUES (?, ?, ?, ?, ?)');
  const insertMsg = db.prepare(
    'INSERT INTO messages (id, job_id, phone, first_name, last_name, link, body, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );

  let queued = 0, skippedSuppress = 0, skippedInvalid = 0;

  const doInserts = db.transaction(() => {
    // Atomic re-check inside write lock to prevent races near plan limit
    if (!isPrivilegedUser) {
      const fresh = db.prepare('SELECT monthly_sends, plan FROM users WHERE id = ?').get(req.user.id);
      const planObj = PLANS[fresh.plan] || PLANS.free;
      const freshRemaining = planObj.monthly_limit - fresh.monthly_sends;
      if (freshRemaining < parsedRows.length) {
        const err = new Error('LIMIT_EXCEEDED');
        err.remaining = freshRemaining;
        err.limit = planObj.monthly_limit;
        throw err;
      }
    }
    insertJob.run(jobId, req.user.id, name, template, Number(paceSeconds));
    for (const row of parsedRows) {
      const rawPhone = row[columnMap.phone];
      const phone = normalizePhone(rawPhone);
      if (!phone) { skippedInvalid++; continue; }
      if (suppressedSet.has(phone)) { skippedSuppress++; continue; }

      const mapped = {
        first_name: columnMap.first_name ? (row[columnMap.first_name] || '') : '',
        last_name: columnMap.last_name ? (row[columnMap.last_name] || '') : '',
        phone,
        link: columnMap.link ? (row[columnMap.link] || '') : '',
      };
      const body = renderDynamicTemplate(template, row, columnMap);
      insertMsg.run(uuidv4(), jobId, phone, mapped.first_name, mapped.last_name, mapped.link, body, 'pending');
      queued++;
    }
    db.prepare("UPDATE jobs SET total=?, updated_at=datetime('now') WHERE id=?").run(queued, jobId);
  });

  try {
    doInserts();
  } catch (err) {
    if (err.message === 'LIMIT_EXCEEDED') {
      return res.status(402).json({
        error: `Send limit reached. You have ${err.remaining} sends left this month on the ${PLANS[req.user.plan]?.label || req.user.plan} plan.`,
        upgrade: true,
        remaining: err.remaining,
        limit: err.limit,
      });
    }
    throw err;
  }
  // Send count incremented at ack time (only confirmed sends count)

  res.status(201).json({ job_id: jobId, queued, skipped_suppressed: skippedSuppress, skipped_invalid: skippedInvalid });
});

app.patch('/api/jobs/:id/status', requireAuth, (req, res) => {
  const { status } = req.body;
  const allowed = ['queued', 'paused', 'cancelled'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE jobs SET status=?, updated_at=datetime('now') WHERE id=?").run(status, req.params.id);
  res.json({ ok: true, status });
});

app.delete('/api/jobs/:id', requireAuth, (req, res) => {
  const job = db.prepare('SELECT id FROM jobs WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM messages WHERE job_id = ?').run(req.params.id);
  db.prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── Preview ─────────────────────────────────────────────────────────────────

app.post('/api/preview', requireAuth, (req, res) => {
  const { template, rows, columnMap } = req.body;
  if (!template || !rows || !columnMap) return res.status(400).json({ error: 'Missing fields' });
  const previews = rows.slice(0, 3).map(row => {
    const mapped = {
      first_name: columnMap.first_name ? (row[columnMap.first_name] || '') : '',
      last_name: columnMap.last_name ? (row[columnMap.last_name] || '') : '',
      phone: normalizePhone(row[columnMap.phone]) || row[columnMap.phone] || '',
      link: columnMap.link ? (row[columnMap.link] || '') : '',
    };
    const body = renderDynamicTemplate(template, row, columnMap);
    return { ...mapped, body };
  });
  res.json(previews);
});

// ─── Companion Polling ───────────────────────────────────────────────────────

app.get('/api/poll', requireApiKey, (req, res) => {
  const userId = req.user ? req.user.id : null;
  const apiKeyId = req.apiKey ? req.apiKey.id : null;

  // Find candidate message — locked to this user AND this specific API key.
  // If the key has a platform tag, only serve jobs to the matching companion OS
  // so Mac and Windows companions don't race each other on the same queue.
  const companionPlatform = req.query.platform || null;
  const keyRow = db.prepare('SELECT platform FROM api_keys WHERE id = ?').get(apiKeyId);
  const keyPlatform = keyRow ? keyRow.platform : null;

  // Block cross-platform poll: if key is tagged for one platform, reject the other
  if (keyPlatform && companionPlatform && keyPlatform !== companionPlatform) {
    return res.json({ message: null });
  }

  const message = db.prepare(`
    SELECT m.*, j.pace_seconds FROM messages m
    JOIN jobs j ON j.id = m.job_id
    JOIN api_keys ak ON ak.id = ? AND ak.user_id = j.user_id
    WHERE m.status = 'pending'
      AND j.status = 'queued'
      AND j.user_id = ?
      AND (m.picked_at IS NULL OR m.picked_at < datetime('now', '-90 seconds'))
    ORDER BY m.created_at ASC
    LIMIT 1
  `).get(apiKeyId, userId);

  if (!message) return res.json({ message: null });

  // Server-side pace enforcement: check last sent message in this job
  const pace = message.pace_seconds || 0;
  if (pace > 0) {
    const lastSent = db.prepare(`
      SELECT sent_at FROM messages
      WHERE job_id = ? AND status = 'sent' AND sent_at IS NOT NULL
      ORDER BY sent_at DESC LIMIT 1
    `).get(message.job_id);
    if (lastSent && lastSent.sent_at) {
      const elapsed = (Date.now() - new Date(lastSent.sent_at + 'Z').getTime()) / 1000;
      if (elapsed < pace) {
        return res.json({ message: null, pace_wait: Math.ceil(pace - elapsed) });
      }
    }
  }

  db.prepare("UPDATE messages SET picked_at=datetime('now') WHERE id=?").run(message.id);

  // Include job progress so the companion can show a counter instead of per-send popups
  const jobCounts = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN status IN ('pending','sending') THEN 1 ELSE 0 END) as pending
    FROM messages WHERE job_id = ?
  `).get(message.job_id);

  res.json({
    message: {
      id: message.id,
      job_id: message.job_id,
      phone: message.phone,
      body: message.body,
      job_total: jobCounts ? jobCounts.total : 1,
      job_sent: jobCounts ? jobCounts.sent : 0,
    },
  });
});

app.post('/api/ack', requireApiKey, (req, res) => {
  const { message_id, status, error } = req.body;
  if (!message_id || !['sent', 'failed'].includes(status)) {
    return res.status(400).json({ error: 'message_id and status (sent|failed) required' });
  }

  // Verify ownership — message must belong to this user AND this specific API key
  const apiKeyId = req.apiKey ? req.apiKey.id : null;
  const msg = db.prepare(`
    SELECT m.* FROM messages m
    JOIN jobs j ON j.id = m.job_id
    JOIN api_keys ak ON ak.id = ? AND ak.user_id = j.user_id
    WHERE m.id = ? AND j.user_id = ?
  `).get(apiKeyId, message_id, req.user.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });

  const MAX_RETRIES = 3;
  const newAttempts = msg.attempts + 1;

  if (status === 'sent') {
    db.prepare(`UPDATE messages SET status='sent', attempts=?, sent_at=datetime('now'), picked_at=NULL, last_attempt_at=datetime('now'), error=NULL WHERE id=?`)
      .run(newAttempts, message_id);
    incrementSendCount(req.user.id, 1);
  } else {
    if (newAttempts >= MAX_RETRIES) {
      db.prepare(`UPDATE messages SET status='dead', attempts=?, picked_at=NULL, last_attempt_at=datetime('now'), error=? WHERE id=?`)
        .run(newAttempts, error || null, message_id);
    } else {
      db.prepare(`UPDATE messages SET status='pending', attempts=?, picked_at=NULL, last_attempt_at=datetime('now'), error=? WHERE id=?`)
        .run(newAttempts, error || null, message_id);
    }
  }

  const userId = req.user ? req.user.id : null;
  log(userId, message_id, msg.job_id, msg.phone, status, error || null);
  recountJob(msg.job_id);
  res.json({ ok: true });
});

// ─── Single Send ─────────────────────────────────────────────────────────────

function queueSingleSend(userId, rawPhone, message, label, source, defaultPace) {
  const phone = normalizePhone(rawPhone);
  if (!phone) return { error: 'Invalid phone number' };
  if (!message || !message.trim()) return { error: 'message is required' };

  const suppressed = db.prepare('SELECT id FROM suppression_list WHERE phone = ? AND (user_id = ? OR user_id IS NULL)').get(phone, userId);
  if (suppressed) return { error: 'Phone is on the suppression list', code: 'suppressed' };

  const jobId = uuidv4();
  const msgId = uuidv4();
  const body  = message.trim();
  // API-sourced: if user has a default pace set, auto-queue; otherwise hold for approval
  let status = 'queued';
  let pace = 0;
  if (source === 'api') {
    if (defaultPace != null) {
      status = 'queued';
      pace = Math.max(0, parseInt(defaultPace, 10) || 0);
    } else {
      status = 'api_pending';
    }
  }

  db.transaction(() => {
    db.prepare('INSERT INTO jobs (id, user_id, name, template, status, pace_seconds, total, source) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
      .run(jobId, userId, label || `Send: ${phone}`, body, status, pace, source || null);
    db.prepare('INSERT INTO messages (id, job_id, phone, first_name, last_name, link, body) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(msgId, jobId, phone, '', '', '', body);
  })();

  return { job_id: jobId, message_id: msgId, status, preview: body };
}

// API route — requires API key, used by Make/Zapier. Pro plan (or admin) required.
app.post('/api/make/send', apiSendLimiter, requireApiKey, (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message are required' });

  // Check Pro requirement (admin and manual accounts bypass)
  const isPrivileged = req.user.is_admin || req.user.manual_account;
  if (!isPrivileged) {
    const plan = PLANS[req.user.plan] || PLANS.free;
    if (!plan.api_send) {
      return res.status(403).json({
        error: 'Pro plan required to use the API send endpoint. Starter plan users can send via the web UI and CSV upload.',
        upgrade: true,
      });
    }
  }

  const limitCheck = checkSendLimit(req.user);
  if (!limitCheck.allowed) {
    if (limitCheck.blocked) {
      return res.status(402).json({ error: limitCheck.blockReason, upgrade: true });
    }
    return res.status(402).json({ error: `Send limit reached (${req.user.plan} plan). Upgrade to send more.`, upgrade: true });
  }

  // Pro users can set api_default_pace: null=hold, 0=fast, 15=drip
  const defaultPace = req.user.api_default_pace;
  const result = queueSingleSend(req.user.id, phone, message, `API: ${phone}`, 'api', defaultPace);
  if (result.error) return res.status(result.code === 'suppressed' ? 422 : 400).json(result);
  res.status(201).json(result);
});

// Web UI route — requires session auth
app.post('/api/send-one', requireAuth, (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message are required' });
  const messageError = validateMaxLength(message, 1600, 'Single-send message body');
  if (messageError) return res.status(400).json({ error: messageError });

  const limitCheck = checkSendLimit(req.user);
  if (!limitCheck.allowed) {
    return res.status(402).json({
      error: `You've used all ${limitCheck.limit} sends for this month. Upgrade your plan to send more.`,
      upgrade: true,
      remaining: 0,
    });
  }

  const result = queueSingleSend(req.user.id, phone, message, `Web: ${phone}`);
  if (result.error) return res.status(result.code === 'suppressed' ? 422 : 400).json(result);
  res.status(201).json(result);
});

// ─── Suppression List ─────────────────────────────────────────────────────────

app.get('/api/suppression', requireAuth, (req, res) => {
  const list = db.prepare('SELECT * FROM suppression_list WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json(list);
});

app.post('/api/suppression', requireAuth, (req, res) => {
  const { phone: rawPhone, reason } = req.body;
  const phone = normalizePhone(rawPhone);
  if (!phone) return res.status(400).json({ error: 'Invalid phone number' });
  try {
    db.prepare('INSERT OR IGNORE INTO suppression_list (user_id, phone, reason) VALUES (?, ?, ?)').run(req.user.id, phone, reason || null);
    res.status(201).json({ ok: true, phone });
  } catch (err) {
    res.status(409).json({ error: 'Already suppressed' });
  }
});

app.delete('/api/suppression/:phone', requireAuth, (req, res) => {
  const phone = normalizePhone(decodeURIComponent(req.params.phone)) || decodeURIComponent(req.params.phone);
  db.prepare('DELETE FROM suppression_list WHERE phone = ? AND user_id = ?').run(phone, req.user.id);
  res.json({ ok: true });
});

// Change 6 (Build 4): Bulk CSV import to suppression list
app.post('/api/suppression/import', requireAuth, upload.single('file'), (req, res) => {
  const fileError = validateCsvUpload(req.file);
  if (fileError) return res.status(400).json({ error: fileError });
  try {
    const text = req.file.buffer.toString('utf8');
    const lines = text.trim().split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return res.status(400).json({ error: 'CSV has no data rows' });
    if (lines.length - 1 > 10000) return res.status(400).json({ error: 'CSV cannot have more than 10,000 rows' });

    // Parse header row to find the phone column index
    const parseCSVRow = (line) => {
      const cols = []; let cur = ''; let inQ = false;
      for (let c of line) {
        if (c === '"') { inQ = !inQ; }
        else if (c === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
        else { cur += c; }
      }
      cols.push(cur.trim());
      return cols;
    };

    const firstRow = parseCSVRow(lines[0]);
    const phoneHeaderIdx = firstRow.findIndex(h =>
      /^phone/i.test(h.replace(/^"|"$/g, '').trim()) ||
      /^mobile/i.test(h.replace(/^"|"$/g, '').trim()) ||
      /^cell/i.test(h.replace(/^"|"$/g, '').trim()) ||
      /^number/i.test(h.replace(/^"|"$/g, '').trim())
    );
    // If first row has a phone-like header → header row exists; else check if first cell is numeric
    const firstCellIsPhone = /^\+?[\d\s\-().]+$/.test(firstRow[0].replace(/^"|"$/g, '').trim());
    const hasHeader = phoneHeaderIdx !== -1 || !firstCellIsPhone;
    const phoneColIdx = phoneHeaderIdx !== -1 ? phoneHeaderIdx : 0;
    const startIdx = hasHeader ? 1 : 0;

    const insert = db.prepare('INSERT OR IGNORE INTO suppression_list (user_id, phone, reason) VALUES (?, ?, ?)');

    let added = 0;
    let already_suppressed = 0;

    const doInserts = db.transaction(() => {
      for (let i = startIdx; i < lines.length; i++) {
        const cols = parseCSVRow(lines[i]);
        const raw = (cols[phoneColIdx] || '').replace(/^"|"$/g, '').trim();
        const phone = normalizePhone(raw);
        if (!phone) continue;
        const existing = db.prepare('SELECT id FROM suppression_list WHERE user_id = ? AND phone = ?').get(req.user.id, phone);
        if (existing) { already_suppressed++; continue; }
        insert.run(req.user.id, phone, 'CSV import');
        added++;
      }
    });
    doInserts();
    res.json({ ok: true, added, already_suppressed });
  } catch (err) {
    res.status(400).json({ error: 'Could not parse file: ' + err.message });
  }
});

// ─── API Keys ────────────────────────────────────────────────────────────────

app.get('/api/keys', requireAuth, (req, res) => {
  const keys = db.prepare('SELECT id, name, scope, active, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json(keys);
});

app.post('/api/keys', requireAuth, (req, res) => {
  const { name, scope = 'all' } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  // Admin and manual accounts bypass key limits
  const isPrivileged = req.user.is_admin || req.user.manual_account;
  if (!isPrivileged) {
    const plan = PLANS[req.user.plan] || PLANS.free;
    const keyLimit = plan.api_keys; // 1 for free/starter, Infinity for pro
    if (isFinite(keyLimit)) {
      const keyCount = db.prepare('SELECT COUNT(*) as c FROM api_keys WHERE user_id = ? AND active = 1').get(req.user.id);
      if (keyCount.c >= keyLimit) {
        const limitMsg = plan.label === 'Pro'
          ? 'Upgrade to Pro for unlimited keys.'
          : `Your ${plan.label} plan allows ${keyLimit} active API key. Upgrade to Pro to create more.`;
        return res.status(402).json({ error: limitMsg, upgrade: true });
      }
    }
  }

  const key = 'tbk_' + crypto.randomBytes(24).toString('hex');
  const keyHash = crypto.createHash('sha256').update(key).digest('hex');
  db.prepare('INSERT INTO api_keys (user_id, key, key_hash, name, scope) VALUES (?, ?, ?, ?, ?)').run(req.user.id, key, keyHash, name, scope);
  res.set('Cache-Control', 'no-store').status(201).json({ key, name, scope });
});

app.delete('/api/keys/:id', requireAuth, (req, res) => {
  db.prepare('UPDATE api_keys SET active = 0 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.get('/api/keys/:id/companion', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ? AND user_id = ? AND active = 1').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Key not found or revoked' });

  const apiUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const platform = req.query.platform || 'mac';
  const platformFamily = (platform === 'windows-iphone' || platform === 'windows-iphone-app' || platform === 'windows') ? 'windows' : 'mac';

  // Tag the API key with its platform so companions don't race each other
  db.prepare('UPDATE api_keys SET platform = ? WHERE id = ?').run(platformFamily, row.id);

  if (platform === 'windows-iphone' || platform === 'windows-iphone-app') {
    // Windows + iPhone — Electron tray app (zip with config.json injected)
    const zipPath = path.join(__dirname, 'public', 'downloads', 'TYLCompanion-win32-x64.zip');
    if (!fs.existsSync(zipPath)) {
      return res.status(503).json({ error: 'Companion app not yet built. Please contact support.' });
    }
    try {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(zipPath);
      const config = JSON.stringify({
        apiUrl: apiUrl,
        apiKey: row.key,
        pollIntervalSeconds: 3,
        paceSeconds: 1,
      }, null, 2);
      // Replace the placeholder config.json inside the zip
      // config.json lives at resources/config.json (process.resourcesPath), NOT resources/app/
      // Zip files are at root (no subfolder), so path is just resources/config.json
      const winConfigPath = 'resources/config.json';
      const configEntry = zip.getEntry(winConfigPath);
      if (configEntry) {
        zip.updateFile(winConfigPath, Buffer.from(config));
      } else {
        zip.addFile(winConfigPath, Buffer.from(config));
      }
      const zipBuffer = zip.toBuffer();
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="TextYourListCompanion-${row.name.replace(/[^a-z0-9]/gi,'_')}.zip"`);
      res.send(zipBuffer);
    } catch (err) {
      res.status(500).json({ error: 'Failed to generate companion download: ' + err.message });
    }
    return;
  }

  if (platform === 'mac-iphone') {
    // Mac + iPhone — Electron tray app (zip with config.json injected)
    // Serve arm64 for Apple Silicon (M1/M2/M3), x64 for Intel
    const arch = req.query.arch === 'x64' ? 'x64' : 'arm64';
    const zipFile = arch === 'arm64' ? 'TYLCompanion-darwin-arm64.zip' : 'TYLCompanion-darwin-x64.zip';
    const zipPath = path.join(__dirname, 'public', 'downloads', zipFile);
    if (!fs.existsSync(zipPath)) {
      return res.status(503).json({ error: 'Mac companion not available. Please contact support.' });
    }
    try {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(zipPath);
      const config = JSON.stringify({
        apiUrl: apiUrl,
        apiKey: row.key,
        pollIntervalSeconds: 3,
        paceSeconds: 1,
      }, null, 2);
      // App sits at root of zip: TextYourListCompanion.app/Contents/Resources/config.json
      const macConfigPath = 'TextYourListCompanion.app/Contents/Resources/config.json';
      const configEntry = zip.getEntry(macConfigPath);
      if (configEntry) {
        zip.updateFile(macConfigPath, Buffer.from(config));
      } else {
        zip.addFile(macConfigPath, Buffer.from(config));
      }
      const zipBuffer = zip.toBuffer();
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="TextYourListCompanionMac-${row.name.replace(/[^a-z0-9]/gi,'_')}.zip"`);
      res.send(zipBuffer);
    } catch (err) {
      res.status(500).json({ error: 'Failed to generate Mac companion download: ' + err.message });
    }
    return;
  }

  if (false && platform === 'windows-iphone-ps1') {
    // Legacy PowerShell fallback (kept for reference)
    const ps1 = `# Text Your List Companion — ${row.name} (iPhone via Phone Link)
# Right-click this file and select "Run with PowerShell"
# Leave the window open while sending.
# Requirements: Windows 10/11 with Phone Link app paired to your iPhone.

$API_URL = "${apiUrl}"
$API_KEY = "${row.key}"
$POLL_INTERVAL = 10
$PACE_SECONDS = 20

# Keep the window open if anything goes wrong
trap {
  Write-Host ""
  Write-Host "Unexpected error: $_" -ForegroundColor Red
  Read-Host "Press Enter to close"
  exit 1
}

try { Add-Type -AssemblyName System.Windows.Forms } catch {
  Write-Host "Warning: System.Windows.Forms not available." -ForegroundColor Yellow
}

# Win32 API to force Phone Link into the foreground
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
}
"@

function Get-PhoneLinkProcess {
  return Get-Process -Name "YourPhone", "PhoneLink" -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Send-ViaPhoneLink($number, $message) {
  $proc = Get-PhoneLinkProcess
  if (-not $proc) {
    Write-Host "Phone Link is not running. Please open Phone Link first." -ForegroundColor Red
    return $false
  }

  try {
    # Bring Phone Link window to foreground using Win32 API (more reliable than UIAutomation)
    $hwnd = $proc.MainWindowHandle
    if ($hwnd -eq [IntPtr]::Zero) {
      # Window may be minimized — find it by process
      $hwnd = (Get-Process -Id $proc.Id).MainWindowHandle
    }
    [Win32]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE = 9
    Start-Sleep -Milliseconds 400
    [Win32]::SetForegroundWindow($hwnd) | Out-Null
    Start-Sleep -Milliseconds 600

    # Use Ctrl+N keyboard shortcut to open New Message compose (confirmed shortcut per Microsoft docs)
    [System.Windows.Forms.SendKeys]::SendWait("^n")
    Start-Sleep -Milliseconds 1000

    # Type the phone number — escape special SendKeys chars
    $safeNumber = $number -replace '([+(){}[\]^~])', '{$1}'
    [System.Windows.Forms.SendKeys]::SendWait($safeNumber)
    Start-Sleep -Milliseconds 800

    # Press Enter to confirm recipient
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Start-Sleep -Milliseconds 800

    # Tab to message body (Phone Link moves focus to the message field after recipient confirm)
    [System.Windows.Forms.SendKeys]::SendWait("{TAB}")
    Start-Sleep -Milliseconds 400

    # Type message — escape special chars
    $safeMsg = $message -replace '([+(){}[\]^~%])', '{$1}'
    [System.Windows.Forms.SendKeys]::SendWait($safeMsg)
    Start-Sleep -Milliseconds 500

    # Enter to send
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Start-Sleep -Milliseconds 1000

    return $true
  } catch {
    Write-Host "Error sending via Phone Link: $_" -ForegroundColor Red
    return $false
  }
}

Write-Host "Text Your List Companion — ${row.name}" -ForegroundColor Cyan
Write-Host "Using iPhone via Phone Link" -ForegroundColor Yellow
Write-Host "Leave this window open while sending." -ForegroundColor Cyan
Write-Host ""

$proc = Get-PhoneLinkProcess
if (-not $proc) {
  Write-Host "Phone Link is not open yet." -ForegroundColor Yellow
  Write-Host "Open Phone Link from the Start menu and make sure your iPhone is paired." -ForegroundColor Yellow
  Write-Host "This companion will keep running and will start sending once Phone Link is ready." -ForegroundColor Cyan
  Write-Host ""
}

$lastSentAt = $null

while ($true) {
  try {
    $response = Invoke-RestMethod -Uri "$API_URL/api/poll" \`
      -Headers @{ Authorization = "Bearer $API_KEY" } \`
      -Method Get -ErrorAction Stop

    if ($response.message) {
      $msg = $response.message

      # Check Phone Link is running before attempting send
      $proc = Get-PhoneLinkProcess
      if (-not $proc) {
        Write-Host "[$([datetime]::Now.ToString('HH:mm:ss'))] Message queued but Phone Link is not open. Open Phone Link to send." -ForegroundColor Yellow
        Start-Sleep -Seconds $POLL_INTERVAL
        continue
      }

      Write-Host "[$([datetime]::Now.ToString('HH:mm:ss'))] Sending to $($msg.phone)..." -ForegroundColor Yellow

      # Pace enforcement
      if ($lastSentAt) {
        $elapsed = ([datetime]::Now - $lastSentAt).TotalSeconds
        if ($elapsed -lt $PACE_SECONDS) {
          $wait = [math]::Ceiling($PACE_SECONDS - $elapsed)
          Write-Host "Waiting $wait seconds (pace)..." -ForegroundColor Gray
          Start-Sleep -Seconds $wait
        }
      }

      $success = Send-ViaPhoneLink $msg.phone $msg.body

      $status = if ($success) { "sent" } else { "failed" }
      $errorMsg = if (-not $success) { "UI Automation send failed" } else { $null }

      $ackBody = @{ message_id = $msg.id; status = $status } | ConvertTo-Json
      if ($errorMsg) { $ackBody = @{ message_id = $msg.id; status = $status; error = $errorMsg } | ConvertTo-Json }

      Invoke-RestMethod -Uri "$API_URL/api/ack" \`
        -Headers @{ Authorization = "Bearer $API_KEY"; "Content-Type" = "application/json" } \`
        -Method Post -Body $ackBody -ErrorAction Stop | Out-Null

      if ($success) {
        Write-Host "  Sent." -ForegroundColor Green
        $lastSentAt = [datetime]::Now
      } else {
        Write-Host "  Failed — check that Phone Link is open and paired to your iPhone." -ForegroundColor Red
      }
    } else {
      Write-Host "[$([datetime]::Now.ToString('HH:mm:ss'))] Connected — waiting for messages..." -ForegroundColor DarkGray
    }
  } catch {
    Write-Host "Poll error: $_" -ForegroundColor DarkGray
  }
  Start-Sleep -Seconds $POLL_INTERVAL
}

Read-Host "Companion stopped. Press Enter to close"
`;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="TextYourList-iPhone-PhoneLink-${row.name.replace(/[^a-z0-9]/gi,'_')}.ps1"`);
    res.send(ps1);
    return;
  }

  if (platform === 'windows') {
    // Windows + Android companion PowerShell script
    const ps1 = `# Text Your List Windows Companion — ${row.name}
# Right-click this file and select "Run with PowerShell"
# Leave the window open while sending.

$API_URL = "${apiUrl}"
$API_KEY = "${row.key}"

Write-Host "Text Your List Windows Companion — ${row.name}" -ForegroundColor Cyan
Write-Host ""

# Check for Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js is not installed." -ForegroundColor Red
  Write-Host "Please install it from https://nodejs.org (LTS version)" -ForegroundColor Yellow
  Write-Host ""
  $open = Read-Host "Press Enter to open nodejs.org, then re-run this script"
  Start-Process "https://nodejs.org"
  exit 1
}

$nodeVersion = node --version
Write-Host "Node.js found: $nodeVersion" -ForegroundColor Green

# Set up companion folder
$dir = "$env:USERPROFILE\\TextYourList-Windows"
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }

Write-Host "Setting up companion in $dir ..." -ForegroundColor Yellow

# Download companion files
Invoke-WebRequest -Uri "$API_URL/companion/windows-companion/sender.js"   -OutFile "$dir\\sender.js"     -UseBasicParsing
Invoke-WebRequest -Uri "$API_URL/companion/windows-companion/package.json" -OutFile "$dir\\package.json" -UseBasicParsing

# Write config
\$config = @"
{
  "apiUrl": "$API_URL",
  "apiKey": "$API_KEY",
  "paceSeconds": 30,
  "pollIntervalSeconds": 10,
  "sessionDir": "session"
}
"@
\$config | Set-Content "$dir\\config.json"

Set-Location $dir

# Install dependencies
Write-Host "Installing dependencies (first run may take a minute)..." -ForegroundColor Yellow
npm install --silent

if (-not (Test-Path "$dir\\node_modules\\playwright")) {
  Write-Host "Installing Playwright browser (one-time setup)..." -ForegroundColor Yellow
  npx playwright install chromium
}

Write-Host ""
Write-Host "Starting Text Your List Windows companion..." -ForegroundColor Green
Write-Host "On first run, a browser will open for QR code pairing." -ForegroundColor Yellow
Write-Host "Scan the QR code with your Android phone in Messages app." -ForegroundColor Yellow
Write-Host "Leave this window open while sending." -ForegroundColor Cyan
Write-Host ""

node sender.js
`;

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="TextYourList-Windows-${row.name.replace(/[^a-z0-9]/gi,'_')}.ps1"`);
    res.send(ps1);
    return;
  }

  // Default: Mac companion (.command file)
  const script = `#!/bin/bash
# Text Your List Companion — ${row.name}
# Double-click to start. Leave this window open while sending.

API_URL="${apiUrl}"
API_KEY="${row.key}"

# ── Check for Node.js ────────────────────────────────────────────────────────
if ! command -v node &> /dev/null; then
  echo ""
  echo "Node.js is not installed on this Mac."
  echo ""
  echo "To install it:"
  echo "  1. Go to https://nodejs.org in your browser"
  echo "  2. Click the big green LTS download button"
  echo "  3. Open the downloaded file and click through the installer"
  echo "  4. Once done, double-click this file again"
  echo ""
  read -p "Press Enter to open nodejs.org now..."
  open "https://nodejs.org"
  exit 1
fi

# ── Set up companion folder ──────────────────────────────────────────────────
DIR="$HOME/TextYourList"
mkdir -p "$DIR"

echo "Setting up Text Your List..."

curl -s "$API_URL/companion/sender.js"      -o "$DIR/sender.js"
curl -s "$API_URL/companion/package.json"   -o "$DIR/package.json"

cat > "$DIR/config.json" << 'CONFIG'
{
  "apiUrl": "API_URL_PLACEHOLDER",
  "apiKey": "API_KEY_PLACEHOLDER",
  "paceSeconds": 30,
  "pollIntervalSeconds": 10
}
CONFIG

sed -i '' "s|API_URL_PLACEHOLDER|$API_URL|g; s|API_KEY_PLACEHOLDER|$API_KEY|g" "$DIR/config.json"

cd "$DIR"
npm install --silent --prefer-offline 2>/dev/null || npm install --silent

echo ""
echo "Text Your List is running. Leave this window open."
echo "Messages will send through your Mac's Messages app."
echo ""

node sender.js
`;

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="TextYourList-${row.name.replace(/[^a-z0-9]/gi,'_')}.command"`);
  res.send(script);
});

// ─── Logs ────────────────────────────────────────────────────────────────────

app.get('/api/logs', requireAuth, (req, res) => {
  const { job_id, limit = 100, offset = 0 } = req.query;
  let query = 'SELECT * FROM send_logs WHERE user_id = ?';
  const params = [req.user.id];
  if (job_id) { query += ' AND job_id = ?'; params.push(job_id); }
  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));
  res.json(db.prepare(query).all(...params));
});

// ─── Templates ───────────────────────────────────────────────────────────────

app.get('/api/templates', requireAuth, (req, res) => {
  const plan = PLANS[req.user.plan] || PLANS.free;
  if (!req.user.is_admin && !req.user.manual_account && !plan.templates) return res.status(403).json({ error: 'Templates require Starter or Pro plan', upgrade: true });
  const list = db.prepare('SELECT * FROM templates WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json(list);
});

app.post('/api/templates', requireAuth, (req, res) => {
  const plan = PLANS[req.user.plan] || PLANS.free;
  if (!req.user.is_admin && !req.user.manual_account && !plan.templates) return res.status(403).json({ error: 'Templates require Starter or Pro plan', upgrade: true });
  const { name, body } = req.body;
  if (!name || !body) return res.status(400).json({ error: 'name and body required' });
  const nameError = validateMaxLength(name, 100, 'Template name');
  if (nameError) return res.status(400).json({ error: nameError });
  const bodyError = validateMaxLength(body, 1600, 'Template body');
  if (bodyError) return res.status(400).json({ error: bodyError });
  const result = db.prepare('INSERT INTO templates (user_id, name, body) VALUES (?, ?, ?)').run(req.user.id, name, body);
  res.status(201).json({ id: result.lastInsertRowid, name, body });
});

app.patch('/api/templates/:id', requireAuth, (req, res) => {
  const plan = PLANS[req.user.plan] || PLANS.free;
  if (!req.user.is_admin && !req.user.manual_account && !plan.templates) return res.status(403).json({ error: 'Templates require Starter or Pro plan', upgrade: true });
  const { name, body } = req.body;
  if (!name || !body) return res.status(400).json({ error: 'name and body required' });
  const result = db.prepare('UPDATE templates SET name = ?, body = ? WHERE id = ? AND user_id = ?').run(name.slice(0, 100), body.slice(0, 1600), req.params.id, req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'Template not found' });
  res.json({ ok: true });
});

app.delete('/api/templates/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM templates WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ─── Contact Lists ────────────────────────────────────────────────────────────

app.get('/api/lists', requireAuth, (req, res) => {
  const lists = db.prepare('SELECT id, name, columns, row_count, created_at FROM contact_lists WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json(lists);
});

app.post('/api/lists', requireAuth, (req, res) => {
  // All plans can save contact lists (free plan contact limit enforced at send time)
  const { name, csv_data, columns, row_count } = req.body;
  if (!name || !csv_data || !columns) return res.status(400).json({ error: 'name, csv_data, and columns required' });
  const nameError = validateMaxLength(name, 100, 'List name');
  if (nameError) return res.status(400).json({ error: nameError });
  const result = db.prepare(
    'INSERT INTO contact_lists (user_id, name, csv_data, columns, row_count) VALUES (?, ?, ?, ?, ?)'
  ).run(req.user.id, name, csv_data, JSON.stringify(columns), row_count || 0);
  res.status(201).json({ id: result.lastInsertRowid, name });
});

app.get('/api/lists/:id', requireAuth, (req, res) => {
  const list = db.prepare('SELECT * FROM contact_lists WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!list) return res.status(404).json({ error: 'Not found' });
  list.columns = JSON.parse(list.columns);
  res.json(list);
});

app.patch('/api/lists/:id/rename', requireAuth, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const nameError = validateMaxLength(name, 100, 'List name');
  if (nameError) return res.status(400).json({ error: nameError });
  const result = db.prepare('UPDATE contact_lists SET name = ? WHERE id = ? AND user_id = ?').run(name, req.params.id, req.user.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true, name });
});

app.delete('/api/lists/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM contact_lists WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// Sanitize CSV cells to prevent formula injection when opened in Excel
function sanitizeCsvForExport(csvData) {
  const formulaPattern = /^[=+\-@\t\r]/;
  try {
    const rows = parse(csvData, { columns: true, skip_empty_lines: true, trim: false });
    if (!rows.length) return csvData;
    const headers = Object.keys(rows[0]);
    const lines = [headers.map(h => `"${String(h).replace(/"/g, '""')}"`).join(',')];
    for (const row of rows) {
      const cells = headers.map(h => {
        let val = String(row[h] || '');
        if (h.toLowerCase() !== 'phone' && formulaPattern.test(val)) {
          val = "'" + val;
        }
        return `"${val.replace(/"/g, '""')}"`;
      });
      lines.push(cells.join(','));
    }
    return lines.join('\n');
  } catch (_) {
    return csvData;
  }
}

// Change 3: Download CSV
app.get('/api/lists/:id/download', requireAuth, (req, res) => {
  const list = db.prepare('SELECT * FROM contact_lists WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!list) return res.status(404).json({ error: 'Not found' });
  const filename = list.name.replace(/[^a-z0-9]/gi, '_') + '.csv';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(sanitizeCsvForExport(list.csv_data));
});

// Change 3: Replace CSV for a list
app.put('/api/lists/:id', requireAuth, upload.single('file'), (req, res) => {
  const list = db.prepare('SELECT * FROM contact_lists WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!list) return res.status(404).json({ error: 'Not found' });
  let text;
  let columns;
  let rowCount;
  if (req.file) {
    const fileError = validateCsvUpload(req.file);
    if (fileError) return res.status(400).json({ error: fileError });
    text = req.file.buffer.toString('utf8');
    try {
      const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true });
      const rowError = validateCsvRows(rows);
      if (rowError) return res.status(400).json({ error: rowError });
      columns = Object.keys(rows[0]);
      rowCount = rows.length;
    } catch (err) {
      return res.status(400).json({ error: 'Could not parse CSV: ' + err.message });
    }
  } else if (req.body.csv_data) {
    text = req.body.csv_data;
    columns = req.body.columns ? (Array.isArray(req.body.columns) ? req.body.columns : JSON.parse(req.body.columns)) : [];
    if (!text || !columns.length) return res.status(400).json({ error: 'csv_data and columns required' });
    try {
      const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true });
      if (rows.length > 10000) return res.status(400).json({ error: 'CSV cannot have more than 10,000 rows' });
      const rowError = validateCsvRows(rows);
      if (rowError) return res.status(400).json({ error: rowError });
      rowCount = rows.length;
    } catch (err) {
      return res.status(400).json({ error: 'Could not parse csv_data: ' + err.message });
    }
  } else {
    return res.status(400).json({ error: 'No file uploaded or csv_data provided' });
  }
  db.prepare('UPDATE contact_lists SET csv_data = ?, columns = ?, row_count = ? WHERE id = ?')
    .run(text, JSON.stringify(columns), rowCount, req.params.id);
  res.json({ ok: true, row_count: rowCount, columns });
});

// Change 3: View CSV data (first 50 rows)
app.get('/api/lists/:id/view', requireAuth, (req, res) => {
  const list = db.prepare('SELECT * FROM contact_lists WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!list) return res.status(404).json({ error: 'Not found' });
  try {
    const rows = parse(list.csv_data, { columns: true, skip_empty_lines: true, trim: true });
    res.json({ rows: rows.slice(0, 50), total: rows.length, columns: Object.keys(rows[0] || {}) });
  } catch (err) {
    res.status(400).json({ error: 'Could not parse CSV' });
  }
});

// ─── Billing ─────────────────────────────────────────────────────────────────

// GET /billing/checkout — redirect from signup with plan param (Change 1)
app.get('/billing/checkout', requireAuth, async (req, res) => {
  const { plan } = req.query;
  if (!['starter', 'pro'].includes(plan)) return res.redirect('/app');

  if (!stripe) {
    // Stripe not configured — go to app with flash
    return res.redirect('/app?billing_flash=not_configured&plan=' + encodeURIComponent(plan));
  }

  // Derive monthly price ID by default
  const priceId = plan === 'starter'
    ? (process.env.STRIPE_STARTER_MONTHLY_PRICE_ID || process.env.STRIPE_STARTER_PRICE_ID)
    : (process.env.STRIPE_PRO_MONTHLY_PRICE_ID || process.env.STRIPE_PRO_PRICE_ID);

  const validPriceIds = [
    process.env.STRIPE_STARTER_MONTHLY_PRICE_ID,
    process.env.STRIPE_STARTER_ANNUAL_PRICE_ID,
    process.env.STRIPE_PRO_MONTHLY_PRICE_ID,
    process.env.STRIPE_PRO_ANNUAL_PRICE_ID,
    process.env.STRIPE_STARTER_PRICE_ID,
    process.env.STRIPE_PRO_PRICE_ID,
  ].filter(Boolean);

  if (!priceId || (validPriceIds.length > 0 && !validPriceIds.includes(priceId))) {
    return res.redirect('/app?billing_flash=not_configured&plan=' + encodeURIComponent(plan));
  }

  try {
    const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}/app?billing=success`,
      cancel_url: `${appUrl}/app?billing=cancelled`,
      customer_email: req.user.email,
      metadata: { user_id: String(req.user.id), plan },
    });
    return res.redirect(session.url);
  } catch (err) {
    return res.redirect('/app?billing_flash=error');
  }
});

// Change 4: billing/checkout accepts priceId or cycle for monthly/annual toggle
app.post('/billing/checkout', requireAuth, async (req, res) => {
  const { plan, priceId: customPriceId, cycle } = req.body;
  if (!['starter', 'pro'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' });

  if (!stripe) {
    return res.status(503).json({ error: 'Billing not configured. Contact support to upgrade.' });
  }

  // Accept a specific priceId from frontend (for annual vs monthly toggle)
  // Or derive from plan + cycle
  // Fallback to legacy single price IDs for backward compat
  let priceId = customPriceId;
  if (!priceId) {
    const isAnnual = cycle === 'annual';
    if (plan === 'starter') {
      priceId = isAnnual
        ? (process.env.STRIPE_STARTER_ANNUAL_PRICE_ID)
        : (process.env.STRIPE_STARTER_MONTHLY_PRICE_ID || process.env.STRIPE_STARTER_PRICE_ID);
    } else {
      priceId = isAnnual
        ? (process.env.STRIPE_PRO_ANNUAL_PRICE_ID)
        : (process.env.STRIPE_PRO_MONTHLY_PRICE_ID || process.env.STRIPE_PRO_PRICE_ID);
    }
  }

  // Validate the priceId is one we recognize (security check)
  const validPriceIds = [
    process.env.STRIPE_STARTER_MONTHLY_PRICE_ID,
    process.env.STRIPE_STARTER_ANNUAL_PRICE_ID,
    process.env.STRIPE_PRO_MONTHLY_PRICE_ID,
    process.env.STRIPE_PRO_ANNUAL_PRICE_ID,
    process.env.STRIPE_STARTER_PRICE_ID, // legacy
    process.env.STRIPE_PRO_PRICE_ID,     // legacy
  ].filter(Boolean);

  if (!priceId || (validPriceIds.length > 0 && !validPriceIds.includes(priceId))) {
    return res.status(503).json({ error: 'Billing not configured. Contact support to upgrade.' });
  }

  try {
    const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}/app?billing=success`,
      cancel_url: `${appUrl}/app?billing=cancelled`,
      customer_email: req.user.email,
      metadata: { user_id: String(req.user.id), plan },
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[billing/checkout] Stripe error:', err.message);
    res.status(500).json({ error: 'Unable to start checkout. Please try again or contact support.' });
  }
});

app.post('/billing/portal', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing not configured' });
  const user = req.user;
  if (!user.stripe_customer_id) return res.status(400).json({ error: 'No billing account found' });

  try {
    const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${appUrl}/app`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[billing/portal] Stripe error:', err.message);
    res.status(500).json({ error: 'Unable to open billing portal. Please try again or contact support.' });
  }
});

function handleStripeWebhook(req, res) {
  if (!stripe) return res.status(200).json({ received: true });

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata?.user_id;
    const plan = session.metadata?.plan;
    if (userId && plan) {
      // Detect billing interval from price ID
      let billingInterval = null;
      const starterAnnual = process.env.STRIPE_STARTER_ANNUAL_PRICE_ID;
      const proAnnual = process.env.STRIPE_PRO_ANNUAL_PRICE_ID;
      const priceId = session.line_items?.data?.[0]?.price?.id;
      if (priceId && (priceId === starterAnnual || priceId === proAnnual)) {
        billingInterval = 'annual';
      } else {
        billingInterval = 'monthly';
      }
      db.prepare('UPDATE users SET plan = ?, stripe_customer_id = ?, stripe_subscription_id = ?, subscription_status = ?, billing_interval = ? WHERE id = ?')
        .run(plan, session.customer, session.subscription, 'active', billingInterval, userId);
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    // Change 8: keep plan active until billing_period_end passes
    const sub = event.data.object;
    const periodEnd = sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString()
      : null;
    db.prepare("UPDATE users SET subscription_status = 'cancelled', billing_period_end = ? WHERE stripe_subscription_id = ?")
      .run(periodEnd, sub.id);
    // Do NOT change plan yet — downgrade happens on next /api/auth/me call after period_end
  }

  if (event.type === 'customer.subscription.updated') {
    const sub = event.data.object;
    const priceId = sub.items?.data?.[0]?.price?.id;
    let plan = null;
    // Support both monthly and annual price IDs
    const starterPriceIds = [process.env.STRIPE_STARTER_PRICE_ID, process.env.STRIPE_STARTER_MONTHLY_PRICE_ID, process.env.STRIPE_STARTER_ANNUAL_PRICE_ID].filter(Boolean);
    const proPriceIds = [process.env.STRIPE_PRO_PRICE_ID, process.env.STRIPE_PRO_MONTHLY_PRICE_ID, process.env.STRIPE_PRO_ANNUAL_PRICE_ID].filter(Boolean);
    if (starterPriceIds.includes(priceId)) plan = 'starter';
    if (proPriceIds.includes(priceId)) plan = 'pro';
    const status = sub.status; // active, past_due, canceled, trialing, etc.
    const mappedStatus = status === 'canceled' ? 'cancelled' : (status || 'active');
    if (plan) {
      db.prepare("UPDATE users SET plan = ?, subscription_status = ? WHERE stripe_subscription_id = ?").run(plan, mappedStatus, sub.id);
    } else {
      db.prepare("UPDATE users SET subscription_status = ? WHERE stripe_subscription_id = ?").run(mappedStatus, sub.id);
    }
  }

  if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object;
    if (invoice.subscription) {
      db.prepare("UPDATE users SET subscription_status = 'past_due' WHERE stripe_subscription_id = ?").run(invoice.subscription);
    }
  }

  res.json({ received: true });
}

// ─── Admin endpoints ──────────────────────────────────────────────────────────

// Server health endpoint
app.get('/api/admin/health', requireAdmin, (req, res) => {
  try {
    const dbPath = path.join(__dirname, 'data', 'textblast.db');
    const dbSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
    const disk = fs.statfsSync('/');
    const diskTotal = disk.blocks * disk.bsize;
    const diskFree = disk.bfree * disk.bsize;
    const diskUsed = diskTotal - diskFree;
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const activeJobs = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'queued'").get().c;
    const activeCompanions = db.prepare("SELECT COUNT(*) as c FROM api_keys WHERE active = 1 AND last_used_at >= datetime('now', '-90 seconds')").get().c;
    res.json({
      uptime: Math.floor(process.uptime()),
      disk: { total: diskTotal, used: diskUsed, free: diskFree, pct: Math.round((diskUsed / diskTotal) * 100) },
      mem: { total: totalMem, used: usedMem, free: freeMem, pct: Math.round((usedMem / totalMem) * 100) },
      db: { size: dbSize },
      activeJobs,
      activeCompanions,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SaaS metrics — Build 4: fix MRR to exclude admins + admin/manual breakdown
app.get('/api/admin/metrics', requireAdmin, (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  // Paid users: exclude admins and manual accounts
  const paidUsers = db.prepare("SELECT COUNT(*) as c FROM users WHERE plan != 'free' AND subscription_status = 'active' AND manual_account = 0 AND is_admin = 0").get().c;
  // Change 7: count only confirmed sent messages (status='sent') for the current period
  const periodStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const totalSendsMonth = db.prepare("SELECT COUNT(*) as c FROM messages WHERE status = 'sent' AND created_at >= ?").get(periodStart).c || 0;
  const newSignups7d = db.prepare("SELECT COUNT(*) as c FROM users WHERE created_at >= datetime('now', '-7 days')").get().c;
  const churn30d = db.prepare("SELECT COUNT(*) as c FROM users WHERE subscription_status = 'cancelled' AND last_active_at >= datetime('now', '-30 days')").get().c;

  // MRR: only count active Stripe subscriptions (not manual, not free, not cancelled, not admin)
  const paidRows = db.prepare("SELECT plan, billing_interval FROM users WHERE plan != 'free' AND subscription_status = 'active' AND manual_account = 0 AND is_admin = 0").all();
  const mrr = paidRows.reduce((sum, u) => {
    const basePrice = PLANS[u.plan]?.price || 0;
    // Annual plans: $96/yr starter, $288/yr pro (20% off)
    if (u.billing_interval === 'annual') {
      const annualPrice = basePrice === 10 ? 96 : basePrice === 30 ? 288 : basePrice * 12 * 0.8;
      return sum + Math.round((annualPrice / 12) * 100) / 100;
    }
    return sum + basePrice;
  }, 0);
  const arr = mrr * 12;

  // Plan breakdown
  const planBreakdown = {
    free: db.prepare("SELECT COUNT(*) as c FROM users WHERE plan = 'free' AND is_admin = 0 AND manual_account = 0").get().c,
    starterMonthly: db.prepare("SELECT COUNT(*) as c FROM users WHERE plan = 'starter' AND billing_interval = 'monthly' AND subscription_status = 'active' AND is_admin = 0 AND manual_account = 0").get().c,
    starterAnnual: db.prepare("SELECT COUNT(*) as c FROM users WHERE plan = 'starter' AND billing_interval = 'annual' AND subscription_status = 'active' AND is_admin = 0 AND manual_account = 0").get().c,
    proMonthly: db.prepare("SELECT COUNT(*) as c FROM users WHERE plan = 'pro' AND billing_interval = 'monthly' AND subscription_status = 'active' AND is_admin = 0 AND manual_account = 0").get().c,
    proAnnual: db.prepare("SELECT COUNT(*) as c FROM users WHERE plan = 'pro' AND billing_interval = 'annual' AND subscription_status = 'active' AND is_admin = 0 AND manual_account = 0").get().c,
    manual: db.prepare("SELECT COUNT(*) as c FROM users WHERE manual_account = 1 AND is_admin = 0").get().c,
    admins: db.prepare("SELECT COUNT(*) as c FROM users WHERE is_admin = 1").get().c,
  };

  res.json({ totalUsers, paidUsers, totalSendsMonth, newSignups7d, churn30d, mrr, arr, planBreakdown, mrrNote: 'Excludes admins and manual accounts' });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const search = (req.query.search || '').trim();
  const plan = req.query.plan || '';
  const status = req.query.status || '';
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;

  let where = 'WHERE 1=1';
  const params = [];
  if (search) { where += ' AND u.email LIKE ?'; params.push(`%${search}%`); }
  if (plan) { where += ' AND u.plan = ?'; params.push(plan); }
  if (status) { where += ' AND u.subscription_status = ?'; params.push(status); }

  const total = db.prepare(`SELECT COUNT(*) as c FROM users u ${where}`).get(...params).c;
  const users = db.prepare(`
    SELECT u.id, u.email, u.plan, u.monthly_sends, u.period_start, u.is_admin,
           u.created_at, u.last_active_at, u.stripe_subscription_id, u.stripe_customer_id,
           u.subscription_status, u.billing_period_end, u.manual_account, u.plan_expires_at,
           (SELECT COUNT(*) FROM jobs WHERE user_id = u.id) as total_jobs,
           (SELECT last_used_at FROM api_keys WHERE user_id = u.id AND active = 1 ORDER BY last_used_at DESC LIMIT 1) as companion_last_seen
    FROM users u ${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  res.json({ users, total, limit, offset });
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const { email, password, plan = 'free', is_admin = 0, manual = 0 } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (existing) return res.status(409).json({ error: 'Email already exists' });

  const hash = await bcrypt.hash(password, 12);
  const result = db.prepare(
    'INSERT INTO users (email, password_hash, is_admin, plan, subscription_status, manual_account) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(email.toLowerCase().trim(), hash, is_admin ? 1 : 0, plan, manual ? 'manual' : (plan === 'free' ? 'free' : 'active'), manual ? 1 : 0);

  res.status(201).json({ ok: true, id: result.lastInsertRowid });
});

app.patch('/api/admin/users/:id', requireAdmin, (req, res) => {
  const { plan, plan_expires_at, monthly_sends, is_admin, subscription_status, manual_account } = req.body;
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (plan !== undefined && !PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });
  const validStatuses = ['free', 'active', 'past_due', 'canceled', 'manual'];
  if (subscription_status !== undefined && !validStatuses.includes(subscription_status))
    return res.status(400).json({ error: 'Invalid subscription_status' });
  if (monthly_sends !== undefined && (typeof monthly_sends !== 'number' || monthly_sends < 0 || !Number.isInteger(monthly_sends)))
    return res.status(400).json({ error: 'monthly_sends must be a non-negative integer' });
  if (plan_expires_at !== undefined && plan_expires_at !== null && isNaN(Date.parse(plan_expires_at)))
    return res.status(400).json({ error: 'plan_expires_at must be a valid date string or null' });

  if (plan !== undefined) db.prepare('UPDATE users SET plan = ? WHERE id = ?').run(plan, req.params.id);
  // plan_expires_at: null clears the expiry, a date string sets it
  if (plan_expires_at !== undefined) {
    db.prepare('UPDATE users SET plan_expires_at = ? WHERE id = ?').run(plan_expires_at || null, req.params.id);
  }
  if (monthly_sends !== undefined) db.prepare('UPDATE users SET monthly_sends = ? WHERE id = ?').run(monthly_sends, req.params.id);
  if (is_admin !== undefined) db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(is_admin ? 1 : 0, req.params.id);
  if (subscription_status !== undefined) db.prepare('UPDATE users SET subscription_status = ? WHERE id = ?').run(subscription_status, req.params.id);
  if (manual_account !== undefined) db.prepare('UPDATE users SET manual_account = ? WHERE id = ?').run(manual_account ? 1 : 0, req.params.id);

  res.json({ ok: true });
});

// Change 6: Admin generate reset token for user
app.post('/api/admin/users/:id/reset-token', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours
  db.prepare('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?').run(token, expires, user.id);
  const appUrl = process.env.APP_URL || 'https://app.textyourlist.com';
  const resetLink = `${appUrl}/reset-password?token=${token}`;
  res.json({ ok: true, resetLink, email: user.email });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT id, is_admin FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // Prevent deleting yourself
  if (user.id === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });

  // Clean up user data
  db.prepare('DELETE FROM api_keys WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM suppression_list WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM templates WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM contact_lists WHERE user_id = ?').run(req.params.id);
  // Keep jobs/messages/logs for audit trail but nullify user reference
  db.prepare('UPDATE jobs SET user_id = NULL WHERE user_id = ?').run(req.params.id);
  db.prepare('UPDATE send_logs SET user_id = NULL WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);

  res.json({ ok: true });
});

// Change 2: CSV template download
app.get('/api/csv-template', (req, res) => {
  const csv = 'first_name,last_name,phone,special\nJane,Smith,8015551234,COUPON10\nJohn,Doe,8015555678,https://example.com/link\n';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="text-your-list-contacts-template.csv"');
  res.send(csv);
});

// ─── Sitemap ─────────────────────────────────────────────────────────────────

app.get('/sitemap.xml', (req, res) => {
  const base = 'https://app.textyourlist.com';
  const pages = [
    { url: '/', priority: '1.0', changefreq: 'weekly' },
    { url: '/signup', priority: '0.9', changefreq: 'monthly' },
    { url: '/login', priority: '0.5', changefreq: 'monthly' },
    { url: '/privacy', priority: '0.3', changefreq: 'monthly' },
    { url: '/terms', priority: '0.3', changefreq: 'monthly' },
    { url: '/help/companion', priority: '0.6', changefreq: 'monthly' },
    { url: '/help/windows', priority: '0.6', changefreq: 'monthly' },
    { url: '/help/mac', priority: '0.6', changefreq: 'monthly' },
    { url: '/send-texts-individually', priority: '0.8', changefreq: 'monthly' },
    { url: '/church-texting-app', priority: '0.8', changefreq: 'monthly' },
    { url: '/text-from-computer', priority: '0.8', changefreq: 'monthly' },
    { url: '/csv-text-message-sender', priority: '0.8', changefreq: 'monthly' },
    { url: '/texting-for-coaches', priority: '0.8', changefreq: 'monthly' },
  ];
  const today = new Date().toISOString().split('T')[0];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map(p => `  <url>
    <loc>${base}${p.url}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`).join('\n')}
</urlset>`;
  res.setHeader('Content-Type', 'application/xml');
  res.send(xml);
});

app.get('/robots.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.send(`User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /admin\nDisallow: /api/\nSitemap: https://app.textyourlist.com/sitemap.xml\n`);
});

// ─── Companion static files ───────────────────────────────────────────────────

app.use('/companion', express.static(path.join(__dirname, 'companion')));

// ─── Desktop embedded sender ─────────────────────────────────────────────────
// When running as a desktop app (TYL_DESKTOP=1), send messages directly from
// the server process instead of relying on an external companion process.

if (process.env.TYL_DESKTOP) {
  const sendFn = process.platform === 'darwin'
    ? require('./send-mac.js')
    : require('./send-windows.js');

  async function desktopSendLoop() {
    try {
      // Find the next pending message across all users — skip jobs whose owner has an expired/cancelled subscription
      const message = db.prepare(`
        SELECT m.*, j.pace_seconds, j.user_id
        FROM messages m
        JOIN jobs j ON j.id = m.job_id
        JOIN users u ON u.id = j.user_id
        WHERE m.status = 'pending'
          AND j.status = 'queued'
          AND (m.picked_at IS NULL OR m.picked_at < datetime('now', '-90 seconds'))
          AND (
            u.is_admin = 1
            OR u.manual_account = 1
            OR u.plan = 'free'
            OR u.subscription_status = 'active'
            OR (u.subscription_status = 'cancelled' AND u.billing_period_end > date('now'))
          )
        ORDER BY m.created_at ASC
        LIMIT 1
      `).get();

      if (!message) return;

      // Pace enforcement with jitter — carriers flag perfectly rhythmic sends
      if (message.pace_seconds > 0) {
        const lastSent = db.prepare(`
          SELECT sent_at FROM messages
          WHERE job_id = ? AND status = 'sent' AND sent_at IS NOT NULL
          ORDER BY sent_at DESC LIMIT 1
        `).get(message.job_id);
        if (lastSent && lastSent.sent_at) {
          const elapsed = (Date.now() - new Date(lastSent.sent_at + 'Z').getTime()) / 1000;
          // Add deterministic jitter (0–7s) derived from message ID so each message gets a consistent delay
          const idSum = message.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
          const jitter = idSum % 8;
          if (elapsed < message.pace_seconds + jitter) return;
        }
      }

      db.prepare("UPDATE messages SET status='sending', picked_at=datetime('now'), attempts=attempts+1, last_attempt_at=datetime('now') WHERE id=?").run(message.id);
      console.log(`[desktop-sender] picking up message ${message.id} for ${message.phone}`);
      if (process.env.TYL_DESKTOP) process.stdout.write('__TRAY:green__\n');

      try {
        await sendFn(message.phone, message.body);
        db.prepare("UPDATE messages SET status='sent', sent_at=datetime('now'), error=NULL WHERE id=?").run(message.id);
        incrementSendCount(message.user_id, 1);
        log(message.user_id, message.id, message.job_id, message.phone, 'sent');
        console.log(`[desktop-sender] sent → ${message.phone}`);
      } catch (err) {
        const attempts = message.attempts + 1;
        const newStatus = attempts >= 3 ? 'dead' : 'failed';
        db.prepare("UPDATE messages SET status=?, error=?, last_attempt_at=datetime('now') WHERE id=?").run(newStatus, err.message, message.id);
        log(message.user_id, message.id, message.job_id, message.phone, newStatus, err.message);
        console.error(`[desktop-sender] failed → ${message.phone}: ${err.message}`);
      }

      recountJob(message.job_id);
      const remaining = db.prepare("SELECT COUNT(*) as c FROM messages m JOIN jobs j ON j.id = m.job_id WHERE j.status = 'queued' AND m.status IN ('pending','sending')").get();
      if (process.env.TYL_DESKTOP && (!remaining || remaining.c === 0)) process.stdout.write('__TRAY:gray__\n');
    } catch (err) {
      console.error('[desktop-sender] loop error:', err.message);
      if (process.env.TYL_DESKTOP) process.stdout.write('__TRAY:gray__\n');
    }
  }

  // Poll every 5 seconds for pending messages
  setInterval(desktopSendLoop, 5000);
  console.log('[desktop-sender] embedded sender active');
}

// ─── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.TYL_PORT ? parseInt(process.env.TYL_PORT, 10) : (process.env.PORT || 3000);
app.listen(PORT, '127.0.0.1', () => {
  console.log(`TYL server listening on port ${PORT}`);
});
