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

// Whether this process can actually read chat.db right now.
//
// This used to be fs.accessSync(R_OK). access() does NOT go through macOS's
// TCC (Full Disk Access) gate — Apple DTS: "you have to actually try opening
// the file" — so it is not a valid FDA probe. main.js's setup-wizard check
// was switched to a real open for exactly this reason back in ec26989
// (2026-04-20), but this copy was never updated. Field evidence (2026-10-29):
// zero send_debug events across every Mac send on v1.0.103/104 with the FDA
// toggle ON, i.e. this returned false every time and none of the chat.db
// routing/verification ever ran — which is why known iPhone contacts went
// green. Now we open chat.db the same way the real queries do and run one.
//
// lastChatDbError keeps the failure reason (e.g. EPERM vs SQLITE_CANTOPEN)
// for telemetry, so a remaining access problem is diagnosable from our side.
let lastChatDbError = null;
let chatDbCheck = { ok: false, at: 0 };
function canReadChatDb() {
  // Brief cache: called per send and by the 20s reconciler. Short TTL on a
  // failure so a fresh grant is picked up quickly.
  const ttl = chatDbCheck.ok ? 30000 : 5000;
  if (Date.now() - chatDbCheck.at < ttl) return chatDbCheck.ok;
  let db;
  try {
    const Database = require('better-sqlite3');
    db = new Database(chatDbPath(), { readonly: true, fileMustExist: true });
    db.prepare('SELECT ROWID FROM message LIMIT 1').get();
    lastChatDbError = null;
    chatDbCheck = { ok: true, at: Date.now() };
  } catch (err) {
    lastChatDbError = (err && (err.code || err.message)) || 'unknown';
    chatDbCheck = { ok: false, at: Date.now() };
  } finally {
    try { if (db) db.close(); } catch {}
  }
  return chatDbCheck.ok;
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

// Decide a number's route from its chat.db history.
// Returns 'imessage' | 'sms' | 'unknown'. Pure — exported for unit tests.
//
// rows: this number's recent messages, NEWEST FIRST, each
//   { service, is_from_me, is_delivered, error, style }
// (style = chat.style: 45 = 1:1, 43 = group; null when no chat join).
//
// The most recent CONCLUSIVE piece of evidence wins, in either direction —
// so someone who switched phones is judged by what they're using now, not
// by old history (the v1.0.101 stale-route bug), and a contact's own
// messages count, not just ours. Since Messages syncs via iCloud, this
// covers anyone the user has ever texted from their iPhone too.
//   incoming iMessage                        → imessage (they're on iMessage)
//   outgoing iMessage, is_delivered=1        → imessage (device ack)
//   outgoing iMessage, error != 0            → sms
//   outgoing iMessage, never delivered       → sms (the silent "Not Delivered"
//                                              Android case — Apple often writes
//                                              no error; is_sent alone proves
//                                              nothing, see v1.0.102)
//   incoming SMS/RCS in a 1:1 chat           → sms (an iPhone on iMessage would
//                                              have sent iMessage; group MMS is
//                                              skipped — iPhones send SMS there
//                                              when any member is on Android)
//   our own outgoing SMS                     → inconclusive (we chose SMS)
// No conclusive row → 'unknown' (caller sends SMS — the safe default).
function classifyRoute(rows) {
  for (const r of rows || []) {
    const svc = r.service;
    if (r.is_from_me) {
      if (svc !== 'iMessage') continue;
      if (r.error && r.error !== 0) return 'sms';
      return r.is_delivered ? 'imessage' : 'sms';
    }
    if (svc === 'iMessage') return 'imessage';
    if ((svc === 'SMS' || svc === 'RCS') && r.style !== 43) return 'sms';
  }
  return 'unknown';
}

function phoneVariants(phone) {
  const digits = phone.replace(/\D/g, '');
  const variants = new Set([phone, digits]);
  if (digits.length === 10) {
    variants.add('+1' + digits); // US 10-digit → E.164
  } else if (digits.length === 11 && digits.startsWith('1')) {
    variants.add('+' + digits);  // 1XXXXXXXXXX → +1XXXXXXXXXX
  }
  return [...variants];
}

// Look up a number's known route from chat.db (persists across restarts,
// unlike routingCache). Returns 'imessage' | 'sms' | 'unknown'.
function lookupKnownRoute(phone) {
  let db;
  try {
    const Database = require('better-sqlite3');
    db = new Database(chatDbPath(), { readonly: true, fileMustExist: true });
    const varArr = phoneVariants(phone);
    const placeholders = varArr.map(() => '?').join(',');
    // item_type = 0: real messages only (not group renames/joins etc).
    // Ordered by m.date, not ROWID: iCloud sync can insert old messages with
    // new ROWIDs, so ROWID isn't a reliable recency order.
    const rows = db.prepare(`
      SELECT m.service, m.is_from_me, m.is_delivered, m.error, c.style
      FROM message m
      JOIN handle h ON h.ROWID = m.handle_id
      LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN chat c ON c.ROWID = cmj.chat_id
      WHERE h.id IN (${placeholders})
        AND (m.item_type IS NULL OR m.item_type = 0)
      ORDER BY m.date DESC
      LIMIT 50
    `).all(...varArr);
    return classifyRoute(rows);
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

    // iMessage route with a safety net. If chat.db reports the iMessage
    // failed, or Messages has no iMessage service, resend as SMS right away
    // (no duplicate risk — the iMessage didn't go through) and stop routing
    // this number to iMessage. If delivery is merely unconfirmed after 7s
    // (recipient offline, or switched phones and Apple wrote no error), keep
    // the 'unconfirmed' result for the reconciler — an SMS on top could
    // double-deliver — and drop the session cache so the next send re-reads
    // chat.db, where an undelivered iMessage now counts as evidence for SMS.
    const sendIMessage = async (tag) => {
      try {
        const result = await executeSend('iMessage', number, tmp, stagedImg, dbg(tag));
        if (result && result.confirmed === false) routingCache.delete(number);
        return result;
      } catch (err) {
        if (!/delivery failed|TYL_SERVICE_UNAVAILABLE:iMessage/.test(err.message)) throw err;
        routingCache.set(number, 'sms');
        return await executeSend('SMS', number, tmp, stagedImg, dbg(tag + '_error_fallback_sms'));
      }
    };

    // ── Session cache (in-memory, resets on restart) ─────────────────────────
    const cached = routingCache.get(number);
    if (cached === 'imessage') return await sendIMessage('cached_imessage');
    if (cached === 'sms') {
      return await executeSend('SMS', number, tmp, stagedImg, dbg('cached_sms'));
    }

    // ── Persistent chat.db history lookup (survives restarts) ────────────────
    if (canReadChatDb()) {
      const knownRoute = lookupKnownRoute(number);
      if (knownRoute === 'imessage') {
        routingCache.set(number, 'imessage');
        return await sendIMessage('known_imessage');
      }
      if (knownRoute === 'sms') {
        routingCache.set(number, 'sms');
        return await executeSend('SMS', number, tmp, stagedImg, dbg('known_sms'));
      }

      // ── Unknown number: SMS (v1.0.104 policy, unchanged) ───────────────────
      // No conclusive history, so no iMessage guess: AppleScript's iMessage
      // send never fails synchronously for a non-iMessage number, and a
      // wrong guess is a silent non-delivery. SMS reaches everyone. Not
      // cached: if this recipient replies from an iPhone, their reply lands
      // in chat.db as an incoming iMessage and their next send goes blue.
      return await executeSend('SMS', number, tmp, stagedImg, dbg('unknown_default_sms'));
    }

    // ── Fallback: chat.db unreadable (no Full Disk Access) ─────────────────
    // No verification possible, so SMS first; iMessage only if SMS itself
    // isn't available on this Mac. Reports why chat.db was unreadable so a
    // remaining access problem shows up in send_debug telemetry instead of
    // as silence (which is all v1.0.103/104 could show).
    const noDbDebug = (tag) => ({ sendId, tag, serviceType: tag.includes('imessage') ? 'iMessage' : 'SMS', pollResult: `chatdb_unreadable:${lastChatDbError}` });
    try {
      const r = await executeSend('SMS', number, tmp, stagedImg);
      return { ...r, _debug: noDbDebug('no_fda_sms') };
    } catch {
      const r = await executeSend('iMessage', number, tmp, stagedImg);
      return { ...r, _debug: noDbDebug('no_fda_fallback_imessage') };
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
module.exports.classifyRoute = classifyRoute; // exported for unit tests (pure)
module.exports.chatDbAccessError = () => lastChatDbError;
