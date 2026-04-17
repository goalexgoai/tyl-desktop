const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

let messagesLaunched = false; // only wait for launch once per session

module.exports = async function sendViaMac(number, message) {
  // Write message body to temp file to avoid AppleScript quoting issues
  const tmp = path.join(os.tmpdir(), `tyl_${Date.now()}.txt`);
  fs.writeFileSync(tmp, message, 'utf8');

  // Ensure Messages.app is running — only wait on first launch
  try {
    const procs = execSync('pgrep -x Messages', { encoding: 'utf8' }).trim();
    if (!procs) throw new Error('not running');
    messagesLaunched = true;
  } catch (_) {
    execSync('open -a Messages', { timeout: 5000 });
    if (!messagesLaunched) {
      await new Promise(r => setTimeout(r, 3000));
      messagesLaunched = true;
    }
  }

  // Use the SMS relay service exclusively.
  //
  // Why not iMessage service: AppleScript's "send to participant of iMessage service"
  // returns success immediately for ANY number — including Android — because it just
  // queues the message. There is no synchronous error for "this number isn't on iMessage."
  // The message then silently fails to deliver for Android users.
  //
  // SMS relay works differently: all messages route through the paired iPhone, which
  // makes the iMessage vs SMS decision itself (iPhone→iMessage if recipient has it,
  // iPhone→SMS if not). This correctly handles mixed iPhone/Android lists.
  // Requirement: iPhone must be on the same WiFi or nearby Bluetooth, and
  // Settings > Messages > Text Message Forwarding must have this Mac enabled.
  const script = `
set msgBody to (do shell script "cat " & quoted form of "${tmp}")
set targetNumber to "${number.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"
tell application "Messages"
  set sSvc to first service whose service type = SMS
  set sPart to participant targetNumber of sSvc
  send msgBody to sPart
end tell
`;

  try {
    execFileSync('osascript', ['-e', script], { timeout: 30000 });
    return true;
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
};
