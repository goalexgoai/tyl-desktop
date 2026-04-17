# Text Your List Desktop App — Phase 3 Directive

## Context

Phase 1 and 2 are complete. The app launches, embeds the server, sends messages (confirmed iPhone delivery), and has tray color signals. Two unresolved bugs must be fixed in Phase 3 before any new features.

**Project location:** `/home/ubuntu/projects/tyl-desktop/`
**Do NOT touch:** `/home/ubuntu/projects/text-sender/`

---

## Bug 1: Wrong account on login (CRITICAL — fix first)

**Root cause:** Electron's BrowserWindow cookie jar persists across app launches independently of the server-side session file store. On restart, the browser sends the old session cookie. The server-side session files were cleared (Phase 2 fix), so the server creates a new empty session — but the browser holds an old cookie that may later get reused, causing confusion about which account is active.

**Fix in `main.js`:** Before calling `createWindow(port)`, clear Electron's cookie and storage data for the default session. This forces re-authentication on every launch — correct desktop behavior.

```javascript
// Add this import at the top of main.js:
const { session: electronSession } = require('electron');

// Add this in app.whenReady(), after waitForServer() resolves but BEFORE createWindow():
async function clearBrowserSession() {
  await electronSession.defaultSession.clearStorageData({
    storages: ['cookies', 'localstorage', 'sessionstorage', 'indexdb', 'websql'],
  });
}
```

Call it in the startup sequence:
```javascript
app.whenReady().then(async () => {
  try {
    createTray();
    const port = await startServer();
    await clearBrowserSession();          // ← add this line
    const license = await checkLicense(port);
    console.log('[main] license status:', JSON.stringify(license));
    createWindow(port);
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  } catch (err) {
    console.error('Startup failed:', err);
    app.quit();
  }
});
```

---

## Bug 2: Phone icon tray on macOS

**Problem:** The phone/tray icon is unnecessary on macOS — the app already lives in the dock. Users can bring up the window from the dock. The tray icon adds no value and confuses users.

**Fix:** Make tray macOS-specific disabled. On Windows, keep the tray (Windows doesn't have a dock equivalent).

In `main.js`, wrap all tray creation in a platform check:

```javascript
function createTray() {
  if (process.platform === 'darwin') return; // macOS uses dock, no tray needed

  // Windows tray below:
  const iconPath = path.join(__dirname, 'assets', 'icon-gray.png');
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('Text Your List');
  // ... rest of tray setup
}
```

On macOS, the app should stay alive when the window is closed (keep the existing `window-all-closed` behavior). The user quits with Cmd+Q or from the dock menu. Update the `close` handler to just hide (not quit) on macOS:

```javascript
mainWindow.on('close', (e) => {
  if (process.platform === 'darwin' && !app.isQuitting) {
    e.preventDefault();
    mainWindow.hide();
  }
});
```

Also remove the `setTrayStatus()` calls from server.js since the tray isn't used on macOS. Keep the stdout signals harmless (no-op if tray is null):

In `main.js`, `setTrayStatus()` should guard against null tray:
```javascript
function setTrayStatus(status) {
  if (!tray) return; // No tray on macOS
  // ... rest of function
}
```

---

## Bug 3: Restart reliability

The WAL stale file cleanup and busy_timeout fixes are in place. Verify they're still in db.js after Phase 2 edits. The db.js should have:
- `for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(filePath + ext); } catch (_) {} }` before opening
- `PRAGMA busy_timeout = 10000` after opening
- `db.transaction()` shim

Confirm these are present — do NOT remove them.

---

## Cleanup: Remove desktop-irrelevant server routes

When running as desktop (`TYL_DESKTOP=1`), these routes serve no purpose and should return 404 or redirect to `/app`:

In `server.js`, wrap these route registrations in `if (!process.env.TYL_DESKTOP) { ... }`:

```javascript
// SEO landing pages — irrelevant in desktop mode
if (!process.env.TYL_DESKTOP) {
  app.get('/send-texts-individually', ...);
  app.get('/church-texting-app', ...);
  app.get('/text-from-computer', ...);
  app.get('/csv-text-message-sender', ...);
  app.get('/texting-for-coaches', ...);
  app.get('/help/companion', ...);
  app.get('/help/windows', ...);
  app.get('/help/mac', ...);
  app.get('/privacy', ...);
  app.get('/terms', ...);
  app.get('/signup', ...);
}
```

Also in desktop mode, redirect `/` directly to `/app`:
```javascript
app.get('/', (req, res) => {
  if (process.env.TYL_DESKTOP) return res.redirect('/app');
  // ... existing web redirect logic
});
```

---

## Verify: Embedded sender end-to-end

The embedded sender loop (added in Phase 1) handles jobs where `j.status = 'queued'`. Confirm the `/api/send-one` route calls `queueSingleSend()` which inserts a job with `status = 'queued'`. If it does, the desktop sender loop will pick it up within 5 seconds.

Add a log line when the loop finds a message to send:
```javascript
console.log(`[desktop-sender] picking up message ${message.id} for ${message.phone}`);
```

This verifies the loop is running in production. No functional change needed if flow is correct.

---

## What NOT to change

- `send-mac.js` / `send-windows.js` — working, no changes
- `db.js` shims — working, do not touch
- API routes (`/api/jobs`, `/api/send-one`, etc.) — leave as-is
- Stripe routes — leave as-is
- `public/app.html`, `public/app.js` — no UI changes in Phase 3
- The original `/home/ubuntu/projects/text-sender/` — do not touch

---

## After implementing Phase 3

Push all changes to `https://github.com/goalexgoai/tyl-desktop` on the `main` branch.

Report:
1. Which bugs were fixed
2. Confirm `clearBrowserSession()` is called before `createWindow()`
3. Confirm tray is macOS-disabled
4. Confirm db.js still has WAL cleanup + busy_timeout + transaction shim
5. Confirm the desktop route cleanup is in place

Phase 4 will cover: packaged .dmg build, auto-update delivery, and license enforcement.
