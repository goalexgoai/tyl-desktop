const { execFile } = require('child_process');
const { writeFileSync, unlinkSync } = require('fs');
const { join } = require('path');
const os = require('os');

function escapeSendKeys(value) {
  return value.replace(/([+^%~{}\[\]()])/g, '{$1}');
}

function escapePowerShell(value) {
  return value.replace(/'/g, "''");
}

// Extract the human-readable first line from a PowerShell error blob.
// PS errors look like:
//   Friendly message here
//   At C:\...\script.ps1:126 char:5
//   + throw "Friendly message here"
//   + CategoryInfo : ...
// We want only the first meaningful line.
function parsePsError(raw) {
  if (!raw) return null;
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    // Skip PS metadata lines
    if (/^(At |    \+|Exception calling|FullyQualifiedErrorId|CategoryInfo|OperationStopped)/.test(line)) continue;
    // Skip lines that are just PS stack decoration (dashes/tildes)
    if (/^[~\-+\s]+$/.test(line)) continue;
    return line;
  }
  return lines[0] || null;
}

module.exports = async function sendViaPhoneLink(number, message) {
  const safeNumber = escapeSendKeys(escapePowerShell(number));
  // Message goes via clipboard — preserves emoji and unicode without SendKeys escaping.
  const safeMessage = escapePowerShell(message || '');
  const tmpFile = join(os.tmpdir(), `textyourlist-${Date.now()}.ps1`);

  const processNames = ['PhoneLink', 'PhoneLinkHost', 'PhoneExperienceHost', 'PhoneExperience', 'PhoneLinkInfrastructureHost', 'YourPhone', 'YourPhoneServiceHost'];

  const script = `
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

# Win32 API for reliable window activation (SetFocus via UIAutomation can fail
# if the window is minimised or not currently the foreground app).
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class TylWin32 {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    public const int SW_RESTORE = 9;
}
"@ -ErrorAction SilentlyContinue

# Find Phone Link across all known process names
$proc = $null
foreach ($name in @(${processNames.map(n => `'${n}'`).join(',')})) {
  $found = Get-Process -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { $proc = $found; break }
}
if (-not $proc) {
  $allPhone = (Get-Process | Where-Object { $_.Name -match 'phone|yourphone' } | Select-Object -ExpandProperty Name -Unique) -join ', '
  throw "Phone Link is not open. Make sure the Phone Link app is running before sending. (Processes seen: [$allPhone])"
}

# Restore and bring Phone Link to the foreground using Win32 before UIAutomation.
if ($proc.MainWindowHandle -ne [IntPtr]::Zero) {
  [TylWin32]::ShowWindow($proc.MainWindowHandle, [TylWin32]::SW_RESTORE) | Out-Null
  [TylWin32]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 400
}

$root = [System.Windows.Automation.AutomationElement]::RootElement
$pidCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id
)

function Wait-Element($start, $cond, $timeout = 10) {
  $deadline = [datetime]::Now.AddSeconds($timeout)
  while ([datetime]::Now -lt $deadline) {
    $el = $start.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if ($el) { return $el }
    Start-Sleep -Milliseconds 250
  }
  return $null
}

$window = Wait-Element $root $pidCond 5
if (-not $window) { throw 'Could not find Phone Link window. Make sure Phone Link is open and not minimised to the tray.' }

# UIAutomation SetFocus — best-effort; Win32 activation above is the reliable path.
try { $window.SetFocus() } catch {}
Start-Sleep -Milliseconds 500

# Press Escape several times to dismiss any open conversation/dialog and return
# Phone Link to the home screen. Critical for group sends — after the first message
# Phone Link stays in the conversation view, so subsequent messages must reset first.
[System.Windows.Forms.SendKeys]::SendWait('{ESC}')
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait('{ESC}')
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait('{ESC}')
Start-Sleep -Milliseconds 500

# Try to find and click the compose button first; fall back to Ctrl+N
$btnTypeCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Button
)
$invokableCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty, $true
)
$btnCond = New-Object System.Windows.Automation.AndCondition($btnTypeCond, $invokableCond)
$compose = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond) |
  Where-Object { $_.Current.Name -match 'New message|Compose|New conversation' } |
  Select-Object -First 1
if ($compose) {
  try {
    $compose.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  } catch {
    [System.Windows.Forms.SendKeys]::SendWait('^n')
  }
} else {
  [System.Windows.Forms.SendKeys]::SendWait('^n')
}
Start-Sleep -Milliseconds 1500

# Find edit fields (type + enabled)
$editTypeCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Edit
)
$enabledCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::IsEnabledProperty, $true
)
$editCond = New-Object System.Windows.Automation.AndCondition($editTypeCond, $enabledCond)

$edits = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)
$recipient = $edits | Where-Object { $_.Current.Name -match 'Type a name|Type a number|To:' } | Select-Object -First 1
if (-not $recipient) { $recipient = $edits | Select-Object -First 1 }
if (-not $recipient) { throw 'Could not find the recipient field. The new message dialog may not have opened — make sure Phone Link is on the home screen.' }

$recipient.SetFocus()
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait('${safeNumber}')
Start-Sleep -Milliseconds 700
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 1500

$edits2 = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)
$msgField = $edits2 | Where-Object { $_.Current.Name -match 'Type a message|Aa|Message|Continue' } | Select-Object -First 1
if (-not $msgField) { $msgField = $edits2 | Select-Object -Last 1 }
if (-not $msgField) { throw 'Could not find the message field. The phone number may not have resolved — check that the contact is available in Phone Link.' }

$msgField.SetFocus()
Start-Sleep -Milliseconds 300

# Use clipboard paste so emoji and unicode are preserved
[System.Windows.Forms.Clipboard]::SetText('${safeMessage}')
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 500

# Try to find and invoke the Send button; fall back to Enter on any failure.
$sendBtn = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond) |
  Where-Object { $_.Current.Name -match '^Send$|^Send message$' } |
  Select-Object -First 1
if ($sendBtn) {
  try {
    $sendBtn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  } catch {
    # Button found but not yet clickable (e.g. still loading) — fall back to Enter.
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  }
} else {
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
}
Start-Sleep -Milliseconds 1200

# Verify the message was sent by checking that the message field is now empty.
# If it still contains text the send did not go through — fail explicitly so the
# caller marks this message as failed rather than silently recording a false success.
$edits3 = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)
$verifyField = $edits3 | Where-Object { $_.Current.Name -match 'Type a message|Aa|Message|Continue' } | Select-Object -First 1
if ($verifyField) {
  $remaining = ''
  try {
    $vp = $verifyField.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $remaining = $vp.Current.Value
  } catch {}
  if ($remaining -and $remaining.Trim() -ne '') {
    throw "Message did not send — Phone Link still shows text in the message field. Make sure Phone Link is connected to your phone and try again."
  }
}
`;

  // Write as UTF-16 LE with BOM — PS5 (Windows 10 default) reads .ps1 as system ANSI
  // without a BOM, which corrupts special characters. UTF-16 LE BOM is always safe.
  const scriptBuffer = Buffer.concat([
    Buffer.from([0xFF, 0xFE]),
    Buffer.from(script, 'utf16le'),
  ]);
  writeFileSync(tmpFile, scriptBuffer);

  try {
    await new Promise((resolve, reject) => {
      execFile(
        'powershell',
        ['-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpFile],
        { windowsHide: true, timeout: 30000 },
        (err, stdout, stderr) => {
          if (err) {
            const raw = (stderr || stdout || '').toString().trim();
            if (!raw && (err.killed || err.code === 'ETIMEDOUT' || err.signal)) {
              return reject(new Error('Phone Link did not respond in time. Make sure Phone Link is open and your phone is connected.'));
            }
            // Extract just the human-readable first line from PS error output.
            const friendly = parsePsError(raw);
            return reject(new Error(friendly || 'Phone Link automation error — please try again.'));
          }
          resolve();
        }
      );
    });
  } finally {
    try { unlinkSync(tmpFile); } catch (_) {}
  }
  return true;
};
