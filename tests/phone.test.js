const { parsePhone, normalizePhone, resolveCountry } = require('../phone');

describe('normalizePhone: country-aware', () => {
  test.each([
    // US behavior unchanged
    ['(801) 427-3388', 'US', '+18014273388'],
    ['801.427.3388', 'US', '+18014273388'],
    ['1 801 427 3388', 'US', '+18014273388'],
    ['+1 801 427 3388', 'FR', '+18014273388'],
    ['8015550123', 'US', '+18015550123'],
    // France — the real-telemetry case
    ['06 22 92 26 52', 'FR', '+33622922652'],
    ['0622922652', 'FR', '+33622922652'],
    ['+33 6 22 92 26 52', 'FR', '+33622922652'],
    ['0033 6 22 92 26 52', 'FR', '+33622922652'],
    ['+33622922652', 'US', '+33622922652'],
    // Others
    ['07911 123456', 'GB', '+447911123456'],
    ['0151 23456789', 'DE', '+4915123456789'],
    ['0412 345 678', 'AU', '+61412345678'],
    ['55 1234 5678', 'MX', '+525512345678'],
    ['98765 43210', 'IN', '+919876543210'],
    ['416-555-0199', 'CA', '+14165550199'],
    // legacy: long digit strings were already treated as international
    ['447911123456', 'US', '+447911123456'],
    ['33622922652', 'US', '+33622922652'],
  ])('%s (%s) -> %s', (raw, c, want) => {
    expect(normalizePhone(raw, c)).toBe(want);
  });

  test('French national number with US default is rejected, never +1 0…', () => {
    expect(normalizePhone('06 22 92 26 52', 'US')).toBeNull();
    expect(normalizePhone('0622922652', 'US')).toBeNull();
    expect(parsePhone('0622922652', 'US').reason).toMatch(/country code/);
  });

  test('never produces +1 followed by 0 or 1', () => {
    for (const raw of ['0622922652', '0123456789', '10123456789', '1123456789']) {
      const p = normalizePhone(raw, 'US');
      expect(p === null || !/^\+1[01]/.test(p)).toBe(true);
    }
  });

  test('rejects blanks, short codes, extensions, garbage', () => {
    for (const raw of ['', null, undefined, '12345', 'abc', '801-427-3388 ext 12', '801-427-3388 x5']) {
      expect(normalizePhone(raw, 'US')).toBeNull();
    }
  });

  test('unknown/blank country falls back to US', () => {
    expect(resolveCountry('zz')).toBeNull();
    expect(normalizePhone('801-427-3388', 'zz')).toBe('+18014273388');
  });
});
