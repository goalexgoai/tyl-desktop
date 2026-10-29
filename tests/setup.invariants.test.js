/**
 * Product rule (Dustin, 2026-10-29): first-run setup must be easy. No
 * Terminal, no scary System Settings. Full Disk Access (blue/green bubbles)
 * can't be granted without System Settings → Privacy & Security, so it is
 * NOT part of setup. It's optional: Account Settings card + help article
 * textyourlist.com/help/mac-blue-bubbles. Don't add it back here.
 */
const fs = require('fs');
const path = require('path');
const setup = fs.readFileSync(path.join(__dirname, '..', 'public', 'setup.html'), 'utf8');
const visible = setup.replace(/<!--[\s\S]*?-->/g, '');

test('setup has no Full Disk Access / Privacy settings / Terminal step', () => {
  expect(visible).not.toMatch(/Full Disk Access|openFdaSettings|Privacy_AllFiles|tccutil|Terminal/i);
});

test('setup can be completed with only the Messages permission', () => {
  expect(visible).toMatch(/document\.getElementById\('btn-continue'\)\.disabled = !messagesGranted;/);
});
