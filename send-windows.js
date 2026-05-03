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
  // Message goes via clipboard — preserves emoji and unicode without SendKeys escaping.
  const safeMessage = escapePowerShell(message || '');
  const tmpFile = join(os.tmpdir(), `textyourlist-${Date.now()}.ps1`);

  const processNames = ['PhoneLink', 'PhoneLinkHost', 'PhoneExperienceHost', 'PhoneExperience', 'PhoneLinkInfrastructureHost', 'YourPhone', 'YourPhoneServiceHost'];

  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

# Find Phone Link across all known process names
$proc = $null
foreach ($name in @(${processNames.map(n => `'${n}'`).join(',')})) {
  $found = Get-Process -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { $proc = $found; break }
}
if (-not $proc) {
  $allPhone = (Get-Process | Where-Object { $_.Name -match 'phone|yourphone' } | Select-Object -ExpandProperty Name -Unique) -join ', '
  throw "Phone Link not found. Phone-related processes running: [$allPhone]. Make sure Phone Link is open."
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
if (-not $window) { throw 'Could not find Phone Link window via UIAutomation' }

$window.SetFocus()
Start-Sleep -Milliseconds 500

# Press Escape several times to dismiss any open conversation/dialog and return Phone Link to the home screen.
# This is critical for group sends — after the first message Phone Link stays in the conversation view,
# so the second call would attempt to compose from the wrong state without this reset.
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
  $compose.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
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
if (-not $recipient) { throw 'Recipient field not found — new message dialog may not have opened. Make sure Phone Link is on the home screen, not inside an existing conversation.' }

$recipient.SetFocus()
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait('${safeNumber}')
Start-Sleep -Milliseconds 700
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 1500

$edits2 = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)
$msgField = $edits2 | Where-Object { $_.Current.Name -match 'Type a message|Aa|Message|Continue' } | Select-Object -First 1
if (-not $msgField) { $msgField = $edits2 | Select-Object -Last 1 }
if (-not $msgField) { throw 'Message field not found — phone number may not have resolved. Check that the contact exists in Phone Link.' }

$msgField.SetFocus()
Start-Sleep -Milliseconds 300

# Use clipboard paste so emoji and unicode are preserved
[System.Windows.Forms.Clipboard]::SetText('${safeMessage}')
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 500

# Try to find and invoke the Send button; fall back to Enter
$sendBtn = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond) |
  Where-Object { $_.Current.Name -match '^Send$|^Send message$' } |
  Select-Object -First 1
if ($sendBtn) {
  $sendBtn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
} else {
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
}
Start-Sleep -Milliseconds 1200

# Verify the message was sent by checking that the message field is now empty.
# If it still contains text the send did not go through — throw so the caller marks it failed
# rather than silently recording a false success.
$edits3 = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)
$verifyField = $edits3 | Where-Object { $_.Current.Name -match 'Type a message|Aa|Message|Continue' } | Select-Object -First 1
if ($verifyField) {
  $remaining = ''
  try {
    $vp = $verifyField.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $remaining = $vp.Current.Value
  } catch {}
  if ($remaining -and $remaining.Trim() -ne '') {
    throw "Message send may have failed — message field still contains text after send attempt. Phone Link may not have sent the message."
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
            const detail = (stderr || stdout || '').toString().trim();
            if (!detail && (err.killed || err.code === 'ETIMEDOUT' || err.signal)) {
              return reject(new Error('Could not find Phone Link window via UIAutomation (timed out)'));
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
