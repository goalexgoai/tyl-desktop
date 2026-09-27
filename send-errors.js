// Shared send-error helpers, used by main.js (completion dialog) and server.js
// (send loop auto-pause). Users should see what to do, not a PowerShell dump.

function friendlyError(raw, platform = process.platform) {
  const e = String(raw || '');
  const app = platform === 'darwin' ? 'Messages' : 'Phone Link';
  if (/ParserError|Missing '\)' in method call|Unexpected token|string is missing the terminator/i.test(e))
    return `Text Your List couldn't prepare this message for ${app}. Update Text Your List to the latest version, then resend.`;
  if (/not authorized to send apple events|permission/i.test(e))
    return `${app} permission wasn't granted. Open Help → Manage Permissions, grant access, then resend.`;
  if (/phone ?link not found|could not find phone link|not found\. processes|application isn't running|isn't running/i.test(e))
    return `${app} wasn't running or wasn't ready. Open ${app}, confirm your phone is connected, then resend.`;
  if (/could not focus|foreground|receive focus/i.test(e))
    return `Couldn't bring ${app} to the front. Close other windows, click ${app} once, then resend.`;
  if (/recipient field|message field|compose|new message|did not open/i.test(e))
    return `${app} didn't open a new message. In ${app}, click the Messages tab and confirm your phone is connected, then resend.`;
  if (/timed out|timeout/i.test(e))
    return `${app} was too slow to respond. Make sure it's open and your phone is connected, then resend.`;
  if (/cancelled by user/i.test(e))
    return `Cancelled.`;
  // Unknown: first line only, never a multi-line script dump.
  const first = e.split(/\r?\n/).find(l => l.trim()) || 'Unknown error';
  return first.trim().slice(0, 200);
}

// Stable key for "is this the same failure as last time?" — strips temp-file
// paths, line/char positions and message text so identical root causes match.
function errorSignature(raw) {
  const e = String(raw || '');
  const thrown = e.match(/throw '([^']+)'/);
  if (thrown) return thrown[1];
  if (/ParserError|Missing '\)' in method call|Unexpected token/i.test(e)) return 'ParserError';
  return (e.split(/\r?\n/)[0] || '')
    .replace(/[A-Z]:\\[^\s:]+/gi, '<path>')
    .replace(/\d+/g, '#')
    .slice(0, 120);
}

module.exports = { friendlyError, errorSignature };
