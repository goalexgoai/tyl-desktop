const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

let messagesLaunched = false;

// Per-session routing cache: phone → 'imessage' | 'sms'
// Set on first successful detection; avoids the poll delay on every subsequent send.
const routingCache = new Map();

function chatDbPath() {
  return path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
}

function canReadChatDb() {
  try {
    fs.accessSync(chatDbPath(), fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function getMaxMessageRowId() {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(chatDbPath(), { readonly: true, fileMustExist: true });
    const row = db.prepare('SELECT MAX(ROWID) as m FROM message').get();
    db.close();
    return row ? (row.m || 0) : 0;
  } catch {
    return 0;
  }
}

// Poll chat.db after an iMessage send to determine if it succeeded or failed.
// Returns: 'delivered' | 'error' | 'timeout'
//
// Apple writes outgoing iMessage status to the message table:
//   is_sent=1      → reached Apple servers (iMessage number confirmed)
//   is_delivered=1 → recipient device acknowledged
//   error != 0     → failed (Android numbers get error ~4000 within 2-3 seconds)
function pollForDelivery(phone, beforeRowId) {
  return new Promise((resolve) => {
    let Database;
    try { Database = require('better-sqlite3'); } catch { return resolve('timeout'); }

    let db;
    try {
      db = new Database(chatDbPath(), { readonly: true, fileMustExist: true });
    } catch { return resolve('timeout'); }

    // Try multiple number formats: raw, digits-only, +1XXXXXXXXXX, +XXXXXXXXXX
    const normalized = phone.replace(/\D/g, '');
    const phones = [...new Set([phone, normalized, '+1' + normalized, '+' + normalized])];
    const placeholders = phones.map(() => '?').join(',');

    const deadline = Date.now() + 7000; // 7 second window

    function check() {
      try {
        const row = db.prepare(`
          SELECT m.ROWID, m.is_delivered, m.is_sent, m.error
          FROM message m
          JOIN handle h ON h.ROWID = m.handle_id
          WHERE h.id IN (${placeholders})
            AND m.is_from_me = 1
            AND m.service = 'iMessage'
            AND m.ROWID > ?
          ORDER BY m.ROWID DESC
          LIMIT 1
        `).get(...phones, beforeRowId);

        if (!row) {
          if (Date.now() >= deadline) { db.close(); return resolve('timeout'); }
          return setTimeout(check, 400);
        }

        if (row.error && row.error !== 0) {
          db.close(); return resolve('error');
        }
        if (row.is_delivered || row.is_sent) {
          db.close(); return resolve('delivered');
        }

        // Found but outcome not yet settled
        if (Date.now() >= deadline) { db.close(); return resolve('timeout'); }
        setTimeout(check, 400);
      } catch {
        try { db.close(); } catch {}
        resolve('timeout');
      }
    }

    check();
  });
}

async function ensureMessagesRunning() {
  try {
    const procs = execSync('pgrep -x Messages', { encoding: 'utf8' }).trim();
    if (!procs) throw new Error('not running');
    messagesLaunched = true;
  } catch (_) {
    execSync('open -a Messages', { timeout: 5000 });
    if (!messagesLaunched) {
      await new Promise(r => setTimeout(r, 3000));
      messagesLaunched = true;
    }
  }
}

function buildScript(serviceType, number, tmpFile) {
  const safeNum = number.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `
set msgBody to (do shell script "cat " & quoted form of "${tmpFile}")
tell application "Messages"
  set svc to first service whose service type = ${serviceType}
  set p to participant "${safeNum}" of svc
  send msgBody to p
end tell
`;
}

module.exports = async function sendViaMac(number, message) {
  const tmp = path.join(os.tmpdir(), `tyl_${Date.now()}.txt`);
  fs.writeFileSync(tmp, message, 'utf8');

  try {
    await ensureMessagesRunning();

    // ── Cached routing decision ──────────────────────────────────────────────
    const cached = routingCache.get(number);
    if (cached === 'imessage') {
      execFileSync('osascript', ['-e', buildScript('iMessage', number, tmp)], { timeout: 30000 });
      return true;
    }
    if (cached === 'sms') {
      execFileSync('osascript', ['-e', buildScript('SMS', number, tmp)], { timeout: 30000 });
      return true;
    }

    // ── Smart routing: iMessage-first with chat.db delivery check ────────────
    if (canReadChatDb()) {
      const beforeRowId = getMaxMessageRowId();

      execFileSync('osascript', ['-e', buildScript('iMessage', number, tmp)], { timeout: 30000 });

      const result = await pollForDelivery(number, beforeRowId);

      if (result === 'delivered') {
        routingCache.set(number, 'imessage');
        return true;
      }

      if (result === 'error') {
        // iMessage failed (Android) — send via SMS relay and cache
        routingCache.set(number, 'sms');
        execFileSync('osascript', ['-e', buildScript('SMS', number, tmp)], { timeout: 30000 });
        return true;
      }

      // Timeout — message reached Apple servers but delivery unconfirmed.
      // Don't double-send via SMS. Don't cache (try smart routing again next send).
      return true;
    }

    // ── Fallback: no Full Disk Access — use SMS relay ────────────────────────
    // iPhone makes the iMessage vs SMS decision when paired.
    execFileSync('osascript', ['-e', buildScript('SMS', number, tmp)], { timeout: 30000 });
    return true;

  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
};
