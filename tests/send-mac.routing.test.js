/**
 * lookupKnownRoute unit tests (send-mac.js).
 *
 * Field evidence (2026-10-29): a known-Android number (switched from iPhone
 * to Android at some point) kept getting routed to iMessage and silently
 * failing ("Not Delivered") on every send. Root cause: lookupKnownRoute
 * asked chat.db "has any iMessage send to this number EVER succeeded"
 * with no recency bound — a stale historical success (from when the
 * recipient still had an iPhone) permanently locked the number onto the
 * iMessage route. These tests lock in the fix: only the MOST RECENT
 * iMessage attempt should decide the route.
 *
 * better-sqlite3 is mocked since this test environment has no real chat.db.
 */

let mockLastIMsgResult;
let mockSmsRowResult;
const mockPrepareCalls = [];

jest.mock('better-sqlite3', () => {
  return jest.fn().mockImplementation(() => ({
    prepare: (sql) => {
      mockPrepareCalls.push(sql);
      return {
        get: () => {
          if (/ORDER BY m\.ROWID DESC/.test(sql)) return mockLastIMsgResult;
          if (/FROM handle WHERE/.test(sql)) return mockSmsRowResult;
          return undefined;
        },
      };
    },
    close: () => {},
  }));
});

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  accessSync: () => {}, // canReadChatDb() isn't under test here; unused but keep require() happy
}));

const { lookupKnownRoute } = require('../send-mac.js');

beforeEach(() => {
  mockLastIMsgResult = undefined;
  mockSmsRowResult = undefined;
  mockPrepareCalls.length = 0;
});

describe('lookupKnownRoute', () => {
  test('most recent iMessage attempt delivered → imessage', () => {
    mockLastIMsgResult = { is_sent: 1, is_delivered: 1, error: 0 };
    expect(lookupKnownRoute('5551234567')).toBe('imessage');
  });

  test('most recent iMessage attempt is_sent=1 but NOT is_delivered, no error → falls through (not trusted as imessage)', () => {
    // This is the exact field scenario that defeated the first (v1.0.101) fix:
    // Android numbers get is_sent=1 immediately too, and often never get an
    // explicit error written back. Only is_delivered proves real success.
    // With no SMS handle on record either, this should land on 'unknown' so
    // a fresh probe runs instead of blindly trusting the queued-not-proven send.
    mockLastIMsgResult = { is_sent: 1, is_delivered: 0, error: 0 };
    mockSmsRowResult = undefined;
    expect(lookupKnownRoute('5551234567')).toBe('unknown');
  });

  test('most recent iMessage attempt errored → sms, even if an OLDER send once succeeded', () => {
    // This is the exact field scenario: an old successful iMessage row sits
    // in chat.db from when the recipient had an iPhone, but the most recent
    // attempt (what we actually query) failed — e.g. after they switched to
    // Android. Must not fall back to the old success.
    mockLastIMsgResult = { is_sent: 1, is_delivered: 0, error: 4000 };
    expect(lookupKnownRoute('5551234567')).toBe('sms');
  });

  test('no iMessage history at all, but a known SMS handle exists → sms', () => {
    mockLastIMsgResult = undefined;
    mockSmsRowResult = { 1: 1 };
    expect(lookupKnownRoute('5551234567')).toBe('sms');
  });

  test('no history of either kind → unknown (triggers fresh probe)', () => {
    mockLastIMsgResult = undefined;
    mockSmsRowResult = undefined;
    expect(lookupKnownRoute('5551234567')).toBe('unknown');
  });

  test('queries the most recent row (ORDER BY ROWID DESC), not "any row ever"', () => {
    mockLastIMsgResult = { is_sent: 1, is_delivered: 1, error: 0 };
    lookupKnownRoute('5551234567');
    const iMsgQuery = mockPrepareCalls.find(sql => /service = 'iMessage'/.test(sql));
    expect(iMsgQuery).toMatch(/ORDER BY m\.ROWID DESC/);
    expect(iMsgQuery).toMatch(/LIMIT 1/);
  });
});
