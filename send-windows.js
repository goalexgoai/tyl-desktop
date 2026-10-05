// =============================================================================
// Windows Phone Link send — DO NOT CHANGE without reading this header.
// =============================================================================
// Confirmed working as of v1.0.87 on Windows 11 24H2 with PhoneExperienceHost
// as the Phone Link UWP host. Diagnostic log from a working bulk-send was
// captured 2026-05-18 and lives in the v1.0.87 history. Every line below was
// validated against that log. If you change this file, run the same scenario
// (3-message bulk, Phone Link behind TYL, emoji + field merge) and re-capture
// %TEMP%\tyl-send-debug.log to verify the same tier transitions still fire.
//
// EMPIRICAL FINDINGS — these are not theories, they are what actually happens
// in the field. Treat as load-bearing.
//
//   1) UIAutomation `$window.SetFocus()` ALWAYS THROWS "Target element cannot
//      receive focus" on Phone Link's root window. This is benign — the root
//      doesn't expose a focusable element directly. Catch and proceed. Do
//      NOT use SetFocus throwing as a signal that focus failed.
//
//   2) Win11 24H2 takes ~500ms for a foreground transition to actually settle
//      after `SetForegroundWindow` returns. v1.0.85 checked at 200ms, saw
//      "not foreground", retried, and the retry created a flapping state that
//      made every send fail. Keep at least 500ms total between
//      `SetForegroundWindow` and the next `Is-PhoneLinkFg` check (we currently
//      use 300ms + 200ms = 500ms; do not tighten).
//
//   3) `AttachThreadInput` returns False on Dustin's setup (integrity-level
//      mismatch between Electron child PowerShell and the UWP Phone Link host).
//      It's a no-op here but harmless. Do NOT add a guard that aborts when
//      AttachThreadInput returns False — SetForegroundWindow alone is what
//      actually works.
//
//   4) Field detection MUST be by Name match, not "first empty Edit":
//        - Recipient: /Type a name|Type a number|To:/  (log saw "To")
//        - Message:   /Type a message|Aa|Message|Continue/
//                      (log saw "Send a message, Conversation with…")
//        - Compose button: /New message|Compose|New conversation/
//        - Send button: /^Send$|^Send message$/
//      If Phone Link's UI strings change, update these regexes — the debug log
//      will show the new strings under "recipient field: edits_found=…
//      picked='…'" and "message field: attempts=… picked='…'".
//
//   5) DO NOT add post-send verification via ValuePattern. v1.0.81 had a check
//      that read $msgField.ValuePattern.Value after Enter and threw "Message
//      may not have sent" if non-empty. The field re-renders after send and
//      the stale reference produced FALSE NEGATIVES — messages WERE sent but
//      TYL marked them failed. The Send button Invoke is the signal that the
//      message was submitted; the Phone Link app handles the rest.
//
//   6) Send via the Send BUTTON (UIAutomation Invoke), not Enter. Enter is a
//      fallback only when the button can't be located. Enter is unreliable
//      when focus has slipped (it inserts a newline or no-ops). The log
//      confirms the Send button was found and invoked on each send.
//
//   7) Use SendKeys for typing, NOT clipboard paste (Set-Clipboard + Ctrl+V).
//      Clipboard pollutes the user's clipboard AND fails silently if focus
//      shifts between Set-Clipboard and Ctrl+V. SendKeys types directly into
//      the focused field and degrades gracefully.
//
//   8) Process name match list MUST include 'PhoneExperienceHost' (that's what
//      Phone Link actually runs under on Win11 24H2; the older 'PhoneLink' and
//      'YourPhone' names are legacy). The log confirms 'PhoneExperienceHost'.
//
//   9) The JS template literal interpolation `${name}` collides with
//      PowerShell's `${name}` variable syntax. If you need a PowerShell
//      `${variable}` inside this script, escape the dollar sign as `\${name}`
//      so JS leaves it for PowerShell. v1.0.86 shipped broken because of
//      `${windowSearchMs}` being JS-interpolated (windowSearchMs undefined →
//      ReferenceError before PowerShell ever ran). The valid JS
//      interpolations in this file are: Date.now(), processNames.map() (twice),
//      safeNumber, safeMessage — all the rest of `${…}` must be `\${…}`.
//
//  10) PhoneExperienceHost keeps running in the background after the user
//      closes the Phone Link window. "Process found, window not found" means
//      Phone Link is closed, so launch it (shell:AppsFolder) and search again.
//      Seen in field logs Sept 2026 ("could not find Phone Link window in
//      8550ms"). Runs only when the window search has already failed.
//
//  11) If no compose button is found, Phone Link is usually on another tab
//      (field logs: only edit was "Search your contacts", or zero edits).
//      Select the "Messages" nav item and look again. Runs only when compose
//      was not found; logs nav_names so a mismatch is diagnosable.
//
//  13) Phone Link's UI includes phone NOTIFICATIONS as controls (sender +
//      preview text). Never log long control names. When compose and the
//      Messages tab are both missing, throw a specific error only for screens
//      we can identify for certain (first-run setup, Bluetooth pairing
//      failed). "iPhone paired, no Messages" is NOT assumed to be a phone
//      permission problem: the Messages tab may be a control type we don't
//      search. Field logs 2026-10-04 (Windows 10 + iPhone).
//
//  14) On those failures, Log-Diagnostics dumps Phone Link version, OS build,
//      language and the control tree (type + AutomationId; names only when
//      short; server keeps only known labels). Once per send. No mouse
//      clicks to activate Messages: DPI scaling makes coordinates unreliable.
//
//  12) PowerShell treats ‘ ’ ‚ ‛ as single quotes too. escapePowerShell must
//      double all of them, or a pasted ’ breaks every send in the job.
//
// PRIOR REGRESSIONS — captured here so the same mistakes are not re-made:
//   - v1.0.81: added foreground hardening that broke bulk sending because of
//     points 5, 6, and 4 above.
//   - v1.0.83: stripped foreground APIs entirely; worked for the easy case but
//     could not recover when Phone Link was behind another window.
//   - v1.0.84: added ShowWindow+SetForegroundWindow without timing or tier
//     model — Phone Link half-restored to a non-focusable state.
//   - v1.0.85: full AttachThreadInput chain in a 3-retry loop — too tight a
//     foreground check (200ms) caused flapping; every send failed.
//   - v1.0.86: correct design but undefined-variable JS bug crashed before
//     PowerShell ran.
//   - v1.0.87: the design above; first working bulk-send confirmed by Dustin
//     including emoji and field merges.
//
// If you are changing this file, ask yourself: am I about to break one of
// the 9 findings above? If so, capture a debug log first and prove the
// finding is no longer true on the target system.
// =============================================================================

