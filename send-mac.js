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
// debugOut (optional): a plain object this mutates in place with the row it
// actually judged, purely for diagnostic logging (2026-10-29 Android-SMS
// investigation) — never read by any decision logic, safe to omit.
function queryDeliveryRows(db, phone, beforeRowId, serviceType, expectedText, debugOut) {
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

    if (!rows.length) {
      if (debugOut) Object.assign(debugOut, { rowsSeen: 0 });
      return 'pending';
    }

    const matched = expectedText
      ? rows.find(r => normText(r.text) === normText(expectedText))
      : null;
    const row = matched || rows[0]; // fallback = prior behavior (newest row)
    if (debugOut) {
      Object.assign(debugOut, {
        rowsSeen: rows.length, textMatched: !!matched, rowid: row.ROWID,
        is_sent: row.is_sent, is_delivered: row.is_delivered, error: row.error,
      });
    }

    if (row.error && row.error !== 0) return 'error';
    // Field evidence (2026-10-29): a known-Android number kept getting
    // classified "delivered" via iMessage on is_sent=1 alone, even though it
    // was never actually received ("Not Delivered" in Messages.app's own UI).
    // is_sent=1 means "handed to the send queue" — true for Android numbers
    // too, since iMessage queues unconditionally and Apple frequently never
    // writes back a nonzero error for this failure mode. Only is_delivered
    // (a real network ack from the recipient's device) proves an iMessage
    // actually succeeded. SMS has no equivalent device-ack in practice, so
    // is_sent remains the right (only) signal there.
    if (serviceType === 'iMessage') {
      if (row.is_delivered) return 'delivered';
    } else if (row.is_delivered || row.is_sent) {
      return 'delivered';
    }
    return 'pending';
  } catch {
    return 'db_error';
  }
}

