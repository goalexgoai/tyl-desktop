/**
 * Delivery-reconciler unit tests (send-mac.js).
 *
 * These exercise the pure row-matching logic (queryDeliveryRows) that both
 * the live 7s poll (pollForDelivery) and the background reconciler
 * (checkDeliveryOnce, used from server.js) share. Deliberately independent
 * of AppleScript/real chat.db — this VPS has neither — by passing a
 * minimal fake `db` object shaped like the one real query needs
 * (`.prepare(sql).all(...)`).
 */

const { queryDeliveryRows, checkDeliveryOnce, buildScript, buildImageScript } = require('../send-mac.js');

function fakeDb(rows) {
  return {
    prepare: () => ({
      all: () => rows,
    }),
  };
}

describe('queryDeliveryRows', () => {
  test('no rows at all → pending (genuinely unknown, not an error)', () => {
    expect(queryDeliveryRows(fakeDb([]), '5551234567', 100, 'SMS', 'hi')).toBe('pending');
  });

  test('settled error row (newest, no expectedText) → error', () => {
    const rows = [{ ROWID: 101, is_delivered: 0, is_sent: 0, error: 4000, text: 'hi' }];
    expect(queryDeliveryRows(fakeDb(rows), '5551234567', 100, 'SMS', null)).toBe('error');
  });

  test('settled delivered row → delivered', () => {
    const rows = [{ ROWID: 101, is_delivered: 1, is_sent: 1, error: 0, text: 'hi' }];
    expect(queryDeliveryRows(fakeDb(rows), '5551234567', 100, 'SMS', null)).toBe('delivered');
  });

  test('row exists but neither delivered nor errored yet → pending', () => {
    const rows = [{ ROWID: 101, is_delivered: 0, is_sent: 0, error: 0, text: 'hi' }];
    expect(queryDeliveryRows(fakeDb(rows), '5551234567', 100, 'SMS', null)).toBe('pending');
  });

  test('exact-text match is preferred over the newest row (group-chat race)', () => {
    // Newest row (ROWID 102) is a different, unrelated message that already
    // delivered. Our message (ROWID 101, sent a beat earlier) errored. Without
    // exact-text matching this would wrongly report 'delivered'.
    const rows = [
      { ROWID: 102, is_delivered: 1, is_sent: 1, error: 0, text: 'unrelated later text' },
      { ROWID: 101, is_delivered: 0, is_sent: 0, error: 4000, text: 'our message' },
    ];
    expect(queryDeliveryRows(fakeDb(rows), '5551234567', 100, 'SMS', 'our message')).toBe('error');
  });

  test('expectedText with no match anywhere falls back to newest row (prior behavior)', () => {
    const rows = [
      { ROWID: 102, is_delivered: 1, is_sent: 1, error: 0, text: 'different encoding/quoting' },
    ];
    expect(queryDeliveryRows(fakeDb(rows), '5551234567', 100, 'SMS', 'our message')).toBe('delivered');
  });

  test('query throw (lock, schema issue) → db_error, never confused with a delivery outcome', () => {
    const throwingDb = { prepare: () => { throw new Error('database is locked'); } };
    expect(queryDeliveryRows(throwingDb, '5551234567', 100, 'SMS', null)).toBe('db_error');
  });
});

describe('queryDeliveryRows: iMessage requires is_delivered, not just is_sent', () => {
  // Field evidence (2026-10-29): a known-Android number kept reading as
  // "delivered" via iMessage on is_sent=1 alone, even though Messages.app's
  // own UI showed "Not Delivered" — is_sent just means "handed to the send
  // queue," true for Android numbers too, and Apple frequently never writes
  // back a nonzero error for this failure mode. Only is_delivered (a real
  // device ack) proves an iMessage actually succeeded. SMS has no such
  // ack in practice, so is_sent remains the right signal there.
  test('iMessage: is_sent=1, no is_delivered, no error → pending, NOT delivered', () => {
    const rows = [{ ROWID: 101, is_delivered: 0, is_sent: 1, error: 0, text: 'hi' }];
    expect(queryDeliveryRows(fakeDb(rows), '5551234567', 100, 'iMessage', null)).toBe('pending');
  });

  test('iMessage: is_delivered=1 → delivered', () => {
    const rows = [{ ROWID: 101, is_delivered: 1, is_sent: 1, error: 0, text: 'hi' }];
    expect(queryDeliveryRows(fakeDb(rows), '5551234567', 100, 'iMessage', null)).toBe('delivered');
  });

  test('SMS: is_sent=1 alone still counts as delivered (unchanged behavior)', () => {
    const rows = [{ ROWID: 101, is_delivered: 0, is_sent: 1, error: 0, text: 'hi' }];
    expect(queryDeliveryRows(fakeDb(rows), '5551234567', 100, 'SMS', null)).toBe('delivered');
  });
});

describe('checkDeliveryOnce', () => {
  test('better-sqlite3 unavailable or chat.db unreadable → db_error, not a false "pending"', () => {
    // No real Messages chat.db exists on this (Linux) test environment, so
    // the real code path (new Database(...) throws on fileMustExist) applies
    // here without any mocking — this is exercising actual production code.
    const result = checkDeliveryOnce('5551234567', 0, 'SMS', 'hi');
    expect(result).toBe('db_error');
  });
});

describe('buildScript / buildImageScript: honest service-selection', () => {
  // Field evidence (2026-10-29): Messages.app silently sent iMessage ("blue")
  // to a known-Android number that repeatedly showed "Not Delivered", even
  // though our routing logic had decided to send SMS. Root cause: the
  // AppleScript's `on error: set svc to first service` fallback masks a
  // missing SMS service (e.g. Text Message Forwarding not enabled) by
  // silently substituting whatever service IS configured — almost always
  // iMessage — instead of failing. These tests lock in the fix: a missing
  // service type must throw a distinguishable error, never substitute.
  test('buildScript never falls back to "first service" on a missing service type', () => {
    const script = buildScript('SMS', '5551234567', '/tmp/x.txt');
    expect(script).not.toMatch(/set svc to first service\s*$/m);
    expect(script).toMatch(/error "TYL_SERVICE_UNAVAILABLE:SMS"/);
  });

  test('buildImageScript never falls back to "first service" on a missing service type', () => {
    const script = buildImageScript('iMessage', '5551234567', '/tmp/x.jpg');
    expect(script).not.toMatch(/set svc to first service\s*$/m);
    expect(script).toMatch(/error "TYL_SERVICE_UNAVAILABLE:iMessage"/);
  });
});

describe('friendlyError: service-unavailable mapping', () => {
  const { friendlyError } = require('../send-errors.js');

  test('TYL_SERVICE_UNAVAILABLE:SMS tells the user to enable Text Message Forwarding', () => {
    const msg = friendlyError('execution error: TYL_SERVICE_UNAVAILABLE:SMS (-2700)', 'darwin');
    expect(msg).toMatch(/Text Message Forwarding/i);
  });

  test('TYL_SERVICE_UNAVAILABLE:iMessage tells the user to sign in to iMessage', () => {
    const msg = friendlyError('execution error: TYL_SERVICE_UNAVAILABLE:iMessage (-2700)', 'darwin');
    expect(msg).toMatch(/sign in/i);
  });
});
