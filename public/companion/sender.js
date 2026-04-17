#!/usr/bin/env node
/**
 * Text Your List Mac Companion Sender
 *
 * Polls the Text Your List server for pending messages and sends them
 * through the macOS Messages app via AppleScript.
 *
 * Requirements:
 *   - macOS with Messages app
 *   - iPhone linked to Messages (for SMS/iMessage)
 *   - Node.js >= 18
 *
 * Setup:
 *   1. Copy config.example.json -> config.json
 *   2. Fill in apiUrl and apiKey
 *   3. node sender.js
 */

'use strict';

const { execFileSync } = require('child_process');
const { existsSync, readFileSync, writeFileSync, unlinkSync } = require('fs');
const { createServer } = require('http');
const { join } = require('path');
const os = require('os');

// ── Config ─────────────────────────────────────────────────────────────────

const configPath = process.env.CONFIG_PATH || join(__dirname, 'config.json');
if (!existsSync(configPath)) {
  console.error(`
  No config.json found. Create one from config.example.json:

    cp config.example.json config.json
    # then edit it with your apiUrl and apiKey
`);
  process.exit(1);
}

let config;
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error('Failed to parse config.json:', err.message);
  process.exit(1);
}

const {
  apiUrl,
  apiKey,
  paceSeconds = 30,
  pollIntervalSeconds = 10,
  maxRetries = 3,
  mode = 'single',        // 'single' = manual trigger, 'batch' = auto-poll
  port = 7777,            // local HTTP port for status/control
  service = 'iMessage',   // 'iMessage' or 'SMS'
} = config;

if (!apiUrl) { console.error('config.json: apiUrl is required'); process.exit(1); }
if (!apiKey) { console.error('config.json: apiKey is required'); process.exit(1); }

// ── Logging ────────────────────────────────────────────────────────────────

let sent = 0, failed = 0, totalPolls = 0;

function log(level, msg) {
  const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const prefix = { INFO: '  ', WARN: '! ', ERR: 'x ', SEND: '> ', OK: 'v ' };
  console.log(`[${ts}] ${prefix[level] || ''}${msg}`);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, apiUrl);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? require('https') : require('http');

    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function poll() {
  totalPolls++;
  const res = await request('GET', '/api/poll');
  if (res.status !== 200) throw new Error(`Poll failed: HTTP ${res.status}`);
  return res.body;
}

async function ack(messageId, status, error = null) {
  const res = await request('POST', '/api/ack', { message_id: messageId, status, error });
  if (res.status !== 200) throw new Error(`Ack failed: HTTP ${res.status}`);
}

// ── AppleScript sender ────────────────────────────────────────────────────

function escapeAppleScript(str) {
  // Escape backslashes first, then quotes, then handle newlines
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n/g, '\\n');
}

function sendViaMessages(phone, body) {
  const escapedBody = escapeAppleScript(body);
  const escapedPhone = escapeAppleScript(phone);

  // Try iMessage first; if service not found, fall back gracefully
  const script = `
on run
  tell application "Messages"
    set didSend to false

    -- Try iMessage
    repeat with svc in services
      if service type of svc is iMessage then
        try
          set tgt to buddy "${escapedPhone}" of svc
          send "${escapedBody}" to tgt
          set didSend to true
          exit repeat
        end try
      end if
    end repeat

    -- Fall back to first available service
    if not didSend then
      set svc to 1st service of services
      try
        set tgt to buddy "${escapedPhone}" of svc
        send "${escapedBody}" to tgt
        set didSend to true
      end try
    end if

    if not didSend then
      error "Could not find a service to send via"
    end if
  end tell
end run`;

  const tmpFile = join(os.tmpdir(), `tbsend_${Date.now()}_${process.pid}.applescript`);
  try {
    writeFileSync(tmpFile, script, 'utf8');
    execFileSync('osascript', [tmpFile], { timeout: 30000 });
  } finally {
    try { unlinkSync(tmpFile); } catch (_) {}
  }
}

// ── Core send logic ───────────────────────────────────────────────────────

async function sendNext() {
  const { message } = await poll();
  if (!message) {
    log('INFO', 'No pending messages');
    return false;
  }

  const { id, phone, body } = message;
  log('SEND', `Sending to ${phone} (${id.slice(0, 8)}…)`);

  try {
    sendViaMessages(phone, body);
    await ack(id, 'sent');
    log('OK', `Sent to ${phone}`);
    sent++;
    return true;
  } catch (err) {
    const errMsg = err.message || String(err);
    await ack(id, 'failed', errMsg.slice(0, 500)).catch(() => {});
    log('ERR', `Failed ${phone}: ${errMsg}`);
    failed++;
    return false;
  }
}

// ── Modes ─────────────────────────────────────────────────────────────────

async function runSingleMode() {
  log('INFO', `Single-send mode. Listening for manual trigger on http://localhost:${port}`);
  log('INFO', `POST http://localhost:${port}/send to trigger one send`);
  log('INFO', `GET  http://localhost:${port}/status for stats`);

  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && req.url === '/status') {
      res.end(JSON.stringify({ mode: 'single', sent, failed, totalPolls, uptime: process.uptime() }));
    } else if (req.method === 'POST' && req.url === '/send') {
      try {
        const hadMessage = await sendNext();
        res.end(JSON.stringify({ ok: true, hadMessage, sent, failed }));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  server.listen(port, '127.0.0.1', () => {
    log('INFO', `Control server ready on port ${port}`);
  });
}

async function runBatchMode() {
  log('INFO', `Batch mode — polling every ${pollIntervalSeconds}s, pace ${paceSeconds}s between sends`);

  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const hadMessage = await sendNext();
      if (hadMessage && paceSeconds > 0) {
        log('INFO', `Pacing — waiting ${paceSeconds}s before next`);
        await sleep(paceSeconds * 1000);
      }
    } catch (err) {
      log('ERR', `Poll/send error: ${err.message}`);
    } finally {
      running = false;
    }
  }

  // Also run a local status server in batch mode
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/status') {
      res.end(JSON.stringify({ mode: 'batch', sent, failed, totalPolls, uptime: process.uptime() }));
    } else if (req.method === 'POST' && req.url === '/pause') {
      // Simple toggle — not implemented, just respond
      res.end(JSON.stringify({ ok: true, message: 'Stop the process to pause batch mode' }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });
  server.listen(port, '127.0.0.1');
  log('INFO', `Status: GET http://localhost:${port}/status`);

  setInterval(tick, pollIntervalSeconds * 1000);
  tick(); // run immediately
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Start ──────────────────────────────────────────────────────────────────

log('INFO', `Text Your List Companion starting`);
log('INFO', `Server: ${apiUrl}`);
log('INFO', `Mode: ${mode}`);

if (mode === 'batch') {
  runBatchMode().catch(err => { log('ERR', err.message); process.exit(1); });
} else {
  runSingleMode().catch(err => { log('ERR', err.message); process.exit(1); });
}

// Graceful shutdown
process.on('SIGINT', () => {
  log('INFO', `Shutting down. Sent: ${sent}, Failed: ${failed}`);
  process.exit(0);
});
process.on('SIGTERM', () => {
  log('INFO', `Shutting down. Sent: ${sent}, Failed: ${failed}`);
  process.exit(0);
});