function pollForDelivery(phone, beforeRowId, serviceType = 'iMessage', expectedText = null, debugOut) {
  return new Promise((resolve) => {
    let Database;
    try { Database = require('better-sqlite3'); } catch { return resolve('timeout'); }

    let db;
    try {
      db = new Database(chatDbPath(), { readonly: true, fileMustExist: true });
    } catch { return resolve('timeout'); }

    const deadline = Date.now() + 7000; // 7 second window

    function check() {
      const result = queryDeliveryRows(db, phone, beforeRowId, serviceType, expectedText, debugOut);
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
    error "TYL_SERVICE_UNAVAILABLE:${serviceType}"
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
    error "TYL_SERVICE_UNAVAILABLE:${serviceType}"
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
// debugCtx (optional, diagnostic only, 2026-10-29 Android-SMS investigation):
// { tag, sendId } — when given, attaches { _debug: { sendId, tag, serviceType,
// pollResult, row... } } to the resolved object (or, on a confirmed delivery
// failure, to the thrown Error as err._debug — a first pass of this omitted
// that, silently losing diagnostics on exactly the case most worth seeing) so
// the caller can report exactly which row this send's verification judged.
// sendId correlates a probe attempt with its own SMS fallback as one logical
// send. Never read by any decision logic here.
async function executeSend(serviceType, number, tmpFile, stagedImgPath, debugCtx) {
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
      const rowDebug = debugCtx ? {} : undefined;
      const result = await pollForDelivery(number, beforeRowId, serviceType, rawText, rowDebug);
      const _debug = debugCtx ? { sendId: debugCtx.sendId, tag: debugCtx.tag, serviceType, pollResult: result, ...rowDebug } : undefined;
      if (result === 'error') {
        const err = new Error(`${serviceType} delivery failed — relay reported an error`);
        if (_debug) err._debug = _debug;
        throw err;
      }
      if (result === 'timeout') {
        return { confirmed: false, chatBeforeRowId: beforeRowId, chatService: serviceType, _debug };
      }
      // 'delivered' → confirmed.
      return { confirmed: true, _debug };
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
    // Field evidence (2026-10-29): a number that was iMessage-capable in the
    // past (recipient had an iPhone, later switched to Android) keeps old
    // successful iMessage rows in chat.db forever. The original query here
    // asked "has ANY iMessage send to this number ever succeeded" with no
    // ORDER BY — so it could match that stale old row and classify the
    // number as iMessage-capable permanently, even after every subsequent
    // send started failing ("Not Delivered"). First fix (v1.0.101): only
    // trust the MOST RECENT iMessage attempt. That alone wasn't enough —
    // it still read is_sent=1 as "success," but is_sent just means "handed
    // to the send queue," true for Android numbers too; Apple frequently
    // never writes back a nonzero error for this failure mode either. Only
    // is_delivered (a real network ack from the recipient's device) proves
    // the most recent attempt actually succeeded.
    const lastIMsg = db.prepare(`
      SELECT m.is_sent, m.is_delivered, m.error
      FROM message m
      JOIN handle h ON h.ROWID = m.handle_id
      WHERE h.id IN (${placeholders})
        AND m.is_from_me = 1
        AND m.service = 'iMessage'
      ORDER BY m.ROWID DESC
      LIMIT 1
    `).get(...varArr);
    if (lastIMsg) {
      const failed = !!(lastIMsg.error && lastIMsg.error !== 0);
      if (failed) return 'sms'; // most recent iMessage attempt to this number failed — don't repeat it
      if (lastIMsg.is_delivered) return 'imessage';
      // is_sent=1 with no error and no is_delivered yet is inconclusive —
      // fall through to the SMS-handle check / 'unknown', which triggers a
      // fresh probe (iMessage attempt with a real 7s delivery poll, falling
      // back to SMS on timeout) rather than trusting a queued-but-unproven send.
    }

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
  // Diagnostic only (2026-10-29 Android-SMS investigation): correlates a
  // probe attempt with its own SMS fallback as one logical send, since both
  // share the same branch tag (e.g. 'unknown_probe_timeout_fallback_sms')
  // but are two separate executeSend calls. Remove dbg()/sendId once resolved.
  const sendId = Math.random().toString(36).slice(2, 8);
  const dbg = (tag) => ({ tag, sendId });

  try {
    if (hasImage) stagedImg = stageTmpImage(imagePath);
    await ensureMessagesRunning();

    // ── Session cache (in-memory, resets on restart) ─────────────────────────
    const cached = routingCache.get(number);
    if (cached === 'imessage') {
      return await executeSend('iMessage', number, tmp, stagedImg, dbg('cached_imessage'));
    }
    if (cached === 'sms') {
      return await executeSend('SMS', number, tmp, stagedImg, dbg('cached_sms'));
    }

    // ── Persistent chat.db handle lookup (survives restarts) ─────────────────
    if (canReadChatDb()) {
      const knownRoute = lookupKnownRoute(number);
      if (knownRoute === 'imessage') {
        routingCache.set(number, 'imessage');
        return await executeSend('iMessage', number, tmp, stagedImg, dbg('known_imessage'));
      }
      if (knownRoute === 'sms') {
        routingCache.set(number, 'sms');
        return await executeSend('SMS', number, tmp, stagedImg, dbg('known_sms'));
      }

      // ── Unknown number: SMS is the resilient default (2026-10-29 policy
      // change) ──────────────────────────────────────────────────────────────
      // This used to probe iMessage first (send it, poll chat.db up to 7s,
      // fall back to SMS on error/timeout). That was a speculative iMessage
      // attempt as the PRIMARY delivery path for a number we have no real
      // evidence about — and it's exactly how a known-Android number kept
      // going out blue and silently failing for an entire day of live
      // testing (2026-10-29): AppleScript's iMessage send never throws for a
      // wrong number (it just queues), so the only thing that could catch it
      // was the chat.db poll — and when chat.db access itself wasn't working
      // (confirmed separately, diagnostic instrumentation showed it never
      // even ran), there was nothing left to catch the failure at all.
      // This product's very first version (before any "smart routing" existed)
      // used SMS exclusively for precisely this reason — see the original
      // design note, since removed: "There is no synchronous error for 'this
      // number isn't on iMessage.'" SMS reliably reaches both iPhone and
      // Android when Text Message Forwarding is configured; iMessage only
      // reaches iPhone. A number only earns the iMessage route through
      // lookupKnownRoute's VERIFIED is_delivered=1 history above — never a
      // live, unproven guess. The cost is iPhone recipients see a green text
      // instead of blue on their first message from this list; the benefit is
      // no more silent non-delivery.
      routingCache.set(number, 'sms');
      return await executeSend('SMS', number, tmp, stagedImg, dbg('unknown_default_sms'));
    }

    // ── Fallback: no Full Disk Access (or chat.db otherwise unreadable) ────
    // Same resilient-default reasoning as above, and doubly so here: with no
    // chat.db access at all, there is no verification step of any kind — an
    // iMessage-first attempt here has zero safety net. SMS first; iMessage
    // only as a last resort if SMS itself isn't available on this Mac at all.
    try {
      return await executeSend('SMS', number, tmp, stagedImg, dbg('no_fda_sms'));
    } catch {
      return await executeSend('iMessage', number, tmp, stagedImg, dbg('no_fda_fallback_imessage'));
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
module.exports.buildScript = buildScript; // exported for unit tests (pure string-builder)
module.exports.buildImageScript = buildImageScript; // exported for unit tests (pure string-builder)
module.exports.lookupKnownRoute = lookupKnownRoute; // exported for unit tests (mocks better-sqlite3)
