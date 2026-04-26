const { execFileSync } = require('child_process');

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

# Bring Phone Link to front via UIAutomation SetFocus (no C# needed, no MainWindowHandle needed)
$window.SetFocus()
Start-Sleep -Milliseconds 500

# Open new message — try compose button first, fall back to Ctrl+N
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
Start-Sleep -Milliseconds 500

# Find edit fields — only use ControlType + IsEnabled (AndCondition max 2 args)
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
if (-not $recipient) { throw 'Recipient field not found' }

$recipient.SetFocus()
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait('${safeNumber}')
Start-Sleep -Milliseconds 700
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
# Wait for Phone Link to redraw the conversation view — iPhone contacts may take longer to resolve
Start-Sleep -Milliseconds 2000

$edits2 = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)
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

# Try to find and invoke the Send button — more reliable than Enter in Phone Link
$sendBtn = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond) |
  Where-Object { $_.Current.Name -match '^Send$|^Send message$' } |
  Select-Object -First 1
if ($sendBtn) {
  $sendBtn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
} else {
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
}
Start-Sleep -Milliseconds 500
`;

  // Encode as UTF-16 LE Base64 for PowerShell -EncodedCommand.
  // PS5 (Windows 10 default) reads .ps1 files as system ANSI when there's no BOM,
  // which corrupts emoji and other non-ASCII characters. -EncodedCommand bypasses
  // file I/O entirely and guarantees correct unicode handling.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    execFileSync(
      'powershell',
      ['-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (err) {
    const detail = ((err.stderr || err.stdout || '').toString().trim());
    throw new Error(detail || err.message);
  }
  return true;
};
