/**
 * Guards the Mac blue/green routing rules that took 8 releases to get right
 * (2026-10-29). See the EMPIRICAL FINDINGS header in send-mac.js and
 * ~/alex/knowledge/businesses/tyl.md → "MAC iMESSAGE vs SMS ROUTING — SETTLED".
 * If one of these fails, re-read those before "fixing" the test.
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'send-mac.js'), 'utf8');
const fnBody = (name) => {
  const start = src.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = src.indexOf('\nfunction ', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
};

describe('send-mac.js routing invariants', () => {
  test('canReadChatDb really opens chat.db — never access()/exists() (they bypass the FDA/TCC gate)', () => {
    const body = fnBody('canReadChatDb');
    expect(body).not.toMatch(/accessSync|existsSync|fs\.access\b/);
    expect(body).toMatch(/new Database\(chatDbPath\(\)/);
    expect(body).toMatch(/\.prepare\(/);
  });

  test('unknown numbers default to SMS — never a speculative iMessage guess', () => {
    expect(src).toMatch(/executeSend\('SMS', number, tmp, stagedImg, dbg\('unknown_default_sms'\)\)/);
    expect(src).not.toMatch(/unknown_probe/);
  });

  test('chat.db-unreadable path sends SMS first and reports why chat.db was unreadable', () => {
    const fallback = src.slice(src.indexOf('Fallback: chat.db unreadable'));
    const smsAt = fallback.indexOf("executeSend('SMS'");
    const imAt = fallback.indexOf("executeSend('iMessage'");
    expect(smsAt).toBeGreaterThan(-1);
    expect(smsAt).toBeLessThan(imAt);
    expect(fallback).toMatch(/chatdb_unreadable:\$\{lastChatDbError\}/);
  });

  test('route history is ordered by message date, not ROWID (iCloud sync reorders ROWIDs)', () => {
    expect(fnBody('lookupKnownRoute')).toMatch(/ORDER BY m\.date DESC/);
  });

  test('iMessage success requires is_delivered, not is_sent', () => {
    const body = fnBody('queryDeliveryRows');
    expect(body).toMatch(/if \(serviceType === 'iMessage'\) \{\s*if \(row\.is_delivered\) return 'delivered';/);
  });
});
