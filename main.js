const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');

app.setAppUserModelId('com.textyourlist.app');

// Prevent multiple instances — second launch focuses the existing window instead
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
}

let mainWindow = null;
let tray = null;
let serverProcess = null;
let serverPort = null;
let serverReady = false;
app.isQuitting = false;

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
    NODE_ENV: process.env.NODE_ENV || 'production',
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

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon-gray.png');
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('Text Your List');

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

app.whenReady().then(async () => {
  try {
    createTray();
    const port = await startServer();
    createWindow(port);
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  } catch (err) {
    console.error('Startup failed:', err);
    app.quit();
  }
});

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
