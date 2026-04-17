# Text Your List Desktop App — Phase 2 Directive

## Context

Phase 1 is complete and tested on a real Mac (Apple Silicon, macOS 15):
- Electron app launches, embeds the Express server, shows login UI
- Account creation and login work
- Sending to iPhone via embedded AppleScript sender works
- Tray icon appears; minimize-to-tray works

**Project location:** `/home/ubuntu/projects/tyl-desktop/`  
**Do NOT touch:** `/home/ubuntu/projects/text-sender/` (working web fallback)

---

## Phase 2 Goals

Fix the remaining Phase 1 bugs, then add tray color feedback and license gating.

---

## Bug 1: Session confusion on restart

**Symptom:** After clearing the database and creating a new account, the app logs the user into an old account. The session-file-store persists session files in `<app_dir>/data/sessions/`. When the database is wiped but sessions remain, the session userId references an old record that gets reassigned to a new user.

**Fix:** In `server.js`, when `TYL_DESKTOP` is set, clear the session directory on startup before any sessions are loaded. Add this after the `dataDir` is created:

```javascript
if (process.env.TYL_DESKTOP) {
  // Clear stale sessions on restart — prevents old session from mapping to wrong user
  const sessionsDir = path.join(dataDir, 'sessions');
  if (fs.existsSync(sessionsDir)) {
    for (const f of fs.readdirSync(sessionsDir)) {
      try { fs.unlinkSync(path.join(sessionsDir, f)); } catch (_) {}
    }
  }
}
```

Place this block BEFORE the `app.use(session({...}))` middleware setup.

---

## Bug 2: Single-instance lock not preventing double-launch

**Symptom:** Two Electron windows open on launch. The `requestSingleInstanceLock()` is in `main.js` but the second instance sometimes still starts before quitting.

**Verify:** Check `main.js` — the `requestSingleInstanceLock()` call must happen BEFORE `app.whenReady()`. Confirm it's structured exactly like:

```javascript
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  app.whenReady().then(async () => {
    // ... startup code
  });
}
```

The `app.whenReady()` block must be INSIDE the `else` branch.

---

## Feature 1: Tray icon color during send

**Requirement:** The tray icon should turn green when a send job is actively running, and return to gray when it finishes. This gives the user visual feedback that the app is working.

**Assets available:** `/home/ubuntu/projects/tyl-desktop/assets/`
- `icon-gray.png` — idle state (currently used)
- `icon-green.png` — active send state
- `icon-yellow.png` — available for future use (e.g. error/paused)

**Implementation:**

1. In `main.js`, add an IPC handler that receives tray state updates from the server:

```javascript
ipcMain.on('set-tray-status', (_, status) => {
  const icons = { gray: 'icon-gray.png', green: 'icon-green.png', yellow: 'icon-yellow.png' };
  const iconFile = icons[status] || 'icon-gray.png';
  if (tray) tray.setImage(nativeImage.createFromPath(path.join(__dirname, 'assets', iconFile)));
});
```

2. In `server.js`, the embedded desktop sender loop already runs. Add tray status signaling. The server can't use IPC directly (it's a child process), so communicate via HTTP to the main process OR use stdout signals.

**Recommended approach — stdout signals:**

In `server.js` desktop sender loop:

```javascript
// Before starting to send a job:
if (process.env.TYL_DESKTOP) process.stdout.write('__TRAY:green__\n');

// After job completes (recountJob shows no more pending):
if (process.env.TYL_DESKTOP) process.stdout.write('__TRAY:gray__\n');
```

In `main.js`, parse stdout from the server process:

```javascript
serverProcess.stdout.on('data', (d) => {
  const text = d.toString();
  const trayMatch = text.match(/__TRAY:(\w+)__/);
  if (trayMatch && tray) {
    const icons = { gray: 'icon-gray.png', green: 'icon-green.png', yellow: 'icon-yellow.png' };
    const iconFile = icons[trayMatch[1]] || 'icon-gray.png';
    tray.setImage(nativeImage.createFromPath(path.join(__dirname, 'assets', iconFile)));
  }
  // Still log non-signal lines
  const logLine = text.replace(/__TRAY:\w+__\n?/g, '').trim();
  if (logLine) console.log('[server]', logLine);
});
```

---

## Feature 2: License gate on launch (desktop-only)

**Requirement:** The desktop app must verify the user has a valid paid plan before allowing sends. Since the desktop app has no persistent server connection, this check must work offline with a grace period.

**Implementation:**

Add a license check file stored in userData:

```javascript
// In main.js, after server is ready and user logs in:
// (This logic lives in server.js — add a route that main.js can call)
```

In `server.js`, add a route (available without auth for the main process to call):

```javascript
// Called by main.js after startup to check if a valid account exists
app.get('/internal/license-status', (req, res) => {
  // Only accessible from localhost
  if (req.ip !== '127.0.0.1' && req.ip !== '::1' && req.ip !== '::ffff:127.0.0.1') {
    return res.status(403).end();
  }
  const user = db.prepare('SELECT plan, subscription_status, manual_account FROM users ORDER BY id ASC LIMIT 1').get();
  if (!user) return res.json({ licensed: false, reason: 'no_account' });
  const licensed = user.manual_account ||
    user.plan !== 'free' ||
    user.subscription_status === 'active';
  res.json({ licensed, plan: user.plan, status: user.subscription_status });
});
```

In `main.js`, after `waitForServer()` resolves, check license status and store it:

```javascript
async function checkLicense(port) {
  try {
    const res = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/internal/license-status`, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => resolve(JSON.parse(d)));
      }).on('error', reject);
    });
    return res;
  } catch {
    return { licensed: true }; // offline grace: assume licensed if can't check
  }
}
```

For Phase 2, just log the result — enforcement (blocking sends for unlicensed users) comes in Phase 3.

---

## What NOT to change in Phase 2

- `send-mac.js` / `send-windows.js` — working, no changes
- `public/` — all web UI files, no UI redesign in Phase 2
- Stripe billing routes — leave as-is
- The original `/home/ubuntu/projects/text-sender/` — do not touch

---

## After implementing Phase 2

Push all changes to `https://github.com/goalexgoai/tyl-desktop` on the `main` branch. Report:
1. Which bugs were fixed and how verified
2. Whether tray color changes on send (can be tested by queuing a job)
3. What the license status endpoint returns for the test account

Phase 3 will cover: auto-updates, installable .dmg build, and license enforcement.
