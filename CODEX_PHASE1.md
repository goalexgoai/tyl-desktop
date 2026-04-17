# Text Your List Desktop App — Phase 1 Directive

## What you're building

A full Electron desktop application that replaces the web app + companion setup. Users install one app, log in, and everything works — no separate companion, no Terminal commands.

**Project location:** `/home/ubuntu/projects/tyl-desktop/`  
**Do NOT touch:** `/home/ubuntu/projects/text-sender/` (the working web app — preserve it as fallback)

---

## Architecture

The Electron main process spawns the Express server (server.js) as a child Node.js process on a random available port. The BrowserWindow loads the web UI from that local server. The sending logic (AppleScript on Mac, PowerShell on Windows) runs in the main process directly — no companion app needed.

```
Electron Main Process
  ├── Spawns: server.js (child process, random port)
  ├── Creates: BrowserWindow → http://localhost:{port}
  ├── Manages: system tray, window lifecycle
  └── Handles: send-mac.js / send-windows.js directly
```

---

## File structure to create

```
/home/ubuntu/projects/tyl-desktop/
├── main.js              ← Electron main process (CREATE THIS)
├── preload.js           ← Electron preload script (CREATE THIS)
├── package.json         ← Electron + electron-builder config (CREATE THIS)
├── server.js            ← Already copied — modify as noted below
├── db.js                ← Already copied — modify as noted below
├── send-mac.js          ← Already copied — no changes needed
├── send-windows.js      ← Already copied — no changes needed
├── assets/              ← Already copied (icons)
├── public/              ← Already copied (web UI files)
└── companion/           ← Already copied (sender.js used by server polling)
```

---

## 1. package.json

Create `/home/ubuntu/projects/tyl-desktop/package.json`:

```json
{
  "name": "textyourlist",
  "version": "1.0.0",
  "description": "Text Your List — Send personal texts to your list",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "build:mac": "electron-builder --mac",
    "build:win": "electron-builder --win"
  },
  "dependencies": {
    "bcrypt": "^5.1.1",
    "better-sqlite3": "^9.4.3",
    "connect-sqlite3": "^0.9.15",
    "cookie-parser": "^1.4.6",
    "express": "^4.18.3",
    "express-rate-limit": "^7.2.0",
    "express-session": "^1.18.0",
    "helmet": "^7.1.0",
    "nodemailer": "^6.9.13",
    "stripe": "^14.21.0",
    "uuid": "^9.0.1",
    "adm-zip": "^0.5.10",
    "multer": "^1.4.5-lts.1",
    "csv-parse": "^5.5.3"
  },
  "devDependencies": {
    "electron": "^35.7.5",
    "electron-builder": "^25.1.8",
    "electron-updater": "^6.3.4"
  },
  "build": {
    "appId": "com.textyourlist.app",
    "productName": "Text Your List",
    "asar": true,
    "files": [
      "main.js",
      "preload.js",
      "server.js",
      "db.js",
      "send-mac.js",
      "send-windows.js",
      "assets/**",
      "public/**",
      "companion/**",
      "node_modules/**"
    ],
    "mac": {
      "target": [
        { "target": "dmg", "arch": ["arm64", "x64"] }
      ],
      "icon": "assets/icon.icns",
      "category": "public.app-category.utilities",
      "hardenedRuntime": false,
      "gatekeeperAssess": false
    },
    "win": {
      "target": [
        { "target": "nsis", "arch": ["x64"] }
      ],
      "icon": "assets/icon.ico"
    },
    "publish": {
      "provider": "github",
      "owner": "OWNER_PLACEHOLDER",
      "repo": "REPO_PLACEHOLDER"
    }
  }
}
```

---

## 2. main.js

Create `/home/ubuntu/projects/tyl-desktop/main.js`. This is the core Electron main process.

Key responsibilities:
- Find a free local port
- Set the SQLite database path to `app.getPath('userData')/tyl.db`
- Set an env var so server.js knows where to put the DB and what port to use
- Spawn server.js as a child Node.js process
- Wait for the server to be ready (poll localhost until it responds)
- Create the BrowserWindow and load the local server URL
- Manage system tray (gray when idle, green when sending)
- Handle window close → minimize to tray (not quit)
- Handle quit from tray

```javascript
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');

app.setAppUserModelId('com.textyourlist.app');

let mainWindow = null;
let tray = null;
let serverProcess = null;
let serverPort = null;
let serverReady = false;

// ── Find a free port ──────────────────────────────────────────────────────────
function getFreePort() {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// ── Wait for server to be ready ───────────────────────────────────────────────
function waitForServer(port, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function check() {
      if (Date.now() - start > timeout) return reject(new Error('Server startup timeout'));
      http.get(`http://127.0.0.1:${port}/health`, (res) => {
        if (res.statusCode < 500) resolve();
        else setTimeout(check, 300);
      }).on('error', () => setTimeout(check, 300));
    }
    check();
  });
}

