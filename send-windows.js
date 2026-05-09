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
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
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

function Is-PhoneLinkForeground {
  $fgHwnd = [Win32]::GetForegroundWindow()
  $fgPid = [uint32]0
  [Win32]::GetWindowThreadProcessId($fgHwnd, [ref]$fgPid) | Out-Null
  return ($fgPid -eq [uint32]$proc.Id)
}

$window = Wait-Element $root $pidCond 6
if (-not $window) { throw 'Could not find Phone Link window via UIAutomation' }

# ── 3. Bring Phone Link to foreground — verify it worked ───────────────────
# Layer 1: UIAutomation SetFocus (accessibility-level, bypasses some restrictions)
$window.SetFocus()
Start-Sleep -Milliseconds 200

# Layer 2: Win32 ShowWindow + SetForegroundWindow if we have an HWND
$hwnd = [IntPtr]$window.Current.NativeWindowHandle
if ($hwnd -ne [IntPtr]::Zero) {
  [Win32]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE
  [Win32]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 200
}

# Layer 3: WScript.Shell AppActivate — special Shell privilege, bypasses foreground lock
$shell = New-Object -ComObject WScript.Shell
if (-not $shell.AppActivate($proc.Id)) {
  if (-not $shell.AppActivate('Phone Link')) {
    $shell.AppActivate('Link to Windows') | Out-Null
  }
}
Start-Sleep -Milliseconds 300

# ── Verify foreground before sending any keys ───────────────────────────────
# If Phone Link is not the foreground window, Ctrl+N would go to the wrong app.
if (-not (Is-PhoneLinkForeground)) {
  # One more SetFocus attempt — UIAutomation can succeed even when Win32 API is blocked
  $window.SetFocus()
  Start-Sleep -Milliseconds 400
  if (-not (Is-PhoneLinkForeground)) {
    throw 'Could not bring Phone Link to the foreground. Click on the Phone Link window and try again.'
  }
}

# ── 4. Open compose view via Ctrl+N ─────────────────────────────────────────
$editTypeCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Edit
)
$editsBefore = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editTypeCond).Count

# SetFocus immediately before SendKeys — no gap for another window to steal focus
$window.SetFocus()
[System.Windows.Forms.SendKeys]::SendWait('^n')

# Wait up to 5s for a new Edit field to appear (compose dialog opened)
$composeDeadline = [datetime]::Now.AddSeconds(5)
$composeOpened = $false
while ([datetime]::Now -lt $composeDeadline) {
  if ($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editTypeCond).Count -gt $editsBefore) {
    $composeOpened = $true
    break
  }
  Start-Sleep -Milliseconds 200
}
if (-not $composeOpened) {
  throw 'Phone Link compose view did not open after Ctrl+N. Make sure Phone Link is open on the Messages tab and try again.'
}
Start-Sleep -Milliseconds 300

# ── 5. Type recipient ────────────────────────────────────────────────────────
$edits = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editTypeCond)
$recipient = $edits | Where-Object {
  $_.Current.Name -match 'Type a name|Type a number|To:|Search|recipient|Enter name|name, number|number or email'
} | Select-Object -First 1

if (-not $recipient) {
  $allEdits = @($edits)
  $newFieldCount = $allEdits.Count - $editsBefore
  if ($newFieldCount -eq 1) {
    $recipient = $allEdits | Select-Object -Last 1
  } else {
    throw "Recipient field not found. Fields visible ($($edits.Count)): $(($edits | ForEach-Object { """$($_.Current.Name)""" }) -join ', ')"
  }
}

$recipient.SetFocus()
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait('${safeNumber}')
Start-Sleep -Milliseconds 800
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')

# ── 6. Wait for conversation / message field to appear ──────────────────────
# Poll for the message field instead of sleeping a fixed 3s — faster and reliable.
$msgTypeCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Edit
)
$msgField = $null
$msgDeadline = [datetime]::Now.AddSeconds(6)
while ([datetime]::Now -lt $msgDeadline) {
  $candidates = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $msgTypeCond) |
    Where-Object {
      $n = $_.Current.Name
      ($n -match 'Type a message|Aa|Message|Continue|Text message|iMessage|SMS|message') -and
      ($n -notmatch 'Type a name|Type a number|To:|recipient|Enter name|name, number')
    }
  if ($candidates) { $msgField = @($candidates)[0]; break }
  Start-Sleep -Milliseconds 300
}

if ($msgField) {
  $msgField.SetFocus()
  Start-Sleep -Milliseconds 300
} else {
  # TAB fallback — Phone Link puts focus near the message input after recipient Enter.
  # Try up to 3 TABs to reach the message field.
  [System.Windows.Forms.SendKeys]::SendWait('{TAB}')
  Start-Sleep -Milliseconds 400
}

# ── 7. Paste message and send ─────────────────────────────────────────────────
[System.Windows.Forms.Clipboard]::SetText('${safeMessage}')
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 500
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 500
`;

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