const { execFile } = require('child_process');
const { writeFileSync, unlinkSync } = require('fs');
const { join } = require('path');
const os = require('os');

function escapeSendKeys(value) {
  return value.replace(/([+^%~{}\[\]()])/g, '{$1}');
}

// PowerShell treats the typographic quotes ‘ ’ ‚ ‛ (U+2018–U+201B) as single-
// quote delimiters, not just ASCII '. Text pasted from Word/Docs/phones uses ’,
// which previously terminated the '...' string early and every send in the job
// died with a ParserError ("Missing ')' in method call"). Doubling any of them
// escapes it; PowerShell keeps the second char, so ’ is still typed as ’.
function escapePowerShell(value) {
  return value.replace(/['‘’‚‛]/g, "$&$&");
}

module.exports = async function sendViaPhoneLink(number, message) {
  const safeNumber = escapeSendKeys(escapePowerShell(number));
  const safeMessage = escapeSendKeys(escapePowerShell(message || ''));
  const tmpFile = join(os.tmpdir(), `textyourlist-${Date.now()}.ps1`);

  const processNames = ['PhoneLink', 'PhoneLinkHost', 'PhoneExperienceHost', 'PhoneExperience', 'PhoneLinkInfrastructureHost', 'YourPhone', 'YourPhoneServiceHost'];

  // v1.0.86 — diagnostic build. Restores v1.0.83's SetFocus-first approach
  // (which Dustin reported worked best) and adds the AttachThreadInput chain
  // only as a fallback if SetFocus fails. Writes every step to
  // %TEMP%\tyl-send-debug.log so the actual failure mode is observable.
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
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet=CharSet.Auto, SetLastError=true)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
}
"@ -Language CSharp

# ── Diagnostic log ──────────────────────────────────────────────────────────
$DEBUG_LOG = Join-Path $env:TEMP 'tyl-send-debug.log'
function Log($msg) {
  try { Add-Content -Path $DEBUG_LOG -Value ("[" + (Get-Date -Format 'HH:mm:ss.fff') + "] " + $msg) -ErrorAction SilentlyContinue } catch { }
}
function Log-Foreground($label) {
  try {
    $fg = [Win32]::GetForegroundWindow()
    $fgPid = [uint32]0
    [Win32]::GetWindowThreadProcessId($fg, [ref]$fgPid) | Out-Null
    $sb = New-Object System.Text.StringBuilder 256
    [Win32]::GetWindowText($fg, $sb, 256) | Out-Null
    $title = $sb.ToString()
    $procName = ''
    try { $procName = (Get-Process -Id $fgPid -ErrorAction SilentlyContinue).Name } catch { }
    Log "$label foreground: hwnd=$fg, pid=$fgPid, proc=$procName, title='$title'"
  } catch { Log "$label foreground: log failed: $($_.Exception.Message)" }
}

# ── Failure diagnostics (finding 14) ────────────────────────────────────────
# One-time dump when a send can't find what it needs: Phone Link version, OS
# build, language, and the window's controls by type + AutomationId. Names are
# kept only when short and single-line (long ones are notifications), and the
# server keeps only known Phone Link labels. AutomationIds that look like
# numbers or addresses are masked.
$script:diagDone = $false
function Log-Diagnostics($win) {
  if ($script:diagDone) { return }
  $script:diagDone = $true
  try {
    $pl = Get-AppxPackage -Name Microsoft.YourPhone -ErrorAction SilentlyContinue | Select-Object -First 1
    $nt = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion' -ErrorAction SilentlyContinue
    Log "env: phonelink=$($pl.Version) build=$($nt.CurrentBuild).$($nt.UBR) release=$($nt.DisplayVersion) culture=$((Get-Culture).Name) ui=$((Get-UICulture).Name)"
  } catch { Log "env: failed: $($_.Exception.Message)" }
  if (-not $win) { return }
  try {
    $els = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $n = 0
    foreach ($e in $els) {
      $c = $e.Current
      $t = $c.ControlType.ProgrammaticName.Replace('ControlType.', '')
      if ($t -eq 'Text' -or $t -eq 'Image') { continue }
      if ($n -ge 150) { Log "ui: truncated at 150 of $($els.Count) elements"; break }
      $nm = $c.Name
      $nmOut = if ($nm -and $nm.Length -le 40 -and $nm -notmatch "[\r\n]") { $nm } elseif ($nm) { "<len $($nm.Length)>" } else { '' }
      $aid = $c.AutomationId
      if ($aid -match '[0-9]{5,}|@|[+]') { $aid = '<masked>' }
      Log ("ui: type=" + $t + " id='" + $aid + "' class='" + $c.ClassName + "' enabled=" + $c.IsEnabled + " offscreen=" + $c.IsOffscreen + " name='" + $nmOut + "'")
      $n++
    }
  } catch { Log "ui: dump failed: $($_.Exception.Message)" }
}

Log "════════ send start (v1.0.86) ════════"
Log-Foreground "initial"

# ── 1. Find Phone Link process ──────────────────────────────────────────────
$proc = $null
$matched = ''
foreach ($name in @(${processNames.map(n => `'${n}'`).join(',')})) {
  $found = Get-Process -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { $proc = $found; $matched = $name; break }
}
$allCandidates = (Get-Process | Where-Object { $_.Name -match 'phone|yourphone|link.*window' } |
  Select-Object -ExpandProperty Name -Unique) -join ', '
Log "process search: matched='$matched' pid=$($proc.Id) all_phone_candidates=[$allCandidates]"
if (-not $proc) {
  Log "FATAL: Phone Link process not found"
  throw "Phone Link not found. Processes: [$allCandidates]. Open Phone Link and try again."
}

# ── 2. Find Phone Link window via UIAutomation ──────────────────────────────
$root = [System.Windows.Automation.AutomationElement]::RootElement
$pidCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id
)
$windowSearchStart = [datetime]::Now
$window = $null
$winDeadline = $windowSearchStart.AddSeconds(8)
while ([datetime]::Now -lt $winDeadline) {
  $window = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $pidCond)
  if ($window) { break }
  Start-Sleep -Milliseconds 250
}
$windowSearchMs = [int]([datetime]::Now - $windowSearchStart).TotalMilliseconds
if (-not $window) {
  # Failure path only (finding 10): PhoneExperienceHost keeps running in the
  # background after the user closes Phone Link, so the process check above
  # passes but no window exists. Launch Phone Link and search once more.
  Log "window not found in \${windowSearchMs}ms; launching Phone Link and retrying"
  try { Start-Process -FilePath 'explorer.exe' -ArgumentList 'shell:AppsFolder\\Microsoft.YourPhone_8wekyb3d8bbwe!App' } catch { Log "launch threw: $($_.Exception.Message)" }
  $relaunchDeadline = [datetime]::Now.AddSeconds(15)
  while ([datetime]::Now -lt $relaunchDeadline) {
    Start-Sleep -Milliseconds 500
    foreach ($name in @(${processNames.map(n => `'${n}'`).join(',')})) {
      $found = Get-Process -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($found) {
        $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $found.Id)
        $w = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $c)
        if ($w) { $window = $w; $proc = $found; break }
      }
    }
    if ($window) { break }
  }
  if ($window) {
    Log "window found after launch: pid=$($proc.Id)"
    # Give a freshly launched Phone Link time to load conversations.
    Start-Sleep -Milliseconds 2500
  }
}
if (-not $window) {
  Log "FATAL: UIAutomation could not find Phone Link window in \${windowSearchMs}ms (pid=$($proc.Id))"
  throw 'Could not find Phone Link window via UIAutomation'
}
$hwnd = [IntPtr]$window.Current.NativeWindowHandle
$winName = ''
try { $winName = $window.Current.Name } catch { }
Log "window found in \${windowSearchMs}ms: hwnd=$hwnd, name='$winName'"

