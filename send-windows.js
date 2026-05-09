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

# ── 3. Bring Phone Link to foreground — three-layer approach ───────────────
$window.SetFocus()
Start-Sleep -Milliseconds 200

$hwnd = [IntPtr]$window.Current.NativeWindowHandle
if ($hwnd -ne [IntPtr]::Zero) {
  [Win32]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE
  [Win32]::SetForegroundWindow($hwnd) | Out-Null
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

# ── 5. Type recipient number — focus is already on recipient field ──────────
[System.Windows.Forms.SendKeys]::SendWait('${safeNumber}')
Start-Sleep -Milliseconds 800
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')

# ── 6. Wait for conversation to load, then Tab to message field ─────────────
Start-Sleep -Milliseconds 1500
[System.Windows.Forms.SendKeys]::SendWait('{TAB}')
Start-Sleep -Milliseconds 400

# ── 7. Paste message and send ─────────────────────────────────────────────────
Set-Clipboard -Value '${safeMessage}'
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
