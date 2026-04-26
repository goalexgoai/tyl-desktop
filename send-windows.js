const { execFile } = require('child_process');
const { writeFileSync, unlinkSync } = require('fs');
const { join } = require('path');
const os = require('os');

function escapeSendKeys(value) {
  // Escape SendKeys special characters
  return value.replace(/([+^%~{}\[\]()])/g, '{$1}');
}

function escapePowerShell(value) {
  // Escape single quotes for PowerShell single-quoted strings
  return value.replace(/'/g, "''");
}

module.exports = async function sendViaPhoneLink(number, message) {
  const safeNumber = escapeSendKeys(escapePowerShell(number));
  // Message goes via clipboard, not SendKeys — clipboard preserves emoji and unicode.
  // Only PowerShell single-quote escaping is needed here.
  const safeMessage = escapePowerShell(message || '');
  const tmpFile = join(os.tmpdir(), `textyourlist-${Date.now()}.ps1`);

  const processNames = ['PhoneLink', 'PhoneLinkHost', 'PhoneExperienceHost', 'PhoneExperience', 'PhoneLinkInfrastructureHost', 'YourPhone', 'YourPhoneServiceHost'];

  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

# Find Phone Link across all known process names — never filter by MainWindowHandle (UWP = 0)
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

# Bring Phone Link to front
$window.SetFocus()
Start-Sleep -Milliseconds 500

# Open new message via Ctrl+N — skipping button search avoids slow FindAll on WebView2 UI tree
[System.Windows.Forms.SendKeys]::SendWait('^n')
Start-Sleep -Milliseconds 800

# Find edit fields using only ControlType (no compound conditions — faster on WebView2)
$editTypeCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Edit
)

$edits = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editTypeCond)
$recipient = $edits | Where-Object { $_.Current.Name -match 'Type a name|Type a number|To:' } | Select-Object -First 1
if (-not $recipient) { $recipient = $edits | Select-Object -First 1 }
if (-not $recipient) { throw 'Recipient field not found' }

$recipient.SetFocus()
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait('${safeNumber}')
Start-Sleep -Milliseconds 700
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
# Wait for Phone Link to redraw the conversation view — iPhone contacts may take longer to resolve
Start-Sleep -Milliseconds 2000

$edits2 = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editTypeCond)
$msgField = $edits2 | Where-Object { $_.Current.Name -match 'Type a message|Aa|Message|Continue' } | Select-Object -First 1
if (-not $msgField) { $msgField = $edits2 | Select-Object -Last 1 }
if (-not $msgField) { throw 'Message field not found' }

$msgField.SetFocus()
Start-Sleep -Milliseconds 300
# Use clipboard paste so emoji and unicode characters are preserved
[System.Windows.Forms.Clipboard]::SetText('${safeMessage}')
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 500
# Send via Enter key — avoids slow FindAll for send button on WebView2 UI tree
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 500
`;

  // Write as UTF-16 LE with BOM so PowerShell 5 (Windows 10 default) reads it correctly.
  // PS5 reads .ps1 files as system ANSI when there's no BOM, corrupting emoji.
  // UTF-16 LE + BOM is the one encoding PS5 always handles correctly.
  const scriptBuffer = Buffer.concat([
    Buffer.from([0xFF, 0xFE]), // UTF-16 LE BOM
    Buffer.from(script, 'utf16le'),
  ]);
  writeFileSync(tmpFile, scriptBuffer);

  try {
    await new Promise((resolve, reject) => {
      execFile(
        'powershell',
        ['-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpFile],
        { windowsHide: true, timeout: 25000 },
        (err, stdout, stderr) => {
          if (err) {
            const detail = ((stderr || stdout || '').toString().trim());
            // Treat a timeout as "Phone Link not responding" so the job pauses
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