# ── 3. Bring Phone Link to a focusable state ────────────────────────────────
# Try the simple v1.0.83 approach first (SetFocus on the AutomationElement).
# If that succeeds we never touch the foreground APIs. If it fails or doesn't
# actually transfer foreground, escalate through ShowWindow → AttachThreadInput
# → SetForegroundWindow → AppActivate, then re-try SetFocus.
function Is-PhoneLinkFg($targetPid) {
  $fg = [Win32]::GetForegroundWindow()
  if ($fg -eq [IntPtr]::Zero) { return $false }
  $fgPid = [uint32]0
  [Win32]::GetWindowThreadProcessId($fg, [ref]$fgPid) | Out-Null
  return ($fgPid -eq [uint32]$targetPid)
}

$focusOk = $false
try {
  $window.SetFocus()
  Start-Sleep -Milliseconds 300
  Log "tier 1: \$window.SetFocus() did not throw"
  if (Is-PhoneLinkFg $proc.Id) { $focusOk = $true; Log "tier 1: foreground transferred via SetFocus alone" }
  else { Log "tier 1: SetFocus did not bring window to foreground; will escalate" }
} catch {
  Log "tier 1: SetFocus threw: $($_.Exception.Message)"
}

if (-not $focusOk -and $hwnd -ne [IntPtr]::Zero) {
  Log "tier 2: ShowWindow(SW_RESTORE) + AttachThreadInput + SetForegroundWindow"
  [Win32]::ShowWindow($hwnd, 9) | Out-Null
  $phoneLinkTid = [uint32]0
  [Win32]::GetWindowThreadProcessId($hwnd, [ref]$phoneLinkTid) | Out-Null
  $myTid = [Win32]::GetCurrentThreadId()
  $attachOk = [Win32]::AttachThreadInput($myTid, $phoneLinkTid, $true)
  [Win32]::BringWindowToTop($hwnd) | Out-Null
  $sfwOk = [Win32]::SetForegroundWindow($hwnd)
  [Win32]::AttachThreadInput($myTid, $phoneLinkTid, $false) | Out-Null
  Log "tier 2: attach=$attachOk setForegroundWindow=$sfwOk myTid=$myTid phoneLinkTid=$phoneLinkTid"
  Start-Sleep -Milliseconds 300
  try { $window.SetFocus() } catch { Log "tier 2: post-escalation SetFocus threw: $($_.Exception.Message)" }
  Start-Sleep -Milliseconds 200
  if (Is-PhoneLinkFg $proc.Id) { $focusOk = $true; Log "tier 2: foreground transferred" }
  else { Log "tier 2: STILL not foreground after AttachThreadInput chain" }
}

