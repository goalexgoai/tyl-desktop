const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, session: electronSession } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');

app.setAppUserModelId('com.textyourlist.app');

let mainWindow = null;
let tray = null;
let serverProcess = null;
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

  // Locate server.js reliably whether packaged or in dev.
  // In a packaged build, asarUnpack extracts server.js to app.asar.unpacked/.
  // In dev, __dirname is the real project directory.
  // We detect by checking if the unpacked path actually contains server.js —
  // this avoids relying on app.isPackaged which can be unreliable when launched
  // from Terminal.
  const unpackedDir = path.join(process.resourcesPath, 'app.asar.unpacked');
  const serverDir = fs.existsSync(path.join(unpackedDir, 'server.js'))
    ? unpackedDir
    : __dirname;
  const serverPath = path.join(serverDir, 'server.js');

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

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',   // required: makes Electron binary behave as Node.js
    TYL_PORT: String(port),
    TYL_DB_PATH: dbPath,
    TYL_DESKTOP: '1',
    SESSION_SECRET: sessionSecret,
    NODE_ENV: process.env.NODE_ENV || 'production',
  };

  serverProcess = spawn(process.execPath, [serverPath], {
    env,
    cwd: serverDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverLog = '';
  serverProcess.stdout.on('data', (d) => {
    const text = d.toString();
    serverLog += text;
    const trayMatch = text.match(/__TRAY:(\w+)__/);
    if (trayMatch) setTrayStatus(trayMatch[1]);
    const logLine = text.replace(/__TRAY:\w+__\n?/g, '').trim();
    if (logLine) console.log('[server]', logLine);
  });
  serverProcess.stderr.on('data', (d) => {
    serverLog += d.toString();
    console.error('[server]', d.toString().trim());
  });

  serverProcess.on('exit', (code) => {
    console.log(`[server] exited with code ${code}`);
    if (mainWindow && !app.isQuitting) {
      mainWindow.loadURL(`data:text/html,<h2>Server stopped (code ${code}). Restart the app.</h2>`);
    }
  });

  try {
    await waitForServer(port);
  } catch (timeoutErr) {
    serverProcess.kill();
    throw new Error('Server startup timeout.\n\nServer output:\n' + (serverLog.trim() || '(none)'));
  }
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
      createWindow(port);
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
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
  if (serverProcess) serverProcess.kill();
});

ipcMain.on('open-external', (_, url) => {
  shell.openExternal(url);
});

ipcMain.handle('open-billing', async () => {
  shell.openExternal('https://textyourlist.com/billing/checkout?plan=starter');
});

ipcMain.on('set-tray-status', (_, status) => {
  setTrayStatus(status);
});
