const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, session: electronSession } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { autoUpdater } = require('electron-updater');

app.setAppUserModelId('com.textyourlist.app');

let mainWindow = null;
let tray = null;
let serverPort = null;
let serverReady = false;
app.isQuitting = false;

function setTrayStatus(status) {
  if (!tray) return; // No tray on macOS
  const icons = { gray: 'icon-gray.png', green: 'icon-green.png', yellow: 'icon-yellow.png' };
  const iconFile = icons[status] || 'icon-gray.png';
  tray.setImage(nativeImage.createFromPath(path.join(__dirname, 'assets', iconFile)));
}

const gotLock = app.requestSingleInstanceLock();

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

function waitForServer(port, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function check() {
      if (Date.now() - start > timeout) return reject(new Error('Server startup timeout'));
      http.get(`http://127.0.0.1:${port}/health`, (res) => {
        res.resume();
        if (res.statusCode < 500) resolve();
        else setTimeout(check, 300);
      }).on('error', () => setTimeout(check, 300));
    }
    check();
  });
}

async function checkLicense(port) {
  try {
    const result = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/internal/license-status`, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data || '{}'));
          } catch (err) {
            reject(err);
          }
        });
      }).on('error', reject);
    });
    return result;
  } catch {
    return { licensed: true };
  }
}

async function clearBrowserSession() {
  await electronSession.defaultSession.clearStorageData({
    storages: ['cookies', 'localstorage', 'sessionstorage', 'indexdb', 'websql'],
  });
}

async function startServer() {
  const port = await getFreePort();
  serverPort = port;

  const dbPath = path.join(app.getPath('userData'), 'tyl.db');

  // Generate a stable session secret stored in userData so sessions survive restarts.
  const secretPath = path.join(app.getPath('userData'), '.session-secret');
  let sessionSecret;
  try {
    sessionSecret = fs.readFileSync(secretPath, 'utf8').trim();
  } catch {
    sessionSecret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(secretPath), { recursive: true });
    fs.writeFileSync(secretPath, sessionSecret, { mode: 0o600 });
  }

  // Set env vars before requiring server so it picks them up at module load time.
  process.env.TYL_PORT = String(port);
  process.env.TYL_DB_PATH = dbPath;
  process.env.TYL_DATA_DIR = app.getPath('userData');
  process.env.TYL_DESKTOP = '1';
  process.env.SESSION_SECRET = sessionSecret;
  if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production';
  // Web auth — credentials baked into desktop build for talking to the hosted web server.
  process.env.TYL_WEB_URL = process.env.TYL_WEB_URL || 'https://app.textyourlist.com';
  process.env.DESKTOP_LICENSE_SECRET = process.env.DESKTOP_LICENSE_SECRET || 'cd69e5f72254cff5b33050350de14925296a19a35b18bf92d3677eddaf17dc7f';

  // Run server in-process — avoids all ABI/WASM issues with spawned child.
  // better-sqlite3 native bindings work fine in Electron's main process.
  require('./server');

  await waitForServer(port);
  serverReady = true;
  console.log(`[main] server ready on port ${port}`);
  return port;
}

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

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      if (process.platform === 'darwin') {
        e.preventDefault();
        mainWindow.hide();
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  if (process.platform === 'darwin') return; // macOS uses dock, no tray needed

  const iconPath = path.join(__dirname, 'assets', 'icon-gray.png');
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('Text Your List');
  setTrayStatus('gray');

  const menu = Menu.buildFromTemplate([
    {
      label: 'Open Text Your List',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else if (serverPort) {
          createWindow(serverPort);
        }
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
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  app.whenReady().then(async () => {
    try {
      createTray();
      const port = await startServer();
      await clearBrowserSession();
      const license = await checkLicense(port);
      console.log('[main] license status:', JSON.stringify(license));

      // On Mac, show setup wizard on first launch (permissions request)
      const setupDone = process.platform !== 'darwin' || (() => {
        try { fs.accessSync(path.join(app.getPath('userData'), 'tyl-setup-done')); return true; } catch { return false; }
      })();

      createWindow(port);

      if (!setupDone && mainWindow) {
        mainWindow.loadURL(`http://127.0.0.1:${port}/setup`);
      }

      if (app.isPackaged) autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    } catch (err) {
      console.error('Startup failed:', err);
      const { dialog } = require('electron');
      await dialog.showMessageBox({
        type: 'error',
        title: 'Text Your List — Startup Error',
        message: 'The app failed to start.',
        detail: err.message + '\n\n' + (err.stack || ''),
        buttons: ['OK'],
      }).catch(() => {});
      app.quit();
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Stay running in tray until user quits explicitly.
  }
});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
  else if (serverPort) createWindow(serverPort);
});

app.on('before-quit', () => {
  app.isQuitting = true;
  // Server runs in-process — it exits with the main process automatically.
});

ipcMain.on('open-external', (_, url) => {
  shell.openExternal(url);
});

ipcMain.handle('open-billing', async (_, plan) => {
  // Load billing in the Electron window so the local session cookie is used.
  // The local server's /billing/checkout creates a Stripe checkout session and redirects.
  if (mainWindow && serverPort) {
    mainWindow.loadURL(`http://127.0.0.1:${serverPort}/billing/checkout?plan=${plan || 'starter'}`);
  }
});

ipcMain.on('set-tray-status', (_, status) => {
  setTrayStatus(status);
});

// ── Setup wizard IPC ──────────────────────────────────────────────────────────

ipcMain.handle('check-chat-db-access', () => {
  const os = require('os');
  const dbPath = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
  try {
    // Use openSync + closeSync rather than accessSync — this actually exercises
    // the TCC read gate and gives a reliable answer in the packaged Electron context.
    const fd = fs.openSync(dbPath, 'r');
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('trigger-messages-permission', async () => {
  // Running any AppleScript against Messages triggers the macOS Automation permission prompt.
  try {
    const { execFileSync } = require('child_process');
    execFileSync('osascript', ['-e', 'tell application "Messages" to get name'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
});

ipcMain.on('open-fda-settings', () => {
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
});

ipcMain.handle('mark-setup-done', () => {
  try {
    fs.writeFileSync(path.join(app.getPath('userData'), 'tyl-setup-done'), '1', 'utf8');
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('check-messages-running', () => {
  if (process.platform !== 'darwin') return true;
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    const proc = execFile('pgrep', ['-x', 'Messages'], { timeout: 1500 }, (err, stdout) => {
      resolve(!err && stdout.trim().length > 0);
    });
    proc.on('error', () => resolve(false));
  });
});

ipcMain.handle('check-phone-link-running', () => {
  if (process.platform !== 'win32') return true;
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    const proc = execFile('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      'if (Get-Process -Name PhoneLink,YourPhone,YourPhoneServer -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }'
    ], { timeout: 1500 }, (err) => {
      resolve(!err);
    });
    proc.on('error', () => resolve(false));
  });
});

ipcMain.handle('is-setup-done', () => {
  if (process.platform !== 'darwin') return true; // Windows needs no setup
  try {
    fs.accessSync(path.join(app.getPath('userData'), 'tyl-setup-done'));
    return true;
  } catch {
    return false;
  }
});