if (-not $focusOk) {
  Log "tier 3: AppActivate fallback"
  try {
    $shell = New-Object -ComObject WScript.Shell
    $r1 = $shell.AppActivate([int]$proc.Id)
    $r2 = if (-not $r1) { $shell.AppActivate('Phone Link') } else { $true }
    $r3 = if (-not $r2) { $shell.AppActivate('Link to Windows') } else { $true }
    Log "tier 3: appActivate pid=$r1 name1=$r2 name2=$r3"
    Start-Sleep -Milliseconds 350
    try { $window.SetFocus() } catch { Log "tier 3: post-AppActivate SetFocus threw: $($_.Exception.Message)" }
    Start-Sleep -Milliseconds 200
    if (Is-PhoneLinkFg $proc.Id) { $focusOk = $true; Log "tier 3: foreground transferred" }
    else { Log "tier 3: STILL not foreground" }
  } catch {
    Log "tier 3: AppActivate threw: $($_.Exception.Message)"
  }
}

Log-Foreground "after focus attempt"

if (-not $focusOk) {
  Log "FATAL: could not bring Phone Link to foreground after 3 tiers"
  throw "Could not focus Phone Link. Click on the Phone Link window once, then try again. (Debug log: %TEMP%\\tyl-send-debug.log)"
}
Start-Sleep -Milliseconds 400

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
$composeBtns = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond) |
  Where-Object { $_.Current.Name -match 'New message|Compose|New conversation' }
