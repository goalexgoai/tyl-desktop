const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, session: electronSession } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; } catch (_) {}

app.setAppUserModelId('com.textyourlist.app');

// ── Startup / crash telemetry ────────────────────────────────────────────────
// Send-failure telemetry only fires once the app is running and a send is
// attempted. If the app fails to START (or the renderer crashes), that's
// invisible server-side — which is exactly the blind spot when a user reports
// "it won't work" before ever sending. Report those events too, best-effort.
function reportDesktopEvent(errorMessage, detail) {
  try {
    const https = require('https');
    const webUrl = process.env.TYL_WEB_URL || 'https://app.textyourlist.com';
    const secret = process.env.DESKTOP_LICENSE_SECRET || 'cd69e5f72254cff5b33050350de14925296a19a35b18bf92d3677eddaf17dc7f';
    let version = '';
    try { version = app.getVersion(); } catch (_) {}
    const body = JSON.stringify({
      web_user_id: null,
      platform: process.platform,
      app_version: version,
      error_message: String(errorMessage || '').slice(0, 2000),
      debug_log: String(detail || '').slice(0, 100000),
    });
    const u = new URL(`${webUrl}/api/desktop-error-report`);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-desktop-secret': secret },
      timeout: 8000,
    });
    req.on('error', () => {});
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} });
    req.write(body);
    req.end();
  } catch (_) {}
}

let mainWindow = null;
let tray = null;
let serverPort = null;
let serverReady = false;
app.isQuitting = false;

// ── Send progress / completion ──────────────────────────────────────────────
const { EventEmitter } = require('events');
global.tylEvents = new EventEmitter();

let progressWindow = null;

function openProgressWindow() {
  if (progressWindow && !progressWindow.isDestroyed()) return;
  progressWindow = new BrowserWindow({
    width: 420,
    height: process.platform === 'win32' ? 360 : 220,
    resizable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    alwaysOnTop: true,
    title: 'Sending…',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  progressWindow.setMenuBarVisibility(false);
  progressWindow.loadURL(`http://127.0.0.1:${serverPort}/send-progress-page`);
}

function closeProgressWindow() {
  if (progressWindow && !progressWindow.isDestroyed()) {
    progressWindow.destroy();
  }
  progressWindow = null;
}

global.tylEvents.on('send-start', () => {
  openProgressWindow();
});

// Translate raw send errors into plain-language guidance the user can act on.
// The raw strings come from send-windows.js / send-mac.js; users should never
// see "Message field not found" — they should see what to do about it.
function friendlyError(raw) {
  const e = String(raw || '');
  const app = process.platform === 'darwin' ? 'Messages' : 'Phone Link';
  if (/not authorized to send apple events|permission/i.test(e))
    return `${app} permission wasn't granted. Open Help → Manage Permissions, grant access, then resend.`;
  if (/phone ?link not found|could not find phone link|not found\. processes|application isn't running|isn't running/i.test(e))
    return `${app} wasn't running or wasn't ready. Open ${app}, confirm your phone is connected, then resend.`;
  if (/could not focus|foreground|receive focus/i.test(e))
    return `Couldn't bring ${app} to the front. Close other windows, click ${app} once, then resend.`;
  if (/recipient field|message field|compose|new message|did not open/i.test(e))
    return `${app} didn't open a new message. Make sure ${app} is up to date and your phone is connected, then resend. If the number isn't a saved contact, try adding it first.`;
  if (/timed out|timeout/i.test(e))
    return `${app} was too slow to respond. Make sure it's open and your phone is connected, then resend.`;
  if (/cancelled by user/i.test(e))
    return `Cancelled.`;
  return e || 'Unknown error';
}

global.tylEvents.on('send-complete', ({ sent, failed, failures }) => {
  closeProgressWindow();
  const { dialog } = require('electron');
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (failed === 0) {
    dialog.showMessageBox(parent, {
      type: 'info',
      title: 'Send complete',
      message: `✓ All ${sent} message${sent !== 1 ? 's' : ''} sent successfully.`,
      buttons: ['OK'],
    });
  } else {
    const failLines = failures.map(f => `• ${f.phone}: ${friendlyError(f.error)}`).join('\n');
    dialog.showMessageBox(parent, {
      type: 'warning',
      title: 'Send complete — some failures',
      message: `${sent} sent, ${failed} failed.\n\nFailed messages:\n${failLines}\n\nCheck the History tab for full details.`,
      buttons: ['OK'],
    });
  }
});

function setTrayStatus(status) {
  if (!tray) return; // No tray on macOS
  // On Windows the multi-size .ico carries the TYL logo at every tray size and
  // is used regardless of status. The PNG status variants only exist for Linux.
  let iconFile;
  if (process.platform === 'win32') {
    iconFile = 'icon.ico';
  } else {
    const linuxIcons = { gray: 'icon-gray.png', green: 'icon-green.png', yellow: 'icon-yellow.png' };
    iconFile = linuxIcons[status] || linuxIcons.gray;
  }
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

  // Report renderer crashes / load failures — another pre-send blind spot.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    reportDesktopEvent(`RENDERER GONE: ${details.reason}`, `exitCode=${details.exitCode}`);
  });
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    // Ignore benign aborted loads (e.g. in-app redirects).
    if (errorCode === -3) return;
    reportDesktopEvent(`LOAD FAILED: ${errorDescription}`, `code=${errorCode} url=${validatedURL}`);
  });
}

function createTray() {
  if (process.platform === 'darwin') return; // macOS uses dock, no tray needed

  const iconPath = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon-gray.png');
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

      if (app.isPackaged && autoUpdater) autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    } catch (err) {
      console.error('Startup failed:', err);
      reportDesktopEvent(`STARTUP FAILED: ${err.message}`, err.stack || '');
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
    execFileSync('osascript', ['-e', 'tell application "Messages"\ncount every service\nend tell'], { timeout: 30000 });
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
    // Check for PhoneLink.exe (Windows 11 Phone Link) or YourPhone.exe (legacy).
    // Avoid YourPhoneServer which is a background service that runs even when Phone Link is not open.
    const proc = execFile('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      'if (Get-Process -Name PhoneLink,PhoneExperienceHost,PhoneLinkHost,YourPhone -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }'
    ], { timeout: 3000 }, (err) => {
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
