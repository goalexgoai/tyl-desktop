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

// Poll chat.db after a send to determine if it succeeded or failed.
// Returns: 'delivered' | 'error' | 'timeout'
//
// Apple writes outgoing status to the message table for BOTH services:
//   is_sent=1      → left the Mac (iMessage: reached Apple servers; SMS: relayed to phone)
//   is_delivered=1 → recipient device acknowledged (iMessage only — SMS rarely gets this)
//   error != 0     → failed (iMessage: Android numbers get error ~4000 within 2-3 seconds;
//                    SMS: relay failures, e.g. phone unreachable, also surface here when
//                    chat.db records them — not guaranteed for every carrier failure mode,
//                    but strictly better than the previous no-check-at-all behavior)
// serviceType: 'iMessage' or 'SMS' — must match what buildScript/buildImageScript used,
// otherwise this will never find the row it's looking for.
//
// expectedText (optional): the exact body we just sent. We just captured beforeRowId
// immediately before firing the send, so "newest row after beforeRowId" is normally
// right — but if the user manually sends another text to this same number/service in
// the few seconds we're polling, that row would sort newest and get misattributed to
// this send. When expectedText is given, prefer the candidate row whose text matches
// it exactly (after trim, since Messages can trim a trailing newline we didn't). If no
// candidate matches — different quoting/encoding than we expect — fall back to the
// newest row exactly as before, so this can only improve precision, never regress the
// existing failure-detection into a timeout it wouldn't have hit otherwise.
// Shared row-matching logic between the live 7s poll and the one-shot
// reconciler check (checkDeliveryOnce). Both need to pick the SAME row out of
// chat.db for the same send, so this lives in one place.
// Returns: 'delivered' | 'error' | 'pending' (rows exist but none settled, or
// none found yet) | 'db_error' (the query itself failed — NOT the same as
// "no answer yet"; callers must not treat this as a delivery outcome).
function queryDeliveryRows(db, phone, beforeRowId, serviceType, expectedText) {
  try {
    const normalized = phone.replace(/\D/g, '');
    const phones = [...new Set([phone, normalized, '+1' + normalized, '+' + normalized])];
    const placeholders = phones.map(() => '?').join(',');
    const normText = s => String(s || '').trim();

    const rows = db.prepare(`
      SELECT m.ROWID, m.is_delivered, m.is_sent, m.error, m.text
      FROM message m
      JOIN handle h ON h.ROWID = m.handle_id
      WHERE h.id IN (${placeholders})
        AND m.is_from_me = 1
        AND m.service = ?
        AND m.ROWID > ?
      ORDER BY m.ROWID DESC
      LIMIT 8
    `).all(...phones, serviceType, beforeRowId);

    if (!rows.length) return 'pending';

    const matched = expectedText
      ? rows.find(r => normText(r.text) === normText(expectedText))
      : null;
    const row = matched || rows[0]; // fallback = prior behavior (newest row)

    if (row.error && row.error !== 0) return 'error';
    if (row.is_delivered || row.is_sent) return 'delivered';
    return 'pending';
  } catch {
    return 'db_error';
  }
}

function pollForDelivery(phone, beforeRowId, serviceType = 'iMessage', expectedText = null) {
  return new Promise((resolve) => {
    let Database;
    try { Database = require('better-sqlite3'); } catch { return resolve('timeout'); }

    let db;
    try {
      db = new Database(chatDbPath(), { readonly: true, fileMustExist: true });
    } catch { return resolve('timeout'); }

    const deadline = Date.now() + 7000; // 7 second window

    function check() {
      const result = queryDeliveryRows(db, phone, beforeRowId, serviceType, expectedText);
      if (result === 'delivered' || result === 'error') {
        db.close();
        return resolve(result);
      }
      // 'pending' or 'db_error' — keep polling until the deadline, then give up
      // as 'timeout'. A mid-poll db_error is usually transient (lock contention);
      // worth retrying within the same 7s window rather than failing fast.
      if (Date.now() >= deadline) {
        try { db.close(); } catch {}
        return resolve('timeout');
      }
      setTimeout(check, 400);
    }

    check();
  });
}

// One-shot (non-looping) check used by the background reconciler in server.js.
// Opens its own short-lived read-only connection, asks once, closes. Distinct
// from pollForDelivery: no 7s wait loop — the reconciler itself is the loop,
// running on its own ~20s cadence across many messages.
// Returns: 'delivered' | 'error' | 'pending' | 'db_error'
function checkDeliveryOnce(phone, beforeRowId, serviceType, expectedText) {
  let Database;
  try { Database = require('better-sqlite3'); } catch { return 'db_error'; }
  let db;
  try {
    db = new Database(chatDbPath(), { readonly: true, fileMustExist: true });
  } catch { return 'db_error'; }
  try {
    return queryDeliveryRows(db, phone, beforeRowId, serviceType, expectedText);
  } finally {
    try { db.close(); } catch {}
  }
}

