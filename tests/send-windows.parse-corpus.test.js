/**
 * User-input corpus through the REAL PowerShell parser.
 *
 * send-windows.js embeds the recipient number and message text inside a
 * PowerShell '...' literal. v1.0.92 and earlier broke on a curly apostrophe (’),
 * which PowerShell treats as a quote; every send in that job failed. This test
 * builds the actual script for each tricky input, parses it with pwsh, and
 * checks that it parses cleanly and that the literal PowerShell receives is
 * exactly the SendKeys-escaped message.
 *
 * Needs `pwsh` (preinstalled on GitHub ubuntu runners). Set PWSH=/path/to/pwsh
 * locally. Skips when pwsh is absent, except in CI, where that's a failure.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function findPwsh() {
  const candidates = [process.env.PWSH, 'pwsh'].filter(Boolean);
  for (const c of candidates) {
    try { execFileSync(c, ['-NoProfile', '-Command', '1'], { stdio: 'ignore' }); return c; } catch (_) {}
  }
  return null;
}
const PWSH = findPwsh();

const CORPUS = [
  ['curly apostrophe', 'Confirming 1 guest(s) for Catarina’s celebration'],
  ['all single-quote variants', "' ‘ ’ ‚ ‛ ''"],
  ['double quotes, straight and curly', 'She said "hi" and “bye” „'],
  ['backtick and dollar', 'Cost is $5 `n $(Get-Date) ${x} $env:USERNAME'],
  ['SendKeys specials', '+ ^ % ~ { } [ ] ( ) 100% off ~today~'],
  ['PowerShell operators', '@{} @() # comment ; & | < > -and -eq 2>&1'],
  ['newlines and tabs', 'Line one\nLine two\r\nLine three\tTabbed'],
  ['emoji and ZWJ', 'Party 🎉 👨‍👩‍👧 ❤️'],
  ['invisible characters', 'zero​width non breaking rtl‏mark bom﻿'],
  ['accents and other scripts', 'José Müller Здравствуй 你好 مرحبا'],
  ['dashes and ellipsis', 'Wait — really – yes…'],
  ['empty message', ''],
  ['only quotes', "''''"],
];

// Build the exact .ps1 send-windows.js would run, without running it.
function buildScript(number, message) {
  const outFile = path.join(os.tmpdir(), `tyl-corpus-${process.pid}-${Math.random().toString(36).slice(2)}.ps1`);
  jest.isolateModules(() => {
    const realFs = jest.requireActual('fs');
    jest.doMock('fs', () => ({
      ...realFs,
      writeFileSync: (p, data, ...rest) =>
        String(p).includes('textyourlist-') ? realFs.writeFileSync(outFile, data) : realFs.writeFileSync(p, data, ...rest),
      unlinkSync: (p) => { if (!String(p).includes('textyourlist-')) realFs.unlinkSync(p); },
    }));
    jest.doMock('child_process', () => ({
      execFile: (cmd, args, opts, cb) => { setImmediate(() => cb(null, '', '')); return { on() {} }; },
    }));
    require('../send-windows.js')(number, message);
  });
  return outFile;
}

const PARSE = `
param($path)
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$t, [ref]$e)
$calls = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and $n.Member.Value -eq 'SendWait' }, $true)
$vals = @($calls | ForEach-Object { $a = $_.Arguments[0]; if ($a -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $a.Value } })
[pscustomobject]@{ errors = @($e | ForEach-Object { $_.Message }); literals = $vals } | ConvertTo-Json -Compress -Depth 3
`;

const escapeSendKeys = v => v.replace(/([+^%~{}\[\]()])/g, '{$1}');

(PWSH ? describe : (process.env.CI ? describe : describe.skip))('send-windows.js user-input corpus parses in real PowerShell', () => {
  const parser = path.join(os.tmpdir(), `tyl-parse-${process.pid}.ps1`);
  beforeAll(() => {
    if (!PWSH) throw new Error('pwsh not found in CI; the parse-corpus test must run');
    fs.writeFileSync(parser, PARSE);
  });

  test.each(CORPUS)('%s', async (_label, message) => {
    const file = buildScript('+15551234567', message);
    await new Promise(r => setTimeout(r, 20));
    const out = execFileSync(PWSH, ['-NoProfile', '-NonInteractive', '-File', parser, file], { encoding: 'utf8' });
    fs.unlinkSync(file);
    const { errors, literals } = JSON.parse(out.trim());
    expect(errors).toEqual([]);
    // The message literal PowerShell sees must be exactly what we meant to type.
    expect(literals).toContain(escapeSendKeys(message));
  });
});
