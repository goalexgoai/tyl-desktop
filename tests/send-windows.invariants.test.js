/**
 * Send-windows.js INVARIANT TESTS.
 *
 * These tests guard against re-introducing regressions captured in the
 * empirical-findings header of send-windows.js. Each test corresponds to a
 * numbered finding in that header. A failing test means someone changed
 * load-bearing code without re-validating the design — read the header
 * before deleting the test.
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'send-windows.js'), 'utf8');

// Pull just the embedded PowerShell template string body so we test the
// content the desktop will actually send to powershell.exe.
function extractPsScript() {
  // The script lives inside a tagged template literal assigned to `const script = \`…\`;`
  const start = SRC.indexOf('const script = `');
  expect(start).toBeGreaterThan(-1);
  const end = SRC.indexOf("`;", start);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start + 'const script = `'.length, end);
}

describe('send-windows.js empirical-findings invariants', () => {
  const ps = extractPsScript();

  test('Finding 1: SetFocus throws are caught (Tier 1 wraps in try/catch)', () => {
    // The Tier 1 SetFocus must be inside a try-catch so the benign "Target
    // element cannot receive focus" exception does not abort the send.
    expect(ps).toMatch(/try\s*\{\s*\$window\.SetFocus\(\)/);
  });

  test('Finding 2: at least 500ms total settle before Tier 2 foreground check', () => {
    // Two sleeps between SetForegroundWindow and Is-PhoneLinkFg in Tier 2:
    // 300ms then 200ms. Tightening this caused every send to fail in v1.0.85.
    const tier2 = ps.slice(ps.indexOf('tier 2'), ps.indexOf('if (Is-PhoneLinkFg', ps.indexOf('tier 2')) + 100);
    const sleeps = [...tier2.matchAll(/Start-Sleep -Milliseconds (\d+)/g)].map(m => parseInt(m[1], 10));
    const total = sleeps.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(500);
  });

  test('Finding 3: AttachThreadInput is called but not asserted', () => {
    // AttachThreadInput must be invoked (some environments need it) but a
    // False return must not abort — Dustin's machine returns False yet
    // sending works.
    expect(ps).toMatch(/AttachThreadInput\(\$myTid, \$phoneLinkTid, \$true\)/);
    expect(ps).not.toMatch(/if\s*\(\s*-not\s+\$attachOk\s*\)\s*\{/);
  });

  test('Finding 4: field detection is by Name regex match, not "first empty"', () => {
    expect(ps).toMatch(/Type a name\|Type a number\|To:/);
    expect(ps).toMatch(/Type a message\|Aa\|Message\|Continue/);
    expect(ps).toMatch(/New message\|Compose\|New conversation/);
    expect(ps).toMatch(/\^Send\$\|\^Send message\$/);
  });

  test('Finding 5: no post-send ValuePattern verification (false-negative source)', () => {
    expect(ps).not.toMatch(/ValuePattern.*Pattern.*Current\.Value/);
    expect(ps).not.toMatch(/Message may not have sent/);
  });

  test('Finding 6: Send button is invoked via InvokePattern (Enter is fallback only)', () => {
    expect(ps).toMatch(/\$sendBtn\.GetCurrentPattern\(\[System\.Windows\.Automation\.InvokePattern\]::Pattern\)\.Invoke\(\)/);
    // The Enter SendKeys for sending must be in an else-branch (fallback), not
    // the primary path.
    const sendBtnIdx = ps.indexOf('$sendBtn = ');
    const enterFallbackIdx = ps.indexOf("SendWait('{ENTER}')", sendBtnIdx);
    const elseIdx = ps.indexOf('} else {', sendBtnIdx);
    expect(elseIdx).toBeGreaterThan(-1);
    expect(elseIdx).toBeLessThan(enterFallbackIdx);
  });

  test('Finding 7: typing uses SendKeys, not clipboard paste', () => {
    expect(ps).not.toMatch(/Set-Clipboard\s+-Value/);
    expect(ps).not.toMatch(/SendWait\('\^v'\)/);
    expect(ps).toMatch(/SendKeys\]::SendWait\('\$\{safeNumber\}'\)/);
    expect(ps).toMatch(/SendKeys\]::SendWait\('\$\{safeMessage\}'\)/);
  });

  test('Finding 8: PhoneExperienceHost is in the process-name match list', () => {
    expect(SRC).toMatch(/'PhoneExperienceHost'/);
  });

  test('Finding 9: no unescaped JS-style ${name} interpolations in the PS body', () => {
    // The whitelist of valid JS interpolations inside the embedded PowerShell
    // template literal. Anything else `${…}` in the PS body must be `\${…}`
    // (escaped) so PowerShell receives it literally. v1.0.86 shipped broken
    // because ${windowSearchMs} was JS-interpolated and ReferenceError'd
    // before PowerShell ran. Only checks inside the template literal — JS
    // comments above the declaration are not interpolated.
    // Exact matches OR prefix matches — needed because the simple { … } regex
    // can't balance nested braces in `${processNames.map(n => \`'${n}'\`)…}`.
    const ALLOWED_EXACT = new Set(['safeNumber', 'safeMessage', 'n']);
    const ALLOWED_PREFIX = ['processNames.map('];
    const isAllowed = (e) => ALLOWED_EXACT.has(e) || ALLOWED_PREFIX.some(p => e.startsWith(p));
    const interpolations = [...ps.matchAll(/(?<!\\)\$\{([^}]+)\}/g)].map(m => m[1]);
    for (const expr of interpolations) {
      if (!isAllowed(expr)) {
        throw new Error(
          `Unescaped JS-style \${${expr}} in the PowerShell template — JS will interpolate it. ` +
          `If it's PowerShell, escape as \\\${${expr}}. ` +
          `If it's a new JS interpolation, whitelist it in this test.`
        );
      }
    }
  });

  test('JS template literal builds without ReferenceError when sendViaPhoneLink is invoked', () => {
    // Smoke test the v1.0.86 regression specifically — building the script
    // string must not throw. We mock execFile so the function short-circuits
    // before actually spawning powershell on a non-Windows test runner.
    jest.resetModules();
    const cp = require('child_process');
    const realExecFile = cp.execFile;
    cp.execFile = (...args) => {
      const cb = args[args.length - 1];
      // Mimic an immediate, error-free spawn completion.
      setImmediate(() => cb(null, '', ''));
      return { kill: () => {} };
    };
    try {
      const send = require('../send-windows');
      return expect(send('+15551234567', 'Hello world 👋')).resolves.toBe(true);
    } finally {
      cp.execFile = realExecFile;
    }
  });
});
