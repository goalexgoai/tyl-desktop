# Text Your List Desktop App — Phase 4 Directive

## Context

Phases 1–3 are complete and pushed to `https://github.com/goalexgoai/tyl-desktop` on `main`. The app launches, embeds the server, sends messages, and has clean session management. Phase 4 delivers: packaged builds for Mac and Windows, GitHub Actions CI/CD, auto-update delivery, Stripe price ID wiring, and license enforcement.

**Project location:** `/home/ubuntu/projects/tyl-desktop/`
**Do NOT touch:** `/home/ubuntu/projects/text-sender/`

---

## Task 1: Fix package.json publish config

The `build.publish` block in `package.json` currently has placeholder values. Replace them with the real values:

```json
"publish": {
  "provider": "github",
  "owner": "goalexgoai",
  "repo": "tyl-desktop"
}
```

Also fix the duplicate `session-file-store` entry in `dependencies` — it appears twice. Remove one.

---

## Task 2: Add .env.example with Stripe price IDs

Create `/home/ubuntu/projects/tyl-desktop/.env.example` with this exact content:

```
# Server
SESSION_SECRET=change_me_to_a_random_64_char_string
NODE_ENV=production

# App URL (used for Stripe redirect URLs — set to your web domain in production)
APP_URL=https://textyourlist.com

# Stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_STARTER_MONTHLY_PRICE_ID=price_1TNESORpqOQYXtWTtHZYYjsN
STRIPE_STARTER_ANNUAL_PRICE_ID=price_1TNESRRpqOQYXtWTjNnPUtGC
STRIPE_PRO_MONTHLY_PRICE_ID=price_1TNESURpqOQYXtWT5fqXu5O0
STRIPE_PRO_ANNUAL_PRICE_ID=price_1TNESXRpqOQYXtWTcX1efxdv

# Email (for password reset, etc.)
EMAIL_HOST=
EMAIL_PORT=587
EMAIL_USER=
EMAIL_PASS=
EMAIL_FROM=
```

Do NOT create or modify `.env` itself — that is the live secrets file on the Mac.

---

## Task 3: License enforcement in main.js

The `/internal/license-status` endpoint already exists in server.js and returns:
- `{ licensed: false, reason: 'no_account' }` — no account exists
- `{ licensed: true/false, plan: '...', status: '...' }` — account exists

Phase 2 added a `checkLicense(port)` call that logs the result. Now enforce it.

### What to implement

After `checkLicense(port)` resolves, evaluate the response. If the user is on a free plan AND has been using the app for more than 14 days (grace period), show a blocking dialog and prevent access until they upgrade.

**Grace period logic:** Store the install date in Electron's app userData as a JSON file (`<userData>/install_date.json`). On first launch (file doesn't exist), write today's date. On subsequent launches, read it and compare.

```javascript
const fs = require('fs');
const path = require('path');

function getInstallDate() {
  const filePath = path.join(app.getPath('userData'), 'install_date.json');
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return new Date(data.date);
  } catch {
    const date = new Date();
    fs.writeFileSync(filePath, JSON.stringify({ date: date.toISOString() }));
    return date;
  }
}
```

Grace period check:
```javascript
function isGracePeriodExpired() {
  const installDate = getInstallDate();
  const daysSinceInstall = (Date.now() - installDate.getTime()) / (1000 * 60 * 60 * 24);
  return daysSinceInstall > 14;
}
```

### License enforcement gate

In the startup sequence in `app.whenReady()`, after `checkLicense(port)`:

```javascript
const license = await checkLicense(port);
console.log('[main] license status:', JSON.stringify(license));

if (!license.licensed && isGracePeriodExpired()) {
  // Show blocking dialog — user must upgrade
  const { dialog, shell } = require('electron');
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'Subscription Required',
    message: 'Your free trial has ended.',
    detail: 'Please upgrade your plan at textyourlist.com to continue using Text Your List.',
    buttons: ['Upgrade Now', 'Quit'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    shell.openExternal('https://textyourlist.com/billing/checkout?plan=starter');
  }
  app.quit();
  return;
}
```

Note: users in grace period (`licensed: false` but `isGracePeriodExpired()` is false) proceed normally. Users with `licensed: true` (any paid plan or `manual_account`) always proceed.

---

## Task 4: "Manage Subscription" button in-app

The desktop app must not host billing UI itself — Stripe Checkout is web-only. When users want to upgrade or manage billing, they go to the web app.

### What to add in server.js

Add a new internal route `/internal/open-billing` that — when called from the app — responds with the billing URL to open. This keeps the logic server-side.

```javascript
app.get('/internal/open-billing', (req, res) => {
  if (!req.socket.localAddress.includes('127.0.0.1') && req.socket.localAddress !== '::1') {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json({ url: process.env.APP_URL + '/billing/checkout?plan=starter' });
});
```

