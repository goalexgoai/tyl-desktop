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

module.exports = async function sendViaPhoneLink(number, message) {
  const safeNumber = escapeSendKeys(escapePowerShell(number));
  const safeMessage = escapePowerShell(message || '');
  const tmpFile = join(os.tmpdir(), `textyourlist-${Date.now()}.ps1`);

  const processNames = ['PhoneLink', 'PhoneLinkHost', 'PhoneExperienceHost', 'PhoneExperience', 'PhoneLinkInfrastructureHost', 'YourPhone', 'YourPhoneServiceHost'];

  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
}
"@ -Language CSharp

# ── 1. Find Phone Link process ──────────────────────────────────────────────
$proc = $null
foreach ($name in @(${processNames.map(n => `'${n}'`).join(',')})) {
  $found = Get-Process -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { $proc = $found; break }
}
if (-not $proc) {
  $allPhone = (Get-Process | Where-Object { $_.Name -match 'phone|yourphone' } |
    Select-Object -ExpandProperty Name -Unique) -join ', '
  throw "Phone Link not found. Processes running: [$allPhone]. Open Phone Link and try again."
}

# ── 2. Find Phone Link window via UIAutomation ──────────────────────────────
# Modern Phone Link (MSIX/UWP) has MainWindowHandle = 0, so we must use UIAutomation.
$root = [System.Windows.Automation.AutomationElement]::RootElement
$pidCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id
)

function Wait-Element($start, $cond, $timeoutSec = 10) {
  $deadline = [datetime]::Now.AddSeconds($timeoutSec)
  while ([datetime]::Now -lt $deadline) {
    $el = $start.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if ($el) { return $el }
    Start-Sleep -Milliseconds 250
  }
  return $null
}

$window = Wait-Element $root $pidCond 6
if (-not $window) { throw 'Could not find Phone Link window via UIAutomation' }

# ── 3. Bring Phone Link to foreground ───────────────────────────────────────
# Three-layer approach: UIAutomation SetFocus, Win32 SetForegroundWindow (if HWND exists),
# and WScript.Shell AppActivate by PID (works even for packaged apps with no classic HWND).
$window.SetFocus()
$hwnd = [IntPtr]$window.Current.NativeWindowHandle
if ($hwnd -ne [IntPtr]::Zero) {
  [Win32]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE
  [Win32]::SetForegroundWindow($hwnd) | Out-Null
}
$shell = New-Object -ComObject WScript.Shell
# Try by PID, then by known window titles as fallback
if (-not $shell.AppActivate($proc.Id)) {
  if (-not $shell.AppActivate('Phone Link')) {
    $shell.AppActivate('Link to Windows') | Out-Null
  }
}
Start-Sleep -Milliseconds 800

# ── 4. Open compose view via Ctrl+N ─────────────────────────────────────────
$editTypeCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Edit
)
$editsBefore = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editTypeCond).Count

[System.Windows.Forms.SendKeys]::SendWait('^n')

# Wait up to 4s for compose to open — we know it opened when a new Edit field appears.
$composeDeadline = [datetime]::Now.AddSeconds(4)
$composeOpened = $false
while ([datetime]::Now -lt $composeDeadline) {
  if ($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editTypeCond).Count -gt $editsBefore) {
    $composeOpened = $true
    break
  }
  Start-Sleep -Milliseconds 200
}
if (-not $composeOpened) {
  throw 'Phone Link compose view did not open — Phone Link may not be in the foreground. Make sure Phone Link is the active window and try again.'
}
Start-Sleep -Milliseconds 400

# ── 5. Type recipient — no silent fallback ───────────────────────────────────
$edits = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editTypeCond)
$recipient = $edits | Where-Object {
  $_.Current.Name -match 'Type a name|Type a number|To:|Search|recipient|Enter name|name, number|number or email'
} | Select-Object -First 1

if (-not $recipient) {
  # If field names don't match — could be a newer Phone Link version.
  # Only proceed with the first field if there is exactly one new field compared to before,
  # which strongly implies it's the compose To: field.
  $allEdits = @($edits)
  $newFieldCount = $allEdits.Count - $editsBefore
  if ($newFieldCount -eq 1) {
    $recipient = $allEdits | Select-Object -Last 1
  } else {
    throw "Recipient (To:) field not found in Phone Link. Edit fields visible: $($edits.Count), field names: $(($edits | ForEach-Object { $_.Current.Name }) -join ', ')"
  }
}

$recipient.SetFocus()
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait('${safeNumber}')
Start-Sleep -Milliseconds 900
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')

# ── 6. Wait for conversation view to load ────────────────────────────────────
# iPhone contacts take up to 3s to resolve; Android is faster.
Start-Sleep -Milliseconds 3000

# ── 7. Find message field ────────────────────────────────────────────────────
$edits2 = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editTypeCond)
$msgField = $edits2 | Where-Object {
  $n = $_.Current.Name
  ($n -match 'Type a message|Aa|Message|Continue|Text message|iMessage|SMS') -and
  ($n -notmatch 'Type a name|Type a number|To:|recipient|Enter name|name, number')
} | Select-Object -First 1

if (-not $msgField) {
  # TAB from current focus — Phone Link moves keyboard focus to message field
  # after the recipient resolves. More reliable across versions than UIAutomation name matching.
  [System.Windows.Forms.SendKeys]::SendWait('{TAB}')
  Start-Sleep -Milliseconds 500
  # Re-query; the message field should now have focus.
  # We don't need the element reference — we can paste + Enter directly.
} else {
  $msgField.SetFocus()
  Start-Sleep -Milliseconds 400
}

# ── 8. Paste message and send ─────────────────────────────────────────────────
# Clipboard preserves emoji and unicode; SendKeys would corrupt them.
[System.Windows.Forms.Clipboard]::SetText('${safeMessage}')
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 600
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 600
`;

  // UTF-16 LE with BOM — required for PowerShell 5 (Windows 10 default) to handle emoji correctly.
  // PS5 reads .ps1 as system ANSI without a BOM, corrupting non-ASCII.
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
        { windowsHide: true, timeout: 35000 },
        (err, stdout, stderr) => {
          if (err) {
            const detail = (stderr || stdout || '').toString().trim();
            if (!detail && (err.killed || err.code === 'ETIMEDOUT' || err.signal)) {
              return reject(new Error('Phone Link automation timed out — make sure Phone Link is open and responsive'));
            }
            return reject(new Error(detail || err.message));
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