$compose = $composeBtns | Select-Object -First 1
Log "compose: matching buttons=$($composeBtns.Count), invoked=$($compose -ne $null)"
if (-not $compose) {
  # Failure path only (finding 11): field logs show Phone Link parked on
  # Calls/Photos ("Search your contacts" was the only edit) or a screen with no
  # edits at all. Select the Messages nav item, then look for compose again.
  # When compose is found above, none of this runs.
  $navTypes = @('TabItem', 'ListItem', 'Button', 'MenuItem', 'Hyperlink')
  $allEls = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $navNames = ''
  try {
    # Long names are usually phone notifications (sender + preview), which must
    # never be logged; keep short single-line labels only (finding 13).
    $navNames = (@($allEls) | Where-Object { $navTypes -contains $_.Current.ControlType.ProgrammaticName.Replace('ControlType.', '') -and $_.Current.Name -and $_.Current.Name.Length -le 40 -and $_.Current.Name -notmatch "[\r\n]" } |
      ForEach-Object { "'" + $_.Current.Name + "'" } | Select-Object -Unique -First 40) -join ', '
  } catch { }
  Log "compose: none found; nav_names=[$navNames]"
  # Prefer navigation-type controls, but Phone Link's layouts differ (Android
  # vs iPhone, versions), so fall back to any control named exactly Messages.
  $msgNav = @($allEls) | Where-Object {
    $_.Current.Name -match '^Messages$' -and $navTypes -contains $_.Current.ControlType.ProgrammaticName.Replace('ControlType.', '')
  } | Select-Object -First 1
  if (-not $msgNav) {
    $msgNav = @($allEls) | Where-Object { $_.Current.Name -match '^Messages$' } | Select-Object -First 1
  }
  if ($msgNav) {
    $pat = $null
    $how = 'none'
    $navType = ''
    try { $navType = $msgNav.Current.ControlType.ProgrammaticName.Replace('ControlType.', '') } catch { }
    try {
      if ($msgNav.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pat)) { $pat.Select(); $how = 'select' }
      elseif ($msgNav.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) { $pat.Invoke(); $how = 'invoke' }
      elseif ($msgNav.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pat)) { $pat.Toggle(); $how = 'toggle' }
      elseif ($msgNav.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pat)) { $pat.Expand(); $how = 'expand' }
      else { $msgNav.SetFocus(); Start-Sleep -Milliseconds 200; [System.Windows.Forms.SendKeys]::SendWait(' '); $how = 'focus+space' }
    } catch { Log "compose: messages nav activate threw: $($_.Exception.Message)" }
    Log "compose: selected Messages nav (type=$navType) via $how"
    Start-Sleep -Milliseconds 1500
    $composeBtns = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond) |
      Where-Object { $_.Current.Name -match 'New message|Compose|New conversation' }
    $compose = $composeBtns | Select-Object -First 1
    Log "compose: after Messages nav matching buttons=$($composeBtns.Count), invoked=$($compose -ne $null)"
    if (-not $compose) { Log-Diagnostics $window }
  } else {
    Log "compose: no Messages nav item found"
    Log-Diagnostics $window
    # Only screens we can identify for certain get a specific error. Anything
    # else falls through to the Ctrl+N path, whose failure is diagnosed by the
    # dump above (finding 13).
    $labels = @($allEls | ForEach-Object { try { $_.Current.Name } catch { '' } } | Where-Object { $_ -and $_.Length -le 40 })
    if (($labels | Where-Object { $_ -match '^Android' }) -and ($labels | Where-Object { $_ -match '^iPhone' })) {
      Log "FATAL: Phone Link setup screen (no phone connected)"
      throw 'Phone Link not set up: no phone connected'
    }
    if ($labels -contains 'Try Bluetooth pairing again') {
      Log "FATAL: Phone Link Bluetooth pairing failed"
      throw 'Phone Link pairing incomplete'
    }
  }
}
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
$recipName = ''
try { if ($recipient) { $recipName = $recipient.Current.Name } } catch { }
# Dump every edit's Name so a failing machine's log reveals the actual UI
# strings (localization / Phone Link version drift show up here). Diagnostic
# only — does not affect the send path.
$editNames = ''
try { $editNames = (@($edits) | ForEach-Object { "'" + $_.Current.Name + "'" }) -join ', ' } catch { }
Log "recipient field: edits_found=$($edits.Count), picked='$recipName', all_edit_names=[$editNames]"
if (-not $recipient) {
  Log "FATAL: no recipient field"
  Log-Diagnostics $window
  throw 'Recipient field not found'
}

