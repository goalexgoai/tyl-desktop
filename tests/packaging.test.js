/**
 * Every local module the app loads must be in the electron-builder `files`
 * list, and anything server.js loads must also be in `asarUnpack` (server.js
 * runs from app.asar.unpacked and can't reach files left inside the asar).
 * Tests run from the source tree, so a missing entry passes every other test
 * and only breaks the installed app (caught 2026-10-05: vcard.js missing, the
 * packaged app would not have started).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const build = require('../package.json').build;

function localRequires(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return [...src.matchAll(/require\(\s*['"]\.\/([^'"]+)['"]\s*\)/g)]
    .map(m => (m[1].endsWith('.js') || m[1].endsWith('.json') ? m[1] : `${m[1]}.js`))
    .filter(f => !f.startsWith('public/') && !f.startsWith('companion/'));
}

describe('packaging includes every local module', () => {
  for (const entry of ['main.js', 'server.js', 'send-windows.js', 'send-mac.js', 'db.js']) {
    test(`${entry}: local requires are in build.files`, () => {
      const missing = localRequires(entry).filter(f => !build.files.includes(f) && f !== 'package.json');
      expect(missing).toEqual([]);
    });
  }

  test('server.js local requires are also in asarUnpack', () => {
    const missing = localRequires('server.js').filter(f => !build.asarUnpack.includes(f) && f !== 'package.json');
    expect(missing).toEqual([]);
  });
});
