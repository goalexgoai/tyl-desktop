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
    const ALLOWED_PREFIX = ['processNames.map(', "require('./package.json')"];
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

  test('Finding 10: Phone Link relaunch runs only after the window search failed', () => {
    const launch = ps.indexOf('shell:AppsFolder');
    expect(launch).toBeGreaterThan(-1);
    const guard = ps.lastIndexOf('if (-not $window) {', launch);
    expect(guard).toBeGreaterThan(-1);
    // The guard must come after the initial 8s search loop, not replace it.
    expect(guard).toBeGreaterThan(ps.indexOf('$winDeadline = $windowSearchStart.AddSeconds(8)'));
  });

  test('Finding 11: Messages-tab recovery runs only when no compose button was found', () => {
    const nav = ps.indexOf("'^Messages$'");
    expect(nav).toBeGreaterThan(-1);
    const guard = ps.lastIndexOf('if (-not $compose) {', nav);
    expect(guard).toBeGreaterThan(ps.indexOf('Log "compose: matching buttons='));
    // Working path unchanged: compose Invoke and Ctrl+N fallback still follow.
    expect(ps.indexOf('if ($compose) {', nav)).toBeGreaterThan(nav);
    expect(ps).toMatch(/SendWait\('\^n'\)/);
  });

  test('Finding 13: setup-state classification only after compose AND Messages nav were not found', () => {
    const cls = ps.indexOf("throw 'Phone Link not set up: no phone connected'");
    expect(cls).toBeGreaterThan(-1);
    expect(ps.lastIndexOf('Log "compose: no Messages nav item found"', cls)).toBeGreaterThan(ps.indexOf('if (-not $compose) {'));
    expect(ps.lastIndexOf('Log-Diagnostics $window', cls)).toBeGreaterThan(ps.lastIndexOf('Log "compose: no Messages nav item found"', cls));
    expect(ps.indexOf("throw 'Phone Link pairing incomplete'")).toBeGreaterThan(cls);
    // 'iPhone paired, no Messages' must not be asserted as a permission problem.
    expect(ps).not.toMatch(/messaging not enabled/);
  });

  test('Finding 13: logged nav names are length-limited (notifications must not be logged)', () => {
    const line = ps.slice(ps.indexOf('$navNames = '), ps.indexOf('Log "compose: none found; nav_names='));
    expect(line).toMatch(/Name\.Length -le 40/);
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

// Regression: 619 field sends (both paying Windows customers, Sept 2026) died
// with ParserError "Missing ')' in method call" because a typographic ’ in the
// message closed the PowerShell '...' literal early. PowerShell's tokenizer
// treats ' ‘ ’ ‚ ‛ all as single quotes; a doubled pair yields the 2nd char.
describe('escapePowerShell handles every PowerShell single-quote variant', () => {
  const fnSrc = SRC.match(/function escapePowerShell\(value\) \{[\s\S]*?\n\}/)[0];
  // eslint-disable-next-line no-new-func
  const escapePowerShell = new Function(`${fnSrc}; return escapePowerShell;`)();
  const isQuote = c => /['‘’‚‛]/.test(c);

  // Mirrors PowerShell's single-quoted-string scan. Returns the parsed value
  // and whether the literal ended exactly at the closing quote we append.
  function parsePsLiteral(escaped) {
    const src = escaped + "'";
    let out = '';
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (isQuote(c)) {
        if (i + 1 < src.length && isQuote(src[i + 1])) { out += src[i + 1]; i++; continue; }
        return { value: out, closedAtEnd: i === src.length - 1 };
      }
      out += c;
    }
    return { value: out, closedAtEnd: false };
  }

  test.each([
    "Confirming 1 guest(s) for Catarina’s celebration",
    "into God’s arms",
    "plain ASCII it's fine",
    "‘single’ ‚low‛ and “double” quotes",
    "O''Brien",
  ])('round-trips %s', (msg) => {
    const r = parsePsLiteral(escapePowerShell(msg));
    expect(r.closedAtEnd).toBe(true);
    expect(r.value).toBe(msg);
  });
});