### What to add in main.js

Add an IPC handler so the renderer (app.html/app.js) can trigger a browser open:

```javascript
const { ipcMain, shell } = require('electron');

ipcMain.handle('open-billing', async () => {
  shell.openExternal('https://textyourlist.com/billing/checkout?plan=starter');
});
```

### What to add in preload.js

Expose the IPC call to the renderer:

```javascript
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openBilling: () => ipcRenderer.invoke('open-billing'),
});
```

**IMPORTANT:** If preload.js already exposes an `electronAPI` object, add `openBilling` to the existing object rather than redefining it. Read preload.js first.

### What to add in public/app.js

Somewhere in the app's account/settings section, add a button trigger. Check what section of app.js handles settings or account info. Add a call like:

```javascript
document.getElementById('manage-subscription-btn')?.addEventListener('click', () => {
  if (window.electronAPI?.openBilling) {
    window.electronAPI.openBilling();
  } else {
    window.location.href = '/billing/checkout?plan=starter';
  }
});
```

### What to add in public/app.html

Find the settings or account section of app.html. Add a "Manage Subscription" button near the account info:

```html
<button id="manage-subscription-btn" class="btn btn-secondary">Manage Subscription</button>
```

Match the existing button style in app.html. Read app.html to find the right location before inserting.

---

## Task 5: GitHub Actions CI/CD

Create `.github/workflows/build.yml` to build signed-ready packages for Mac and Windows.

```yaml
name: Build Desktop App

on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:

jobs:
  build-mac:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Build Mac
        env:
          GH_TOKEN: ${{ secrets.GH_TOKEN }}
          CSC_IDENTITY_AUTO_DISCOVERY: false
        run: npm run build:mac
        
      - name: Upload Mac artifacts
        uses: actions/upload-artifact@v4
        with:
          name: mac-build
          path: dist/*.dmg

  build-win:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Build Windows
        env:
          GH_TOKEN: ${{ secrets.GH_TOKEN }}
        run: npm run build:win
        
      - name: Upload Windows artifacts
        uses: actions/upload-artifact@v4
        with:
          name: win-build
          path: dist/*.exe

  release:
    needs: [build-mac, build-win]
    runs-on: ubuntu-latest
    if: startsWith(github.ref, 'refs/tags/')
    steps:
      - name: Download Mac build
        uses: actions/download-artifact@v4
        with:
          name: mac-build
          path: dist/
          
      - name: Download Windows build
        uses: actions/download-artifact@v4
        with:
          name: win-build
          path: dist/
          
      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          files: dist/*
          draft: true
        env:
          GITHUB_TOKEN: ${{ secrets.GH_TOKEN }}
```

**Notes:**
- `CSC_IDENTITY_AUTO_DISCOVERY: false` disables macOS code signing in CI — we're not signing yet, this skips the signing step without error
- The release job creates a **draft** — Dustin can review and publish manually
- `workflow_dispatch` allows manual runs from GitHub Actions tab without pushing a tag
- Artifacts upload even without a tag push, so you can verify the builds work before doing a real release

---

## Task 6: Verify auto-update config

electron-updater is already in dependencies. Verify `main.js` has `autoUpdater.checkForUpdatesAndNotify()` in the startup sequence (it does — Phase 2 added it). Confirm the import is present:

```javascript
const { autoUpdater } = require('electron-updater');
```

No changes needed if it's already there — just confirm.

---

## Task 7: Version bump

In `package.json`, set `"version": "1.0.0"` — this is the first shippable version. Confirm it's already set correctly (the current package.json has this). No change needed unless it's different.

---

## What NOT to change

- `send-mac.js` / `send-windows.js` — do not touch
- `db.js` — do not touch
- API routes (`/api/jobs`, `/api/send-one`, etc.) — do not touch
- Stripe billing routes beyond what's specified above — do not touch
- `/home/ubuntu/projects/text-sender/` — do not touch

---

## After implementing Phase 4

Push all changes to `https://github.com/goalexgoai/tyl-desktop` on the `main` branch.

Report:
1. `package.json` publish config updated (owner: goalexgoai, repo: tyl-desktop)
2. `.env.example` created with all Stripe price IDs
3. License enforcement implemented — confirm `isGracePeriodExpired()` and dialog logic in place
4. "Manage Subscription" button wired: preload.js IPC, main.js handler, app.html button, app.js listener
5. `.github/workflows/build.yml` created
6. `autoUpdater` confirmed present in main.js
7. Confirm git push succeeded

Phase 5 will cover: code signing, Notarization for macOS, production Stripe keys, and Windows signing certificate.