// ── Start embedded server ─────────────────────────────────────────────────────
async function startServer() {
  const port = await getFreePort();
  serverPort = port;

  const dbPath = path.join(app.getPath('userData'), 'tyl.db');
  const serverPath = path.join(__dirname, 'server.js');

  const env = {
    ...process.env,
    TYL_PORT: String(port),
    TYL_DB_PATH: dbPath,
    TYL_DESKTOP: '1',
    NODE_ENV: 'production',
  };

  serverProcess = spawn(process.execPath, [serverPath], {
    env,
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', (d) => console.log('[server]', d.toString().trim()));
  serverProcess.stderr.on('data', (d) => console.error('[server]', d.toString().trim()));

  serverProcess.on('exit', (code) => {
    console.log(`[server] exited with code ${code}`);
    if (mainWindow && !app.isQuitting) {
      mainWindow.loadURL(`data:text/html,<h2>Server stopped unexpectedly (code ${code}). Restart the app.</h2>`);
    }
  });

  await waitForServer(port);
  serverReady = true;
  console.log(`[main] server ready on port ${port}`);
  return port;
}

// ── Create main window ────────────────────────────────────────────────────────
function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    title: 'Text Your List',
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/app`);

  // Minimize to tray on close instead of quitting
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── System tray ───────────────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon-gray.png');
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('Text Your List');

  const menu = Menu.buildFromTemplate([
    {
      label: 'Open Text Your List',
      click: () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
        else if (serverPort) createWindow(serverPort);
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  try {
    createTray();
    const port = await startServer();
    createWindow(port);

    // Check for updates (non-blocking, silently downloads)
    autoUpdater.checkForUpdatesAndNotify().catch(() => {}); // ignore if no update server configured yet
  } catch (err) {
    console.error('Startup failed:', err);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  // Don't quit on macOS when window closes — stay in tray
  if (process.platform !== 'darwin') {
    // On Windows, also stay in tray
    // app.quit() is only called from tray menu
  }
});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
  else if (serverPort) createWindow(serverPort);
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (serverProcess) serverProcess.kill();
});

// ── IPC: open external links in browser ──────────────────────────────────────
ipcMain.on('open-external', (_, url) => {
  shell.openExternal(url);
});
```

---

## 3. preload.js

Create `/home/ubuntu/projects/tyl-desktop/preload.js`:

```javascript
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openExternal: (url) => ipcRenderer.send('open-external', url),
  platform: process.platform,
  isDesktop: true,
});
```

---

## 4. Modify server.js

The copied `server.js` needs these specific changes. Apply them surgically — don't rewrite the whole file.

**Change 1: Port and DB path from environment**

Find the line near the bottom where the server listens (look for `app.listen`). Change it to:

```javascript
const PORT = process.env.TYL_PORT ? parseInt(process.env.TYL_PORT) : (process.env.PORT || 3000);
app.listen(PORT, '127.0.0.1', () => {
  console.log(`TYL server listening on port ${PORT}`);
});
```

**Change 2: DB path from environment**

In `db.js`, find where the database file path is set. Change it to use `process.env.TYL_DB_PATH` when set:

```javascript
const DB_PATH = process.env.TYL_DB_PATH || path.join(__dirname, 'tyl.db');
const db = new Database(DB_PATH);
```

**Change 3: Add /health endpoint**

Add this route early in server.js (after middleware, before other routes):

```javascript
app.get('/health', (req, res) => res.json({ ok: true }));
```

**Change 4: Disable Stripe webhooks when running as desktop**

Stripe can't send webhooks to a local machine. Find the `/billing/webhook` route and wrap it:

```javascript
if (!process.env.TYL_DESKTOP) {
  app.post('/billing/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    // ... existing webhook handler code ...
  });
}
```

**Change 5: Companion download routes not needed in desktop**

The routes that serve companion download files (`/api/keys/:id/companion`) can stay — they don't hurt anything — but the desktop app won't use them.

---

## 5. Modify db.js

Change the database path line to respect `process.env.TYL_DB_PATH`:

Find:
```javascript
const db = new Database(path.join(__dirname, 'tyl.db'));
```
Or similar. Replace with:
```javascript
const dbPath = process.env.TYL_DB_PATH || path.join(__dirname, 'tyl.db');
const db = new Database(dbPath);
```

---

## 6. Add /app route to server.js

The web app currently lives at `/` (landing page) and `/app` (the actual app). Confirm this route exists and serves `public/app.html`. It should already be there — just verify.

---

## Success criteria for Phase 1

Running `npm start` in `/home/ubuntu/projects/tyl-desktop/` should:
1. Start without errors
2. Open a window showing the Text Your List login page
3. Allow login with existing credentials
4. Allow sending a test message (single send)
5. Show the campaign history
6. System tray icon appears

The `.env` file from the original project has the required secrets. Copy it:
```bash
cp /home/ubuntu/projects/text-sender/.env /home/ubuntu/projects/tyl-desktop/.env
```
And load it in server.js at the top:
```javascript
require('dotenv').config();
```
Add `dotenv` to package.json dependencies: `"dotenv": "^16.0.3"`

---

## What NOT to change

- `send-mac.js` — working, no changes
- `send-windows.js` — working, no changes  
- `public/` — all web UI files, no changes in Phase 1
- The original `/home/ubuntu/projects/text-sender/` — do not touch

---

## After implementing Phase 1

Run:
```bash
cd /home/ubuntu/projects/tyl-desktop
npm install
npm start
```

Report any errors. The goal is a running app before moving to Phase 2.
