const { execSync, execFile } = require('child_process');

function runOsascript(args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile('osascript', args, { timeout }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}
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

function buildImageScript(serviceType, number, imagePath) {
  const safeNum = number.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const safePath = imagePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `tell application "Messages"
  set svc to first service whose service type = ${serviceType}
  set p to participant "${safeNum}" of svc
  send POSIX file "${safePath}" to p
end tell`;
}

// Send image + text (if any) using the specified service.
// stagedImgPath must already be in /tmp (use stageTmpImage before calling).
async function executeSend(serviceType, number, tmpFile, stagedImgPath) {
  const hasText = !!fs.readFileSync(tmpFile, 'utf8').trim();
  if (stagedImgPath && fs.existsSync(stagedImgPath)) {
    await runOsascript(['-e', buildImageScript(serviceType, number, stagedImgPath)]);
    // Pause so Messages queues the image before the text bubble arrives
    await new Promise(r => setTimeout(r, 800));
  }
  if (hasText) {
    await runOsascript(['-e', buildScript(serviceType, number, tmpFile)]);
  }
}

// Look up a number's known route from chat.db handle table.
// Returns 'imessage' | 'sms' | 'unknown'.
// This is a persistent cache across restarts — unlike routingCache which resets per session.
function lookupKnownRoute(phone) {
  let db;
  try {
    const Database = require('better-sqlite3');
    db = new Database(chatDbPath(), { readonly: true, fileMustExist: true });
    const digits = phone.replace(/\D/g, '');
    const variants = new Set([phone, digits]);
    if (digits.length === 10) {
      variants.add('+1' + digits); // US 10-digit → E.164
    } else if (digits.length === 11 && digits.startsWith('1')) {
      variants.add('+' + digits);  // 1XXXXXXXXXX → +1XXXXXXXXXX
    }
    const varArr = [...variants];
    const placeholders = varArr.map(() => '?').join(',');
    // A confirmed outgoing iMessage (is_sent=1, no error) is the only reliable signal
    // that a number is iMessage-capable. Merely having an iMessage handle is NOT enough —
    // failed sends to Android numbers also create iMessage handles in chat.db.
    const iMsgRow = db.prepare(`
      SELECT 1 FROM message m
      JOIN handle h ON h.ROWID = m.handle_id
      WHERE h.id IN (${placeholders})
        AND m.is_from_me = 1
        AND m.service = 'iMessage'
        AND m.is_sent = 1
        AND (m.error IS NULL OR m.error = 0)
      LIMIT 1
    `).get(...varArr);
    if (iMsgRow) return 'imessage';

    const smsRow = db.prepare(`
      SELECT 1 FROM handle WHERE id IN (${placeholders}) AND service = 'SMS' LIMIT 1
    `).get(...varArr);
    if (smsRow) return 'sms';

    return 'unknown';
  } catch {
    return 'unknown';
  } finally {
    try { if (db) db.close(); } catch {}
  }
}

// Copy image to /tmp so Messages.app can always access it regardless of TCC
// restrictions on Application Support directories. Returns the tmp path.
function stageTmpImage(imagePath) {
  const ext = path.extname(imagePath) || '.jpg';
  const tmpImg = path.join(os.tmpdir(), `tyl_img_${Date.now()}${ext}`);
  fs.copyFileSync(imagePath, tmpImg);
  return tmpImg;
}

module.exports = async function sendViaMac(number, message, imagePath) {
  const tmp = path.join(os.tmpdir(), `tyl_${Date.now()}.txt`);
  fs.writeFileSync(tmp, message || '', 'utf8');
  const hasText = !!(message && message.trim());
  const hasImage = !!(imagePath && fs.existsSync(imagePath));
  let stagedImg = null;

  try {
    if (hasImage) stagedImg = stageTmpImage(imagePath);
    await ensureMessagesRunning();

    // ── Session cache (in-memory, resets on restart) ─────────────────────────
    const cached = routingCache.get(number);
    if (cached === 'imessage') {
      await executeSend('iMessage', number, tmp, stagedImg);
      return true;
    }
    if (cached === 'sms') {
      await executeSend('SMS', number, tmp, stagedImg);
      return true;
    }

    // ── Persistent chat.db handle lookup (survives restarts) ─────────────────
    if (canReadChatDb()) {
      const knownRoute = lookupKnownRoute(number);
      if (knownRoute === 'imessage') {
        routingCache.set(number, 'imessage');
        await executeSend('iMessage', number, tmp, stagedImg);
        return true;
      }
      if (knownRoute === 'sms') {
        routingCache.set(number, 'sms');
        await executeSend('SMS', number, tmp, stagedImg);
        return true;
      }

      // ── Unknown number: iMessage-first with delivery poll ────────────────────
      // Send image first (if any) via iMessage — osascript doesn't throw for Android
      // numbers immediately; the error shows up in chat.db within a few seconds.
      if (stagedImg) {
        await runOsascript(['-e', buildImageScript('iMessage', number, stagedImg)]);
        await new Promise(r => setTimeout(r, 800));
      }

      if (hasText) {
        // Use text send to probe delivery and detect routing.
        const beforeRowId = getMaxMessageRowId();
        await runOsascript(['-e', buildScript('iMessage', number, tmp)]);
        const result = await pollForDelivery(number, beforeRowId);

        if (result === 'delivered') {
          routingCache.set(number, 'imessage');
          return true;
        }

        if (result === 'error') {
          // iMessage failed (Android) — resend both image and text via SMS.
          routingCache.set(number, 'sms');
          await executeSend('SMS', number, tmp, stagedImg);
          return true;
        }

        // Timeout — iMessage delivery unconfirmed for unknown number.
        // Fall back to SMS to guarantee delivery rather than silently dropping the message.
        // Risk of double-delivery is accepted; silent failure is not.
        routingCache.set(number, 'sms');
        await executeSend('SMS', number, tmp, stagedImg);
        return true;
      } else {
        // Image-only send to unknown number: iMessage already attempted above.
        // Fall back to SMS as well to match text behavior.
        routingCache.set(number, 'sms');
        await executeSend('SMS', number, tmp, null); // image already sent via iMessage attempt
        return true;
      }
    }

    // ── Fallback: no Full Disk Access — use SMS relay ────────────────────────
    await executeSend('SMS', number, tmp, stagedImg);
    return true;

  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
    if (stagedImg) try { fs.unlinkSync(stagedImg); } catch (_) {}
  }
};
