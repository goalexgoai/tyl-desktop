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

const { queryDeliveryRows, checkDeliveryOnce } = require('../send-mac.js');

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

describe('checkDeliveryOnce', () => {
  test('better-sqlite3 unavailable or chat.db unreadable → db_error, not a false "pending"', () => {
    // No real Messages chat.db exists on this (Linux) test environment, so
    // the real code path (new Database(...) throws on fileMustExist) applies
    // here without any mocking — this is exercising actual production code.
    const result = checkDeliveryOnce('5551234567', 0, 'SMS', 'hi');
    expect(result).toBe('db_error');
  });
});
