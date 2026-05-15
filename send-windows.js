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
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
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
  throw "Phone Link not found. Processes: [$allPhone]. Open Phone Link and try again."
}

# ── 2. Find Phone Link window via UIAutomation ──────────────────────────────
$root = [System.Windows.Automation.AutomationElement]::RootElement
$pidCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id
)

function Is-PhoneLinkForeground {
  $fgHwnd = [Win32]::GetForegroundWindow()
  $fgPid = [uint32]0
  [Win32]::GetWindowThreadProcessId($fgHwnd, [ref]$fgPid) | Out-Null
  return ($fgPid -eq [uint32]$proc.Id)
}

$window = $null
$winDeadline = [datetime]::Now.AddSeconds(6)
while ([datetime]::Now -lt $winDeadline) {
  $window = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $pidCond)
  if ($window) { break }
  Start-Sleep -Milliseconds 250
}
if (-not $window) { throw 'Could not find Phone Link window via UIAutomation' }

# ── 3. Bring Phone Link to foreground ──────────────────────────────────────
# Three-layer approach: UIAutomation → thread-input attachment → AppActivate
$window.SetFocus()
Start-Sleep -Milliseconds 200

$hwnd = [IntPtr]$window.Current.NativeWindowHandle
if ($hwnd -ne [IntPtr]::Zero) {
  [Win32]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE

  # Attach our PowerShell thread's input to Phone Link's thread so
  # SetForegroundWindow is not blocked by Windows foreground-steal restrictions.
  $phoneLinkTid = [uint32]0
  $phoneLinkTid = [Win32]::GetWindowThreadProcessId($hwnd, [ref]$phoneLinkTid)
  $myTid = [Win32]::GetCurrentThreadId()
  [Win32]::AttachThreadInput($myTid, $phoneLinkTid, $true) | Out-Null
  [Win32]::BringWindowToTop($hwnd) | Out-Null
  [Win32]::SetForegroundWindow($hwnd) | Out-Null
  [Win32]::AttachThreadInput($myTid, $phoneLinkTid, $false) | Out-Null
  Start-Sleep -Milliseconds 200
}

$shell = New-Object -ComObject WScript.Shell
if (-not $shell.AppActivate($proc.Id)) {
  if (-not $shell.AppActivate('Phone Link')) {
    $shell.AppActivate('Link to Windows') | Out-Null
  }
}
Start-Sleep -Milliseconds 300

if (-not (Is-PhoneLinkForeground)) {
  $window.SetFocus()
  Start-Sleep -Milliseconds 400
  if (-not (Is-PhoneLinkForeground)) {
    throw 'Could not bring Phone Link to the foreground. Click on the Phone Link window and try again.'
  }
}

# ── 4. Open compose via Ctrl+N — wait for new edit field ───────────────────
$editTypeCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Edit
)
$editsBefore = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editTypeCond).Count

$window.SetFocus()
[System.Windows.Forms.SendKeys]::SendWait('^n')

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

# ── 5. Type recipient number ────────────────────────────────────────────────
[System.Windows.Forms.SendKeys]::SendWait('${safeNumber}')
Start-Sleep -Milliseconds 800
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')

# ── 6. Find message field via UIAutomation, fall back to Tab ───────────────
# After recipient Enter, Phone Link transitions from compose to conversation view.
# Poll for an enabled, visible, empty Edit field — that is the message input.
# If UIAutomation can't find it (Phone Link version without ValuePattern), fall back.
$msgDeadline = [datetime]::Now.AddSeconds(6)
$msgField = $null
while ([datetime]::Now -lt $msgDeadline) {
  $edits = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editTypeCond)
  foreach ($edit in $edits) {
    if ($edit.Current.IsEnabled -and -not $edit.Current.IsOffscreen) {
      try {
        $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        if ($vp.Current.Value -eq '') { $msgField = $edit; break }
      } catch { }
    }
  }
  if ($msgField) { break }
  Start-Sleep -Milliseconds 200
}

if ($msgField) {
  $msgField.SetFocus()
  Start-Sleep -Milliseconds 300
} else {
  # Fallback: fixed wait then Tab (original behaviour for Phone Link versions
  # where UIAutomation ValuePattern is unavailable)
  Start-Sleep -Milliseconds 1200
  [System.Windows.Forms.SendKeys]::SendWait('{TAB}')
  Start-Sleep -Milliseconds 500
}

# ── 7. Paste message and send ───────────────────────────────────────────────
Set-Clipboard -Value '${safeMessage}'
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 500
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 800

# ── 8. Verify message was consumed ─────────────────────────────────────────
# If the compose field still has content after Enter, the keystroke was not
# captured (focus slipped). This turns a silent false-positive into a real
# failure that TYL can retry or surface to the user.
if ($msgField) {
  try {
    $vp2 = $msgField.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($vp2.Current.Value -ne '') {
      throw "Message may not have sent — compose field still has content after Enter. Phone Link may have lost focus mid-send."
    }
  } catch [System.Management.Automation.RuntimeException] { throw }
  catch { }  # ValuePattern unavailable or element gone — skip check
}
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
        { windowsHide: true, timeout: 35000 },
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