$recipient.SetFocus()
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait('${safeNumber}')
Start-Sleep -Milliseconds 800
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 1300

# ── 7. Find message field by Name (poll up to 4s), type message ─────────────
$msgField = $null
$msgDeadline = [datetime]::Now.AddSeconds(4)
$msgAttempts = 0
while ([datetime]::Now -lt $msgDeadline -and -not $msgField) {
  $msgAttempts++
  $edits2 = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)
  $msgField = $edits2 | Where-Object { $_.Current.Name -match 'Type a message|Aa|Message|Continue' } | Select-Object -First 1
  if (-not $msgField -and $edits2.Count -gt $edits.Count) {
    $msgField = $edits2 | Select-Object -Last 1
  }
  if (-not $msgField) { Start-Sleep -Milliseconds 250 }
}
$msgFieldName = ''
try { if ($msgField) { $msgFieldName = $msgField.Current.Name } } catch { }
Log "message field: attempts=$msgAttempts, picked='$msgFieldName'"
if (-not $msgField) {
  # Dump the post-Enter edit names. If this list still shows only the recipient
  # box (no message field appeared), the recipient chip was never committed —
  # i.e. typing the raw number + Enter did not resolve to a conversation on
  # this machine's Phone Link. That is the most common non-English / non-contact
  # failure mode and is what this log line is here to confirm.
  $edits2Names = ''
  try {
    $edits2 = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)
    $edits2Names = (@($edits2) | ForEach-Object { "'" + $_.Current.Name + "'" }) -join ', '
  } catch { }
  Log "FATAL: no message field after $msgAttempts polls; post-enter_edit_names=[$edits2Names]"
  Log-Diagnostics $window
  throw 'Message field not found'
}

$msgField.SetFocus()
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait('${safeMessage}')
Start-Sleep -Milliseconds 500

# ── 8. Invoke Send button; fall back to Enter ───────────────────────────────
$sendBtns = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond) |
  Where-Object { $_.Current.Name -match '^Send$|^Send message$' }
$sendBtn = $sendBtns | Select-Object -First 1
if (-not $sendBtn) {
  # Send button not matched — dump all button names so we can see what the
  # Send control is actually called on this machine before we fall back to Enter.
  $btnNames = ''
  try {
    $allBtns = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
    $btnNames = (@($allBtns) | ForEach-Object { "'" + $_.Current.Name + "'" }) -join ', '
  } catch { }
  Log "send: no Send-button match; all_button_names=[$btnNames]"
}
Log "send: matching send buttons=$($sendBtns.Count), invoked=$($sendBtn -ne $null)"
if ($sendBtn) {
  $sendBtn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
} else {
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
}
Start-Sleep -Milliseconds 600
Log "send complete (no exception thrown)"
`;

  const scriptBuffer = Buffer.concat([
    Buffer.from([0xFF, 0xFE]),
    Buffer.from(script, 'utf16le'),
  ]);
  writeFileSync(tmpFile, scriptBuffer);

  let sendError = null;
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
  } catch (err) {
    sendError = err;
  } finally {
    try { unlinkSync(tmpFile); } catch (_) {}
  }

  if (sendError) {
    // Attach the PowerShell debug log so the caller can ship it to the server
    // for diagnosis without needing to reach the user's machine.
    try {
      const { readFileSync } = require('fs');
      sendError.debugLog = readFileSync(join(os.tmpdir(), 'tyl-send-debug.log'), 'utf8');
    } catch (_) {}
    throw sendError;
  }
  return true;
};
