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
  const safeMessage = escapeSendKeys(escapePowerShell(message || ''));
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
}
"@ -Language CSharp

# ── 1. Find Phone Link process (any UWP variant) ────────────────────────────
$proc = $null
foreach ($name in @(${processNames.map(n => `'${n}'`).join(',')})) {
  $found = Get-Process -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { $proc = $found; break }
}
if (-not $proc) {
  $allPhone = (Get-Process | Where-Object { $_.Name -match 'phone|yourphone' } |
    Select-Object -ExpandProperty Name -Unique) -join ', '
  throw "Phone Link not found. Processes: [$allPhone]. Open Phone Link and try again."
}

# ── 2. Find Phone Link window via UIAutomation ──────────────────────────────
$root = [System.Windows.Automation.AutomationElement]::RootElement
$pidCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id
)

function Find-PhoneLinkWindow {
  param([int]$timeoutSeconds = 6)
  $deadline = [datetime]::Now.AddSeconds($timeoutSeconds)
  while ([datetime]::Now -lt $deadline) {
    $w = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $pidCond)
    if ($w) { return $w }
    Start-Sleep -Milliseconds 250
  }
  return $null
}

$window = Find-PhoneLinkWindow 6
if (-not $window) { throw 'Could not find Phone Link window via UIAutomation' }

# ── 3. Restore + foreground + SetFocus with retries ─────────────────────────
# Multi-send failures (3rd send fails with "Target element cannot receive
# focus") happen when Phone Link's window is minimized, backgrounded, or its
# UIAutomation element is stale after the previous send's UI transition.
# Strategy: restore the native window first (ShowWindow SW_RESTORE +
# SetForegroundWindow), then try SetFocus on the element with re-find retries.
$hwnd = [IntPtr]$window.Current.NativeWindowHandle
if ($hwnd -ne [IntPtr]::Zero) {
  [Win32]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE
  Start-Sleep -Milliseconds 150
  [Win32]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 150
}

$focusOk = $false
for ($i = 0; $i -lt 3 -and -not $focusOk; $i++) {
  try {
    $window.SetFocus()
    $focusOk = $true
  } catch {
    Start-Sleep -Milliseconds 400
    $window = Find-PhoneLinkWindow 3
    if (-not $window) { throw 'Phone Link window disappeared while focusing' }
    $hwnd = [IntPtr]$window.Current.NativeWindowHandle
    if ($hwnd -ne [IntPtr]::Zero) {
      [Win32]::ShowWindow($hwnd, 9) | Out-Null
      [Win32]::SetForegroundWindow($hwnd) | Out-Null
      Start-Sleep -Milliseconds 200
    }
  }
}
if (-not $focusOk) { throw 'Could not focus Phone Link after 3 attempts. Click on Phone Link and try again.' }
Start-Sleep -Milliseconds 500

# ── 4. Shared condition objects ─────────────────────────────────────────────
$btnTypeCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Button
)
$invokableCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty, $true
)
$btnCond = New-Object System.Windows.Automation.AndCondition($btnTypeCond, $invokableCond)

$editTypeCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Edit
)
$enabledCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::IsEnabledProperty, $true
)
$editCond = New-Object System.Windows.Automation.AndCondition($editTypeCond, $enabledCond)

# ── 5. Open compose: try compose button first, fall back to Ctrl+N ──────────
$compose = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond) |
  Where-Object { $_.Current.Name -match 'New message|Compose|New conversation' } |
  Select-Object -First 1
if ($compose) {
  $compose.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
} else {
  [System.Windows.Forms.SendKeys]::SendWait('^n')
}
Start-Sleep -Milliseconds 700

# ── 6. Find recipient field by Name, type number, Enter ─────────────────────
$edits = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)
$recipient = $edits | Where-Object { $_.Current.Name -match 'Type a name|Type a number|To:' } | Select-Object -First 1
if (-not $recipient) { $recipient = $edits | Select-Object -First 1 }
if (-not $recipient) { throw 'Recipient field not found' }

$recipient.SetFocus()
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait('${safeNumber}')
Start-Sleep -Milliseconds 800
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 1300

# ── 7. Find message field by Name (poll up to 4s), type message ─────────────
# Phone Link can take a moment to re-render after the recipient Enter — poll
# rather than relying on a single fixed sleep.
$msgField = $null
$msgDeadline = [datetime]::Now.AddSeconds(4)
while ([datetime]::Now -lt $msgDeadline -and -not $msgField) {
  $edits2 = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)
  $msgField = $edits2 | Where-Object { $_.Current.Name -match 'Type a message|Aa|Message|Continue' } | Select-Object -First 1
  if (-not $msgField -and $edits2.Count -gt $edits.Count) {
    # Conversation view added a new edit field; take the last one
    $msgField = $edits2 | Select-Object -Last 1
  }
  if (-not $msgField) { Start-Sleep -Milliseconds 250 }
}
if (-not $msgField) { throw 'Message field not found' }

$msgField.SetFocus()
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait('${safeMessage}')
Start-Sleep -Milliseconds 500

# ── 8. Invoke Send button; fall back to Enter ───────────────────────────────
$sendBtn = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond) |
  Where-Object { $_.Current.Name -match '^Send$|^Send message$' } |
  Select-Object -First 1
if ($sendBtn) {
  $sendBtn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
} else {
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
}
Start-Sleep -Milliseconds 600
`;

  const scriptBuffer = Buffer.concat([
    Buffer.from([0xFF, 0xFE]),
    Buffer.from(script, 'utf16le'),
  ]);
  writeFileSync(tmpFile, scriptBuffer);

  try {
    await new Promise((resolve, reject) => {
      const proc = execFile(
        'powershell',
        ['-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', tmpFile],
        { windowsHide: true, timeout: 45000 },
        (err, stdout, stderr) => {
          if (err) {
            if (err.killed || err.signal === 'SIGTERM') {
              return reject(new Error('Send cancelled by user'));
            }
            const detail = (stderr || stdout || '').toString().trim();
            if (!detail && (err.code === 'ETIMEDOUT')) {
              return reject(new Error('Phone Link automation timed out — make sure Phone Link is open and responsive'));
            }
            return reject(new Error(detail || err.message));
          }
          resolve();
        }
      );
      if (typeof global.__registerSendProc === 'function') global.__registerSendProc(proc);
    });
  } finally {
    try { unlinkSync(tmpFile); } catch (_) {}
  }
  return true;
};