async function ensureMessagesRunning() {
  let currentUserHasMessages = false;
  try {
    const out = execSync(`pgrep -u ${process.getuid()} -x Messages`, { encoding: 'utf8' }).trim();
    currentUserHasMessages = !!out;
  } catch (_) {}

  if (!currentUserHasMessages) {
    // If another user has Messages open (Fast User Switching), plain 'open -a Messages'
    // just activates their instance instead of launching one for the current user.
    // Use -n to force a new instance scoped to this user's session.
    let otherUserHasMessages = false;
    try {
      const out = execSync('pgrep -x Messages', { encoding: 'utf8' }).trim();
      otherUserHasMessages = !!out;
    } catch (_) {}
    const openCmd = otherUserHasMessages ? 'open -n -a Messages' : 'open -a Messages';
    execSync(openCmd, { timeout: 5000 });
    if (!messagesLaunched) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  messagesLaunched = true;
}

function buildScript(serviceType, number, tmpFile) {
  const safeNum = number.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `
set msgBody to (do shell script "cat " & quoted form of "${tmpFile}")
tell application "Messages"
  try
    set svc to first service whose service type = ${serviceType}
  on error
    set svc to first service
  end try
  set p to participant "${safeNum}" of svc
  send msgBody to p
end tell
`;
}

function buildImageScript(serviceType, number, imagePath) {
  const safeNum = number.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const safePath = imagePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `tell application "Messages"
  try
    set svc to first service whose service type = ${serviceType}
  on error
    set svc to first service
  end try
  set p to participant "${safeNum}" of svc
  send POSIX file "${safePath}" to p
end tell`;
}

// Send image + text (if any) using the specified service.
// stagedImgPath must already be in /tmp (use stageTmpImage before calling).
// Throws on a confirmed send failure so the caller's existing error handling
// (pause/retry/dead-letter logic in server.js) applies — this used to only
// happen for iMessage; SMS sends were trusted unconditionally the moment the
// osascript command returned, with no check that the relay actually worked.
//
// Resolves { confirmed: true } when chat.db positively confirmed delivery (or
// verification wasn't possible at all, e.g. no Full Disk Access — nothing to
// be unconfirmed about). Resolves { confirmed: false, chatBeforeRowId,
// chatService } when the 7s poll window closed with no settled answer either
// way — the caller (server.js) persists chatBeforeRowId/chatService on the
// message row so the background reconciler can re-check the SAME chat.db rows
// later instead of re-deriving "which row was this" from phone+time.
async function executeSend(serviceType, number, tmpFile, stagedImgPath) {
  const rawText = fs.readFileSync(tmpFile, 'utf8');
  const hasText = !!rawText.trim();
  if (stagedImgPath && fs.existsSync(stagedImgPath)) {
    await runOsascript(['-e', buildImageScript(serviceType, number, stagedImgPath)]);
    // Pause so Messages queues the image before the text bubble arrives
    await new Promise(r => setTimeout(r, 800));
  }
  if (hasText) {
    const canVerify = canReadChatDb();
    const beforeRowId = canVerify ? getMaxMessageRowId() : 0;
    await runOsascript(['-e', buildScript(serviceType, number, tmpFile)]);
    if (canVerify) {
      const result = await pollForDelivery(number, beforeRowId, serviceType, rawText);
      if (result === 'error') {
        throw new Error(`${serviceType} delivery failed — relay reported an error`);
      }
      if (result === 'timeout') {
        return { confirmed: false, chatBeforeRowId: beforeRowId, chatService: serviceType };
      }
      // 'delivered' → confirmed.
    }
  }
  return { confirmed: true };
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
      return await executeSend('iMessage', number, tmp, stagedImg);
    }
    if (cached === 'sms') {
      return await executeSend('SMS', number, tmp, stagedImg);
    }

    // ── Persistent chat.db handle lookup (survives restarts) ─────────────────
    if (canReadChatDb()) {
      const knownRoute = lookupKnownRoute(number);
      if (knownRoute === 'imessage') {
        routingCache.set(number, 'imessage');
        return await executeSend('iMessage', number, tmp, stagedImg);
      }
      if (knownRoute === 'sms') {
        routingCache.set(number, 'sms');
        return await executeSend('SMS', number, tmp, stagedImg);
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
        const result = await pollForDelivery(number, beforeRowId, 'iMessage', message);

        if (result === 'delivered') {
          routingCache.set(number, 'imessage');
          return { confirmed: true };
        }

        if (result === 'error') {
          // iMessage failed (Android) — resend both image and text via SMS.
          routingCache.set(number, 'sms');
          return await executeSend('SMS', number, tmp, stagedImg);
        }

        // Timeout — iMessage delivery unconfirmed for unknown number.
        // Fall back to SMS to guarantee delivery rather than silently dropping the message.
        // Risk of double-delivery is accepted; silent failure is not.
        routingCache.set(number, 'sms');
        return await executeSend('SMS', number, tmp, stagedImg);
      } else {
        // Image-only send to unknown number: iMessage already attempted above.
        // Fall back to SMS as well to match text behavior.
        routingCache.set(number, 'sms');
        return await executeSend('SMS', number, tmp, null); // image already sent via iMessage attempt
      }
    }

    // ── Fallback: no Full Disk Access — try iMessage first, SMS on error ────
    // Prefer iMessage since it works without SMS relay. Fall back to SMS only
    // if iMessage throws (e.g. no iMessage service configured on this profile).
    try {
      return await executeSend('iMessage', number, tmp, stagedImg);
    } catch {
      return await executeSend('SMS', number, tmp, stagedImg);
    }

  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
    if (stagedImg) try { fs.unlinkSync(stagedImg); } catch (_) {}
  }
};

// Used by server.js's background reconciler to re-check an 'unconfirmed'
// message against chat.db without the module's default-export send path.
module.exports.checkDeliveryOnce = checkDeliveryOnce;
module.exports.canReadChatDb = canReadChatDb;
module.exports.queryDeliveryRows = queryDeliveryRows; // exported for unit tests (pure, DB-shape-only)
