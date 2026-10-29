/**
 * iMessage-vs-SMS routing unit tests (send-mac.js).
 *
 * classifyRoute decides blue vs green from a number's chat.db history
 * (newest first). The most recent CONCLUSIVE evidence wins, in either
 * direction — that's what keeps a phone-switcher from being locked onto a
 * stale route (v1.0.101) while still sending blue to known iPhone contacts.
 *
 * Field evidence (2026-10-29): a known-Android number (formerly iPhone) kept
 * going out blue and "Not Delivered" — Apple wrote is_sent=1 and no error,
 * so only is_delivered proves an iMessage worked. And with chat.db access
 * fixed, known iPhone contacts must go blue again, not green.
 *
 * better-sqlite3 is mocked since this test environment has no real chat.db.
 */

let mockRows;
let mockOpenError;
const mockPrepareCalls = [];

jest.mock('better-sqlite3', () => {
  return jest.fn().mockImplementation(() => {
    if (mockOpenError) throw mockOpenError;
    return {
      prepare: (sql) => {
        mockPrepareCalls.push(sql);
        return { all: () => mockRows, get: () => ({ ROWID: 1 }) };
      },
      close: () => {},
    };
  });
});

const { classifyRoute, lookupKnownRoute } = require('../send-mac.js');

const outIM = (o = {}) => ({ service: 'iMessage', is_from_me: 1, is_delivered: 0, error: 0, style: 45, ...o });
const inIM = (o = {}) => ({ service: 'iMessage', is_from_me: 0, is_delivered: 0, error: 0, style: 45, ...o });
const outSMS = (o = {}) => ({ service: 'SMS', is_from_me: 1, is_delivered: 0, error: 0, style: 45, ...o });
const inSMS = (o = {}) => ({ service: 'SMS', is_from_me: 0, is_delivered: 0, error: 0, style: 45, ...o });

beforeEach(() => {
  mockRows = [];
  mockOpenError = null;
  mockPrepareCalls.length = 0;
});

describe('classifyRoute', () => {
  test('no history → unknown (caller defaults to SMS)', () => {
    expect(classifyRoute([])).toBe('unknown');
  });

  test('most recent outgoing iMessage delivered → imessage', () => {
    expect(classifyRoute([outIM({ is_delivered: 1 })])).toBe('imessage');
  });

  test('known iPhone contact we texted green today still goes blue (our own SMS is inconclusive)', () => {
    // Exactly Dustin's v1.0.104 state: today's sends went SMS, but the
    // contact's real history is delivered iMessages.
    expect(classifyRoute([outSMS(), outSMS(), outIM({ is_delivered: 1 })])).toBe('imessage');
  });

  test('incoming iMessage from the contact → imessage, even with no outgoing iMessage history', () => {
    expect(classifyRoute([outSMS(), inIM()])).toBe('imessage');
  });

  test('outgoing iMessage queued but never delivered, no error → sms (silent "Not Delivered" Android case)', () => {
    expect(classifyRoute([outIM({ is_sent: 1 }), outIM({ is_delivered: 1 })])).toBe('sms');
  });

  test('outgoing iMessage errored → sms even if an older one succeeded (phone switcher)', () => {
    expect(classifyRoute([outIM({ error: 22 }), outIM({ is_delivered: 1 })])).toBe('sms');
  });

  test('incoming 1:1 SMS newer than old iMessage history → sms', () => {
    expect(classifyRoute([inSMS(), inIM(), outIM({ is_delivered: 1 })])).toBe('sms');
  });

  test('incoming RCS in 1:1 → sms', () => {
    expect(classifyRoute([inSMS({ service: 'RCS' })])).toBe('sms');
  });

  test('incoming SMS in a GROUP chat is skipped (iPhones send SMS in mixed groups)', () => {
    expect(classifyRoute([inSMS({ style: 43 }), inIM()])).toBe('imessage');
    expect(classifyRoute([inSMS({ style: 43 })])).toBe('unknown');
  });

  test('only outgoing SMS on record → unknown, not locked to sms forever', () => {
    expect(classifyRoute([outSMS(), outSMS()])).toBe('unknown');
  });
});

describe('lookupKnownRoute', () => {
  test('classifies rows from chat.db', () => {
    mockRows = [outSMS(), outIM({ is_delivered: 1 })];
    expect(lookupKnownRoute('5551234567')).toBe('imessage');
  });

  test('orders by message date (iCloud sync can reorder ROWIDs) and matches E.164 variants', () => {
    lookupKnownRoute('5551234567');
    const sql = mockPrepareCalls.find(s => /FROM message m/.test(s));
    expect(sql).toMatch(/ORDER BY m\.date DESC/);
    expect(sql).toMatch(/chat_message_join/);
  });

  test('chat.db unreadable → unknown', () => {
    mockOpenError = Object.assign(new Error('unable to open database file'), { code: 'SQLITE_CANTOPEN' });
    expect(lookupKnownRoute('5551234567')).toBe('unknown');
  });
});

describe('canReadChatDb', () => {
  test('uses a real open+query (not access()) and records the failure reason', () => {
    jest.isolateModules(() => {
      mockOpenError = Object.assign(new Error('authorization denied'), { code: 'SQLITE_AUTH' });
      const m = require('../send-mac.js');
      expect(m.canReadChatDb()).toBe(false);
      expect(m.chatDbAccessError()).toBe('SQLITE_AUTH');
    });
    jest.isolateModules(() => {
      mockOpenError = null;
      const m = require('../send-mac.js');
      expect(m.canReadChatDb()).toBe(true);
      expect(m.chatDbAccessError()).toBe(null);
    });
  });
});
